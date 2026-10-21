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
import { EFFORTS, LABELS, VENDORS, Pick, type Fall, type Offer } from "./Pick.ts";

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

// the profiles the model menu lists first (Pick.ts), by name: config
// `profiles`, each name's list of "vendor:model[:effort[:speed]]"
OFFER.profiles = config_profiles();

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
export const KEYS: Record<string, string> = Object.fromEntries(Object.entries(VARS).map(([name, v]) => [name, config_key(v)]));

// Config
// ======

export function config_get(key: string, def: string): string {
  return process.env["UNII_" + key.toUpperCase()] ?? FILE[key] ?? def;
}

function config_path(path: string): string {
  return path.startsWith("~/") ? os.homedir() + path.slice(1) : path;
}

// vendor:model:effort:speed, or a profile's name (at medium and slow
// unless its first model names its own)
function config_run(key: string, text: string): Pick {
  const [vendor, model, effort, speed] = text.split(":");
  const pick = Pick.read(Object.hasOwn(OFFER.profiles!, text) ? { profile: text, effort: "medium", speed: "slow" } : { vendor, model, effort, speed }, OFFER);
  if (pick === null) {
    throw new Error("config: " + key + " is no vendor:model:effort:speed or profile offered here: " + text);
  }
  return pick;
}

// config `profiles` (as UNII_PROFILES: its JSON): names no model has and
// without a ":", each a list of the models offered here, one or more
function config_profiles(): Record<string, Fall[]> {
  const env = process.env.UNII_PROFILES;
  const all: any = env === undefined ? (FILE as Record<string, unknown>).profiles ?? {} : JSON.parse(env);
  if (all === null || typeof all !== "object" || Array.isArray(all)) {
    throw new Error("config: profiles is no object of names, each a list of models");
  }
  return Object.fromEntries(Object.entries(all).map(([name, list]: [string, any]) => {
    if (name.trim() === "" || name.includes(":") || LABELS.includes(name) || !Array.isArray(list) || list.length === 0) {
      throw new Error("config: profile " + JSON.stringify(name) + " is no name (none of a model, no \":\") with a list of models");
    }
    return [name, list.map((f) => config_fall(name, String(f).trim()))];
  }));
}

// a profile's model: vendor:model, then an effort and a speed if not the pick's
function config_fall(name: string, f: string): Fall {
  const parts = f.split(":");
  const [vendor, label, effort, speed] = parts as [Vendor, string, string?, string?];
  const model = OFFER.vendors.includes(vendor) && OFFER.models.includes(label) ? Pick.model(vendor, label) : undefined;
  const bad = parts.length > 4 || (effort !== undefined && !EFFORTS.includes(effort)) || (speed !== undefined && !model?.speeds.includes(speed));
  if (model === undefined || bad) {
    throw new Error("config: profile " + JSON.stringify(name) + " has no vendor:model[:effort[:speed]] offered here: " + f);
  }
  return { vendor, model, effort, speed };
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
