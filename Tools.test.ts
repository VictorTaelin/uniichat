// Tools test
// ==========
// `bun test Tools.test.ts`. A chat moves twice (A to B to C) while an
// agent's call still runs in A, its MCP requests sent to A's tools. B,
// once its relay is done, ends; A's requests must then reach C, not B:
// C taking the call tells A where the chat is (Main.far, Tools.went).

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

process.env.UNII_DIR = fs.mkdtempSync(os.tmpdir() + "/unii-tools-");

const { Tools } = await import("./Tools.ts");

test("a call's MCP requests follow its chat past a process that ended", async () => {
  const tools = Tools.serve({} as any, {} as any);
  const ask = () => fetch(Tools.at(tools, "main"), { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  // B: took the chat, then gave it on and ended
  const b = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("b") });
  const at_b = "http://127.0.0.1:" + b.port + "/";
  Tools.give(tools, at_b, () => "");
  expect(await (await ask()).text()).toBe("b");
  b.stop(true);
  // C: has the chat now; without Tools.went, A would still pass to B:
  // "Unable to connect", as every deploy's second handoff did
  const c = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => new Response("c " + new URL(req.url).pathname) });
  Tools.went(tools.key, "http://127.0.0.1:" + c.port + "/");
  expect(await (await ask()).text()).toBe("c /" + tools.key + "/main");
  c.stop(true);
});

// a stopped Claude Code (claude-sub) cancels its tool call with an MCP
// `notifications/cancelled` naming the request, its HTTP request left
// open: the device's job must stop, here or where the chat went
test("a cancel stops the job of the request it names, here and where its chat went", async () => {
  const tools = Tools.serve({} as any, {} as any);
  const sent: any[] = [];
  const term = { send: (m: object) => sent.push(m), live: () => true, computer: false, work: "/w" };
  tools.devices.set("d", { who: "u", terms: new Map([["t", term]]), jobs: new Map() });
  const post = (body: object) => fetch(Tools.at(tools, "main"), { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", ...body }) });
  const cancel = (requestId: unknown) => post({ method: "notifications/cancelled", params: { requestId, reason: "interrupted" } });
  const call = post({ id: 7, method: "tools/call", params: { name: "shell", arguments: { device: "d", command: "sleep 100" } } });
  while (!sent.some((m) => m.$ === "job")) {
    await Bun.sleep(5);
  }
  const jobs = (tools as any).devices.get("d").jobs as Map<string, unknown>;
  expect(jobs.size).toBe(1);
  // another id, or another caller's: nothing stops
  expect((await cancel(8)).status).toBe(202);
  await fetch(Tools.at(tools, "Agent1"), { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } }) });
  await Bun.sleep(20);
  expect(jobs.size).toBe(1);
  expect((await cancel(7)).status).toBe(202);
  const out: any = await (await call).json();
  expect(out).toMatchObject({ id: 7, result: { content: [{ type: "text", text: "Stopped." }], isError: true } });
  expect(jobs.size).toBe(0);
  expect(sent.at(-1)).toEqual({ $: "jobs", ids: [] });

  // the chat moved on: its request and the cancel of it go there, and the
  // request sent on is dropped
  const there: any[] = [];
  let dropped = false;
  const b = Bun.serve({
    port: 0, hostname: "127.0.0.1", idleTimeout: 0,
    async fetch(req) {
      const msg = await req.json();
      there.push(msg);
      if (msg.id === undefined) {
        return new Response(null, { status: 202 });
      }
      await new Promise<void>((ok) => req.signal.addEventListener("abort", () => ok(), { once: true }));
      dropped = true;
      return new Response(null, { status: 499 });
    },
  });
  Tools.give(tools, "http://127.0.0.1:" + b.port + "/", () => "");
  const far = post({ id: 9, method: "tools/call", params: { name: "shell", arguments: { device: "d", command: "sleep 100" } } }).catch(() => null);
  while (there.length === 0) {
    await Bun.sleep(5);
  }
  await cancel(9);
  await far;
  for (let i = 0; i < 100 && !dropped; i++) {
    await Bun.sleep(10);
  }
  expect(there.map((m) => m.method)).toEqual(["tools/call", "notifications/cancelled"]);
  expect(there[1].params.requestId).toBe(9);
  expect(dropped).toBe(true);
  b.stop(true);
});
