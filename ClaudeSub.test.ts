// ClaudeSub test
// ==============
// `bun test ClaudeSub.test.ts`. What claude-sub hands Claude Code: never
// another sign-in or endpoint than its own, nor a tool of its own that
// would act on the server (its tools are ours, over MCP). And its lanes,
// on a fake SDK whose "Claude Code" answers with all it was told since
// its last /clear: no call sees another's, no more run than the ceiling,
// chat turns go first, a stop while waiting ends the wait, a lane that
// dies is replaced, one unused ends, a sign-in or out ends them.

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

process.env.UNII_DIR = fs.mkdtempSync(os.tmpdir() + "/unii-claude-sub-");
process.env.UNII_CLAUDE = "/bin/true";
process.env.UNII_CLAUDE_LANES = "2";
process.env.UNII_CLAUDE_IDLE = "1";
const { ClaudeSub } = await import("./ClaudeSub.ts");

// the fake: each query() a process, answering each message with its
// system prompt and what it was told since its last /clear; "SLOW" runs
// till interrupted; "DIE" (once) ends the process
const fake = { spawned: 0, live: 0, most: 0, died: false };
function query({ prompt, options }: any) {
  fake.spawned += 1;
  fake.most = Math.max(fake.most, ++fake.live);
  const out: any[] = [];
  let told: string[] = [];
  let wake = () => {};
  let halt = () => {};
  let gone = false;
  const end = () => {
    if (!gone) {
      gone = true;
      fake.live -= 1;
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
        emit({ type: "conversation_reset" });
        emit({ type: "result", subtype: "success", is_error: false, result: "" });
        continue;
      }
      if (text.includes("DIE") && !fake.died) {
        fake.died = true;
        return end();
      }
      told.push(text);
      if (text.includes("SLOW")) {
        await new Promise<void>((ok) => (halt = ok));
        emit({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["interrupted"] });
        continue;
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
    setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
    interrupt    : async () => halt(),
    close        : end,
  };
}
ClaudeSub.use({ query, BUILTIN_TOOL_NAMES: ["Bash", "WebSearch"] });

const asked = (system: string, text: string, more: any = {}): any => ({ vendor: "claude-sub", model: "claude-sonnet-5-5", effort: "low", speed: "slow", system, blocks: [{ text, mark: true }], searches: 0, server: "", ...more });
const said = async (call: any) => JSON.parse((await call.done).text);
const tick = () => Bun.sleep(20);

test("Claude Code gets no key, token or endpoint, and its own config dir", () => {
  process.env.ANTHROPIC_AUTH_TOKEN = "token";
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "token";
  process.env.CLAUDE_CODE_USE_BEDROCK = "1";
  const env = ClaudeSub.env();
  expect(Object.keys(env).filter((k) => /^ANTHROPIC_|^CLAUDE_CODE_(OAUTH|USE_)/.test(k))).toEqual([]);
  expect(env.CLAUDE_CONFIG_DIR).toBe(process.env.UNII_DIR + "/claude-sub");
  expect(fs.statSync(env.CLAUDE_CONFIG_DIR!).mode & 0o777).toBe(0o700);
});

test("a lane's only tools are ours and web search, our URL never on its command line", () => {
  const ask = asked("s", "", { searches: 10, server: "http://127.0.0.1:1/key/main" });
  const opts = ClaudeSub.options(ask, new AbortController(), ["Bash", "Read", "WebSearch", "Agent"]);
  expect(opts.tools).toEqual(["WebSearch"]);
  expect(opts.disallowedTools).toContain("Bash");
  expect(opts.disallowedTools).not.toContain("WebSearch");
  expect(opts.mcpServers).toEqual({});
  expect(opts.settingSources).toEqual([]);
  expect(ClaudeSub.options({ ...ask, searches: 0 }, new AbortController(), ["WebSearch"]).tools).toEqual([]);
  expect(ClaudeSub.key("c", ask)).not.toBe(ClaudeSub.key("c", { ...ask, searches: 0 }));
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

test("no more lanes than the ceiling; chat turns first; a stop while waiting ends the wait", async () => {
  ClaudeSub.end();
  const x = ClaudeSub.ask(asked("X", "SLOW"), () => {});
  const y = ClaudeSub.ask(asked("Y", "SLOW", { server: "http://h/k/Agent1" }), () => {});
  await tick();
  const order: string[] = [];
  const sum = ClaudeSub.ask(asked("Z", "summary", { patient: true }), () => {});
  const gone = ClaudeSub.ask(asked("Z", "summary 2", { patient: true }), () => {});
  const chat = ClaudeSub.ask(asked("W", "chat", { server: "http://h/k/main" }), () => {});
  sum.done.then(() => order.push("summary"));
  chat.done.then(() => order.push("chat"));
  await tick();
  expect(ClaudeSub.pool()).toEqual({ lanes: 2, busy: 2, waits: 3 });
  const spawned = fake.spawned;
  gone.stop();
  expect((await gone.done).ok).toBe(false);
  expect(ClaudeSub.pool().waits).toBe(2);
  x.stop();
  expect((await x.done).ok).toBe(false);
  expect(await said(chat)).toEqual({ system: "W", told: ["chat"] });
  expect(await said(sum)).toEqual({ system: "Z", told: ["summary"] });
  expect(order).toEqual(["chat", "summary"]);
  expect(fake.spawned - spawned).toBe(2);
  y.stop();
  expect((await y.done).ok).toBe(false);
  expect(fake.most).toBeLessThanOrEqual(2);
  expect(fake.live).toBeLessThanOrEqual(2);
});

test("ten calls at once run on the ceiling's lanes, each seeing only its own message", async () => {
  ClaudeSub.end();
  const calls = Array.from({ length: 10 }, (_, i) => ClaudeSub.ask(asked("S", "n" + i, { patient: true }), () => {}));
  const outs = await Promise.all(calls.map(said));
  expect(outs.map((o) => o.told)).toEqual(Array.from({ length: 10 }, (_, i) => ["n" + i]));
  expect(fake.live).toBeLessThanOrEqual(2);
});

test("a lane that dies before any output: the call runs on a fresh one", async () => {
  ClaudeSub.end();
  const before = fake.spawned;
  expect(await said(ClaudeSub.ask(asked("D", "DIE"), () => {}))).toEqual({ system: "D", told: ["DIE"] });
  expect(fake.spawned - before).toBe(2);
});

test("a lane unused for claude_idle ends", async () => {
  ClaudeSub.end();
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
