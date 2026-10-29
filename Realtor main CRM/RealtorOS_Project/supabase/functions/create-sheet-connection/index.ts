import {
  createAdminClient,
  createUserClient,
  corsHeaders,
  jsonResponse,
  randomConnectorToken,
  readJsonBody,
  sha256Hex,
} from "../_shared/runtime.ts";

type ConnectionRequest = {
  name?: unknown;
  spreadsheet_id?: unknown;
  spreadsheet_url?: unknown;
  raw_tab_name?: unknown;
  ready_tab_name?: unknown;
  sync_mode?: unknown;
  sync_interval_minutes?: unknown;
};

function cleanText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function spreadsheetIdFrom(value: string): string {
  const match = value.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return match?.[1] ?? value;
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
    const {
      data: { user },
      error: userError,
    } = await userClient.auth.getUser();
    if (userError || !user) {
      return jsonResponse({ error: "authentication_required" }, 401);
    }

    let input: ConnectionRequest;
    try {
      input = await readJsonBody(request, 64_000) as ConnectionRequest;
    } catch (error) {
      if (error instanceof RangeError) {
        return jsonResponse({ error: "request_too_large" }, 413);
      }
      return jsonResponse({ error: "invalid_json" }, 400);
    }

    const spreadsheetUrl = cleanText(input.spreadsheet_url, 2_000);
    const spreadsheetId = spreadsheetIdFrom(
      cleanText(input.spreadsheet_id, 300) || spreadsheetUrl,
    );
    const name = cleanText(input.name, 100) || "Google Sheets";
    const rawTabName = cleanText(input.raw_tab_name, 100) || "Raw Leads";
    const readyTabName = cleanText(input.ready_tab_name, 100) || "Ready";
    const syncMode = cleanText(input.sync_mode, 20) || "push";
    const interval = Number(input.sync_interval_minutes ?? 15);

    if (!/^[a-zA-Z0-9_-]{10,300}$/.test(spreadsheetId)) {
      return jsonResponse({ error: "invalid_spreadsheet" }, 422);
    }
    if (!["push", "manual", "interval"].includes(syncMode)) {
      return jsonResponse({ error: "invalid_sync_mode" }, 422);
    }
    if (!Number.isInteger(interval) || interval < 5 || interval > 1_440) {
      return jsonResponse({ error: "invalid_sync_interval" }, 422);
    }

    const admin = createAdminClient();
    const { data: existing, error: lookupError } = await admin
      .from("lead_source_connections")
      .select("id, token_rotated_at")
      .eq("user_id", user.id)
      .eq("spreadsheet_id", spreadsheetId)
      .eq("ready_tab_name", readyTabName)
      .maybeSingle();

    if (lookupError) {
      return jsonResponse({ error: "connection_lookup_failed" }, 500);
    }

    if (existing?.token_rotated_at) {
      const elapsed = Date.now() - new Date(existing.token_rotated_at).getTime();
      if (Number.isFinite(elapsed) && elapsed < 60_000) {
        return jsonResponse(
          { error: "token_rotation_too_frequent", retry_after_seconds: 60 },
          429,
          { "Retry-After": "60" },
        );
      }
    }

    const connectorToken = randomConnectorToken();
    const connectorTokenHash = await sha256Hex(connectorToken);
    const tokenPrefix = connectorToken.slice(0, 12);
    const now = new Date().toISOString();

    let connectionId: string;
    if (existing) {
      const { data, error } = await admin
        .from("lead_source_connections")
        .update({
          name,
          spreadsheet_url: spreadsheetUrl,
          raw_tab_name: rawTabName,
          status: "active",
          sync_mode: syncMode,
          sync_interval_minutes: interval,
          connector_token_hash: connectorTokenHash,
          connector_token_prefix: tokenPrefix,
          token_rotated_at: now,
          last_error: null,
        })
        .eq("id", existing.id)
        .eq("user_id", user.id)
        .select("id")
        .single();
      if (error || !data) {
        return jsonResponse({ error: "connection_update_failed" }, 500);
      }
      connectionId = data.id;
    } else {
      const { data, error } = await admin
        .from("lead_source_connections")
        .insert({
          user_id: user.id,
          name,
          spreadsheet_id: spreadsheetId,
          spreadsheet_url: spreadsheetUrl,
          raw_tab_name: rawTabName,
          ready_tab_name: readyTabName,
          status: "active",
          sync_mode: syncMode,
          sync_interval_minutes: interval,
          connector_token_hash: connectorTokenHash,
          connector_token_prefix: tokenPrefix,
          token_rotated_at: now,
        })
        .select("id")
        .single();
      if (error || !data) {
        return jsonResponse({ error: "connection_create_failed" }, 500);
      }
      connectionId = data.id;
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    return jsonResponse({
      connection_id: connectionId,
      connector_token: connectorToken,
      connector_token_prefix: tokenPrefix,
      ingest_url: `${supabaseUrl}/functions/v1/ingest-sheet-leads`,
      configured_at: now,
      token_displayed_once: true,
    });
  } catch {
    return jsonResponse({ error: "internal_error" }, 500);
  }
});

