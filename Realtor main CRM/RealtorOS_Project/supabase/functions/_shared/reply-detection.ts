// Reply detection helpers — Phase 4E.2. Rule-based only.
//
// Each automated email can carry an opaque per-message Reply-To address
// "r-<token>@<INBOUND_REPLY_DOMAIN>". The token is 40 lowercase hex chars
// of HMAC-SHA256(secret, "realtoros-reply-token.v1." + message idempotency
// key): deterministic (so retries of the same send stay byte-identical),
// not reversible, and containing no id, address or name. Lowercase hex
// survives mail systems that lowercase the local part.
//
// No dependencies beyond Web Crypto, so this runs under Deno and Node.

const REPLY_TOKEN_CONTEXT = "realtoros-reply-token.v1.";
const DOMAIN_SHAPE =
  /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function normalizeInboundDomain(
  value: string | undefined | null,
): string | null {
  if (typeof value !== "string") return null;
  const d = value.trim().toLowerCase();
  return d.length <= 253 && DOMAIN_SHAPE.test(d) ? d : null;
}

export async function replyTokenFor(
  secret: string,
  messageIdempotencyKey: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(REPLY_TOKEN_CONTEXT + messageIdempotencyKey),
    ),
  );
  return Array.from(mac.slice(0, 20)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

export function replyAddress(token: string, domain: string): string {
  return `r-${token}@${domain}`;
}

// Pulls the bare address out of "Name <addr@x>" or "addr@x".
function bareAddress(value: string): string {
  const angle = /<([^<>\s]+)>/.exec(value);
  return (angle ? angle[1] : value).trim().toLowerCase();
}

// Finds our reply token among the inbound recipients (to / cc /
// received_for). Only an address at exactly the configured domain counts.
export function findReplyToken(
  recipients: unknown[],
  domain: string,
): string | null {
  for (const r of recipients) {
    if (typeof r !== "string" || r.length > 320) continue;
    const addr = bareAddress(r);
    const at = addr.lastIndexOf("@");
    if (at < 0 || addr.slice(at + 1) !== domain) continue;
    const local = addr.slice(0, at);
    // Tolerate sub-addressing ("r-<token>+anything").
    const m = /^r-([0-9a-f]{40})(?:\+.*)?$/.exec(local);
    if (m) return m[1];
  }
  return null;
}

// Automatic replies (out-of-office, vacation responders, mailing-list
// robots, bounces) must never count as the contact replying. Checked in
// order of reliability; any one match is enough.
export function autoReplyReason(
  headers: Record<string, unknown> | null,
  subject: unknown,
  from: unknown,
): string | null {
  const h: Record<string, string> = {};
  if (headers && typeof headers === "object") {
    for (const [k, v] of Object.entries(headers)) {
      if (typeof v === "string") h[k.toLowerCase()] = v.trim().toLowerCase();
      else if (Array.isArray(v) && typeof v[0] === "string") {
        h[k.toLowerCase()] = String(v[0]).trim().toLowerCase();
      }
    }
  }
  // RFC 3834: anything other than "no" is machine-generated.
  if (h["auto-submitted"] && h["auto-submitted"] !== "no") {
    return "auto_submitted";
  }
  if ("x-autoreply" in h || "x-autorespond" in h || "x-autoresponder" in h) {
    return "x_autoreply";
  }
  if (["bulk", "auto_reply", "junk", "list"].includes(h["precedence"] ?? "")) {
    return "precedence";
  }
  if (
    h["x-auto-response-suppress"] &&
    /\b(all|oof|autoreply)\b/.test(h["x-auto-response-suppress"]) &&
    h["x-ms-exchange-generated-message-source"]
  ) {
    return "exchange_autoreply";
  }
  if ("list-id" in h || "list-unsubscribe" in h) return "mailing_list";
  const sender = typeof from === "string" ? bareAddress(from) : "";
  if (/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply)@/.test(sender)) {
    return "system_sender";
  }
  const subj = typeof subject === "string" ? subject.trim().toLowerCase() : "";
  if (
    /^(auto(matic)?[ -]?(reply|response)|out of (the )?office|autoreply|undeliverable|delivery status notification)\b/
      .test(subj)
  ) {
    return "auto_subject";
  }
  return null;
}

// ---------------------------------------------------------------------
// Opt-out replies (Phase 4E.3)
// ---------------------------------------------------------------------
// The expired-link page tells people to reply "unsubscribe", so such a
// reply is a legal opt-out request and must be honoured automatically.
// Detection is deliberately strict: the subject (minus Re:/Fwd: prefixes)
// or the FIRST real line of the reply must be EXACTLY one of these
// phrases after normalization. A keyword inside a longer sentence — "yes
// interested but stop calling after 6pm" — is a normal reply. Automatic
// replies must be filtered out with autoReplyReason() before calling this.
export const OPT_OUT_PHRASES: ReadonlySet<string> = new Set([
  "unsubscribe",
  "unsubscribe me",
  "please unsubscribe",
  "please unsubscribe me",
  "stop",
  "remove",
  "remove me",
  "please remove me",
  "opt out",
  "optout",
  "opt me out",
]);

// Lowercase, trim, punctuation removed ("Unsubscribe!" -> "unsubscribe",
// "opt-out" -> "opt out"), whitespace collapsed.
export function normalizeOptOutText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripSubjectPrefixes(subject: string): string {
  let s = subject.trim();
  let prev = "";
  while (s !== prev) {
    prev = s;
    s = s.replace(/^(re|fwd?)\s*(\[\d+\])?\s*:\s*/i, "");
  }
  return s;
}

// Lines that mean "the person's own text has ended": a quote header, a
// forwarded/original-message block, or a signature.
function endsOwnText(line: string): boolean {
  const t = line.trim();
  return /^on\s.+\bwrote:?\s*$/i.test(t) || // On <date>, <name> wrote:
    /^-{2,}\s*(original|forwarded) message\s*-{0,}$/i.test(t) ||
    /^_{5,}$/.test(t) || // Outlook separator
    /^(from|sent|to|subject|date):\s/i.test(t) || // quoted header block
    t === "--" || line === "-- " || // signature delimiter
    /^sent from my\s/i.test(t) || /^get outlook for\s/i.test(t);
}

// The first non-empty line the person actually wrote, or null when there
// is none (empty body, only quoted history, only a signature).
export function firstOwnLine(text: string): string | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (t === "") continue;
    if (t.startsWith(">")) continue; // quoted text
    // "On <date>, <name>" with "wrote:" wrapped onto the next line.
    if (/^on\s/i.test(t) && /^wrote:?\s*$/i.test((lines[i + 1] ?? "").trim())) {
      return null;
    }
    if (endsOwnText(line)) return null;
    return t;
  }
  return null;
}

// Plain text from an HTML-only reply: quoted blocks removed, block tags
// turned into line breaks, other tags dropped, basic entities decoded.
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

// The reply body as plain text: text/plain when present, else text from
// the HTML part (quoted blocks already removed). "" when there is neither.
function replyBodyText(text: unknown, html: unknown): string {
  if (typeof text === "string" && text.trim()) return text;
  if (typeof html === "string" && html.trim() && !html.startsWith("data:")) {
    return htmlToText(html);
  }
  return "";
}

// Everything the person actually wrote, top to bottom: quoted lines (">")
// are skipped, and reading stops at the first quote header ("On … wrote:"),
// forwarded/original-message block or signature. At most 5,000 characters.
export function ownReplyText(text: string): string {
  const lines = text.slice(0, 20_000).replace(/\r\n?/g, "\n").split("\n");
  const own: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (t.startsWith(">")) continue;
    if (/^on\s/i.test(t) && /^wrote:?\s*$/i.test((lines[i + 1] ?? "").trim())) break;
    if (endsOwnText(line)) break;
    if (t) own.push(t);
  }
  return own.join("\n").slice(0, 5_000);
}

// ---------------------------------------------------------------------
// Hot replies (Phase 4H)
// ---------------------------------------------------------------------
// A rule-based flag for a reply that shows buying or selling intent, so the
// owner's notification can say "🔥 … asked about a viewing". Only the
// person's own text is read (quoted history, "On … wrote:" and signatures
// are ignored — the quoted follow-up email itself talks about viewings and
// prices). The subject is ignored too: it is normally "Re: <our subject>".
// The result is a short reason code; the reply text is never stored.
//
// Any negation or opt-out anywhere in the person's text wins: "not
// interested", "no longer looking", "don't call", "already bought",
// "stop emailing", "unsubscribe" ... mean NOT hot, even if a hot phrase also
// appears. The first matching group below (strongest first) names the
// reason.
export type HotReason =
  | "offer"
  | "financing"
  | "ready"
  | "viewing"
  | "call_request"
  | "availability"
  | "price";

export const HOT_REASONS: readonly HotReason[] = [
  "offer",
  "financing",
  "ready",
  "viewing",
  "call_request",
  "availability",
  "price",
];

const PROPERTY_WORD =
  "(?:house|home|property|place|apartment|flat|condo|listing|unit|townhouse|villa|plot|it)";

const HOT_PATTERNS: ReadonlyArray<readonly [HotReason, RegExp]> = [
  ["offer", new RegExp(
    [
      String.raw`\b(?:make|making|put in|putting in|submit|submitting|place|placing|send|sending)\s+(?:an?\s+|my\s+|our\s+)?(?:offer|bid)\b`,
      String.raw`\b(?:my|our)\s+(?:offer|bid)\b`,
      String.raw`\b(?:offer|bid)\s+(?:on|for)\s+(?:the|this|that|your)\b`,
      String.raw`\bwe(?:'d| would)? like to offer\b`,
    ].join("|"),
  )],
  ["financing", new RegExp(
    [
      String.raw`\bpre-?\s?(?:approved|qualified)\b`,
      String.raw`\bmortgage (?:is )?(?:approved|in principle|ready|sorted)\b`,
      String.raw`\bapproved for (?:a |the )?(?:mortgage|loan)\b`,
      String.raw`\b(?:financing|finance|funding|loan) (?:is )?(?:ready|in place|sorted|approved|secured)\b`,
      String.raw`\b(?:cash buyer|paying (?:in )?cash|buying (?:with|in) cash)\b`,
    ].join("|"),
  )],
  ["ready", new RegExp(
    String.raw`\bready to (?:buy|move|sell|go ahead|proceed|list|sign|make a move|make an offer|start)\b`,
  )],
  ["viewing", new RegExp(
    [
      String.raw`\b(?:a |the )?(?:viewing|showing|walk-?through|open house|house tour|home tour|virtual tour)\b`,
      String.raw`\b(?:see|view|visit|tour|look at|check out)\s+(?:the |this |that |your )?${PROPERTY_WORD}\b`,
      String.raw`\bschedule (?:a |an )?(?:visit|tour|viewing|showing)\b`,
      String.raw`\bsee it in person\b`,
      String.raw`\bcome (?:and |to )?(?:see|look)\b`,
    ].join("|"),
  )],
  ["call_request", new RegExp(
    [
      String.raw`\b(?:call|phone|ring|text) me\b`,
      String.raw`\bgive me a (?:call|ring)\b`,
      String.raw`\b(?:what|which) time (?:can|could|would|should) (?:we|i|you) (?:talk|speak|chat|call)\b`,
      String.raw`\bwhen (?:can|could) (?:we|i|you) (?:talk|speak|chat|call|meet)\b`,
      String.raw`\bcan (?:you|we) (?:call|talk|speak|chat)\b`,
      String.raw`\bmy (?:phone |cell |mobile )?number is\b`,
      String.raw`\b(?:call|reach) me (?:at|on)\b`,
    ].join("|"),
  )],
  ["availability", new RegExp(
    [
      String.raw`\b(?:is|are) (?:it|this|that|they|the ${PROPERTY_WORD}) (?:still )?(?:available|for sale|on the market)\b`,
      String.raw`\bstill (?:available|for sale|on the market)\b`,
    ].join("|"),
  )],
  ["price", new RegExp(
    [
      String.raw`\b(?:price|pricing|asking price|negotiable|negotiate)\b`,
      String.raw`\bhow much\b`,
      String.raw`\bbest (?:price|offer you(?:'d| would) take)\b`,
    ].join("|"),
  )],
];

const NOT_HOT = new RegExp(
  [
    String.raw`\b(?:not|no longer|never|dont|doesnt|didnt|isnt|arent|wasnt|werent|wont|havent|hasnt|am not|are not)\s+(?:really\s+|very\s+|at all\s+|currently\s+|yet\s+)?(?:interested|looking|ready|buying|selling|in the market)\b`,
    String.raw`\b(?:do not|dont|please dont|please do not|never)\s+(?:call|phone|text|contact|email|message)\b`,
    String.raw`\bstop (?:emailing|contacting|messaging|sending|calling|texting)\b`,
    String.raw`^stop\b`,
    String.raw`\balready (?:bought|sold|purchased|found|signed|closed|moved|rented|went with|chose|picked)\b`,
    String.raw`\b(?:unsubscribe|remove me|take me off|opt me out|opt out|leave me alone|wrong (?:number|person|email))\b`,
    String.raw`\bno thanks?\b`,
    String.raw`\bno,? thank you\b`,
    String.raw`\bnot (?:at this time|at the moment|right now|now|for now|yet)\b`,
    String.raw`\b(?:changed|change of) (?:my|our) (?:mind|plans)\b`,
    String.raw`\bnot for (?:me|us)\b`,
  ].join("|"),
  "m",
);

// Lowercase, curly apostrophes straightened then dropped ("don’t" ->
// "dont", "I'd" -> "id"), whitespace collapsed.
function normalizeForIntent(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/[ \t]+/g, " ");
}

export function hotReplyReason(
  subject: unknown,
  text: unknown,
  html?: unknown,
): HotReason | null {
  if (isOptOutRequest(subject, text, html)) return null;
  const own = ownReplyText(replyBodyText(text, html));
  if (!own) return null;
  const s = normalizeForIntent(own);
  if (NOT_HOT.test(s)) return null;
  for (const [reason, pattern] of HOT_PATTERNS) {
    if (pattern.test(s)) return reason;
  }
  return null;
}

export function isOptOutRequest(
  subject: unknown,
  text: unknown,
  html?: unknown,
): boolean {
  if (typeof subject === "string" && subject.length <= 500) {
    if (
      OPT_OUT_PHRASES.has(normalizeOptOutText(stripSubjectPrefixes(subject)))
    ) return true;
  }
  let body = "";
  if (typeof text === "string" && text.trim()) body = text;
  else if (
    typeof html === "string" && html.trim() && !html.startsWith("data:")
  ) body = htmlToText(html);
  if (!body) return false;
  const first = firstOwnLine(body.slice(0, 20_000));
  return first !== null && first.length <= 100 &&
    OPT_OUT_PHRASES.has(normalizeOptOutText(first));
}
