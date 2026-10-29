// email-unsubscribe — Phase 4E.2.
// Public (verify_jwt = false): the person clicking an unsubscribe link has
// no RealtorOS account. Every request is authorized instead by a signed,
// expiring, single-purpose token (see _shared/unsubscribe-token.ts) bound
// to one outbound message and its contact.
//
//   GET  ?t=<token>   Confirmation page ONLY. Never unsubscribes and never
//                     touches the database, so link scanners and mail
//                     previews that follow links cannot unsubscribe anyone.
//   POST ?t=<token>   Unsubscribes. Covers the confirmation form, and RFC
//                     8058 one-click (body "List-Unsubscribe=One-Click",
//                     form-urlencoded or multipart).
//   POST {token}      JSON body, from the static app/unsubscribe.html
//                     page (used when this domain cannot serve HTML).
//
// Every failure — malformed, tampered, expired, unknown message, contact
// mismatch — gets the same generic answer, so a link reveals nothing about
// why it did not work. Nothing is logged. Pages load no external
// resources, run no scripts and escape every dynamic value.
import { createAdminClient, jsonResponse } from "../_shared/runtime.ts";
import {
  contactTagFor,
  tagsEqual,
  verifyUnsubscribeToken,
} from "../_shared/unsubscribe-token.ts";

const MAX_BODY_BYTES = 4_000;
const RECORD_ATTEMPTS = 3;
const RECORD_RETRY_BASE_MS = 200;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const PAGE_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
};

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function page(status: number, title: string, body: string): Response {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow"><title>${
    escapeHtml(title)
  }</title>
<style>
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f6f7f9;color:#1d232b}
main{max-width:30rem;margin:12vh auto;padding:2rem;background:#fff;border:1px solid #e3e6ea;border-radius:12px}
h1{font-size:1.25rem;margin:0 0 .75rem}p{line-height:1.5;margin:0 0 1rem}
button{font:inherit;padding:.6rem 1.1rem;border-radius:8px;border:1px solid #1d4ed8;background:#1d4ed8;color:#fff;cursor:pointer}
button:focus-visible{outline:3px solid #93c5fd;outline-offset:2px}
</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, { status, headers: { ...CORS, ...PAGE_HEADERS } });
}

// Shown for EVERY link that cannot be used — expired (older than 180
// days), tampered, truncated, or pointing at a message that no longer
// exists. One fixed page for all of them, so it never reveals whether a
// link was ever genuine, and it contains no token or contact details. It
// always gives a way out that does not depend on the link.
const INVALID_TITLE = "Link expired";
const INVALID_BODY = "<h1>This unsubscribe link has expired</h1>" +
  "<p>To stop receiving these emails, reply to any of them with the word " +
  "&#39;unsubscribe&#39;.</p>";
const DONE_TITLE = "You are unsubscribed";
const DONE_BODY =
  "<h1>You are unsubscribed</h1><p>You will not receive any more follow-up emails from this sender.</p>";
// Any database error or unfinished stop. Claims nothing either way: the
// unsubscribe is not confirmed, and part of it may already have been saved.
const BUSY_TITLE = "Please try again";
const BUSY_BODY = "<h1>Something went wrong</h1><p>Please try again.</p>";

function confirmPage(token: string): Response {
  const action = `?t=${encodeURIComponent(token)}`;
  return page(
    200,
    "Unsubscribe",
    `<h1>Unsubscribe from these emails?</h1><p>You will stop receiving follow-up emails from this sender.</p>` +
      `<form method="post" action="${
        escapeHtml(action)
      }"><input type="hidden" name="confirm" value="1">` +
      `<button type="submit">Unsubscribe</button></form>`,
  );
}

type Outcome = "done" | "invalid" | "busy";

function respond(outcome: Outcome, wantsJson: boolean): Response {
  if (wantsJson) {
    if (outcome === "done") return jsonResponse({ ok: true }, 200, CORS);
    if (outcome === "busy") {
      return jsonResponse({ error: "try_again" }, 503, CORS);
    }
    return jsonResponse({ error: "invalid_link" }, 400, CORS);
  }
  if (outcome === "done") return page(200, DONE_TITLE, DONE_BODY);
  if (outcome === "busy") return page(503, BUSY_TITLE, BUSY_BODY);
  return page(400, INVALID_TITLE, INVALID_BODY);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function unsubscribe(secret: string, token: unknown): Promise<Outcome> {
  const verified = await verifyUnsubscribeToken(secret, token);
  if (!verified.ok) return "invalid";

  const admin = createAdminClient();
  const { data: message, error: messageError } = await admin
    .from("outbound_messages")
    .select("id,user_id,contact_id")
    .eq("id", verified.messageId)
    .maybeSingle();
  if (messageError) return "busy";
  if (
    !message || typeof message.contact_id !== "string" || !message.contact_id
  ) return "invalid";

  // The token's contact tag must match the message's contact: a valid
  // token for one message can never be pointed at another contact.
  if (
    !tagsEqual(
      await contactTagFor(secret, message.contact_id),
      verified.contactTag,
    )
  ) return "invalid";

  for (let attempt = 1; attempt <= RECORD_ATTEMPTS; attempt++) {
    const { data, error } = await admin.rpc(
      "realtoros_record_contact_stop_event",
      {
        p_user_id: message.user_id,
        p_contact_id: message.contact_id,
        p_event_type: "unsubscribe",
        p_source: "unsubscribe_link",
        // One unsubscribe per message: a second click, a scanner replay or a
        // one-click POST after the form is a harmless duplicate.
        p_event_ref: `unsub:${message.id}`,
        p_outbound_message_id: message.id,
        p_occurred_at: new Date().toISOString(),
      },
    );
    // An RPC error (e.g. a lock timeout raised while writing consent or
    // email-block rows) means nothing is confirmed: "try again", never done.
    if (error) return "busy";
    const outcome = data && typeof data === "object"
      ? (data as { outcome?: unknown }).outcome
      : null;
    // contact_not_found: the contact was deleted, so nothing will be sent.
    if (
      outcome === "recorded" || outcome === "duplicate" ||
      outcome === "contact_not_found"
    ) return "done";
    if (outcome === "message_mismatch") return "invalid";
    if (outcome !== "retry") return "busy";
    // 'retry': consent and suppression are already committed by the first
    // attempt; only enrollment stops are pending. Retry briefly.
    if (attempt < RECORD_ATTEMPTS) await sleep(RECORD_RETRY_BASE_MS * attempt);
  }
  return "busy";
}

async function readBody(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  const text = await request.text();
  return new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES
    ? null
    : text;
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  const secret = Deno.env.get("UNSUBSCRIBE_SIGNING_SECRET") ?? "";
  const url = new URL(request.url);
  const queryToken = url.searchParams.get("t");

  try {
    if (request.method === "GET" || request.method === "HEAD") {
      // Signature + expiry only; no database access on GET.
      const verified = await verifyUnsubscribeToken(secret, queryToken);
      return verified.ok
        ? confirmPage(queryToken as string)
        : respond("invalid", false);
    }
    if (request.method !== "POST") {
      return new Response("method not allowed", {
        status: 405,
        headers: { ...CORS, Allow: "GET, POST, OPTIONS" },
      });
    }

    const contentType = (request.headers.get("content-type") ?? "")
      .toLowerCase();
    const body = await readBody(request);
    if (body === null) {
      return respond("invalid", contentType.includes("application/json"));
    }

    if (contentType.includes("application/json")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return respond("invalid", true);
      }
      const token = parsed && typeof parsed === "object"
        ? (parsed as { token?: unknown }).token
        : undefined;
      return respond(await unsubscribe(secret, token), true);
    }

    // Form POST (confirmation page) and RFC 8058 one-click, where the
    // token is always in the URL the header / form pointed at. The body
    // ("List-Unsubscribe=One-Click" or "confirm=1") carries no authority.
    return respond(await unsubscribe(secret, queryToken), false);
  } catch {
    return respond(
      "busy",
      request.headers.get("content-type")?.includes("application/json") ??
        false,
    );
  }
});
