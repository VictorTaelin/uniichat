// Mcp
// ===
// The user's MCP servers (config.MCP: README), whose tools the master and
// its subagents get beside unii's own (Tools.ts), each named
// "<server>__<tool>", on every vendor. A server is a program run here
// (stdio: a JSON-RPC message a line each way), a program run on a device
// (`device`: each message a job of its terminal, Mcp.device, Mcp.here),
// or a URL (streamable HTTP: a POST each, answered as JSON or an event
// stream).
// Each chat runs its own (one user's never see another's), started by
// the first listing or call, ended as the chat closes, moves (a call
// running finishes first) or turns it off. One that fails to start, dies
// or times out fails its call saying why; the chat gets a note of each
// new why, and each agent's next listing gives it the notes it hasn't
// heard (Mcp.heard), for the request it builds. A dead one starts again
// at the next call; one that failed to start rests LIMITS.again first.
// While a device server's device isn't open, its tools are left out.

import * as os from "node:os";
import type { Out } from "./Agent.ts";
import type { Img } from "./AskAI.ts";
import { clip } from "./Clip.ts";
import type * as config from "./Config.ts";
import { Machine, type Job, type Spec } from "./Machine.ts";

// Types
// =====

// a link to a server: a request's result (a throw: why none), a
// notification sent, its end; why it is dead (null: it lives)
type Link = {
  ask   : (method: string, params: object, signal: AbortSignal) => Promise<any>;
  tell  : (method: string, params: object, signal?: AbortSignal) => Promise<void>;
  close : () => void;
  dead  : () => string | null;
};

// a chat's server: its config; its start or listing running or done (a
// string: why it has no tools); why its last start failed, and when it
// may be tried again; its link; the server's name of each tool by the
// model's; whether it said its tools changed; the note of why it has no
// tools (null: it works); what each agent last heard of it; the tools
// last told left out; the calls running; gone: it ends as its last call
// does (its chat moved)
export type Server = {
  conf  : config.McpServer;
  up    : Promise<Spec[] | string> | null;
  fail  : { why: string; till: number } | null;
  link  : Link | null;
  names : Map<string, string>;
  stale : boolean;
  said  : string | null;
  heard : Map<string, string | null>;
  left  : string;
  calls : number;
  gone  : boolean;
};

// a chat's servers, by name, how it is told of them, how it runs a job
// on a device (Tools.job), and whether a device is open (Tools.open)
export type Run = (device: string, job: Job, signal: AbortSignal) => Promise<Out>;
export type Servers = { all: Map<string, Server>; note: (text: string) => void; run: Run; open: (device: string) => boolean };

// Constants
// =========

// start: how long a server may take to run, initialize and list its
// tools (an npx's first run downloads it); again: how long one that
// failed to start rests; kill: how long a program ended has to exit
// before its process group is killed; msg: the most characters a
// message from a server may have; img: the most bytes of an image in a
// result (the vendors' limit)
export const LIMITS = { start: 60e3, again: 30e3, kill: 3e3, msg: 16 * 2 ** 20, img: 5 * 2 ** 20 };

// why an HTTP link is dead whose session its server ended (Mcp.call
// begins a new one)
const EXPIRED = "ended its session (HTTP 404)";

const VERSION = "2025-06-18";
const INIT    = { protocolVersion: VERSION, capabilities: {}, clientInfo: { name: "unii", version: "1" } };

// what a program's stderr shows of why it ended, at most
const TAIL = 1000;

// the variables of unii's a program gets (as the MCP SDK's client
// passes), beside its own `env`: no key, no other server's secret
const PASS = ["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR"];

// on a device, the programs it runs for chats (Mcp.here), by their
// link's key; whether each said its tools changed since its last answer
const HERE = new Map<string, { link: Link; changed: boolean }>();

// Mcp
// ===

export namespace Mcp {

  export function servers(note: (text: string) => void, confs: config.McpServer[], run: Run, open: (device: string) => boolean): Servers {
    const server = (conf: config.McpServer): Server => ({ conf, up: null, fail: null, link: null, names: new Map(), stale: false, said: null, heard: new Map(), left: "", calls: 0, gone: false });
    return { all: new Map(confs.map((conf) => [conf.name, server(conf)])), note, run, open };
  }

  // the tools of the servers not `off`, each started if it isn't
  export async function list(servers: Servers, off: string[]): Promise<Spec[]> {
    const on = [...servers.all.values()].filter((s) => !s.gone && !off.includes(s.conf.name));
    const lists = await Promise.all(on.map((s) => Mcp.start(servers, s)));
    return lists.flatMap((list) => (typeof list === "string" ? [] : list));
  }

  // the notes of the servers not `off` that agent `who` hasn't heard: why
  // one has no tools, or that it works again
  export function heard(servers: Servers, off: string[], who: string): string[] {
    const notes: string[] = [];
    for (const s of servers.all.values()) {
      if (s.gone || off.includes(s.conf.name) || s.said === (s.heard.get(who) ?? null)) {
        continue;
      }
      s.heard.set(who, s.said);
      notes.push(s.said ?? "MCP server " + s.conf.name + " works again.");
    }
    return notes;
  }

  // a server's tools: started (anew if its link died), listed again if
  // it said they changed; else why none, told
  export async function start(servers: Servers, s: Server): Promise<Spec[] | string> {
    if (s.conf.device && !servers.open(s.conf.device)) {
      Mcp.close(s);
      s.fail = null;
      const why = "can't run: device " + s.conf.device + " isn't open";
      Mcp.tell(servers, s, why + "; its tools are left out until it is");
      return why;
    }
    if (s.link !== null && s.link.dead() !== null) {
      Mcp.close(s);
    }
    if (s.up === null && s.fail !== null && Date.now() < s.fail.till) {
      return s.fail.why;
    }
    if (s.up === null) {
      s.up = Mcp.open(servers, s);
    } else if (s.stale) {
      s.stale = false;
      s.up = s.up.then(() => Mcp.listed(servers, s, AbortSignal.timeout(LIMITS.start))).catch((err) => "failed to list its tools: " + Mcp.why(err));
    }
    const up = s.up;
    const got = await up;
    if (s.up !== up) {
      return got;
    }
    if (typeof got === "string") {
      Mcp.close(s);
      s.fail = { why: got, till: Date.now() + LIMITS.again };
      Mcp.tell(servers, s, got + "; its tools are left out until it starts");
      return got;
    }
    s.fail = null;
    if (s.said !== null) {
      s.said = null;
      Mcp.say(servers, s, "MCP server " + s.conf.name + " works again.");
    }
    return got;
  }

  // a server run (or reached) and initialized, its tools listed, within
  // LIMITS.start; else why not. Once up, its link dying is told
  export async function open(servers: Servers, s: Server): Promise<Spec[] | string> {
    const timer = AbortSignal.timeout(LIMITS.start);
    const changed = () => (s.stale = true);
    let up = false;
    let link: Link | null = null;
    const died = (why: string) => up && s.link === link && Mcp.tell(servers, s, why + "; the next call starts it again");
    try {
      link = s.link = s.conf.url ? Mcp.http(s.conf, changed) : s.conf.device ? Mcp.device(s.conf, servers.run, changed, died) : Mcp.stdio(s.conf, changed, died);
      await link.ask("initialize", INIT, timer);
      await link.tell("notifications/initialized", {}, timer);
      const specs = await Mcp.listed(servers, s, timer);
      up = true;
      return specs;
    } catch (err) {
      return timer.aborted ? "didn't start within " + LIMITS.start / 1e3 + " s" : "failed to start: " + Mcp.why(err);
    }
  }

  // its tools, named for the model; one whose name clashes with another's
  // once made the vendors', or whose input schema they refuse, left out,
  // the chat told
  export async function listed(servers: Servers, s: Server, signal: AbortSignal): Promise<Spec[]> {
    const specs: Spec[] = [];
    const names = new Map<string, string>();
    const left: string[] = [];
    let cursor: string | undefined;
    do {
      const got = await s.link!.ask("tools/list", cursor === undefined ? {} : { cursor }, signal);
      for (const tool of Array.isArray(got?.tools) ? got.tools : []) {
        const name = Mcp.name(s.conf.name, String(tool?.name));
        const schema = names.has(name) ? "its name is another's for the model" : Mcp.schema(tool?.inputSchema);
        if (typeof schema === "string") {
          left.push(JSON.stringify(String(tool?.name)) + " (" + schema + ")");
          continue;
        }
        names.set(name, String(tool.name));
        specs.push({ name, info: String(tool.description ?? ""), schema });
      }
      cursor = typeof got?.nextCursor === "string" ? got.nextCursor : undefined;
    } while (cursor !== undefined);
    if (left.join(", ") !== s.left) {
      s.left = left.join(", ");
      if (s.left !== "") {
        Mcp.say(servers, s, "MCP server " + s.conf.name + " has tools left out: " + s.left + ".");
      }
    }
    s.names = names;
    return specs;
  }

  // an input schema the vendors take, else why none: an object's, with
  // properties (Anthropic refuses anyOf, oneOf and allOf at its top)
  export function schema(given: any): object | string {
    const is = (x: any) => typeof x === "object" && x !== null && !Array.isArray(x);
    const obj = is(given) ? given : {};
    if (obj.type !== undefined && obj.type !== "object") {
      return "its input isn't an object";
    }
    const top = ["anyOf", "oneOf", "allOf"].find((k) => k in obj);
    if (top !== undefined) {
      return "its input schema has " + top + " at its top, which the vendors refuse";
    }
    return { ...obj, type: "object", properties: is(obj.properties) ? obj.properties : {} };
  }

  // why a server has no tools, told to the chat if it is new
  export function tell(servers: Servers, s: Server, why: string): void {
    const text = "MCP server " + s.conf.name + " " + why + ".";
    if (text !== s.said) {
      s.said = text;
      Mcp.say(servers, s, text);
    }
  }

  // a note to the chat; none once it moved: the process it went to has it
  export function say(servers: Servers, s: Server, text: string): void {
    if (!s.gone) {
      servers.note(text);
    }
  }

  // the server whose tool the model calls `name` ("<server>__<tool>"), if
  // it is on: it might not have listed its tools in this process yet
  export function find(servers: Servers, off: string[], name: string): Server | null {
    const at = name.indexOf("__");
    const s = at > 0 ? servers.all.get(name.slice(0, at)) : undefined;
    return s !== undefined && !s.gone && !off.includes(s.conf.name) ? s : null;
  }

  // a tool call, cancelled at a stop or its server's timeout; its server
  // started first if it isn't running. A session the HTTP server ended
  // (404) is begun again and the call sent again, once
  export async function call(servers: Servers, s: Server, name: string, args: object, signal: AbortSignal): Promise<Out> {
    const head = "MCP server " + s.conf.name + " ";
    const fail = (text: string): Out => ({ text, fail: true });
    s.calls += 1;
    try {
      for (let again = true; ; again = false) {
        if (s.link === null || s.link.dead() !== null || !s.names.has(name) || (s.conf.device && !servers.open(s.conf.device))) {
          const got = await Mcp.start(servers, s);
          if (typeof got === "string") {
            return fail(head + got + ".");
          }
        }
        const link = s.link;
        if (link === null || !s.names.has(name)) {
          return fail("No tool " + name + ".");
        }
        const timer = AbortSignal.timeout(s.conf.timeout * 1000);
        try {
          return Mcp.out(await link.ask("tools/call", { name: s.names.get(name), arguments: args }, AbortSignal.any([signal, timer])));
        } catch (err) {
          const why = link.dead();
          if (signal.aborted) {
            return fail("Stopped.");
          }
          if (timer.aborted) {
            return fail(head + "didn't answer within " + s.conf.timeout + " s; the call was cancelled.");
          }
          if (again && why === EXPIRED) {
            continue;
          }
          const next = why === "was ended by unii" ? "." : "; the next call starts it again.";
          return fail(head + (why === null ? "failed: " + Mcp.why(err) + "." : why + next));
        }
      }
    } finally {
      s.calls -= 1;
      if (s.gone && s.calls === 0) {
        Mcp.close(s);
      }
    }
  }

  // a tool's result as unii's: its text (a resource's too, other parts
  // named; structured content if nothing else), cut to CAP; its images
  // the vendors take
  export function out(got: any): Out {
    const texts: string[] = [];
    const imgs: Img[] = [];
    for (const part of Array.isArray(got?.content) ? got.content : []) {
      const res = part?.resource;
      const pic = part?.type === "image" && typeof part.data === "string" && /^image\/(png|jpeg|gif|webp)$/.test(part.mimeType);
      if (part?.type === "text") {
        texts.push(String(part.text ?? ""));
      } else if (pic && part.data.length * 0.75 <= LIMITS.img) {
        imgs.push({ type: part.mimeType, data: part.data });
      } else if (part?.type === "resource" && typeof res?.text === "string") {
        texts.push(res.text);
      } else {
        texts.push("[" + [part?.type, part?.mimeType ?? res?.mimeType, part?.uri ?? res?.uri].filter((x) => typeof x === "string").join(" ") + "]");
      }
    }
    if (texts.length === 0 && imgs.length === 0 && got?.structuredContent !== undefined) {
      texts.push(JSON.stringify(got.structuredContent));
    }
    const text = clip();
    text.add(texts.join("\n"));
    return { text: text.text(), fail: got?.isError === true, imgs };
  }

  // a chat's servers end: at once, or (gone) each as its last call does
  export function end(servers: Servers): void {
    for (const s of servers.all.values()) {
      s.gone = true;
      if (s.calls === 0) {
        Mcp.close(s);
      }
    }
  }

  // a server ended (turned off, dead): its calls running fail
  export function close(s: Server): void {
    const link = s.link;
    s.link = null;
    link?.close();
    s.up = null;
    s.stale = false;
    s.names = new Map();
  }

  export function name(server: string, tool: string): string {
    return (server + "__" + tool).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  }

  export function why(err: any): string {
    return String(err?.message ?? err);
  }

  // a server's request answered: ping; none else is asked for
  export function answer(msg: any): object {
    if (msg.method === "ping") {
      return { jsonrpc: "2.0", id: msg.id, result: {} };
    }
    return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unii offers no " + msg.method } };
  }

  // a stream's text, a piece at a time; the stream let go once the
  // reader stops
  export async function* texts(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
    const reader = stream.getReader();
    const text = new TextDecoder();
    try {
      for (let got = await reader.read(); !got.done; got = await reader.read()) {
        yield text.decode(got.value, { stream: true });
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  }

  // Links
  // -----

  // a program in its own process group, a JSON-RPC message a line; its
  // stderr's tail says why it ended. It gets PASS and its own env; a
  // line past LIMITS.msg ends it
  export function stdio(conf: config.McpServer, changed: () => void, died: (why: string) => void): Link {
    const env = Object.fromEntries(PASS.flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k]!]])));
    const proc = Bun.spawn([conf.command, ...conf.args], { cwd: conf.cwd || undefined, env: { ...env, ...conf.env }, stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true });
    const waits = new Map<number, { ok: (got: any) => void; no: (err: Error) => void }>();
    let next = 0;
    let dead: string | null = null;
    let tail = "";
    let ended = false;
    const fail = (why: string) => {
      if (dead === null) {
        dead = why;
        died(why);
      }
      waits.forEach((w) => w.no(new Error(dead!)));
      waits.clear();
    };
    const write = (msg: object) => {
      try {
        proc.stdin.write(JSON.stringify(msg) + "\n");
        proc.stdin.flush();
      } catch {}
    };
    const heard = (line: string) => {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const w = waits.get(Number(msg?.id));
      if (msg?.method !== undefined && msg.id !== undefined) {
        write(Mcp.answer(msg));
      } else if (msg?.method === "notifications/tools/list_changed") {
        changed();
      } else if (w !== undefined) {
        waits.delete(Number(msg.id));
        msg.error === undefined ? w.ok(msg.result) : w.no(new Error(msg.error?.message ?? JSON.stringify(msg.error)));
      }
    };
    // its stdin closed, its group told to end, then killed
    const end = () => {
      if (!ended) {
        ended = true;
        try {
          proc.stdin.end();
        } catch {}
        try {
          process.kill(-proc.pid, "SIGTERM");
        } catch {}
        setTimeout(() => Machine.kill(-proc.pid), LIMITS.kill).unref();
      }
    };
    (async () => {
      let rest: string[] = [];
      let size = 0;
      for await (const chunk of Mcp.texts(proc.stdout)) {
        const parts = chunk.split("\n");
        rest.push(parts[0]);
        size += parts[0].length;
        const lines = parts.length === 1 ? [] : [rest.join(""), ...parts.slice(1, -1)];
        if (parts.length > 1) {
          [rest, size] = [[parts.at(-1)!], parts.at(-1)!.length];
        }
        if (size > LIMITS.msg || lines.some((line) => line.length > LIMITS.msg)) {
          throw new Error("sent a message over " + LIMITS.msg + " characters");
        }
        lines.forEach((line) => line.trim() !== "" && heard(line));
      }
    })().catch((err) => {
      fail(Mcp.why(err) + "; unii ended it");
      end();
    });
    const err = (async () => {
      for await (const chunk of Mcp.texts(proc.stderr)) {
        tail = (tail + chunk).slice(-TAIL);
      }
    })().catch(() => {});
    proc.exited.then(async (code) => {
      end();
      await Promise.race([err, Bun.sleep(200)]);
      const how = proc.signalCode ? "was killed by " + proc.signalCode : "exited with code " + code;
      const said = tail.trim();
      fail(how + (said === "" ? "" : ": " + said.split("\n").slice(-5).join(" / ")));
    });
    const tell = async (method: string, params: object) => write({ jsonrpc: "2.0", method, params });
    const ask = (method: string, params: object, signal: AbortSignal) => new Promise<any>((ok, no) => {
      if (dead !== null || signal.aborted) {
        return no(dead !== null ? new Error(dead) : signal.reason);
      }
      const id = ++next;
      const stop = () => {
        waits.delete(id);
        tell("notifications/cancelled", { requestId: id, reason: "stopped" });
        no(signal.reason ?? new Error("stopped"));
      };
      signal.addEventListener("abort", stop, { once: true });
      const done = () => signal.removeEventListener("abort", stop);
      waits.set(id, { ok: (got) => (done(), ok(got)), no: (err) => (done(), no(err)) });
      write({ jsonrpc: "2.0", id, method, params });
    });
    const close = () => {
      fail(dead ?? "was ended by unii");
      end();
    };
    return { ask, tell, close, dead: () => dead };
  }

  // a program run on a device: each message a job "mcp" of its terminal
  // (Mcp.here runs it there), keyed to this link; a device not open
  // fails the message; one whose program died (or whose unii restarted)
  // says why, and the link is dead
  export function device(conf: config.McpServer, run: Run, changed: () => void, died: (why: string) => void): Link {
    const key = crypto.randomUUID();
    const job = (input: object): Job => ({ name: "mcp", input: { key, ...input }, cwd: "" });
    let dead: string | null = null;
    const send = async (input: object, signal: AbortSignal) => {
      if (dead !== null) {
        throw new Error(dead);
      }
      const out = await run(conf.device, job(input), signal);
      if (signal.aborted) {
        throw signal.reason ?? new Error("stopped");
      }
      if (out.fail) {
        throw new Error(out.text);
      }
      const got = JSON.parse(out.text);
      if (got.changed) {
        changed();
      }
      if (got.dead && dead === null) {
        dead = got.dead + " (on " + conf.device + ")";
        died(dead);
      }
      if (dead !== null || got.error !== undefined) {
        throw new Error(dead ?? got.error);
      }
      return got.result;
    };
    const ask = (method: string, params: object, signal: AbortSignal) => send({ conf: method === "initialize" ? conf : undefined, method, params }, signal);
    const tell = (method: string, params: object, signal = AbortSignal.timeout(LIMITS.start)) => send({ method, params, tell: true }, signal).then(() => {});
    const close = () => {
      if (dead === null) {
        dead = "was ended by unii";
        run(conf.device, job({ method: "close" }), AbortSignal.timeout(LIMITS.start)).catch(() => {});
      }
    };
    return { ask, tell, close, dead: () => dead };
  }

  // on a device, a message of a chat's server (Mcp.device) to the program
  // it runs here: initialize starts it (Mcp.stdio, its `cwd` read here);
  // close ends it. Answered as JSON: its result or error, why it is dead,
  // whether its tools changed
  export async function here(input: any, signal: AbortSignal): Promise<Out> {
    const { key, method, params } = input;
    const answer = (got: object): Out => {
      const s = HERE.get(key);
      const changed = s?.changed ?? false;
      if (s) {
        s.changed = false;
      }
      return { text: JSON.stringify({ ...got, changed }), fail: false };
    };
    let s = HERE.get(key);
    if (method === "close") {
      s?.link.close();
      HERE.delete(key);
      return answer({});
    }
    if (method === "initialize") {
      s?.link.close();
      const cwd = String(input.conf.cwd ?? "").replace(/^~(?=\/|$)/, os.homedir());
      const run = { link: null as unknown as Link, changed: false };
      run.link = Mcp.stdio({ ...input.conf, cwd }, () => (run.changed = true), () => {});
      HERE.set(key, (s = run));
    }
    if (s === undefined) {
      return answer({ dead: "isn't running: unii there restarted or lost the server" });
    }
    try {
      const result = input.tell ? await s.link.tell(method, params) : await s.link.ask(method, params, signal);
      return answer({ result });
    } catch (err) {
      const dead = s.link.dead();
      if (dead !== null) {
        HERE.delete(key);
      }
      return answer(dead !== null ? { dead } : { error: Mcp.why(err) });
    }
  }

  // on a device, its socket to the server lost (Term.ts): the programs it
  // ran for chats end, as no close may come; a chat's next message finds
  // its program gone, and starts it again
  export function lost(): void {
    HERE.forEach((s) => s.link.close());
    HERE.clear();
  }

  // a URL, each message a POST, its session kept by its header (one the
  // server ended, HTTP 404, ends the link: EXPIRED); an answer is JSON or
  // an event stream (the server's requests and notifications in it, then
  // the answer), at most LIMITS.msg characters. Ended, its requests
  // running are aborted and its session DELETEd
  export function http(conf: config.McpServer, changed: () => void): Link {
    let session: string | null = null;
    let version: string | null = null;
    let dead: string | null = null;
    let next = 0;
    const ender = new AbortController();
    const headers = (): Record<string, string> => ({
      "content-type" : "application/json",
      "accept"       : "application/json, text/event-stream",
      ...conf.headers,
      ...(session === null ? {} : { "mcp-session-id": session }),
      ...(version === null ? {} : { "mcp-protocol-version": version }),
    });
    const post = (msg: object, signal: AbortSignal) => {
      return fetch(conf.url, { method: "POST", headers: headers(), body: JSON.stringify(msg), signal: AbortSignal.any([signal, ender.signal]), timeout: false } as RequestInit);
    };
    const tell = async (method: string, params: object, signal = AbortSignal.timeout(LIMITS.start)) => {
      const res = await post({ jsonrpc: "2.0", method, params }, signal);
      await res.body?.cancel();
      if (!res.ok) {
        throw new Error("HTTP " + res.status);
      }
    };
    // a message: the server's request answered, a change noted; else it,
    // if it answers `id`
    const heard = (msg: any, id: number): any => {
      if (msg?.method !== undefined && msg.id !== undefined) {
        post(Mcp.answer(msg), AbortSignal.timeout(LIMITS.start)).then((res) => res.body?.cancel(), () => {});
      } else if (msg?.method === "notifications/tools/list_changed") {
        changed();
      } else if (Number(msg?.id) === id) {
        return msg;
      }
      return null;
    };
    // the answer to `id` in a response: its JSON, or an event stream's,
    // each event's data lines joined, read till it comes
    const read = async (res: Response, id: number): Promise<any> => {
      const sse = (res.headers.get("content-type") ?? "").includes("text/event-stream");
      const event = (text: string) => {
        const data = text.split(/\r\n|\r|\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, ""));
        try {
          return data.length === 0 ? null : heard(JSON.parse(data.join("\n")), id);
        } catch {
          return null;
        }
      };
      let text = "";
      for await (const chunk of Mcp.texts(res.body!)) {
        text += chunk;
        if (text.length > LIMITS.msg) {
          throw new Error("sent a message over " + LIMITS.msg + " characters");
        }
        const events = sse ? text.split(/\r\n\r\n|\n\n|\r\r/) : [];
        text = sse ? events.pop()! : text;
        for (const msg of events.map(event)) {
          if (msg !== null) {
            return msg;
          }
        }
      }
      return sse ? event(text) : heard(JSON.parse(text), id);
    };
    const ask = async (method: string, params: object, signal: AbortSignal) => {
      if (dead !== null) {
        throw new Error(dead);
      }
      const id = ++next;
      const stop = () => tell("notifications/cancelled", { requestId: id, reason: "stopped" }).catch(() => {});
      signal.addEventListener("abort", stop, { once: true });
      try {
        const res = await post({ jsonrpc: "2.0", id, method, params }, signal);
        if (res.status === 404 && session !== null) {
          await res.body?.cancel();
          end(EXPIRED);
          throw new Error(EXPIRED);
        }
        if (!res.ok) {
          throw new Error("HTTP " + res.status + ": " + (await res.text()).slice(0, 300));
        }
        session = method === "initialize" ? res.headers.get("mcp-session-id") : session;
        const msg = await read(res, id);
        if (msg === null) {
          throw new Error("no answer to " + method);
        }
        if (msg.error !== undefined) {
          throw new Error(msg.error?.message ?? JSON.stringify(msg.error));
        }
        version = method === "initialize" ? String(msg.result?.protocolVersion ?? VERSION) : version;
        return msg.result;
      } catch (err) {
        if (Mcp.why(err).startsWith("sent a message over")) {
          end(Mcp.why(err) + "; unii ended it");
        }
        throw dead !== null ? new Error(dead) : err;
      } finally {
        signal.removeEventListener("abort", stop);
      }
    };
    const end = (why: string) => {
      if (dead === null) {
        dead = why;
        ender.abort(new Error(why));
        if (session !== null && why !== EXPIRED) {
          fetch(conf.url, { method: "DELETE", headers: headers(), signal: AbortSignal.timeout(LIMITS.kill) }).then((res) => res.body?.cancel(), () => {});
        }
      }
    };
    return { ask, tell, close: () => end("was ended by unii"), dead: () => dead };
  }

}
