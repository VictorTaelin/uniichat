// View
// ====
// What a view of the chat holds and draws, shared by the web (main.ts)
// and the terminal (Term.ts), with no DOM: `view_hear` takes the server's
// messages, `view_act` the person's acts, and both answer what to send
// (by the Link). The main chat shows what its agent sees (Server.ts): the
// view's parts as blocks ("nx"), from the turn on each message whole
// (0x) and its thoughts, then what streams or what the turn waits on. An
// agent's page is its log, kept live. The AI notice (AI) opens the chat
// and comes again before a message in another 3-hour window.

import type { Kind, Vendor } from "./AskAI.ts";
import { topup } from "./Import.ts";
import * as Call from "./Call.ts";
import * as Md from "./Md.ts";
import { LABELS, type Move, Pick } from "./Pick.ts";
import { Price } from "./Price.ts";
import { GLYPH, WHO } from "./Theme.ts";

// Types
// =====

// the n messages from id on (n a power of two)
export type Part = [number, number];

// a message logged: its kind, its text, its date (ISO), its images
export type Entry = { kind: Kind; text: string; date?: string; images?: string[] };

// a summary: its text, its last message's date
export type Node = { text: string; to: string };

export type Live = { kind: Kind; text: string };

// log: null while it loads
export type Page = { name: string; log: Entry[] | null; live: Live[] };

// an import's time done and in all (micro-USD: Server.ts Chat.time), USD
// spent and left, why paused, its messages, its nodes not built by level
export const BROKE = "out of credit";
export type Progress = { done: number; total: number; spent: number; left: number; why: string | null; msgs: number; open: number[] };

// an import's minutes a micro-USD of its time (the compactor, measured on
// a real import: 990 s for 162,900)
const PACE = 1e-4;

// what a guest is asked after the hello: an email, or a GitHub name but in
// the iOS app (main.ts guest); a new account's chat opens with it, its
// email and the line it signed in by, OPENING messages (Server.ts)
export const email_ask = (github: boolean) => "First, what's your email" + (github ? " or @github" : "") + "? I'll send you a quick sign-up link.";
export const OPENING = 3;

// what a turn waits on while nothing streams: nothing (""), SUMMARIES,
// or the first piece of the model it names (a request out, no tool
// running; a running tool shows its call)
export const SUMMARIES = "summaries";
export type Wait = string;

// agents: those at work; vendors and models: those offered; bills:
// whether the server bills (Billing.ts); credits: what the user may
// spend (null: free, or not told)
export type State = {
  busy      : boolean;
  wait      : Wait;
  agents    : string[];
  pick      : Pick | null;
  vendors   : Vendor[];
  models    : string[];
  bills     : boolean;
  credits   : number | null;
  importing : Progress | null;
};

// fold: the tops shown (null: not folded); nodes and whole: the summaries
// ("id+n") and messages known; open: the blocks opened (true) or shut by
// hand; minds: the thoughts after each message; pages: the agents' asked
// for; page: the one shown (null: UniiChat's); the Link's: this view's
// id, acts not answered, socket (up: it showed the chat)
export type View = State & {
  parts : Part[];
  turn  : number;
  fold  : Part[] | null;
  nodes : Map<string, Node>;
  whole : Map<number, Entry>;
  open  : Map<string, boolean>;
  live  : Live[];
  minds : Map<number, string[]>;
  pages : Map<string, Page>;
  page  : Page | null;
  notes : string[];
  tab   : string;
  out   : Post[];
  ws    : WebSocket | null;
  up    : boolean;
  flush : () => void;
};

export type Pack = { nodes?: Record<string, Node>; whole?: Record<string, Entry> };

// the server's messages (Server.ts documents them)
export type Server =
  | ({ $: "know" } & Pack)
  | { $: "view"; parts: Part[]; turn: number }
  | { $: "zoom"; id: number; n: number; parts: Part[] }
  | { $: "root"; parts: Part[] }
  | ({ $: "entry"; agent?: string; id?: number } & Entry)
  | { $: "delta"; agent?: string; kind: Kind; text: string; fresh?: boolean }
  | { $: "live"; agent?: string; live: Live[] }
  | ({ $: "state" } & State)
  | { $: "agent"; name: string; found: boolean }
  | { $: "note"; text: string }
  | ({ $: "ack"; id: string } & Answer)
  | { $: "jobs"; ids: string[] }
  | { $: "job"; id: string; job: unknown };

// a message a person sends: its text, its images
export type Sent = { text: string; images?: Blob[] };

// an act's answer: why refused (status: HTTP's), a recording's words, an
// import's still running, its cost; a body, made anew for each post (what fetch
// takes)
export type Answer = { error?: string; status?: number; text?: string; going?: boolean; usd?: number };
export type Body   = () => any;

// the acts a view sends (out: a job's output): changes, then reads; a
// message's body is its images (sizes given), then its text
export type Client =
  | { $: "say"; sizes: number[]; body: Body }
  | { $: "import"; body: Body }
  | { $: "voice"; type: string; body: Body }
  | { $: "stop"; name?: string } // all work, or the agent named, or TURN
  | { $: "goal"; text: string | null } // the goal set (/goal), or none (/halt)
  | { $: "go"; on: boolean } // the import's: resume (true) or pause
  | { $: "pick"; to: Pick }
  | { $: "out"; job: string; out: object }
  | { $: "zoom"; part: Part }
  | { $: "root" }
  | { $: "agent"; name: string }
  | { $: "guess"; body: Body }; // an import's cost

// an act not answered: with its id, the socket it went by, what its
// answer does, what a message said (shown while offline: view_tail)
export type Post = { msg: Client & { id: string }; ws: WebSocket | null; done: (a: Answer) => void; said: string };

// how a view reaches the server: a socket by its query, a post, what it
// does with a message, and, one lost (up: it showed the chat), whether to
// open another
export type Link = {
  open : (query: string) => WebSocket;
  post : (path: string, body: any) => Promise<Response>;
  hear : (msg: Server) => void;
  lost : (up: boolean) => Promise<boolean>;
};

// what a person does
export type Act =
  | ({ $: "Send" } & Sent)                      // Enter: a message, or, empty, interrupt
  | { $: "Move"; move: Move; to?: string }      // the pick moves (to: to that value)
  | { $: "Open"; id: number; n: number }        // a click on a block
  | { $: "Shut"; id: number; n: number }        // a click on an open block's bar
  | { $: "Fold"; on: boolean }                  // fold all, unfold all
  | { $: "Goto"; name: string | null }          // a tab, a name, the logo (null: UniiChat)

// what a page draws, top to bottom
export type Row =
  | { $: "Sum"; id: number; n: number; text: string; call: Call.Call | null }                     // a block: nx, its summary (call: a tool call's, word for word)
  | { $: "Box"; id: number; n: number; text: string; rows: Row[] }                              // a block open: its bar
  | { $: "Msg"; id: number | null; kind: Kind; who: string; text: string; body: Md.Block[]; call: Call.Call | null; images: string[] } // a message whole: 0x (who: its speaker or "↳ result", named on its block; call: a tool call's, drawn as Call.ts reads it)
  | { $: "Cap"; text: string }                                                                  // a line about the page

export type Tab = { name: string | null; here: boolean; text: string };

// hint: what the knob's value means (a tooltip; the site's note when it
// changes)
export type Knob = { text: string; move: Move; hint: string };

// a user's account, as /api/account gives it (Cloud.data): whether the
// server bills; where it does, every purchase and every call paid,
// newest first (cents; micro-USD)
export type Topup   = { id: number; at: string; credits_cents: number; paid_cents: number; left_cents: number; status: string; source: string; receipt_url: string | null };
export type Spend   = { at: number; kind: string; micros: number };
export type Account = { name: string; bills: boolean; credits: number | null; topups?: Topup[]; calls?: Spend[] };

// a day's use: its date (day_show), what its calls served, counted
// ("3 replies, 9 summaries"), and their cost
export type Day = { date: string; what: string; usd: number };

// Constants
// =========

export const MAIN = "UniiChat";

// UniiChat's turn, as a stop names it among the agents at work
export const TURN = "Unii's turn";

// the messages' version, in a view's query; one more for each change an
// older view would misread
export const WIRE = 2;

// the Link's: the most a live socket hears nothing (ms); the wait to open
// another; the server's tick; a terminal's close as it quits; the
// server's close as the chat moves to its next process (a deploy)
export const PING  = 10000;
export const RETRY = 1000;
export const TICK  = "+";
export const QUIT  = 4000;
export const MOVE  = 4001;

// the most a socket message may be (bytes; Bun's own cap is 16 MiB): 3x
// a tool's largest output, a screenshot (Computer.ts, at most 1280x800:
// a screen of noise, the worst case, is 1.33 MB in base64; a real one
// ~0.15 MB). A bigger one closes its socket (Server.ts)
export const FRAME = 2 ** 22;

export const HINT = "Message UniiChat";

// the disclosure both views show (EU AI Act art. 50, California SB 243,
// New York GBL art. 47, Anthropic's usage policy)
export const AI = "Unii is an AI, not a person, and can make mistakes.";

// the AI notice's period (ms)
const NOTICE = 3 * 60 * 60 * 1000;

const WAIT = "compressing…";
const SUMS = "compressing earlier messages…";

// under the messages sent while offline, still kept to send
const UNSENT = "Sends once connected.";

// the kinds an image may be, each by its mark at a byte of its first HEAD
const MARKS: Array<[string, number, string]> = [
  ["image/png", 0, "\x89PNG"],
  ["image/jpeg", 0, "\xFF\xD8\xFF"],
  ["image/gif", 0, "GIF8"],
  ["image/webp", 8, "WEBP"],
];
export const HEAD   = 12;
export const IMAGES = "Images are png, jpeg, gif or webp.";

// how a line of one tool call starts
const TOOL = "tool: ";
const FOLD = "The whole chat, folded into the fewest blocks.";

// a purchase's columns (what is left says its status unless paid; the
// last, its receipt)
export const TOPUP = ["#", "Date", "Credit", "Paid", "Left", ""];

// what a call served (Billing.ts `calls` kind), as a person counts it: one,
// many
const SERVED: Record<string, string[]> = {
  chat      : ["reply", "replies"],
  compactor : ["summary", "summaries"],
  import    : ["import summary", "import summaries"],
  voice     : ["voice note", "voice notes"],
  agent     : ["agent step", "agent steps"],
  computer  : ["computer step", "computer steps"],
  earlier   : ["earlier use", "earlier uses"],
};

// Constructors
// ============

export function Cap(text: string): Row {
  return { $: "Cap", text };
}

// View
// ====

export function view_new(): View {
  return {
    busy      : false,
    wait      : "",
    agents    : [],
    pick      : null,
    vendors   : [],
    models    : LABELS,
    bills     : false,
    credits   : null,
    importing : null,
    parts     : [],
    turn      : Infinity,
    fold      : null,
    nodes     : new Map(),
    whole     : new Map(),
    open      : new Map(),
    live      : [],
    minds     : new Map(),
    pages     : new Map(),
    page      : null,
    notes     : [],
    tab       : crypto.randomUUID(),
    out       : [],
    ws        : null,
    up        : false,
    flush     : () => {},
  };
}

export function view_hear(v: View, msg: Server): Client[] {
  switch (msg.$) {
    case "know": {
      view_learn(v, msg);
      return [];
    }
    case "view": {
      v.parts = msg.parts;
      v.turn  = msg.turn;
      return v.fold === null ? [] : [{ $: "root" }];
    }
    case "zoom":
    case "jobs":
    case "job": {
      return [];
    }
    case "root": {
      v.fold = v.fold === null ? null : msg.parts;
      return [];
    }
    case "entry": {
      view_entry(v, msg);
      return [];
    }
    case "delta": {
      const live = view_live(v, msg.agent);
      if (live !== null) {
        live_push(live, msg.kind, msg.text, msg.fresh);
      }
      return [];
    }
    case "live": {
      const live = view_live(v, msg.agent);
      if (live !== null) {
        live_set(live, msg.live);
      }
      return [];
    }
    case "state": {
      const { $, ...state } = msg;
      Object.assign(v, state);
      return [];
    }
    case "agent": {
      const page = v.pages.get(msg.name);
      if (page === undefined) {
        return [];
      }
      if (msg.found) {
        page.log = [];
        return [];
      }
      v.pages.delete(msg.name);
      if (v.page === page) {
        v.page = null;
      }
      v.notes.push("No agent " + msg.name + ".");
      return [];
    }
    case "note": {
      v.notes.push(msg.text);
      return [];
    }
    case "ack": {
      const post = v.out.find((p) => p.msg.id === msg.id);
      v.out = v.out.filter((p) => p !== post);
      post?.done(msg);
      return [];
    }
    default: {
      // a kind newer than this view: a unii runs the release it was
      // installed with (Term.ts), behind the server's
      return [];
    }
  }
}

export function view_act(v: View, act: Act): Client[] {
  switch (act.$) {
    case "Send": {
      const text   = act.text.trim();
      const images = act.images ?? [];
      // a `/word` reaching here is no command (the terminal ran its
      // own), but /goal (a message, sent as typed, set as the goal) and
      // /halt: it errs, never goes to the AI as a message
      const word   = /^\/[a-z]+(?=\s|$)/i.exec(text)?.[0];
      const goal   = word === "/goal" ? text.slice(word.length).trim() : null;
      if (!view_typing(v)) {
        return [];
      }
      if (text === "" && images.length === 0) {
        return v.busy ? [{ $: "stop", name: TURN }] : [];
      }
      if (word === "/halt") {
        return [{ $: "goal", text: null }];
      }
      if (goal === "") {
        v.notes.push("/goal needs one: /goal <message>.");
        return [];
      }
      if (word !== undefined && goal === null) {
        v.notes.push(word + " is no command; nothing was sent. The terminal's /help lists its commands; the site's are in its ☰ menu.");
        return [];
      }
      const blob = new Blob([...images, text]);
      const say: Client = { $: "say", sizes: images.map((b) => b.size), body: () => blob };
      v.fold = null;
      return goal === null ? [say] : [{ $: "goal", text: goal }, say];
    }
    case "Move": {
      // from the last pick asked for and not acked, else the chat's
      const from = v.out.flatMap((p) => (p.msg.$ === "pick" ? [p.msg.to] : [])).at(-1) ?? v.pick;
      if (from === null) {
        return [];
      }
      const to = Pick.move(from, act.move, v, act.to);
      if (act.move === "speed" && Pick.options(from, "speed", v).length === 1) {
        v.notes.push(from.model + " has no fast.");
        return [];
      }
      if (to === null) {
        const parts = Pick.options(from, act.move, v).map(([part]) => part);
        v.notes.push("No " + [act.move, act.to].join(" ").trim() + "; one of: " + [...new Set(parts)].join(", ") + ".");
        return [];
      }
      return [{ $: "pick", to }];
    }
    case "Open": {
      v.open.set(act.id + "+" + act.n, true);
      return act.n === 1 ? [] : [{ $: "zoom", part: [act.id, act.n] }];
    }
    case "Shut": {
      v.open.set(act.id + "+" + act.n, false);
      return [];
    }
    case "Fold": {
      v.open.clear();
      v.fold = act.on ? [] : null;
      return act.on ? [{ $: "root" }] : [];
    }
    case "Goto": {
      if (act.name === null) {
        v.page = null;
        return [];
      }
      const known = v.pages.get(act.name);
      v.page = known ?? { name: act.name, log: null, live: [] };
      v.pages.set(act.name, v.page);
      return known === undefined ? [{ $: "agent", name: act.name }] : [];
    }
  }
}

export function view_body(v: View): Row[] {
  if (v.page !== null) {
    return page_rows(v, v.page);
  }
  if (v.fold !== null) {
    const tops = v.fold.flatMap(([id, n]) => part_rows(v, id, n, Infinity, false));
    return [Cap(FOLD), ...tops];
  }
  return [Cap(AI), ...view_rows(v, v.parts).flat()];
}

// the chat's parts given, in order, as rows each (part_due)
export function view_rows(v: View, parts: Part[]): Row[][] {
  return parts.map(([id, n], k) => {
    const rows = part_rows(v, id, n, v.turn, true);
    return part_due(v, [id, n], parts[k - 1]) ? [Cap(AI), ...rows] : rows;
  });
}

// whether rows show a block whose summary isn't known yet (WAIT)
export function rows_wait(v: View, rows: Row[]): boolean {
  return rows.some((row) => (row.$ === "Sum" && !v.nodes.has(row.id + "+" + row.n)) || (row.$ === "Box" && rows_wait(v, row.rows)));
}

// live: what of the stream to draw (the terminal's: what it has not
// printed yet)
export function view_tail(v: View, live = view_stream(v)): Row[] {
  if (v.page === null && v.fold !== null) {
    return [];
  }
  const rows = live.flatMap((l) => entry_rows(null, l.kind, l.text));
  const load = v.page === null && v.importing !== null ? [Cap(progress_show(v, v.importing))] : [];
  const said = v.page === null && !v.up ? v.out.flatMap((p) => entry_rows(null, "user", p.said)) : [];
  const kept = said.length > 0 ? [...said, Cap(UNSENT)] : [];
  if (v.page !== null || rows.length > 0 || v.wait === "") {
    return [...rows, ...kept, ...load];
  }
  return [Cap(v.wait === SUMMARIES ? SUMS : "waiting for " + v.wait + "…"), ...kept, ...load];
}

// what streams on the page shown
export function view_stream(v: View): Live[] {
  return v.page === null ? v.live : v.page.live;
}

// an import's progress; where the server bills, its cost; short of
// credit, what to add (progress_need)
export function progress_show(v: State, p: Progress): string {
  const n = (k: number) => k.toLocaleString("en-US");
  const merges = p.open.reduce((x, y) => x + y, 0);
  const phase = p.open[0] > 0 ? "Summarizing messages: " + n(p.msgs - p.open[0]) + " of " + n(p.msgs) : "Merging the top of the tree: " + merges + (merges === 1 ? " merge" : " merges") + " left · about " + Math.ceil((p.total - p.done) * PACE) + " min";
  const why = p.why === null ? "" : p.why === BROKE ? " · waiting for credit: add $" + progress_need(p, v.credits) + " and it goes on by itself" : " · paused";
  const usd = v.bills ? " · $" + p.spent.toFixed(2) + " spent, estimated $" + p.left.toFixed(2) + " left" : "";
  return phase + usd + why;
}

// what an import waiting for credit asks to add: the estimate left and
// half again, and at least a top-up's least, $5 (a request books its
// whole output, so it can wait with the credit over that estimate)
export function progress_need(p: Progress, credits: number | null): number {
  return Math.max(5, topup(p.left, credits ?? 0));
}

// the chat, each agent at work, and the page shown while its agent is
// done (so it can be left: the tabs were the way back, and hid)
export function view_tabs(v: View): Tab[] {
  const at    = v.page === null ? null : v.page.name;
  const names = at === null || v.agents.includes(at) ? v.agents : [...v.agents, at];
  return [null, ...names].map((name) => {
    const here = name === at;
    const text = (here ? GLYPH.here : GLYPH.tab) + " " + (name ?? MAIN);
    return { name, here, text };
  });
}

export function view_fold(v: View): string | null {
  if (v.page !== null) {
    return null;
  }
  return v.fold === null ? "fold all" : "unfold all";
}

export function view_typing(v: View): boolean {
  return v.page === null;
}

export function view_running(v: View): boolean {
  return v.busy || v.agents.length > 0;
}

export function view_pick(v: View): Knob[] {
  if (v.pick === null) {
    return [];
  }
  const { model, effort, speed } = v.pick;
  // a plan (claude-sub) isn't billed by the token: no prices
  const plan  = v.pick.vendor === "claude-sub";
  const rate  = plan ? undefined : Price.rate(Pick.ask(v.pick).model);
  const price = rate === undefined ? "" : ": $" + rate.input + "/M tokens in, $" + rate.output + "/M out";
  return [
    { text: model, move: "model", hint: model + price },
    { text: effort, move: "effort", hint: effort + " effort: how long it thinks first; more is smarter, slower" + (plan ? "" : " and costs more") },
    { text: speed, move: "speed", hint: plan ? speed : speed + ": ×" + Price.times(speed) + " the price" },
  ];
}

export function view_count(v: View): number {
  return v.parts.reduce((end, [id, n]) => Math.max(end, id + n), 0);
}

export function view_credits(v: View): string | null {
  return v.credits === null ? null : usd_show(v.credits);
}

function view_learn(v: View, pack: Pack): void {
  for (const [key, node] of Object.entries(pack.nodes ?? {})) {
    v.nodes.set(key, node);
  }
  for (const [id, entry] of Object.entries(pack.whole ?? {})) {
    v.whole.set(Number(id), entry);
  }
}

// a message: on its agent's page, in Unii's chat, or, a thought (not
// logged), after the last message
function view_entry(v: View, msg: Server & { $: "entry" }): void {
  const { $, agent, id, ...entry } = msg;
  const last = v.parts[v.parts.length - 1];
  if (agent !== undefined) {
    const log = v.pages.get(agent)?.log;
    if (Array.isArray(log)) {
      log.push(entry);
    }
  } else if (id !== undefined) {
    v.whole.set(id, entry);
    v.parts.push([id, 1]);
  } else if (msg.kind === "mind" && last !== undefined) {
    const at = last[0] + last[1] - 1;
    v.minds.set(at, [...(v.minds.get(at) ?? []), msg.text]);
  }
}

// null: a page not asked for
function view_live(v: View, agent: string | undefined): Live[] | null {
  if (agent === undefined) {
    return v.live;
  }
  return v.pages.get(agent)?.live ?? null;
}

// Link
// ====
// What TCP, WebSocket and HTTP do is theirs; the Link adds only what
// they can't. A socket that dies loses what was in flight: each act has
// an id and is kept until answered (its ack, or its post's answer); those
// not answered go again once the next socket shows the chat (none on a
// live one); the server does each once (Server.ts Chat.apply). An act
// with a body is a post of its own; one unanswered means the link is
// lost. A page sees no pings: the server ticks each PING / 2, and a view
// drops a socket silent for a PING. A socket closed as MOVE opens again
// at once, unseen: no link was lost.

export function link_open(v: View, link: Link): void {
  const ws   = link.open("?tab=" + v.tab + "&wire=" + WIRE);
  let heard  = Date.now();
  const tick = setInterval(() => Date.now() - heard > PING && drop(), PING / 2);
  async function drop(moved = false): Promise<void> {
    const up = v.up;
    ws.onmessage = null;
    ws.onclose   = null;
    clearInterval(tick);
    ws.close();
    [v.ws, v.up] = [null, false];
    if (moved || await link.lost(up)) {
      setTimeout(() => link_open(v, link), moved ? 0 : RETRY);
    }
  }
  // sends, in order, the acts not sent on this socket
  function flush(): void {
    for (const post of v.up && v.ws === ws ? v.out.filter((p) => p.ws !== ws) : []) {
      post.ws = ws;
      if ("body" in post.msg) {
        upload(post);
      } else {
        ws.send(JSON.stringify(post.msg));
      }
    }
  }
  async function upload(post: Post): Promise<void> {
    const { body, ...rest } = post.msg as any;
    const query = Object.entries(rest).map(([k, x]) => k + "=" + encodeURIComponent(String(x)));
    const res = await link.post("/api/act?" + query.join("&"), await body()).catch(() => null);
    const out = await res?.json().catch(() => null);
    if (out != null) {
      link.hear({ $: "ack", id: post.msg.id, ...out });
    } else if (post.ws === ws && v.ws === ws) {
      drop();
    }
  }
  [v.ws, v.flush] = [ws, flush];
  ws.onmessage = (ev) => {
    heard = Date.now();
    if (ev.data === TICK) {
      return;
    }
    const msg = JSON.parse(String(ev.data));
    const join = msg.$ === "view" && !v.up;
    if (join) {
      v.up = true;
      v.pages.clear();
    }
    link.hear(msg);
    if (join) {
      view_act(v, { $: "Goto", name: v.page?.name ?? null }).forEach((out) => link_send(v, out));
      flush();
    }
  };
  ws.onclose = (ev) => drop(ev.code === MOVE);
}

// an act, kept until answered; by default a refusal is a note; said: a
// message's text
export function link_send(v: View, msg: Client, done = (a: Answer) => link_note(v, a), said = ""): void {
  v.out.push({ msg: { id: crypto.randomUUID(), ...msg }, ws: null, done, said });
  v.flush();
}

export function link_note(v: View, a: Answer): void {
  if (a.error !== undefined) {
    v.notes.push(a.error);
  }
}

// a JSON post's answer, ok if its status was
export async function post(url: string, body: object, auth: Record<string, string> = {}): Promise<any> {
  const headers = { ...auth, "content-type": "application/json" };
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) }).catch(() => null);
  const out = res === null ? { error: "Can't reach the server." } : await res.json().catch(() => (res.ok ? {} : { error: "HTTP " + res.status }));
  return { ...out, ok: res?.ok === true, status: res?.status ?? 0 };
}

// Part
// ====

// a block's name, as /open and /close take it: its first message's id,
// then its size past 1x
export function block_name(id: number, n: number): string {
  return "#" + id + (n === 1 ? "" : "+" + n);
}

// whether the AI notice comes before part, after the part `before`: a
// message from the turn on, in another window than that part's
export function part_due(v: View, part: Part, before: Part | undefined): boolean {
  const last = before === undefined ? NaN : part_window(v, before);
  return part[1] === 1 && part[0] >= v.turn && !Number.isNaN(last) && part_window(v, part) !== last;
}

// the window (NOTICE) of a part's last date (NaN: not known)
function part_window(v: View, [id, n]: Part): number {
  const date = n === 1 ? v.whole.get(id)?.date : v.nodes.get(id + "+" + n)?.to;
  return Math.floor(Date.parse(date ?? "") / NOTICE);
}

// t: the turn; talk: whether talk opens by itself (not in Fold all). Open:
// the person's choice (Open, Shut) if made, else a message of the user or
// Unii (tool calls, reports and the rest stay folded)
function part_rows(v: View, id: number, n: number, t: number, talk: boolean): Row[] {
  const key   = id + "+" + n;
  const entry = v.whole.get(id);
  const half  = n / 2;
  if (n === 1 && id >= t && entry !== undefined) {
    const minds = v.minds.get(id) ?? [];
    const after = minds.flatMap((x) => entry_rows(null, "mind", x));
    return [...whole_rows(id, entry), ...after];
  }
  const open  = talk && n === 1 && ["user", "unii"].includes(entry?.kind ?? "");
  if (!(v.open.get(key) ?? open)) {
    return sum_rows(id, n, v.nodes.get(key));
  }
  const text = n === 1 ? "fold" : GLYPH.open + " " + n + "x · fold";
  if (n > 1) {
    const rows = [...part_rows(v, id, half, t, talk), ...part_rows(v, id + half, half, t, talk)];
    return [{ $: "Box", id, n, text, rows }];
  }
  const rows = entry === undefined ? [] : whole_rows(id, entry);
  return [{ $: "Box", id, n, text, rows }];
}

// a message's rows, or a summary's block, made once: neither changes once
// known, so a redraw remakes only the rows that changed
const ROWS = new WeakMap<Entry | Node, Row[]>();

function whole_rows(id: number | null, entry: Entry): Row[] {
  const rows = ROWS.get(entry) ?? entry_rows(id, entry.kind, entry.text, entry.images);
  ROWS.set(entry, rows);
  return rows;
}

// a block whose summary isn't known yet says WAIT
function sum_rows(id: number, n: number, node: Node = { text: WAIT, to: "" }): Row[] {
  const rows = ROWS.get(node) ?? [{ $: "Sum", id, n, text: Md.md_flat(node.text), call: sum_call(n, node.text) }];
  ROWS.set(node, rows);
  return rows;
}

// Page
// ====

// an agent's page, its log (once it comes) from message `from` on
export function page_rows(v: View, page: Page, from = 0): Row[] {
  const head = Cap(page.name + (v.agents.includes(page.name) ? " · at work" : " · done"));
  return [head, ...(page.log ?? []).slice(from).flatMap((e) => whole_rows(null, e))];
}

// Live
// ====

// a piece joins the message streaming, if of its kind, unless it starts
// one (fresh: a tool call, as two calls never join)
export function live_push(live: Live[], kind: Kind, text: string, fresh = false): void {
  const top = live[live.length - 1];
  if (top !== undefined && top.kind === kind && !fresh) {
    top.text += text;
  } else {
    live.push({ kind, text });
  }
}

// the whole stream, told anew (a view joining, a call's entry): one that
// goes on with the stream held extends it in place, each message staying
// the one it was (the terminal prints a message once: Term.ts flow), as
// after a reconnect; another replaces it
function live_set(live: Live[], now: Live[]): void {
  const goes = live.every((l, k) => now[k]?.kind === l.kind && now[k].text.startsWith(l.text));
  const held = goes ? live : [];
  const next = now.map((l, k) => (k < held.length ? Object.assign(held[k], l) : l));
  live.splice(0, live.length, ...next);
}

// the call a line of one message holds, when the line is a tool call
// word for word (the compactor keeps a short message as it is)
function sum_call(n: number, text: string): Call.Call | null {
  const call = n === 1 && text.startsWith(TOOL) ? Call.call_parse(text.slice(TOOL.length)) : null;
  return call === null || call.name === "" ? null : call;
}

// Account
// =======

// the name and balance, the purchases, the use by day
export function account_md(a: Account): string {
  const row  = (cells: string[]) => "| " + cells.join(" | ") + " |";
  const head = "**" + a.name + "**" + (a.credits === null ? "" : ", balance " + usd_show(a.credits));
  const tops = (a.topups ?? []).length === 0 ? [] : ["", row(TOPUP), "|---|---|---|---|---|---|", ...a.topups!.map((t) => row(topup_cells(t)))];
  const days = account_days(a).map((d) => row([d.date, d.what, cost_show(d.usd)]));
  const uses = days.length === 0 ? [] : ["", row(["Day", "Use", "Cost"]), "|---|---|---|", ...days];
  return [head, ...tops, ...uses].join("\n");
}

// a purchase, as TOPUP's cells (inline markdown)
export function topup_cells(t: Topup): string[] {
  const usd  = (cents: number) => usd_show(cents / 100);
  const paid = t.source === "apple" ? "App Store" : usd(t.paid_cents);
  const left = usd(t.left_cents) + (t.status === "paid" ? "" : " · " + t.status);
  const bill = t.receipt_url ? "[Receipt](" + t.receipt_url + ")" : "";
  return ["#" + t.id, day_show(new Date(t.at)), usd(t.credits_cents), paid, left, bill];
}

// the calls paid, a row a day, newest first
export function account_days(a: Account): Day[] {
  const days = new Map<string, { counts: Map<string[], number>; micros: number }>();
  for (const s of a.calls ?? []) {
    const date = day_show(new Date(s.at));
    const day  = days.get(date) ?? { counts: new Map(), micros: 0 };
    const name = SERVED[s.kind] ?? SERVED.earlier;
    day.counts.set(name, (day.counts.get(name) ?? 0) + 1);
    day.micros += s.micros;
    days.set(date, day);
  }
  return [...days].map(([date, day]) => {
    const what = [...day.counts].map(([name, n]) => n + " " + name[n === 1 ? 0 : 1]);
    return { date, what: what.join(", "), usd: day.micros / 1e6 };
  });
}

// a day as people read it, "Oct 6" (the year added when not this one)
export function day_show(d: Date): string {
  const year = d.getFullYear() === new Date().getFullYear() ? undefined : "numeric";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year });
}

// a cost in cents, or under one
export function cost_show(usd: number): string {
  return usd > 0 && usd < 0.005 ? "<$0.01" : usd_show(usd);
}

export function usd_show(usd: number): string {
  return (usd < 0 ? "-$" : "$") + Math.abs(usd).toFixed(2);
}

// Image
// =====

// an image's kind by its first HEAD bytes (each kind's mark, at its
// byte); null: none of them. Said as IMAGES where one is refused.
export function image_kind(head: Uint8Array): string | null {
  const text = String.fromCharCode(...head.subarray(0, HEAD));
  return MARKS.find(([, at, mark]) => text.slice(at, at + mark.length) === mark)?.[0] ?? null;
}

// Entry
// =====

export function entry_rows(id: number | null, kind: Kind, text: string, images: string[] = []): Row[] {
  const call = kind === "tool" ? Call.call_parse(text) : null;
  const report = kind === "work" ? Call.report_read(text) : null;
  const body = call === null ? entry_body(kind, report?.text ?? text) : [];
  const who = report?.name ?? WHO[kind] ?? "";
  return call === null && body.length === 0 && images.length === 0 ? [] : [{ $: "Msg", id, kind, who, text, body, call, images }];
}

// the length of a streaming message's head printed now: all of it once
// ended, as one block (a frame or fill is drawn whole), else none; none
// of one logged whole (a call, a result, the user's, a report)
export function entry_settled(kind: Kind, text: string, ended: boolean): number {
  return ["user", "work", "echo", "tool"].includes(kind) || !ended ? 0 : text.length;
}

function entry_body(kind: Kind, text: string): Md.Block[] {
  switch (kind) {
    case "user":
    case "work": {
      return Md.md_plain(text);
    }
    case "echo": {
      return Md.md_output(text);
    }
    default: {
      return Md.md_parse(text);
    }
  }
}
