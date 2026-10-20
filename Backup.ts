// Backup
// ======
// Snapshots of each chat (its dir, users/<id>: Memory.ts), when the config
// names a dir (BACKUP): every so often (BACKUP_EVERY), a chat changed since
// its last snapshot gets a new one, <dir>/<id>/<date>.tar.gz, of which the
// last BACKUP_KEEP are kept; BACKUP_RUN, a shell command, then gets its
// path ($1), say to copy it off the machine. Each worker snapshots the
// chats it serves (Server.ts Chat.backups), reading their logs at once,
// between two events: as each write to them is too (Memory.ts), a snapshot
// is the chat as it was at one moment, as a crash would leave it, which a
// load recovers. Images, written once by their hash, are read after. The
// indexes are left out: a load makes them anew. A failure is a note in the
// chat (Server.ts).
//
// A user puts their chat back from a snapshot by uploading it (the account
// page: Server.ts Main.restore). Of its files, only those a chat keeps
// (KEPT) are taken, into a dir aside; that dir is loaded as a chat, so
// none that fails to load replaces one, then renamed into the chat's
// place (swap). A tar of a chat's dir made by hand restores too.

import * as fs from "node:fs";
import * as path from "node:path";
import { Memory } from "./Memory.ts";

// Constants
// =========

// the files of a chat's dir a snapshot keeps, by their path in it (not
// import.json: a restore starts no import)
const KEPT = [/^view\.json$/, /^(main|tree)\/\d{4}-\d{2}-\d{2}\.jsonl$/, /^docs\/agent\/[A-Za-z-]+\.jsonl$/, /^docs\/images\/[0-9a-f]{16}\.(png|jpeg|gif|webp)(\.jpg)?$/];
const IMAGE = /^docs\/images\//;

// a snapshot's name: when it was taken, in UTC
const SNAP = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2}\.\d{3})Z\.tar\.gz$/;

// how long BACKUP_RUN may take (ms), then it is killed
const HOOK = 10 * 60 * 1000;

export const NOT_BACKUP = "Not a UniiChat backup";

// Backup
// ======

export namespace Backup {

  // the files of a chat's dir a snapshot keeps (KEPT), by their path in it
  export function files(dir: string): string[] {
    const all = fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map((f) => String(f).replace(/\\/g, "/")) : [];
    return all.filter((name) => KEPT.some((re) => re.test(name)) && fs.statSync(dir + "/" + name).isFile()).sort();
  }

  // the chat in dir, as a snapshot in out, named by `date`: its path. Its
  // files but images read at once (the header says why)
  export async function write(dir: string, out: string, date = new Date()): Promise<string> {
    const data: Record<string, Uint8Array> = {};
    const names = Backup.files(dir);
    for (const name of names.filter((name) => !IMAGE.test(name))) {
      data[name] = fs.readFileSync(dir + "/" + name);
    }
    for (const name of names.filter((name) => IMAGE.test(name))) {
      data[name] = await Bun.file(dir + "/" + name).bytes();
    }
    const file = out + "/" + date.toISOString().replace(/:/g, "-").replace(/Z$/, "Z.tar.gz");
    fs.mkdirSync(out, { recursive: true });
    try {
      await Bun.Archive.write(file + ".new", data, { compress: "gzip" });
      fs.renameSync(file + ".new", file);
    } finally {
      fs.rmSync(file + ".new", { force: true });
    }
    return file;
  }

  // the snapshots in out, oldest first
  export function list(out: string): string[] {
    return fs.existsSync(out) ? fs.readdirSync(out).filter((f) => SNAP.test(f)).sort() : [];
  }

  // when the last snapshot in out was taken (ms; 0: none)
  export function last(out: string): number {
    const m = Backup.list(out).at(-1)?.match(SNAP);
    return m === undefined || m === null ? 0 : Date.parse(m[1] + "T" + m[2] + ":" + m[3] + ":" + m[4] + "Z");
  }

  // whether the chat in dir is due a snapshot: none yet, or the last
  // older than `every` (ms), and a file changed since
  export function due(dir: string, out: string, every: number, now = Date.now()): boolean {
    const last = Backup.last(out);
    if (now - last < every) {
      return false;
    }
    return Backup.files(dir).some((name) => fs.statSync(dir + "/" + name).mtimeMs >= last);
  }

  // the snapshots in out but the last `keep` deleted (only those named as
  // one: no other file there is touched)
  export function prune(out: string, keep: number): void {
    const all = Backup.list(out);
    all.slice(0, Math.max(0, all.length - keep)).forEach((f) => fs.rmSync(out + "/" + f));
  }

  // the command given a snapshot's path, in a process group of its own,
  // killed whole past `ms`: why it failed (null: it didn't)
  export async function hook(cmd: string, file: string, ms = HOOK): Promise<string | null> {
    const proc = Bun.spawn(["/bin/sh", "-c", cmd, "sh", file], { stdin: "ignore", stdout: "ignore", stderr: "pipe", detached: true });
    const timer = setTimeout(() => {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {}
    }, ms);
    const err = (await new Response(proc.stderr).text()).trim();
    const code = await proc.exited;
    clearTimeout(timer);
    const why = proc.signalCode === "SIGKILL" ? "backup_run took too long" : "backup_run exited " + code;
    return code === 0 ? null : why + (err === "" ? "" : ": " + err.slice(-500));
  }

  // a snapshot of the chat in dir, in out, the oldest past `keep` deleted,
  // then the command (none: "") given its path: why it failed (null: it
  // didn't)
  export async function run(dir: string, out: string, keep: number, cmd: string): Promise<string | null> {
    try {
      const file = await Backup.write(dir, out);
      Backup.prune(out, keep);
      return cmd === "" ? null : await Backup.hook(cmd, file);
    } catch (err: any) {
      return err?.message ?? String(err);
    }
  }

  // an uploaded snapshot, into `aside` (made anew), loaded once as a chat
  // with nothing running (its work as saved is dropped, so a restore
  // starts no turn, no agent), its indexes made: why not (null: done)
  export async function unpack(bytes: Uint8Array, aside: string): Promise<string | null> {
    fs.rmSync(aside, { recursive: true, force: true });
    let files: Map<string, File>;
    try {
      files = await new Bun.Archive(bytes).files();
    } catch {
      return NOT_BACKUP + ".";
    }
    const kept = [...files].map(([name, file]): [string, File] => [name.replace(/^\.\//, ""), file]).filter(([name]) => KEPT.some((re) => re.test(name)));
    for (const [name, file] of kept) {
      fs.mkdirSync(path.dirname(aside + "/" + name), { recursive: true });
      fs.writeFileSync(aside + "/" + name, await file.bytes());
    }
    try {
      const mem = Memory.load(aside, () => {
        throw new Error("a restore calls no model");
      });
      const count = mem.count;
      mem.work = [];
      Memory.save(mem);
      Memory.stop(mem);
      if (count === 0) {
        throw new Error("it holds no messages");
      }
    } catch (err: any) {
      fs.rmSync(aside, { recursive: true, force: true });
      return NOT_BACKUP + ": " + (err?.message ?? err) + ".";
    }
    return null;
  }

  // t/new (unpack) in the chat's place (dir); the chat it replaces moved
  // to t/old first, put back if the move fails, deleted once it is done
  export function swap(t: string, dir: string): void {
    fs.rmSync(t + "/old", { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const had = fs.existsSync(dir);
    if (had) {
      fs.renameSync(dir, t + "/old");
    }
    try {
      fs.renameSync(t + "/new", dir);
    } catch (err) {
      if (had) {
        fs.renameSync(t + "/old", dir);
      }
      throw err;
    }
    fs.rmSync(t + "/old", { recursive: true, force: true });
  }

  // what a swap a crash cut left in t: the chat it moved off put back if
  // none took its place; then t deleted
  export function recover(t: string, dir: string): void {
    if (fs.existsSync(t + "/old") && !fs.existsSync(dir)) {
      fs.renameSync(t + "/old", dir);
    }
    fs.rmSync(t, { recursive: true, force: true });
  }

}
