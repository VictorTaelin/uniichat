// Anthropic
// =========
// The wire of claude-api (Agent.ts): the Messages API, streamed, with
// adaptive thinking summarized and fast as `speed`. Outputs go back
// whole, items of one role joined. A marked block gets cache_control, a
// marked end the top-level one too (which Anthropic counts apart: a
// request takes four in all), and so does the system prompt: what every
// call shares (tools, system) stays cached whatever its view does, so a
// view written anew writes only itself. A stream builds blocks from
// pieces; tool_use and end_turn end a step, pause_turn asks again, an
// error event is busy (a rate_limit_error a usage limit). It pings while
// the model thinks, so 5 silent minutes mean it is dead.

import type { Ask, Img } from "./AskAI.ts";
import { Agent, type Emit, type Entry, type Item, type Step, type Tool, type Use, type Wire } from "./Agent.ts";
import { Price, type Usage } from "./Price.ts";

// Types
// =====

// a stream read so far: the content blocks, the JSON of each tool input
// that came in pieces, how it stopped and why, its usage, an error
type State = {
  blocks : any[];
  json   : string[];
  stop   : string;
  why    : any;
  use    : Usage;
  error  : any;
};

// Constants
// =========

const MARK  = { type: "ephemeral" };
const WEB   = { type: "web_search_20260318", name: "web_search" };
const FAST  = "fast-mode-2026-02-01";
const COUNT = "https://api.anthropic.com/v1/messages/count_tokens";

// Anthropic
// =========

export namespace Anthropic {

  export function headers(key: string, ask: Ask): Record<string, string> {
    const out: Record<string, string> = {
      "x-api-key"         : key,
      "anthropic-version" : "2023-06-01",
      "content-type"      : "application/json",
    };
    if (ask.speed === "fast") {
      out["anthropic-beta"] = FAST;
    }
    return out;
  }

  export function body(ask: Ask, items: Item[], tools: Tool[], max: number): unknown {
    const defs: object[] = tools.map((t) => ({ name: t.name, description: t.info, input_schema: t.schema, eager_input_streaming: true }));
    if (ask.searches > 0) {
      defs.push({ ...WEB, max_uses: ask.searches });
    }
    const messages: any[] = [];
    for (const item of items) {
      const msg = Anthropic.message(item);
      const top = messages[messages.length - 1];
      if (top?.role === msg.role) {
        top.content.push(...msg.content);
      } else {
        messages.push(msg);
      }
    }
    const cache = ask.blocks[ask.blocks.length - 1]?.mark ? MARK : undefined;
    return {
      model         : ask.model,
      max_tokens    : max,
      stream        : true,
      system        : [{ type: "text", text: ask.system, cache_control: MARK }],
      thinking      : { type: "adaptive", display: "summarized" },
      output_config : { effort: ask.effort },
      cache_control : cache,
      tools         : defs.length > 0 ? defs : undefined,
      speed         : ask.speed === "fast" ? "fast" : undefined,
      messages,
    };
  }

  // a body's input tokens, as the API counts them (free): the body less
  // what only a message sent takes; null: not told within 10 s
  export async function count(key: string, ask: Ask, body: any): Promise<number | null> {
    const { max_tokens, stream, ...rest } = body;
    const init = { method: "POST", headers: Anthropic.headers(key, ask), body: JSON.stringify(rest), signal: AbortSignal.timeout(10e3) };
    const out = await fetch(COUNT, init).then((res) => res.json()).catch(() => null);
    return typeof out?.input_tokens === "number" ? out.input_tokens : null;
  }

  export function message(item: Item): { role: string; content: any[] } {
    switch (item.$) {
      case "User": {
        const texts = item.parts.map((p) => ({ type: "text", text: p.text, cache_control: p.mark ? MARK : undefined }));
        return { role: "user", content: [...texts, ...item.imgs.map(Anthropic.image)] };
      }
      case "Turn": {
        return { role: "assistant", content: [...item.out] };
      }
      case "Back": {
        const content = item.backs.map((b) => ({
          type         : "tool_result",
          tool_use_id : b.id,
          content     : Anthropic.content([b.out.text], b.out.imgs ?? []),
          is_error    : b.out.fail,
        }));
        return { role: "user", content };
      }
    }
  }

  // content blocks: the texts (none empty), then the images
  export function content(texts: string[], imgs: Img[]): unknown[] {
    const blocks = texts.filter((text) => text !== "").map((text) => ({ type: "text", text }));
    return [...blocks, ...imgs.map(Anthropic.image)];
  }

  export function image(img: Img): unknown {
    return { type: "image", source: { type: "base64", media_type: img.type, data: img.data } };
  }

  // one stream event; whether it is the last
  export function read(st: State, ev: any, on: Emit): boolean {
    switch (ev.type) {
      case "message_start": {
        Anthropic.usage(st.use, ev.message.usage ?? {});
        return false;
      }
      case "content_block_start": {
        st.blocks[ev.index] = { ...ev.content_block };
        Anthropic.live(ev, on);
        return false;
      }
      case "content_block_delta": {
        Anthropic.delta(st, ev.index, ev.delta);
        Anthropic.live(ev, on);
        return false;
      }
      case "message_delta": {
        st.stop = ev.delta.stop_reason ?? st.stop;
        st.why  = ev.delta.stop_details ?? st.why;
        Anthropic.usage(st.use, ev.usage ?? {});
        return false;
      }
      case "error": {
        st.error = ev.error;
        return true;
      }
    }
    return ev.type === "message_stop";
  }

  export function usage(use: Usage, u: any): void {
    use.input    = u.input_tokens ?? use.input;
    use.write    = u.cache_creation_input_tokens ?? use.write;
    use.read     = u.cache_read_input_tokens ?? use.read;
    use.output   = u.output_tokens ?? use.output;
    use.searches = u.server_tool_use?.web_search_requests ?? use.searches;
    use.speed    = u.speed === undefined ? use.speed : u.speed === "fast" ? "fast" : "slow";
  }

  // a piece of a content block, added to it
  export function delta(st: State, k: number, delta: any): void {
    const block = st.blocks[k];
    switch (delta.type) {
      case "thinking_delta": {
        block.thinking += delta.thinking;
        return;
      }
      case "text_delta": {
        block.text += delta.text;
        return;
      }
      case "signature_delta": {
        block.signature = delta.signature;
        return;
      }
      case "input_json_delta": {
        st.json[k] = (st.json[k] ?? "") + delta.partial_json;
        return;
      }
      case "citations_delta": {
        block.citations = [...(block.citations ?? []), delta.citation];
        return;
      }
    }
  }

  // what an event shows live: thoughts, replies, a tool call as it forms
  // (its name, then its input's JSON in pieces, as Call.ts reads it)
  export function live(ev: any, on: Emit): void {
    const block = ev.content_block ?? {};
    const delta = ev.delta ?? {};
    if (ev.type === "content_block_start" && block.type.endsWith("tool_use")) {
      on("tool", block.name + " ", true);
    }
    if (delta.type === "thinking_delta") {
      on("mind", delta.thinking);
    }
    if (delta.type === "text_delta") {
      on("unii", delta.text);
    }
    if (delta.type === "input_json_delta") {
      on("tool", delta.partial_json);
    }
  }

  // the step a stream gave
  export function step(st: State, ask: Ask): Step {
    const uses: Use[] = [];
    st.blocks.forEach((b, k) => {
      if (st.json[k] !== undefined) {
        b.input = Agent.parse(st.json[k]);
      }
      if (b.type === "tool_use") {
        uses.push({ id: b.id, name: b.name, input: b.input });
      }
      if (b.input === null) {
        b.input = {};
      }
    });
    const out = st.blocks.filter((b) => b.type !== "text" || b.text);
    const slow = ask.speed === "fast" && st.use.speed !== "fast";
    const note = slow ? "ran at " + st.use.speed + " speed" : "";
    const step: Step = { out, uses, entries: Anthropic.entries(out), stop: "done", why: "", note };
    if (st.error) {
      return { ...step, stop: st.error.type === "rate_limit_error" ? "limit" : "busy", why: st.error.type + ": " + st.error.message };
    }
    switch (st.stop) {
      case "end_turn":
      case "tool_use": {
        return { ...step, stop: uses.length > 0 ? "tools" : "done" };
      }
      case "pause_turn": {
        return { ...step, stop: "again" };
      }
    }
    const why = st.why?.explanation;
    return { ...step, stop: "fail", why: "stopped: " + st.stop + (why ? " (" + why + ")" : "") };
  }

  // the messages of an output, in order (a run of text blocks, split
  // where citations go, is one reply)
  export function entries(out: any[]): Entry[] {
    const entries: Entry[] = [];
    for (const b of out) {
      const entry = Anthropic.entry(b);
      const top = entries[entries.length - 1];
      if (entry?.kind === "unii" && top?.kind === "unii") {
        top.text += entry.text;
      } else if (entry !== null) {
        entries.push(entry);
      }
    }
    return entries.map((e) => ({ ...e, text: e.text.trim() })).filter((e) => e.text);
  }

  // the message of a block, if any
  export function entry(b: any): Entry | null {
    const c = b.content;
    switch (b.type) {
      case "text": {
        return { kind: "unii", text: b.text };
      }
      case "thinking": {
        return { kind: "mind", text: b.thinking };
      }
      case "tool_use":
      case "server_tool_use": {
        return { kind: "tool", text: b.name + " " + JSON.stringify(b.input), of: b.id };
      }
    }
    if (!b.type.endsWith("_tool_result")) {
      return null;
    }
    return { kind: "echo", text: Anthropic.result(c) || "(no output)", of: b.tool_use_id };
  }

  // the text of a server tool's result. Every call gets one, even empty
  // or kept secret (code execution under web search gives its output
  // encrypted), since a call is logged with its result: one without
  // would wait to the turn's end, below the reply
  export function result(c: any): string {
    if (Array.isArray(c)) {
      return c.map((r: any) => r.title + " " + r.url).join("\n");
    }
    if (String(c?.type).startsWith("encrypted")) {
      return ("(output encrypted by the API)\n" + (c.stderr ?? "")).trim();
    }
    if (typeof c?.stdout === "string") {
      return (c.stdout + (c.stderr ?? "")).trim();
    }
    return JSON.stringify(c);
  }

  export const wire: Wire<State> = {
    key     : "anthropic",
    idle    : 300e3,
    url     : "https://api.anthropic.com/v1/messages",
    headers : Anthropic.headers,
    body    : Anthropic.body,
    count   : Anthropic.count,
    start   : () => ({ blocks: [], json: [], stop: "", why: null, use: Price.usage("slow"), error: null }),
    read    : Anthropic.read,
    begun   : (ev) => ev.type === "message_start",
    step    : Anthropic.step,
    usage   : (st) => st.use,
  };

}
