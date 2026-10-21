// Settings
// ========
// The settings page's side (web/src/main.ts, /settings), its owner's
// alone (Config.ts config_owner: whom config.json names, never this
// page): every setting, its value, where it comes from (the environment, config.json, its default) and whether a
// change applies at once or on a restart; and the keys, each only as
// set or not, where from, and its last 4 characters: no answer and no
// log line holds a key. A save is a POST of JSON (which another site's
// page can't send: a browser asks first, and the server allows it none;
// Server.ts refuses what another site's page sends at all), naming what
// it changes (null: back to the default, a key dropped). All of it is
// checked as a start checks config.json (each pick offered...) and more
// (the site a URL...), then keys.json and config.json (the keys it
// doesn't name kept) written and read again (config_reload; with
// workers, by every one: Server.ts). A save made on files changed since
// the page read them (another tab, a hand edit: `version`) is refused,
// so none undoes another unseen.

import * as fs from "node:fs";
import * as config from "./Config.ts";
import { LABELS } from "./Pick.ts";

// Types
// =====

// a setting as shown: its value (config.json's or the environment's,
// as a start reads it now), its default, where it comes from, its
// variable, when a change applies, whether the page may change it; and
// one that applies on a restart, what this process runs on if that
// differs (null: the same)
export type Row = {
  key     : string;
  value   : string;
  def     : string;
  from    : config.From;
  env     : string;
  apply   : "now" | "restart";
  web     : boolean;
  running : string | null;
};

// a key as shown: its name, its variable, where it comes from
// ("default": unset), its last characters ("": unset, or too short to
// show any)
export type Key = { name: string; env: string; from: config.From; tail: string };

// the page: the files' version, the settings, the keys; why the page
// can't save (config.json unreadable; null: it can)
export type Page = { version: string; settings: Row[]; keys: Key[]; error: string | null };

// a save's answer: its status and body (refused: why, and the setting
// or "key.<name>" it is about), what it changed (`saved`), and whether
// the files may have changed (`wrote`: every process reads them again)
type Out = { status: number; body: object; saved: string[]; wrote: boolean };

// Constants
// =========

// a save's largest body; a value's longest (an APNs key's PEM is ~250)
const BODY  = 2 ** 16;
const VALUE = 4096;
const KEY   = 16384;

// a key shows its last TAIL characters, if it has MASK or more (fewer
// would say too much of it)
const TAIL = 4;
const MASK = 20;

// the settings that must look so, past what a start checks: an App ID
// ("TEAM.bundle"), an APNs key's id
const APPLE = /^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/;
const APNS  = /^[A-Z0-9]{10}$/;

// Settings
// ========

export namespace Settings {

  // the page, as the files are now: shown and versioned from one reading
  // of them (config.config_snapshot)
  export function page(): Page {
    let file: Record<string, unknown> = {};
    let keys: Record<string, string> = {};
    let error: string | null = null;
    let snap: config.Snapshot = { file: null, keys: null, version: "" };
    try {
      snap = config.config_snapshot();
      file = config.config_file_of(snap.file);
    } catch (err: any) {
      error = "config.json can't be read (" + String(err?.message ?? err).replace(/^config: (config\.json )?/, "") + "): fix it on the server; nothing can be saved here till then.";
    }
    try {
      keys = config.keys_of(snap.keys);
    } catch {
      error ??= "keys.json can't be read: fix it on the server (or remove it); nothing can be saved here till then.";
    }
    const settings = config.SETTINGS.map((s): Row => {
      const env = "UNII_" + s.key.toUpperCase();
      const from: config.From = process.env[env] !== undefined ? "env" : file[s.key] !== undefined && file[s.key] !== null ? "file" : "default";
      const value = config.config_value(file, s.key);
      const running = s.apply === "restart" && config.STARTED[s.key] !== value ? config.STARTED[s.key] : null;
      return { key: s.key, value, def: s.def, from, env, apply: s.apply, web: s.web, running };
    });
    const shown = Object.entries(config.VARS).map(([name, env]): Key => {
      const from = config.config_key_from(name, keys);
      const key = from === "env" ? config.KEYS[name] : keys[name] ?? "";
      return { name, env, from, tail: Settings.tail(key) };
    });
    return { version: snap.version, settings, keys: shown, error };
  }

  // a key's last characters, as shown: its letters and digits only (a
  // PEM's end is dashes)
  export function tail(key: string): string {
    const plain = key.replace(/[^A-Za-z0-9]/g, "");
    return plain.length >= MASK ? plain.slice(-TAIL) : "";
  }

  // a POST's: the owner's save (Server.ts checked who sends it), made or
  // refused with nothing changed, and answered with the page as saved.
  // From the version check to the writes nothing waits, so no other save
  // in this process runs between them
  export async function save(req: Request): Promise<Out> {
    const refuse = (status: number, error: string, key?: string): Out => ({ status, body: { error, key }, saved: [], wrote: false });
    if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) {
      return refuse(415, "Settings are saved as JSON.");
    }
    if (Number(req.headers.get("content-length") ?? 0) > BODY) {
      return refuse(413, "Too large.");
    }
    const text = await req.text();
    if (text.length > BODY) {
      return refuse(413, "Too large.");
    }
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      return refuse(400, "Not JSON.");
    }
    const set = Settings.record(body?.set);
    const keys = Settings.record(body?.keys);
    let snap: config.Snapshot;
    try {
      snap = config.config_snapshot();
    } catch (err: any) {
      return refuse(409, String(err?.message ?? err).replace(/^config: /, "") + ": fix it on the server first.");
    }
    if (body?.version !== snap.version) {
      return refuse(409, "The settings changed since this page read them (another tab, or config.json edited by hand). Reload to see them, then save again.");
    }
    let file: Record<string, unknown>;
    let kept: Record<string, string>;
    try {
      file = config.config_file_of(snap.file);
    } catch {
      return refuse(409, "config.json can't be read: fix it on the server first.");
    }
    try {
      kept = config.keys_of(snap.keys);
    } catch {
      return refuse(409, "keys.json can't be read: fix it on the server (or remove it) first.");
    }
    const next = { ...file };
    for (const [key, value] of Object.entries(set)) {
      const s = config.SETTINGS.find((s) => s.key === key);
      const env = "UNII_" + key.toUpperCase();
      if (s === undefined) {
        return refuse(400, "No setting " + JSON.stringify(key) + ".");
      }
      if (!s.web) {
        return refuse(403, key + " is changed in config.json on the server only.", key);
      }
      if (process.env[env] !== undefined) {
        return refuse(409, env + " sets " + key + ": unset it on the server to change it here.", key);
      }
      if (value === null) {
        delete next[key];
        continue;
      }
      if (typeof value !== "string" || value.length > VALUE || /[\x00-\x1f\x7f]/.test(value)) {
        return refuse(400, "That " + key + " isn't one line of text.", key);
      }
      next[key] = value.trim();
    }
    for (const [name, value] of Object.entries(keys)) {
      if (!Object.hasOwn(config.VARS, name)) {
        return refuse(400, "No key " + JSON.stringify(name) + ".");
      }
      const env = config.VARS[name];
      if (config.config_key_from(name, kept) === "env") {
        return refuse(409, env + " sets the " + name + " key: unset it on the server to change it here.", "key." + name);
      }
      if (value === null) {
        delete kept[name];
        continue;
      }
      const key = typeof value === "string" ? value.trim() : "";
      const ok = name === "apns" ? /^[\x20-\x7e\r\n\t]+$/ : /^[\x21-\x7e]+$/;
      if (key.length === 0 || key.length > KEY || !ok.test(key)) {
        return refuse(400, "That doesn't look like a " + name + " key" + (name === "apns" ? "." : " (one word, no spaces)."), "key." + name);
      }
      kept[name] = key;
    }
    const why = Settings.check(next, new Set(Object.keys(set)));
    if (why !== null) {
      return refuse(400, why.error, why.key);
    }
    try {
      if (Object.keys(keys).length > 0) {
        config.config_write(config.KEYS_PATH, config.keys_text(kept), 0o600);
      }
      if (Object.keys(set).length > 0) {
        const mode = snap.file === null ? 0o600 : fs.statSync(config.FILE_PATH).mode & 0o777;
        config.config_write(config.FILE_PATH, JSON.stringify(next, null, 2) + "\n", mode);
      }
      config.config_reload();
    } catch (err: any) {
      const out = refuse(500, "The settings couldn't be saved (" + (err?.code ?? String(err?.message ?? err).replace(/^config: /, "")) + "). Reload to see what is saved.");
      return { ...out, wrote: true };
    }
    const saved = [...Object.keys(set), ...Object.keys(keys).map((name) => "key." + name)];
    return { status: 200, body: { ...Settings.page(), saved }, saved, wrote: saved.length > 0 };
  }

  // an object's own fields (anything else: none)
  export function record(x: unknown): Record<string, unknown> {
    return x !== null && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
  }

  // why `file` can't be saved (null: it can): what a start refuses; of
  // the settings `changed`, models none offers, a site that is no
  // http(s) origin, an App ID or APNs key id that isn't one
  export function check(file: Record<string, unknown>, changed: Set<string>): { error: string; key?: string } | null {
    if (changed.has("vendors") && config.config_value(file, "vendors").trim() === "") {
      return { error: "Offer at least one vendor.", key: "vendors" };
    }
    const models = config.config_value(file, "models").split(",").map((m) => m.trim());
    const unknown = models.find((m) => !LABELS.includes(m));
    if (changed.has("models") && unknown !== undefined) {
      return { error: unknown === "" ? "Offer at least one model." : "There is no model " + unknown + ".", key: "models" };
    }
    try {
      config.config_make(file);
    } catch (err: any) {
      const text = String(err?.message ?? err).replace(/^config: /, "");
      const key = config.SETTINGS.find((s) => text.startsWith(s.key + " "))?.key;
      const pick = key === "pick" || key === "compactor" || key === "agents";
      const error = pick ? config.config_value(file, key) + " isn't offered by the vendors and models checked: pick another." : key === "vendors" ? "There is no vendor " + text.replace(/^vendors can't offer /, "") + "." : text + ".";
      return { error, key };
    }
    const site = config.config_value(file, "site");
    let url: URL | null = null;
    try {
      url = new URL(site);
    } catch {}
    if (changed.has("site") && (url === null || !/^https?:$/.test(url.protocol) || url.pathname.replace(/\/$/, "") !== "" || url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "")) {
      return { error: "The site is the address the server is reached at, like https://chat.example.com.", key: "site" };
    }
    const apple = config.config_value(file, "apple");
    if (changed.has("apple") && apple !== "" && !APPLE.test(apple)) {
      return { error: "The App ID is the team's ID, a dot, then the bundle's: TEAM123456.com.example.uniichat.", key: "apple" };
    }
    const apns = config.config_value(file, "apns");
    if (changed.has("apns") && apns !== "" && !APNS.test(apns)) {
      return { error: "The APNs key ID is 10 letters and digits.", key: "apns" };
    }
    return null;
  }

}
