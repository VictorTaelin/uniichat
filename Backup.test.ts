// Backup test
// ===========
// `bun test Backup.test.ts`. A chat's snapshot restores as the chat it
// was, with nothing running, in place of another; one is due when none
// is, or the last is old and the chat changed since; only the last N are
// kept; the command gets each one's path, a failure says why, one that
// hangs is killed; an upload that is no backup restores nothing, and no
// path in it reaches outside the chat; a swap cut puts the chat back. On
// the server: a restore keeps the chat it replaces as a snapshot, runs
// one at a time and takes no form; a failed command is tried again on
// the last snapshot; a deleted account's backups go.

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

const DIR = fs.mkdtempSync(os.tmpdir() + "/unii-backup-");
const OUT = DIR + "/backups";

process.env.UNII_DIR = DIR;
process.env.UNII_BACKUP = OUT;
process.env.UNII_BACKUP_RUN = 'test -e ' + DIR + '/fail && { echo no remote >&2; exit 3; }; cp "$1" ' + DIR + "/copied.tar.gz";

const { Backup } = await import("./Backup.ts");
const { Memory } = await import("./Memory.ts");
const { Chat, Main } = await import("./Server.ts");
const { Cloud } = await import("./Cloud.ts");

const SHARE = () => {
  throw new Error("no model here");
};

const HOUR = 3600 * 1000;
const PNG  = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const IMG  = "0123456789abcdef.png";

// a chat in dir: n short messages (each its own summary: no model call),
// the last with an image, and an agent's log; what runs, saved
function chat(dir: string, n: number, work: string[] = []) {
  const mem = Memory.load(dir, SHARE);
  fs.mkdirSync(dir + "/docs/images", { recursive: true });
  fs.writeFileSync(dir + "/docs/images/" + IMG, PNG);
  const msgs = Array.from({ length: n }, (_, k) => ({ kind: (k % 2 === 0 ? "user" : "unii") as any, text: dir + " message " + k }));
  Memory.push(mem, msgs.slice(0, -1));
  Memory.push(mem, [{ ...msgs[n - 1], images: [IMG] }]);
  const name = Memory.agent_new(mem);
  Memory.agent_push(mem, name, "user", "a task for " + name);
  mem.work = work;
  Memory.save(mem);
  return { mem, name };
}

function texts(mem: any): string[] {
  return Array.from({ length: mem.count }, (_, i) => Memory.message(mem, i)!.text);
}

async function names(file: string): Promise<string[]> {
  return [...(await new Bun.Archive(await Bun.file(file).bytes()).files()).keys()].sort();
}

const bytes = (file: string) => Bun.file(file).bytes();

test("a snapshot restores as the chat it was, in place of another", async () => {
  const { mem, name } = chat(DIR + "/users/1", 6, ["Unii"]);
  fs.mkdirSync(DIR + "/users/1/up", { recursive: true });
  fs.writeFileSync(DIR + "/users/1/up/body", "an upload half read");
  fs.writeFileSync(DIR + "/users/1/import.json", "{}");
  const was = texts(mem);
  const file = await Backup.write(DIR + "/users/1", DIR + "/out/1", new Date("2026-10-20T10:11:12.345Z"));
  Memory.stop(mem);

  Memory.stop(chat(DIR + "/users/2", 3).mem);
  expect(await Backup.unpack(await bytes(file), DIR + "/restore/2/new")).toBeNull();
  Backup.swap(DIR + "/restore/2", DIR + "/users/2");
  const back = Memory.load(DIR + "/users/2", SHARE);
  expect(texts(back)).toEqual(was);
  expect(Memory.message(back, back.count - 1)!.images).toEqual([IMG]);
  expect(fs.readFileSync(Memory.image_file(back, IMG)!)).toEqual(PNG);
  expect(Memory.agent_show(back, name)).toContain("a task for " + name);
  expect(Memory.node(back, { l: 1, i: 0 })).not.toBeNull();
  expect(back.work).toEqual([]);
  Memory.stop(back);
});

test("a snapshot is due when none is, or the last is old and the chat changed since", async () => {
  const dir = DIR + "/users/3";
  const out = DIR + "/out/3";
  Memory.stop(chat(dir, 2).mem);
  const t0 = Date.parse("2026-10-20T00:00:00Z");
  expect(Backup.due(dir, out, 24 * HOUR, t0)).toBe(true);
  await Backup.write(dir, out, new Date(t0));
  const age = (ms: number) => Backup.files(dir).forEach((f) => fs.utimesSync(dir + "/" + f, new Date(ms), new Date(ms)));
  age(t0 - HOUR);
  expect(Backup.due(dir, out, 24 * HOUR, t0 + 25 * HOUR)).toBe(false);
  fs.utimesSync(dir + "/view.json", new Date(t0 + 2 * HOUR), new Date(t0 + 2 * HOUR));
  expect(Backup.due(dir, out, 24 * HOUR, t0 + 25 * HOUR)).toBe(true);
});

test("only the last N are kept, no other file there touched; two in one second keep both", async () => {
  const dir = DIR + "/users/4";
  const out = DIR + "/out/4";
  Memory.stop(chat(dir, 2).mem);
  for (const at of ["01T00:00:00.000", "02T00:00:00.000", "02T00:00:00.500"]) {
    await Backup.write(dir, out, new Date("2026-10-" + at + "Z"));
  }
  fs.writeFileSync(out + "/notes.txt", "mine");
  Backup.prune(out, 2);
  expect(Backup.list(out)).toHaveLength(2);
  expect(Backup.list(out)[0] > "2026-10-02").toBe(true);
  expect(fs.readFileSync(out + "/notes.txt", "utf8")).toBe("mine");
});

test("the command gets each snapshot's path; a failure says why; one that hangs is killed", async () => {
  const dir = DIR + "/users/5";
  const out = DIR + "/out/5";
  Memory.stop(chat(dir, 2).mem);
  expect(await Backup.run(dir, out, 7, 'cp "$1" ' + DIR + "/five.tar.gz")).toBeNull();
  expect(await names(DIR + "/five.tar.gz")).toContain("view.json");
  expect(await Backup.run(dir, out, 7, "echo no remote >&2; exit 3")).toContain("no remote");
  fs.writeFileSync(DIR + "/a-file", "");
  expect(await Backup.run(dir, DIR + "/a-file/5", 7, "")).toBeString();
  expect(await Backup.hook("sleep 30 & sleep 30", DIR + "/five.tar.gz", 300)).toBeString();
});

test("an upload that is no backup, or holds no messages, restores nothing", async () => {
  expect(await Backup.unpack(Buffer.from("not a tar"), DIR + "/restore/6/new")).toBeString();
  const none = await new Bun.Archive({ "main/2026-10-20.jsonl": "", "notes.txt": "hi" }, { compress: "gzip" }).bytes();
  expect(await Backup.unpack(none, DIR + "/restore/6/new")).toBeString();
  expect(fs.existsSync(DIR + "/restore/6/new")).toBe(false);
});

test("no path in an upload reaches outside the chat; a tar made by hand restores", async () => {
  const dir = DIR + "/users/7";
  Memory.stop(chat(dir, 4).mem);
  const evil = DIR + "/evil";
  fs.mkdirSync(evil + "/a/b/main", { recursive: true });
  fs.cpSync(dir + "/main", evil + "/a/b/main", { recursive: true });
  fs.writeFileSync(evil + "/escaped.jsonl", "{}\n");
  fs.writeFileSync(evil + "/a/b/main.index", "garbage");
  const tar = Bun.spawnSync(["tar", "czf", DIR + "/evil.tgz", "-C", evil + "/a/b", "./main", "./main.index", "../../escaped.jsonl", "-P", evil + "/escaped.jsonl"]);
  expect(tar.exitCode).toBe(0);
  fs.rmSync(evil + "/escaped.jsonl");
  expect(await Backup.unpack(await bytes(DIR + "/evil.tgz"), DIR + "/restore/8/new")).toBeNull();
  expect(fs.existsSync(evil + "/escaped.jsonl")).toBe(false);
  expect(fs.existsSync(DIR + "/escaped.jsonl")).toBe(false);
  const all = fs.readdirSync(DIR + "/restore/8/new", { recursive: true }).map(String).sort();
  expect(all.filter((f) => !/^(main|tree)(\/[0-9-]+\.jsonl|\.index)?$/.test(f))).toEqual(["view.json"]);
  const back = Memory.load(DIR + "/restore/8/new", SHARE);
  expect(back.count).toBe(4);
  Memory.stop(back);
});

test("a message's images are only image files of its chat: one naming a path outside sends nothing", async () => {
  const dir = DIR + "/users/9";
  const mem = Memory.load(dir, SHARE);
  fs.writeFileSync(DIR + "/secret.png", "a secret");
  Memory.push(mem, [{ kind: "user", text: "look", images: ["../../../secret.png", IMG] }]);
  expect(Memory.images(mem, 0)).toEqual([]);
  fs.mkdirSync(dir + "/docs/images", { recursive: true });
  fs.writeFileSync(dir + "/docs/images/" + IMG, PNG);
  expect(Memory.images(mem, 0).map((img) => img.type)).toEqual(["image/png"]);
  Memory.stop(mem);
});

test("a swap that fails, or a crash cut, puts the chat back", async () => {
  const dir = DIR + "/users/10";
  Memory.stop(chat(dir, 2).mem);
  const was = fs.readdirSync(dir).sort();
  fs.mkdirSync(DIR + "/restore/10", { recursive: true });
  expect(() => Backup.swap(DIR + "/restore/10", dir)).toThrow();
  expect(fs.readdirSync(dir).sort()).toEqual(was);
  fs.renameSync(dir, DIR + "/restore/10/old");
  Backup.recover(DIR + "/restore/10", dir);
  expect(fs.readdirSync(dir).sort()).toEqual(was);
  expect(fs.existsSync(DIR + "/restore/10")).toBe(false);
});

// the server, in this process: a user signed in, by a bearer token
Chat.cloud = Cloud.open(() => {}, () => {}, async () => null);
Main.listed.resolve();
const ME = { id: "me", name: "me@example.com" };
Chat.cloud.db.query("insert into sessions values (?, ?, ?)").run(Cloud.hash("token"), ME.id, ME.name);
const post = (body: BodyInit, type = "application/gzip") => new Request("http://x/api/restore", { method: "POST", headers: { authorization: "Bearer token", "content-type": type }, body });

test("on the server, a restore keeps the chat it replaces as a snapshot, runs one at a time and takes no form", async () => {
  const dir = DIR + "/users/" + ME.id;
  const { mem } = chat(DIR + "/old", 3);
  Memory.stop(mem);
  const file = await Backup.write(DIR + "/old", DIR + "/out/old");
  const opened = Chat.open(ME)!;
  Chat.push(opened, null, "user", "what is here now");
  expect((await Main.restore(post(await bytes(file), "multipart/form-data"))).status).toBe(415);
  const [one, two] = await Promise.all([Main.restore(post(await bytes(file))), Main.restore(post(await bytes(file)))]);
  expect([one.status, two.status]).toEqual([200, 200]);
  expect(Chat.chats.has(ME.id)).toBe(false);
  const [back, old] = [Memory.load(dir, SHARE), Memory.load(DIR + "/old", SHARE)];
  expect(texts(back)).toEqual(texts(old));
  [back, old].forEach(Memory.stop);
  const before = Backup.list(OUT + "/" + ME.id);
  expect(before.length).toBe(2);
  expect(await Backup.unpack(await bytes(OUT + "/" + ME.id + "/" + before[0]), DIR + "/kept")).toBeNull();
  const k = Memory.load(DIR + "/kept", SHARE);
  expect(texts(k)).toContain("what is here now");
  Memory.stop(k);
  expect(fs.existsSync(DIR + "/restore/" + ME.id)).toBe(false);
});

test("on the server, a failed command is tried again on the last snapshot, a signed-out chat too; a deleted account's backups go", async () => {
  const id = "away";
  Memory.stop(chat(DIR + "/users/" + id, 2).mem);
  fs.writeFileSync(DIR + "/fail", "");
  await Chat.backups();
  expect(Backup.list(OUT + "/" + id).length).toBe(1);
  expect(Chat.unbacked.has(id)).toBe(true);
  fs.rmSync(DIR + "/fail");
  fs.rmSync(DIR + "/copied.tar.gz", { force: true });
  await Chat.backups();
  expect(Chat.unbacked.has(id)).toBe(false);
  expect(Backup.list(OUT + "/" + id).length).toBe(1);
  expect(fs.existsSync(DIR + "/copied.tar.gz")).toBe(true);

  const del = new Request("http://x/api/delete", { method: "POST", headers: { authorization: "Bearer token" }, body: JSON.stringify({ confirm: ME.name }) });
  expect(fs.existsSync(OUT + "/" + ME.id)).toBe(true);
  expect((await Main.close(del)).status).toBe(204);
  expect(fs.existsSync(OUT + "/" + ME.id)).toBe(false);
  expect(fs.existsSync(DIR + "/users/" + ME.id)).toBe(false);
});
