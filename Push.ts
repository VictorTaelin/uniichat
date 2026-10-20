// Push
// ====
// Web Push (RFC 8030) with no vendor's account: the server's own VAPID
// key pair (RFC 8292), made at its first start and kept beside its config
// (config.DIR/vapid.json; a new pair loses every browser's subscription),
// signs each request, and each message is encrypted to its browser's
// keys (RFC 8291: aes128gcm, RFC 8188, one record), so the push service
// (Google's, Mozilla's, Apple's, as the browser picked) reads nothing.

import * as crypto from "node:crypto";
import * as dns from "node:dns";
import * as fs from "node:fs";
import * as net from "node:net";
import * as config from "./Config.ts";

// Types
// =====

// a browser's subscription: where its push service takes its messages,
// its key (an uncompressed P-256 point) and its secret, base64url
export type Sub = { endpoint: string; p256dh: string; auth: string };

// the server's key pair: its private key as a JWK (vapid.json), and its
// public point (65 bytes, base64url), as browsers take it
export type Keys = { jwk: JsonWebKey; public: string };

// Constants
// =========

const FILE   = config.DIR + "/vapid.json";

// a record's size (RFC 8188): one record holds any message sent here
const RS     = 4096;

// how long a push service keeps a message for a browser that is off (s)
const TTL    = 24 * 60 * 60;

// how long a request's signature holds (s; RFC 8292 caps it at 24 h)
const AGE    = 12 * 60 * 60;

// how long a push service may take to answer (ms)
const ANSWER = 30 * 1000;

// the most an endpoint's URL may be (Chrome's, Firefox's, Apple's are
// under 500)
const URL_MAX = 2048;

// where no push may go, so a signed-in user can't make the server post
// into its own network: loopback, private, link-local (and so cloud
// metadata), CGNAT (Tailscale), multicast, reserved; IPv4-mapped IPv6
// addresses are checked as IPv4
const INSIDE = new net.BlockList();
for (const cidr of ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/3", "::/127", "fc00::/7", "fe80::/10", "ff00::/8"]) {
  const [ip, bits] = cidr.split("/");
  INSIDE.addSubnet(ip, Number(bits), net.isIPv6(ip) ? "ipv6" : "ipv4");
}

// Globals
// =======

// the key pair read (null: vapid.json is broken, so no web push)
let KEYS: Keys | null | undefined;

// Push
// ====

export namespace Push {

  // the server's key pair, read, or made at the first start (Cloud.open,
  // before any worker); null, logged, if vapid.json isn't one: made anew,
  // it would silence every browser
  export function keys(): Keys | null {
    if (KEYS !== undefined) {
      return KEYS;
    }
    if (!fs.existsSync(FILE)) {
      const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
      fs.writeFileSync(FILE + ".new", JSON.stringify(privateKey.export({ format: "jwk" })) + "\n", { mode: 0o600 });
      fs.renameSync(FILE + ".new", FILE);
    }
    try {
      const jwk = JSON.parse(fs.readFileSync(FILE, "utf8"));
      crypto.createPrivateKey({ key: jwk, format: "jwk" });
      const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
      KEYS = { jwk, public: point.toString("base64url") };
    } catch (err: any) {
      console.error(FILE + " is not a VAPID key pair, so web push is off: put the right file back, or delete it for a new pair (every browser then turns notifications on again). " + (err?.message ?? err));
      KEYS = null;
    }
    return KEYS;
  }

  // a subscription as a browser gives it (PushSubscription.toJSON), if
  // whole and sound: an https endpoint, a key on the curve, a 16-byte
  // secret
  export function sub_read(json: any): Sub | null {
    const endpoint = String(json?.endpoint ?? "");
    const p256dh = String(json?.keys?.p256dh ?? "");
    const auth = String(json?.keys?.auth ?? "");
    if (endpoint.length > URL_MAX || !URL.canParse(endpoint) || new URL(endpoint).protocol !== "https:") {
      return null;
    }
    if (Buffer.from(auth, "base64url").length !== 16 || Push.point(p256dh) === null) {
      return null;
    }
    return { endpoint, p256dh, auth };
  }

  // whether an endpoint's host is, or resolves to, an address INSIDE (a
  // name that doesn't resolve isn't: a push to it fails anyway)
  export async function inside(endpoint: string): Promise<boolean> {
    const host = new URL(endpoint).hostname.replace(/^\[|\]$/g, "");
    const ips = await dns.promises.lookup(host, { all: true }).catch(() => []);
    return ips.some((ip) => INSIDE.check(ip.address, ip.family === 6 ? "ipv6" : "ipv4"));
  }

  // a public key's point as a key object (null: not a P-256 point)
  export function point(b64: string): crypto.KeyObject | null {
    const raw = Buffer.from(b64, "base64url");
    if (raw.length !== 65 || raw[0] !== 4) {
      return null;
    }
    try {
      const jwk = { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") };
      return crypto.createPublicKey({ key: jwk, format: "jwk" });
    } catch {
      return null;
    }
  }

  // Encryption
  // ----------

  // a message encrypted to a browser (RFC 8291 3.4, RFC 8188 2): the
  // salt, the record size, the sender's one-off public key, then the one
  // record, the message padded by its delimiter (2: the last). The salt
  // and the sender's key are random but in tests
  export function encrypt(sub: Sub, plain: Uint8Array, salt: Buffer = crypto.randomBytes(16), as: crypto.ECDH = Push.ecdh()): Buffer {
    const ua_public = Buffer.from(sub.p256dh, "base64url");
    const as_public = as.getPublicKey();
    const secret = as.computeSecret(ua_public);
    const hmac = (key: Buffer, data: Buffer) => crypto.createHmac("sha256", key).update(data).digest();
    const prk_key = hmac(Buffer.from(sub.auth, "base64url"), secret);
    const key_info = Buffer.concat([Buffer.from("WebPush: info\0"), ua_public, as_public]);
    const ikm = hmac(prk_key, Buffer.concat([key_info, Buffer.from([1])]));
    const prk = hmac(salt, ikm);
    const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
    const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
    const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
    const record = Buffer.concat([cipher.update(Buffer.concat([plain, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
    const rs = Buffer.alloc(4);
    rs.writeUInt32BE(RS);
    return Buffer.concat([salt, rs, Buffer.from([as_public.length]), as_public, record]);
  }

  export function ecdh(): crypto.ECDH {
    const ecdh = crypto.createECDH("prime256v1");
    ecdh.generateKeys();
    return ecdh;
  }

  // Sending
  // -------

  // a request's Authorization (RFC 8292): a token for the endpoint's
  // origin, signed with the server's key, and that key
  export function vapid(endpoint: string, keys: Keys, now: number = Date.now()): string {
    const key = crypto.createPrivateKey({ key: keys.jwk, format: "jwk" });
    const b64 = (obj: object) => Buffer.from(JSON.stringify(obj)).toString("base64url");
    const claims = { aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + AGE, sub: Push.subject() };
    const head = b64({ typ: "JWT", alg: "ES256" }) + "." + b64(claims);
    const sig = crypto.sign("sha256", Buffer.from(head), { key, dsaEncoding: "ieee-p1363" });
    return "vapid t=" + head + "." + sig.toString("base64url") + ", k=" + keys.public;
  }

  // who a push service may write to about this server's pushes: its
  // site, if https, else its sign-in mail's sender
  export function subject(): string {
    return config.SITE.startsWith("https:") ? config.SITE : "mailto:noreply@" + new URL(config.SITE).hostname;
  }

  // a message to a browser: the push service's answer's status (201:
  // taken; 404, 410: the subscription is gone), 0 if none came or push is
  // off. The answer's body is never read: the status says all
  export async function send(sub: Sub, text: string): Promise<number> {
    const keys = Push.keys();
    if (keys === null) {
      return 0;
    }
    try {
      // checked again here: a name may resolve elsewhere since it was taken
      if (await Push.inside(sub.endpoint)) {
        throw new Error("inside the server's network, not sent");
      }
      const headers = {
        authorization      : Push.vapid(sub.endpoint, keys),
        "content-encoding" : "aes128gcm",
        "content-type"     : "application/octet-stream",
        ttl                : String(TTL),
        urgency            : "normal",
      };
      const body = new Uint8Array(Push.encrypt(sub, Buffer.from(text)));
      const res = await fetch(sub.endpoint, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(ANSWER) });
      await res.body?.cancel().catch(() => null);
      return res.status;
    } catch (err: any) {
      console.error("web push: " + new URL(sub.endpoint).host + ": " + (err?.message ?? err));
      return 0;
    }
  }

}
