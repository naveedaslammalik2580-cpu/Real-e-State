// Signed, expiring, single-purpose unsubscribe tokens.
//
// Format: "u1.<payload>.<signature>", both parts base64url without padding.
//   payload   = JSON { p: "unsub", m: <outbound_message_id>, c: <contact tag>, e: <expiry, unix seconds> }
//   signature = HMAC-SHA256(UNSUBSCRIBE_SIGNING_SECRET, "realtoros-unsubscribe.v1." + payload)
//
// The token carries no email address, no owner id and no raw contact id.
// The contact is bound through a keyed tag (HMAC of the contact id), so the
// id cannot be read from, or guessed into, a link. The message id is
// visible but useless without a valid signature.
//
// Tokens are deterministic for a given (message, contact, expiry): the
// worker derives the expiry from the message's persisted first provider
// attempt, so every retry of the same send produces byte-identical content
// under the same provider Idempotency-Key.
//
// No dependencies beyond Web Crypto, so this module runs unchanged under
// Deno and under Node's offline tests.

const PURPOSE = "unsub";
const VERSION_PREFIX = "u1";
const SIGNING_CONTEXT = "realtoros-unsubscribe.v1.";
const CONTACT_TAG_CONTEXT = "realtoros-unsubscribe-contact.v1.";
export const TOKEN_MAX_LENGTH = 512;
export const MIN_SECRET_LENGTH = 32;
// Links keep working for 180 days after the send — well beyond the 30 days
// commercial-email rules require an opt-out mechanism to stay functional.
export const TOKEN_LIFETIME_SECONDS = 180 * 24 * 60 * 60;

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64URL_SHAPE = /^[A-Za-z0-9_-]+$/;
const encoder = new TextEncoder();

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll(
    "=",
    "",
  );
}

function b64urlDecode(text: string): Uint8Array<ArrayBuffer> | null {
  if (!B64URL_SHAPE.test(text)) return null;
  try {
    const padded = text.replaceAll("-", "+").replaceAll("_", "/") +
      "===".slice((text.length + 3) % 4);
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function isUsableSecret(
  secret: string | undefined | null,
): secret is string {
  return typeof secret === "string" &&
    secret.trim().length >= MIN_SECRET_LENGTH;
}

async function hmacKey(
  secret: string,
  usage: "sign" | "verify",
): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await hmacKey(secret, "sign");
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(data)),
  );
}

// Keyed, non-reversible tag for a contact id (first 16 bytes of an HMAC).
export async function contactTagFor(
  secret: string,
  contactId: string,
): Promise<string> {
  return b64urlEncode(
    (await hmac(secret, CONTACT_TAG_CONTEXT + contactId)).slice(0, 16),
  );
}

export async function createUnsubscribeToken(
  secret: string,
  input: { messageId: string; contactId: string; expiresAtSeconds: number },
): Promise<string> {
  if (!isUsableSecret(secret)) throw new Error("unsubscribe_secret_unusable");
  if (!UUID_SHAPE.test(input.messageId)) {
    throw new Error("unsubscribe_bad_message_id");
  }
  if (!input.contactId) throw new Error("unsubscribe_bad_contact");
  if (
    !Number.isSafeInteger(input.expiresAtSeconds) || input.expiresAtSeconds <= 0
  ) throw new Error("unsubscribe_bad_expiry");
  const payload = b64urlEncode(encoder.encode(JSON.stringify({
    p: PURPOSE,
    m: input.messageId.toLowerCase(),
    c: await contactTagFor(secret, input.contactId),
    e: input.expiresAtSeconds,
  })));
  const signature = b64urlEncode(await hmac(secret, SIGNING_CONTEXT + payload));
  return `${VERSION_PREFIX}.${payload}.${signature}`;
}

export type VerifiedUnsubscribeToken = {
  ok: true;
  messageId: string;
  contactTag: string;
  expiresAtSeconds: number;
};

// Returns ok:false for every kind of failure — malformed, wrong purpose,
// bad signature, expired — without saying which, so a caller cannot leak
// the reason to whoever holds the link.
export async function verifyUnsubscribeToken(
  secret: string,
  token: unknown,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<VerifiedUnsubscribeToken | { ok: false }> {
  const fail = { ok: false } as const;
  if (
    !isUsableSecret(secret) || typeof token !== "string" ||
    token.length === 0 || token.length > TOKEN_MAX_LENGTH
  ) return fail;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION_PREFIX) return fail;
  const [, payload, signature] = parts;
  const signatureBytes = b64urlDecode(signature);
  if (
    !signatureBytes || signatureBytes.length !== 32 ||
    !B64URL_SHAPE.test(payload)
  ) return fail;

  // crypto.subtle.verify compares in constant time.
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret, "verify"),
    signatureBytes,
    encoder.encode(SIGNING_CONTEXT + payload),
  );
  if (!valid) return fail;

  const payloadBytes = b64urlDecode(payload);
  if (!payloadBytes) return fail;
  let claims: unknown;
  try {
    claims = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return fail;
  }
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) {
    return fail;
  }
  const { p, m, c, e } = claims as Record<string, unknown>;
  if (
    p !== PURPOSE || typeof m !== "string" || !UUID_SHAPE.test(m) ||
    typeof c !== "string" || !B64URL_SHAPE.test(c)
  ) return fail;
  if (typeof e !== "number" || !Number.isSafeInteger(e) || e <= nowSeconds) {
    return fail;
  }
  return { ok: true, messageId: m, contactTag: c, expiresAtSeconds: e };
}

// Constant-time comparison for two short ASCII strings (the contact tag).
export function tagsEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

// The public endpoint the List-Unsubscribe header points at, and the page a
// person lands on from the visible footer link. UNSUBSCRIBE_PAGE_URL is
// optional: the Supabase default domain serves HTML as plain text, so a
// deployment without a custom functions domain should point it at the
// static app/unsubscribe.html page (token passed in the #fragment,
// never sent to that page's host).
export function unsubscribeLinks(
  env: { supabaseUrl: string; pageUrl?: string | null },
  token: string,
): { oneClickUrl: string; pageUrl: string } {
  const base = env.supabaseUrl.replace(/\/+$/, "");
  const oneClickUrl = `${base}/functions/v1/email-unsubscribe?t=${
    encodeURIComponent(token)
  }`;
  const page = env.pageUrl && /^https:\/\/[^\s#?]+$/.test(env.pageUrl)
    ? `${env.pageUrl}#t=${encodeURIComponent(token)}`
    : oneClickUrl;
  return { oneClickUrl, pageUrl: page };
}
