// Usage limit test
// ================
// `bun test limit.test.ts`. A call at a fake Anthropic that refuses it
// with HTTP 429, a usage limit, then answers: it never fails, but waits
// for the reset the vendor tells, at least a doubling up to 30 min; a
// wait of a minute or more parks it, telling the call when it resumes. A
// message sent meanwhile asks at once; a stop ends it at once. Timers
// fire at once (each wait recorded), or a park's never (`hold`).

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

process.env.UNII_DIR = fs.mkdtempSync(os.tmpdir() + "/unii-limit-");

const config = await import("./Config.ts");
config.KEYS.anthropic = "test";

const { Agent, LIMIT, LONG } = await import("./Agent.ts");
const { Anthropic } = await import("./Anthropic.ts");
const { AskAI } = await import("./AskAI.ts");
const { MASTER } = await import("./Tools.ts");

const SHARE = { vendor: "claude-api" as const, model: "claude-opus-5-5", effort: "medium", speed: "slow", system: MASTER, searches: 0, server: "" };

const WHY = "This request would exceed your account's rate limit. Please try again later.";

const real = { setTimeout, fetch, error: console.error };

// the waits asked (ms; not the stream's idle timer), and whether a park's
// wait never ends
const naps: number[] = [];
let hold = false;

function sleep(ms: number): Promise<void> {
  return new Promise((ok) => real.setTimeout(ok, ms));
}

// a streamed answer
function answer(text: string): Response {
  const events = [
    { type: "message_start", message: { usage: {} } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 10 } },
    { type: "message_stop" },
  ];
  return new Response(events.map((ev) => "data: " + JSON.stringify(ev) + "\n\n").join(""));
}

// the vendor refuses the first `n` requests, each with `headers`
function vendor(n: number, headers: Record<string, string> = {}): () => Response {
  return () => {
    if (n-- > 0) {
      return Response.json({ type: "error", error: { type: "rate_limit_error", message: WHY } }, { status: 429, headers });
    }
    return answer("done");
  };
}

// runs `go` on the vendor with fake timers, the log kept quiet
async function faked(fetch: () => Response, go: () => Promise<void>): Promise<void> {
  naps.length = 0;
  globalThis.setTimeout = ((go: () => void, ms = 0) => {
    if (ms === Anthropic.wire.idle) {
      return real.setTimeout(go, ms);
    }
    naps.push(ms);
    return real.setTimeout(go, hold && ms >= LONG ? 2 ** 31 - 1 : 0);
  }) as any;
  globalThis.fetch = (async () => fetch()) as any;
  console.error = () => {};
  try {
    await go();
  } finally {
    Object.assign(globalThis, { setTimeout: real.setTimeout, fetch: real.fetch });
    console.error = real.error;
    hold = false;
  }
}

// a call's events: its usage-limit waits (null: over), its thoughts
function asked(text = "hi", more: object = {}) {
  const limits: Array<{ until: number; known: boolean } | null> = [];
  const minds: string[] = [];
  const users: string[] = [];
  const call = AskAI.ask({ ...SHARE, blocks: [{ text, mark: true }], ...more }, (ev: any) => {
    if (ev.$ === "Limit") {
      limits.push(ev.limit);
    } else if (ev.kind === "mind") {
      minds.push(ev.text);
    } else if (ev.kind === "user") {
      users.push(ev.text);
    }
  });
  return { call, limits, minds, users };
}

test("a usage limit waits for the reset the vendor tells, then answers", () => faked(vendor(2, { "retry-after": "7200" }), async () => {
  const { call, limits } = asked();
  expect(await call.done).toMatchObject({ ok: true, text: "done" });
  expect(Math.min(...naps)).toBeGreaterThanOrEqual(7200e3);
  expect(limits.at(-1)).toBeNull();
}));

// never hammering the vendor: no reset told, or a short one that never
// clears, still backs off, capped at LIMIT
test("with no reset told, or a stale short one, it backs off up to LIMIT", async () => {
  for (const headers of [{}, { "retry-after": "5" }] as Record<string, string>[]) {
    await faked(vendor(12, headers), async () => {
      expect(await asked().call.done).toMatchObject({ ok: true });
      expect(naps.every((n, i) => i === 0 || n >= naps[i - 1]!)).toBe(true);
      expect(naps.at(-1)).toBeGreaterThan(60e3);
      expect(Math.max(...naps)).toBeLessThanOrEqual(LIMIT);
    });
  }
});

test("a message sent while parked asks at once, then is answered", () => faked(vendor(1, { "retry-after": "7200" }), async () => {
  hold = true;
  const { call, limits, users } = asked();
  for (let t = 0; t < 100 && limits.length === 0; t++) {
    await sleep(10);
  }
  expect(limits).toHaveLength(1);
  call.send({ text: "still there?", imgs: [] });
  const end = await Promise.race([call.done, sleep(2000).then(() => null)]);
  expect(end).toMatchObject({ ok: true, text: "done" });
  expect(users).toEqual(["still there?"]);
  expect(limits.at(-1)).toBeNull();
}));

test("a stop while parked ends the call at once, no longer waiting", () => faked(vendor(99, { "retry-after": "7200" }), async () => {
  hold = true;
  const { call, limits } = asked();
  for (let t = 0; t < 100 && limits.length === 0; t++) {
    await sleep(10);
  }
  call.stop();
  const end = await Promise.race([call.done, sleep(2000).then(() => null)]);
  expect(end).toMatchObject({ ok: false, text: "stopped" });
  expect(limits.at(-1)).toBeNull();
}));

test("the reset a vendor tells", () => {
  const now = Date.parse("2026-10-21T10:00:00Z");
  const at = (headers: Record<string, string>) => Agent.reset(new Response("", { status: 429, headers }), now);
  expect(at({})).toBeNull();
  expect(at({ "retry-after": "90" })).toBe(now + 90e3);
  expect(at({ "retry-after": "Wed, 21 Oct 2026 12:30:00 GMT" })).toBe(Date.parse("2026-10-21T12:30:00Z"));
  expect(at({ "anthropic-ratelimit-requests-reset": "2026-10-21T15:00:00Z", "anthropic-ratelimit-tokens-reset": "2026-10-21T13:00:00Z" })).toBe(Date.parse("2026-10-21T15:00:00Z"));
  expect(at({ "x-ratelimit-reset-tokens": "6m0s", "x-ratelimit-reset-requests": "1.5s" })).toBe(now + 360e3);
  // now, past, or too far for a timer (it would fire at once) is none told
  expect(at({ "retry-after": "0" })).toBeNull();
  expect(at({ "anthropic-ratelimit-tokens-reset": "2020-01-01T00:00:00Z" })).toBeNull();
  expect(at({ "retry-after": "9999999999999" })).toBeNull();
});

test("what is a usage limit", () => {
  const res = (status: number) => new Response("", { status });
  expect(Agent.limited(res(429), JSON.stringify({ error: { type: "rate_limit_error", message: WHY } }))).toBe(true);
  // out of credit never clears by waiting
  expect(Agent.limited(res(429), JSON.stringify({ error: { code: "insufficient_quota", message: "You exceeded your current quota" } }))).toBe(false);
  expect(Agent.limited(res(529), JSON.stringify({ error: { type: "overloaded_error" } }))).toBe(false);
  // a stream's error event
  const st = Anthropic.wire.start(SHARE as any);
  Anthropic.read(st, { type: "error", error: { type: "rate_limit_error", message: WHY } }, () => {});
  expect(Anthropic.step(st, SHARE as any).stop).toBe("limit");
});

test("waiting at a usage limit leaves no abort listeners behind", async () => {
  const proto = EventTarget.prototype;
  const real = { add: proto.addEventListener, remove: proto.removeEventListener };
  const live = new Set<unknown>();
  proto.addEventListener = function (this: EventTarget, type: string, fn: any, opts?: any) {
    if (type === "abort") {
      live.add(fn);
    }
    return real.add.call(this, type, fn, opts);
  };
  proto.removeEventListener = function (this: EventTarget, type: string, fn: any, opts?: any) {
    live.delete(fn);
    return real.remove.call(this, type, fn, opts);
  };
  const left = async (n: number) => {
    live.clear();
    await faked(vendor(n, { "retry-after": "0" }), async () => {
      expect(await asked().call.done).toMatchObject({ ok: true });
    });
    return live.size;
  };
  try {
    const few = await left(3);
    const many = await left(30);
    expect(many).toBe(few);
  } finally {
    Object.assign(proto, { addEventListener: real.add, removeEventListener: real.remove });
  }
});
