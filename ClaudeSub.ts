// ClaudeSub
// =========
// The claude-sub vendor: a Claude plan instead of an API key, on the
// Claude Agent SDK. Its Claude Code (the SDK's own binary, unmodified;
// config `claude` names another) runs with CLAUDE_CONFIG_DIR at DIR
// (config `claude_sub`): `unii claude` runs its `claude auth login` there,
// so the sign-in is Anthropic's own and the token stays Claude Code's,
// kept and refreshed by it, never read by us. A call is one query():
// our system prompt, our blocks as its first message, our tools over MCP
// (the chat's URL, Tools.ts) and web search; Claude Code's own tools,
// settings, skills, memory and compaction off. It runs the tool loop; we
// log what it streams. A message sent mid-run goes in once its turn
// ends. A refusal (not signed in, a usage limit) ends the call as the
// vendor's (`down`), in Claude Code's words ("You've hit your limit ·
// resets 3pm"), or saying how to sign in.

import * as fs from "node:fs";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { AskAI, type Ask, type Event, type Img, type Say, type Try } from "./AskAI.ts";
import { Agent, type Emit } from "./Agent.ts";
import { Anthropic } from "./Anthropic.ts";
import { live_push, type Live } from "./View.ts";
import * as config from "./Config.ts";

// Constants
// =========

const DIR = config.CLAUDE_SUB;

// Claude Code's tools kept: web search, as claude-api has (Anthropic.ts)
const WEB = ["WebSearch"];

// the rest, by name, so none comes back: the SDK's list, and older
// names it lacks
const MORE = ["Task", "DesignSync"];

// what turns off what Claude Code does beyond calling the model
const ENV = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC : "1", // updates, telemetry, error reports
  CLAUDE_CODE_DISABLE_AUTO_MEMORY          : "1",
  CLAUDE_CODE_DISABLE_ATTACHMENTS          : "1", // "@path" in a message stays text
  CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS     : "1",
  DISABLE_AUTO_COMPACT                     : "1",
  CLAUDE_AGENT_SDK_CLIENT_APP              : "uniichat",
};

const SIGN_IN = "claude-sub is not signed in: run `unii claude` on the server";

const NO_BIN = "claude-sub needs Claude Code: `bun install` in uniichat's folder, or set `claude` to a Claude Code executable";

// ClaudeSub
// =========

export namespace ClaudeSub {

  // the Claude Code it runs
  export function bin(): string {
    if (config.CLAUDE) {
      return config.CLAUDE;
    }
    const exe = process.platform === "win32" ? "/claude.exe" : "/claude";
    try {
      return Bun.fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk-" + process.platform + "-" + process.arch + exe));
    } catch {
      throw new Error(NO_BIN);
    }
  }

  // its environment: ours, less what would sign it in or send it
  // elsewhere (an API key, a token, a base URL, Bedrock, Vertex...)
  export function env(): Record<string, string | undefined> {
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    const ours = Object.entries(process.env).filter(([k]) => !/^(ANTHROPIC_|CLAUDE_)/.test(k));
    return { ...Object.fromEntries(ours), ...ENV, CLAUDE_CONFIG_DIR: DIR };
  }

  // `unii claude [logout|status]`
  export async function cli(args: string[]): Promise<void> {
    const cmd = args.includes("logout") ? ["logout"] : args.includes("status") ? ["status"] : ["login", "--claudeai"];
    const run = Bun.spawn([ClaudeSub.bin(), "auth", ...cmd], { env: ClaudeSub.env(), stdio: ["inherit", "inherit", "inherit"] });
    process.exitCode = await run.exited;
  }

  export function ask(ask: Ask, on: (ev: Event) => void): Try {
    const end = AskAI.end("");
    const sent: Say[] = [];
    const abort = new AbortController();
    const stop = () => {
      end.text = "stopped";
      abort.abort();
    };
    const done = ClaudeSub.run(ask, on, sent, abort).then(
      (out) => abort.signal.aborted || Object.assign(end, out),
      (err) => (end.text ||= err.message),
    ).then(() => {
      end.ok   = end.ok && !abort.signal.aborted;
      end.left = sent;
      return end;
    });
    return { send: (say) => sent.push(say), stop, done };
  }

  // builtin: Claude Code's tools (the SDK's BUILTIN_TOOL_NAMES). Our
  // tools load up front, never behind its tool search, and a call may
  // run past the 60 s Claude Code gives an HTTP MCP request
  export function options(ask: Ask, abort: AbortController, builtin: readonly string[]): Options {
    const tools = ask.searches > 0 ? WEB : [];
    const deny = [...builtin, ...MORE].filter((t) => !tools.includes(t));
    return {
      abortController        : abort,
      env                    : ClaudeSub.env(),
      cwd                    : DIR,
      model                  : ask.model,
      effort                 : ask.effort as Options["effort"],
      thinking               : { type: "adaptive", display: "summarized" },
      systemPrompt           : ask.system,
      tools,
      allowedTools           : [...tools, "mcp__unii"],
      disallowedTools        : deny,
      permissionMode         : "dontAsk",
      mcpServers             : ask.server ? { unii: { type: "http", url: ask.server, alwaysLoad: true, timeout: 1e8 } } : {},
      strictMcpConfig        : true,
      settingSources         : [],
      plugins                : [],
      skills                 : [],
      persistSession         : false,
      includePartialMessages : true,
      settings               : {
        disableBundledSkills      : true,
        disableWorkflows          : true,
        disableRemoteControl      : true,
        disableClaudeAiConnectors : true,
        enableArtifact            : false,
        permissions               : { deny },
      },
    };
  }

  // the call's end, once its last turn ended (or it threw)
  export async function run(ask: Ask, on: (ev: Event) => void, sent: Say[], abort: AbortController): Promise<Partial<Awaited<Try["done"]>>> {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    const input = ClaudeSub.inbox();
    input.put(ask.blocks.filter((b) => b.text !== "").map((b) => b.text), ask.imgs ?? []);
    let seen: Live[] = [];
    const emit: Emit = (kind, text, fresh) => {
      live_push(seen, kind, text, fresh);
      on({ $: "Delta", kind, text, fresh });
    };
    try {
      const options = { ...ClaudeSub.options(ask, abort, sdk.BUILTIN_TOOL_NAMES), pathToClaudeCodeExecutable: ClaudeSub.bin() };
      for await (const msg of sdk.query({ prompt: input.read(), options }) as AsyncIterable<SDKMessage>) {
        if (abort.signal.aborted) {
          return {};
        }
        if (msg.type === "stream_event" && msg.parent_tool_use_id === null) {
          Anthropic.live(msg.event, emit);
        }
        if (msg.type === "assistant" && msg.error === undefined) {
          Anthropic.entries(msg.message.content).forEach((e) => on({ $: "Entry", ...e }));
          seen = [];
        }
        if (msg.type === "assistant" && msg.error === "authentication_failed") {
          return { text: SIGN_IN, stop: "down" };
        }
        if (msg.type === "user" && Array.isArray(msg.message.content)) {
          ClaudeSub.backs(msg.message.content).forEach((e) => on({ $: "Entry", ...e }));
        }
        if (msg.type !== "result") {
          continue;
        }
        if (msg.subtype !== "success" || msg.is_error) {
          const why = msg.subtype === "success" ? msg.result : msg.errors.join("; ");
          return { text: why || msg.subtype, stop: "down" };
        }
        const says = sent.splice(0);
        if (says.length === 0) {
          return { ok: true, text: msg.result.trim() };
        }
        says.forEach((say) => on({ $: "Entry", kind: "user", text: say.text }));
        input.put(says.map((say) => say.text).filter((t) => t !== ""), says.flatMap((say) => say.imgs));
      }
      return { text: "Claude Code ended early" };
    } finally {
      input.close();
      if (abort.signal.aborted) {
        Agent.fail("stopped", seen).entries.forEach((e) => on({ $: "Entry", ...e }));
      }
    }
  }

  // the results in a message Claude Code sent itself, each as logged
  export function backs(content: any[]): Array<{ kind: "echo"; text: string; of: string }> {
    const results = content.filter((b) => b.type === "tool_result");
    return results.map((b) => ({ kind: "echo", text: (b.is_error ? "error: " : "") + (AskAI.show(b.content) || "(no output)"), of: b.tool_use_id }));
  }

  // the messages Claude Code reads, as they come; closed: it ends
  export function inbox() {
    const queue: SDKUserMessage[] = [];
    let wake = () => {};
    let shut = false;
    const put = (texts: string[], imgs: Img[]) => {
      const content = Anthropic.content(texts, imgs) as any[];
      queue.push({ type: "user", message: { role: "user", content }, parent_tool_use_id: null });
      wake();
    };
    const close = () => {
      shut = true;
      wake();
    };
    async function* read(): AsyncGenerator<SDKUserMessage> {
      for (;;) {
        while (queue.length > 0) {
          yield queue.shift()!;
        }
        if (shut) {
          return;
        }
        await new Promise<void>((ok) => (wake = ok));
      }
    }
    return { put, close, read };
  }

}
