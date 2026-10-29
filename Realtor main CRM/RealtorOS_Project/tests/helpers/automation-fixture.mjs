// A ready-to-run automation world for process-automation tests: one owner,
// one contact, one active rule, one active enrollment and one due job, plus
// JS fakes of the service-role RPCs that mirror the SQL contracts in
// supabase/migrations (outcome names, lock-token checks, state changes).
import { randomUUID } from "node:crypto";
import { FakeDb } from "./fake-db.mjs";

export const WORKER_SECRET = "test-worker-secret-0123456789";
export const OWNER = "11111111-1111-4111-8111-111111111111";
export const CONTACT = "contact-abc";
export const CONTACT_EMAIL = "Lead.Person@Example.com";
// Phase 2C: the fixture's own workspace. Everything it seeds belongs to
// this one, because rule matching is now scoped by workspace and a fake
// that skipped that check would be looser than the real thing.
export const WORKSPACE = "22222222-2222-4222-8222-222222222222";

export const WORKER_ENV = {
  SUPABASE_URL: "https://unit-test.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key",
  RESEND_API_KEY: "re_test_key_do_not_log",
  RESEND_SENDING_DOMAIN: "mail.example.com",
  AUTOMATION_WORKER_SECRET: WORKER_SECRET,
  UNSUBSCRIBE_SIGNING_SECRET: "unsubscribe-signing-secret-for-tests-0123456789",
};

export function automationScenario(opts = {}) {
  const {
    jobType = "send_email",
    stopOnReply = true,
    stopOnUnsubscribe = true,
    consent = null, // 'opted_out' | 'opted_in' | null
    suppressed = false,
    replyDetectedAt = null,
    unsubscribeDetectedAt = null,
    enrollmentStatus = "active",
    ruleStatus = "active",
  } = opts;

  const db = new FakeDb();
  const ruleId = randomUUID();
  const enrollmentId = randomUUID();
  const jobId = randomUUID();
  const templateId = randomUUID();

  db.unique("outbound_messages", ["user_id", "idempotency_key"], (r) => r.idempotency_key != null);
  db.unique("activities", ["id"]);
  db.unique("tasks", ["id"]);
  db.unique("email_suppressions", ["user_id", "normalized_email"], (r) => r.is_active === true);
  db.unique("communication_consents", ["user_id", "contact_id", "channel"]);

  db.seed("contacts", [{
    workspace_id: WORKSPACE,
    id: CONTACT, user_id: OWNER, email: CONTACT_EMAIL, full_name: "Lead Person", status: "New Lead",
    last_contact: null, reply_detected_at: replyDetectedAt, unsubscribe_detected_at: unsubscribeDetectedAt,
  }]);
  if (consent) {
    db.seed("communication_consents", [{ user_id: OWNER, contact_id: CONTACT, channel: "email", status: consent }]);
  }
  if (suppressed) {
    db.seed("email_suppressions", [{
      id: randomUUID(), user_id: OWNER, normalized_email: CONTACT_EMAIL.toLowerCase(), reason: "bounce", is_active: true,
    }]);
  }
  db.seed("message_templates", [{ id: templateId, user_id: OWNER, is_active: true }]);
  db.seed("email_sender_profiles", [{
    user_id: OWNER, display_name: "Agent Smith", reply_to_email: "agent@example.org", is_enabled: true, provider: "resend",
  }]);
  db.seed("automation_rules", [{
    id: ruleId, user_id: OWNER, workspace_id: WORKSPACE, status: ruleStatus,
    visibility: "shared", audience_filter: {}, trigger_config: {}, timezone: "UTC", trigger_type: "manual",
    stop_on_reply: stopOnReply, stop_on_unsubscribe: stopOnUnsubscribe,
  }]);
  db.seed("automation_enrollments", [{
    id: enrollmentId, user_id: OWNER, workspace_id: WORKSPACE, rule_id: ruleId, contact_id: CONTACT, status: enrollmentStatus,
    stopped_at: null, stop_reason: null, reply_detected_at: null, unsubscribe_detected_at: null, started_at: "2026-09-01T00:00:00Z",
  }]);
  const payload = jobType === "send_email"
    ? { step_order: 1, action_type: "send_email", template_id: templateId, subject: "Hi {{first_name}}", body_text: "Hello {{first_name}}, following up." }
    : { step_order: 1, action_type: "create_task", config: { title: "Call the lead", priority: "High" } };
  db.seed("automation_jobs", [{
    id: jobId, user_id: OWNER, workspace_id: WORKSPACE, enrollment_id: enrollmentId, rule_id: ruleId, contact_id: CONTACT, job_type: jobType,
    status: "pending", attempts: 0, max_attempts: 3, lock_token: null, payload, cancelled_at: null, cancelled_reason: null,
    skipped_reason: null, scheduled_at: "2026-09-01T00:00:00Z",
  }]);
  db.seed("automation_runs", []);
  db.seed("automation_trigger_events", []);

  installAutomationRpcs(db);
  return { db, ruleId, enrollmentId, jobId, templateId };
}

function jobById(db, id, userId) {
  return db.table("automation_jobs").find((j) => j.id === id && j.user_id === userId);
}

/**
 * Puts a trigger event in the outbox AND makes the next claim return it.
 *
 * Both halves matter. Phase 2C moved rule matching into
 * public.realtoros_rules_for_event, which takes an event ID and READS THE
 * EVENT FROM THE TABLE - so a test that only faked the claim would hand the
 * worker an event the matcher cannot see, and every rule would silently
 * fail to match. In production the claim returns rows it has just updated
 * in that table, so seeding it is the faithful thing to do.
 */
export function claimEvent(db, row) {
  const event = Object.assign({
    id: randomUUID(),
    user_id: OWNER,
    workspace_id: WORKSPACE,
    contact_id: CONTACT,
    event_type: "contact_created",
    old_status: null,
    new_status: "New Lead",
    status: "processing",
    attempts: 1,
    max_attempts: 5,
    lock_token: randomUUID(),
    rule_id: null,
    event_key: null,
    payload: {},
  }, row || {});
  db.table("automation_trigger_events").push(event);
  db.rpc("realtoros_claim_trigger_events", () => [event]);
  return event;
}

export function installAutomationRpcs(db) {
  db.rpc("realtoros_recover_stale_automation_leases", () => ({ recovered_events: 0, failed_events: 0, recovered_jobs: 0, failed_jobs: 0 }));
  db.rpc("realtoros_claim_trigger_events", () => []);

  // Phase 2C. Mirrors public.realtoros_rules_for_event: the event names its
  // workspace, every candidate rule must be active in that workspace, and
  // automation_internal.rule_targets_contact decides whether the rule may
  // act on that particular contact. Kept faithful rather than permissive -
  // a fake that matched more than the database would hide the very bug 2C
  // fixed.
  const DETECTED = new Set(["follow_up_due", "no_contact", "status_stale"]);
  const STATUSES = new Set(["New Lead", "Qualified", "Nurturing", "Client", "Past Client", "Lost"]);

  const targetsContact = (rule, contactId) => {
    const contact = db.table("contacts").find(
      (c) => c.id === contactId && c.workspace_id === rule.workspace_id);
    if (!contact) return false;
    if (rule.visibility !== "personal") return true;
    const tm = db.table("team_members").find(
      (t) => t.workspace_id === rule.workspace_id && t.auth_user_id === rule.user_id);
    if (tm && contact.assigned_to_id === tm.id) return true;
    return contact.assigned_to_id == null && contact.user_id === rule.user_id;
  };

  db.rpc("realtoros_rules_for_event", (a) => {
    const event = db.table("automation_trigger_events").find((e) => e.id === a.p_event_id);
    if (!event) return [];
    const inScope = db.table("automation_rules").filter(
      (r) => r.workspace_id === event.workspace_id
        && r.status === "active"
        && targetsContact(r, event.contact_id));

    if (DETECTED.has(event.event_type)) {
      if (!event.rule_id) return [];
      return inScope
        .filter((r) => r.id === event.rule_id && r.trigger_type === event.event_type)
        .map((r) => r.id);
    }
    const payload = event.payload || {};
    return inScope.filter((r) => {
      if (event.event_type === "contact_created") {
        return r.trigger_type === "contact_created"
          || (r.trigger_type === "new_lead" && event.new_status === "New Lead");
      }
      if (event.event_type === "contact_status_changed") {
        return r.trigger_type === "contact_status_changed"
          && event.old_status !== event.new_status
          && STATUSES.has(event.new_status)
          && (r.audience_filter || {}).status_equals === event.new_status;
      }
      if (event.event_type === "deal_stage_changed") {
        const cfg = r.trigger_config || {};
        if (r.trigger_type !== "deal_stage_changed") return false;
        if (typeof cfg.to_stage === "string" && cfg.to_stage !== payload.new_stage) return false;
        if (typeof cfg.side === "string" && cfg.side !== payload.side) return false;
        return true;
      }
      return false;
    }).map((r) => r.id);
  });

  // The reminder scan notifies people; it is not part of any existing
  // assertion, so the default answer is "nothing to report".
  db.rpc("realtoros_scan_follow_up_reminders", () => ({
    untouched_notified: 0, escalated: 0, summaries: 0,
  }));
  db.rpc("realtoros_claim_due_jobs", () => {
    const claimed = [];
    for (const j of db.table("automation_jobs")) {
      const enr = db.table("automation_enrollments").find((e) => e.id === j.enrollment_id);
      const rule = db.table("automation_rules").find((r) => r.id === j.rule_id);
      if (j.status !== "pending" || j.attempts >= j.max_attempts) continue;
      if (!enr || enr.status !== "active" || !rule || rule.status !== "active") continue;
      j.status = "processing";
      j.lock_token = randomUUID();
      j.attempts += 1;
      db.table("automation_runs").push({ job_id: j.id, attempt_number: j.attempts, status: "processing" });
      claimed.push(structuredClone(j));
    }
    return claimed;
  });

  db.rpc("realtoros_reschedule_job", (a) => {
    const j = jobById(db, a.p_job_id, a.p_user_id);
    if (!j) return { outcome: "not_found" };
    if (j.lock_token !== a.p_lock_token) return { outcome: "stale_lock" };
    j.last_error = a.p_error_message;
    j.last_error_code = a.p_error_code;
    j.lock_token = null;
    if (a.p_retriable && j.attempts < j.max_attempts) {
      j.status = "pending";
      j.scheduled_at = a.p_next_retry_at;
      return { outcome: "rescheduled" };
    }
    j.status = "failed";
    return { outcome: "failed_final" };
  });
  db.rpc("realtoros_complete_job_and_advance", (a) => {
    const j = jobById(db, a.p_job_id, a.p_user_id);
    if (!j) return { outcome: "not_found" };
    if (j.lock_token !== a.p_lock_token) return { outcome: "stale_lock" };
    j.status = "completed";
    j.lock_token = null;
    return { outcome: "completed_no_advance" };
  });
  db.rpc("realtoros_cancel_claimed_job", (a) => {
    const j = jobById(db, a.p_job_id, a.p_user_id);
    if (!j) return { outcome: "not_found" };
    if (j.status !== "processing") return { outcome: "not_processing" };
    if (j.lock_token !== a.p_lock_token) return { outcome: "stale_lock" };
    j.status = "cancelled";
    j.lock_token = null;
    return { outcome: "cancelled" };
  });
  db.rpc("realtoros_stop_enrollment", (a) => {
    const e = db.table("automation_enrollments").find((x) => x.id === a.p_enrollment_id && x.user_id === a.p_user_id);
    if (e && ["active", "paused"].includes(e.status)) Object.assign(e, { status: "stopped", stop_reason: a.p_reason });
    for (const j of db.table("automation_jobs")) {
      if (j.enrollment_id === a.p_enrollment_id && j.status === "pending") j.status = "cancelled";
    }
    return { outcome: "stopped" };
  });
  db.rpc("realtoros_stop_enrollment_on_event", (a) => stopEnrollmentOnEvent(db, a));
  db.rpc("realtoros_check_enrollment_eligibility", (a) => checkEligibility(db, a));
  db.rpc("realtoros_presend_guard", (a) => presendGuard(db, a));
  db.rpc("realtoros_record_contact_stop_event", (a) => recordContactStopEvent(db, a));
  db.rpc("realtoros_mark_reply_hot", (a) => markReplyHot(db, a));
  db.rpc("realtoros_skip_claimed_job", (a) => {
    if (!["contact_unsubscribed", "consent_revoked", "suppressed"].includes(a.p_reason)) throw new Error("invalid skip reason");
    const j = jobById(db, a.p_job_id, a.p_user_id);
    if (!j) return { outcome: "not_found" };
    if (j.status !== "processing") return { outcome: "not_processing" };
    if (j.lock_token !== a.p_lock_token) return { outcome: "stale_lock" };
    if (j.job_type !== "send_email") return { outcome: "not_email" };
    j.skipped_reason = a.p_reason;
    j.status = "completed";
    j.lock_token = null;
    return { outcome: "completed_no_advance", skipped_reason: a.p_reason };
  });
}

// Mirrors public.realtoros_record_contact_stop_event (Phase 4E.2 migration,
// section 4) closely enough to test callers: validation, idempotency on
// (user, source, ref), lifecycle markers, consent, suppression, one
// activity, and rule-flag enrollment stops. db.lockBusy (a Set of
// enrollment ids) simulates a lock_timeout -> 'retry'.
export function recordContactStopEvent(db, a) {
  const types = ["reply", "unsubscribe", "complaint", "hard_bounce"];
  const sources = ["provider_webhook", "unsubscribe_link", "inbound_email", "owner_manual"];
  if (!types.includes(a.p_event_type)) throw new Error("invalid contact stop event type");
  if (!sources.includes(a.p_source)) throw new Error("invalid contact stop event source");
  const ok = (a.p_event_type === "reply" && ["inbound_email", "owner_manual", "provider_webhook"].includes(a.p_source))
    || (a.p_event_type === "unsubscribe" && ["unsubscribe_link", "owner_manual", "provider_webhook", "inbound_email"].includes(a.p_source))
    || (["complaint", "hard_bounce"].includes(a.p_event_type) && a.p_source === "provider_webhook");
  if (!ok) throw new Error("invalid contact stop event source for this event type");
  if (typeof a.p_event_ref !== "string" || !a.p_event_ref || a.p_event_ref.length > 200) throw new Error("invalid contact stop event reference");
  if (db.contactLockBusy) return { outcome: "retry", recorded: false };
  const c = db.table("contacts").find((x) => x.id === a.p_contact_id && x.user_id === a.p_user_id);
  if (!c) return { outcome: "contact_not_found", recorded: false };
  const prior = db.table("contact_stop_events").find((x) => x.user_id === a.p_user_id && x.source === a.p_source && x.event_ref === a.p_event_ref);
  if (prior) return { ...prior.result, outcome: "duplicate" };
  let recipient = null;
  if (a.p_outbound_message_id) {
    const m = db.table("outbound_messages").find((x) => x.id === a.p_outbound_message_id && x.user_id === a.p_user_id && x.contact_id === a.p_contact_id);
    if (!m) return { outcome: "message_mismatch", recorded: false };
    recipient = m.recipient;
  }
  const at = a.p_occurred_at ?? new Date().toISOString();
  let first = false;
  if (a.p_event_type === "reply") {
    if (!c.reply_detected_at || c.reply_detected_at > at) { first = !c.reply_detected_at; c.reply_detected_at = at; }
  } else if (a.p_event_type !== "hard_bounce") {
    if (!c.unsubscribe_detected_at || c.unsubscribe_detected_at > at) { first = !c.unsubscribe_detected_at; c.unsubscribe_detected_at = at; }
  }
  let consentRevoked = false;
  if (["unsubscribe", "complaint"].includes(a.p_event_type)) {
    const existing = db.table("communication_consents").find((x) => x.user_id === a.p_user_id && x.contact_id === a.p_contact_id && x.channel === "email");
    if (!existing) db.table("communication_consents").push({ user_id: a.p_user_id, contact_id: a.p_contact_id, channel: "email", status: "opted_out", source: a.p_source });
    else if (existing.status !== "opted_out") Object.assign(existing, { status: "opted_out", source: a.p_source });
    consentRevoked = true;
  }
  const supReason = { unsubscribe: "unsubscribe", complaint: "complaint", hard_bounce: "bounce" }[a.p_event_type];
  let supAdded = false;
  if (supReason) {
    const norm = String(recipient ?? c.email ?? "").trim().toLowerCase();
    if (norm.includes("@") && !db.table("email_suppressions").some((s) => s.user_id === a.p_user_id && s.normalized_email === norm && s.is_active)) {
      db.table("email_suppressions").push({ id: randomUUID(), user_id: a.p_user_id, normalized_email: norm, reason: supReason, is_active: true, source_message_id: a.p_outbound_message_id ?? null });
      supAdded = true;
    }
  }
  const actId = `automation-stop-${a.p_event_type}-${a.p_contact_id}`;
  if (!db.table("activities").some((x) => x.id === actId)) {
    db.table("activities").push({ id: actId, user_id: a.p_user_id, contact_id: a.p_contact_id, type: a.p_event_type === "reply" ? "Email" : "Note", subject: `stop:${a.p_event_type}`, notes: `source:${a.p_source}` });
  }
  let stopped = 0, jobs = 0, continuing = 0, retry = false;
  if (a.p_event_type !== "hard_bounce") {
    const reason = a.p_event_type;
    const open = db.table("automation_enrollments")
      .filter((e) => e.user_id === a.p_user_id && e.contact_id === a.p_contact_id && ["active", "paused"].includes(e.status))
      .sort((x, y) => (x.id < y.id ? -1 : 1));
    for (const e of open) {
      const r = db.table("automation_rules").find((x) => x.id === e.rule_id);
      const applies = reason === "reply" ? r.stop_on_reply : r.stop_on_unsubscribe;
      if (!applies) { continuing++; continue; }
      const out = stopEnrollmentOnEvent(db, { p_user_id: a.p_user_id, p_enrollment_id: e.id, p_reason: reason, p_contact_id: a.p_contact_id });
      if (out.reason === "retry") retry = true;
      else if (out.enrollment_stopped) { stopped++; jobs += out.jobs_cancelled; }
    }
  }
  const result = {
    recorded: true, event_type: a.p_event_type, first_occurrence: first, consent_revoked: consentRevoked,
    suppression_added: supAdded, enrollments_stopped: stopped, jobs_cancelled: jobs, enrollments_continuing: continuing,
  };
  if (retry) return { ...result, outcome: "retry" };
  const event = { id: randomUUID(), user_id: a.p_user_id, contact_id: a.p_contact_id, event_type: a.p_event_type, source: a.p_source, event_ref: a.p_event_ref, result };
  db.table("contact_stop_events").push(event);
  notifyOnStopEvent(db, event);
  return { ...result, outcome: "recorded" };
}

// Mirrors the Phase 4H trigger on contact_stop_events: one notification per
// applied event (dedupe 'stop:<event id>'), none for the owner's own
// reply / unsubscribe. Titles are simplified; the SQL tests check wording.
function notifyOnStopEvent(db, ev) {
  if (ev.source === "owner_manual" && ["reply", "unsubscribe"].includes(ev.event_type)) return;
  const type = { reply: "lead_replied", unsubscribe: "unsubscribed", complaint: "spam_report", hard_bounce: "email_bounced" }[ev.event_type];
  const key = `stop:${ev.id}`;
  if (db.table("notifications").some((n) => n.user_id === ev.user_id && n.dedupe_key === key)) return;
  db.table("notifications").push({
    id: randomUUID(), user_id: ev.user_id, type, title: `${type}`, contact_id: ev.contact_id,
    dedupe_key: key, metadata: { event_type: ev.event_type, source: ev.source }, read_at: null,
  });
}

// Mirrors public.realtoros_mark_reply_hot (Phase 4H): the reply's own
// notification becomes hot_reply; idempotent; created if missing.
export function markReplyHot(db, a) {
  const reasons = ["viewing", "offer", "ready", "financing", "call_request", "availability", "price"];
  if (!reasons.includes(a.p_reason)) throw new Error("invalid hot reply reason");
  const ev = db.table("contact_stop_events").find((x) => x.user_id === a.p_user_id && x.source === "inbound_email"
    && x.event_type === "reply" && x.event_ref === a.p_event_ref);
  if (!ev) return { outcome: "no_reply_event" };
  const key = `stop:${ev.id}`;
  const n = db.table("notifications").find((x) => x.user_id === a.p_user_id && x.dedupe_key === key);
  if (n) Object.assign(n, { type: "hot_reply", metadata: { ...n.metadata, hot_reason: a.p_reason } });
  else db.table("notifications").push({ id: randomUUID(), user_id: a.p_user_id, type: "hot_reply", contact_id: ev.contact_id, dedupe_key: key, metadata: { hot_reason: a.p_reason }, read_at: null });
  return { outcome: "marked", reason: a.p_reason };
}

// Mirrors public.realtoros_presend_guard (Phase 4E.2 migration, section 5).
export function presendGuard(db, a) {
  const j = jobById(db, a.p_job_id, a.p_user_id);
  if (!j) return { blocked: true, action: "abort", reason: "job_not_found" };
  if (j.status !== "processing" || j.lock_token !== a.p_lock_token) return { blocked: true, action: "abort", reason: "lock_lost" };
  const e = db.table("automation_enrollments").find((x) => x.id === j.enrollment_id && x.user_id === a.p_user_id);
  if (!e || e.status !== "active") return { blocked: true, action: "cancel", reason: "enrollment_inactive" };
  const c = db.table("contacts").find((x) => x.id === j.contact_id && x.user_id === a.p_user_id);
  if (!c) return { blocked: true, action: "cancel", reason: "contact_not_found" };
  const r = db.table("automation_rules").find((x) => x.id === j.rule_id && x.user_id === a.p_user_id);
  if (!r) return { blocked: true, action: "cancel", reason: "rule_not_found" };
  if (c.reply_detected_at && r.stop_on_reply) return { blocked: true, action: "stop", reason: "contact_replied", stop_reason: "reply" };
  if (c.unsubscribe_detected_at && r.stop_on_unsubscribe) return { blocked: true, action: "stop", reason: "contact_unsubscribed", stop_reason: "unsubscribe" };
  if (j.job_type !== "send_email") return { blocked: false, action: "none", reason: null };
  const norm = String(c.email ?? "").trim().toLowerCase();
  if (norm && db.table("email_suppressions").some((s) => s.user_id === a.p_user_id && s.normalized_email === norm && s.is_active)) {
    return { blocked: true, action: "skip", reason: "suppressed" };
  }
  if (db.table("communication_consents").some((s) => s.user_id === a.p_user_id && s.contact_id === j.contact_id && s.channel === "email" && s.status === "opted_out")) {
    return { blocked: true, action: "skip", reason: "consent_revoked" };
  }
  if (c.unsubscribe_detected_at) return { blocked: true, action: "skip", reason: "contact_unsubscribed" };
  return { blocked: false, action: "none", reason: null };
}

export function stopEnrollmentOnEvent(db, a) {
  if (db.lockBusy?.has(a.p_enrollment_id)) {
    return { enrollment_stopped: false, jobs_cancelled: 0, reason: "retry" };
  }
  const e = db.table("automation_enrollments").find((x) => x.id === a.p_enrollment_id && x.user_id === a.p_user_id);
  if (!e) return { enrollment_stopped: false, jobs_cancelled: 0, reason: "not_found" };
  if (a.p_contact_id && e.contact_id !== a.p_contact_id) return { enrollment_stopped: false, jobs_cancelled: 0, reason: "contact_mismatch" };
  if (!["active", "paused"].includes(e.status)) return { enrollment_stopped: false, jobs_cancelled: 0, reason: "already_terminal" };
  Object.assign(e, { status: "stopped", stop_reason: a.p_reason, stopped_at: new Date().toISOString() });
  let n = 0;
  for (const j of db.table("automation_jobs")) {
    if (j.enrollment_id === e.id && j.status === "pending") {
      Object.assign(j, { status: "cancelled", cancelled_reason: a.p_reason, cancelled_at: new Date().toISOString() });
      n++;
    }
  }
  return { enrollment_stopped: true, jobs_cancelled: n, reason: a.p_reason };
}

export function checkEligibility(db, a) {
  const c = db.table("contacts").find((x) => x.id === a.p_contact_id && x.user_id === a.p_user_id);
  if (!c) return { eligible: false, block_reason: "contact_not_found" };
  const r = db.table("automation_rules").find((x) => x.id === a.p_rule_id && x.user_id === a.p_user_id);
  if (!r) return { eligible: false, block_reason: "rule_not_found" };
  const norm = String(c.email ?? "").trim().toLowerCase();
  if (norm && db.table("email_suppressions").some((s) => s.user_id === a.p_user_id && s.normalized_email === norm && s.is_active)) {
    return { eligible: false, block_reason: "suppressed" };
  }
  if (db.table("communication_consents").some((s) => s.user_id === a.p_user_id && s.contact_id === a.p_contact_id && s.channel === "email" && s.status === "opted_out")) {
    return { eligible: false, block_reason: "consent_revoked" };
  }
  if (c.unsubscribe_detected_at && r.stop_on_unsubscribe) return { eligible: false, block_reason: "contact_unsubscribed" };
  if (c.reply_detected_at && r.stop_on_reply) return { eligible: false, block_reason: "contact_replied" };
  if (db.table("automation_enrollments").some((e) => e.user_id === a.p_user_id && e.rule_id === a.p_rule_id && e.contact_id === a.p_contact_id && ["active", "paused"].includes(e.status))) {
    return { eligible: false, block_reason: "duplicate_enrollment" };
  }
  return { eligible: true, block_reason: null };
}

// Minimal fetch double for the provider API. Every call is recorded; the
// responder decides the reply.
export function mockFetch(responder = () => new Response(JSON.stringify({ id: "re_msg_123" }), { status: 200 })) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    // `body` is the parsed JSON for the callers that post JSON (Resend),
    // and null for the ones that post bytes (Phase 3B pushes an
    // encrypted payload). Parsing used to be unguarded, which turned a
    // binary body into a thrown TypeError inside whatever was calling
    // fetch - a failure that looked like the push service refusing.
    let body = null;
    if (typeof init.body === "string") {
      try { body = JSON.parse(init.body); } catch { body = null; }
    }
    calls.push({ url: String(url), init, body });
    return responder(String(url), init);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

export function workerRequest(secret = WORKER_SECRET) {
  return new Request("https://unit-test.supabase.co/functions/v1/process-automation", {
    method: "POST",
    headers: { "x-realtoros-worker-secret": secret },
  });
}
