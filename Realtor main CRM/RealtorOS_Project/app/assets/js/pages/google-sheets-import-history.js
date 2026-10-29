/* ============================================================
   google-sheets-import-history.js — Settings → Import History.
   Read-only import history for both sources: Google Sheets syncs and
   one-time file uploads (Phase 4E.4), plus troubleshooting help.

   IMPORTANT BACKEND LIMITATION: there is no authenticated frontend
   endpoint for replaying or retrying an import. This module never calls
   ingest-sheet-leads and never inserts/updates/deletes an import batch or
   row — every action here is a SELECT, and "Retry Loading"/"Refresh
   History" only repeat that same SELECT. The only real resynchronization
   path is: fix Raw Leads → Sync Now (or the trigger) inside the Sheet →
   Refresh History here.

   Depends on: app.js, store.js (App.store.sheetConnections,
   App.store.sheetImportHistory), util.js
   ============================================================ */

window.App = window.App || {};
App.pages = App.pages || {};

App.pages.googleSheetsImportHistory = (function () {
  "use strict";

  const U = () => App.util;
  const S = () => App.store;

  const BATCH_PAGE_SIZE = 20;
  const ROW_PAGE_SIZE = 50;

  const BATCH_STATUS_META = {
    received:   { label: "Received", cls: "badge-info" },
    processing: { label: "Processing", cls: "badge-warning" },
    completed:  { label: "Completed", cls: "badge-success" },
    partial:    { label: "Completed with rejected rows", cls: "badge-warning" },
    failed:     { label: "Failed", cls: "badge-danger" }
  };
  const BATCH_STATUSES = ["received", "processing", "completed", "partial", "failed"];

  const ROW_STATUS_META = {
    accepted:  { label: "Accepted", cls: "badge-info" },
    imported:  { label: "Imported", cls: "badge-success" },
    duplicate: { label: "Duplicate (matched existing contact)", cls: "badge-neutral" },
    rejected:  { label: "Rejected", cls: "badge-danger" },
    failed:    { label: "Failed", cls: "badge-danger" }
  };
  const ROW_STATUSES = ["accepted", "imported", "duplicate", "rejected", "failed"];

  // Backend rejection codes this module recognizes (see
  // supabase/migrations/…_add_atomic_sheet_lead_ingestion.sql). Any other
  // code falls back to the escaped database error message plus generic
  // guidance — the code itself is never interpolated into HTML or a CSS
  // class, only used as a plain object-key lookup below.
  const REJECTION_GUIDANCE = {
    missing_lead_id: "This row has no usable lead identifier. Leave the ID column blank so RealtorOS can create one, or fix the value in Raw Leads.",
    missing_full_name: "Add the lead's full name in Raw Leads.",
    missing_contact_channel: "Add at least an email address or phone number in Raw Leads.",
    identity_conflict: "Check that the email and phone belong to the same person and correct the conflicting value in Raw Leads.",
    row_not_object: "This row could not be read as expected. Re-check the row's data in Raw Leads."
  };

  // Matches this app's own contact id convention (contacts.idPrefix "ct")
  // closely enough to reject anything that clearly isn't one, without
  // hard-coding one specific id generator's exact shape.
  const CONTACT_ID_PATTERN = /^ct_[A-Za-z0-9_-]{1,100}$/;

  function safeLookup(map, key) {
    if (typeof key !== "string") return null;
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
  }

  function statusBadge(meta, rawStatus) {
    const found = meta || null;
    const label = found ? found.label : "Unknown";
    const cls = found ? found.cls : "badge-neutral";
    return `<span class="badge ${cls}"><span class="dot"></span>${U().esc(label)}</span>`;
  }
  function batchStatusBadge(status) { return statusBadge(safeLookup(BATCH_STATUS_META, status), status); }
  function rowStatusBadge(status) { return statusBadge(safeLookup(ROW_STATUS_META, status), status); }

  function formatTimestamp(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleString();
  }

  function contactLinkHtml(contactId) {
    if (typeof contactId !== "string" || !CONTACT_ID_PATTERN.test(contactId)) return "";
    return `<a class="link" href="#/contacts/${U().esc(contactId)}">View Contact</a>`;
  }

  /* ============================================================
   * RENDER ENTRY POINT
   * ========================================================== */
  // Fresh, self-contained state per render() call. If the user navigates
  // away while a request is pending, this `state` object and the `pane`
  // it closes over are simply abandoned — any late-arriving response only
  // ever writes into this same detached subtree, never into whatever the
  // next page rendered, so nothing can cross-contaminate another page.

  async function render(pane) {
    if (!pane) return;

    const state = {
      connections: [],
      connectionsError: null,
      connectionId: "",
      sourceType: "",
      status: "",
      batches: [],
      batchTotal: 0,
      batchOffset: 0,
      batchToken: 0,
      batchLoading: false,
      summaryBatch: null,
      summaryToken: 0,
      connectionsToken: 0,
      connectionsRequest: null, // shared in-flight sheetConnections.list() promise, if any
      expandedBatchId: null,
      rowState: {} // batchId -> { status, offset, rows, total, loaded, loading, token }
    };

    pane.innerHTML = App.app.loadingHtml ? App.app.loadingHtml("your import history") : "";

    try {
      state.connections = await S().sheetConnections.list();
    } catch (err) {
      state.connections = [];
      state.connectionsError = err && err.message ? err.message : "Unknown error";
    }

    renderShell(pane, state);
    await Promise.all([loadSummary(pane, state), loadBatches(pane, state)]);
  }

  function connectionName(state, connectionId) {
    const conn = (state.connections || []).find(c => c.id === connectionId);
    if (conn && conn.name) return conn.name;
    return conn ? "Google Sheets" : "Unknown connection";
  }

  // Where a batch came from, in words: the file's name for an upload, the
  // connection's name for a Google Sheet sync.
  function batchSourceLabel(state, b) {
    if (b && b.source_type === "file_upload") return "File upload · " + (b.file_name || "file");
    return "Google Sheet · " + connectionName(state, b && b.connection_id);
  }

  /* ============================================================
   * STATIC SHELL
   * ========================================================== */

  function renderShell(pane, state) {
    const connectionOptions = (state.connections || []).map(c =>
      `<option value="${U().esc(c.id)}">${U().esc(c.name || "Google Sheets")}</option>`
    ).join("");
    const statusOptions = BATCH_STATUSES.map(s =>
      `<option value="${U().esc(s)}">${U().esc(BATCH_STATUS_META[s].label)}</option>`
    ).join("");

    pane.innerHTML = `
      <div class="settings-category-head">
        <div class="settings-category-title">Import History</div>
        <p class="form-help">Review imports from Google Sheets and from uploaded files, and fix rejected leads.</p>
      </div>
      <div style="margin-bottom:16px">
        <button type="button" class="btn btn-sm" id="gsihManageBtn">Manage Google Sheets</button>
      </div>

      <div class="release-callout gsih-disclosure">
        <strong>Row details reflect the latest sync, not a frozen snapshot.</strong>
        <p style="margin:6px 0 0">Each Raw Leads row is tracked by its lead identifier. When a row is corrected and
        synced again, its record moves to the newest import — so an older import's row list may no longer show
        every row that was originally part of it. Import totals above always reflect what happened in that
        specific import; individual results are always the current, latest outcome for that row.</p>
      </div>

      <div class="release-callout release-callout-warning" id="gsihConnWarning" ${state.connectionsError ? "" : "hidden"}>
        <strong>Connection names could not be loaded.</strong>
        <p id="gsihConnWarningMsg" style="margin:6px 0 10px">${state.connectionsError ? U().esc(state.connectionsError) : ""}</p>
        <p class="form-help" style="margin:0 0 10px">Imports below are still shown using "Unknown connection" where a name could not be found.</p>
        <button type="button" class="btn btn-sm" id="gsihConnRetryBtn">Retry Connections</button>
      </div>

      <section class="card" id="gsihSummaryCard" hidden>
        <div class="card-header"><div class="card-title">Most recent sync</div></div>
        <div class="card-body" id="gsihSummaryBody"></div>
      </section>

      <section class="card">
        <div class="card-body">
          <div class="gsih-filter-bar">
            <label class="field">
              <span>Source</span>
              <select id="gsihSourceFilter">
                <option value="">All sources</option>
                <option value="google_sheet">Google Sheet</option>
                <option value="file_upload">File upload</option>
              </select>
            </label>
            <label class="field">
              <span>Connection</span>
              <select id="gsihConnFilter">
                <option value="">All connections</option>
                ${connectionOptions}
              </select>
            </label>
            <label class="field">
              <span>Import status</span>
              <select id="gsihStatusFilter">
                <option value="">All statuses</option>
                ${statusOptions}
              </select>
            </label>
            <button type="button" class="btn" id="gsihRefreshBtn">Refresh History</button>
          </div>
          <p id="gsihLiveStatus" class="profile-edit-message" aria-live="polite" role="status"></p>
        </div>
      </section>

      <section class="card">
        <div class="card-header"><div class="card-title">Imports</div></div>
        <div class="card-body" id="gsihBatchBody"></div>
        <div class="gsih-pagination" id="gsihBatchPagination"></div>
      </section>

      <section class="card">
        <div class="card-header"><div class="card-title">Troubleshooting</div></div>
        <div class="card-body">
          <ol class="gs-install-steps">
            <li>Open the connected Google Sheet.</li>
            <li>Correct rejected information in <strong>Raw Leads</strong>.</li>
            <li>Do not edit <strong>Ready</strong> — it is fully script-managed.</li>
            <li>Use <strong>RealtorOS → Sync Now</strong> in the Sheet for an immediate synchronization.</li>
            <li>Alternatively, wait for the approximate 15-minute installed trigger.</li>
            <li>Return here and select <strong>Refresh History</strong>.</li>
          </ol>
          <div class="release-callout" style="margin-top:10px">
            <ul class="gs-explainer-list">
              <li>Duplicate rows generally mean RealtorOS matched an existing contact by email or phone — nothing was lost.</li>
              <li>Rejected rows were not imported until the underlying value is corrected.</li>
              <li>Ready is rebuilt automatically from Raw Leads on every sync.</li>
              <li>The Sheet can remain closed while a triggered synchronization runs.</li>
              <li>Only the connection owner should configure the connector token and install the trigger.</li>
              <li>This page cannot safely replay or retry an import — there is no such request it's allowed to make.</li>
            </ul>
          </div>
        </div>
      </section>
    `;

    pane.querySelector("#gsihManageBtn").addEventListener("click", () => App.app.navigate("/settings/google-sheets"));

    pane.querySelector("#gsihConnFilter").addEventListener("change", (e) => {
      state.connectionId = e.target.value;
      state.batchOffset = 0;
      loadBatches(pane, state);
    });
    pane.querySelector("#gsihSourceFilter").addEventListener("change", (e) => {
      state.sourceType = e.target.value;
      state.batchOffset = 0;
      loadBatches(pane, state);
    });
    pane.querySelector("#gsihStatusFilter").addEventListener("change", (e) => {
      state.status = e.target.value;
      state.batchOffset = 0;
      loadBatches(pane, state);
    });
    pane.querySelector("#gsihConnRetryBtn").addEventListener("click", async () => {
      const btn = pane.querySelector("#gsihConnRetryBtn");
      if (btn.disabled) return;
      const filterChanged = await reloadConnections(pane, state);
      if (filterChanged === null) return; // superseded by a newer connections reload; that call already rendered
      if (filterChanged) await loadBatches(pane, state);
      else renderBatchList(pane, state);
    });
    pane.querySelector("#gsihRefreshBtn").addEventListener("click", async () => {
      const btn = pane.querySelector("#gsihRefreshBtn");
      if (btn.disabled) return;
      // Refresh History also retries connection loading, so a connection
      // failure can be cleared without a separate click on Retry Connections.
      // loadBatches/loadSummary always run here regardless of whether this
      // call's own connections reload was superseded — they carry their
      // own independent stale-response protection (batchToken/summaryToken).
      setPageBusy(pane, true);
      await reloadConnections(pane, state);
      await Promise.all([loadSummary(pane, state), loadBatches(pane, state)]);
    });
  }

  // Re-fetches connection names only (never the batches, except when the
  // effective connection filter itself just became invalid — see below)
  // and refreshes every already-rendered piece that shows a connection
  // name. Used by both "Retry Connections" and "Refresh History".
  //
  // Both buttons can trigger this, so a single shared connectionsToken +
  // connectionsRequest guard the actual network call: only one
  // sheetConnections.list() is ever in flight at a time — a second caller
  // reuses that same promise rather than starting a competing request —
  // and only the LATEST caller (by token) is allowed to apply the result
  // and re-render, so an older response can never overwrite newer state.
  //
  // Returns:
  //   true  — completed, and the effective connection filter changed (the
  //           previously selected connection no longer exists)
  //   false — completed, filter unchanged
  //   null  — superseded by a newer reloadConnections call; this call did
  //           nothing further and the caller should also do nothing further
  async function reloadConnections(pane, state) {
    // renderBatchList/loadBatches below rebuild the batch cards; collapse
    // first so that rebuild can't leave a stale-expanded card with an
    // empty panel (the same hazard loadBatches guards against).
    collapseAllRowPanels(state);

    const myToken = ++state.connectionsToken;
    setConnectionsBusy(pane, true);

    if (!state.connectionsRequest) {
      state.connectionsRequest = S().sheetConnections.list().then(
        (rows) => ({ ok: true, rows: rows }),
        (err) => ({ ok: false, message: err && err.message ? err.message : "Unknown error" })
      ).finally(() => { state.connectionsRequest = null; });
    }
    const outcome = await state.connectionsRequest;

    if (myToken !== state.connectionsToken) {
      // A newer reloadConnections call has since started; it owns applying
      // whatever outcome eventually arrives (possibly this same shared
      // promise). Nothing here is still the newest intended operation.
      return null;
    }

    let filterChanged = false;
    if (outcome.ok) {
      state.connections = outcome.rows;
      state.connectionsError = null;
      // Only a successful fetch can prove whether the previously selected
      // connection still exists. A failed fetch must never be treated as
      // proof it was removed — leave state.connections, the filter's
      // options, and state.connectionId exactly as they were, so a
      // previously selected connection keeps being queried (and keeps
      // showing its real name) through a failed refresh, and the select
      // never falls back to displaying "All connections" while a specific
      // connection id is still the one actually being queried.
      filterChanged = rebuildConnectionFilterOptions(pane, state);
    } else {
      state.connectionsError = outcome.message;
    }

    setConnectionsBusy(pane, false);
    updateConnectionWarning(pane, state);
    renderSummary(pane, state);
    if (filterChanged) state.batchOffset = 0;
    return filterChanged;
  }

  function setConnectionsBusy(pane, busy) {
    const btn = pane.querySelector("#gsihConnRetryBtn");
    if (btn) btn.disabled = busy;
  }

  function updateConnectionWarning(pane, state) {
    const el = pane.querySelector("#gsihConnWarning");
    const msgEl = pane.querySelector("#gsihConnWarningMsg");
    if (!el) return;
    el.hidden = !state.connectionsError;
    if (msgEl) msgEl.textContent = state.connectionsError || "";
  }

  // Rebuilds the connection <select>'s options from state.connections.
  // state.connectionId (not the select's own prior DOM value) is the
  // authoritative "currently selected connection" — if it no longer
  // matches any refreshed connection, both the select and state.connectionId
  // are reset to "" (All connections) together, so the displayed option and
  // the connectionId any subsequent listBatches() call uses always agree.
  // Returns true when the effective filter changed (was a specific id, now
  // reset to "all"), false otherwise.
  function rebuildConnectionFilterOptions(pane, state) {
    const select = pane.querySelector("#gsihConnFilter");
    if (!select) return false;
    const current = state.connectionId;
    const stillExists = !!current && (state.connections || []).some(c => c.id === current);
    const options = (state.connections || []).map(c =>
      `<option value="${U().esc(c.id)}">${U().esc(c.name || "Google Sheets")}</option>`
    ).join("");
    select.innerHTML = `<option value="">All connections</option>${options}`;
    if (stillExists) {
      select.value = current;
      return false;
    }
    select.value = "";
    const changed = !!current;
    state.connectionId = "";
    return changed;
  }

  function setLiveStatus(pane, text, kind) {
    const el = pane.querySelector("#gsihLiveStatus");
    if (!el) return;
    el.textContent = text || "";
    el.className = "profile-edit-message" + (kind ? " " + kind : "");
  }

  /* ============================================================
   * SUMMARY (absolute newest batch — independent of filters)
   * ========================================================== */

  async function loadSummary(pane, state) {
    const myToken = ++state.summaryToken;
    try {
      const result = await S().sheetImportHistory.listBatches({ limit: 1, offset: 0 });
      if (myToken !== state.summaryToken) return; // superseded
      state.summaryBatch = (result.rows && result.rows[0]) || null;
      renderSummary(pane, state);
    } catch (err) {
      if (myToken !== state.summaryToken) return;
      state.summaryBatch = null;
      // The summary is a "nice to have" — a failure here shouldn't block
      // the rest of the page; the batch list below has its own error/retry.
    }
  }

  function renderSummary(pane, state) {
    const card = pane.querySelector("#gsihSummaryCard");
    const body = pane.querySelector("#gsihSummaryBody");
    if (!card || !body) return;
    const b = state.summaryBatch;
    if (!b) { card.hidden = true; body.innerHTML = ""; return; }
    card.hidden = false;
    body.innerHTML = `
      <div class="settings-status-grid">
        <div class="settings-status-card"><div class="k">Source</div><div class="v">${U().esc(batchSourceLabel(state, b))}</div></div>
        <div class="settings-status-card"><div class="k">Status</div><div class="v">${batchStatusBadge(b.status)}</div></div>
        <div class="settings-status-card"><div class="k">Started</div><div class="v">${U().esc(formatTimestamp(b.started_at))}</div></div>
        <div class="settings-status-card"><div class="k">Completed</div><div class="v">${U().esc(formatTimestamp(b.completed_at))}</div></div>
        <div class="settings-status-card"><div class="k">Source rows</div><div class="v">${U().esc(b.source_row_count)}</div></div>
        <div class="settings-status-card"><div class="k">Imported</div><div class="v">${U().esc(b.imported_count)}</div></div>
        <div class="settings-status-card"><div class="k">Duplicate / matched</div><div class="v">${U().esc(b.duplicate_count)}</div></div>
        <div class="settings-status-card"><div class="k">Rejected</div><div class="v">${U().esc(b.rejected_count)}</div></div>
      </div>
      ${b.error_summary ? `<div class="release-callout release-callout-danger" style="margin-top:12px">${U().esc(b.error_summary)}</div>` : ""}
    `;
  }

  /* ============================================================
   * BATCH LIST + PAGINATION
   * ========================================================== */

  async function loadBatches(pane, state) {
    // Any operation that rebuilds #gsihBatchBody (this function, called by
    // Refresh History, the connection/status filters, batch Previous/Next,
    // and Retry Loading) must first collapse whatever row panel was
    // expanded — otherwise the freshly rebuilt card for that batch id can
    // come back with a stale "expanded" flag, showing "Hide Row Results"
    // over an empty panel that nothing ever repopulates. Collapsing here,
    // once, covers every one of those call sites automatically.
    collapseAllRowPanels(state);

    const myToken = ++state.batchToken;
    state.batchLoading = true;
    setPageBusy(pane, true);
    renderBatchLoading(pane);
    setLiveStatus(pane, "Loading imports…");

    try {
      const result = await S().sheetImportHistory.listBatches({
        connectionId: state.connectionId || undefined,
        sourceType: state.sourceType || undefined,
        status: state.status || undefined,
        limit: BATCH_PAGE_SIZE,
        offset: state.batchOffset
      });
      if (myToken !== state.batchToken) return; // a newer request superseded this one
      state.batches = result.rows;
      state.batchTotal = result.total;
      state.batchOffset = result.offset;
      state.batchLoading = false;
      setPageBusy(pane, false);
      renderBatchList(pane, state);
      renderBatchPagination(pane, state);
      setLiveStatus(pane, state.batches.length
        ? "Loaded " + state.batches.length + " of " + state.batchTotal + " import(s)."
        : "No imports match the current filters.");
    } catch (err) {
      if (myToken !== state.batchToken) return;
      state.batchLoading = false;
      setPageBusy(pane, false);
      renderBatchError(pane, state, err);
      setLiveStatus(pane, "Could not load import history.", "error");
    }
  }

  function setPageBusy(pane, busy) {
    const refreshBtn = pane.querySelector("#gsihRefreshBtn");
    if (refreshBtn) refreshBtn.disabled = busy;
  }

  function renderBatchLoading(pane) {
    const body = pane.querySelector("#gsihBatchBody");
    if (body) body.innerHTML = App.app.loadingHtml ? App.app.loadingHtml("imports") : "";
    const pag = pane.querySelector("#gsihBatchPagination");
    if (pag) pag.innerHTML = "";
  }

  function renderBatchError(pane, state, err) {
    const body = pane.querySelector("#gsihBatchBody");
    if (!body) return;
    body.innerHTML = `
      <div class="empty-state">
        <div class="empty-title">Could not load import history</div>
        <div class="empty-desc">${U().esc(err && err.message ? err.message : "Unknown error")}</div>
        <button type="button" class="btn btn-primary" id="gsihBatchRetry">Retry Loading</button>
      </div>`;
    const retryBtn = body.querySelector("#gsihBatchRetry");
    if (retryBtn) retryBtn.addEventListener("click", () => loadBatches(pane, state));
    const pag = pane.querySelector("#gsihBatchPagination");
    if (pag) pag.innerHTML = "";
  }

  function renderBatchList(pane, state) {
    const body = pane.querySelector("#gsihBatchBody");
    if (!body) return;

    // Only treat "no connections" as a genuine empty state when the
    // connections query actually succeeded and came back empty. When it
    // failed instead (state.connectionsError set), state.connections is
    // also [] — but that must never be read as "connect a Google Sheet
    // first": the warning banner above already explains the failure, and
    // batches (looked up with "Unknown connection" as needed) still render
    // normally below if the batch query itself succeeded.
    if (!state.connectionsError && (!state.connections || state.connections.length === 0)) {
      body.innerHTML = `
        <div class="empty-state">
          <div class="empty-title">No Google Sheets connections yet</div>
          <div class="empty-desc">Connect a Google Sheet first to start seeing import history here.</div>
          <button type="button" class="btn btn-primary" id="gsihGoConnectBtn">Manage Google Sheets</button>
        </div>`;
      const btn = body.querySelector("#gsihGoConnectBtn");
      if (btn) btn.addEventListener("click", () => App.app.navigate("/settings/google-sheets"));
      return;
    }

    if (!state.batches || state.batches.length === 0) {
      const filtered = !!(state.connectionId || state.sourceType || state.status);
      body.innerHTML = `
        <div class="empty-state">
          <div class="empty-title">${filtered ? "No imports match these filters" : "No imports yet"}</div>
          <div class="empty-desc">${filtered
            ? "Try All connections / All statuses, or check back after the next sync."
            : "Once a Google Sheet syncs leads, its imports will appear here."}</div>
        </div>`;
      return;
    }

    body.innerHTML = state.batches.map(b => renderBatchCard(state, b)).join("");

    const byId = {};
    state.batches.forEach(b => { byId[b.id] = b; });
    body.querySelectorAll("[data-view-rows]").forEach(btn => {
      const batch = byId[btn.getAttribute("data-view-rows")];
      if (batch) btn.addEventListener("click", () => toggleRowPanel(pane, state, batch));
    });
  }

  function renderBatchCard(state, b) {
    const isExpanded = state.expandedBatchId === b.id;
    return `
      <div class="gsih-batch-card">
        <div class="gsih-batch-head">
          <div>
            <div class="gsih-batch-conn">${U().esc(batchSourceLabel(state, b))}</div>
            <div class="form-help">Created ${U().esc(formatTimestamp(b.created_at))}</div>
          </div>
          ${batchStatusBadge(b.status)}
        </div>
        <div class="settings-status-grid">
          <div class="settings-status-card"><div class="k">Started</div><div class="v">${U().esc(formatTimestamp(b.started_at))}</div></div>
          <div class="settings-status-card"><div class="k">Completed</div><div class="v">${U().esc(formatTimestamp(b.completed_at))}</div></div>
          <div class="settings-status-card"><div class="k">Source rows</div><div class="v">${U().esc(b.source_row_count)}</div></div>
          <div class="settings-status-card"><div class="k">Imported</div><div class="v">${U().esc(b.imported_count)}</div></div>
          <div class="settings-status-card"><div class="k">Duplicate</div><div class="v">${U().esc(b.duplicate_count)}</div></div>
          <div class="settings-status-card"><div class="k">Rejected</div><div class="v">${U().esc(b.rejected_count)}</div></div>
        </div>
        ${b.error_summary ? `<div class="release-callout release-callout-danger" style="margin-top:10px">${U().esc(b.error_summary)}</div>` : ""}
        <div class="gsih-batch-actions">
          <button type="button" class="btn btn-sm" data-view-rows="${U().esc(b.id)}">${isExpanded ? "Hide Row Results" : "View Row Results"}</button>
        </div>
        <div class="gsih-row-panel" data-row-panel-for="${U().esc(b.id)}" ${isExpanded ? "" : "hidden"}></div>
      </div>`;
  }

  function renderBatchPagination(pane, state) {
    const el = pane.querySelector("#gsihBatchPagination");
    if (!el) return;
    if (!state.batchTotal) { el.innerHTML = ""; return; }

    const shown = state.batches.length;
    const from = shown ? state.batchOffset + 1 : 0;
    const to = state.batchOffset + shown;
    const hasPrev = state.batchOffset > 0;
    const hasNext = state.batchOffset + BATCH_PAGE_SIZE < state.batchTotal;

    el.innerHTML = `
      <button type="button" class="btn btn-sm" id="gsihBatchPrev" ${hasPrev ? "" : "disabled"}>Previous</button>
      <span class="form-help" aria-live="polite">${from}-${to} of ${state.batchTotal}</span>
      <button type="button" class="btn btn-sm" id="gsihBatchNext" ${hasNext ? "" : "disabled"}>Next</button>
    `;
    if (hasPrev) el.querySelector("#gsihBatchPrev").addEventListener("click", () => {
      state.batchOffset = Math.max(0, state.batchOffset - BATCH_PAGE_SIZE);
      loadBatches(pane, state);
    });
    if (hasNext) el.querySelector("#gsihBatchNext").addEventListener("click", () => {
      state.batchOffset = state.batchOffset + BATCH_PAGE_SIZE;
      loadBatches(pane, state);
    });
  }

  /* ============================================================
   * ROW RESULTS (lazy-loaded per batch, accordion-style)
   * ========================================================== */

  // Collapses whatever row panel is currently expanded and discards all
  // per-batch row state. Any row request already in flight for one of
  // these entries is staled by bumping its token, so a late response can
  // never populate a panel that no longer belongs to it (whether that
  // panel was rebuilt for the same batch id or dropped from the list
  // entirely).
  function collapseAllRowPanels(state) {
    Object.keys(state.rowState).forEach((batchId) => {
      const rs = state.rowState[batchId];
      rs.token = (rs.token || 0) + 1;
    });
    state.expandedBatchId = null;
    state.rowState = {};
  }

  function toggleRowPanel(pane, state, batch) {
    const wasExpanded = state.expandedBatchId === batch.id;
    state.expandedBatchId = wasExpanded ? null : batch.id;
    // Re-render the batch list so the toggled button label/panel[hidden]
    // reflect the new state (and any previously-expanded panel collapses).
    renderBatchList(pane, state);
    if (!wasExpanded) {
      const rs = state.rowState[batch.id] || (state.rowState[batch.id] = {
        status: "", offset: 0, rows: [], total: 0, loaded: false, loading: false, token: 0
      });
      renderRowPanelShell(pane, state, batch, rs);
      if (!rs.loaded) loadRows(pane, state, batch, rs);
      else renderRowList(pane, state, batch, rs);
    }
  }

  function renderRowPanelShell(pane, state, batch, rs) {
    const panel = findRowPanel(pane, batch.id);
    if (!panel) return;
    const statusOptions = ROW_STATUSES.map(s =>
      `<option value="${U().esc(s)}">${U().esc(ROW_STATUS_META[s].label)}</option>`
    ).join("");
    panel.innerHTML = `
      <div class="gsih-row-toolbar">
        <label class="field">
          <span>Row status</span>
          <select data-row-status-select>
            <option value="">All rows</option>
            ${statusOptions}
          </select>
        </label>
        <p class="form-help" style="margin:0;flex:1 1 260px">Rows show each source row's <strong>latest</strong> synced outcome, not a frozen snapshot of this import.</p>
      </div>
      <p class="profile-edit-message" data-row-live aria-live="polite" role="status"></p>
      <div data-row-list></div>
      <div class="gsih-pagination" data-row-pagination></div>
    `;
    panel.querySelector("[data-row-status-select]").value = rs.status;
    panel.querySelector("[data-row-status-select]").addEventListener("change", (e) => {
      if (rs.loading) return; // the select is disabled while loading; this is defense in depth
      rs.status = e.target.value;
      rs.offset = 0;
      loadRows(pane, state, batch, rs);
    });
    setRowPanelBusy(panel, rs.loading);
  }

  // Disables the row-status filter and any Previous/Next/Retry buttons
  // currently present in this panel while a row request is in flight, so
  // a double-click (or a filter change mid-request) cannot fire a second
  // overlapping request or advance rs.offset more than once per click.
  // renderRowList/renderRowPagination/renderRowError rebuild Previous/Next/
  // Retry fresh (not disabled) on their own, but the row-status select is
  // part of the panel shell and is never rebuilt per request, so loadRows
  // always re-enables it (and, harmlessly, whatever Prev/Next/Retry exist)
  // explicitly once a request settles — always against whatever panel is
  // CURRENTLY rendered for this batch, never a captured/detached one.
  function setRowPanelBusy(panel, busy) {
    if (!panel) return;
    const selectEl = panel.querySelector("[data-row-status-select]");
    if (selectEl) selectEl.disabled = busy;
    panel.querySelectorAll("[data-row-prev], [data-row-next], [data-row-retry]").forEach((btn) => {
      btn.disabled = busy;
    });
  }

  // Looked up by attribute value in JS (not a dynamically-built CSS
  // selector) — same approach as the connection cards in
  // google-sheets-settings.js, so a batch id never has to be
  // selector-escaped.
  function findRowPanel(pane, batchId) {
    const panels = pane.querySelectorAll("[data-row-panel-for]");
    for (let i = 0; i < panels.length; i++) {
      if (panels[i].getAttribute("data-row-panel-for") === batchId) return panels[i];
    }
    return null;
  }

  async function loadRows(pane, state, batch, rs) {
    // Real request guard: a request already in flight for this row state
    // owns rs.loading/rs.token until it settles, so a stray duplicate call
    // (bypassing the disabled controls below) cannot start a second,
    // overlapping fetch or advance rs.offset again. Because state.rowState
    // is replaced wholesale on collapse (see collapseAllRowPanels), a
    // freshly (re-)expanded batch always gets a brand-new rs with
    // loading:false — a stale rs can never permanently block a later
    // request.
    if (rs.loading) return;
    const myToken = ++rs.token;
    rs.loading = true;
    const panel = findRowPanel(pane, batch.id);
    setRowPanelBusy(panel, true);
    setRowLive(pane, batch, "Loading row results…");
    const listEl = panel ? panel.querySelector("[data-row-list]") : null;
    if (listEl) listEl.innerHTML = App.app.loadingHtml ? App.app.loadingHtml("row results") : "";

    try {
      const result = await S().sheetImportHistory.listRows(batch.id, {
        status: rs.status || undefined,
        limit: ROW_PAGE_SIZE,
        offset: rs.offset
      });
      if (myToken !== rs.token) return; // superseded by a newer request for this same batch
      rs.rows = result.rows;
      rs.total = result.total;
      rs.offset = result.offset;
      rs.loaded = true;
      rs.loading = false;
      renderRowList(pane, state, batch, rs);
      // The `panel` captured above may since have been detached (the panel
      // was collapsed and/or reopened, or the batch list was rebuilt, while
      // this request was in flight) — re-resolve the CURRENTLY rendered
      // panel before touching its controls. renderRowList/renderRowPagination
      // rebuild Previous/Next fresh (not disabled) on the current panel
      // already; the row-status select is part of the panel shell and is
      // never rebuilt per request, so it must be re-enabled here explicitly.
      setRowPanelBusy(findRowPanel(pane, batch.id), false);
      setRowLive(pane, batch, rs.rows.length
        ? "Loaded " + rs.rows.length + " of " + rs.total + " row(s)."
        : "No row details are currently available for this import.");
    } catch (err) {
      if (myToken !== rs.token) return;
      rs.loading = false;
      // Render the retry control first, then ensure the CURRENT retry
      // button and status select (not a stale captured panel) are enabled.
      renderRowError(pane, state, batch, rs, err);
      setRowPanelBusy(findRowPanel(pane, batch.id), false);
      setRowLive(pane, batch, "Could not load row results.", "error");
    }
  }

  function setRowLive(pane, batch, text, kind) {
    const panel = findRowPanel(pane, batch.id);
    const el = panel ? panel.querySelector("[data-row-live]") : null;
    if (!el) return;
    el.textContent = text || "";
    el.className = "profile-edit-message" + (kind ? " " + kind : "");
  }

  function renderRowError(pane, state, batch, rs, err) {
    const panel = findRowPanel(pane, batch.id);
    const listEl = panel ? panel.querySelector("[data-row-list]") : null;
    if (!listEl) return;
    listEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-title">Could not load row results</div>
        <div class="empty-desc">${U().esc(err && err.message ? err.message : "Unknown error")}</div>
        <button type="button" class="btn btn-primary" data-row-retry>Retry Loading</button>
      </div>`;
    const retryBtn = listEl.querySelector("[data-row-retry]");
    if (retryBtn) retryBtn.addEventListener("click", () => loadRows(pane, state, batch, rs));
    const pagEl = panel.querySelector("[data-row-pagination]");
    if (pagEl) pagEl.innerHTML = "";
  }

  function renderRowList(pane, state, batch, rs) {
    const panel = findRowPanel(pane, batch.id);
    const listEl = panel ? panel.querySelector("[data-row-list]") : null;
    if (!listEl) return;

    if (!rs.rows || rs.rows.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-title">No row details currently available</div>
          <div class="empty-desc">${rs.status
            ? "No rows currently match this status for this import."
            : "This import's rows may have since moved to a newer import after a later sync — see the note above."}</div>
        </div>`;
      const pagEl = panel.querySelector("[data-row-pagination]");
      if (pagEl) pagEl.innerHTML = "";
      return;
    }

    listEl.innerHTML = rs.rows.map(renderRowItem).join("");
    renderRowPagination(pane, state, batch, rs);
  }

  function renderRowItem(row) {
    // Sheet guidance talks about Raw Leads; file rows use the plain reason
    // the import already stored.
    const guidance = row.source_type === "file_upload" ? null : safeLookup(REJECTION_GUIDANCE, row.error_code);
    let errorBlock = "";
    if (row.error_code || row.error_message) {
      const lines = [];
      if (guidance) {
        lines.push(`<p class="gsih-row-guidance">${U().esc(guidance)}</p>`);
      } else {
        if (row.error_message) lines.push(`<p class="gsih-row-guidance">${U().esc(row.error_message)}</p>`);
        // A row held back by the daily limit is fine as it is; its stored
        // reason already says when to upload the file again.
        if (row.error_code !== "daily_limit_reached") {
          lines.push(row.source_type === "file_upload"
            ? `<p class="gsih-row-guidance">Fix this row in your file and import it again.</p>`
            : `<p class="gsih-row-guidance">Correct this row in Raw Leads and synchronize again.</p>`);
        }
      }
      errorBlock = `<div class="release-callout release-callout-danger gsih-row-error">${lines.join("")}</div>`;
    }
    const contactLink = contactLinkHtml(row.contact_id);

    return `
      <div class="gsih-row-item">
        <div class="gsih-row-item-head">
          <span class="gsih-row-num">Row ${row.source_row_number != null ? "#" + U().esc(row.source_row_number) : "(unnumbered)"}</span>
          ${row.source_type === "file_upload" ? "" : `<span class="gsih-row-key">${U().esc(row.source_row_key || "—")}</span>`}
          ${rowStatusBadge(row.status)}
        </div>
        ${errorBlock}
        <div class="form-help">Last seen: ${U().esc(formatTimestamp(row.last_seen_at))}</div>
        ${contactLink ? `<div style="margin-top:4px">${contactLink}</div>` : ""}
      </div>`;
  }

  function renderRowPagination(pane, state, batch, rs) {
    const panel = findRowPanel(pane, batch.id);
    const el = panel ? panel.querySelector("[data-row-pagination]") : null;
    if (!el) return;
    if (!rs.total) { el.innerHTML = ""; return; }

    const shown = rs.rows.length;
    const from = shown ? rs.offset + 1 : 0;
    const to = rs.offset + shown;
    const hasPrev = rs.offset > 0;
    const hasNext = rs.offset + ROW_PAGE_SIZE < rs.total;

    el.innerHTML = `
      <button type="button" class="btn btn-sm" data-row-prev ${hasPrev ? "" : "disabled"}>Previous</button>
      <span class="form-help" aria-live="polite">${from}-${to} of ${rs.total}</span>
      <button type="button" class="btn btn-sm" data-row-next ${hasNext ? "" : "disabled"}>Next</button>
    `;
    if (hasPrev) el.querySelector("[data-row-prev]").addEventListener("click", () => {
      rs.offset = Math.max(0, rs.offset - ROW_PAGE_SIZE);
      loadRows(pane, state, batch, rs);
    });
    if (hasNext) el.querySelector("[data-row-next]").addEventListener("click", () => {
      rs.offset = rs.offset + ROW_PAGE_SIZE;
      loadRows(pane, state, batch, rs);
    });
  }

  return { render };
})();
