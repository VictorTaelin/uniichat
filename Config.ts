// Config
// ======
// The server's settings. Its DIR ($UNII_DIR, default ~/.unii) holds
// config.json, keys.json, the lock and users/<id>. Each key of
// config.json (README, SETTINGS) may be set as UNII_<KEY> instead, which
// wins; a path may start with "~/". The keys are read from the
// environment and removed from it, so no program an agent runs inherits
// them, and put back for the workers; a key the environment lacks is
// read from keys.json (0600), where the settings page puts them
// (Settings.ts). config_reload reads both
// files again: what SETTINGS applies "now" changes at once, the rest
// on the next start.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Vendor } from "./AskAI.ts";
import { LABELS, VENDORS, Pick, type Offer } from "./Pick.ts";

// Types
// =====

// a setting: its key in config.json, its default; whether a change
// applies at once ("now": config_reload) or on the next start; whether
// the settings page may change it (one that names a command or a file
// the server runs or reads may not: a sign-in would be a shell on the
// server; one that decides how the server is reached neither: a wrong
// one is fixed only by hand)
export type Setting = { key: string; def: string; apply: "now" | "restart"; web: boolean };

// where a value comes from: the environment, config.json (a key:
// keys.json), the default (a key: none)
export type From = "env" | "file" | "default";

// the settings a config.json gives, the environment's winning
type Made = {
  offer     : Offer;
  pick      : Pick;
  compactor : Pick;
  agents    : Pick | null;
  rules     : string;
  after     : string;
  owner     : string[];
};

// Constants
// =========

export const DIR = config_path(process.env.UNII_DIR ?? "~/.unii");

export const FILE_PATH = DIR + "/config.json";
export const KEYS_PATH = DIR + "/keys.json";

export const SETTINGS: Setting[] = [
  { key: "vendors",   def: "claude-api",                        apply: "now",     web: true  },
  { key: "models",    def: LABELS.join(),                       apply: "now",     web: true  },
  { key: "pick",      def: "claude-api:sonnet-5.5:medium:slow", apply: "now",     web: true  },
  { key: "compactor", def: "claude-api:haiku-5.5:high:slow",    apply: "now",     web: true  },
  { key: "agents",    def: "",                                  apply: "now",     web: true  },
  { key: "owner",     def: "",                                  apply: "now",     web: false },
  { key: "site",      def: "http://127.0.0.1:8788",             apply: "restart", web: true  },
  { key: "apple",     def: "",                                  apply: "restart", web: true  },
  { key: "apns",      def: "",                                  apply: "restart", web: true  },
  { key: "workers",   def: "0",                                 apply: "restart", web: false },
  { key: "work",      def: DIR + "/work",                       apply: "restart", web: false },
  { key: "rules",     def: "",                                  apply: "now",     web: false },
  { key: "after",     def: "",                                  apply: "now",     web: false },
];

// the keys, by name, and the variable each is read from
export const VARS: Record<string, string> = {
  anthropic       : "ANTHROPIC_API_KEY",
  openai          : "OPENAI_API_KEY",
  resend          : "RESEND_API_KEY",
  apns            : "APNS_KEY",
};

// config.json as read at the start
const FILE: Record<string, unknown> = config_file();

const MADE = config_make(FILE);

// the values this process started with: what a "restart" setting runs on
export const STARTED: Record<string, string> = Object.fromEntries(SETTINGS.map((s) => [s.key, config_value(FILE, s.key)]));

export const SITE    = config_value(FILE, "site").replace(/\/$/, "");
export const OFFER: Offer = MADE.offer;

export const WORK       = config_path(config_value(FILE, "work"));
export let   RULES      = MADE.rules;
export let   AFTER      = MADE.after;
export let   PICK       = MADE.pick;

// what every compaction runs on, a chat's and an import's alike, whatever
// the chat's pick
export let   COMPACTOR  = MADE.compactor;
export let   AGENTS     = MADE.agents;
export const WORKERS    = Number(config_value(FILE, "workers"));

// who may change the settings (config_owner): sign-in names (an email);
// config.json's or UNII_OWNER's only (the settings page can't change it)
export let   OWNER      = MADE.owner;

// the iOS app (ios/, Cloud.ts): its App ID, the team's then the bundle's
// ("TEAM.com.example.uniichat"), whose app sign-in links open; and
// the id of the key its pushes are signed with (APNS_KEY holds the key)
export const APPLE      = config_value(FILE, "apple");
export const APNS       = config_value(FILE, "apns");

// the keys the environment gave (removed from it), and every key as used:
// the environment's, else keys.json's
const ENV_KEYS: Record<string, string> = Object.fromEntries(Object.entries(VARS).map(([name, v]) => [name, config_key(v)]));
export const KEYS: Record<string, string> = config_keys(keys_read());

// Config
// ======

// a setting's value in `file`, the environment's winning, else its default
export function config_value(file: Record<string, unknown>, key: string): string {
  const def = SETTINGS.find((s) => s.key === key)?.def ?? "";
  return config_env_value(key) ?? config_str(file[key]) ?? def;
}

function config_env_value(key: string): string | undefined {
  return process.env["UNII_" + key.toUpperCase()];
}

// a value of config.json as a string (one hand-written as a number or a
// list too); null and none: unset
function config_str(x: unknown): string | undefined {
  return x === undefined || x === null ? undefined : String(x);
}

// a key's: the environment's, keys.json's (`kept`), or none ("default")
export function config_key_from(name: string, kept: Record<string, string>): From {
  return ENV_KEYS[name] ? "env" : kept[name] ? "file" : "default";
}

function config_path(path: string): string {
  return path.startsWith("~/") ? os.homedir() + path.slice(1) : path;
}

// config.json, read (none: empty); an Error if it is no JSON object
export function config_file(): Record<string, unknown> {
  return config_file_of(config_text(FILE_PATH));
}

// config.json's text (null: none), as read
export function config_file_of(text: string | null): Record<string, unknown> {
  if (text === null) {
    return {};
  }
  const json = config_json(FILE_PATH, text);
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    throw new Error("config: config.json is no JSON object");
  }
  return json;
}

// a file's text; null: there is none
export function config_text(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return null;
    }
    throw new Error("config: " + path.basename(file) + " can't be read (" + (err?.code ?? err) + ")");
  }
}

// a file's JSON, of its text; an Error names the file (keys.json's,
// nothing more: a parser's message may quote what it read)
function config_json(file: string, text: string): any {
  try {
    return JSON.parse(text);
  } catch (err: any) {
    const why = file === KEYS_PATH ? "" : " (" + (err?.message ?? err) + ")";
    throw new Error("config: " + path.basename(file) + " is no JSON" + why);
  }
}

// what `file` sets, checked as a start does: an Error names the first
// setting that is wrong
export function config_make(file: Record<string, unknown>): Made {
  const offer: Offer = {
    vendors : config_vendors(config_value(file, "vendors")),
    models  : config_value(file, "models").split(",").map((m) => m.trim()),
  };
  const agents = config_value(file, "agents");
  return {
    offer,
    pick      : config_run("pick", config_value(file, "pick"), offer),
    compactor : config_run("compactor", config_value(file, "compactor"), offer),
    agents    : agents ? config_run("agents", agents, offer) : null,
    rules     : config_path(config_value(file, "rules")),
    after     : config_value(file, "after"),
    owner     : config_value(file, "owner").split(",").map((o) => o.trim().toLowerCase()).filter((o) => o !== ""),
  };
}

function config_run(key: string, text: string, offer: Offer): Pick {
  const [vendor, model, effort, speed] = text.split(":");
  const pick = Pick.read({ vendor, model, effort, speed }, offer);
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

// every key as used, keys.json's (`kept`) under the environment's
function config_keys(kept: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(VARS).map((name) => [name, ENV_KEYS[name] || kept[name] || ""]));
}

// the environment a worker of this server starts with: this one, with
// the environment's keys back (a worker reads keys.json itself, so a key
// set there is no environment's)
export function config_env(): Record<string, string | undefined> {
  const keys = Object.entries(VARS).filter(([name]) => ENV_KEYS[name]).map(([name, v]) => [v, ENV_KEYS[name]]);
  return { ...process.env, ...Object.fromEntries(keys) };
}

// config.json and keys.json read again: what applies at once takes their
// values (OFFER and KEYS changed in place, so who holds them sees it);
// one wrong (a hand edit) throws and changes nothing
export function config_reload(): void {
  const file = config_file();
  const made = config_make(file);
  const keys = config_keys(keys_read());
  OFFER.vendors = made.offer.vendors;
  OFFER.models = made.offer.models;
  PICK = made.pick;
  COMPACTOR = made.compactor;
  AGENTS = made.agents;
  RULES = made.rules;
  AFTER = made.after;
  OWNER = made.owner;
  Object.assign(KEYS, keys);
}

// whether a user (a sign-in name) may change the settings: one `owner`
// names (config.json, UNII_OWNER: the server's files, never the settings
// page). None named: no one. Who signed up first, or holds id 1, proves
// nothing: where sign-in is open to any email, that may be anyone
export function config_owner(user: { name: string }, owner: string[] = OWNER): boolean {
  return owner.includes(user.name.toLowerCase());
}

// config.json and keys.json as read at once: their texts (null: none)
// and their version, a hash of both: what a save checks is unchanged
// since the page read them. What a page shows is read from these same
// texts, so its version is what it shows
export type Snapshot = { file: string | null; keys: string | null; version: string };

export function config_snapshot(): Snapshot {
  const file = config_text(FILE_PATH);
  const keys = config_text(KEYS_PATH);
  const hash = crypto.createHash("sha256").update((file ?? "\u0001none") + "\0" + (keys ?? "\u0001none"));
  return { file, keys, version: hash.digest("hex").slice(0, 32) };
}

export function config_version(): string {
  return config_snapshot().version;
}

// a file replaced at once by `text` (null: removed): written whole beside
// it (<file>.<pid>.new), readable by `mode` from its first byte, synced,
// then moved in, so a crash leaves the old file or the new, never half
export function config_write(file: string, text: string | null, mode: number): void {
  if (text === null) {
    fs.rmSync(file, { force: true });
    return;
  }
  const tmp = file + "." + process.pid + ".new";
  try {
    const fd = fs.openSync(tmp, "w", mode);
    try {
      fs.fchmodSync(fd, mode);
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

// Keys
// ====
// The keys the settings page set, by name, in keys.json: plain JSON,
// only the server's user may read it (600; README).

export function keys_read(): Record<string, string> {
  return keys_of(config_text(KEYS_PATH));
}

// keys.json's keys, of its text (null: none); an Error if it is no JSON
export function keys_of(text: string | null): Record<string, string> {
  if (text === null) {
    return {};
  }
  const json = config_json(KEYS_PATH, text);
  const keys = json !== null && typeof json === "object" && !Array.isArray(json) ? json : {};
  return Object.fromEntries(Object.keys(VARS).filter((name) => typeof keys[name] === "string" && keys[name] !== "").map((name) => [name, keys[name]]));
}

// keys.json's text for `keys`; none left: null (the file goes)
export function keys_text(keys: Record<string, string>): string | null {
  const kept = Object.fromEntries(Object.entries(keys).filter(([name, key]) => VARS[name] !== undefined && key !== ""));
  return Object.keys(kept).length === 0 ? null : JSON.stringify(kept, null, 2) + "\n";
}
