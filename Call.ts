// Call
// ====
// A tool call as people read it. Logged as its tool's name, a space and its
// input's JSON (`zoom {"id":6243,"n":1}`; an MCP client's prefix,
// `mcp__unii__`, dropped), it shows on its device (its `device` field) as its
// emoji (Theme.TOOL), its name in bold and a head, as its tool reads (READS): a
// command as itself; a file tool its path, read's lines after it, write's
// content in a block, edit's files (the diff comes in its result); zoom and
// date the message (`#6243`, a line `#6243+8`, an agent by name); spawn its
// tasks, tell and computer their name and text in blocks; schedule its time
// (or cron) and zone, its message in a block. Any other call, or an
// edit whose edits are no list, shows its name and short values as arguments
// (`web_search "bend"`; short: JSON within SHORT chars, and a string without
// spaces or escapes), over a code block for each other value, keyed by its name
// unless alone. A call still streaming reads as its input so far: its open
// string and brackets closed, else up to its last whole field.
//
// An agent's report is logged as `[Name]` on its own line, its replies,
// and a line naming its whole chat (the model reads who sent it); it
// shows as its replies alone, framed and named by its agent.

import type * as Md from "./Md.ts";

// Types
// =====

// name: the bare tool name ("": no call), shown bold; head: the rest of
// its line (a command's lines); device: where it runs ("": none named)
export type Call = { name: string; head: string; device: string; blocks: Md.Code[] };

type Input = Record<string, unknown>;

type Shown = { head: string; blocks: Md.Code[] };

// Constants
// =========

const SHORT = 60;

const CALL = /^(\S+) (\{[\s\S]*)$/;

const MCP = /^mcp__.+?__/;

const READS = new Map<string, (x: Input) => Shown>([
  ["shell",    (x) => ({ head: String(x.command ?? ""), blocks: [] })],
  ["read",     (x) => ({ head: String(x.path ?? "") + lines_show(x.offset, x.limit), blocks: [] })],
  ["write",    (x) => ({ head: String(x.path ?? ""), blocks: [] })],
  ["edit",     (x) => (Array.isArray(x.edits) ? { head: edits_files(x.edits), blocks: [] } : input_shown(x))],
  ["zoom",     (x) => ({ head: msg_show(x.id, x.n) + (x.at === undefined ? "" : " from char " + x.at), blocks: [] })],
  ["date",     (x) => ({ head: msg_show(x.id, 1), blocks: [] })],
  ["spawn",    (x) => ({ head: tasks_show(x.tasks, x.effort), blocks: (Array.isArray(x.tasks) ? x.tasks : []).flatMap(text_block) })],
  ["tell",     (x) => ({ head: String(x.name ?? ""), blocks: text_block(x.message) })],
  ["computer", (x) => ({ head: "", blocks: text_block(x.task) })],
  ["schedule", (x) => ({ head: (x.cron === undefined ? String(x.at ?? "") : "cron " + x.cron) + " " + String(x.zone ?? ""), blocks: text_block(x.message) })],
]);

// Report
// ======

export type Report = { name: string; text: string };

export function report_text(name: string, text: string): string {
  return "[" + name + "]\n" + text + "\n\nFull chat: zoom(\"" + name + "\")";
}

export function report_read(text: string): Report | null {
  const m = /^\[([^\]\n]+)\]\s*([\s\S]*?)(?:\s*Full chat: zoom\("[^"\n]*"\))?\s*$/.exec(text);
  return m === null ? null : { name: m[1], text: m[2] };
}

// Parse
// =====

export function call_parse(text: string): Call {
  const m     = CALL.exec(text);
  const input = m === null ? null : input_parse(m[2]);
  if (m === null || input === null) {
    return { name: "", head: text, device: "", blocks: [] };
  }
  const name = m[1].replace(MCP, "");
  const { device, ...rest } = input;
  const shown = (READS.get(name) ?? input_shown)(rest);
  return { name, device: typeof device === "string" ? device : "", ...shown };
}

// the call on one line, after its name: its head, then each block,
// spaces folded, then its device
export function call_line(c: Call): string {
  const blocks = c.blocks.map((b) => (b.k === "" ? "" : b.k + ": ") + b.x);
  const where  = c.device === "" ? [] : ["· " + c.device];
  return [c.head, ...blocks, ...where].join(" ").replace(/\s+/g, " ").trim();
}

// the call as it shows, for Copy: its name and head, then each block
export function call_text(c: Call): string {
  return [(c.name + " " + c.head).trim(), ...c.blocks.map((b) => b.x)].join("\n");
}

// any tool's input: its short values as arguments, the rest in blocks
function input_shown(input: Input): Shown {
  const keys   = Object.keys(input);
  const args   : string[] = [];
  const blocks : Md.Code[] = [];
  for (const k of keys) {
    const v    = input[k];
    const json = JSON.stringify(v);
    const word = typeof v !== "string" || /^[^\s"\\]*$/.test(v);
    if (json.length <= SHORT && word) {
      args.push(json);
    } else {
      const x = typeof v === "string" ? v : JSON.stringify(v, null, 2);
      blocks.push({ $: "Code", k: keys.length > 1 ? k : "", x });
    }
  }
  return { head: args.join(" "), blocks };
}

// a text as a block ([]: none)
function text_block(x: unknown): Md.Code[] {
  return typeof x === "string" && x !== "" ? [{ $: "Code", k: "", x: x.replace(/\n$/, "") }] : [];
}

// the message or line zoom and date name: `#6243`, `#6243+8` (n > 1), an
// agent's name as is
function msg_show(id: unknown, n: unknown): string {
  const many = typeof n === "number" && n > 1 ? "+" + n : "";
  return typeof id === "number" ? "#" + id + many : String(id ?? "");
}

// a spawn's count of tasks, and its effort if named
function tasks_show(tasks: unknown, effort: unknown): string {
  const n = Array.isArray(tasks) ? tasks.length : 0;
  return n + (n === 1 ? " agent" : " agents") + (typeof effort === "string" ? " · " + effort : "");
}

// a read's lines, as path:4-7 shows them ("": the whole file)
function lines_show(offset: unknown, limit: unknown): string {
  const from = typeof offset === "number" ? offset : 1;
  const to   = typeof limit === "number" ? String(from + limit - 1) : "";
  return offset === undefined && limit === undefined ? "" : ":" + from + "-" + to;
}

// the files an edit's list names, each once
function edits_files(edits: unknown[]): string {
  const paths = edits.map((e: any) => e?.path).filter((p) => typeof p === "string");
  return [...new Set(paths)].join(", ");
}

// null: no JSON object, nor a prefix of one; `field`: where the input's
// last whole field ends (just after its "{" if none)
function input_parse(text: string): Record<string, unknown> | null {
  const shut: string[] = [];
  let quote = false;
  let esc   = false;
  let field = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      quote = esc || c !== '"';
      esc   = !esc && c === "\\";
    } else if (c === '"') {
      quote = true;
    } else if (c === "{" || c === "[") {
      shut.push(c === "{" ? "}" : "]");
      field = shut.length === 1 ? i + 1 : field;
    } else if (c === "}" || c === "]") {
      shut.pop();
    } else if (c === "," && shut.length === 1) {
      field = i;
    }
  }
  const open = quote ? (esc ? text.slice(0, -1) : text) + '"' : text;
  const full = open.replace(/[\s,]*$/, "") + shut.reverse().join("");
  return object_parse(full) ?? object_parse(text.slice(0, field) + "}");
}

// null: no JSON object
function object_parse(text: string): Record<string, unknown> | null {
  try {
    const x = JSON.parse(text);
    return typeof x === "object" && x !== null && !Array.isArray(x) ? x : null;
  } catch {
    return null;
  }
}
