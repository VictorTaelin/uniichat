// Config
// ======
// The server's settings. Its DIR ($UNII_DIR, default ~/.unii) holds
// config.json, the lock, keys.enc and users/<id>. Each key of config.json
// (README) may be set as UNII_<KEY> instead; a path may start with "~/".
// The keys are read from the environment and removed from it, so no
// program an agent runs inherits them, and handed to the workers on
// their stdin, so none sits in theirs.
//
// keys.enc holds them sealed, so none need sit in a file in plain text:
// AES-256-GCM, by a key scrypt makes of a passphrase, $UNII_PASSPHRASE
// (taken out of the environment too) else typed at the terminal the
// server starts at. Given it, the server seals in each key the
// environment holds that the file lacks or holds otherwise: one start
// with a key set moves it there; then it can leave the environment. A
// worker gets the keys from its supervisor (config_hand), not the file.

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

// where the keys are sealed (config_keys)
export const SEALED = DIR + "/keys.enc";

export const KEYS: Record<string, string> = config_keys();

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

// the keys: a worker's, as its supervisor hands them; else the
// environment's, over those sealed in SEALED, sealed in too when they
// add or change one (none sealed and no passphrase: the environment's
// alone)
function config_keys(): Record<string, string> {
  const env = Object.fromEntries(Object.entries(VARS).map(([name, v]) => [name, config_key(v)]));
  const pass = config_key("UNII_PASSPHRASE");
  if (process.env.UNII_WORKER !== undefined) {
    return { ...env, ...JSON.parse(fs.readFileSync(0, "utf8") || "{}") };
  }
  const sealed = fs.existsSync(SEALED);
  const given = Object.fromEntries(Object.entries(env).filter(([, key]) => key !== ""));
  if (!sealed && (pass === "" || Object.keys(given).length === 0)) {
    return env;
  }
  const word = pass !== "" ? pass : config_ask();
  const old = sealed ? config_open(fs.readFileSync(SEALED, "utf8"), word) : {};
  if (old === null) {
    throw new Error("config: " + SEALED + " is not sealed by that passphrase");
  }
  const keys = { ...old, ...given };
  const news = Object.keys(given).filter((name) => old[name] !== given[name]);
  if (news.length > 0) {
    fs.mkdirSync(DIR, { recursive: true });
    fs.rmSync(SEALED + ".new", { force: true });
    fs.writeFileSync(SEALED + ".new", config_seal(keys, word), { mode: 0o600 });
    fs.renameSync(SEALED + ".new", SEALED);
    console.log("unii: sealed " + news.join(", ") + " in " + SEALED + "; the environment needs them no more");
  }
  return Object.fromEntries(Object.keys(VARS).map((name) => [name, keys[name] ?? ""]));
}

// the passphrase, typed at the terminal unseen (stty, where there is one)
function config_ask(): string {
  if (!process.stdin.isTTY) {
    throw new Error("config: " + SEALED + " needs its passphrase: set UNII_PASSPHRASE, or start at a terminal");
  }
  const echo = (on: boolean) => {
    try {
      Bun.spawnSync(["stty", on ? "echo" : "-echo"], { stdin: "inherit" });
    } catch {}
  };
  echo(false);
  const pass = prompt("unii: passphrase of " + SEALED + ":") ?? "";
  echo(true);
  process.stdout.write("\n");
  return pass;
}

// the key a passphrase makes with a salt (scrypt; some 0.1 s and 32 MiB)
function config_kdf(pass: string, salt: Buffer): Buffer {
  return crypto.scryptSync(pass.normalize("NFC"), salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 2 ** 26 });
}

// keys, by name, sealed by a passphrase: a keys.enc's text
export function config_seal(keys: Record<string, string>, pass: string): string {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", config_kdf(pass, salt), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(keys), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({ v: 1, salt: salt.toString("base64"), iv: iv.toString("base64"), tag: tag.toString("base64"), data: data.toString("base64") }) + "\n";
}

// the keys a keys.enc's text seals (null: not by that passphrase, or
// changed since)
export function config_open(text: string, pass: string): Record<string, string> | null {
  const box = JSON.parse(text);
  const bytes = (b64: string) => Buffer.from(b64, "base64");
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", config_kdf(pass, bytes(box.salt)), bytes(box.iv));
    decipher.setAuthTag(bytes(box.tag));
    return JSON.parse(Buffer.concat([decipher.update(bytes(box.data)), decipher.final()]).toString("utf8"));
  } catch {
    return null;
  }
}

// a worker's keys, to write to its stdin (config_keys reads them)
export function config_hand(): string {
  return JSON.stringify(KEYS);
}
