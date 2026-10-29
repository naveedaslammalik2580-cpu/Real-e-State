// import-lead-file — Phase 4E.4.
// Authenticated (verify_jwt = true). A one-time lead import from a file the
// owner picked in the browser. The browser parses the file and sends only
// the mapped rows as JSON; the raw file never reaches the server.
//
// The owner is ALWAYS the verified JWT user — no user id is read from the
// request. Every field is re-validated and sanitized here (the browser's
// checks only drive its preview), then the rows go to the service-role-only
// realtoros_ingest_lead_file(), which shares validation, dedup and row
// results with Google Sheet imports, is idempotent on (owner, import_id),
// limits uploads per owner (10 per 15 minutes, 20 per 24 hours) and allows
// at most 200 NEW contacts from files per owner per rolling 24 hours.
//
// Import:  { import_id: uuid, file_name: string, rows: object[] (1-500),
//            start_automation?: boolean }
// Quota:   { action: "quota" } -> { ok, quota: { limit, used, remaining, resets_at } }
//
// Nothing about rows, emails or phone numbers is ever logged or echoed back
// beyond row numbers and plain-language reasons.
import {
  corsHeaders,
  createAdminClient,
  createUserClient,
  isUuid,
  jsonResponse,
  readJsonBody,
} from "../_shared/runtime.ts";

export const MAX_ROWS = 500;
export const MAX_BODY_BYTES = 3_000_000;
const MAX_FILE_NAME = 255;

const CONTROL_CHARS = /[\x00-\x1F\x7F]/g;
// Notes keep line breaks and tabs; every other control character goes.
const CONTROL_CHARS_EXCEPT_NEWLINES = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const EMAIL_SHAPE =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

const FIELD_LIMITS: Record<string, number> = {
  full_name: 200,
  email: 254,
  phone: 100,
  source: 100,
  notes: 10000,
  budget: 50,
  preferred_area: 300,
};
const MAX_TAGS = 20;
const MAX_TAG_LENGTH = 50;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value: unknown, max: number, keepNewlines = false): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const s = String(value).replace(
    keepNewlines ? CONTROL_CHARS_EXCEPT_NEWLINES : CONTROL_CHARS,
    keepNewlines ? "" : " ",
  );
  return s.replace(/[ \t]+/g, " ").trim().slice(0, max);
}

function cleanTags(value: unknown): string[] {
  const list = Array.isArray(value)
    ? value
    : typeof value === "string"
    ? value.split(/[,;]/)
    : [];
  const out: string[] = [];
  for (const t of list) {
    const tag = cleanText(t, MAX_TAG_LENGTH);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

// One sanitized row for the database, or { _invalid: code } when the row
// cannot be imported. The database re-checks the same rules.
export function sanitizeRow(raw: unknown): Record<string, unknown> {
  if (!isPlainObject(raw)) return { _invalid: "row_not_object" };
  const row: Record<string, unknown> = {
    full_name: cleanText(raw.full_name, FIELD_LIMITS.full_name),
    email: cleanText(raw.email, 320).toLowerCase(),
    phone: cleanText(raw.phone, FIELD_LIMITS.phone),
    source: cleanText(raw.source, FIELD_LIMITS.source),
    notes: cleanText(raw.notes, FIELD_LIMITS.notes, true),
    budget: cleanText(raw.budget, FIELD_LIMITS.budget),
    preferred_area: cleanText(raw.preferred_area, FIELD_LIMITS.preferred_area),
    tags: cleanTags(raw.tags),
  };
  const email = row.email as string;
  const phoneDigits = (row.phone as string).replace(/[^0-9]+/g, "");
  if (!email && !phoneDigits) return { _invalid: "missing_contact_channel" };
  if (
    email && (email.length > FIELD_LIMITS.email || !EMAIL_SHAPE.test(email))
  ) return { _invalid: "invalid_email" };
  if (phoneDigits && (phoneDigits.length < 7 || phoneDigits.length > 15)) {
    return { _invalid: "invalid_phone" };
  }
  return row;
}

export function cleanFileName(value: unknown): string {
  return typeof value === "string"
    ? value.replace(CONTROL_CHARS, "").trim().slice(0, MAX_FILE_NAME)
    : "";
}

type Problem = { row_number: number; code: string; message: string };

function problemList(value: unknown): Problem[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isPlainObject).map((p) => ({
    row_number: typeof p.row_number === "number"
      ? p.row_number
      : Number(p.row_number) || 0,
    code: typeof p.code === "string" ? p.code : "",
    message: typeof p.message === "string"
      ? p.message
      : "This row could not be imported.",
  }));
}

const num = (
  v: unknown,
) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

type Quota = {
  limit: number;
  used: number;
  remaining: number;
  resets_at: string | null;
};

// Only the four known fields, with safe types, go back to the browser.
export function cleanQuota(value: unknown): Quota | null {
  if (!isPlainObject(value)) return null;
  return {
    limit: num(value.limit),
    used: num(value.used),
    remaining: num(value.remaining),
    resets_at: typeof value.resets_at === "string" ? value.resets_at : null,
  };
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
    const { data: { user }, error: userError } = await userClient.auth
      .getUser();
    if (userError || !user) {
      return jsonResponse({ error: "authentication_required" }, 401);
    }

    let input: unknown;
    try {
      input = await readJsonBody(request, MAX_BODY_BYTES);
    } catch (error) {
      if (error instanceof RangeError) {
        return jsonResponse({ error: "request_too_large" }, 413);
      }
      return jsonResponse({ error: "invalid_json" }, 400);
    }
    if (!isPlainObject(input)) {
      return jsonResponse({ error: "invalid_request" }, 422);
    }

    // Read the owner's daily allowance (for the import dialog).
    if (input.action !== undefined) {
      if (input.action !== "quota" || Object.keys(input).length !== 1) {
        return jsonResponse({ error: "invalid_request" }, 422);
      }
      const { data, error } = await createAdminClient().rpc(
        "realtoros_file_import_quota",
        { p_user_id: user.id },
      );
      const quota = error ? null : cleanQuota(data);
      if (!quota) return jsonResponse({ error: "try_again" }, 503);
      return jsonResponse({ ok: true, quota });
    }
    const allowed = new Set([
      "import_id",
      "file_name",
      "rows",
      "start_automation",
    ]);
    if (Object.keys(input).some((k) => !allowed.has(k))) {
      return jsonResponse({ error: "invalid_request" }, 422);
    }

    const importId = input.import_id;
    if (typeof importId !== "string" || !isUuid(importId)) {
      return jsonResponse({ error: "invalid_request" }, 422);
    }
    const fileName = cleanFileName(input.file_name);
    if (!fileName) return jsonResponse({ error: "invalid_request" }, 422);
    if (
      input.start_automation !== undefined &&
      typeof input.start_automation !== "boolean"
    ) {
      return jsonResponse({ error: "invalid_request" }, 422);
    }
    const rows = input.rows;
    if (!Array.isArray(rows) || rows.length === 0) {
      return jsonResponse({ error: "no_rows" }, 422);
    }
    if (rows.length > MAX_ROWS) {
      return jsonResponse({ error: "too_many_rows", max_rows: MAX_ROWS }, 422);
    }

    const admin = createAdminClient();
    const { data, error } = await admin.rpc("realtoros_ingest_lead_file", {
      p_user_id: user.id,
      p_import_id: importId,
      p_file_name: fileName,
      p_rows: rows.map(sanitizeRow),
      p_start_automation: input.start_automation === true,
    });
    // Any database error (a lock timeout, a restart, a network blip) is
    // "try again": the import id makes a retry safe.
    if (error || !isPlainObject(data)) {
      return jsonResponse({ error: "try_again" }, 503);
    }

    if (data.outcome === "rate_limited") {
      const retryAfter = num(data.retry_after_seconds) || 60;
      return jsonResponse(
        { error: "rate_limited", retry_after_seconds: retryAfter },
        429,
        {
          "Retry-After": String(retryAfter),
        },
      );
    }
    if (data.outcome !== "imported" && data.outcome !== "replayed") {
      return jsonResponse({ error: "try_again" }, 503);
    }

    const problems = problemList(data.problems);
    const isLimit = (p: Problem) => p.code === "daily_limit_reached";
    const isSkip = (p: Problem) => p.code === "duplicate_in_file";
    const limited = num(data.daily_limit_skipped_count);
    return jsonResponse({
      ok: true,
      replayed: data.outcome === "replayed",
      batch_id: typeof data.batch_id === "string" ? data.batch_id : null,
      total: num(data.source_row_count),
      imported: num(data.imported_count),
      updated: num(data.updated_count),
      skipped: num(data.unchanged_count) + num(data.in_file_duplicate_count),
      // The database stores daily-limit rows as rejected; report them apart.
      rejected: Math.max(0, num(data.rejected_count) - limited),
      daily_limit_skipped: limited,
      rejected_rows: problems.filter((p) => !isSkip(p) && !isLimit(p))
        .map((p) => ({ row_number: p.row_number, reason: p.message })),
      skipped_rows: problems.filter(isSkip)
        .map((p) => ({ row_number: p.row_number, reason: p.message })),
      limited_rows: problems.filter(isLimit).map((p) => p.row_number),
      quota: cleanQuota(data.quota),
    });
  } catch {
    return jsonResponse({ error: "try_again" }, 503);
  }
});
