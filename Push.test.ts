// Web Push (Push.ts): a message is encrypted as RFC 8291's example
// (Appendix A) says, byte for byte; a request's VAPID token (RFC 8292) is
// signed by the server's key, for the endpoint's origin, within 24 h; the
// server's key pair is kept private.

import { afterAll, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";

process.env.UNII_DIR = fs.mkdtempSync("/tmp/push-test-");
process.env.UNII_SITE = "https://chat.example.com";
const { Push } = await import("./Push.ts");

afterAll(() => fs.rmSync(process.env.UNII_DIR ?? "", { recursive: true, force: true }));

// RFC 8291 Appendix A
const A = {
  plain      : "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  as_public  : "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  as_private : "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  ua_public  : "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  ua_private : "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt       : "DGv6ra1nlYgDCS1FRnbzlw",
  auth       : "BTBZMqHH6r4Tts7J_aSIgg",
  body       : "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

const b64 = (s: string) => Buffer.from(s, "base64url");

// what a browser does with a message (RFC 8291 3.4, RFC 8188), from its
// own keys: the plaintext, its delimiter dropped
function open(body: Buffer, ua: crypto.ECDH, auth: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const as_public = body.subarray(21, 21 + idlen);
  const hmac = (key: Buffer, data: Buffer) => crypto.createHmac("sha256", key).update(data).digest();
  const prk_key = hmac(auth, ua.computeSecret(as_public));
  const ikm = hmac(prk_key, Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), as_public, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const rec = body.subarray(21 + idlen);
  const dec = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  dec.setAuthTag(rec.subarray(rec.length - 16));
  const out = Buffer.concat([dec.update(rec.subarray(0, rec.length - 16)), dec.final()]);
  expect(out[out.length - 1]).toBe(2);
  return out.subarray(0, out.length - 1);
}

test("encrypt: RFC 8291's example, byte for byte", () => {
  const as = crypto.createECDH("prime256v1");
  as.setPrivateKey(b64(A.as_private));
  expect(as.getPublicKey("base64url")).toBe(A.as_public);
  const sub = { endpoint: "https://push.example.net/x", p256dh: A.ua_public, auth: A.auth };
  const body = Push.encrypt(sub, b64(A.plain), b64(A.salt), as);
  expect(body.toString("base64url")).toBe(A.body);
  // the RFC's user agent opens it
  const ua = crypto.createECDH("prime256v1");
  ua.setPrivateKey(b64(A.ua_private));
  expect(open(body, ua, b64(A.auth)).toString()).toBe("When I grow up, I want to be a watermelon");
});

test("vapid: ES256 token for the endpoint's origin, signed by the server's key", () => {
  const keys = Push.keys()!;
  const file = process.env.UNII_DIR + "/vapid.json";
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(keys.jwk);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  const now = Date.UTC(2026, 9, 21);
  const auth = Push.vapid("https://fcm.googleapis.com/fcm/send/abc:def", keys, now);
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(auth);
  expect(m).not.toBeNull();
  const [, head, claims, sig, k] = m!;
  expect(k).toBe(keys.public);
  expect(JSON.parse(b64(head).toString())).toEqual({ typ: "JWT", alg: "ES256" });
  const claim = JSON.parse(b64(claims).toString());
  expect(claim.aud).toBe("https://fcm.googleapis.com");
  expect(claim.sub).toBe("https://chat.example.com");
  expect(claim.exp).toBeGreaterThan(now / 1000);
  expect(claim.exp).toBeLessThanOrEqual(now / 1000 + 24 * 3600);
  const key = Push.point(keys.public)!;
  expect(crypto.verify("sha256", Buffer.from(head + "." + claims), { key, dsaEncoding: "ieee-p1363" }, b64(sig))).toBe(true);
  expect(crypto.verify("sha256", Buffer.from(head + "." + claims + "x"), { key, dsaEncoding: "ieee-p1363" }, b64(sig))).toBe(false);
});
