// Server test
// ===========
// `bun test Server.test.ts`. `./Server.ts <port>` alone serves the site
// (its prices only if it bills); with workers set, it is their
// supervisor, which only routes (a proxy in front sends each request to
// the worker it names).

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

// `./Server.ts <port>` on a fresh dir, with `env`: its answer to `path`,
// read whole, once it answers
async function server_get(port: number, env: Record<string, string>, path: string): Promise<Response> {
  const dir = fs.mkdtempSync(os.tmpdir() + "/unii-server-");
  const site = "http://127.0.0.1:" + port;
  const proc = Bun.spawn([process.execPath, import.meta.dir + "/Server.ts", String(port)], {
    env    : { ...process.env, UNII_DIR: dir, UNII_SITE: site, ...env },
    stdout : "ignore",
    stderr : "inherit",
  });
  try {
    for (let k = 0; k < 100; k++) {
      const res = await fetch(site + path).catch(() => null);
      if (res !== null) {
        return new Response(await res.text(), res);
      }
      await Bun.sleep(50);
    }
    throw new Error("no answer on " + site);
  } finally {
    proc.kill();
    await proc.exited;
  }
}

test("Server.ts alone serves the page", async () => {
  const res = await server_get(9461, {}, "/");
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("<title>");
});

test("with workers, Server.ts routes to them", async () => {
  const res = await server_get(9471, { UNII_WORKERS: "2" }, "/");
  expect(res.headers.get("x-unii-worker")).toMatch(/^127\.0\.0\.1:947[23]$/);
  expect(await res.text()).toBe("");
});

// a server says whether it bills (Billing.ts): this one doesn't, so it
// serves no prices or terms
test("a free server bills nothing: it says so, and shows no prices or terms", async () => {
  expect(await (await server_get(9481, {}, "/api/hello")).json()).toMatchObject({ bills: false, github: false });
  expect((await server_get(9482, {}, "/pricing")).status).toBe(404);
  expect((await server_get(9483, {}, "/terms.html")).status).toBe(404);
});

// a /model while the turn's call runs picks the next call's: the wait
// names the model the running one asked. Its own process, as config is
// read once a process (another test file's dir is not this one's)
const TURN = `
const { Chat } = await import(${JSON.stringify(import.meta.dir + "/Server.ts")});
const { AskAI } = await import(${JSON.stringify(import.meta.dir + "/AskAI.ts")});
const { Cloud } = await import(${JSON.stringify(import.meta.dir + "/Cloud.ts")});
Chat.cloud = Cloud.open(() => {}, () => {}, async () => null);
const chat = Chat.open({ id: "u1", name: "a@b.c" });
AskAI.ask = (ask, on) => AskAI.tie(on, ask.bill, () => {}, () => {})[0];
Chat.take(chat, Chat.push(chat, null, "user", "hi"));
await Bun.sleep(10);
const model = chat.pick.model;
const waited = Chat.waits(chat);
const to = { ...chat.pick, model: model === "opus-5.5" ? "haiku-5.5" : "opus-5.5" };
const acted = await Chat.act(chat, "pick", { $: "pick", to }, "");
console.log(JSON.stringify({ model, waited, acted, picked: chat.pick.model, to: to.model, after: Chat.waits(chat) }));
process.exit(0);
`;

test("a turn's wait names the model it runs on, not one picked since", async () => {
  const dir = fs.mkdtempSync(os.tmpdir() + "/unii-server-");
  fs.writeFileSync(dir + "/turn.ts", TURN);
  const proc = Bun.spawn([process.execPath, dir + "/turn.ts"], { env: { ...process.env, UNII_DIR: dir }, stdout: "pipe", stderr: "inherit" });
  const out = JSON.parse((await new Response(proc.stdout).text()).trim().split("\n").at(-1) ?? "{}");
  expect(out.model).toMatch(/\w/);
  expect(out.to).not.toBe(out.model);
  expect(out.waited).toBe(out.model);
  expect(out.acted).toEqual({});
  expect(out.picked).toBe(out.to);
  expect(out.after).toBe(out.model);
});

// whether a deploy's Config.ts takes the workers' keys as this server
// hands them (Main.hands): its code's HANDOVER, not a comment's, however
// written. Its own process, for its own UNII_DIR
const HANDS = `
const { Main } = await import(${JSON.stringify(import.meta.dir + "/Server.ts")});
const fs = require("node:fs");
const cases = JSON.parse(process.argv[2]);
console.log(JSON.stringify(cases.map((code, k) => {
  const path = process.env.UNII_DIR + "/Config" + k + ".ts";
  fs.writeFileSync(path, code);
  return Main.hands(path);
})));
process.exit(0);
`;

test("Main.hands: a deploy's Config.ts hands over alike by its code, not its comments", async () => {
  const dir = fs.mkdtempSync(os.tmpdir() + "/unii-server-");
  fs.writeFileSync(dir + "/hands.ts", HANDS);
  const ours = fs.readFileSync(import.meta.dir + "/Config.ts", "utf8");
  const cases: [string, boolean][] = [
    [ours, true],
    ["export const HANDOVER = 1;", true],
    ["export   const HANDOVER: number=1 // the keys on stdin\n", true],
    ["export const HANDOVER = 0x1", true],
    ["/* export const HANDOVER = 1; */\nexport const HANDOVER = 2;", false],
    ["// export const HANDOVER = 1;\n", false],
    ["const s = \"export const HANDOVER = 1;\";", false],
    ["export const HANDOVER = 1;\nexport const HANDOVER = 2;", false],
    ["export const HANDOVER = 2;", false],
    ["export const HANDOVER = (", false],
    ["", false],
  ];
  const proc = Bun.spawn([process.execPath, dir + "/hands.ts", JSON.stringify(cases.map(([code]) => code))], { env: { ...process.env, UNII_DIR: dir }, stdout: "pipe", stderr: "inherit" });
  const out = JSON.parse((await new Response(proc.stdout).text()).trim().split("\n").at(-1) ?? "[]");
  expect(out).toEqual(cases.map(([, ok]) => ok));
  expect(await proc.exited).toBe(0);
  fs.rmSync(dir, { recursive: true, force: true });
});

// a supervisor of 2 workers (each writes "<pid> <k>" to `pids` as it
// starts) whose Config.ts changes to hand over otherwise right after a
// deploy's first check (Main.hands sees it so from then on), as when a
// deploy's files are still being written
const RACE = `
const { Main, serve } = await import(${JSON.stringify(import.meta.dir + "/Server.ts")});
const real = Main.hands;
let checks = -1;
process.on("SIGHUP", () => (checks = 0));
Main.hands = (path) => (checks < 0 || checks++ === 0 ? real(path) : false);
await serve(Number(process.argv[2]), [process.execPath, "--preload", process.env.UNII_DIR + "/pid.ts", ${JSON.stringify(import.meta.dir + "/Server.ts")}]);
`;
const PID = `require("node:fs").appendFileSync(process.env.UNII_DIR + "/pids", process.pid + " " + process.env.UNII_WORKER + "\\n");`;

test("a deploy whose Config.ts changes after its first check leaves the workers serving; a dead one's start on it ends the server", async () => {
  const dir = fs.mkdtempSync(os.tmpdir() + "/unii-server-");
  fs.writeFileSync(dir + "/race.ts", RACE);
  fs.writeFileSync(dir + "/pid.ts", PID);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const site = "http://127.0.0.1:" + port;
  const log = dir + "/log";
  const env: Record<string, string | undefined> = { ...process.env, UNII_DIR: dir, UNII_SITE: site, UNII_WORKERS: "2" };
  for (const v of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "RESEND_API_KEY", "APNS_KEY", "UNII_PASSPHRASE", "UNII_PASSPHRASE_FILE", "CREDENTIALS_DIRECTORY", "UNII_WORKER"]) {
    delete env[v];
  }
  const proc = Bun.spawn([process.execPath, dir + "/race.ts", String(port)], { env, stdin: "ignore", stdout: Bun.file(log), stderr: Bun.file(dir + "/err") });
  const pids = () => (fs.existsSync(dir + "/pids") ? fs.readFileSync(dir + "/pids", "utf8").trim().split("\n").map((line) => Number(line.split(" ")[0])) : []);
  const up = async (k: number) => (await fetch("http://127.0.0.1:" + (port + 1 + k) + "/").catch(() => null)) !== null;
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    for (let k = 0; k < 200 && !(pids().length === 2 && (await up(0)) && (await up(1))); k++) {
      await Bun.sleep(50);
    }
    const before = pids();
    expect(before.length).toBe(2);
    await Bun.sleep(500);
    proc.kill("SIGHUP");
    await Bun.sleep(2000);
    const said = fs.readFileSync(dir + "/err", "utf8");
    // the replacements refused, the server and both workers on
    expect(proc.exitCode).toBeNull();
    expect(pids()).toEqual(before);
    expect(before.every(alive)).toBe(true);
    expect((await up(0)) && (await up(1))).toBe(true);
    expect(said).toContain("worker 0 not replaced");
    expect(said).toContain("worker 1 not replaced");
    // a worker that dies is started again only on code that hands over
    // alike: here none, so the server ends (1)
    process.kill(before[0], "SIGKILL");
    const code = await Promise.race([proc.exited, Bun.sleep(10000).then(() => "running")]);
    expect(code).toBe(1);
    expect(fs.readFileSync(dir + "/err", "utf8")).toContain("worker 0 not started");
    await Bun.sleep(500);
    expect(pids().some(alive)).toBe(false);
  } finally {
    proc.kill("SIGKILL");
    pids().forEach((pid) => alive(pid) && process.kill(pid, "SIGKILL"));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
