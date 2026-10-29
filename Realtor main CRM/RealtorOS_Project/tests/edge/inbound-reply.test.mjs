// Reply detection: opaque per-message Reply-To token, inbound
// email.received handling, and auto-reply filtering (rule-based).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { automationScenario, mockFetch, workerRequest, WORKER_ENV, OWNER, CONTACT, CONTACT_EMAIL } from "../helpers/automation-fixture.mjs";
import { signedWebhookRequest, WEBHOOK_SECRET } from "../helpers/svix.mjs";

const rd = await import(new URL("../../supabase/functions/_shared/reply-detection.ts", import.meta.url).href);
const DOMAIN = "reply.example.com";
const ENV = { ...WORKER_ENV, RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET, INBOUND_REPLY_DOMAIN: DOMAIN };
const TOKEN = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

let fetchMock;
beforeEach(() => { globalThis.__edge.setEnv(ENV); });
afterEach(() => fetchMock?.restore());

// ------------------------------------------------------------ helpers

test("reply token: deterministic 40-char lowercase hex, differs per message", async () => {
  const a = await rd.replyTokenFor(WORKER_ENV.UNSUBSCRIBE_SIGNING_SECRET, "key-1");
  assert.match(a, /^[0-9a-f]{40}$/);
  assert.equal(a, await rd.replyTokenFor(WORKER_ENV.UNSUBSCRIBE_SIGNING_SECRET, "key-1"));
  assert.notEqual(a, await rd.replyTokenFor(WORKER_ENV.UNSUBSCRIBE_SIGNING_SECRET, "key-2"));
});

test("findReplyToken: only our domain, tolerant of display names, case and +tags", () => {
  assert.equal(rd.findReplyToken([`Agent <R-${TOKEN.toUpperCase()}@Reply.Example.com>`], DOMAIN), TOKEN);
  assert.equal(rd.findReplyToken([`r-${TOKEN}+x@${DOMAIN}`], DOMAIN), TOKEN);
  assert.equal(rd.findReplyToken(["someone@else.com", `r-${TOKEN}@${DOMAIN}`], DOMAIN), TOKEN);
  assert.equal(rd.findReplyToken([`r-${TOKEN}@evil.example.com`], DOMAIN), null);
  assert.equal(rd.findReplyToken([`r-${TOKEN}@sub.${DOMAIN}`], DOMAIN), null);
  assert.equal(rd.findReplyToken(["r-short@" + DOMAIN, 42, null], DOMAIN), null);
  assert.equal(rd.normalizeInboundDomain(" Reply.Example.COM "), DOMAIN);
  assert.equal(rd.normalizeInboundDomain("not a domain"), null);
});

test("autoReplyReason: header and subject rules", () => {
  const cases = [
    [{ "Auto-Submitted": "auto-replied" }, "Re: hi", "a@b.com", "auto_submitted"],
    [{ "auto-submitted": "auto-generated" }, "Re: hi", "a@b.com", "auto_submitted"],
    [{ "x-autoreply": "yes" }, "Re: hi", "a@b.com", "x_autoreply"],
    [{ precedence: "bulk" }, "Re: hi", "a@b.com", "precedence"],
    [{ Precedence: "auto_reply" }, "Re: hi", "a@b.com", "precedence"],
    [{ "list-id": "<x.list>" }, "Re: hi", "a@b.com", "mailing_list"],
    [{}, "Re: hi", "MAILER-DAEMON@mx.example.com", "system_sender"],
    [{}, "Automatic reply: Following up", "a@b.com", "auto_subject"],
    [{}, "Out of Office: back Monday", "a@b.com", "auto_subject"],
    [null, "Undeliverable: Following up", "a@b.com", "auto_subject"],
  ];
  for (const [h, subj, from, want] of cases) assert.equal(rd.autoReplyReason(h, subj, from), want, JSON.stringify([h, subj]));
  assert.equal(rd.autoReplyReason({ "auto-submitted": "no" }, "Re: Following up", "Lead <lead@example.com>"), null);
  assert.equal(rd.autoReplyReason({ from: "x", "mime-version": "1.0" }, "Re: sounds good", "lead@example.com"), null);
});

// ------------------------------------------------------------ worker

test("worker: Reply-To = agent address + opaque reply address; token stored, never an id", async () => {
  fetchMock = mockFetch();
  const worker = await globalThis.__edge.load("process-automation");
  const s = automationScenario();
  s.db.install();
  await worker(workerRequest());
  const body = fetchMock.calls[0].body;
  assert.equal(body.reply_to.length, 2);
  assert.equal(body.reply_to[0], "agent@example.org");
  const m = /^r-([0-9a-f]{40})@reply\.example\.com$/.exec(body.reply_to[1]);
  assert.ok(m, body.reply_to[1]);
  const msg = s.db.table("outbound_messages")[0];
  assert.equal(msg.metadata.reply_token, m[1]);
  assert.ok(!body.reply_to[1].includes(msg.id.replaceAll("-", "")) && !body.reply_to[1].includes(CONTACT));
});

test("worker: without INBOUND_REPLY_DOMAIN only the agent address is used", async () => {
  globalThis.__edge.setEnv({ ...ENV, INBOUND_REPLY_DOMAIN: "" });
  fetchMock = mockFetch();
  const worker = await globalThis.__edge.load("process-automation");
  automationScenario().db.install();
  await worker(workerRequest());
  assert.deepEqual(fetchMock.calls[0].body.reply_to, ["agent@example.org"]);
});

// ------------------------------------------------------------ webhook

function world(opts = {}) {
  const s = automationScenario(opts);
  const messageId = randomUUID();
  s.db.unique("webhook_events", ["provider", "provider_event_id"]);
  s.db.seed("outbound_messages", [{
    id: messageId, user_id: OWNER, contact_id: CONTACT, recipient: CONTACT_EMAIL, provider: "resend",
    provider_message_id: "re_out_1", status: "delivered", message_kind: "automation", replied_at: null,
    metadata: { reply_token: TOKEN },
  }]);
  s.db.install();
  return { ...s, messageId };
}

const received = (to = [`r-${TOKEN}@${DOMAIN}`], extra = {}) => ({
  type: "email.received",
  created_at: "2026-09-28T12:00:00.000Z",
  data: { email_id: "in_email_1", created_at: "2026-09-28T11:59:59.000Z", from: "Lead <lead.person@example.com>", to, subject: "Re: Following up", ...extra },
});

function providerReturns(headers, subject = "Re: Following up") {
  fetchMock = mockFetch((url) => {
    if (url.includes("/emails/receiving/")) {
      return new Response(JSON.stringify({ object: "email", id: "in_email_1", headers, subject, from: "lead.person@example.com", text: "Yes, call me" }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  });
}

test("real reply -> recorded through the stop entry point (inbound_email), sequence stopped, message 'replied'", async () => {
  const handler = await globalThis.__edge.load("resend-webhook");
  const w = world({ stopOnReply: true });
  providerReturns({ from: "Lead <lead.person@example.com>", "mime-version": "1.0" });
  const res = await handler(signedWebhookRequest(received()).request);
  assert.equal(res.status, 200);
  assert.equal(fetchMock.calls[0].url, "https://api.resend.com/emails/receiving/in_email_1");
  const call = w.db.rpcCalls("realtoros_record_contact_stop_event")[0];
  assert.equal(call.args.p_event_type, "reply");
  assert.equal(call.args.p_source, "inbound_email");
  assert.equal(call.args.p_event_ref, "inbound:in_email_1");
  assert.equal(call.args.p_outbound_message_id, w.messageId);
  assert.equal(w.db.table("automation_enrollments")[0].status, "stopped");
  const msg = w.db.table("outbound_messages")[0];
  assert.equal(msg.status, "replied");
  assert.equal(msg.replied_at, "2026-09-28T11:59:59.000Z");
  const ev = w.db.table("webhook_events")[0];
  assert.equal(ev.status, "processed");
  assert.deepEqual(Object.keys(ev.payload).sort(), ["email_id", "type"], "no headers, body or addresses stored");
});

test("stop_on_reply = false -> reply recorded, sequence continues", async () => {
  const handler = await globalThis.__edge.load("resend-webhook");
  const w = world({ stopOnReply: false });
  providerReturns({});
  await handler(signedWebhookRequest(received()).request);
  assert.equal(w.db.rpcCalls("realtoros_record_contact_stop_event").length, 1);
  assert.ok(w.db.table("contacts")[0].reply_detected_at);
  assert.equal(w.db.table("automation_enrollments")[0].status, "active");
});

for (const [label, headers, subject] of [
  ["Auto-Submitted", { "auto-submitted": "auto-replied" }, "Re: Following up"],
  ["X-Autoreply", { "x-autoreply": "YES" }, "Re: Following up"],
  ["Precedence: auto_reply", { precedence: "auto_reply" }, "Re: Following up"],
  ["out-of-office subject", {}, "Out of Office: back next week"],
]) {
  test(`auto-reply (${label}) -> activity only, no stop`, async () => {
    const handler = await globalThis.__edge.load("resend-webhook");
    const w = world({ stopOnReply: true });
    providerReturns(headers, subject);
    const res = await handler(signedWebhookRequest(received()).request);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).inbound, "auto_reply");
    assert.equal(w.db.rpcCalls("realtoros_record_contact_stop_event").length, 0);
    assert.equal(w.db.table("automation_enrollments")[0].status, "active");
    assert.equal(w.db.table("contacts")[0].reply_detected_at, null);
    const act = w.db.table("activities").find((a) => a.id === `automation-autoreply-${w.messageId}`);
    assert.equal(act.subject, "Automatic reply received");
    assert.equal(w.db.table("outbound_messages")[0].status, "delivered", "status untouched");
  });
}

test("duplicate inbound delivery -> a single stop", async () => {
  const handler = await globalThis.__edge.load("resend-webhook");
  const w = world();
  providerReturns({});
  const first = signedWebhookRequest(received());
  await handler(first.request);
  const again = await handler(signedWebhookRequest(received(), { id: first.id }).request);
  assert.equal((await again.json()).status, "duplicate");
  assert.equal(w.db.rpcCalls("realtoros_record_contact_stop_event").length, 1);
});

test("provider lookup of the received email fails -> 500, event left retryable, nothing stopped", async () => {
  const handler = await globalThis.__edge.load("resend-webhook");
  const w = world();
  fetchMock = mockFetch(() => new Response("{}", { status: 500 }));
  const res = await handler(signedWebhookRequest(received()).request);
  assert.equal(res.status, 500);
  assert.equal(w.db.table("webhook_events")[0].status, "failed");
  assert.equal(w.db.rpcCalls("realtoros_record_contact_stop_event").length, 0);
});

test("unknown token, foreign domain, or inbound not configured -> ignored, no provider lookup", async () => {
  const handler = await globalThis.__edge.load("resend-webhook");
  for (const [to, env] of [
    [[`r-${"f".repeat(40)}@${DOMAIN}`], ENV],
    [[`r-${TOKEN}@attacker.example`], ENV],
    [[`r-${TOKEN}@${DOMAIN}`], { ...ENV, INBOUND_REPLY_DOMAIN: "" }],
  ]) {
    globalThis.__edge.setEnv(env);
    const w = world();
    fetchMock = mockFetch();
    const res = await handler(signedWebhookRequest(received(to)).request);
    assert.equal((await res.json()).status, "ignored");
    assert.equal(fetchMock.calls.length, 0);
    assert.equal(w.db.rpcCalls("realtoros_record_contact_stop_event").length, 0);
    fetchMock.restore();
  }
});

test("inbound reply: stop RPC raises -> non-2xx, event left retryable", async () => {
  const handler = await globalThis.__edge.load("resend-webhook");
  const w = world();
  providerReturns({});
  w.db.failWhen((e) => e.kind === "rpc" && e.name === "realtoros_record_contact_stop_event", { code: "55P03", message: "lock timeout" });
  const res = await handler(signedWebhookRequest(received()).request);
  assert.equal(res.status, 500);
  assert.equal(w.db.table("webhook_events")[0].status, "failed");
  assert.equal(w.db.table("outbound_messages")[0].status, "delivered", "not marked replied");
});
