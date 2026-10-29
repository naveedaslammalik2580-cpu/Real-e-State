// manage-automation — Phase 4D + Phase 4E stop history.
// Authenticated (verify_jwt = true). The ONLY way a browser can ever move
// an automation_rules row out of 'draft', or manually enroll one contact
// into a manual-trigger rule, or retry one eligible failed job. Never
// trusts a browser-supplied user id — the caller's identity always comes
// from their own verified JWT via createUserClient().auth.getUser().
//
// Narrow action contract: activate_rule | pause_rule | resume_rule |
// archive_rule | manual_enroll | retry_job | stop_summary | mark_replied |
// mark_unsubscribed. Any other action, or any unrecognized field in the
// body, is rejected outright.
//
// mark_replied / mark_unsubscribed (Phase 4E.2) are the owner's manual
// fallback when a reply or unsubscribe arrives outside the automated
// paths (a phone call, a reply to a different address). They call the
// same single stop entry point as the webhook and the unsubscribe link,
// with source 'owner_manual', for a contact the caller owns.
//
// stop_summary (Phase 4E) is strictly READ-ONLY: it returns why automation
// stopped for the contacts on one rule the caller owns. It can no more
// stop, start, cancel or retry anything than a SELECT can — every stop is
// applied server-side by resend-webhook or process-automation.
//
// This function never calls Resend, never sends an email, and never
// enrolls a pre-existing contact when activating a rule — enrollment
// only ever happens later, asynchronously, via process-automation
// reacting to a genuinely new trigger event (or, for manual_enroll, the
// one explicitly named contact).
import {
  createAdminClient,
  createUserClient,
  corsHeaders,
  isUuid,
  jsonResponse,
  readJsonBody,
} from "../_shared/runtime.ts";

const CONTROL_CHARS = /[\x00-\x1F\x7F]/;
const UNSAFE_HEADER_CHARS = /[<>"\\,]/;
const EMAIL_SHAPE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const ALLOWED_MERGE_TAGS = new Set(["first_name", "full_name", "email", "agent_name"]);
const TASK_PRIORITIES = new Set(["High", "Medium", "Low"]);
// The only contact statuses this app supports — must stay in sync with
// store.js's contactStages and data-service.js's own allowlist copy.
const ALLOWED_CONTACT_STATUSES = new Set(["New Lead", "Qualified", "Nurturing", "Client", "Past Client", "Lost"]);
const SUBJECT_MAX = 200;
const BODY_MAX = 50_000;
const REQUIRED_ENV_VARS = [
  "RESEND_API_KEY",
  "RESEND_SENDING_DOMAIN",
  "RESEND_WEBHOOK_SECRET",
  "AUTOMATION_WORKER_SECRET",
  // Phase 4E.2: every automated email must carry a working unsubscribe link.
  "UNSUBSCRIBE_SIGNING_SECRET",
];

const ACTIONS = new Set([
  "activate_rule",
  "pause_rule",
  "resume_rule",
  "archive_rule",
  "manual_enroll",
  "retry_job",
  "stop_summary",
  "mark_replied",
  "mark_unsubscribed",
]);

const MARK_ATTEMPTS = 3;
const MARK_RETRY_BASE_MS = 200;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// realtoros_check_enrollment_eligibility block reason -> the error code
// the browser already knows how to explain.
const ENROLL_BLOCK_ERRORS: Record<string, { error: string; status: number }> = {
  suppressed: { error: "contact_suppressed", status: 422 },
  consent_revoked: { error: "contact_opted_out", status: 422 },
  contact_unsubscribed: { error: "contact_unsubscribed", status: 422 },
  contact_replied: { error: "contact_replied", status: 422 },
  duplicate_enrollment: { error: "duplicate_enrollment", status: 409 },
  contact_not_found: { error: "contact_not_found", status: 404 },
  rule_not_found: { error: "rule_not_found", status: 404 },
};

function isValidDisplayName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed === value && trimmed.length >= 1 && trimmed.length <= 100 &&
    !CONTROL_CHARS.test(trimmed) && !UNSAFE_HEADER_CHARS.test(trimmed);
}
function isValidReplyTo(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed === value && trimmed.length >= 1 && trimmed.length <= 254 &&
    !CONTROL_CHARS.test(trimmed) && !trimmed.includes(",") && EMAIL_SHAPE.test(trimmed);
}
function isValidIanaTimezone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz.trim() || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
// Strict placeholder scanner. The old approach (a regex that only ever
// FOUND well-formed {{tag}} occurrences) let a malformed placeholder —
// unmatched `{{`/`}}`, nested braces, or an invalid name like
// `{{first-name}}` or `{{first name}}` — sail through completely
// unnoticed (it simply matched nothing, so "only allowed tags" was
// vacuously true), and the same malformed text would later render
// literally, unfilled, straight into a real email. This scans every
// `{{`/`}}` token in order and requires: no nesting, no unmatched token,
// and every `{{...}}` span's trimmed inner content to be exactly one
// allowed tag name (optional surrounding whitespace only).
function hasOnlyValidPlaceholders(text: string): boolean {
  let depth = 0;
  let start = -1;
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("{{", i)) {
      if (depth > 0) return false; // nested {{
      depth = 1;
      start = i;
      i += 2;
      continue;
    }
    if (text.startsWith("}}", i)) {
      if (depth === 0) return false; // unmatched }}
      const inner = text.slice(start + 2, i);
      const trimmed = inner.trim();
      if (!/^[A-Za-z0-9_]+$/.test(trimmed) || !ALLOWED_MERGE_TAGS.has(trimmed)) return false;
      depth = 0;
      start = -1;
      i += 2;
      continue;
    }
    i += 1;
  }
  return depth === 0; // false = an unmatched {{ was left open
}
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function isSafeStatusValue(value: unknown): value is string {
  return typeof value === "string" && ALLOWED_CONTACT_STATUSES.has(value);
}

// The audience lists a rule may carry: tags_any since Phase 2E, type_in
// and temperature_in since Phase 2F. Their CONTENTS are the database's
// business — automation_internal.validate_audience_filter runs on every
// write to automation_rules, so anything stored is already normalized and
// legal. This gate only checks the shape, which is why it does not repeat
// the length and de-duplication rules.
const AUDIENCE_LIST_KEYS = new Set(["tags_any", "type_in", "temperature_in"]);
function isAudienceList(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.length <= 20
    && value.every((v) => typeof v === "string" && v.trim().length > 0 && v.length <= 50);
}

// Validates the audience_filter shape for the given trigger type. Returns
// true/false only — never interprets the filter as anything beyond this
// one narrow allowed shape.
//
// PHASE 2F NOTE. Before this, the only shape allowed outside a
// status-change rule was the empty object, which meant a Phase 2E rule
// with a tag audience could be drafted and then refused at activation
// with invalid_audience_filter. The three lists are accepted here now.
// The 2A trigger settings still have no business here: they live in
// trigger_config, which the database validates separately, and keeping
// the two apart is what stops a trigger setting from being mistaken for a
// contact filter.
function isValidAudienceFilter(triggerType: string, filter: unknown): boolean {
  if (!isPlainObject(filter)) return false;
  const keys = Object.keys(filter);
  if (keys.some((k) => k !== "status_equals" && !AUDIENCE_LIST_KEYS.has(k))) return false;
  if (keys.some((k) => AUDIENCE_LIST_KEYS.has(k) && !isAudienceList(filter[k]))) return false;
  if (triggerType === "contact_status_changed") {
    // Still required, and still the one value this function checks itself:
    // a status-change rule with no status matches nothing it should.
    return isSafeStatusValue(filter.status_equals);
  }
  return !("status_equals" in filter);
}

type PreflightResult =
  | { ok: true; runtimeSnapshot: Record<string, unknown>; senderProfile: { display_name: string; reply_to_email: string } }
  | { ok: false; error: string };

async function buildActivationSnapshot(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  rule: Record<string, unknown>,
): Promise<PreflightResult> {
  if (!isValidIanaTimezone(rule.timezone)) return { ok: false, error: "invalid_timezone" };
  if (!isValidAudienceFilter(rule.trigger_type as string, rule.audience_filter)) {
    return { ok: false, error: "invalid_audience_filter" };
  }

  // Phase 2A. trigger_config is validated by the DATABASE, not here, so
  // there is exactly one definition of a valid config and the browser,
  // this function and a draft INSERT cannot drift apart. What comes back is
  // the NORMALIZED config (defaults filled in), and that is what goes into
  // the snapshot — so an activated rule runs on the values that were
  // actually checked, not on whatever the row happened to hold.
  const { data: configCheck, error: configError } = await admin.rpc("realtoros_validate_trigger_config", {
    p_trigger_type: rule.trigger_type,
    p_config: isPlainObject(rule.trigger_config) ? rule.trigger_config : {},
  });
  if (configError || !isPlainObject(configCheck)) return { ok: false, error: "internal_error" };
  if (configCheck.ok !== true) return { ok: false, error: "invalid_trigger_config" };
  const normalizedTriggerConfig = isPlainObject(configCheck.config) ? configCheck.config : {};

  const { data: steps, error: stepsError } = await admin
    .from("automation_steps")
    .select("id,template_id,step_order,action_type,delay_minutes,subject_override,config,is_active")
    .eq("user_id", userId)
    .eq("rule_id", rule.id)
    .order("step_order", { ascending: true });
  if (stepsError) return { ok: false, error: "internal_error" };

  const activeSteps = (steps || []).filter((s) => s.is_active === true);
  if (activeSteps.length === 0) return { ok: false, error: "no_active_steps" };

  const seenOrders = new Set<number>();
  const snapshotSteps: Record<string, unknown>[] = [];

  for (const step of activeSteps) {
    if (typeof step.step_order !== "number" || seenOrders.has(step.step_order)) {
      return { ok: false, error: "invalid_step_order" };
    }
    seenOrders.add(step.step_order);

    if (step.action_type === "send_email") {
      if (typeof step.template_id !== "string" || !isUuid(step.template_id)) {
        return { ok: false, error: "invalid_step_template" };
      }
      const { data: template, error: templateError } = await admin
        .from("message_templates")
        .select("id,channel,subject,body_text,is_active")
        .eq("id", step.template_id)
        .eq("user_id", userId)
        .maybeSingle();
      if (templateError) return { ok: false, error: "internal_error" };
      if (!template || template.channel !== "email" || template.is_active !== true) {
        return { ok: false, error: "invalid_step_template" };
      }
      const resolvedSubject = typeof step.subject_override === "string" && step.subject_override.trim()
        ? step.subject_override.trim()
        : (typeof template.subject === "string" ? template.subject.trim() : "");
      const bodyText = typeof template.body_text === "string" ? template.body_text.trim() : "";
      if (!resolvedSubject || resolvedSubject.length > SUBJECT_MAX || CONTROL_CHARS.test(resolvedSubject)) {
        return { ok: false, error: "invalid_step_subject" };
      }
      if (!bodyText || bodyText.length > BODY_MAX) {
        return { ok: false, error: "invalid_step_body" };
      }
      if (!hasOnlyValidPlaceholders(resolvedSubject) || !hasOnlyValidPlaceholders(bodyText)) {
        return { ok: false, error: "unsupported_merge_tag" };
      }
      snapshotSteps.push({
        step_order: step.step_order,
        action_type: "send_email",
        delay_minutes: step.delay_minutes,
        template_id: step.template_id,
        subject: resolvedSubject,
        body_text: bodyText,
      });
    } else if (step.action_type === "create_task") {
      const config = isPlainObject(step.config) ? step.config : {};
      const title = typeof config.title === "string" ? config.title.trim() : "";
      const priority = typeof config.priority === "string" ? config.priority : "";
      if (!title || title.length > 200 || CONTROL_CHARS.test(title)) {
        return { ok: false, error: "invalid_step_task_title" };
      }
      if (!TASK_PRIORITIES.has(priority)) return { ok: false, error: "invalid_step_task_priority" };
      snapshotSteps.push({
        step_order: step.step_order,
        action_type: "create_task",
        delay_minutes: step.delay_minutes,
        config: { title, priority },
      });
    } else if (step.action_type === "wait") {
      snapshotSteps.push({
        step_order: step.step_order,
        action_type: "wait",
        delay_minutes: step.delay_minutes,
      });
    } else {
      return { ok: false, error: "unsupported_step_action" };
    }
  }

  const { data: senderProfile, error: senderProfileError } = await admin
    .from("email_sender_profiles")
    .select("user_id,display_name,reply_to_email,is_enabled,provider")
    .eq("user_id", userId)
    .maybeSingle();
  if (senderProfileError) return { ok: false, error: "internal_error" };
  if (!senderProfile || senderProfile.is_enabled !== true || senderProfile.provider !== "resend") {
    return { ok: false, error: "sender_profile_unavailable" };
  }
  if (!isValidDisplayName(senderProfile.display_name) || !isValidReplyTo(senderProfile.reply_to_email)) {
    return { ok: false, error: "sender_profile_unavailable" };
  }

  for (const name of REQUIRED_ENV_VARS) {
    const value = Deno.env.get(name);
    if (!value || !value.trim()) return { ok: false, error: "provider_not_configured" };
  }

  return {
    ok: true,
    runtimeSnapshot: {
      steps: snapshotSteps,
      built_at: new Date().toISOString(),
      // Phase 2A: frozen with the steps, so editing the draft's config
      // later cannot change how an already-running rule behaves.
      trigger_type: rule.trigger_type,
      trigger_config: normalizedTriggerConfig,
    },
    senderProfile: { display_name: senderProfile.display_name, reply_to_email: senderProfile.reply_to_email },
  };
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405, { Allow: "POST, OPTIONS" });
  }

  try {
    const authorization = request.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ")) return jsonResponse({ error: "authentication_required" }, 401);
    const userClient = createUserClient(authorization);
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) return jsonResponse({ error: "authentication_required" }, 401);

    let input: Record<string, unknown>;
    try {
      input = await readJsonBody(request, 4_000) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof RangeError) return jsonResponse({ error: "request_too_large" }, 413);
      return jsonResponse({ error: "invalid_json" }, 400);
    }
    if (!isPlainObject(input)) return jsonResponse({ error: "invalid_request" }, 422);

    const action = input.action;
    if (typeof action !== "string" || !ACTIONS.has(action)) {
      return jsonResponse({ error: "unknown_action" }, 400);
    }

    const admin = createAdminClient();

    // ---------- activate_rule / pause_rule / resume_rule / archive_rule ----------
    if (action === "activate_rule" || action === "pause_rule" || action === "resume_rule" || action === "archive_rule") {
      const allowedKeys = new Set(["action", "rule_id"]);
      if (Object.keys(input).some((k) => !allowedKeys.has(k))) return jsonResponse({ error: "invalid_request" }, 422);
      const ruleId = input.rule_id;
      if (typeof ruleId !== "string" || !isUuid(ruleId)) return jsonResponse({ error: "invalid_request" }, 422);

      const { data: rule, error: ruleError } = await admin
        .from("automation_rules")
        .select("id,user_id,status,trigger_type,timezone,audience_filter,daily_enrollment_limit,trigger_config")
        .eq("id", ruleId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (ruleError) return jsonResponse({ error: "internal_error" }, 500);
      if (!rule) return jsonResponse({ error: "rule_not_found" }, 404);

      if (action === "activate_rule") {
        if (rule.status !== "draft") return jsonResponse({ error: "invalid_transition" }, 409);
        const preflight = await buildActivationSnapshot(admin, user.id, rule);
        if (!preflight.ok) return jsonResponse({ error: preflight.error }, 422);

        const runtimeVersion = crypto.randomUUID();
        const { data: updated, error: updateError } = await admin
          .from("automation_rules")
          .update({
            status: "active",
            runtime_version: runtimeVersion,
            runtime_snapshot: preflight.runtimeSnapshot,
            activated_at: new Date().toISOString(),
            paused_at: null,
            archived_at: null,
          })
          .eq("id", ruleId).eq("user_id", user.id).eq("status", "draft")
          .select("id,status,runtime_version,activated_at,paused_at,archived_at")
          .maybeSingle();
        if (updateError) return jsonResponse({ error: "internal_error" }, 500);
        if (!updated) return jsonResponse({ error: "invalid_transition" }, 409);
        return jsonResponse({ ok: true, rule: updated });
      }

      if (action === "pause_rule") {
        if (rule.status !== "active") return jsonResponse({ error: "invalid_transition" }, 409);
        const { data: updated, error: updateError } = await admin
          .from("automation_rules")
          .update({ status: "paused", paused_at: new Date().toISOString() })
          .eq("id", ruleId).eq("user_id", user.id).eq("status", "active")
          .select("id,status,runtime_version,activated_at,paused_at,archived_at")
          .maybeSingle();
        if (updateError) return jsonResponse({ error: "internal_error" }, 500);
        if (!updated) return jsonResponse({ error: "invalid_transition" }, 409);
        return jsonResponse({ ok: true, rule: updated });
      }

      if (action === "resume_rule") {
        if (rule.status !== "paused") return jsonResponse({ error: "invalid_transition" }, 409);
        const { data: updated, error: updateError } = await admin
          .from("automation_rules")
          .update({ status: "active", paused_at: null })
          .eq("id", ruleId).eq("user_id", user.id).eq("status", "paused")
          .select("id,status,runtime_version,activated_at,paused_at,archived_at")
          .maybeSingle();
        if (updateError) return jsonResponse({ error: "internal_error" }, 500);
        if (!updated) return jsonResponse({ error: "invalid_transition" }, 409);
        return jsonResponse({ ok: true, rule: updated });
      }

      // archive_rule — one transaction-safe RPC: verifies the transition,
      // archives the rule, stops every open enrollment, cancels their
      // pending jobs, and preserves all history atomically. This function
      // never reports success unless that RPC call itself succeeded and
      // its outcome was validated.
      if (rule.status !== "active" && rule.status !== "paused") {
        return jsonResponse({ error: "invalid_transition" }, 409);
      }
      const { data: archiveData, error: archiveError } = await admin.rpc("realtoros_archive_rule", {
        p_user_id: user.id,
        p_rule_id: ruleId,
      });
      if (archiveError || !isPlainObject(archiveData)) return jsonResponse({ error: "internal_error" }, 500);
      const archiveOutcome = archiveData.outcome;
      if (archiveOutcome === "invalid_transition") return jsonResponse({ error: "invalid_transition" }, 409);
      if (archiveOutcome === "not_found") return jsonResponse({ error: "rule_not_found" }, 404);
      if (archiveOutcome !== "archived") return jsonResponse({ error: "internal_error" }, 500);

      const { data: archivedRule, error: archivedRuleError } = await admin
        .from("automation_rules")
        .select("id,status,runtime_version,activated_at,paused_at,archived_at")
        .eq("id", ruleId).eq("user_id", user.id).maybeSingle();
      if (archivedRuleError || !archivedRule) return jsonResponse({ error: "internal_error" }, 500);

      return jsonResponse({ ok: true, rule: archivedRule });
    }

    // ---------- manual_enroll ----------
    if (action === "manual_enroll") {
      const allowedKeys = new Set(["action", "rule_id", "contact_id"]);
      if (Object.keys(input).some((k) => !allowedKeys.has(k))) return jsonResponse({ error: "invalid_request" }, 422);
      const ruleId = input.rule_id;
      const contactId = input.contact_id;
      if (typeof ruleId !== "string" || !isUuid(ruleId)) return jsonResponse({ error: "invalid_request" }, 422);
      if (typeof contactId !== "string" || !contactId.trim() || contactId.length > 100) {
        return jsonResponse({ error: "invalid_request" }, 422);
      }

      const { data: rule, error: ruleError } = await admin
        .from("automation_rules")
        .select("id,status,trigger_type,runtime_version")
        .eq("id", ruleId).eq("user_id", user.id).maybeSingle();
      if (ruleError) return jsonResponse({ error: "internal_error" }, 500);
      if (!rule) return jsonResponse({ error: "rule_not_found" }, 404);
      if (rule.status !== "active" || rule.trigger_type !== "manual" || !rule.runtime_version) {
        return jsonResponse({ error: "rule_not_eligible" }, 422);
      }

      const { data: contact, error: contactError } = await admin
        .from("contacts")
        .select("id,email")
        .eq("id", contactId).eq("user_id", user.id).maybeSingle();
      if (contactError) return jsonResponse({ error: "internal_error" }, 500);
      if (!contact) return jsonResponse({ error: "contact_not_found" }, 404);
      const email = typeof contact.email === "string" ? contact.email.trim() : "";
      if (!email || !EMAIL_SHAPE.test(email)) return jsonResponse({ error: "invalid_contact_email" }, 422);

      // Phase 4E.2: one authoritative eligibility check — active
      // suppression, revoked consent, a detected unsubscribe/reply on a
      // rule that stops for it, and duplicate prevention — with a specific
      // refusal reason the page can show.
      const { data: eligibility, error: eligibilityError } = await admin.rpc("realtoros_check_enrollment_eligibility", {
        p_user_id: user.id,
        p_contact_id: contactId,
        p_rule_id: ruleId,
      });
      if (eligibilityError || !isPlainObject(eligibility) || typeof eligibility.eligible !== "boolean") {
        return jsonResponse({ error: "internal_error" }, 500);
      }
      if (!eligibility.eligible) {
        const mapped = typeof eligibility.block_reason === "string" ? ENROLL_BLOCK_ERRORS[eligibility.block_reason] : undefined;
        if (!mapped) return jsonResponse({ error: "rule_not_eligible" }, 422);
        return jsonResponse({ error: mapped.error }, mapped.status);
      }

      const { data: senderProfile, error: senderProfileError } = await admin
        .from("email_sender_profiles")
        .select("is_enabled,provider")
        .eq("user_id", user.id).maybeSingle();
      if (senderProfileError) return jsonResponse({ error: "internal_error" }, 500);
      if (!senderProfile || senderProfile.is_enabled !== true || senderProfile.provider !== "resend") {
        return jsonResponse({ error: "sender_profile_unavailable" }, 422);
      }

      const { data: claimData, error: claimError } = await admin.rpc("realtoros_enroll_contact", {
        p_user_id: user.id,
        p_rule_id: ruleId,
        p_contact_id: contactId,
        p_trigger_event_id: null,
        p_trigger_event_key: `manual:${contactId}`,
      });
      if (claimError || !claimData || typeof claimData !== "object") {
        return jsonResponse({ error: "internal_error" }, 500);
      }
      const outcome = (claimData as { outcome?: unknown }).outcome;
      if (outcome === "duplicate") return jsonResponse({ error: "duplicate_enrollment" }, 409);
      if (outcome === "rate_limited") {
        const retryAfter = (claimData as { retry_after_seconds?: unknown }).retry_after_seconds;
        return jsonResponse({
          error: "rate_limited",
          retry_after_seconds: typeof retryAfter === "number" ? retryAfter : 3600,
        }, 429);
      }
      if (outcome !== "enrolled") return jsonResponse({ error: "rule_not_eligible" }, 422);

      return jsonResponse({
        ok: true,
        enrollment_id: (claimData as { enrollment_id?: unknown }).enrollment_id,
      });
    }

    // ---------- stop_summary (Phase 4E, read-only) ----------
    if (action === "stop_summary") {
      const allowedKeys = new Set(["action", "rule_id", "limit"]);
      if (Object.keys(input).some((k) => !allowedKeys.has(k))) return jsonResponse({ error: "invalid_request" }, 422);
      const ruleId = input.rule_id;
      if (typeof ruleId !== "string" || !isUuid(ruleId)) return jsonResponse({ error: "invalid_request" }, 422);
      const rawLimit = input.limit;
      if (rawLimit !== undefined && (typeof rawLimit !== "number" || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100)) {
        return jsonResponse({ error: "invalid_request" }, 422);
      }

      // Ownership is enforced twice: once here against the caller's own
      // verified JWT identity, and again inside the RPC, which returns
      // found:false for a rule that is not p_user_id's.
      const { data: summary, error: summaryError } = await admin.rpc("realtoros_rule_stop_summary", {
        p_user_id: user.id,
        p_rule_id: ruleId,
        p_limit: typeof rawLimit === "number" ? rawLimit : 20,
      });
      if (summaryError || !isPlainObject(summary)) return jsonResponse({ error: "internal_error" }, 500);
      if (summary.found !== true) return jsonResponse({ error: "rule_not_found" }, 404);

      return jsonResponse({
        ok: true,
        stopped_counts: summary.stopped_counts ?? {},
        stopped_enrollments: Array.isArray(summary.stopped_enrollments) ? summary.stopped_enrollments : [],
        cancelled_jobs: Array.isArray(summary.cancelled_jobs) ? summary.cancelled_jobs : [],
        skipped_jobs: Array.isArray(summary.skipped_jobs) ? summary.skipped_jobs : [],
      });
    }

    // ---------- mark_replied / mark_unsubscribed (Phase 4E.2) ----------
    if (action === "mark_replied" || action === "mark_unsubscribed") {
      const allowedKeys = new Set(["action", "contact_id"]);
      if (Object.keys(input).some((k) => !allowedKeys.has(k))) return jsonResponse({ error: "invalid_request" }, 422);
      const contactId = input.contact_id;
      if (typeof contactId !== "string" || !contactId.trim() || contactId.length > 100) {
        return jsonResponse({ error: "invalid_request" }, 422);
      }

      // Ownership against the caller's own verified identity; the RPC
      // re-checks it (contact_not_found for another owner's contact).
      const { data: contact, error: contactError } = await admin
        .from("contacts").select("id").eq("id", contactId).eq("user_id", user.id).maybeSingle();
      // A database error is always "try again", never a false outcome.
      if (contactError) return jsonResponse({ error: "try_again" }, 503);
      if (!contact) return jsonResponse({ error: "contact_not_found" }, 404);

      // One reference per request, reused across the bounded retries, so a
      // retry after a lock timeout is the SAME event, never a second one.
      const eventRef = `manual:${crypto.randomUUID()}`;
      const occurredAt = new Date().toISOString();
      for (let attempt = 1; attempt <= MARK_ATTEMPTS; attempt++) {
        const { data, error } = await admin.rpc("realtoros_record_contact_stop_event", {
          p_user_id: user.id,
          p_contact_id: contactId,
          p_event_type: action === "mark_replied" ? "reply" : "unsubscribe",
          p_source: "owner_manual",
          p_event_ref: eventRef,
          p_outbound_message_id: null,
          p_occurred_at: occurredAt,
        });
        // The RPC can RAISE rather than return outcome='retry' — e.g. a lock
        // wait timing out while it writes the consent, email-block or
        // timeline rows. Nothing is known to be recorded in that case, so
        // the answer is a retryable "try again", exactly like 'retry'. The
        // one event reference makes asking again safe.
        if (error) return jsonResponse({ error: "try_again" }, 503);
        if (!isPlainObject(data) || typeof data.outcome !== "string") {
          return jsonResponse({ error: "internal_error" }, 500);
        }
        if (data.outcome === "recorded" || data.outcome === "duplicate") {
          const n = (k: string) => (typeof data[k] === "number" ? data[k] : 0);
          return jsonResponse({
            ok: true,
            first_occurrence: data.first_occurrence === true,
            enrollments_stopped: n("enrollments_stopped"),
            enrollments_continuing: n("enrollments_continuing"),
          });
        }
        if (data.outcome === "contact_not_found") return jsonResponse({ error: "contact_not_found" }, 404);
        if (data.outcome !== "retry") return jsonResponse({ error: "internal_error" }, 500);
        if (attempt < MARK_ATTEMPTS) await sleep(MARK_RETRY_BASE_MS * attempt);
      }
      // Still could not take the locks. Anything already applied (consent,
      // email block, timeline note) is kept; asking again finishes the rest.
      return jsonResponse({ error: "try_again" }, 503);
    }

    // ---------- retry_job ----------
    {
      const allowedKeys = new Set(["action", "job_id"]);
      if (Object.keys(input).some((k) => !allowedKeys.has(k))) return jsonResponse({ error: "invalid_request" }, 422);
      const jobId = input.job_id;
      if (typeof jobId !== "string" || !isUuid(jobId)) return jsonResponse({ error: "invalid_request" }, 422);

      const { data: job, error: jobError } = await admin
        .from("automation_jobs")
        .select("id")
        .eq("id", jobId).eq("user_id", user.id).maybeSingle();
      if (jobError) return jsonResponse({ error: "internal_error" }, 500);
      if (!job) return jsonResponse({ error: "job_not_found" }, 404);

      const { data: retryData, error: retryError } = await admin.rpc("realtoros_retry_failed_job", {
        p_user_id: user.id,
        p_job_id: jobId,
      });
      if (retryError || !retryData || typeof retryData !== "object") {
        return jsonResponse({ error: "internal_error" }, 500);
      }
      const outcome = (retryData as { outcome?: unknown }).outcome;
      if (outcome === "not_found") return jsonResponse({ error: "job_not_found" }, 404);
      if (outcome === "not_eligible") return jsonResponse({ error: "job_not_eligible" }, 422);
      if (outcome !== "retried") return jsonResponse({ error: "internal_error" }, 500);
      return jsonResponse({ ok: true });
    }
  } catch {
    return jsonResponse({ error: "internal_error" }, 500);
  }
});
