#!/usr/bin/env bun
// Term
// ====
// `unii`: a terminal view of the agent (Server.ts) and, while open, a
// device its tools reach (DEVICE). It feeds a View the server's messages
// and the person's acts, and prints what it says (Paint.ts, Screen.ts)
// into the terminal's own scrollback. Every act of the site is a command
// here (COMMANDS, /help). The agent's jobs run here (Machine.ts) until
// done or halted; all they left running dies as this unii quits. From a
// pipe, each line is a message.
//
// One executable per platform (the releases uniichat.com/install.sh
// installs); once a day it asks bend-lang.com's /check (update_check) and
// notes a newer one. `unii serve` runs the server it carries. The server:
// the url given, else $UNII_URL, else uniichat.com; each server's session
// is a file of its own (TOKEN).
//
// Usage: USAGE (`unii help` prints it).

import * as child from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import type { Kind } from "./AskAI.ts";
import * as Import from "./Import.ts";
import { Machine, WIN, type Job } from "./Machine.ts";
import * as Paint from "./Paint.ts";
import { type Move, Pick } from "./Pick.ts";
import * as Screen from "./Screen.ts";
import * as View from "./View.ts";

// Types
// =====

// the terminal: jobs running here; ended: input's; pending: commands at
// work; last: UniiChat's message printed last (-1: none); wait: parts up
// to it not printed (term_settle); out: lines to print; wipe: first;
// due: a paint; settle: the page's print at a new size; imgs: for the
// next message; flow: how much of each message streaming is printed
// (Infinity: logged); logs: of each agent's page, the messages printed
type Term = {
  v       : View.View;
  scr     : Screen.Screen;
  url     : string;
  jobs    : Map<string, AbortController>;
  ended   : boolean;
  pending : number;
  last    : number;
  wait    : View.Part[];
  out     : Paint.Line[];
  wipe    : boolean;
  due     : boolean;
  settle  : Timer | undefined;
  imgs    : Blob[];
  flow    : Map<View.Live, number>;
  logs    : Map<string, number>;
};

// a line of /help: how it is typed ("": keys only), its keys, what it
// does; it runs on its argument, or by a key on "" (or the key's name)
type Cmd = [use: string, keys: string, text: string, run: (t: Term, arg: string) => void | Promise<void>];

// Constants
// =========

// this unii's version: each release ships one, a new one for every
// change to Term.ts or what it imports
const VERSION = "1.0.138";

const ARGS   = process.argv.slice(2);
const LOGIN  = ARGS.includes("login");
const HELP   = ARGS.some((a) => ["help", "--help", "-h"].includes(a));
const ASKVER = ARGS.includes("version");
const UPDATE = ARGS.includes("update");
const SERVE  = ARGS.includes("serve");
const PORT   = SERVE ? ARGS.find((a) => /^\d+$/.test(a)) : undefined;
const WORDS  = ["login", "help", "--help", "-h", "version", "update", "serve"];
const WEB    = /^https?:\/\//;
const ODD    = ARGS.find((a) => !WORDS.includes(a) && !WEB.test(a) && a !== PORT);
const HOME   = process.env.UNII_HOME || os.homedir() + "/.unii";
const OURS   = "https://uniichat.com";
const SERVER = (ARGS.find((a) => WEB.test(a)) ?? process.env.UNII_URL ?? OURS).replace(/\/$/, "");
const HOST   = new URL(SERVER).host;
const TOKEN  = HOME + "/" + (WIN ? HOST.replaceAll(":", "_") : HOST) + "/token"; // no ":" in a Windows name

const USAGE = `Usage: unii [url]           the chat (url: $UNII_URL, else https://uniichat.com)
       unii login [url]     sign in
       unii update [url]    install the latest unii (curl | sh, shown first)
       unii version         this unii's version
       unii serve [port]    your own UniiChat server, at http://127.0.0.1:8788
                            (another port: set UNII_SITE to its address too),
                            on your ANTHROPIC_API_KEY and OPENAI_API_KEY;
                            chat with it: unii http://127.0.0.1:8788
       unii help            this
UNII_WORK: where the agent works on this computer (default
~/.unii/work). UNII_COMPUTER=1: it may use the screen. UNII_HOME: where
it keeps its sign-in (default ~/.unii).
Once a day, unii asks bend-lang.com for the latest version, sending only
its version, OS and CPU type, and whether this computer ever ran its own
server. UNII_NO_TELEMETRY=1 turns that off.
In the chat, /help lists every command and key.`;

// the daily version check: what it asks, its cache, and the self-host
// flag: a file made once this computer serves or opens a server not OURS
const CHECK   = "https://bend-lang.com/check?p=unii&v=" + VERSION + "&os=" + process.platform + "&arch=" + process.arch;
const CHECKED = HOME + "/check.json";
const SELF    = HOME + "/self";
const DAY     = 86400000;

// this device's name, as the agent sees it: on macOS its local host name
// (Bonjour's, unique on its network), else the host's
const LOCAL  = process.platform === "darwin" ? child.spawnSync("scutil", ["--get", "LocalHostName"]).stdout?.toString().trim() : "";
const DEVICE = LOCAL || os.hostname();

// where the agent's tools work on this device: in WORK/main (the agent)
// and WORK/<name> (each subagent)
const WORK = process.env.UNII_WORK || "~/.unii/work";

// whether the agent may use this device's screen, mouse and keyboard
const COMPUTER = process.env.UNII_COMPUTER === "1";

// the margin left of each line
const MARGIN = 2;

// a paint's frame: a stream's pieces come faster than a screen shows
// them (ms)
const FRAME = 16;

// a size held this long is settled: a drag's sizes come faster, and each
// would print the whole page again (ms)
const SETTLE = 100;

// where Claude Code and Codex keep their sessions
const CODEX   = process.env.CODEX_HOME ?? os.homedir() + "/.codex";
const IMPORTS = [
  (process.env.CLAUDE_CONFIG_DIR ?? os.homedir() + "/.claude") + "/projects",
  CODEX + "/sessions",
  CODEX + "/archived_sessions",
];

// what /import takes: its day; a site's export (its zip, or its
// conversations.json)
const SINCE  = /\bsince +(\d{4}-\d\d-\d\d)\b/;
const EXPORT = /\.(zip|json)$/i;
const HOW = "Pick with /import [claude] [chatgpt] [since 2026-06-01] [tools] [sessions] [-#n] [<export>.zip] [go] (-#n: not session n; go: import); /import pause or resume: the import running. Exports, on each website: " + Object.entries(Import.EXPORTS).map(([app, how]) => app + ": " + how).join("; ") + "; it emails you a zip.";

// how a terminal adds credit, said when a request is refused for want
// of it
const TOPUP = "Add credit with /topup <dollars> ($5 to $500).";

// the input's hint on an agent's page
const OFF = "Commands only: /help";

// the pick's moves by Shift and an arrow
const ARROWS: Record<string, Move> = { "Shift+Left": "prev", "Shift+Right": "next", "Shift+Up": "up", "Shift+Down": "down" };

// all a person can do here, by group (the editing keys are Screen's);
// credit added only where the server bills
function term_groups(v: View.View): [group: string, cmds: Cmd[]][] {
  const topup: Cmd[] = v.bills ? [["/topup <usd>", "", "add Bend Credits, paid in the browser", term_topup]] : [];
  return [
    ["Chat", [
      ["",                  "Enter",                   "send; on an empty input, interrupt UniiChat",    term_enter],
      ["",                  "Esc",                     "interrupt UniiChat's turn; agents go on",        (t) => term_act(t, { $: "Send", text: "" })],
      ["",                  "Ctrl+C, Ctrl+D",          "clear; on an empty input, interrupt, quit",      term_clear],
      ["/goal <message>",   "",                        "send a message as the goal: at each turn's end, UniiChat asks itself if it is met, and goes on till it is", (t, a) => term_act(t, { $: "Send", text: "/goal " + a })],
      ["/halt",             "",                        "drop the goal; the turn running ends as it would", (t) => term_act(t, { $: "Send", text: "/halt" })],
      ["/image <path>",     "",                        "attach an image to the next message",            term_image],
      ["/open #id",         "",                        "open block #id, as it shows, and keep it open",  (t, a) => term_block(t, a, true)],
      ["/close #id",        "",                        "close block #id and keep it closed",             (t, a) => term_block(t, a, false)],
      ["/fold",             "Ctrl+F",                  "the chat in the fewest blocks; again: unfold (Ctrl+F eaten? type /fold)", term_fold],
      ["/import [...]",     "",                        "import your Claude and ChatGPT chats (alone: options, costs)", term_import],
      ["/export",           "",                        "save memory and account as ./unii-memory.json",  term_export],
      ["/tree",             "",                        "the whole memory, in the browser (its link prints too)", (t) => term_browse(t, "The memory tree", t.url + "/tree")],
      ["",                  "Ctrl+Z",                  "suspend; fg brings it back",                     (t) => Screen.screen_suspend(t.scr)],
      ["/quit",             "",                        "leave: the chat goes on without this terminal",  term_quit],
      ["/help",             "",                        "this list",                                      term_help],
    ]],
    ["Pick", [
      ["",                  "Shift+Left, Shift+Right", "the model before, the next",                     (t, k) => term_move(t, ARROWS[k])],
      ["",                  "Shift+Up, Shift+Down",    "more effort, less",                              (t, k) => term_move(t, ARROWS[k])],
      ["",                  "Shift+Tab",               "fast on, off (the next speed), typing or not",   (t) => term_move(t, "speed")],
      ["/model [name]",     "",                        "the models to pick from; with a name, that one", (t, a) => term_pick(t, "model", a)],
      ["/effort [level]",   "",                        "the efforts; with one, that one",                (t, a) => term_pick(t, "effort", a)],
      ["/speed [speed]",    "",                        "the speeds; with one, that one",                 (t, a) => term_pick(t, "speed", a)],
    ]],
    ["Agents", [
      ["",                  "Tab",                     "the next tab",                                   term_cycle],
      ["/tab [name]",       "",                        "the tabs; with a name, that one",               term_tab],
      ["/stop [name]",      "",                        "stop all work, agents too; or that agent",       term_stop],
    ]],
    ["Account", [
      ...topup,
      ["/account",          "",                        "balance, top-ups, charges, calls",               term_account],
      ["/delete <name>",    "",                        "delete your account and chat (its name confirms)", term_delete],
      ["/logout",           "",                        "sign out and quit",                              term_logout],
    ]],
  ];
}

function term_commands(v: View.View): Cmd[] {
  return term_groups(v).flatMap(([, cmds]) => cmds);
}

// Term
// ====

function term_new(url: string): Term {
  const t: Term = {
    v       : View.view_new(),
    scr     : Screen.screen_new((key) => term_press(t, key)),
    url,
    jobs    : new Map(),
    ended   : false,
    pending : 0,
    last    : -1,
    wait    : [],
    out     : [],
    wipe    : false,
    due     : false,
    settle  : undefined,
    imgs    : [],
    flow    : new Map(),
    logs    : new Map(),
  };
  process.stdin.on("end", () => {
    if (t.scr.ed.text.trim() !== "") {
      term_enter(t);
    }
    t.ended = true;
    term_idle(t);
  });
  process.stdout.on("resize", () => term_resize(t));
  process.on("exit", Machine.end);
  for (const sig of ["SIGHUP", "SIGTERM", "SIGINT"]) {
    process.on(sig, () => term_bye(t));
  }
  return t;
}

// connects, by View's link, naming this device
function term_connect(t: Term): void {
  const dev = "&device=" + encodeURIComponent(DEVICE) + "&computer=" + (COMPUTER ? 1 : 0) + "&work=" + encodeURIComponent(WORK) + (WIN ? "&shell=PowerShell" : "");
  View.link_open(t.v, {
    open : (query) => new WebSocket(t.url.replace(/^http/, "ws") + "/ws" + query + dev, { headers: term_auth() } as any),
    post : (path, body) => fetch(t.url + path, { method: "POST", headers: term_auth(), body }),
    hear : (msg) => term_hear(t, msg),
    lost : (up) => term_lost(t, up),
  });
}

// a socket lost (up: it had opened): the footer says offline; one that
// never opened, if the server refuses this terminal's session, quits
async function term_lost(t: Term, up: boolean): Promise<boolean> {
  term_draw(t);
  if (!up && !await term_signed(t.url)) {
    term_note(t, "This terminal is signed out: run unii again to sign in.");
    process.exitCode = 1;
    term_quit(t);
    return false;
  }
  return true;
}

// an act to the server (a message shown while it waits offline); a
// message refused goes back in the input
function term_send(t: Term, msg: View.Client, sent?: View.Sent): void {
  const said = sent === undefined ? "" : sent.text.trim();
  View.link_send(t.v, msg, (a) => {
    if (a.error !== undefined) {
      term_note(t, term_refusal(a));
    }
    if (a.error !== undefined && sent !== undefined) {
      term_back(t, sent);
    }
    term_idle(t);
  }, said);
}

// a message of the server: to the view, then to the jobs and the page;
// the update note comes under the first view, where it is seen
function term_hear(t: Term, msg: View.Server): void {
  const first = msg.$ === "view" && t.v.parts.length === 0;
  const was   = t.v.page;
  for (const out of View.view_hear(t.v, msg)) {
    term_send(t, out);
  }
  term_went(t, was);
  if (msg.$ === "jobs" || msg.$ === "job") {
    term_jobs(t, msg);
    return;
  }
  term_print(t, msg);
  if (first) {
    term_history(t);
    update_check(t);
  }
  term_draw(t);
  if (msg.$ === "state") {
    term_idle(t);
  }
}

// an act of the person: to the view; the messages it sends the server
function term_act(t: Term, act: View.Act): View.Client[] {
  const was = t.v.page;
  const out = View.view_act(t.v, act);
  out.forEach((msg) => term_send(t, msg, act.$ === "Send" ? act : undefined));
  term_went(t, was);
  return out;
}

// a message the server refused, back in the input, unless another is in
// it; from a pipe, the end, failed
function term_back(t: Term, sent: View.Sent): void {
  if (!t.scr.tty) {
    process.exitCode = 1;
    term_quit(t);
    return;
  }
  if (t.scr.ed.text !== "" || t.imgs.length > 0) {
    return;
  }
  Screen.ed_type(t.scr.ed, sent.text);
  t.imgs = sent.images ?? [];
}

// the page shown was `was`: another prints below, after its name (a
// wipe and whole print took seconds on a long page)
function term_went(t: Term, was: View.Page | null): void {
  if (t.v.page !== was) {
    term_rows(t, t.v.page === null ? [View.Cap(View.MAIN)] : [], false);
    term_show(t);
  }
}

// the input's history: the user's messages known
function term_history(t: Term): void {
  const sent = [...t.v.whole].sort((a, b) => a[0] - b[0]).flatMap(([, e]) => (e.kind === "user" ? [e.text] : []));
  t.scr.ed.hist = sent;
  t.scr.ed.at   = sent.length;
}

// input's end: quits once all it sent is answered and no work runs
function term_idle(t: Term): void {
  if (t.ended && t.pending <= 0 && t.v.out.length === 0 && !View.view_running(t.v)) {
    term_quit(t);
  }
}

// Keys
// ----

// a key ("": text typed): its line of COMMANDS
function term_press(t: Term, key: string): void {
  const cmd = term_commands(t.v).find((c) => c[1] !== "" && c[1].split(", ").includes(key));
  if (cmd !== undefined) {
    cmd[3](t, cmd[0] === "" ? key : "");
  }
  term_draw(t);
}

// Enter: runs a command, or sends the input; text not sent stays (it
// was lost: an unknown /word)
function term_enter(t: Term): void {
  const text = Screen.ed_take(t.scr.ed);
  if (term_command(t, text)) {
    return;
  }
  if (!View.view_typing(t.v)) {
    term_note(t, "Messages go to UniiChat: Tab or /tab goes back.");
  } else if (term_act(t, { $: "Send", text, images: t.imgs }).length > 0) {
    t.imgs = [];
    return;
  }
  Screen.ed_type(t.scr.ed, text);
}

// Ctrl+C or Ctrl+D: clears the input; on an empty one, Ctrl+C interrupts
// UniiChat's turn (never quits: that kills the jobs here), Ctrl+D quits
function term_clear(t: Term, key: string): void {
  if (t.scr.ed.text !== "") {
    Screen.ed_take(t.scr.ed);
  } else if (key === "Ctrl+D") {
    term_quit(t);
  } else {
    term_act(t, { $: "Send", text: "" });
  }
}

// the next tab
function term_cycle(t: Term): void {
  const tabs = View.view_tabs(t.v);
  const at   = tabs.findIndex((tab) => tab.here) + 1;
  term_act(t, { $: "Goto", name: tabs[at % tabs.length].name });
}

// Commands
// --------

// a command typed (`/name arg`): runs it (pending while it works on);
// false if the text is none
function term_command(t: Term, text: string): boolean {
  const word = text.trim().split(/\s+/)[0];
  const cmd = term_commands(t.v).find(([use]) => use !== "" && use.split(" ")[0] === word);
  const run = cmd?.[3](t, text.trim().slice(word.length).trim());
  if (run instanceof Promise) {
    t.pending += 1;
    run.finally(() => {
      t.pending -= 1;
      term_idle(t);
    });
  }
  return cmd !== undefined;
}

// the commands and keys by group, in two columns, then the editing keys
function term_help(t: Term): void {
  const how   = (c: Cmd) => [c[0], c[1]].filter((x) => x !== "").join(", ");
  const left  = Math.max(...term_commands(t.v).map((c) => Paint.text_width(how(c)))) + 2;
  const right = Math.max(20, term_inner() - left);
  const row   = (c: Cmd) => Paint.runs_wrap([Paint.Run(c[2])], right, false).map((l, k) => [Paint.Run((k === 0 ? how(c) : "").padEnd(left)), ...l]);
  const bold  = { ...Paint.INK, b: true };
  const group = ([name, cmds]: [string, Cmd[]]) => [[Paint.Run(name, bold)], ...cmds.flatMap(row)];
  const edit  = Paint.runs_wrap([Paint.Run(Screen.EDITING)], term_inner(), false);
  t.out = t.out.concat(term_inset([[], ...term_groups(t.v).flatMap(group), [Paint.Run("Editing", bold)], ...edit]));
}

// attaches the image at a path (as typed or dropped: quoted, escaped, ~)
// to the next message, its bytes as read now (a Bun file inside a Blob
// adds nothing to it, Bun 1.3.14: the server got the text alone and
// refused the message); a file of another kind is refused here
async function term_image(t: Term, arg: string): Promise<void> {
  const file = arg.replace(/^(['"])(.*)\1$/, "$2").replace(/\\(.)/g, "$1").replace(/^~(?=\/|$)/, os.homedir());
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    term_note(t, "No file " + arg + ".");
    return;
  }
  const bytes = await Bun.file(file).bytes();
  if (View.image_kind(bytes) === null) {
    term_note(t, "Not attached: " + arg + " is no image. " + View.IMAGES);
    return;
  }
  t.imgs.push(new Blob([bytes]));
  term_note(t, "Attached " + arg + "; it goes with the next message (" + t.imgs.length + " waiting).");
}

// stops all that runs, or the agent named
function term_stop(t: Term, arg: string): void {
  const name = term_agent(t, arg);
  if (arg !== "" && !t.v.agents.includes(name)) {
    term_note(t, "No agent " + arg + " at work.");
    return;
  }
  term_send(t, arg === "" ? { $: "stop" } : { $: "stop", name });
}

// an agent at work whose name starts with arg, else arg
function term_agent(t: Term, arg: string): string {
  return t.v.agents.find((a) => a.toLowerCase().startsWith(arg.toLowerCase())) ?? arg;
}

// the person's choice for block #id or #id+n (its name, View.block_name),
// open or closed, whatever it shows now: it holds until Fold all
function term_block(t: Term, arg: string, open: boolean): void {
  const name = /^#?(\d+)(?:\+(\d+))?$/.exec(arg);
  const id   = Number(name?.[1]);
  const n    = Number(name?.[2] ?? 1);
  if (name === null || block_row(View.view_body(t.v), id, n) === undefined) {
    term_note(t, arg === "" ? "Which block? " + (open ? "/open" : "/close") + " #id, as each block shows it." : "No block " + arg + " here.");
    return;
  }
  term_act(t, { $: open ? "Open" : "Shut", id, n });
  if (!open || n === 1) {
    term_shown(t, id, n, open);
  }
}

// block #id+n as chosen, printed below what is printed, then a note: the
// scrollback is never written over, so the reader keeps their place, and
// an opened block shows where one reads (it may be far above); the page
// shows the choice in place at its next whole print
function term_shown(t: Term, id: number, n: number, open: boolean): void {
  const row = block_row(View.view_body(t.v), id, n);
  term_rows(t, open && row !== undefined ? [row] : [], false);
  term_note(t, (open ? "Opened " : "Closed ") + View.block_name(id, n) + ".");
}

// the row of block #id+n, among rows or inside their boxes
function block_row(rows: View.Row[], id: number, n: number): View.Row | undefined {
  for (const r of rows) {
    if ((r.$ === "Sum" || r.$ === "Box") && r.id === id && r.n === n) {
      return r;
    }
    const inner = r.$ === "Box" ? block_row(r.rows, id, n) : undefined;
    if (inner !== undefined) {
      return inner;
    }
  }
  return undefined;
}

// folds all (printed when the tops come), or unfolds
function term_fold(t: Term): void {
  if (t.v.page !== null) {
    return;
  }
  const on = t.v.fold === null;
  term_act(t, { $: "Fold", on });
  if (!on) {
    term_page(t);
  }
}

// shows an agent's chat, by the start of its name, or UniiChat's; no
// name lists the tabs
function term_tab(t: Term, arg: string): void {
  const main = arg.toLowerCase() === View.MAIN.toLowerCase();
  if (arg === "") {
    return term_note(t, "Tabs: " + View.view_tabs(t.v).map((tab) => tab.text).join("  "));
  }
  term_act(t, { $: "Goto", name: main ? null : term_agent(t, arg) });
}

// moves the pick one step (a key)
function term_move(t: Term, move: Move): void {
  term_act(t, { $: "Move", move });
}

// a part of the pick: to the value given, or, none, the values it may
// take, the pick's marked
function term_pick(t: Term, move: Move, arg: string): void {
  const knob = View.view_pick(t.v).find((k) => k.move === move);
  if (arg !== "" || knob === undefined || t.v.pick === null) {
    term_act(t, { $: "Move", move, to: arg });
    return;
  }
  const parts = [...new Set(Pick.options(t.v.pick, move, t.v).map(([part]) => part))];
  const list  = parts.map((part) => (part === knob.text ? part + " (now)" : part));
  term_note(t, move[0].toUpperCase() + move.slice(1) + "s: " + list.join(", ") + ". Pick one with /" + move + " <" + move + ">.");
}

async function term_export(t: Term): Promise<void> {
  const res  = await term_get(t, "/export", "export");
  const file = process.cwd() + "/unii-memory.json";
  if (res !== null) {
    await Bun.write(file, res);
    term_note(t, "Your data is in " + file + ".");
  }
}

// this computer's Claude and ChatGPT chats, and the websites' exports
// given (EXPORT), not imported yet, as the words want (claude, chatgpt;
// Import.Want: since a day; tools; -#n: not session n): without go,
// what it finds and costs (sessions: and the list); with go, sent;
// pause, resume: the import running
async function term_import(t: Term, arg: string): Promise<void> {
  if (/^(pause|resume)$/.test(arg)) {
    return term_send(t, { $: "go", on: arg === "resume" });
  }
  const given = arg.replace(SINCE, "").split(/\s+/).filter((w) => w !== "");
  const files = given.filter((w) => EXPORT.test(w)).map((w) => w.replace(/^~(?=\/)/, os.homedir()));
  const words = given.filter((w) => !EXPORT.test(w)).map((w) => w.toLowerCase());
  const apps  = Import.APPS.filter((app) => words.includes(app.toLowerCase()));
  const want  = { off: [] as string[], since: arg.match(SINCE)?.[1] ?? "", tools: words.includes("tools") };
  if (words.some((w) => !/^(tools|sessions|go|-#\d+)$/.test(w) && !Import.APPS.some((app) => app.toLowerCase() === w))) {
    term_note(t, "Not understood. " + HOW);
    return;
  }
  term_note(t, "Looking for Claude and ChatGPT chats on this computer…");
  const read = await Promise.all([...IMPORTS.map(term_sessions), ...files.map(export_sessions)]).catch((e) => String(e.message ?? e));
  if (typeof read === "string") {
    term_note(t, "Not imported: " + read);
    return;
  }
  const sessions = read.flat().filter((s) => apps.length === 0 || apps.includes(s.app));
  const done  = await term_get(t, "/api/imported", "read what Unii has");
  if (done === null) {
    return;
  }
  const old   = await done.json();
  const shown = Import.import_plan(sessions, want, old, View.view_count(t.v)).sessions;
  want.off    = shown.filter((s, k) => words.includes("-#" + (k + 1))).map(Import.import_id);
  const plan  = Import.import_plan(sessions, want, old, View.view_count(t.v));
  const found = "Found " + Import.import_count(plan.msgs, "new ") + ". ";
  if (plan.msgs === 0) {
    term_note(t, plan.first === "" ? Import.OLD : found + HOW);
    return;
  }
  if (!words.includes("go")) {
    const which = words.includes("sessions") ? shown.map((s, k) => "\n- #" + (k + 1) + " " + s.app + ": " + Import.import_line(s) + (want.off.includes(Import.import_id(s)) ? " (left out)" : "")).join("") + "\n" : "";
    const out   = await new Promise<View.Answer>((ok) => View.link_send(t.v, { $: "guess", body: () => plan.sizes.join(",") }, ok));
    const cost  = out.usd === undefined ? "Not priced: " + term_refusal(out) : "Importing them costs about " + Import.guess_usd(out.usd) + ". To import them, type:\n\n```\n/import " + (arg + " go").trim() + "\n```";
    term_rows(t, View.entry_rows(null, "note", found + which + "\n" + cost + "\n\n" + HOW), false);
    return;
  }
  term_note(t, found + "Sending them…");
  term_send(t, { $: "import", body: () => Import.import_body(plan.picked) });
}

// a dir's sessions (none if it is missing), a file at a time
async function term_sessions(dir: string): Promise<Import.Session[]> {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map((f) => dir + "/" + (WIN ? String(f).replaceAll("\\", "/") : f)).filter(Import.import_file) : [];
  const found: Import.Session[] = [];
  for (const f of files) {
    found.push(...[await Import.import_session(Bun.file(f), "log")].filter((s) => s !== null));
  }
  return found;
}

// a site's export file's sessions
async function export_sessions(path: string): Promise<Import.Session[]> {
  if (!fs.existsSync(path)) {
    throw new Error("no file " + path);
  }
  return Import.import_export(Bun.file(path));
}

async function term_topup(t: Term, arg: string): Promise<void> {
  const out = await term_post(t, "/api/topup", { usd: Number(arg) });
  if (typeof out.url !== "string") {
    term_note(t, out.error ?? "Could not top up: no connection.");
    return;
  }
  term_browse(t, "The payment", out.url);
}

async function term_account(t: Term): Promise<void> {
  const a = await account_get(t);
  if (a !== null) {
    term_rows(t, View.entry_rows(null, "note", View.account_md(a)), false);
  }
}

// the account; null: not read (term_get)
async function account_get(t: Term): Promise<View.Account | null> {
  return (await term_get(t, "/api/account", "read the account"))?.json() ?? null;
}

// deletes the account, once its name is typed; the server says what
// deleting does, and the name, when it isn't
async function term_delete(t: Term, arg: string): Promise<void> {
  const out = await term_post(t, "/api/delete", { confirm: arg });
  if (!out.ok) {
    term_note(t, out.error ?? "No connection.");
    return;
  }
  fs.rmSync(TOKEN, { force: true });
  term_note(t, "Your account and chat are deleted.");
  term_quit(t);
}

async function term_logout(t: Term): Promise<void> {
  await term_post(t, "/api/logout", {});
  fs.rmSync(TOKEN, { force: true });
  term_note(t, "Signed out. Run unii to sign in again.");
  term_quit(t);
}

// a GET of the server; failing, a note says it could not do `what`
async function term_get(t: Term, path: string, what: string): Promise<Response | null> {
  const res = await fetch(t.url + path, { headers: term_auth() }).catch(() => null);
  if (res === null || !res.ok) {
    term_note(t, "Could not " + what + ": " + (res === null ? "no connection" : "HTTP " + res.status) + ".");
    return null;
  }
  return res;
}

// a JSON POST to the server (View.post)
function term_post(t: Term, path: string, body: object): Promise<any> {
  return View.post(t.url + path, body, term_auth());
}

// a refusal's text; one for want of credit (402) says how to add some
function term_refusal(out: View.Answer): string {
  return out.status === 402 ? out.error + " " + TOPUP : out.error ?? "";
}

// quits, telling the server (its jobs here end), once all printed is out
// (a write's callback comes after those before it), with exitCode
function term_quit(t: Term): void {
  t.v.ws?.close(View.QUIT);
  term_paint(t);
  process.stdout.write("", () => process.exit());
}

// quits at a signal (the terminal may be gone: nothing printed)
function term_bye(t: Term): void {
  t.v.ws?.close(View.QUIT);
  process.exit(0);
}

// a page for the browser: its link printed (a terminal reached over ssh
// has no browser of its own), then opened in the browser here, if any
function term_browse(t: Term, what: string, url: string): void {
  term_note(t, what + ": " + url);
  browse(url);
}

// a link opened in the browser here, if any: a Linux with no desktop has
// no xdg-open (spawning one missing throws)
function browse(url: string): void {
  const open = Bun.which(process.platform === "darwin" ? "open" : "xdg-open");
  if (open !== null) {
    child.spawn(open, [url], { detached: true, stdio: "ignore" }).unref();
  }
}

// a note printed above the footer
function term_note(t: Term, text: string): void {
  t.v.notes.push(text);
  term_draw(t);
}

// Printing
// --------

// what a server message prints, as it comes
function term_print(t: Term, msg: View.Server): void {
  const v     = t.v;
  const main  = v.page === null;
  switch (msg.$) {
    case "view": {
      if (main && v.fold === null) {
        term_after(t);
      }
      return;
    }
    case "know": {
      if (main) {
        term_settle(t);
      }
      return;
    }
    case "entry": {
      if (msg.agent !== v.page?.name) {
        return;
      }
      // a page's log comes again at each reconnect
      const text = term_logged(t, msg.kind, msg.text);
      const page = msg.agent ?? "";
      const n    = v.page?.log?.length ?? 0;
      if (main ? msg.id !== undefined && msg.id <= t.last : n <= (t.logs.get(page) ?? 0)) {
        return;
      }
      t.logs.set(page, n);
      t.last = main && msg.id !== undefined ? msg.id : t.last;
      const due  = main && msg.id !== undefined && View.part_due(v, [msg.id, 1], v.parts[v.parts.length - 2]);
      const head = due ? [View.Cap(View.AI)] : [];
      term_rows(t, [...head, ...View.entry_rows(msg.id ?? null, msg.kind, text, msg.images)], false);
      return;
    }
    case "root": {
      if (main && v.fold !== null) {
        term_page(t);
      }
      return;
    }
    case "zoom": {
      if (main) {
        term_shown(t, msg.id, msg.n, true);
      }
      return;
    }
  }
}

// the page shown, whole, alone on the screen and its scrollback (a new
// size, /fold): no other is printed then
function term_page(t: Term): void {
  term_rows(t, [], true);
  [t.last, t.wait, t.logs] = [-1, [], new Map()];
  term_show(t);
}

// what of the page shown was never printed, then its stream again
function term_show(t: Term): void {
  const page = t.v.page;
  t.flow = new Map([...t.flow].filter(([, done]) => done === Infinity));
  if (page !== null) {
    const from = t.logs.get(page.name) ?? 0;
    t.logs.set(page.name, Math.max(from, page.log?.length ?? 0));
    return term_rows(t, View.page_rows(t.v, page, from), false);
  }
  if (t.v.fold === null) {
    return term_after(t);
  }
  t.last = Math.max(t.last, View.view_count(t.v) - 1);
  term_rows(t, View.view_body(t.v), false);
}

// a new view of the chat: the parts holding a message past the one
// printed last print as they settle, after the AI notice if none is,
// since a terminal's scrollback is never written over; what changed
// above (new summaries) shows at the next whole print (a resize, /fold)
function term_after(t: Term): void {
  const head = t.last < 0 ? [View.Cap(View.AI)] : [];
  t.wait = t.wait.concat(t.v.parts.filter(([id, n]) => id + n - 1 > t.last));
  t.last = Math.max(t.last, View.view_count(t.v) - 1);
  term_rows(t, head, false);
  term_settle(t);
}

// prints the parts not printed, in order, up to one whose summary isn't
// known yet: from it on they show in the footer till it is (an import's
// blocks, the oldest built last)
function term_settle(t: Term): void {
  const rows = View.view_rows(t.v, t.wait);
  const wait = rows.findIndex((r) => View.rows_wait(t.v, r));
  const done = wait < 0 ? rows.length : wait;
  t.wait = t.wait.slice(done);
  term_rows(t, rows.slice(0, done).flat(), false);
}

// prints what streams that no piece to come changes, a message at a
// time: whole once a message after it started, else its settled blocks;
// a message with a part left holds back those after it
function term_flow(t: Term): void {
  const live = View.view_stream(t.v);
  for (const [l, done] of t.flow) {
    if (done === Infinity && !live.includes(l)) {
      t.flow.delete(l);
    }
  }
  for (const [k, l] of live.entries()) {
    const done  = t.flow.get(l) ?? 0;
    const end   = done + View.entry_settled(l.kind, l.text.slice(done), k < live.length - 1);
    const piece = piece_trim(l.text.slice(done, end));
    if (piece !== "") {
      t.flow.set(l, end);
      term_rows(t, View.entry_rows(null, l.kind, piece), false);
    }
    if (piece_trim(l.text.slice(t.flow.get(l) ?? 0)) !== "") {
      return;
    }
  }
}

// the part of a message logged not printed yet: what follows the printed
// head of the first message streaming of its kind that it starts with;
// that one prints no more
function term_logged(t: Term, kind: Kind, text: string): string {
  const fresh = View.view_stream(t.v).filter((l) => !t.flow.has(l)).map((l): [View.Live, number] => [l, 0]);
  const heads = [...t.flow].filter(([, done]) => done < Infinity).concat(fresh);
  const at    = heads.findIndex(([l, done]) => l.kind === kind && text.startsWith(l.text.slice(0, done).trim()));
  if (at < 0) {
    return text;
  }
  for (const [l] of heads.slice(0, at + 1)) {
    t.flow.set(l, Infinity);
  }
  const [l, done] = heads[at];
  return piece_trim(text.slice(l.text.slice(0, done).trim().length));
}

// a piece of a message as printed: no blank lines around it
function piece_trim(text: string): string {
  return text.replace(/^\s*\n/, "").trimEnd();
}

// rows to print above the footer (with wipe: alone on the screen), after
// the notes before them, painted (/account's waited for a key)
function term_rows(t: Term, rows: View.Row[], wipe: boolean): void {
  t.out  = wipe ? [] : t.out;
  t.wipe = t.wipe || wipe;
  t.out  = t.out.concat(term_lines(t.v.notes.splice(0).map(View.Cap)), term_lines(rows));
  term_draw(t);
}

// rows as lines, after a blank line, in the margin
function term_lines(rows: View.Row[]): Paint.Line[] {
  return term_inset(rows.length === 0 ? [] : [[], ...Paint.rows_lines(rows, term_inner())]);
}

function term_inset(lines: Paint.Line[]): Paint.Line[] {
  const pad = Paint.Run(" ".repeat(MARGIN));
  return lines.map((l) => [pad, ...l]);
}

function term_inner(): number {
  return Screen.screen_width() - 2 * MARGIN;
}

// a new size: the page laid out again, at the new width, once the size
// settles
function term_resize(t: Term): void {
  clearTimeout(t.settle);
  t.settle = setTimeout(() => term_page(t), SETTLE);
}

// a paint, a frame from now, unless one is due
function term_draw(t: Term): void {
  if (!t.due) {
    t.due = true;
    setTimeout(() => term_paint(t), FRAME);
  }
}

// prints the lines due, the notes and what of the stream settled, then
// the footer: the rest of the stream (its last lines that fit), the rule,
// the input, a rule (offline while the socket is not open), the tabs.
// The screen's top row stays free: an erase from the top left clears
// the screen, which tmux keeps in its scrollback at each paint
function term_paint(t: Term): void {
  t.out = t.out.concat(term_lines(t.v.notes.splice(0).map(View.Cap)));
  term_flow(t);
  const w     = Screen.screen_width();
  const iw    = term_inner();
  const room  = (process.stdout.rows || 24) - 1;
  const off   = !View.view_typing(t.v);
  const input = Screen.screen_input(t.scr, iw, room - 3, off ? OFF : View.HINT + " · /help", off);
  const under = Paint.rule_text(t.v.up ? "" : "offline", iw);
  const own   = term_inset([Paint.rule_line(t.v, iw), ...input.lines, under, Paint.tabs_line(t.v, iw)]);
  const rest  = View.view_stream(t.v).map((l) => ({ kind: l.kind, text: l.text.slice(t.flow.get(l) ?? 0) }));
  const held  = t.v.page === null ? View.view_rows(t.v, t.wait).flat() : [];
  const tail  = term_lines([...held, ...View.view_tail(t.v, rest)]).flatMap((l) => Paint.runs_wrap(l, w, true));
  const above = tail.slice(Math.max(0, tail.length - room + own.length));
  const at    = { row: above.length + 1 + input.at.row, col: input.at.col + MARGIN };
  Screen.screen_paint(t.scr, t.out, t.wipe, [...above, ...own], at);
  t.out  = [];
  t.wipe = false;
  t.due  = false;
}

// Jobs
// ----

// the server's word on this terminal's jobs: a job, run unless it runs
// or its output waits for an answer; or their ids, the rest halted
function term_jobs(t: Term, msg: View.Server & { $: "jobs" | "job" }): void {
  if (msg.$ === "job") {
    const sent = t.v.out.some((p) => p.msg.$ === "out" && p.msg.job === msg.id);
    if (!t.jobs.has(msg.id) && !sent) {
      term_run(t, msg.id, msg.job as Job);
    }
    return;
  }
  for (const [id, abort] of t.jobs) {
    if (!msg.ids.includes(id)) {
      abort.abort();
    }
  }
}

// runs a job here, and answers its output; one too large for a socket
// message (View.FRAME, the 1 KiB left for the act around it) answers its
// size instead, failed (sent, it would close the socket at every try)
async function term_run(t: Term, id: string, job: Job): Promise<void> {
  const abort = new AbortController();
  t.jobs.set(id, abort);
  const no   = { text: "This terminal does no computer use.", fail: true };
  const out  = job.name === "computer" && !COMPUTER ? no : await Machine.run(job, WORK, abort.signal);
  const size = Buffer.byteLength(JSON.stringify(out));
  const most = View.FRAME - 1024;
  const big  = { text: "The output, " + size + " bytes, is over the " + most + " a tool may send.", fail: true };
  t.jobs.delete(id);
  term_send(t, { $: "out", job: id, out: size > most ? big : out });
}

// Login
// =====

// signs in: what is typed (an email, or @ and a GitHub name where the
// server takes one) begins a sign-in for a token made here, kept in TOKEN
// once its link was opened; where the server bills, it accepts its terms.
// A server that says nothing of itself (/api/hello) bills, as one of
// before it did
async function login_run(url: string): Promise<void> {
  const hello = await fetch(url + "/api/hello").then((res) => res.json()).catch(() => ({}));
  const { bills = true, github = true } = hello;
  if (bills) {
    console.log("Signing in, you accept the terms (" + url + "/terms.html) and the privacy policy (" + url + "/privacy.html).");
  }
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const out = await login_ask(url, key, github);
  if (out.url) {
    browse(out.url);
  }
  console.log(out.url ? "Sign in with GitHub in the browser: " + out.url : "A sign-in link is on its way to " + out.who + ". Open it.");
  console.log("On the page it opens, type this code: " + out.code);
  // the link lives on the server, so only it ends the wait: signed in (ok),
  // or the link gone (410); a wait that fails is asked again
  const wait = { headers: { authorization: "Bearer " + key }, timeout: false } as RequestInit;
  while (true) {
    const done = await fetch(url + "/api/wait", wait).catch(() => null);
    const ans  = await done?.json().catch(() => ({})) ?? {};
    if (done?.status === 410) {
      login_fail("the link expired: run unii again");
    }
    if (done?.ok && ans.ok) {
      break;
    }
    if (done?.status !== 408) {
      await Bun.sleep(View.RETRY);
    }
  }
  fs.writeFileSync(TOKEN, key, { mode: 0o600 });
  console.log("Signed in.");
}

// asks for an address (a GitHub login too, where the server takes one)
// until the server takes one (it says why it doesn't): the address, and
// the server's answer
async function login_ask(url: string, key: string, github: boolean): Promise<{ who: string; url?: string; code: string }> {
  while (true) {
    process.stdout.write(github ? "Email or @github: " : "Email: ");
    const who  = (await login_line()).trim();
    const init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ who, key }) };
    const res  = await fetch(url + "/api/login", init).catch(() => null);
    if (res === null) {
      login_fail("no connection to " + url);
    }
    const out = await res.json().catch(() => ({ error: "HTTP " + res.status }));
    if (out.error === undefined) {
      return { ...out, who };
    }
    console.log(out.error);
  }
}

// the next line typed; stdin is paused after it, till the screen reads it
function login_line(): Promise<string> {
  return new Promise((done) => {
    const end  = () => login_fail("no address typed");
    const take = (chunk: Buffer) => {
      process.stdin.off("data", take).off("end", end).pause();
      done(String(chunk).split("\n")[0]);
    };
    process.stdin.on("data", take).on("end", end).resume();
  });
}

function login_fail(why: string): never {
  console.error("unii: " + why);
  process.exit(1);
}

// Update
// ======

// marks this computer as one that self-hosted (SELF), for good
function self_mark(): void {
  fs.writeFileSync(SELF, "");
}

// update_check is the whole telemetry: once a day, a GET of CHECK (plus
// &self=1 once SELF exists; no account, no id), its answer {ver, notice}
// cached in CHECKED (stamped before the request: one a day); a cached
// ver newer than this one is a note. It never delays nor fails the chat
async function update_check(t: Term): Promise<void> {
  if (process.env.UNII_NO_TELEMETRY) {
    return;
  }
  let last = { t: 0, ver: VERSION, notice: "" };
  try {
    last = { ...last, ...JSON.parse(fs.readFileSync(CHECKED, "utf8")) };
  } catch {}
  try {
    if (Date.now() - last.t > DAY) {
      last.t = Date.now();
      fs.writeFileSync(CHECKED, JSON.stringify(last) + "\n");
      const got = await (await fetch(CHECK + (fs.existsSync(SELF) ? "&self=1" : ""), { signal: AbortSignal.timeout(3000) })).json() as { ver?: unknown; notice?: unknown };
      last.ver = typeof got.ver === "string" ? got.ver : VERSION;
      last.notice = typeof got.notice === "string" ? got.notice : "";
      fs.writeFileSync(CHECKED, JSON.stringify(last) + "\n");
    }
  } catch {}
  if (update_newer(last.ver)) {
    const notice = last.notice.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 200);
    term_note(t, "unii " + last.ver + " is available: run unii update" + (notice === "" ? "" : ". " + notice));
  }
}

// whether ver (major.minor.patch) is newer than this unii
function update_newer(ver: string): boolean {
  const a = ver.split(".").map(Number);
  const b = VERSION.split(".").map(Number);
  return a.length === 3 && a.every(Number.isInteger) && (a[0] - b[0] || a[1] - b[1] || a[2] - b[2]) > 0;
}

// runs the installer again: the one way unii changes. The command prints
// first, so one can run it alone.
function update_run(url: string): void {
  if (WIN) {
    console.error("On Windows, build unii.exe again from the source (README).");
    process.exitCode = 1;
    return;
  }
  const cmd = "curl -fsSL " + url + "/install.sh | sh";
  console.error(cmd);
  process.exitCode = child.spawnSync("sh", ["-c", cmd], { stdio: "inherit" }).status ?? 1;
}

// Main
// ====

// the session's header, if signed in
function term_auth(): Record<string, string> {
  if (!fs.existsSync(TOKEN)) {
    return {};
  }
  return { authorization: "Bearer " + fs.readFileSync(TOKEN, "utf8").trim() };
}

// whether this terminal is signed in: it holds a session the server
// doesn't refuse (one it can't reach may: the chat waits for it)
async function term_signed(url: string): Promise<boolean> {
  if (!fs.existsSync(TOKEN)) {
    return false;
  }
  const res = await fetch(url + "/api/me", { headers: term_auth() }).catch(() => null);
  return res === null || res.status !== 401;
}

fs.mkdirSync(TOKEN.slice(0, -"/token".length), { recursive: true, mode: 0o700 });

if (HELP || ODD !== undefined) {
  if (ODD !== undefined) {
    login_fail("no argument " + ODD + ".\n\n" + USAGE);
  }
  console.log(USAGE);
} else if (ASKVER) {
  console.log("unii " + VERSION);
} else if (UPDATE) {
  update_run(SERVER);
} else if (SERVE) {
  self_mark();
  await (await import("./Server.ts")).serve(Number(PORT ?? 8788), null);
} else if (LOGIN) {
  await login_run(SERVER);
} else {
  if (!await term_signed(SERVER)) {
    await login_run(SERVER);
  }
  if (SERVER !== OURS) {
    self_mark();
  }
  const t = term_new(SERVER);
  term_connect(t);
}
