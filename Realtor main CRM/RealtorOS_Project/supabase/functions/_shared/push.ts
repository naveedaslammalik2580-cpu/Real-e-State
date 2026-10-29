/* ============================================================
   push.ts — Web Push, written against WebCrypto and nothing else.

   WHY NOT A LIBRARY. The offline test suite refuses every remote import
   except the Supabase client (tests/helpers/hooks.mjs throws on npm:,
   jsr: and https:), deliberately, so no test can reach the network. A
   push library imported from a registry would therefore be either
   untestable here or replaced by a stub, and a stub proves nothing about
   the bytes that reach Google's servers. Everything below is two RFCs
   and the WebCrypto that both Deno and Node already have:

     * RFC 8291 - Message Encryption for Web Push (aes128gcm)
     * RFC 8292 - VAPID, the ES256 JWT that identifies the sender

   so the encryption is tested for real, by decrypting it again with a
   key pair the test generated.

   WHAT TRAVELS. { title, body, url } and nothing else. url is the
   notification's own link_route - an internal app route, never a URL -
   and title and body are the two lines the database already refuses to
   store an email address in. No contact id, no address, no phone
   number: a push payload is stored on somebody else's server until the
   device collects it.
   ============================================================ */

export interface PushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushPayload {
  title: string;
  body: string;
  url: string | null;
}

export interface VapidKeys {
  publicKey: string;    // base64url, uncompressed P-256 point (65 bytes)
  privateKey: string;   // base64url, the raw 32-byte scalar
  subject: string;      // mailto: or https:
}

export interface PushResult {
  ok: boolean;
  status: number;
  /** 404/410: this endpoint is gone for good and must be deleted. */
  dead: boolean;
}

const encoder = new TextEncoder();

/* ---------- base64url, both ways ---------- */

export function b64urlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/")
    + "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function bytesToB64url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/* ---------- HKDF (RFC 5869), as extract and expand ----------
 * Written out rather than using deriveBits("HKDF"), because RFC 8291
 * needs the two halves separately: the first extract is keyed with the
 * subscription's auth secret, the second with a fresh salt.
 */

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    "raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

const hkdfExtract = (salt: Uint8Array, ikm: Uint8Array) => hmac(salt, ikm);

async function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  // Every length used here is <= 32, so one round is always enough.
  const block = await hmac(prk, concat(info, new Uint8Array([1])));
  return block.subarray(0, length);
}

/* ---------- RFC 8291: encrypting the payload ---------- */

/**
 * Returns the aes128gcm body exactly as it goes on the wire:
 *   salt(16) | record size(4) | key id length(1) | server public key(65) | ciphertext
 */
export async function encryptPayload(
  subscription: PushSubscription,
  plaintext: string,
  options: { salt?: Uint8Array; serverKeys?: CryptoKeyPair } = {},
): Promise<Uint8Array> {
  const uaPublic = b64urlToBytes(subscription.p256dh);
  const authSecret = b64urlToBytes(subscription.auth);

  const serverKeys = options.serverKeys ?? await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  const serverPublic = new Uint8Array(
    await crypto.subtle.exportKey("raw", serverKeys.publicKey));

  const uaKey = await crypto.subtle.importKey(
    "raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: uaKey }, serverKeys.privateKey, 256));

  // The input keying material is bound to BOTH public keys, which is what
  // stops a shared secret being reused for a different device.
  const prkKey = await hkdfExtract(authSecret, shared);
  const keyInfo = concat(encoder.encode("WebPush: info\0"), uaPublic, serverPublic);
  const ikm = await hkdfExpand(prkKey, keyInfo, 32);

  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const prk = await hkdfExtract(salt, ikm);
  const cek = await hkdfExpand(prk, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdfExpand(prk, encoder.encode("Content-Encoding: nonce\0"), 12);

  const key = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  // 0x02 is the single-record padding delimiter: this is the last (and
  // only) record.
  const padded = concat(encoder.encode(plaintext), new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce }, key, padded));

  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096, false);   // record size
  header[20] = serverPublic.length;                          // key id length: 65
  return concat(header, serverPublic, ciphertext);
}

/* ---------- RFC 8292: the VAPID header ---------- */

async function importVapidPrivateKey(keys: VapidKeys): Promise<CryptoKey> {
  const pub = b64urlToBytes(keys.publicKey);
  if (pub.length !== 65 || pub[0] !== 4) {
    throw new Error("vapid_public_key_malformed");
  }
  // WebCrypto will not take a bare scalar, so the private key goes in as
  // a JWK with the coordinates read off the public point.
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    d: keys.privateKey.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"),
    x: bytesToB64url(pub.subarray(1, 33)),
    y: bytesToB64url(pub.subarray(33, 65)),
    ext: true,
  };
  return await crypto.subtle.importKey(
    "jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

/**
 * `vapid t=<jwt>, k=<public key>`. The audience is the push service's
 * origin, not the endpoint: signing for the whole endpoint would make
 * the token a bearer token for one device.
 */
export async function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const audience = new URL(endpoint).origin;
  const header = bytesToB64url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = bytesToB64url(encoder.encode(JSON.stringify({
    aud: audience,
    // Twelve hours. The spec's ceiling is 24; half of it means a clock a
    // few hours out is still inside the window.
    exp: nowSeconds + 12 * 60 * 60,
    sub: keys.subject,
  })));
  const signingInput = encoder.encode(header + "." + claims);
  const key = await importVapidPrivateKey(keys);
  // WebCrypto's ECDSA signature is already the raw r||s that JWS wants.
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, key, signingInput));
  const jwt = header + "." + claims + "." + bytesToB64url(signature);
  return `vapid t=${jwt}, k=${keys.publicKey}`;
}

/* ---------- Reading the keys out of the environment ---------- */

/**
 * The three secrets, or null when any is missing. Null is a normal
 * state, not an error: the app ships before the keys exist, and the
 * worker simply skips the push step until they do.
 */
export function vapidFromEnv(getEnv: (name: string) => string | undefined): VapidKeys | null {
  const publicKey = (getEnv("VAPID_PUBLIC_KEY") || "").trim();
  const privateKey = (getEnv("VAPID_PRIVATE_KEY") || "").trim();
  const subject = (getEnv("VAPID_SUBJECT") || "").trim();
  if (!publicKey || !privateKey || !subject) return null;
  // A subject that is not a contact address makes some push services
  // reject every request, which is a confusing way to find out.
  if (!/^(mailto:|https:\/\/)/.test(subject)) return null;
  return { publicKey, privateKey, subject };
}

/* ---------- Sending ---------- */

/** The payload, and only ever these three fields. */
export function buildPayload(notification: {
  title?: unknown;
  body?: unknown;
  url?: unknown;
}): PushPayload {
  const text = (v: unknown, max: number) =>
    typeof v === "string" ? v.slice(0, max) : "";
  const url = typeof notification.url === "string" && notification.url.startsWith("/")
    ? notification.url
    : null;
  return { title: text(notification.title, 200), body: text(notification.body, 400), url };
}

/**
 * One POST to one push service. Never throws for a refusal - a refusal
 * is an answer, and the caller decides what it means.
 */
export async function sendPush(
  subscription: PushSubscription,
  payload: PushPayload,
  keys: VapidKeys,
  options: { ttlSeconds?: number; fetchImpl?: typeof fetch } = {},
): Promise<PushResult> {
  const doFetch = options.fetchImpl ?? fetch;
  let body: Uint8Array;
  let authorization: string;
  try {
    body = await encryptPayload(subscription, JSON.stringify(payload));
    authorization = await vapidAuthorization(subscription.endpoint, keys);
  } catch {
    // A malformed key is this device's problem, not the batch's. Reported
    // as a plain failure with no detail: the message could quote a key.
    return { ok: false, status: 0, dead: false };
  }

  let response: Response;
  try {
    response = await doFetch(subscription.endpoint, {
      method: "POST",
      headers: {
        "Authorization": authorization,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        // A day: long enough that a phone switched off overnight still
        // gets it, short enough that nothing arrives stale.
        "TTL": String(options.ttlSeconds ?? 86400),
        "Urgency": "normal",
      },
      body,
    });
  } catch {
    return { ok: false, status: 0, dead: false };
  }

  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    // The two the specs reserve for "this subscription no longer exists".
    dead: response.status === 404 || response.status === 410,
  };
}
