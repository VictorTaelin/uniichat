// Fallback test
// =============
// `bun test fallback.test.ts`. Calls on the config's profile "duo",
// claude-api:opus-5.5 then openai-api:gpt-6.1-sol, through the real AskAI and
// Agent loop against a fake Anthropic and OpenAI (as `claude` and `gpt`
// say) and a fake tools server. Timers run 1000 times fast.

import { expect, setSystemTime, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

process.env.UNII_DIR = fs.mkdtempSync(os.tmpdir() + "/unii-fallback-");
process.env.UNII_VENDORS = "claude-api,openai-api";
process.env.UNII_PROFILES = JSON.stringify({ duo: ["claude-api:opus-5.5", "openai-api:gpt-6.1-sol"], back: ["openai-api:gpt-6.1-sol", "claude-api:opus-5.5"] });

const config = await import("./Config.ts");
config.KEYS.anthropic = "test";
config.KEYS.openai = "test";

const { AskAI } = await import("./AskAI.ts");
const { Pick } = await import("./Pick.ts");

const ASK = { vendor: "claude-api" as const, model: "claude-opus-5-5", effort: "high", speed: "fast", profile: "duo", system: "sys", searches: 0, server: "" };
const OPUS = { vendor: "claude-api" as const, model: "claude-opus-5-5", effort: "high", speed: "fast" };
const SOL = { vendor: "openai-api" as const, model: "gpt-6.1-sol", effort: "high", speed: "fast" };
const BUSY = "the AI service is busy or unavailable right now";

const real = { setTimeout, fetch, error: console.error };
const logged: string[] = [];
const asked: string[] = [];

// claude: ok, broke (out of credit, also once a tool ran), limited
// (429), tool (a tool call), cut (a tool call cut off as it streamed),
// long (a prompt too long), stall (no answer); gpt: ok, quota (429
// insufficient_quota), error (an `error` event, server_error, once)
let claude = "ok";
let gpt = "ok";

function sse(events: object[]): Response {
  return new Response(events.map((ev) => "data: " + JSON.stringify(ev) + "\n\n").join(""));
}

function anthropic(body: any): Promise<Response> | Response {
  asked.push("claude");
  const ran = body.messages.some((m: any) => Array.isArray(m.content) && m.content.some((c: any) => c.type === "tool_result"));
  const error = (status: number, type: string, message: string) => Response.json({ type: "error", error: { type, message } }, { status });
  if (claude === "stall") {
    return new Promise(() => {});
  }
  if (claude === "broke" || ran) {
    return error(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API.");
  }
  if (claude === "long") {
    return error(400, "invalid_request_error", "prompt is too long: 250000 tokens > 200000 maximum");
  }
  if (claude === "limited") {
    return error(429, "rate_limit_error", "slow down");
  }
  const use = claude === "tool" || claude === "cut";
  const block = use ? { type: "tool_use", id: "toolu_1", name: "shell", input: {} } : { type: "text", text: "" };
  const delta = use ? { type: "input_json_delta", partial_json: '{"command":"ls"}' } : { type: "text_delta", text: "claude here" };
  const begun = [{ type: "message_start", message: { usage: {} } }, { type: "content_block_start", index: 0, content_block: block }, { type: "content_block_delta", index: 0, delta }];
  if (claude === "cut") {
    return sse(begun);
  }
  return sse([...begun, { type: "content_block_stop", index: 0 }, { type: "message_delta", delta: { stop_reason: use ? "tool_use" : "end_turn" }, usage: { output_tokens: 10 } }, { type: "message_stop" }]);
}

function openai(body: any): Response {
  asked.push(body.model);
  if (gpt === "quota") {
    return Response.json({ error: { message: "You exceeded your current quota.", type: "insufficient_quota", code: "insufficient_quota" } }, { status: 429 });
  }
  if (gpt === "error") {
    gpt = "ok";
    return sse([{ type: "error", sequence_number: 1, error: { code: "server_error", message: "boom" } }]);
  }
  const item = { type: "message", content: [{ type: "output_text", text: "openai here" }] };
  return sse([
    { type: "response.output_item.added", item: { type: "message" } },
    { type: "response.output_text.delta", delta: "openai here" },
    { type: "response.completed", response: { status: "completed", service_tier: "fast", output: [item], usage: { input_tokens: 10, output_tokens: 10 } } },
  ]);
}

// a tools server: one shell tool
function tools(body: any): Response {
  const result = body.method === "tools/list" ? { tools: [{ name: "shell", description: "", inputSchema: { type: "object" } }] } : { content: [{ type: "text", text: "a b c" }] };
  return Response.json({ jsonrpc: "2.0", id: body.id, result });
}

async function vendor(url: string, init: any): Promise<Response> {
  const body = JSON.parse(init.body);
  if (url.startsWith("https://api.anthropic.com/v1/messages/count_tokens")) {
    return Response.json({ input_tokens: 10 });
  }
  return url.startsWith("https://api.anthropic.com/") ? anthropic(body) : url.startsWith("https://api.openai.com/") ? openai(body) : tools(body);
}

// a call's end and its Run events, as "model <- from"
async function call(over: object = {}): Promise<{ end: any; runs: string[]; evs: any[] }> {
  const evs: any[] = [];
  const end = await AskAI.ask({ ...ASK, blocks: [{ text: "hi", mark: true }], ...over }, (ev) => evs.push(ev)).done;
  const runs = evs.filter((ev) => ev.$ === "Run").map((ev) => ev.run.model + (ev.from ? " <- " + ev.from.model : ""));
  return { end, runs, evs };
}

// runs `go` with timers 1000 times fast, the fakes, the log kept, all
// answering and up at first
async function fast(go: () => Promise<void>): Promise<void> {
  globalThis.setTimeout = ((go: () => void, ms = 0) => real.setTimeout(go, ms / 1000)) as any;
  globalThis.fetch = vendor as any;
  console.error = (...args: unknown[]) => logged.push(args.join(" "));
  claude = gpt = "ok";
  [OPUS, SOL].forEach((p) => AskAI.down(p, null));
  logged.length = asked.length = 0;
  try {
    await go();
  } finally {
    Object.assign(globalThis, { setTimeout: real.setTimeout, fetch: real.fetch });
    console.error = real.error;
    setSystemTime();
  }
}

// a fallback that lacks the call's speed would fail every time
test("a fallback takes the call's effort and speed (a slower one if it lacks it), and none repeats its model", () => {
  const sol = Pick.model("openai-api", "gpt-6.1-sol")!;
  const opus = Pick.model("claude-api", "opus-5.5")!;
  const run = { vendor: "claude-api" as const, model: "claude-sonnet-5-5", effort: "max", speed: "slow" };
  const falls = [{ vendor: "openai-api" as const, model: sol }, { vendor: "claude-api" as const, model: opus, effort: "low" }, { vendor: "openai-api" as const, model: sol, effort: "high" }];
  expect(Pick.falls({ ...run, speed: "ultrafast" }, falls).map(Pick.label)).toEqual([
    "claude-api:claude-sonnet-5-5:max:ultrafast",
    "openai-api:gpt-6.1-sol:max:fast",
    "claude-api:claude-opus-5-5:low:fast",
  ]);
});

test("a pick out of credit goes on with the fallback, is skipped a minute, then asked once a call till it answers", () => fast(async () => {
  claude = "broke";
  const first = await call();
  expect(first.end).toMatchObject({ ok: true, text: "openai here" });
  expect(first.runs).toEqual(["gpt-6.1-sol <- opus-5.5"]);
  expect(asked).toEqual(["claude", "gpt-6.1-sol"]);

  asked.length = 0;
  expect((await call()).runs).toEqual(["gpt-6.1-sol <- opus-5.5"]);
  expect(asked).toEqual(["gpt-6.1-sol"]);

  setSystemTime(new Date(Date.now() + 61e3));
  asked.length = 0;
  expect((await call()).end.text).toBe("openai here");
  expect(asked).toEqual(["claude", "gpt-6.1-sol"]);

  claude = "ok";
  setSystemTime(new Date(Date.now() + 61e3));
  asked.length = 0;
  const back = await call();
  expect(back.end).toMatchObject({ ok: true, text: "claude here" });
  expect(back.runs).toEqual(["opus-5.5"]);
  expect(asked).toEqual(["claude"]);
}));

test("a busy pick is retried, then the fallback", () => fast(async () => {
  claude = "limited";
  expect((await call()).end.text).toBe("openai here");
  expect(asked.at(-1)).toBe("gpt-6.1-sol");
}));

test("OpenAI out of quota (a 429) goes on at once; its `error` event is read", () => fast(async () => {
  const back = { ...SOL, profile: "back" };
  gpt = "quota";
  expect((await call(back)).end.text).toBe("claude here");
  expect(asked).toEqual(["gpt-6.1-sol", "claude"]);
  AskAI.down(SOL, null);
  gpt = "error";
  asked.length = 0;
  expect((await call(back)).end.text).toBe("openai here");
  expect(asked).toEqual(["gpt-6.1-sol", "gpt-6.1-sol"]);
}));

// a model picked, not a profile, must never run (and bill) another
test("a model picked alone has no fallback", () => fast(async () => {
  claude = "broke";
  const alone = await call({ profile: undefined });
  expect(alone.end).toMatchObject({ ok: false, stop: "down" });
  expect(alone.runs).toEqual([]);
  expect(asked).toEqual(["claude"]);
}));

test("a try that ran a tool isn't redone on the fallback; one whose tool call was cut off, unrun, is", () => fast(async () => {
  const server = { server: "http://127.0.0.1:1/tools" };
  claude = "tool";
  expect((await call(server)).end).toMatchObject({ ok: false, stop: "down", text: BUSY });
  expect(asked).toEqual(["claude", "claude"]);
  AskAI.down(OPUS, null);
  claude = "cut";
  asked.length = 0;
  expect((await call(server)).end.text).toBe("openai here");
  expect(asked.at(-1)).toBe("gpt-6.1-sol");
}));

test("a request's own failure (a prompt too long), our own (the tools server) or a stop neither switches nor marks the pick out", () => fast(async () => {
  claude = "long";
  expect((await call()).end).toMatchObject({ ok: false, stop: "down" });
  globalThis.fetch = ((url: string, init: any) => (url.includes("/tools") ? Promise.reject(new Error("refused")) : vendor(url, init))) as any;
  expect((await call({ server: "http://127.0.0.1:1/tools" })).end.ok).toBe(false);
  globalThis.fetch = vendor as any;
  claude = "stall";
  const c = AskAI.ask({ ...ASK, blocks: [{ text: "hi", mark: true }] }, () => {});
  await new Promise((ok) => real.setTimeout(ok, 20));
  c.stop();
  expect(await c.done).toMatchObject({ ok: false, stop: "lost" });
  expect(asked).toEqual(["claude", "claude"]);
}));

test("a patient call (a summary's) falls back; out of picks it asks again a minute later", () => fast(async () => {
  claude = "broke";
  expect((await call({ patient: true })).end.text).toBe("openai here");
  setSystemTime(new Date(Date.now() + 61e3));
  gpt = "quota";
  asked.length = 0;
  const sum = AskAI.ask({ ...ASK, blocks: [{ text: "hi", mark: true }], patient: true }, () => {});
  await new Promise((ok) => real.setTimeout(ok, 150));
  expect(asked.slice(0, 3)).toEqual(["claude", "gpt-6.1-sol", "gpt-6.1-sol"]);
  gpt = "ok";
  expect(await sum.done).toMatchObject({ ok: true, text: "openai here" });
}));

// Chat (Server.ts): the notes a chat's calls' Runs make

const X = { vendor: "claude-api", model: "opus-5.5", effort: "high", speed: "fast" };
const Y = { vendor: "openai-api", model: "gpt-6.1-sol", effort: "high", speed: "fast" };
const FELL = { $: "Run", run: Y, from: X, why: BUSY };
const BACK = { $: "Run", run: X, from: null, why: "" };

async function chat_open(): Promise<any> {
  const { Chat } = await import("./Server.ts");
  const { Cloud } = await import("./Cloud.ts");
  Chat.cloud ??= Cloud.open(() => {}, () => {}, async () => null);
  return Chat.open({ id: "u" + crypto.randomUUID().slice(0, 8), name: "a@b.c" })!;
}

// the chat's notes of switches ("fell") and ways back ("back")
async function notes(chat: any): Promise<string[]> {
  const { Memory } = await import("./Memory.ts");
  const out: string[] = [];
  for (let i = 0; i < chat.mem.count; i++) {
    const m = Memory.message(chat.mem, i);
    if (m?.kind === "note" && /failed: |^Back on /.test(m.text)) {
      out.push(m.text.startsWith("Back on") ? "back" : "fell");
    }
  }
  return out;
}

test("a chat notes a switch and the way back once each, not each call", async () => {
  const { Chat } = await import("./Server.ts");
  const chat = await chat_open();
  for (const [ev, want] of [[FELL, ["fell"]], [FELL, ["fell"]], [BACK, ["fell", "back"]], [BACK, ["fell", "back"]], [FELL, ["fell", "back", "fell"]]] as const) {
    Chat.on(chat, null, ev as any);
    expect(await notes(chat)).toEqual([...want]);
  }
});
