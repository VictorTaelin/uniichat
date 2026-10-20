// Sign-in links (Cloud.link_ask): an address has at most 3 unused at once
// (a ticket used up leaves the count) and a network (Cloud.net) 100 a
// day, used or not, so /api/login can't mail a victim links or drain the
// mail quota.

import { afterAll, expect, test } from "bun:test";
import * as fs from "node:fs";

process.env.UNII_DIR = fs.mkdtempSync("/tmp/cloud-test-");
process.env.UNII_SITE = "http://127.0.0.1";
const { Cloud } = await import("./Cloud.ts");

// accounts in a dir made anew; the last test's goes after all
function cloud_new() {
  fs.rmSync(process.env.UNII_DIR ?? "", { recursive: true, force: true });
  fs.mkdirSync(process.env.UNII_DIR ?? "", { recursive: true });
  return Cloud.open(() => {}, () => {}, async () => null);
}

afterAll(() => fs.rmSync(process.env.UNII_DIR ?? "", { recursive: true, force: true }));

test("Cloud.net: IPv4 whole, IPv6 by its /48", () => {
  expect(Cloud.net("1.2.3.4")).toBe("1.2.3.4");
  expect(Cloud.net("::ffff:1.2.3.4")).toBe("1.2.3.4");
  expect(Cloud.net("2001:db8:0:1:aaaa::5")).toBe("2001:db8:0::/48");
  expect(Cloud.net("2001:DB8::1")).toBe("2001:db8:0::/48");
});

test("link_ask caps links by address at once and by network a day", () => {
  const cloud = cloud_new();
  const ask = (who: string, net: string) => Cloud.link_ask(cloud, who, net) ?? Cloud.ticket(cloud, { who, session: null }, 60000);
  const first = ask("a@x.com", "1.1.1.1");
  ask("a@x.com", "1.1.1.1");
  ask("a@x.com", "1.1.1.1");
  expect(Cloud.link_ask(cloud, "a@x.com", "2.2.2.2")).toContain("15 minutes");
  Cloud.ticket_read(cloud, first, true);
  expect(Cloud.link_ask(cloud, "a@x.com", "3.3.3.3")).toBeNull();
  for (let k = 0; k < 97; k++) {
    ask("b" + k + "@x.com", "1.1.1.1");
  }
  expect(Cloud.link_ask(cloud, "c@x.com", "1.1.1.1")).toContain("tomorrow");
  expect(Cloud.link_ask(cloud, "c@x.com", "2.2.2.2")).toBeNull();
  cloud.db.query("update asks set at = at - 864e5").run();
  expect(Cloud.link_ask(cloud, "c@x.com", "1.1.1.1")).toBeNull();
  // no address (a self-host, no proxy): one network, counted
  expect(Cloud.link_ask(cloud, "d@x.com", Cloud.net(""))).toBeNull();
});

test("Cloud.address", () => {
  expect(Cloud.address("@OCTOCAT on gh", true)).toBe("@octocat");
  expect(Cloud.address("o'neil@x.com, not @octocat.", false)).toBe("o'neil@x.com");
});

// A terminal sign-in signs in only when the code the terminal shows is
// typed on the page its link opens (the email's, or GitHub's, which
// brings its code): opening the link makes no session, nor
// does a wrong code; the right one does. So opening an unrequested link,
// or one an attacker forwarded, grants nothing.
test("terminal sign-in needs the code the terminal shows", async () => {
  const cloud = cloud_new();
  const key = Cloud.random();
  const session = Cloud.hash(key);
  const t = Cloud.ticket(cloud, { who: "t@x.com", session }, 60000);
  const code = Cloud.code(session);
  expect(code).toMatch(/^\d{6}$/);
  const post = (c: string) => new Request("http://127.0.0.1/auth", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ t, code: c }).toString() });
  const signed = () => cloud.db.query("select hash from sessions where hash = ?").get(session);
  const gh = Cloud.ticket(cloud, { who: "@x", session }, 60000);
  for (const link of [t, gh]) {
    const page = await Cloud.http(cloud, new Request("http://127.0.0.1/auth?t=" + link + "&code=" + "a".repeat(64)));
    expect(await page?.text()).toContain("Enter the code");
  }
  expect(signed()).toBeNull();
  await Cloud.confirm(cloud, post(code === "000000" ? "111111" : "000000"));
  expect(signed()).toBeNull();
  await Cloud.confirm(cloud, post(code));
  expect(signed()).not.toBeNull();
});

// An emailed link signs in each time it is opened until it expires: a
// mail app's preview opening it first must not use it up.
test("an emailed link survives its preview", async () => {
  const cloud = cloud_new();
  const t = Cloud.ticket(cloud, { who: "p@x.com", session: null }, 60000);
  const open = async () => (await Cloud.http(cloud, new Request("http://127.0.0.1/auth?t=" + t)))?.headers.get("set-cookie") ?? "";
  expect(await open()).toContain("=");
  expect(await open()).toContain("=");
});

// Web push: a signed-in browser posts its subscription, kept for its
// sign-in (signing out forgets it); one at an address inside the
// server's network is refused; each turn's reply goes to each, encrypted
// and signed (Push.ts); one its push service no longer knows (410) is
// forgotten, one it refuses (401, 403: a clock or key gone wrong) kept.
test("web push: subscriptions kept per sign-in, replies sent, gone ones forgotten", async () => {
  const crypto = await import("node:crypto");
  const { Push } = await import("./Push.ts");
  const cloud = cloud_new();
  const user = { id: "7", name: "w@x.com" };
  const token = Cloud.session(cloud, user);
  const call = (method: string, path: string, body?: object) => Cloud.http(cloud, new Request("http://127.0.0.1" + path, { method, headers: { cookie: "unii=" + token, "content-type": "application/json" }, body: body && JSON.stringify(body) }));
  const browser = (n: number) => {
    const ua = Push.ecdh();
    const auth = crypto.randomBytes(16);
    return { ua, auth, json: { endpoint: "https://push.example.net/" + n, keys: { p256dh: ua.getPublicKey("base64url"), auth: auth.toString("base64url") } } };
  };
  const a = browser(1);
  const b = browser(2);
  const c = browser(3);
  const d = browser(4);
  // signed out: no answer here (Server: 401)
  expect(await Cloud.http(cloud, new Request("http://127.0.0.1/api/webpush"))).toBeNull();
  const got = await (await call("GET", "/api/webpush?endpoint=" + encodeURIComponent(a.json.endpoint)))!.json();
  expect(got).toEqual({ key: Push.keys()!.public, on: false });
  expect((await call("POST", "/api/webpush", { endpoint: "http://push.example.net/1", keys: a.json.keys }))!.status).toBe(400);
  for (const inside of ["https://127.0.0.1/x", "https://localhost:8443/x", "https://[::1]/x", "https://169.254.169.254/x", "https://10.1.2.3/x", "https://100.64.0.1/x", "https://[fd7a:115c:a1e0::1]/x", "https://[::ffff:192.168.1.1]/x"]) {
    expect((await call("POST", "/api/webpush", { endpoint: inside, keys: a.json.keys }))!.status).toBe(400);
  }
  expect((await call("POST", "/api/webpush", a.json))!.status).toBe(200);
  expect((await call("POST", "/api/webpush", b.json))!.status).toBe(200);
  expect((await call("POST", "/api/webpush", c.json))!.status).toBe(200);
  expect((await call("POST", "/api/webpush", d.json))!.status).toBe(200);
  expect((await (await call("GET", "/api/webpush?endpoint=" + encodeURIComponent(a.json.endpoint)))!.json()).on).toBe(true);
  // a reply: each browser gets its start, encrypted to it, signed
  const sent: { url: string; headers: Headers; body: Buffer }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    sent.push({ url: String(url), headers: new Headers(init.headers), body: Buffer.from(init.body) });
    const status = { "1": 201, "2": 410, "3": 403, "4": 401 }[String(url).slice(-1)];
    return new Response(null, { status });
  }) as any;
  try {
    Cloud.web_push(cloud, "7", "Here is   the\nanswer. " + "x".repeat(400));
    for (let k = 0; k < 300 && sent.length < 4; k++) {
      await Bun.sleep(10);
    }
    await Bun.sleep(20);
  } finally {
    globalThis.fetch = real;
  }
  expect(sent.map((s) => s.url).sort()).toEqual([a.json.endpoint, b.json.endpoint, c.json.endpoint, d.json.endpoint]);
  const to_a = sent.find((s) => s.url === a.json.endpoint)!;
  expect(to_a.headers.get("content-encoding")).toBe("aes128gcm");
  expect(to_a.headers.get("authorization")).toStartWith("vapid t=");
  expect(to_a.headers.get("authorization")).toEndWith(", k=" + Push.keys()!.public);
  const salt = to_a.body.subarray(0, 16);
  const as_public = to_a.body.subarray(21, 86);
  const hmac = (key: Buffer, data: Buffer) => crypto.createHmac("sha256", key).update(data).digest();
  const ikm = hmac(hmac(a.auth, a.ua.computeSecret(as_public)), Buffer.concat([Buffer.from("WebPush: info\0"), a.ua.getPublicKey(), as_public, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const dec = crypto.createDecipheriv("aes-128-gcm", hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16), hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12));
  const rec = to_a.body.subarray(86);
  dec.setAuthTag(rec.subarray(rec.length - 16));
  const plain = Buffer.concat([dec.update(rec.subarray(0, rec.length - 16)), dec.final()]);
  const msg = JSON.parse(plain.subarray(0, plain.length - 1).toString());
  expect(msg.text).toStartWith("Here is the answer. xxx");
  // 410: forgotten; 403, 401 kept
  const left = () => (cloud.db.query("select endpoint from web_pushes").all() as { endpoint: string }[]).map((r) => r.endpoint);
  expect(left().sort()).toEqual([a.json.endpoint, c.json.endpoint, d.json.endpoint]);
  // turned off: forgotten
  expect((await call("DELETE", "/api/webpush", { endpoint: a.json.endpoint }))!.status).toBe(200);
  expect((await call("DELETE", "/api/webpush", { endpoint: c.json.endpoint }))!.status).toBe(200);
  expect((await call("DELETE", "/api/webpush", { endpoint: d.json.endpoint }))!.status).toBe(200);
  expect(left()).toEqual([]);
  // signing out forgets this sign-in's
  await call("POST", "/api/webpush", a.json);
  expect(left()).toEqual([a.json.endpoint]);
  await Cloud.http(cloud, new Request("http://127.0.0.1/api/logout", { method: "POST", headers: { cookie: "unii=" + token } }));
  expect(left()).toEqual([]);
});

// Web push, a shared browser: a sign-in link opened in a browser signed in
// as someone else ends that sign-in and its pushes, so Alice's replies
// don't reach a browser now Bob's.
test("web push: a browser's subscription ends with its sign-in", async () => {
  const crypto = await import("node:crypto");
  const { Push } = await import("./Push.ts");
  const cloud = cloud_new();
  const ua = Push.ecdh();
  const json = { endpoint: "https://push.example.net/shared", keys: { p256dh: ua.getPublicKey("base64url"), auth: crypto.randomBytes(16).toString("base64url") } };
  const req = (token: string, path: string, init: RequestInit = {}) => new Request("http://127.0.0.1" + path, { ...init, headers: { cookie: "unii=" + token, "content-type": "application/json" } });
  const sign_in = async (who: string, cookie: string) => {
    const t = Cloud.ticket(cloud, { who, session: null }, 60000);
    const res = await Cloud.http(cloud, req(cookie, "/auth?t=" + t));
    return decodeURIComponent(/unii=([^;]+)/.exec(res!.headers.get("set-cookie") ?? "")![1]);
  };
  const rows = () => cloud.db.query("select user from web_pushes").all();
  const alice = await sign_in("alice@x.com", "");
  const user = Cloud.who(cloud, req(alice, "/"))!;
  expect((await Cloud.http(cloud, req(alice, "/api/webpush", { method: "POST", body: JSON.stringify(json) })))!.status).toBe(200);
  expect(rows()).toEqual([{ user: user.id }]);
  const bob = await sign_in("bob@x.com", alice);
  expect(Cloud.who(cloud, req(alice, "/"))).toBeNull();
  expect(Cloud.who(cloud, req(bob, "/"))?.id).not.toBe(user.id);
  expect(rows()).toEqual([]);
});
