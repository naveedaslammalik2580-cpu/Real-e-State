// manage-automation: owner-verified manual reply/unsubscribe, manual
// enroll refusals with a clear reason, and retry refused for a step a
// stop cancelled.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { automationScenario, WORKER_ENV, OWNER, CONTACT } from "../helpers/automation-fixture.mjs";
import { WEBHOOK_SECRET } from "../helpers/svix.mjs";

const TOKEN = "owner-session-token";
let handler;
beforeEach(async () => {
  globalThis.__edge.setEnv({ ...WORKER_ENV, SUPABASE_ANON_KEY: "anon", RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET });
  handler = await globalThis.__edge.load("manage-automation");
});

function world(opts = {}) {
  const s = automationScenario(opts);
  s.db.users.set(TOKEN, OWNER);
  s.db.table("automation_rules")[0].runtime_version = randomUUID();
  s.db.rpc("realtoros_enroll_contact", () => ({ outcome: "enrolled", enrollment_id: randomUUID() }));
  s.db.rpc("realtoros_retry_failed_job", (a) => {
    const j = s.db.table("automation_jobs").find((x) => x.id === a.p_job_id && x.user_id === a.p_user_id);
    if (!j) return { outcome: "not_found" };
    return j.status === "failed" ? { outcome: "retried" } : { outcome: "not_eligible" };
  });
  s.db.rpc("realtoros_rule_stop_summary", () => ({ found: true, stopped_counts: {}, stopped_enrollments: [], cancelled_jobs: [], skipped_jobs: [{ job_id: "x", skipped_reason: "suppressed" }] }));
  s.db.install();
  return s;
}

async function call(body, token = TOKEN) {
  const res = await handler(new Request("https://unit-test.supabase.co/functions/v1/manage-automation", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

test("mark_replied: owner-verified, one stop through the entry point with source owner_manual", async () => {
  const s = world({ stopOnReply: true });
  const r = await call({ action: "mark_replied", contact_id: CONTACT });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.enrollments_stopped, 1);
  const c = s.db.rpcCalls("realtoros_record_contact_stop_event");
  assert.equal(c.length, 1);
  assert.equal(c[0].args.p_user_id, OWNER, "identity from the JWT, never the body");
  assert.equal(c[0].args.p_event_type, "reply");
  assert.equal(c[0].args.p_source, "owner_manual");
  assert.match(c[0].args.p_event_ref, /^manual:[0-9a-f-]{36}$/);
  assert.equal(s.db.table("automation_enrollments")[0].status, "stopped");
});

test("mark_unsubscribed: email blocked and consent revoked", async () => {
  const s = world();
  const r = await call({ action: "mark_unsubscribed", contact_id: CONTACT });
  assert.equal(r.status, 200);
  assert.equal(s.db.table("communication_consents")[0].status, "opted_out");
  assert.equal(s.db.table("communication_consents")[0].source, "owner_manual");
  assert.equal(s.db.table("email_suppressions")[0].reason, "unsubscribe");
});

test("mark actions: other owner's contact, bad input, no session", async () => {
  const s = world();
  s.db.table("contacts")[0].user_id = randomUUID();
  assert.equal((await call({ action: "mark_replied", contact_id: CONTACT })).status, 404);
  assert.equal((await call({ action: "mark_replied", contact_id: CONTACT, user_id: OWNER })).status, 422, "no extra fields");
  assert.equal((await call({ action: "mark_replied", contact_id: "" })).status, 422);
  assert.equal((await call({ action: "mark_replied", contact_id: CONTACT }, null)).status, 401);
  assert.equal((await call({ action: "mark_replied", contact_id: CONTACT }, "bogus")).status, 401);
  assert.equal(s.db.rpcCalls("realtoros_record_contact_stop_event").length, 0);
});

test("mark action lock timeout -> bounded retries of the SAME event, then try_again (503)", async () => {
  const s = world();
  s.db.contactLockBusy = true;
  const r = await call({ action: "mark_unsubscribed", contact_id: CONTACT });
  assert.equal(r.status, 503);
  assert.equal(r.body.error, "try_again");
  const refs = s.db.rpcCalls("realtoros_record_contact_stop_event").map((c) => c.args.p_event_ref);
  assert.equal(refs.length, 3);
  assert.equal(new Set(refs).size, 1, "one event reference reused across retries");
});

for (const [label, setup, code, status] of [
  ["suppressed", (s) => s.db.seed("email_suppressions", [{ user_id: OWNER, normalized_email: "lead.person@example.com", reason: "bounce", is_active: true }]), "contact_suppressed", 422],
  ["opted out", (s) => s.db.seed("communication_consents", [{ user_id: OWNER, contact_id: CONTACT, channel: "email", status: "opted_out" }]), "contact_opted_out", 422],
  ["unsubscribed (rule stops on unsubscribe)", (s) => { s.db.table("contacts")[0].unsubscribe_detected_at = "2026-09-01T00:00:00Z"; }, "contact_unsubscribed", 422],
  ["replied (rule stops on reply)", (s) => { s.db.table("contacts")[0].reply_detected_at = "2026-09-01T00:00:00Z"; }, "contact_replied", 422],
  ["already in the automation", () => {}, "duplicate_enrollment", 409],
]) {
  test(`manual enroll refused: ${label} -> ${code}`, async () => {
    const s = world();
    if (code !== "duplicate_enrollment") s.db.table("automation_enrollments").length = 0;
    setup(s);
    const r = await call({ action: "manual_enroll", rule_id: s.ruleId, contact_id: CONTACT });
    assert.equal(r.status, status);
    assert.equal(r.body.error, code);
    assert.equal(s.db.rpcCalls("realtoros_enroll_contact").length, 0);
  });
}

test("manual enroll allowed for an eligible contact", async () => {
  const s = world();
  s.db.table("automation_enrollments").length = 0;
  const r = await call({ action: "manual_enroll", rule_id: s.ruleId, contact_id: CONTACT });
  assert.equal(r.status, 200);
  assert.equal(s.db.rpcCalls("realtoros_enroll_contact").length, 1);
});

test("retry refused for a step that a stop cancelled", async () => {
  const s = world();
  Object.assign(s.db.table("automation_jobs")[0], { status: "cancelled", cancelled_reason: "unsubscribe" });
  const r = await call({ action: "retry_job", job_id: s.jobId });
  assert.equal(r.status, 422);
  assert.equal(r.body.error, "job_not_eligible");
});

test("stop_summary passes skipped email steps through", async () => {
  const s = world();
  const r = await call({ action: "stop_summary", rule_id: s.ruleId });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.skipped_jobs, [{ job_id: "x", skipped_reason: "suppressed" }]);
});

// Fix 1: a raised database error is a retryable "try again", never 500
// internal_error and never a success.
const LOCK_TIMEOUT = { code: "55P03", message: "canceling statement due to lock timeout" };

for (const action of ["mark_replied", "mark_unsubscribed"]) {
  test(`${action}: stop RPC raises -> 503 try_again`, async () => {
    const s = world();
    s.db.failWhen((e) => e.kind === "rpc" && e.name === "realtoros_record_contact_stop_event", LOCK_TIMEOUT);
    const r = await call({ action, contact_id: CONTACT });
    assert.equal(r.status, 503);
    assert.deepEqual(r.body, { error: "try_again" });
    assert.equal(s.db.table("contact_stop_events").length, 0);
  });
}

test("mark action: contact lookup fails -> 503 try_again", async () => {
  const s = world();
  s.db.failWhen((e) => e.kind === "table" && e.table === "contacts", LOCK_TIMEOUT);
  const r = await call({ action: "mark_replied", contact_id: CONTACT });
  assert.equal(r.status, 503);
  assert.equal(r.body.error, "try_again");
  assert.equal(s.db.rpcCalls("realtoros_record_contact_stop_event").length, 0);
});
