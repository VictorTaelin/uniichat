// ClaudeSub test
// ==============
// `bun test ClaudeSub.test.ts`. What claude-sub hands Claude Code: never
// another sign-in or endpoint than its own, nor a tool of its own that
// would act on the server (its tools are ours, over MCP).

import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";

process.env.UNII_DIR = fs.mkdtempSync(os.tmpdir() + "/unii-claude-sub-");
const { ClaudeSub } = await import("./ClaudeSub.ts");

test("Claude Code gets no key, token or endpoint, and its own config dir", () => {
  process.env.ANTHROPIC_AUTH_TOKEN = "token";
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "token";
  process.env.CLAUDE_CODE_USE_BEDROCK = "1";
  const env = ClaudeSub.env();
  expect(Object.keys(env).filter((k) => /^ANTHROPIC_|^CLAUDE_CODE_(OAUTH|USE_)/.test(k))).toEqual([]);
  expect(env.CLAUDE_CONFIG_DIR).toBe(process.env.UNII_DIR + "/claude-sub");
  expect(fs.statSync(env.CLAUDE_CONFIG_DIR!).mode & 0o777).toBe(0o700);
});

test("a call's only tools are ours and web search", () => {
  const ask: any = { model: "claude-sonnet-5-5", effort: "medium", system: "s", blocks: [], searches: 10, server: "http://127.0.0.1:1/key/main" };
  const opts = ClaudeSub.options(ask, new AbortController(), ["Bash", "Read", "WebSearch", "Agent"]);
  expect(opts.tools).toEqual(["WebSearch"]);
  expect(opts.disallowedTools).toContain("Bash");
  expect(opts.disallowedTools).not.toContain("WebSearch");
  expect(opts.mcpServers).toEqual({ unii: expect.objectContaining({ type: "http", url: ask.server }) });
  expect(opts.settingSources).toEqual([]);
  expect(ClaudeSub.options({ ...ask, searches: 0, server: "" }, new AbortController(), []).tools).toEqual([]);
});
