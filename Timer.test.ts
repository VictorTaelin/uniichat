// Timer test
// ==========
// `bun test Timer.test.ts`. Schedules (Timer.ts) on a fake clock: their
// times in their own zone, across daylight-saving changes; then a chat's
// coming as the timer's reports, each time once, across a crash and a
// restart (Server.ts Chat.ring), each in a process of its own on one dir.

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as Timer from "./Timer.ts";

const AMS = "Europe/Amsterdam";

// the next time of a cron after an instant, as UTC ISO
function next(cron: string, zone: string, after: string): string | null {
  const read = Timer.cron_read(cron);
  if (typeof read === "string") {
    throw new Error(read);
  }
  const t = Timer.cron_next(read, zone, Date.parse(after));
  return t === null ? null : new Date(t).toISOString();
}

test("a cron is read in its zone, across a clock change", () => {
  // Friday 2026-10-16 09:00 in Amsterdam (CEST, +02:00): weekdays at 08:00 next come Monday
  expect(next("0 8 * * mon-fri", AMS, "2026-10-16T07:00:00Z")).toBe("2026-10-19T06:00:00.000Z");
  // after the clocks go back (Oct 25), 08:00 there is 07:00 UTC
  expect(next("0 8 * * 1-5", AMS, "2026-10-23T07:00:00Z")).toBe("2026-10-26T07:00:00.000Z");
  expect(next("*/15 * * * *", "UTC", "2026-10-20T10:07:30Z")).toBe("2026-10-20T10:15:00.000Z");
});

test("with both day and weekday set, either matches; a day that never comes is none", () => {
  // the 13th, or a Friday: from Wednesday Oct 21, Friday Oct 23 comes first
  expect(next("0 0 13 * fri", "UTC", "2026-10-21T00:00:00Z")).toBe("2026-10-23T00:00:00.000Z");
  const started = performance.now();
  // and doesn't hang looking for it
  expect(next("0 0 31 2 *", "UTC", "2026-10-21T00:00:00Z")).toBeNull();
  expect(performance.now() - started).toBeLessThan(2000);
});

test("a wall time a clock change skips doesn't come that day; one it repeats comes once", () => {
  // Mar 29 2026, Amsterdam: 02:00 jumps to 03:00, so 02:30 comes on the 30th
  expect(next("30 2 * * *", AMS, "2026-03-28T03:00:00Z")).toBe("2026-03-30T00:30:00.000Z");
  // a time just after the day's first hour is never stepped over
  expect(next("30 0 * * 1", AMS, "2026-03-29T00:30:00Z")).toBe("2026-03-29T22:30:00.000Z");
  // Oct 25 2026: 03:00 goes back to 02:00, so 02:30 is there twice; it comes the first time only
  const first = next("30 2 * * *", AMS, "2026-10-24T22:00:00Z");
  expect(first).toBe("2026-10-25T00:30:00.000Z");
  expect(next("30 2 * * *", AMS, first!)).toBe("2026-10-26T01:30:00.000Z");
});

test("a time is read in its zone or by its offset; one that doesn't exist is refused", () => {
  expect(Timer.at_read("2026-10-21 08:00", AMS)).toBe(Date.parse("2026-10-21T06:00:00Z"));
  expect(Timer.at_read("2026-10-21T08:00:00+05:30", AMS)).toBe(Date.parse("2026-10-21T02:30:00Z"));
  for (const bad of ["2026-03-29 02:30", "2026-02-30 08:00", "tomorrow at 8"]) {
    expect(Timer.at_read(bad, AMS)).toBeString();
  }
});

// a bad schedule is refused, not kept to fire never or wrongly; a cron
// faster than GAP would run up the bill
test("a schedule asks a zone, at or cron, a time to come, and a cron at least GAP apart", () => {
  const now = Date.parse("2026-10-21T06:00:00Z");
  for (const bad of [
    { message: "x", at: "2026-10-21 09:00", zone: "Mars/Olympus" },
    { message: "x", zone: AMS },
    { message: "x", at: "2026-10-21 09:00", cron: "* * * * *", zone: AMS },
    { message: "x", at: "2026-10-21 07:00", zone: AMS },
    { message: "x", cron: "61 * * * *", zone: AMS },
    { message: "x", cron: "0 0 31 2 *", zone: AMS },
    { message: "", cron: "0 9 * * *", zone: AMS },
    { message: "x", cron: "* * * * *", zone: AMS },
    { message: "x", cron: "0,1 9 * * *", zone: AMS },
  ]) {
    expect(Timer.timer_new(bad, now)).toBeString();
  }
  for (const cron of ["*/5 * * * *", "0,30 * * * *"]) {
    expect(typeof Timer.timer_new({ message: "x", cron, zone: AMS }, now)).toBe("object");
  }
  const once = Timer.timer_new({ message: "check the build", at: "2026-10-21 09:00", zone: AMS }, now) as Timer.Timer;
  expect(Timer.timer_after(once, Date.parse(once.at))).toBeNull();
  // a cron missed for days comes once, then at its next time after now
  const daily = Timer.timer_new({ message: "standup", cron: "0 9 * * *", zone: AMS }, now) as Timer.Timer;
  expect(Timer.timer_after(daily, Date.parse("2026-10-24T12:00:00Z"))!.at).toBe("2026-10-25T08:00:00.000Z");
});

// a chat's schedules in a server process on `dir`, its calls faked (a
// turn's call never ends): `steps` run, then what it logged and asked
const RUN = (dir: string, steps: string) => `
const { Chat, Main } = await import(${JSON.stringify(import.meta.dir + "/Server.ts")});
const { AskAI } = await import(${JSON.stringify(import.meta.dir + "/AskAI.ts")});
const { Cloud } = await import(${JSON.stringify(import.meta.dir + "/Cloud.ts")});
const { Memory } = await import(${JSON.stringify(import.meta.dir + "/Memory.ts")});
const fs = await import("node:fs");
const { Tools } = await import(${JSON.stringify(import.meta.dir + "/Tools.ts")});
const Timer = await import(${JSON.stringify(import.meta.dir + "/Timer.ts")});
Chat.cloud = Cloud.open(() => {}, () => {}, async () => null);
Cloud.user = (cloud, id) => ({ id, name: "a@b.c" });
const asked = [];
AskAI.ask = (ask, on) => {
  asked.push(ask.blocks.at(-1).text);
  return AskAI.tie(on, ask.bill, (say) => asked.push(say.text), () => {})[0];
};
const out = {};
const log = (chat) => Array.from({ length: chat.mem.count }, (_, i) => Memory.message(chat.mem, i)).filter((m) => m.kind !== "unii" && m.kind !== "user").map((m) => m.kind + ": " + m.text);
${steps}
console.log(JSON.stringify(out));
process.exit(0);
`;

async function run(dir: string, steps: string): Promise<any> {
  const file = dir + "/run-" + crypto.randomUUID() + ".ts";
  fs.writeFileSync(file, RUN(dir, steps));
  const proc = Bun.spawn([process.execPath, file], { env: { ...process.env, UNII_DIR: dir }, stdout: "pipe", stderr: "inherit" });
  const text = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0);
  return JSON.parse(text.trim().split("\n").at(-1) ?? "{}");
}

test("a schedule comes as the timer's, once, through a crash and a restart", async () => {
  const dir = fs.mkdtempSync(os.tmpdir() + "/unii-timer-");
  // the chat schedules two, one once, one every 5 minutes; at the first's
  // time, it comes as a report "[Timer id]" and starts a turn; rung
  // again, nothing comes again
  const one = await run(dir, `
    Main.listed.resolve();
    const delays = [];
    const set = globalThis.setTimeout;
    globalThis.setTimeout = (f, ms, ...rest) => (delays.push(ms), set(f, ms, ...rest));
    const chat = Chat.open({ id: "u1", name: "a@b.c" });
    const now = Date.now();
    const at = new Date(now + 180000).toISOString().slice(0, 16);
    const once = Tools.schedule(chat.tools, Timer.timer_new({ message: "check the build", at, zone: "UTC" }, now));
    out.delay = delays.at(-1);
    const cron = Tools.schedule(chat.tools, Timer.timer_new({ message: "look at the queue", cron: "*/5 * * * *", zone: "UTC" }, now));
    const ids = chat.mem.timers.map((t) => t.id);
    const was = chat.mem.timers;
    const due = Math.max(...was.map((t) => Date.parse(t.at))) + 1000;
    Chat.fire(chat, due);
    out.left = chat.mem.timers.map((t) => t.id);
    Chat.fire(chat, due);
    // a crash after the message, before the save: the file still says due
    chat.mem.timers = was;
    Chat.fire(chat, due);
    await Bun.sleep(50);
    out.ids = ids;
    out.log = log(chat);
    out.asked = asked.filter((text) => text.startsWith("Turn:"));
    out.cron_at = chat.mem.timers.find((t) => t.id === ids[1])?.at;
  `);
  const [once, cron] = one.ids;
  // the alarm looks at the clock at least once a minute, the time three minutes off
  expect(one.delay).toBeLessThanOrEqual(60000);
  expect(one.left).toEqual([cron]);
  const timer = one.log.filter((l: string) => l.startsWith("work: [Timer"));
  expect(timer.length).toBe(2);
  expect(timer[0].startsWith("work: [Timer " + once + "]\ncheck the build")).toBe(true);
  expect(timer[1].startsWith("work: [Timer " + cron + "]\nlook at the queue")).toBe(true);
  expect(one.asked.length).toBe(1);
  expect(one.asked[0]).toContain("[Timer " + once + "]\ncheck the build");
  expect(one.asked[0]).toContain("[Timer " + cron + "]\nlook at the queue");
  // a restart, the user signed in nowhere, the cron's time long past: the
  // turn it started goes on, and read from the chat's file, the cron
  // comes once, late, saying when it was due; cancelled in the web UI, a
  // schedule goes, noted
  const two = await run(dir, `
    Cloud.user = () => null;
    Main.listed.resolve();
    Chat.wake();
    Chat.timers_read();
    out.due = Chat.due.get("u1");
    Chat.ring(out.due + 7 * 864e5);
    Chat.ring(out.due + 7 * 864e5);
    await Bun.sleep(100);
    const chat = Chat.chats.get("u1");
    out.cron = chat.mem.timers.map((t) => t.at);
    const late = Tools.schedule(chat.tools, Timer.timer_new({ message: "later", cron: "0 0 1 1 *", zone: "UTC" }, Date.now()));
    const id = late.text.slice("Scheduled ".length, "Scheduled ".length + 6);
    out.acted = await Chat.act(chat, "a1", { $: "unschedule", id }, "");
    out.left = chat.mem.timers.length;
    out.log = log(chat);
  `);
  expect(two.due).toBe(Date.parse(one.cron_at));
  expect(two.log.filter((l: string) => l.startsWith("note: The server restarted")).length).toBe(1);
  const timers2 = two.log.filter((l: string) => l.startsWith("work: [Timer"));
  expect(timers2.length).toBe(3);
  expect(timers2[2].startsWith("work: [Timer " + cron + "]\nlook at the queue")).toBe(true);
  expect(Date.parse(two.cron[0])).toBeGreaterThan(Date.parse(one.cron_at) + 7 * 864e5 - 1);
  expect(two.acted).toEqual({});
  expect(two.left).toBe(1);
  expect(two.log.filter((l: string) => l.includes("cancelled by the user")).length).toBe(1);
});

test("a full disk or a failed write holds a schedule back, the chat let go; it comes later, once", async () => {
  const dir = fs.mkdtempSync(os.tmpdir() + "/unii-timer-");
  const one = await run(dir, `
    Main.listed.resolve();
    const chat = Chat.open({ id: "u1", name: "a@b.c" });
    const now = Date.now();
    Tools.schedule(chat.tools, Timer.timer_new({ message: "check the build", at: new Date(now + 120000).toISOString().slice(0, 16), zone: "UTC" }, now));
    const id = chat.mem.timers[0].id;
    const due = Date.parse(chat.mem.timers[0].at) + 1000;
    await Bun.sleep(50);
    Chat.full = () => true;
    Chat.ring(due);
    await Bun.sleep(50);
    out.full = Chat.due.get("u1") - Date.now();
    Chat.full = () => false;
    const save = Memory.save;
    let fail = 1;
    // the write that moves the schedule on throws, once
    Memory.save = (mem) => {
      if (mem.timers.length === 0 && fail-- > 0) {
        throw new Error("EIO: i/o error, write");
      }
      return save(mem);
    };
    Chat.ring(due);
    await Bun.sleep(50);
    out.failed = fail === 0;
    out.posts = Chat.chats.get("u1")?.posts ?? 0;
    out.again = Chat.due.get("u1") - Date.now();
    Chat.ring(due + 120000);
    await Bun.sleep(50);
    out.log = log(Chat.open({ id: "u1", name: "a@b.c" })).filter((l) => l.startsWith("work: [Timer " + id + "]"));
  `);
  expect(one.full).toBeGreaterThan(50000);
  expect(one.failed).toBe(true);
  expect(one.posts).toBe(0);
  expect(one.again).toBeGreaterThan(50000);
  expect(one.log.length).toBe(1);
});
