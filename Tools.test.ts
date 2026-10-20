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

test("a subagent spawned with a model runs on that model", async () => {
  const chat = { vendor: "claude-api", model: "opus-5.5", effort: "high", speed: "fast" } as const;
  let pick: any = chat;
  const tools = { hooks: { pick: () => pick } } as any;
  const spawn = (model: string) => Tools.call(tools, "main", "spawn", { tasks: ["x"], model }, new AbortController().signal, "1");
  expect(await spawn("opus")).toMatchObject({ fail: true });
  const sub = (model: string | null) => ({ name: "A", role: { $: "sub", effort: null, model } }) as any;
  expect(Tools.pick(tools, sub(null))).toEqual(chat);
  // at a speed the model has: haiku has no fast
  expect(Tools.pick(tools, sub("haiku-5.5"))).toMatchObject({ vendor: "claude-api", model: "haiku-5.5", speed: "slow" });
  // the chat moved to another vendor since: it stays on its model
  pick = { vendor: "openai-api", model: "gpt-6-luna", effort: "low", speed: "slow" };
  expect(Tools.pick(tools, sub("haiku-5.5"))).toMatchObject({ vendor: "claude-api", model: "haiku-5.5" });
  // its model no longer offered: it fails, not switched to a pricier one
  expect(() => Tools.pick(tools, sub("haiku-4.5"))).toThrow();
});
