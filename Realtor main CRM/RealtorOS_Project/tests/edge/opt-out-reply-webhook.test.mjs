// Phase 4E.3: resend-webhook records an opt-out reply as an unsubscribe
// (source inbound_email), never also as a reply. Other replies unchanged.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { automationScenario, mockFetch, WORKER_ENV, OWNER, CONTACT, CONTACT_EMAIL } from "../helpers/automation-fixture.mjs";
import { signedWebhookRequest, WEBHOOK_SECRET } from "../helpers/svix.mjs";

const DOMAIN = "reply.example.com";
const TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const ENV = { ...WORKER_ENV, RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET, INBOUND_REPLY_DOMAIN: DOMAIN };
const LOCK_TIMEOUT = { code: "55P03", message: "canceling statement due to lock timeout" };

let handler;
let fetchMock;
beforeEach(async () => {
  globalThis.__edge.setEnv(ENV);
  handler = await globalThis.__edge.load("resend-webhook");
});
afterEach(() => fetchMock?.restore());

function world(opts = {}) {
  const s = automationScenario(opts);
  const messageId = randomUUID();
  s.db.unique("webhook_events", ["provider", "provider_event_id"]);
  s.db.seed("outbound_messages", [{
    id: messageId, user_id: OWNER, contact_id: CONTACT, recipient: CONTACT_EMAIL, provider: "resend",
    provider_message_id: "re_out_1", status: "delivered", message_kind: "automation",
    replied_at: null, unsubscribed_at: null, metadata: { reply_token: TOKEN },
  }]);
  s.db.install();
  return { ...s, messageId };
}

const received = (emailId = "in_email_1") => ({
  type: "email.received",
  created_at: "2026-09-29T12:00:00.000Z",
  data: { email_id: emailId, created_at: "2026-09-29T11:59:59.000Z", from: "lead.person@example.com", to: [`r-${TOKEN}@${DOMAIN}`], subject: "Re: Following up" },
});

function replyBody(text, { subject = "Re: Following up", headers = {}, html = null } = {}) {
  fetchMock = mockFetch((url) => url.includes("/emails/receiving/")
    ? new Response(JSON.stringify({ object: "email", headers, subject, from: "lead.person@example.com", text, html }), { status: 200 })
    : new Response("{}", { status: 404 }));
}

test("reply 'unsubscribe' -> unsubscribed (inbound_email), address blocked, pending follow-ups cancelled, NOT a reply", async () => {
  const w = world({ stopOnUnsubscribe: true });
  replyBody("Unsubscribe\n\nOn Mon, Sep 28, 2026 Agent <agent@example.org> wrote:\n> Hi Pat");
  const res = await handler(signedWebhookRequest(received()).request);
  assert.equal(res.status, 200);
  assert.match((await res.json()).inbound, /^opt_out /);
  const calls = w.db.rpcCalls("realtoros_record_contact_stop_event");
  assert.equal(calls.length, 1, "exactly one stop call");
  assert.equal(calls[0].args.p_event_type, "unsubscribe");
  assert.equal(calls[0].args.p_source, "inbound_email");
  assert.equal(calls[0].args.p_event_ref, "inbound:in_email_1");
  const c = w.db.table("contacts")[0];
  assert.ok(c.unsubscribe_detected_at);
  assert.equal(c.reply_detected_at, null, "not recorded as a reply");
  assert.equal(w.db.table("communication_consents")[0].status, "opted_out");
  assert.equal(w.db.table("email_suppressions")[0].reason, "unsubscribe");
  assert.equal(w.db.table("automation_jobs")[0].status, "cancelled");
  const msg = w.db.table("outbound_messages")[0];
  assert.equal(msg.status, "unsubscribed");
  assert.equal(msg.replied_at, null);
  assert.ok(msg.unsubscribed_at);
  assert.deepEqual(Object.keys(w.db.table("webhook_events")[0].payload).sort(), ["email_id", "type"], "no body or headers stored");
});

test("rule keeps running (stop_on_unsubscribe off): later email steps are skipped, not sent", async () => {
  const w = world({ stopOnUnsubscribe: false });
  replyBody("stop");
  await handler(signedWebhookRequest(received()).request);
  assert.equal(w.db.table("automation_enrollments")[0].status, "active");
  // The pre-send guard now blocks every email step for this contact.
  const { presendGuard } = await import("../helpers/automation-fixture.mjs");
  const job = w.db.table("automation_jobs")[0];
  Object.assign(job, { status: "processing", lock_token: "t" });
  assert.equal(presendGuard(w.db, { p_user_id: OWNER, p_job_id: job.id, p_lock_token: "t" }).action, "skip");
});

test("opt-out in the subject line counts too", async () => {
  const w = world();
  replyBody("", { subject: "Re: UNSUBSCRIBE" });
  await handler(signedWebhookRequest(received()).request);
  assert.equal(w.db.rpcCalls("realtoros_record_contact_stop_event")[0].args.p_event_type, "unsubscribe");
});

test("'yes I'm interested, stop by at 5' -> a normal reply only", async () => {
  const w = world({ stopOnReply: true });
  replyBody("yes I'm interested, stop by at 5");
  await handler(signedWebhookRequest(received()).request);
  const calls = w.db.rpcCalls("realtoros_record_contact_stop_event");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.p_event_type, "reply");
  assert.equal(w.db.table("email_suppressions").length, 0, "address not blocked");
  assert.equal(w.db.table("communication_consents").length, 0);
  assert.equal(w.db.table("outbound_messages")[0].status, "replied");
});

test("automatic reply whose body is 'stop' is still only an automatic reply", async () => {
  const w = world();
  replyBody("stop", { headers: { "auto-submitted": "auto-replied" } });
  const res = await handler(signedWebhookRequest(received()).request);
  assert.equal((await res.json()).inbound, "auto_reply");
  assert.equal(w.db.rpcCalls("realtoros_record_contact_stop_event").length, 0);
  assert.equal(w.db.table("email_suppressions").length, 0);
});

test("duplicate delivery of an opt-out reply is harmless", async () => {
  const w = world();
  replyBody("remove me");
  const first = signedWebhookRequest(received());
  assert.equal((await handler(first.request)).status, 200);
  const again = await handler(signedWebhookRequest(received(), { id: first.id }).request);
  assert.equal((await again.json()).status, "duplicate");
  // A second copy under a new webhook id but the same received email is
  // deduplicated by the stop ledger (same inbound:<id> reference).
  await handler(signedWebhookRequest(received()).request);
  assert.equal(w.db.table("contact_stop_events").length, 1);
  assert.equal(w.db.table("email_suppressions").length, 1);
  assert.equal(w.db.table("activities").filter((a) => a.id.startsWith("automation-stop-")).length, 1);
});

test("opt-out reply: stop RPC raises -> non-2xx, event retryable, nothing claimed", async () => {
  const w = world();
  replyBody("unsubscribe");
  w.db.failWhen((e) => e.kind === "rpc" && e.name === "realtoros_record_contact_stop_event", LOCK_TIMEOUT);
  const first = signedWebhookRequest(received());
  const res = await handler(first.request);
  assert.equal(res.status, 500);
  assert.equal(w.db.table("webhook_events")[0].status, "failed");
  assert.equal(w.db.table("outbound_messages")[0].status, "delivered");
  const again = await handler(signedWebhookRequest(received(), { id: first.id }).request);
  assert.equal(again.status, 200);
  assert.equal(w.db.table("email_suppressions").length, 1);
});

test("opt-out reply: persistent lock timeout ('retry') -> non-2xx", async () => {
  const w = world();
  replyBody("opt out");
  w.db.contactLockBusy = true;
  const res = await handler(signedWebhookRequest(received()).request);
  assert.equal(res.status, 500);
  assert.equal(w.db.table("webhook_events")[0].status, "failed");
});
