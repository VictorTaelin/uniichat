// Timer
// =====
// A chat's schedules: Unii's `schedule` tool sets one, a message and when
// it comes, once (a time) or again and again (a cron expression); at that
// time it reaches the chat as the timer's, a report "[Timer <id>]"
// (Server.ts Chat.ring). Each is kept with its chat, in view.json
// (Memory.ts), by when it is next due.
// No time is read in the server's zone: a cron, and a time with no
// offset, are read in the schedule's own zone (an IANA name, the user's),
// so neither the server's place nor a daylight-saving change moves them.
// A cron is five fields, minute hour day month weekday, each `*`, a
// number or a range a-b (months and weekdays also by name: jan, mon),
// either with a step /n, or a list of those by commas; weekday 0-7 (0 and
// 7: Sunday); with both day and weekday set, either matches, as in cron.
// A wall time a daylight-saving change skips doesn't come that day; one
// it repeats comes once, the first time. A cron's times are at least GAP
// apart, so no schedule fills the chat's log (each brings a message and a
// turn).

// Types
// =====

// a schedule: its id, message, when next due (ISO, UTC), its cron (null:
// once), the zone its times are read in
export type Timer = { id: string; text: string; at: string; cron: string | null; zone: string };

// a cron read: each field's values (minute, hour, day, month, weekday),
// whether day and weekday were set (not starting `*`)
type Cron = { sets: Array<Set<number>>; day: boolean; week: boolean };

// a time's wall clock in a zone
type Wall = { y: number; mo: number; d: number; h: number; mi: number; wd: number };

// Constants
// =========

// the most schedules a chat keeps, the longest message one carries
// (characters): they live in view.json, written as the view changes
export const TIMERS = 50;
export const TEXT   = 2000;

// a schedule's message past this late (ms) says so
const LATE  = 60000;

// how far ahead a cron is looked at for its next time (days): a cron
// with none by then (February 31) is refused
const AHEAD = 8 * 366;

const MINUTE = 60000;

// the least time between a cron's times (minutes): `*/5` is fine, `* *`
// (every minute) is refused
export const GAP = 5;

// each field's least and most, and its names (from its least)
const FIELDS: Array<[number, number, string[]]> = [
  [0, 59, []],
  [0, 23, []],
  [1, 31, []],
  [1, 12, ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]],
  [0, 7, ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]],
];

const DAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// each zone's formatter, made once
const CLOCKS = new Map<string, Intl.DateTimeFormat>();

// Zones
// =====

// a zone's formatter; null: no such zone
function clock(zone: string): Intl.DateTimeFormat | null {
  if (!CLOCKS.has(zone)) {
    try {
      const fields = { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" } as const;
      CLOCKS.set(zone, new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", ...fields }));
    } catch {
      return null;
    }
  }
  return CLOCKS.get(zone)!;
}

export function zone_ok(zone: string): boolean {
  return zone !== "" && clock(zone) !== null;
}

// a time's wall clock in a zone (one that exists: zone_ok)
export function wall(ms: number, zone: string): Wall {
  const parts = Object.fromEntries(clock(zone)!.formatToParts(ms).map((p) => [p.type, p.value]));
  return { y: Number(parts.year), mo: Number(parts.month), d: Number(parts.day), h: Number(parts.hour) % 24, mi: Number(parts.minute), wd: DAYS[parts.weekday] };
}

// a wall clock as one number, in its order
function wall_key(w: Wall): number {
  return (((w.y * 100 + w.mo) * 100 + w.d) * 100 + w.h) * 100 + w.mi;
}

// "2026-10-21 08:00"
export function wall_show(ms: number, zone: string): string {
  const w = wall(ms, zone);
  const two = (n: number) => String(n).padStart(2, "0");
  return w.y + "-" + two(w.mo) + "-" + two(w.d) + " " + two(w.h) + ":" + two(w.mi);
}

// a wall clock in a zone as a time, the first it shows it; null: none (a
// daylight-saving change skips it)
export function wall_time(w: Omit<Wall, "wd">, zone: string): number | null {
  return wall_times(w, zone)[0] ?? null;
}

// each time a zone's clock shows a wall clock, in order: none (a change
// skips it), one, or two (a change repeats it). Tried by the zone's
// offsets over the day around it (a zone's offset is within 14 h)
export function wall_times(w: Omit<Wall, "wd">, zone: string): number[] {
  const want = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
  const key = wall_key({ ...w, wd: 0 });
  const off = (ms: number) => {
    const at = wall(ms, zone);
    return Date.UTC(at.y, at.mo - 1, at.d, at.h, at.mi) - Math.floor(ms / MINUTE) * MINUTE;
  };
  const offs = new Set([-26, -14, 0, 14, 26].map((h) => off(want + h * 3600e3)));
  const times = [...offs].map((o) => want - o).filter((ms) => wall_key(wall(ms, zone)) === key);
  return [...new Set(times)].sort((a, b) => a - b);
}

// Cron
// ====

// a cron expression read; else why not
export function cron_read(expr: string): Cron | string {
  const fields = expr.trim().toLowerCase().split(/\s+/);
  if (fields.length !== 5) {
    return "A cron has five fields (minute hour day month weekday), not " + fields.length + ".";
  }
  const sets: Array<Set<number>> = [];
  for (const [k, field] of fields.entries()) {
    const set = field_read(field, FIELDS[k]);
    if (typeof set === "string") {
      return set;
    }
    sets.push(set);
  }
  if (sets[4].delete(7)) {
    sets[4].add(0);
  }
  return { sets, day: !fields[2].startsWith("*"), week: !fields[4].startsWith("*") };
}

// a field's values; else why not
function field_read(field: string, [lo, hi, names]: [number, number, string[]]): Set<number> | string {
  const set = new Set<number>();
  const num = (s: string) => (names.includes(s) ? names.indexOf(s) + lo : /^\d+$/.test(s) ? Number(s) : NaN);
  for (const item of field.split(",")) {
    const m = /^(\*|([a-z0-9]+)(?:-([a-z0-9]+))?)(?:\/(\d+))?$/.exec(item);
    const [a, b] = m === null ? [NaN, NaN] : m[1] === "*" ? [lo, hi] : [num(m[2]), m[3] === undefined ? (m[4] === undefined ? num(m[2]) : hi) : num(m[3])];
    const step = Number(m?.[4] ?? 1);
    if (!(a >= lo && b <= hi && a <= b && step >= 1)) {
      return "No cron field " + JSON.stringify(field) + ": its values go from " + lo + " to " + hi + ".";
    }
    for (let n = a; n <= b; n += step) {
      set.add(n);
    }
  }
  return set;
}

function cron_day(c: Cron, w: Wall): boolean {
  const [day, week] = [c.sets[2].has(w.d), c.sets[4].has(w.wd)];
  return c.sets[3].has(w.mo) && (c.day && c.week ? day || week : day && week);
}

// the cron's first time after `after`, in a zone; null: none in AHEAD
// days. Its days are walked as the zone's calendar dates, each day's
// times as wall clocks, each made a time by the zone's own offsets
// (wall_times), so no daylight-saving change, of any size, skips a day. A
// wall clock a change skips is none; one it repeats, its first time
export function cron_next(c: Cron, zone: string, after: number): number | null {
  const w = wall(after, zone);
  const [hours, minutes] = [c.sets[1], c.sets[0]].map((set) => [...set].sort((a, b) => a - b));
  for (let k = 0; k <= AHEAD; k++) {
    const date = new Date(Date.UTC(w.y, w.mo - 1, w.d + k));
    const day = { y: date.getUTCFullYear(), mo: date.getUTCMonth() + 1, d: date.getUTCDate() };
    if (!cron_day(c, { ...day, h: 0, mi: 0, wd: date.getUTCDay() })) {
      continue;
    }
    for (const h of hours) {
      for (const mi of minutes) {
        const first = wall_times({ ...day, h, mi }, zone)[0];
        if (first !== undefined && first > after) {
          return first;
        }
      }
    }
  }
  return null;
}

// the least time between two of a cron's times, by its hours and
// minutes (minutes; a day's last to the next's first counted as if
// every day came)
export function cron_gap(c: Cron): number {
  const times = [...c.sets[1]].flatMap((h) => [...c.sets[0]].map((mi) => h * 60 + mi)).sort((a, b) => a - b);
  const gaps = times.map((t, k) => (k === 0 ? times[times.length - 1] - 1440 : times[k - 1])).map((prev, k) => times[k] - prev);
  return Math.min(...gaps);
}

// Schedules
// =========

// a time to read: "YYYY-MM-DD HH:MM" (or a T between, seconds dropped)
// in the zone, or with an offset (Z, +02:00) that says it; else why not
export function at_read(text: string, zone: string): number | string {
  const m = /^(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::\d\d(?:\.\d+)?)?\s*(Z|[+-]\d\d:?\d\d)?$/i.exec(text.trim());
  const [y, mo, d, h, mi] = (m ?? []).slice(1, 6).map(Number);
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (m === null || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d || h > 23 || mi > 59) {
    return "No time " + JSON.stringify(text) + ": give YYYY-MM-DD HH:MM.";
  }
  if (m[6] !== undefined) {
    return Date.parse(m.slice(1, 4).join("-") + "T" + m[4] + ":" + m[5] + ":00" + m[6].toUpperCase().replace(/^([+-]\d\d)(\d\d)$/, "$1:$2"));
  }
  const ms = wall_time({ y, mo, d, h, mi }, zone);
  return ms ?? text + " doesn't exist in " + zone + ": a daylight-saving change skips it.";
}

// a schedule as the tool asks it, made at `now`; else why not
export function timer_new(args: { message?: unknown; at?: unknown; cron?: unknown; zone?: unknown }, now: number): Timer | string {
  const text = String(args.message ?? "").trim();
  const zone = String(args.zone ?? "");
  const [at, cron] = [args.at, args.cron].map((x) => (x === undefined || x === null || x === "" ? null : String(x)));
  if (text === "" || text.length > TEXT) {
    return "A schedule's message has 1 to " + TEXT + " characters.";
  }
  if (!zone_ok(zone)) {
    return "No time zone " + JSON.stringify(zone) + ": give an IANA name, such as Europe/Amsterdam or UTC.";
  }
  if ((at === null) === (cron === null)) {
    return "Give either at (once) or cron (again and again), not both or neither.";
  }
  const read = cron === null ? null : cron_read(cron);
  if (typeof read === "string") {
    return read;
  }
  if (read !== null && cron_gap(read) < GAP) {
    return "A cron's times must be at least " + GAP + " minutes apart (*/" + GAP + " is the most often).";
  }
  const ms = read === null ? at_read(at!, zone) : cron_next(read, zone, now);
  if (typeof ms === "string") {
    return ms;
  }
  if (ms === null || Number.isNaN(ms)) {
    return "That cron never comes.";
  }
  if (ms <= now) {
    return wall_show(ms, zone) + " " + zone + " has passed; it is " + wall_show(now, zone) + " there now.";
  }
  const id = crypto.randomUUID().slice(0, 6);
  return { id, text, at: new Date(ms).toISOString(), cron: cron === null ? null : cron.trim(), zone };
}

// a schedule after it came at `now`: due next (a cron's first time after
// now: one missed many times comes once), or gone (null)
export function timer_after(t: Timer, now: number): Timer | null {
  const read = t.cron === null ? null : cron_read(t.cron);
  const next = read === null || typeof read === "string" ? null : cron_next(read, t.zone, now);
  return next === null ? null : { ...t, at: new Date(next).toISOString() };
}

// the message a schedule brings at `now`, a report of the timer: late,
// it says when it was due
export function timer_say(t: Timer, now: number): string {
  const due = Date.parse(t.at);
  const late = now - due > LATE ? "\n\n(Due " + wall_show(due, t.zone) + " " + t.zone + "; it came late, at " + wall_show(now, t.zone) + ".)" : "";
  return "[Timer " + t.id + "]\n" + t.text + late;
}

// when a schedule comes, as said to Unii and the user
export function timer_when(t: Timer): string {
  const next = wall_show(Date.parse(t.at), t.zone) + " " + t.zone;
  return t.cron === null ? "once, " + next : "cron " + t.cron + ", next " + next;
}

export function timer_line(t: Timer): string {
  return t.id + ": " + timer_when(t) + ": " + t.text.replace(/\s+/g, " ");
}
