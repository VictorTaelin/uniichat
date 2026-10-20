// Agent
// =====
// claude-api and openai-api in Unii's own loop; a Wire (Anthropic.ts,
// OpenAI.ts) shapes requests and reads streams. Each step sends every
// item and streams one output; tool calls run in order, a message sent
// mid-run follows the next results, and the call ends at a step with no
// tools and nothing sent. A request goes again, TRIES times at most,
// after its retry-after or a doubling wait, for a passing reason (`busy`:
// no connection, a retry status, a stream error, cut short or silent for
// the wire's `idle`), dropping what it streamed. A request that yields
// (an import's summary, AskAI.ts) sends nothing while one that doesn't
// (a turn's, a chat's summary, which a turn waits on) waits on its busy
// model: the room a busy vendor has goes to the chats first, and many
// imports never starve every chat of the summaries its next turn needs.
// An import asks a busy model again by one request at a time, the rest
// waiting on it, so imports share what room is left alike, however many
// requests each runs.
// A usage limit (a 429 but OpenAI's insufficient_quota, or a rate-limit
// stream error) never ends a call: it asks again at the reset the vendor
// tells, else after a doubling wait up to LIMIT (a patient call's:
// AGAIN); from TRIES on, at least that doubling, so one that never
// clears never asks fast. A wait of LONG or more parks it (Agent.park):
// a Limit event tells till when, and a message sent, a wake or a stop
// ends the wait.
// A busy model is logged as its first request asks again and as its
// last is done, never each try (a storm logged ~600 lines a second).
// A call ends answered
// (`fail`: the model's answer failed, a refusal or a stop reason: its
// input's doing) or not: `down`, the vendor's (a refusal of the request,
// as when the API key's credit is gone, or busy past TRIES); `lost`,
// ours (a stop, its payer's refusal or cut), saying why. A vendor's why
// (`busy`, `down`) goes to the log; the user reads only that the AI
// service is busy, as the call's end, each retry's thought and where a
// call is cut (a vendor's errors speak of the server's account, not the
// user's). A stop ends the call at once; a paid one's
// request is read on to its end, out of sight, and billed whole (a
// stream cut short is billed what it read: Agent.used), a free one's is
// cut. A paid request is booked first (worst, Bill: AskAI.ts), then takes
// its place in single flight (AskAI.wait).

import { AGAIN, AskAI, type Grant, type Cost, type Ask, type Block, type Flight, type Try, type End, type Event, type Img, type Kind, type Say } from "./AskAI.ts";
import { Anthropic } from "./Anthropic.ts";
import { OpenAI } from "./OpenAI.ts";
import { Price, type Usage } from "./Price.ts";
import { live_push } from "./View.ts";
import { Machine, type Spec } from "./Machine.ts";
import * as config from "./Config.ts";

// Types
// =====

export type Out = { text: string; fail: boolean; imgs?: Img[] };

export type Tool = Spec;

// what a request's stream read: the bytes of its output, and whether it
// ended (its last event read, its usage all told)
export type Read = { bytes: number; done: boolean };

// a running call: the messages sent mid-run not taken yet
type Run = {
  ask   : Ask;
  on    : (ev: Event) => void;
  sent  : Say[];
  abort : AbortController;
  end   : End;
  poke  : () => void; // a message was sent, or a wake: ends a park
};

export type Back = { id: string; out: Out };

// a room at a busy model, a model's or an import's (AskAI.ts `yields`):
// the requests asking again that hold it (a model's: those that don't
// yield; an import's: the one asking for all its requests), and those
// waiting till none does; a model's counts all its requests asking
// again too, logged as they go from none to some and back
type Room = { busy: number; asking: number; wait: Array<() => void> };

export type Item =
  | { $: "User"; parts: Block[]; imgs: Img[] } // user text, images
  | { $: "Turn"; out: unknown[] }             // the model's output, as its API gave it
  | { $: "Back"; backs: Back[] };             // tool results

// a tool call: its input (null: not JSON)
export type Use = { id: string; name: string; input: unknown };

export type Entry = { kind: Kind; text: string; of?: string };

// note: what it did other than asked
export type Step = {
  out     : unknown[];
  uses    : Use[];
  entries : Entry[];
  stop    : "done" | "tools" | "again" | "busy" | "limit" | "down" | "lost" | "fail";
  why     : string;
  note    : string;
};

export type Emit = (kind: Kind, text: string, fresh?: boolean) => void;

// an API: its key's name in config.KEYS, a body's input tokens as it
// counts them (null: not told), and how its stream reads into a step (S:
// what it read so far)
export type Wire<S> = {
  key     : string;
  idle    : number;
  url     : string;
  headers : (key: string, ask: Ask) => Record<string, string>;
  body    : (ask: Ask, items: Item[], tools: Tool[], max: number) => unknown;
  count   : (key: string, ask: Ask, body: unknown) => Promise<number | null>;
  start   : (ask: Ask) => S;
  read    : (st: S, ev: any, on: Emit) => boolean;
  begun   : (ev: any) => boolean;
  step    : (st: S, ask: Ask) => Step;
  usage   : (st: S) => Usage;
};

// Constants
// =========

// a request's most output tokens: the models' own cap (less, if a paid
// one's credit pays for less: Bill)
const MAX   = 128000;
export const TRIES = 8;

// what a call the vendor never answered says
const BUSY  = "the AI service is busy or unavailable right now";

// a usage limit's waits: from how long one parks its call, and the
// longest it waits between tries when no reset is told
export const LONG  = 60e3;
export const LIMIT = 1800e3;

// the most tokens a model reads an image as (scaled to 1568 px at most),
// and a web search's results are booked as (0.1k to 8k)
const PIC    = 4096;
const RESULT = 5000;

// what a request on a free server is let write: all
const FREE: Grant = { max: MAX, cut: null, end: () => {} };

// the rooms held or waited on, by model, or model and import (Agent.step)
const ROOMS = new Map<string, Room>();

// the requests sent whose answers are not read to their end: a process
// ends only once none is (Server.ts Main.leave), as a paid one goes on
// after a stop and is billed only at its end
export const READING = { n: 0 };

// Agent
// =====

export namespace Agent {

  export function ask(ask: Ask, on: (ev: Event) => void): Try {
    const end = AskAI.end("");
    const run: Run = { ask, on, sent: [], abort: new AbortController(), end, poke: () => {} };
    const send = (say: Say) => {
      run.sent.push(say);
      run.poke();
    };
    const stop = () => {
      end.text = "stopped";
      run.abort.abort();
    };
    const done = (async () => {
      try {
        if (ask.vendor === "claude-api") {
          await Agent.loop(Anthropic.wire, run);
        } else {
          await Agent.loop(OpenAI.wire, run);
        }
      } catch (err: any) {
        end.text ||= err.message;
      }
      end.ok   = end.ok && !run.abort.signal.aborted;
      end.left = run.sent;
      return end;
    })();
    return { send, stop, wake: () => run.poke(), done };
  }

  export async function loop<S>(wire: Wire<S>, run: Run): Promise<void> {
    const { ask, on, end } = run;
    const signal = run.abort.signal;
    const key = config.KEYS[wire.key];
    if (!key) {
      throw new Error("no API key: set " + wire.key.toUpperCase() + "_API_KEY");
    }
    const tools = await Agent.server(run);
    const parts = ask.blocks.filter((b) => b.text !== "");
    const items: Item[] = [{ $: "User", parts, imgs: ask.imgs ?? [] }];
    while (!signal.aborted) {
      const step = await Agent.step(wire, run, key, (max) => wire.body(ask, items, tools, max), items);
      for (const entry of step.entries) {
        on({ $: "Entry", ...entry });
      }
      if (step.stop === "down" || step.stop === "lost" || step.stop === "fail") {
        end.text ||= step.stop === "down" ? BUSY : step.why;
        end.stop = step.stop;
        return;
      }
      items.push({ $: "Turn", out: step.out });
      end.note = step.note || end.note;
      if (step.stop === "again") {
        continue;
      }
      const backs: Back[] = [];
      for (const use of step.uses) {
        if (signal.aborted) {
          return;
        }
        const out = await Agent.use(run, tools, use);
        on({ $: "Entry", kind: "echo", text: (out.fail ? "error: " : "") + out.text, of: use.id });
        backs.push({ id: use.id, out });
      }
      if (signal.aborted) {
        return;
      }
      const says = run.sent.splice(0);
      const replies = step.entries.filter((e) => e.kind === "unii");
      const text = replies.map((e) => e.text).join("\n\n");
      if (backs.length === 0 && says.length === 0) {
        end.ok   = true;
        end.text = text;
        return;
      }
      for (const say of says) {
        on({ $: "Entry", kind: "user", text: say.text });
      }
      if (backs.length > 0) {
        items.push({ $: "Back", backs });
      }
      if (says.length > 0) {
        const parts = says.filter((say) => say.text !== "").map((say) => ({ text: say.text, mark: false }));
        const imgs = says.flatMap((say) => say.imgs);
        items.push({ $: "User", parts, imgs });
      }
    }
  }

  // make: the request's body, writing `max` tokens at most. Asking again,
  // it holds its room (Room): its model's, or its import's, which one
  // request holds at a time while the rest wait on it, so each import
  // has one request at a busy model however many it runs, and imports
  // share its room alike. k: its busy tries, n: its usage-limit ones
  export async function step<S>(wire: Wire<S>, run: Run, key: string, make: (max: number) => unknown, items: Item[]): Promise<Step> {
    const body = make(MAX);
    const cost = Agent.worst(run.ask, JSON.stringify(body), items, () => wire.count(key, run.ask, body));
    const signal = run.abort.signal;
    const model = run.ask.model;
    const own = run.ask.yields === undefined ? model : model + " " + run.ask.yields;
    let asking = false;
    let parked = false;
    try {
      for (let k = 0, n = 0; !signal.aborted; ) {
        await Agent.yielded(run, own, asking);
        const seen: Entry[] = [];
        const got = await Agent.race(Agent.request(wire, run, key, make, cost, seen), signal);
        if (got === null) {
          return Agent.fail("stopped", seen);
        }
        const { res, step } = got;
        const limit = step.stop === "limit";
        k += step.stop === "busy" ? 1 : 0;
        n += limit ? 1 : 0;
        if (step.stop === "down") {
          console.error(model + ": " + step.why.slice(0, 300));
        }
        if (!limit && (step.stop !== "busy" || k >= TRIES)) {
          return step.stop === "busy" ? { ...step, stop: "down" } : step;
        }
        if (!asking && own !== model && (ROOMS.get(own)?.busy ?? 0) > 0) {
          continue;
        }
        if (!asking) {
          Agent.hold(model, own, step.why);
          asking = true;
        }
        const after = Number(res?.headers.get("retry-after") ?? "");
        const { ms, known } = limit ? Agent.limit_wait(res, n, run.ask.patient ? AGAIN : LIMIT) : { ms: (after > 0 ? after : 2 ** k) * 1e3, known: false };
        if (limit && ms >= LONG) {
          await Agent.park(run, ms, known, !parked);
          parked = true;
          continue;
        }
        run.on({ $: "Entry", kind: "mind", text: "The AI service is busy: asking again in " + Math.ceil(ms / 1e3) + " s." });
        await Machine.nap(ms, signal);
      }
      return Agent.fail("stopped", []);
    } finally {
      if (asking) {
        Agent.free(model, own);
      }
    }
  }

  // a promise's value, or null once `signal` aborts; its listener gone
  // either way (a call at a usage limit asks again without end)
  export function race<T>(go: Promise<T>, signal: AbortSignal): Promise<T | null> {
    let drop = () => {};
    const stopped = new Promise<null>((done) => {
      const stop = () => done(null);
      signal.addEventListener("abort", stop, { once: true });
      drop = () => signal.removeEventListener("abort", stop);
    });
    return Promise.race([go, stopped]).finally(drop);
  }

  // how long a call waits at its `n`th usage limit in a row: the reset
  // told (from TRIES on, at least the doubling), else a doubling up to
  // `pace`; known: it waits for the reset told
  export function limit_wait(res: Response | null, n: number, pace: number): { ms: number; known: boolean } {
    const now = Date.now();
    const told = Agent.reset(res, now);
    const back = Math.min(2 ** n * 1e3, pace);
    const ms = told === null ? back : n < TRIES ? told - now : Math.max(told - now, back);
    return { ms, known: told !== null && ms === told - now };
  }

  // a call waits `ms` for its usage limit, told till when (Limit), its
  // thought logged if `say`; a stop, a message sent or a wake ends it
  export async function park(run: Run, ms: number, known: boolean, say: boolean): Promise<void> {
    const wake = new AbortController();
    const end = () => wake.abort();
    run.poke = end;
    run.abort.signal.addEventListener("abort", end, { once: true });
    if (run.abort.signal.aborted) {
      end();
    }
    run.on({ $: "Limit", limit: { until: Date.now() + ms, known } });
    if (say) {
      run.on({ $: "Entry", kind: "mind", text: "The AI service reached a usage limit: asking again in " + Agent.span(ms) + "." });
    }
    try {
      await Machine.nap(ms, wake.signal);
    } finally {
      run.abort.signal.removeEventListener("abort", end);
      run.poke = () => {};
      run.on({ $: "Limit", limit: null });
    }
  }

  // a wait as people read it: "5 min", "3 h 20 min"
  export function span(ms: number): string {
    const min = Math.max(1, Math.round(ms / 60e3));
    return min < 60 ? min + " min" : Math.floor(min / 60) + " h" + (min % 60 > 0 ? " " + (min % 60) + " min" : "");
  }

  // when a usage limit resets, as the vendor tells it (ms since the epoch;
  // null: not told, past, or too far for a timer): its retry-after
  // (seconds or a date), else the latest of its ratelimit headers' resets
  // (Anthropic's anthropic-ratelimit-*-reset, a date or epoch seconds;
  // OpenAI's x-ratelimit-reset-*, a span like "6m0s")
  export function reset(res: Response | null, now: number): number | null {
    const UNIT: Record<string, number> = { h: 3600e3, m: 60e3, s: 1e3, ms: 1 };
    const at = (name: string, v: string): number =>
      name.startsWith("x-") ? now + [...v.matchAll(/([\d.]+)(ms|h|m|s)/g)].reduce((t, m) => t + Number(m[1]) * UNIT[m[2]], 0)
      : /^\d+(\.\d+)?$/.test(v.trim()) ? (name === "retry-after" ? now : 0) + Number(v) * 1e3
      : Date.parse(v);
    const ok = (t: number) => t > now && t - now < 2 ** 31;
    const told = [...(res?.headers ?? [])].filter(([name]) => /^(retry-after|anthropic-ratelimit-.+-reset|x-ratelimit-reset-.+)$/.test(name)).map(([name, v]) => [name, at(name, v)] as const).filter(([, t]) => ok(t));
    const after = told.find(([name]) => name === "retry-after");
    return after?.[1] ?? (told.length > 0 ? Math.max(...told.map(([, t]) => t)) : null);
  }

  export function room(key: string): Room {
    const room = ROOMS.get(key) ?? { busy: 0, asking: 0, wait: [] };
    ROOMS.set(key, room);
    return room;
  }

  // a request asks `model` again, holding `own`, its model's room or its
  // import's; the model's first says why
  export function hold(model: string, own: string, why: string): void {
    if (Agent.room(model).asking++ === 0) {
      console.error(model + ": " + why.slice(0, 300) + ": its requests ask again");
    }
    Agent.room(own).busy += 1;
  }

  // ... and lets go of it, answered or not: the last frees those waiting
  export function free(model: string, own: string): void {
    const room = Agent.room(own);
    room.busy -= 1;
    if (room.busy === 0) {
      room.wait.splice(0).forEach((ok) => ok());
    }
    if (--Agent.room(model).asking === 0) {
      console.error(model + ": none asks again");
    }
    for (const key of [own, model]) {
      if (ROOMS.get(key)?.busy === 0 && ROOMS.get(key)?.asking === 0) {
        ROOMS.delete(key);
      }
    }
  }

  // a request that yields waits while a request that doesn't holds its
  // model's room, and while another holds its import's
  export async function yielded(run: Run, own: string, asking: boolean): Promise<void> {
    const keys = run.ask.yields === undefined ? [] : asking ? [run.ask.model] : [run.ask.model, own];
    for (;;) {
      const room = keys.map((key) => ROOMS.get(key)).find((room) => (room?.busy ?? 0) > 0);
      if (room === undefined || run.abort.signal.aborted) {
        return;
      }
      await Agent.race(new Promise<void>((ok) => room.wait.push(ok)), run.abort.signal);
    }
  }

  // a request's most input cost: each byte of its text a token, an image
  // PIC tokens (exact: the tokens `count` tells, or those), all at the
  // dearest input price (a cache write), and its most web searches, each
  // RESULT tokens more; and an output token's, at a prompt that size (a
  // long one may cost more)
  export function worst(ask: Ask, json: string, items: Item[], count: () => Promise<number | null>): Cost {
    const imgs = items.flatMap((item) => (item.$ === "User" ? item.imgs : item.$ === "Back" ? item.backs.flatMap((b) => b.out.imgs ?? []) : []));
    const write = Buffer.byteLength(json) + imgs.reduce((n, img) => n + PIC - img.data.length, 0);
    const web = Price.cost(ask.model, { ...Price.usage(ask.speed), write: ask.searches * RESULT, searches: ask.searches });
    const at = (write: number, output: number) => Price.cost(ask.model, { ...Price.usage(ask.speed), write, output });
    const cost = (write: number, exact: Cost["exact"]): Cost => ({ input: at(write, 0) + web, token: (at(write, 1e6) - at(write, 0)) / 1e6, exact });
    return cost(write, async () => cost((await count()) ?? write, null));
  }

  // one request, sent once its payer let it through (Bill), then single
  // flight (AskAI.wait); then, if paid, read to the end of its stream
  // whether the call stops or not, and billed: its response, if any, and
  // step
  export async function request<S>(wire: Wire<S>, run: Run, key: string, make: (max: number) => unknown, cost: Cost, seen: Entry[]): Promise<{ res: Response | null; step: Step }> {
    const grant = run.ask.bill ? await run.ask.bill(cost, MAX) : FREE;
    if (typeof grant === "string") {
      return { res: null, step: Agent.fail(grant, []) };
    }
    const flight = await AskAI.wait(run.ask);
    if (run.abort.signal.aborted) {
      flight.end();
      grant.end(null);
      return { res: null, step: Agent.fail("stopped", []) };
    }
    READING.n += 1;
    return Agent.send(wire, run, key, make(grant.max), grant, flight, seen).finally(() => (READING.n -= 1));
  }

  export async function send<S>(wire: Wire<S>, run: Run, key: string, body: unknown, grant: Grant, flight: Flight, seen: Entry[]): Promise<{ res: Response | null; step: Step }> {
    const idle = new AbortController();
    const timer = setTimeout(() => idle.abort(new Error("no word from the API in " + wire.idle / 1e3 + " s")), wire.idle);
    const st = wire.start(run.ask);
    const read: Read = { bytes: 0, done: false };
    const json = JSON.stringify(body);
    let res: Response | null = null;
    let step: Step;
    try {
      res = await fetch(wire.url, {
        method  : "POST",
        headers : wire.headers(key, run.ask),
        body    : json,
        signal  : run.ask.bill ? idle.signal : AbortSignal.any([run.abort.signal, idle.signal]),
        timeout : false,
      } as RequestInit);
      const text = res.ok && res.body ? "" : await res.text();
      const why = res.ok && res.body ? "" : "HTTP " + res.status + ": " + Agent.reason(text);
      const stop = Agent.limited(res, text) ? "limit" : Agent.passing(res) ? "busy" : "down";
      step = why ? Agent.fail(why, [], stop) : await Agent.stream(wire, run, res.body!, timer, seen, st, flight.begun, read);
    } catch (err: any) {
      step = Agent.fail(err.message, [], "busy");
    }
    clearTimeout(timer);
    flight.end();
    const { vendor, model, effort, speed } = run.ask;
    const use = res?.ok ? Agent.used(wire.usage(st), read, json) : null;
    grant.end(use && { run: { vendor, model, effort, speed }, use });
    const cut = use !== null && use.output >= grant.max ? grant.cut : null;
    return { res, step: cut === null ? step : Agent.fail(cut, seen) };
  }

  // a request's usage: the API's, once its stream ended; else (cut short,
  // its usage not all told) at least what it read, each byte a token as a
  // booking counts (worst): the output streamed, and the request's text as
  // written input if the API told no input at all (OpenAI tells it last)
  export function used(use: Usage, read: Read, json: string): Usage {
    if (read.done) {
      return use;
    }
    const told = use.input + use.write + use.read > 0;
    return { ...use, write: told ? use.write : Buffer.byteLength(json), output: Math.max(use.output, read.bytes) };
  }

  // a failed request's why: the API's message (Anthropic's and OpenAI's
  // errors are {error: {message}}), else the start of its body
  export function reason(body: string): string {
    try {
      const why = JSON.parse(body)?.error?.message;
      return typeof why === "string" ? why : body.slice(0, 2000);
    } catch {
      return body.slice(0, 2000);
    }
  }

  // a refusal a usage limit's reset ends: a 429, but OpenAI's
  // insufficient_quota (credit gone)
  export function limited(res: Response, body: string): boolean {
    return res.status === 429 && !body.includes("insufficient_quota");
  }

  export function passing(res: Response): boolean {
    const should = res.headers.get("x-should-retry");
    const busy = [408, 409, 429].includes(res.status) || res.status >= 500;
    return should === "true" || (should !== "false" && busy);
  }

  // seen: what streamed, as told to the call (none once it stopped); st:
  // what it read, its usage; begun: its response began (Flight)
  export async function stream<S>(wire: Wire<S>, run: Run, body: ReadableStream<Uint8Array>, timer: Timer, seen: Entry[], st: S, begun: () => void, read: Read): Promise<Step> {
    const ask = run.ask;
    const on: Emit = (kind, text, fresh) => {
      read.bytes += Buffer.byteLength(text);
      if (!run.abort.signal.aborted) {
        live_push(seen, kind, text, fresh);
        run.on({ $: "Delta", kind, text, fresh });
      }
    };
    try {
      for await (const ev of Agent.events(body)) {
        timer.refresh();
        if (wire.begun(ev)) {
          begun();
        }
        if (wire.read(st, ev, on)) {
          read.done = true;
          const step = wire.step(st, ask);
          return step.stop === "fail" || step.stop === "busy" || step.stop === "limit" ? Agent.fail(step.why, seen, step.stop) : step;
        }
      }
      return Agent.fail("the stream ended early", seen, "busy");
    } catch (err: any) {
      return Agent.fail(err.message, seen, "busy");
    }
  }

  export function fail(why: string, seen: Entry[], stop: Step["stop"] = "lost"): Step {
    const mark = "\n[cut off: " + (stop === "busy" || stop === "limit" ? BUSY : why).slice(0, 300) + "]";
    const entries = seen.filter((e) => e.text.trim()).map((e) => ({ kind: e.kind, text: e.text.trim() + mark }));
    return { out: [], uses: [], entries, stop, why, note: "" };
  }

  export async function* events(stream: ReadableStream<Uint8Array>) {
    for await (const line of AskAI.lines(stream)) {
      if (line.startsWith("data:") && line.slice(5).trim() !== "[DONE]") {
        yield JSON.parse(line.slice(5));
      }
    }
  }

  // null: not JSON
  export function parse(json: string): unknown {
    try {
      return JSON.parse(json || "{}");
    } catch {
      return null;
    }
  }

  // Tools
  // -----

  export async function use(run: Run, tools: Tool[], use: Use): Promise<Out> {
    if (!tools.some((t) => t.name === use.name)) {
      return { text: "No tool " + use.name + ".", fail: true };
    }
    if (use.input === null || typeof use.input !== "object") {
      return { text: "The input is not a JSON object.", fail: true };
    }
    try {
      const out = await Agent.call(run, use.name, use.input);
      return { ...out, text: out.text || "(no output)" };
    } catch (err: any) {
      const why = run.abort.signal.aborted ? "(stopped)" : err.message;
      return { text: why, fail: true };
    }
  }

  export async function server(run: Run): Promise<Tool[]> {
    if (!run.ask.server) {
      return [];
    }
    const list = await Agent.rpc(run, "tools/list", {});
    return list.tools.map((t: any) => ({ name: t.name, info: t.description, schema: t.inputSchema }));
  }

  export async function call(run: Run, name: string, input: unknown): Promise<Out> {
    const res = await Agent.rpc(run, "tools/call", { name, arguments: input });
    const pics = res.content.filter((part: any) => part.type === "image");
    const imgs = pics.map((part: any) => ({ type: part.mimeType, data: part.data }));
    return { text: AskAI.show(res.content), fail: res.isError === true, imgs };
  }

  export async function rpc(run: Run, method: string, params: unknown): Promise<any> {
    const res = await fetch(run.ask.server, {
      method  : "POST",
      headers : { "content-type": "application/json" },
      body    : JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal  : run.abort.signal,
      timeout : false,
    } as RequestInit);
    const msg = await res.json();
    if (msg.error) {
      throw new Error(method + ": " + msg.error.message);
    }
    return msg.result;
  }

}
