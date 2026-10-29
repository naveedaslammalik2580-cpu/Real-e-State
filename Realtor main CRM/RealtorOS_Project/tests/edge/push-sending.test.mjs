// Phase 3B, the sending half.
//
// The encryption is written out in _shared/push.ts rather than imported
// from a registry, because this suite refuses remote imports so that no
// test can reach the network. That trade is only honest if the crypto is
// actually tested, so the first test here generates a subscriber key
// pair, has push.ts encrypt to it, and decrypts the result back - if the
// bytes were wrong in any way, the payload would not come out again.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, webcrypto } from "node:crypto";
import {
  automationScenario, mockFetch, workerRequest, WORKER_ENV,
} from "../helpers/automation-fixture.mjs";

const push = await import("../../supabase/functions/_shared/push.ts");

const subtle = webcrypto.subtle;
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");

// A real VAPID pair, generated here so nothing secret lives in the repo.
async function vapidKeys() {
  const pair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  const jwk = await subtle.exportKey("jwk", pair.privateKey);
  return {
    keys: { publicKey: b64url(raw), privateKey: jwk.d, subject: "mailto:ops@example.com" },
    publicCryptoKey: pair.publicKey,
  };
}

// A browser's subscription, with the private half kept so the test can
// decrypt what was sent to it.
async function subscriber(endpoint = "https://fcm.googleapis.com/fcm/send/" + randomUUID()) {
  const pair = await subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const pub = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  const auth = webcrypto.getRandomValues(new Uint8Array(16));
  return {
    subscription: { endpoint, p256dh: b64url(pub), auth: b64url(auth) },
    privateKey: pair.privateKey,
    publicRaw: pub,
    authSecret: auth,
  };
}

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

async function hmac(key, data) {
  const k = await subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await subtle.sign("HMAC", k, data));
}
async function expand(prk, info, length) {
  const block = await hmac(prk, concat(new TextEncoder().encode(info), new Uint8Array([1])));
  return block.subarray(0, length);
}

/** RFC 8291 in reverse, which is the only way to prove it was done right. */
async function decrypt(body, sub) {
  const salt = body.subarray(0, 16);
  const keyIdLength = body[20];
  const serverPublic = body.subarray(21, 21 + keyIdLength);
  const ciphertext = body.subarray(21 + keyIdLength);

  const serverKey = await subtle.importKey(
    "raw", serverPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits(
    { name: "ECDH", public: serverKey }, sub.privateKey, 256));

  const prkKey = await hmac(sub.authSecret, shared);
  const keyInfo = concat(new TextEncoder().encode("WebPush: info\0"), sub.publicRaw, serverPublic);
  const ikm = await expand(prkKey, "", 32).then(() => hmac(prkKey, concat(keyInfo, new Uint8Array([1]))))
    .then((b) => b.subarray(0, 32));

  const prk = await hmac(salt, ikm);
  const cek = await expand(prk, "Content-Encoding: aes128gcm\0", 16);
  const nonce = await expand(prk, "Content-Encoding: nonce\0", 12);

  const key = await subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["decrypt"]);
  const plain = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext));
  // Strip the 0x02 single-record padding delimiter.
  return new TextDecoder().decode(plain.subarray(0, plain.length - 1));
}

// ---------------------------------------------------------------- crypto

test("the encrypted payload decrypts back, and the VAPID header verifies", async () => {
  const sub = await subscriber();
  const { keys, publicCryptoKey } = await vapidKeys();
  const payload = { title: "A lead replied", body: "Have a look", url: "/contacts/ct_1" };

  const body = await push.encryptPayload(sub.subscription, JSON.stringify(payload));
  // The header the spec requires, byte for byte.
  assert.equal(body[20], 65, "the key id length is the uncompressed point length");
  assert.equal(new DataView(body.buffer, body.byteOffset).getUint32(16, false), 4096,
    "the record size field");
  assert.deepEqual(JSON.parse(await decrypt(body, sub)), payload,
    "and it comes back out again, which is the only proof that matters");

  // Two sends of the same payload must not produce the same bytes: the
  // salt and the ephemeral key are fresh each time.
  const again = await push.encryptPayload(sub.subscription, JSON.stringify(payload));
  assert.notDeepEqual([...body], [...again], "a fresh salt and key every time");

  // VAPID: a real ES256 JWT, audience = the push service's origin only.
  const header = await push.vapidAuthorization(sub.subscription.endpoint, keys, 1_760_000_000);
  const m = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.ok(m, "the header is in the RFC 8292 shape: " + header);
  assert.equal(m[2], keys.publicKey, "the public key travels with the token");

  const [h, c, sig] = m[1].split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString()), { typ: "JWT", alg: "ES256" });
  const claims = JSON.parse(Buffer.from(c, "base64url").toString());
  assert.equal(claims.aud, "https://fcm.googleapis.com",
    "the origin, not the endpoint - a token for the endpoint would be a bearer token for one device");
  assert.equal(claims.sub, "mailto:ops@example.com");
  assert.equal(claims.exp, 1_760_000_000 + 12 * 60 * 60);

  const verified = await subtle.verify(
    { name: "ECDSA", hash: "SHA-256" }, publicCryptoKey,
    Buffer.from(sig, "base64url"), Buffer.from(h + "." + c));
  assert.equal(verified, true, "signed with the private half of the key it advertises");
});

test("the payload carries three fields and no way to smuggle a fourth", () => {
  const built = push.buildPayload({
    title: "A lead replied",
    body: "Have a look",
    url: "/contacts/ct_1",
    // Everything the claim does not return, plus everything an attacker
    // or a careless caller might add.
    email: "sarah@example.com",
    phone: "+44 7700 900123",
    contact_id: "ct_1",
    id: "n_1",
  });
  assert.deepEqual(Object.keys(built).sort(), ["body", "title", "url"]);
  const json = JSON.stringify(built);
  assert.ok(!json.includes("@"), "no address of any kind: " + json);
  assert.ok(!json.includes("900123"));
  assert.ok(!json.includes("ct_1") || json.includes("/contacts/ct_1"),
    "the only id that travels is the one inside the app route");

  // An absolute URL is not a route, and is dropped rather than followed.
  assert.equal(push.buildPayload({ url: "https://evil.example/steal" }).url, null);
  assert.equal(push.buildPayload({ url: "/contacts" }).url, "/contacts");
  // Two lines, not an essay: a push payload has a size limit and these
  // come from a database that caps them anyway.
  assert.equal(push.buildPayload({ title: "x".repeat(500) }).title.length, 200);
});

test("missing or malformed VAPID configuration reads as 'not configured'", () => {
  const env = (values) => (name) => values[name];
  assert.equal(push.vapidFromEnv(env({})), null, "nothing set: push is simply off");
  assert.equal(push.vapidFromEnv(env({ VAPID_PUBLIC_KEY: "a", VAPID_PRIVATE_KEY: "b" })), null,
    "a subject is required");
  assert.equal(push.vapidFromEnv(env({
    VAPID_PUBLIC_KEY: "a", VAPID_PRIVATE_KEY: "b", VAPID_SUBJECT: "ops@example.com",
  })), null, "a bare address is not a subject - it has to be a mailto: or https: URI");
  assert.deepEqual(push.vapidFromEnv(env({
    VAPID_PUBLIC_KEY: " a ", VAPID_PRIVATE_KEY: "b ", VAPID_SUBJECT: "mailto:ops@example.com",
  })), { publicKey: "a", privateKey: "b", subject: "mailto:ops@example.com" });
});

// ---------------------------------------------------------------- the worker

let worker;
let fetchMock;
afterEach(() => { if (fetchMock) fetchMock.restore(); });

async function loadWorker(env) {
  globalThis.__edge.setEnv(env);
  worker = await globalThis.__edge.load("process-automation");
}

const quietScan = (s) => {
  s.db.rpc("realtoros_scan_time_triggers", () => ({ events_created: 0 }));
  s.db.rpc("realtoros_scan_follow_up_reminders", () => ({ untouched_notified: 0 }));
  return s;
};

async function run() {
  const res = await worker(workerRequest());
  assert.equal(res.status, 200);
  return (await res.json()).counters;
}

test("with no VAPID keys the push step is skipped without a sound", async () => {
  await loadWorker(WORKER_ENV);                    // no VAPID_* at all
  const s = quietScan(automationScenario());
  s.db.rpc("realtoros_claim_push_batch", () => ({ claimed: [], skipped: 0, deferred: 0 }));
  s.db.install();
  fetchMock = mockFetch();

  const counters = await run();
  assert.equal(s.db.rpcCalls("realtoros_claim_push_batch").length, 0,
    "it does not even ask for a batch - nothing to send it with");
  assert.equal(counters.pushStepFailed, 0, "and that is not a failure: the keys arrive at go-live");
  assert.equal(counters.pushSent, 0);
  assert.equal(fetchMock.calls.filter((c) => !c.url.includes("resend")).length, 0);
});

async function pushWorld(claimed, responder) {
  const { keys } = await vapidKeys();
  await loadWorker({
    ...WORKER_ENV,
    VAPID_PUBLIC_KEY: keys.publicKey,
    VAPID_PRIVATE_KEY: keys.privateKey,
    VAPID_SUBJECT: keys.subject,
  });
  const s = quietScan(automationScenario());
  s.db.rpc("realtoros_claim_push_batch", () => ({ claimed, skipped: 1, deferred: 0 }));
  s.db.rpc("realtoros_complete_push", () => ({ outcome: "sent" }));
  s.db.install();
  fetchMock = mockFetch(responder);
  return s;
}

test("a dead endpoint is reported for deletion, and one live device is a send", async () => {
  const live = await subscriber("https://fcm.googleapis.com/fcm/send/live");
  const gone = await subscriber("https://fcm.googleapis.com/fcm/send/gone");
  const id = randomUUID();

  const s = await pushWorld([{
    id,
    type: "hot_reply",
    title: "A lead replied",
    body: "Have a look",
    url: "/contacts/ct_1",
    subscriptions: [live.subscription, gone.subscription],
  }], (url) => new Response("", { status: url.endsWith("/gone") ? 410 : 201 }));

  const counters = await run();
  assert.equal(counters.pushSent, 1, "one device accepted, so the notification arrived");
  assert.equal(counters.pushSkipped, 1, "and the claim's own skip count is carried through");

  const posts = fetchMock.calls.filter((c) => c.url.includes("fcm.googleapis.com"));
  assert.equal(posts.length, 2, "both devices were tried");
  posts.forEach((p) => {
    assert.equal(p.init.method, "POST");
    assert.equal(p.init.headers["Content-Encoding"], "aes128gcm");
    assert.match(p.init.headers.Authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
    assert.equal(p.init.headers.TTL, "86400");
    // The body is ciphertext, so nothing legible can be in it.
    const raw = Buffer.from(p.init.body).toString("latin1");
    assert.ok(!raw.includes("A lead replied"), "the payload is encrypted, not plain");
  });

  const completed = s.db.rpcCalls("realtoros_complete_push");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].args.p_notification_id, id);
  assert.equal(completed[0].args.p_outcome, "sent");
  assert.deepEqual(completed[0].args.p_dead_endpoints, [gone.subscription.endpoint],
    "the 410 is handed back so the row can be deleted; the 201 is left alone");

  // And the one that worked really did get the payload.
  const livePost = posts.find((p) => p.url.endsWith("/live"));
  assert.deepEqual(
    JSON.parse(await decrypt(new Uint8Array(livePost.init.body), live)),
    { title: "A lead replied", body: "Have a look", url: "/contacts/ct_1" });
});

test("every device refusing is a failure, and a push failure never stops the run", async () => {
  const one = await subscriber("https://fcm.googleapis.com/fcm/send/refuses");
  const id = randomUUID();
  const s = await pushWorld([{
    id, type: "hot_reply", title: "t", body: "b", url: null,
    subscriptions: [one.subscription],
  }], () => new Response("", { status: 500 }));

  const counters = await run();
  assert.equal(counters.pushFailed, 1);
  assert.equal(counters.pushSent, 0);
  const completed = s.db.rpcCalls("realtoros_complete_push");
  assert.equal(completed[0].args.p_outcome, "failed");
  assert.equal(completed[0].args.p_dead_endpoints, null,
    "a 500 is not a dead device - it is a bad afternoon at Google");

  // The run itself is fine, and the rest of the worker still ran.
  assert.equal(counters.scanFailed, 0);
  assert.ok(s.db.rpcCalls("realtoros_claim_due_jobs").length >= 1,
    "mail already scheduled is claimed as usual");
});

test("a push step that throws is counted, not propagated", async () => {
  const { keys } = await vapidKeys();
  await loadWorker({
    ...WORKER_ENV,
    VAPID_PUBLIC_KEY: keys.publicKey,
    VAPID_PRIVATE_KEY: keys.privateKey,
    VAPID_SUBJECT: keys.subject,
  });
  const s = quietScan(automationScenario());
  s.db.rpc("realtoros_claim_push_batch", () => { throw new Error("database is having a moment"); });
  s.db.install();
  fetchMock = mockFetch();

  const counters = await run();
  assert.equal(counters.pushStepFailed, 1, "counted");
  assert.ok(s.db.rpcCalls("realtoros_claim_due_jobs").length >= 1,
    "and the queue carried on, which is the whole rule for this step");
});
