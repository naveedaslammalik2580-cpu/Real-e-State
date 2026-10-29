// email-unsubscribe + the unsubscribe link on every automated email.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  automationScenario, mockFetch, workerRequest, WORKER_ENV, OWNER, CONTACT, CONTACT_EMAIL,
} from "../helpers/automation-fixture.mjs";

const SECRET = WORKER_ENV.UNSUBSCRIBE_SIGNING_SECRET;
const tokens = await import(new URL("../../supabase/functions/_shared/unsubscribe-token.ts", import.meta.url).href);
const FN_URL = "https://unit-test.supabase.co/functions/v1/email-unsubscribe";

let handler;
beforeEach(async () => {
  globalThis.__edge.setEnv(WORKER_ENV);
  handler = await globalThis.__edge.load("email-unsubscribe");
});

function world() {
  const s = automationScenario();
  const messageId = randomUUID();
  s.db.seed("outbound_messages", [{
    id: messageId, user_id: OWNER, contact_id: CONTACT, recipient: CONTACT_EMAIL, status: "sent", message_kind: "automation",
  }]);
  s.db.install();
  return { ...s, messageId };
}
const nowS = () => Math.floor(Date.now() / 1000);
const makeToken = (messageId, contactId = CONTACT, exp = nowS() + 3600, secret = SECRET) =>
  tokens.createUnsubscribeToken(secret, { messageId, contactId, expiresAtSeconds: exp });

// ------------------------------------------------------------ token module

test("token: round trip; contains no email, owner id or raw contact id", async () => {
  const m = randomUUID();
  const t = await makeToken(m);
  assert.ok(t.length < 300);
  const v = await tokens.verifyUnsubscribeToken(SECRET, t);
  assert.equal(v.ok, true);
  assert.equal(v.messageId, m);
  const decoded = Buffer.from(t.split(".")[1], "base64url").toString();
  assert.doesNotMatch(decoded, new RegExp(CONTACT));
  assert.doesNotMatch(decoded, /@/);
  assert.doesNotMatch(decoded, new RegExp(OWNER));
});

test("token: tampered, expired, wrong secret, wrong shape all fail the same way", async () => {
  const m = randomUUID();
  const good = await makeToken(m);
  const [v, payload, sig] = good.split(".");
  const other = Buffer.from(JSON.stringify({ p: "unsub", m: randomUUID(), c: "x", e: nowS() + 999 })).toString("base64url");
  const flip = (s) => (s[0] === "A" ? "B" : "A") + s.slice(1);
  const bad = [
    `${v}.${other}.${sig}`, // swapped payload
    `${v}.${payload}.${flip(sig)}`, // tampered signature
    `${v}.${flip(payload)}.${sig}`,
    `u2.${payload}.${sig}`,
    `${payload}.${sig}`,
    await makeToken(m, CONTACT, nowS() - 1), // expired
    await makeToken(m, CONTACT, nowS() + 60, "a-completely-different-secret-value-0123456789"),
    "", "u1..", "x".repeat(600), null, 42,
  ];
  for (const t of bad) assert.deepEqual(await tokens.verifyUnsubscribeToken(SECRET, t), { ok: false }, String(t).slice(0, 40));
  assert.deepEqual(await tokens.verifyUnsubscribeToken("short", good), { ok: false }, "unusable secret");
});

test("token: deterministic for the same message, contact and expiry", async () => {
  const m = randomUUID();
  const exp = nowS() + 1000;
  assert.equal(await makeToken(m, CONTACT, exp), await makeToken(m, CONTACT, exp));
});

// ------------------------------------------------------------ GET

test("GET with a valid token shows a confirmation page and does NOT unsubscribe or touch the database", async () => {
  const w = world();
  const t = await makeToken(w.messageId);
  const res = await handler(new Request(`${FN_URL}?t=${encodeURIComponent(t)}`));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<form method="post"/);
  assert.doesNotMatch(html, /<script/i);
  assert.match(res.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal(w.db.calls.length, 0, "GET makes zero database calls");
  assert.equal(w.db.table("email_suppressions").length, 0);
});

test("GET with invalid / expired / tampered tokens: identical generic page, nothing reflected", async () => {
  const w = world();
  const expired = await makeToken(w.messageId, CONTACT, nowS() - 5);
  const good = await makeToken(w.messageId);
  const tampered = good.slice(0, -2) + (good.endsWith("A") ? "BB" : "AA");
  const hostile = `"><script>alert(1)</script>`;
  const bodies = [];
  for (const t of [expired, tampered, hostile, ""]) {
    const res = await handler(new Request(`${FN_URL}?t=${encodeURIComponent(t)}`));
    assert.equal(res.status, 400);
    bodies.push(await res.text());
  }
  assert.ok(bodies.every((b) => b === bodies[0]), "no difference between failure kinds");
  assert.doesNotMatch(bodies[0], /script>alert/);
  assert.equal(w.db.calls.length, 0);
});

// ------------------------------------------------------------ POST

async function post(query, body, contentType) {
  return await handler(new Request(`${FN_URL}${query}`, { method: "POST", headers: { "content-type": contentType }, body }));
}

test("POST from the confirmation form unsubscribes through the single entry point", async () => {
  const w = world();
  const t = await makeToken(w.messageId);
  const res = await post(`?t=${encodeURIComponent(t)}`, "confirm=1", "application/x-www-form-urlencoded");
  assert.equal(res.status, 200);
  assert.match(await res.text(), /You are unsubscribed/);
  const call = w.db.rpcCalls("realtoros_record_contact_stop_event")[0];
  assert.equal(call.args.p_event_type, "unsubscribe");
  assert.equal(call.args.p_source, "unsubscribe_link");
  assert.equal(call.args.p_event_ref, `unsub:${w.messageId}`);
  assert.equal(call.args.p_user_id, OWNER);
  assert.equal(w.db.table("communication_consents")[0].status, "opted_out");
  assert.equal(w.db.table("email_suppressions")[0].reason, "unsubscribe");
});

test("RFC 8058 one-click POST (urlencoded and multipart) unsubscribes", async () => {
  for (const [body, type] of [
    ["List-Unsubscribe=One-Click", "application/x-www-form-urlencoded"],
    ["--b\r\nContent-Disposition: form-data; name=\"List-Unsubscribe\"\r\n\r\nOne-Click\r\n--b--\r\n", "multipart/form-data; boundary=b"],
  ]) {
    const w = world();
    const t = await makeToken(w.messageId);
    const res = await post(`?t=${encodeURIComponent(t)}`, body, type);
    assert.equal(res.status, 200);
    assert.equal(w.db.table("email_suppressions").length, 1);
  }
});

test("POST JSON {token} (static page) unsubscribes and answers with JSON + CORS", async () => {
  const w = world();
  const t = await makeToken(w.messageId);
  const res = await post("", JSON.stringify({ token: t }), "application/json");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.equal(w.db.table("contacts")[0].unsubscribe_detected_at !== null, true);
});

test("repeat clicks are harmless: one suppression, one ledger entry, still a success page", async () => {
  const w = world();
  const t = await makeToken(w.messageId);
  for (let i = 0; i < 3; i++) {
    const res = await post(`?t=${encodeURIComponent(t)}`, "List-Unsubscribe=One-Click", "application/x-www-form-urlencoded");
    assert.equal(res.status, 200);
  }
  assert.equal(w.db.table("email_suppressions").length, 1);
  assert.equal(w.db.table("contact_stop_events").length, 1);
  assert.equal(w.db.table("activities").filter((a) => a.id.startsWith("automation-stop-")).length, 1);
});

test("POST with invalid, expired or cross-contact tokens: rejected, nothing written, no detail leaked", async () => {
  const w = world();
  const cases = [
    await makeToken(w.messageId, CONTACT, nowS() - 1),
    await makeToken(w.messageId, "some-other-contact"), // valid signature, wrong contact for this message
    await makeToken(randomUUID()), // unknown message
    "u1.garbage.garbage",
  ];
  const bodies = [];
  for (const t of cases) {
    const res = await post("", JSON.stringify({ token: t }), "application/json");
    assert.equal(res.status, 400);
    bodies.push(await res.text());
  }
  assert.ok(bodies.every((b) => b === bodies[0]));
  assert.equal(w.db.rpcCalls("realtoros_record_contact_stop_event").length, 0);
  assert.equal(w.db.table("email_suppressions").length, 0);
});

test("stop could not take its lock -> bounded retries then 'try again' (503)", async () => {
  const w = world();
  w.db.contactLockBusy = true;
  const t = await makeToken(w.messageId);
  const res = await post("", JSON.stringify({ token: t }), "application/json");
  assert.equal(res.status, 503);
  assert.equal(w.db.rpcCalls("realtoros_record_contact_stop_event").length, 3);
});

test("missing signing secret: every link is treated as invalid", async () => {
  const w = world();
  const t = await makeToken(w.messageId);
  globalThis.__edge.setEnv({ ...WORKER_ENV, UNSUBSCRIBE_SIGNING_SECRET: "" });
  const res = await post("", JSON.stringify({ token: t }), "application/json");
  assert.equal(res.status, 400);
  assert.equal(w.db.calls.length, 0);
});

test("oversized body and other methods are refused", async () => {
  world();
  assert.equal((await post("", "x".repeat(5000), "application/json")).status, 400);
  assert.equal((await handler(new Request(FN_URL, { method: "PUT" }))).status, 405);
});

// ------------------------------------------------------------ worker side

test("every automated email carries List-Unsubscribe headers and the fixed footer; the link works", async () => {
  const fetchMock = mockFetch();
  try {
    const worker = await globalThis.__edge.load("process-automation");
    const s = automationScenario();
    s.db.install();
    await worker(workerRequest());
    const call = fetchMock.calls.find((c) => c.url.includes("api.resend.com/emails"));
    const h = call.body.headers;
    assert.equal(h["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
    const url = /^<(https:\/\/unit-test\.supabase\.co\/functions\/v1\/email-unsubscribe\?t=[^>]+)>$/.exec(h["List-Unsubscribe"]);
    assert.ok(url, h["List-Unsubscribe"]);
    assert.match(call.body.text, /\n--\nDon't want these emails\? Unsubscribe here: https:\/\//);
    assert.ok(call.body.text.includes(url[1]), "footer links to the same token when no page URL is set");
    const token = new URL(url[1]).searchParams.get("t");
    const v = await tokens.verifyUnsubscribeToken(SECRET, token);
    assert.equal(v.ok, true);
    assert.equal(v.messageId, s.db.table("outbound_messages")[0].id);
    assert.doesNotMatch(JSON.stringify(s.db.table("outbound_messages")), /u1\./, "token is never stored");
  } finally {
    fetchMock.restore();
  }
});

test("UNSUBSCRIBE_PAGE_URL: footer points at the static page with the token in the #fragment", async () => {
  const fetchMock = mockFetch();
  try {
    globalThis.__edge.setEnv({ ...WORKER_ENV, UNSUBSCRIBE_PAGE_URL: "https://app.example.com/unsubscribe.html" });
    const worker = await globalThis.__edge.load("process-automation");
    const s = automationScenario();
    s.db.install();
    await worker(workerRequest());
    const body = fetchMock.calls[0].body;
    assert.match(body.text, /Unsubscribe here: https:\/\/app\.example\.com\/unsubscribe\.html#t=u1\./);
    assert.match(body.headers["List-Unsubscribe"], /^<https:\/\/unit-test\.supabase\.co\/functions\/v1\/email-unsubscribe\?t=/);
  } finally {
    fetchMock.restore();
  }
});

test("retries of one send produce a byte-identical provider body (same idempotency key)", async () => {
  let n = 0;
  const fetchMock = mockFetch(() => (++n === 1 ? new Response("{}", { status: 503 }) : new Response(JSON.stringify({ id: "re_ok" }), { status: 200 })));
  try {
    const worker = await globalThis.__edge.load("process-automation");
    const s = automationScenario();
    s.db.install();
    await worker(workerRequest());
    s.db.table("automation_jobs")[0].scheduled_at = "2026-09-01T00:00:00Z";
    await worker(workerRequest());
    assert.equal(fetchMock.calls.length, 2);
    assert.equal(fetchMock.calls[0].init.body, fetchMock.calls[1].init.body);
    assert.equal(fetchMock.calls[0].init.headers["Idempotency-Key"], fetchMock.calls[1].init.headers["Idempotency-Key"]);
  } finally {
    fetchMock.restore();
  }
});

test("no signing secret configured -> worker sends nothing and retries later", async () => {
  const fetchMock = mockFetch();
  try {
    globalThis.__edge.setEnv({ ...WORKER_ENV, UNSUBSCRIBE_SIGNING_SECRET: "" });
    const worker = await globalThis.__edge.load("process-automation");
    const s = automationScenario();
    s.db.install();
    await worker(workerRequest());
    assert.equal(fetchMock.calls.length, 0);
    const j = s.db.table("automation_jobs")[0];
    assert.equal(j.status, "pending");
    assert.equal(j.last_error_code, "unsubscribe_not_configured");
  } finally {
    fetchMock.restore();
  }
});

// Fix 1: any database error -> "Something went wrong, please try again";
// never claims the person was unsubscribed.
const LOCK_TIMEOUT = { code: "55P03", message: "canceling statement due to lock timeout" };

for (const [label, after] of [["on the first attempt", 0], ["after a retry outcome", 1]]) {
  test(`stop RPC raises ${label} -> try-again page, never 'unsubscribed'`, async () => {
    const w = world();
    let calls = 0;
    const real = w.db.rpcs.get("realtoros_record_contact_stop_event");
    w.db.rpc("realtoros_record_contact_stop_event", (a, db) => {
      calls++;
      if (calls <= after) return { outcome: "retry", recorded: false };
      return { data: null, error: LOCK_TIMEOUT };
    });
    const t = await makeToken(w.messageId);
    const res = await post(`?t=${encodeURIComponent(t)}`, "List-Unsubscribe=One-Click", "application/x-www-form-urlencoded");
    assert.equal(res.status, 503);
    const html = await res.text();
    assert.match(html, /Something went wrong/);
    assert.match(html, /Please try again/);
    assert.doesNotMatch(html, /unsubscribed/i);
    w.db.rpc("realtoros_record_contact_stop_event", real);
  });
}

test("stop RPC raises (JSON / static page) -> 503 try_again, not ok", async () => {
  const w = world();
  w.db.failWhen((e) => e.kind === "rpc" && e.name === "realtoros_record_contact_stop_event", LOCK_TIMEOUT);
  const t = await makeToken(w.messageId);
  const res = await post("", JSON.stringify({ token: t }), "application/json");
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "try_again" });
});

test("message lookup fails -> try-again page, never 'unsubscribed'", async () => {
  const w = world();
  w.db.failWhen((e) => e.kind === "table" && e.table === "outbound_messages", LOCK_TIMEOUT);
  const t = await makeToken(w.messageId);
  const res = await post(`?t=${encodeURIComponent(t)}`, "confirm=1", "application/x-www-form-urlencoded");
  assert.equal(res.status, 503);
  assert.doesNotMatch(await res.text(), /unsubscribed/i);
});

// Fix 2: an expired link never dead-ends — and the page cannot be used to
// tell an expired genuine link from a forged one.
const EXPIRED_TEXT = "To stop receiving these emails, reply to any of them with the word &#39;unsubscribe&#39;.";

test("expired link (older than 180 days): plain 'expired' page with a way out, on GET, form POST and one-click", async () => {
  const w = world();
  const sentLongAgo = nowS() - 200 * 24 * 60 * 60;
  const expired = await makeToken(w.messageId, CONTACT, sentLongAgo + 180 * 24 * 60 * 60);
  const tamperedValid = (await makeToken(w.messageId)).slice(0, -3) + "AAA";
  const pages = [];
  for (const [method, body, type] of [
    ["GET", null, null],
    ["POST", "confirm=1", "application/x-www-form-urlencoded"],
    ["POST", "List-Unsubscribe=One-Click", "application/x-www-form-urlencoded"],
  ]) {
    for (const t of [expired, tamperedValid]) {
      const init = method === "GET" ? {} : { method, headers: { "content-type": type }, body };
      const res = await handler(new Request(`${FN_URL}?t=${encodeURIComponent(t)}`, init));
      assert.equal(res.status, 400);
      pages.push(await res.text());
    }
  }
  const html = pages[0];
  assert.match(html, /<h1>This unsubscribe link has expired<\/h1>/);
  assert.ok(html.includes(EXPIRED_TEXT), "tells the person how to stop the emails");
  assert.ok(pages.every((p) => p === html), "expired and forged links get byte-identical pages");
  for (const secretish of [expired, w.messageId, CONTACT, CONTACT_EMAIL, OWNER, "u1."]) {
    assert.ok(!html.includes(secretish), `page must not contain ${secretish.slice(0, 10)}…`);
  }
  assert.doesNotMatch(html, /valid|was ever|previous/i, "no hint about the link's history");
  assert.equal(w.db.rpcCalls("realtoros_record_contact_stop_event").length, 0);
  assert.equal(w.db.table("email_suppressions").length, 0);
});

test("expired link via the static page (JSON) -> 400 invalid_link; the page shows the same wording", async () => {
  const w = world();
  const expired = await makeToken(w.messageId, CONTACT, nowS() - 60);
  const res = await post("", JSON.stringify({ token: expired }), "application/json");
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: "invalid_link" });
  const fs = await import("node:fs");
  const staticPage = fs.readFileSync(new URL("../../app/unsubscribe.html", import.meta.url), "utf8");
  assert.ok(staticPage.includes("This unsubscribe link has expired"));
  assert.ok(staticPage.includes("To stop receiving these emails, reply to any of them with the word 'unsubscribe'."));
  assert.doesNotMatch(staticPage, /This link is not valid/);
});
