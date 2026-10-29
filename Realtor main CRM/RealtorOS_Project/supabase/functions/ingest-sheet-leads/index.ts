import {
  createAdminClient,
  isUuid,
  jsonResponse,
  readJsonBody,
  sha256Hex,
} from "../_shared/runtime.ts";

type IngestRequest = {
  source_event_id?: unknown;
  sheet_revision?: unknown;
  rows?: unknown;
};

function text(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405, {
      Allow: "POST",
    });
  }

  try {
    const authorization = request.headers.get("authorization") ?? "";
    const connectorToken = authorization.startsWith("Bearer ")
      ? authorization.slice(7).trim()
      : "";
    if (!/^ros_[A-Za-z0-9_-]{40,100}$/.test(connectorToken)) {
      return jsonResponse({ error: "invalid_connector_credentials" }, 401);
    }

    const timestampText = request.headers.get("x-realtoros-timestamp") ?? "";
    const timestampSeconds = Number(timestampText);
    if (
      !Number.isInteger(timestampSeconds) ||
      Math.abs(Math.floor(Date.now() / 1_000) - timestampSeconds) > 300
    ) {
      return jsonResponse({ error: "stale_or_invalid_timestamp" }, 401);
    }

    const nonce = request.headers.get("x-realtoros-nonce") ?? "";
    if (!isUuid(nonce)) {
      return jsonResponse({ error: "invalid_nonce" }, 422);
    }

    let input: IngestRequest;
    try {
      input = await readJsonBody(request, 1_000_000) as IngestRequest;
    } catch (error) {
      if (error instanceof RangeError) {
        return jsonResponse({ error: "request_too_large" }, 413);
      }
      return jsonResponse({ error: "invalid_json" }, 400);
    }

    const sourceEventId = text(input.source_event_id, 200);
    const sheetRevision = text(input.sheet_revision, 200);
    if (!isUuid(sourceEventId)) {
      return jsonResponse({ error: "invalid_source_event_id" }, 422);
    }
    if (!Array.isArray(input.rows) || input.rows.length < 1 || input.rows.length > 500) {
      return jsonResponse({ error: "rows_must_contain_1_to_500_items" }, 422);
    }

    const admin = createAdminClient();
    const tokenHash = await sha256Hex(connectorToken);
    const { data: connection, error: connectionError } = await admin
      .from("lead_source_connections")
      .select("id, user_id")
      .eq("connector_token_hash", tokenHash)
      .eq("status", "active")
      .maybeSingle();

    if (connectionError || !connection) {
      return jsonResponse({ error: "invalid_connector_credentials" }, 401);
    }

    const { data: existingBatch, error: replayError } = await admin
      .from("lead_import_batches")
      .select(
        "id,status,source_row_count,accepted_count,duplicate_count,rejected_count,imported_count",
      )
      .eq("user_id", connection.user_id)
      .eq("connection_id", connection.id)
      .eq("source_event_id", sourceEventId)
      .maybeSingle();

    if (replayError) {
      return jsonResponse({ error: "replay_check_failed" }, 500);
    }
    if (existingBatch) {
      return jsonResponse({
        batch_id: existingBatch.id,
        status: existingBatch.status,
        source_row_count: existingBatch.source_row_count,
        accepted_count: existingBatch.accepted_count,
        duplicate_count: existingBatch.duplicate_count,
        rejected_count: existingBatch.rejected_count,
        imported_count: existingBatch.imported_count,
        replayed: true,
      });
    }

    const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();
    const { count, error: rateError } = await admin
      .from("lead_import_batches")
      .select("id", { count: "exact", head: true })
      .eq("connection_id", connection.id)
      .gte("created_at", oneMinuteAgo);

    if (rateError) {
      return jsonResponse({ error: "rate_limit_check_failed" }, 500);
    }
    if ((count ?? 0) >= 30) {
      return jsonResponse(
        { error: "rate_limit_exceeded", retry_after_seconds: 60 },
        429,
        { "Retry-After": "60" },
      );
    }

    const { data, error } = await admin.rpc("realtoros_ingest_lead_batch", {
      p_connection_id: connection.id,
      p_source_event_id: sourceEventId,
      p_sheet_revision: sheetRevision || null,
      p_rows: input.rows,
    });

    if (error) {
      const validationError =
        error.code === "22023" ||
        error.message?.includes("row_count") ||
        error.message?.includes("rows_must");
      return jsonResponse(
        { error: validationError ? "batch_validation_failed" : "ingestion_failed" },
        validationError ? 422 : 500,
      );
    }

    return jsonResponse(data as Record<string, unknown>);
  } catch {
    return jsonResponse({ error: "internal_error" }, 500);
  }
});

