// Md
// ==
// The little markdown a message uses, as tokens both views draw (Html.ts,
// Paint.ts): fenced code, headings, rules, quotes, lists, tables,
// paragraphs; inline code, links, bold, italics, and agent names
// (`[FireAnt]`, linked to its chat). `md_plain` reads text as it is:
// paragraphs, lines and names only. `md_output` reads a tool's result
// as a file's lines: a read's as its lines, a unified diff (Machine.ts
// writes them, git too) as its file and hunks, any other text as lines
// named "result", so every result looks as a read does. Tokens hold
// raw text; each emitter escapes it. A block is read by its first line
// and runs while the next pass its test. A span is the first mark at its
// point.

import * as Names from "./Names.ts";

// Types
// =====

export type Span =
  | { $: "Text"; x: string }            // x
  | { $: "Code"; x: string }            // `x`
  | { $: "Bold"; x: string }            // **x**
  | { $: "Ital"; x: string }            // *x*
  | { $: "Link"; x: string; k: string } // [x](k) (k: a url or a /path), or a bare url
  | { $: "Name"; x: string }            // [x]: an agent, x its name

// k: a label, or ""
export type Code = { $: "Code"; k: string; x: string }; // ```k x ```

// a line of a diff: kept (" "), dropped ("-") or added ("+"), its number
// in the old file if dropped, else in the new one
export type Line = { s: " " | "-" | "+"; n: number; x: string };

export type Block =
  | { $: "Para"; x: Span[][] }             // its lines
  | { $: "Head"; k: number; x: Span[] }    // # x (k: the level, 1 to 6)
  | Code
  | { $: "Rule" }                          // ---
  | { $: "Quot"; x: Block[] }              // > x
  | { $: "List"; k: boolean; n: number; t: boolean; x: Block[][] } // - x (k: numbered, 1. x, from n; t: tight; each item its blocks)
  | { $: "Tabl"; x: Span[][][] }           // | x | (rows of cells; 1st: head)
  | { $: "Diff"; k: string; x: Line[][] }  // --- k, +++ k, then hunks (@@ -1,2 +1,3 @@)
  | { $: "File"; k: string; n: number; x: string[] } // a file's lines x, from line n, named k (a read's "lines 4-7 of 15", else "result")

// Constants
// =========

const NAME  = new RegExp("\\[(" + Names.NAME + ")\\]", "g");
const SPAN  = new RegExp([
  /`([^`\n]+)`/.source,
  /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|\/(?!\/)[^\s)]*)\)/.source,
  NAME.source,
  /\*\*([^*\n]+)\*\*/.source,
  /(?<![*\w])\*([^*\s][^*\n]*?)\*(?![\w*])/.source,
  /(?<![^\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/.source,
].join("|"), "g");
const LIST  = /^ {0,3}([-*+]|\d{1,9}[.)])(?=[ \t]|$)/;
const FENCE = /^\s*```/;
const HEAD  = /^(#{1,6})\s+(.*)$/;
const RULE  = /^\s*([-*_])(\s*\1){2,}\s*$/;
const QUOT  = /^\s*>\s?/;
const ROW   = /^\s*\|.*\|\s*$/;
const BAR   = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;
const NEW   = /^\+\+\+ (.*)$/;
const READ  = /^\[(lines (\d+)-\d+ of \d+[^\]]*)\]$/;
const HUNK  = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const MARKS = /^(?:\s*(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)|\s*>\s?)*/;

// how many lists and quotes deep a list is still read (past it, its
// lines are text: a list in a list costs every line under it a copy)
const DEEP  = 16;

// Constructors
// ============

export function Text(x: string): Span {
  return { $: "Text", x };
}

export function Name(x: string): Span {
  return { $: "Name", x };
}

// Parse
// =====

// the text between the matches of re, and each match as mark reads it
function spans_by(s: string, re: RegExp, mark: (m: RegExpMatchArray) => Span): Span[] {
  const out: Span[] = [];
  let at = 0;
  for (const m of s.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > at) {
      out.push(Text(s.slice(at, i)));
    }
    out.push(mark(m));
    at = i + m[0].length;
  }
  if (at < s.length) {
    out.push(Text(s.slice(at)));
  }
  return out;
}

export function span_parse(s: string): Span[] {
  return spans_by(s, SPAN, span_mark);
}

function span_mark(m: RegExpMatchArray): Span {
  if (m[1] !== undefined) {
    return { $: "Code", x: m[1] };
  }
  if (m[2] !== undefined) {
    return { $: "Link", x: m[2], k: m[3] };
  }
  if (m[4] !== undefined) {
    return Name(m[4]);
  }
  if (m[5] !== undefined) {
    return { $: "Bold", x: m[5] };
  }
  if (m[6] !== undefined) {
    return { $: "Ital", x: m[6] };
  }
  return { $: "Link", x: m[7], k: m[7] };
}

// a line's text, its marks dropped (a summary is plain text: View.ts)
export function md_flat(s: string): string {
  return span_parse(s).map((span) => span.x).join("");
}

export function md_plain(s: string): Block[] {
  const paras = s.replace(/\r/g, "").split(/\n(?:[ \t]*\n)+/);
  const kept = paras.filter((p) => p.trim() !== "");
  return kept.map((p) => ({ $: "Para", x: p.split("\n").map(plain_line) }));
}

function plain_line(s: string): Span[] {
  return spans_by(s, NAME, (m) => Name(m[1]));
}

// a tool's result: a read's lines a File, each unified diff in it a
// Diff, the text around them a File named "result" (none if blank)
export function md_output(s: string): Block[] {
  const lines = s.replace(/\r/g, "").split("\n");
  const read  = READ.exec(lines[lines.length - 1]);
  if (read !== null) {
    return [{ $: "File", k: read[1], n: Number(read[2]), x: lines.slice(0, -1) }];
  }
  const out: Block[] = [];
  let [i, at] = [0, 0];
  while (i < lines.length) {
    const [diff, next] = diff_parse(lines, i);
    if (diff !== null) {
      out.push(...output_lines(lines.slice(at, i)), diff);
      at = next;
    }
    i = next;
  }
  return [...out, ...output_lines(lines.slice(at))];
}

// a result's text as a File named "result", its blank lines at either
// end dropped; none if all blank
function output_lines(lines: string[]): Block[] {
  const from = lines.findIndex((l) => l.trim() !== "");
  const upto = lines.findLastIndex((l) => l.trim() !== "");
  return from < 0 ? [] : [{ $: "File", k: "result", n: 1, x: lines.slice(from, upto + 1) }];
}

// null: no diff starts at line i (its "---" and "+++" lines, then hunks,
// each exactly as long as its header counts); and the line after it
function diff_parse(lines: string[], i: number): [Block | null, number] {
  const file  = NEW.exec(lines[i + 1] ?? "");
  const hunks : Line[][] = [];
  if (file === null || !lines[i].startsWith("--- ")) {
    return [null, i + 1];
  }
  let j = i + 2;
  for (let h = HUNK.exec(lines[j] ?? ""); h !== null; h = HUNK.exec(lines[j] ?? "")) {
    const [hunk, next] = hunk_parse(lines, j + 1, h);
    if (hunk === null) {
      return [null, i + 1];
    }
    hunks.push(hunk);
    j = next;
  }
  return hunks.length === 0 ? [null, i + 1] : [{ $: "Diff", k: file[1], x: hunks }, j];
}

// null: the lines from j don't fill the header's counts
function hunk_parse(lines: string[], j: number, h: RegExpExecArray): [Line[] | null, number] {
  let [olds, news] = [Number(h[2] ?? 1), Number(h[4] ?? 1)];
  let [o, n] = [Number(h[1]), Number(h[3])];
  const out: Line[] = [];
  for (; olds > 0 || news > 0; j++) {
    const s = lines[j]?.[0];
    const x = lines[j]?.slice(1) ?? "";
    if (s === " " && olds > 0 && news > 0) {
      out.push({ s, n: n++, x });
      [o, olds, news] = [o + 1, olds - 1, news - 1];
    } else if (s === "-" && olds > 0) {
      out.push({ s, n: o++, x });
      olds--;
    } else if (s === "+" && news > 0) {
      out.push({ s, n: n++, x });
      news--;
    } else if (s !== "\\") {
      return [null, j];
    }
  }
  return [out, j];
}

export function md_parse(src: string): Block[] {
  return blocks_parse(src.replace(/\r/g, "").split("\n"), 0)[0];
}

// the blocks of lines d lists or quotes deep, and whether a blank line
// parts two of them (a list item's: a loose list)
function blocks_parse(lines: string[], d: number): [Block[], boolean] {
  const out: Block[] = [];
  let [i, gap, apart] = [0, false, false];
  while (i < lines.length) {
    const [block, next] = block_parse(lines, i, d);
    if (block === null) {
      gap = out.length > 0;
    } else {
      [apart, gap] = [apart || gap, false];
      out.push(block);
    }
    i = next;
  }
  return [out, apart];
}

// null: a blank line; and the line after the block
function block_parse(lines: string[], i: number, d: number): [Block | null, number] {
  const line = lines[i];
  const head = HEAD.exec(line);
  const runs = (test: (l: string, j: number) => boolean) => lines_run(lines, i, test);
  if (line.trim() === "") {
    return [null, i + 1];
  }
  if (FENCE.test(line)) {
    const end = runs((l) => !FENCE.test(l));
    const k = line.trim().slice(3).trim();
    const x = lines.slice(i + 1, end).join("\n");
    return [{ $: "Code", k, x }, end + 1];
  }
  if (head !== null) {
    const x = span_parse(head[2]);
    return [{ $: "Head", k: head[1].length, x }, i + 1];
  }
  if (RULE.test(line)) {
    return [{ $: "Rule" }, i + 1];
  }
  if (QUOT.test(line)) {
    const end = runs((l) => QUOT.test(l));
    const body = lines.slice(i, end).map((l) => l.replace(QUOT, ""));
    return [{ $: "Quot", x: blocks_parse(body, d + 1)[0] }, end];
  }
  if (list_kind(line) !== null && d < DEEP) {
    return list_parse(lines, i, d);
  }
  if (ROW.test(line) && BAR.test(lines[i + 1] ?? "")) {
    const end = lines_run(lines, i + 1, (l) => ROW.test(l));
    const rows = [line, ...lines.slice(i + 2, end)];
    return [{ $: "Tabl", x: rows.map(row_cells) }, end];
  }
  const end = runs((l, j) => l.trim() !== "" && !block_starts(lines, j));
  const x = lines.slice(i, end).map(span_parse);
  return [{ $: "Para", x }, end];
}

// a list: its items, of one kind (one bullet, or one number's end).
// An item runs on over the lines as far in as its text (its paragraphs,
// its sub-lists), blank lines between them too, and over the lines
// right under its paragraph that start no block. It is tight but a
// blank line parts two items or two of an item's blocks. Numbered, it
// counts from its first item's number (GFM's list items and lists)
function list_parse(lines: string[], i: number, d: number): [Block, number] {
  const kind  = list_kind(lines[i]);
  const items : string[][] = [];
  let [end, w, blank, open, para, fenced, loose] = [i, 0, 0, true, false, false, false];
  for (let j = i; j < lines.length; j++) {
    const l  = untab(lines[j]);
    const at = indent(l);
    if (at === l.length) {
      [blank, para] = [blank + 1, false];
      continue;
    }
    if (list_kind(l) === kind && (items.length === 0 || at < w)) {
      const mark = LIST.exec(l)![0];
      const rest = l.slice(mark.length);
      const pad  = indent(rest);
      w     = mark.length + (rest.trim() === "" || pad > 4 ? 1 : pad);
      open  = rest.trim() !== "" || (lines[j + 1] ?? "").trim() !== "";
      loose = loose || (blank > 0 && items.length > 0);
      items.push([l.slice(w)]);
      [para, fenced] = item_line(l.slice(w), false);
    } else if (open && at >= w) {
      for (; blank > 0; blank--) {
        items[items.length - 1].push("");
      }
      items[items.length - 1].push(l.slice(w));
      [para, fenced] = item_line(l.slice(w), fenced);
    } else if (open && para && blank === 0 && !LIST.test(l) && !block_starts(lines, j)) {
      items[items.length - 1].push(l.trimStart());
    } else {
      break;
    }
    [blank, end] = [0, j + 1];
  }
  const first = LIST.exec(lines[i])![1];
  const k     = /\d/.test(first);
  const parts = items.map((x) => blocks_parse(x, d + 1));
  const t     = !loose && !parts.some((p) => p[1]);
  return [{ $: "List", k, n: k ? Number(first.slice(0, -1)) : 1, t, x: parts.map((p) => p[0]) }, end];
}

// an item's line s: whether a paragraph is open after it (a line under
// it can go on with it), and whether a fence is (fenced: before it)
function item_line(s: string, fenced: boolean): [boolean, boolean] {
  const x = RULE.test(s) ? "" : s.replace(MARKS, "");
  if (FENCE.test(x)) {
    return [false, !fenced];
  }
  return [!fenced && x.trim() !== "" && !HEAD.test(x) && !RULE.test(x) && !ROW.test(x), fenced];
}

// a line, the tabs in its indent and after its list marks as spaces, to
// the next 4th column
function untab(l: string): string {
  return l.replace(/^[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)*/, (pre) => [...pre].reduce((out, c) => out + (c === "\t" ? " ".repeat(4 - (out.length % 4)) : c), ""));
}

// a line's leading blanks
function indent(l: string): number {
  return l.search(/\S|$/);
}

function lines_run(lines: string[], i: number, test: (l: string, j: number) => boolean): number {
  let j = i + 1;
  while (j < lines.length && test(lines[j], j)) {
    j++;
  }
  return j;
}

// whether line j starts a block block_parse reads, but a paragraph: one
// ends a paragraph, a rule too ("---" right under a line), a table only
// with its bar under it, a list item only with text, numbered only at 1
function block_starts(lines: string[], j: number): boolean {
  const l = lines[j];
  const m = LIST.exec(l);
  const item = m !== null && l.slice(m[0].length).trim() !== "" && (!/\d/.test(m[1]) || Number(m[1].slice(0, -1)) === 1);
  return FENCE.test(l) || HEAD.test(l) || RULE.test(l) || QUOT.test(l) || item || (ROW.test(l) && BAR.test(lines[j + 1] ?? ""));
}

// a list item's kind: its bullet (-, *, +) or its number's end (., ));
// null: no item (a rule, as "- - -", is none). A list is of one kind
function list_kind(l: string): string | null {
  const m = LIST.exec(l);
  return m === null || RULE.test(l) ? null : m[1].slice(-1);
}

// a table row's cells, split at each | but an escaped one (\|)
function row_cells(line: string): Span[][] {
  const cells = line.trim().replace(/^\||(?<!\\)\|$/g, "").split(/(?<!\\)\|/);
  return cells.map((c) => span_parse(c.trim().replace(/\\\|/g, "|")));
}
