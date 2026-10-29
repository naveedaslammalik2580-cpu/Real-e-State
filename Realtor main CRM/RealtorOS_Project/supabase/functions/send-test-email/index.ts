// send-test-email — Phase 4C (hardened).
// Authenticated (verify_jwt = true). Sends exactly one controlled test
// email to the caller's OWN saved Reply-To address, using a server-derived
// sender alias and a template the caller owns. Never accepts a recipient,
// From address, Reply-To override, or user id from the request body.
//
// Idempotency + rate limiting are claimed atomically in one database
// transaction (public.realtoros_claim_test_send, service_role-only), under
// a per-user advisory lock, so concurrent requests — whether the same
// idempotency key or distinct ones — can never both pass the rate limit
// or both call the provider. An ambiguous outcome (timeout, network
// interruption, or a malformed "successful" response) never marks the
// message failed — it stays queued with a short lease so a later request
// using the SAME idempotency key can safely retry the same provider call
// (Resend's own Idempotency-Key header makes that retry safe even if the
// first attempt actually reached Resend).
//
// This function performs configuration-only, single-recipient sends. It
// never enrolls a contact, never activates an automation rule, and never
// writes to automation_enrollments/automation_jobs/automation_runs.
import {
  createAdminClient,
  createUserClient,
  corsHeaders,
  isUuid,
  jsonResponse,
  readJsonBody,
} from "../_shared/runtime.ts";

const DISPLAY_NAME_MAX = 100;
const REPLY_TO_MAX = 254;
const CONTROL_CHARS = /[\x00-\x1F\x7F]/;
const UNSAFE_HEADER_CHARS = /[<>"\\,]/;
const EMAIL_SHAPE =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const DOMAIN_SHAPE =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const PROVIDER_ID_MAX = 128;
const PROVIDER_ID_SHAPE = /^[A-Za-z0-9_.-]+$/;

const RATE_LIMIT_SHORT_WINDOW_SECONDS = 15 * 60;
const RATE_LIMIT_SHORT_MAX = 5;
const RATE_LIMIT_DAILY_WINDOW_SECONDS = 24 * 60 * 60;
const RATE_LIMIT_DAILY_MAX = 20;
const SEND_LEASE_SECONDS = 30; // how long a 'queued' claim is presumed still in flight
const RESEND_TIMEOUT_MS = 10_000;

const MESSAGE_SELECT_COLUMNS =
  "id,status,provider_message_id,recipient,subject,sender_display_name,sender_address,queued_at,sent_at,delivered_at,failed_at,error_code,error_message";

function isValidDisplayName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return (
    trimmed === value &&
    trimmed.length >= 1 &&
    trimmed.length <= DISPLAY_NAME_MAX &&
    !CONTROL_CHARS.test(trimmed) &&
    !UNSAFE_HEADER_CHARS.test(trimmed)
  );
}
function isValidReplyTo(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return (
    trimmed === value &&
    trimmed.length >= 1 &&
    trimmed.length <= REPLY_TO_MAX &&
    !CONTROL_CHARS.test(trimmed) &&
    !trimmed.includes(",") &&
    EMAIL_SHAPE.test(trimmed)
  );
}
function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}
function senderAliasFor(userId: string): string {
  const hex = userId.replace(/[^a-f0-9]/gi, "").toLowerCase();
  return `agent-${hex.slice(0, 12)}`;
}
function isValidDomain(value: string): boolean {
  return value.length > 0 && value.length <= 253 && DOMAIN_SHAPE.test(value);
}
function isValidProviderMessageId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return (
    trimmed === value &&
    trimmed.length > 0 &&
    trimmed.length <= PROVIDER_ID_MAX &&
    PROVIDER_ID_SHAPE.test(trimmed)
  );
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405, {
      Allow: "POST, OPTIONS",
    });
  }

  try {
    const authorization = request.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ")) {
      return jsonResponse({ error: "authentication_required" }, 401);
    }
    const userClient = createUserClient(authorization);
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      return jsonResponse({ error: "authentication_required" }, 401);
    }

    let input: { template_id?: unknown; idempotency_key?: unknown };
    try {
      input = await readJsonBody(request, 4_000) as typeof input;
    } catch (error) {
      if (error instanceof RangeError) {
        return jsonResponse({ error: "request_too_large" }, 413);
      }
      return jsonResponse({ error: "invalid_json" }, 400);
    }

    const templateId = input.template_id;
    const idempotencyKey = input.idempotency_key;
    if (
      typeof templateId !== "string" || !isUuid(templateId) ||
      typeof idempotencyKey !== "string" || !isUuid(idempotencyKey)
    ) {
      return jsonResponse({ error: "invalid_request" }, 422);
    }

    const admin = createAdminClient();

    // 1-2. Sender profile.
    const { data: senderProfile, error: senderProfileError } = await admin
      .from("email_sender_profiles")
      .select("user_id,display_name,reply_to_email,is_enabled,provider")
      .eq("user_id", user.id)
      .maybeSingle();
    if (senderProfileError) {
      return jsonResponse({ error: "internal_error" }, 500);
    }
    if (!senderProfile) {
      return jsonResponse({ error: "sender_profile_incomplete" }, 422);
    }
    if (senderProfile.is_enabled !== true) {
      return jsonResponse({ error: "sender_profile_disabled" }, 422);
    }
    if (
      !isValidDisplayName(senderProfile.display_name) ||
      !isValidReplyTo(senderProfile.reply_to_email) ||
      senderProfile.provider !== "resend"
    ) {
      return jsonResponse({ error: "sender_profile_incomplete" }, 422);
    }
    const replyToEmail = senderProfile.reply_to_email;
    const normalizedRecipient = normalizeEmail(replyToEmail);

    // 4-5. Template, owner-scoped.
    const { data: template, error: templateError } = await admin
      .from("message_templates")
      .select("id,name,channel,subject,body_text,is_active")
      .eq("id", templateId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (templateError) {
      return jsonResponse({ error: "internal_error" }, 500);
    }
    if (!template || template.channel !== "email") {
      return jsonResponse({ error: "template_not_found" }, 404);
    }
    if (!template.is_active) {
      return jsonResponse({ error: "template_inactive" }, 422);
    }
    const templateName = typeof template.name === "string" ? template.name.trim() : "";
    const templateSubject = typeof template.subject === "string" ? template.subject.trim() : "";
    const templateBody = typeof template.body_text === "string" ? template.body_text.trim() : "";
    if (
      !templateName || templateName.length > 100 ||
      !templateSubject || templateSubject.length > 200 ||
      !templateBody || templateBody.length > 50_000 ||
      CONTROL_CHARS.test(templateSubject)
    ) {
      return jsonResponse({ error: "invalid_template" }, 422);
    }

    // 6. Suppression check.
    const { data: suppression, error: suppressionError } = await admin
      .from("email_suppressions")
      .select("id")
      .eq("user_id", user.id)
      .eq("normalized_email", normalizedRecipient)
      .eq("is_active", true)
      .maybeSingle();
    if (suppressionError) {
      return jsonResponse({ error: "internal_error" }, 500);
    }
    if (suppression) {
      return jsonResponse({ error: "suppressed_recipient" }, 422);
    }

    // 7. Provider configuration — read only from environment.
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    const resendSendingDomain = Deno.env.get("RESEND_SENDING_DOMAIN");
    if (
      !resendApiKey || !resendApiKey.trim() ||
      !resendSendingDomain || !isValidDomain(resendSendingDomain.trim())
    ) {
      // Never reveal which specific secret is missing.
      return jsonResponse({ error: "provider_not_configured" }, 503);
    }

    const senderAddress = `${senderAliasFor(user.id)}@${resendSendingDomain.trim().toLowerCase()}`;

    // 8-9. Atomic claim: idempotency + rate limit, one protected DB call.
    const { data: claimData, error: claimError } = await admin.rpc("realtoros_claim_test_send", {
      p_user_id: user.id,
      p_idempotency_key: idempotencyKey,
      p_template_id: template.id,
      p_recipient: replyToEmail,
      p_subject: templateSubject,
      p_body_snapshot: templateBody,
      p_sender_display_name: senderProfile.display_name,
      p_sender_address: senderAddress,
      p_reply_to_email: replyToEmail,
      p_short_window_seconds: RATE_LIMIT_SHORT_WINDOW_SECONDS,
      p_short_window_max: RATE_LIMIT_SHORT_MAX,
      p_daily_window_seconds: RATE_LIMIT_DAILY_WINDOW_SECONDS,
      p_daily_window_max: RATE_LIMIT_DAILY_MAX,
      p_lease_seconds: SEND_LEASE_SECONDS,
    });
    if (claimError || !claimData || typeof claimData !== "object") {
      return jsonResponse({ error: "internal_error" }, 500);
    }
    const claim = claimData as {
      outcome?: unknown;
      message_id?: unknown;
      retry_after_seconds?: unknown;
    };

    if (claim.outcome === "rate_limited") {
      const retryAfter = typeof claim.retry_after_seconds === "number" ? claim.retry_after_seconds : 900;
      return jsonResponse({ error: "rate_limited", retry_after_seconds: retryAfter }, 429, {
        "Retry-After": String(retryAfter),
      });
    }
    if (claim.outcome === "in_progress") {
      const retryAfter = typeof claim.retry_after_seconds === "number" ? claim.retry_after_seconds : SEND_LEASE_SECONDS;
      return jsonResponse({ error: "send_in_progress", retry_after_seconds: retryAfter }, 409, {
        "Retry-After": String(retryAfter),
      });
    }
    if (claim.outcome === "existing") {
      if (typeof claim.message_id !== "string") return jsonResponse({ error: "internal_error" }, 500);
      const { data: existingRow, error: existingFetchError } = await admin
        .from("outbound_messages")
        .select(MESSAGE_SELECT_COLUMNS)
        .eq("id", claim.message_id)
        .eq("user_id", user.id)
        .maybeSingle();
      if (existingFetchError || !existingRow) return jsonResponse({ error: "internal_error" }, 500);
      // A terminal row already exists (including a prior definitive
      // failure) — return it as-is; never call the provider again.
      return jsonResponse({ ok: true, message: existingRow });
    }
    if (claim.outcome !== "created" && claim.outcome !== "retry_claimed") {
      return jsonResponse({ error: "internal_error" }, 500);
    }
    if (typeof claim.message_id !== "string") {
      return jsonResponse({ error: "internal_error" }, 500);
    }
    const messageId = claim.message_id;

    // 10. Send — Resend only, from this Edge Function. The SAME
    // Idempotency-Key is used whether this is a first attempt or a leased
    // retry, so Resend itself de-duplicates if the earlier attempt
    // actually reached it.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), RESEND_TIMEOUT_MS);
    const fromHeader = `${senderProfile.display_name} via RealtorOS <${senderAddress}>`;

    let outcome: "sent" | "failed" | "ambiguous" = "ambiguous";
    let providerMessageId: string | null = null;
    let failureCode = "provider_error";
    let failureMessage = "The email provider returned an error.";
    try {
      const resendResponse = await fetch("https://api.resend.com/emails", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Authorization": `Bearer ${resendApiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          from: fromHeader,
          to: [replyToEmail],
          reply_to: [replyToEmail],
          subject: templateSubject,
          text: templateBody,
        }),
      });
      if (resendResponse.ok) {
        const parsed = await resendResponse.json().catch(() => null);
        const candidateId = parsed && typeof parsed === "object" ? (parsed as { id?: unknown }).id : undefined;
        if (isValidProviderMessageId(candidateId)) {
          outcome = "sent";
          providerMessageId = candidateId;
        } else {
          // A 2xx response we can't trust the id from — ambiguous, not a
          // definitive success or failure.
          outcome = "ambiguous";
        }
      } else {
        // Only a response we can actually parse counts as a definitive
        // rejection; an unparseable error body is ambiguous, not failed.
        const parsedError = await resendResponse.json().catch(() => null);
        if (parsedError && typeof parsedError === "object") {
          outcome = "failed";
          failureCode = resendResponse.status === 429 ? "provider_rate_limited" : "provider_error";
          failureMessage = `Provider responded with status ${resendResponse.status}.`;
        } else {
          outcome = "ambiguous";
        }
      }
    } catch (error) {
      outcome = "ambiguous";
      if (error instanceof Error && error.name === "AbortError") {
        failureCode = "provider_timeout";
      }
    } finally {
      clearTimeout(timeout);
    }

    if (outcome === "ambiguous") {
      // Leave status as 'queued' — never mark failed for an unconfirmed
      // outcome. The lease (already set by the claim step) lets a later
      // request with the SAME idempotency key retry safely.
      return jsonResponse({
        ok: false,
        error: "provider_ambiguous",
        retryable: true,
      }, 200);
    }

    if (outcome === "failed") {
      const failedAt = new Date().toISOString();
      const { data: updated, error: updateError } = await admin
        .from("outbound_messages")
        .update({ status: "failed", failed_at: failedAt, error_code: failureCode, error_message: failureMessage })
        .eq("id", messageId)
        .eq("user_id", user.id)
        .select(MESSAGE_SELECT_COLUMNS)
        .single();
      if (updateError) return jsonResponse({ error: "message_update_failed" }, 500);
      return jsonResponse({ ok: true, message: updated });
    }

    const sentAt = new Date().toISOString();
    const { data: sentRow, error: sentUpdateError } = await admin
      .from("outbound_messages")
      .update({ status: "sent", sent_at: sentAt, provider_message_id: providerMessageId })
      .eq("id", messageId)
      .eq("user_id", user.id)
      .select(MESSAGE_SELECT_COLUMNS)
      .single();
    if (sentUpdateError) {
      // The provider send DID succeed — this is exactly the "ambiguous
      // from our own side" case. Never report failure for a confirmed
      // send; tell the caller it's safe (and necessary) to retry the same
      // key so the write can be completed (Resend will just re-confirm
      // the same message id).
      return jsonResponse({ ok: false, error: "provider_ambiguous", retryable: true }, 200);
    }
    return jsonResponse({ ok: true, message: sentRow });
  } catch {
    return jsonResponse({ error: "internal_error" }, 500);
  }
});
