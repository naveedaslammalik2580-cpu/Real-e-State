import { createClient } from "npm:@supabase/supabase-js@2.95.0";

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-realtoros-timestamp, x-realtoros-nonce, x-realtoros-worker-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function jsonResponse(
  body: Record<string, unknown>,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      ...extraHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function namedKey(jsonValue: string | undefined): string | null {
  if (!jsonValue) return null;
  try {
    const parsed = JSON.parse(jsonValue) as Record<string, unknown>;
    if (typeof parsed.default === "string" && parsed.default) return parsed.default;
    const first = Object.values(parsed).find(
      (value) => typeof value === "string" && value.length > 0,
    );
    return typeof first === "string" ? first : null;
  } catch {
    return null;
  }
}

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing required environment value: ${name}`);
  return value;
}

export function createAdminClient() {
  const url = requiredEnv("SUPABASE_URL");
  const key =
    namedKey(Deno.env.get("SUPABASE_SECRET_KEYS")) ??
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!key) throw new Error("No Supabase backend key is configured.");

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function createUserClient(authorization: string) {
  const url = requiredEnv("SUPABASE_URL");
  const key =
    namedKey(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS")) ??
    Deno.env.get("SUPABASE_ANON_KEY");
  if (!key) throw new Error("No Supabase publishable key is configured.");

  return createClient(url, key, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function randomConnectorToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
  return `ros_${encoded}`;
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
}

export async function readJsonBody(
  request: Request,
  maxBytes: number,
): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new RangeError("request_too_large");
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new RangeError("request_too_large");
  }
  if (!text) throw new SyntaxError("empty_json_body");
  return JSON.parse(text);
}

