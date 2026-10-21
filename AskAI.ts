// AskAI
// =====
// One way to call a model: a system prompt and a user message in;
// Deltas (live pieces) and an Entry per finished message out. send()
// hands the agent a message at its next chance, stop() aborts, `left`
// holds those never taken. Every vendor is an API run in our loop
// (Agent.ts). A patient call (a summary's) asks again, AGAIN after each
// try nothing answered (the vendor down or refusing it, as when the API
// key's credit is gone; our setup failing), till
// one is answered or we end it (a stop; its payer's refusal: its node
// then waits for the user's credit, with no call: Memory.ts `hold`): an
// outage only delays it, and no summary is made of a failure that isn't
// its input's (Memory.ts). A call that yields (an import's summary,
// naming its import) sends nothing while one that doesn't waits on its
// busy model, nor while another of its import's does (Agent.ts). A
// call's events, payments and end go to its sink, which moves with its
// chat to another process (Server.ts): the call runs on where it started.
//
// Fallback: a call on a profile (Pick.ts) runs on its pick, then on each
// of the profile's models (Pick.falls); one on a model alone has none.
// A try whose vendor is out for every call (End.off: busy past its
// tries, the account refused) and that ran no tool nor took a message
// (End.acted) goes on with the next pick; a patient one, out of picks,
// asks again from the first after AGAIN. A pick out is skipped for COOL
// (the last one is asked anyway), then asked by one request till it
// answers. As a try's answer begins it tells its sink what it runs on
// (Run).
//
// Cache: a marked block ends a prefix the vendor caches. Single flight
// (AskAI.wait), as a request is sent, once its payer let it through: one
// whose prefix no call cached within TTL leads; one whose prefix a leader
// is writing waits until the leader's response begins (only then can it
// read the entry). So a leader is always a request being sent, never one
// waiting for its user's credit or yielding (Agent.ts), which every
// user's calls of its prefix would wait on.

import { Agent } from "./Agent.ts";
import { stream_lines } from "./Clip.ts";
import { Machine } from "./Machine.ts";
import { Pick } from "./Pick.ts";
import * as config from "./Config.ts";
import type { Usage } from "./Price.ts";

// Types
// =====

// the user's, an agent's report ("[Name]\n...", a user turn to the
// model), a thought (shown, never logged), a reply, a tool call, its
// result, a note from before the chat (imported)
export type Kind = "user" | "work" | "mind" | "unii" | "tool" | "echo" | "note";

export type Vendor = "claude-api" | "openai-api";

// an image: its mime type, its bytes in base64
export type Img = { type: string; data: string };

// a message for the agent
export type Say = { text: string; imgs: Img[] };

// a text block of a call's message; `mark`: a cache entry ends after it
export type Block = { text: string; mark: boolean };

// what a paid call serves: the chat's turn, a summary (the chat's, an
// import's), a recording, an agent, a computer-use agent
export type Served = "chat" | "compactor" | "import" | "voice" | "agent" | "computer";

// a paid request let through: the most tokens it may write, why it
// failed should it write them all (null: the model's cap, no failure),
// and what ends it, billing what it used (null: nothing) and letting go
// of its booking
export type Grant = { max: number; cut: string | null; end: (used: Used | null) => void };

// what a request ran on and used
export type Used = { run: Pick; use: Usage };

// a paid request's costs (micro-USD): its input's, each byte of its text a
// token (Agent.worst), and an output token's, priced at that input's size;
// exact: both at its tokens as the API counts them (null: they are)
export type Cost = { input: number; token: number; exact: (() => Promise<Cost>) | null };

// a paid call's payer, the gate every paid request passes right before
// it is sent. Given its costs and the model's most tokens out (cap), it
// books the input (exact, once the credit can't pay cap tokens past its
// bytes) and as many tokens out, up to cap, as the credit less what
// running requests booked pays for, waiting while they hold what a few
// need; why not: the credit alone can't pay a few tokens out. So any
// credit runs any model, a debt is at most what one estimate missed, and
// a reply that wrote all it was let ends, saying why
export type Bill = (cost: Cost, cap: number) => Promise<Grant | string>;

// the bill of a call serving `what`: a zoom target (a message "id", a
// summary "id+n", an agent's name), or "" (a recording); bytes: a
// compaction's input
export type Pay = (kind: Served, what: string, bytes?: number) => Bill;

// searches: the most web searches it runs (0: no web tools); probe: its
// first request goes once (its pick is DOWN)
export type Ask = Pick & {
  system    : string;
  blocks    : Block[];
  imgs?     : Img[];
  searches  : number;
  server    : string;
  bill?     : Bill;
  patient?  : boolean;
  yields?   : string;
  probe?    : boolean;
};

// a prefix cached: until when; while its leader's response has not
// begun, what its waiters wait on
type Cached = { until: number; ready: Promise<void> | null };

// a request's place in single flight: its response began; it ended
export type Flight = { begun: () => void; end: () => void };

// Run: a call with fallbacks answers on `run` (by its model's label),
// having left `from` (null: none, its own pick) as it failed, saying why
export type Event =
  | { $: "Delta"; kind: Kind; text: string; fresh?: boolean }
  | { $: "Entry"; kind: Kind; text: string; of?: string } // of: the tool call it is or answers (a call is logged with its result)
  | { $: "Run"; run: Pick; from: Pick | null; why: string };

// stop: who ended a call that failed (Agent.ts): the model (`fail`: it
// answered, so the failure is its input's doing, a refusal or a stop
// reason; asked again, it fails alike), we (`lost`: a stop, its payer's
// refusal or cut), the vendor (`down`; off: out for every call, not
// this request alone), or none (our setup threw); acted: it ran a tool
// or took a message sent mid-run, which another try would do again
export type End = {
  ok     : boolean;
  text   : string;
  left   : Say[];
  note?  : string;
  stop?  : "fail" | "lost" | "down";
  off?   : boolean;
  acted? : boolean;
};

// one try at a vendor
export type Try = {
  send : (say: Say) => void;
  stop : () => void;
  done : Promise<End>;
};

// where a call's events, payments and end go
export type Sink = { on: (ev: Event) => void; bill?: Bill; end: (end: End) => void };

// a call: its done is its first sink's end; `move` sends what comes
// after to another (its chat moved to another process: Server.ts)
export type Call = Try & { move: (to: Sink) => void };

// Constants
// =========

// how long a patient call waits to ask again: short enough that summaries
// go on within a minute of an outage's end, long enough not to flood the
// vendor meanwhile (its JOBS a side per chat each asking once a minute)
const AGAIN = 60e3;

// how long a vendor keeps a cache entry unused, in ms
export const TTL: Record<Vendor, number> = {
  "claude-api" : 300e3,
  "openai-api" : 1800e3,
};

// the prefixes cached, by key (AskAI.keys)
const CACHE = new Map<string, Cached>();

// how long a pick out (AskAI.down) is skipped
const COOL = 60e3;

// the picks out (vendor:model, as called): till when, why
const DOWN = new Map<string, { until: number; why: string }>();

// AskAI
// =====

export namespace AskAI {

  // a call: its tries, one after another (a patient one's, a fallback's)
  export function ask(ask: Ask, on: (ev: Event) => void): Call {
    const halt = new AbortController();
    const send = (say: Say) => call.send(say);
    const stop = () => {
      halt.abort();
      call.stop();
    };
    const [out, feed] = AskAI.tie(on, ask.bill, send, stop);
    const picks = Pick.falls(ask, ask.profile === undefined ? [] : config.OFFER.profiles?.[ask.profile] ?? []);
    let k = AskAI.up(picks, 0);
    // a try on picks[k], having left the one before it if any
    const go = (): Try => {
      const run = picks[k];
      const from = k > 0 ? picks[k - 1] : null;
      const why = from === null ? "" : DOWN.get(AskAI.down_key(from))?.why ?? "";
      let heard = picks.length === 1;
      const hear = (ev: Event) => {
        if (!heard && (ev.$ === "Delta" || (ev.$ === "Entry" && ev.kind !== "mind"))) {
          heard = true;
          feed.on({ $: "Run", run: Pick.named(run), from: from && Pick.named(from), why });
        }
        feed.on(ev);
      };
      const probe = picks.length > 1 && DOWN.has(AskAI.down_key(run));
      return AskAI.start({ ...ask, ...run, bill: feed.bill, probe }, hear);
    };
    let call = go();
    const run = async (): Promise<End> => {
      let end = await call.done;
      for (;;) {
        const failed = !end.ok && end.stop !== "fail" && end.stop !== "lost" && !halt.signal.aborted;
        const off = failed && end.off === true;
        const up = !halt.signal.aborted && (end.ok || end.stop === "fail" || (end.stop === "down" && !off));
        if (picks.length > 1 && (off || up)) {
          AskAI.down(picks[k], off ? end.text : null);
        }
        const next = off && end.acted !== true && k < picks.length - 1;
        const wait = failed && !next && ask.patient === true;
        if (wait) {
          await Machine.nap(AGAIN, halt.signal);
        }
        if (halt.signal.aborted || (!next && !wait)) {
          return end;
        }
        k = AskAI.up(picks, next ? k + 1 : 0);
        call = go();
        end.left.forEach(send);
        end = await call.done;
      }
    };
    run().then(feed.end, (err) => feed.end(AskAI.end(String(err?.message ?? err))));
    return out;
  }

  // a call fed by `feed` (its tries, or another process: Server.ts),
  // which passes all to the call's sink: first `on`, `bill` and done
  export function tie(on: Sink["on"], bill: Bill | undefined, send: Try["send"], stop: Try["stop"]): [Call, Sink] {
    const { promise, resolve } = Promise.withResolvers<End>();
    let to: Sink = { on, bill, end: resolve };
    const pay: Bill = (cost, cap) => to.bill!(cost, cap);
    const feed: Sink = { on: (ev) => to.on(ev), bill: bill && pay, end: (end) => to.end(end) };
    return [{ send, stop, done: promise, move: (sink) => (to = sink) }, feed];
  }

  // one try; a vendor that throws gives a failed one
  export function start(ask: Ask, on: (ev: Event) => void): Try {
    try {
      return Agent.ask(ask, on);
    } catch (err: any) {
      const end = AskAI.end(err.message);
      const send = (say: Say) => end.left.push(say);
      return { send, stop: () => {}, done: Promise.resolve(end) };
    }
  }

  // a call's end, before it ends: failed, saying `text`
  export function end(text: string): End {
    return { ok: false, text, left: [] };
  }

  // the first of picks from k on not skipped (DOWN), else the last
  export function up(picks: Pick[], k: number): number {
    while (k < picks.length - 1 && (DOWN.get(AskAI.down_key(picks[k]))?.until ?? 0) > Date.now()) {
      k += 1;
    }
    return k;
  }

  // a pick out, saying why (skipped for COOL), or answering (why null),
  // logged as that changes
  export function down(run: Pick, why: string | null): void {
    const key = AskAI.down_key(run);
    if ((why !== null) !== DOWN.has(key)) {
      console.error(Pick.label(Pick.named(run)) + (why !== null ? ": failed; calls go on with their fallbacks" : ": answers again"));
    }
    if (why !== null) {
      DOWN.set(key, { until: Date.now() + COOL, why });
    } else {
      DOWN.delete(key);
    }
  }

  export function down_key(run: Pick): string {
    return run.vendor + ":" + run.model;
  }

  // Cache
  // -----

  // the keys of a call's prefix at each block end through its last mark
  // before its end: what it runs on, its system prompt, tools and blocks,
  // each block's hash seeded by the one before (64 bits)
  export function keys(ask: Ask): string[] {
    const last = ask.blocks.slice(0, -1).findLastIndex((b) => b.mark);
    const head = [ask.vendor, ask.model, ask.effort, ask.speed, ask.system, ask.searches > 0];
    let key = Bun.hash(JSON.stringify(head));
    return ask.blocks.slice(0, last + 1).map((b) => String((key = Bun.hash(b.text, key))));
  }

  // single flight: waits while a leader writes the longest cached part of
  // the call's prefix; then leads, unless its whole prefix is cached
  export async function wait(ask: Ask): Promise<Flight> {
    const keys = AskAI.keys(ask);
    const ttl = TTL[ask.vendor];
    for (;;) {
      const now = Date.now();
      const live = (key: string) => CACHE.get(key)?.ready || (CACHE.get(key)?.until ?? 0) > now;
      const k = keys.findLastIndex(live);
      const got = k < 0 ? null : CACHE.get(keys[k])!;
      if (got?.ready) {
        await got.ready;
        continue;
      }
      if (got !== null) {
        got.until = now + ttl;
        CACHE.delete(keys[k]);
        CACHE.set(keys[k], got);
      }
      if (k === keys.length - 1) {
        return { begun: () => {}, end: () => {} };
      }
      return AskAI.lead(keys[keys.length - 1], ttl, now);
    }
  }

  // the call writing `key`; old entries go as a new one comes, the least
  // lately used first, up to the first still live (a process's calls of
  // all its chats share CACHE)
  export function lead(key: string, ttl: number, now: number): Flight {
    for (const [k, c] of CACHE) {
      if (c.ready !== null || c.until >= now) {
        break;
      }
      CACHE.delete(k);
    }
    let free = () => {};
    const own: Cached = { until: 0, ready: new Promise((ok) => (free = ok)) };
    CACHE.set(key, own);
    const begun = () => {
      if (own.ready !== null) {
        own.ready = null;
        own.until = Date.now() + ttl;
        free();
      }
    };
    const end = () => {
      if (own.ready !== null) {
        CACHE.delete(key);
        own.ready = null;
        free();
      }
    };
    return { begun, end };
  }

  // the non-empty lines of a byte stream
  export async function* lines(stream: ReadableStream<Uint8Array>) {
    for await (const lines of stream_lines(stream)) {
      yield* lines.map((line) => line.trim()).filter((line) => line !== "");
    }
  }

  // a tool result's content (a string, or MCP parts) as text
  export function show(content: any): string {
    if (typeof content === "string") {
      return content;
    }
    return (content ?? []).map((part: any) => part.text ?? "[" + part.type + "]").join("\n");
  }

}
