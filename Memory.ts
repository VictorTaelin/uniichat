// Memory
// ======
// The chat, kept forever, and the view of it every call sees. Sizes are
// bytes of UTF-8. A message is logged in pages (Clip.ts CAP chars, PICS
// images).
//
// Over the messages grows a binary tree: node (0,i) is message i
// (or the line it was logged with) in at most NODE bytes, node (l,i)
// merges (l-1,2i) and (l-1,2i+1). A source that fits is its node; else a
// compaction writes it: a call like a turn, on the config's COMPACTOR,
// with its own system prompt (`share`, Server.ts), no tools, and its
// own view (`seen`) up to the node's `ctx`; a line too long is asked
// anew (build). The call asks till it is answered (AskAI patient: an
// outage only delays a node, never harms it); answered with no line (a
// refusal: its input's doing), its node is its source clipped. Every
// node builds so, an imported one too; the import's are a side of their
// own (`side`: the chat's turns don't wait on them). A side is held as
// the user's credit says (its payer refusing a call holds it:
// Billing.ts), an import's also as its user does (`hold`; a pause cuts
// its calls): its nodes wait, with no call, till it goes on, and a turn
// needing the chat's is told why (settle), never left waiting. Of each
// side, JOBS build at once, in the order the messages came. A try cut
// after a line keeps the best one. A chat
// moving to another process (a deploy) takes its summaries along, their
// calls going on where they began (give, take): none is cut or asked
// again.
//
// A view lists nodes covering the chat to its end, oldest first; each message
// it reaches appends its node. Past `high` bytes, a batch merges the adjacent
// siblings whose parent is built and most due (oldest since its last message,
// to the view's end, in halves: detail fades with age) down to half, so a view
// changes only at its end between batches. Two, each on its own: the chat's
// (turns'), to the last message, and the compactions', to the first not built
// of the sides that build. A call gets one in BLOCK-line blocks, the last whole
// one marked for the cache (AskAI.ts); few lines, as those past it are read
// anew (a compaction's view ends at its node, then its task, both unmarked).
//
// Files: main/ (messages) and tree/ (nodes), JSON lines in a file per
// day, flushed (Disk.ts); main.index and tree.index give each line's
// place by slot; view.json keeps the view, the chat's pick and goal,
// written over. main/ is also the act log: an act recorded (Server.ts Chat.act)
// is done once its record is, a line naming it (`act`; its answer
// `ans`; an older one's `pick` is in view.json too): the last page of
// what it logs, or a line of its own. Each record indexed (as logged, or
// as a load indexes what a crash left) goes to `acted`, the server's
// store of acts done. Pages `more` after the last that isn't are not in
// the chat.
// Memory holds only the view's nodes and those built above them; any
// other line is read by its index. Images are in docs/images/ by their
// hash; an agent's log in docs/agent/<Name>.jsonl.

import * as fs from "node:fs";
import { AskAI, type Ask, type Bill, type Block, type Call, type Img, type Kind, type Pay, type Say, type Served } from "./AskAI.ts";
import { clip_page, clip_pages } from "./Clip.ts";
import * as config from "./Config.ts";
import { Disk } from "./Disk.ts";
import { Pick } from "./Pick.ts";
import * as names from "./Names.ts";
import { image_kind } from "./View.ts";

// Types
// =====

// a message (a page): its index, kind, text, size, date, images, whether
// imported, its node (if written with it), whether it is logged as one
// with the next, the act it records
type Root = Msg & { i: number; size: number; date: string };

// a message to log: a Root but its index and size; no date: now
export type Msg = { kind: Kind; text: string; date?: string; images?: string[]; imported?: boolean; line?: string; more?: boolean; act?: string };

// node (l,i), as a line of a view
type Part = { l: number; i: number };

// a view: its lines, the bytes of those built, a batch under way, the
// bytes past which it merges to half
type View = { parts: Part[]; size: number; batch: boolean; high: number };

// a summary running: its node, what it serves
type Sum = Part & { kind: Served };

// a summary running as its chat moved (Memory.give): its node, its call's id
export type Given = [number, number, string];

// what a compaction's call starts with, as a turn's does: all but the
// blocks (its own system prompt: Server.ts share)
export type Share = Omit<Ask, "blocks">;

// a log: of messages (main) or of nodes (tree)
type Stream = "main" | "tree";

// how far a log is indexed: its last file's day (since 1970), size
type End = [number, number];

// a view in view.json
type Kept = { parts: Array<[number, number]>; batch: boolean };

// view.json: the chat's view, the compactions' (none: the chat's)
type Saved = Kept & { seen?: Kept; main: End; tree: End; pick: object | null; goal?: string | null; work?: string[] };

// fds: files read lately, open, oldest first; count: the pages logged
// whole; open: those after, not whole yet; pick: the chat's, as last set;
// goal: the user's (/goal; null: none), till met or halted (Server.ts);
// work: what ran, as last saved; nodes: the texts of the views' nodes
// built and of those above them, by slot; agents: their logs' lengths;
// view: the chat's view; seen: the compactions'; ready: the nodes not
// built whose halves are, by side and level, in order; ends: how far
// each log is indexed; busy: nodes building, by slot, with their side;
// sides: the side by the last message of nodes not built; calls: those
// building's calls; hold: why each side is held (null: it builds);
// wait: checks run as the views change; share: what
// compactions' calls start with; pay: what pays them (none:
// free); made, acted: told of each node built, of each act indexed
export type Memory = {
  dir    : string;
  fds    : Map<string, number>;
  count  : number;
  open   : number;
  pick   : object | null;
  goal   : string | null;
  work   : string[];
  nodes  : Map<number, string>;
  agents : Map<string, number>;
  view   : View;
  seen   : View;
  ready  : number[][][];
  ends   : Record<Stream, End>;
  busy   : Map<number, number>;
  sides  : Map<number, number>;
  calls  : Map<Call, Sum>;
  hold   : Array<string | null>;
  done   : boolean;
  wait   : Set<() => void>;
  share  : () => Share;
  pay?   : Pay;
  made?  : (l: number, i: number) => void;
  acted  : (id: string, ans: object) => void;
};

// Constants
// =========

const NODE  = 512;
export const JOBS = 64;
const TRIES = 5;
// a view past its `high` merges to half: the chat's 64-128 KB (96 KB on
// average), the compactions' 16-32 KB (24 KB)
const HIGH  = 128000;
const SEEN  = 32000;
const BLOCK = 4;
const SLOT  = 16;
const DAY   = 864e5;

// the files a chat keeps open to read: its two indexes and the day files
// read lately (mostly its last days), so a chat however old holds a few
const FDS   = 8;

// Anthropic takes 32 MB a request, 20 images at full size: 20 of IMAGE
// bytes, in base64; PIXELS, the most decoded: a larger image goes as is
const PICS   = 20;
const FIT    = 1568;
const IMAGE  = 2 ** 20;
const PIXELS = 2 ** 28;

// what an image's hash takes between turns of the event loop
const PIECE = 2 ** 20;

// a ruler, not a sample line: the compactor copied a sample's content
const SCALE = "-".repeat(NODE);

const WAIT = "(not summarized yet: zoom it)";

const IMAGES = "/docs/images/";

const AGENTS = "/docs/agent/";

// a compaction's task, before its <input>: one message to compress
// (level 0), or two lines to merge
const LEAF = `Compaction: compress message {id} into one line of at most ${NODE} bytes
(about 70 words), the length of this ruler:
${SCALE}
<input>
`;

const MERGE = `Compaction: merge lines {a} and {b}, adjacent, into one line of at most
${NODE} bytes (about 70 words), the length of this ruler:
${SCALE}
<chat> may hold their messages, {id} to {end}, in more detail: take details
of them from there too.
<input>
`;

// Memory
// ======

export namespace Memory {

  export function load(dir: string, share: Memory["share"], acted: Memory["acted"] = () => {}): Memory {
    const mem: Memory = {
      dir, fds: new Map(), count: 0, open: 0, pick: null, goal: null, work: [], nodes: new Map(), agents: new Map(), ready: [[], []], ends: { main: [0, 0], tree: [0, 0] },
      view: { parts: [], size: 0, batch: false, high: HIGH }, seen: { parts: [], size: 0, batch: false, high: SEEN },
      busy: new Map(), sides: new Map(), calls: new Map(), hold: [null, "paused"], done: false, wait: new Set(), share, acted,
    };
    const saved = Memory.saved(dir);
    mem.pick = saved?.pick ?? null;
    mem.goal = saved?.goal ?? null;
    mem.work = saved?.work ?? [];
    mem.ends.main = Memory.index(mem, "main", saved?.main ?? [0, 0]);
    mem.ends.tree = Memory.index(mem, "tree", saved?.tree ?? [0, 0]);
    mem.count = fs.statSync(dir + "/main.index").size / SLOT;
    while (Memory.message(mem, mem.count - 1)?.more) {
      mem.count -= 1;
    }
    Memory.open(mem, mem.view, saved);
    Memory.open(mem, mem.seen, saved?.seen ?? saved);
    Memory.roots(mem.count).flatMap((part) => Memory.todo(mem, part)).forEach((part) => Memory.ready(mem, part, true));
    Memory.fit(mem);
    Memory.save(mem);
    return mem;
  }

  // view.json; null: none, or unreadable
  export function saved(dir: string): Saved | null {
    try {
      return JSON.parse(fs.readFileSync(dir + "/view.json", "utf8"));
    } catch {
      return null;
    }
  }

  // a view as kept (none: the highest nodes built)
  export function open(mem: Memory, view: View, kept: Kept | null): void {
    const keys = kept === null ? null : new Set(kept.parts.map(([l, i]) => Memory.slot(l, i)));
    view.parts = Memory.roots(mem.count).flatMap((part) => Memory.down(mem, part, keys));
    view.size = view.parts.reduce((n, part) => n + Memory.size(mem, part), 0);
    view.batch = kept?.batch ?? false;
  }

  // written whole, then moved in place; flushed soon (Disk.ts)
  export function save(mem: Memory): void {
    const file = mem.dir + "/view.json";
    const [chat, seen] = [mem.view, mem.seen].map((view): Kept => ({ parts: view.parts.map((part) => [part.l, part.i]), batch: view.batch }));
    fs.writeFileSync(file + ".new", JSON.stringify({ ...chat, seen, pick: mem.pick, goal: mem.goal, work: mem.work, ...mem.ends }));
    fs.renameSync(file + ".new", file);
    Disk.wrote(file);
  }

  // indexes the log's lines past `from` (none, or no index: all, in an
  // index made anew); answers how far
  export function index(mem: Memory, stream: Stream, from: End): End {
    const file = mem.dir + "/" + stream + ".index";
    let end: End = fs.existsSync(file) ? from : [0, 0];
    fs.mkdirSync(mem.dir + "/" + stream, { recursive: true });
    const fd = fs.openSync(file, end[0] === 0 ? "w+" : "r+");
    const days = fs.readdirSync(mem.dir + "/" + stream).map((f) => Date.parse(f.slice(0, 10)) / DAY);
    try {
      for (const day of days.filter((day) => day >= end[0]).sort((a, b) => a - b)) {
        end = [day, Memory.scan(mem, stream, day, day === end[0] ? end[1] : 0, fd)];
      }
    } finally {
      fs.closeSync(fd);
    }
    return end;
  }

  // indexes, into fd, the lines of a day's file from byte `at`; answers
  // the file's end. A line a crash cut short is skipped
  export function scan(mem: Memory, stream: Stream, day: number, at: number, fd: number): number {
    const file = Memory.path(mem, stream, day);
    const data = Memory.slice(file, at, fs.statSync(file).size - at);
    let k = 0;
    for (let nl = data.indexOf(10); nl >= 0; nl = data.indexOf(10, k)) {
      const rec = Memory.parse(data.subarray(k, nl).toString("utf8"), file);
      if (rec !== null) {
        Memory.place(mem, fd, stream, rec, day, at + k, nl - k);
      }
      k = nl + 1;
    }
    if (k < data.length) {
      console.error("skipped the last line of " + file + ": cut short");
      fs.appendFileSync(file, "\n");
      return at + data.length + 1;
    }
    return at + k;
  }

  export function slot(l: number, i: number): number {
    return (2 * i + 1) * 2 ** l - 1;
  }

  // a record's line, in its log's index (an act's of its own has none),
  // and the act it records
  export function place(mem: Memory, fd: number, stream: Stream, rec: any, day: number, at: number, length: number): void {
    const buf = Buffer.alloc(SLOT);
    if (rec.act !== undefined) {
      mem.acted(rec.act, rec.ans ?? {});
    }
    if (rec.i === undefined) {
      return;
    }
    buf.writeDoubleLE(at, 0);
    buf.writeUInt32LE(day, 8);
    buf.writeUInt32LE(length, 12);
    fs.writeSync(fd, buf, 0, SLOT, (stream === "main" ? rec.i : Memory.slot(rec.l, rec.i)) * SLOT);
  }

  // the record at a slot of a log; null: none
  export function read(mem: Memory, stream: Stream, slot: number): any {
    const rec = Memory.pread(Memory.fd(mem, mem.dir + "/" + stream + ".index"), slot * SLOT, SLOT);
    const day = rec.length < SLOT ? 0 : rec.readUInt32LE(8);
    if (day === 0) {
      return null;
    }
    const line = Memory.pread(Memory.fd(mem, Memory.path(mem, stream, day)), rec.readDoubleLE(0), rec.readUInt32LE(12));
    return JSON.parse(line.toString("utf8"));
  }

  // a file of the chat to read, kept open (the FDS read last) while the
  // chat is in memory
  export function fd(mem: Memory, file: string): number {
    const fd = mem.fds.get(file) ?? fs.openSync(file, "r");
    mem.fds.delete(file);
    mem.fds.set(file, fd);
    for (const [old, gone] of mem.fds) {
      if (mem.fds.size <= FDS) {
        break;
      }
      fs.closeSync(gone);
      mem.fds.delete(old);
    }
    return fd;
  }

  // up to n bytes of an open file, from byte `at`
  export function pread(fd: number, at: number, n: number): Buffer {
    const buf = Buffer.alloc(n);
    return buf.subarray(0, fs.readSync(fd, buf, 0, n, at));
  }

  // up to n bytes of a file, from byte `at`
  export function slice(file: string, at: number, n: number): Buffer {
    const fd = fs.openSync(file, "r");
    try {
      return Memory.pread(fd, at, n);
    } finally {
      fs.closeSync(fd);
    }
  }

  export function path(mem: Memory, stream: Stream, day: number): string {
    return mem.dir + "/" + stream + "/" + new Date(day * DAY).toISOString().slice(0, 10) + ".jsonl";
  }

  export function file(file: string): any[] {
    const data = fs.readFileSync(file, "utf8");
    if (data !== "" && !data.endsWith("\n")) {
      fs.appendFileSync(file, "\n");
    }
    return data.split("\n").flatMap((line) => Memory.parse(line, file) ?? []);
  }

  // null: not JSON
  export function parse(line: string, file: string): any {
    try {
      return JSON.parse(line);
    } catch {
      if (line !== "") {
        console.error("skipped a line of " + file + ": not JSON");
      }
      return null;
    }
  }

  // appended to the file of the local date and synced, then indexed
  export function log(mem: Memory, stream: Stream, recs: object[]): void {
    const day = Date.parse(new Date().toLocaleDateString("sv-SE")) / DAY;
    const lines = recs.map((rec) => JSON.stringify(rec));
    let at = Memory.append(Memory.path(mem, stream, day), lines);
    const fd = fs.openSync(mem.dir + "/" + stream + ".index", "r+");
    try {
      for (const [k, line] of lines.entries()) {
        Memory.place(mem, fd, stream, recs[k], day, at, Memory.bytes(line));
        at += Memory.bytes(line) + 1;
      }
    } finally {
      fs.closeSync(fd);
    }
    mem.ends[stream] = [day, at];
  }

  // where they start; flushed soon (Disk.ts)
  export function append(file: string, lines: string[]): number {
    const fd = fs.openSync(file, "a");
    try {
      const at = fs.fstatSync(fd).size;
      fs.writeSync(fd, lines.map((line) => line + "\n").join(""));
      return at;
    } finally {
      fs.closeSync(fd);
      Disk.wrote(file);
    }
  }

  export function bytes(text: string): number {
    return Buffer.byteLength(text, "utf8");
  }

  export function root(i: number, msg: Msg): Root {
    const date   = msg.date ?? new Date().toISOString();
    const images = msg.images?.length ? msg.images : undefined;
    const root: Root = { ...msg, text: msg.text.toWellFormed(), i, size: 0, date, images };
    root.size = Memory.bytes(Memory.show(root));
    return root;
  }

  // a message as models read it, tagged by its author: an imported chat's
  // AI (its say and calls) is "ai", not Unii
  export function show(root: Root): string {
    const pics = (root.images ?? []).map((name) => "\n[image docs/images/" + name + "]");
    const who  = root.imported && (root.kind === "unii" || root.kind === "tool") ? "ai" : root.kind;
    return who + ": " + root.text + pics.join("");
  }

  // message i, from its file; null: none
  export function message(mem: Memory, i: number): Root | null {
    return Number.isInteger(i) && i >= 0 && i < mem.count ? Memory.read(mem, "main", i) : null;
  }

  // the pages logged; those `more` stay open, past the count, till one
  // that isn't
  export function push(mem: Memory, msgs: Msg[]): Root[] {
    const roots = msgs.flatMap(Memory.pages).map((msg, k) => Memory.root(mem.count + mem.open + k, msg));
    const done = roots.findLastIndex((root) => !root.more) + 1;
    const ids = Array.from({ length: done === 0 ? 0 : mem.open + done }, (_, k) => mem.count + k);
    Memory.log(mem, "main", roots);
    mem.open += roots.length - ids.length;
    mem.count += ids.length;
    ids.forEach((i) => Memory.ready(mem, { l: 0, i }, true));
    Memory.fit(mem, true);
    Memory.pump(mem);
    return roots;
  }

  // its text and images on the last pages (a call takes them whole), its
  // line on the first, its act's record on the last
  export function pages(msg: Msg): Msg[] {
    const texts = clip_pages(msg.text);
    const pics = msg.images ?? [];
    const n = Math.max(texts.length, Math.ceil(pics.length / PICS));
    return Array.from({ length: n }, (_, k) => {
      const end = Math.max(0, pics.length - (n - 1 - k) * PICS);
      const images = pics.slice(Math.max(0, end - PICS), end);
      const more = k < n - 1 || msg.more === true ? true : undefined;
      const act = k === n - 1 ? msg.act : undefined;
      return { ...msg, text: texts[k - n + texts.length] ?? "", images, line: k === 0 ? msg.line : undefined, more, act };
    });
  }

  // the first message, from `from` on, from which those to the end go
  // whole in a call: HIGH bytes, PICS images (the last always)
  export function whole(mem: Memory, from: number): number {
    let [k, size, pics] = [mem.count, 0, 0];
    for (; k > from; k--) {
      const root = Memory.message(mem, k - 1)!;
      size += root.size;
      pics += root.images?.length ?? 0;
      if (k < mem.count && (size > HIGH || pics > PICS)) {
        return k;
      }
    }
    return k;
  }

  // the pages [a, b) of a message as a model gets them: one text, their
  // images
  export function say(mem: Memory, a: number, b: number): Say {
    const ids = Array.from({ length: b - a }, (_, k) => a + k);
    const text = ids.map((id) => Memory.message(mem, id)!.text).join("");
    return { text, imgs: ids.flatMap((id) => Memory.images(mem, id)) };
  }

  // Images
  // ------

  // an image's bytes put in place, by their hash, its copy for models
  // beside it; hashed and scaled off the event loop; null: no image kind
  // or unreadable
  export async function image_add(mem: Memory, bytes: Buffer): Promise<string | null> {
    const kind = image_kind(bytes);
    if (kind === null) {
      return null;
    }
    const img = new Bun.Image(bytes);
    const size = await img.metadata().catch(() => null);
    if (size === null) {
      return null;
    }
    const hash = new Bun.CryptoHasher("sha256");
    for (let at = 0; at < bytes.length; at += PIECE) {
      hash.update(bytes.subarray(at, at + PIECE));
      await new Promise((ok) => setImmediate(ok));
    }
    const name = hash.digest("hex").slice(0, 16) + "." + kind.split("/")[1];
    const k = Math.min(1, FIT / Math.max(size.width, size.height));
    const fit = (k < 1 || bytes.length > IMAGE) && size.width * size.height <= PIXELS;
    fs.mkdirSync(mem.dir + IMAGES, { recursive: true });
    if (fit) {
      const out = img.resize(Math.round(size.width * k), Math.round(size.height * k)).jpeg({ quality: 85 });
      await Bun.write(mem.dir + IMAGES + name + ".jpg", await out.bytes());
      Disk.wrote(mem.dir + IMAGES + name + ".jpg");
    }
    await Bun.write(mem.dir + IMAGES + name, bytes);
    Disk.wrote(mem.dir + IMAGES + name);
    return name;
  }

  export function image_file(mem: Memory, name: string): string | null {
    const file = mem.dir + IMAGES + name;
    return /^[0-9a-f]{16}\.[a-z]+$/.test(name) && fs.existsSync(file) ? file : null;
  }

  // what models get of message id's images: their copies, if any
  export function images(mem: Memory, id: number): Img[] {
    const names = Memory.message(mem, id)?.images ?? [];
    return names.map((name) => {
      const fit = fs.existsSync(mem.dir + IMAGES + name + ".jpg");
      const data = fs.readFileSync(mem.dir + IMAGES + name + (fit ? ".jpg" : "")).toString("base64");
      return { type: fit ? "image/jpeg" : "image/" + name.split(".")[1], data };
    });
  }

  // Tree
  // ----

  // of a node the view or a node above it may need
  export function built(mem: Memory, l: number, i: number): boolean {
    return mem.nodes.has(Memory.slot(l, i));
  }

  // node (l,i)'s text, kept or from its file; null: not built
  export function node(mem: Memory, part: Part): string | null {
    const slot = Memory.slot(part.l, part.i);
    return mem.nodes.get(slot) ?? Memory.read(mem, "tree", slot)?.text ?? null;
  }

  // the tree's roots: a node per power of two in the count, largest first
  export function roots(count: number): Part[] {
    const out: Part[] = [];
    for (let l = 30, id = 0; l >= 0; l--) {
      if (id + 2 ** l <= count) {
        out.push({ l, i: id / 2 ** l });
        id += 2 ** l;
      }
    }
    return out;
  }

  // the view under `part`, down from it, keeping the built nodes met:
  // the nodes of `keys` built (none: any built), or messages
  export function down(mem: Memory, part: Part, keys: Set<number> | null): Part[] {
    const key = Memory.slot(part.l, part.i);
    const text = Memory.node(mem, part);
    if (text !== null) {
      mem.nodes.set(key, text);
    }
    if (part.l === 0 || (text !== null && (keys === null || keys.has(key)))) {
      return [part];
    }
    return Memory.halves(part).flatMap((half) => Memory.down(mem, half, keys));
  }

  export function halves(part: Part): Part[] {
    return part.l === 0 ? [] : [{ l: part.l - 1, i: 2 * part.i }, { l: part.l - 1, i: 2 * part.i + 1 }];
  }

  export function source(mem: Memory, l: number, i: number): string | null {
    if (l === 0) {
      const root = Memory.message(mem, i);
      return root === null ? null : root.line ?? Memory.show(root);
    }
    const [a, b] = Memory.halves({ l, i }).map((half) => Memory.node(mem, half));
    return a === null || b === null ? null : Memory.flat(a) + "\n" + Memory.flat(b);
  }

  export function ctx(l: number, i: number): number {
    return l === 0 ? i : (i + 1) * 2 ** l;
  }

  // the message of the view's (k+1)th line not built of a side (0: the
  // chat's, 1: an import's), else the count
  export function first(mem: Memory, k = 0, side = 0): number {
    return (mem.ready[side][0] ?? [])[k] ?? mem.count;
  }

  // a node ready (on), or no more (built)
  export function ready(mem: Memory, { l, i }: Part, on: boolean): void {
    const queue = (mem.ready[Memory.side(mem, l, i)][l] ??= []);
    let [a, z] = [0, queue.length];
    while (a < z) {
      const m = (a + z) >> 1;
      [a, z] = queue[m] < i ? [m + 1, z] : [a, m];
    }
    if (on !== (queue[a] === i)) {
      queue.splice(a, on ? 0 : 1, ...(on ? [i] : []));
    }
  }

  // node (l,i)'s side: 1 if its last message is imported, else 0
  export function side(mem: Memory, l: number, i: number): number {
    const last = (i + 1) * 2 ** l - 1;
    const side = mem.sides.get(last) ?? (Memory.message(mem, last)?.imported === true ? 1 : 0);
    mem.sides.set(last, side);
    return side;
  }

  // the nodes to build; those whose source fits take no call: built at
  // once, together (as jobs, a chain of them held the event loop)
  export function pump(mem: Memory): void {
    let built = false;
    for (let free = Memory.starts(mem); free.length > 0 && !mem.done; free = Memory.starts(mem)) {
      Memory.store(mem, free);
      built = true;
    }
    if (built) {
      Memory.fit(mem);
    }
  }

  // of each side not held, the nodes ready up to its JOBS-th line not
  // built, in the order the messages came (`ctx`; at a tie, a merge
  // first), while JOBS run. The jobs started; the nodes
  // whose source fits
  export function starts(mem: Memory): Array<Part & { text: string }> {
    const free: Array<Part & { text: string }> = [];
    for (const side of [0, 1].filter((side) => mem.hold[side] === null)) {
      const end = Memory.first(mem, JOBS - 1, side);
      const next: Part[] = [];
      mem.ready[side].forEach((queue, l) => {
        for (let k = 0; k < queue.length && Memory.ctx(l, queue[k]) <= end; k++) {
          next.push({ l, i: queue[k] });
        }
      });
      next.sort((a, b) => Memory.ctx(a.l, a.i) - Memory.ctx(b.l, b.i) || b.l - a.l);
      for (const { l, i } of next) {
        if (mem.done || Memory.running(mem, side) >= JOBS) {
          break;
        }
        const text = mem.busy.has(Memory.slot(l, i)) ? null : Memory.source(mem, l, i);
        if (text !== null && Memory.bytes(text) <= NODE) {
          free.push({ l, i, text });
        } else if (text !== null) {
          Memory.job(mem, l, i, text);
        }
      }
    }
    return free;
  }

  // an import held by its user, at once: its calls out cut; their nodes
  // build as it goes on
  export function pause(mem: Memory): void {
    mem.hold[1] = "paused";
    mem.calls.forEach((sum, call) => sum.kind === "import" && call.stop());
  }

  // the nodes under `part` not built whose sources are: only nodes not
  // built and their halves are visited
  export function todo(mem: Memory, part: Part): Part[] {
    if (Memory.built(mem, part.l, part.i)) {
      return [];
    }
    const halves = Memory.halves(part);
    const here = halves.every((half) => Memory.built(mem, half.l, half.i)) ? [part] : [];
    return [...here, ...halves.flatMap((half) => Memory.todo(mem, half))];
  }

  // how many nodes of a side build
  export function running(mem: Memory, side: number): number {
    return [...mem.busy.values()].filter((n) => n === side).length;
  }

  // a node cut (its side held, or the chat ended: Memory.stop) builds as
  // it goes on; call: one running for it already (Memory.take)
  export function job(mem: Memory, l: number, i: number, text: string, call: Call | null = null): void {
    const key = Memory.slot(l, i);
    mem.busy.set(key, Memory.side(mem, l, i));
    Memory.build(mem, l, i, text, call).finally(() => {
      mem.busy.delete(key);
      Memory.pump(mem);
      Memory.fit(mem);
    }).catch((err) => {
      console.error("compactor: node " + l + "/" + i + ": " + (err?.message ?? err));
    });
  }

  // no node starts again (the chat moves: Memory.give)
  export function halt(mem: Memory): void {
    mem.done = true;
  }

  // nor runs: those running are cut
  export function stop(mem: Memory): void {
    Memory.halt(mem);
    mem.calls.forEach((_, call) => call.stop());
    mem.fds.forEach((fd) => fs.closeSync(fd));
    mem.fds.clear();
  }

  // the summaries running, as the chat moves to another process (Server.ts
  // Chat.move): each node and its call, which runs on here as `far` moves
  // it (its id); none is cut, nor asked again there
  export function give(mem: Memory, far: (call: Call) => string): Given[] {
    const given = [...mem.calls].map(([call, { l, i }]): Given => [l, i, far(call)]);
    mem.calls.clear();
    return given;
  }

  // the summaries a chat moved here was running (Memory.give) build here
  // as their calls end there: `far` makes the call of an id, paid here
  export function take(mem: Memory, given: Given[], far: (id: string, bill?: Bill) => Call): void {
    for (const [l, i, id] of given) {
      const text = Memory.source(mem, l, i)!;
      Memory.job(mem, l, i, text, far(id, Memory.bill(mem, l, i, text)));
    }
  }

  // node (l,i)'s summary: its view to the node and its task, asked till
  // a line fits, TRIES lines at most (fewer if the chat moves), the
  // shortest kept. Each try sends those blocks, never a try's words or
  // thoughts; one after a line too long adds only its size and where the
  // limit cuts it (`over`): never more than the first and that note. No
  // line (a refusal: its input's doing): its source clipped; a try cut
  // (a pause, a stop) or refused by its payer throws, unless a line came
  export async function build(mem: Memory, l: number, i: number, text: string, call: Call | null): Promise<void> {
    const task = { text: Memory.task(l, i) + text + "\n</input>", mark: false };
    const upto = Math.min(Memory.ctx(l, i), Memory.first(mem, 0, Memory.side(mem, l, i)));
    const blocks = [...Memory.view(mem, upto, mem.seen.parts), task];
    const lines: string[] = [];
    let end = await Memory.compact(mem, l, i, call ?? Memory.ask(mem, l, i, text, blocks));
    while (end.ok && end.text.trim() !== "") {
      const line = end.text.trim();
      lines.push(line);
      if (Memory.bytes(line) <= NODE || lines.length === TRIES || mem.done) {
        break;
      }
      const note = { text: Memory.over(line), mark: false };
      end = await Memory.compact(mem, l, i, Memory.ask(mem, l, i, text, [...blocks, note]));
    }
    if (lines.length === 0 && !end.ok && end.stop !== "fail") {
      throw new Error(end.text);
    }
    if (lines.length === 0) {
      console.error("compactor: node " + l + "/" + i + ": " + (end.ok ? "an empty line" : end.text) + "; clipped");
    }
    const line = lines.length === 0 ? Memory.cut(Memory.flat(text)) : lines.reduce((a, b) => (Memory.bytes(b) < Memory.bytes(a) ? b : a));
    Memory.store(mem, [{ l, i, text: line }]);
  }

  // what node (l,i)'s summary serves: an import, or the chat
  export function served(mem: Memory, l: number, i: number): Served {
    return Memory.side(mem, l, i) === 1 ? "import" : "compactor";
  }

  // what pays node (l,i)'s summary (none: free)
  export function bill(mem: Memory, l: number, i: number, text: string): Bill | undefined {
    return mem.pay?.(Memory.served(mem, l, i), Memory.ref({ l, i }), Memory.bytes(text));
  }

  // nodes built: logged in one write, kept
  export function store(mem: Memory, parts: Array<Part & { text: string }>): void {
    Memory.log(mem, "tree", parts.map(({ l, i, text }) => ({ l, i, text, size: Memory.bytes(text) })));
    for (const { l, i, text } of parts) {
      Memory.ready(mem, { l, i }, false);
      mem.nodes.set(Memory.slot(l, i), text);
      mem.sides.delete((i + 1) * 2 ** l - 1);
      [mem.view, mem.seen].forEach((view) => (view.size += l === 0 && i < Memory.end(view) ? Memory.bytes(text) : 0));
    }
    for (const { l, i } of parts) {
      const up = { l: l + 1, i: i >> 1 };
      if (Memory.built(mem, l, i ^ 1) && !Memory.built(mem, up.l, up.i)) {
        Memory.ready(mem, up, true);
      }
    }
    parts.forEach(({ l, i }) => mem.made?.(l, i));
  }

  // a call of node (l,i)'s summary, on the compactor
  export function ask(mem: Memory, l: number, i: number, text: string, blocks: Block[]): Call {
    const bill = Memory.bill(mem, l, i, text);
    return AskAI.ask({ ...mem.share(), ...Pick.ask(config.COMPACTOR), blocks, bill, patient: true, yields: Memory.served(mem, l, i) === "import" ? mem.dir : undefined }, () => {});
  }

  // a summary's try: its call's end, the call held in `calls` till then
  export function compact(mem: Memory, l: number, i: number, call: Call): Call["done"] {
    mem.calls.set(call, { l, i, kind: Memory.served(mem, l, i) });
    return call.done.finally(() => mem.calls.delete(call));
  }

  // node (l,i)'s task, but its input
  export function task(l: number, i: number): string {
    const [a, z] = Memory.span({ l, i });
    const n = 2 ** l / 2;
    const fill: Array<[string, string]> = [["{a}", a + "+" + n], ["{b}", a + n + "+" + n], ["{id}", String(a)], ["{end}", String(z)]];
    return fill.reduce((t, [k, v]) => t.replace(k, v), l === 0 ? LEAF : MERGE);
  }

  // a text's first NODE bytes
  export function cut(text: string): string {
    return Buffer.from(text, "utf8").subarray(0, NODE).toString("utf8").replace(/\uFFFD+$/, "");
  }

  export function over(line: string): string {
    return `Too long: your last line for this <input> was ${Memory.bytes(line)} bytes,
over the ${NODE}-byte limit. Write the whole line again, cutting just
enough of the least valuable items to fit before this cut:
${Memory.cut(line)}| ← LIMIT`;
  }

  // View
  // ----

  // of the view or a node above it: kept, or not built
  export function text(mem: Memory, part: Part): string {
    return mem.nodes.get(Memory.slot(part.l, part.i)) ?? WAIT;
  }

  // a line's bytes as calls get it: none until built
  export function size(mem: Memory, part: Part): number {
    return Memory.built(mem, part.l, part.i) ? Memory.bytes(Memory.text(mem, part)) : 0;
  }

  // each view to its end; a batch starts as a view passes `high`, or goes
  // on at a message (`next`) if a missing parent stopped it; between
  // messages, only a whole batch, to half or, as parents not built keep
  // it over (an import's lag JOBS calls a level), by `high`: each change
  // makes every call after write the view anew. A node merged away no
  // view holds, nor one under it, is let go
  export function fit(mem: Memory, next = false): void {
    const gone: Part[] = [];
    let changed = false;
    const sides = [0, 1].filter((side) => mem.hold[side] === null).map((side) => Memory.first(mem, 0, side));
    Memory.reach(mem, mem.view, mem.count);
    Memory.reach(mem, mem.seen, Math.min(mem.count, ...sides));
    for (const view of [mem.view, mem.seen]) {
      const [parts, batch] = [view.parts.length, view.batch];
      if (view.size > view.high || (next && view.batch)) {
        const merged = Memory.merge(mem, view);
        if (next || merged.size <= Math.max(view.high / 2, view.size - view.high)) {
          [view.parts, view.size] = [merged.parts, merged.size];
          gone.push(...merged.gone);
        }
        view.batch = view.size > view.high / 2;
      }
      changed ||= view.parts.length !== parts || view.batch !== batch;
    }
    gone.filter((part) => !Memory.held(mem, part)).forEach((part) => mem.nodes.delete(Memory.slot(part.l, part.i)));
    if (changed) {
      Memory.save(mem);
    }
    mem.wait.forEach((check) => check());
  }

  // a view to message `end`: its lines from it dropped (an import going on
  // again), the messages to it appended
  export function reach(mem: Memory, view: View, end: number): void {
    for (const part of view.parts.splice(Memory.cover(view, end))) {
      view.size -= Memory.size(mem, part);
    }
    for (let i = Memory.end(view); i < end; i++) {
      view.parts.push({ l: 0, i });
      view.size += Memory.size(mem, { l: 0, i });
    }
  }

  // the message after a view's last line
  export function end({ parts }: View): number {
    return parts.length === 0 ? 0 : Memory.span(parts[parts.length - 1])[1] + 1;
  }

  // the index of a view's line holding message id (past its end: none)
  export function cover({ parts }: View, id: number): number {
    let [a, z] = [0, parts.length];
    while (a < z) {
      const m = (a + z) >> 1;
      [a, z] = Memory.span(parts[m])[1] < id ? [m + 1, z] : [a, m];
    }
    return a;
  }

  // whether a view holds `part` or a node under it, or will (not there)
  export function held(mem: Memory, part: Part): boolean {
    return [mem.view, mem.seen].some((view) => {
      const k = Memory.cover(view, Memory.span(part)[0]);
      return k === view.parts.length || view.parts[k].l <= part.l;
    });
  }

  // a view's most due pairs merged down to half, as their parents allow:
  // a pair whose parent is built, most due first ((T + 1) / 2^l - i, T
  // the view's end: its age from its last message, in halves; from its
  // first, old pairs won near ties, so a merge rewrote old lines a view
  // should keep), the oldest of equals; a heap of pairs over the view as
  // a linked list, so a view of thousands merges in milliseconds
  export function merge(mem: Memory, from: View): { parts: Part[]; size: number; gone: Part[] } {
    const [t, low] = [Memory.end(from), from.high / 2];
    const view: Array<Part | null> = [...from.parts];
    const gone: Part[] = [];
    const next = view.map((_, k) => k + 1);
    const prev = view.map((_, k) => k - 1);
    const heap: Array<{ d: number; k: number; a: Part; b: Part }> = [];
    const over = (x: (typeof heap)[0], y: (typeof heap)[0]) => x.d > y.d || (x.d === y.d && x.k < y.k);
    const swap = (x: number, y: number) => ([heap[x], heap[y]] = [heap[y], heap[x]]);
    const offer = (k: number) => {
      const [a, b] = [view[k], view[next[k]]];
      if (k < 0 || !a || !b || a.i % 2 !== 0 || b.l !== a.l || b.i !== a.i + 1 || !Memory.built(mem, a.l + 1, a.i / 2)) {
        return;
      }
      heap.push({ d: (t + 1) / 2 ** a.l - a.i, k, a, b });
      for (let x = heap.length - 1; x > 0 && over(heap[x], heap[(x - 1) >> 1]); x = (x - 1) >> 1) {
        swap(x, (x - 1) >> 1);
      }
    };
    const take = () => {
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length > 0) {
        heap[0] = last;
        for (let x = 0; ; ) {
          const m = [x, 2 * x + 1, 2 * x + 2].reduce((m, c) => (c < heap.length && over(heap[c], heap[m]) ? c : m));
          if (m === x) {
            break;
          }
          swap(x, m);
          x = m;
        }
      }
      return top;
    };
    let size = from.size;
    view.forEach((_, k) => offer(k));
    while (heap.length > 0 && size > low) {
      const { k, a, b } = take();
      const j = next[k];
      if (view[k] !== a || view[j] !== b) {
        continue;
      }
      const up = { l: a.l + 1, i: a.i / 2 };
      size += Memory.size(mem, up) - Memory.size(mem, a) - Memory.size(mem, b);
      [view[k], view[j]] = [up, null];
      next[k] = next[j];
      prev[next[j]] = k;
      gone.push(a, b);
      offer(prev[k]);
      offer(k);
    }
    return { parts: view.filter((part) => part !== null), size, gone };
  }

  // once the chat's messages before `end` are built (not an import's):
  // null; else why they won't be: "Stopped." (signal aborted), or why
  // their side is held (no credit for them: Billing.ts book), so no
  // turn or agent waits on summaries no call is building
  export function settle(mem: Memory, end: number, signal: AbortSignal): Promise<string | null> {
    return new Promise((resolve) => {
      const check = () => {
        const built = Memory.first(mem) >= end;
        const why = signal.aborted ? "Stopped." : built ? null : mem.hold[0];
        if (built || why !== null) {
          mem.wait.delete(check);
          signal.removeEventListener("abort", check);
          resolve(why);
        }
      };
      mem.wait.add(check);
      signal.addEventListener("abort", check);
      check();
    });
  }

  export function span(part: Part): [number, number] {
    const a = part.i * 2 ** part.l;
    return [a, a + 2 ** part.l - 1];
  }

  // the regex tries every position; most lines have no newline at all
  export function flat(text: string): string {
    if (!text.includes("\n")) {
      return text;
    }
    return text.replace(/\s*\n\s*/g, " ");
  }

  // its zoom target, "id+n"
  export function ref(part: Part): string {
    return part.i * 2 ** part.l + "+" + 2 ** part.l;
  }

  export function line(part: Part, text: string): string {
    return Memory.ref(part) + "|" + Memory.flat(text);
  }

  export function before(view: Part[], end: number): Part[] {
    return view.filter((part) => Memory.span(part)[1] < end);
  }

  // the view's lines built before message `end`, in blocks (the last cut
  // short), one marked: the last whole one, else the opening one. One
  // mark only: a request takes four, and Anthropic.ts adds three (the
  // system prompt's, a reply's end's, the top-level)
  export function view(mem: Memory, end = mem.count, parts = mem.view.parts): Block[] {
    const lines = Memory.before(parts, end).filter((part) => Memory.built(mem, part.l, part.i)).map((part) => Memory.line(part, Memory.text(mem, part)) + "\n");
    const whole = Math.floor(lines.length / BLOCK);
    const blocks: Block[] = [{ text: "<chat>\n", mark: whole === 0 }];
    for (let k = 0; k < whole; k++) {
      blocks.push({ text: lines.slice(k * BLOCK, (k + 1) * BLOCK).join(""), mark: k === whole - 1 });
    }
    blocks.push({ text: lines.slice(whole * BLOCK).join("") + "</chat>\n", mark: false });
    return blocks;
  }

  export function part(mem: Memory, id: number, n: number): Part | null {
    const l = Math.log2(n);
    const ok = Number.isInteger(id) && Number.isInteger(l) && id >= 0 && id % n === 0 && id + n <= mem.count;
    return ok ? { l, i: id / n } : null;
  }

  // a message (n = 1) whole, a long one a page from `at` (Clip.ts), its
  // images on the first; else the two lines under id+n
  export function zoom(mem: Memory, id: number, n: number, at: number): string {
    const part = Memory.part(mem, id, n);
    const root = n === 1 ? Memory.message(mem, id) : null;
    if (part === null) {
      const roots = Memory.roots(mem.count).map((root) => Memory.ref(root)).join(", ");
      return "No line " + id + "+" + n + ": n is a power of 2, id a multiple of n. The tree's roots: " + roots + ".";
    }
    if (root !== null) {
      const images = at === 0 ? root.images : undefined;
      return id + "+0|" + Memory.show({ ...root, text: clip_page(root.text, at), images });
    }
    return Memory.halves(part).map((half) => Memory.line(half, Memory.node(mem, half) ?? WAIT)).join("\n");
  }

  export function date(mem: Memory, id: number): string {
    const root = Memory.message(mem, id);
    return root === null ? "No message " + id + "." : new Date(root.date).toLocaleString("sv-SE");
  }

  // where a page of the chat starts: the last message starting a turn
  // (the user's or a report) the view holds whole; none: the first, or
  // the end
  export function turn(mem: Memory): number {
    const whole = mem.view.parts.slice(mem.view.parts.findLastIndex((part) => part.l > 0) + 1);
    const user = whole.findLast((part) => ["user", "work"].includes(Memory.message(mem, part.i)?.kind ?? ""));
    return (user ?? whole[0])?.i ?? mem.count;
  }

  // the tree's levels: as many as the count's bits
  export function levels(mem: Memory): number[] {
    return Array.from({ length: mem.count.toString(2).length }, (_, l) => l);
  }

  // level l's nodes built, in order
  export function* level(mem: Memory, l: number): Generator<[Part, string]> {
    for (let i = 0; (i + 1) * 2 ** l <= mem.count; i++) {
      const text = Memory.node(mem, { l, i });
      if (text !== null) {
        yield [{ l, i }, text];
      }
    }
  }

  // /export: the account, the messages, the summaries, the agents' logs,
  // then every image, each its base64, read a PIECE at a time
  export function* dump(mem: Memory, account: object): Generator<string> {
    const ls = (sub: string) => (fs.existsSync(mem.dir + sub) ? fs.readdirSync(mem.dir + sub).sort() : []);
    let sep = "\n";
    yield '{"account": ' + JSON.stringify(account) + ',\n"messages": [';
    for (let i = 0; i < mem.count; i++) {
      const { kind, text, date, images, more } = Memory.message(mem, i)!;
      yield (i === 0 ? "\n" : ",\n") + JSON.stringify({ id: i, kind, text, date, images, more });
    }
    yield '],\n"summaries": [';
    for (const l of Memory.levels(mem)) {
      for (const [part, text] of Memory.level(mem, l)) {
        yield sep + JSON.stringify({ id: Memory.span(part)[0], n: 2 ** l, text });
        sep = ",\n";
      }
    }
    yield '],\n"agents": {';
    sep = "\n";
    for (const name of ls(AGENTS).map((file) => file.replace(/\.jsonl$/, ""))) {
      const log = Memory.agent(mem, name);
      if (log === null) {
        continue;
      }
      const entries = log.map(({ i, kind, text, date }) => ({ id: i, kind, text, date }));
      yield sep + JSON.stringify(name) + ": " + JSON.stringify(entries);
      sep = ",\n";
    }
    yield '},\n"images": {';
    sep = "\n";
    for (const name of ls(IMAGES)) {
      const file = Memory.image_file(mem, name);
      if (file === null) {
        continue;
      }
      yield sep + JSON.stringify(name) + ': "';
      for (let at = 0, size = fs.statSync(file).size; at < size; at += 3 * PIECE) {
        yield Memory.slice(file, at, 3 * PIECE).toString("base64");
      }
      yield '"';
      sep = ",\n";
    }
    yield "}}\n";
  }

  // /tree: a section for the view, the messages and each level
  export function* page(mem: Memory): Generator<string> {
    const esc  = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const item = (head: string[], text: string) => "<h4>" + esc(head.join(" · ")) + "</h4><pre>" + esc(text) + "</pre>";
    const date = (id: number) => new Date(Memory.message(mem, id)!.date).toLocaleString("sv-SE");
    const when = (a: number, b: number) => date(a) + (a === b ? "" : " – " + date(b));
    const node = (part: Part, text: string) => {
      const [a, b] = Memory.span(part);
      const head = ["LVL" + part.l + " #" + a + "-" + b, when(a, b), Memory.bytes(text) + " B"];
      return item(head, text);
    };
    const levels = Memory.levels(mem);
    const menu = ["VIEW", "ROOT", ...levels.map((l) => "LVL" + l)].map((name) => `<a href="#${name}">${name}</a>`);
    yield `<!doctype html><meta charset="utf-8"><title>UniiChat memory</title>
<style>
body { font: 13px/1.4 ui-monospace, monospace; margin: 2em; } nav a { margin-right: 1em; }
section { display: none; } section:target { display: block; }
h4 { margin: .8em 0 .2em; color: #888; font-weight: normal; } pre { margin: 0; white-space: pre-wrap; font: inherit; }
</style>
<script>location.hash = location.hash || "VIEW";</script>
<nav>${menu.join("")}</nav>
<section id="VIEW">`;
    yield mem.view.parts.map((part) => node(part, Memory.text(mem, part))).join("");
    yield '</section>\n<section id="ROOT">';
    for (let i = 0; i < mem.count; i++) {
      const r = Memory.message(mem, i)!;
      yield item(["ROOT #" + i, when(i, i), r.kind, r.size + " B"], r.text);
    }
    for (const l of levels) {
      yield '</section>\n<section id="LVL' + l + '">';
      for (const [part, text] of Memory.level(mem, l)) {
        yield node(part, text);
      }
    }
    yield "</section>\n";
  }

  // Agents
  // ------

  // read whole; a name is letters and hyphens, never a path
  export function agent(mem: Memory, name: string): Root[] | null {
    const file = mem.dir + AGENTS + name + ".jsonl";
    return /^[A-Za-z-]+$/.test(name) && fs.existsSync(file) ? Memory.file(file) : null;
  }

  export function agent_new(mem: Memory): string {
    const name = names.name_random();
    fs.mkdirSync(mem.dir + AGENTS, { recursive: true });
    try {
      fs.writeFileSync(mem.dir + AGENTS + name + ".jsonl", "", { flag: "wx" });
    } catch (err: any) {
      if (err.code === "EEXIST") {
        return Memory.agent_new(mem);
      }
      throw err;
    }
    mem.agents.set(name, 0);
    return name;
  }

  // its length read once, then counted (mem.agents)
  export function agent_push(mem: Memory, name: string, kind: Kind, text: string): number {
    const n = mem.agents.get(name) ?? Memory.agent(mem, name)?.length ?? 0;
    const root = Memory.root(n, { kind, text });
    Memory.append(mem.dir + AGENTS + name + ".jsonl", [JSON.stringify(root)]);
    mem.agents.set(name, n + 1);
    return root.i;
  }

  export function agent_show(mem: Memory, name: string): string {
    return Memory.agent(mem, name)?.map(Memory.agent_line).join("\n\n") ?? "No agent " + name + ".";
  }

  export function agent_line(root: Root): string {
    return root.i + "|" + Memory.show(root);
  }

}
