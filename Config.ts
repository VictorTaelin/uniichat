// Config
// ======
// The server's settings. Its DIR ($UNII_DIR, default ~/.unii) holds
// config.json, the lock and users/<id>. Each key of config.json (README)
// may be set as UNII_<KEY> instead; a path may start with "~/". The keys
// are read from the environment and removed from it, so no program an
// agent runs inherits them, and put back for the workers.

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

// each chat's snapshots (Backup.ts): the dir they go to ("": none), the
// hours between two, how many are kept, the shell command each is given
// to (its path, $1)
export const BACKUP       = config_path(config_get("backup", ""));
export const BACKUP_EVERY = config_number("backup_every", "24");
export const BACKUP_KEEP  = config_number("backup_keep", "7");
export const BACKUP_RUN   = config_get("backup_run", "");

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
export const KEYS: Record<string, string> = Object.fromEntries(Object.entries(VARS).map(([name, v]) => [name, config_key(v)]));

// Config
// ======

export function config_get(key: string, def: string): string {
  return process.env["UNII_" + key.toUpperCase()] ?? FILE[key] ?? def;
}

function config_path(path: string): string {
  return path.startsWith("~/") ? os.homedir() + path.slice(1) : path;
}

function config_number(key: string, def: string): number {
  const n = Number(config_get(key, def));
  if (!(n > 0)) {
    throw new Error("config: " + key + " is no number above 0: " + config_get(key, def));
  }
  return n;
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

// the environment a worker of this server starts with: this one, with
// the keys back
export function config_env(): Record<string, string | undefined> {
  const keys = Object.entries(VARS).map(([name, v]) => [v, KEYS[name]]);
  return { ...process.env, ...Object.fromEntries(keys) };
}
