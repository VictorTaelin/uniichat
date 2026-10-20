// UniiChat (the site)
// ===================
// The page around View.ts's chat: the server's messages go to
// View.view_hear, a click's `data-act` (Html.ts) to View.view_act, and
// both answer what to send back. The page is drawn once a frame, keeping
// the first row in sight in place, or the bottom while the page is at it;
// the log's rows only once a message (but a stream's piece) or an act
// changed them, what streams in a place of its own, so typing, or a reply
// streaming, touches no row.
// The markup is index.html's: the header, the chat or the account page
// (/account), and the footer as the terminal's. A tab is no device; a
// signed-out one gets the chat offline (Guest). In the iOS app (ios/),
// credit is bought through the App Store (APP), and sign-in is by email
// only (another company's would need Sign in with Apple).

import * as Import from "../../Import.ts";
import { theme_css } from "../../Theme.ts";
import * as View from "../../View.ts";
import * as Html from "./Html.ts";

// Types
// =====

// a source the import read (a folder, an export): its sessions, and its
// files left out as they changed while read
type Read = { sessions: Import.Session[]; moved: number };

// Constants
// =========

// the iOS app's bridge (ios/), in its web view only
const APP = (window as any).webkit?.messageHandlers?.unii ?? null;

// a page with a hover has a keyboard of its own; on a touch screen,
// Enter types a new line (the arrow sends), and the page never focuses
// the box itself, which would pop the keyboard up
const DESK = matchMedia("(hover: hover)");

// what a guest is told after the hello but its ask (View.ask): the ask
// again (a link expired), the link sent
const EXPIRED = "That sign-in link expired. What's your email? I'll send you a new one.";
// the line under a guest's box, where the server bills: signing in is
// the consent (Billing.ts CONSENT says it in full); its links open a tab,
// as the menu's do, so the chat stays
const GUEST_AI = 'By signing in, you accept the <a href="/terms.html" target="_blank">terms</a> and <a href="/privacy.html" target="_blank">privacy policy</a>, and that Anthropic\'s and OpenAI\'s models answer you.';
const SENT    = (email: string) => `Thanks! I sent a link to ${email}. Open it, and we'll go on from here.`;

// a folder without sessions
const NONE   = "No Claude or ChatGPT chats in that folder. Choose ~/.claude or ~/.codex.";
const PAYING = "Waiting for your payment in the new tab…";

// an import's payment, its tab back from checkout (?paid=tab), tells the
// import's tab at once (a hidden tab's timers may wait a minute)
const PAID = new BroadcastChannel("unii.paid");

// the intro's scenes: two lines, then the logo above the name
const SCENES = `
  <div class="scene"><p>Your entire life.</p><p>One single chat.</p></div>
  <div class="scene"><i class="mark"></i><h1>UniiChat</h1></div>`;

// the chat
const v = View.view_new();

// the message box
const BOX = $<HTMLTextAreaElement>("textarea");

// the import's slider: the first day it takes, in days since 1970, from
// the first new message's (its left end: all) to today's
const BACK = $<HTMLInputElement>("#import [name=back]");

// the page's: end: at its bottom; stick: the next draw may keep it;
// frame: awaited (0: none); rows: the log's rows changed, to draw;
// found: the sources read, by name; done: sessions imported before; off:
// left out (Import.Want); step: the import's
const P = {
  id    : "",
  guest : false,
  imgs  : [] as Blob[],
  rec   : null as MediaRecorder | null,
  shown : "",
  end   : true,
  stick : true,
  frame : 0,
  rows  : true,
  toast : 0,
  found : new Map<string, Read>(),
  done  : {} as Import.Done,
  off   : new Set<string>(),
  step  : "" as "" | "start" | "pay" | "send" | "run" | "seen" | "done",
};

function $<T extends HTMLElement>(sel: string): T {
  return document.querySelector(sel) as T;
}

// where this browser keeps a fact of the account signed in, so another
// account on it starts anew: "draft", the box's text, for the tab (a
// reload or a top-up's trip to Stripe keeps it); "welcomed", offered the
// import; "risked", the risk accepted
function kept(fact: string): string {
  return "unii." + fact + "." + P.id;
}

// Boot
// ====

async function boot(): Promise<void> {
  document.head.insertAdjacentHTML("beforeend", `<style>${theme_css()}</style>`);
  const q = new URLSearchParams(location.search);
  history.replaceState(null, "", location.pathname === "/account" ? "/account" : "/");
  if (q.has("terminal")) {
    solo("Your terminal is signed in.", "You can close this tab and go back to it.");
    return;
  }
  if (q.has("deleted")) {
    solo("Your account was deleted.", `Your chat and Unii's memory are erased. <a href="/">Back to UniiChat</a>`);
    return;
  }
  if (q.get("paid") === "tab") {
    PAID.postMessage(true);
    close();
    solo("Payment received.", "Close this tab: your import starts in the UniiChat tab you came from.");
    return;
  }
  const me = await boot_me();
  P.guest = me === null;
  chat();
  if (me === null) {
    history.replaceState(null, "", "/");
    guest(q.has("expired"));
    return;
  }
  P.id = me.id;
  signed();
  route();
  v.bills = me.bills;
  v.credits = me.credits;
  connect();
  if (q.has("paid")) {
    toast("Payment received. Your credit shows up in a moment.");
  }
}

// the account signed in (null: none, as the server refuses the session);
// any other answer (a network past its limit, a deploy, no connection)
// says nothing of who, so it is asked again
async function boot_me(): Promise<any> {
  for (;;) {
    const res = await fetch("/api/me").catch(() => null);
    if (res?.status === 200 || res?.status === 401) {
      return res.ok ? res.json() : null;
    }
    await new Promise((ok) => setTimeout(ok, View.RETRY));
  }
}

// a page of one note: the terminal signed in, the account deleted
function solo(title: string, sub: string): void {
  document.body.className = "solo";
  document.body.innerHTML = `<main><h1>${title}</h1><p class="sub">${sub}</p></main>`;
}

// Guest
// =====
// UniiChat's hello, ending in its ask for an email; the answers come from
// here, by no AI: an email gets the sign-in link, "@name" goes to
// GitHub, anything else gets the server's why. All in v.live (unlogged).

// a guest's tab, shown or hidden once signed in elsewhere (the link opens
// a new tab), becomes the user's
async function guest(expired: boolean): Promise<void> {
  document.onvisibilitychange = async () => {
    const res = await fetch("/api/me").catch(() => null);
    if (res?.ok) {
      location.reload();
    }
  };
  const { hello, bills, github } = await fetch("/api/hello").then((res) => res.json());
  const ask = github && APP === null;
  document.body.classList.toggle("bills", bills);
  $(".ai").innerHTML = bills ? GUEST_AI : "";
  BOX.placeholder = "Enter your email" + (ask ? " or @github" : "");
  // read from its start: on a phone it is taller than the screen
  P.end = false;
  guest_say(hello + "\n\n" + (expired ? EXPIRED : View.email_ask(ask)));
}

async function guest_send(text: string): Promise<void> {
  P.end = true;
  v.live.push({ kind: "user", text });
  draw(true);
  const res = await View.post("/api/login", { who: text });
  if (res.url) {
    location.href = res.url;
    return;
  }
  guest_say(res.error ?? SENT(res.who));
}

function guest_say(text: string): void {
  v.live.push({ kind: "unii", text });
  draw(true);
}

// Chat
// ====

function chat(): void {
  const file = $<HTMLInputElement>("input[type=file]");
  BOX.oninput = () => {
    if (!P.guest) {
      sessionStorage.setItem(kept("draft"), BOX.value);
    }
    if (BOX.offsetParent !== null) {
      BOX.style.height = "auto";
      BOX.style.height = Math.min(BOX.scrollHeight, innerHeight * 0.4) + "px";
    }
    draw(true);
  };
  // a guest's answer, an email, is one line: Enter sends it everywhere;
  // never the Enter that ends a composition (Japanese, Chinese: Safari
  // ends it first, so only its keyCode, 229, says so)
  BOX.onkeydown = (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing && ev.keyCode !== 229 && (DESK.matches || P.guest)) {
      ev.preventDefault();
      submit();
    }
  };
  BOX.onpaste = (ev) => attach([...(ev.clipboardData?.files ?? [])]);
  $("form").onsubmit = (ev) => {
    ev.preventDefault();
    submit();
  };
  $(".attach").onclick = () => file.click();
  $("#menu .out").onclick = signout;
  $(".mic").onclick = mic;
  file.onchange = () => {
    attach([...(file.files ?? [])]);
    file.value = "";
  };
  $("#wallet").insertAdjacentHTML("beforeend", Html.credit_html(APP !== null));
  onpopstate = route;
  importer();
  document.ondragover = (ev) => ev.preventDefault();
  document.ondrop = (ev) => {
    ev.preventDefault();
    attach([...(ev.dataTransfer?.files ?? [])]);
  };
  document.onclick = click;
  // a phone's keyboard up or down: the box's last line stays in sight, if
  // the caret is there; the page's bottom, if at it
  visualViewport!.onresize = () => {
    if (document.activeElement === BOX && BOX.selectionStart === BOX.value.length) {
      BOX.scrollTop = BOX.scrollHeight;
    }
    draw(true);
  };
  document.onscroll = () => {
    P.end = innerHeight + scrollY >= document.documentElement.scrollHeight - 1;
  };
  draw(true);
}

// the page of a user signed in, out of the guest's
function signed(): void {
  document.body.className = "";
  BOX.placeholder = View.HINT;
  BOX.removeAttribute("inputmode");
  BOX.removeAttribute("enterkeyhint");
  BOX.removeAttribute("autocomplete");
  BOX.value = sessionStorage.getItem(kept("draft")) ?? "";
  BOX.dispatchEvent(new Event("input"));
}

function submit(): void {
  const text = BOX.value.trim();
  if (P.guest) {
    BOX.value = "";
    if (text !== "") {
      guest_send(text);
    }
    return;
  }
  act({ $: "Send", text, images: P.imgs });
  pics([]);
  BOX.value = "";
  BOX.dispatchEvent(new Event("input"));
}

// a message refused goes back in the box, unless another is in it; out
// of credit (402), the wallet opens, saying so, else the why is a toast
function back(sent: View.Sent, out: View.Answer): void {
  if (out.error === undefined) {
    return;
  }
  if (BOX.value.trim() === "" && P.imgs.length === 0) {
    BOX.value = sent.text;
    BOX.dispatchEvent(new Event("input"));
    pics(sent.images ?? []);
  }
  if (out.status !== 402) {
    toast(out.error);
    return;
  }
  $("#wallet .title").textContent = out.error;
  $("#wallet").showPopover();
}

// files to send with the next message, posted (a guest sends none)
function attach(files: File[]): void {
  if (!P.guest && files.length > 0) {
    pics([...P.imgs, ...files]);
  }
}

// the images waiting, shown over the box; a click drops one
function pics(imgs: Blob[]): void {
  const els = imgs.map((img) => {
    const el = new Image();
    el.src = URL.createObjectURL(img);
    el.title = "Remove";
    el.onclick = () => pics(imgs.filter((x) => x !== img));
    return el;
  });
  P.imgs = imgs;
  $("#pics").replaceChildren(...els);
  draw(true);
}

function act(a: View.Act): void {
  const said = a.$ === "Send" ? a.text.trim() : "";
  P.end = P.end || a.$ === "Send";
  P.rows = true;
  for (const msg of View.view_act(v, a)) {
    View.link_send(v, msg, a.$ === "Send" ? (out) => back(a, out) : undefined, said);
  }
  draw(a.$ === "Send");
}

// a click on a View.Act, a Copy button, a page (go) or credit to buy
// (Html.ts), unless it ends a selection dragged in
// its element
function click(ev: MouseEvent): void {
  const el = (ev.target as HTMLElement).closest<HTMLElement>("[data-act], [data-copy], [data-go], [data-usd]");
  const sel = getSelection();
  if (el === null || (sel !== null && !sel.isCollapsed && el.contains(sel.focusNode))) {
    return;
  }
  const { act: a, copy: text, go: path, usd } = el.dataset;
  const menu = el.closest("#menu") !== null;
  if (menu) {
    $("#menu").hidePopover();
  }
  if (path !== undefined || (a !== undefined && menu)) {
    ev.preventDefault();
    go(path ?? "/");
  }
  if (a !== undefined) {
    act(JSON.parse(a));
  }
  if (usd !== undefined) {
    warned(el, () => topup(Number(usd)));
  }
  if (text !== undefined) {
    navigator.clipboard.writeText(text).then(() => copied(el), () => toast("Could not copy."));
  }
}

function copied(button: HTMLElement): void {
  button.innerHTML = Html.CHECK;
  setTimeout(() => (button.innerHTML = Html.SHEETS), 1200);
}

// Voice
// =====
// The mic records (the browser's MediaRecorder: webm, or mp4 where only
// that is made) until clicked again; the server writes the recording
// out, paid as the calls, and its words join the box where the cursor
// is, to edit and send.

async function mic(): Promise<void> {
  if (P.rec !== null) {
    P.rec.stop();
    return;
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
  if (stream === null) {
    toast("UniiChat can't use the microphone.");
    return;
  }
  const mimeType = ["audio/webm", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported(type));
  const rec = new MediaRecorder(stream, { mimeType });
  const parts: Blob[] = [];
  rec.ondataavailable = (ev) => parts.push(ev.data);
  rec.onstop = () => {
    stream.getTracks().forEach((track) => track.stop());
    P.rec = null;
    words(new Blob(parts, { type: rec.mimeType }));
  };
  rec.start();
  P.rec = rec;
  draw(false);
  meter(stream, rec);
}

// While rec records, the box shows its loudness: a bar every 50 ms,
// scrolling left, and the time so far.
function meter(stream: MediaStream, rec: MediaRecorder): void {
  const audio = new AudioContext();
  const probe = audio.createAnalyser();
  audio.createMediaStreamSource(stream).connect(probe);
  const buf = new Uint8Array(probe.fftSize);
  const canvas = $<HTMLCanvasElement>(".voice canvas");
  const pen = canvas.getContext("2d")!;
  const levels: number[] = [];
  const start = performance.now();
  const frame = (now: number): void => {
    if (P.rec !== rec) {
      audio.close();
      return;
    }
    probe.getByteTimeDomainData(buf);
    const power = buf.reduce((sum, b) => sum + ((b - 128) / 128) ** 2, 0) / buf.length;
    const level = Math.min(1, Math.sqrt(power) * 5);
    const slot = Math.floor((now - start) / 50);
    levels[slot] = Math.max(levels[slot] ?? 0, level);
    const secs = Math.floor((now - start) / 1000);
    $(".voice span").textContent = Math.floor(secs / 60) + ":" + String(secs % 60).padStart(2, "0");
    const dpr = devicePixelRatio;
    const w = (canvas.width = canvas.clientWidth * dpr);
    const h = (canvas.height = canvas.clientHeight * dpr);
    pen.fillStyle = getComputedStyle(canvas).color;
    const step = 5 * dpr;
    for (let i = 0; i * step < w && slot - i >= 0; i++) {
      const bar = Math.max(2 * dpr, (levels[slot - i] ?? 0) * h);
      pen.fillRect(w - (i + 1) * step, (h - bar) / 2, 3 * dpr, bar);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function words(audio: Blob): void {
  const act: View.Client = { $: "voice", type: audio.type, body: () => audio };
  View.link_send(v, act, heard);
  draw(false);
}

function heard(out: View.Answer): void {
  draw(false);
  const text = out.text?.trim() ?? "";
  if (text === "") {
    toast(out.error ?? "No words heard.");
    return;
  }
  const gap = /\S$/.test(BOX.value.slice(0, BOX.selectionStart)) ? " " : "";
  BOX.setRangeText(gap + text, BOX.selectionStart, BOX.selectionEnd, "end");
  BOX.dispatchEvent(new Event("input"));
  BOX.focus();
}

// Socket
// ======
// View's link; a socket lost opens again, but one that never showed the
// chat may be a session gone: then the page starts over.

function connect(): void {
  View.link_open(v, {
    open : (query) => new WebSocket(location.origin.replace(/^http/, "ws") + "/ws" + query),
    post : (path, body) => fetch(path, { method: "POST", body }),
    hear : hear,
    lost : lost,
  });
}

async function lost(up: boolean): Promise<boolean> {
  draw(true);
  const me = up ? null : await fetch("/api/me").catch(() => null);
  if (me !== null && me.status === 401) {
    location.href = "/";
    return false;
  }
  return true;
}

// a pick changed shows what it is now (a click on a knob moves it). The
// rows change with what they show: a state (credits, ~10/s importing)
// only by its agents, an agent's page saying whether it runs
function hear(msg: View.Server): void {
  const was = View.view_pick(v);
  const agents = v.agents.join();
  for (const out of View.view_hear(v, msg)) {
    View.link_send(v, out);
  }
  const now = View.view_pick(v).filter((k) => was.length > 0 && !was.some((w) => w.text === k.text));
  if (now.length > 0) {
    toast("Now " + now.map((k) => k.hint).join("; ") + ".");
  }
  P.rows ||= msg.$ === "state" ? v.agents.join() !== agents : msg.$ !== "delta" && msg.$ !== "live";
  import_welcome();
  draw(true);
}

// Import
// ======
// Import History: offered once to a new account on a computer, and in
// the menu. A folder picked, or a site's export (a zip), is read for its
// sessions' heads, each app's list folded (all picked; open it to
// leave some out); then what it finds and costs, and Import (short of
// credit, Add $N and import: checkout in a new tab, the import starting
// once paid); then its progress, Pause or Resume. All follows from P and
// a status. A picked file can't be read once it changes, so each is
// copied as first read.

function importer(): void {
  const form = $<HTMLFormElement>("#import form");
  const dir  = $<HTMLInputElement>("#import [name=dir]");
  $(".imp").onclick = () => import_open(false);
  const zip  = $<HTMLInputElement>("#import [name=zip]");
  $(".pickdir").onclick = () => dir.click();
  for (const src of import_srcs()) {
    src.querySelector<HTMLButtonElement>(".pickzip")!.onclick = () => zip.click();
    src.querySelector<HTMLButtonElement>(".pickzip")!.title = "From the website: " + Import.EXPORTS[src.dataset.app!] + ", which emails you a zip.";
  }
  $(".into").onclick = () => {
    P.step = "";
    import_draw("");
  };
  $("#import").onclick = (ev) => (ev.target as HTMLElement).closest(".skip") && $("#import").hidePopover();
  $("#import .prog .sub").textContent = Import.MIDWAY;
  $("#import .flow").onclick = import_flow;
  $("#import").ontoggle = (ev) => {
    if ((ev as ToggleEvent).newState === "closed") {
      P.step = P.step === "pay" || P.step === "start" || P.step === "done" ? "" : P.step;
    }
    import_draw("");
  };
  form.oninput = (ev) => {
    const box = ev.target as HTMLInputElement;
    if (box.name === "session") {
      box.checked ? P.off.delete(box.value) : P.off.add(box.value);
    }
    import_draw("");
  };
  // drawn once as the read starts (a draw lists every session found)
  dir.onchange = async () => {
    const all = [...(dir.files ?? [])];
    const files = all.filter((f) => Import.import_file(f.webkitRelativePath));
    const found: Import.Session[] = [];
    let moved = 0;
    const reading = (k: number) => "Reading " + k + " of " + files.length + " files…";
    import_draw(reading(1));
    for (const [k, f] of files.entries()) {
      $("#import .guess").textContent = reading(k + 1);
      const s = await import_copy(f).then((b) => Import.import_session(b, "log"), () => undefined);
      moved += s === undefined ? 1 : 0;
      found.push(...(s ? [s] : []));
    }
    dir.value = "";
    import_took(all[0]?.webkitRelativePath.split("/")[0] ?? "", { sessions: found, moved }, found.length > 0 ? "" : NONE);
  };
  zip.onchange = async () => {
    for (const f of zip.files ?? []) {
      import_draw("Reading " + f.name + "…");
      try {
        const found = await Import.import_export(await import_copy(f));
        import_took(f.name, { sessions: found, moved: 0 }, found.length > 0 ? "" : "No chats in " + f.name + ".");
      } catch (e) {
        import_took(f.name, { sessions: [], moved: 0 }, f.name + ": " + (e as Error).message);
      }
    }
    zip.value = "";
  };
  // short of credit, Import adds it first, in a new tab (this one keeps
  // the folder), and imports once it is in
  form.onsubmit = (ev) => {
    ev.preventDefault();
    warned(form, import_go);
  };
}

// Import: at once, or short of credit, after paying
function import_go(): void {
  const add = import_add(import_plan());
  if (add === 0) {
    return import_send();
  }
  import_buy(add);
}

// the progress's button: Pause, Resume, or, the import waiting for
// credit, Add $N, paid as Import is
function import_flow(): void {
  const run = v.importing;
  if (run?.why === View.BROKE) {
    return warned($("#import .flow"), () => import_buy(View.progress_need(run, v.credits)));
  }
  View.link_send(v, { $: "go", on: Boolean(run?.why) }, (out) => out.error && toast(out.error));
}

// credit for the import, in a new tab, awaited once checkout opened;
// refused (past the most one payment takes, a test server, BendAI
// down), the box is as before it, to press again
async function import_buy(usd: number): Promise<void> {
  P.step = "pay";
  import_draw(PAYING);
  if (await topup(usd)) {
    return import_pay();
  }
  P.step = "";
  import_draw("");
}

// before an account's first import or payment on this browser, a warning:
// this is experimental software, money in may be lost, uploads may leak
// (accepted, it holds past a reload or a payment's trip). It opens
// inside the box that asked (so a click on it never light-dismisses that
// box, which keeps its folder and opens checkout in a new tab), and its
// "I accept the risk" runs then in its own click, so checkout's tab opens
function warned(from: HTMLElement, then: () => void): void {
  if (localStorage.getItem(kept("risked")) !== null) {
    return then();
  }
  const box = $("#risk");
  (from.closest("[popover]") ?? document.body).append(box);
  box.querySelector<HTMLButtonElement>(".no")!.onclick = () => box.hidePopover();
  box.querySelector<HTMLButtonElement>(".ok")!.onclick = () => {
    localStorage.setItem(kept("risked"), "1");
    box.hidePopover();
    then();
  };
  box.showPopover();
}

// the box, opened by the menu or as a new account's first step
async function import_open(first: boolean): Promise<void> {
  $("#menu").hidePopover();
  P.done = await fetch("/api/imported").then((res) => res.json()).catch(() => ({}));
  $("#import form .skip").textContent = first ? "Start fresh" : "Close";
  P.step = first ? "start" : P.step === "done" ? "" : P.step;
  import_draw("");
  $("#import").showPopover();
}

// a source read, its sessions by name; the slider at all again (its left end:
// the draw's min pulls it up to the first day). Its min goes first: a range
// keeps its value within its bounds (set under the last min, today with nothing
// read, it stays at today)
function import_took(name: string, read: Read, status: string): void {
  P.found.set(name, read);
  BACK.min = "0";
  BACK.value = "0";
  import_draw(status);
}

// a new account (its chat only its OPENING), on a computer: the box, once
// on this browser (a payment's trip, or a reload, never asks again), after
// the intro
async function import_welcome(): Promise<void> {
  await INTRO;
  const key = kept("welcomed");
  if (localStorage.getItem(key) === null && v.pick !== null && v.parts.length === View.OPENING && v.importing === null && DESK.matches) {
    localStorage.setItem(key, "1");
    import_open(true);
  }
}

// while a payment is awaited: the balance, every few seconds and as the
// payment's tab says it is paid (the server reads it only when asked),
// until it covers the import, which then starts; an import waiting for
// it goes on by itself
async function import_pay(): Promise<void> {
  while (P.step === "pay") {
    await new Promise((ok) => {
      setTimeout(ok, 3000);
      PAID.onmessage = ok;
    });
    const me = await fetch("/api/me").then((res) => res.json()).catch(() => null);
    v.credits = me?.credits ?? v.credits;
    if (P.step === "pay" && v.importing === null && v.credits !== null && v.credits >= import_plan().guess) {
      import_send();
    }
  }
}

function import_send(): void {
  const picked = import_plan().picked;
  P.step = "send";
  import_draw("");
  const body = async () => new Blob(await Array.fromAsync(Import.import_body(picked), (part) => new Blob([part])));
  View.link_send(v, { $: "import", body }, import_sent);
}

// the box stays open on the import's progress (the answer says whether it
// still runs: its first progress may come before or after it)
function import_sent(out: View.Answer): void {
  P.step = out.error !== undefined ? "" : out.going ? "run" : "done";
  if (out.error === undefined) {
    P.found.clear();
  }
  import_draw(out.error === undefined ? "" : "Not imported: " + out.error);
  $("#import").showPopover();
}

// the credit an import of plan adds first (Import.topup; 0: none)
function import_add(plan: Import.Plan): number {
  return plan.msgs > 0 && v.credits !== null ? Import.topup(plan.guess, v.credits) : 0;
}

// the import the box wants
function import_plan(): Import.Plan {
  const form = new FormData($("#import form"));
  const want = { off: [...P.off], since: import_since(), tools: form.has("tools") };
  const found = [...P.found.values()].flatMap((read) => read.sessions);
  return Import.import_plan(found, want, P.done, View.view_count(v));
}

// the slider's day, the first one taken ("2026-06-01"; at its left end,
// all: ""): it runs in days from the first new message's to today
function import_since(): string {
  return BACK.valueAsNumber > Number(BACK.min) ? new Date(BACK.valueAsNumber * 864e5).toISOString().slice(0, 10) : "";
}

// an import's progress, in the box and the header, once it is sent or
// while one runs (from any tab: its step is then "seen", whatever the box
// showed, but "pay" while it waits for the credit paid); at its end the
// box says so, until closed. Whether it shows.
function import_bar(): boolean {
  const run = v.importing;
  const broke = run?.why === View.BROKE;
  const paying = broke && P.step === "pay";
  P.step = run !== null && !paying ? "seen" : P.step === "seen" ? "done" : P.step;
  const done  = P.step === "done";
  const going = paying || ["send", "run", "seen", "done"].includes(P.step);
  const part  = run === null ? Number(done) : run.done / Math.max(1, run.total);
  const why   = Boolean(run?.why);
  const said  = run !== null ? View.progress_show(v, run) : done ? Import.DONE : P.step === "send" ? "Sending…" : "Starting…";
  $("#import .start").hidden = P.step !== "start";
  $("#import form").hidden = going || P.step === "start";
  $("#import .prog").hidden = !going;
  $("#import .prog .title").textContent = done ? "Memory tree built" : "Building your memory tree";
  $<HTMLProgressElement>("#import progress").value = part;
  $<HTMLProgressElement>(".imping progress").value = part;
  $(".imping").hidden = run === null;
  $(".imping").classList.toggle("why", why);
  $(".imping span").textContent = !why ? "Building memory" : run!.why === View.BROKE ? "Needs credit" : "Import paused";
  $(".imping").title = $("#import .pct").textContent = said;
  $("#import .prog .sub").hidden = why || done;
  $("#import .flow").textContent = broke ? "Add $" + View.progress_need(run, v.credits) : why ? "Resume" : "Pause";
  $<HTMLButtonElement>("#import .flow").hidden = run === null;
  $<HTMLButtonElement>("#import .flow").disabled = paying;
  markup($("#import .prog .topup"), broke ? [Html.fine_html(APP !== null)] : []);
  return going;
}

// the box as P says, with a status (reading, paying, or why not)
function import_draw(status: string): void {
  if (import_bar()) {
    return;
  }
  const reads    = [...P.found.values()];
  const sessions = reads.flatMap((read) => read.sessions);
  const plan     = import_plan();
  const msgs     = plan.msgs;
  const add      = import_add(plan);
  const left     = reads.reduce((n, read) => n + read.moved, 0);
  const moved    = left === 0 ? "" : " (" + left + (left === 1 ? " file" : " files") + " changed while read: choose the folder again to add them)";
  const has      = add > 0 ? " · you have " + View.usd_show(v.credits!) : "";
  const found    = sessions.length === 0 ? "" : plan.first === "" ? Import.OLD : Import.import_count(msgs, "new ") + (msgs > 0 ? " · about " + Import.guess_usd(plan.guess) + has : "");
  const day = (at: string | number) => new Date(at).getUTCDate() + " " + new Date(at).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
  BACK.min = String(Math.floor(Date.parse(plan.first || new Date().toISOString()) / 864e5));
  BACK.max = String(Math.floor(Date.now() / 864e5));
  $("#import .since .from").textContent = day(import_since() || plan.first || Date.now());
  $("#import .since .to").textContent = day(Date.now());
  BACK.style.setProperty("--at", (100 * (BACK.valueAsNumber - Number(BACK.min))) / Math.max(1, Number(BACK.max) - Number(BACK.min)) + "%");
  $("#import .want").hidden = plan.first === "";
  $("#import .tools").hidden = !sessions.some((s) => s.heads.some((m) => m.kind === "tool" || m.kind === "echo"));
  $("#import .found").textContent = found + moved;
  for (const src of import_srcs()) {
    const list  = src.querySelector(".sessions")!;
    const shown = plan.sessions.filter((s) => s.app === src.dataset.app);
    markup(list, shown.map((s) => `<label title="${Html.esc(s.where + ", " + Import.import_count(s.heads.length, ""))}"><input type="checkbox" name="session" value="${Html.esc(Import.import_id(s))}">${Import.import_cells(s).map((c) => `<span>${Html.esc(c)}</span>`).join("")}</label>`));
    list.querySelectorAll("input").forEach((box) => (box.checked = !P.off.has(box.value)));
    const on = shown.filter((s) => !P.off.has(Import.import_id(s))).length;
    src.querySelector<HTMLElement>(".pick")!.hidden = shown.length === 0;
    src.querySelector(".pick summary")!.textContent = (on < shown.length ? on + " of " : shown.length > 1 ? "All " : "") + shown.length + (shown.length === 1 ? " session" : " sessions") + " picked · choose";
  }
  $("#import .guess").textContent = status;
  markup($("#import form .topup"), add > 0 ? [Html.fine_html(APP !== null)] : []);
  const [go, dir] = [$<HTMLButtonElement>("#import .go"), $<HTMLButtonElement>(".pickdir")];
  go.hidden = msgs === 0;
  go.textContent = add > 0 ? "Add $" + add + " and import" : "Import";
  go.disabled = P.step === "pay" || status.startsWith("Reading");
  dir.textContent = msgs > 0 ? "Add a folder" : "Choose folder";
  dir.classList.toggle("alt", msgs > 0);
  dir.disabled = go.disabled;
  import_srcs().forEach((src) => (src.querySelector<HTMLButtonElement>(".pickzip")!.disabled = dir.disabled));
}

// each app's box (index.html .src, by data-app)
function import_srcs(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("#import .src")];
}

// a picked file as it is now, copied a chunk at a time (the browser keeps
// the chunks, on disk when large, so the page never holds it whole)
async function import_copy(file: File): Promise<Blob> {
  const reader = file.stream().getReader();
  const parts: Blob[] = [];
  for (let got = await reader.read(); !got.done; got = await reader.read()) {
    parts.push(new Blob([got.value]));
  }
  return new Blob(parts);
}

// Drawing
// =======

// an element's children, one per markup, each made only when no child
// has its markup: the rest stay as they are, so a fold or a new message
// touches its own row only, and what is under the mouse, selected or
// loaded stays (a reply streams into its last row only)
const MARKUP = new WeakMap<Element, string>();

function markup(el: Element, htmls: string[]): void {
  const had = new Map<string, Element[]>();
  for (const child of el.children) {
    const html = MARKUP.get(child)!;
    const same = had.get(html) ?? [];
    same.push(child);
    had.set(html, same);
  }
  const kids = htmls.map((html) => had.get(html)?.shift() ?? html_parse(html));
  for (const left of had.values()) {
    left.forEach((child) => child.remove());
  }
  let at = el.firstElementChild;
  for (const kid of kids) {
    if (kid === at) {
      at = at.nextElementSibling;
    } else {
      el.insertBefore(kid, at);
    }
  }
}

// one markup's element, its markup kept
function html_parse(html: string): Element {
  const made = document.createElement("template");
  made.innerHTML = html;
  const child = made.content.firstElementChild!;
  MARKUP.set(child, html);
  return child;
}

// draws the page at the next frame; stick: keep the bottom, if at it
function draw(stick: boolean): void {
  P.stick = P.stick && stick;
  if (P.frame === 0) {
    P.frame = requestAnimationFrame(paint);
  }
}

// a new chat shown opens at its bottom (folded: its top); the account
// page shown, only the bars
function paint(): void {
  if (!$("#account").hidden) {
    P.frame = 0;
    bars();
    return;
  }
  const doc = document.documentElement;
  const follow = P.stick && P.end;
  const at = P.rows && !follow ? anchor() : null;
  const shown = (v.page === null ? "" : v.page.name) + (v.fold === null ? "" : "/fold");
  P.frame = 0;
  P.stick = true;
  bars();
  if (P.rows) {
    markup($("#log .rows"), View.view_body(v).map(Html.row_html));
    P.rows = false;
  }
  markup($("#log .tail"), View.view_tail(v).map(Html.row_html));
  if (shown !== P.shown) {
    P.shown = shown;
    scrollTo(0, v.fold === null ? doc.scrollHeight : 0);
    return;
  }
  if (follow) {
    scrollTo(0, doc.scrollHeight);
    return;
  }
  if (at === null) {
    return;
  }
  const rows = [...document.querySelectorAll<HTMLElement>("#log [data-a]")];
  const el = rows.filter((r) => Number(r.dataset.a) <= at.a).pop();
  if (el !== undefined) {
    scrollBy(0, el.getBoundingClientRect().top - at.top);
  }
}

// the header's and the footer's parts that change, and the notes, a
// server's or an act's ("/help is no command", "haiku-5.5 has no fast"),
// as toasts
function bars(): void {
  for (const note of v.notes.splice(0)) {
    toast(note);
  }
  const credits = View.view_credits(v);
  const on = View.view_typing(v);
  const stop = on && v.busy && BOX.value.trim() === "" && P.imgs.length === 0;
  const tabs = View.view_tabs(v);
  const send = $<HTMLButtonElement>(".send");
  $(".net").hidden = v.up;
  $(".credits").hidden = credits === null;
  $(".credits").textContent = credits;
  document.body.classList.toggle("bills", v.bills);
  send.classList.toggle("stop", stop);
  send.disabled = !on;
  BOX.disabled = !on;
  $<HTMLButtonElement>(".attach").disabled = !on;
  $<HTMLButtonElement>(".mic").disabled = !on || v.out.some((p) => p.msg.$ === "voice");
  $(".mic").classList.toggle("rec", P.rec !== null);
  $(".composer").classList.toggle("off", !on);
  $(".composer").classList.toggle("rec", P.rec !== null);
  markup($("#pick"), Html.pick_html(View.view_fold(v), v.fold === null, View.view_pick(v)));
  $("#tabs").hidden = tabs.length < 2;
  markup($("#tabs"), Html.tabs_html(tabs));
  import_bar();
}

// the first row in sight with a first message (no row inside it): that
// message, and where it is on screen. None in sight: the page keeps its
// scroll, as those rows only grow at its end
function anchor(): { a: number; top: number } | null {
  for (const r of document.querySelectorAll<HTMLElement>("#log [data-a]")) {
    const box = r.getBoundingClientRect();
    if (box.bottom > 60 && r.querySelector("[data-a]") === null) {
      return box.top < innerHeight ? { a: Number(r.dataset.a), top: box.top } : null;
    }
  }
  return null;
}

// Account
// =======
// The account page (Html.account_html), drawn anew each time it is shown
// and after each act on it.

// shows the page at path: the chat ("/") or the account
function go(path: string): void {
  if (location.pathname !== path) {
    history.pushState(null, "", path);
  }
  route();
}

// the account page keeps of the footer only its toasts (style.css)
function route(): void {
  const page = location.pathname === "/account";
  $("#log").hidden = page;
  document.body.classList.toggle("account", page);
  $("#account").hidden = !page;
  P.shown = location.pathname;
  if (page) {
    account();
  }
  draw(false);
}

async function account(): Promise<void> {
  const el = $("#account");
  const res = await fetch("/api/account").catch(() => null);
  const a: View.Account | null = res !== null && res.ok ? await res.json() : null;
  if (a === null) {
    el.innerHTML = `<p class="sub">Could not read your account. Try again in a moment.</p>`;
    return;
  }
  el.innerHTML = Html.account_html(a, APP !== null);
  const kill = $<HTMLFormElement>("#account .kill");
  const del  = $<HTMLButtonElement>("#account .del");
  const name = kill.querySelector("input")!;
  const sure = (open: boolean) => {
    kill.hidden = !open;
    del.hidden = open;
  };
  del.onclick = () => {
    sure(true);
    name.focus();
  };
  $("#account .keep").onclick = () => sure(false);
  name.oninput = () => (kill.querySelector<HTMLButtonElement>(".red")!.disabled = name.value.trim().toLowerCase() !== a.name.toLowerCase());
  $("#account .out").onclick = signout;
  kill.onsubmit = (ev) => {
    ev.preventDefault();
    account_delete(kill);
  };
}

async function signout(): Promise<void> {
  await View.post("/api/logout", {});
  location.href = "/";
}

// the server deletes it all, once the account's name is typed
async function account_delete(kill: HTMLFormElement): Promise<void> {
  const name = kill.querySelector("input")!.value;
  const out = await View.post("/api/delete", { confirm: name });
  if (out.error === undefined) {
    location.href = "/?deleted";
    return;
  }
  kill.querySelector(".why")!.textContent = out.error;
}

// Notes
// =====

// in the app, the App Store's (ios/ buys, then posts the purchase); else
// Stripe's checkout, in this page, or in a new tab while Import History
// is open (a page left loses the folder picked); it comes back to the
// page that bought (back: the chat, or the account page). Whether it
// started (refused, the why is a toast)
async function topup(usd: number): Promise<boolean> {
  if (APP !== null) {
    $("#wallet").hidePopover();
    APP.postMessage({ buy: usd });
    return true;
  }
  const tab = $("#import").matches(":popover-open") ? open("", "_blank") : null;
  const out = await View.post("/api/topup", { usd, tab: tab !== null, back: location.pathname });
  if (out.url) {
    (tab ?? window).location.href = out.url;
    return true;
  }
  tab?.close();
  toast(out.error ?? "Could not start the payment.");
  return false;
}

function toast(text: string): void {
  const el = $("#toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(P.toast);
  P.toast = setTimeout(() => (el.hidden = true), 7000) as unknown as number;
}

// Intro
// =====
// Once per browser (?skip: never), over the page; style.css times it, and
// its last animation, a click or a key ends it. Played, it is done once
// gone (INTRO), so no box opens over it.

function intro_play(): Promise<void> {
  const skip = new URLSearchParams(location.search).has("skip");
  if (localStorage.getItem("unii.intro") !== null || skip) {
    return Promise.resolve();
  }
  localStorage.setItem("unii.intro", "1");
  const el = document.createElement("div");
  return new Promise((gone) => {
    function end(): void {
      removeEventListener("keydown", end);
      el.classList.add("out");
      el.ontransitionend = () => {
        el.remove();
        gone();
      };
      if (DESK.matches) {
        BOX.focus();
      }
    }
    el.id = "intro";
    el.innerHTML = SCENES;
    el.onclick = end;
    el.onanimationend = (ev) => {
      if (ev.target === el) {
        end();
      }
    };
    addEventListener("keydown", end);
    document.documentElement.append(el);
  });
}

const INTRO = intro_play();
boot();
