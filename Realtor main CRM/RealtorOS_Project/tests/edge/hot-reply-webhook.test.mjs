// Phase 4H: resend-webhook marks a hot reply's notification. Exactly one
// notification per reply; the reply text never leaves the function.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { automationScenario, mockFetch, WORKER_ENV, OWNER, CONTACT, CONTACT_EMAIL } from "../helpers/automation-fixture.mjs";
import { signedWebhookRequest, WEBHOOK_SECRET } from "../helpers/svix.mjs";

const DOMAIN = "reply.example.com";
const TOKEN = "b1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const ENV = { ...WORKER_ENV, RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET, INBOUND_REPLY_DOMAIN: DOMAIN };

let handler;
let fetchMock;
beforeEach(async () => {
  globalThis.__edge.setEnv(ENV);
  handler = await globalThis.__edge.load("resend-webhook");
});
afterEach(() => fetchMock?.restore());

function world() {
  const s = automationScenario({ stopOnReply: true });
  s.db.unique("webhook_events", ["provider", "provider_event_id"]);
  s.db.seed("outbound_messages", [{
    id: randomUUID(), user_id: OWNER, contact_id: CONTACT, recipient: CONTACT_EMAIL, provider: "resend",
    provider_message_id: "re_out_1", status: "delivered", message_kind: "automation",
    replied_at: null, unsubscribed_at: null, metadata: { reply_token: TOKEN },
  }]);
  s.db.install();
  return s;
}

const received = (emailId = "in_email_hot") => ({
  type: "email.received",
  created_at: "2026-09-29T12:00:00.000Z",
  data: { email_id: emailId, created_at: "2026-09-29T11:59:59.000Z", from: "lead.person@example.com", to: [`r-${TOKEN}@${DOMAIN}`], subject: "Re: Following up" },
});

function replyBody(text) {
  fetchMock = mockFetch((url) => url.includes("/emails/receiving/")
    ? new Response(JSON.stringify({ object: "email", headers: {}, subject: "Re: Following up", from: "lead.person@example.com", text, html: null }), { status: 200 })
    : new Response("{}", { status: 404 }));
}

test("hot reply -> one notification, upgraded to hot_reply with a reason code; no text stored", async () => {
  const w = world();
  replyBody("Hi! Can we book a viewing on Saturday? My cell is 555 0100.\n\nOn Mon, Agent wrote:\n> Not interested? Reply stop.");
  const res = await handler(signedWebhookRequest(received()).request);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.inbound, / hot=viewing$/);
  const calls = w.db.rpcCalls("realtoros_mark_reply_hot");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, { p_user_id: OWNER, p_event_ref: "inbound:in_email_hot", p_reason: "viewing" });
  const n = w.db.table("notifications");
  assert.equal(n.length, 1);
  assert.equal(n[0].type, "hot_reply");
  assert.equal(n[0].metadata.hot_reason, "viewing");
  assert.doesNotMatch(JSON.stringify(w.db.table("notifications")) + JSON.stringify(w.db.table("webhook_events")), /Saturday|555 0100/,
    "reply text is never stored");
});

test("normal reply -> one lead_replied notification, no hot call", async () => {
  const w = world();
  replyBody("Thanks for the update, will read it later.");
  const res = await handler(signedWebhookRequest(received()).request);
  assert.equal(res.status, 200);
  assert.doesNotMatch((await res.json()).inbound, /hot=/);
  assert.equal(w.db.rpcCalls("realtoros_mark_reply_hot").length, 0);
  const n = w.db.table("notifications");
  assert.equal(n.length, 1);
  assert.equal(n[0].type, "lead_replied");
});

test("'not interested' with hot words is not hot", async () => {
  const w = world();
  replyBody("Not interested anymore, we already bought. No need for a viewing.");
  await handler(signedWebhookRequest(received()).request);
  assert.equal(w.db.rpcCalls("realtoros_mark_reply_hot").length, 0);
  assert.equal(w.db.table("notifications")[0].type, "lead_replied");
});

test("duplicate delivery of a hot reply -> still one notification", async () => {
  const w = world();
  replyBody("We'd like to make an offer.");
  const first = signedWebhookRequest(received());
  assert.equal((await handler(first.request)).status, 200);
  // Same webhook id: deduplicated before anything runs.
  assert.equal((await (await handler(signedWebhookRequest(received(), { id: first.id }).request)).json()).status, "duplicate");
  // New webhook id, same received email: the stop ledger dedupes, the hot mark is idempotent.
  assert.equal((await handler(signedWebhookRequest(received()).request)).status, 200);
  assert.equal(w.db.table("contact_stop_events").length, 1);
  const n = w.db.table("notifications");
  assert.equal(n.length, 1);
  assert.equal(n[0].type, "hot_reply");
  assert.equal(n[0].metadata.hot_reason, "offer");
});

test("an opt-out reply is an unsubscribe notification and never hot", async () => {
  const w = world();
  replyBody("unsubscribe");
  await handler(signedWebhookRequest(received()).request);
  assert.equal(w.db.rpcCalls("realtoros_mark_reply_hot").length, 0);
  const n = w.db.table("notifications");
  assert.equal(n.length, 1);
  assert.equal(n[0].type, "unsubscribed");
});

test("if marking hot fails, the reply is still processed (200) and the plain notification stays", async () => {
  const w = world();
  replyBody("Please call me tomorrow.");
  w.db.failWhen((e) => e.kind === "rpc" && e.name === "realtoros_mark_reply_hot", { code: "XX000", message: "boom" });
  const res = await handler(signedWebhookRequest(received()).request);
  assert.equal(res.status, 200);
  assert.match((await res.json()).inbound, / hot=call_request hot_mark_failed$/);
  assert.equal(w.db.table("webhook_events")[0].status, "processed");
  assert.equal(w.db.table("outbound_messages")[0].status, "replied");
  assert.equal(w.db.table("notifications")[0].type, "lead_replied");
});
