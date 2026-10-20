// Mcp test
// ========
// `bun test Mcp.test.ts`. The user's MCP servers as the model reaches
// them, through a chat's tools (Tools.ts): a fake stdio server (FAKE,
// run by bun) and a fake streamable HTTP one; their tools listed beside
// unii's own, called, turned off, crashing, timing out, failing to
// start; a chat that moves or closes; a stdio server run on a device,
// through a fake terminal, its device closing and opening again; the
// notes an agent's listing gives its own request.

import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

const dir = fs.mkdtempSync(os.tmpdir() + "/unii-mcp-");
process.env.UNII_DIR = dir;

// a stdio MCP server: tools on two pages; echo, a slow call, a crash
// (its stderr says why), its pid, its environment, a child that ignores
// SIGTERM, a long line.
// FAKE_MODE=exit: it dies at once, saying why; bad: tools whose schema
// the vendors refuse
const FAKE = `
if (process.env.FAKE_MODE === "exit") {
  console.error("no token given");
  process.exit(1);
}
const obj = { type: "object", properties: {} };
const tool = (name) => ({ name, description: name + ".", inputSchema: obj });
const tools = ["echo", "slow", "crash", "pid", "odd.name/x", "env", "child", "crashlate", "flood"].map(tool);
if (process.env.FAKE_MODE === "bad") {
  tools.push({ name: "anyof", inputSchema: { type: "object", anyOf: [{ required: ["a"] }, { required: ["b"] }] } }, { name: "arr", inputSchema: { type: "array" } }, { name: "nullprops", inputSchema: { type: "object", properties: null } });
}
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const text = (id, t) => send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: t }] } });
for await (const line of console) {
  const m = JSON.parse(line);
  const a = m.params?.arguments ?? {};
  if (m.method === "initialize") {
    send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: "fake", version: "1" } } });
  } else if (m.method === "tools/list") {
    send({ jsonrpc: "2.0", id: m.id, result: m.params?.cursor ? { tools: tools.slice(4) } : { tools: tools.slice(0, 4), nextCursor: "2" } });
  } else if (m.method === "tools/call") {
    switch (m.params.name) {
      case "echo": text(m.id, "echo: " + a.text); break;
      case "slow": setTimeout(() => text(m.id, "slept"), 5000); break;
      case "crash": console.error("boom: the disk is on fire"); setTimeout(() => process.exit(3), 50); break;
      case "crashlate": setTimeout(() => process.exit(3), 300); break;
      case "pid": text(m.id, String(process.pid)); break;
      case "env": text(m.id, JSON.stringify(process.env)); break;
      case "child": text(m.id, String(Bun.spawn([process.execPath, "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "ignore"] }).pid)); break;
      case "flood": text(m.id, "x".repeat(a.n)); break;
      default: send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "no such tool" }], isError: true } });
    }
  } else if (m.id !== undefined) {
    send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no " + m.method } });
  }
}
`;
const fake = dir + "/fake.js";
fs.writeFileSync(fake, FAKE);

// a streamable HTTP MCP server: a session by its header (any other gets
// 404), a call answered as an event stream (CRLF) after a notification;
// what it was sent, in `seen`
const web = { session: "", n: 0, seen: [] as any[] };
const http = Bun.serve({
  port     : 0,
  hostname : "127.0.0.1",
  async fetch(req) {
    if (new URL(req.url).pathname === "/broken") {
      return new Response("down for maintenance", { status: 503 });
    }
    if (req.method === "DELETE") {
      return new Response(null, { status: 200 });
    }
    const m = await req.json();
    web.seen.push({ m, session: req.headers.get("mcp-session-id"), version: req.headers.get("mcp-protocol-version"), auth: req.headers.get("authorization") });
    if (m.method === "initialize") {
      web.session = "s" + ++web.n;
      const result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "web", version: "1" } };
      return Response.json({ jsonrpc: "2.0", id: m.id, result }, { headers: { "mcp-session-id": web.session } });
    }
    if (req.headers.get("mcp-session-id") !== web.session) {
      return new Response("no session", { status: 404 });
    }
    if (m.id === undefined) {
      return new Response(null, { status: 202 });
    }
    if (m.method === "tools/list") {
      const tool = (name: string) => ({ name, description: name + ".", inputSchema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } });
      return Response.json({ jsonrpc: "2.0", id: m.id, result: { tools: [tool("add")] } });
    }
    const events = [
      { jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } },
      { jsonrpc: "2.0", id: m.id, result: { content: [], structuredContent: { sum: m.params.arguments.a + m.params.arguments.b } } },
    ];
    const body = events.map((e) => "event: message\r\ndata: " + JSON.stringify(e) + "\r\n\r\n").join("");
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  },
});

process.env.FAKE_TOKEN = "t0ken-0123456789";
process.env.UNII_MCP = JSON.stringify({
  mcpServers: {
    fake   : { command: process.execPath, args: [fake] },
    slowpo : { command: process.execPath, args: [fake], timeout: 1 },
    gone   : { command: "/nonexistent/mcp-server" },
    dies   : { command: process.execPath, args: [fake], env: { FAKE_MODE: "exit" } },
    web    : { type: "http", url: "http://127.0.0.1:" + http.port + "/mcp", headers: { Authorization: "Bearer ${FAKE_TOKEN}" } },
    broken : { url: "http://127.0.0.1:" + http.port + "/broken" },
  },
});

const config = await import("./Config.ts");
const { Tools } = await import("./Tools.ts");
const { Mcp, LIMITS } = await import("./Mcp.ts");
const { Machine } = await import("./Machine.ts");
const LIMITS0 = { ...LIMITS };
const bun = process.execPath;

// a chat's tools: its memory just the servers it turned off, its notes
// kept (an agent's as "Name: text"); one subagent and one computer task
const open: any[] = [];
function chat(servers?: object) {
  const notes: string[] = [];
  const hooks = { note: (text: string) => notes.push(text), push: (agent: any, _kind: string, text: string) => notes.push(agent.name + ": " + text) };
  const tools = Tools.serve({ off: [] } as any, hooks as any);
  tools.agents.set("Sub", { name: "Sub", role: { $: "sub", effort: null } } as any);
  tools.agents.set("Hand", { name: "Hand", role: { $: "hands", device: "mac" } } as any);
  if (servers !== undefined) {
    tools.mcp = Mcp.servers((text: string) => notes.push(text), config.config_mcp(servers), tools.mcp.run, tools.mcp.open);
  }
  open.push(tools);
  return { tools, notes };
}

async function rpc(tools: any, who: string, method: string, params: object = {}): Promise<any> {
  const res = await fetch(Tools.at(tools, who), { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await res.json()).result;
}

async function names(tools: any, who = "main"): Promise<string[]> {
  return (await rpc(tools, who, "tools/list")).tools.map((t: any) => t.name);
}

async function call(tools: any, name: string, args: object = {}, who = "main"): Promise<any> {
  return rpc(tools, who, "tools/call", { name, arguments: args });
}

// whether a process lives (not a zombie)
function alive(pid: number): boolean {
  return Machine.alive(pid) && !/^\d+ \(.*\) Z/.test(fs.readFileSync("/proc/" + pid + "/stat", "utf8"));
}

afterEach(() => {
  open.splice(0).forEach((tools) => Tools.close(tools));
  Object.assign(LIMITS, LIMITS0);
});

test("config: Claude's mcpServers shape; plain http to any host; names that would clash refused", () => {
  expect(config.MCP.map((s) => s.name)).toEqual(["fake", "slowpo", "gone", "dies", "web", "broken"]);
  expect(config.MCP[4].headers.Authorization).toBe("Bearer t0ken-0123456789");
  expect(config.config_mcp({ ha: { type: "http", url: "http://homeassistant.local:8123/mcp_server/sse" } })[0].url).toBe("http://homeassistant.local:8123/mcp_server/sse");
  expect(() => config.config_mcp({ a__b: { command: "x" } })).toThrow();
  expect(() => config.config_mcp("{oops")).toThrow();
});

test("the servers' tools come beside unii's own, for the master and subagents, not computer tasks; failed starts told, not fatal", async () => {
  const { tools, notes } = chat();
  const main = await names(tools);
  expect(main).toContain("spawn");
  expect(main).toContain("fake__odd_name_x");
  expect(main).toContain("fake__flood");
  expect(main).toContain("web__add");
  expect(await names(tools, "Sub")).toContain("fake__echo");
  expect(await names(tools, "Hand")).toEqual(["computer"]);
  expect((await call(tools, "fake__echo", { text: "hi" }, "Hand")).isError).not.toBe(false);
  for (const name of ["gone", "dies", "broken"]) {
    expect(notes.some((n) => n.startsWith("MCP server " + name + " failed to start"))).toBe(true);
  }
});

test("a call: stdio and HTTP event stream; a line past the limit ends the server, not unii", async () => {
  const { tools } = chat();
  await names(tools);
  expect(await call(tools, "fake__echo", { text: "hello" })).toEqual({ content: [{ type: "text", text: "echo: hello" }], isError: false });
  expect((await call(tools, "web__add", { a: 2, b: 3 })).content[0].text).toBe('{"sum":5}');
  expect(web.seen.at(-1)).toMatchObject({ session: web.session, auth: "Bearer t0ken-0123456789" });
  LIMITS.msg = 1000;
  expect((await call(tools, "fake__flood", { n: 5000 })).isError).toBe(true);
  expect((await call(tools, "fake__echo", { text: "back" })).content[0].text).toBe("echo: back");
});

test("a server turned off in a chat: no tools, its program and its children ended", async () => {
  LIMITS.kill = 300;
  const { tools } = chat();
  await names(tools);
  const pid = Number((await call(tools, "fake__pid")).content[0].text);
  const child = Number((await call(tools, "fake__child")).content[0].text);
  tools.mem.off = ["fake"];
  Tools.unplug(tools, "fake");
  expect((await names(tools)).some((n) => n.startsWith("fake__"))).toBe(false);
  await Bun.sleep(800);
  expect([alive(pid), alive(child)]).toEqual([false, false]);
});

test("a crash fails its call and is told; the next call starts it again", async () => {
  const { tools, notes } = chat();
  const out = await call(tools, "fake__crash");
  expect(out.isError).toBe(true);
  expect(out.content[0].text).toContain("boom: the disk is on fire");
  expect(notes).toContain(out.content[0].text);
  expect((await call(tools, "fake__echo", { text: "back" })).content[0].text).toBe("echo: back");
});

test("a call past its timeout is cancelled, not left hanging", async () => {
  const { tools } = chat();
  await names(tools);
  expect((await call(tools, "slowpo__slow")).isError).toBe(true);
});

test("an HTTP server that ended its session gets a new one, the call sent again", async () => {
  const { tools } = chat();
  await names(tools);
  web.session = "expired";
  expect((await call(tools, "web__add", { a: 1, b: 1 })).content[0].text).toBe('{"sum":2}');
});

test("a call running as its chat moves finishes here, never done again there", async () => {
  const { tools, notes } = chat();
  await names(tools);
  const pid = Number((await call(tools, "fake__pid")).content[0].text);
  let again = 0;
  const far = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => (again++, Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "moved" }] } })) });
  const late = call(tools, "fake__crashlate");
  await Bun.sleep(100);
  Tools.give(tools, "http://127.0.0.1:" + far.port + "/", () => "");
  expect((await late).isError).toBe(true);
  expect(again).toBe(0);
  expect((await call(tools, "fake__echo", { text: "x" })).content[0].text).toBe("moved");
  await Bun.sleep(300);
  expect(alive(pid)).toBe(false);
  expect(notes.filter((n) => n.startsWith("MCP server fake"))).toEqual([]);
  far.stop(true);
});

test("a chat closed ends its servers' programs", async () => {
  const { tools } = chat();
  await names(tools);
  const pid = Number((await call(tools, "fake__pid")).content[0].text);
  Tools.close(tools);
  await Bun.sleep(300);
  expect(alive(pid)).toBe(false);
});

test("a tool whose input schema the vendors refuse is left out, the others kept", async () => {
  const { tools, notes } = chat({ d: { command: bun, args: [fake], env: { FAKE_MODE: "bad" } } });
  const all = (await rpc(tools, "main", "tools/list")).tools;
  expect(all.some((t: any) => t.name === "d__anyof" || t.name === "d__arr")).toBe(false);
  expect(all.find((t: any) => t.name === "d__nullprops").inputSchema).toEqual({ type: "object", properties: {} });
  expect(all.some((t: any) => t.name === "d__echo")).toBe(true);
  expect(notes.length).toBe(1);
});

test("a server's program never gets UNII_MCP or others' secrets", async () => {
  expect(process.env.UNII_MCP).toBeUndefined();
  const { tools } = chat({ e: { command: bun, args: [fake], env: { FAKE_OWN: "mine" } } });
  const env = JSON.parse((await call(tools, "e__env")).content[0].text);
  expect(env.FAKE_OWN).toBe("mine");
  expect([env.UNII_MCP, env.FAKE_TOKEN, env.UNII_DIR]).toEqual([undefined, undefined, undefined]);
});

// Devices
// -------

// a device's terminal, as Term.ts is one: each job sent run by
// Machine.run, its output answered; jobs no longer listed halted
function terminal(tools: any, host: string) {
  const jobs = new Map<string, AbortController>();
  const send = (msg: any) => {
    if (msg.$ === "jobs") {
      jobs.forEach((abort, id) => !msg.ids.includes(id) && abort.abort());
    } else if (msg.$ === "job" && !jobs.has(msg.id)) {
      const job = JSON.parse(JSON.stringify(msg.job));
      const abort = new AbortController();
      jobs.set(msg.id, abort);
      Machine.run(job, dir + "/dev", abort.signal).then((out) => (jobs.delete(msg.id), Tools.done(tools, host, msg.id, out)));
    }
  };
  Tools.attach(tools, "term-" + host, host, "me", { send, live: () => true, computer: false, work: "" });
}

test("a stdio server on a device: runs there; one that died there starts again at the next call", async () => {
  const { tools } = chat({ there: { command: bun, args: [fake], device: "phone" } });
  terminal(tools, "phone");
  expect(await call(tools, "there__echo", { text: "hi" })).toEqual({ content: [{ type: "text", text: "echo: hi" }], isError: false });
  expect((await call(tools, "there__crash")).isError).toBe(true);
  expect((await call(tools, "there__echo", { text: "back" })).content[0].text).toBe("echo: back");
  const pid = Number((await call(tools, "there__pid")).content[0].text);
  Tools.close(tools);
  await Bun.sleep(500);
  expect(alive(pid)).toBe(false);
});

// a bug found live: a closed device's tools were still offered
test("a server's device closed: its tools left out, told once; reopened, they come back", async () => {
  const { tools, notes } = chat({ there: { command: bun, args: [fake], device: "phone" } });
  terminal(tools, "phone");
  const mine = async () => (await names(tools)).filter((n) => n.startsWith("there__"));
  expect(await mine()).toContain("there__echo");
  Tools.detach(tools, "term-phone", "phone");
  expect(await mine()).toEqual([]);
  expect(await mine()).toEqual([]);
  expect((await call(tools, "there__echo", { text: "hi" })).isError).not.toBe(false);
  expect(notes.length).toBe(1);
  terminal(tools, "phone");
  expect(await mine()).toContain("there__echo");
  expect((await call(tools, "there__echo", { text: "back" })).content[0].text).toBe("echo: back");
});

// bugs found live: a listing's note missed that same request, and a
// subagent's notes went to the chat, not to its own request
test("an agent's request says why a server has no tools, made by its own listing or before; once, then that it works again", async () => {
  const { tools } = chat({ there: { command: bun, args: [fake], device: "phone" } });
  // a call's requests, against a fake Anthropic
  const { Agent } = await import("./Agent.ts");
  config.KEYS.anthropic = "test";
  const sent: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    if (!String(url).startsWith("https://api.anthropic.com/")) {
      return real(url, init);
    }
    if (String(url).includes("count_tokens")) {
      return Response.json({ input_tokens: 10 });
    }
    const body = JSON.parse(init.body);
    sent.push(body.messages[0].content.map((p: any) => p.text ?? "").join("") + " tools: " + body.tools.map((t: any) => t.name).join(" "));
    const events = [
      { type: "message_start", message: { usage: {} } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ];
    return new Response(events.map((ev) => "data: " + JSON.stringify(ev) + "\n\n").join(""));
  }) as any;
  const ask = (who: string, text: string) => Agent.ask({ vendor: "claude-api", model: "claude-opus-5-5", effort: "medium", speed: "slow", system: "x", blocks: [{ text: "view", mark: true }, { text, mark: true }], searches: 0, server: Tools.at(tools, who) } as any, () => {}).done;
  try {
    expect((await ask("main", "turn one")).ok).toBe(true);
    expect((await ask("Sub", "task one")).ok).toBe(true);
    expect((await ask("Sub", "task two")).ok).toBe(true);
    terminal(tools, "phone");
    expect((await ask("Sub", "task three")).ok).toBe(true);
  } finally {
    globalThis.fetch = real;
  }
  expect(sent[0]).toContain("Note: MCP server there can't run");
  expect(sent[1]).toContain("Note: MCP server there can't run");
  expect(sent[2]).not.toContain("Note: ");
  expect(sent[3]).toContain("Note: MCP server there works again.");
  expect(sent[3]).toContain("there__echo");
});
