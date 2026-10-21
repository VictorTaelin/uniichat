// ClaudeSub test
// ==============
// `bun test ClaudeSub.test.ts`. What claude-sub hands Claude Code: never
// another sign-in or endpoint than its own, nor a tool of its own that
// would act on the server (its tools are ours, over MCP, and web search,
// always). And its lanes, on a fake SDK whose "Claude Code" (a real
// process) answers with all it was told since its last /clear: no call
// sees another's, a lane serves any call of its exact prompt (whoever's),
// never more Claude Codes than claude_lanes, one ending counted till it
// exits; one of them the summaries' (so a turn waiting on a summary
// never waits forever, and nothing is ended for it), chat turns first,
// imports last; below 2 refused; a stop while waiting or while a lane is
// being set ends at once, a lane that dies is replaced, one unused ends,
// a sign-in or out ends them. And the copies of
// the carried binary another unii still uses are kept; a model two
// vendors offer keeps its name, its two picks apart.

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

process.env.UNII_DIR = fs.mkdtempSync(os.tmpdir() + "/unii-claude-sub-");
process.env.UNII_CLAUDE = "/bin/true";
process.env.UNII_CLAUDE_LANES = "3";
process.env.UNII_CLAUDE_IDLE = "1";
const { ClaudeSub } = await import("./ClaudeSub.ts");
const { Pick, LABELS } = await import("./Pick.ts");
const { view_pick } = await import("./View.ts");

// the fake: each query() a process (a real one, spawned as the lane asks
// its spawner to: it exits fake.linger s after its stdin closes), answering
// each message with its system prompt and what it was told since its last
// /clear; "SLOW" runs till interrupted; "AWAIT" till fake.gate opens (a
// turn waiting on something, as a spawn waits on summaries); "HOLD" till
// fake.hold opens; "DIE" (once)
// ends the process; fake.stuck: /clear never answered; an MCP URL with
// "HANG": setMcpServers never answers
const procs = new Set<any>();
const fake = {
  spawned: 0, most: 0, died: false, linger: 0, stuck: false, gate: Promise.withResolvers<void>(), hold: Promise.withResolvers<void>(),
  get live() {
    procs.forEach((p) => (p.exitCode !== null || p.signalCode !== null) && procs.delete(p));
    return procs.size;
  },
};
function query({ prompt, options }: any) {
  fake.spawned += 1;
  const proc = options.spawnClaudeCodeProcess({ command: "sh", args: ["-c", "read x; sleep " + fake.linger], env: process.env });
  // live: those not exited, as the OS has it (not as an exit listener
  // that runs after the lane's has, which may start another first)
  procs.add(proc);
  fake.most = Math.max(fake.most, fake.live);
  const out: any[] = [];
  let told: string[] = [];
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
  (async () => {
    for await (const msg of prompt) {
      const c = msg.message.content;
      const text = typeof c === "string" ? c : c.map((b: any) => b.text).join("");
      if (text === "/clear") {
        told = [];
        if (!fake.stuck) {
          emit({ type: "conversation_reset" });
          emit({ type: "result", subtype: "success", is_error: false, result: "" });
        }
        continue;
      }
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
      if (text.includes("AWAIT")) {
        await fake.gate.promise;
      }
      if (text.includes("HOLD")) {
        await fake.hold.promise;
      }
      emit({ type: "result", subtype: "success", is_error: false, result: JSON.stringify({ system: options.systemPrompt, told }) });
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
    setModel     : async () => {},
    applyFlagSettings : async () => {},
    setMcpServers: (s: any) => (JSON.stringify(s).includes("HANG") ? new Promise(() => {}) : Promise.resolve({ added: [], removed: [], errors: {} })),
    interrupt    : async () => halt(),
    close        : end,
  };
}
ClaudeSub.use({ query, BUILTIN_TOOL_NAMES: ["Bash", "WebSearch"] });

const asked = (system: string, text: string, more: any = {}): any => ({ vendor: "claude-sub", model: "claude-sonnet-5-5", effort: "low", speed: "slow", system, blocks: [{ text, mark: true }], searches: 0, server: "", ...more });
const said = async (call: any) => JSON.parse((await call.done).text);
const tick = () => Bun.sleep(20);

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

test("a lane's only tools are ours and web search, always; its key is the prompt alone", () => {
  const ask = asked("s", "", { searches: 10, server: "http://127.0.0.1:1/key/main" });
  const opts = ClaudeSub.options(ask, new AbortController(), ["Bash", "Read", "WebSearch", "Agent"]);
  expect(opts.tools).toEqual(["WebSearch"]);
  expect(opts.disallowedTools).toContain("Bash");
  expect(opts.disallowedTools).not.toContain("WebSearch");
  expect(opts.mcpServers).toEqual({});
  expect(opts.settingSources).toEqual([]);
  // a summary's call (no searches) has web search too, and the same key
  expect(ClaudeSub.options({ ...ask, searches: 0 }, new AbortController(), ["WebSearch"]).tools).toEqual(["WebSearch"]);
  expect(ClaudeSub.key("c", ask)).toBe(ClaudeSub.key("c", { ...ask, searches: 0, server: "", patient: true }));
  expect(ClaudeSub.key("c", ask)).not.toBe(ClaudeSub.key("c", { ...ask, system: "s2" }));
  expect(ClaudeSub.mcp(ask.server)).toEqual({ unii: expect.objectContaining({ type: "http", url: ask.server }) });
});

test("a lane serves call after call of its prompt, each in a fresh conversation", async () => {
  const before = fake.spawned;
  expect(await said(ClaudeSub.ask(asked("A", "one"), () => {}))).toEqual({ system: "A", told: ["one"] });
  expect(await said(ClaudeSub.ask(asked("A", "two"), () => {}))).toEqual({ system: "A", told: ["two"] });
  expect(fake.spawned - before).toBe(1);
  expect(await said(ClaudeSub.ask(asked("B", "three"), () => {}))).toEqual({ system: "B", told: ["three"] });
  expect(fake.spawned - before).toBe(2);
  expect(await said(ClaudeSub.ask(asked("A", "four"), () => {}))).toEqual({ system: "A", told: ["four"] });
  expect(fake.spawned - before).toBe(2);
});

test("two users, the same system prompt: one lane; another SOUL: its own; a summary shares the chat's", async () => {
  ClaudeSub.end();
  const before = fake.spawned;
  const soul = (s: string) => "You are Unii.\n\nRules.\n\n" + s;
  const ann = asked(soul("Be kind."), "ann's", { server: "http://127.0.0.1:1/chat-ann/main", searches: 10 });
  const bob = asked(soul("Be kind."), "bob's", { server: "http://127.0.0.1:1/chat-bob/main", searches: 10 });
  expect(await said(ClaudeSub.ask(ann, () => {}))).toEqual({ system: soul("Be kind."), told: ["ann's"] });
  expect(await said(ClaudeSub.ask(bob, () => {}))).toEqual({ system: soul("Be kind."), told: ["bob's"] });
  expect(fake.spawned - before).toBe(1);
  // a summary of ann's chat: same prompt, no tools, no searches: same lane
  expect(await said(ClaudeSub.ask({ ...ann, blocks: [{ text: "sum", mark: true }], server: "", searches: 0, patient: true }, () => {}))).toEqual({ system: soul("Be kind."), told: ["sum"] });
  expect(fake.spawned - before).toBe(1);
  // a user whose SOUL.md differs: a lane of its own
  expect(await said(ClaudeSub.ask({ ...bob, system: soul("Be blunt.") }, () => {}))).toEqual({ system: soul("Be blunt."), told: ["bob's"] });
  expect(fake.spawned - before).toBe(2);
  expect(ClaudeSub.pool().lanes).toBe(2);
});

test("never more than claude_lanes Claude Codes; one is the summaries'; chat turns first; a stop while waiting ends the wait", async () => {
  ClaudeSub.end();
  await Bun.sleep(100);
  fake.most = fake.live;
  const x = ClaudeSub.ask(asked("X", "SLOW"), () => {});
  const y = ClaudeSub.ask(asked("Y", "SLOW", { server: "http://h/k/Agent1" }), () => {});
  await tick();
  // chat turns and subagents hold 2 of 3: a third waits, the last lane
  // stays the summaries'
  const third = ClaudeSub.ask(asked("T", "third", { server: "http://h/k/Agent9" }), () => {});
  await tick();
  expect(ClaudeSub.pool()).toMatchObject({ lanes: 2, busy: 2, waits: 1 });
  const s1 = ClaudeSub.ask(asked("Z", "SLOW", { patient: true }), () => {});
  await tick();
  expect(ClaudeSub.pool()).toMatchObject({ lanes: 3, busy: 3, waits: 1 });
  const order: string[] = [];
  const sum = ClaudeSub.ask(asked("Z", "summary", { patient: true }), () => {});
  const gone = ClaudeSub.ask(asked("Z", "summary 2", { patient: true }), () => {});
  const sub = ClaudeSub.ask(asked("V", "subagent", { server: "http://h/k/Agent2" }), () => {});
  const chat = ClaudeSub.ask(asked("W", "chat", { server: "http://h/k/main" }), () => {});
  sum.done.then(() => order.push("summary"));
  sub.done.then(() => order.push("subagent"));
  chat.done.then(() => order.push("chat"));
  third.done.then(() => order.push("third"));
  await tick();
  expect(ClaudeSub.pool()).toMatchObject({ lanes: 3, busy: 3, waits: 5 });
  gone.stop();
  expect((await gone.done).ok).toBe(false);
  expect(ClaudeSub.pool().waits).toBe(4);
  x.stop();
  expect(await said(chat)).toEqual({ system: "W", told: ["chat"] });
  y.stop();
  expect(await said(third)).toEqual({ system: "T", told: ["third"] });
  expect(await said(sub)).toEqual({ system: "V", told: ["subagent"] });
  s1.stop();
  expect(await said(sum)).toEqual({ system: "Z", told: ["summary"] });
  expect(order).toEqual(["chat", "third", "subagent", "summary"]);
  expect(fake.most).toBeLessThanOrEqual(3);
  expect(fake.live).toBeLessThanOrEqual(3);
});

test("claude_lanes below 2 is refused, not raised", async () => {
  expect(() => ClaudeSub.ceiling(1)).toThrow("claude_lanes must be at least 2: one is kept for summaries");
  for (const n of ["1", "0", "x"]) {
    const run = Bun.spawnSync([process.execPath, "-e", "await import('./Config.ts')"], { cwd: import.meta.dir, env: { ...process.env, UNII_CLAUDE_LANES: n } });
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("claude_lanes must be at least 2: one is kept for summaries");
  }
  const ok = Bun.spawnSync([process.execPath, "-e", "const c = await import('./Config.ts'); console.log(c.CLAUDE_LANES)"], { cwd: import.meta.dir, env: { ...process.env, UNII_CLAUDE_LANES: "2" } });
  expect(ok.stdout.toString().trim()).toBe("2");
});

// a compaction while every lane is busy: turns holding every chat lane
// wait (as Tools.spawn waits on Memory.settle) for a summary queued
// behind them, the summaries' lane itself busy with an import's. The
// summary waits for that lane, ahead of the imports queued before it;
// then the turns go on. Nothing is ended, nothing deadlocks, and never
// more Claude Codes than the setting, at 2 and 3
for (const most of [2, 3]) {
  test("a compaction while every lane is busy waits, then runs; nothing ended, never more than " + most, async () => {
    ClaudeSub.end();
    await Bun.sleep(100);
    ClaudeSub.ceiling(most);
    fake.gate = Promise.withResolvers<void>();
    fake.hold = Promise.withResolvers<void>();
    fake.most = fake.live;
    const imp = { patient: true, yields: "/imports" };
    const importing = ClaudeSub.ask(asked("M", "HOLD import 0", imp), () => {});
    const holding = Array.from({ length: most - 1 }, (_, i) => ClaudeSub.ask(asked("M", "AWAIT " + i, { server: "http://h/k/" + (i === 0 ? "main" : "Agent" + i) }), () => {}));
    await tick();
    expect(ClaudeSub.pool()).toMatchObject({ lanes: most, busy: most, waits: 0 });
    const order: string[] = [];
    const ended: string[] = [];
    holding.forEach((c, i) => c.done.then(() => ended.push("turn " + i)));
    const imports = [1, 2].map((i) => ClaudeSub.ask(asked("M", "import " + i, imp), () => {}));
    imports.forEach((c, i) => c.done.then(() => order.push("import " + (i + 1))));
    const more = ClaudeSub.ask(asked("M", "one more subagent", { server: "http://h/k/AgentX" }), () => {});
    more.done.then(() => ended.push("subagent"));
    const sum = ClaudeSub.ask(asked("M", "the summary", { patient: true }), () => {});
    sum.done.then(() => order.push("summary"));
    await Bun.sleep(300);
    expect(ClaudeSub.pool()).toMatchObject({ lanes: most, busy: most, waits: 4 });
    fake.hold.resolve();
    expect(await said(importing)).toEqual({ system: "M", told: ["HOLD import 0"] });
    const late = Bun.sleep(3000).then(() => "deadlock");
    expect(await Promise.race([said(sum), late])).toEqual({ system: "M", told: ["the summary"] });
    // the turns still wait on their gate, untouched; the subagent still waits
    expect(ended).toEqual([]);
    expect(fake.most).toBeLessThanOrEqual(most);
    fake.gate.resolve();
    const outs = await Promise.all(holding.map(said));
    expect(outs.map((o) => o.told[0])).toEqual(holding.map((_, i) => "AWAIT " + i));
    expect(await said(more)).toEqual({ system: "M", told: ["one more subagent"] });
    await Promise.all(imports.map(said));
    expect(order).toEqual(["summary", "import 1", "import 2"]);
    expect(fake.most).toBeLessThanOrEqual(most);
    ClaudeSub.ceiling(3);
  });
}

test("a lane ending counts toward claude_lanes till its process exits", async () => {
  ClaudeSub.end();
  await Bun.sleep(100);
  ClaudeSub.ceiling(2);
  fake.linger = 0.5;
  fake.most = fake.live;
  await said(ClaudeSub.ask(asked("P", "one"), () => {}));
  await said(ClaudeSub.ask(asked("R", "a summary", { patient: true }), () => {}));
  expect(ClaudeSub.pool()).toMatchObject({ lanes: 2, busy: 0 });
  // a chat turn of another prompt: the longest unused lane ends, and the
  // new one starts only once that one's process exited
  const t0 = Date.now();
  expect(await said(ClaudeSub.ask(asked("Q", "two"), () => {}))).toEqual({ system: "Q", told: ["two"] });
  expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
  expect(fake.most).toBeLessThanOrEqual(2);
  expect(ClaudeSub.pool()).toMatchObject({ lanes: 2, ending: 0 });
  ClaudeSub.end();
  expect(ClaudeSub.pool().ending).toBe(2);
  await Bun.sleep(900);
  expect(ClaudeSub.pool().ending).toBe(0);
  fake.linger = 0;
  ClaudeSub.ceiling(3);
});

test("a stop while a lane is being set (its /clear, its MCP server) ends the call at once, and the lane", async () => {
  ClaudeSub.end();
  await Bun.sleep(100);
  await said(ClaudeSub.ask(asked("C", "one"), () => {}));
  fake.stuck = true;
  const before = fake.spawned;
  const clearing = ClaudeSub.ask(asked("C", "two"), () => {});
  await tick();
  const t0 = Date.now();
  clearing.stop();
  expect((await clearing.done).ok).toBe(false);
  expect(Date.now() - t0).toBeLessThan(500);
  expect(ClaudeSub.pool().lanes).toBe(0);
  fake.stuck = false;
  const hang = ClaudeSub.ask(asked("C", "three", { server: "http://h/HANG/main" }), () => {});
  await tick();
  expect(fake.spawned - before).toBe(1);
  const t1 = Date.now();
  hang.stop();
  expect((await hang.done).ok).toBe(false);
  expect(Date.now() - t1).toBeLessThan(500);
  expect(ClaudeSub.pool().lanes).toBe(0);
  expect(await said(ClaudeSub.ask(asked("C", "four"), () => {}))).toEqual({ system: "C", told: ["four"] });
  expect(fake.spawned - before).toBe(2);
});

test("ten calls at once run on claude_lanes' lanes, each seeing only its own message", async () => {
  ClaudeSub.end();
  await Bun.sleep(100);
  fake.most = fake.live;
  const calls = Array.from({ length: 10 }, (_, i) => ClaudeSub.ask(asked("S", "n" + i, i % 2 ? { patient: true } : { server: "http://h/k/Agent" + i }), () => {}));
  const outs = await Promise.all(calls.map(said));
  expect(outs.map((o) => o.told)).toEqual(Array.from({ length: 10 }, (_, i) => ["n" + i]));
  expect(fake.most).toBeLessThanOrEqual(3);
});

test("a lane that dies before any output: the call runs on a fresh one", async () => {
  ClaudeSub.end();
  const before = fake.spawned;
  expect(await said(ClaudeSub.ask(asked("D", "DIE"), () => {}))).toEqual({ system: "D", told: ["DIE"] });
  expect(fake.spawned - before).toBe(2);
});

test("a lane unused for claude_idle ends", async () => {
  ClaudeSub.end();
  await Bun.sleep(100);
  const live = fake.live;
  await said(ClaudeSub.ask(asked("I", "one"), () => {}));
  expect(fake.live).toBe(live + 1);
  await Bun.sleep(1300);
  expect(ClaudeSub.pool().lanes).toBe(0);
  expect(fake.live).toBe(live);
});

test("a sign-in or out ends the lanes started before it", async () => {
  ClaudeSub.end();
  await said(ClaudeSub.ask(asked("M", "one"), () => {}));
  const before = fake.spawned;
  fs.writeFileSync(process.env.UNII_DIR + "/claude-sub/.unii-signed", String(Date.now()));
  expect(await said(ClaudeSub.ask(asked("M", "two"), () => {}))).toEqual({ system: "M", told: ["two"] });
  expect(fake.spawned - before).toBe(1);
  expect(ClaudeSub.pool().lanes).toBe(1);
  ClaudeSub.end();
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
