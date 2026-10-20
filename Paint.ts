// Paint
// =====
// The terminal's emitter: View's rows, pick and tabs as lines of
// styled runs, and a line as ANSI (Theme's ink as the text, any other
// dimmed; fills and diffs in the terminal's own palette, Theme.ANSI).
// `rows_lines` lays rows out as the site: what the machine wrote
// filled (Theme.FILLED), half blocks rounding the fill's top and
// bottom: a block, its level in a gutter, its summary and its first
// message's id (`#6840`, for /open); a tool call, its emoji and verb
// bold, its device dimmed; its result its own fill. The user's words
// framed, unnamed; an agent's report framed, its name on the top edge
// (Theme.FRAMED); Unii's words bare. An open block
// framed, its bar in the frame's top edge; code filled (a call's, framed
// on the call's fill); a file's lines
// (a read, a diff) framed, the file on the top edge, each numbered. Control
// characters never reach the terminal.

import type { Kind } from "./AskAI.ts";
import * as Call from "./Call.ts";
import type * as Md from "./Md.ts";
import * as Theme from "./Theme.ts";
import * as View from "./View.ts";

// Types
// =====

// an ink: dim, bold, italic, underlined, a link's url ("": none), its
// color and its fill (an ANSI palette index "0"-"15", or "": the
// terminal's own)
type Ink = { d: boolean; b: boolean; i: boolean; u: boolean; k: string; c: string; g: string };

// text in an ink
export type Run = { x: string; s: Ink };

export type Line = Run[];

// Constants
// =========

export const INK: Ink = { d: false, b: false, i: false, u: false, k: "", c: "", g: "" };
export const DIM: Ink = { ...INK, d: true };

// a diff line's ink, by its mark
const MARK: Record<Md.Line["s"], Ink> = { " ": DIM, "-": { ...INK, c: Theme.ANSI.del }, "+": { ...INK, c: Theme.ANSI.add } };

// the gutter of a block: its level, and the space after it
const GUTTER = 7;

const GRAPHEMES = new Intl.Segmenter("en", { granularity: "grapheme" });

// Constructors
// ============

export function Run(x: string, s: Ink = INK): Run {
  return { x, s };
}

// Text
// ====

export function text_width(s: string): number {
  return Bun.stringWidth(s);
}

// text on one line, without control characters: newlines as spaces,
// tabs as two
export function text_clean(s: string): string {
  return s.replace(/\t/g, "  ").replace(/\n/g, " ").replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

export function text_graphemes(s: string): string[] {
  return [...GRAPHEMES.segment(s)].map((g) => g.segment);
}

// Line
// ====

// runs into lines of w columns: prose breaks between words (the space at a
// break dropped), code (hard) and a word wider than a line at any character; a
// link never (the terminal wraps it: indented pieces can't be clicked or
// copied). A run that fits in the rest of its line goes whole, unless it would
// start a line that a break began.
export function runs_wrap(runs: Line, w: number, hard: boolean): Line[] {
  const out: Line[] = [[]];
  let col = 0;
  for (const r of runs) {
    const whole  = col + text_width(r.x) <= w && (col > 0 || out.length === 1);
    const pieces = whole ? [r.x] : hard ? text_graphemes(r.x) : r.x.split(/(\s+)/).flatMap((p) => (text_width(p) <= w || /^https?:\/\//.test(p) ? [p] : text_graphemes(p)));
    for (const p of pieces) {
      const pw = text_width(p);
      if (col > 0 && col + pw > w) {
        out.push([]);
        col = 0;
      }
      if (!(!hard && /^\s+$/.test(p) && col === 0 && out.length > 1)) {
        out[out.length - 1].push(Run(p, r.s));
        col += pw;
      }
    }
  }
  return out;
}

function line_width(l: Line): number {
  return l.reduce((n, r) => n + text_width(r.x), 0);
}

// a line as ANSI: an ink's codes only where the ink changes (a link open
// over all its runs), back to the plain ink at its end; its end's spaces
// dropped unless filled
export function line_ansi(l: Line): string {
  let out = "";
  let was: Ink | null = null;
  for (const r of l) {
    out += ink_ansi(was, r.s) + r.x;
    was = r.s;
  }
  return (was?.g ? out : out.trimEnd()) + ink_ansi(was, INK);
}

// the codes that change ink was (null: a line's start) to s
function ink_ansi(was: Ink | null, s: Ink): string {
  if (was !== null && was.d === s.d && was.b === s.b && was.i === s.i && was.u === s.u && was.k === s.k && was.c === s.c && was.g === s.g) {
    return "";
  }
  const end  = was !== null && was.k !== "" ? "\x1b]8;;\x1b\\" : "";
  const sgr  = "\x1b[0" + (s.b ? ";1" : "") + (s.i ? ";3" : "") + (s.u ? ";4" : "") + (s.d ? ";2" : "") + color_sgr(38, s.c) + color_sgr(48, s.g) + "m";
  const link = s.k === "" ? "" : "\x1b]8;;" + s.k + "\x1b\\";
  return end + sgr + link;
}

// a palette color as the SGR that sets it (at 38: the text, 48: the
// fill; "": none), its basic code (30-37/90-97 or 40-47/100-107)
function color_sgr(at: number, c: string): string {
  if (c === "") {
    return "";
  }
  const i = Number(c);
  return ";" + (at - 8 + (i < 8 ? i : 60 + i - 8));
}

// lines on a fill iw columns wide inside, a column of it each side, a
// half block above and below; a run without its color in the ink, so the
// text reads on any terminal's background
function fill_lines(body: Line[], iw: number): Line[] {
  const g    = Theme.ANSI.block;
  const pad  = { ...INK, g };
  const edge = (c: string) => [Run(c.repeat(Math.max(0, iw + 2)), { ...INK, c: g })];
  const ink  = (r: Run) => Run(r.x, { ...r.s, g, c: r.s.c || Theme.ANSI.ink });
  const mid  = body.map((l) => [Run(" ", pad), ...l.map(ink), Run(" ".repeat(Math.max(0, iw - line_width(l))) + " ", pad)]);
  return [edge("▄"), ...mid, edge("▀")];
}

// lines in a frame iw columns wide inside, a title in its top edge, cut
// at the edge's end
function frame_lines(body: Line[], iw: number, edge: Ink, title: Line): Line[] {
  const head = runs_wrap(title, iw + 1, true)[0];
  const bar  = "─".repeat(Math.max(0, iw + 1 - line_width(head)));
  const top  = [Run("╭─", edge), ...head, Run(bar + "╮", edge)];
  const end  = [Run("╰" + "─".repeat(Math.max(0, iw + 2)) + "╯", edge)];
  const pad  = (l: Line) => Run(" ".repeat(Math.max(0, iw - line_width(l))));
  const mid  = body.map((l) => [Run("│ ", edge), ...l, pad(l), Run(" │", edge)]);
  return [top, ...mid, end];
}

// each x's lines, a blank line between each two
function lines_join<T>(xs: T[], f: (x: T) => Line[]): Line[] {
  return xs.flatMap((x, k) => (k === 0 ? f(x) : [[], ...f(x)]));
}

// Row
// ===

// rows a blank line apart: one block per message, in its order
export function rows_lines(rows: View.Row[], w: number): Line[] {
  return rows.flatMap((row, k) => [...(k > 0 ? [[]] : []), ...row_lines(row, w), ...images_lines(row)]);
}

// the names of a message's images, a dim line each
function images_lines(row: View.Row): Line[] {
  const names = row.$ === "Msg" ? row.images : [];
  return names.map((name) => [Run("  [image " + name + "]", DIM)]);
}

function row_lines(row: View.Row, w: number): Line[] {
  switch (row.$) {
    case "Sum": {
      const head = row.call === null ? [] : verb_runs(row.call);
      const text = row.call === null ? row.text : Call.call_line(row.call);
      return fill_lines(sum_lines(row.id, row.n, head, text, w - 2), w - 2);
    }
    case "Box": {
      const bar = [Run(" " + row.n + "x · /close " + View.block_name(row.id, row.n) + " ", { ...DIM, b: true })];
      return frame_lines(rows_lines(row.rows, w - 4), w - 4, DIM, bar);
    }
    case "Msg": {
      return row.call === null ? msg_lines(row.kind, row.who, row.body, w) : fill_lines(call_lines(row.call, w - 2), w - 2);
    }
    case "Cap": {
      return runs_wrap([Run(text_clean(row.text), { ...DIM, i: true })], w, false);
    }
  }
}

// a block's summary (a tool call's: after its glyph and verb); the
// command that opens it ends its last line, else has a line of its own:
// copied whole, never split by a wrap
function sum_lines(id: number, n: number, head: Line, text: string, w: number): Line[] {
  const room = w - GUTTER - 2;
  const cmd  = Run("/open " + View.block_name(id, n), DIM);
  const rows = runs_wrap([...head, Run(text_clean(text))], room, false);
  const last = rows.pop() ?? [];
  const ends = line_width(last) + 2 + text_width(cmd.x) <= room ? [[...last, Run("  "), cmd]] : [last, [cmd]];
  const lvl  = { ...DIM, b: true };
  return [...rows, ...ends].map((l, k) => [Run(" " + (k === 0 ? n + "x" : "").padEnd(GUTTER), lvl), ...l]);
}

// a message as its kind looks: a call filled; a result bare, its lines
// framed as a file's (Md.md_output), the frame naming them; a person's
// words (the user's, a report) framed in ink (the user's in blue),
// Unii's and a note framed dim, each named on its top; thinking bare,
// its name over it; all at the left, the column's width; none framed
// nor filled without text (images alone)
function msg_lines(kind: Kind, who: string, body: Md.Block[], w: number): Line[] {
  const look = Theme.KIND[kind];
  const ink  = { ...INK, d: look.dim, i: look.it };
  if (body.length === 0) {
    return [];
  }
  if (Theme.FILLED.includes(kind)) {
    return fill_lines(blocks_lines(body, w - 2, ink), w - 2);
  }
  if (Theme.FRAMED.includes(kind)) {
    const edge = kind === "user" ? { ...INK, c: Theme.ANSI.you } : INK;
    return frame_lines(blocks_lines(body, w - 4, ink), w - 4, edge, who === "" ? [] : [Run(" " + who + " ", { ...edge, b: true })]);
  }
  const name = who === "" ? [] : [[Run(who, { ...DIM, b: true })]];
  return [...name, ...blocks_lines(body, w, ink)];
}

// a tool call: its glyph and verb, its head after them if it fits on
// that line, else under it (a command's lines), its device dimmed at the
// line's right end; over its blocks
function call_lines(c: Call.Call, w: number): Line[] {
  const verb  = verb_runs(c);
  const where = c.device === "" ? [] : [Run(c.device, DIM)];
  const one   = !c.head.includes("\n") && line_width(verb) + text_width(c.head) + 2 + line_width(where) <= w;
  const top   = one ? [...verb, Run(text_clean(c.head))] : verb;
  const gap   = Run(" ".repeat(Math.max(1, w - line_width(top) - line_width(where))));
  const heads = one || c.head === "" ? [] : c.head.split("\n").flatMap((l) => runs_wrap([Run(text_clean(l))], w, true));
  return [[...top, gap, ...where], ...heads, ...c.blocks.flatMap((b) => code_lines(b.k, b.x, w, DIM, false))];
}

// a call's emoji and name, bold
function verb_runs(c: Call.Call): Line {
  const ink = { ...INK, b: true };
  return [Run(Theme.tool_glyph(c.name) + " ", ink), ...(c.name === "" ? [] : [Run(c.name + " ", ink)])];
}

// Block
// =====

function blocks_lines(blocks: Md.Block[], w: number, ink: Ink): Line[] {
  return lines_join(blocks, (b) => block_lines(b, w, ink));
}

function block_lines(b: Md.Block, w: number, ink: Ink): Line[] {
  switch (b.$) {
    case "Para": {
      return b.x.flatMap((spans) => runs_wrap(spans_runs(spans, ink), w, false));
    }
    case "Head": {
      return runs_wrap(spans_runs(b.x, { ...ink, b: true }), w, false);
    }
    case "Code": {
      return code_lines(b.k, b.x, w, ink, true);
    }
    case "Rule": {
      return [[Run("─".repeat(Math.max(0, w)), DIM)]];
    }
    case "Quot": {
      return blocks_lines(b.x, w - 2, { ...ink, d: true }).map((l) => [Run("│ ", DIM), ...l]);
    }
    case "List": {
      const items = b.x.map((item, k) => item_lines(item, b.k ? b.n + k + ". " : "• ", b.t, w, ink));
      return b.t ? items.flat() : lines_join(items, (x) => x);
    }
    case "Tabl": {
      return table_lines(b.x, w, ink);
    }
    case "Diff": {
      return diff_lines(b.k, b.x, w);
    }
    case "File": {
      return file_lines(b.k, b.n, b.x, w);
    }
  }
}

// a list's item: its mark, its blocks hung after it; a loose list's a
// blank line apart, as its items are
function item_lines(blocks: Md.Block[], mark: string, tight: boolean, w: number, ink: Ink): Line[] {
  const mw   = text_width(mark);
  const rows = tight ? blocks.flatMap((b) => block_lines(b, w - mw, ink)) : blocks_lines(blocks, w - mw, ink);
  return (rows.length === 0 ? [[]] : rows).map((l, k) => [Run(k === 0 ? mark : " ".repeat(mw), ink), ...l]);
}

// code: its label (a key, a language) over its lines, on a fill (a
// message's) or in a frame (a call's, already on a fill)
function code_lines(label: string, text: string, w: number, ink: Ink, fill: boolean): Line[] {
  const code = { ...INK, d: ink.d };
  const iw   = fill ? w - 2 : w - 4;
  const head = label === "" ? [] : [[Run(label, { ...ink, d: true })]];
  const body = text.split("\n").flatMap((l) => runs_wrap([Run(text_clean(l), code)], iw, true));
  return [...head, ...(fill ? fill_lines(body, iw) : frame_lines(body, iw, code, []))];
}

// a diff: framed, its file and its lines added and dropped in the top
// edge; each line its number (dimmed), its mark and its text in the
// mark's ink, hung after the number; a ⋯ between hunks
function diff_lines(file: string, hunks: Md.Line[][], w: number): Line[] {
  const all   = hunks.flat();
  const adds  = all.filter((l) => l.s === "+").length;
  const dels  = all.filter((l) => l.s === "-").length;
  const nw    = all.reduce((w, l) => Math.max(w, String(l.n).length), 0);
  const title = [Run(" " + text_clean(file) + " ", { ...INK, b: true }), Run("+" + adds, MARK["+"]), Run(" "), Run("-" + dels, MARK["-"]), Run(" ")];
  const line  = (l: Md.Line) => runs_wrap([Run(text_clean(l.x), MARK[l.s])], w - nw - 7, true).map((r, k) => [Run((k === 0 ? String(l.n) : "").padStart(nw) + " ", DIM), Run((k === 0 ? l.s : " ") + " ", MARK[l.s]), ...r]);
  const gap   = [[Run(" ".repeat(nw) + " ⋯", DIM)]];
  const body  = hunks.flatMap((h, k) => [...(k === 0 ? [] : gap), ...h.flatMap(line)]);
  return frame_lines(body, w - 4, DIM, title);
}

// a read's lines: framed as a diff is, the lines shown in the top edge;
// each line its number (dimmed) and its text, hung after the number
function file_lines(shown: string, from: number, lines: string[], w: number): Line[] {
  const nw    = String(from + lines.length - 1).length;
  const title = [Run(" " + text_clean(shown) + " ", { ...INK, b: true })];
  const line  = (x: string, k: number) => runs_wrap([Run(text_clean(x))], w - nw - 5, true).map((r, j) => [Run((j === 0 ? String(from + k) : "").padStart(nw) + " ", DIM), ...r]);
  return frame_lines(lines.flatMap(line), w - 4, DIM, title);
}

// a table: columns as wide as their widest cell, the head bold, a rule
// between rows (as the web's). Too wide, the columns share the width
// (table_fit) and each cell wraps in its column.
function table_lines(rows: Md.Span[][][], w: number, ink: Ink): Line[] {
  const cells  = rows.map((row, k) => row.map((c) => spans_runs(c, { ...ink, b: k === 0 })));
  const cols   = cells.reduce((n, row) => Math.max(n, row.length), 0);
  const want   = Array.from({ length: cols }, (_, c) => cells.reduce((n, row) => Math.max(n, line_width(row[c] ?? [])), 0));
  const widths = table_fit(want, w - 2 * (cols - 1));
  const rule   = [Run("─".repeat(Math.max(0, Math.min(w, widths.reduce((a, b) => a + b + 2, -2)))), DIM)];
  return cells.flatMap((row, k) => (k === 0 ? row_lines(row) : [rule, ...row_lines(row)]));
  function row_lines(row: Line[]): Line[] {
    const wrap = widths.map((cw, c) => runs_wrap(row[c] ?? [], cw, false));
    const tall = wrap.reduce((n, x) => Math.max(n, x.length), 0);
    return Array.from({ length: tall }, (_, k) => wrap.flatMap((x, c) => cell_line(x[k] ?? [], widths[c])));
  }
  function cell_line(l: Line, cw: number): Line {
    return [...l, Run(" ".repeat(Math.max(0, cw - line_width(l)) + 2))];
  }
}

// columns' widths in w: each its want if all fit; else, narrowest first,
// each at most an equal share of the width the ones before left
function table_fit(want: number[], w: number): number[] {
  const order = want.map((_, c) => c).sort((a, b) => want[a] - want[b]);
  const out   = [...want];
  let left = w;
  for (const [k, c] of order.entries()) {
    out[c] = Math.max(1, Math.min(want[c], Math.floor(left / (order.length - k))));
    left  -= out[c];
  }
  return out;
}

// Span
// ====

function spans_runs(spans: Md.Span[], ink: Ink): Line {
  return spans.map((s) => span_run(s, ink));
}

function span_run(s: Md.Span, ink: Ink): Run {
  const x = text_clean(s.x);
  switch (s.$) {
    case "Text":
    case "Code": {
      return Run(x, ink);
    }
    case "Bold": {
      return Run(x, { ...ink, b: true });
    }
    case "Ital": {
      return Run(x, { ...ink, i: true });
    }
    case "Link": {
      return Run(x, { ...ink, u: true, k: text_clean(s.k) });
    }
    case "Name": {
      return Run("[" + x + "]", { ...ink, b: true, u: true });
    }
  }
}

// Bars
// ====

// the rule over the input, the pick and the balance at its right end
export function rule_line(v: View.View, w: number): Line {
  const parts = [...View.view_pick(v).map((knob) => knob.text), View.view_credits(v) ?? []].flat();
  return rule_text(parts.join(" · "), w);
}

// a rule, a text at its right end ("": none)
export function rule_text(text: string, w: number): Line {
  const tag = text === "" ? "" : " " + text + " ";
  return [Run("─".repeat(Math.max(0, w - text_width(tag) - 1)) + tag + "─", DIM)];
}

// the last line, w wide: a tab for UniiChat and each agent at work, the
// shown bold; with agents, the key that moves along them, if it fits
export function tabs_line(v: View.View, w: number): Line {
  const tabs = View.view_tabs(v).map((tab) => Run(tab.text, tab.here ? { ...INK, b: true } : DIM));
  const line = tabs.flatMap((r, k) => (k === 0 ? [r] : [Run("  "), r]));
  const hint = [Run("  · Tab to cycle", DIM)];
  return tabs.length > 1 && line_width([...line, ...hint]) <= w ? [...line, ...hint] : line;
}
