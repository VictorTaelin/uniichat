#!/usr/bin/env bun
// Server
// ======
// The agent: chats that never end (Memory.ts), one per user signed in
// (Cloud.ts), at config.DIR/users/<id>, and their views, terminals
// (Term.ts) and browser tabs (web/), each one WebSocket (View.ts's Link)
// carrying the chat's events and its acts (one with a body: a post to
// /api/act), each done once (Chat.apply), within USERS' limit. A
// terminal's socket names its device, which the agent's tools reach
// (Tools.ts) until it quits.
//
// One turn at a time. A message is logged as it arrives; the running call
// takes it between tool calls if it goes whole beside its view, else the
// next call does, on the chat's pick (Pick.ts). Its paid calls ask its
// wallet (Billing.ts), and what the billing refuses stops; a chat at
// rest settles what it owes; one nobody views is let go.
//
// Alone, this process serves the site. Workers (config.WORKERS, behind a
// proxy: README) each serve the users shard() gives them, under this
// process (Main.supervise), which only routes. A deploy is a handover:
// told so (SIGHUP), the supervisor starts each worker anew beside the
// old one, on the same port; the old one takes no more connections and
// gives the new one each chat once no post of it runs (Chat.give): its
// work goes on there, the calls it runs (its turn's, agents', summaries')
// going on where they started, fed straight to where the chat is (Main.away,
// Main.far), and its views open again there at once (View.ts MOVE). It
// ends once those calls do (a process that ran none, at once); one
// waiting for a usage limit is cut, and goes on there as after a restart
// (Main.away). A stop or crash cuts all: a start resumes what ran
// (Chat.wake), told so.
//
// Usage: Server.ts [port]   (127.0.0.1; default 8788)

import * as fs from "node:fs";
import * as net from "node:net";
import type { ServerWebSocket } from "bun";
import { READING } from "./Agent.ts";
import { AskAI, type Bill, type Grant, type Call, type End, type Event, type Kind, type Parked, type Say, type Sink } from "./AskAI.ts";
import type { Wallet } from "./Billing.ts";
import { clip_pages } from "./Clip.ts";
import { Cloud, type Account, type User } from "./Cloud.ts";
import { Disk } from "./Disk.ts";
import { Mail } from "./Mail.ts";
import * as Import from "./Import.ts";
import { JOBS, Memory, type Given, type Msg as Log, type Share } from "./Memory.ts";
import { OpenAI, TRANSCRIBER } from "./OpenAI.ts";
import { Pick } from "./Pick.ts";
import { Price } from "./Price.ts";
import { MASTER, SEARCHES, Tools, type Agent, type Live, type Moved as Kit } from "./Tools.ts";
import { email_ask, FRAME, IMAGES, live_push, MOVE, PING, QUIT, SUMMARIES, TICK, TURN, WIRE, type Answer, type Part, type Server as Out, type Wait } from "./View.ts";
import * as config from "./Config.ts";
import hello_md from "./hello.md" with { type: "text" };
import app_js from "./web/app.js" with { type: "file" };
import index_html from "./web/index.html" with { type: "file" };
import install_sh from "./web/install.sh" with { type: "file" };
import legal_css from "./web/legal.css" with { type: "file" };
import mark_svg from "./web/mark.svg" with { type: "file" };
import experimental_jpg from "./web/experimental.jpg" with { type: "file" };
import og_png from "./web/og.png" with { type: "file" };
import style_css from "./web/style.css" with { type: "file" };

// Types
// =====

// a socket: its user, sign-in (hashed), its query's fields, its device,
// the parts it was shown (Chat.teach)
type Sock = ServerWebSocket<{ user: User; who: string; tab: string; wire: string | null; host: string | null; computer: boolean; work: string; device: string | null; seen: Set<string> }>;

// a body: its file, its size so far
type Body = { fh: fs.promises.FileHandle; size: number };

// a message logged: its pages [id, end)
type Msg = { id: number; end: number };

// what the agent saw at its last call: the view before message `from`,
// then every message from it on
type Eye = { parts: Part[]; from: number };

// a goal check (Chat.check): its call (here, or by its ref as its chat
// moves), the goal it asks of
type Check<C> = { call: C; goal: string };

// an import as kept: messages [a, b), those sent (not notes), USD spent;
// as run: by level what each node costs (micro-USD, Import.import_guess)
// and how many are not built; their cost; its time (Chat.time) in all
type Kept  = { a: number; b: number; said: number; spent: number };
type Batch = Kept & { micros: number[][]; open: number[]; left: number; all: number };

// a chat: acts being done (Chat.apply); posts: requests and acts being
// taken, its start till what it resumed runs, and the command after a
// turn; model: what the turn's call runs on, as picked when it began (a
// /model since picks the next call's); asked: a request out, nothing
// back; open: tool calls without results; check: the turn's goal check
// running (Chat.check); sent, wait: messages given and waiting; ending:
// what to do once at rest as it ends (all: nothing runs) or moves (no
// post runs); writes, held: the posts logging, one after another, and
// the logging held meanwhile (null: none); wallet: what pays its calls;
// limits: the calls waiting for a usage limit, by TURN or agent name
type Chat = {
  acct  : Account;
  mem   : Memory;
  tools : Tools;
  pick  : Pick;
  socks : Set<Sock>;
  acts  : Map<string, Promise<Answer>>;
  busy  : boolean;
  posts : number;
  call  : Call | null;
  model : string;
  check : Check<Call> | null;
  asked : boolean;
  open  : number;
  sent  : Msg[];
  wait  : Msg[];
  halt  : AbortController;
  live  : Live[];
  calls : Record<string, string>; // its tool calls awaiting their results, by id (Chat.on)
  eye   : Eye;
  after : Promise<void>;
  batch : Batch | null;
  ending: { all: boolean; then: () => void } | null;
  writes: Promise<unknown>;
  held  : Array<() => void> | null;
  wallet: Wallet;
  limits: Record<string, Parked>;
};

// a chat as it moves to another process (Chat.move): its user (an id:
// a chat moved is never new, so no hello needs their name, and they may
// have signed out since), their credit as their billing last told it,
// its turn (its call and goal check's by their refs, Main.away), the
// tools' part, its summaries running
type Moved = { user: string; credit: number | undefined; turn: Turn; tools: Kit; sums: Given[] };
type Turn = { busy: boolean; call: string | null; model: string; check: Check<string> | null; sent: Msg[]; wait: Msg[]; asked: boolean; open: number; live: Live[]; calls: Record<string, string>; eye: Eye };

// another process (the one this gives its chats to or takes them from,
// or one a call is fed from or to), by a line of JSON a message
// (Main.told): the replies to payments asked of it; the calls fed from it
// here, by ref (Main.far), and the payments let through for them; end:
// the line closed once all sent is out, then `then`
type Peer = {
  send   : (msg: object) => void;
  end    : (then: () => void) => void;
  asks   : Map<string, (grant: Grant | string) => void>;
  feeds  : Map<string, Sink>;
  grants : Map<string, Grant>;
};

// a call fed from here to the process its chat is in (Main.away): run
// here, or passed on (a relay) till its origin feeds that process itself
type Away = { call: Call; link: Peer };

// a call fed here by its origin while its relay (the process its chat
// came from) still passes on what reached it first: what came straight
// meanwhile, held; whether its origin's line was lost
type Gate = { relay: Peer; origin: Peer; held: any[]; lost: boolean };

// a rate limit (Main.spend): what each key (a user, a network) may still
// spend, as of when; it grows `rate` a second, up to `most`
type Limit = { rate: number; most: number; keys: Map<string, { n: number; at: number }> };

// Constants
// =========

const LOCK       = config.DIR + "/lock";
// where worker k's successor reaches it, HAND + k (Main.listen); how
// often one that gave its chats looks whether its last requests ended
const HAND       = config.DIR + "/hand";
const LEAVE      = 500;
// how a call ends whose process ended first (a crash)
const ENDED      = "the server process that ran it ended";
// a turn's head, as a summary's is "Compaction:": one prompt serves both
const HEAD       = "Turn: the user's new message:\n\n";
// a goal's check (Chat.check): its own system prompt (Unii's, which says
// a call is a turn or a compaction, made the model summarize the chat
// instead of answering), asked after the chat (the view, its latest
// messages whole) of its goal; unmet, the user's nudge
const GOAL       = "You check a goal. Below is a chat between a user and Unii, an AI agent: its older messages as summary lines (id+n|text), then its latest messages whole, then the goal the user set with /goal. Answer yes if the chat shows the goal fully satisfied now, else no. Write that one word, nothing else.";
const GOAL_ASK   = "\nThe goal:\n\n";
const GOAL_NO    = "The goal isn't satisfied yet: keep working.";
const FULL       = "UniiChat's disk is full; try again soon.";
// an import running: its batch's file in the chat's dir (Chat.keep)
const BATCH      = "/import.json";
// under SPARE free, the disk takes no more (Chat.post)
const SPARE      = 2 ** 30;

// the acts with a body (Chat.post)
const BODIES     = ["say", "import", "voice"];

// a read of a body: a buffer, no limit
const READ       = 2 ** 20;

// what a socket may hold unsent (Bun's default, 16 MiB, drops the rest)
const BUFFER     = 2 ** 31 - 1;

// a piece of a long answer (Main.stream)
const PIECE      = 2 ** 16;

// what a user's clients may send (Main.spend): 200 messages (acts, asks,
// sockets opened) at once, 100 more a second, each counting once more
// for each UNIT in it (none is over View.FRAME); past it, a socket is
// closed (FLOOD) unread, a socket or an act posted refused (429), so no
// user's flood holds the worker every chat on it shares (a client opens
// again and sends what wasn't answered; a person's clicks, keys and
// tools never come near: a screenshot counts ~3)
const USERS: Limit = { rate: 100, most: 200, keys: new Map() };
const UNIT       = 2 ** 16;
const FLOOD      = 1008;

// the sockets a user's clients may hold open at once (Main.sockets: a
// view each, a tab, a terminal, the app); past it a new one is refused
// (429), so no user fills the worker's memory with sockets, each of which
// may hold an unfinished message up to View.FRAME
const SOCKETS    = 32;

// what a network (Cloud.net: an IPv4 address, an IPv6 /48) may ask of the
// site: 1,000 requests at once, 100 more a second; past it the supervisor
// answers 429, so no worker hears it. A page opens in ~10, then lives on
// its socket: a hundred people behind one NAT opening it at once never
// come near
const NETS: Limit = { rate: 100, most: 1000, keys: new Map() };

// the model requests a worker may have open at once (Bun's fetch: 256)
const FETCHES    = 65535;

// the paths of a user signed in, but /api/'s (the rest: the site's files)
const OWN        = ["/ws", "/tree", "/export"];

// what a recording is written out by, and its fewest bytes a second
// (Opus's least, 6 kbps)
const VOICE: Pick = { vendor: "openai-api", model: TRANSCRIBER, effort: "", speed: "slow" };
const AUDIO      = 750;

// the first message, ending in the installer every terminal starts from,
// signed out (it signs in by email: Term.ts login_run), so the message
// holds no credential a screenshot could leak
const HELLO      = hello_md.trim().replace("{install}", config.SITE + "/install.sh");

// the site's files, by path (a new one is imported above)
const WEB: Record<string, string> = {
  "/"               : index_html,
  "/account"        : index_html,
  "/app.js"         : app_js,
  "/experimental.jpg": experimental_jpg,
  "/favicon.svg"    : mark_svg,
  "/install.sh"     : install_sh,
  "/legal.css"      : legal_css,
  "/mark.svg"       : mark_svg,
  "/og.png"         : og_png,
  "/style.css"      : style_css,
};

// a new account's chat opens as its guest's talk went (main.ts guest), so
// its next line follows from the email: hello.md asking for it (View.ask),
// the email, and SIGNED. The hello's node is written with it, so no
// compactor call summarizes the three (with an email of up to 254 bytes,
// a node of at most 512 bytes) and a new account owes nothing.
const HELLO_LINE = "unii: hello: UniiChat, one endless chat kept in a memory tree, recent days in more detail; build anything for years; recalls the past (ad2cat.py); a chatbot with a memory system; the user's terminal install; asks their email.";
const SIGNED     = "You're in! What should we start with?";

// Chat
// ====

export namespace Chat {

  // the accounts (set at start); the chats loaded, by user
  export let cloud: Cloud;
  export const chats = new Map<string, Chat>();

  // a chat's paid calls ask its wallet (Billing.ts), each sent only while
  // its credit pays it (a balance not told yet is none): its summaries
  // start once told. One
  // moving here takes what ran (`moved`); none opens as this process
  // gives its chats away (null). A chat is kept only once open whole, so
  // one that fails to (throws) is never left half open
  export function open(user: User, moved: Moved | null = null, peer: Peer | null = null): Chat | null {
    const cloud = Chat.cloud;
    const old = Chat.chats.get(user.id);
    if (old !== undefined || (Main.given && moved === null)) {
      return old ?? null;
    }
    const acct = { cloud, user: user.id };
    const dir = config.DIR + "/users/" + user.id;
    const mem = Memory.load(dir, () => Chat.share(chat), (id, ans) => Cloud.act_put(acct, id, ans));
    const tools = Tools.serve(mem, {
      push   : (agent, kind, text) => Chat.push(chat, agent, kind, text),
      on     : (agent, ev) => Chat.on(chat, agent, ev),
      report : (agent, text, stopped) => Chat.report(chat, agent, text, stopped),
      change : () => Chat.change(chat),
      pick   : () => chat.pick,
      halt   : () => chat.halt.signal,
    }, moved?.tools.key);
    const wallet = cloud.billing.wallet({
      user  : user.id,
      mem,
      batch : () => chat.batch,
      told  : () => Chat.all(chat, Chat.state(chat)),
      rest  : () => Chat.free(chat),
    });
    const pick = Pick.load(mem.pick, config.OFFER, config.PICK);
    const chat: Chat = {
      acct, mem, tools, pick, socks: new Set(), acts: new Map(), busy: false, posts: 1, call: null, model: "", check: null, asked: false, open: 0, sent: [], wait: [],
      halt: new AbortController(), live: [], calls: {}, eye: { parts: [], from: 0 }, after: Promise.resolve(), batch: null, ending: null,
      writes: Promise.resolve(), held: null, wallet, limits: {},
    };
    // a saved pick not offered gave way: told once
    const saved = mem.pick === null ? null : Pick.label(mem.pick as Pick);
    if (saved !== null && saved !== Pick.label(pick)) {
      mem.pick = pick;
      Memory.save(mem);
      Chat.note(chat, saved + " isn't offered here, so the chat now runs on " + Pick.label(pick) + ".");
    }
    mem.pay = tools.pay = wallet.pay;
    if (mem.count === 0) {
      const hello = HELLO + "\n\n" + email_ask(cloud.billing.github !== null);
      Memory.push(mem, [{ kind: "unii", text: hello, line: HELLO_LINE }, { kind: "user", text: user.name }, { kind: "unii", text: SIGNED }]);
    }
    chat.eye = Chat.eye(mem, Memory.turn(mem));
    mem.made = (l, i) => Chat.made(chat, l, i);
    mem.wait.add(() => Chat.progress(chat));
    mem.wait.add(() => Chat.free(chat));
    const work = moved === null ? mem.work : [];
    chat.batch = Chat.resumed(chat);
    if (moved !== null) {
      Chat.arrive(chat, moved, peer!);
    }
    Chat.chats.set(user.id, chat);
    cloud.billing.balance(user.id).then(async () => {
      Memory.pump(mem);
      Chat.progress(chat);
      await Chat.resume(chat, work);
    }).finally(() => {
      chat.posts -= 1;
      Chat.change(chat);
    }).catch((err) => console.error("chat " + acct.user + ": open: " + (err?.message ?? err)));
    return chat;
  }

  // what every call of the chat starts with, a summary's too: its system
  // prompt. A summary gets no tools: one it called, ours or the API's
  // own (web search brings code execution), sent its whole input again
  export function share(chat: Chat): Share {
    const system = Tools.system(MASTER);
    return { ...Pick.ask(chat.pick), system, searches: 0, server: "" };
  }

  // at rest (nothing runs): pays, and lets go of a chat nobody views;
  // one ending or moving does that once at its rest (Chat.ending), and
  // one ended or moved never (it pays where it is, or as it closes)
  export function free(chat: Chat): void {
    const acct = chat.acct;
    const ending = chat.ending;
    if (ending !== null && chat.posts === 0 && (!ending.all || Chat.idle(chat))) {
      chat.ending = null;
      ending.then();
    }
    if (ending !== null || !Chat.idle(chat) || Chat.chats.get(acct.user) !== chat) {
      return;
    }
    Chat.cloud.billing.settle(acct.user);
    if (chat.socks.size === 0) {
      Tools.close(chat.tools);
      Memory.stop(chat.mem);
      Chat.chats.delete(acct.user);
    }
  }

  // no turn, post, agent, summary or paid request runs (one stopped is
  // read on to its end, then billed: Billing.ts book)
  export function idle(chat: Chat): boolean {
    return !chat.busy && chat.posts === 0 && Tools.working(chat.tools).length === 0 && chat.mem.busy.size === 0 && chat.wallet.booked() === 0;
  }

  // stops a chat for good; done at rest, its work logged where it was cut
  export function end(chat: Chat): Promise<void> {
    Chat.chats.delete(chat.acct.user);
    chat.socks.forEach((sock) => sock.close());
    Chat.stop(chat, null);
    Memory.stop(chat.mem);
    return new Promise((done) => {
      const then = () => {
        Tools.close(chat.tools);
        done();
      };
      chat.ending = { all: true, then };
      Chat.free(chat);
    });
  }

  // a message (its body: its images, sizes given, then its text), logged
  // and taken
  export async function say(chat: Chat, id: string, sizes: number[], body: Body): Promise<Answer> {
    const images: string[] = [];
    let at = 0;
    for (const size of sizes) {
      const name = await Memory.image_add(chat.mem, await Chat.read(body, at, size));
      if (name === null) {
        return { error: IMAGES };
      }
      images.push(name);
      at += size;
    }
    await Chat.writing(chat, async () => Chat.take(chat, await Chat.text(chat, body, at, images, id)));
    return {};
  }

  // up to n bytes of a body, from byte `at`
  export async function read(body: Body, at: number, n: number): Promise<Buffer> {
    const buf = Buffer.alloc(n);
    const got = await body.fh.read(buf, 0, n, at);
    return buf.subarray(0, got.bytesRead);
  }

  // a body's text from byte `at`, logged as the user's message, a read
  // at a time, the last with the images and the act's record
  export async function text(chat: Chat, body: Body, at: number, images: string[], act: string): Promise<Msg> {
    const id = chat.mem.count;
    for await (const [pages, more] of Chat.pieces(body, at, clip_pages)) {
      Chat.push(chat, null, "user", pages.join(""), more ? [] : images, more, more ? undefined : act);
    }
    return { id, end: chat.mem.count };
  }

  // a post's logging, after the chat's earlier ones, holding its other
  // logging (Chat.hold) till it ends, so a long post's pages stay together
  export function writing<T>(chat: Chat, write: () => Promise<T>): Promise<T> {
    const run = chat.writes.then(async () => {
      chat.held = [];
      try {
        return await write();
      } finally {
        const held = chat.held ?? [];
        chat.held = null;
        chat.mem.open = 0;
        held.forEach((step) => step());
      }
    });
    chat.writes = run.catch(() => {});
    return run;
  }

  // a step that logs to the chat: now, or once the post logging ends
  export function hold(chat: Chat, step: () => void): void {
    if (chat.held === null) {
      step();
    } else {
      chat.held.push(step);
    }
  }

  // a body's text from byte `at`, cut in pieces a READ at a time, and
  // whether more come; none over READ
  export async function* pieces(body: Body, at: number, cut: (text: string) => string[]): AsyncGenerator<[string[], boolean]> {
    const dec = new TextDecoder();
    let rest = "";
    do {
      const buf = await Chat.read(body, at, READ);
      at += buf.length;
      const all = cut(rest + dec.decode(buf, { stream: at < body.size }));
      rest = at < body.size ? all.pop()! : "";
      if (rest.length > READ) {
        throw new Error("A line over " + READ + " characters: no import sends it.");
      }
      yield [all, at < body.size];
    } while (at < body.size);
  }

  // a recording's words, logged as the act's answer, then billed (booked
  // as its bytes at AUDIO a second)
  export async function voice(chat: Chat, id: string, type: string, body: Body): Promise<Answer> {
    const most = Price.cost(VOICE.model, { ...Price.usage("slow"), seconds: body.size / AUDIO });
    const pay = await chat.mem.pay?.("voice", id)?.({ input: most, token: 0, exact: null }, 0);
    if (typeof pay === "string") {
      return { error: pay };
    }
    const got = await OpenAI.transcribe(new Blob([await Chat.read(body, 0, body.size)], { type })).catch((err: Error) => err);
    if (got instanceof Error) {
      pay?.end(null);
      return { error: got.message };
    }
    Chat.mark(chat, id, { ans: { text: got.text } });
    pay?.end({ run: VOICE, use: { ...Price.usage("slow"), seconds: got.seconds } });
    return { text: got.text };
  }

  // a message logged: to the running call if whole beside its view, else
  // to the next (a goal check running, whose answer it drops, stops)
  export function take(chat: Chat, msg: Msg): void {
    const mem = chat.mem;
    if (chat.call !== null && Memory.whole(mem, msg.id) === msg.id) {
      chat.sent.push(msg);
      chat.call.send(Memory.say(mem, msg.id, msg.end));
      return;
    }
    chat.wait.push(msg);
    chat.check?.call.stop();
    if (!chat.busy) {
      Chat.turn(chat);
    }
  }

  // first: the end of the call running (its chat moved here)
  export async function turn(chat: Chat, first: Promise<boolean> | null = null): Promise<void> {
    chat.busy = true;
    try {
      let go = first === null || (await first);
      while (go && chat.wait.length > 0) {
        go = await Chat.call(chat);
      }
    } catch (err: any) {
      Chat.failed(chat, String(err?.message ?? err));
    } finally {
      const why: string | null = chat.halt.signal.aborted ? chat.halt.signal.reason : null;
      if (why !== null) {
        Chat.note(chat, why);
      }
      chat.call = null;
      chat.sent = [];
      chat.wait = [];
      chat.busy = false;
      Chat.live(chat, null, []);
      Chat.phone(chat);
      Chat.after(chat);
      Chat.change(chat);
    }
  }

  // where a call's messages go whole from (a message meanwhile may move it)
  export function from(chat: Chat): number {
    return Memory.whole(chat.mem, chat.wait[0].id);
  }

  // false: the turn ends
  export async function call(chat: Chat): Promise<boolean> {
    const mem = chat.mem;
    const halt = (chat.halt = new AbortController());
    Chat.change(chat);
    let from = -1;
    while (from !== Chat.from(chat)) {
      from = Chat.from(chat);
      const why = await Memory.settle(mem, from, halt.signal);
      if (why !== null) {
        if (!halt.signal.aborted) {
          Chat.failed(chat, why);
        }
        return false;
      }
    }
    const msgs = (chat.sent = chat.wait.splice(0));
    const says = msgs.filter((m) => m.end > from).map((m) => Memory.say(mem, Math.max(m.id, from), m.end));
    const view = Memory.view(mem, from);
    const text = says.map((say) => say.text).join("\n\n");
    const imgs = says.flatMap((say) => say.imgs);
    const server = Tools.at(chat.tools, "main");
    chat.eye = Chat.eye(mem, from);
    chat.socks.forEach((sock) => Chat.show(chat, sock));
    const bill = mem.pay?.("chat", String(msgs[0].id));
    const blocks = [...view, Tools.devices(chat.tools), Tools.at_work(chat.tools), { text: HEAD + text, mark: true }];
    const ask = { ...Chat.share(chat), searches: SEARCHES, server, blocks, imgs, bill };
    chat.model = chat.pick.model;
    chat.asked = true;
    chat.open = 0;
    const call = (chat.call = AskAI.ask(ask, (ev) => Chat.on(chat, null, ev)));
    Chat.change(chat);
    return Chat.ended(chat, call, halt);
  }

  // the turn's call ends; false: the turn ends. One a deploy cut as it
  // waited for a usage limit goes on, as after a restart
  export async function ended(chat: Chat, call: Call, halt: AbortController): Promise<boolean> {
    const end = await call.done;
    chat.call = null;
    delete chat.limits[TURN];
    Chat.unanswered(chat, null);
    Chat.live(chat, null, []);
    chat.wait.unshift(...chat.sent.slice(chat.sent.length - end.left.length));
    if (end.cut && !halt.signal.aborted) {
      await Chat.writing(chat, () => Chat.resume(chat, [TURN]));
    } else if (!end.ok && !halt.signal.aborted) {
      Chat.failed(chat, end.text);
    }
    if (end.note) {
      Chat.all(chat, { $: "note", text: end.note });
    }
    const goal = chat.mem.goal;
    if (end.ok && !halt.signal.aborted && chat.wait.length === 0 && goal !== null) {
      return Chat.checked(chat, Chat.check(chat, goal), halt);
    }
    return !halt.signal.aborted;
  }

  // the user's goal (/goal), asked of the chat's model, without tools, on
  // the chat as it is now
  export function check(chat: Chat, goal: string): Check<Call> {
    const mem  = chat.mem;
    const at   = Memory.whole(mem, 0);
    const tail = Array.from({ length: mem.count - at }, (_, k) => at + k).map((i) => {
      const msg = Memory.message(mem, i)!;
      return Memory.line({ l: 0, i }, msg.kind + ": " + msg.text) + "\n";
    });
    const blocks = [...Memory.view(mem, at), { text: tail.join("") + GOAL_ASK + goal, mark: true }];
    return { call: AskAI.ask({ ...Chat.share(chat), system: GOAL, blocks, bill: mem.pay?.("chat", "goal") }, (ev) => Chat.checking(chat, ev)), goal };
  }

  // a goal check's events: only its waits for a usage limit show, as the
  // turn's
  export function checking(chat: Chat, ev: Event): void {
    if (ev.$ === "Limit") {
      Chat.limit(chat, TURN, ev.limit);
    }
  }

  // a goal check's answer, as the turn's call's is, read where the chat
  // is (its call moves with it: Chat.move): unmet (any answer but yes),
  // the user's nudge goes to the turn as their message; met, the goal
  // ends. A check that fails, a stop, a message or a /halt meanwhile end
  // it with no nudge, so the turn ends; one a deploy cut as it waited for
  // a usage limit is asked anew; false: it ends
  export async function checked(chat: Chat, check: Check<Call>, halt: AbortController): Promise<boolean> {
    const { call, goal } = (chat.check = check);
    halt.signal.addEventListener("abort", () => call.stop(), { once: true });
    const end = await call.done;
    const mem = chat.mem;
    const on = !halt.signal.aborted && mem.goal === goal && chat.wait.length === 0;
    chat.check = null;
    delete chat.limits[TURN];
    if (on && end.cut) {
      return Chat.checked(chat, Chat.check(chat, goal), halt);
    }
    if (on && !end.ok) {
      Chat.note(chat, "No goal check: " + end.text.replace(/\.$/, "") + ". The goal stays; /halt drops it.");
    } else if (on && /^\W*yes\b/i.test(end.text)) {
      mem.goal = null;
      Memory.save(mem);
      Chat.note(chat, "Goal met.");
    } else if (on) {
      await Chat.writing(chat, async () => Chat.take(chat, Chat.push(chat, null, "user", GOAL_NO)));
    }
    return !halt.signal.aborted;
  }

  // a failed turn's why, as a note
  export function failed(chat: Chat, why: string): void {
    Chat.note(chat, "No reply: " + why.replace(/\.$/, "") + ". Send a message to try again.");
  }

  // a note in the chat, why work ended as it did
  export function note(chat: Chat, text: string): void {
    Chat.hold(chat, () => Chat.push(chat, null, "note", text));
  }

  // to the chat (in pages), or an agent's log; each told to every view
  export function push(chat: Chat, agent: Agent | null, kind: Kind, text: string, images: string[] = [], more = false, act?: string): Msg {
    if (agent !== null) {
      const id = Memory.agent_push(chat.mem, agent.name, kind, text);
      Chat.all(chat, { $: "entry", agent: agent.name, id, kind, text });
      return { id, end: id + 1 };
    }
    const roots = Memory.push(chat.mem, [{ kind, text, images, more, act }]);
    for (const { i, kind, text, date, images } of roots) {
      Chat.all(chat, { $: "entry", id: i, kind, text, date, images });
    }
    return { id: roots[0].i, end: chat.mem.count };
  }

  // a message the call took was logged as it came
  export function on(chat: Chat, agent: Agent | null, ev: Event): void {
    const at = agent ?? chat;
    const name = agent?.name;
    if (ev.$ === "Limit") {
      return Chat.limit(chat, name ?? TURN, ev.limit);
    }
    if (agent === null) {
      Chat.asks(chat, ev);
    }
    if (ev.$ === "Delta") {
      live_push(at.live, ev.kind, ev.text, ev.fresh);
      Chat.all(chat, { $: "delta", agent: name, kind: ev.kind, text: ev.text, fresh: ev.fresh });
      return;
    }
    if (ev.kind === "tool" && ev.of !== undefined) {
      at.calls[ev.of] = ev.text;
    } else if (ev.kind === "mind") {
      Chat.all(chat, { $: "entry", agent: name, kind: ev.kind, text: ev.text });
    } else if (ev.kind !== "user") {
      const call = ev.of === undefined ? undefined : at.calls[ev.of];
      delete at.calls[ev.of ?? ""];
      Chat.hold(chat, () => {
        if (call !== undefined) {
          Chat.push(chat, agent, "tool", call);
        }
        Chat.push(chat, agent, ev.kind, ev.text);
      });
    }
    Chat.live(chat, agent, Chat.waiting(at));
  }

  // the turn (TURN) or agent named waits for a usage limit (Agent.park),
  // or no longer (null), told to every view
  export function limit(chat: Chat, name: string, limit: Parked | null): void {
    if (limit === null) {
      delete chat.limits[name];
    } else {
      chat.limits[name] = limit;
    }
    Chat.all(chat, Chat.state(chat));
  }

  // what streams once an entry came: the tool calls awaiting their
  // results, as they will be logged; what was drawn never vanishes
  // before it is printed
  export function waiting(at: { calls: Record<string, string> }): Live[] {
    return Object.values(at.calls).map((text) => ({ kind: "tool", text }));
  }

  // a call's tool calls left without a result (it was stopped), logged
  // as they are, once it ends
  export function unanswered(chat: Chat, agent: Agent | null): void {
    const at = agent ?? chat;
    const calls = Object.values(at.calls);
    at.calls = {};
    Chat.hold(chat, () => calls.forEach((call) => Chat.push(chat, agent, "tool", call)));
    Chat.live(chat, agent, []);
  }

  // the model is asked again once handed all it waits for, until its
  // answer starts
  export function asks(chat: Chat, ev: Event): void {
    const kind = ev.$ === "Entry" ? ev.kind : "";
    const step = kind === "tool" ? 1 : kind === "echo" ? -1 : 0;
    chat.open = ev.$ === "Delta" ? 0 : Math.max(0, chat.open + step);
    const asked = (kind === "echo" || kind === "user") && chat.open === 0;
    if (asked !== chat.asked) {
      chat.asked = asked;
      Chat.change(chat);
    }
  }

  // what streams for the chat (agent: null) or an agent, set and told
  export function live(chat: Chat, agent: Agent | null, live: Live[]): void {
    (agent ?? chat).live = live;
    Chat.all(chat, { $: "live", agent: agent?.name, live });
  }

  // an agent's report, once it ends: a turn of its own, unless stopped or
  // out of credit; none once its chat ended (the next start resumes it).
  // It is taken as a post is, so the chat never rests between logging it
  // and its turn
  export function report(chat: Chat, agent: Agent, text: string, stopped: boolean): void {
    delete chat.limits[agent.name];
    Chat.unanswered(chat, agent);
    Chat.live(chat, agent, []);
    Chat.hold(chat, () => {
      chat.posts += 1;
      const msg = Chat.chats.get(chat.acct.user) !== chat ? null : Chat.push(chat, null, "work", text);
      if (msg !== null && !stopped && Chat.cloud.billing.refuse(chat.acct.user, 0) === null) {
        Chat.take(chat, msg);
      }
      chat.posts -= 1;
      Chat.change(chat);
      Chat.free(chat);
    });
  }

  // a turn's last message, Unii's reply or why there was none, to the
  // user's phones (Cloud.push)
  export function phone(chat: Chat): void {
    const last = Memory.message(chat.mem, chat.mem.count - 1);
    if (last !== null && (last.kind === "unii" || last.kind === "note")) {
      Cloud.push(Chat.cloud, chat.acct.user, last.text);
    }
  }

  // config.AFTER, a shell command, after each turn
  export function after(chat: Chat): void {
    if (!config.AFTER) {
      return;
    }
    chat.posts += 1;
    chat.after = chat.after.then(async () => {
      const proc = Bun.spawn(["/bin/sh", "-c", config.AFTER], { stdout: "ignore", stderr: "pipe" });
      const err = await new Response(proc.stderr).text();
      if ((await proc.exited) !== 0) {
        Chat.all(chat, { $: "note", text: "after: " + err.trim() });
      }
    }).catch((err) => console.error("after: " + (err?.message ?? err))).finally(() => {
      chat.posts -= 1;
      Chat.free(chat);
    });
  }

  // Import
  // ------

  // an import (its body: messages as JSON lines), those new (fresh) logged
  // as one, summarized on the compactor; refused amid a turn or an
  // import, or past the credits
  export async function ingest(chat: Chat, id: string, body: Body): Promise<Answer> {
    if (chat.busy || chat.batch !== null) {
      return { error: (chat.busy ? "Unii is answering" : "An import is under way") + ": import again once it ends." };
    }
    const done = Chat.done(chat);
    const sizes: number[] = [];
    let said = 0;
    for await (const msgs of Chat.fresh(body, done)) {
      sizes.push(...msgs.map(Import.import_size));
      said += msgs.filter((m) => m.kind !== "note").length;
    }
    const a = chat.mem.count;
    const usd = Import.import_usd(a, sizes);
    if (sizes.length === 0) {
      return { error: "Nothing to import: no new messages found." };
    }
    const refused = Chat.cloud.billing.refuse(chat.acct.user, usd);
    if (refused !== null) {
      return refused;
    }
    chat.mem.hold[1] = null;
    const tag = (m: Log, of: boolean): Log => ({ ...m, imported: true, ...(of ? { more: true } : { more: false, act: id }) });
    let held: Log[] = [];
    for await (const msgs of Chat.fresh(body, done)) {
      const all = [...held, ...msgs];
      held = all.splice(-1);
      Memory.push(chat.mem, all.map((m) => tag(m, true)));
    }
    Memory.push(chat.mem, held.map((m) => tag(m, false)));
    chat.batch = Chat.batch(chat, { a, b: chat.mem.count, said, spent: 0 });
    chat.socks.forEach((sock) => Chat.show(chat, sock));
    Chat.progress(chat);
    return { going: chat.batch !== null };
  }

  // an import run: its estimate, of its messages' sizes as logged, timed
  // with none built, then its summaries built counted
  export function batch(chat: Chat, { a, b, said, spent }: Kept): Batch {
    const sizes = Array.from({ length: b - a }, (_, k) => Memory.message(chat.mem, a + k)?.size ?? 0);
    const micros = Import.import_guess(a, sizes);
    const batch = { a, b, said, spent, micros, open: micros.map((level) => level.length), left: micros.flat().reduce((x, y) => x + y, 0), all: 0 };
    batch.all = Chat.time(batch);
    micros.forEach((level, l) => level.forEach((_, j) => Memory.node(chat.mem, { l, i: Math.floor(a / 2 ** l) + j }) !== null && Chat.built(batch, l, j)));
    return batch;
  }

  // node j of level l built (none such: the chat's)
  export function built(batch: Batch, l: number, j: number): void {
    const cost = batch.micros[l]?.[j];
    if (cost !== undefined) {
      batch.left -= cost;
      batch.open[l] -= 1;
    }
  }

  // its time left in micro-USD (a call's, as its cost, is its thinking):
  // its cost left over JOBS, then each level not built's last call (the
  // tree's top builds a call a level)
  export function time(batch: Batch): number {
    return batch.left / JOBS + batch.micros.reduce((t, level, l) => t + (batch.open[l] > 0 ? level.at(-1)! : 0), 0);
  }

  // kept as it is till it ends (a restart changes nothing): written
  // whole, then moved in place
  export function keep(batch: Batch, chat: Chat): void {
    const file = chat.mem.dir + BATCH;
    const { a, b, said, spent } = batch;
    fs.writeFileSync(file + ".new", JSON.stringify({ a, b, said, spent, why: chat.mem.hold[1] }));
    fs.renameSync(file + ".new", file);
  }

  // the import a chat ran when let go (BATCH); null: none
  export function resumed(chat: Chat): Batch | null {
    const file = chat.mem.dir + BATCH;
    if (!fs.existsSync(file)) {
      return null;
    }
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    chat.mem.hold[1] = saved.why === "paused" ? "paused" : null;
    return Chat.batch(chat, saved);
  }

  // a body's JSON lines, as messages imported (a line is a page)
  export async function* reads(body: Body): AsyncGenerator<Log[]> {
    for await (const [lines] of Chat.pieces(body, 0, (text) => text.split("\n"))) {
      yield lines.filter((line) => line !== "").map((line) => Chat.imported(JSON.parse(line)));
    }
  }

  // a body's messages new to the chat (Import.import_new): a session
  // imported before brings only what came after, its note only then
  export async function* fresh(body: Body, done: Import.Done): AsyncGenerator<Log[]> {
    let note: Log | null = null;
    let last: string | undefined;
    for await (const msgs of Chat.reads(body)) {
      const out: Log[] = [];
      for (const m of msgs) {
        if (m.kind === "note") {
          [note, last] = [m, done[Import.import_key(m)]];
        } else if (Import.import_new(m, last)) {
          out.push(...(note === null ? [] : [note]), m);
          note = null;
        }
      }
      yield out;
    }
  }

  // the sessions the chat imported (Import.Done), read from its log
  export function done(chat: Chat): Import.Done {
    const done: Import.Done = {};
    let key = "";
    for (let i = 0; i < chat.mem.count; i++) {
      const m = Memory.message(chat.mem, i)!;
      if (m.imported && m.kind === "note") {
        key = Import.import_key(m);
      } else if (m.imported && m.date > (done[key] ?? "")) {
        done[key] = m.date;
      }
    }
    return done;
  }

  // a message imported (a page); a line with no kind or no text refuses
  // the import whole (ingest reads every line before it logs one)
  export function imported(x: any): Log {
    const kinds: Kind[] = ["user", "unii", "tool", "echo", "note"];
    if (!kinds.includes(x?.kind)) {
      throw new Error("An import has no kind " + x?.kind + ".");
    }
    if (typeof x.text !== "string") {
      throw new Error("An import has a " + x.kind + " message with no text.");
    }
    const date = Number.isNaN(Date.parse(x.date)) ? undefined : new Date(x.date).toISOString();
    return { kind: x.kind, text: x.text, date, more: x.more === true };
  }

  // a summary built (Memory's made): counted, if the import's; sent to
  // each view shown its block (Chat.teach)
  export function made(chat: Chat, l: number, i: number): void {
    if (chat.batch !== null) {
      Chat.built(chat.batch, l, i - Math.floor(chat.batch.a / 2 ** l));
    }
    const [a] = Memory.span({ l, i });
    for (const sock of chat.socks) {
      if (sock.data.seen.has(a + "+" + 2 ** l)) {
        Chat.know(chat, sock, a, 2 ** l);
      }
    }
  }

  // as the view changes (Memory's wait): the state; done when all are
  // built; not as the chat is let go (Chat.resumed)
  export function progress(chat: Chat): void {
    const batch = chat.batch;
    if (batch === null || chat.mem.done) {
      return;
    }
    if (batch.open.every((n) => n === 0)) {
      return Chat.digest(chat, batch);
    }
    Chat.keep(batch, chat);
    Chat.all(chat, Chat.state(chat));
  }

  export function digest(chat: Chat, batch: Batch): void {
    chat.batch = null;
    fs.rmSync(chat.mem.dir + BATCH, { force: true });
    chat.eye = Chat.eye(chat.mem, Math.max(chat.eye.from, batch.b));
    chat.socks.forEach((sock) => Chat.show(chat, sock));
    const said = "Imported " + Import.import_count(batch.said, "") + ".";
    Chat.all(chat, { $: "note", text: said });
    Chat.change(chat);
  }

  // an import paused, at once (Memory.pause), or resumed (short of credit,
  // it waits for it)
  export function go(chat: Chat, on: boolean): Answer {
    if (chat.batch === null) {
      return { error: "No import is running." };
    }
    if (on) {
      chat.mem.hold[1] = null;
    } else {
      Memory.pause(chat.mem);
    }
    Chat.keep(chat.batch, chat);
    Chat.all(chat, Chat.state(chat));
    Memory.pump(chat.mem);
    Chat.change(chat);
    return {};
  }

  // the chats a restart cut at work or importing, opened; one that fails
  // to load is logged and left (its user's page gets the error), never
  // keeping the worker, which serves every other user, from starting
  export function wake(): void {
    const dir = config.DIR + "/users/";
    for (const id of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      const user = Main.shard(id) === Main.index ? Cloud.user(Chat.cloud, id) : null;
      if (user !== null && ((Memory.saved(dir + id)?.work ?? []).length > 0 || fs.existsSync(dir + id + BATCH))) {
        Main.event("waking the chat of user " + id, () => Chat.open(user));
      }
    }
  }

  // the work a restart cut goes on, told so: each agent, and Unii's turn
  // by a note (none for a chat ended meanwhile)
  export async function resume(chat: Chat, work: string[]): Promise<void> {
    if (work.length === 0 || Chat.chats.get(chat.acct.user) !== chat) {
      return;
    }
    const text = Tools.restarted(work);
    const msg = Chat.push(chat, null, "note", text);
    await Promise.all(work.map((w) => (w === TURN ? Chat.take(chat, msg) : Tools.tell(chat.tools, w, text))));
  }

  // Moving
  // ------

  // the chat moves to `peer`'s process, whose tools are at `url`, once no
  // post of it runs; no summary starts meanwhile, and those running go
  // along (Memory.give): waiting for them hung the chat (an import's run
  // on), cutting them asked each again there, billed twice
  export function give(chat: Chat, peer: Peer, url: string): void {
    Memory.halt(chat.mem);
    chat.ending = { all: false, then: () => Chat.move(chat, peer, url) };
    Chat.free(chat);
  }

  // the chat moves: what it runs goes on there (its calls by Main.away),
  // and its views open again there
  export function move(chat: Chat, peer: Peer, url: string): void {
    const user = chat.acct.user;
    const far = (call: Call) => Main.away(peer, call);
    const { busy, model, sent, wait, asked, open, live, calls, eye } = chat;
    const check = chat.check && { call: far(chat.check.call), goal: chat.check.goal };
    const turn = { busy, call: chat.call && far(chat.call), model, check, sent, wait, asked, open, live, calls, eye };
    const tools = Tools.give(chat.tools, url, far);
    if (chat.batch !== null) {
      Chat.keep(chat.batch, chat);
    }
    const sums = Memory.give(chat.mem, far);
    Chat.chats.delete(user);
    Memory.stop(chat.mem);
    peer.send({ $: "chat", moved: { user, credit: Chat.cloud.billing.credit.get(user), turn, tools, sums } });
    chat.socks.forEach((sock) => sock.close(MOVE));
    Main.done();
  }

  // a chat moved here (Chat.move) goes on: its turn, agents and summaries,
  // each call running there by Main.far
  export function arrive(chat: Chat, moved: Moved, peer: Peer): void {
    const { call, check, ...turn } = moved.turn;
    const far = (id: string, on: (ev: Event) => void, bill?: Bill) => Main.far(peer, id, chat.tools.key, on, bill);
    Object.assign(chat, turn);
    Tools.take(chat.tools, moved.tools, far);
    Memory.take(chat.mem, moved.sums, (id, bill) => far(id, () => {}, bill));
    if (turn.busy) {
      const run = call === null ? null : (chat.call = far(call, (ev) => Chat.on(chat, null, ev), chat.mem.pay?.("chat", String(turn.sent[0].id))));
      const checking = check ? { call: far(check.call, (ev) => Chat.checking(chat, ev), chat.mem.pay?.("chat", "goal")), goal: check.goal } : null;
      Chat.turn(chat, run ? Chat.ended(chat, run, chat.halt) : checking && Chat.checked(chat, checking, chat.halt));
    }
  }

  // what runs: Unii's turn, the agents at work
  export function running(chat: Chat): string[] {
    return [...(chat.busy ? [TURN] : []), ...Tools.working(chat.tools).map((a) => a.name)];
  }

  // UniiChat's turn only, with the spawns and tells it waits on (for the
  // view: Tools.view, on chat.halt); agents go on. why: the note the turn's
  // end logs (Chat.turn), so after the reply the stop cut; null: none
  export function interrupt(chat: Chat, why: string | null): void {
    chat.halt.abort(why);
    chat.call?.stop();
  }

  // all work, agents too; its why noted at the turn's end, or at once if
  // no turn is left to end
  export function stop(chat: Chat, why: string | null): void {
    const turn = chat.busy && !chat.halt.signal.aborted;
    Chat.interrupt(chat, turn ? why : null);
    Tools.stop(chat.tools, null);
    if (!turn && why !== null) {
      Chat.note(chat, why);
    }
  }

  // Views
  // -----
  // A socket message carries at most one log entry, summary or job, so
  // none is too large to hear the next tick in time.

  export function all(chat: Chat, msg: Out): void {
    chat.socks.forEach((sock) => Chat.send(sock, msg));
  }

  export function send(sock: Sock, msg: object): void {
    sock.send(JSON.stringify(msg));
  }

  export function state(chat: Chat): Out {
    const agents = Tools.working(chat.tools).map((a) => a.name);
    const batch = chat.batch;
    const why = chat.mem.hold[1];
    const importing = batch && { done: batch.all - Chat.time(batch), total: batch.all, spent: batch.spent, left: batch.left / 1e6, why, msgs: batch.b - batch.a, open: batch.open };
    const billing = Chat.cloud.billing;
    return { $: "state", busy: chat.busy, wait: Chat.waits(chat), agents, pick: chat.pick, ...config.OFFER, bills: billing.bills, credits: billing.credits(chat.acct.user), importing, limits: chat.limits };
  }

  export function waits(chat: Chat): Wait {
    if (chat.call !== null) {
      return chat.asked ? chat.model : "";
    }
    const summing = chat.busy && chat.wait.length > 0 && Memory.first(chat.mem) < Chat.from(chat);
    return summing ? SUMMARIES : "";
  }

  // the wallet told the change (Billing.ts changed): what it ends stops
  // all work running, saying so; what runs is saved, unless the chat ended
  export function change(chat: Chat): void {
    const stop = chat.wallet.changed();
    const work = Chat.running(chat);
    if (Chat.chats.get(chat.acct.user) === chat && String(work) !== String(chat.mem.work)) {
      chat.mem.work = work;
      Memory.save(chat.mem);
    }
    const turn = chat.busy && !chat.halt.signal.aborted;
    const agents = [...chat.tools.agents.values()].some((a) => a.call !== null && !a.stop);
    if ((turn || agents) && stop !== null) {
      Chat.stop(chat, stop);
    }
    Chat.all(chat, Chat.state(chat));
    Chat.free(chat);
  }

  // a view joins on the chat as it is now; a terminal's device too (told
  // its name if its host's was taken)
  export function join(chat: Chat, sock: Sock): void {
    const { tab, host, computer, work } = sock.data;
    chat.socks.add(sock);
    Chat.send(sock, Chat.state(chat));
    Chat.show(chat, sock);
    Chat.send(sock, { $: "live", live: chat.live });
    if (host === null) {
      return;
    }
    const link = { send: (msg: object) => Chat.send(sock, msg), live: () => chat.socks.has(sock), computer, work };
    sock.data.device = Tools.attach(chat.tools, tab, host, sock.data.who, link);
    if (sock.data.device !== host) {
      Chat.send(sock, { $: "note", text: host + " was taken: Unii calls this computer " + sock.data.device + "." });
    }
  }

  // a socket closed; a terminal's device goes only if it quit (a link lost
  // is no quit)
  export function leave(chat: Chat, sock: Sock, quit: boolean): void {
    chat.socks.delete(sock);
    if (quit && sock.data.device !== null) {
      Tools.detach(chat.tools, sock.data.tab, sock.data.device);
    }
    Chat.free(chat);
  }

  // a view's message answered (ack): a read at once, else as Chat.apply
  // does it. A client sends it, so it may be anything (not JSON, a field
  // missing): one that fails is answered its error, as a failed act is,
  // and never ends the process, which serves other users too
  export async function answer(chat: Chat, sock: Sock, data: string): Promise<void> {
    chat.posts += 1;
    let msg: any = null;
    const out = await Promise.try(() => {
      msg = JSON.parse(data);
      return Chat.ask(chat, sock, msg) ?? Chat.apply(chat, msg, sock.data.device ?? "");
    }).catch(Chat.fail);
    chat.posts -= 1;
    Chat.send(sock, { $: "ack", id: msg?.id, ...out });
    Chat.free(chat);
  }

  // what a message or act that threw answers
  export function fail(err: any): Answer {
    return { error: String(err?.message ?? err) };
  }

  // a read, answered by what it sends; null: no read
  export function ask(chat: Chat, sock: Sock, msg: any): Answer | null {
    switch (msg.$) {
      case "zoom": {
        const [id, n] = [...msg.part].map(Number);
        if (n > 1 && Memory.part(chat.mem, id, n) !== null) {
          const parts: Part[] = [[id, n / 2], [id + n / 2, n / 2]];
          Chat.teach(chat, sock, parts);
          Chat.send(sock, { $: "zoom", id, n, parts });
        }
        return {};
      }
      case "root": {
        const parts = Memory.roots(chat.mem.count).map(({ l, i }): Part => [i * 2 ** l, 2 ** l]);
        Chat.teach(chat, sock, parts);
        Chat.send(sock, { $: "root", parts });
        return {};
      }
      case "agent": {
        const name = String(msg.name);
        const log = Memory.agent(chat.mem, name);
        Chat.send(sock, { $: "agent", name, found: log !== null });
        log?.forEach(({ kind, text, date }) => Chat.send(sock, { $: "entry", agent: name, kind, text, date }));
        Chat.send(sock, { $: "live", agent: name, live: chat.tools.agents.get(name)?.live ?? [] });
        return {};
      }
    }
    return null;
  }

  // THE apply point: every change is done here once, however often it
  // comes. An act being done, or recorded done (its record's answer, kept
  // by Cloud.act_put as the log indexes it), gets that answer; else
  // Chat.act does it, answered once on disk
  export function apply(chat: Chat, msg: any, device: string): Promise<Answer> {
    const id = String(msg.id);
    const was = chat.acts.get(id) ?? (Cloud.act_get(chat.acct, id) as Answer | null);
    if (was !== null) {
      return Promise.resolve(was);
    }
    const run = Chat.act(chat, id, msg, device).catch(Chat.fail).then(async (out) => {
      await Disk.synced();
      chat.acts.delete(id);
      return out;
    });
    chat.acts.set(id, run);
    return run;
  }

  // an act changes the chat. One that would change it again if done again
  // (a post adds again; a stop ends what runs by then) is recorded: logged
  // (Chat.mark) before any effect off the log, or as the last page of
  // what it logs; each costs credit or ends what credit started. The rest
  // set state (a pick: view.json; an import's hold: its file) or end a
  // job, so done again they change nothing, and only that state is kept,
  // written over; a stop with nothing to stop is one (so one a client
  // sends again, its answer lost, may end what runs by then)
  export async function act(chat: Chat, id: string, msg: any, device: string): Promise<Answer> {
    if ("req" in msg && BODIES.includes(msg.$)) {
      return Chat.post(chat, id, msg);
    }
    switch (msg.$) {
      case "stop": {
        const name = msg.name === undefined ? null : String(msg.name);
        const what = Chat.running(chat).filter((w) => name === null || w === name);
        const why = "Stopped by the user: " + what.join(", ") + ".";
        const turn = what.includes(TURN);
        if (what.length === 0) {
          return {};
        }
        Chat.mark(chat, id, {});
        if (turn) {
          Chat.interrupt(chat, why);
        }
        what.forEach((w) => Tools.stop(chat.tools, w));
        if (!turn) {
          Chat.note(chat, why);
        }
        return {};
      }
      case "goal": {
        const goal = msg.text === null ? null : String(msg.text);
        if (goal === chat.mem.goal) {
          return {};
        }
        chat.mem.goal = goal;
        Memory.save(chat.mem);
        chat.check?.call.stop();
        if (goal === null) {
          Chat.note(chat, "Goal halted by the user.");
        }
        return {};
      }
      case "go": {
        return Chat.go(chat, msg.on === true || msg.on === "true");
      }
      case "guess": {
        // a read: an import priced here, not by a unii older than PRICE
        let sizes = "";
        for await (const data of msg.req?.body ?? []) {
          sizes += Buffer.from(data);
          if (sizes.length > FRAME) {
            return { error: "Too large.", status: 413 };
          }
        }
        return { usd: Import.import_usd(chat.mem.count, sizes.split(",").map(Number)) };
      }
      case "pick": {
        const pick = Pick.read(msg.to, config.OFFER);
        if (pick === null) {
          return { error: "No pick " + JSON.stringify(msg.to) + "." };
        }
        chat.pick = chat.mem.pick = pick;
        Memory.save(chat.mem);
        Chat.change(chat);
        return {};
      }
      case "out": {
        Tools.done(chat.tools, device, String(msg.job), msg.out);
        return {};
      }
    }
    return { error: "No act " + msg.$ + "." };
  }

  // a post (msg.req) refused before a byte of its body is read, so a chat
  // without credit stores none: under SPARE free, 507; refused by the
  // billing, asked again after a balance read (a top-up lands there). Else
  // its body goes to a file unlinked once open, then its act is done
  export async function post(chat: Chat, id: string, msg: any): Promise<Answer> {
    const disk = fs.statfsSync(config.DIR);
    if (disk.bavail * disk.bsize < SPARE) {
      return { error: FULL, status: 507 };
    }
    const billing = Chat.cloud.billing;
    if (billing.refuse(chat.acct.user, 0) !== null) {
      await billing.balance(chat.acct.user);
    }
    const refused = billing.refuse(chat.acct.user, 0);
    if (refused !== null) {
      return refused;
    }
    const file = chat.mem.dir + "/up/" + crypto.randomUUID();
    fs.mkdirSync(chat.mem.dir + "/up", { recursive: true });
    const body = { fh: await fs.promises.open(file, "w+"), size: 0 };
    fs.rmSync(file);
    try {
      for await (const data of msg.req.body ?? []) {
        await body.fh.write(data);
        body.size += data.length;
      }
      switch (msg.$) {
        case "say": {
          return await Chat.say(chat, id, msg.sizes.split(",").filter(Boolean).map(Number), body);
        }
        case "import": {
          return await Chat.writing(chat, () => Chat.ingest(chat, id, body));
        }
        case "voice": {
          return await Chat.voice(chat, id, String(msg.type), body);
        }
      }
      return { error: "No act " + msg.$ + "." };
    } finally {
      await body.fh.close();
    }
  }

  // an act's record, a line of its own (Memory.ts)
  export function mark(chat: Chat, id: string, rec: object): void {
    Memory.log(chat.mem, "main", [{ act: id, ...rec }]);
  }

  export function eye(mem: Memory, from: number): Eye {
    const parts = Memory.before(mem.view.parts, from).map((part): Part => [Memory.span(part)[0], 2 ** part.l]);
    return { parts, from };
  }

  // what the agent saw: the eye's parts, then each message after them;
  // a running import's messages, wherever they are, as the fewest blocks
  // of the tree that hold them, built or not (a summary not built comes
  // once built: Chat.made), so no view ever gets the raw history; a block
  // opened gets its halves (zoom); they start where the tree's root
  // holding the import's first message starts, so the oldest blocks are
  // the largest, as in the tree, not grown from an unaligned start
  export function show(chat: Chat, sock: Sock): void {
    const [from, count] = [chat.eye.from, chat.mem.count];
    const [a, hi] = chat.batch === null ? [0, 0] : [chat.batch.a, chat.batch.b];
    const root = Memory.roots(count).find((part) => Memory.span(part)[1] >= a);
    const lo = root === undefined ? a : Memory.span(root)[0];
    const near = chat.eye.parts.filter(([id, n]) => id < hi && id + n > lo);
    const cover: [number, number] = [Math.min(lo, ...near.map(([id]) => id)), Math.max(hi, ...near.map(([id, n]) => id + n))];
    const eye = chat.eye.parts.filter(([id, n]) => id + n <= cover[0] || id >= cover[1]);
    const tree = Memory.roots(count).flatMap((part) => Chat.blocks(part, cover));
    const ids = (a: number, b: number) => Array.from({ length: Math.max(0, b - a) }, (_, k): Part => [a + k, 1]);
    const raw = [...ids(from, cover[0]), ...ids(Math.max(from, cover[1]), count)];
    const parts = [...eye, ...tree, ...raw].sort((x, y) => x[0] - y[0]);
    Chat.teach(chat, sock, parts);
    Chat.send(sock, { $: "view", parts, turn: from });
  }

  // the fewest blocks under a tree part that tile messages [a, b)
  export function blocks(part: { l: number; i: number }, [a, b]: [number, number]): Part[] {
    const [first, last] = Memory.span(part);
    if (last < a || first >= b) {
      return [];
    }
    if (first >= a && last < b) {
      return [[first, 2 ** part.l]];
    }
    return Memory.halves(part).flatMap((half) => Chat.blocks(half, [a, b]));
  }

  // what a view lacks of parts, before the parts themselves: each
  // message or summary a message of its own (Views); a summary not built
  // yet, once built (Chat.made)
  export function teach(chat: Chat, sock: Sock, parts: Part[]): void {
    for (const [id, n] of parts.filter(([id, n]) => !sock.data.seen.has(id + "+" + n))) {
      sock.data.seen.add(id + "+" + n);
      if (n === 1) {
        const m = Memory.message(chat.mem, id)!;
        Chat.send(sock, { $: "know", whole: { [id]: { kind: m.kind, text: m.text, date: m.date, images: m.images } } });
      }
      Chat.know(chat, sock, id, n);
    }
  }

  // a summary, if built, to a view shown its block
  export function know(chat: Chat, sock: Sock, id: number, n: number): void {
    const text = Memory.node(chat.mem, { l: Math.log2(n), i: id / n });
    if (text !== null) {
      Chat.send(sock, { $: "know", nodes: { [id + "+" + n]: { text, to: Memory.message(chat.mem, id + n - 1)!.date } } });
    }
  }

}

// Main
// ====

export namespace Main {

  // whether the supervisor ends; its workers, which this is; mails the
  // supervisor sends for it, by id, awaiting answers
  export let leaving = false;
  export let count   = 1;
  export let index   = 0;
  export const mails = new Map<string, (err: string | null) => void>();

  // a worker: its port and server; the process it took its chats from,
  // its address, and the users whose chats that one has yet to give
  // (Main.here), once it said which; the one it gives its chats to, and
  // whether it does
  export let port    = 0;
  export let server  : Bun.Server<Sock["data"]>;
  export let back    : Peer | null = null;
  export let before  = "";
  export const coming = new Map<string, PromiseWithResolvers<void>>();
  export let listed  = Promise.withResolvers<void>();
  export let next    : Peer | null = null;
  export let given   = false;
  export let onward  = "";
  // the sockets open here, by user (SOCKETS; Bun opens one inside
  // server.upgrade, so none is opened past it)
  export const sockets = new Map<string, number>();

  // this process's address (Main.listen); every line to another, and those
  // it opened to calls' origins, by address; the calls it feeds to where
  // their chats went (Main.away) and those its relays still pass on to it
  // (Main.far), by ref; each call's ref here, if fed from elsewhere
  export let addr    = "";
  export const peers  = new Set<Peer>();
  export const links  = new Map<string, Peer>();
  export const aways  = new Map<string, Away>();
  export const gates  = new Map<string, Gate>();
  export const refs   = new WeakMap<Call, string>();

  // a unix socket one process at a time listens on: one a crash left
  // refuses connections and is taken; one held is waited on
  export async function lock(): Promise<void> {
    fs.mkdirSync(config.DIR, { recursive: true });
    while (true) {
      try {
        Bun.listen({ unix: LOCK, socket: { data() {} } });
        return;
      } catch (err: any) {
        if (err.code !== "EADDRINUSE") {
          throw err;
        }
      }
      const live = await new Promise<boolean>((done) => {
        const sock = net.connect(LOCK);
        sock.on("connect", () => sock.on("close", () => done(true)));
        sock.on("error", () => done(false));
      });
      if (!live) {
        fs.rmSync(LOCK, { force: true });
      }
    }
  }

  // a site's file
  export function file(pathname: string): Response {
    const file = WEB[pathname];
    return file === undefined ? new Response("not found", { status: 404 }) : new Response(Bun.file(file));
  }


  // deletes the account of the user signed in, if they typed its name,
  // where their chat is: one the worker before still gives (a deploy) is
  // waited for, so it ends before its files go
  export async function close(req: Request): Promise<Response> {
    const cloud = Chat.cloud;
    const user = Cloud.who(cloud, req);
    const confirm = String((await req.json().catch(() => ({}))).confirm ?? "").trim().toLowerCase();
    if (user === null || confirm !== user.name.toLowerCase()) {
      const name = user === null ? "you are signed out." : "type \"" + user.name + "\".";
      const error = "Deleting your account erases your chat and Unii's memory for good" + cloud.billing.closes + ". To confirm, " + name;
      return Response.json({ error }, { status: 400 });
    }
    await Main.here(user.id);
    const owed = await cloud.billing.owing(user.id);
    if (owed !== null) {
      return Response.json({ error: owed }, { status: 409 });
    }
    Cloud.leave(cloud, user);
    const chat = Chat.chats.get(user.id);
    await (chat === undefined ? Promise.resolve() : Chat.end(chat));
    const why = await Cloud.close(cloud, user, req);
    if (why !== null) {
      return Response.json({ error: why }, { status: 409 });
    }
    fs.rmSync(config.DIR + "/users/" + user.id, { recursive: true, force: true });
    return Cloud.out();
  }

  // a long answer, sent as made, a PIECE at a time, the event loop
  // running between
  export async function* stream(lines: Iterable<string>): AsyncGenerator<string> {
    let piece = "";
    for (const line of lines) {
      piece += line;
      if (piece.length >= PIECE) {
        yield piece;
        piece = "";
        await new Promise((ok) => setImmediate(ok));
      }
    }
    yield piece;
  }

  // a page or post of the user's chat (/api/act: an act with a body, its
  // fields in the query; a POST only, since a GET is what another site
  // may send with the user's cookie, by sending their browser here, from
  // a browser that doesn't say where it comes from: Main.http)
  export async function page(chat: Chat, user: User, p: string, req: Request): Promise<Response> {
    const mem = chat.mem;
    switch (p) {
      case "/tree": {
        return new Response(Main.stream(Memory.page(mem)), { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      case "/export": {
        const name = "unii-memory-" + new Date().toISOString().slice(0, 10) + ".json";
        const json = { "content-type": "application/json", "content-disposition": 'attachment; filename="' + name + '"' };
        return new Response(Main.stream(Memory.dump(mem, await Cloud.data(Chat.cloud, user))), { headers: json });
      }
      case "/api/act": {
        if (req.method !== "POST") {
          return new Response("an act is a POST", { status: 405 });
        }
        if (!Main.spend(USERS, user.id)) {
          return Response.json({ error: "Too many requests: wait a moment." }, { status: 429 });
        }
        const msg = { ...Object.fromEntries(new URL(req.url).searchParams), req };
        const out = await Chat.apply(chat, msg, "");
        return Response.json(out, { status: out.status ?? (out.error === undefined ? 200 : 400) });
      }
      case "/api/imported": {
        return Response.json(Chat.done(chat));
      }
    }
    const file = Memory.image_file(mem, p.slice("/image/".length));
    const keep = { "cache-control": "private, max-age=31536000, immutable" };
    return file === null ? new Response("not found", { status: 404 }) : new Response(Bun.file(file), { headers: keep });
  }

  // a request; one for a chat this process gave away goes there. Another
  // site's page (its browser says so: Sec-Fetch-Site) only links here: it
  // posts nothing, reaches no /api/ and opens no socket, so no site acts
  // for its visitors, signed in or not (sends a message, signs them out,
  // asks sign-in mail from their networks)
  // an answer of a process giving its chats away closes its connection,
  // so no client (Caddy, another worker's Main.pass) keeps one to reuse as
  // the process ends
  export async function reply(req: Request, server: Bun.Server<Sock["data"]>): Promise<Response | undefined> {
    const res = await Main.http(req, server);
    if (res === undefined || !Main.given) {
      return res;
    }
    const headers = new Headers(res.headers);
    headers.set("connection", "close");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }

  export async function http(req: Request, server: Bun.Server<Sock["data"]>): Promise<Response | undefined> {
    const p = new URL(req.url).pathname;
    const cloud = Chat.cloud;
    const away = /^(cross|same)-site$/.test(req.headers.get("sec-fetch-site") ?? "");
    if (away && (req.method !== "GET" || p.startsWith("/api/") || p === "/ws")) {
      return new Response("not from another site", { status: 403 });
    }
    try {
      const user = Cloud.who(cloud, req);
      if (user !== null && Main.shard(user.id) !== Main.index) {
        return new Response("this user's worker is another", { status: 421 });
      }
      const api = await Cloud.http(cloud, req);
      if (api !== null) {
        return api;
      }
      if (p === "/api/hello") {
        return Response.json({ hello: HELLO, bills: cloud.billing.bills, github: cloud.billing.github !== null });
      }
      if (p === "/api/delete") {
        return await Main.close(req);
      }
      if (!OWN.includes(p) && !p.startsWith("/image/") && !p.startsWith("/api/")) {
        return Main.file(p);
      }
      if (user === null) {
        return new Response("sign in first", { status: 401 });
      }
      await Main.here(user.id);
      if (p === "/ws") {
        if ((Main.sockets.get(user.id) ?? 0) >= SOCKETS || !Main.spend(USERS, user.id)) {
          return new Response("too many requests", { status: 429 });
        }
        const q    = new URL(req.url).searchParams;
        const who  = Cloud.hash(Cloud.token(req));
        const work = q.get("work") ?? "~/.unii/work";
        const data = { user, who, tab: q.get("tab") ?? "", wire: q.get("wire"), host: q.get("device"), computer: q.get("computer") === "1", work, device: null, seen: new Set<string>() };
        return server.upgrade(req, { data }) ? undefined : new Response("upgrade failed", { status: 400 });
      }
      const chat = Chat.open(user);
      if (chat === null) {
        return await Main.pass(req);
      }
      chat.posts += 1;
      const res = await Main.page(chat, user, p, req).finally(() => (chat.posts -= 1));
      Chat.free(chat);
      return res;
    } catch (err: any) {
      return Response.json({ error: err.message }, { status: 500 });
    }
  }

  // work one user or peer asks (a socket opened or closed, a chat woken,
  // a message of the process before or after): one that throws (a chat
  // that fails to load or show) fails alone, logged, then `fail`, never
  // the worker, which serves other users too, nor the work that came
  // with it (a view's message fails alone too: Chat.answer)
  export function event(what: string, run: () => void, fail: () => void = () => {}): void {
    try {
      run();
    } catch (err: any) {
      console.error("unii: " + what + " failed: " + (err?.stack ?? err));
      fail();
    }
  }

  // whether `key` may spend n more of its limit; one refused spends
  // nothing
  export function spend(limit: Limit, key: string, n = 1): boolean {
    const now = performance.now();
    const q = limit.keys.get(key) ?? { n: limit.most, at: now };
    q.n = Math.min(limit.most, q.n + ((now - q.at) * limit.rate) / 1000);
    q.at = now;
    limit.keys.set(key, q);
    if (q.n < n) {
      return false;
    }
    q.n -= n;
    return true;
  }

  // a key whose quota grew full again is as one never seen: dropped, so
  // a limit holds only the keys near it, not every one it ever saw
  export function forget(limit: Limit): void {
    const full = (limit.most / limit.rate) * 1000;
    setInterval(() => limit.keys.forEach((q, key) => performance.now() - q.at > full && limit.keys.delete(key)), full);
  }

  // a user's sockets here, n more (n < 0: fewer); none: dropped
  export function opened(user: string, n: number): void {
    const open = (Main.sockets.get(user) ?? 0) + n;
    if (open === 0) {
      Main.sockets.delete(user);
    } else {
      Main.sockets.set(user, open);
    }
  }

  // the worker of a user (signed out: of a token)
  export function shard(key: string): number {
    return Bun.hash.crc32(key) % Main.count;
  }

  // a worker, alone or of a supervisor (whose word, over IPC, wakes a
  // terminal signed in elsewhere, and answers a mail it sent): it takes
  // the chats of the one it follows, if any, then serves beside it on
  // the same port
  export async function start(port: number): Promise<void> {
    const send = process.send?.bind(process);
    const change = (user: string) => {
      const chat = Chat.chats.get(user);
      if (chat !== undefined) {
        Chat.change(chat);
      }
    };
    const signed = (session: string) => (send === undefined ? Cloud.wake(Chat.cloud, session) : send({ $: "signed", session }));
    const post = (mail: object) => (send === undefined ? Mail.send(config.KEYS.resend, mail) : Main.mail(send, mail));
    const hand = HAND + Main.index;
    Main.port = port;
    Chat.cloud = Cloud.open(change, signed, post);
    Main.back = await Main.dial(hand);
    if (Main.back === null) {
      Main.listed.resolve();
      Chat.wake();
    }
    Tools.coming(Main.arrived());
    Chat.cloud.billing.start(Main.index, (user) => Main.shard(user) === Main.index, Chat.chats);
    Main.forget(USERS);
    process.on("message", Main.heard);
    process.on("disconnect", () => process.exit(0));
    process.on("unhandledRejection", Main.unowned);
    Main.server = Bun.serve<Sock["data"]>({
      port               : port,
      hostname           : "127.0.0.1",
      reusePort          : true,
      idleTimeout        : 0,
      maxRequestBodySize : Infinity,
      fetch              : Main.reply,
      websocket          : {
        maxPayloadLength         : FRAME,
        backpressureLimit        : BUFFER,
        closeOnBackpressureLimit : true,
        idleTimeout              : PING / 1000,
        open(ws: Sock) {
          Main.opened(ws.data.user.id, 1);
          Main.event("a socket of user " + ws.data.user.id, () => {
            if (ws.data.wire !== String(WIRE)) {
              ws.send(JSON.stringify({ $: "error", text: "This page or unii is older than the server: reload or reopen it (`unii update` for the latest)." }));
              return;
            }
            const chat = Chat.open(ws.data.user);
            if (chat === null) {
              ws.close(MOVE);
            } else {
              Chat.join(chat, ws);
            }
          }, () => ws.close(1011));
        },
        message(ws: Sock, data) {
          const chat = Chat.chats.get(ws.data.user.id);
          if (chat === undefined || !chat.socks.has(ws)) {
            return;
          }
          if (Main.spend(USERS, chat.acct.user, 1 + data.length / UNIT)) {
            Chat.answer(chat, ws, String(data));
          } else {
            ws.close(FLOOD);
          }
        },
        close(ws: Sock, code) {
          Main.opened(ws.data.user.id, -1);
          Main.event("a socket of user " + ws.data.user.id, () => {
            const chat = Chat.chats.get(ws.data.user.id);
            if (chat !== undefined) {
              Chat.leave(chat, ws, code === QUIT);
            }
          });
        },
      },
    });
    setInterval(() => {
      for (const chat of Chat.chats.values()) {
        chat.socks.forEach((sock) => sock.send(TICK));
      }
    }, PING / 2);
    for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
      process.on(sig, () => process.exit(0));
    }
    process.on("exit", () => {
      fs.rmSync(Main.addr, { force: true });
      for (const chat of Chat.chats.values()) {
        Chat.stop(chat, null);
        Memory.stop(chat.mem);
      }
    });
    console.log("unii: " + config.SITE + ", users in " + config.DIR + "/users, worker " + Main.index + " of " + Main.count + " on 127.0.0.1:" + port);
    send?.({ $: "ready" });
    Main.back?.send({ $: "go", tools: Tools.base() });
    Main.listen(hand);
  }

  // a mail, sent by the supervisor: its answer
  export function mail(send: (msg: object) => void, mail: object): Promise<string | null> {
    const id = crypto.randomUUID();
    send({ $: "mail", id, mail });
    return new Promise((done) => Main.mails.set(id, done));
  }

  // a failure no owner took: every background promise has one that ends
  // it (a chat's note, a log line), so this is a bug, logged, never the
  // end of the worker and every chat it holds
  export function unowned(err: unknown): void {
    console.error("unii: a failure no one owned: " + ((err as any)?.stack ?? err));
  }

  // a worker hears its supervisor
  export function heard(msg: any): void {
    switch (msg.$) {
      case "signed": {
        Cloud.wake(Chat.cloud, String(msg.session));
        return;
      }
      case "mailed": {
        Main.mails.get(msg.id)?.(msg.err);
        Main.mails.delete(msg.id);
        return;
      }
    }
  }

  // Handover
  // --------
  // Worker k's successor reaches it at HAND + k (which leads to the
  // newest's own address: Main.listen), says go (its tools' URL), then
  // listens for its own (a successor that dies before that leaves this
  // one serving, reachable again). This one stops serving (its watch
  // too), says its address, which chats it holds and which still come to
  // it (a deploy during a deploy: the one before gives a chat only at
  // rest, after a long post), and gives each on as it can (Chat.give),
  // those coming once they come. A call goes on in the process that
  // started it, fed straight to its chat's process (Main.away, Main.far),
  // so one that passed calls on ends once their origins feed the next.
  // A process ends once nothing is left to come, run, pass
  // on or pay (Main.done).

  // the worker before this one, if one listens at `hand`
  export function dial(hand: string): Promise<Peer | null> {
    return new Promise((done) => {
      const sock = net.connect(hand);
      sock.once("connect", () => done(Main.peer(sock)));
      sock.once("error", () => done(null));
    });
  }

  // this process's address, `hand` and its pid, which any process may
  // reach (a call's new process: Main.far); once it listens, `hand`
  // leads to it, so the next worker k reaches this one
  export function listen(hand: string): void {
    const temp = hand + ".link";
    Main.addr = hand + "." + process.pid;
    fs.rmSync(Main.addr, { force: true });
    net.createServer((sock) => Main.peer(sock)).listen(Main.addr, () => {
      fs.rmSync(temp, { force: true });
      fs.symlinkSync(Main.addr, temp);
      fs.renameSync(temp, hand);
    });
  }

  // a peer over a socket, a line of JSON a message, each heard alone
  // (Main.event): one that fails (a chat moved here that won't open) is
  // logged, and the rest of the read (the chats moved after it) goes on
  export function peer(sock: net.Socket): Peer {
    const peer: Peer = { send: (msg) => sock.write(JSON.stringify(msg) + "\n"), end: (then) => (sock.destroyed ? then() : sock.end(then)), asks: new Map(), feeds: new Map(), grants: new Map() };
    let rest = "";
    Main.peers.add(peer);
    sock.setEncoding("utf8");
    sock.on("data", (data: string) => {
      const lines = (rest + data).split("\n");
      rest = lines.pop()!;
      lines.forEach((line) => Main.event("a message of another worker", () => Main.told(peer, JSON.parse(line))));
    });
    sock.on("error", () => {});
    sock.on("close", () => Main.lost(peer));
    return peer;
  }

  // the process at `addr` (a call's origin: Main.far), by one line
  export function link(addr: string): Peer {
    const known = Main.links.get(addr);
    if (known !== undefined) {
      return known;
    }
    const peer = Main.peer(net.connect(addr));
    Main.links.set(addr, peer);
    return peer;
  }

  // a peer's message; a chat moved here frees its user's requests first,
  // so one that won't open is opened by them anew, as after a restart
  // (Chat.open: it was never kept half open). What a call's origin sends
  // while its relay still passes on is held (Main.far)
  export function told(peer: Peer, msg: any): void {
    const gate = Main.gates.get(msg.call);
    if (gate?.origin === peer) {
      gate.held.push(msg);
      return;
    }
    switch (msg.$) {
      case "go": {
        if (Main.next !== null) {
          return peer.end(() => {});
        }
        Main.next = peer;
        Main.server.stop();
        Main.given = true;
        Main.onward = msg.tools;
        Main.listed.promise.then(() => {
          peer.send({ $: "users", addr: Main.addr, users: [...Chat.chats.keys(), ...Main.coming.keys()] });
          [...Chat.chats.values()].forEach((chat) => Chat.give(chat, peer, msg.tools));
          Main.done();
        }).catch((err) => console.error("unii: giving the chats failed: " + (err?.stack ?? err)));
        return;
      }
      case "users": {
        Main.before = msg.addr ?? "";
        (msg.users as string[]).forEach((user) => Main.coming.set(user, Promise.withResolvers()));
        Main.listed.resolve();
        return;
      }
      case "chat": {
        const moved: Moved = msg.moved;
        Main.coming.get(moved.user)?.resolve();
        Main.coming.delete(moved.user);
        if (moved.credit !== undefined) {
          Chat.cloud.billing.credit.set(moved.user, moved.credit);
        }
        const chat = Chat.open({ id: moved.user, name: "" }, moved, peer);
        if (chat !== null && Main.given) {
          Chat.give(chat, Main.next!, Main.onward);
        }
        Main.done();
        return;
      }
      case "ev": {
        peer.feeds.get(msg.call)?.on(msg.ev);
        return;
      }
      case "end": {
        peer.feeds.get(msg.call)?.end(msg.end);
        peer.feeds.delete(msg.call);
        gate?.origin.feeds.delete(msg.call);
        Main.gates.delete(msg.call);
        return;
      }
      case "take": {
        Tools.went(msg.key, msg.tools);
        const away = Main.aways.get(msg.call);
        if (away !== undefined) {
          away.link.send({ $: "gone", call: msg.call });
          away.link = peer;
        }
        return;
      }
      case "gone": {
        if (gate !== undefined) {
          return Main.open(msg.call, gate);
        }
        peer.feeds.delete(msg.call);
        Main.aways.get(msg.call)?.link.send(msg);
        Main.aways.delete(msg.call);
        Main.done();
        return;
      }
      case "send": {
        Main.aways.get(msg.call)?.call.send(msg.say);
        return;
      }
      case "stop": {
        Main.aways.get(msg.call)?.call.stop();
        return;
      }
      case "book": {
        const bill = peer.feeds.get(msg.call)?.bill ?? (async () => "its call ended");
        bill({ input: msg.input, token: msg.token, exact: null }, msg.cap).then((grant) => {
          if (typeof grant !== "string") {
            peer.grants.set(msg.req, grant);
          }
          peer.send(typeof grant === "string" ? { $: "grant", req: msg.req, why: grant } : { $: "grant", req: msg.req, max: grant.max, cut: grant.cut });
        }).catch((err) => console.error("book " + msg.req + ": " + (err?.message ?? err)));
        return;
      }
      case "grant": {
        const end = (used: object | null) => peer.send({ $: "paid", req: msg.req, used });
        peer.asks.get(msg.req)?.(msg.why ?? { max: msg.max, cut: msg.cut, end });
        peer.asks.delete(msg.req);
        Main.done();
        return;
      }
      case "paid": {
        peer.grants.get(msg.req)?.end(msg.used);
        peer.grants.delete(msg.req);
        Main.done();
        return;
      }
    }
  }

  // a call moved with its chat to `peer`'s process: what it sends, pays
  // and ends goes where the chat is, by its ref: this process's address
  // and an id, or, fed here from further back, its own, passed on till
  // its origin feeds the chat's process itself (gone); a request it books
  // there goes with its input exact (Cost: a count can't go). One that
  // started here is woken (one parked asks once more) and cut once it
  // waits for a usage limit, its end told so (End.cut), so it goes on
  // where the chat is and no process waits on running old code
  export function away(peer: Peer, call: Call): string {
    const own = !Main.refs.has(call);
    const ref = Main.refs.get(call) ?? Main.addr + "#" + crypto.randomUUID();
    const away: Away = { call, link: peer };
    let cut = false;
    const on = (ev: Event) => {
      if (own && !cut && ev.$ === "Limit" && ev.limit !== null) {
        cut = true;
        call.stop();
      }
      if (!cut) {
        away.link.send({ $: "ev", call: ref, ev });
      }
    };
    const bill: Bill = async (cost, cap) => {
      const { input, token } = cost.exact === null ? cost : await cost.exact();
      const req = crypto.randomUUID();
      const link = away.link;
      link.send({ $: "book", call: ref, req, input, token, cap });
      return new Promise((done) => link.asks.set(req, done));
    };
    const end = (end: End) => {
      Main.aways.delete(ref);
      away.link.send({ $: "end", call: ref, end: cut ? { ...end, cut } : end });
      Main.done();
    };
    Main.aways.set(ref, away);
    call.move({ on, bill, end });
    if (own) {
      call.wake();
    }
    return ref;
  }

  // the call `ref` running elsewhere for a chat moved here from `back`: fed by
  // `back` if it runs there, else by its origin, asked to (take; its MCP
  // requests for the chat `key` then come straight here: Tools.went), what that
  // sends held till `back` passed on all that reached it (gone)
  export function far(back: Peer, ref: string, key: string, on: (ev: Event) => void, bill?: Bill): Call {
    const at = ref.slice(0, Math.max(0, ref.lastIndexOf("#")));
    const origin = at === Main.before ? back : Main.link(at);
    const send = (say: Say) => origin.send({ $: "send", call: ref, say });
    const [call, feed] = AskAI.tie(on, bill, send, () => origin.send({ $: "stop", call: ref }));
    back.feeds.set(ref, feed);
    origin.feeds.set(ref, feed);
    if (origin !== back) {
      Main.gates.set(ref, { relay: back, origin, held: [], lost: false });
      origin.send({ $: "take", call: ref, key, tools: Tools.base() });
    }
    Main.refs.set(call, ref);
    return call;
  }

  // a call's relay passed on all that reached it: what its origin sent
  // since goes on, then the end its lost line meant
  export function open(ref: string, gate: Gate): void {
    Main.gates.delete(ref);
    gate.relay.feeds.delete(ref);
    gate.held.forEach((msg) => Main.told(gate.origin, msg));
    if (gate.lost) {
      gate.origin.feeds.get(ref)?.end(AskAI.end(ENDED));
      gate.origin.feeds.delete(ref);
    }
  }

  // once it gave all its chats and nothing it runs, passes on or pays for
  // them is left, this process ends, its last requests answered
  // (Main.leave)
  export function done(): void {
    const paying = [...Main.peers].some((peer) => peer.asks.size > 0 || peer.grants.size > 0);
    if (Main.given && Chat.chats.size === 0 && Main.coming.size === 0 && Main.aways.size === 0 && !paying) {
      Main.leave();
    }
  }

  // ends once no request is under way, to it or from it (a model's answer
  // read on to be billed: Agent.READING), and all told to other processes
  // is out (an exit drops what a socket still holds: a call's end, its
  // payment; on macOS all past 8 KB); Bun's server.stop() promise would
  // say so of the first, but never resolves once a WebSocket was open
  // (Bun 1.3.14), so the counts are read again each LEAVE ms
  export function leave(): void {
    if (Main.server.pendingRequests === 0 && READING.n === 0) {
      Promise.all([...Main.peers].map((peer) => new Promise<void>((ok) => peer.end(ok)))).then(() => process.exit(0));
      return;
    }
    setTimeout(Main.leave, LEAVE);
  }

  // a line lost: if calls were fed over it from here, or it was the next
  // one's with chats still given it, that process crashed, and this one
  // ends too (the next start resumes all). Else the calls fed over it end
  // (a call's origin crashed; one its relay still passes on ends as that
  // says), and what it asked or let through for payment; the one before
  // frees what waits on it, and this one ends as it was to (Main.leave)
  export function lost(peer: Peer): void {
    Main.peers.delete(peer);
    Main.links.forEach((link, at) => link === peer && Main.links.delete(at));
    const fed = [...Main.aways.values()].some((away) => away.link === peer);
    if (fed || (peer === Main.next && (Chat.chats.size > 0 || Main.coming.size > 0))) {
      process.exit(1);
    }
    if (peer === Main.back) {
      Main.listed.resolve();
      Main.coming.forEach((c) => c.resolve());
      Main.coming.clear();
    }
    for (const [ref, feed] of peer.feeds) {
      const gate = Main.gates.get(ref);
      if (gate?.origin === peer) {
        gate.lost = true;
        continue;
      }
      gate?.origin.feeds.delete(ref);
      Main.gates.delete(ref);
      feed.end(AskAI.end(ENDED));
    }
    peer.asks.forEach((ask) => ask(ENDED));
    peer.grants.forEach((grant) => grant.end(null));
    Main.done();
  }

  // a request for a chat this process gave away, sent where it went
  // (the only one on this port since)
  export function pass(req: Request): Promise<Response> {
    const url = new URL(req.url);
    return fetch("http://127.0.0.1:" + Main.port + url.pathname + url.search, { method: req.method, headers: req.headers, body: req.body, redirect: "manual" });
  }

  // once the chat of `user` the worker before gives is here
  export async function here(user: string): Promise<void> {
    await Main.listed.promise;
    await Main.coming.get(user)?.promise;
  }

  // once all it gives are
  export async function arrived(): Promise<void> {
    await Main.listed.promise;
    await Promise.all([...Main.coming.values()].map((c) => c.promise));
  }

  // the workers' supervisor (run: what starts one, on port+1+k,
  // UNII_WORKER=k): holds the lock, starts again a worker that dies,
  // answers each request with its worker's address (`x-unii-worker`:
  // README; past its network's limit, NETS, 429), relays a worker's word
  // to all, sends their mail. A deploy (SIGHUP) starts each worker anew,
  // which takes the chats of the one before (Main.start); one that fails
  // to start leaves that one serving. Its own code changes only on a
  // restart
  export function supervise(port: number, run: string[]): void {
    const cloud = Cloud.open(() => {}, () => {}, async () => null);
    const workers: Bun.Subprocess[] = [];
    const all = new Set<Bun.Subprocess>();
    const hear = (k: number, proc: Bun.Subprocess, msg: any) => {
      switch (msg.$) {
        case "ready": {
          workers[k] = proc;
          return;
        }
        case "signed": {
          all.forEach((w) => w.send(msg));
          return;
        }
        case "mail": {
          Mail.send(config.KEYS.resend, msg.mail).then((err) => proc.send({ $: "mailed", id: msg.id, err })).catch(() => {});
          return;
        }
      }
    };
    const start = (k: number) => {
      const env = { ...config.config_env(), UNII_WORKER: String(k), BUN_CONFIG_MAX_HTTP_REQUESTS: String(FETCHES) };
      const ipc = (msg: any, proc: Bun.Subprocess) => hear(k, proc, msg);
      const proc = Bun.spawn([...run, String(port + 1 + k)], { env, ipc, stdio: ["ignore", "inherit", "inherit"] });
      all.add(proc);
      proc.exited.then((code) => {
        all.delete(proc);
        Main.died(k, code, workers[k], proc, () => start(k));
      });
    };
    Array.from({ length: config.WORKERS }, (_, k) => start(k));
    Main.forget(NETS);
    Bun.serve({
      port     : port,
      hostname : "127.0.0.1",
      fetch    : (req) => {
        if (!Main.spend(NETS, Cloud.net(Cloud.ip(req) ?? ""))) {
          return new Response("too many requests", { status: 429 });
        }
        const user = Cloud.who(cloud, req);
        const k = Main.shard(user?.id ?? Cloud.token(req));
        return new Response(null, { headers: { "x-unii-worker": "127.0.0.1:" + (port + 1 + k) } });
      },
    });
    const stop = () => {
      Main.leaving = true;
      all.forEach((w) => w.kill());
      Promise.all([...all].map((w) => w.exited)).then(() => process.exit(0));
    };
    for (const sig of ["SIGTERM", "SIGINT"]) {
      process.on(sig, stop);
    }
    process.on("SIGHUP", () => workers.forEach((_, k) => start(k)));
    console.log("unii: " + config.SITE + ", " + config.WORKERS + " workers on 127.0.0.1:" + (port + 1) + "-" + (port + config.WORKERS) + ", routes on " + port);
  }

  // a worker ended (`now`: worker k's, the last that started): as the
  // server ends, nothing; one after a deploy (another is now) too; worker
  // k's again; one that never started (none is), the server ends
  export function died(k: number, code: number | null, now: Bun.Subprocess | undefined, proc: Bun.Subprocess, again: () => void): void {
    if (code !== 0) {
      console.error("unii: worker " + k + " ended (" + code + ")");
    }
    if (Main.leaving || (now !== undefined && now !== proc)) {
      return;
    }
    if (now === undefined) {
      process.exit(1);
    }
    again();
  }

}

// run: the command that starts this server again, to start a worker
// (null: the server is one process: no workers, or `unii serve`)
export async function serve(port: number, run: string[] | null): Promise<void> {
  const worker = process.env.UNII_WORKER;
  Main.count = run === null ? 1 : config.WORKERS;
  Main.index = Number(worker ?? 0);
  if (worker === undefined) {
    await Main.lock();
  }
  if (worker === undefined && run !== null) {
    Main.supervise(port, run);
  } else {
    await Main.start(port);
  }
}

if (import.meta.main) {
  await serve(Number(process.argv[2] ?? 8788), config.WORKERS > 0 ? [process.execPath, import.meta.path] : null);
}
