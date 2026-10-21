// ChatGPT
// =======
// The openai-sub vendor: a ChatGPT plan instead of an API key, signed in
// and called as Codex CLI does (openai/codex: codex-rs login, codex-api).
// `unii chatgpt` (or `bun ChatGPT.ts`) signs in as Codex's OAuth client,
// by a device code typed at auth.openai.com/codex/device (no redirect
// back to this computer: the server is often another). The tokens go to FILE
// (config `chatgpt`), in Codex's auth.json shape, mode 600. Each request
// reads FILE; the access token is refreshed 5 min before it expires and
// once on a 401, one refresh at a time in a process. A refresh refused as
// used reads FILE again for a while (another process refreshed it), as
// Codex does; one saves only if FILE still holds the tokens it refreshed
// (a logout or sign-in since wins).
// The body is Codex's: openai-api's parts (OpenAI.ts), the system prompt
// as `instructions`, no max_output_tokens. A usage limit (429) is told to
// the user as such, with its reset time (Agent.ts, AskAI.ts).
// config `chatgpt_issuer` and `chatgpt_url` point it elsewhere (tests).

import * as fs from "node:fs";
import * as path from "node:path";
import type { Ask } from "./AskAI.ts";
import type { Emit, Item, Refusal, Tool, Wire } from "./Agent.ts";
import { OpenAI, type State } from "./OpenAI.ts";
import * as config from "./Config.ts";

// Types
// =====

export type Tokens = { id_token: string; access_token: string; refresh_token: string; account_id: string };

// FILE, as Codex writes its auth.json
export type Auth = { auth_mode: "chatgpt"; OPENAI_API_KEY: null; tokens: Tokens; last_refresh: string };

// a stream read so far, the items it gave, and the speed it was asked at
type Sub = State & { items: any[]; speed: string };

// Constants
// =========

// Codex CLI's OAuth client
const CLIENT    = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER    = config.config_get("chatgpt_issuer", "https://auth.openai.com").replace(/\/$/, "");
const RESPONSES = config.config_get("chatgpt_url", "https://chatgpt.com/backend-api/codex").replace(/\/$/, "") + "/responses";

// how close to its expiry a token is refreshed; how old a token with no
// expiry may get; the longest a request to the issuer takes; how long a
// sign-in waits for its user to enter its device code; how long
// a refresh refused as used waits for another process's tokens (ms)
const EARLY   = 5 * 60e3;
const OLD     = 8 * 86400e3;
const REQUEST = 20e3;
const DEVICE  = 15 * 60e3;
const SETTLE  = 2e3;

// the claim with a token's account
const CLAIMS = "https://api.openai.com/auth";

// refresh errors that only signing in again fixes
const GONE = ["refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated", "invalid_grant"];

// 429s whose limit lasts, and what the user reads of each
const LIMITS: Record<string, string> = {
  usage_limit_reached : "reached its usage limit",
  usage_not_included  : "doesn't include this use",
  insufficient_quota  : "is out of quota",
};

const SIGN_IN = "sign in again: `unii chatgpt` (or `bun ChatGPT.ts`) on the server";

// the refresh under way in this process, which every call waits on
let REFRESHING: Promise<Auth> | null = null;

// ChatGPT
// =======

export namespace ChatGPT {

  // Tokens
  // ------

  // a JWT's claims ({}: not one)
  export function claims(jwt: string): any {
    try {
      return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8")) ?? {};
    } catch {
      return {};
    }
  }

  export function json(text: string): any {
    try {
      return JSON.parse(text) ?? {};
    } catch {
      return {};
    }
  }

  // FILE's sign-in (null: none)
  export function load(): Auth | null {
    if (!fs.existsSync(config.CHATGPT)) {
      return null;
    }
    const auth = JSON.parse(fs.readFileSync(config.CHATGPT, "utf8"));
    if (typeof auth?.tokens?.access_token !== "string" || typeof auth.tokens.refresh_token !== "string") {
      throw new Error(config.CHATGPT + " holds no ChatGPT sign-in");
    }
    return auth;
  }

  // written whole (a temp file renamed over it), owner only, its dir made
  export function save(auth: Auth): void {
    fs.mkdirSync(path.dirname(config.CHATGPT), { recursive: true, mode: 0o700 });
    const tmp = config.CHATGPT + "." + process.pid + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(auth, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, config.CHATGPT);
  }

  // a sign-in from a token response (old: the tokens it refreshed)
  export function auth(got: any, old?: Tokens): Auth {
    const id_token = got.id_token ?? old?.id_token ?? "";
    const tokens: Tokens = {
      id_token,
      access_token  : got.access_token,
      refresh_token : got.refresh_token ?? old?.refresh_token,
      account_id    : ChatGPT.claims(id_token)[CLAIMS]?.chatgpt_account_id ?? old?.account_id ?? "",
    };
    return { auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens, last_refresh: new Date().toISOString() };
  }

  // whether it is refreshed now
  export function due(auth: Auth, now = Date.now()): boolean {
    const exp = ChatGPT.claims(auth.tokens.access_token).exp;
    return typeof exp === "number" ? exp * 1000 <= now + EARLY : !(Date.parse(auth.last_refresh) > now - OLD);
  }

  // the access token a request sends, refreshed if due or if it is the
  // one a 401 refused (Agent.ts Wire auth)
  export async function token(refused?: string): Promise<string> {
    const auth = ChatGPT.load();
    if (auth === null) {
      throw new Error("not signed in to ChatGPT: " + SIGN_IN);
    }
    if (auth.tokens.access_token !== refused && !ChatGPT.due(auth)) {
      return auth.tokens.access_token;
    }
    REFRESHING ??= ChatGPT.refresh(auth).finally(() => (REFRESHING = null));
    return (await REFRESHING).tokens.access_token;
  }

  // an error that asking again may get past: a busy try (Agent.ts)
  export function busy(why: string): Error {
    return Object.assign(new Error("ChatGPT token refresh failed: " + why), { busy: true });
  }

  // as Codex asks it (its fields only); refused for good, FILE read again
  // for SETTLE ms: another process's new tokens, if it writes some. Saved
  // only if FILE still holds `old`'s, else FILE's sign-in is the one used
  export async function refresh(old: Auth): Promise<Auth> {
    const newer = () => {
      const now = ChatGPT.load();
      if (now === null) {
        throw new Error("signed out of ChatGPT: " + SIGN_IN);
      }
      return now.tokens.refresh_token !== old.tokens.refresh_token ? now : null;
    };
    let res: Response;
    let text: string;
    try {
      res = await fetch(ISSUER + "/oauth/token", {
        method  : "POST",
        headers : { "content-type": "application/json" },
        body    : JSON.stringify({ client_id: CLIENT, grant_type: "refresh_token", refresh_token: old.tokens.refresh_token }),
        signal  : AbortSignal.timeout(REQUEST),
      });
      text = await res.text();
    } catch (err: any) {
      throw ChatGPT.busy(err.message);
    }
    const body = ChatGPT.json(text);
    if (!res.ok) {
      const code = String(typeof body.error === "string" ? body.error : body.error?.code ?? body.code ?? "").toLowerCase();
      if (res.status !== 401 && !GONE.includes(code)) {
        throw ChatGPT.busy("HTTP " + res.status);
      }
      for (const end = Date.now() + SETTLE; ; await Bun.sleep(250)) {
        const now = newer();
        if (now !== null) {
          return now;
        }
        if (Date.now() >= end) {
          break;
        }
      }
      throw new Error("the ChatGPT sign-in has expired or was revoked (" + (code || "HTTP " + res.status) + "): " + SIGN_IN);
    }
    if (typeof body.access_token !== "string") {
      throw ChatGPT.busy("no access token");
    }
    const auth = ChatGPT.auth(body, old.tokens);
    const now = newer();
    if (now !== null) {
      return now;
    }
    ChatGPT.save(auth);
    return auth;
  }

  // Sign-in
  // -------

  // an authorization code's tokens, saved
  export async function exchange(code: string, redirect: string, verifier: string): Promise<Auth> {
    const form = new URLSearchParams({ grant_type: "authorization_code", client_id: CLIENT, code, redirect_uri: redirect, code_verifier: verifier });
    const res = await fetch(ISSUER + "/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form, signal: AbortSignal.timeout(REQUEST) });
    const text = await res.text();
    if (!res.ok) {
      throw new Error("ChatGPT sign-in failed: HTTP " + res.status + ": " + text.slice(0, 300));
    }
    const auth = ChatGPT.auth(JSON.parse(text));
    ChatGPT.save(auth);
    return auth;
  }

  // by a device code: the link and code to show, then polling till the
  // user entered it, within `wait` ms; a poll the issuer fails (5xx, no
  // answer) polls on
  export async function device(show: (url: string, code: string) => void, wait = DEVICE): Promise<Auth> {
    const api = ISSUER + "/api/accounts/deviceauth";
    const post = (path: string, body: object) =>
      fetch(api + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(REQUEST) });
    const res = await post("/usercode", { client_id: CLIENT });
    if (!res.ok) {
      const off = res.status === 404 ? " (device code sign-in is off for this account: allow it in ChatGPT's security settings)" : "";
      throw new Error("ChatGPT device code request failed: HTTP " + res.status + off);
    }
    const got = await res.json();
    const code = got.user_code ?? got.usercode;
    const every = Math.max(1, Number(got.interval) || 5) * 1000;
    show(ISSUER + "/codex/device", code);
    for (const end = Date.now() + wait; Date.now() < end; await Bun.sleep(Math.min(every, end - Date.now()))) {
      const poll = await post("/token", { device_auth_id: got.device_auth_id, user_code: code }).catch(() => null);
      if (poll?.ok) {
        const ok = await poll.json();
        return ChatGPT.exchange(ok.authorization_code, ISSUER + "/deviceauth/callback", ok.code_verifier);
      }
      if (poll !== null && poll.status !== 403 && poll.status !== 404 && poll.status < 500) {
        throw new Error("ChatGPT device sign-in failed: HTTP " + poll.status);
      }
    }
    throw new Error("ChatGPT device sign-in timed out after " + Math.round(wait / 60e3) + " minutes");
  }

  // revokes the refresh token (Codex's logout), then forgets the sign-in
  // whether or not that worked
  export async function logout(): Promise<string> {
    const auth = ChatGPT.load();
    if (auth === null) {
      return "Not signed in to ChatGPT.";
    }
    const res = await fetch(ISSUER + "/oauth/revoke", {
      method  : "POST",
      headers : { "content-type": "application/json" },
      body    : JSON.stringify({ token: auth.tokens.refresh_token, token_type_hint: "refresh_token", client_id: CLIENT }),
      signal  : AbortSignal.timeout(REQUEST),
    }).catch(() => null);
    fs.rmSync(config.CHATGPT, { force: true });
    return "Signed out of ChatGPT" + (res?.ok ? "." : " (its token wasn't revoked: " + (res ? "HTTP " + res.status : "offline") + ").");
  }

  // who FILE is signed in as
  export function who(auth: Auth): string {
    const id = ChatGPT.claims(auth.tokens.id_token);
    const plan = id[CLAIMS]?.chatgpt_plan_type;
    return (id.email ?? "an account") + (plan ? " (" + plan + " plan)" : "");
  }

  // `unii chatgpt [logout]`
  export async function cli(args: string[]): Promise<void> {
    if (args.includes("logout")) {
      console.log(await ChatGPT.logout());
      return;
    }
    const auth = await ChatGPT.device((url, code) => console.log("To sign this server in to ChatGPT, open\n\n  " + url + "\n\nand enter the code\n\n  " + code + "\n\n(it expires in 15 minutes; enter it only if you started this sign-in)"));
    console.log("\nSigned in to ChatGPT as " + ChatGPT.who(auth) + "; tokens in " + config.CHATGPT + ".\nOffer it with the config vendors=openai-sub (README).");
  }

  // Wire
  // ----

  // the body Codex sends, its fields in its order, of openai-api's parts:
  // the system prompt as `instructions` (the backend requires it), no
  // max_output_tokens, cache breakpoints nor tool-call cap
  export function body(ask: Ask, items: Item[], tools: Tool[], max: number): unknown {
    const api: any = OpenAI.body({ ...ask, speed: "slow" }, items, tools, max);
    return {
      model               : api.model,
      instructions        : ask.system,
      input               : api.input.slice(1).map(ChatGPT.unmark),
      tools               : api.tools,
      tool_choice         : "auto",
      parallel_tool_calls : true,
      reasoning           : api.reasoning,
      store               : false,
      stream              : true,
      include             : ["reasoning.encrypted_content"],
      service_tier        : ask.speed === "fast" ? "priority" : undefined,
      prompt_cache_key    : "unii-" + Bun.hash(JSON.stringify([ask.model, ask.system, ask.blocks[0]?.text ?? ""])).toString(36),
    };
  }

  // a user message without its cache breakpoints
  export function unmark(item: any): any {
    if (item.role !== "user" || !Array.isArray(item.content)) {
      return item;
    }
    return { ...item, content: item.content.map(({ prompt_cache_breakpoint, ...part }: any) => part) };
  }

  export function headers(token: string): Record<string, string> {
    return {
      authorization        : "Bearer " + token,
      "chatgpt-account-id" : ChatGPT.claims(token)[CLAIMS]?.chatgpt_account_id ?? ChatGPT.load()?.tokens.account_id ?? "",
      "openai-beta"        : "responses=experimental",
      "content-type"       : "application/json",
      accept               : "text/event-stream",
      originator           : "uniichat",
    };
  }

  // one stream event, as OpenAI.read takes it; the backend's last
  // response holds no output, so its output is the items streamed
  export function read(st: Sub, ev: any, on: Emit): boolean {
    if (ev.type === "response.output_item.done") {
      st.items[ev.output_index ?? st.items.length] = ev.item;
    }
    const end = OpenAI.read(st, ev, on);
    if (end && st.res !== null && !(st.res.output?.length > 0)) {
      st.res = { ...st.res, output: st.items.filter(Boolean) };
      OpenAI.usage(st.use, st.res);
    }
    st.use.speed = st.speed;
    return end;
  }

  // a 429 at a lasting limit (null: not one): the backend's words logged,
  // ours said (which limit, the plan, when it resets)
  export function refusal(res: Response, text: string): Refusal | null {
    const err = ChatGPT.json(text).error ?? {};
    const kind = [err.type, err.code].find((k) => typeof k === "string" && Object.hasOwn(LIMITS, k));
    if (res.status !== 429 || kind === undefined) {
      return null;
    }
    const until = typeof err.resets_at === "number" && err.resets_at > 0 && err.resets_at < 1e11 ? err.resets_at * 1000 : undefined;
    const plan = typeof err.plan_type === "string" && /^[a-z0-9_]{1,20}$/.test(err.plan_type) ? " (" + err.plan_type + ")" : "";
    const when = until === undefined ? "" : "; it resets " + new Date(until).toISOString().slice(0, 16).replace("T", " ") + " UTC";
    const why = "ChatGPT " + kind + plan + when + ": " + String(err.message ?? "").slice(0, 300);
    return { why, say: "the ChatGPT plan" + plan + " this server runs on " + LIMITS[kind] + when, until };
  }

  export const wire: Wire<Sub> = {
    key     : "",
    idle    : 1200e3,
    url     : RESPONSES,
    auth    : (refused) => ChatGPT.token(refused),
    headers : (token) => ChatGPT.headers(token),
    body    : (ask, items, tools, max) => ChatGPT.body(ask, items, tools, max),
    count   : async () => null,
    start   : (ask) => ({ ...OpenAI.wire.start(ask), items: [], speed: ask.speed }),
    read    : (st, ev, on) => ChatGPT.read(st, ev, on),
    begun   : (ev) => ev.type === "response.output_item.added",
    step    : (st, ask) => ({ ...OpenAI.step(st, ask), note: "" }),
    usage   : (st) => st.use,
    refusal : (res, text) => ChatGPT.refusal(res, text),
  };

}

if (import.meta.main) {
  await ChatGPT.cli(process.argv.slice(2)).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
