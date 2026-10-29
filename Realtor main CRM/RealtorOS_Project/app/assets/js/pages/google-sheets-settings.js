/* ============================================================
   google-sheets-settings.js — Settings → Google Sheets.
   Lets an authenticated user create a Google Sheets lead-import
   connection, view their existing connections, and rotate a
   connection's connector token. Creation/rotation always go through the
   existing create-sheet-connection Edge Function — this module never
   inserts a connector row directly and never sees the token hash.
   Depends on: app.js, store.js (App.store.sheetConnections), util.js
   ============================================================ */

window.App = window.App || {};
App.pages = App.pages || {};

App.pages.googleSheetsSettings = (function () {
  "use strict";

  const U = () => App.util;
  const S = () => App.store;

  const CANONICAL_INGEST_URL = "https://yanasorwmaybnabfuepn.supabase.co/functions/v1/ingest-sheet-leads";
  const TOKEN_PATTERN = /^ros_[A-Za-z0-9_-]{40,100}$/;
  const TOKEN_PREFIX_PATTERN = /^[A-Za-z0-9_-]{4,16}$/;
  const CONNECTION_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const SPREADSHEET_ID_PATTERN = /^[A-Za-z0-9_-]{10,300}$/;

  const DEFAULT_NAME = "Google Sheets";
  const DEFAULT_RAW_TAB = "Raw Leads";
  const DEFAULT_READY_TAB = "Ready";

  // Static wording only — never interpolates a connection name or any
  // other database/user value. Shown, identically, whether the rotation
  // was triggered by the "Rotate Token" button or by submitting the
  // create form with a (spreadsheet_id, ready_tab_name) pair that matches
  // an existing connection.
  const ROTATION_CONFIRM_MESSAGE =
    "The previous token for this connection will stop working immediately. The new token is shown only " +
    "once — you must run RealtorOS → Setup Connection inside the Google Sheet with the new " +
    "token afterward. Only continue if you're ready to update the Sheet right away.";

  // Shared across the create form and every "Rotate Token" button so only
  // one create/rotate request can be in flight for this page at a time.
  let requestInFlight = false;

  /* ============================================================
   * SPREADSHEET INPUT PARSING / VALIDATION
   * ========================================================== */

  // Strict parse of a Google Sheets URL. Every one of these must hold:
  //   - protocol is exactly "https:"
  //   - hostname is exactly "docs.google.com" (no subdomain/suffix
  //     deception in either direction, e.g. "docs.google.com.evil.com" or
  //     "evil.docs.google.com")
  //   - no embedded username/password (userinfo)
  //   - no nonstandard port (url.port is "" for both "no port given" and
  //     an explicit default port — the URL parser normalizes those the
  //     same way, so this rejects only a genuinely different port)
  //   - the path matches /spreadsheets/d/{id} where {id} is 10-300
  //     characters of [A-Za-z0-9_-], immediately followed by "/" or the
  //     end of the path — never by other punctuation stuck directly onto
  //     the id
  // Ordinary Google query strings and fragments (sharing params, #gid=…)
  // are untouched: they live in url.search/url.hash, never url.pathname,
  // so this check never has to special-case them.
  // Returns null for anything that doesn't satisfy every condition.
  function parseGoogleSheetsUrl(value) {
    if (typeof value !== "string" || !value) return null;
    let url;
    try { url = new URL(value); }
    catch (e) { return null; }
    if (url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    if (url.hostname !== "docs.google.com") return null;
    if (url.port !== "") return null;
    const match = url.pathname.match(/^\/spreadsheets\/d\/([A-Za-z0-9_-]{10,300})(?:\/|$)/);
    if (!match) return null;
    return { id: match[1], href: url.href };
  }

  // Used at render time to decide whether a stored spreadsheet_url is safe
  // to render as a clickable link — re-validated here rather than trusted,
  // even though it already passed this same check before being saved.
  function isSafeGoogleSheetsUrl(value) {
    return parseGoogleSheetsUrl(value) !== null;
  }

  // Accepts either a valid Google Sheets URL or a directly pasted Sheet ID.
  function parseSpreadsheetInput(raw) {
    const trimmed = String(raw == null ? "" : raw).trim();
    if (!trimmed) return { ok: false, error: "Enter a Google Sheets URL or Sheet ID." };

    const looksLikeUrl = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed);
    if (looksLikeUrl) {
      const parsed = parseGoogleSheetsUrl(trimmed);
      if (!parsed) {
        return {
          ok: false,
          error: "Enter an https://docs.google.com Google Sheets URL (no username/password) " +
            "containing /spreadsheets/d/{id}, or paste the Sheet ID directly."
        };
      }
      return { ok: true, id: parsed.id, url: parsed.href };
    }

    if (!SPREADSHEET_ID_PATTERN.test(trimmed)) {
      return {
        ok: false,
        error: "Enter a valid Sheet ID (10-300 letters, digits, \"_\" or \"-\") or a docs.google.com Sheets URL."
      };
    }
    return { ok: true, id: trimmed, url: "" };
  }

  function validateForm(fields) {
    const errors = {};

    let name = String(fields.name == null ? "" : fields.name).trim();
    if (!name) name = DEFAULT_NAME;
    if (name.length > 100) errors.name = "Connection name must be 100 characters or fewer.";

    const sheetResult = parseSpreadsheetInput(fields.spreadsheetInput);
    if (!sheetResult.ok) errors.spreadsheetInput = sheetResult.error;

    let rawTab = String(fields.rawTabName == null ? "" : fields.rawTabName).trim();
    if (!rawTab) rawTab = DEFAULT_RAW_TAB;
    let readyTab = String(fields.readyTabName == null ? "" : fields.readyTabName).trim();
    if (!readyTab) readyTab = DEFAULT_READY_TAB;

    if (rawTab.length > 100) errors.rawTabName = "Raw tab name must be 100 characters or fewer.";
    if (readyTab.length > 100) errors.readyTabName = "Ready tab name must be 100 characters or fewer.";
    if (!errors.rawTabName && !errors.readyTabName && rawTab === readyTab) {
      errors.readyTabName = "Raw and Ready tab names must be different.";
    }

    if (Object.keys(errors).length) return { ok: false, errors: errors };

    return {
      ok: true,
      values: {
        name: name,
        spreadsheet_id: sheetResult.id,
        spreadsheet_url: sheetResult.url || "",
        raw_tab_name: rawTab,
        ready_tab_name: readyTab,
        sync_mode: "push",
        sync_interval_minutes: 15
      }
    };
  }

  /* ============================================================
   * SUCCESS-RESPONSE VALIDATION
   * ========================================================== */

  function isValidTimestamp(value) {
    return typeof value === "string" && value.length > 0 && !isNaN(Date.parse(value));
  }

  function validateConnectionResponse(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, reason: "response_not_an_object" };
    }
    if (typeof data.connection_id !== "string" || !CONNECTION_UUID_PATTERN.test(data.connection_id)) {
      return { ok: false, reason: "invalid_connection_id" };
    }
    if (typeof data.connector_token !== "string" || !TOKEN_PATTERN.test(data.connector_token)) {
      return { ok: false, reason: "invalid_connector_token" };
    }
    if (typeof data.connector_token_prefix !== "string" || !TOKEN_PREFIX_PATTERN.test(data.connector_token_prefix)) {
      return { ok: false, reason: "invalid_connector_token_prefix" };
    }
    if (data.connector_token.indexOf(data.connector_token_prefix) !== 0) {
      return { ok: false, reason: "connector_token_prefix_mismatch" };
    }
    if (data.ingest_url !== CANONICAL_INGEST_URL) {
      return { ok: false, reason: "invalid_ingest_url" };
    }
    if (!isValidTimestamp(data.configured_at)) {
      return { ok: false, reason: "invalid_configured_at" };
    }
    if (data.token_displayed_once !== true) {
      return { ok: false, reason: "token_displayed_once_not_true" };
    }
    return { ok: true };
  }

  /* ============================================================
   * ERROR MESSAGE MAPPING
   * ========================================================== */

  const ERROR_MESSAGES = {
    authentication_required: "Your session has expired. Sign in again and retry.",
    invalid_spreadsheet: "That Sheet ID or URL wasn't accepted. Double-check it and try again.",
    invalid_sync_mode: "An unsupported sync mode was submitted — this is a RealtorOS bug, please report it.",
    invalid_sync_interval: "An unsupported sync interval was submitted — this is a RealtorOS bug, please report it.",
    connection_lookup_failed: "RealtorOS couldn't check for an existing connection. Please try again.",
    connection_create_failed: "RealtorOS couldn't create this connection. Please try again.",
    connection_update_failed: "RealtorOS couldn't update this connection. Please try again.",
    request_too_large: "That request was too large. Try a shorter connection name or tab names.",
    invalid_json: "RealtorOS couldn't read that request. Please try again.",
    internal_error: "RealtorOS hit an unexpected error. Please try again shortly."
  };

  function friendlyErrorMessage(err) {
    const code = err && err.code;
    if (code === "token_rotation_too_frequent") {
      const seconds = (err && typeof err.retryAfterSeconds === "number" && err.retryAfterSeconds > 0)
        ? err.retryAfterSeconds : 60;
      return "This connection was rotated too recently. Wait about " + seconds +
        " second" + (seconds === 1 ? "" : "s") + " and try again.";
    }
    if (code && ERROR_MESSAGES[code]) return ERROR_MESSAGES[code];
    if (err && err.message) return err.message;
    return "Something went wrong. Please try again.";
  }

  /* ============================================================
   * SMALL HELPERS
   * ========================================================== */

  function formatTimestamp(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleString();
  }

  // Self-contained copy helper (same navigator.clipboard-first, execCommand
  // fallback pattern used elsewhere in the app) — kept local to this module
  // rather than reaching into another page module's private functions.
  function copyToClipboard(text, successMessage) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text)
        .then(() => App.app.toast(successMessage || "Copied to clipboard.", "success"))
        .catch(() => fallbackCopy(text, successMessage));
      return;
    }
    fallbackCopy(text, successMessage);
  }
  function fallbackCopy(text, successMessage) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      App.app.toast(successMessage || "Copied to clipboard.", "success");
    } catch (e) {
      App.app.toast("Copy failed. Select the text manually.", "danger");
    }
    document.body.removeChild(ta);
  }

  function statusBadge(status) {
    const s = String(status || "").toLowerCase();
    const cls = s === "active" ? "badge-success" : (s === "paused" || s === "disabled") ? "badge-neutral" : "badge-warning";
    return `<span class="badge ${cls}"><span class="dot"></span>${U().esc(status || "unknown")}</span>`;
  }

  /* ============================================================
   * RENDER
   * ========================================================== */

  async function render(pane) {
    if (!pane) return;
    requestInFlight = false;
    pane.innerHTML = App.app.loadingHtml ? App.app.loadingHtml("your Google Sheets connections") : "";

    let connections;
    try {
      connections = await S().sheetConnections.list();
    } catch (err) {
      pane.innerHTML = App.app.errorHtml
        ? App.app.errorHtml("Could not load your Google Sheets connections: " + (err && err.message ? err.message : "Unknown error"))
        : "";
      const retryBtn = pane.querySelector('[data-role="route-retry"]');
      if (retryBtn) retryBtn.addEventListener("click", () => render(pane));
      return;
    }

    pane.innerHTML = `
      <div class="settings-category-head">
        <div class="settings-category-title">Google Sheets</div>
        <p class="form-help">Automatically import leads from a permanent Google Sheet into RealtorOS.</p>
      </div>

      <section class="card">
        <div class="card-header"><div class="card-title">Two ways to import leads</div></div>
        <div class="card-body" style="display:flex;flex-direction:column;gap:12px">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
            <div><strong>Import from file</strong><div class="form-help">One-time upload from a file (Excel or CSV).</div></div>
            <button type="button" class="btn" id="gsImportFileBtn">Import from file</button>
          </div>
          <div><strong>Google Sheets</strong><div class="form-help">Automatic sync from Google Sheets — set up below.</div></div>
        </div>
      </section>

      <section class="card">
        <div class="card-body">
          <div class="settings-section-title">How this works</div>
          <ul class="gs-explainer-list">
            <li>RealtorOS does not scrape or find leads for you.</li>
            <li>You supply lead data you're permitted to use, in your own Google Sheet.</li>
            <li>Leads are pasted into a <strong>Raw Leads</strong> tab.</li>
            <li>A <strong>Ready</strong> tab is rebuilt automatically from Raw Leads before every sync.</li>
            <li>New or changed content is synchronized securely, over HTTPS, with a per-connection token.</li>
            <li>Existing contacts are deduplicated by normalized email and phone — a sync never creates duplicates for a lead you already have.</li>
          </ul>
        </div>
      </section>

      <section class="card">
        <div class="card-header">
          <div class="card-title">Your connections</div>
        </div>
        <div class="card-body" id="gsConnectionsBody"></div>
      </section>

      <section class="card" id="gsCreateCard">
        <div class="card-header"><div class="card-title">Connect a Google Sheet</div></div>
        <div class="card-body">
          <p class="form-help">Using the same Sheet and the same Ready tab name as an existing connection rotates that connection's token instead of creating a duplicate.</p>
          <form id="gsCreateForm" novalidate>
            <div class="form-grid">
              <label class="field full">
                <span>Connection name</span>
                <input type="text" id="gsFieldName" maxlength="100" placeholder="${U().esc(DEFAULT_NAME)}" autocomplete="off">
                <div class="field-error-hint" id="gsFieldNameErr"></div>
              </label>
              <label class="field full">
                <span>Google Sheet URL or Sheet ID</span>
                <input type="text" id="gsFieldSheet" placeholder="https://docs.google.com/spreadsheets/d/… or a Sheet ID" autocomplete="off" required>
                <div class="field-error-hint" id="gsFieldSheetErr"></div>
              </label>
              <label class="field">
                <span>Raw tab name</span>
                <input type="text" id="gsFieldRawTab" maxlength="100" placeholder="${U().esc(DEFAULT_RAW_TAB)}" autocomplete="off">
                <div class="field-error-hint" id="gsFieldRawTabErr"></div>
              </label>
              <label class="field">
                <span>Ready tab name</span>
                <input type="text" id="gsFieldReadyTab" maxlength="100" placeholder="${U().esc(DEFAULT_READY_TAB)}" autocomplete="off">
                <div class="field-error-hint" id="gsFieldReadyTabErr"></div>
              </label>
            </div>
            <button type="submit" class="btn btn-primary" id="gsCreateSubmit" style="margin-top:14px">${App.app.icon("plus")} Connect Google Sheet</button>
            <p id="gsFormMessage" class="profile-edit-message" aria-live="polite"></p>
          </form>
        </div>
      </section>

      <section class="card">
        <div class="card-header"><div class="card-title">Installing the Apps Script connector</div></div>
        <div class="card-body">
          <ol class="gs-install-steps">
            <li>Open the permanent lead-intake Google Sheet.</li>
            <li>Open <strong>Extensions → Apps Script</strong>.</li>
            <li>Install the supplied RealtorOS <code>Code.gs</code> and <code>appsscript.json</code> files.</li>
            <li>Reload the spreadsheet.</li>
            <li>Open <strong>RealtorOS → Setup Connection</strong>.</li>
            <li>Paste the ingest URL and the one-time connector token shown below after connecting.</li>
            <li>Confirm the Raw Leads and Ready tab names.</li>
            <li>Open <strong>RealtorOS → Install 15-Minute Trigger</strong>.</li>
            <li>Complete Google's authorization prompt.</li>
            <li>Paste leads only into Raw Leads.</li>
          </ol>
          <div class="release-callout" style="margin-top:10px">
            <strong>A few things worth knowing:</strong>
            <ul class="gs-explainer-list">
              <li>Ready is script-managed and must not be edited by hand — every sync rebuilds it from Raw Leads.</li>
              <li>All corrections belong in Raw Leads, including corrections to rejected rows.</li>
              <li><strong>Sync Now</strong> in the Sheet's RealtorOS menu can be used for an immediate sync at any time.</li>
              <li>The Sheet can stay closed while the scheduled 15-minute sync runs in the background.</li>
              <li>Google's 15-minute schedule is approximate, not exact.</li>
              <li>Only the connection owner should configure the token and install the trigger.</li>
              <li>Other editors of the spreadsheet must not install their own additional RealtorOS trigger.</li>
            </ul>
          </div>
        </div>
      </section>
    `;

    const importFileBtn = pane.querySelector("#gsImportFileBtn");
    if (importFileBtn) {
      importFileBtn.addEventListener("click", () => {
        if (App.pages.leadFileImport) App.pages.leadFileImport.open();
      });
    }

    renderConnectionsBody(pane, connections);
    wireCreateForm(pane, connections);
  }

  function renderConnectionsBody(pane, connections) {
    const body = pane.querySelector("#gsConnectionsBody");
    if (!body) return;

    if (!connections || connections.length === 0) {
      body.innerHTML = `
        <div class="empty-state">
          <div class="empty-title">No Google Sheets connections yet</div>
          <div class="empty-desc">Connect a Google Sheet below to start importing leads automatically.</div>
          <button type="button" class="btn btn-primary" id="gsEmptyConnectBtn">${App.app.icon("plus")} Connect Google Sheet</button>
        </div>`;
      const btn = body.querySelector("#gsEmptyConnectBtn");
      if (btn) btn.addEventListener("click", () => {
        const nameField = pane.querySelector("#gsFieldName");
        if (nameField) nameField.focus();
        const card = pane.querySelector("#gsCreateCard");
        if (card && card.scrollIntoView) card.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      return;
    }

    body.innerHTML = connections.map(renderConnectionCard).join("");

    // Looked up by attribute value in JS (not a dynamically-built CSS
    // selector) so a connection id never has to be selector-escaped.
    const byId = {};
    connections.forEach(conn => { byId[conn.id] = conn; });
    body.querySelectorAll("[data-rotate-id]").forEach(btn => {
      const conn = byId[btn.getAttribute("data-rotate-id")];
      if (conn) btn.addEventListener("click", () => confirmRotate(pane, conn));
    });
  }

  function renderConnectionCard(conn) {
    const spreadsheetLink = isSafeGoogleSheetsUrl(conn.spreadsheet_url)
      ? `<a href="${U().esc(conn.spreadsheet_url)}" target="_blank" rel="noopener noreferrer" class="link">Open Sheet</a> <span class="form-help" style="display:inline">(${U().esc(conn.spreadsheet_id)})</span>`
      : `<span>${U().esc(conn.spreadsheet_id || "—")}</span>`;
    const lastError = conn.last_error
      ? `<div class="settings-status-card" style="border-color:var(--danger)"><div class="k">Last error</div><div class="v" style="color:var(--danger);font-size:var(--font-size-sm);font-weight:500">${U().esc(conn.last_error)}</div></div>`
      : "";

    return `
      <div class="gs-connection-card">
        <div class="gs-connection-head">
          <div>
            <div class="gs-connection-name">${U().esc(conn.name || "Google Sheets")}</div>
            <div class="form-help">${spreadsheetLink}</div>
          </div>
          ${statusBadge(conn.status)}
        </div>
        <div class="settings-status-grid">
          <div class="settings-status-card"><div class="k">Raw tab</div><div class="v">${U().esc(conn.raw_tab_name || "—")}</div></div>
          <div class="settings-status-card"><div class="k">Ready tab</div><div class="v">${U().esc(conn.ready_tab_name || "—")}</div></div>
          <div class="settings-status-card"><div class="k">Sync</div><div class="v">Every ${U().esc(conn.sync_interval_minutes || 15)} min (automatic)</div></div>
          <div class="settings-status-card"><div class="k">Connector token</div><div class="v">${U().esc(conn.connector_token_prefix || "—")}&hellip;</div></div>
          <div class="settings-status-card"><div class="k">Last synchronized</div><div class="v">${U().esc(formatTimestamp(conn.last_synced_at))}</div></div>
          <div class="settings-status-card"><div class="k">Token rotated</div><div class="v">${U().esc(formatTimestamp(conn.token_rotated_at))}</div></div>
          ${lastError}
        </div>
        <div class="gs-connection-actions">
          <button type="button" class="btn btn-sm" data-rotate-id="${U().esc(conn.id)}">Rotate Token</button>
        </div>
      </div>`;
  }

  /* ============================================================
   * CREATE FORM WIRING
   * ========================================================== */

  function setFieldError(pane, fieldId, message) {
    const input = pane.querySelector("#gsField" + fieldId);
    const hint = pane.querySelector("#gsField" + fieldId + "Err");
    if (hint) { hint.textContent = message || ""; hint.classList.toggle("visible", !!message); }
    if (input) {
      input.setAttribute("aria-invalid", message ? "true" : "false");
      const wrap = input.closest(".field");
      if (wrap) wrap.classList.toggle("has-field-error", !!message);
    }
  }

  function clearFormErrors(pane) {
    ["Name", "Sheet", "RawTab", "ReadyTab"].forEach(f => setFieldError(pane, f, ""));
  }

  function setFormMessage(pane, text, kind) {
    const el = pane.querySelector("#gsFormMessage");
    if (!el) return;
    el.textContent = text || "";
    el.className = "profile-edit-message" + (kind ? " " + kind : "");
  }

  // Disables the create button and every "Rotate Token" button together —
  // a single page-wide guard against overlapping create/rotate requests,
  // regardless of which control started the in-flight one.
  function setPageBusy(pane, busy) {
    const submitBtn = pane.querySelector("#gsCreateSubmit");
    if (submitBtn) submitBtn.disabled = busy;
    pane.querySelectorAll("[data-rotate-id]").forEach(btn => { btn.disabled = busy; });
  }

  function findMatchingConnection(connections, spreadsheetId, readyTabName) {
    return (connections || []).find(c =>
      c.spreadsheet_id === spreadsheetId && c.ready_tab_name === readyTabName
    ) || null;
  }

  /* ============================================================
   * SHARED CREATE/ROTATE SUBMISSION PATH
   * ========================================================== */
  // One path for both entry points — the "Rotate Token" button (always a
  // rotation) and a create-form submission whose (spreadsheet_id,
  // ready_tab_name) matches an existing connection (also a rotation in
  // effect, even though it came from the create form). `matchedConnection`
  // is the existing connection when this call is a rotation, or null for a
  // genuinely new connection. When it's a rotation, the same static
  // warning is shown and confirmed before any request is made — zero Edge
  // Function calls happen until the user confirms, and none at all if
  // they cancel. `requestInFlight` is checked here too so a click that
  // slips through before buttons are disabled still can't start a second
  // request.

  function submitConnection(pane, payload, matchedConnection, reporter) {
    if (requestInFlight) return;
    if (matchedConnection) {
      App.app.confirmDialog({
        title: "Rotate connector token?",
        message: ROTATION_CONFIRM_MESSAGE,
        okLabel: "Rotate token",
        danger: true
      }, () => { runSubmit(pane, payload, reporter); });
      return;
    }
    runSubmit(pane, payload, reporter);
  }

  async function runSubmit(pane, payload, reporter) {
    if (requestInFlight) return;
    requestInFlight = true;
    reporter.onBusyStart();
    try {
      const response = await S().sheetConnections.createOrRotate(payload);
      const validation = validateConnectionResponse(response);
      if (!validation.ok) {
        reporter.onError(
          "The connection may have been created or rotated, but the returned credentials could not be " +
          "verified (" + validation.reason + "). Check Connection Status in the Google Sheet, or wait " +
          "about 60 seconds and try again."
        );
        await render(pane);
        return;
      }
      openCredentialModal(response, { onDone: () => render(pane) });
    } catch (err) {
      reporter.onError(friendlyErrorMessage(err));
    } finally {
      requestInFlight = false;
      reporter.onBusyEnd();
    }
  }

  function wireCreateForm(pane, connections) {
    const form = pane.querySelector("#gsCreateForm");
    if (!form) return;
    const submitBtn = pane.querySelector("#gsCreateSubmit");

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (requestInFlight) return;

      clearFormErrors(pane);
      setFormMessage(pane, "");

      const result = validateForm({
        name: pane.querySelector("#gsFieldName").value,
        spreadsheetInput: pane.querySelector("#gsFieldSheet").value,
        rawTabName: pane.querySelector("#gsFieldRawTab").value,
        readyTabName: pane.querySelector("#gsFieldReadyTab").value
      });

      if (!result.ok) {
        const fieldMap = { name: "Name", spreadsheetInput: "Sheet", rawTabName: "RawTab", readyTabName: "ReadyTab" };
        Object.keys(result.errors).forEach(k => setFieldError(pane, fieldMap[k], result.errors[k]));
        setFormMessage(pane, "Please fix the highlighted fields.", "error");
        return;
      }

      const originalLabel = submitBtn.innerHTML;
      const matched = findMatchingConnection(connections, result.values.spreadsheet_id, result.values.ready_tab_name);

      submitConnection(pane, result.values, matched, {
        onError: (msg) => setFormMessage(pane, msg, "error"),
        onBusyStart: () => { setPageBusy(pane, true); submitBtn.textContent = "Connecting…"; },
        onBusyEnd: () => { setPageBusy(pane, false); submitBtn.innerHTML = originalLabel; }
      });
    });
  }

  /* ============================================================
   * ROTATE FLOW ("Rotate Token" button)
   * ========================================================== */

  function confirmRotate(pane, conn) {
    const payload = {
      name: conn.name || DEFAULT_NAME,
      spreadsheet_id: conn.spreadsheet_id,
      spreadsheet_url: conn.spreadsheet_url || "",
      raw_tab_name: conn.raw_tab_name || DEFAULT_RAW_TAB,
      ready_tab_name: conn.ready_tab_name || DEFAULT_READY_TAB,
      sync_mode: "push",
      sync_interval_minutes: 15
    };
    submitConnection(pane, payload, conn, {
      onError: (msg) => App.app.toast(msg, "danger"),
      onBusyStart: () => setPageBusy(pane, true),
      onBusyEnd: () => setPageBusy(pane, false)
    });
  }

  /* ============================================================
   * ONE-TIME CREDENTIAL MODAL
   * ========================================================== */

  // No nested modal is ever opened from here. An unconfirmed close (X,
  // backdrop, Escape) shows a warning INSIDE this same modal instead —
  // avoiding a second set of backdrop/Escape handlers that could
  // conflict with this modal's own and let it close unexpectedly.
  function openCredentialModal(payload, opts) {
    let confirmedSaved = false;
    let closePermitted = false;
    let cleanupCapture = function () {};

    const bodyHtml = `
      <p><strong>This connector token is shown only once. Save it now before closing.</strong></p>
      <label class="field full">
        <span>Ingest URL</span>
        <input type="text" id="gsCredIngestUrl" class="gs-cred-input" readonly>
      </label>
      <label class="field full">
        <span>Connector token</span>
        <input type="text" id="gsCredToken" class="gs-cred-input" readonly>
      </label>
      <div class="gs-cred-meta">
        <div><span class="form-help">Connection ID (reference only, not secret)</span><div id="gsCredConnId" class="gs-cred-mono"></div></div>
        <div><span class="form-help">Configured at</span><div id="gsCredConfiguredAt"></div></div>
      </div>
      <div class="gs-cred-actions">
        <button type="button" class="btn btn-sm" id="gsCopyUrl">Copy Ingest URL</button>
        <button type="button" class="btn btn-sm" id="gsCopyToken">Copy Token</button>
        <button type="button" class="btn btn-sm" id="gsCopyBoth">Copy Both</button>
      </div>
      <div class="release-callout release-callout-warning gs-cred-warning" id="gsCredWarning" hidden>
        <strong>You haven't confirmed you saved the connector token.</strong>
        <p style="margin:6px 0 0">It cannot be shown again — closing now means you'd need to rotate the token to get a new one.</p>
        <div class="gs-cred-warning-actions">
          <button type="button" class="btn btn-sm" id="gsCredKeepOpen">Keep credentials open</button>
          <button type="button" class="btn btn-sm btn-danger" id="gsCredCloseAnyway">Close anyway</button>
        </div>
      </div>
    `;

    const h = App.app.openModal({
      title: "Connector credentials",
      wide: true,
      body: bodyHtml,
      footer: `<button type="button" class="btn btn-primary" id="gsCredDone">I saved these details</button>`,
      onOpen: (modal) => {
        // Secret/reference values are set via safe DOM APIs (input.value /
        // textContent) — never interpolated into the HTML template above.
        const urlInput = modal.querySelector("#gsCredIngestUrl");
        const tokenInput = modal.querySelector("#gsCredToken");
        urlInput.value = payload.ingest_url;
        tokenInput.value = payload.connector_token;
        modal.querySelector("#gsCredConnId").textContent = payload.connection_id;
        modal.querySelector("#gsCredConfiguredAt").textContent = formatTimestamp(payload.configured_at);

        modal.querySelector("#gsCopyUrl").addEventListener("click", () =>
          copyToClipboard(urlInput.value, "Ingest URL copied."));
        modal.querySelector("#gsCopyToken").addEventListener("click", () =>
          copyToClipboard(tokenInput.value, "Connector token copied."));
        modal.querySelector("#gsCopyBoth").addEventListener("click", () =>
          copyToClipboard("Ingest URL: " + urlInput.value + "\nConnector token: " + tokenInput.value, "Ingest URL and token copied."));

        const doneBtn = modal.querySelector("#gsCredDone");
        const warningEl = modal.querySelector("#gsCredWarning");
        const keepOpenBtn = modal.querySelector("#gsCredKeepOpen");
        const closeAnywayBtn = modal.querySelector("#gsCredCloseAnyway");

        function showWarning() {
          warningEl.hidden = false;
          closeAnywayBtn.focus();
        }
        function hideWarning() {
          warningEl.hidden = true;
        }

        doneBtn.addEventListener("click", () => {
          confirmedSaved = true;
          h.close();
        });
        keepOpenBtn.addEventListener("click", () => {
          hideWarning();
          doneBtn.focus();
        });
        closeAnywayBtn.addEventListener("click", () => {
          closePermitted = true;
          h.close();
        });

        // Replace the shared modal's close (X) button with a clone (which
        // carries none of its original listeners) so an unconfirmed click
        // shows the inline warning above instead of the shared close path
        // — without altering the shared modal component used by every
        // other page.
        const oldCloseBtn = modal.querySelector(".modal-close");
        if (oldCloseBtn && oldCloseBtn.parentNode) {
          const newCloseBtn = oldCloseBtn.cloneNode(true);
          oldCloseBtn.parentNode.replaceChild(newCloseBtn, oldCloseBtn);
          newCloseBtn.addEventListener("click", () => {
            if (confirmedSaved || closePermitted) { h.close(); return; }
            showWarning();
          });
        }

        // Backdrop click and Escape both close the shared modal via
        // bubble-phase listeners already attached by openModal. These
        // capture-phase listeners run first; while the token hasn't been
        // confirmed saved (or closing hasn't been explicitly permitted via
        // "Close anyway"), they fully suppress that default path —
        // preventDefault() and stopImmediatePropagation() stop the other
        // listener on this same overlay/document from ever running — and
        // show the inline warning instead. No second modal is opened.
        const onOverlayCapture = (e) => {
          if (confirmedSaved || closePermitted) return;
          if (e.target === h.overlay) {
            e.preventDefault();
            e.stopImmediatePropagation();
            showWarning();
          }
        };
        const onKeyCapture = (e) => {
          if (confirmedSaved || closePermitted) return;
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopImmediatePropagation();
            showWarning();
          }
        };
        h.overlay.addEventListener("click", onOverlayCapture, true);
        document.addEventListener("keydown", onKeyCapture, true);
        cleanupCapture = () => {
          h.overlay.removeEventListener("click", onOverlayCapture, true);
          document.removeEventListener("keydown", onKeyCapture, true);
        };
      },
      onClose: () => {
        cleanupCapture();
        // Defensive cleanup: blank the secret out of the (by now detached)
        // DOM node, and drop every reference this closure held, so nothing
        // keeps the plaintext token reachable after the modal is gone.
        const tokenField = h.modal ? h.modal.querySelector("#gsCredToken") : null;
        if (tokenField) tokenField.value = "";
        payload = null;
        if (opts && typeof opts.onDone === "function") opts.onDone();
      }
    });
    return h;
  }

  return { render };
})();
