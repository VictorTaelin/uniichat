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

// Types
// =====

// a user's MCP server (Mcp.ts): a program run here (stdio: command, its
// args, its env: all it gets beside the few of this one's variables
// Mcp.ts passes on, its dir) or a URL (streamable HTTP, with headers);
// how long a tool call may take, in seconds; device: the device that
// runs the program instead (Mcp.device; "": here)
export type McpServer = {
  name    : string;
  device  : string;
  command : string;
  args    : string[];
  env     : Record<string, string>;
  cwd     : string;
  url     : string;
  headers : Record<string, string>;
  timeout : number;
};

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
export const KEYS: Record<string, string> = Object.fromEntries(Object.entries(VARS).map(([name, v]) => [name, config_key(v)]));

// the MCP servers each chat runs (Mcp.ts): Claude's `mcpServers`, as an
// object, its JSON, or a file holding it (read once the keys are out of
// the environment, so ${VAR} never gives one). UNII_MCP leaves the
// environment too (a server's headers are in it): only workers get it
// back (config_env)
const MCP_VAR           = process.env.UNII_MCP;
delete process.env.UNII_MCP;
export const MCP        = config_mcp(MCP_VAR ?? (FILE.mcp as unknown) ?? {});

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

// the servers of Claude's `mcpServers` shape (the object, or one that holds
// it under that key, as Claude's .mcp.json does); ${VAR} in their
// strings reads the environment
export function config_mcp(raw: unknown): McpServer[] {
  let all: any = raw;
  if (typeof all === "string" && all.trim() !== "" && !all.trim().startsWith("{")) {
    all = fs.readFileSync(config_path(all.trim()), "utf8");
  }
  if (typeof all === "string") {
    try {
      all = all.trim() === "" ? {} : JSON.parse(all);
    } catch {
      // not the parser's why: it quotes the text, which may hold a secret
      throw new Error("config: mcp is no JSON");
    }
  }
  all = all?.mcpServers ?? all;
  if (typeof all !== "object" || all === null || Array.isArray(all)) {
    throw new Error("config: mcp must be an object of servers by name");
  }
  return Object.entries(all).map(([name, server]) => config_server(name, server));
}

// a server, its strings' ${VAR}s read (one unset is an error). An error
// never quotes a value (it may hold a secret). A name has no "__" and
// no _ at its ends, so "<server>__<tool>" names its server
function config_server(name: string, s: any): McpServer {
  const bad = (why: string) => new Error("config: mcp server " + JSON.stringify(name) + " " + why);
  const vars = (text: string) => text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, v) => {
    if (process.env[v] === undefined) {
      throw bad("uses ${" + v + "}, which isn't set");
    }
    return process.env[v]!;
  });
  const strs = (list: unknown, what: string): string[] => {
    if (list !== undefined && (!Array.isArray(list) || list.some((x) => typeof x !== "string"))) {
      throw bad("needs " + what + " as a list of strings");
    }
    return ((list ?? []) as string[]).map(vars);
  };
  const map = (obj: unknown, what: string): Record<string, string> => {
    if (obj !== undefined && (typeof obj !== "object" || obj === null || Array.isArray(obj) || Object.values(obj).some((x) => typeof x !== "string"))) {
      throw bad("needs " + what + " as an object of strings");
    }
    return Object.fromEntries(Object.entries((obj ?? {}) as Record<string, string>).map(([k, v]) => [k, vars(v)]));
  };
  if (!/^[A-Za-z0-9-]+(_[A-Za-z0-9-]+)*$/.test(name)) {
    throw bad("needs a name of letters, digits, - and single _s inside (its tools are named <server>__<tool>)");
  }
  if (typeof s !== "object" || s === null || Array.isArray(s)) {
    throw bad("must be an object");
  }
  const type = s.type ?? (s.url === undefined ? "stdio" : "http");
  const timeout = s.timeout ?? 600;
  if (typeof timeout !== "number" || !(timeout > 0)) {
    throw bad("needs timeout as seconds, more than 0");
  }
  if (s.device !== undefined && (type !== "stdio" || typeof s.device !== "string" || s.device === "")) {
    throw bad("needs device as a device's name, on a stdio server");
  }
  const server = { name, device: "", command: "", args: [], env: {}, cwd: "", url: "", headers: {}, timeout };
  if (type === "stdio") {
    if (typeof s.command !== "string" || s.command === "" || (s.cwd !== undefined && typeof s.cwd !== "string")) {
      throw bad("needs a command (and cwd, if any, as a string)");
    }
    // a device's cwd is a path there, read by it
    const device = s.device === undefined ? "" : vars(s.device);
    const cwd = s.cwd ? (device ? vars(s.cwd) : config_path(vars(s.cwd))) : "";
    return { ...server, device, command: vars(s.command), args: strs(s.args, "args"), env: map(s.env, "env"), cwd };
  }
  if (type === "http") {
    if (typeof s.url !== "string" || !URL.canParse(vars(s.url))) {
      throw bad("needs a url");
    }
    return { ...server, url: vars(s.url), headers: map(s.headers, "headers") };
  }
  throw bad("has type " + JSON.stringify(type) + "; unii runs stdio and http (streamable HTTP) servers");
}

function config_key(name: string): string {
  const key = (process.env[name] ?? "").trim();
  delete process.env[name];
  return key;
}

// the environment a worker of this server starts with: this one, with
// the keys (and UNII_MCP) back
export function config_env(): Record<string, string | undefined> {
  const keys = Object.entries(VARS).map(([name, v]) => [v, KEYS[name]]);
  return { ...process.env, ...Object.fromEntries(keys), ...(MCP_VAR === undefined ? {} : { UNII_MCP: MCP_VAR }) };
}
