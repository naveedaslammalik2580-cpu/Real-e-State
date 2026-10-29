// Phase 2A wiring in the two Edge Functions.
//
// The detector itself is SQL and is tested against a real database in
// tests/sql/phase_2a_time_triggers.test.mjs. What is tested here is only
// what the functions are responsible for: that the worker asks for a scan
// at the right moment and survives it failing, that a detected occurrence
// starts its own rule and nobody else's, and that activation will not let a
// bad trigger_config through or snapshot an unvalidated one.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  automationScenario, claimEvent, mockFetch, workerRequest, WORKER_ENV, OWNER, CONTACT, WORKSPACE,
} from "../helpers/automation-fixture.mjs";
import { WEBHOOK_SECRET } from "../helpers/svix.mjs";

// ---------------------------------------------------------------- worker

let worker;
let fetchMock;
beforeEach(async () => {
  globalThis.__edge.setEnv(WORKER_ENV);
  worker = await globalThis.__edge.load("process-automation");
  fetchMock = mockFetch();
});
afterEach(() => fetchMock.restore());

async function run() {
  const res = await worker(workerRequest());
  assert.equal(res.status, 200);
  return (await res.json()).counters;
}

/** A scenario with the scan faked, so the worker gets a real answer. */
function workerWorld(scanResult, opts = {}) {
  const s = automationScenario(opts);
  if (scanResult !== null) {
    s.db.rpc("realtoros_scan_time_triggers", () => scanResult);
  }
  s.db.install();
  return s;
}

test("the worker asks for a scan once, before it claims any events", async () => {
  const s = workerWorld({ scanned_workspaces: 2, scanned_rules: 3, events_created: 4, skipped_workspaces: 1 });
  const counters = await run();

  const scans = s.db.rpcCalls("realtoros_scan_time_triggers");
  assert.equal(scans.length, 1, "exactly one scan per run");
  assert.equal(counters.timeEventsCreated, 4, "its count is reported");
  assert.equal(counters.scanSkipped, 1);
  assert.equal(counters.scanFailed, 0);

  // Ordering: anything that came due this run has to be claimable in the
  // same run, so the scan must precede the claim.
  const names = s.db.calls.filter((c) => c.kind === "rpc").map((c) => c.name);
  const scanAt = names.indexOf("realtoros_scan_time_triggers");
  const claimAt = names.indexOf("realtoros_claim_trigger_events");
  assert.ok(scanAt >= 0 && claimAt >= 0);
  assert.ok(scanAt < claimAt, "the scan runs before events are claimed: " + names.join(","));
});

test("a scan that fails is counted and never stops the queue", async () => {
  // No fake for the scan at all, so the call comes back as an error — which
  // is also what a missing migration would look like.
  const s = workerWorld(null);
  const counters = await run();

  assert.equal(counters.scanFailed, 1, "the failure is visible in the counters");
  assert.equal(counters.timeEventsCreated, 0);
  // The run still did its real work.
  assert.equal(s.db.rpcCalls("realtoros_claim_trigger_events").length, 1);
  assert.equal(s.db.rpcCalls("realtoros_claim_due_jobs").length, 1);
  assert.equal(counters.jobsCompleted, 1, "the queued job was still sent");
});

test("the scan response never reaches the worker's own response body", async () => {
  const s = workerWorld({
    scanned_workspaces: 1, scanned_rules: 1, events_created: 1, skipped_workspaces: 0,
    // A hostile or careless future version of the RPC adding something it
    // should not: the worker must not pass it through.
    leaked_email: "lead.person@example.com",
  });
  const res = await worker(workerRequest());
  const text = await res.text();
  assert.ok(!text.includes("lead.person@example.com"), "nothing from the scan is echoed: " + text);
  assert.ok(text.includes("timeEventsCreated"), "only the counts it chose to keep");
  s.db.install; // silence unused
});

test("a detected occurrence enrols against its own rule only, under its own key", async () => {
  const s = automationScenario({ jobType: "send_email" });
  // The fixture predates workspaces, so the rule it seeds has no
  // workspace_id. A detected occurrence is resolved by (rule_id,
  // workspace_id), so both sides need one.
  const WS = WORKSPACE;   // the fixture seeds everything into this one
  const rule = s.db.table("automation_rules")[0];
  rule.status = "active";
  rule.workspace_id = WS;
  rule.trigger_type = "no_contact";
  rule.trigger_config = { days: 30, fire_hour: 8, include_existing: false };
  // The fixture seeds an OPEN enrollment and a queued job for this rule and
  // contact, which is exactly what eligibility refuses a second enrollment
  // for. This test is about which rule an occurrence starts, so that
  // enrollment is closed and its job removed first.
  s.db.table("automation_enrollments")[0].status = "completed";
  s.db.table("automation_jobs").length = 0;
  // A second active rule that must NOT be started by this occurrence.
  const other = randomUUID();
  s.db.table("automation_rules").push({
    id: other, user_id: OWNER, workspace_id: WS, status: "active", visibility: "shared",
    timezone: "UTC", trigger_type: "no_contact",
    trigger_config: { days: 60, fire_hour: 8, include_existing: false },
    stop_on_reply: true, stop_on_unsubscribe: true, audience_filter: {},
  });

  const eventKey = `nc:${rule.id}:${CONTACT}:2026-02-01`;
  s.db.rpc("realtoros_scan_time_triggers", () => ({
    scanned_workspaces: 1, scanned_rules: 2, events_created: 1, skipped_workspaces: 0,
  }));
  claimEvent(s.db, {
    event_type: "no_contact", new_status: null, rule_id: rule.id, event_key: eventKey,
    payload: { rule_id: rule.id, trigger_type: "no_contact" },
  });
  s.db.rpc("realtoros_complete_trigger_event", () => ({ outcome: "completed" }));
  s.db.rpc("realtoros_enroll_contact", () => ({ outcome: "enrolled", enrollment_id: randomUUID() }));
  s.db.install();

  await run();

  const enrolls = s.db.rpcCalls("realtoros_enroll_contact");
  assert.equal(enrolls.length, 1, "one rule started, not both");
  assert.equal(enrolls[0].args.p_rule_id, rule.id, "and it is the rule the occurrence named");
  assert.notEqual(enrolls[0].args.p_rule_id, other);
  assert.equal(enrolls[0].args.p_trigger_event_key, eventKey,
    "the enrollment carries the occurrence's own key, not one derived from the row id");
});

test("a detected occurrence whose rule was paused in the meantime starts nothing", async () => {
  const s = automationScenario();
  const rule = s.db.table("automation_rules")[0];
  rule.status = "paused";
  rule.trigger_type = "no_contact";
  s.db.rpc("realtoros_scan_time_triggers", () => ({ scanned_workspaces: 0, scanned_rules: 0, events_created: 0, skipped_workspaces: 0 }));
  claimEvent(s.db, {
    event_type: "no_contact", new_status: null, rule_id: rule.id, event_key: "nc:x:y:z",
  });
  s.db.rpc("realtoros_complete_trigger_event", () => ({ outcome: "completed" }));
  s.db.install();

  await run();
  assert.equal(s.db.rpcCalls("realtoros_enroll_contact").length, 0,
    "a rule that is no longer active must not be started between detection and processing");
});

// ---------------------------------------------------------------- activation

const TOKEN = "owner-session-token";
let manage;

async function manageCall(body) {
  const res = await manage(new Request("https://unit-test.supabase.co/functions/v1/manage-automation", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

/** A draft rule of a 2A type, ready to activate, with the DB validator
 *  faked to behave like the real one for the cases under test. */
function activationWorld(triggerType, triggerConfig, { validatorOk = true, normalized = null } = {}) {
  const s = automationScenario({ ruleStatus: "draft" });
  s.db.users.set(TOKEN, OWNER);
  const rule = s.db.table("automation_rules")[0];
  rule.status = "draft";
  rule.trigger_type = triggerType;
  rule.trigger_config = triggerConfig;
  rule.audience_filter = {};
  rule.timezone = "UTC";
  // One active step, so the rest of the preflight passes.
  s.db.seed("automation_steps", [{
    id: randomUUID(), user_id: OWNER, rule_id: rule.id,
    template_id: s.db.table("message_templates")[0].id,
    step_order: 1, action_type: "send_email", delay_minutes: 0,
    subject_override: "Hi {{first_name}}", config: {}, is_active: true,
  }]);
  s.db.table("message_templates")[0].channel = "email";
  s.db.table("message_templates")[0].subject = "Hi {{first_name}}";
  s.db.table("message_templates")[0].body_text = "Hello {{first_name}}.";
  s.db.rpc("realtoros_validate_trigger_config", (a) => (
    validatorOk
      ? { ok: true, config: normalized ?? a.p_config }
      : { ok: false, code: "trigger_config_days_out_of_range" }
  ));
  s.db.install();
  return { s, rule };
}

test("activation refuses a trigger_config the database rejects", async () => {
  globalThis.__edge.setEnv({ ...WORKER_ENV, SUPABASE_ANON_KEY: "anon", RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET });
  manage = await globalThis.__edge.load("manage-automation");
  const { s, rule } = activationWorld("no_contact", { days: 999 }, { validatorOk: false });

  const r = await manageCall({ action: "activate_rule", rule_id: rule.id });
  assert.equal(r.status, 422);
  assert.equal(r.body.error, "invalid_trigger_config");
  assert.equal(s.db.table("automation_rules")[0].status, "draft", "the rule stays a draft");
});

test("activation snapshots the NORMALIZED config the validator returned", async () => {
  globalThis.__edge.setEnv({ ...WORKER_ENV, SUPABASE_ANON_KEY: "anon", RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET });
  manage = await globalThis.__edge.load("manage-automation");
  // The row holds a bare config; the validator fills in the defaults. What
  // is frozen must be the filled-in version, not the row's.
  const { s, rule } = activationWorld("no_contact", { days: 30 }, {
    normalized: { days: 30, fire_hour: 8, include_existing: false },
  });

  const r = await manageCall({ action: "activate_rule", rule_id: rule.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const saved = s.db.table("automation_rules")[0];
  assert.equal(saved.status, "active");
  assert.equal(saved.runtime_snapshot.trigger_type, "no_contact");
  assert.deepEqual(saved.runtime_snapshot.trigger_config,
    { days: 30, fire_hour: 8, include_existing: false },
    "the activated rule runs on the values that were actually checked");

  const calls = s.db.rpcCalls("realtoros_validate_trigger_config");
  assert.equal(calls.length, 1, "validated exactly once, in the database");
  assert.equal(calls[0].args.p_trigger_type, "no_contact");
});

test("a pre-2A trigger type still activates, and carries an empty config", async () => {
  globalThis.__edge.setEnv({ ...WORKER_ENV, SUPABASE_ANON_KEY: "anon", RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET });
  manage = await globalThis.__edge.load("manage-automation");
  const { s, rule } = activationWorld("manual", {}, { normalized: {} });

  const r = await manageCall({ action: "activate_rule", rule_id: rule.id });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const saved = s.db.table("automation_rules")[0];
  assert.equal(saved.status, "active");
  assert.deepEqual(saved.runtime_snapshot.trigger_config, {});
  assert.ok(Array.isArray(saved.runtime_snapshot.steps) && saved.runtime_snapshot.steps.length === 1,
    "and the steps are still snapshotted as before");
});
