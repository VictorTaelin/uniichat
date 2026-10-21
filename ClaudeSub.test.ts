// ClaudeSub test
// ==============
// `bun test ClaudeSub.test.ts`. What claude-sub hands Claude Code: never
// another sign-in or endpoint than its own, nor a tool of its own that
// would act on the server (its tools are ours, over MCP, and web search,
// always). And its Claude Codes, on a fake SDK whose "Claude Code" (a
// real process) answers with all it was told: one per call, gone as the
// call ends; summaries and imports SUMS at most at once (a chat's first),
// chat turns and subagents never held back. A usage limit never ends a
// call: with no tool run it waits for the reset and asks again in a new
// Claude Code; after a tool it keeps its Claude Code and goes on, the
// tool not run again; no Claude Code starts under a limit told; a stop
// ends the wait, a message sent too (but not into extra usage); usage
// billed past the plan interrupts the turn. A stop while the MCP server
// is set ends at once; one that dies is replaced. And the copies of the
// carried binary another unii still uses are kept; a model two vendors
// offer keeps its name, its two picks apart.

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

process.env.UNII_DIR = fs.mkdtempSync(os.tmpdir() + "/unii-claude-sub-");
process.env.UNII_CLAUDE = "/bin/true";
const { ClaudeSub, SUMS, ON } = await import("./ClaudeSub.ts");
const { Pick, LABELS } = await import("./Pick.ts");
const { view_pick } = await import("./View.ts");

// the fake: each query() a process (a real one, spawned as the call asks
// its spawner to: it exits fake.linger s after its stdin closes),
// answering each message with its system prompt and all it was told;
// "SLOW" runs till interrupted; "DIE" (once) ends the process. "LIMIT"
// and "TOOL" (a tool of ours run first) meet a usage limit while
// fake.limits lasts, resetting at fake.reset ("bills": extra usage on);
// "OVER" answers on extra usage. An MCP URL with "HANG": setMcpServers
// never answers
const procs = new Set<any>();
const fake = {
  spawned: 0, most: 0, died: false, linger: 0, limits: 0, reset: 0, bills: false, tools: 0, interrupts: 0,
  get live() {
    procs.forEach((p) => (p.exitCode !== null || p.signalCode !== null) && procs.delete(p));
    return procs.size;
  },
};
function query({ prompt, options }: any) {
  fake.spawned += 1;
  const proc = options.spawnClaudeCodeProcess({ command: "sh", args: ["-c", "read x; sleep " + fake.linger], env: process.env });
  // live: those not exited, as the OS has it
  procs.add(proc);
  fake.most = Math.max(fake.most, fake.live);
  const out: any[] = [];
  const told: string[] = [];
  let wake = () => {};
  let halt = () => {};
  let gone = false;
  const end = () => {
    if (!gone) {
      gone = true;
      proc.stdin.end();
    }
    wake();
  };
  const emit = (m: any) => (out.push(m), wake());
  const rate = (status: string, more: any = {}) => emit({ type: "rate_limit_event", rate_limit_info: { status, resetsAt: fake.reset, rateLimitType: "five_hour", overageStatus: fake.bills ? "allowed" : "rejected", isUsingOverage: false, ...more } });
  const limit = () => {
    fake.limits -= 1;
    rate("rejected");
    emit({ type: "assistant", error: "rate_limit", message: { content: [{ type: "text", text: "You've hit your limit" }] } });
    emit({ type: "result", subtype: "success", is_error: true, result: "You've hit your limit" });
  };
  const answer = () => {
    rate("allowed");
    emit({ type: "result", subtype: "success", is_error: false, result: JSON.stringify({ system: options.systemPrompt, told }) });
  };
  (async () => {
    for await (const msg of prompt) {
      const c = msg.message.content;
      const text = typeof c === "string" ? c : c.map((b: any) => b.text).join("");
      if (text.includes("DIE") && !fake.died) {
        fake.died = true;
        proc.kill();
        return end();
      }
      told.push(text);
      if (text.includes("SLOW")) {
        await new Promise<void>((ok) => (halt = ok));
        emit({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["interrupted"] });
        continue;
      }
      if (text.includes("TOOL") && told.length === 1) {
        fake.tools += 1;
        emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__unii__shell", input: { command: "date" } }] } });
        emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "Tue" }] } });
      }
      if ((text.includes("LIMIT") || text.includes("TOOL")) && fake.limits > 0) {
        limit();
        continue;
      }
      if (text.includes("OVER")) {
        emit({ type: "assistant", message: { content: [{ type: "text", text: "paid" }] } });
        rate("rejected", { isUsingOverage: true, overageStatus: "allowed" });
        emit({ type: "result", subtype: "success", is_error: false, result: "paid" });
        continue;
      }
      answer();
    }
    end();
  })();
  return {
    async next() {
      while (out.length === 0) {
        if (gone) {
          return { done: true, value: undefined };
        }
        await new Promise<void>((ok) => (wake = ok));
      }
      return { done: false, value: out.shift() };
    },
    setMcpServers: (s: any) => (JSON.stringify(s).includes("HANG") ? new Promise(() => {}) : Promise.resolve({ added: [], removed: [], errors: {} })),
    interrupt    : async () => (fake.interrupts++, halt()),
    close        : end,
  };
}
ClaudeSub.use({ query, BUILTIN_TOOL_NAMES: ["Bash", "WebSearch"] });

const asked = (system: string, text: string, more: any = {}): any => ({ vendor: "claude-sub", model: "claude-sonnet-5-5", effort: "low", speed: "slow", system, blocks: [{ text, mark: true }], searches: 0, server: "", ...more });
const said = async (call: any) => JSON.parse((await call.done).text);
const tick = () => Bun.sleep(30);
// the Claude Codes gone, as the OS has it
const settled = async (live: number) => {
  for (let i = 0; i < 100 && fake.live > live; i++) {
    await Bun.sleep(20);
  }
  return fake.live;
};
// a call's thoughts
const minds = (evs: any[]) => evs.filter((e) => e.$ === "Entry" && e.kind === "mind").map((e) => e.text);

test("Claude Code gets no key, token or endpoint, and its own config dir, its owner's alone", () => {
  process.env.ANTHROPIC_AUTH_TOKEN = "token";
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "token";
  process.env.CLAUDE_CODE_USE_BEDROCK = "1";
  const env = ClaudeSub.env();
  expect(Object.keys(env).filter((k) => /^ANTHROPIC_|^CLAUDE_CODE_(OAUTH|USE_)/.test(k))).toEqual([]);
  expect(env.CLAUDE_CONFIG_DIR).toBe(process.env.UNII_DIR + "/claude-sub");
  expect(fs.statSync(env.CLAUDE_CONFIG_DIR!).mode & 0o777).toBe(0o700);
  // one made before, open to others: closed again
  fs.chmodSync(env.CLAUDE_CONFIG_DIR!, 0o755);
  ClaudeSub.env();
  expect(fs.statSync(env.CLAUDE_CONFIG_DIR!).mode & 0o777).toBe(0o700);
});

test("its only tools are ours and web search, always; our MCP URL is never in its start options", () => {
  const ask = asked("s", "", { searches: 10, server: "http://127.0.0.1:1/key/main" });
  const opts = ClaudeSub.options(ask, new AbortController(), ["Bash", "Read", "WebSearch", "Agent"]);
  expect(opts.tools).toEqual(["WebSearch"]);
  expect(opts.disallowedTools).toContain("Bash");
  expect(opts.disallowedTools).not.toContain("WebSearch");
  expect(opts.mcpServers).toEqual({});
  expect(JSON.stringify(opts)).not.toContain("/key/main");
  expect(opts.settingSources).toEqual([]);
  // a summary's call (no searches) has web search too
  expect(ClaudeSub.options({ ...ask, searches: 0 }, new AbortController(), ["WebSearch"]).tools).toEqual(["WebSearch"]);
  expect(ClaudeSub.mcp(ask.server)).toEqual({ unii: expect.objectContaining({ type: "http", url: ask.server }) });
});

test("each call its own Claude Code, gone as the call ends; ten at once each see only their own message", async () => {
  const live = await settled(0);
  const before = fake.spawned;
  expect(await said(ClaudeSub.ask(asked("A", "one"), () => {}))).toEqual({ system: "A", told: ["one"] });
  expect(await said(ClaudeSub.ask(asked("A", "two"), () => {}))).toEqual({ system: "A", told: ["two"] });
  expect(fake.spawned - before).toBe(2);
  expect(await settled(live)).toBe(live);
  const calls = Array.from({ length: 10 }, (_, i) => ClaudeSub.ask(asked("S", "n" + i, { server: "http://h/k/Agent" + i }), () => {}));
  const outs = await Promise.all(calls.map(said));
  expect(outs.map((o) => o.told)).toEqual(Array.from({ length: 10 }, (_, i) => ["n" + i]));
  expect(await settled(live)).toBe(live);
});

test("summaries and imports run SUMS Claude Codes at most, a chat's summaries first; chat turns and subagents never wait", async () => {
  const live = await settled(0);
  fake.most = live;
  const imp = { patient: true, yields: "/imports" };
  const imports = Array.from({ length: SUMS + 2 }, (_, i) => ClaudeSub.ask(asked("M", "SLOW import " + i, imp), () => {}));
  await tick();
  expect(ClaudeSub.slots()).toEqual({ busy: SUMS, waits: 2 });
  const order: string[] = [];
  const sums = [1, 2].map((i) => ClaudeSub.ask(asked("M", "summary " + i, { patient: true }), () => {}));
  sums.forEach((c, i) => c.done.then(() => order.push("summary " + (i + 1))));
  imports.slice(SUMS).forEach((c, i) => c.done.then(() => order.push("import " + (SUMS + i))));
  // a parent's turn and subagents start at once, whatever runs
  const turns = Array.from({ length: 3 }, (_, i) => ClaudeSub.ask(asked("M", "SLOW turn " + i, { server: "http://h/k/" + (i ? "Agent" + i : "main") }), () => {}));
  await tick();
  expect(fake.live).toBe(live + SUMS + 3);
  expect(ClaudeSub.slots()).toEqual({ busy: SUMS, waits: 4 });
  imports.slice(0, SUMS).forEach((c) => c.stop());
  await Promise.all(sums.map(said));
  imports.slice(SUMS).forEach((c) => c.stop());
  turns.forEach((c) => c.stop());
  await Promise.all([...imports, ...turns].map((c) => c.done));
  expect(order.slice(0, 2)).toEqual(["summary 1", "summary 2"]);
  expect(fake.most).toBeLessThanOrEqual(live + SUMS + 3);
  expect(await settled(live)).toBe(live);
  expect(ClaudeSub.slots()).toEqual({ busy: 0, waits: 0 });
});

test("a usage limit, no tool run: the call waits for the reset, then asks again in a new Claude Code; none starts under it", async () => {
  ClaudeSub.forget();
  const live = await settled(0);
  const before = fake.spawned;
  fake.limits = 1;
  fake.reset = Date.now() + 600;
  const evs: any[] = [];
  const t0 = Date.now();
  const call = ClaudeSub.ask(asked("L", "LIMIT one"), (ev) => evs.push(ev));
  await tick();
  expect(minds(evs)).toEqual(["The AI service reached a usage limit: asking again in 1 min."]);
  expect(await settled(live)).toBe(live);
  // another call meanwhile waits too, starting nothing
  const other = ClaudeSub.ask(asked("L", "another", { patient: true }), () => {});
  await tick();
  expect(fake.spawned - before).toBe(1);
  expect(await said(call)).toEqual({ system: "L", told: ["LIMIT one"] });
  expect(Date.now() - t0).toBeGreaterThanOrEqual(500);
  expect(await said(other)).toEqual({ system: "L", told: ["another"] });
  expect(fake.spawned - before).toBe(3);
  await settled(live);
  await tick();
  expect(ClaudeSub.slots()).toEqual({ busy: 0, waits: 0 });
});

test("a usage limit after a tool ran: the call keeps its Claude Code, then is told to go on; the tool doesn't run again", async () => {
  ClaudeSub.forget();
  const before = fake.spawned;
  const tools = fake.tools;
  fake.limits = 1;
  fake.reset = Date.now() + 400;
  const evs: any[] = [];
  const out = await said(ClaudeSub.ask(asked("T", "TOOL then answer", { server: "http://h/k/main" }), (ev) => evs.push(ev)));
  expect(out).toEqual({ system: "T", told: ["TOOL then answer", ON] });
  expect(fake.spawned - before).toBe(1);
  expect(fake.tools - tools).toBe(1);
  expect(evs.filter((e) => e.$ === "Entry" && e.kind === "echo").length).toBe(1);
});

test("a stop while waiting for a usage limit ends the call at once, and its Claude Code", async () => {
  ClaudeSub.forget();
  const live = await settled(0);
  fake.limits = 2;
  fake.reset = Date.now() + 60e3;
  const kept = ClaudeSub.ask(asked("T", "TOOL", { server: "http://h/k/main" }), () => {});
  await tick();
  expect(fake.live).toBe(live + 1);
  const fresh = ClaudeSub.ask(asked("L", "LIMIT"), () => {});
  await tick();
  const t0 = Date.now();
  kept.stop();
  fresh.stop();
  expect((await kept.done).ok).toBe(false);
  expect((await fresh.done).ok).toBe(false);
  expect(Date.now() - t0).toBeLessThan(500);
  expect(await settled(live)).toBe(live);
  fake.limits = 0;
  ClaudeSub.forget();
});

test("a message sent ends a usage limit's wait, as at the other vendors; not when asking would bill extra usage", async () => {
  ClaudeSub.forget();
  fake.limits = 1;
  fake.reset = Date.now() + 60e3;
  const call = ClaudeSub.ask(asked("W", "LIMIT"), () => {});
  await tick();
  const t0 = Date.now();
  call.send({ text: "hi", imgs: [] });
  expect(await said(call)).toEqual({ system: "W", told: ["LIMIT", "hi"] });
  expect(Date.now() - t0).toBeLessThan(1000);
  ClaudeSub.forget();
  fake.limits = 1;
  fake.bills = true;
  const before = fake.spawned;
  const billing = ClaudeSub.ask(asked("W", "LIMIT"), () => {});
  await tick();
  billing.send({ text: "hi", imgs: [] });
  await Bun.sleep(200);
  expect(fake.spawned - before).toBe(1);
  billing.stop();
  expect((await billing.done).ok).toBe(false);
  fake.bills = false;
  fake.limits = 0;
  ClaudeSub.forget();
});

test("usage billed past the plan interrupts the turn; its whole answer kept, but no call asks again till the reset", async () => {
  ClaudeSub.forget();
  fake.reset = Date.now() + 60e3;
  const interrupts = fake.interrupts;
  const end = await ClaudeSub.ask(asked("O", "OVER"), () => {}).done;
  expect(end).toMatchObject({ ok: true, text: "paid" });
  expect(fake.interrupts - interrupts).toBe(1);
  const before = fake.spawned;
  const evs: any[] = [];
  const next = ClaudeSub.ask(asked("O", "next"), (ev) => evs.push(ev));
  next.send({ text: "now?", imgs: [] });
  await Bun.sleep(200);
  expect(fake.spawned - before).toBe(0);
  expect(minds(evs)[0]).toContain("usage limit");
  next.stop();
  await next.done;
  ClaudeSub.forget();
});

test("a stop while our MCP server is being set ends the call at once, and its Claude Code", async () => {
  const live = await settled(0);
  const hang = ClaudeSub.ask(asked("C", "three", { server: "http://h/HANG/main" }), () => {});
  await tick();
  expect(fake.live).toBe(live + 1);
  const t1 = Date.now();
  hang.stop();
  expect((await hang.done).ok).toBe(false);
  expect(Date.now() - t1).toBeLessThan(500);
  expect(await settled(live)).toBe(live);
});

test("a Claude Code that dies before any output: the call runs on a fresh one", async () => {
  const before = fake.spawned;
  expect(await said(ClaudeSub.ask(asked("D", "DIE"), () => {}))).toEqual({ system: "D", told: ["DIE"] });
  expect(fake.spawned - before).toBe(2);
});

test("the carried binary's copies another running unii uses are kept; the rest go", async () => {
  const home = fs.mkdtempSync(os.tmpdir() + "/unii-claude-bins-");
  const dirs = ["keep", "live", "dead", "bare", "new"].map((n) => home + "/claude-agent-sdk-" + n);
  dirs.forEach((d) => fs.mkdirSync(d + "/users", { recursive: true }));
  fs.mkdirSync(home + "/other");
  const live = Bun.spawn(["sleep", "30"]);
  const dead = Bun.spawn(["true"]);
  await dead.exited;
  fs.writeFileSync(dirs[1] + "/users/" + live.pid, "");
  fs.writeFileSync(dirs[2] + "/users/" + dead.pid, "");
  const old = new Date(Date.now() - 3600e3);
  dirs.slice(0, 4).forEach((d) => (fs.utimesSync(d + "/users", old, old), fs.utimesSync(d, old, old)));
  ClaudeSub.claim(dirs[0]);
  expect(fs.existsSync(dirs[0] + "/users/" + process.pid)).toBe(true);
  ClaudeSub.prune(home, "claude-agent-sdk-keep");
  expect(fs.readdirSync(home).sort()).toEqual(["claude-agent-sdk-keep", "claude-agent-sdk-live", "claude-agent-sdk-new", "other"]);
  // once its unii exits, the next prune removes it
  live.kill();
  await live.exited;
  fs.utimesSync(dirs[1] + "/users", old, old);
  fs.utimesSync(dirs[1], old, old);
  ClaudeSub.prune(home, "claude-agent-sdk-keep");
  expect(fs.readdirSync(home).sort()).toEqual(["claude-agent-sdk-keep", "claude-agent-sdk-new", "other"]);
  fs.rmSync(home, { recursive: true, force: true });
});

test("both Claude vendors offered: a model keeps its name, its two picks stay apart", () => {
  const offer = { vendors: ["claude-api", "claude-sub"] as any, models: LABELS };
  const api = { vendor: "claude-api", model: "opus-5.5", effort: "low", speed: "slow" } as any;
  const sub = { ...api, vendor: "claude-sub" };
  const opts = Pick.options(api, "model", offer);
  expect(opts.map(([part]) => part).filter((p) => p.includes("(") || p.includes("claude-"))).toEqual([]);
  expect(opts.filter(([part]) => part === "opus-5.5").map(([, p]) => p.vendor)).toEqual(["claude-api", "claude-sub"]);
  // by value: the pick's own vendor's, or the one named
  expect(Pick.move(sub, "model", offer, "opus-5.5")?.vendor).toBe("claude-sub");
  expect(Pick.move(api, "model", offer, "opus-5.5")?.vendor).toBe("claude-api");
  expect(Pick.move(api, "model", offer, "claude-sub:opus-5.5")?.vendor).toBe("claude-sub");
  expect(Pick.move(sub, "model", offer, "sonnet")).toMatchObject({ vendor: "claude-sub", model: "sonnet-5.5" });
  // stepping goes through both
  const seen = new Set<string>();
  let at = api;
  for (let i = 0; i < opts.length; i++) {
    at = Pick.move(at, "next", offer)!;
    seen.add(Pick.label(at));
  }
  expect(seen.size).toBe(opts.length);
  // the knob: the name alone; its hint says whose
  const knob = view_pick({ pick: sub, vendors: offer.vendors, models: offer.models } as any)[0];
  expect(knob.text).toBe("opus-5.5");
  expect(knob.hint).toBe("opus-5.5, claude-sub");
  expect(view_pick({ pick: sub, vendors: ["claude-sub"], models: offer.models } as any)[0].hint).toBe("opus-5.5");
});
