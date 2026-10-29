// process-automation: the pre-send guard decides cancel / stop / skip for
// claimed jobs; a stop landing mid-flight never causes a send that the
// guard could still prevent, and never un-records a send that happened.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  automationScenario, claimEvent, mockFetch, workerRequest, WORKER_ENV, OWNER, CONTACT, CONTACT_EMAIL,
  recordContactStopEvent,
} from "../helpers/automation-fixture.mjs";

let handler;
let fetchMock;
beforeEach(async () => {
  globalThis.__edge.setEnv(WORKER_ENV);
  handler = await globalThis.__edge.load("process-automation");
  fetchMock = mockFetch();
});
afterEach(() => fetchMock.restore());

const providerCalls = () => fetchMock.calls.filter((c) => c.url.includes("api.resend.com/emails"));
async function run() {
  const res = await handler(workerRequest());
  assert.equal(res.status, 200);
  return (await res.json()).counters;
}
const job = (db, id) => db.table("automation_jobs").find((j) => j.id === id);
const enrollment = (db, id) => db.table("automation_enrollments").find((e) => e.id === id);
const stop = (db, type, source, ref = randomUUID()) =>
  recordContactStopEvent(db, { p_user_id: OWNER, p_contact_id: CONTACT, p_event_type: type, p_source: source, p_event_ref: ref });

test("stop_on_reply = true and the contact replied -> sequence stopped, no send", async () => {
  const s = automationScenario({ stopOnReply: true, replyDetectedAt: "2026-09-27T00:00:00Z" });
  s.db.install();
  const counters = await run();
  assert.equal(providerCalls().length, 0);
  assert.equal(counters.jobsCancelled, 1);
  assert.equal(enrollment(s.db, s.enrollmentId).status, "stopped");
  assert.equal(enrollment(s.db, s.enrollmentId).stop_reason, "reply");
  assert.equal(job(s.db, s.jobId).status, "cancelled");
  assert.equal(job(s.db, s.jobId).cancelled_reason, "reply");
  const act = s.db.table("activities").find((a) => a.id === `automation-job-stopped-${s.jobId}`);
  assert.match(act.notes, /replied/);
});

test("stop_on_reply = false and the contact replied -> the email is sent", async () => {
  const s = automationScenario({ stopOnReply: false, replyDetectedAt: "2026-09-27T00:00:00Z" });
  s.db.install();
  await run();
  assert.equal(providerCalls().length, 1);
  assert.equal(job(s.db, s.jobId).status, "completed");
});

test("stop_on_unsubscribe = true: unsubscribe stops the sequence", async () => {
  const s = automationScenario({ stopOnUnsubscribe: true });
  s.db.install();
  stop(s.db, "unsubscribe", "unsubscribe_link");
  // The stop already cancelled the pending job; nothing is claimed or sent.
  const counters = await run();
  assert.equal(providerCalls().length, 0);
  assert.equal(counters.jobsCompleted + counters.jobsCancelled + counters.jobsSkipped, 0);
  assert.equal(job(s.db, s.jobId).status, "cancelled");
});

test("stop_on_unsubscribe = false: email step skipped (still blocked), sequence continues", async () => {
  const s = automationScenario({ stopOnUnsubscribe: false });
  s.db.install();
  stop(s.db, "unsubscribe", "owner_manual");
  assert.equal(enrollment(s.db, s.enrollmentId).status, "active");
  const counters = await run();
  assert.equal(providerCalls().length, 0, "email is blocked regardless of the rule flag");
  assert.equal(counters.jobsSkipped, 1);
  const j = job(s.db, s.jobId);
  assert.equal(j.status, "completed");
  assert.ok(["suppressed", "consent_revoked", "contact_unsubscribed"].includes(j.skipped_reason));
  assert.equal(s.db.table("outbound_messages").length, 0, "no message row for a step that never sent");
  const act = s.db.table("activities").find((a) => a.id === `automation-job-skipped-${s.jobId}`);
  assert.equal(act.subject, "Follow-up email skipped");
});

test("stop_on_unsubscribe = false: a task step still runs after the unsubscribe", async () => {
  const s = automationScenario({ stopOnUnsubscribe: false, jobType: "create_task" });
  s.db.install();
  stop(s.db, "unsubscribe", "owner_manual");
  await run();
  assert.equal(job(s.db, s.jobId).status, "completed");
  assert.equal(s.db.table("tasks").length, 1);
});

test("hard bounce: email skipped, task continues", async () => {
  const email = automationScenario();
  email.db.install();
  recordContactStopEvent(email.db, { p_user_id: OWNER, p_contact_id: CONTACT, p_event_type: "hard_bounce", p_source: "provider_webhook", p_event_ref: "b1" });
  await run();
  assert.equal(providerCalls().length, 0);
  assert.equal(job(email.db, email.jobId).skipped_reason, "suppressed");

  const task = automationScenario({ jobType: "create_task" });
  task.db.install();
  recordContactStopEvent(task.db, { p_user_id: OWNER, p_contact_id: CONTACT, p_event_type: "hard_bounce", p_source: "provider_webhook", p_event_ref: "b2" });
  await run();
  assert.equal(task.db.table("tasks").length, 1);
});

test("stop lands while the job is processing, BEFORE the send -> late guard prevents the send", async () => {
  const s = automationScenario({ stopOnReply: true });
  s.db.install();
  const realGuard = s.db.rpcs.get("realtoros_presend_guard");
  let calls = 0;
  s.db.rpc("realtoros_presend_guard", (a, db) => {
    calls++;
    // Between the early and the late guard, a reply arrives. The job is
    // already 'processing', so the stop itself cannot cancel it.
    if (calls === 2) stop(db, "reply", "inbound_email");
    return realGuard(a, db);
  });
  await run();
  assert.equal(calls, 2);
  assert.equal(providerCalls().length, 0);
  assert.equal(job(s.db, s.jobId).status, "cancelled");
  assert.equal(enrollment(s.db, s.enrollmentId).stop_reason, "reply");
});

test("stop lands AFTER the provider call -> send recorded normally, no later step, never unsent", async () => {
  const s = automationScenario({ stopOnUnsubscribe: true });
  s.db.install();
  fetchMock.restore();
  fetchMock = mockFetch(() => {
    stop(s.db, "unsubscribe", "unsubscribe_link");
    return new Response(JSON.stringify({ id: "re_sent_1" }), { status: 200 });
  });
  await run();
  assert.equal(providerCalls().length, 1);
  const msg = s.db.table("outbound_messages")[0];
  assert.equal(msg.status, "sent");
  assert.equal(msg.provider_message_id, "re_sent_1");
  assert.equal(job(s.db, s.jobId).status, "completed");
  assert.ok(s.db.table("activities").some((a) => a.id === `automation-activity-${s.jobId}`), "the send is on the timeline");
  assert.equal(enrollment(s.db, s.enrollmentId).status, "stopped");
});

test("message already accepted on an earlier attempt + contact since unsubscribed -> recorded, not resent, not cancelled", async () => {
  const s = automationScenario({ stopOnUnsubscribe: true });
  s.db.install();
  const { deterministicKey } = await import("../helpers/keys.mjs");
  s.db.seed("outbound_messages", [{
    id: randomUUID(), user_id: OWNER, contact_id: CONTACT, idempotency_key: await deterministicKey(s.jobId),
    status: "delivered", recipient: CONTACT_EMAIL, provider_message_id: "re_prev",
  }]);
  s.db.table("contacts")[0].unsubscribe_detected_at = "2026-09-28T00:00:00Z";
  await run();
  assert.equal(providerCalls().length, 0);
  assert.equal(job(s.db, s.jobId).status, "completed");
  assert.equal(s.db.table("outbound_messages")[0].status, "delivered");
});

test("ambiguous queued message from an earlier attempt + stop -> 'unconfirmed', never resent", async () => {
  const s = automationScenario({ stopOnReply: true, replyDetectedAt: "2026-09-28T00:00:00Z" });
  s.db.install();
  const { deterministicKey } = await import("../helpers/keys.mjs");
  s.db.seed("outbound_messages", [{
    id: randomUUID(), user_id: OWNER, contact_id: CONTACT, idempotency_key: await deterministicKey(s.jobId),
    status: "queued", recipient: CONTACT_EMAIL, first_provider_attempt_at: new Date().toISOString(),
  }]);
  await run();
  assert.equal(providerCalls().length, 0);
  assert.equal(s.db.table("outbound_messages")[0].status, "unconfirmed");
  assert.equal(job(s.db, s.jobId).status, "cancelled");
});

test("enrollment lock timeout on the worker's stop -> bounded retries, then released as retryable, nothing sent", async () => {
  const s = automationScenario({ stopOnReply: true, replyDetectedAt: "2026-09-28T00:00:00Z" });
  s.db.install();
  s.db.lockBusy = new Set([s.enrollmentId]);
  const counters = await run();
  assert.equal(providerCalls().length, 0);
  assert.equal(s.db.rpcCalls("realtoros_stop_enrollment_on_event").length, 3);
  assert.equal(counters.jobsRescheduled, 1);
  const j = job(s.db, s.jobId);
  assert.equal(j.status, "pending");
  assert.equal(j.last_error_code, "stop_lock_timeout");
  assert.equal(enrollment(s.db, s.enrollmentId).status, "active");

  s.db.lockBusy.clear();
  j.scheduled_at = "2026-09-01T00:00:00Z";
  await run();
  assert.equal(providerCalls().length, 0);
  assert.equal(enrollment(s.db, s.enrollmentId).status, "stopped");
  assert.equal(j.status, "cancelled");
});

test("lost lock (guard says abort) -> job untouched, nothing sent", async () => {
  const s = automationScenario();
  s.db.install();
  s.db.rpc("realtoros_presend_guard", () => ({ blocked: true, action: "abort", reason: "lock_lost" }));
  const counters = await run();
  assert.equal(counters.jobsAbandoned, 1);
  assert.equal(providerCalls().length, 0);
  assert.equal(job(s.db, s.jobId).status, "processing", "left for whoever holds the lock");
  assert.equal(s.db.rpcCalls("realtoros_cancel_claimed_job").length, 0);
  assert.equal(s.db.rpcCalls("realtoros_reschedule_job").length, 0);
});

test("unrecognized guard answer fails closed (no send)", async () => {
  const s = automationScenario();
  s.db.install();
  s.db.rpc("realtoros_presend_guard", () => ({ blocked: false, action: "maybe" }));
  const counters = await run();
  assert.equal(counters.jobsErrored, 1);
  assert.equal(providerCalls().length, 0);
});

test("the agent's reply-to address is passed to the provider", async () => {
  const s = automationScenario();
  s.db.install();
  await run();
  assert.deepEqual(providerCalls()[0].body.reply_to.slice(-1), ["agent@example.org"]);
});

test("enrollment refused for an unsubscribed contact records a plain-language note", async () => {
  const s = automationScenario();
  s.db.install();
  s.db.table("automation_enrollments").length = 0;
  s.db.table("automation_jobs").length = 0;
  s.db.table("automation_rules")[0].trigger_type = "contact_created";
  s.db.table("contacts")[0].unsubscribe_detected_at = "2026-09-28T00:00:00Z";
  claimEvent(s.db, { event_type: "contact_created", new_status: "New Lead" });
  s.db.rpc("realtoros_complete_trigger_event", () => ({ outcome: "completed" }));
  const counters = await run();
  assert.equal(counters.enrollmentsBlocked, 1);
  assert.equal(s.db.rpcCalls("realtoros_enroll_contact").length, 0);
  const note = s.db.table("activities").find((a) => a.id.startsWith("automation-enroll-blocked-"));
  assert.equal(note.notes, "This contact unsubscribed, so they were not added to the automation.");
  assert.doesNotMatch(note.notes, /_/);
});
