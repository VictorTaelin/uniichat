// Screen
// ======
// The terminal of Term.ts: lines print once into its own scrollback
// (native scroll, select and copy), above a footer each paint erases and
// draws again in one synchronized write; a pipe gets the lines as text.
// Input is read raw (macOS cuts a cooked line at 1024 bytes) as one
// stream; a paste comes bracketed and is typed whole. Kitty's keys at
// flag 1 only, so dead keys still compose. The input (Ed) draws as rows
// starting `> ` and takes its editing keys (ed_key, EDITING) here; Up and
// Down past its ends walk the messages sent.

import * as Paint from "./Paint.ts";
import * as Theme from "./Theme.ts";

// Types
// =====

// the input: its text, cursor, the messages sent before, the one Up and
// Down are at (hist.length: the new one), the new one meanwhile, whether
// Left or Right moved the cursor, the width its rows wrap at
type Ed = {
  text  : string;
  pos   : number;
  hist  : string[];
  at    : number;
  draft : string;
  moved : boolean;
  w     : number;
  tall  : number; // the rows it held since taken: a box shrinks only on Enter, else a gap would open above it
};

// where the cursor shows: a row of the lines drawn, a column
type Spot = { row: number; col: number };

// a place of the cursor in the input: its index in the text, its spot
type Place = Spot & { pos: number };

// the screen: whether a terminal, whether it answered kitty's flags (so
// Esc comes as CSI 27u, and a bare ESC only starts a sequence), the
// input, input not read yet (cut by a read's end), the footer's rows
// above the cursor (its blank rows too), the rows from the footer's top
// to the screen's bottom, where keys go
export type Screen = {
  tty    : boolean;
  kitty  : boolean;
  ed     : Ed;
  rest   : string;
  up     : number;
  rows   : number;
  on     : (key: string) => void;
};

// Constants
// =========

// the editing keys, as /help lists them
export const EDITING = "Arrows, Home, End, Ctrl+A, E, U, K, W, Alt+B, F, D, as in a shell; Shift+Enter or Ctrl+J, a new line; Up and Down past the ends, the messages sent.";

const PASTE_ON  = "\x1b[200~";
const PASTE_OFF = "\x1b[201~";

// a write the terminal shows at once; the screen and its scrollback
// erased, the cursor home
const SYNC_ON  = "\x1b[?2026h";
const SYNC_OFF = "\x1b[?2026l";
const WIPE     = "\x1b[2J\x1b[3J\x1b[H";

// bracketed paste, kitty's keys at flag 1 (popped before pushed), the
// flags asked (a kitty terminal answers CSI ? flags u); off
const MODES_ON  = "\x1b[?2004h\x1b[<u\x1b[>1u\x1b[?u";
const MODES_OFF = "\x1b[?2004l\x1b[<u";

// a sequence: CSI params [intermediates] final, or SS3 final (kitty's:
// CSI code[:alts] [; mods] u; modifyOtherKeys': CSI 27 ; mods ; code ~);
// CUT: one cut by the end of a read (a bare ESC too, where Esc is CSI
// 27u); FLAGS: kitty's answer to the flags asked
const SEQ   = /^\x1b(?:\[([0-9;:?<=>]*)[\x20-\x2f]*|O)([\x40-\x7e])/;
const CUT   = /^\x1b(?:\[[0-9;:?<=>\x20-\x2f]*|O)$/;
const FLAGS = /^\?\d*$/;

// key names by code (a byte, kitty's), by a sequence's final, or by its
// number and `~`; any other code is its character, byte Ctrl+letter
const KEYS: Record<string, string> = {
  8     : "Ctrl+Backspace",
  9     : "Tab",
  13    : "Enter",
  27    : "Esc",
  32    : "Space",
  127   : "Backspace",
  57414 : "Enter",
  A     : "Up",
  B     : "Down",
  C     : "Right",
  D     : "Left",
  H     : "Home",
  F     : "End",
  Z     : "Shift+Tab",
  "1~"  : "Home",
  "3~"  : "Delete",
  "4~"  : "End",
  "7~"  : "Home",
  "8~"  : "End",
};

// a word's character
const WORD = /[\p{L}\p{N}_]/u;

// modifiers, as bits of (mods - 1)
const MODS: [number, string][] = [[4, "Ctrl+"], [2, "Alt+"], [1, "Shift+"]];

// Screen
// ======

export function screen_new(on: (key: string) => void): Screen {
  const tty = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const ed  = { text: "", pos: 0, hist: [], at: 0, draft: "", moved: false, w: 80, tall: 1 };
  const scr = { tty, kitty: false, ed, rest: "", up: 0, rows: 0, on };
  if (tty) {
    process.stdin.setRawMode(true);
    process.stdout.write(MODES_ON);
    process.on("exit", () => process.stdout.write(screen_erase(scr) + MODES_OFF));
  }
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (data: string) => screen_feed(scr, data)).resume();
  return scr;
}

// the width drawn in: the screen's but its last column (a full row
// would wrap)
export function screen_width(): number {
  return (process.stdout.columns || 80) - 1;
}

// Output
// ------

// lines printed (wipe: on a screen and scrollback erased), then the
// footer again, cut at the width, the cursor at its spot. The footer
// always ends on the screen's last row: the rows it held that the new
// lines and footer don't fill stay blank above it (a wipe: the whole
// screen's), as a terminal never scrolls back down to them
export function screen_paint(scr: Screen, body: Paint.Line[], wipe: boolean, foot: Paint.Line[], at: Spot): void {
  if (!scr.tty) {
    process.stdout.write(body.map((l) => l.map((r) => r.x).join("").trimEnd() + "\n").join(""));
    return;
  }
  const w     = screen_width();
  const held  = Math.min(wipe ? Infinity : scr.rows, process.stdout.rows || 24);
  const pad   = Math.max(0, held - body.length - foot.length);
  const lines = [...body.map(Paint.line_ansi), ...Array(pad).fill("")].map((l) => l + "\r\n").join("");
  const draw  = foot.map((l) => Paint.line_ansi(Paint.runs_wrap(l, w, true)[0])).join("\r\n");
  const back  = foot.length - 1 - at.row;
  const move  = (back > 0 ? "\x1b[" + back + "A" : "") + "\r\x1b[" + (at.col + 1) + "G";
  const erase = wipe ? WIPE : screen_erase(scr);
  scr.up   = pad + at.row;
  scr.rows = pad + foot.length;
  process.stdout.write(SYNC_ON + erase + lines + draw + move + SYNC_OFF);
}

// the footer erased
function screen_erase(scr: Screen): string {
  const up = scr.up > 0 ? "\x1b[" + scr.up + "A" : "";
  return "\r" + up + "\x1b[J";
}

// Input
// -----

// each key read, then "" (the input may have changed)
export function screen_feed(scr: Screen, data: string): void {
  data = scr.rest + data;
  let n = 1;
  while (data !== "" && n > 0) {
    n = screen_key(scr, data);
    data = data.slice(n);
  }
  scr.rest = data;
  scr.on("");
}

// reads one key at the start of data; returns its length (0: cut short)
function screen_key(scr: Screen, data: string): number {
  const seq  = SEQ.exec(data);
  const text = /^[^\x00-\x1f\x7f]+/.exec(data);
  const code = data.charCodeAt(0);
  if (!scr.tty) {
    return screen_line(scr, data);
  }
  if (data.startsWith(PASTE_ON)) {
    return screen_paste(scr, data);
  }
  if (CUT.test(data) || (scr.kitty && data === "\x1b")) {
    return 0;
  }
  if (seq !== null && seq[2] === "u" && FLAGS.test(seq[1] ?? "")) {
    scr.kitty = true;
    return seq[0].length;
  }
  if (seq !== null) {
    screen_press(scr, seq_name(seq[1] ?? "", seq[2]));
    return seq[0].length;
  }
  if (code === 27 && data.length > 1 && data[1] !== "\x1b") {
    const c  = data.codePointAt(1) ?? 0;
    const ch = String.fromCodePoint(c);
    screen_press(scr, "Alt+" + (KEYS[c] ?? (c < 32 ? "Ctrl+" + String.fromCharCode(c + 64) : ch.toUpperCase())));
    return 1 + ch.length;
  }
  if (text !== null) {
    ed_type(scr.ed, text[0]);
    return text[0].length;
  }
  screen_press(scr, KEYS[code] ?? "Ctrl+" + String.fromCharCode(code + 64));
  return 1;
}

// a key: an editing key edits the input; any other goes to Term.ts
function screen_press(scr: Screen, key: string): void {
  if (!ed_key(scr.ed, key)) {
    scr.on(key);
  }
}

// stops the process (Ctrl+Z), the terminal as it found it; continued
// (fg), the screen's modes again, and the footer drawn anew
export function screen_suspend(scr: Screen): void {
  if (process.platform === "win32") {
    return; // no job control
  }
  process.stdout.write(screen_erase(scr) + MODES_OFF);
  scr.up   = 0;
  scr.rows = 0;
  process.stdin.setRawMode(false);
  process.once("SIGCONT", () => {
    process.stdin.setRawMode(true);
    process.stdout.write(MODES_ON);
    scr.on("");
  });
  process.kill(0, "SIGTSTP");
}

// a paste, typed whole
function screen_paste(scr: Screen, data: string): number {
  const end = data.indexOf(PASTE_OFF);
  if (end < 0) {
    return 0;
  }
  ed_type(scr.ed, data.slice(PASTE_ON.length, end).replace(/\r\n?/g, "\n"));
  return end + PASTE_OFF.length;
}

// a pipe's input: typed as it comes, each newline sending it (the last
// line, without one, is sent at the input's end: Term.ts)
function screen_line(scr: Screen, data: string): number {
  const k = data.indexOf("\n");
  ed_type(scr.ed, k < 0 ? data : data.slice(0, k));
  if (k < 0) {
    return data.length;
  }
  scr.on("Enter");
  return k + 1;
}

// a sequence's key: its code's (kitty, modifyOtherKeys) or its final's
function seq_name(params: string, end: string): string {
  const [a = 1, b = 1, c = 1] = params.split(";").map((p) => Number(p.split(":")[0]) || 1);
  const code = end === "u" ? a : end === "~" && a === 27 ? c : null;
  const name = end === "~" ? a + "~" : end;
  const key  = code === null ? KEYS[name] ?? name : KEYS[code] ?? String.fromCodePoint(code).toUpperCase();
  const mods = MODS.filter(([bit]) => (b - 1) & bit).map(([, m]) => m);
  return mods.join("") + key;
}

// the input's rows in w columns, at most max of them (the cursor's and
// those before it), a hint when empty, grey when off; and where the
// cursor shows
export function screen_input(scr: Screen, w: number, max: number, hint: string, off: boolean): { lines: Paint.Line[]; at: Spot } {
  const mark = Paint.Run(Theme.GLYPH.input, Paint.DIM);
  const ink  = off ? Paint.DIM : Paint.INK;
  const ed   = scr.ed;
  ed.w = w - 2;
  const { rows, places, at } = ed_layout(ed);
  const spot = places[at];
  const top  = Math.max(0, spot.row - Math.max(1, max) + 1);
  const seen = rows.slice(top, top + Math.max(1, max));
  const text = ed.text === "" ? [[mark, Paint.Run(hint, Paint.DIM)]] : seen.map((x) => [mark, Paint.Run(x, ink)]);
  ed.tall    = Math.min(Math.max(ed.tall, text.length), Math.max(1, max));
  text.push(...Array.from({ length: ed.tall - text.length }, () => [Paint.Run("")]));
  return { lines: text, at: { row: spot.row - top, col: spot.col + 2 } };
}

// Ed
// ==

// the rows' texts, wrapped at ed.w columns (a character at a time); each
// place of the cursor (before each character, and the end); the cursor's
function ed_layout(ed: Ed): { rows: string[]; places: Place[]; at: number } {
  const rows = [""];
  const places: Place[] = [];
  let col = 0;
  let pos = 0;
  for (const g of Paint.text_graphemes(ed.text)) {
    const x = g === "\n" ? "" : Paint.text_clean(g);
    if (g !== "\n" && col + Paint.text_width(x) > ed.w) {
      rows.push("");
      col = 0;
    }
    places.push({ pos, row: rows.length - 1, col });
    pos += g.length;
    rows[rows.length - 1] += x;
    col += Paint.text_width(x);
    if (g === "\n") {
      rows.push("");
      col = 0;
    }
  }
  if (col >= ed.w) {
    rows.push("");
    col = 0;
  }
  places.push({ pos, row: rows.length - 1, col });
  return { rows, places, at: places.findIndex((p) => p.pos >= ed.pos) };
}

// text typed or pasted, at the cursor
export function ed_type(ed: Ed, s: string): void {
  ed.text = ed.text.slice(0, ed.pos) + s + ed.text.slice(ed.pos);
  ed.pos += s.length;
}

// an editing key: a new line, a move, a character or word erased;
// whether key is one
export function ed_key(ed: Ed, key: string): boolean {
  const { places, at } = ed_layout(ed);
  const back = places[Math.max(0, at - 1)].pos;
  const next = places[Math.min(places.length - 1, at + 1)].pos;
  const word_back = ed_word(ed.text, ed.pos, -1);
  const word_next = ed_word(ed.text, ed.pos, 1);
  const move: Record<string, number> = {
    "Left": back, "Right": next, "Home": 0, "End": ed.text.length, "Ctrl+A": 0, "Ctrl+E": ed.text.length,
    "Ctrl+Left": word_back, "Alt+Left": word_back, "Alt+B": word_back,
    "Ctrl+Right": word_next, "Alt+Right": word_next, "Alt+F": word_next,
  };
  const erase: Record<string, [number, number]> = {
    "Backspace": [back, ed.pos], "Delete": [ed.pos, next],
    "Ctrl+Backspace": [word_back, ed.pos], "Alt+Backspace": [word_back, ed.pos], "Ctrl+W": [word_back, ed.pos],
    "Ctrl+Delete": [ed.pos, word_next], "Alt+Delete": [ed.pos, word_next], "Alt+D": [ed.pos, word_next],
    "Ctrl+U": [0, ed.pos], "Ctrl+K": [ed.pos, ed.text.length],
  };
  if (key in move) {
    ed.pos   = move[key];
    ed.moved = true;
    return true;
  }
  if (key in erase) {
    const [a, b] = erase[key];
    ed.text = ed.text.slice(0, a) + ed.text.slice(b);
    ed.pos  = a;
    return true;
  }
  switch (key) {
    case "Shift+Enter":
    case "Ctrl+J": {
      ed_type(ed, "\n");
      return true;
    }
    case "Up":
    case "Down": {
      ed_vert(ed, places, places[at], key === "Up" ? -1 : 1);
      return true;
    }
  }
  return false;
}

// from pos, back (d < 0) or on, past the non-word characters, then the
// word's: a scan, as a regex anchored at the text's end is tried from
// each start, quadratic (a 24 KB pasted box took 0.7 s per key, so keys
// queued and the terminal froze)
function ed_word(text: string, pos: number, d: number): number {
  const char = (i: number) => (d < 0 ? [...text.slice(Math.max(0, i - 2), i)].at(-1) : [...text.slice(i, i + 2)][0]) ?? "";
  let i = pos;
  for (const word of [false, true]) {
    for (let c = char(i); c !== "" && WORD.test(c) === word; c = char(i)) {
      i += d * c.length;
    }
  }
  return i;
}

// Up (d < 0) or Down: a row, at the nearest column; past the ends (unless
// Left or Right moved the cursor in a typed input), the message sent
// before/after
function ed_vert(ed: Ed, places: Place[], at: Place, d: number): void {
  const row = places.filter((p) => p.row === at.row + d);
  if (row.length > 0) {
    ed.pos = (row.filter((p) => p.col <= at.col).pop() ?? row[0]).pos;
    return;
  }
  const to = ed.at + d;
  if ((ed.moved && ed.text !== "") || to < 0 || to > ed.hist.length) {
    return;
  }
  if (ed.at === ed.hist.length) {
    ed.draft = ed.text;
  }
  ed.at   = to;
  ed.text = to === ed.hist.length ? ed.draft : ed.hist[to];
  ed.pos  = ed.text.length;
}

// the input taken (Enter), kept in the history; empty again
export function ed_take(ed: Ed): string {
  const text = ed.text;
  if (text.trim() !== "" && text !== ed.hist[ed.hist.length - 1]) {
    ed.hist.push(text);
  }
  Object.assign(ed, { text: "", pos: 0, at: ed.hist.length, draft: "", moved: false, tall: 1 });
  return text;
}
