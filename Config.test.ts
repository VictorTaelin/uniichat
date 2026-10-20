// Config test
// ===========
// The keys sealed in keys.enc (Config.ts): sealed by a passphrase, read
// back by it alone, the environment's moved in. Each start its own
// process, as config is read once a process.

import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

const DIRS = [fs.mkdtempSync(os.tmpdir() + "/unii-config-")];
process.env.UNII_DIR = DIRS[0];
const config = await import("./Config.ts");

afterAll(() => DIRS.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

// a process reading the config in `dir` with `env` (none of the keys
// else) and `stdin`: what it read, what is left of them in its
// environment, and what it would hand a worker
const READ = `
const config = await import(${JSON.stringify(import.meta.dir + "/Config.ts")});
const left = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "UNII_PASSPHRASE"].filter((v) => process.env[v] !== undefined);
console.log(JSON.stringify({ keys: config.KEYS, left, hand: JSON.parse(config.config_hand()) }));
`;
async function start(dir: string, env: Record<string, string>, stdin = ""): Promise<{ code: number; out: any; said: string }> {
  fs.writeFileSync(dir + "/read.ts", READ);
  const base = { ...process.env };
  for (const v of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "RESEND_API_KEY", "APNS_KEY", "UNII_PASSPHRASE", "UNII_WORKER"]) {
    delete base[v];
  }
  const proc = Bun.spawn([process.execPath, dir + "/read.ts"], { env: { ...base, UNII_DIR: dir, ...env }, stdin: stdin === "" ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
  const text = await new Response(proc.stdout).text();
  const said = text + (await new Response(proc.stderr).text());
  const code = await proc.exited;
  const last = text.trim().split("\n").at(-1) ?? "";
  return { code, out: last.startsWith("{") ? JSON.parse(last) : null, said };
}
function fresh(): string {
  const dir = fs.mkdtempSync(os.tmpdir() + "/unii-config-");
  DIRS.push(dir);
  return dir;
}

test("config_seal: config_open reads the keys back by the passphrase alone", () => {
  const keys = { anthropic: "sk-ant-secret", apns: "-----BEGIN PRIVATE KEY-----\nAbC\n-----END PRIVATE KEY-----" };
  const text = config.config_seal(keys, "correct horse");
  expect(text).not.toContain("sk-ant-secret");
  expect(text).not.toContain("BEGIN");
  expect(config.config_open(text, "correct horse")).toEqual(keys);
  expect(config.config_open(text, "wrong horse")).toBeNull();
  // sealed anew each time: another salt and nonce
  expect(config.config_seal(keys, "correct horse")).not.toBe(text);
  // a byte changed is caught
  const box = JSON.parse(text);
  const data = Buffer.from(box.data, "base64");
  data[0] ^= 1;
  expect(config.config_open(JSON.stringify({ ...box, data: data.toString("base64") }), "correct horse")).toBeNull();
});

test("no keys.enc, no passphrase: the environment's keys, as ever, and no file", async () => {
  const dir = fresh();
  const got = await start(dir, { ANTHROPIC_API_KEY: "sk-ant-plain" });
  expect(got.code).toBe(0);
  expect(got.out.keys.anthropic).toBe("sk-ant-plain");
  expect(got.out.left).toEqual([]);
  expect(fs.existsSync(dir + "/keys.enc")).toBe(false);
});

test("a passphrase seals the environment's keys; later starts need only it", async () => {
  const dir = fresh();
  const first = await start(dir, { ANTHROPIC_API_KEY: " sk-ant-one ", UNII_PASSPHRASE: "pass phrase" });
  expect(first.code).toBe(0);
  expect(first.said).toContain("sealed anthropic in " + dir + "/keys.enc");
  expect(first.out.keys.anthropic).toBe("sk-ant-one");
  expect(first.out.left).toEqual([]);
  const file = dir + "/keys.enc";
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(fs.readFileSync(file, "utf8")).not.toContain("sk-ant-one");
  expect(fs.existsSync(file + ".new")).toBe(false);
  const sealed = fs.readFileSync(file, "utf8");

  // the key gone from the environment: read from the file, which stays
  const second = await start(dir, { UNII_PASSPHRASE: "pass phrase" });
  expect(second.code).toBe(0);
  expect(second.said).not.toContain("sealed");
  expect(second.out.keys).toEqual({ anthropic: "sk-ant-one", openai: "", resend: "", apns: "" });
  expect(second.out.left).toEqual([]);
  expect(fs.readFileSync(file, "utf8")).toBe(sealed);

  // a worker is handed the keys, not the passphrase
  expect(second.out.hand).toEqual(second.out.keys);

  // one added and one changed: both sealed in, the rest kept
  const third = await start(dir, { OPENAI_API_KEY: "sk-open", RESEND_API_KEY: "re_1", UNII_PASSPHRASE: "pass phrase" });
  expect(third.code).toBe(0);
  expect(third.said).toContain("sealed openai, resend in");
  const fourth = await start(dir, { RESEND_API_KEY: "re_2", UNII_PASSPHRASE: "pass phrase" });
  expect(fourth.said).toContain("sealed resend in");
  const fifth = await start(dir, { UNII_PASSPHRASE: "pass phrase" });
  expect(fifth.out.keys).toEqual({ anthropic: "sk-ant-one", openai: "sk-open", resend: "re_2", apns: "" });
});

test("keys.enc without its passphrase: the server won't start on no keys", async () => {
  const dir = fresh();
  await start(dir, { ANTHROPIC_API_KEY: "sk-ant-one", UNII_PASSPHRASE: "right" });
  const wrong = await start(dir, { UNII_PASSPHRASE: "wrong" });
  expect(wrong.code).not.toBe(0);
  expect(wrong.said).toContain("is not sealed by that passphrase");
  expect(wrong.said).not.toContain("sk-ant-one");
  // no terminal to type it at
  const none = await start(dir, {});
  expect(none.code).not.toBe(0);
  expect(none.said).toContain("needs its passphrase: set UNII_PASSPHRASE");
  // a wrong passphrase writes nothing, even with a key given
  const before = fs.readFileSync(dir + "/keys.enc", "utf8");
  await start(dir, { ANTHROPIC_API_KEY: "sk-ant-evil", UNII_PASSPHRASE: "wrong" });
  expect(fs.readFileSync(dir + "/keys.enc", "utf8")).toBe(before);
});

test("a worker takes the keys its supervisor hands it on stdin, not keys.enc", async () => {
  const dir = fresh();
  await start(dir, { ANTHROPIC_API_KEY: "sk-ant-one", UNII_PASSPHRASE: "right" });
  const keys = { anthropic: "sk-ant-one", openai: "sk-open", resend: "", apns: "" };
  const worker = await start(dir, { UNII_WORKER: "0" }, JSON.stringify(keys));
  expect(worker.code).toBe(0);
  expect(worker.out.keys).toEqual(keys);
});
