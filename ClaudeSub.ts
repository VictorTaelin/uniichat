// ClaudeSub
// =========
// The claude-sub vendor: a Claude plan instead of an API key, on the
// Claude Agent SDK. Its Claude Code (the SDK's own binary, unmodified,
// carried inside a compiled unii; config `claude` names another) runs
// with CLAUDE_CONFIG_DIR at DIR (config `claude_sub`): `unii claude` runs
// its `claude auth login` there, so the sign-in is Anthropic's own and
// the token stays Claude Code's, kept and refreshed by it, never read by
// us. A call is one turn: our system prompt, our blocks as its message,
// our tools over MCP (the chat's URL, Tools.ts, set over Claude Code's
// pipe: never on its command line) and web search, always; Claude Code's
// own tools, settings, skills, memory and compaction off. It runs the
// tool loop; we log what it streams. A message sent mid-run goes in once
// its turn ends. Not signed in, the call ends as the vendor's (`down`),
// saying how to sign in.
//
// A Claude Code per call: each call starts its own (~235 MB while it
// runs), which exits as the call ends; a stop kills it (its tool jobs
// stop as their requests drop). Chat turns and subagents start theirs at
// once: a parent waits on its subagents, so a cap there could deadlock.
// Summaries and imports wait on no call: SUMS of them run at most at once
// (Memory.ts starts up to JOBS), a chat's summaries ahead of imports'.
//
// A usage limit never ends a call, as with the other vendors (Agent.ts).
// Claude Code tells it (a rate_limit_event "rejected", saying when it
// resets; then a reply with error rate_limit); the call waits for that
// reset (if not told, a doubling wait up to PACE), its thought saying so
// once, and a message sent or a stop ends the wait. One that ran no tool
// of ours (nor took a message) asks again in a new Claude Code; one that
// did keeps its Claude Code, idle, and at the reset is told to go on
// (ON): its conversation as it was, tool results in, so no tool runs
// again. Usage billed past the plan (isUsingOverage: extra usage) is a
// limit too: the turn is interrupted at once (an answer already whole is
// kept: it is paid). A limit told is remembered till its reset (LIMITS,
// per plan or per model family), and a call under it waits before
// starting a Claude Code, so none asks into it, nor bills extra usage.

import * as child from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Options, Query, SDKMessage, SDKRateLimitInfo, SDKUserMessage, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { AskAI, type Ask, type End, type Event, type Img, type Say, type Try } from "./AskAI.ts";
import { Agent, TRIES, type Emit } from "./Agent.ts";
import { Anthropic } from "./Anthropic.ts";
import { Machine } from "./Machine.ts";
import { live_push, type Live } from "./View.ts";
import * as config from "./Config.ts";

// Constants
// =========

const DIR = config.CLAUDE_SUB;

// the most summaries' and imports' Claude Codes running at once
export const SUMS = 4;

// the longest wait between asks at a usage limit whose reset isn't told
// (a patient call's: AGAIN, as AskAI's)
const PACE  = 1800e3;
const AGAIN = 60e3;

// a carried binary's copy younger than this is never removed (another
// process may have just written it, not yet marked it as its own)
const FRESH = 60e3;

// what a call that ran tools is told as its usage limit resets
export const ON = "(The AI service's usage limit cut your last step short. It has reset: go on.)";

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

// a call's Claude Code: its query, the messages it reads, its process
// (once spawned), when that exited, and what tells it did
type Code = {
  q    : Query;
  box  : ReturnType<typeof ClaudeSub.inbox>;
  proc : child.ChildProcess | null;
  exit : Promise<void>;
  gone : () => void;
};

// a turn's end: the call's, or a usage limit (until: its reset, if told,
// ms since 1970; text: Claude Code's words)
type Out = Partial<End> & { limit?: { until: number | null; text: string } };

// a summary or import waiting for a slot: an import's or not, its place
// in line, what lets it go
type Wait = { imp: boolean; n: number; go: () => void };

// a turn's Claude Code ended unbidden
class Died extends Error {}

// State
// =====

// the binary and the SDK, loaded once
const LOADED = { bin: null as Promise<string> | null, sdk: null as Promise<Sdk> | null };

// the summaries' slots: how many run, those waiting
const SLOTS = { busy: 0, waits: [] as Wait[], n: 0 };

// the usage limits told: the plan's (""), or a model family's ("opus",
// "sonnet": a weekly limit of its own); till when, and whether asking
// under it would bill extra usage
const LIMITS = new Map<string, { until: number; bills: boolean }>();

// ClaudeSub
// =========

export namespace ClaudeSub {

  // the Claude Code it runs: config `claude`, else the one a compiled unii
  // carries (Build.ts; written out once, under the unii dir, as a process
  // can't run it from inside unii), else the SDK's in node_modules
  export function bin(): Promise<string> {
    LOADED.bin ??= ClaudeSub.find().catch((err) => {
      LOADED.bin = null;
      throw err;
    });
    return LOADED.bin;
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
  // extractFromBunfs (to a dir named by its hash; /tmp is often RAM),
  // marked as this process's, and the copies of other versions no
  // running unii uses removed (`prune`)
  export async function extract(inside: string): Promise<string> {
    const { extractFromBunfs } = await import("@anthropic-ai/claude-agent-sdk/extract");
    const was = process.env.CLAUDE_CODE_TMPDIR;
    process.env.CLAUDE_CODE_TMPDIR = config.DIR;
    try {
      const out = extractFromBunfs(inside);
      ClaudeSub.claim(path.dirname(out));
      ClaudeSub.prune(path.dirname(path.dirname(out)), path.basename(path.dirname(out)));
      return out;
    } finally {
      was === undefined ? delete process.env.CLAUDE_CODE_TMPDIR : (process.env.CLAUDE_CODE_TMPDIR = was);
    }
  }

  // a binary's copy marked as used by this process (a file named by its
  // pid, under `users`), unmarked as it exits
  export function claim(dir: string): void {
    const mine = path.join(dir, "users", String(process.pid));
    fs.mkdirSync(path.dirname(mine), { recursive: true, mode: 0o700 });
    fs.writeFileSync(mine, "");
    process.once("exit", () => fs.rmSync(mine, { force: true }));
  }

  // the copies of other versions (dirs claude-agent-sdk-<hash> in home
  // but `keep`) removed, but those a live process marked, or new
  export function prune(home: string, keep: string): void {
    for (const old of fs.readdirSync(home)) {
      const dir = path.join(home, old);
      if (old.startsWith("claude-agent-sdk-") && old !== keep && !ClaudeSub.used(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }

  export function used(dir: string): boolean {
    const users = path.join(dir, "users");
    const times = [dir, users].map((p) => fs.statSync(p, { throwIfNoEntry: false })?.mtimeMs ?? 0);
    if (Date.now() - Math.max(...times) < FRESH) {
      return true;
    }
    const pids = fs.existsSync(users) ? fs.readdirSync(users).map(Number) : [];
    return pids.some((pid) => pid > 0 && ClaudeSub.alive(pid));
  }

  export function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: any) {
      return err?.code === "EPERM";
    }
  }

  // the SDK, loaded once (a test hands in its own)
  export function sdk(): Promise<Sdk> {
    LOADED.sdk ??= import("@anthropic-ai/claude-agent-sdk").catch((err) => {
      LOADED.sdk = null;
      throw err;
    });
    return LOADED.sdk;
  }

  export function use(sdk: unknown): void {
    LOADED.sdk = Promise.resolve(sdk as Sdk);
  }

  // its environment: ours, less what would sign it in or send it
  // elsewhere (an API key, a token, a base URL, Bedrock, Vertex...)
  // (its config dir made, or kept, its owner's alone)
  export function env(): Record<string, string | undefined> {
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    fs.chmodSync(DIR, 0o700);
    const ours = Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC_|CLAUDE_)/.test(k));
    return { ...Object.fromEntries(ours), ...ENV, CLAUDE_CONFIG_DIR: DIR };
  }


  // `unii claude [logout|status]`
  export async function cli(args: string[]): Promise<void> {
    const cmd = args.includes("logout") ? ["logout"] : args.includes("status") ? ["status"] : ["login", "--claudeai"];
    const run = Bun.spawn([await ClaudeSub.bin(), "auth", ...cmd], { env: ClaudeSub.env(), stdio: ["inherit", "inherit", "inherit"] });
    process.exitCode = await run.exited;
  }

  // a call (ClaudeSub.run); a message sent, like a stop, ends a wait for
  // a usage limit
  export function ask(ask: Ask, on: (ev: Event) => void): Try {
    const end = AskAI.end("");
    const sent: Say[] = [];
    const abort = new AbortController();
    const wake = { poke: () => {} };
    const send = (say: Say) => {
      sent.push(say);
      wake.poke();
    };
    const stop = () => {
      end.text = "stopped";
      abort.abort();
    };
    const done = ClaudeSub.run(ask, on, sent, abort.signal, wake).then(
      (out) => abort.signal.aborted || Object.assign(end, out),
      (err) => (end.text ||= err.message),
    ).then(() => {
      end.ok   = end.ok && !abort.signal.aborted;
      end.left = sent;
      return end;
    });
    return { send, stop, done };
  }

  // what a call's Claude Code starts with; builtin: Claude Code's tools
  // (the SDK's BUILTIN_TOOL_NAMES). Web search is always on (a summary's
  // call has it too). Our tools load up front, never behind its tool
  // search, and a call may run past the 60 s Claude Code gives an HTTP
  // MCP request. Our MCP server is set once it runs (ClaudeSub.connect),
  // over its pipe: its secret URL is never on its command line
  export function options(ask: Ask, abort: AbortController, builtin: readonly string[]): Options {
    const tools = WEB;
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


  // Summaries' slots
  // ----------------

  // the summaries' and imports' Claude Codes running, those waiting (for
  // tests)
  export function slots(): { busy: number; waits: number } {
    return { busy: SLOTS.busy, waits: SLOTS.waits.length };
  }

  // a slot for a summary's or import's Claude Code (false: stopped while
  // waiting), in line: a chat's summaries first, then imports
  export function slot(ask: Ask, signal: AbortSignal): Promise<boolean> {
    return new Promise((ok) => {
      if (signal.aborted) {
        return ok(false);
      }
      const off = () => {
        SLOTS.waits = SLOTS.waits.filter((w) => w !== wait);
        ok(false);
      };
      const wait: Wait = { imp: ask.yields !== undefined, n: SLOTS.n++, go: () => (signal.removeEventListener("abort", off), ok(true)) };
      signal.addEventListener("abort", off, { once: true });
      SLOTS.waits.push(wait);
      ClaudeSub.grant();
    });
  }

  export function grant(): void {
    SLOTS.waits.sort((a, b) => Number(a.imp) - Number(b.imp) || a.n - b.n);
    while (SLOTS.busy < SUMS && SLOTS.waits.length > 0) {
      SLOTS.busy += 1;
      SLOTS.waits.shift()!.go();
    }
  }

  export function free(): void {
    SLOTS.busy -= 1;
    ClaudeSub.grant();
  }

  // A call's Claude Code
  // --------------------

  // a call's Claude Code, started on its pick (holding a slot if `held`:
  // freed as it exits); its process spawned as the SDK's own spawn does
  // (stderr unread), but watched
  export function start(sdk: Sdk, bin: string, ask: Ask, held: boolean): Code {
    const box = ClaudeSub.inbox();
    let gone = () => {};
    const exit = new Promise<void>((ok) => (gone = ok));
    if (held) {
      exit.then(ClaudeSub.free);
    }
    const code = { box, proc: null, exit, gone } as Omit<Code, "q"> as Code;
    const spawn = (o: SpawnOptions) => {
      const proc = child.spawn(o.command, o.args, { cwd: o.cwd, env: o.env, signal: o.signal, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
      code.proc = proc;
      proc.once("exit", gone);
      proc.once("error", () => proc.pid === undefined && gone());
      return proc;
    };
    const options = { ...ClaudeSub.options(ask, new AbortController(), sdk.BUILTIN_TOOL_NAMES), pathToClaudeCodeExecutable: bin, spawnClaudeCodeProcess: spawn };
    try {
      code.q = sdk.query({ prompt: box.read(), options });
    } catch (err) {
      gone();
      throw err;
    }
    return code;
  }

  // a call's Claude Code ended (the SDK's close: SIGTERM, then SIGKILL),
  // done as it exits
  export function close(code: Code): Promise<void> {
    code.box.close();
    try {
      code.q.close();
    } catch {}
    if (code.proc === null || code.proc.exitCode !== null || code.proc.signalCode !== null) {
      code.gone();
    }
    return code.exit;
  }

  // its next message
  export function read(code: Code): Promise<IteratorResult<SDKMessage>> {
    const next = code.q.next().catch((err) => {
      throw new Died(err?.message ?? String(err));
    });
    next.catch(() => {});
    return next;
  }

  // our MCP server set for the call (a call with none, as a summary's, has
  // no tools of ours); why it failed (null: it didn't, or a stop came)
  export async function connect(code: Code, server: string, signal: AbortSignal): Promise<string | null> {
    if (server === "") {
      return null;
    }
    const out = await ClaudeSub.race(code.q.setMcpServers(ClaudeSub.mcp(server)), signal);
    const err = out?.errors?.unii;
    return err === undefined ? null : "claude-sub couldn't reach UniiChat's tools: " + err;
  }

  // a promise's value, or null once `signal` aborts
  export function race<T>(go: Promise<T>, signal: AbortSignal): Promise<T | null> {
    go.catch(() => {});
    let drop = () => {};
    const stopped = new Promise<null>((done) => {
      const stop = () => done(null);
      signal.aborted ? stop() : signal.addEventListener("abort", stop, { once: true });
      drop = () => signal.removeEventListener("abort", stop);
    });
    return Promise.race([go, stopped]).finally(drop);
  }

  // Usage limits
  // ------------

  // when a limit Claude Code told resets (ms since 1970; null: not told).
  // It tells seconds
  export function reset(info: SDKRateLimitInfo): number | null {
    const at = info.resetsAt;
    return typeof at === "number" && at > 0 ? (at < 1e12 ? at * 1e3 : at) : null;
  }

  // a limit told, kept till its reset, or lifted: the plan's, or a model
  // family's. One whose reset isn't told is kept PACE if asking under it
  // bills (extra usage on), else not (the call's doubling waits pace it)
  export function note(info: SDKRateLimitInfo): void {
    const scope = /opus|sonnet/.exec(info.rateLimitType ?? "")?.[0] ?? "";
    const bills = info.isUsingOverage === true || info.overageStatus === "allowed" || info.overageStatus === "allowed_warning";
    const until = ClaudeSub.reset(info) ?? (bills ? Date.now() + PACE : null);
    if ((info.status === "rejected" || info.isUsingOverage === true) && until !== null) {
      LIMITS.set(scope, { until, bills });
    } else {
      LIMITS.delete(scope);
    }
  }

  // the latest reset of the limits a call on `model` is under (null:
  // none); billing: only those asking under would bill
  export function limited(model: string, billing: boolean): number | null {
    const now = Date.now();
    const family = /opus|sonnet/.exec(model)?.[0];
    const told = ["", ...(family ? [family] : [])].map((k) => LIMITS.get(k)).filter((l) => l !== undefined && l.until > now && (l.bills || !billing));
    return told.length > 0 ? Math.max(...told.map((l) => l!.until)) : null;
  }

  // the limits told forgotten (for tests)
  export function forget(): void {
    LIMITS.clear();
  }

  // how long a call waits at its `n`th usage limit in a row: till the
  // reset told (from TRIES on, at least the doubling), else a doubling up
  // to PACE (a patient call's: AGAIN), as Agent.limit_wait does
  export function wait(until: number | null, n: number, patient: boolean): number {
    const back = Math.min(2 ** n * 1e3, patient ? AGAIN : PACE);
    const left = until === null ? 0 : until - Date.now();
    return Math.min(2 ** 31 - 1, left <= 0 ? back : n < TRIES ? left : Math.max(left, back));
  }

  // a call waits `ms` for a usage limit, its thought logged if `say`; a
  // message sent (wake: true) or a stop ends the wait
  export async function park(on: (ev: Event) => void, ms: number, say: boolean, signal: AbortSignal, wake: { poke: () => void }): Promise<boolean> {
    const end = new AbortController();
    let woke = false;
    const stop = () => end.abort();
    wake.poke = () => ((woke = true), stop());
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) {
      stop();
    }
    if (say) {
      on({ $: "Entry", kind: "mind", text: "The AI service reached a usage limit: asking again in " + ClaudeSub.span(ms) + "." });
    }
    try {
      await Machine.nap(ms, end.signal);
    } finally {
      signal.removeEventListener("abort", stop);
      wake.poke = () => {};
    }
    return woke;
  }

  // a wait as people read it: "5 min", "3 h 20 min"
  export function span(ms: number): string {
    const min = Math.max(1, Math.round(ms / 60e3));
    return min < 60 ? min + " min" : Math.floor(min / 60) + " h" + (min % 60 > 0 ? " " + (min % 60) + " min" : "");
  }

  // A call
  // ------

  // the call's end: its Claude Code started (a summary's once it has a
  // slot), our MCP server set, its message in, its turn read to its end.
  // Under a usage limit told it waits before asking (a message sent ends
  // the wait, as at the vendor's, unless asking would bill extra usage);
  // at one, it waits for the reset, then asks again (ran no tool: in a
  // new Claude Code) or goes on (ON). One whose Claude Code dies before
  // anything came out is tried once more. A binary's copy gone since
  // (removed by hand) is written out again
  export async function run(ask: Ask, on: (ev: Event) => void, sent: Say[], signal: AbortSignal, wake: { poke: () => void }): Promise<Partial<End>> {
    let bin = await ClaudeSub.bin();
    if (!fs.existsSync(bin)) {
      LOADED.bin = null;
      bin = await ClaudeSub.bin();
    }
    const sdk = await ClaudeSub.sdk();
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
    const acted = { v: false };
    let code: Code | null = null;
    let parked = false;
    let woke = false;
    const sleep = async (ms: number) => {
      woke = await ClaudeSub.park(on, ms, !parked, signal, wake);
      parked = true;
    };
    try {
      for (let tries = 0, n = 0; !signal.aborted; ) {
        const until = ClaudeSub.limited(ask.model, woke);
        woke = false;
        if (until !== null) {
          await sleep(until - Date.now());
          continue;
        }
        if (code === null) {
          const held = ask.patient === true;
          if (held && !(await ClaudeSub.slot(ask, signal))) {
            return {};
          }
          code = ClaudeSub.start(sdk, bin, ask, held);
          const fail = await ClaudeSub.connect(code, ask.server, signal);
          if (fail !== null) {
            return { text: fail, stop: "down" };
          }
          if (signal.aborted) {
            return {};
          }
          code.box.put(ask.blocks.filter((b) => b.text !== "").map((b) => b.text), ask.imgs ?? []);
        } else if (n > 0) {
          const says = sent.splice(0);
          says.forEach((say) => log({ $: "Entry", kind: "user", text: say.text }));
          code.box.put([ON, ...says.map((say) => say.text).filter((t) => t !== "")], says.flatMap((say) => say.imgs));
        }
        let out: Out | null;
        try {
          out = await ClaudeSub.turn(code, emit, log, sent, signal, acted, () => (seen = []));
        } catch (err) {
          if (!(err instanceof Died) || said || signal.aborted || tries > 0) {
            throw err;
          }
          tries += 1;
          void ClaudeSub.close(code);
          code = null;
          continue;
        }
        if (out === null || out.limit === undefined) {
          return out ?? {};
        }
        n += 1;
        if (!acted.v) {
          void ClaudeSub.close(code);
          code = null;
        }
        await sleep(ClaudeSub.wait(out.limit.until, n, ask.patient === true));
      }
      return {};
    } finally {
      if (code !== null) {
        void ClaudeSub.close(code);
      }
      if (signal.aborted) {
        Agent.fail("stopped", seen).entries.forEach((e) => on({ $: "Entry", ...e }));
      }
    }
  }

  // a turn read to its result (null: stopped); a tool of ours run, or a
  // message sent taken, marks the call `acted`. At usage billed past the
  // plan the turn is interrupted: its end a limit, unless its answer came
  // whole (paid already) with no message to take (another request)
  export async function turn(code: Code, emit: Emit, log: (ev: Event) => void, sent: Say[], signal: AbortSignal, acted: { v: boolean }, fresh: () => void): Promise<Out | null> {
    const stopped = new Promise<"stop">((ok) => (signal.aborted ? ok("stop") : signal.addEventListener("abort", () => ok("stop"), { once: true })));
    let info: SDKRateLimitInfo | null = null;
    let hit = false;
    let over = false;
    for (;;) {
      const r = await Promise.race([ClaudeSub.read(code), stopped]);
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
      if (msg.type === "rate_limit_event") {
        info = msg.rate_limit_info;
        ClaudeSub.note(info);
        if (info.isUsingOverage === true && !over) {
          over = true;
          code.q.interrupt().catch(() => {});
        }
      }
      if (msg.type === "assistant" && msg.error === undefined) {
        Anthropic.entries(msg.message.content).forEach((e) => log({ $: "Entry", ...e }));
        acted.v ||= msg.message.content.some((b: any) => b.type === "tool_use" && !WEB.includes(b.name));
        fresh();
      }
      if (msg.type === "assistant" && msg.error === "authentication_failed") {
        await ClaudeSub.settle(code);
        return { text: SIGN_IN, stop: "down" };
      }
      hit ||= msg.type === "assistant" && msg.error === "rate_limit";
      if (msg.type === "user" && Array.isArray(msg.message.content)) {
        ClaudeSub.backs(msg.message.content).forEach((e) => log({ $: "Entry", ...e }));
      }
      if (msg.type !== "result") {
        continue;
      }
      const ok = msg.subtype === "success" && !msg.is_error;
      const why = msg.subtype === "success" ? msg.result : msg.errors.join("; ");
      if ((!ok && (hit || over || info?.status === "rejected")) || (over && sent.length > 0)) {
        acted.v ||= ok;
        return { limit: { until: info && ClaudeSub.reset(info), text: why } };
      }
      if (!ok) {
        return { text: why || msg.subtype, stop: "down" };
      }
      const says = sent.splice(0);
      if (says.length === 0) {
        return { ok: true, text: msg.result.trim() };
      }
      acted.v = true;
      says.forEach((say) => log({ $: "Entry", kind: "user", text: say.text }));
      code.box.put(says.map((say) => say.text).filter((t) => t !== ""), says.flatMap((say) => say.imgs));
    }
  }

  // a turn read to its result, what's left of it unseen
  export async function settle(code: Code): Promise<void> {
    for (;;) {
      const r = await ClaudeSub.read(code);
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

  // the messages Claude Code reads, as they come; closed: it ends
  export function inbox() {
    const queue: SDKUserMessage[] = [];
    let wake = () => {};
    let shut = false;
    const push = (content: any) => {
      queue.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null });
      wake();
    };
    const put = (texts: string[], imgs: Img[]) => push(Anthropic.content(texts, imgs));
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
    return { put, close, read };
  }

}
