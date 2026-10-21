// Tools
// =====
// Unii's prompts, tools and agents. Calls get the tools as MCP over one
// local port, at a URL with the chat's secret and the caller ("main", an
// agent; a compaction has none).
// shell, read, write, edit and view_video run on the device their
// `device` field names: a computer with unii open, one per sign-in
// (host, host-2...), listed in each call's message. A name stays its sign-in's
// while the chat is loaded, so a call meant for one computer never
// reaches another. A device's terminals are its views' tabs: one whose
// link is lost stays, its jobs waiting, until it quits. It is told its
// jobs' ids as they change, and each job new to it; a job's output is an
// act (Server.ts).
// An agent (subagent or computer task) has a name and a log; each call
// gets its context and its whole log, so a told agent goes on even after
// a restart; its replies reach the chat as one "[Name]" message.
// A chat moves to another process whole (Tools.give, Tools.take): its
// key, devices and jobs, and its agents at work, whose calls run on where
// they started; MCP requests reaching this one then go on there, those
// waiting too, straight to where the chat is now, past the processes
// between, which end (Tools.went) (a job's request waits on its job
// there, by its id; a spawn or tell still waiting on summaries is done
// there anew).

import * as fs from "node:fs";
import { AskAI, type Ask, type Bill, type Block, type Call, type Event, type Kind, type Pay } from "./AskAI.ts";
import type { Out } from "./Agent.ts";
import { report_text } from "./Call.ts";
import { clip_page } from "./Clip.ts";
import * as config from "./Config.ts";
import { COMPUTER, INT, STR, TOOLS, spec, type Job, type Spec } from "./Machine.ts";
import { Memory } from "./Memory.ts";
import PROMPT from "./prompt.txt" with { type: "text" };
import { EFFORTS, Pick } from "./Pick.ts";
import type { Live } from "./View.ts";

export type { Live };

// Types
// =====

// a device: its sign-in (a session's hash), terminals by tab (none:
// closed), and jobs by id
type Device = {
  who   : string;
  terms : Map<string, Link>;
  jobs  : Map<string, Running>;
};

// a job: the terminal it runs on, what it runs, its output, what ends it
type Running = { term: string; job: Job; out: Promise<Out>; end: (out: Out) => void };

// a terminal: how to reach it, whether its socket is open now, whether it
// does computer use, its work dir
export type Link = { send: (msg: object) => void; live: () => boolean; computer: boolean; work: string };

// at work, the view its calls get and its replies so far
export type Agent = {
  name    : string;
  role    : { $: "sub"; effort: string | null } | { $: "hands"; device: string };
  call    : Call | null;
  live    : Live[];
  calls   : Record<string, string>; // its tool calls awaiting their results, by id (Chat.on)
  stop    : boolean; // its call was stopped: the report stays unanswered
  view    : Block[];
  replies : string[];
};

// a chat's tools as they move to another process (Tools.give): the
// calls of its agents at work by the id `far` takes (Server.ts)
export type Moved = {
  key     : string;
  devices : Array<[string, string, Array<[string, string, Job]>]>;
  agents  : Array<Omit<Agent, "role" | "call"> & { call: string }>;
};

// what the server does for agents (report: work stopped stays unanswered;
// pick: the chat's pick; halt: what stops its turn)
type Hooks = {
  push   : (agent: Agent, kind: Kind, text: string) => void;
  on     : (agent: Agent, ev: Event) => void;
  report : (agent: Agent, text: string, stopped: boolean) => void;
  change : () => void;
  pick   : () => Pick;
  halt   : () => AbortSignal;
};

// the tools: what pays the calls (none: the vendors' keys); where its
// chat moved (a process's tools URL), once it did
export type Tools = {
  mem     : Memory;
  devices : Map<string, Device>;
  agents  : Map<string, Agent>;
  key     : string;
  url     : string;
  hooks   : Hooks;
  pay?    : Pay;
  away    : PromiseWithResolvers<string>;
};

// Constants
// =========

export const MAIN = config.WORK + "/main";

// the most web searches a request of a turn or a subagent runs
export const SEARCHES = 10;

// the chats' tools, by their secret; where those moved went (Tools.give);
// what a chat on its way here waits on (Tools.coming); the server, once
// one is
const CHATS = new Map<string, Tools>();
const GONE  = new Map<string, string>();
let COMING: Promise<void> = Promise.resolve();
let HTTP: ReturnType<typeof Bun.serve> | null = null;

// the header of a request that waits on a job, its id (Tools.give)
const JOB = "x-unii-job";

// the master's prompt (a turn's and a compaction's): prompt.txt
export const MASTER = PROMPT.trim();

const SUB_HEAD = `You are a subagent of Unii, an AI agent that works for one user in a
single chat that never ends. Unii gave you a task. Do it yourself, with
your tools, following the user's instructions at the end of this
prompt: they say who the user is, how their files are organized and how
they want work done.

Your first message holds the view below, then your chat with Unii so far,
its lines as "i|kind: text": what you are (note), your task (user), and
later all you did and were told. The view shows you what Unii knows: what the user wants,
decided and taught. Use it as context only, and do what your task says,
not what the user's last message says, since Unii may have given you
just part of the work. Your final reply is your report to Unii. Unii may
send you more messages, even while you work: answer the last.`;

const HANDS = `You are the hands of Unii, an AI agent that works for one user: you use
the user's computer, {device}, through your computer tool (screenshots,
the mouse and the keyboard). Your first message is your
chat with Unii so far, its lines as "i|kind: text": what you are
(note), your task (user), and later all you did and were told. Do the task, following the user's
instructions at the end of this prompt, and do nothing it does not ask
for: pay, buy, send or delete only what it names, and if a page asks
for a password, a card or a confirmation it does not cover, stop and
report that. Unii may send you more messages while you work: follow them. No
one sees your work but Unii, and only your final reply: your report,
saying what you did, what you found that the task asks for, and what
failed.`;

const VIEW_DOC = `The view: the whole chat between Unii and the user, oldest first, inside
<chat> tags, as one-line summaries. Each line is

  id+n|text   the n messages from id on, summarized (newlines shown as spaces)

A summary tags each item with its kind: user (the user's words), unii
(Unii's replies), tool (Unii's tool calls), echo (their results), note
(memories from before this chat), or work (the report of an agent, a
subagent or a computer task, starting "[Name]"). A short message is its own line, word for word. Recent lines
cover one message each; the older the messages, the more a line covers.
A message not summarized yet shows as "(not summarized yet: zoom it)".
No message appears in full, not even the last ones. A text too long for
one message is split over several in a row.

Navigating: zoom(id, n) opens line id+n into the two lines of n/2
messages it was made from; zoom(id, 1) gives message id in full, with
the images its "[image <file>]" lines name. Zoom whenever a summary
only mentions something you need, such as what your last reply said, a
decision, a past attempt or where a file is, before you act, guess or
ask. date(id) gives the date and time of message id. zoom("Name") gives
an agent's whole chat.`;

// an agent's log starts with a note of what it is: SUB_NOTE, and its
// effort if not the configured one; or HANDS_NOTE and its device
const SUB_NOTE   = "subagent";
const SUB_AT     = " at effort ";
const HANDS_NOTE = "computer task on ";

// the devices: how they work, in the system prompt (DEVICES); those open
// now, at the start of each call's message (Tools.devices), so one
// joining or leaving changes a call's tail, never its cached prefix
const DEVICES = `Devices: the user's computers that have unii open now, by name, listed
at the start of each message. Your shell, read, write, edit and view_video
tools run on the one their \`device\` field names, and computer tasks on
one marked "computer use". A computer is listed only while the user runs unii on
it, and leaves the list when they close it: a task that needs one not
listed can't be done now, so tell the user it isn't available.`;
const DEVICES_NONE = "(None is open now.)";

// a subagent's prompt: its part, then the view's and the devices' docs
const SUB = SUB_HEAD + "\n\n" + VIEW_DOC + "\n\n" + DEVICES;

// the tools of everyone (OWN), the master's (BOSS), those that run on a
// device (`kit`: Machine.ts's), and the master's computer tasks (HAND),
// whose agents get only COMPUTER, on their device
const OWN: Spec[] = [
  spec("zoom", "Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole. With an agent's name as id, give that agent's whole chat. A long text comes in pages from character at, saying where to go on.", { id: { type: ["integer", "string"] }, n: INT, at: INT }, ["id"]),
  spec("date", "The date and time of message id.", { id: INT }, ["id"]),
];
const BOSS: Spec[] = [
  spec("spawn", "Start one subagent per task, in parallel, and return their names at once. Each one's report reaches you as a message \"[Name] report\" when it finishes. A subagent sees the view and the user's instructions, but knows what you want only from its task.", { tasks: { type: "array", items: STR }, effort: { type: "string", enum: EFFORTS, description: "How hard they think; by default, as hard as you." } }, ["tasks"]),
  spec("tell", "Send a message to an agent (a subagent or a computer task), by name. One at work reads it between its tool calls, and its report answers it; an idle one goes on from its chat, and its reply reaches you as a message \"[Name] reply\".", { name: STR, message: STR }, ["name", "message"]),
];
const DEVICE = { device: { type: "string", description: "The name of the device to run on, one listed under Devices." } };
function kit(who: string): Spec[] {
  return TOOLS.map((t) => {
    const schema = t.schema as { properties: object; required: string[] };
    const info = t.info + " It runs on the device named, in <work>/" + who + ", <work> being the work dir Devices lists for it.";
    return spec(t.name, info, { ...DEVICE, ...schema.properties }, ["device", ...schema.required]);
  });
}
const HAND: Spec = spec("computer", "Start a task on the screen of a device marked \"computer use\", done with its mouse and keyboard by an agent that sees screenshots, and return its name at once. Its report reaches you as a message \"[Name] report\". It knows only the task, so say all it needs. One at a time on each device.", { ...DEVICE, task: STR }, ["device", "task"]);

// Tools
// =====

export namespace Tools {

  // key: a chat's moving here keeps its own
  export function serve(mem: Memory, hooks: Hooks, key: string = crypto.randomUUID()): Tools {
    const url = Tools.base() + key + "/";
    const tools: Tools = { mem, devices: new Map(), agents: new Map(), key, url, hooks, away: Promise.withResolvers() };
    CHATS.set(key, tools);
    fs.mkdirSync(MAIN, { recursive: true });
    return tools;
  }

  // this process's tools URL
  export function base(): string {
    HTTP ??= Bun.serve({ port: 0, hostname: "127.0.0.1", idleTimeout: 0, fetch: Tools.fetch });
    return "http://127.0.0.1:" + HTTP.port + "/";
  }

  // the chats on their way here: a request for one not here waits on
  // `till` (Server.ts)
  export function coming(till: Promise<void>): void {
    COMING = till;
  }

  export function close(tools: Tools): void {
    Tools.stop(tools, null);
    CHATS.delete(tools.key);
  }

  export function at(tools: Tools, who: string): string {
    return tools.url + who;
  }

  export function system(head: string): string {
    return head + "\n\n" + Tools.rules();
  }

  export function devices(tools: Tools): Block {
    const work = (d: Device) => [...d.terms.values()][0]?.work;
    const line = ([name, d]: [string, Device]) => "- " + name + (Tools.hands(d) ? " (computer use)" : "") + ", work dir " + work(d);
    const lines = Tools.opened(tools).map(line);
    return { text: "Devices open now:\n" + (lines.length === 0 ? DEVICES_NONE : lines.join("\n")) + "\n\n", mark: false };
  }

  // the master's agents at work now, at the start of each of its calls'
  // messages: read from their calls, so the list is never kept apart and
  // can't drift from the truth
  export function at_work(tools: Tools): Block {
    const names = Tools.working(tools).map((a) => a.name);
    return { text: "Agents at work now: " + (names.length === 0 ? "none." : names.join(", ") + ".") + "\n\n", mark: false };
  }

  export function rules(): string {
    return config.RULES ? fs.readFileSync(config.RULES, "utf8") : "";
  }

  // MCP
  // ---

  // a notification gets no answer; a request dropped stops its job; one
  // of a chat moved, or waiting as it moves, goes on where it went
  export async function fetch(req: Request): Promise<Response> {
    const [, key, who, ...rest] = new URL(req.url).pathname.split("/");
    const tools = CHATS.get(key) ?? (GONE.has(key) ? undefined : await COMING.then(() => CHATS.get(key)));
    const caller = who === "main" || tools?.agents.has(who);
    const msg = await req.json().catch(() => ({}));
    const id = req.headers.get(JOB) ?? crypto.randomUUID();
    if (GONE.has(key)) {
      return Tools.pass(GONE.get(key)!, key, who, msg, id, req.signal);
    }
    if (tools === undefined || rest.length > 0 || !caller) {
      return new Response(null, { status: 404 });
    }
    if (req.method !== "POST") {
      return new Response(null, { status: 405 });
    }
    if (msg.id === undefined) {
      return new Response(null, { status: 202 });
    }
    const no = { error: { code: -32601, message: "no method " + msg.method } };
    const here = Tools.answer(tools, who, msg.method, msg.params ?? {}, req.signal, id).then(
      (result) => (result === null ? no : { result }),
      (err) => ({ error: { code: -32603, message: String(err?.message ?? err) } }),
    );
    const out = await Promise.race([here, tools.away.promise]);
    if (typeof out === "string") {
      return Tools.pass(out, key, who, msg, id, req.signal);
    }
    return Response.json({ jsonrpc: "2.0", id: msg.id, ...out });
  }

  // a request sent on to the tools at `url`, as the job `id` if one
  export function pass(url: string, key: string, who: string, msg: object, id: string, signal: AbortSignal): Promise<Response> {
    const headers = { "content-type": "application/json", [JOB]: id };
    return globalThis.fetch(url + key + "/" + who, { method: "POST", headers, body: JSON.stringify(msg), signal });
  }

  // null: no such method
  export async function answer(tools: Tools, who: string, method: string, params: any, signal: AbortSignal, id: string): Promise<object | null> {
    switch (method) {
      case "initialize": {
        const protocolVersion = params.protocolVersion ?? "2025-06-18";
        return { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "unii", version: "1" } };
      }
      case "tools/list": {
        return { tools: Tools.list(tools, who).map((t) => ({ name: t.name, description: t.info, inputSchema: t.schema })) };
      }
      case "tools/call": {
        const name = String(params.name);
        const has = Tools.list(tools, who).some((t) => t.name === name);
        const out = has ? await Tools.call(tools, who, name, params.arguments ?? {}, signal, id) : { text: "No tool " + name + ".", fail: true };
        const imgs = (out.imgs ?? []).map((img) => ({ type: "image", data: img.data, mimeType: img.type }));
        return { content: [{ type: "text", text: out.text }, ...imgs], isError: out.fail };
      }
      case "ping": {
        return {};
      }
    }
    return null;
  }

  export function list(tools: Tools, who: string): Spec[] {
    if (who === "main") {
      return [...OWN, ...BOSS, ...kit(who), HAND];
    }
    return tools.agents.get(who)?.role.$ === "hands" ? [COMPUTER] : [...OWN, ...kit(who)];
  }

  // id: a job's, if it starts one
  export async function call(tools: Tools, who: string, name: string, args: any, signal: AbortSignal, id: string): Promise<Out> {
    const mem = tools.mem;
    switch (name) {
      case "zoom": {
        const id = String(args.id);
        const n = Number(args.n ?? 1);
        const at = Number(args.at ?? 0);
        if (/^[A-Za-z]/.test(id)) {
          return { text: clip_page(Memory.agent_show(mem, id), at), fail: false };
        }
        const imgs = n === 1 && at === 0 ? Memory.images(mem, Number(id)) : [];
        return { text: Memory.zoom(mem, Number(id), n, at), fail: false, imgs };
      }
      case "date": {
        return { text: Memory.date(mem, Number(args.id)), fail: false };
      }
      case "spawn": {
        const effort = args.effort === undefined ? null : String(args.effort);
        if (effort !== null && !EFFORTS.includes(effort)) {
          return { text: "No effort " + effort + "; one of " + EFFORTS.join(", ") + ".", fail: true };
        }
        return { text: await Tools.spawn(tools, (args.tasks ?? []).map(String), effort), fail: false };
      }
      case "tell": {
        return { text: await Tools.tell(tools, String(args.name), String(args.message)), fail: false };
      }
      case "computer": {
        const role = tools.agents.get(who)?.role;
        if (role?.$ === "hands") {
          return Tools.job(tools, role.device, { name, input: args, cwd: who }, signal, id);
        }
        return Tools.computer(tools, String(args.device), String(args.task));
      }
      default: {
        const { device, ...input } = args;
        return Tools.job(tools, String(device), { name, input, cwd: who }, signal, id);
      }
    }
  }

  // Devices
  // -------

  // a terminal joins its sign-in's device on host, and is sent its jobs;
  // the device's name
  export function attach(tools: Tools, term: string, host: string, who: string, link: Link): string {
    let name = host;
    for (let k = 2; (tools.devices.get(name)?.who ?? who) !== who; k++) {
      name = host + "-" + k;
    }
    const d = tools.devices.get(name) ?? { who, terms: new Map(), jobs: new Map() };
    d.terms.set(term, link);
    tools.devices.set(name, d);
    Tools.sync(d, term, () => true);
    return name;
  }

  // a terminal told its jobs' ids (it halts the rest), then each that
  // `fresh` picks, a message each
  export function sync(d: Device, term: string, fresh: (id: string) => boolean): void {
    const send = d.terms.get(term)?.send ?? (() => {});
    const mine = [...d.jobs].filter(([, j]) => j.term === term);
    send({ $: "jobs", ids: mine.map(([id]) => id) });
    mine.filter(([id]) => fresh(id)).forEach(([id, j]) => send({ $: "job", id, job: j.job }));
  }

  export function detach(tools: Tools, term: string, device: string): void {
    const d = tools.devices.get(device);
    if (d === undefined || !d.terms.delete(term)) {
      return;
    }
    for (const job of d.jobs.values()) {
      if (job.term === term) {
        job.end({ text: "The terminal that ran this on " + device + " closed.", fail: true });
      }
    }
  }

  export function opened(tools: Tools): [string, Device][] {
    return [...tools.devices].filter(([, d]) => d.terms.size > 0);
  }

  // else why not
  export function open(tools: Tools, device: string, computer: boolean): Device | string {
    const d = tools.devices.get(device);
    const open = Tools.opened(tools).map(([name]) => name).join(", ") || "none";
    if (d === undefined || d.terms.size === 0) {
      // only the user opens one, so a retry in a loop only keeps the chat
      // busy: stop and say so instead
      return "No device " + device + " is open (unii isn't running there). Open: " + open + ". Only the user opens it, so don't retry or wait: end your turn, saying what is left.";
    }
    if (computer && !Tools.hands(d)) {
      return device + " does no computer use (its unii runs without UNII_COMPUTER=1).";
    }
    return d;
  }

  // the job `id` on a device, waited on: started, unless it runs
  export function job(tools: Tools, device: string, job: Job, signal: AbortSignal, id: string): Promise<Out> {
    const run = tools.devices.get(device)?.jobs.get(id) ?? Tools.start_job(tools, device, job, id);
    if (typeof run === "string") {
      return Promise.resolve({ text: run, fail: true });
    }
    signal.addEventListener("abort", () => run.end({ text: "Stopped.", fail: true }), { once: true });
    return run.out;
  }

  // a job started on a device's terminal (the last live one), told to
  // it; else why not
  export function start_job(tools: Tools, device: string, job: Job, id: string): Running | string {
    const computer = job.name === "computer";
    const d = Tools.open(tools, device, computer);
    if (typeof d === "string") {
      return d;
    }
    const terms = [...d.terms].filter(([, t]) => t.computer || !computer);
    const [term] = terms.filter(([, t]) => t.live()).at(-1) ?? terms.at(-1)!;
    const run = Tools.track(d, id, term, job);
    Tools.sync(d, term, (x) => x === id);
    return run;
  }

  // a job kept until it ends, its terminal told then
  export function track(d: Device, id: string, term: string, job: Job): Running {
    const { promise, resolve } = Promise.withResolvers<Out>();
    const end = (out: Out) => {
      if (d.jobs.delete(id)) {
        Tools.sync(d, term, () => false);
        resolve(out);
      }
    };
    const run = { term, job, out: promise, end };
    d.jobs.set(id, run);
    return run;
  }

  export function hands(d: Device): boolean {
    return [...d.terms.values()].some((t) => t.computer);
  }

  export function done(tools: Tools, device: string, id: string, out: Out): void {
    tools.devices.get(device)?.jobs.get(id)?.end(out);
  }

  // Agents
  // ------

  export async function spawn(tools: Tools, tasks: string[], effort: string | null): Promise<string> {
    const view = tasks.length === 0 ? "No tasks." : await Tools.view(tools);
    if (typeof view === "string") {
      return view;
    }
    const names = tasks.map((task) => Tools.start(tools, { $: "sub", effort }, task, view));
    return "Started " + names.join(", ") + ". Each one's report will reach you as a message when it finishes.";
  }

  export function computer(tools: Tools, device: string, task: string): Out {
    const d = Tools.open(tools, device, true);
    const why = typeof d === "string" ? d : Tools.screen(tools, device);
    if (why !== null) {
      return { text: why, fail: true };
    }
    const name = Tools.start(tools, { $: "hands", device }, task, []);
    return { text: "Started " + name + " on " + device + ". Its report will reach you as a message.", fail: false };
  }

  export async function tell(tools: Tools, name: string, message: string): Promise<string> {
    const agent = Tools.agent(tools, name);
    if (agent === null) {
      return "No agent " + name + " to tell.";
    }
    if (agent.call !== null) {
      tools.hooks.push(agent, "user", message);
      agent.call.send({ text: message, imgs: [] });
      return "Sent. " + name + " reads it between its tool calls, and its report answers it.";
    }
    const busy = agent.role.$ === "hands" ? Tools.screen(tools, agent.role.device) : null;
    const view = busy ?? (agent.role.$ === "sub" ? await Tools.view(tools) : []);
    if (typeof view === "string") {
      return view;
    }
    tools.hooks.push(agent, "user", message);
    Tools.run(tools, Object.assign(agent, { view, replies: [], stop: false }));
    return "Sent. " + name + "'s reply will reach you as a message.";
  }

  export function start(tools: Tools, role: Agent["role"], task: string, view: Block[]): string {
    const name = Memory.agent_new(tools.mem);
    const agent = { name, role, call: null, live: [], calls: {}, stop: false, view, replies: [] };
    fs.mkdirSync(config.WORK + "/" + name, { recursive: true });
    tools.agents.set(name, agent);
    tools.hooks.push(agent, "note", role.$ === "sub" ? SUB_NOTE + (role.effort === null ? "" : SUB_AT + role.effort) : HANDS_NOTE + role.device);
    tools.hooks.push(agent, "user", task);
    Tools.run(tools, agent);
    return name;
  }

  // one not of this process is taken back from its log, idle
  export function agent(tools: Tools, name: string): Agent | null {
    const log = tools.agents.has(name) ? null : Memory.agent(tools.mem, name);
    const note = log !== null && log.length > 0 && log[0].kind === "note" ? log[0].text : "";
    const sub = note === SUB_NOTE || note.startsWith(SUB_NOTE + SUB_AT);
    if (sub || note.startsWith(HANDS_NOTE)) {
      const effort = note === SUB_NOTE ? null : note.slice((SUB_NOTE + SUB_AT).length);
      const role: Agent["role"] = sub ? { $: "sub", effort } : { $: "hands", device: note.slice(HANDS_NOTE.length) };
      tools.agents.set(name, { name, role, call: null, live: [], calls: {}, stop: false, view: [], replies: [] });
    }
    return tools.agents.get(name) ?? null;
  }

  // calls while a message waits in its log (told too late for the call
  // before), the first `call` if it runs (its chat moved here); then its
  // report. Detached: a throw ends it as a failed reply, still reported
  export async function run(tools: Tools, agent: Agent, call: Call | null = null): Promise<void> {
    try {
      for (let more = true; more; call = null) {
        agent.call = call ?? AskAI.ask(Tools.ask(tools, agent), (ev) => tools.hooks.on(agent, ev));
        tools.hooks.change();
        const end = await agent.call.done;
        agent.call = null;
        agent.replies.push(end.ok ? end.text : "failed: " + end.text);
        more = end.ok && end.left.length > 0;
      }
    } catch (err: any) {
      agent.call = null;
      agent.replies.push("failed: " + String(err?.message ?? err));
    }
    tools.hooks.report(agent, report_text(agent.name, agent.replies.join("\n\n")), agent.stop);
  }

  // what pays an agent's calls
  export function bill(tools: Tools, agent: Agent): Bill | undefined {
    return tools.pay?.(agent.role.$ === "sub" ? "agent" : "computer", agent.name);
  }

  // a call of an agent, on config.AGENTS or else the chat's pick (a
  // computer task's sees no view, and only its computer tool)
  export function ask(tools: Tools, agent: Agent): Ask {
    const log = { text: Memory.agent_show(tools.mem, agent.name), mark: true };
    const server = Tools.at(tools, agent.name);
    const run = Pick.ask(config.AGENTS ?? tools.hooks.pick());
    const bill = Tools.bill(tools, agent);
    const role = agent.role;
    switch (role.$) {
      case "sub": {
        const system = Tools.system(SUB);
        const blocks = [...agent.view, Tools.devices(tools), log];
        const effort = role.effort ?? run.effort;
        return { ...run, effort, system, blocks, searches: SEARCHES, server, bill };
      }
      case "hands": {
        const system = Tools.system(HANDS.replace("{device}", role.device));
        return { ...run, system, blocks: [...agent.view, log], searches: 0, server, bill };
      }
    }
  }

  // a string: why there is none (Memory.settle)
  export async function view(tools: Tools): Promise<Block[] | string> {
    const why = await Memory.settle(tools.mem, tools.mem.count, tools.hooks.halt());
    return why ?? Memory.view(tools.mem);
  }

  // Moving
  // ------

  // the chat's tools moved to the process whose tools are at `url`: its
  // agents at work by `far`, which moves each call; requests go there
  export function give(tools: Tools, url: string, far: (call: Call) => string): Moved {
    const jobs = (d: Device) => [...d.jobs].map(([id, j]): [string, string, Job] => [id, j.term, j.job]);
    const devices = [...tools.devices].map(([name, d]): Moved["devices"][number] => [name, d.who, jobs(d)]);
    const agents = Tools.working(tools).map(({ role, call, ...a }) => ({ ...a, call: far(call!) }));
    CHATS.delete(tools.key);
    GONE.set(tools.key, url);
    tools.away.resolve(url);
    return { key: tools.key, devices, agents };
  }

  // the chat `key`, given away from here, is now at the tools at `url`
  // (its new process took a call that runs here: Main.far): this
  // process's calls reach it straight, never through one that ended
  export function went(key: string, url: string): void {
    if (GONE.has(key)) {
      GONE.set(key, url);
    }
  }

  // a chat's tools come here (Tools.give): `far` makes the call of id
  export function take(tools: Tools, moved: Moved, far: (id: string, on: (ev: Event) => void, bill?: Bill) => Call): void {
    for (const [name, who, jobs] of moved.devices) {
      const d: Device = { who, terms: new Map(), jobs: new Map() };
      jobs.forEach(([id, term, job]) => Tools.track(d, id, term, job));
      tools.devices.set(name, d);
    }
    for (const { call, ...was } of moved.agents) {
      const agent = Object.assign(Tools.agent(tools, was.name)!, was);
      Tools.run(tools, agent, far(call, (ev) => tools.hooks.on(agent, ev), Tools.bill(tools, agent)));
    }
  }

  // why a computer task can't start on a device now
  export function screen(tools: Tools, device: string): string | null {
    const on = (a: Agent) => a.role.$ === "hands" && a.role.device === device && a.call !== null;
    const busy = [...tools.agents.values()].find(on);
    return busy === undefined ? null : "Computer task " + busy.name + " is still working on " + device + "; one works there at a time.";
  }

  export function working(tools: Tools): Agent[] {
    return [...tools.agents.values()].filter((a) => a.call !== null);
  }

  // every agent at work (name null), or the one named
  export function stop(tools: Tools, name: string | null): void {
    for (const agent of Tools.working(tools).filter((a) => name === null || a.name === name)) {
      agent.stop = true;
      agent.call?.stop();
    }
  }

}
