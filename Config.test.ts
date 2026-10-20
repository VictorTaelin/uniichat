// Config test
// ===========
// The keys sealed in keys.enc (Config.ts): sealed by a passphrase, read
// back by it alone, the environment's moved in. Each start its own
// process, as config is read once a process.

import { afterAll, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";

const DIRS = [fs.mkdtempSync(os.tmpdir() + "/unii-config-")];
process.env.UNII_DIR = DIRS[0];
const config = await import("./Config.ts");

afterAll(() => DIRS.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

// a process reading the config in `dir` with `env` (none of the keys
// else) and `stdin`: what it read, what is left of them in its
// environment,
// and what it would hand a worker
const READ = `
const config = await import(${JSON.stringify(import.meta.dir + "/Config.ts")});
const left = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "UNII_PASSPHRASE", "UNII_PASSPHRASE_FILE"].filter((v) => process.env[v] !== undefined);
console.log(JSON.stringify({ keys: config.KEYS, left, hand: JSON.parse(config.config_hand()) }));
process.exit(0);
`;
async function start(dir: string, env: Record<string, string>, stdin = "", umask = ""): Promise<{ code: number; out: any; said: string }> {
  fs.writeFileSync(dir + "/read.ts", READ);
  const base = { ...process.env };
  for (const v of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "RESEND_API_KEY", "APNS_KEY", "UNII_PASSPHRASE", "UNII_PASSPHRASE_FILE", "CREDENTIALS_DIRECTORY", "UNII_WORKER"]) {
    delete base[v];
  }
  const cmd = umask === "" ? [process.execPath, dir + "/read.ts"] : ["sh", "-c", "umask " + umask + " && exec \"$0\" \"$1\"", process.execPath, dir + "/read.ts"];
  const proc = Bun.spawn(cmd, { env: { ...base, UNII_DIR: dir, ...env }, stdin: stdin === "" ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe" });
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
  expect(fs.readdirSync(dir).sort()).toEqual(["keys.enc", "keys.lock", "read.ts"]);
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
  expect(none.said).toContain("needs its passphrase: set UNII_PASSPHRASE_FILE");
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

// a keys.enc made by hand with any envelope and scrypt cost
function box(pass: string, keys: object, over: Record<string, unknown> = {}, cost = { N: 2 ** 14, r: 8, p: 1 }): string {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(pass, salt, 32, { ...cost, maxmem: 2 ** 28 });
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(keys)), cipher.final()]);
  const b64 = (b: Buffer) => b.toString("base64");
  return JSON.stringify({ v: 1, kdf: "scrypt", ...cost, salt: b64(salt), iv: b64(iv), tag: b64(cipher.getAuthTag()), data: b64(data), ...over });
}

test("keys.enc records its scrypt cost, and is read by the cost it records", () => {
  const text = config.config_seal({ anthropic: "sk-a" }, "pw");
  const seal = JSON.parse(text);
  expect([seal.v, seal.kdf, seal.N, seal.r, seal.p]).toEqual([1, "scrypt", 2 ** 17, 8, 1]);
  expect(Buffer.from(seal.salt, "base64").length).toBe(16);
  // a cheaper one, as an older or another unii may have sealed
  expect(config.config_open(box("pw", { anthropic: "sk-old" }), "pw")).toEqual({ anthropic: "sk-old" });
  expect(config.config_open(box("pw", { anthropic: "sk-old" }, {}, { N: 2 ** 15, r: 4, p: 2 }), "pw")).toEqual({ anthropic: "sk-old" });
});

test("a damaged keys.enc says so, apart from a wrong passphrase", () => {
  const good = config.config_seal({ anthropic: "sk-a" }, "pw");
  const json = JSON.parse(good);
  const damaged: [string, string][] = [
    ["empty", ""],
    ["not JSON", "not json"],
    ["not JSON", good.slice(0, 60)],
    ["not an object", "[1]"],
    ["no version", JSON.stringify({ ...json, v: undefined })],
    ["salt missing or not base64", JSON.stringify({ ...json, salt: undefined })],
    ["tag missing or not base64", JSON.stringify({ ...json, tag: "!!" })],
    ["iv of 4 bytes, not 12", JSON.stringify({ ...json, iv: "AAAAAA==" })],
    ["tag of 3 bytes, not 16", JSON.stringify({ ...json, tag: "AAAA" })],
    ["no scrypt cost it can use", JSON.stringify({ ...json, N: 2 ** 30 })],
    ["no scrypt cost it can use", JSON.stringify({ ...json, N: 1000 })],
    ["no scrypt cost it can use", JSON.stringify({ ...json, N: undefined })],
    ["no scrypt cost it can use", JSON.stringify({ ...json, kdf: "argon2" })],
    ["sealed no keys", box("pw", { anthropic: 1 })],
    ["sealed no keys", box("pw", ["sk"])],
  ];
  for (const [why, text] of damaged) {
    expect(() => config.config_open(text, "pw")).toThrow("is damaged (" + why + ")");
  }
  // another version: named, not damaged
  expect(() => config.config_open(JSON.stringify({ ...json, v: 2 }), "pw")).toThrow("is of version 2; this unii reads version 1");
  // a wrong passphrase, or a byte changed: no keys, no error (the tag
  // can't tell those apart)
  expect(config.config_open(good, "wrong")).toBeNull();
  const tag = Buffer.from(json.tag, "base64");
  tag[0] ^= 1;
  expect(config.config_open(JSON.stringify({ ...json, tag: tag.toString("base64") }), "pw")).toBeNull();
});

test("a start on a damaged keys.enc fails saying so, not 'wrong passphrase'", async () => {
  const dir = fresh();
  fs.writeFileSync(dir + "/keys.enc", "{\"v\":1,\"salt\"");
  const got = await start(dir, { UNII_PASSPHRASE: "pw" });
  expect(got.code).not.toBe(0);
  expect(got.said).toContain("keys.enc is damaged (not JSON)");
  expect(got.said).not.toContain("not sealed by that passphrase");
  fs.writeFileSync(dir + "/keys.enc", JSON.stringify({ ...JSON.parse(config.config_seal({}, "pw")), v: 7 }));
  const newer = await start(dir, { UNII_PASSPHRASE: "pw" });
  expect(newer.code).not.toBe(0);
  expect(newer.said).toContain("is of version 7");
});

test("the passphrase from a file, or a systemd credential: the same as typed or set, newline or not", async () => {
  const dir = fresh();
  const file = dir + "-pass";
  DIRS.push(file);
  fs.writeFileSync(file, "pass phrase\n", { mode: 0o600 });
  const first = await start(dir, { ANTHROPIC_API_KEY: "sk-ant-f", UNII_PASSPHRASE_FILE: file });
  expect(first.code).toBe(0);
  expect(first.said).toContain("sealed anthropic in");
  expect(first.said).not.toContain("can be read by others");
  expect(first.out.left).toEqual([]);
  // the same passphrase, set, or in a file with no newline, or spaced
  for (const env of [{ UNII_PASSPHRASE: "pass phrase" }, { UNII_PASSPHRASE: "  pass phrase \n" }]) {
    expect((await start(dir, env)).out.keys.anthropic).toBe("sk-ant-f");
  }
  fs.writeFileSync(file, "pass phrase");
  expect((await start(dir, { UNII_PASSPHRASE_FILE: file })).out.keys.anthropic).toBe("sk-ant-f");
  fs.writeFileSync(file, "pass phrase\r\n\n");
  expect((await start(dir, { UNII_PASSPHRASE_FILE: file })).out.keys.anthropic).toBe("sk-ant-f");
  // inner spaces count
  fs.writeFileSync(file, "pass  phrase\n");
  expect((await start(dir, { UNII_PASSPHRASE_FILE: file })).said).toContain("is not sealed by that passphrase");
  // a systemd credential, no variable set
  const creds = dir + "-creds";
  DIRS.push(creds);
  fs.mkdirSync(creds);
  fs.writeFileSync(creds + "/unii-passphrase", "pass phrase\n", { mode: 0o400 });
  const cred = await start(dir, { CREDENTIALS_DIRECTORY: creds });
  expect(cred.code).toBe(0);
  expect(cred.out.keys.anthropic).toBe("sk-ant-f");
  // one others can read: still read, with a warning
  fs.writeFileSync(file, "pass phrase\n");
  fs.chmodSync(file, 0o644);
  const open = await start(dir, { UNII_PASSPHRASE_FILE: file });
  expect(open.out.keys.anthropic).toBe("sk-ant-f");
  expect(open.said).toContain(file + " can be read by others than you");
  // both ways at once, an empty file, a missing one: no start
  const both = await start(dir, { UNII_PASSPHRASE: "pass phrase", UNII_PASSPHRASE_FILE: file });
  expect(both.code).not.toBe(0);
  expect(both.said).toContain("set UNII_PASSPHRASE or UNII_PASSPHRASE_FILE, not both");
  fs.writeFileSync(file, " \n");
  const empty = await start(dir, { UNII_PASSPHRASE_FILE: file });
  expect(empty.code).not.toBe(0);
  expect(empty.said).toContain("the passphrase file " + file + " is empty");
  const missing = await start(dir, { UNII_PASSPHRASE_FILE: file + "-gone" });
  expect(missing.code).not.toBe(0);
  expect(missing.said).toContain("can't read the passphrase file " + file + "-gone (ENOENT)");
});

test("first starts at once, each with a key of its own: keys.enc keeps them all", async () => {
  for (let round = 0; round < 2; round++) {
    const dir = fresh();
    const keys = { ANTHROPIC_API_KEY: "sk-a", OPENAI_API_KEY: "sk-o", RESEND_API_KEY: "re_r", APNS_KEY: "apns-p" };
    const runs = await Promise.all(Object.entries(keys).map(([v, key]) => start(dir, { [v]: key, UNII_PASSPHRASE: "pw" })));
    expect(runs.map((run) => run.code)).toEqual([0, 0, 0, 0]);
    const after = await start(dir, { UNII_PASSPHRASE: "pw" });
    expect(after.out.keys).toEqual({ anthropic: "sk-a", openai: "sk-o", resend: "re_r", apns: "apns-p" });
    expect(fs.readdirSync(dir).filter((name) => name.startsWith("keys.enc"))).toEqual(["keys.enc"]);
  }
});

test("sealed under umask 000: keys.enc is 600 still", async () => {
  const dir = fresh();
  const got = await start(dir, { ANTHROPIC_API_KEY: "sk-a", UNII_PASSPHRASE: "pw" }, "", "000");
  expect(got.code).toBe(0);
  expect(fs.statSync(dir + "/keys.enc").mode & 0o777).toBe(0o600);
});
