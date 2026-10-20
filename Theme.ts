// Theme
// =====
// The colors and glyphs of both views: black ink on white paper, the
// same look in both. What the machine wrote is filled, what a person or
// Unii said is framed: a block (a summary) and a tool call sit on the
// `block` gray; every result is a file's lines (a read's, a write's or
// edit's diff, any other output's): framed, its name on the top edge,
// each line numbered; the user's message and
// a report sit in a frame; Unii's answer, its thinking and a note are bare.
// A call is named by its tool, a report or note by WHO; thinking
// is unnamed, told by its faint italic. Every tool
// is in ink, its emoji telling it at a glance (TOOL); a diff's lines are
// green and red. The web's colors are style.css's palette, light or dark
// by the device's setting; each kind's look reaches it as variables
// (theme_css). The terminal paints no color of its own, only
// its own palette's (ANSI: text in its foreground, a fill in its gray),
// so it fits any theme, light or dark.

import type { Kind } from "./AskAI.ts";

// Types
// =====

// a kind of message's look: whether dim (the secondary ink), whether in
// italics
type Look = { dim: boolean; it: boolean };

// Constants
// =========

// the terminal's fill and the text on it ("7": its light gray, "0": its
// black), a diff's lines ("2": its green, "1": its red), as ANSI
// palette colors, so they follow the terminal's theme
export const ANSI = { block: "7", ink: "0", add: "2", del: "1", you: "4" };

// what a message is, named on its top (a report's frame edge, a note's
// first line; a result names itself on its frame's edge; a report: its agent's name, else this; a
// call: its tool). The user's words (framed) and Unii's (bare) need none
export const WHO: Record<string, string> = { work: "Report", note: "Note" };

export const KIND: Record<Kind, Look> = {
  user : { dim: false, it: false },
  work : { dim: false, it: false },
  unii : { dim: false, it: false },
  tool : { dim: true, it: false },
  echo : { dim: true, it: false },
  note : { dim: true, it: true },
  mind : { dim: true, it: true },
};

// the kinds filled (the machine's); framed (the user's, an agent's); the
// rest (Unii's, thinking, notes) bare, any name over it
export const FILLED: Kind[] = ["tool"];
export const FRAMED: Kind[] = ["user", "work"];

// each tool's emoji, in both views; any other's is TOOL_ANY
export const TOOL: Record<string, string> = {
  zoom       : "🔍",
  date       : "📅",
  shell      : "⌨️",
  read       : "📖",
  write      : "📄",
  edit       : "📝",
  spawn      : "🤖",
  tell       : "💬",
  computer   : "🖱️",
  schedule   : "⏰",
  schedules  : "⏰",
  unschedule : "⏰",
};
export const TOOL_ANY = "🔧";

export const GLYPH = {
  tab   : "◯",  // a chat's tab
  here  : "●",  // the tab of the chat shown
  input : "> ", // each line of the message typed
  open  : "▾",  // an open block's bar
};

export function tool_glyph(name: string): string {
  return TOOL[name] ?? TOOL_ANY;
}

// Css
// ===

export function theme_css(): string {
  return Object.entries(KIND).map(([k, look]) => look_css(k, look)).join("");
}

function look_css(kind: string, look: Look): string {
  const ink   = look.dim ? "mid" : "ink";
  const style = look.it ? "italic" : "normal";
  const body  = "--fg:var(--" + ink + ");--it:" + style;
  return ".msg." + kind + "{" + body + "}";
}
