// Cache test
// ==========
// `bun test cache.test.ts`. Replays a chat through the real Memory, AskAI
// and Agent loop against a fake Anthropic that caches by its rules: an
// entry written only at a breakpoint, keyed by the prefix up to it, read
// walking back at most LOOK blocks from each breakpoint, serving once its
// writer's response began, living TTL past its last use. Time is faked.

import { expect, setSystemTime, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";

// Types
// =====

// a message as logged, and the steps of the turn it starts (if any)
type Log = { kind: string; text: string; date: string; steps: number };

// a cache entry: from when it serves, until when
type Entry = { from: number; until: number };

// what requests of a kind read, wrote and sent uncached, and how many
type Use = { read: number; write: number; input: number; n: number };

// Constants
// =========

const LOOK  = 20;
const TTL   = 300e3;
const FIRST = 1500;
const DIR   = fs.mkdtempSync(os.tmpdir() + "/unii-cache-");

process.env.UNII_DIR = DIR;

// a process reads Config once (maybe for another test): the fake key goes
// in it, not in the environment
const config = await import("./Config.ts");
config.KEYS.anthropic = "test";

const { AskAI } = await import("./AskAI.ts");
const { Memory } = await import("./Memory.ts");
const { COMPACT, MASTER } = await import("./Tools.ts");

const PICK = { vendor: "claude-api" as const, model: "claude-opus-5-5", effort: "medium", speed: "slow" };
const SHARE = { ...PICK, system: MASTER, searches: 0, server: "" };
const COMPACT_SHARE = { ...SHARE, system: COMPACT };

// Clock
// =====

let now = Date.UTC(2026, 9, 1);
let seed = 1;
const queue: Array<{ at: number; go: () => void }> = [];

function rand(): number {
  seed = (seed * 48271) % 2147483647;
  return seed / 2147483647;
}

function rand_span(a: number, b: number): number {
  return a * (b / a) ** rand();
}

function later(ms: number, go: () => void): void {
  const at = now + ms;
  const k = queue.findIndex((ev) => ev.at > at);
  queue.splice(k < 0 ? queue.length : k, 0, { at, go });
}

async function drain(): Promise<void> {
  while (queue.length > 0) {
    const ev = queue.shift()!;
    now = Math.max(now, ev.at);
    setSystemTime(new Date(now));
    ev.go();
    for (let k = 0; k < 8; k++) {
      await new Promise((ok) => setImmediate(ok));
    }
  }
}

// Fake Anthropic
// ==============

const CACHE = new Map<string, Entry>();

function hash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

// what a request reads, writes and sends uncached, by the cache's rules
function cache_use(body: any): Use {
  const head = JSON.stringify([body.model, body.tools, body.thinking, body.output_config, body.speed]);
  const blocks = [...body.system, ...body.messages.flatMap((m: any) => m.content.map((c: any) => ({ ...c, role: m.role })))];
  const marks = blocks.flatMap((b, k) => (b.cache_control || (body.cache_control && k === blocks.length - 1) ? [k] : []));
  expect(blocks.filter((b) => b.cache_control).length + (body.cache_control ? 1 : 0)).toBeLessThanOrEqual(4);
  const keys: string[] = [];
  const ends: number[] = [];
  for (const { cache_control, ...b } of blocks) {
    const text = JSON.stringify(b);
    keys.push(hash((keys[keys.length - 1] ?? head) + text));
    ends.push((ends[ends.length - 1] ?? 0) + text.length);
  }
  const live = (k: number) => (CACHE.get(keys[k])?.from ?? Infinity) <= now && CACHE.get(keys[k])!.until >= now;
  let hit = -1;
  for (const m of marks) {
    for (let k = m; k > m - LOOK && k >= 0; k--) {
      if (live(k)) {
        hit = Math.max(hit, k);
        break;
      }
    }
  }
  if (hit >= 0) {
    CACHE.get(keys[hit])!.until = now + TTL;
  }
  for (const m of marks.filter((m) => m > hit && !(CACHE.get(keys[m])?.until! >= now))) {
    CACHE.set(keys[m], { from: now + FIRST, until: now + TTL });
  }
  const read = hit < 0 ? 0 : ends[hit];
  const write = Math.max(0, ends[Math.max(-1, ...marks)] ?? 0) - read;
  return { read, write: Math.max(0, write), input: ends[ends.length - 1] - read - Math.max(0, write), n: 1 };
}

// a response to a task: a compaction's line, a turn's tool call (until
// its steps are done) or reply; it begins after FIRST, ends in seconds
function reply(body: any, task: string, line: string): Response {
  const steps = Number(/#steps=(\d+)/.exec(task)?.[1] ?? 0);
  const done = body.messages.filter((m: any) => m.role === "assistant").length;
  const tool = !task.startsWith("Compaction:") && done < steps;
  const block = tool ? { type: "tool_use", id: "t" + done, name: "zoom", input: {} } : { type: "text", text: "" };
  const delta = tool ? { type: "input_json_delta", partial_json: "{}" } : { type: "text_delta", text: task.startsWith("Compaction:") ? line : "ok" };
  const events = [
    { type: "message_start", message: { usage: {} } },
    { type: "content_block_start", index: 0, content_block: block },
    { type: "content_block_delta", index: 0, delta },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 100 } },
    { type: "message_stop" },
  ];
  const sse = (evs: object[]) => new TextEncoder().encode(evs.map((ev) => "data: " + JSON.stringify(ev) + "\n\n").join(""));
  const ms = rand_span(3000, 9000);
  const stream = new ReadableStream({
    start: (out) => {
      later(FIRST, () => out.enqueue(sse(events.slice(0, 1))));
      later(ms, () => {
        out.enqueue(sse(events.slice(1)));
        out.close();
      });
    },
  });
  return new Response(stream);
}

// Replay
// ======

// node (l,i) a task asks for
function task_node(task: string): [number, number] {
  const leaf = /compress message (\d+)/.exec(task);
  const pair = /merge lines (\d+)\+(\d+)/.exec(task)!;
  return leaf ? [0, Number(leaf[1])] : [Math.log2(Number(pair[2])) + 1, Number(pair[1]) / Number(pair[2]) / 2];
}

// what each kind of call read from the cache; a summary's line as long as
// real ones vary, a fourth too long at first: a try after one sends at
// most its first's messages and the note
async function replay(logs: Log[]): Promise<Record<string, Use>> {
  const dir = DIR + "/chat" + Math.floor(rand() * 1e9);
  const mem = Memory.load(dir, () => COMPACT_SHARE);
  const uses: Record<string, Use> = {};
  const sizes = new Map<string, number>();
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const use = cache_use(body);
    const first = body.messages[0].content;
    const task: string = first.findLast((c: any) => c.text.startsWith("Compaction:"))?.text ?? first[first.length - 1].text;
    const node = task.startsWith("Compaction:") ? task_node(task) : null;
    const size = JSON.stringify(body.messages).length;
    const again = first[first.length - 1].text.startsWith("Too long:");
    if (node !== null) {
      sizes.set(node.join(), sizes.get(node.join()) ?? size);
      expect(size).toBeLessThanOrEqual(sizes.get(node.join())! + 1000);
    }
    const sum = (uses[node === null ? "turn" : "compaction"] ??= { read: 0, write: 0, input: 0, n: 0 });
    for (const k of ["read", "write", "input", "n"] as const) {
      sum[k] += use[k];
    }
    sum.input -= node === null ? 0 : task.length;
    const long = !again && node !== null && node[1] % 4 === 0 ? 400 : 0;
    return reply(body, task, node === null ? "" : "line " + node[0] + "/" + node[1] + " " + "x".repeat(120 + long + ((node[1] * 7919 + node[0]) % 330)));
  }) as any;
  const start = Date.parse(logs[0].date);
  let turns = Promise.resolve();
  for (const log of logs) {
    later(Date.parse(log.date) - start, () => {
      const id = Memory.push(mem, [{ kind: log.kind as any, text: log.text, date: log.date }])[0].i;
      if (log.kind === "user") {
        turns = turns.then(() => turn(mem, id, log));
      }
    });
  }
  for (let idle = 0; idle < 4; idle = queue.length > 0 ? 0 : idle + 1) {
    await drain();
    await new Promise((ok) => setImmediate(ok));
  }
  await turns;
  globalThis.fetch = real;
  return uses;
}

// a turn as Server.call makes it
async function turn(mem: any, id: number, log: Log): Promise<void> {
  if ((await Memory.settle(mem, id, new AbortController().signal)) === null) {
    const text = log.text + " #steps=" + log.steps;
    const call = AskAI.ask({ ...SHARE, blocks: [...Memory.view(mem, id), { text, mark: true }] }, () => {});
    await call.done;
  }
}

// a chat of `n` messages: turns of tool steps
function synthetic(n: number): Log[] {
  const logs: Log[] = [];
  let t = now;
  const say = (kind: string, a: number, b: number, gap: number, steps = 0) => {
    t += gap;
    const text = kind + " " + crypto.randomBytes(Math.ceil(rand_span(a, b) * 0.75)).toString("base64");
    logs.push({ kind, text, date: new Date(t).toISOString(), steps });
  };
  while (logs.length < n) {
    const steps = Math.floor(rand() * 7);
    say("user", 40, 1500, rand_span(20e3, 240e3), steps);
    for (let k = 0; k < steps; k++) {
      say("tool", 80, 600, rand_span(2e3, 12e3));
      say("echo", 40, 8000, rand_span(1e3, 6e3));
    }
    say("unii", 100, 2500, rand_span(2e3, 9e3));
  }
  return logs;
}

// the share of calls' input read from the cache; a compaction's task is
// its own, never in a cache, so not counted
function share(use: Use): number {
  return use.read / (use.read + use.write + use.input);
}

// Tests
// =====

test("turns and compactions read >= 95% from the cache", async () => {
  const uses = await replay(synthetic(3000));
  console.log(Object.entries(uses).map(([k, u]) => k + ": " + u.n + " requests, " + (100 * share(u)).toFixed(1) + "% read").join("; "));
  expect(share(uses.turn)).toBeGreaterThanOrEqual(0.95);
  expect(share(uses.compaction)).toBeGreaterThanOrEqual(0.95);
}, 600e3);
