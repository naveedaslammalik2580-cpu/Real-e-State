// resend-webhook: complaints and hard bounces route through the single
// stop entry point with the webhook event id as the idempotency ref; soft
// bounces change nothing; Svix verification and webhook_events dedup stay
// as strict as before.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { automationScenario, OWNER, CONTACT, CONTACT_EMAIL, WORKER_ENV } from "../helpers/automation-fixture.mjs";
import { signedWebhookRequest, WEBHOOK_SECRET } from "../helpers/svix.mjs";

let handler;
beforeEach(async () => {
  globalThis.__edge.setEnv({ ...WORKER_ENV, RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET });
  handler = await globalThis.__edge.load("resend-webhook");
});

function world(opts = {}) {
  const s = automationScenario(opts);
  const messageId = randomUUID();
  s.db.unique("webhook_events", ["provider", "provider_event_id"]);
  s.db.seed("outbound_messages", [{
    id: messageId, user_id: OWNER, contact_id: opts.testSend ? null : CONTACT, recipient: CONTACT_EMAIL,
    provider: "resend", provider_message_id: "re_abc123", status: "sent", message_kind: opts.testSend ? "test" : "automation",
    sent_at: "2026-09-27T10:00:00Z",
  }]);
  s.db.install();
  return { ...s, messageId };
}

const event = (type, extra = {}) => ({ type, created_at: "2026-09-28T09:00:00.000Z", data: { email_id: "re_abc123", ...extra } });

test("complaint -> one stop through the entry point, keyed by the webhook event id", async () => {
  const w = world();
  const { id, request } = signedWebhookRequest(event("email.complained"));
  const res = await handler(request);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "processed");
  const calls = w.db.rpcCalls("realtoros_record_contact_stop_event");
  assert.equal(calls.length, 1);
  assert.deepEqual(
    { ...calls[0].args, p_occurred_at: undefined },
    { p_user_id: OWNER, p_contact_id: CONTACT, p_event_type: "complaint", p_source: "provider_webhook", p_event_ref: id, p_outbound_message_id: w.messageId, p_occurred_at: undefined },
  );
  assert.equal(calls[0].args.p_occurred_at, "2026-09-28T09:00:00.000Z");
  assert.equal(w.db.table("automation_enrollments")[0].status, "stopped");
  assert.equal(w.db.table("email_suppressions").length, 1);
  assert.equal(w.db.table("email_suppressions")[0].reason, "complaint");
  assert.equal(w.db.table("outbound_messages")[0].status, "complained");
  assert.equal(w.db.table("webhook_events")[0].status, "processed");
});

test("duplicate delivery of the same event -> single stop, single activity, single suppression", async () => {
  const w = world();
  const first = signedWebhookRequest(event("email.complained"));
  assert.equal((await handler(first.request)).status, 200);
  const replay = signedWebhookRequest(event("email.complained"), { id: first.id });
  const res = await handler(replay.request);
  assert.equal((await res.json()).status, "duplicate");
  assert.equal(w.db.rpcCalls("realtoros_record_contact_stop_event").length, 1);
  assert.equal(w.db.table("email_suppressions").length, 1);
  assert.equal(w.db.table("activities").filter((a) => a.id.startsWith("automation-stop-")).length, 1);
  assert.equal(w.db.table("contact_stop_events").length, 1);
});

test("a stop that could not take its locks -> 500, event left retryable; redelivery completes it", async () => {
  const w = world();
  w.db.contactLockBusy = true;
  const first = signedWebhookRequest(event("email.complained"));
  const res = await handler(first.request);
  assert.equal(res.status, 500);
  assert.equal(w.db.rpcCalls("realtoros_record_contact_stop_event").length, 2, "bounded inline retry");
  assert.equal(w.db.table("webhook_events")[0].status, "failed");
  assert.equal(w.db.table("automation_enrollments")[0].status, "active");

  w.db.contactLockBusy = false;
  const redelivery = signedWebhookRequest(event("email.complained"), { id: first.id });
  const res2 = await handler(redelivery.request);
  assert.equal(res2.status, 200);
  assert.equal(w.db.table("webhook_events")[0].status, "processed");
  assert.equal(w.db.table("automation_enrollments")[0].status, "stopped");
});

test("enrollment lock timeout inside the stop -> 500 (never a silent drop)", async () => {
  const w = world();
  w.db.lockBusy = new Set([w.enrollmentId]);
  const res = await handler(signedWebhookRequest(event("email.complained")).request);
  assert.equal(res.status, 500);
  assert.equal(w.db.table("automation_enrollments")[0].status, "active");
  assert.equal(w.db.table("contact_stop_events").length, 0, "no ledger row, so the retry runs in full");
});

test("hard bounce (Permanent) -> 'bounce' suppression, enrollment keeps running for non-email steps", async () => {
  const w = world();
  const res = await handler(signedWebhookRequest(event("email.bounced", { bounce: { type: "Permanent", subType: "General", message: "x" } })).request);
  assert.equal(res.status, 200);
  const call = w.db.rpcCalls("realtoros_record_contact_stop_event")[0];
  assert.equal(call.args.p_event_type, "hard_bounce");
  assert.equal(w.db.table("email_suppressions")[0].reason, "bounce");
  assert.equal(w.db.table("automation_enrollments")[0].status, "active");
  assert.equal(w.db.table("outbound_messages")[0].status, "bounced");
  assert.equal(w.db.table("webhook_events")[0].payload.bounce_type, "Permanent");
});

test("bounce with no bounce.type is treated as hard (Resend documents email.bounced as permanent)", async () => {
  const w = world();
  await handler(signedWebhookRequest(event("email.bounced")).request);
  assert.equal(w.db.rpcCalls("realtoros_record_contact_stop_event")[0].args.p_event_type, "hard_bounce");
});

for (const soft of ["Temporary", "Transient", "Undetermined"]) {
  test(`soft bounce (${soft}) -> nothing suppressed, nothing stopped, status unchanged`, async () => {
    const w = world();
    const res = await handler(signedWebhookRequest(event("email.bounced", { bounce: { type: soft } })).request);
    assert.equal(res.status, 200);
    assert.equal(w.db.rpcCalls("realtoros_record_contact_stop_event").length, 0);
    assert.equal(w.db.table("email_suppressions").length, 0);
    assert.equal(w.db.table("outbound_messages")[0].status, "sent");
    assert.equal(w.db.table("webhook_events")[0].status, "ignored");
  });
}

test("test send (no contact) complaint -> address suppressed, no stop call", async () => {
  const w = world({ testSend: true });
  const res = await handler(signedWebhookRequest(event("email.complained")).request);
  assert.equal(res.status, 200);
  assert.equal(w.db.rpcCalls("realtoros_record_contact_stop_event").length, 0);
  assert.equal(w.db.table("email_suppressions")[0].reason, "complaint");
});

test("delivery events do not stop anything", async () => {
  const w = world();
  for (const t of ["email.delivered", "email.opened", "email.clicked", "email.delivery_delayed"]) {
    await handler(signedWebhookRequest(event(t)).request);
  }
  assert.equal(w.db.rpcCalls("realtoros_record_contact_stop_event").length, 0);
  assert.equal(w.db.table("automation_enrollments")[0].status, "active");
});

test("email.replied / email.unsubscribed are not treated as real events (not in the provider's event list)", async () => {
  const w = world();
  for (const t of ["email.replied", "email.unsubscribed"]) {
    const res = await handler(signedWebhookRequest(event(t)).request);
    assert.equal((await res.json()).status, "ignored");
  }
  assert.equal(w.db.rpcCalls("realtoros_record_contact_stop_event").length, 0);
});

test("tampered, missing or stale signatures are rejected before any database access", async () => {
  const w = world();
  const tampered = signedWebhookRequest(event("email.complained"), { tamper: true });
  assert.equal((await handler(tampered.request)).status, 401);
  const stale = signedWebhookRequest(event("email.complained"), { timestamp: Math.floor(Date.now() / 1000) - 3600 });
  assert.equal((await handler(stale.request)).status, 401);
  const wrongKey = signedWebhookRequest(event("email.complained"), { secret: "whsec_" + Buffer.from("other").toString("base64") });
  assert.equal((await handler(wrongKey.request)).status, 401);
  const unsigned = new Request("https://x/functions/v1/resend-webhook", { method: "POST", body: "{}" });
  assert.equal((await handler(unsigned)).status, 401);
  assert.equal(w.db.calls.length, 0, "no database call of any kind");
});

// Fix 1: the stop RPC can RAISE (e.g. a lock timeout while writing consent /
// email-block / timeline rows) instead of returning outcome='retry'.
const LOCK_TIMEOUT = { code: "55P03", message: "canceling statement due to lock timeout" };

test("stop RPC raises an error -> non-2xx, event left retryable, redelivery completes it", async () => {
  const w = world();
  w.db.failWhen((e) => e.kind === "rpc" && e.name === "realtoros_record_contact_stop_event", LOCK_TIMEOUT);
  const first = signedWebhookRequest(event("email.complained"));
  const res = await handler(first.request);
  assert.equal(res.status, 500);
  assert.notEqual((await res.json()).status, "processed");
  assert.equal(w.db.table("webhook_events")[0].status, "failed");
  assert.equal(w.db.table("contact_stop_events").length, 0);

  const again = await handler(signedWebhookRequest(event("email.complained"), { id: first.id }).request);
  assert.equal(again.status, 200);
  assert.equal(w.db.table("webhook_events")[0].status, "processed");
  assert.equal(w.db.table("contact_stop_events").length, 1);
});

test("stop RPC raises on a hard bounce too -> non-2xx", async () => {
  const w = world();
  w.db.failWhen((e) => e.kind === "rpc" && e.name === "realtoros_record_contact_stop_event", LOCK_TIMEOUT);
  const res = await handler(signedWebhookRequest(event("email.bounced", { bounce: { type: "Permanent" } })).request);
  assert.equal(res.status, 500);
  assert.equal(w.db.table("email_suppressions").length, 0);
});
