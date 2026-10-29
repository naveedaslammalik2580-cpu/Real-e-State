// resend-webhook — Phase 4C (hardened) + Phase 4E stop logic.
// Public (verify_jwt = false) only because Resend cannot send a RealtorOS
// user JWT. Every request is authenticated instead via the Svix-compatible
// webhook signature Resend signs requests with (RESEND_WEBHOOK_SECRET).
// No database write of any kind happens before that signature is verified
// against the exact raw request body.
//
// Every Supabase call's {data, error} is checked explicitly — a returned
// error is never treated as "not found" or silently ignored. A failed
// lookup always yields 500; "processed" is only ever set after every
// required write for this event has actually succeeded, so a legitimate
// retry (from Resend, or of a row this function itself left at
// 'received'/'failed') can always safely finish incomplete work.
//
// This function never accepts tenant/user ownership from the payload —
// the owning user_id is always re-derived from the outbound_messages row
// matched by provider_message_id, itself only ever written by
// send-test-email under RLS-independent service-role access.
//
// Phase 4E.2 lifecycle STOP handling: a complaint or a HARD bounce on a
// message that belongs to a contact goes through
// realtoros_record_contact_stop_event — the single stop entry point —
// with this webhook's own event id as the idempotency reference, so a
// redelivered event is harmless. That one call revokes consent, adds the
// suppression, writes the activity and stops enrollments per rule flag.
// A soft (non-permanent) bounce changes nothing. All of it runs BEFORE the
// event is marked 'processed'; a stop that could not be applied (database
// error, or a lock wait that timed out) returns 500 so the provider
// redelivers rather than the stop being silently lost.
//
// Phase 4E.2 reply detection (email.received): when INBOUND_REPLY_DOMAIN is
// set, automated emails carry an opaque per-message Reply-To address. An
// inbound email to that address is mapped token -> outbound message ->
// contact, its headers are fetched from the provider (the webhook itself
// carries none), and — unless it is an automatic reply such as an
// out-of-office — it is recorded as a reply through the same stop entry
// point (source inbound_email). A reply that is exactly an opt-out
// ("unsubscribe", "stop", ...) is recorded as an unsubscribe instead
// (Phase 4E.3). Automatic replies are recorded as an activity only. No header, body or address from the inbound email is
// stored or logged.
//
// Phase 4H: recording a reply creates the owner's in-app notification (a
// database trigger). When the rule-based detector finds buying/selling
// intent in the person's own text, realtoros_mark_reply_hot then turns that
// same notification into a 'hot_reply' with a short reason code — still
// one notification per reply. This step is best-effort: a failure here is
// reported in the event detail but never fails the webhook, because the
// reply itself is already recorded.
import { createAdminClient, corsHeaders, jsonResponse } from "../_shared/runtime.ts";
import {
  autoReplyReason,
  findReplyToken,
  hotReplyReason,
  isOptOutRequest,
  normalizeInboundDomain,
} from "../_shared/reply-detection.ts";

const MAX_BODY_BYTES = 200_000;
const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;
const SAFE_ID_MAX = 128;
const SAFE_ID_SHAPE = /^[A-Za-z0-9_.-]+$/;

// Higher number = never downgraded by a lower-numbered incoming event.
const STATUS_PRIORITY: Record<string, number> = {
  queued: 0,
  sent: 1,
  delivery_delayed: 2,
  delivered: 3,
  opened: 4,
  clicked: 5,
  replied: 6,
  bounced: 90,
  complained: 91,
  suppressed: 92,
  unsubscribed: 93,
  failed: 100,
};

const EVENT_MAP: Record<string, { status: string; timestampField: string }> = {
  "email.sent": { status: "sent", timestampField: "sent_at" },
  "email.delivered": { status: "delivered", timestampField: "delivered_at" },
  "email.delivery_delayed": { status: "delivery_delayed", timestampField: "delivery_delayed_at" },
  "email.opened": { status: "opened", timestampField: "opened_at" },
  "email.clicked": { status: "clicked", timestampField: "clicked_at" },
  "email.bounced": { status: "bounced", timestampField: "bounced_at" },
  "email.complained": { status: "complained", timestampField: "complained_at" },
  "email.failed": { status: "failed", timestampField: "failed_at" },
  "email.suppressed": { status: "suppressed", timestampField: "suppressed_at" },
  // Resend's documented event list (checked 2026-09-28) has no
  // email.unsubscribed or email.replied. Unsubscribes arrive through the
  // email-unsubscribe function; replies through email.received (inbound).
};
const SUPPRESSION_REASON_FOR_STATUS: Record<string, string> = {
  bounced: "bounce",
  complained: "complaint",
  suppressed: "provider",
  unsubscribed: "unsubscribe",
};

// The contact-level stop event each message status maps to. Only these
// two statuses stop anything; everything else is delivery tracking.
const CONTACT_STOP_EVENT_FOR_STATUS: Record<string, "complaint" | "hard_bounce"> = {
  complained: "complaint",
  bounced: "hard_bounce",
};

function isSafeId(value: string): boolean {
  return value.length > 0 && value.length <= SAFE_ID_MAX && SAFE_ID_SHAPE.test(value);
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

async function verifySvixSignature(
  secret: string,
  svixId: string,
  svixTimestamp: string,
  rawBody: string,
  svixSignatureHeader: string,
): Promise<boolean> {
  const tsNum = Number(svixTimestamp);
  if (!Number.isFinite(tsNum)) return false;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - tsNum) > TIMESTAMP_TOLERANCE_SECONDS) return false;

  const secretB64 = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  let keyBytes: Uint8Array<ArrayBuffer>;
  try {
    keyBytes = base64ToBytes(secretB64);
  } catch {
    return false;
  }

  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signatureBytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(signedContent)),
  );
  const expected = bytesToBase64(signatureBytes);

  const provided = svixSignatureHeader.split(" ").map((s) => s.trim()).filter(Boolean);
  for (const entry of provided) {
    const commaIdx = entry.indexOf(",");
    if (commaIdx === -1) continue;
    const version = entry.slice(0, commaIdx);
    const value = entry.slice(commaIdx + 1);
    if (version !== "v1" || !value) continue;
    if (timingSafeEqual(value, expected)) return true;
  }
  return false;
}

type OutboundMessageRow = {
  id: string;
  user_id: string;
  contact_id: string | null;
  recipient: string;
  status: string;
  sent_at: string | null;
  delivered_at: string | null;
  delivery_delayed_at: string | null;
  opened_at: string | null;
  clicked_at: string | null;
  bounced_at: string | null;
  complained_at: string | null;
  failed_at: string | null;
  suppressed_at: string | null;
  unsubscribed_at: string | null;
  replied_at: string | null;
};

// Returns true only if the suppression is known to be active (already
// was, or was just created/reactivated) by the time this returns; false
// on any unrecovered database failure. A unique-violation racing another
// concurrent request creating the same active suppression is verified and
// treated as success, not silently swallowed.
async function upsertSuppression(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  normalizedEmail: string,
  reason: string,
  sourceMessageId: string,
): Promise<boolean> {
  const { data: active, error: activeError } = await admin
    .from("email_suppressions")
    .select("id")
    .eq("user_id", userId)
    .eq("normalized_email", normalizedEmail)
    .eq("is_active", true)
    .maybeSingle();
  if (activeError) return false;
  if (active) return true;

  const { data: inactive, error: inactiveError } = await admin
    .from("email_suppressions")
    .select("id")
    .eq("user_id", userId)
    .eq("normalized_email", normalizedEmail)
    .eq("is_active", false)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (inactiveError) return false;

  if (inactive) {
    const { error: reactivateError } = await admin
      .from("email_suppressions")
      .update({ is_active: true, reason, source_message_id: sourceMessageId })
      .eq("id", inactive.id)
      .eq("user_id", userId);
    return !reactivateError;
  }

  const { error: insertError } = await admin.from("email_suppressions").insert({
    user_id: userId,
    normalized_email: normalizedEmail,
    reason,
    source_message_id: sourceMessageId,
    is_active: true,
  });
  if (!insertError) return true;

  if (insertError.code === "23505") {
    // Another concurrent request created the same active suppression
    // first — verify it now exists and treat that race as success.
    const { data: nowActive, error: verifyError } = await admin
      .from("email_suppressions")
      .select("id")
      .eq("user_id", userId)
      .eq("normalized_email", normalizedEmail)
      .eq("is_active", true)
      .maybeSingle();
    if (verifyError) return false;
    return !!nowActive;
  }
  return false;
}

type AdminClient = ReturnType<typeof createAdminClient>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const STOP_EVENT_ATTEMPTS = 2;

// Calls THE stop entry point. Returns processed:false for a database/RPC
// failure OR a 'retry' outcome that persisted across the bounded inline
// attempts; the caller turns either into a 500 so the event stays
// retryable. `detail` is counts-only: no address, name or content.
async function recordStopEvent(
  admin: AdminClient,
  message: OutboundMessageRow,
  eventType: "complaint" | "hard_bounce" | "reply" | "unsubscribe",
  eventRef: string,
  occurredAt: string,
  source: "provider_webhook" | "inbound_email" = "provider_webhook",
): Promise<{ processed: boolean; detail: string }> {
  for (let attempt = 1; attempt <= STOP_EVENT_ATTEMPTS; attempt++) {
    const { data, error } = await admin.rpc("realtoros_record_contact_stop_event", {
      p_user_id: message.user_id,
      p_contact_id: message.contact_id,
      p_event_type: eventType,
      p_source: source,
      p_event_ref: eventRef,
      p_outbound_message_id: message.id,
      p_occurred_at: occurredAt,
    });
    if (error) return { processed: false, detail: "record_contact_stop_event_failed" };
    if (!isPlainObject(data) || typeof data.outcome !== "string") {
      return { processed: false, detail: "record_contact_stop_event_unexpected" };
    }
    if (data.outcome === "recorded" || data.outcome === "duplicate") {
      const n = (k: string) => (typeof data[k] === "number" ? data[k] : 0);
      return {
        processed: true,
        detail: `event=${eventType} outcome=${data.outcome} stopped=${n("enrollments_stopped")} jobs_cancelled=${n("jobs_cancelled")} continuing=${n("enrollments_continuing")}`,
      };
    }
    if (data.outcome === "contact_not_found") {
      // The contact was deleted after the send. Nothing left to stop.
      return { processed: true, detail: `event=${eventType} outcome=contact_not_found` };
    }
    if (data.outcome !== "retry") {
      // message_mismatch or anything unrecognized: never report success.
      return { processed: false, detail: "record_contact_stop_event_unexpected" };
    }
  }
  return { processed: false, detail: "record_contact_stop_event_retry" };
}

// Resend: data.bounce.type is "Permanent" for a hard bounce. Anything
// else explicitly present (e.g. "Temporary", "Transient", "Undetermined")
// is treated as soft. A missing field is treated as hard, because Resend
// documents email.bounced as a permanent rejection.
function isHardBounce(bounceType: string | null): boolean {
  return bounceType === null || bounceType === "Permanent";
}

// A provider timestamp is used only if it parses and is not in the future;
// otherwise the server clock is used.
function eventTime(raw: unknown): string {
  if (typeof raw === "string") {
    const ms = new Date(raw).getTime();
    if (Number.isFinite(ms) && ms <= Date.now() + 5 * 60 * 1000) return new Date(ms).toISOString();
  }
  return new Date().toISOString();
}

const RECEIVED_EMAIL_TIMEOUT_MS = 10_000;

// Fetches only what reply classification needs from the provider's
// received-email API. Returns null on any failure (the caller answers 500
// so the event is redelivered). The full body and headers are never
// stored or logged.
async function fetchReceivedEmail(
  emailId: string,
): Promise<
  { headers: Record<string, unknown> | null; subject: unknown; from: unknown; text: unknown; html: unknown } | null
> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey || !apiKey.trim()) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RECEIVED_EMAIL_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
      method: "GET",
      signal: controller.signal,
      headers: { "Authorization": `Bearer ${apiKey}` },
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    if (!isPlainObject(body)) return null;
    return {
      headers: isPlainObject(body.headers) ? body.headers : null,
      subject: body.subject,
      from: body.from,
      // Read only to classify an opt-out reply; never stored or logged.
      text: body.text,
      html: body.html,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function finishInboundReply(
  admin: AdminClient,
  message: OutboundMessageRow,
  emailId: string,
  data: { created_at?: unknown; subject?: unknown; from?: unknown },
  webhookEventId: string,
): Promise<Response> {
  const markProcessed = async (status: "processed" | "ignored", detail: string) => {
    const { error } = await admin.from("webhook_events")
      .update({ status, processed_at: new Date().toISOString() })
      .eq("id", webhookEventId);
    if (error) return jsonResponse({ error: "internal_error" }, 500);
    return jsonResponse({ ok: true, status, inbound: detail });
  };

  if (typeof message.contact_id !== "string" || !message.contact_id) {
    return await markProcessed("ignored", "no_contact");
  }

  const received = await fetchReceivedEmail(emailId);
  if (!received) {
    await markEventFailed(admin, webhookEventId);
    return jsonResponse({ error: "internal_error" }, 500);
  }

  const autoReason = autoReplyReason(received.headers, received.subject ?? data.subject, received.from ?? data.from);
  if (autoReason) {
    // Recorded for the owner, but an automatic reply never stops anything.
    const { error } = await admin.from("activities").insert({
      id: `automation-autoreply-${message.id}`,
      user_id: message.user_id,
      type: "Email",
      contact_id: message.contact_id,
      subject: "Automatic reply received",
      description: "",
      outcome: "Automatic reply",
      notes: "An automatic reply (such as an out-of-office message) came back from a follow-up email. Automations were not changed.",
      date: eventTime(data.created_at),
    });
    if (error && error.code !== "23505") {
      await markEventFailed(admin, webhookEventId);
      return jsonResponse({ error: "internal_error" }, 500);
    }
    return await markProcessed("processed", "auto_reply");
  }

  const occurredAt = eventTime(data.created_at);

  // Phase 4E.3: a reply that is EXACTLY an opt-out ("unsubscribe", "stop",
  // "remove me", ...) is a legal opt-out request — recorded as an
  // unsubscribe from inbound_email, and NOT also as a reply. Same event
  // reference pattern as replies, so a redelivery is a harmless duplicate;
  // same retry / non-2xx behaviour on any failure.
  if (isOptOutRequest(received.subject ?? data.subject, received.text, received.html)) {
    const optOut = await recordStopEvent(admin, message, "unsubscribe", `inbound:${emailId}`, occurredAt, "inbound_email");
    if (!optOut.processed) {
      await markEventFailed(admin, webhookEventId);
      return jsonResponse({ error: "internal_error" }, 500);
    }
    const optOutUpdate: Record<string, unknown> = {};
    if ((STATUS_PRIORITY.unsubscribed ?? 0) >= (STATUS_PRIORITY[message.status] ?? 0)) optOutUpdate.status = "unsubscribed";
    if (message.unsubscribed_at == null) optOutUpdate.unsubscribed_at = occurredAt;
    if (Object.keys(optOutUpdate).length > 0) {
      const { error } = await admin.from("outbound_messages").update(optOutUpdate)
        .eq("id", message.id).eq("user_id", message.user_id);
      if (error) {
        await markEventFailed(admin, webhookEventId);
        return jsonResponse({ error: "internal_error" }, 500);
      }
    }
    return await markProcessed("processed", `opt_out ${optOut.detail}`);
  }

  const stop = await recordStopEvent(admin, message, "reply", `inbound:${emailId}`, occurredAt, "inbound_email");
  if (!stop.processed) {
    await markEventFailed(admin, webhookEventId);
    return jsonResponse({ error: "internal_error" }, 500);
  }

  // Phase 4H: a hot reply upgrades its own notification. Only the reason
  // code leaves this function; the reply text is never stored.
  let hotDetail = "";
  const hot = hotReplyReason(received.subject ?? data.subject, received.text, received.html);
  if (hot) {
    const { data: hotData, error: hotError } = await admin.rpc("realtoros_mark_reply_hot", {
      p_user_id: message.user_id,
      p_event_ref: `inbound:${emailId}`,
      p_reason: hot,
    });
    hotDetail = hotError || !isPlainObject(hotData) ? ` hot=${hot} hot_mark_failed` : ` hot=${hot}`;
  }

  // Delivery tracking: 'replied' outranks every positive status and never
  // overwrites a negative one; replied_at is first-write-wins.
  const update: Record<string, unknown> = {};
  if ((STATUS_PRIORITY.replied ?? 0) >= (STATUS_PRIORITY[message.status] ?? 0)) update.status = "replied";
  if (message.replied_at == null) update.replied_at = occurredAt;
  if (Object.keys(update).length > 0) {
    const { error } = await admin.from("outbound_messages").update(update)
      .eq("id", message.id).eq("user_id", message.user_id);
    if (error) {
      await markEventFailed(admin, webhookEventId);
      return jsonResponse({ error: "internal_error" }, 500);
    }
  }
  return await markProcessed("processed", stop.detail + hotDetail);
}

// Best-effort: the caller already returns 500 for the real failure that
// triggered this, regardless of what happens here. The {error} result is
// still explicitly inspected (never fire-and-forget) so this never claims
// success it didn't achieve — but that database error is never exposed
// in any HTTP response, and the original 500 response this call
// accompanies is always preserved either way. If this update itself
// fails, the event row is simply left at whatever status it already had
// ('received') — either outcome ('received' or 'failed') remains safely
// retryable by a later legitimate webhook delivery.
async function markEventFailed(admin: ReturnType<typeof createAdminClient>, webhookEventId: string): Promise<boolean> {
  const { error } = await admin.from("webhook_events").update({ status: "failed" }).eq("id", webhookEventId);
  return !error;
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405, { Allow: "POST, OPTIONS" });
  }

  try {
    const svixId = request.headers.get("svix-id");
    const svixTimestamp = request.headers.get("svix-timestamp");
    const svixSignature = request.headers.get("svix-signature");
    if (!svixId || !svixTimestamp || !svixSignature) {
      return jsonResponse({ error: "signature_required" }, 401);
    }

    const webhookSecret = Deno.env.get("RESEND_WEBHOOK_SECRET");
    if (!webhookSecret || !webhookSecret.trim()) {
      // Fail closed. Never process an unverifiable request.
      return jsonResponse({ error: "webhook_not_configured" }, 503);
    }

    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return jsonResponse({ error: "request_too_large" }, 413);
    }
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
      return jsonResponse({ error: "request_too_large" }, 413);
    }

    const verified = await verifySvixSignature(webhookSecret, svixId, svixTimestamp, rawBody, svixSignature);
    if (!verified) {
      // No database write for an unverified request.
      return jsonResponse({ error: "invalid_signature" }, 401);
    }

    // Defense in depth: even a genuinely-signed request must have a
    // reasonably-shaped event id before it ever reaches a database query.
    if (!isSafeId(svixId)) {
      return jsonResponse({ error: "invalid_event" }, 400);
    }

    let event: {
      type?: unknown;
      created_at?: unknown;
      data?: {
        email_id?: unknown;
        created_at?: unknown;
        bounce?: { type?: unknown };
        to?: unknown;
        cc?: unknown;
        received_for?: unknown;
        from?: unknown;
        subject?: unknown;
      };
    };
    try {
      event = JSON.parse(rawBody);
    } catch {
      return jsonResponse({ error: "invalid_json" }, 400);
    }
    const eventTypeRaw = typeof event.type === "string" ? event.type : "";
    const emailIdRaw = typeof event.data?.email_id === "string" ? event.data.email_id : "";
    const eventType = eventTypeRaw && isSafeId(eventTypeRaw) ? eventTypeRaw : "";
    const emailId = emailIdRaw && isSafeId(emailIdRaw) ? emailIdRaw : "";
    const bounceTypeRaw = typeof event.data?.bounce?.type === "string" ? event.data.bounce.type : null;
    const bounceType = bounceTypeRaw !== null && isSafeId(bounceTypeRaw) ? bounceTypeRaw : null;

    const admin = createAdminClient();

    // Idempotency: (provider, provider_event_id) is globally unique and
    // pre-exists independent of which user the event turns out to belong
    // to, so this check happens before any message lookup.
    const { data: existingEvent, error: existingEventError } = await admin
      .from("webhook_events")
      .select("id,status,outbound_message_id")
      .eq("provider", "resend")
      .eq("provider_event_id", svixId)
      .maybeSingle();
    if (existingEventError) {
      // A failed lookup must never be read as "no existing event".
      return jsonResponse({ error: "internal_error" }, 500);
    }

    if (existingEvent && (existingEvent.status === "processed" || existingEvent.status === "ignored")) {
      // Duplicate of an already fully-handled event — succeed without
      // reprocessing.
      return jsonResponse({ ok: true, status: "duplicate" });
    }

    if (!emailId) {
      if (existingEvent) {
        const { error: ignoreErr } = await admin.from("webhook_events").update({ status: "ignored" }).eq(
          "id",
          existingEvent.id,
        );
        if (ignoreErr) return jsonResponse({ error: "internal_error" }, 500);
      }
      return jsonResponse({ ok: true, status: "ignored" });
    }

    const MESSAGE_COLUMNS =
      "id,user_id,contact_id,recipient,status,sent_at,delivered_at,delivery_delayed_at,opened_at,clicked_at,bounced_at,complained_at,failed_at,suppressed_at,unsubscribed_at,replied_at";
    const inbound = eventType === "email.received";
    let messageQuery;
    if (inbound) {
      // For an inbound email, data.email_id is the RECEIVED email's id.
      // The outbound message is found only through our reply token in its
      // recipients, and only at the configured inbound domain.
      const inboundDomain = normalizeInboundDomain(Deno.env.get("INBOUND_REPLY_DOMAIN"));
      const d = event.data ?? {};
      const recipients = [d.to, d.cc, d.received_for].flatMap((v) => (Array.isArray(v) ? v : []));
      const replyToken = inboundDomain ? findReplyToken(recipients, inboundDomain) : null;
      messageQuery = replyToken
        ? admin.from("outbound_messages").select(MESSAGE_COLUMNS)
          .eq("provider", "resend").eq("metadata->>reply_token", replyToken).maybeSingle()
        : null;
    } else {
      messageQuery = admin.from("outbound_messages").select(MESSAGE_COLUMNS)
        .eq("provider", "resend").eq("provider_message_id", emailId).maybeSingle();
    }
    const { data: messageRow, error: messageError } = messageQuery
      ? await messageQuery
      : { data: null, error: null };
    if (messageError) {
      // A failed lookup must never be treated as "message not found".
      return jsonResponse({ error: "internal_error" }, 500);
    }
    const message = messageRow as OutboundMessageRow | null;

    if (!message) {
      // Unknown provider message id: never guess or attach to any user's
      // records. Only persist a webhook_events row if one already exists
      // from a prior attempt (which — by construction — always resolved a
      // user_id then); a first-time miss has no user_id to attach to.
      if (existingEvent) {
        const { error: ignoreErr } = await admin.from("webhook_events").update({ status: "ignored" }).eq(
          "id",
          existingEvent.id,
        );
        if (ignoreErr) return jsonResponse({ error: "internal_error" }, 500);
      }
      return jsonResponse({ ok: true, status: "ignored" });
    }

    // Minimized, allowlisted payload only — never the full raw body.
    const minimizedPayload: Record<string, string> = { type: eventType, email_id: emailId };
    if (eventType === "email.bounced" && bounceType) minimizedPayload.bounce_type = bounceType;

    let webhookEventId: string;
    if (existingEvent) {
      webhookEventId = existingEvent.id;
      const { error: updateExistingError } = await admin
        .from("webhook_events")
        .update({
          event_type: eventType,
          outbound_message_id: message.id,
          signature_valid: true,
          payload: minimizedPayload,
        })
        .eq("id", webhookEventId);
      if (updateExistingError) return jsonResponse({ error: "internal_error" }, 500);
    } else {
      const { data: inserted, error: insertError } = await admin
        .from("webhook_events")
        .insert({
          user_id: message.user_id,
          outbound_message_id: message.id,
          provider: "resend",
          provider_event_id: svixId,
          event_type: eventType,
          signature_valid: true,
          status: "received",
          payload: minimizedPayload,
        })
        .select("id")
        .single();
      if (insertError) {
        if (insertError.code !== "23505") {
          return jsonResponse({ error: "event_record_failed" }, 500);
        }
        // Lost a race: a concurrent request already inserted this exact
        // event. Reload the winning row rather than assuming its work is
        // complete — two concurrent requests must never both be able to
        // report success while the event stays permanently incomplete.
        const { data: winner, error: winnerError } = await admin
          .from("webhook_events")
          .select("id,status")
          .eq("provider", "resend")
          .eq("provider_event_id", svixId)
          .maybeSingle();
        if (winnerError || !winner) {
          return jsonResponse({ error: "internal_error" }, 500);
        }
        if (winner.status === "processed" || winner.status === "ignored") {
          return jsonResponse({ ok: true, status: "duplicate" });
        }
        // 'received' or 'failed': the winner hasn't finished (or failed
        // part-way) — safely continue processing this SAME event row now,
        // rather than reporting a premature success for incomplete work.
        webhookEventId = winner.id;
        const { error: updateWinnerError } = await admin
          .from("webhook_events")
          .update({
            event_type: eventType,
            outbound_message_id: message.id,
            signature_valid: true,
            payload: minimizedPayload,
          })
          .eq("id", webhookEventId);
        if (updateWinnerError) return jsonResponse({ error: "internal_error" }, 500);
      } else {
        webhookEventId = inserted.id;
      }
    }

    if (inbound) {
      return await finishInboundReply(admin, message, emailId, event.data ?? {}, webhookEventId);
    }

    const mapping = EVENT_MAP[eventType];
    // A soft bounce is a temporary delivery problem: nothing is suppressed,
    // nothing stops, and the message's status is left as it was.
    const softBounce = eventType === "email.bounced" && !isHardBounce(bounceType);
    if (!mapping || softBounce) {
      const { error: ignoreErr } = await admin
        .from("webhook_events")
        .update({ status: "ignored", processed_at: new Date().toISOString() })
        .eq("id", webhookEventId);
      if (ignoreErr) return jsonResponse({ error: "internal_error" }, 500);
      return jsonResponse({ ok: true, status: "ignored" });
    }

    const currentPriority = STATUS_PRIORITY[message.status] ?? 0;
    const newPriority = STATUS_PRIORITY[mapping.status] ?? 0;
    const update: Record<string, unknown> = {};
    if (newPriority >= currentPriority) update.status = mapping.status;
    // Only fill a timestamp that isn't already set — never overwrite an
    // earlier, more specific timestamp with a later/duplicate one.
    const currentTimestampValue = (message as unknown as Record<string, unknown>)[mapping.timestampField];
    if (currentTimestampValue == null) update[mapping.timestampField] = new Date().toISOString();

    if (Object.keys(update).length > 0) {
      const { error: msgUpdateError } = await admin
        .from("outbound_messages")
        .update(update)
        .eq("id", message.id)
        .eq("user_id", message.user_id);
      if (msgUpdateError) {
        await markEventFailed(admin, webhookEventId);
        return jsonResponse({ error: "internal_error" }, 500);
      }
    }

    const hasContact = typeof message.contact_id === "string" && message.contact_id !== "";
    const contactStopEvent = hasContact ? CONTACT_STOP_EVENT_FOR_STATUS[mapping.status] : undefined;

    // Suppression must still be applied even when the status update above
    // was a no-op (e.g. a retry hitting an already-terminal message). For a
    // contact's message a complaint/hard bounce is suppressed inside the
    // stop entry point below instead, in the same transaction as the rest
    // of the stop; this path covers test sends (no contact) and provider
    // suppressions.
    const reason = contactStopEvent ? undefined : SUPPRESSION_REASON_FOR_STATUS[mapping.status];
    if (reason) {
      const normalizedEmail = message.recipient.trim().toLowerCase();
      const suppressionOk = await upsertSuppression(admin, message.user_id, normalizedEmail, reason, message.id);
      if (!suppressionOk) {
        await markEventFailed(admin, webhookEventId);
        return jsonResponse({ error: "internal_error" }, 500);
      }
    }

    // Stop logic. Like suppression above, this runs even when the status
    // update was a no-op, so a retried event still finishes work a
    // previous attempt left undone — the stop entry point is idempotent on
    // this event id.
    let stopDetail = "none";
    if (contactStopEvent) {
      const stopResult = await recordStopEvent(admin, message, contactStopEvent, svixId, eventTime(event.created_at));
      stopDetail = stopResult.detail;
      if (!stopResult.processed) {
        // Leave the event non-'processed' and return 500 so the provider
        // redelivers it — the alternative (a 200 with the stop silently
        // dropped) would keep emailing someone who complained or whose
        // address is dead.
        await markEventFailed(admin, webhookEventId);
        return jsonResponse({ error: "internal_error" }, 500);
      }
    }

    // Only now — after every required write for this event has actually
    // succeeded — mark it processed, and check that this final write
    // itself succeeded too.
    const { error: processedError } = await admin
      .from("webhook_events")
      .update({ status: "processed", processed_at: new Date().toISOString() })
      .eq("id", webhookEventId);
    if (processedError) {
      // The event row is left at 'received' (its status before this
      // call) — a legitimate retry will safely redo the (idempotent,
      // already-applied) writes above and try this update again.
      return jsonResponse({ error: "internal_error" }, 500);
    }
    // Counts only — never an address, a name, or message content.
    return jsonResponse({ ok: true, status: "processed", stop: stopDetail });
  } catch {
    return jsonResponse({ error: "internal_error" }, 500);
  }
});
