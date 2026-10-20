// OpenAI
// ======
// The wire of openai-api (Agent.ts): the Responses API, streamed, store
// off. Reasoning keeps all turns (else a message sent mid-run drops it
// and misses the cache); the speed is a service tier ("priority" is
// fast). A marked block is an explicit breakpoint; the end is cached
// implicitly only if marked. A server_error is busy; failed, incomplete
// or refused fails. Silent while it reasons, it is dead after 20 min.
// Voice: TRANSCRIBER writes a recording out, and says its seconds.

import type { Ask, Img } from "./AskAI.ts";
import { Agent, type Emit, type Entry, type Item, type Step, type Tool, type Use, type Wire } from "./Agent.ts";
import { Price, type Usage } from "./Price.ts";
import * as config from "./Config.ts";

// Types
// =====

// a stream read so far: the final response, or an error event; usage
export type State = { res: any; error: any; use: Usage };

// Constants
// =========

const TIERS: Record<string, string> = { slow: "default", fast: "fast", ultrafast: "ultrafast" };

const MARK = { mode: "explicit" };

export const TRANSCRIBER = "gpt-transcribe";

// OpenAI
// ======

export namespace OpenAI {

  export function body(ask: Ask, items: Item[], tools: Tool[], max: number): unknown {
    const tier = TIERS[ask.speed];
    if (!tier) {
      throw new Error("OpenAI has no speed " + ask.speed);
    }
    const defs: object[] = tools.map((t) => ({ type: "function", name: t.name, description: t.info, parameters: t.schema }));
    if (ask.searches > 0) {
      defs.push({ type: "web_search" });
    }
    const system = { role: "developer", content: [{ type: "input_text", text: ask.system }] };
    const cache = ask.blocks[ask.blocks.length - 1]?.mark ? undefined : { mode: "explicit" };
    return {
      model                : ask.model,
      stream               : true,
      store                : false,
      tools                : defs,
      reasoning            : { effort: ask.effort, summary: "auto", context: "all_turns" },
      max_output_tokens    : max,
      max_tool_calls       : ask.searches || undefined,
      service_tier         : tier,
      prompt_cache_options : cache,
      input                : [system, ...items.flatMap(OpenAI.input)],
    };
  }

  export function input(item: Item): unknown[] {
    switch (item.$) {
      case "User": {
        const texts = item.parts.map((p) => ({ type: "input_text", text: p.text, prompt_cache_breakpoint: p.mark ? MARK : undefined }));
        return [{ role: "user", content: [...texts, ...item.imgs.map(OpenAI.image)] }];
      }
      case "Turn": {
        return item.out;
      }
      case "Back": {
        return item.backs.map((b) => {
          const output = [{ type: "input_text", text: b.out.text }, ...(b.out.imgs ?? []).map(OpenAI.image)];
          return { type: "function_call_output", call_id: b.id, output };
        });
      }
    }
  }

  export function image(img: Img): unknown {
    return { type: "input_image", image_url: "data:" + img.type + ";base64," + img.data };
  }

  // one stream event; whether it is the last
  export function read(st: State, ev: any, on: Emit): boolean {
    switch (ev.type) {
      case "response.output_text.delta": {
        on("unii", ev.delta);
        return false;
      }
      case "response.output_item.added": {
        OpenAI.live(ev.item, on);
        return false;
      }
      case "response.function_call_arguments.delta": {
        on("tool", ev.delta);
        return false;
      }
      case "response.reasoning_summary_text.delta": {
        on("mind", ev.delta);
        return false;
      }
      case "response.reasoning_summary_part.added": {
        if (ev.summary_index > 0) {
          on("mind", "\n\n");
        }
        return false;
      }
      case "response.completed":
      case "response.incomplete":
      case "response.failed": {
        st.res = ev.response;
        OpenAI.usage(st.use, ev.response);
        return true;
      }
      case "error": {
        st.error = ev;
        return true;
      }
    }
    return false;
  }

  // a tool call starting, shown live (Call.ts): its name, then the
  // pieces of its arguments
  export function live(item: any, on: Emit): void {
    if (item.type === "function_call") {
      on("tool", item.name + " ", true);
    }
    if (item.type === "web_search_call") {
      on("tool", "web_search ", true);
    }
  }

  export function usage(use: Usage, res: any): void {
    const u = res.usage ?? {};
    use.read     = u.input_tokens_details?.cached_tokens ?? 0;
    use.write    = u.input_tokens_details?.cache_write_tokens ?? 0;
    use.input    = (u.input_tokens ?? 0) - use.read - use.write;
    use.output   = u.output_tokens ?? 0;
    use.searches = (res.output ?? []).filter((o: any) => o.type === "web_search_call").length;
    use.speed    = OpenAI.tier(res);
  }

  // the speed a response ran at
  export function tier(res: any): string {
    const tier = res.service_tier === "priority" ? "fast" : res.service_tier;
    return tier in TIERS ? tier : "slow";
  }

  // the step a stream gave
  export function step(st: State, ask: Ask): Step {
    const res = st.res ?? { status: "failed", error: st.error, output: [] };
    const out: any[] = res.output;
    const calls = out.filter((o) => o.type === "function_call");
    const uses: Use[] = calls.map((o) => ({ id: o.call_id, name: o.name, input: Agent.parse(o.arguments) }));
    const ran = OpenAI.tier(res);
    const note = ran !== ask.speed ? "ran at " + ran + " speed" : "";
    const refusals = out.flatMap((o) => (o.type === "message" ? o.content : [])).filter((c: any) => c.type === "refusal");
    const step: Step = { out, uses, entries: out.flatMap(OpenAI.entries), stop: "done", why: "", note };
    if (res.status === "failed") {
      return { ...step, stop: res.error?.code === "server_error" ? "busy" : "fail", why: res.error?.message ?? "failed" };
    }
    if (res.status === "incomplete") {
      return { ...step, stop: "fail", why: "incomplete: " + res.incomplete_details?.reason };
    }
    if (refusals.length > 0) {
      return { ...step, stop: "fail", why: "refused: " + refusals.map((c: any) => c.refusal).join(" ") };
    }
    return { ...step, stop: uses.length > 0 ? "tools" : "done" };
  }

  // the messages of an output item: a thought; a reply and the web
  // sources it cites; a tool call
  export function entries(o: any): Entry[] {
    switch (o.type) {
      case "reasoning": {
        const text = (o.summary ?? []).map((s: any) => s.text).join("\n\n").trim();
        return text ? [{ kind: "mind", text }] : [];
      }
      case "message": {
        const content = o.content ?? [];
        const text = content.map((c: any) => c.text ?? "").join("").trim();
        const urls = content.flatMap((c: any) => c.annotations ?? []).filter((a: any) => a.type === "url_citation");
        const cited = [...new Set(urls.map((a: any) => a.title + " " + a.url))];
        const reply: Entry[] = text ? [{ kind: "unii", text }] : [];
        const sources: Entry[] = cited.length > 0 ? [{ kind: "echo", text: "sources:\n" + cited.join("\n") }] : [];
        return [...reply, ...sources];
      }
      case "function_call": {
        return [{ kind: "tool", text: o.name + " " + o.arguments, of: o.call_id }];
      }
      case "web_search_call": {
        return [{ kind: "tool", text: "web_search " + JSON.stringify(o.action ?? {}) }];
      }
    }
    return [];
  }

  // a recording's words and seconds
  export async function transcribe(audio: Blob): Promise<{ text: string; seconds: number }> {
    if (!config.KEYS.openai) {
      throw new Error("Voice needs an OpenAI key");
    }
    const form = new FormData();
    form.append("model", TRANSCRIBER);
    form.append("file", audio, "voice." + audio.type.split(/[/;]/)[1]);
    const init = { method: "POST", headers: { authorization: "Bearer " + config.KEYS.openai }, body: form };
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", init);
    const out = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error("Transcription failed: " + (out.error?.message ?? "HTTP " + res.status));
    }
    return { text: out.text, seconds: out.usage.seconds };
  }

  export const wire: Wire<State> = {
    key     : "openai",
    idle    : 1200e3,
    url     : "https://api.openai.com/v1/responses",
    headers : (key) => ({ authorization: "Bearer " + key, "content-type": "application/json" }),
    body    : OpenAI.body,
    count   : async () => null,
    start   : (ask) => ({ res: null, error: null, use: Price.usage(ask.speed) }),
    read    : OpenAI.read,
    begun   : (ev) => ev.type === "response.output_item.added",
    step    : OpenAI.step,
    usage   : (st) => st.use,
  };

}
