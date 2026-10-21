// ClaudeSub
// =========
// The claude-sub vendor: a Claude plan instead of an API key, on the
// Claude Agent SDK. Its Claude Code (the SDK's own binary, unmodified,
// carried inside a compiled unii; config `claude` names another) runs
// with CLAUDE_CONFIG_DIR at DIR (config `claude_sub`): `unii claude` runs
// its `claude auth login` there, so the sign-in is Anthropic's own and
// the token stays Claude Code's, kept and refreshed by it, never read by
// us. A call is one turn: our system prompt, our blocks as its message,
// our tools over MCP (the chat's URL, Tools.ts) and web search; Claude
// Code's own tools, settings, skills, memory and compaction off. It runs
// the tool loop; we log what it streams. A message sent mid-run goes in
// once its turn ends. A refusal (not signed in, a usage limit) ends the
// call as the vendor's (`down`), in Claude Code's words ("You've hit your
// limit · resets 3pm"), or saying how to sign in.
//
// Lanes: a Claude Code is a ~250 MB process, so calls don't each start
// one. A lane is one kept running, serving one call at a time, each in a
// fresh conversation (/clear: no call sees another's). Its system prompt
// and tools are fixed at its start, so a lane serves only calls of that
// exact prompt: its key is a hash of the prompt's text, the binary and
// whether it has web search (a denial set mid-run still shows the tool).
// A prompt that changes (the rules file edited) has a new key; its old
// lanes go unused and end. Model, effort and our MCP URL are set per
// call. At most LANES run (config `claude_lanes`): a call takes a
// free lane of its key, else starts one, else ends the longest unused
// lane of another key for one, else waits, chat turns first, then
// subagents, then summaries and imports (`rank`); a stop while it waits
// ends it. A lane unused IDLE ends; one that dies is dropped (its call
// tried once more on a fresh lane, if nothing came out yet); all end at a
// sign-in or out (`unii claude` marks it) and with the server.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AskAI, type Ask, type Event, type Img, type Say, type Try } from "./AskAI.ts";
import { Agent, type Emit } from "./Agent.ts";
import { Anthropic } from "./Anthropic.ts";
import { live_push, type Live } from "./View.ts";
import * as config from "./Config.ts";

// Constants
// =========

const DIR = config.CLAUDE_SUB;

// touched by `unii claude` at each sign-in and out: lanes started before
// it end (it holds no token)
const MARK = DIR + "/.unii-signed";

const LANES = config.CLAUDE_LANES;
const IDLE  = config.CLAUDE_IDLE * 1e3;

// how long a stopped call's lane may take to end its turn, and a lane to
// clear its conversation, before it's ended
const DRAIN = 15e3;
const CLEAR = 15e3;

// Claude Code's tools kept: web search, as claude-api has (Anthropic.ts)
const WEB = ["WebSearch"];

// the rest, by name, so none comes back: the SDK's list, and older
// names it lacks
const MORE = ["Task", "DesignSync"];

// what turns off what Claude Code does beyond calling the model
const ENV = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC : "1", // updates, telemetry, error reports
  CLAUDE_CODE_DISABLE_AUTO_MEMORY          : "1",
  CLAUDE_CODE_DISABLE_ATTACHMENTS          : "1", // "@path" in a message stays text
  CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS     : "1",
  DISABLE_AUTO_COMPACT                     : "1",
  CLAUDE_AGENT_SDK_CLIENT_APP              : "uniichat",
};

const SIGN_IN = "claude-sub is not signed in: run `unii claude` on the server";

const NO_BIN = "claude-sub needs Claude Code: `bun install` in uniichat's folder, or set `claude` to a Claude Code executable";

const DIED = "Claude Code ended early";

type Sdk = typeof import("@anthropic-ai/claude-agent-sdk");

// a lane: its Claude Code; what it was started with (key) and when
// (mark: MARK's time then); what the last call set; whether a call holds
// it, has (used: its conversation needs clearing), and when it let go
export type Lane = {
  key    : string;
  q      : Query;
  box    : ReturnType<typeof ClaudeSub.inbox>;
  next   : Promise<IteratorResult<SDKMessage>> | null;
  mark   : number;
  model  : string;
  effort : string;
  server : string;
  busy   : boolean;
  used   : boolean;
  dead   : boolean;
  at     : number;
  idle   : ReturnType<typeof setTimeout> | null;
};

// a call waiting for a lane: its key, rank, place in line; how its lane
// starts, if one must
type Wait = { key: string; rank: number; n: number; start: () => Lane; give: (lane: Lane) => void; fail: (err: Error) => void };

// a lane's end, as told: dead (gone, or failed to clear) or not
class Died extends Error {}

// State
// =====

const POOL = { lanes: [] as Lane[], waits: [] as Wait[], n: 0, bin: null as Promise<string> | null, sdk: null as Promise<Sdk> | null, hooked: false };

// ClaudeSub
// =========

export namespace ClaudeSub {

  // the Claude Code it runs: config `claude`, else the one a compiled unii
  // carries (Build.ts; written out once, under the unii dir, as a process
  // can't run it from inside unii), else the SDK's in node_modules
  export function bin(): Promise<string> {
    POOL.bin ??= ClaudeSub.find().catch((err) => {
      POOL.bin = null;
      throw err;
    });
    return POOL.bin;
  }

  export async function find(): Promise<string> {
    if (config.CLAUDE) {
      return config.CLAUDE;
    }
    const inside = Bun.embeddedFiles.map((f) => (f as Blob & { name: string }).name).find((name) => /^claude(-|\.|$)/.test(name));
    if (inside !== undefined) {
      return ClaudeSub.extract((process.platform === "win32" ? "B:\\~BUN\\root\\" : "/$bunfs/root/") + inside);
    }
    try {
      return Bun.fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk-" + ClaudeSub.platform() + (process.platform === "win32" ? "/claude.exe" : "/claude")));
    } catch {
      throw new Error(NO_BIN);
    }
  }

  // the SDK's package for this machine (musl Linux: its own)
  export function platform(): string {
    const musl = process.platform === "linux" && fs.existsSync("/lib") && fs.readdirSync("/lib").some((f) => f.startsWith("ld-musl-"));
    return process.platform + "-" + process.arch + (musl ? "-musl" : "");
  }

  // the carried binary written out under the unii dir, by the SDK's
  // extractFromBunfs (to a dir named by its hash; /tmp is often RAM), and
  // the copies of other versions removed
  export async function extract(inside: string): Promise<string> {
    const { extractFromBunfs } = await import("@anthropic-ai/claude-agent-sdk/extract");
    const was = process.env.CLAUDE_CODE_TMPDIR;
    process.env.CLAUDE_CODE_TMPDIR = config.DIR;
    try {
      const out = extractFromBunfs(inside);
      const home = path.dirname(path.dirname(out));
      for (const old of fs.readdirSync(home)) {
        if (old.startsWith("claude-agent-sdk-") && old !== path.basename(path.dirname(out))) {
          fs.rmSync(path.join(home, old), { recursive: true, force: true });
        }
      }
      return out;
    } finally {
      was === undefined ? delete process.env.CLAUDE_CODE_TMPDIR : (process.env.CLAUDE_CODE_TMPDIR = was);
    }
  }

  // the SDK, loaded once (a test hands in its own)
  export function sdk(): Promise<Sdk> {
    POOL.sdk ??= import("@anthropic-ai/claude-agent-sdk").catch((err) => {
      POOL.sdk = null;
      throw err;
    });
    return POOL.sdk;
  }

  export function use(sdk: unknown): void {
    POOL.sdk = Promise.resolve(sdk as Sdk);
  }

  // its environment: ours, less what would sign it in or send it
  // elsewhere (an API key, a token, a base URL, Bedrock, Vertex...)
  export function env(): Record<string, string | undefined> {
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    const ours = Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC_|CLAUDE_)/.test(k));
    return { ...Object.fromEntries(ours), ...ENV, CLAUDE_CONFIG_DIR: DIR };
  }

  // `unii claude [logout|status]`; a sign-in or out marked for the lanes
  export async function cli(args: string[]): Promise<void> {
    const cmd = args.includes("logout") ? ["logout"] : args.includes("status") ? ["status"] : ["login", "--claudeai"];
    const run = Bun.spawn([await ClaudeSub.bin(), "auth", ...cmd], { env: ClaudeSub.env(), stdio: ["inherit", "inherit", "inherit"] });
    process.exitCode = await run.exited;
    if (cmd[0] !== "status") {
      fs.writeFileSync(MARK, String(Date.now()), { mode: 0o600 });
    }
  }

  export function ask(ask: Ask, on: (ev: Event) => void): Try {
    const end = AskAI.end("");
    const sent: Say[] = [];
    const abort = new AbortController();
    const stop = () => {
      end.text = "stopped";
      abort.abort();
    };
    const done = ClaudeSub.run(ask, on, sent, abort).then(
      (out) => abort.signal.aborted || Object.assign(end, out),
      (err) => (end.text ||= err.message),
    ).then(() => {
      end.ok   = end.ok && !abort.signal.aborted;
      end.left = sent;
      return end;
    });
    return { send: (say) => sent.push(say), stop, done };
  }

  // a lane's start: all but what a call sets (`prepare`); builtin:
  // Claude Code's tools (the SDK's BUILTIN_TOOL_NAMES). Our tools load up
  // front, never behind its tool search, and a call may run past the 60 s
  // Claude Code gives an HTTP MCP request. Our MCP server is set per call,
  // over its pipe: its secret URL is never on its command line
  export function options(ask: Ask, abort: AbortController, builtin: readonly string[]): Options {
    const tools = ask.searches > 0 ? WEB : [];
    const deny = [...builtin, ...MORE].filter((t) => !tools.includes(t));
    return {
      abortController        : abort,
      env                    : ClaudeSub.env(),
      cwd                    : DIR,
      model                  : ask.model,
      effort                 : ask.effort as Options["effort"],
      thinking               : { type: "adaptive", display: "summarized" },
      systemPrompt           : ask.system,
      tools,
      allowedTools           : [...tools, "mcp__unii"],
      disallowedTools        : deny,
      permissionMode         : "dontAsk",
      mcpServers             : {},
      strictMcpConfig        : true,
      settingSources         : [],
      plugins                : [],
      skills                 : [],
      persistSession         : false,
      includePartialMessages : true,
      settings               : {
        disableBundledSkills      : true,
        disableWorkflows          : true,
        disableRemoteControl      : true,
        disableClaudeAiConnectors : true,
        enableArtifact            : false,
        permissions               : { deny },
      },
    };
  }

  export function mcp(server: string): Record<string, any> {
    return server ? { unii: { type: "http", url: server, alwaysLoad: true, timeout: 1e8 } } : {};
  }

  // what a lane is started with: the binary, web search or not, the
  // system prompt
  export function key(bin: string, ask: Ask): string {
    return crypto.createHash("sha256").update(bin + "\0" + (ask.searches > 0 ? "web" : "") + "\0" + ask.system).digest("hex");
  }

  // a call's place in line: a chat turn (or goal check) 0, a subagent's
  // 1, a summary's or an import's 2 (Tools.at: the master's URL ends
  // /main; a summary is patient)
  export function rank(ask: Ask): number {
    return ask.patient ? 2 : ask.server === "" || ask.server.endsWith("/main") ? 0 : 1;
  }

  // the lanes running, and the calls waiting (for tests)
  export function pool(): { lanes: number; busy: number; waits: number } {
    return { lanes: POOL.lanes.length, busy: POOL.lanes.filter((l) => l.busy).length, waits: POOL.waits.length };
  }

  // MARK's time: when the sign-in last changed (0: never marked)
  export function signed(): number {
    try {
      return fs.statSync(MARK).mtimeMs;
    } catch {
      return 0;
    }
  }

  // a lane for a call (null: stopped while waiting), in line
  export function take(key: string, rank: number, start: () => Lane, signal: AbortSignal): Promise<Lane | null> {
    return new Promise((ok, no) => {
      if (signal.aborted) {
        return ok(null);
      }
      const off = () => {
        POOL.waits = POOL.waits.filter((w) => w !== wait);
        ok(null);
      };
      const wait: Wait = {
        key, rank, n: POOL.n++, start,
        give: (lane) => (signal.removeEventListener("abort", off), ok(lane)),
        fail: (err) => (signal.removeEventListener("abort", off), no(err)),
      };
      signal.addEventListener("abort", off, { once: true });
      POOL.waits.push(wait);
      ClaudeSub.grant();
    });
  }

  // the waiting calls given lanes, first in line first, while any can be
  export function grant(): void {
    const mark = ClaudeSub.signed();
    POOL.lanes.filter((l) => !l.busy && l.mark !== mark).forEach(ClaudeSub.close);
    POOL.waits.sort((a, b) => a.rank - b.rank || a.n - b.n);
    while (POOL.waits.length > 0) {
      const wait = POOL.waits[0];
      let lane = POOL.lanes.find((l) => !l.busy && l.key === wait.key);
      if (lane === undefined && POOL.lanes.length >= LANES) {
        const old = POOL.lanes.filter((l) => !l.busy).sort((a, b) => a.at - b.at)[0];
        if (old === undefined) {
          return;
        }
        ClaudeSub.close(old);
      }
      POOL.waits.shift();
      try {
        lane ??= wait.start();
      } catch (err: any) {
        wait.fail(err);
        continue;
      }
      lane.busy = true;
      if (lane.idle !== null) {
        clearTimeout(lane.idle);
        lane.idle = null;
      }
      wait.give(lane);
    }
  }

  // a new lane for this call's key, started on its pick
  export function start(sdk: Sdk, bin: string, key: string, ask: Ask): Lane {
    const box = ClaudeSub.inbox();
    const options = { ...ClaudeSub.options(ask, new AbortController(), sdk.BUILTIN_TOOL_NAMES), pathToClaudeCodeExecutable: bin };
    const q = sdk.query({ prompt: box.read(), options });
    const lane: Lane = { key, q, box, next: null, mark: ClaudeSub.signed(), model: ask.model, effort: ask.effort, server: "", busy: false, used: false, dead: false, at: Date.now(), idle: null };
    POOL.lanes.push(lane);
    if (!POOL.hooked) {
      POOL.hooked = true;
      process.on("exit", ClaudeSub.end);
    }
    return lane;
  }

  // a lane's next message (one read at a time, whoever waits on it)
  export function read(lane: Lane): Promise<IteratorResult<SDKMessage>> {
    lane.next ??= lane.q.next().then((r) => {
      lane.next = null;
      return r;
    }, (err) => {
      lane.next = null;
      throw new Died(err?.message ?? String(err));
    });
    lane.next.catch(() => {});
    return lane.next;
  }

  // a lane let go: back in the pool, unused for IDLE at most
  export function release(lane: Lane): void {
    lane.busy = false;
    lane.at = Date.now();
    if (!lane.dead && lane.mark !== ClaudeSub.signed()) {
      ClaudeSub.close(lane);
    }
    if (!lane.dead) {
      lane.idle = setTimeout(() => {
        if (!lane.busy) {
          ClaudeSub.close(lane);
          ClaudeSub.grant();
        }
      }, IDLE);
      lane.idle.unref?.();
    }
    ClaudeSub.grant();
  }

  // a lane ended: its Claude Code stopped
  export function close(lane: Lane): void {
    if (lane.dead) {
      return;
    }
    lane.dead = true;
    POOL.lanes = POOL.lanes.filter((l) => l !== lane);
    if (lane.idle !== null) {
      clearTimeout(lane.idle);
    }
    lane.box.close();
    try {
      lane.q.close();
    } catch {}
  }

  // every lane ended (the server's exit)
  export function end(): void {
    POOL.lanes.forEach(ClaudeSub.close);
  }

  // a stopped call's lane: its turn interrupted and read to its end, then
  // let go; one that takes too long (or dies) ends
  export function drain(lane: Lane): void {
    const late = setTimeout(() => ClaudeSub.close(lane), DRAIN);
    lane.q.interrupt().catch(() => {});
    (async () => {
      for (;;) {
        const r = await ClaudeSub.read(lane);
        if (r.done) {
          throw new Died(DIED);
        }
        if (r.value.type === "result") {
          return;
        }
      }
    })().then(
      () => (clearTimeout(late), ClaudeSub.release(lane)),
      () => (clearTimeout(late), ClaudeSub.close(lane), ClaudeSub.grant()),
    );
  }

  // a lane set for a call: a fresh conversation (if it served one), the
  // call's model, effort and our MCP server
  export async function prepare(lane: Lane, ask: Ask): Promise<string | null> {
    if (lane.used) {
      lane.box.say("/clear");
      let reset = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<"late">((ok) => (timer = setTimeout(() => ok("late"), CLEAR)));
      try {
        for (;;) {
          const r = await Promise.race([ClaudeSub.read(lane), late]);
          if (r === "late" || r.done) {
            throw new Died(r === "late" ? "Claude Code didn't clear its conversation" : DIED);
          }
          reset ||= r.value.type === "conversation_reset";
          if (r.value.type === "result") {
            if (!reset) {
              throw new Died("Claude Code didn't clear its conversation");
            }
            break;
          }
        }
      } finally {
        clearTimeout(timer);
      }
    }
    lane.used = true;
    if (lane.model !== ask.model) {
      await lane.q.setModel(ask.model);
      lane.model = ask.model;
    }
    if (lane.effort !== ask.effort) {
      await lane.q.applyFlagSettings({ effortLevel: ask.effort as any });
      lane.effort = ask.effort;
    }
    if (lane.server !== ask.server) {
      lane.server = "";
      const out = await lane.q.setMcpServers(ClaudeSub.mcp(ask.server));
      const err = out.errors?.unii;
      if (err !== undefined) {
        return "claude-sub couldn't reach UniiChat's tools: " + err;
      }
      lane.server = ask.server;
    }
    return null;
  }

  // the call's end, once its last turn ended (or it threw): on a lane of
  // its key; tried once more on a fresh lane if its lane died before
  // anything came out
  export async function run(ask: Ask, on: (ev: Event) => void, sent: Say[], abort: AbortController): Promise<Partial<Awaited<Try["done"]>>> {
    const bin = await ClaudeSub.bin();
    const sdk = await ClaudeSub.sdk();
    const key = ClaudeSub.key(bin, ask);
    let seen: Live[] = [];
    let said = false;
    const emit: Emit = (kind, text, fresh) => {
      said = true;
      live_push(seen, kind, text, fresh);
      on({ $: "Delta", kind, text, fresh });
    };
    const log = (ev: Event) => {
      said = true;
      on(ev);
    };
    try {
      for (let tries = 0; ; tries++) {
        const lane = await ClaudeSub.take(key, ClaudeSub.rank(ask), () => ClaudeSub.start(sdk, bin, key, ask), abort.signal);
        if (lane === null) {
          return {};
        }
        let held = true;
        try {
          const fail = await ClaudeSub.prepare(lane, ask);
          if (fail !== null) {
            return { text: fail, stop: "down" };
          }
          if (abort.signal.aborted) {
            return {};
          }
          const out = await ClaudeSub.turn(lane, ask, emit, log, sent, abort, () => (seen = []));
          if (out === null) {
            held = false;
            ClaudeSub.drain(lane);
            return {};
          }
          if (out.stop === "down" && out.text === SIGN_IN) {
            ClaudeSub.close(lane);
          }
          return out;
        } catch (err: any) {
          ClaudeSub.close(lane);
          if (!(err instanceof Died) || said || abort.signal.aborted || tries > 0) {
            throw err;
          }
        } finally {
          if (held) {
            ClaudeSub.release(lane);
          }
        }
      }
    } finally {
      if (abort.signal.aborted) {
        Agent.fail("stopped", seen).entries.forEach((e) => on({ $: "Entry", ...e }));
      }
    }
  }

  // one call's turn on its lane, read to its result (null: stopped
  // mid-turn; the lane is still in it)
  export async function turn(lane: Lane, ask: Ask, emit: Emit, log: (ev: Event) => void, sent: Say[], abort: AbortController, fresh: () => void): Promise<Partial<Awaited<Try["done"]>> | null> {
    const stopped = new Promise<"stop">((ok) => (abort.signal.aborted ? ok("stop") : abort.signal.addEventListener("abort", () => ok("stop"), { once: true })));
    lane.box.put(ask.blocks.filter((b) => b.text !== "").map((b) => b.text), ask.imgs ?? []);
    for (;;) {
      const r = await Promise.race([ClaudeSub.read(lane), stopped]);
      if (r === "stop") {
        return null;
      }
      if (r.done) {
        throw new Died(DIED);
      }
      const msg = r.value;
      if (msg.type === "stream_event" && msg.parent_tool_use_id === null) {
        Anthropic.live(msg.event, emit);
      }
      if (msg.type === "assistant" && msg.error === undefined) {
        Anthropic.entries(msg.message.content).forEach((e) => log({ $: "Entry", ...e }));
        fresh();
      }
      if (msg.type === "assistant" && msg.error === "authentication_failed") {
        await ClaudeSub.settle(lane);
        return { text: SIGN_IN, stop: "down" };
      }
      if (msg.type === "user" && Array.isArray(msg.message.content)) {
        ClaudeSub.backs(msg.message.content).forEach((e) => log({ $: "Entry", ...e }));
      }
      if (msg.type !== "result") {
        continue;
      }
      if (msg.subtype !== "success" || msg.is_error) {
        const why = msg.subtype === "success" ? msg.result : msg.errors.join("; ");
        return { text: why || msg.subtype, stop: "down" };
      }
      const says = sent.splice(0);
      if (says.length === 0) {
        return { ok: true, text: msg.result.trim() };
      }
      says.forEach((say) => log({ $: "Entry", kind: "user", text: say.text }));
      lane.box.put(says.map((say) => say.text).filter((t) => t !== ""), says.flatMap((say) => say.imgs));
    }
  }

  // a lane's turn read to its result, what's left of it unseen
  export async function settle(lane: Lane): Promise<void> {
    for (;;) {
      const r = await ClaudeSub.read(lane);
      if (r.done || r.value.type === "result") {
        return;
      }
    }
  }

  // the results in a message Claude Code sent itself, each as logged
  export function backs(content: any[]): Array<{ kind: "echo"; text: string; of: string }> {
    const results = content.filter((b) => b.type === "tool_result");
    return results.map((b) => ({ kind: "echo", text: (b.is_error ? "error: " : "") + (AskAI.show(b.content) || "(no output)"), of: b.tool_use_id }));
  }

  // the messages Claude Code reads, as they come; closed: it ends. say: a
  // plain one (a command: /clear)
  export function inbox() {
    const queue: SDKUserMessage[] = [];
    let wake = () => {};
    let shut = false;
    const push = (content: any) => {
      queue.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null });
      wake();
    };
    const put = (texts: string[], imgs: Img[]) => push(Anthropic.content(texts, imgs));
    const say = (text: string) => push(text);
    const close = () => {
      shut = true;
      wake();
    };
    async function* read(): AsyncGenerator<SDKUserMessage> {
      for (;;) {
        while (queue.length > 0) {
          yield queue.shift()!;
        }
        if (shut) {
          return;
        }
        await new Promise<void>((ok) => (wake = ok));
      }
    }
    return { put, say, close, read };
  }

}
