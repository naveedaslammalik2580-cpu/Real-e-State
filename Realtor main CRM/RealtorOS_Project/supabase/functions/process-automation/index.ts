// process-automation — Phase 4D (reliability correction) + Phase 4E
// lifecycle stop guards.
// Machine-only (verify_jwt = false). No Supabase user JWT is ever involved
// — this is invoked by a scheduled job, never a browser — so it instead
// authenticates every request itself via a timing-safe comparison against
// AUTOMATION_WORKER_SECRET, read from a dedicated header. Not deployed or
// scheduled in this phase; this file only implements the engine.
//
// Per invocation: recover stale leases -> process a bounded batch of
// trigger events -> claim a bounded batch of due jobs -> process each job
// independently (one job's failure never blocks another) -> return only
// aggregate, non-secret counts that distinguish completed / rescheduled /
// cancelled / terminally-failed / errored outcomes (never counting a
// rescheduled or failed job as succeeded). Never logs the worker secret or
// any provider/API key, and never returns internal error detail to the
// caller.
//
// Phase 4E / 4E.2 lifecycle guards. No existing authentication, locking,
// lease-recovery, retry, idempotency-key or run-invariant behaviour is
// changed:
//   * before creating an enrollment, the contact is checked against
//     realtoros_check_enrollment_eligibility (suppression, revoked
//     consent, a detected unsubscribe/reply on a rule that stops for it,
//     and duplicate prevention);
//   * a stop event cancels only PENDING jobs, so every CLAIMED job is
//     checked with realtoros_presend_guard (lock-token aware) before it
//     runs — and, for an email, again immediately before the provider
//     call. The guard's action decides the outcome: cancel the job, stop
//     the whole sequence, or skip just the email step (unsubscribe on a
//     rule with stop_on_unsubscribe = false, a blocked address, or revoked
//     consent) so later non-email steps still run;
//   * if the provider already accepted this job's message on an earlier
//     attempt, that outcome is recorded normally even if a stop has since
//     landed. A sent message is never treated as unsent.
//
// Every trigger-event transition after claim goes through a lock-token-
// guarded RPC (realtoros_complete_trigger_event /
// realtoros_reschedule_trigger_event / realtoros_fail_trigger_event) —
// this file never writes to automation_trigger_events directly. Every
// {data, error} result from every select/insert/update/RPC call is
// checked; an unexpected/unknown RPC outcome is never treated as success.
import {
  createAdminClient,
  corsHeaders,
  jsonResponse,
  sha256Hex,
} from "../_shared/runtime.ts";
import {
  createUnsubscribeToken,
  isUsableSecret,
  TOKEN_LIFETIME_SECONDS,
  unsubscribeLinks,
} from "../_shared/unsubscribe-token.ts";
import { normalizeInboundDomain, replyAddress, replyTokenFor } from "../_shared/reply-detection.ts";
import { buildPayload, sendPush, vapidFromEnv } from "../_shared/push.ts";

// Plain-text footer on every automated email. Fixed wording, appended
// after rendering — not a template field.
export function withUnsubscribeFooter(body: string, unsubscribeUrl: string): string {
  return `${body.replace(/\s+$/, "")}\n\n--\nDon't want these emails? Unsubscribe here: ${unsubscribeUrl}\n`;
}

/* ---------- Phase 3B: pushing notifications ----------
 *
 * Held to exactly the same rule as the Phase 2A detector and the 2C
 * reminder scan that run beside it: this only tells people about work,
 * so it must never be the reason mail already scheduled fails to go
 * out. Every failure is counted and swallowed.
 *
 * NOTHING LOGGED. Not the endpoint (it is a device address), not the
 * title or body (they are about a contact), not the keys. The counters
 * returned are numbers only.
 */
export async function runPushBatch(
  admin: ReturnType<typeof createAdminClient>,
  counters: { pushSent: number; pushFailed: number; pushSkipped: number; pushStepFailed: number },
): Promise<void> {
  const vapid = vapidFromEnv((name) => Deno.env.get(name));
  // No keys configured yet: the app ships before they exist, rows stay
  // pending, and this is not a failure to report.
  if (!vapid) return;

  const { data, error } = await admin.rpc("realtoros_claim_push_batch", {
    p_limit: PUSH_BATCH_SIZE,
  });
  if (error || !isPlainObject(data)) {
    counters.pushStepFailed = 1;
    return;
  }
  counters.pushSkipped += typeof data.skipped === "number" ? data.skipped : 0;

  const claimed = Array.isArray(data.claimed) ? data.claimed : [];
  for (const item of claimed) {
    if (!isPlainObject(item)) continue;
    const id = typeof item.id === "string" ? item.id : null;
    const subscriptions = Array.isArray(item.subscriptions) ? item.subscriptions : [];
    if (!id) continue;

    const payload = buildPayload(item as Record<string, unknown>);
    const dead: string[] = [];
    let anyAccepted = false;

    for (const sub of subscriptions) {
      if (!isPlainObject(sub)) continue;
      const endpoint = typeof sub.endpoint === "string" ? sub.endpoint : "";
      const p256dh = typeof sub.p256dh === "string" ? sub.p256dh : "";
      const auth = typeof sub.auth === "string" ? sub.auth : "";
      if (!endpoint || !p256dh || !auth) continue;
      const result = await sendPush({ endpoint, p256dh, auth }, payload, vapid);
      // One device accepting is enough for the notification to have
      // arrived; the others are the device list's problem, not this
      // notification's.
      if (result.ok) anyAccepted = true;
      else if (result.dead) dead.push(endpoint);
    }

    const outcome = anyAccepted ? "sent" : "failed";
    try {
      await admin.rpc("realtoros_complete_push", {
        p_notification_id: id,
        p_outcome: outcome,
        p_dead_endpoints: dead.length ? dead : null,
      });
    } catch {
      // The lease expires on its own, so an unreported result is a
      // retry rather than a lost notification.
    }
    if (anyAccepted) counters.pushSent++; else counters.pushFailed++;
  }
}

const WORKER_SECRET_HEADER = "x-realtoros-worker-secret";
const STALE_LEASE_SECONDS = 300;
const EVENT_BATCH_SIZE = 25;
// Phase 2A. How many detected occurrences one run may create. Bounded so a
// first scan over a large workspace cannot produce an unbounded burst of
// work in a single run; whatever is left is picked up next run.
const TIME_SCAN_LIMIT = 500;
const JOB_BATCH_SIZE = 25;
// Phase 3B. How many notifications one run may push. Small: each one is
// a POST per device to somebody else's server, and the worker's job is
// mail first.
const PUSH_BATCH_SIZE = 20;
const RESEND_TIMEOUT_MS = 10_000;
const EVENT_RETRY_BACKOFF_SECONDS = 60;
const AMBIGUOUS_RETRY_BACKOFF_SECONDS = 60;
// Resend retains an Idempotency-Key for 24 hours. This cutoff is
// deliberately well inside that window — once a message's first provider
// attempt is older than this, this worker makes zero further Resend calls
// for it, no matter what.
const SAFE_IDEMPOTENCY_WINDOW_MS = 20 * 60 * 60 * 1000;
const CONTROL_CHARS = /[\x00-\x1F\x7F]/;
const EMAIL_SHAPE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const DOMAIN_SHAPE =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const PROVIDER_ID_MAX = 128;
const PROVIDER_ID_SHAPE = /^[A-Za-z0-9_.-]+$/;
// Defense-in-depth mirror of the same allowlist enforced at activation
// preflight (manage-automation) and at the browser/data layer
// (data-service.js) — the only contact statuses this app supports.

// Every status outbound_messages_status_check accepts is classified here,
// exhaustively, and an existing automation message is dispatched on that
// classification BEFORE any provider call is even considered. Anything not
// listed is unknown and fails closed with zero provider calls.
//
// Confirmed accepted by the provider: the send already happened. Never send
// again — 'delivery_delayed' in particular is the provider holding an
// ACCEPTED message in its own queue, not an invitation to resend.
const ACCEPTED_MESSAGE_STATUSES = new Set(["sent", "delivery_delayed", "delivered", "opened", "clicked", "replied"]);
// The provider accepted the message and the recipient side later rejected
// it. The send HAPPENED, so the job is recorded as sent (never re-sent,
// never marked unsent); the recipient-level block is applied by the stop
// pipeline and enforced for later jobs by realtoros_presend_guard.
// 'suppressed' is handled separately: the provider declined to deliver.
const RECIPIENT_REJECTED_AFTER_SEND_STATUSES = new Set(["bounced", "complained", "unsubscribed"]);
// Negative/terminal for this job: a definitive provider rejection, or a
// delivery that could never be safely confirmed inside the idempotency
// window. Never sent again; the message status is preserved untouched.
const JOB_TERMINAL_MESSAGE_STATUSES = new Set(["failed", "unconfirmed"]);
// The only status from which a message may legitimately reach the provider
// retry path.
const RETRYABLE_MESSAGE_STATUS = "queued";

// Plain-language explanations for a contact that could not be enrolled.
const ENROLL_BLOCK_NOTES: Record<string, string> = {
  suppressed: "Email to this address is blocked, so this contact was not added to the automation.",
  consent_revoked: "This contact has opted out of email, so they were not added to the automation.",
  contact_unsubscribed: "This contact unsubscribed, so they were not added to the automation.",
  contact_replied: "This contact already replied, and this automation stops when a contact replies, so they were not added.",
};

type AdminClient = ReturnType<typeof createAdminClient>;

function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function isValidDomain(value: string): boolean {
  return value.length > 0 && value.length <= 253 && DOMAIN_SHAPE.test(value);
}
function isValidProviderMessageId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed === value && trimmed.length > 0 && trimmed.length <= PROVIDER_ID_MAX && PROVIDER_ID_SHAPE.test(trimmed);
}
function senderAliasFor(userId: string): string {
  const hex = userId.replace(/[^a-f0-9]/gi, "").toLowerCase();
  return `agent-${hex.slice(0, 12)}`;
}
async function deterministicUuid(seed: string): Promise<string> {
  const hex = (await sha256Hex(seed)).slice(0, 32);
  const version4 = "4" + hex.slice(13, 16);
  const variantNibble = "89ab"[parseInt(hex[16], 16) % 4];
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${version4}-${variantNibble}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function renderMergeText(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_match, tag: string) => values[tag] ?? "");
}
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function todayInTimezone(timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(new Date());
  }
}
// Never trusts a raw Postgres/PostgREST error shape blindly — throws a
// plain Error carrying only a safe message, never headers or secrets.
function requireNoError(error: unknown, context: string): void {
  if (error) throw new Error(`${context}_failed`);
}
// Classifies a non-2xx provider response. `retriable: true` means the real
// delivery outcome is UNKNOWN, so the message must stay in its retryable
// 'queued' state and be re-attempted with the SAME Idempotency-Key — it is
// never marked failed. Only a definitive, parseable, non-retryable
// rejection returns `retriable: false`.
function classifyResendError(
  status: number,
  body: unknown,
  bodyParsed: boolean,
): { code: string; retriable: boolean; category: string; delaySeconds: number } {
  const name = isPlainObject(body) && typeof (body as { name?: unknown }).name === "string"
    ? (body as { name: string }).name
    : "";
  // Definitive, non-retryable: the request itself is malformed or conflicts
  // with a different payload under the same key, and will never succeed as
  // sent. These are the only named errors allowed to be terminal.
  if (name === "invalid_idempotent_request") {
    return { code: "invalid_idempotent_request", retriable: false, category: "validation", delaySeconds: 0 };
  }
  if (name === "invalid_idempotency_key") {
    return { code: "invalid_idempotency_key", retriable: false, category: "validation", delaySeconds: 0 };
  }
  // Another request for this exact key is in flight right now — the send may
  // be succeeding as we speak. Always retryable, never terminal.
  if (name === "concurrent_idempotent_requests") {
    return { code: "concurrent_idempotent_requests", retriable: true, category: "provider", delaySeconds: 60 };
  }
  if (status === 429) {
    return { code: "provider_rate_limited", retriable: true, category: "rate_limit", delaySeconds: 120 };
  }
  if (status >= 500) {
    return { code: "provider_error", retriable: true, category: "provider", delaySeconds: 120 };
  }
  // A 4xx whose body could not be parsed is ambiguous, not definitive: it
  // is not safe to conclude the message was rejected, so it stays
  // retryable behind the same idempotency key.
  if (!bodyParsed) {
    return { code: "provider_response_unparsed", retriable: true, category: "provider", delaySeconds: 120 };
  }
  // A definitive, parseable, non-retryable 4xx rejection.
  return { code: "provider_rejected", retriable: false, category: "validation", delaySeconds: 0 };
}

// Returns the value unchanged only if it is a non-empty string that parses
// to a real instant; otherwise null. Used to validate a timestamp read back
// from the database before any safety decision is based on it.
export function persistedTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return Number.isFinite(new Date(value).getTime()) ? value : null;
}

// Persists outbound_messages.first_provider_attempt_at exactly once for an
// existing queued automation message, and VERIFIES the database write
// before the caller is permitted to judge the safety window against it.
//
// Using a fresh in-memory `new Date()` on every retry instead would push
// the effective 20-hour cutoff forward on each attempt, so the window would
// never close and an ambiguous message could be retried against the
// provider forever, long past the point where the idempotency key is
// guaranteed to still de-duplicate it.
async function ensureFirstProviderAttemptAt(
  admin: AdminClient,
  job: JobRow,
  messageId: string,
  current: unknown,
): Promise<{ ok: true; value: string } | { ok: false; errorCode: string }> {
  const existing = persistedTimestamp(current);
  if (existing !== null) return { ok: true, value: existing };

  const nowIso = new Date().toISOString();
  // `.is("first_provider_attempt_at", null)` makes this strictly
  // write-once: a non-null value is never overwritten, not by this worker
  // and not by a concurrent one.
  const { error: stampError } = await admin
    .from("outbound_messages")
    .update({ first_provider_attempt_at: nowIso })
    .eq("id", messageId).eq("user_id", job.user_id)
    .is("first_provider_attempt_at", null);
  if (stampError) return { ok: false, errorCode: "first_attempt_stamp_failed" };

  // Read the authoritative persisted value back — this both verifies the
  // write and yields the winning value if a concurrent worker stamped it
  // first. There is deliberately no in-memory fallback.
  const { data: verified, error: verifyError } = await admin
    .from("outbound_messages")
    .select("first_provider_attempt_at")
    .eq("id", messageId).eq("user_id", job.user_id).maybeSingle();
  const verifiedValue = verified ? persistedTimestamp(verified.first_provider_attempt_at) : null;
  if (verifyError || verifiedValue === null) {
    return { ok: false, errorCode: "first_attempt_stamp_unverified" };
  }
  return { ok: true, value: verifiedValue };
}

// Phase 2A event types. The three detected ones always carry rule_id and
// event_key; the three real-world ones never carry rule_id.
type TriggerEventType =
  | "contact_created"
  | "contact_status_changed"
  | "follow_up_due"
  | "no_contact"
  | "status_stale"
  | "deal_stage_changed";


type TriggerEventRow = {
  id: string;
  user_id: string;
  workspace_id: string;
  contact_id: string;
  event_type: TriggerEventType;
  old_status: string | null;
  new_status: string | null;
  attempts: number;
  max_attempts: number;
  lock_token: string;
  // Phase 2A. Null for every pre-2A event.
  rule_id: string | null;
  event_key: string | null;
  payload: Record<string, unknown> | null;
};

type JobRow = {
  id: string;
  user_id: string;
  enrollment_id: string;
  rule_id: string;
  step_id: string | null;
  contact_id: string;
  job_type: "send_email" | "create_task" | "advance_enrollment";
  lock_token: string;
  attempts: number;
  max_attempts: number;
  payload: Record<string, unknown>;
};

type JobOutcome = "completed" | "rescheduled" | "cancelled" | "failed" | "skipped" | "abandoned";

function rpcOutcome(data: unknown): string | null {
  return isPlainObject(data) && typeof data.outcome === "string" ? data.outcome : null;
}

// Reschedules/fails a claimed JOB via the lock-token-guarded RPC and
// returns the actual, checked outcome — never assumed. A network/db-level
// error calling the RPC itself is thrown (the job's lock token is still
// valid either way, so a later stale-lease recovery or a fresh attempt
// remains safe).
async function rescheduleJob(
  admin: AdminClient,
  job: JobRow,
  opts: { retriable: boolean; category: string; errorCode: string; errorMessage: string; delaySeconds?: number },
): Promise<"rescheduled" | "failed"> {
  const nextRetryAt = new Date(Date.now() + (opts.delaySeconds ?? 60) * 1000).toISOString();
  const { data, error } = await admin.rpc("realtoros_reschedule_job", {
    p_user_id: job.user_id,
    p_job_id: job.id,
    p_lock_token: job.lock_token,
    p_next_retry_at: nextRetryAt,
    p_error_category: opts.category,
    p_error_code: opts.errorCode,
    p_error_message: opts.errorMessage,
    p_retriable: opts.retriable,
  });
  requireNoError(error, "reschedule_job_rpc");
  const outcome = rpcOutcome(data);
  if (outcome === "rescheduled") return "rescheduled";
  if (outcome === "failed_final") return "failed";
  // stale_lock / already_completed / not_found / anything unrecognized —
  // never silently assumed to be a successful reschedule.
  throw new Error(`reschedule_job_unexpected_outcome:${outcome ?? "null"}`);
}

async function cancelClaimedJob(admin: AdminClient, job: JobRow): Promise<"cancelled"> {
  const { data, error } = await admin.rpc("realtoros_cancel_claimed_job", {
    p_user_id: job.user_id,
    p_job_id: job.id,
    p_lock_token: job.lock_token,
  });
  requireNoError(error, "cancel_claimed_job_rpc");
  const outcome = rpcOutcome(data);
  if (outcome === "cancelled") return "cancelled";
  throw new Error(`cancel_claimed_job_unexpected_outcome:${outcome ?? "null"}`);
}

async function completeJobAndAdvance(admin: AdminClient, job: JobRow): Promise<void> {
  const { data, error } = await admin.rpc("realtoros_complete_job_and_advance", {
    p_user_id: job.user_id,
    p_job_id: job.id,
    p_lock_token: job.lock_token,
  });
  requireNoError(error, "complete_job_rpc");
  const outcome = rpcOutcome(data);
  const known = new Set(["advanced", "enrollment_completed", "completed_no_advance", "already_completed"]);
  if (!outcome || !known.has(outcome)) {
    // stale_lock / not_found / anything unrecognized: the job must NOT be
    // treated as completed by the caller — surface it as an error so the
    // outer loop reschedules for another attempt instead of silently
    // reporting success.
    throw new Error(`complete_job_unexpected_outcome:${outcome ?? "null"}`);
  }
}

// Writes one deterministic, PII-free activity row explaining a skipped
// enrollment or a stopped job. Deliberately best-effort and non-fatal: an
// explanatory note must never be the reason a stop or a skip fails. A
// duplicate id (23505) means an earlier attempt already wrote it.
async function recordStopActivity(
  admin: AdminClient,
  userId: string,
  contactId: string,
  activityId: string,
  subject: string,
  notes: string,
): Promise<void> {
  const { error } = await admin.from("activities").insert({
    id: activityId,
    user_id: userId,
    type: "Note",
    contact_id: contactId,
    subject,
    description: "",
    outcome: "Skipped",
    notes,
    date: new Date().toISOString(),
  });
  if (error && error.code !== "23505") {
    // Swallowed on purpose — see above. Never rethrown, never logged.
  }
}

type EligibilityResult = { eligible: boolean; blockReason: string };

// Shared by both Phase 4E guards. Throws (via requireNoError) only on a
// real database failure, so an unreadable eligibility answer is never
// silently read as "eligible".
async function checkEligibility(
  admin: AdminClient,
  userId: string,
  contactId: string,
  ruleId: string,
): Promise<EligibilityResult> {
  const { data, error } = await admin.rpc("realtoros_check_enrollment_eligibility", {
    p_user_id: userId,
    p_contact_id: contactId,
    p_rule_id: ruleId,
  });
  requireNoError(error, "check_enrollment_eligibility_rpc");
  if (!isPlainObject(data) || typeof data.eligible !== "boolean") {
    throw new Error("check_enrollment_eligibility_unexpected_result");
  }
  return {
    eligible: data.eligible,
    blockReason: typeof data.block_reason === "string" ? data.block_reason : "unknown",
  };
}

// Which rules this event starts.
//
// Phase 2C moved this decision into the database
// (public.realtoros_rules_for_event), for one reason: the two oldest event
// types still matched rules by the CREATOR's user_id, which predates
// workspaces, while Phase 2A's detector matched by workspace and
// visibility. Two different answers to "may this rule act on this contact"
// is how a teammate's lead quietly gets the wrong sequence — or none. There
// is now one definition, automation_internal.rule_targets_contact, and both
// the detector and this path go through it.
//
// Everything the matching needs is already on the event row, so this is one
// round trip rather than a query per rule.
async function matchingRulesForEvent(
  admin: AdminClient,
  event: TriggerEventRow,
): Promise<{ id: string }[]> {
  const { data, error } = await admin.rpc("realtoros_rules_for_event", {
    p_event_id: event.id,
  });
  requireNoError(error, "rules_for_event_rpc");
  // An empty list is a normal answer: nothing was interested in this event.
  if (!Array.isArray(data)) {
    throw new Error("rules_for_event_unexpected_result");
  }
  return data
    .filter((id): id is string => typeof id === "string")
    .map((id) => ({ id }));
}

async function processTriggerEvent(admin: AdminClient, event: TriggerEventRow, counters: Record<string, number>): Promise<void> {
  const matching = await matchingRulesForEvent(admin, event);

  let rateLimitedRetryAfter = 0;
  for (const rule of matching) {
    // Phase 4E pre-enrollment guard. realtoros_enroll_contact already
    // rejects a duplicate open enrollment and an inactive rule; this adds
    // the contact LIFECYCLE checks it cannot see — an active suppression,
    // revoked email consent, or a previously detected unsubscribe/reply on
    // a rule that stops for it. Blocked contacts are skipped with a
    // durable, human-readable explanation rather than silently.
    const eligibility = await checkEligibility(admin, event.user_id, event.contact_id, rule.id);
    if (!eligibility.eligible) {
      counters.enrollmentsBlocked++;
      await recordStopActivity(
        admin, event.user_id, event.contact_id,
        `automation-enroll-blocked-${rule.id}-${event.contact_id}`,
        "Contact not added to an automation",
        ENROLL_BLOCK_NOTES[eligibility.blockReason] ?? "This contact could not be added to the automation. No email was sent.",
      );
      continue;
    }

    const { data: claimData, error: claimError } = await admin.rpc("realtoros_enroll_contact", {
      p_user_id: event.user_id,
      p_rule_id: rule.id,
      p_contact_id: event.contact_id,
      p_trigger_event_id: event.id,
      // Phase 2A: a detected occurrence already has a stable key that
      // identifies the occurrence itself, so the enrollment carries that
      // rather than one derived from the event row's id. For every other
      // event type this is the pre-2A key, unchanged.
      p_trigger_event_key: event.event_key ?? `event:${event.id}:rule:${rule.id}`,
    });
    requireNoError(claimError, "enroll_contact_rpc");
    const outcome = rpcOutcome(claimData);
    if (outcome === "enrolled") {
      counters.enrollmentsCreated++;
    } else if (outcome === "rate_limited") {
      const retryAfter = isPlainObject(claimData) && typeof claimData.retry_after_seconds === "number"
        ? claimData.retry_after_seconds
        : 3600;
      rateLimitedRetryAfter = Math.max(rateLimitedRetryAfter, retryAfter);
    } else if (outcome !== "duplicate" && outcome !== "ineligible") {
      // An unrecognized outcome from an atomic enrollment attempt is never
      // silently treated as handled.
      throw new Error(`enroll_contact_unexpected_outcome:${outcome ?? "null"}`);
    }
  }

  if (rateLimitedRetryAfter > 0) {
    const { data, error } = await admin.rpc("realtoros_reschedule_trigger_event", {
      p_user_id: event.user_id,
      p_event_id: event.id,
      p_lock_token: event.lock_token,
      p_available_at: new Date(Date.now() + rateLimitedRetryAfter * 1000).toISOString(),
    });
    requireNoError(error, "reschedule_trigger_event_rpc");
    const outcome = rpcOutcome(data);
    if (outcome !== "rescheduled") throw new Error(`reschedule_trigger_event_unexpected_outcome:${outcome ?? "null"}`);
    counters.eventsRescheduled++;
    return;
  }

  const { data, error } = await admin.rpc("realtoros_complete_trigger_event", {
    p_user_id: event.user_id,
    p_event_id: event.id,
    p_lock_token: event.lock_token,
  });
  requireNoError(error, "complete_trigger_event_rpc");
  const outcome = rpcOutcome(data);
  if (outcome !== "completed") throw new Error(`complete_trigger_event_unexpected_outcome:${outcome ?? "null"}`);
  counters.eventsCompleted++;
}

// ---------------------------------------------------------------------
// Phase 4E.2 pre-send guard
// ---------------------------------------------------------------------
// realtoros_presend_guard is the authoritative, lock-token-aware check.
// A stop event only cancels PENDING jobs, so a job this worker has already
// claimed is protected by calling the guard at the start of the job and
// again immediately before any provider call.
type GuardAction = "none" | "abort" | "cancel" | "stop" | "skip";
type GuardDecision = { blocked: boolean; action: GuardAction; reason: string; stopReason: string | null };
const GUARD_ACTIONS = new Set<GuardAction>(["none", "abort", "cancel", "stop", "skip"]);
const STOP_REASONS = new Set(["reply", "unsubscribe", "complaint", "bounce", "suppression"]);
const SKIP_REASONS = new Set(["contact_unsubscribed", "consent_revoked", "suppressed"]);

async function presendGuard(admin: AdminClient, job: JobRow): Promise<GuardDecision> {
  const { data, error } = await admin.rpc("realtoros_presend_guard", {
    p_user_id: job.user_id,
    p_job_id: job.id,
    p_lock_token: job.lock_token,
  });
  requireNoError(error, "presend_guard_rpc");
  // Anything not positively recognized fails closed: the throw reaches the
  // outer handler, which reschedules the job without sending.
  if (
    !isPlainObject(data) || typeof data.blocked !== "boolean" || typeof data.action !== "string" ||
    !GUARD_ACTIONS.has(data.action as GuardAction) || data.blocked !== (data.action !== "none")
  ) {
    throw new Error("presend_guard_unexpected_result");
  }
  const action = data.action as GuardAction;
  const reason = typeof data.reason === "string" ? data.reason : "";
  const stopReason = typeof data.stop_reason === "string" ? data.stop_reason : null;
  if (action === "stop" && (!stopReason || !STOP_REASONS.has(stopReason))) throw new Error("presend_guard_bad_stop_reason");
  if (action === "skip" && (job.job_type !== "send_email" || !SKIP_REASONS.has(reason))) throw new Error("presend_guard_bad_skip");
  return { blocked: data.blocked, action, reason, stopReason };
}

const STOP_RETRY_ATTEMPTS = 3;
const STOP_RETRY_BASE_MS = 150;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Stops one enrollment through the blocking, lock_timeout-bounded RPC.
// 'retry' (a lock wait timed out) is retried a bounded number of times and
// is NEVER treated as success — the caller must not send in that case.
async function stopEnrollmentWithRetry(
  admin: AdminClient,
  job: JobRow,
  reason: string,
): Promise<"stopped" | "already_terminal" | "retry"> {
  for (let attempt = 1; attempt <= STOP_RETRY_ATTEMPTS; attempt++) {
    const { data, error } = await admin.rpc("realtoros_stop_enrollment_on_event", {
      p_user_id: job.user_id,
      p_enrollment_id: job.enrollment_id,
      p_reason: reason,
      p_contact_id: job.contact_id,
    });
    requireNoError(error, "stop_enrollment_on_event_rpc");
    if (!isPlainObject(data)) throw new Error("stop_enrollment_on_event_unexpected_result");
    if (data.enrollment_stopped === true) return "stopped";
    if (data.reason === "retry") {
      if (attempt < STOP_RETRY_ATTEMPTS) await sleep(STOP_RETRY_BASE_MS * attempt);
      continue;
    }
    if (data.reason === "already_terminal" || data.reason === "not_found" || data.reason === "contact_mismatch") {
      return "already_terminal";
    }
    throw new Error("stop_enrollment_on_event_unexpected_result");
  }
  return "retry";
}

async function skipClaimedJob(admin: AdminClient, job: JobRow, reason: string): Promise<void> {
  const { data, error } = await admin.rpc("realtoros_skip_claimed_job", {
    p_user_id: job.user_id,
    p_job_id: job.id,
    p_lock_token: job.lock_token,
    p_reason: reason,
  });
  requireNoError(error, "skip_claimed_job_rpc");
  const outcome = rpcOutcome(data);
  const known = new Set(["advanced", "enrollment_completed", "completed_no_advance", "already_completed"]);
  if (!outcome || !known.has(outcome)) throw new Error(`skip_claimed_job_unexpected_outcome:${outcome ?? "null"}`);
}

// A message row left 'queued' by an earlier attempt whose provider outcome
// was ambiguous, for a job that will now never be retried. It may or may
// not have been delivered, so it is marked 'unconfirmed' — never 'sent',
// never 'failed', never deleted.
async function closeUnresolvedQueuedMessage(admin: AdminClient, job: JobRow, messageId: string | null): Promise<void> {
  if (!messageId) return;
  const { error } = await admin.from("outbound_messages")
    .update({ status: "unconfirmed", error_code: "blocked_before_retry", error_message: "Not retried: the contact is no longer eligible for this follow-up." })
    .eq("id", messageId).eq("user_id", job.user_id).eq("status", "queued");
  requireNoError(error, "update_message_unconfirmed");
}

// Plain-language notes for the contact's activity timeline. No codes, no
// provider or system terminology.
const STOP_NOTES: Record<string, string> = {
  contact_replied: "This contact replied, so this automation stopped. No further follow-up was sent.",
  contact_unsubscribed: "This contact unsubscribed, so this automation stopped. No further follow-up was sent.",
};
const SKIP_NOTES: Record<string, string> = {
  contact_unsubscribed: "This contact unsubscribed, so the email step was skipped. Other steps continue.",
  consent_revoked: "This contact has opted out of email, so the email step was skipped. Other steps continue.",
  suppressed: "Email to this address is blocked, so the email step was skipped. Other steps continue.",
};

async function applyGuardDecision(
  admin: AdminClient,
  job: JobRow,
  decision: GuardDecision,
  queuedMessageId: string | null,
): Promise<JobOutcome> {
  if (decision.action === "abort") {
    // This worker no longer holds the job's lock (stale-lease recovery or
    // a newer claim). Touch nothing; whoever holds it now owns the outcome.
    return "abandoned";
  }
  if (decision.action === "cancel") {
    await closeUnresolvedQueuedMessage(admin, job, queuedMessageId);
    const outcome = await cancelClaimedJob(admin, job);
    await annotateCancelledJob(admin, job, decision.reason || "enrollment_inactive");
    return outcome;
  }
  if (decision.action === "stop") {
    const stopReason = decision.stopReason as string;
    const stopped = await stopEnrollmentWithRetry(admin, job, stopReason);
    if (stopped === "retry") {
      // Could not take the enrollment lock. Nothing is sent; the job is
      // released as retryable and the next attempt re-runs the guard.
      return await rescheduleJob(admin, job, {
        retriable: true, category: "database", errorCode: "stop_lock_timeout",
        errorMessage: "The follow-up had to stop but the stop could not be applied yet; nothing was sent, will retry.",
        delaySeconds: 30,
      });
    }
    await closeUnresolvedQueuedMessage(admin, job, queuedMessageId);
    await recordStopActivity(
      admin, job.user_id, job.contact_id,
      `automation-job-stopped-${job.id}`,
      "Follow-up stopped",
      STOP_NOTES[decision.reason] ?? "This automation stopped for this contact. No further follow-up was sent.",
    );
    const outcome = await cancelClaimedJob(admin, job);
    await annotateCancelledJob(admin, job, stopReason);
    return outcome;
  }
  // skip — email steps only (enforced in presendGuard).
  await closeUnresolvedQueuedMessage(admin, job, queuedMessageId);
  await skipClaimedJob(admin, job, decision.reason);
  await recordStopActivity(
    admin, job.user_id, job.contact_id,
    `automation-job-skipped-${job.id}`,
    "Follow-up email skipped",
    SKIP_NOTES[decision.reason] ?? "The email step was skipped. Other steps continue.",
  );
  return "skipped";
}

// Everything that must happen once a message is durably accepted by the
// provider — just now, or by an earlier attempt of this same job. Every
// step is idempotent and re-run in full on a retry.
async function finishAcceptedEmail(admin: AdminClient, job: JobRow, stepOrder: unknown): Promise<JobOutcome> {
  const { data: contact, error: contactError } = await admin
    .from("contacts")
    .select("id,last_contact")
    .eq("id", job.contact_id).eq("user_id", job.user_id).maybeSingle();
  requireNoError(contactError, "select_contact_after_send");

  const today = new Date().toISOString().slice(0, 10);
  if (contact && (!contact.last_contact || contact.last_contact < today)) {
    const { error: contactUpdateError } = await admin.from("contacts")
      .update({ last_contact: today }).eq("id", contact.id).eq("user_id", job.user_id);
    if (contactUpdateError) {
      return await rescheduleJob(admin, job, { retriable: true, category: "database", errorCode: "last_contact_update_failed", errorMessage: "Could not record last contact; will retry.", delaySeconds: 30 });
    }
  }

  const activityId = `automation-activity-${job.id}`;
  const { error: activityError } = await admin.from("activities").insert({
    id: activityId, user_id: job.user_id, type: "Email", contact_id: job.contact_id,
    subject: "Automated follow-up email sent", description: "", outcome: "Sent",
    notes: `Sent automatically by an automation sequence (step ${String(stepOrder ?? "")}).`,
    date: new Date().toISOString(),
  });
  if (activityError && activityError.code !== "23505") {
    return await rescheduleJob(admin, job, { retriable: true, category: "database", errorCode: "activity_insert_failed", errorMessage: "Could not record the CRM activity; will retry.", delaySeconds: 30 });
  }

  // If a stop landed while this message was in flight, the enrollment is
  // no longer active and this completes with 'completed_no_advance': the
  // send is recorded as it happened and no later step is scheduled.
  await completeJobAndAdvance(admin, job);
  return "completed";
}

async function processSendEmail(admin: AdminClient, job: JobRow): Promise<JobOutcome> {
  const step = job.payload as { template_id?: unknown; subject?: unknown; body_text?: unknown; step_order?: unknown };

  const idempotencyKey = await deterministicUuid(`automation-email:${job.id}`);
  const resendIdempotencyHeader = `automation/${job.id}`;

  // 1. What already happened for this job's message? Classified BEFORE any
  //    guard: if the provider already accepted it on an earlier attempt,
  //    that outcome is recorded normally even if a stop has since landed —
  //    a sent message is never treated as unsent.
  const { data: existingMessage, error: existingMessageError } = await admin
    .from("outbound_messages")
    .select("id,status,provider_message_id,first_provider_attempt_at")
    .eq("user_id", job.user_id).eq("idempotency_key", idempotencyKey).maybeSingle();
  requireNoError(existingMessageError, "select_existing_message");

  let queuedMessageId: string | null = null;
  let queuedFirstAttemptAt: unknown = null;
  if (existingMessage) {
    // Every accepted status is classified explicitly. There is no
    // catch-all "else retry" branch: an unrecognized status fails closed.
    const existingStatus = typeof existingMessage.status === "string" ? existingMessage.status : "";
    if (ACCEPTED_MESSAGE_STATUSES.has(existingStatus) || RECIPIENT_REJECTED_AFTER_SEND_STATUSES.has(existingStatus)) {
      // The provider accepted this message on an earlier attempt (and it
      // may since have been delivered, opened, bounced, complained about or
      // unsubscribed from). Zero further provider calls. The recipient-level
      // consequences of a bounce/complaint/unsubscribe are applied by the
      // stop pipeline and the guard on the NEXT job, not by rewriting
      // this message's history.
      return await finishAcceptedEmail(admin, job, step.step_order);
    }
    if (existingStatus === "suppressed") {
      // The provider accepted the request but declined to deliver to a
      // suppressed address. Nothing was delivered and nothing will be
      // retried: the email step is recorded as skipped.
      await skipClaimedJob(admin, job, "suppressed");
      await recordStopActivity(
        admin, job.user_id, job.contact_id, `automation-job-skipped-${job.id}`,
        "Follow-up email skipped", SKIP_NOTES.suppressed,
      );
      return "skipped";
    }
    if (JOB_TERMINAL_MESSAGE_STATUSES.has(existingStatus)) {
      // failed: a prior definitive provider rejection. unconfirmed: a
      // delivery that could never be safely confirmed inside the
      // idempotency window. Never resent; the status is preserved as-is
      // and the job fails terminally.
      return await rescheduleJob(admin, job, {
        retriable: false, category: "provider", errorCode: `existing_message_${existingStatus}`,
        errorMessage: "A prior definitive outcome already exists for this job's message.",
      });
    }
    if (existingStatus !== RETRYABLE_MESSAGE_STATUS) {
      // Unknown/unhandled status — fail closed with zero provider calls
      // and no change to the message row.
      return await rescheduleJob(admin, job, {
        retriable: false, category: "validation", errorCode: "unknown_message_status",
        errorMessage: "The existing message for this job has an unrecognized status.",
      });
    }
    queuedMessageId = existingMessage.id;
    queuedFirstAttemptAt = existingMessage.first_provider_attempt_at;
  }

  // 2. Early guard: stop / skip / cancel before doing any other work.
  const early = await presendGuard(admin, job);
  if (early.blocked) return await applyGuardDecision(admin, job, early, queuedMessageId);

  const { data: contact, error: contactError } = await admin
    .from("contacts")
    .select("id,email,full_name")
    .eq("id", job.contact_id).eq("user_id", job.user_id).maybeSingle();
  requireNoError(contactError, "select_contact");
  const email = contact && typeof contact.email === "string" ? contact.email.trim() : "";
  if (!contact || !email || !EMAIL_SHAPE.test(email)) {
    return await rescheduleJob(admin, job, { retriable: false, category: "validation", errorCode: "invalid_contact_email", errorMessage: "Contact has no valid email address." });
  }

  if (typeof step.template_id !== "string") {
    return await rescheduleJob(admin, job, { retriable: false, category: "validation", errorCode: "invalid_step", errorMessage: "Step is missing a template reference." });
  }
  const { data: template, error: templateError } = await admin
    .from("message_templates")
    .select("is_active")
    .eq("id", step.template_id).eq("user_id", job.user_id).maybeSingle();
  requireNoError(templateError, "select_template");
  if (!template || template.is_active !== true) {
    return await rescheduleJob(admin, job, { retriable: false, category: "validation", errorCode: "template_inactive", errorMessage: "The email template is no longer active." });
  }

  const { data: senderProfile, error: senderProfileError } = await admin
    .from("email_sender_profiles")
    .select("display_name,reply_to_email,is_enabled,provider")
    .eq("user_id", job.user_id).maybeSingle();
  requireNoError(senderProfileError, "select_sender_profile");
  if (!senderProfile || senderProfile.is_enabled !== true || senderProfile.provider !== "resend") {
    return await rescheduleJob(admin, job, { retriable: false, category: "validation", errorCode: "sender_profile_unavailable", errorMessage: "No enabled sender profile is configured." });
  }
  const replyTo = typeof senderProfile.reply_to_email === "string" && EMAIL_SHAPE.test(senderProfile.reply_to_email)
    ? senderProfile.reply_to_email
    : null;

  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  const resendSendingDomain = Deno.env.get("RESEND_SENDING_DOMAIN");
  if (!resendApiKey || !resendApiKey.trim() || !resendSendingDomain || !isValidDomain(resendSendingDomain.trim())) {
    return await rescheduleJob(admin, job, { retriable: true, category: "provider", errorCode: "provider_not_configured", errorMessage: "Email provider is not configured.", delaySeconds: 300 });
  }
  const senderAddress = `${senderAliasFor(job.user_id)}@${resendSendingDomain.trim().toLowerCase()}`;
  // Every automated email carries a working unsubscribe link. Without the
  // signing secret no link can be made, so nothing is sent (retryable,
  // like a missing provider key).
  const unsubscribeSecret = Deno.env.get("UNSUBSCRIBE_SIGNING_SECRET");
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  if (!isUsableSecret(unsubscribeSecret) || !/^https:\/\//.test(supabaseUrl)) {
    return await rescheduleJob(admin, job, { retriable: true, category: "provider", errorCode: "unsubscribe_not_configured", errorMessage: "Unsubscribe links are not configured.", delaySeconds: 300 });
  }

  const replyToken = await replyTokenFor(unsubscribeSecret, idempotencyKey);
  const inboundDomain = normalizeInboundDomain(Deno.env.get("INBOUND_REPLY_DOMAIN"));

  const mergeValues: Record<string, string> = {
    first_name: (typeof contact.full_name === "string" ? contact.full_name.trim().split(/\s+/)[0] : "") || "",
    full_name: typeof contact.full_name === "string" ? contact.full_name.trim() : "",
    email,
    agent_name: senderProfile.display_name,
  };
  // The activation snapshot already guarantees only well-formed, allowlisted
  // {{tag}} placeholders reached this far — this substitution is a second,
  // defensive layer, not the primary validation.
  const renderedSubject = renderMergeText(typeof step.subject === "string" ? step.subject : "", mergeValues);
  const renderedBody = renderMergeText(typeof step.body_text === "string" ? step.body_text : "", mergeValues);
  if (!renderedSubject || CONTROL_CHARS.test(renderedSubject)) {
    return await rescheduleJob(admin, job, { retriable: false, category: "validation", errorCode: "invalid_rendered_subject", errorMessage: "Rendered subject is invalid." });
  }

  // 3. Late guard, immediately before the provider path. Between here and
  //    the provider call there is only the message-row write below. A stop
  //    that lands after this point is handled by the race rule: the
  //    provider outcome is recorded normally and the stop applies to every
  //    later job.
  const late = await presendGuard(admin, job);
  if (late.blocked) return await applyGuardDecision(admin, job, late, queuedMessageId);

  let messageId: string;
  // Only ever a value that is proven to be persisted in the database.
  let firstAttemptAt: string;
  let providerMessageId: string | null = null;

  if (queuedMessageId) {
    // The only path on which a message may legitimately reach the
    // provider again — behind the same idempotency key.
    messageId = queuedMessageId;
    const stamped = await ensureFirstProviderAttemptAt(admin, job, queuedMessageId, queuedFirstAttemptAt);
    if (!stamped.ok) {
      return await rescheduleJob(admin, job, {
        retriable: true, category: "database", errorCode: stamped.errorCode,
        errorMessage: "Could not record the first provider attempt time; will retry.", delaySeconds: 30,
      });
    }
    firstAttemptAt = stamped.value;
  } else {
    const nowIso = new Date().toISOString();
    const { data: inserted, error: insertError } = await admin
      .from("outbound_messages")
      .insert({
        user_id: job.user_id, job_id: job.id, contact_id: contact.id, template_id: step.template_id,
        message_kind: "automation", idempotency_key: idempotencyKey,
        channel: "email", provider: "resend", recipient: email, subject: renderedSubject, body_snapshot: renderedBody,
        sender_display_name: senderProfile.display_name, sender_address: senderAddress, reply_to_email: senderProfile.reply_to_email,
        status: "queued", queued_at: nowIso, first_provider_attempt_at: nowIso,
        // Opaque, deterministic reply token (never an id, address or name):
        // resend-webhook maps an inbound reply back to this row through it.
        metadata: { reply_token: replyToken },
      })
      .select("id,first_provider_attempt_at")
      .single();
    if (insertError) {
      if (insertError.code === "23505") {
        // A concurrent attempt of this same job created the message row.
        // Retry rather than guessing its state: the next attempt re-runs
        // the full classification above against that row, using the same
        // idempotency key and the same provider Idempotency-Key header.
        return await rescheduleJob(admin, job, {
          retriable: true, category: "database", errorCode: "message_insert_raced",
          errorMessage: "A concurrent attempt created this message; will retry.", delaySeconds: 30,
        });
      }
      throw new Error("insert_message_failed");
    }
    messageId = inserted.id;
    // The insert RETURNS the persisted column (`.select(...)` above), so
    // the value judged below is the one the database actually stored —
    // never the in-memory `nowIso` it was written from. A missing or
    // unparseable value is an internal consistency error: no provider
    // call, and the job is released as retryable. The message row stays
    // 'queued', so the next attempt takes the queued-message path above,
    // where ensureFirstProviderAttemptAt stamps and verifies the column.
    const persisted = persistedTimestamp(inserted.first_provider_attempt_at);
    if (persisted === null) {
      return await rescheduleJob(admin, job, {
        retriable: true, category: "database", errorCode: "first_attempt_not_persisted",
        errorMessage: "The stored first provider attempt time was missing or invalid; no email was sent, will retry.",
        delaySeconds: 30,
      });
    }
    firstAttemptAt = persisted;
  }

  // firstAttemptAt is always a value this worker has confirmed is stored
  // in the database, never a fresh in-memory clock reading, so the
  // 20-hour window measures from the real first attempt and genuinely
  // closes.
  const firstAttemptMs = new Date(firstAttemptAt).getTime();
  if (!Number.isFinite(firstAttemptMs) || Date.now() - firstAttemptMs > SAFE_IDEMPOTENCY_WINDOW_MS) {
    // Outside the safe retry window (or the stored first-attempt time is
    // unusable, which fails closed the same way): make ZERO further
    // Resend calls for this job. The delivery outcome could never be
    // confirmed safely — never claim sent, never claim failed, never
    // risk a duplicate.
    const { error: unconfirmedError } = await admin.from("outbound_messages")
      .update({ status: "unconfirmed" })
      .eq("id", messageId).eq("user_id", job.user_id).eq("status", "queued");
    requireNoError(unconfirmedError, "update_message_unconfirmed");
    return await rescheduleJob(admin, job, {
      retriable: false, category: "provider", errorCode: "idempotency_window_expired",
      errorMessage: "Delivery could not be confirmed safely within the provider idempotency window; no further automatic attempts will be made.",
    });
  }

  // The token's expiry derives from the PERSISTED first attempt, so every
  // retry of this send produces byte-identical content under the same
  // provider Idempotency-Key (a changed body would be rejected as a
  // conflicting request). The token itself is never stored.
  const unsubscribeToken = await createUnsubscribeToken(unsubscribeSecret, {
    messageId,
    contactId: contact.id,
    expiresAtSeconds: Math.floor(firstAttemptMs / 1000) + TOKEN_LIFETIME_SECONDS,
  });
  const links = unsubscribeLinks({ supabaseUrl, pageUrl: Deno.env.get("UNSUBSCRIBE_PAGE_URL") ?? null }, unsubscribeToken);

  const providerBody: Record<string, unknown> = {
    from: `${senderProfile.display_name} via RealtorOS <${senderAddress}>`,
    to: [email],
    subject: renderedSubject,
    // The footer is appended AFTER template rendering, so no template can
    // remove or alter it.
    text: withUnsubscribeFooter(renderedBody, links.pageUrl),
    headers: {
      // RFC 2369 + RFC 8058 one-click: mail clients POST
      // "List-Unsubscribe=One-Click" to this URL.
      "List-Unsubscribe": `<${links.oneClickUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
  // Reply-To: the agent's own address first (they always get the reply
  // directly), plus — when inbound replies are configured — this message's
  // opaque reply address, so a reply can be detected automatically.
  const replyToList = [
    ...(replyTo ? [replyTo] : []),
    ...(inboundDomain ? [replyAddress(replyToken, inboundDomain)] : []),
  ];
  if (replyToList.length > 0) providerBody.reply_to = replyToList;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RESEND_TIMEOUT_MS);
  // "retryable" is the default: any outcome not positively recognized as
  // a confirmed send, or as a definitive non-retryable rejection, leaves
  // the message in its retryable 'queued' state for another attempt
  // behind the same Idempotency-Key.
  let outcome: "sent" | "terminal" | "retryable" = "retryable";
  let failureCode = "provider_error";
  let failureMessage = "The email provider returned an error.";
  let failureCategory = "provider";
  let retryDelaySeconds = AMBIGUOUS_RETRY_BACKOFF_SECONDS;
  try {
    const resendResponse = await fetch("https://api.resend.com/emails", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": resendIdempotencyHeader,
      },
      body: JSON.stringify(providerBody),
    });
    if (resendResponse.ok) {
      const parsed = await resendResponse.json().catch(() => null);
      const candidateId = parsed && typeof parsed === "object" ? (parsed as { id?: unknown }).id : undefined;
      if (isValidProviderMessageId(candidateId)) {
        outcome = "sent";
        providerMessageId = candidateId;
      } else {
        // A 2xx whose body cannot be read as a provider message id is
        // ambiguous, not a failure — the send may well have happened.
        failureCode = "provider_response_malformed";
        failureMessage = "The provider accepted the request but returned an unreadable body.";
      }
    } else {
      const parsedError = await resendResponse.json().catch(() => null);
      const classified = classifyResendError(resendResponse.status, parsedError, isPlainObject(parsedError));
      failureCode = classified.code;
      failureCategory = classified.category;
      retryDelaySeconds = classified.delaySeconds > 0 ? classified.delaySeconds : retryDelaySeconds;
      failureMessage = `Provider responded with status ${resendResponse.status} (${classified.code}).`;
      outcome = classified.retriable ? "retryable" : "terminal";
    }
  } catch (err) {
    // Network failure or timeout: the request may or may not have reached
    // the provider, so the delivery outcome is unknown. Always retryable.
    outcome = "retryable";
    failureCategory = "network";
    failureCode = err instanceof Error && err.name === "AbortError" ? "provider_timeout" : "provider_network_error";
    failureMessage = "The provider request did not complete; safe to retry with the same idempotency key.";
  } finally {
    clearTimeout(timeout);
  }

  if (outcome === "retryable") {
    // The message stays 'queued' — a retryable state. It is NEVER set to
    // 'failed' here: HTTP 429, HTTP 5xx, concurrent_idempotent_requests,
    // network failures, timeouts and malformed/ambiguous bodies all leave
    // the real delivery outcome unknown. Only a safe error code/message
    // is stored alongside. The job is then rescheduled, and its next
    // attempt calls Resend again with the SAME
    // `Idempotency-Key: automation/{job-id}` header, so the provider
    // itself de-duplicates rather than the message being sent twice.
    const { error: noteError } = await admin.from("outbound_messages")
      .update({ error_code: failureCode.slice(0, 100), error_message: failureMessage.slice(0, 500) })
      .eq("id", messageId).eq("user_id", job.user_id).eq("status", "queued");
    if (noteError) {
      // Best-effort annotation only — the message is still (truthfully)
      // 'queued' and the job must still be retried against the same key.
      return await rescheduleJob(admin, job, {
        retriable: true, category: "database", errorCode: "provider_retry_note_failed",
        errorMessage: "Could not record the retryable provider error; will retry.", delaySeconds: retryDelaySeconds,
      });
    }
    return await rescheduleJob(admin, job, {
      retriable: true, category: failureCategory, errorCode: failureCode,
      errorMessage: failureMessage, delaySeconds: retryDelaySeconds,
    });
  }
  if (outcome === "terminal") {
    // The ONLY path that may make the message terminal: a definitive,
    // non-retryable provider rejection (invalid_idempotent_request,
    // invalid_idempotency_key, or another definitive parseable 4xx).
    const { error: failedUpdateError } = await admin.from("outbound_messages")
      .update({
        status: "failed", failed_at: new Date().toISOString(),
        error_code: failureCode.slice(0, 100), error_message: failureMessage.slice(0, 500),
      })
      .eq("id", messageId).eq("user_id", job.user_id).eq("status", "queued");
    requireNoError(failedUpdateError, "update_message_failed");
    return await rescheduleJob(admin, job, {
      retriable: false, category: failureCategory, errorCode: failureCode, errorMessage: failureMessage,
    });
  }

  // outcome === "sent" — persist it. If this specific update fails, the
  // message row is still (truthfully) 'queued' in the database — the
  // job must NOT be completed on this attempt. Reschedule instead: the
  // next attempt reuses the same idempotency key/header and will safely
  // receive the same confirmed result from Resend rather than sending
  // twice.
  const { error: sentUpdateError } = await admin.from("outbound_messages")
    .update({ status: "sent", sent_at: new Date().toISOString(), provider_message_id: providerMessageId })
    .eq("id", messageId).eq("user_id", job.user_id).eq("status", "queued");
  if (sentUpdateError) {
    return await rescheduleJob(admin, job, { retriable: true, category: "database", errorCode: "post_send_persist_failed", errorMessage: "The confirmed send could not be persisted; retrying will safely re-confirm the same provider message.", delaySeconds: 30 });
  }

  return await finishAcceptedEmail(admin, job, step.step_order);
}

async function processCreateTask(admin: AdminClient, job: JobRow): Promise<JobOutcome> {
  const step = job.payload as { config?: unknown; step_order?: unknown };
  const config = isPlainObject(step.config) ? step.config : {};
  const title = typeof config.title === "string" ? config.title.trim().slice(0, 200) : "Follow up";
  const priority = typeof config.priority === "string" && ["High", "Medium", "Low"].includes(config.priority) ? config.priority : "Medium";

  const taskId = `automation-task-${job.id}`;
  const { data: existingTask, error: existingTaskError } = await admin.from("tasks").select("id,user_id").eq("id", taskId).maybeSingle();
  requireNoError(existingTaskError, "select_existing_task");
  if (existingTask && existingTask.user_id !== job.user_id) {
    return await rescheduleJob(admin, job, { retriable: false, category: "database", errorCode: "task_id_conflict", errorMessage: "A deterministic task id conflict was detected." });
  }

  if (!existingTask) {
    const { data: rule, error: ruleError } = await admin.from("automation_rules").select("timezone").eq("id", job.rule_id).eq("user_id", job.user_id).maybeSingle();
    requireNoError(ruleError, "select_rule_timezone");
    const dueDate = todayInTimezone(rule && typeof rule.timezone === "string" ? rule.timezone : "UTC");
    const { error: insertError } = await admin.from("tasks").insert({
      id: taskId, user_id: job.user_id, title, description: "", due_date: dueDate,
      completed: false, priority, status: "To Do", contact_id: job.contact_id,
      notes: `Created automatically by an automation sequence (step ${String(step.step_order ?? "")}).`,
    });
    if (insertError && insertError.code !== "23505") {
      return await rescheduleJob(admin, job, { retriable: true, category: "database", errorCode: "task_insert_failed", errorMessage: "Could not create the task; will retry.", delaySeconds: 30 });
    }
  }

  await completeJobAndAdvance(admin, job);
  return "completed";
}

// Records WHY a claimed job was cancelled, after the lock-token-guarded
// cancel has already succeeded. Kept as a separate, guarded annotation so
// the Phase 4D cancel RPC — and its automation_runs invariant — is not
// modified at all. Deliberately non-fatal: the job is correctly cancelled
// either way; only the displayed reason would be missing.
async function annotateCancelledJob(admin: AdminClient, job: JobRow, reason: string): Promise<void> {
  const { error } = await admin
    .from("automation_jobs")
    .update({ cancelled_at: new Date().toISOString(), cancelled_reason: reason.slice(0, 100) })
    .eq("id", job.id).eq("user_id", job.user_id)
    .eq("status", "cancelled")
    .is("cancelled_reason", null);
  if (error) {
    // Swallowed on purpose — see above.
  }
}

async function processJob(admin: AdminClient, job: JobRow): Promise<JobOutcome> {
  // send_email runs its own guards, at the points where they matter: after
  // checking whether the provider already accepted this job's message
  // (which must be recorded, never undone) and again immediately before
  // the provider call.
  if (job.job_type === "send_email") {
    return await processSendEmail(admin, job);
  }

  // Every other job type: one guard before doing anything. A stop never
  // cancels a job this worker has already claimed, so this is what keeps
  // a claimed task step from running after a stop.
  const decision = await presendGuard(admin, job);
  if (decision.blocked) return await applyGuardDecision(admin, job, decision, null);

  if (job.job_type === "advance_enrollment") {
    await completeJobAndAdvance(admin, job);
    return "completed";
  }
  if (job.job_type === "create_task") {
    return await processCreateTask(admin, job);
  }
  // Unrecognized job_type — never silently succeed.
  return await rescheduleJob(admin, job, { retriable: false, category: "validation", errorCode: "unknown_job_type", errorMessage: `Unrecognized job_type: ${String(job.job_type)}` });
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405, { Allow: "POST, OPTIONS" });
  }

  const expectedSecret = Deno.env.get("AUTOMATION_WORKER_SECRET");
  const providedSecret = request.headers.get(WORKER_SECRET_HEADER) ?? "";
  if (!expectedSecret || !expectedSecret.trim() || !providedSecret || !timingSafeEqual(providedSecret, expectedSecret)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  try {
    const admin = createAdminClient();
    const counters = {
      recoveredEvents: 0, failedStaleEvents: 0, recoveredJobs: 0, failedStaleJobs: 0,
      eventsCompleted: 0, eventsRescheduled: 0, eventsErrored: 0,
      enrollmentsCreated: 0, enrollmentsBlocked: 0,
      jobsCompleted: 0, jobsRescheduled: 0, jobsCancelled: 0, jobsSkipped: 0, jobsAbandoned: 0,
      jobsFailedTerminal: 0, jobsErrored: 0,
      // Phase 2A.
      timeEventsCreated: 0, scanSkipped: 0, scanFailed: 0,
      // Phase 2C.
      remindersCreated: 0, reminderScanFailed: 0,
      // Phase 3B.
      pushSent: 0, pushFailed: 0, pushSkipped: 0, pushStepFailed: 0,
    };

    // ---------- Phase 2A: detect what has become due ----------
    //
    // Runs BEFORE events are claimed, so anything that came due since the
    // last run is picked up by this same run rather than waiting for the
    // next one.
    //
    // A scan failure must never stop the queue. Mail that is already
    // scheduled matters more than discovering new work, so the failure is
    // counted and the run continues. The RPC returns counts only, so there
    // is nothing here that could carry a secret or a contact's details
    // into the response.
    try {
      const { data: scan, error: scanError } = await admin.rpc("realtoros_scan_time_triggers", {
        p_limit: TIME_SCAN_LIMIT,
      });
      if (scanError) {
        counters.scanFailed = 1;
      } else if (isPlainObject(scan)) {
        counters.timeEventsCreated = typeof scan.events_created === "number" ? scan.events_created : 0;
        counters.scanSkipped = typeof scan.skipped_workspaces === "number" ? scan.skipped_workspaces : 0;
      }
    } catch {
      // Never rethrown, and nothing about the error is reported: the
      // message could name a workspace or a rule.
      counters.scanFailed = 1;
    }

    // ---------- Phase 2C: the reminder nudge ----------
    //
    // Straight after the detector, and held to exactly the same rule: this
    // only tells people about work, so it must never be the reason mail
    // already scheduled fails to go out. Counts only; the RPC returns no
    // names, addresses or contact ids.
    try {
      const { data: reminders, error: reminderError } = await admin.rpc(
        "realtoros_scan_follow_up_reminders", {},
      );
      if (reminderError) {
        counters.reminderScanFailed = 1;
      } else if (isPlainObject(reminders)) {
        counters.remindersCreated =
          (typeof reminders.untouched_notified === "number" ? reminders.untouched_notified : 0)
          + (typeof reminders.escalated === "number" ? reminders.escalated : 0)
          + (typeof reminders.summaries === "number" ? reminders.summaries : 0);
      }
    } catch {
      counters.reminderScanFailed = 1;
    }

    // ---------- Phase 3B: push what the two scans just created ----------
    //
    // After the reminder scan, so a notification created a moment ago
    // goes out in this same run rather than waiting for the next one -
    // the same reasoning as the detector running before the claim.
    try {
      await runPushBatch(admin, counters);
    } catch {
      counters.pushStepFailed = 1;
    }

    const { data: recovered, error: recoverError } = await admin.rpc("realtoros_recover_stale_automation_leases", { p_stale_seconds: STALE_LEASE_SECONDS });
    requireNoError(recoverError, "recover_stale_leases_rpc");
    if (isPlainObject(recovered)) {
      counters.recoveredEvents = typeof recovered.recovered_events === "number" ? recovered.recovered_events : 0;
      counters.failedStaleEvents = typeof recovered.failed_events === "number" ? recovered.failed_events : 0;
      counters.recoveredJobs = typeof recovered.recovered_jobs === "number" ? recovered.recovered_jobs : 0;
      counters.failedStaleJobs = typeof recovered.failed_jobs === "number" ? recovered.failed_jobs : 0;
    }

    const { data: events, error: eventsError } = await admin.rpc("realtoros_claim_trigger_events", { p_batch_size: EVENT_BATCH_SIZE });
    requireNoError(eventsError, "claim_trigger_events_rpc");
    if (Array.isArray(events)) {
      for (const event of events as TriggerEventRow[]) {
        try {
          await processTriggerEvent(admin, event, counters);
        } catch {
          // The event is still 'processing' with a valid lock_token here
          // (nothing above committed a status change on this path), so a
          // guarded reschedule/fail with that same token is safe.
          try {
            if ((event.attempts || 0) < (event.max_attempts || 5)) {
              const { data, error } = await admin.rpc("realtoros_reschedule_trigger_event", {
                p_user_id: event.user_id, p_event_id: event.id, p_lock_token: event.lock_token,
                p_available_at: new Date(Date.now() + EVENT_RETRY_BACKOFF_SECONDS * 1000).toISOString(),
              });
              requireNoError(error, "reschedule_trigger_event_rpc");
              if (rpcOutcome(data) !== "rescheduled") throw new Error("reschedule_trigger_event_unexpected_outcome");
            } else {
              const { data, error } = await admin.rpc("realtoros_fail_trigger_event", {
                p_user_id: event.user_id, p_event_id: event.id, p_lock_token: event.lock_token, p_error: "processing_failed",
              });
              requireNoError(error, "fail_trigger_event_rpc");
              if (rpcOutcome(data) !== "failed") throw new Error("fail_trigger_event_unexpected_outcome");
            }
          } catch {
            // Even the guarded reschedule/fail attempt failed — leave the
            // event 'processing' with its lock intact; stale-lease
            // recovery will reclaim it on a later invocation. Never
            // pretend this was handled.
          }
          counters.eventsErrored++;
        }
      }
    }

    const { data: jobs, error: jobsError } = await admin.rpc("realtoros_claim_due_jobs", { p_batch_size: JOB_BATCH_SIZE });
    requireNoError(jobsError, "claim_due_jobs_rpc");
    if (Array.isArray(jobs)) {
      for (const job of jobs as JobRow[]) {
        try {
          const outcome = await processJob(admin, job);
          if (outcome === "completed") counters.jobsCompleted++;
          else if (outcome === "rescheduled") counters.jobsRescheduled++;
          else if (outcome === "cancelled") counters.jobsCancelled++;
          else if (outcome === "failed") counters.jobsFailedTerminal++;
          else if (outcome === "skipped") counters.jobsSkipped++;
          else if (outcome === "abandoned") counters.jobsAbandoned++;
        } catch {
          // An unexpected error (a bug, or a DB/network failure not
          // already classified above). The job's lock token is still
          // valid, so a guarded reschedule with it is safe; if even that
          // fails, leave the job 'processing' for stale-lease recovery
          // rather than claiming any outcome.
          try {
            const outcome = await rescheduleJob(admin, job, { retriable: true, category: "database", errorCode: "processing_error", errorMessage: "An unexpected error occurred while processing this job.", delaySeconds: 60 });
            if (outcome === "failed") counters.jobsFailedTerminal++;
          } catch {
            // fall through — counted only as errored below
          }
          counters.jobsErrored++;
        }
      }
    }

    return jsonResponse({ ok: true, counters });
  } catch {
    return jsonResponse({ error: "internal_error" }, 500);
  }
});
