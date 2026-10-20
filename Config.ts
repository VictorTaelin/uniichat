// Config
// ======
// The server's settings. Its DIR ($UNII_DIR, default ~/.unii) holds
// config.json, the lock, keys.enc (and keys.lock) and users/<id>. Each
// key of config.json (README) may be set as UNII_<KEY> instead; a path
// may start with "~/".
// The keys are read from the environment and removed from it, so no
// program an agent runs inherits them, and handed to the workers on
// their stdin, so none sits in theirs.
//
// keys.enc holds them sealed, so none need sit in a file in plain text:
// AES-256-GCM, by a key scrypt makes of a passphrase: $UNII_PASSPHRASE
// (taken out of the environment too, though /proc/<pid>/environ still
// shows it), or read from the file $UNII_PASSPHRASE_FILE names (or a
// systemd credential), else typed at the terminal it starts at. Given
// it, the server seals in each key the environment holds that the file
// lacks or holds otherwise: one start with a key set moves it there;
// then it can leave the environment. A worker gets the keys from its
// supervisor (config_hand), not the file. Sealed, the keys are safe at
// rest (a copy, a backup); not from code running as the server's user
// while it runs, nor in a core dump or swap of it.

import { Database } from "bun:sqlite";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import type { Vendor } from "./AskAI.ts";
import { LABELS, VENDORS, Pick, type Offer } from "./Pick.ts";

// Constants
// =========

export const DIR = config_path(process.env.UNII_DIR ?? "~/.unii");

const PATH = DIR + "/config.json";
const FILE: Record<string, string> = fs.existsSync(PATH) ? JSON.parse(fs.readFileSync(PATH, "utf8")) : {};

export const SITE    = config_get("site", "http://127.0.0.1:8788").replace(/\/$/, "");
export const OFFER: Offer = {
  vendors : config_vendors(config_get("vendors", "claude-api")),
  models  : config_get("models", LABELS.join()).split(",").map((m) => m.trim()),
};

export const WORK       = config_path(config_get("work", DIR + "/work"));
export const RULES      = config_path(config_get("rules", ""));
export const AFTER      = config_get("after", "");
export const PICK       = config_run("pick", config_get("pick", "claude-api:sonnet-5.5:medium:slow"));

// what every compaction runs on, a chat's and an import's alike, whatever
// the chat's pick
export const COMPACTOR  = config_run("compactor", config_get("compactor", "claude-api:haiku-5.5:high:slow"));
export const AGENTS     = config_get("agents", "") ? config_run("agents", config_get("agents", "")) : null;
export const WORKERS    = Number(config_get("workers", "0"));

// the iOS app (ios/, Cloud.ts): its App ID, the team's then the bundle's
// ("TEAM.com.example.uniichat"), whose app sign-in links open; and
// the id of the key its pushes are signed with (APNS_KEY holds the key)
export const APPLE      = config_get("apple", "");
export const APNS       = config_get("apns", "");

// the keys, by name, and the variable each is read from
const VARS: Record<string, string> = {
  anthropic       : "ANTHROPIC_API_KEY",
  openai          : "OPENAI_API_KEY",
  resend          : "RESEND_API_KEY",
  apns            : "APNS_KEY",
};

// where the keys are sealed (config_keys); what one start at a time
// holds to add to it (config_store); and the name of the systemd
// credential that may hold its passphrase (LoadCredential=)
export const SEALED = DIR + "/keys.enc";
const SEALING = DIR + "/keys.lock";
const CREDENTIAL = "unii-passphrase";

// scrypt's cost when sealing (some 0.2 s and 128 MiB), kept in keys.enc
// beside the salt, so it may be raised and older files still open; one
// read is bounded by KDF_MAX (all the memory scrypt takes: config_mem,
// here 1 GiB). The first keys.enc (no cost kept) had KDF_FIRST: one is
// read by it, then sealed anew by KDF
const KDF = { N: 2 ** 17, r: 8, p: 1 };
const KDF_FIRST = { N: 2 ** 15, r: 8, p: 1 };
const KDF_MAX = 2 ** 30;

// how a worker gets the keys: on its stdin, as JSON (config_hand). A
// supervisor deploys only code whose Config.ts has this line alike
// (Server.ts supervise): one from before reads them from its
// environment, which holds them no more
export const HANDOVER = 1;

export const KEYS: Record<string, string> = await config_start();

// Config
// ======

export function config_get(key: string, def: string): string {
  return process.env["UNII_" + key.toUpperCase()] ?? FILE[key] ?? def;
}

function config_path(path: string): string {
  return path.startsWith("~/") ? os.homedir() + path.slice(1) : path;
}

function config_run(key: string, text: string): Pick {
  const [vendor, model, effort, speed] = text.split(":");
  const pick = Pick.read({ vendor, model, effort, speed }, OFFER);
  if (pick === null) {
    throw new Error("config: " + key + " is no vendor:model:effort:speed offered here: " + text);
  }
  return pick;
}

function config_vendors(text: string): Vendor[] {
  const list = text.split(",").map((v) => v.trim()) as Vendor[];
  const bad = list.find((v) => !VENDORS.includes(v));
  if (bad !== undefined) {
    throw new Error("config: vendors can't offer " + bad);
  }
  return list;
}

function config_key(name: string): string {
  const key = (process.env[name] ?? "").trim();
  delete process.env[name];
  return key;
}

// config_keys, or the server ends saying why it can't start on them (no
// stack: the passphrase or keys.enc is wrong, not the code)
async function config_start(): Promise<Record<string, string>> {
  try {
    return await config_keys();
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("config: ")) {
      console.error("unii: " + err.message.slice("config: ".length));
      process.exit(1);
    }
    throw err;
  }
}

// the keys: a worker's, as its supervisor hands them; else the
// environment's, over those sealed in SEALED, sealed in too when they
// add or change one, or it is of the first kind (none sealed and no
// passphrase: the environment's alone). The passphrase's variables and
// systemd's credentials dir leave the environment too: no worker, nor
// program an agent runs, needs them
async function config_keys(): Promise<Record<string, string>> {
  const env = Object.fromEntries(Object.entries(VARS).map(([name, v]) => [name, config_key(v)]));
  const pass = config_key("UNII_PASSPHRASE");
  const file = config_key("UNII_PASSPHRASE_FILE");
  const creds = config_key("CREDENTIALS_DIRECTORY");
  if (process.env.UNII_WORKER !== undefined) {
    return { ...env, ...JSON.parse(fs.readFileSync(0, "utf8") || "{}") };
  }
  const read = fs.existsSync(SEALED) ? fs.readFileSync(SEALED, "utf8") : null;
  const given = Object.fromEntries(Object.entries(env).filter(([, key]) => key !== ""));
  if (read === null && Object.keys(given).length === 0) {
    return env;
  }
  const word = await config_word(pass, file, creds, read !== null);
  if (word === null) {
    return env;
  }
  const old = read === null ? {} : config_unseal(read, word);
  const changed = Object.keys(given).some((name) => old[name] !== given[name]);
  const first = read !== null && config_first(read);
  const keys = changed || first ? config_store(word, given, read, old) : { ...old, ...given };
  return Object.fromEntries(Object.keys(VARS).map((name) => [name, keys[name] ?? ""]));
}

// seals in the keys given that keys.enc lacks or holds otherwise (all,
// if it is of the first kind), over it as read again holding SEALING (an
// exclusive SQLite transaction: the system frees it if the holder dies;
// 600, as keys.enc), so one start at a time reads, adds to and writes
// it: two first starts at once keep both's keys. Its keys then (`read`
// as it was, sealing `old`)
function config_store(word: string, given: Record<string, string>, read: string | null, old: Record<string, string>): Record<string, string> {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.closeSync(fs.openSync(SEALING, "a", 0o600));
  fs.chmodSync(SEALING, 0o600);
  const db = new Database(SEALING, { create: true });
  try {
    db.run("PRAGMA busy_timeout = 60000");
    db.run("BEGIN EXCLUSIVE");
    const now = fs.existsSync(SEALED) ? fs.readFileSync(SEALED, "utf8") : null;
    const was = now === null ? {} : now === read ? old : config_unseal(now, word);
    const keys = { ...was, ...given };
    const news = Object.keys(given).filter((name) => was[name] !== given[name]);
    const first = now !== null && config_first(now);
    if (news.length > 0 || first) {
      config_write(SEALED, config_seal(keys, word));
    }
    if (first) {
      console.log("unii: sealed " + SEALED + " anew, by this unii's scrypt cost (it was of the first kind, which keeps none)");
    }
    if (news.length > 0) {
      console.log("unii: sealed " + news.join(", ") + " in " + SEALED + "; the environment needs them no more: unset them, and start the server again (its /proc/<pid>/environ holds them while it runs)");
    }
    return keys;
  } finally {
    db.close();
  }
}

// writes a file whole or not at all: a temp of this process's alone,
// made anew (O_EXCL: no link there is followed), 600 whatever the umask,
// written to the last byte (a write may take only some), synced, closed,
// renamed over the file, and the dir synced, so it is on the disk once
// this returns. Where a dir can't be synced (Windows, some file
// systems), the rename is left to the system to keep. `write`: as
// fs.writeSync (a test's, to take a few bytes at a time)
export function config_write(path: string, text: string, write = fs.writeSync): void {
  const dir = path.slice(0, path.lastIndexOf("/"));
  const temp = path + "." + process.pid;
  const data = Buffer.from(text, "utf8");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.rmSync(temp, { force: true });
  let done = false;
  try {
    const fd = fs.openSync(temp, "wx", 0o600);
    try {
      fs.fchmodSync(fd, 0o600);
      for (let at = 0; at < data.length; ) {
        const took = write(fd, data, at, data.length - at);
        if (!(took > 0)) {
          throw new Error("config: " + temp + " took no more bytes (" + at + " of " + data.length + " written)");
        }
        at += took;
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, path);
    done = true;
  } finally {
    if (!done) {
      fs.rmSync(temp, { force: true });
    }
  }
  if (process.platform === "win32") {
    return;
  }
  try {
    const dirfd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(dirfd);
    } finally {
      fs.closeSync(dirfd);
    }
  } catch {}
}

// the passphrase: $UNII_PASSPHRASE; else the file $UNII_PASSPHRASE_FILE
// names; else the systemd credential unii-passphrase (LoadCredential=,
// in `creds`, $CREDENTIALS_DIRECTORY); else typed, if `ask`; else none.
// Spaces and newlines at its ends don't count, wherever it comes from (a
// file's last newline)
async function config_word(pass: string, file: string, creds: string, ask: boolean): Promise<string | null> {
  if (pass !== "" && file !== "") {
    throw new Error("config: set UNII_PASSPHRASE or UNII_PASSPHRASE_FILE, not both");
  }
  if (pass !== "") {
    return pass;
  }
  const cred = creds === "" ? "" : creds + "/" + CREDENTIAL;
  const path = file !== "" ? config_path(file) : cred !== "" && fs.existsSync(cred) ? cred : "";
  if (path === "") {
    return ask ? config_ask() : null;
  }
  let text: string;
  try {
    text = fs.readFileSync(path, "utf8").trim();
  } catch (err: any) {
    throw new Error("config: can't read the passphrase file " + path + " (" + (err.code ?? err.message) + ")");
  }
  if (text === "") {
    throw new Error("config: the passphrase file " + path + " is empty");
  }
  if ((fs.statSync(path).mode & 0o077) !== 0) {
    console.error("unii: " + path + " can be read by others than you: chmod 600 it");
  }
  return text;
}

// the passphrase, typed at the terminal unseen. Not shown means stty
// turned echo off; if it can't, no prompt (it would show). It is read
// as the server waits on nothing else, so a signal (Ctrl-C), from as
// echo goes off, ends the start (130) at once, echo back on
async function config_ask(): Promise<string> {
  const why = "config: " + SEALED + " needs its passphrase: set UNII_PASSPHRASE_FILE (or UNII_PASSPHRASE), or start at a terminal";
  if (!process.stdin.isTTY) {
    throw new Error(why);
  }
  const stty = (...args: string[]): string | null => {
    try {
      const run = Bun.spawnSync(["stty", ...args], { stdin: "inherit", stdout: "pipe", stderr: "pipe" });
      return run.exitCode === 0 ? run.stdout.toString().trim() : null;
    } catch {
      return null;
    }
  };
  const noecho = new Error(why.replace("or start at a terminal", "as the terminal's echo can't be turned off (stty) to type it unseen"));
  const saved = stty("-g");
  if (saved === null || saved === "") {
    throw noecho;
  }
  let asked = false;
  const back = () => {
    stty(saved);
    if (asked) {
      process.stdout.write("\n");
    }
  };
  const quit = () => {
    back();
    console.error("unii: no passphrase given");
    process.exit(130);
  };
  const sigs = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  sigs.forEach((sig) => process.on(sig, quit));
  let typed: string | null;
  try {
    if (stty("-echo") === null) {
      throw noecho;
    }
    // a signal sent so far is taken (quit) before the prompt shows
    await new Promise((done) => setTimeout(done, 0));
    asked = true;
    process.stdout.write("unii: passphrase of " + SEALED + ": ");
    typed = await config_line();
  } finally {
    sigs.forEach((sig) => process.off(sig, quit));
    back();
  }
  if (typed === null || typed.trim() === "") {
    throw new Error("config: no passphrase typed for " + SEALED);
  }
  return typed.trim();
}

// a line read from stdin (null: it ended first), then stdin left alone
function config_line(): Promise<string | null> {
  return new Promise((done) => {
    let got = "";
    const stdin = process.stdin;
    const finish = (line: string | null) => {
      stdin.off("data", data);
      stdin.off("end", end);
      stdin.pause();
      done(line);
    };
    const data = (chunk: Buffer | string) => {
      got += chunk.toString();
      const at = got.indexOf("\n");
      if (at >= 0) {
        finish(got.slice(0, at).replace(/\r$/, ""));
      }
    };
    const end = () => finish(null);
    stdin.on("data", data);
    stdin.on("end", end);
    stdin.resume();
  });
}

type Cost = { N: number; r: number; p: number };

// the memory scrypt takes at a cost, all told (as BoringSSL counts it:
// 128 r (N + 2) for V, 128 r p for B)
function config_mem(cost: Cost): number {
  return 128 * cost.r * (cost.N + 2 + cost.p);
}

// the key a passphrase makes with a salt and a cost
function config_kdf(pass: string, salt: Buffer, cost: Cost): Buffer {
  return crypto.scryptSync(pass.normalize("NFC"), salt, 32, { ...cost, maxmem: config_mem(cost) });
}

// keys, by name, sealed by a passphrase: a keys.enc's text (v 1: scrypt
// with N, r, p; AES-256-GCM with a 12-byte iv and a 16-byte tag)
export function config_seal(keys: Record<string, string>, pass: string): string {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", config_kdf(pass, salt, KDF), iv, { authTagLength: 16 });
  const data = Buffer.concat([cipher.update(JSON.stringify(keys), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const b64 = (buf: Buffer) => buf.toString("base64");
  return JSON.stringify({ v: 1, kdf: "scrypt", ...KDF, salt: b64(salt), iv: b64(iv), tag: b64(tag), data: b64(data) }) + "\n";
}

// whether a keys.enc's text is of the first kind (v 1, no scrypt cost
// kept: KDF_FIRST's), to seal anew; not if damaged
export function config_first(text: string): boolean {
  try {
    return config_box(text).first;
  } catch {
    return false;
  }
}

// the keys a keys.enc's text seals: null if not by that passphrase, or
// changed since (the tag tells no more); a file that is no keys.enc, or
// is of another version, is an Error saying so
export function config_open(text: string, pass: string): Record<string, string> | null {
  const bad = (why: string) => new Error("config: " + SEALED + " is damaged (" + why + "): restore it, or delete it and seal the keys anew");
  const { cost, salt, iv, tag, data } = config_box(text);
  let plain: string;
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", config_kdf(pass, salt, cost), iv, { authTagLength: 16 });
    decipher.setAuthTag(tag);
    plain = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
  let keys: any;
  try {
    keys = JSON.parse(plain);
  } catch {
    throw bad("sealed no keys");
  }
  if (typeof keys !== "object" || keys === null || Array.isArray(keys) || Object.values(keys).some((key) => typeof key !== "string")) {
    throw bad("sealed no keys");
  }
  return keys;
}

// a keys.enc's text, read: its scrypt cost (KDF_FIRST's if of the first
// kind, which keeps no kdf, N, r nor p), salt, iv, tag and sealed data;
// an Error if it is no keys.enc, or of another version
function config_box(text: string): { cost: Cost; first: boolean; salt: Buffer; iv: Buffer; tag: Buffer; data: Buffer } {
  const bad = (why: string) => new Error("config: " + SEALED + " is damaged (" + why + "): restore it, or delete it and seal the keys anew");
  let box: any;
  try {
    box = JSON.parse(text);
  } catch {
    throw bad(text.trim() === "" ? "empty" : "not JSON");
  }
  if (typeof box !== "object" || box === null || Array.isArray(box)) {
    throw bad("not an object");
  }
  if (box.v !== 1) {
    throw typeof box.v === "number" ? new Error("config: " + SEALED + " is of version " + box.v + "; this unii reads version 1: update it") : bad("no version");
  }
  const bytes = (name: string, size: number | null): Buffer => {
    const b64 = box[name];
    if (typeof b64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) {
      throw bad(name + " missing or not base64");
    }
    const buf = Buffer.from(b64, "base64");
    if (size !== null && buf.length !== size) {
      throw bad(name + " of " + buf.length + " bytes, not " + size);
    }
    return buf;
  };
  const first = ["kdf", "N", "r", "p"].every((name) => !(name in box));
  const { N, r, p } = first ? KDF_FIRST : box;
  const whole = (n: unknown, lo: number, hi: number) => Number.isInteger(n) && (n as number) >= lo && (n as number) <= hi;
  if ((!first && box.kdf !== "scrypt") || !whole(N, 2, 2 ** 24) || (N & (N - 1)) !== 0 || !whole(r, 1, 64) || !whole(p, 1, 16) || config_mem({ N, r, p }) > KDF_MAX) {
    throw bad("no scrypt cost it can use");
  }
  return { cost: { N, r, p }, first, salt: bytes("salt", 16), iv: bytes("iv", 12), tag: bytes("tag", 16), data: bytes("data", null) };
}

// config_open's keys, or an Error if not by that passphrase
function config_unseal(text: string, pass: string): Record<string, string> {
  const keys = config_open(text, pass);
  if (keys === null) {
    throw new Error("config: " + SEALED + " is not sealed by that passphrase (or was changed since)");
  }
  return keys;
}

// a worker's keys, to write to its stdin (config_keys reads them)
export function config_hand(): string {
  return JSON.stringify(KEYS);
}
