/* ============================================================
   lead-file-import.js — "Import from file" (Phase 4E.4).
   A four-step dialog: choose a file -> match columns -> review -> result.
   A one-time upload, as opposed to the automatic Google Sheets sync.

   Uses the shared modal (focus trapped, Escape closes, focus returns to
   the button that opened it) and moves focus to each step's heading.
   All file-derived text is escaped before it is shown. The file's
   contents live only in this dialog's memory and are dropped when it
   closes — never stored in the browser or put in a URL.

   Depends on: app.js (openModal, toast, navigate), util.js (esc),
   core/lead-file.js (App.leadFile), store.js (App.store.leadFileImport)
   ============================================================ */

window.App = window.App || {};
App.pages = App.pages || {};

App.pages.leadFileImport = (function () {
  "use strict";

  const U = () => App.util;
  const S = () => App.store;
  const L = () => App.leadFile;

  const IMPORT_HISTORY_ROUTE = "/settings/sheet-imports";

  function open(opts) {
    opts = opts || {};
    // Everything about the file lives in this closure and nowhere else.
    let st = {
      fileName: "", sheets: [], sheetIndex: 0, headers: [], dataRows: [], mapping: [],
      analysis: null, importId: null, startAutomation: false, busy: false, result: null,
      quota: null // the daily allowance of new contacts from files, once read
    };
    let templateUrl = null;

    const handle = App.app.openModal({
      title: "Import from file",
      wide: true,
      body: '<div data-role="lfi-step"></div>',
      footer: '<div data-role="lfi-footer" style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;width:100%"></div>',
      onClose: () => {
        if (templateUrl) URL.revokeObjectURL(templateUrl);
        const imported = st.result && (st.result.imported || st.result.updated);
        st = null; // drop the file's contents
        if (imported && typeof opts.onImported === "function") opts.onImported();
      },
      onOpen: () => {}
    });
    const modal = handle.modal;
    const stepEl = () => modal.querySelector('[data-role="lfi-step"]');
    const footEl = () => modal.querySelector('[data-role="lfi-footer"]');

    // Deferred: the shared modal focuses its first control on a zero-delay
    // timer when it opens; the step heading must win over that.
    function focusHeading() {
      setTimeout(() => {
        const h = modal.querySelector("[data-step-heading]");
        if (h) try { h.focus(); } catch (e) { /* ignore */ }
      }, 0);
    }
    function showError(message) {
      const el = modal.querySelector('[data-role="lfi-error"]');
      if (!el) return;
      el.textContent = message || "";
      el.hidden = !message;
    }
    const errorBox = '<p class="release-callout release-callout-warning" data-role="lfi-error" role="alert" hidden style="margin-top:12px"></p>';
    const quotaBox = '<p class="form-help" data-role="lfi-quota" aria-live="polite" style="margin:10px 0 0"></p>';

    // ------------------------------------------------ daily allowance
    // "You can add N more contacts from files today." At 0 the import
    // button is disabled. The server enforces the limit either way; this
    // only explains it before the upload.
    const fmt = (n) => Number(n).toLocaleString("en-US");
    function quotaMessage() {
      const q = st && st.quota;
      if (!q) return "";
      if (q.remaining <= 0) {
        return "You've reached today's limit of " + fmt(q.limit) + " new contacts from files. You can add more after "
          + L().resetTimeText(q.resetsAt) + ".";
      }
      return "You can add " + fmt(q.remaining) + " more contact" + (q.remaining === 1 ? "" : "s") + " from files today.";
    }
    function renderQuota() {
      if (!st) return;
      const box = modal.querySelector('[data-role="lfi-quota"]');
      if (box) box.textContent = quotaMessage();
      const warn = modal.querySelector('[data-role="lfi-quota-warning"]');
      const q = st.quota;
      const a = st.analysis;
      if (warn) {
        const over = q && a && q.remaining > 0 && a.newCount > q.remaining;
        warn.hidden = !over;
        warn.textContent = over
          ? "Only the first " + fmt(q.remaining) + " new contacts will be added today. The rest can be added by uploading the same file again after "
            + L().resetTimeText(q.resetsAt) + "."
          : "";
      }
      const btn = modal.querySelector('[data-role="lfi-import"]');
      if (btn && !st.busy) btn.disabled = !(a && a.validCount) || !!(q && q.remaining <= 0);
    }
    const readQuota = S().leadFileImport && S().leadFileImport.quota;
    if (typeof readQuota === "function") {
      Promise.resolve().then(readQuota).then((q) => { if (st && q) { st.quota = q; renderQuota(); } }, () => {});
    }

    // ------------------------------------------------ step 1: choose a file
    function renderChoose() {
      if (!templateUrl) {
        templateUrl = URL.createObjectURL(new Blob([L().templateCsv()], { type: "text/csv" }));
      }
      stepEl().innerHTML = `
        <h3 data-step-heading tabindex="-1" style="margin:0 0 6px">Choose a file</h3>
        <p class="form-help" style="margin:0 0 14px">A one-time upload of leads from an Excel (.xlsx, .xls) or CSV file, up to 5 MB and 500 rows.
          For leads that keep arriving, use the automatic sync from Google Sheets instead.</p>
        <label class="field">
          <span>File</span>
          <input type="file" data-role="lfi-file" accept=".xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv">
        </label>
        <p class="form-help" style="margin:10px 0 0">Not sure how to lay it out?
          <a href="${U().esc(templateUrl)}" download="realtoros-leads-template.csv">Download a blank template</a> with the expected headings.</p>
        <div data-role="lfi-sheet-pick"></div>
        ${quotaBox}
        <p class="form-help" data-role="lfi-status" aria-live="polite" style="margin:10px 0 0"></p>
        ${errorBox}`;
      footEl().innerHTML = '<button type="button" class="btn" data-role="lfi-cancel">Cancel</button>';
      footEl().querySelector('[data-role="lfi-cancel"]').addEventListener("click", () => handle.close());
      stepEl().querySelector('[data-role="lfi-file"]').addEventListener("change", onFileChosen);
      renderQuota();
      focusHeading();
    }

    async function onFileChosen(e) {
      const file = e.target.files && e.target.files[0];
      showError("");
      const check = L().checkFile(file);
      if (!check.ok) { showError(check.reason); return; }
      const status = stepEl().querySelector('[data-role="lfi-status"]');
      status.textContent = "Reading your file…";
      e.target.disabled = true;
      try {
        const sheets = await L().readFile(file);
        if (!st) return;
        st.fileName = file.name;
        st.sheets = sheets.filter((s) => s.rows.some((r) => r.some((c) => c !== "")));
        if (!st.sheets.length) { status.textContent = ""; showError("That file has no rows to import."); e.target.disabled = false; return; }
        status.textContent = "";
        if (st.sheets.length > 1) renderSheetPick();
        else chooseSheet(0);
      } catch (err) {
        if (!st) return;
        status.textContent = "";
        showError(err && err.userMessage ? err.userMessage
          : err && err.message === "load_failed" ? "The file reader couldn't be loaded. Check your connection and try again."
          : "That file couldn't be read. Make sure it's a valid Excel or CSV file.");
        e.target.disabled = false;
      }
    }

    function renderSheetPick() {
      const box = stepEl().querySelector('[data-role="lfi-sheet-pick"]');
      box.innerHTML = `
        <label class="field" style="margin-top:14px">
          <span>This workbook has several sheets. Which one has your leads?</span>
          <select data-role="lfi-sheet">
            ${st.sheets.map((s, i) => {
              const n = Math.max(0, s.rows.length - 1);
              return `<option value="${i}">${U().esc(s.name)} (${U().esc(n)} row${n === 1 ? "" : "s"})</option>`;
            }).join("")}
          </select>
        </label>`;
      footEl().innerHTML = `
        <button type="button" class="btn" data-role="lfi-cancel">Cancel</button>
        <button type="button" class="btn btn-primary" data-role="lfi-next">Continue</button>`;
      footEl().querySelector('[data-role="lfi-cancel"]').addEventListener("click", () => handle.close());
      footEl().querySelector('[data-role="lfi-next"]').addEventListener("click", () => {
        chooseSheet(Number(box.querySelector('[data-role="lfi-sheet"]').value) || 0);
      });
      box.querySelector('[data-role="lfi-sheet"]').focus();
    }

    // Lets the user pick another file after one was refused.
    function resetFileInput() {
      const input = stepEl().querySelector('[data-role="lfi-file"]');
      if (input) { input.disabled = false; try { input.value = ""; } catch (e) { /* ignore */ } }
    }

    function chooseSheet(index) {
      st.sheetIndex = index;
      const split = L().splitSheet(st.sheets[index].rows);
      if (!split.dataRows.length) { showError("That sheet has headings but no rows under them."); return; }
      if (split.dataRows.length > L().MAX_ROWS) { showError(L().ROW_LIMIT_MESSAGE); resetFileInput(); return; }
      st.headers = split.headers;
      st.dataRows = split.dataRows;
      st.mapping = L().autoMap(split.headers);
      renderMap();
    }

    // ------------------------------------------------ step 2: match columns
    function renderMap() {
      const sample = (i) => {
        const v = (st.dataRows.find((r) => r[i]) || [])[i] || "";
        return v.length > 40 ? v.slice(0, 40) + "…" : v;
      };
      const options = (selected) => ['<option value="">Don\'t import</option>']
        .concat(L().FIELDS.map((f) => `<option value="${f.key}" ${f.key === selected ? "selected" : ""}>${U().esc(f.label)}</option>`))
        .join("");
      // Phase 2E. Which export this looks like, and anything we recognised
      // but cannot import. Both are shown BEFORE the table: the agent should
      // know what we think their file is before they start checking rows.
      const fmt = L().detectFormat(st.headers);
      const unsupported = L().unsupportedColumns(st.headers, st.mapping);
      const mappedCount = st.mapping.filter(Boolean).length;

      stepEl().innerHTML = `
        <h3 data-step-heading tabindex="-1" style="margin:0 0 6px">Match your columns</h3>
        <p class="form-help" style="margin:0 0 12px">
          ${fmt.id === "generic"
            ? `We matched ${mappedCount} of your ${st.headers.length} columns from their headings.`
            : `This looks like a ${U().esc(fmt.label)} export, so we matched ${mappedCount} of your ${st.headers.length} columns for you.`}
          Change any column, or choose "Don't import" to leave it out. Every row needs an email address or a phone number.</p>
        ${unsupported.length ? `
        <div class="release-callout release-callout-warning" style="margin:0 0 12px">
          <strong>${unsupported.length === 1 ? "One column cannot be imported yet" : unsupported.length + " columns cannot be imported yet"}:
            ${unsupported.map((c) => U().esc(c.header) + " (" + U().esc(c.label) + ")").join(", ")}.</strong>
          <p style="margin:6px 0 0">Everything else below imports normally. You can add ${unsupported.length === 1 ? "this" : "these"} to a contact by hand afterwards.</p>
        </div>` : ""}
        <div class="table-wrap">
          <table class="tbl">
            <thead><tr><th scope="col">Column in your file</th><th scope="col">Example</th><th scope="col">Import as</th></tr></thead>
            <tbody>
              ${st.headers.map((h, i) => `
                <tr>
                  <td class="primary-cell" id="lfi-col-${i}">${U().esc(h)}</td>
                  <td>${U().esc(sample(i)) || '<span class="form-help">—</span>'}</td>
                  <td><select data-col="${i}" aria-labelledby="lfi-col-${i}">${options(st.mapping[i])}</select></td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>
        ${errorBox}`;
      stepEl().querySelectorAll("select[data-col]").forEach((sel) => {
        sel.addEventListener("change", () => {
          const i = Number(sel.getAttribute("data-col"));
          // A field can only come from one column.
          if (sel.value) st.mapping = st.mapping.map((m, j) => (j !== i && m === sel.value ? "" : m));
          st.mapping[i] = sel.value;
          stepEl().querySelectorAll("select[data-col]").forEach((s) => { s.value = st.mapping[Number(s.getAttribute("data-col"))]; });
          showError("");
        });
      });
      footEl().innerHTML = `
        <button type="button" class="btn" data-role="lfi-back">Back</button>
        <button type="button" class="btn btn-primary" data-role="lfi-next">Review</button>`;
      footEl().querySelector('[data-role="lfi-back"]').addEventListener("click", renderChoose);
      footEl().querySelector('[data-role="lfi-next"]').addEventListener("click", () => {
        if (!L().hasContactColumn(st.mapping)) {
          showError("Choose which column has the email address or the phone number — every row needs one of them.");
          return;
        }
        try {
          st.analysis = L().analyze(st.dataRows, st.mapping, (S().getState().contacts || []));
        } catch (err) {
          showError(err && err.userMessage ? err.userMessage : "This file couldn't be checked.");
          return;
        }
        st.importId = L().newImportId(); // one id per reviewed import; reused on retry
        renderReview();
      });
      focusHeading();
    }

    // ------------------------------------------------ step 3: review
    function renderReview() {
      const a = st.analysis;
      const cols = L().FIELDS.filter((f) => ["first_name", "last_name"].indexOf(f.key) === -1 && (st.mapping.indexOf(f.key) !== -1
        || (f.key === "full_name" && (st.mapping.indexOf("first_name") !== -1 || st.mapping.indexOf("last_name") !== -1))));
      const cell = (row, key) => U().esc(key === "tags" ? row.data.tags.join(", ") : row.data[key]);
      const invalid = a.rows.filter((r) => !r.valid);
      const shownInvalid = invalid.slice(0, 50);
      stepEl().innerHTML = `
        <h3 data-step-heading tabindex="-1" style="margin:0 0 10px">Review before importing</h3>
        <div class="settings-status-grid" style="margin-bottom:12px">
          <div class="settings-status-card"><div class="k">Ready to import</div><div class="v">${U().esc(a.validCount)}</div></div>
          <div class="settings-status-card"><div class="k">Need attention</div><div class="v">${U().esc(a.invalidCount)}</div></div>
          <div class="settings-status-card"><div class="k">Likely already in your contacts</div><div class="v">${U().esc(a.duplicateCount)}</div></div>
        </div>
        <p class="form-help" style="margin:0 0 10px">People already in your contacts are matched by email or phone: only their empty
          details are filled in, nothing is overwritten. Row 1 is the first row under your headings.</p>
        <div class="table-wrap">
          <table class="tbl tbl-compact">
            <caption class="sr-only">First ${U().esc(a.preview.length)} rows of your file</caption>
            <thead><tr><th scope="col">Row</th>${cols.map((c) => `<th scope="col">${U().esc(c.label)}</th>`).join("")}<th scope="col">Status</th></tr></thead>
            <tbody>
              ${a.preview.map((r) => `
                <tr>
                  <td>${U().esc(r.rowNumber)}</td>
                  ${cols.map((c) => `<td>${cell(r, c.key)}</td>`).join("")}
                  <td>${!r.valid ? `<span class="badge badge-warning">${U().esc(r.reason)}</span>`
                    : r.duplicate === "file" ? `<span class="badge badge-neutral">Same as row ${U().esc(r.duplicateOf)}</span>`
                    : r.duplicate === "existing" ? '<span class="badge badge-neutral">Already a contact</span>'
                    : '<span class="badge badge-success">Ready</span>'}</td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>
        ${a.total > a.preview.length ? `<p class="form-help" style="margin:6px 0 0">Showing the first ${U().esc(a.preview.length)} of ${U().esc(a.total)} rows.</p>` : ""}
        ${invalid.length ? `
          <div class="release-callout release-callout-warning" style="margin-top:12px">
            <strong>${U().esc(invalid.length)} row${invalid.length === 1 ? "" : "s"} won't be imported:</strong>
            <ul style="margin:6px 0 0;padding-left:18px">
              ${shownInvalid.map((r) => `<li>Row ${U().esc(r.rowNumber)}: ${U().esc(r.reason)}</li>`).join("")}
            </ul>
            ${invalid.length > shownInvalid.length ? `<p class="form-help" style="margin:6px 0 0">…and ${U().esc(invalid.length - shownInvalid.length)} more.</p>` : ""}
          </div>` : ""}
        <label style="display:flex;gap:8px;align-items:flex-start;margin-top:14px">
          <input type="checkbox" data-role="lfi-automation" ${st.startAutomation ? "checked" : ""}>
          <span><strong>Start automated follow-up for these contacts</strong><br>
            <span class="form-help">Only include people who agreed to receive emails from you.</span></span>
        </label>
        ${quotaBox}
        <p class="release-callout release-callout-warning" data-role="lfi-quota-warning" hidden style="margin-top:10px"></p>
        <p class="form-help" data-role="lfi-status" aria-live="polite" style="margin:10px 0 0"></p>
        ${errorBox}`;
      stepEl().querySelector('[data-role="lfi-automation"]').addEventListener("change", (e) => { st.startAutomation = e.target.checked; });
      footEl().innerHTML = `
        <button type="button" class="btn" data-role="lfi-back">Back</button>
        <button type="button" class="btn btn-primary" data-role="lfi-import" ${a.validCount ? "" : "disabled"}>
          Import ${U().esc(a.validCount)} contact${a.validCount === 1 ? "" : "s"}</button>`;
      footEl().querySelector('[data-role="lfi-back"]').addEventListener("click", renderMap);
      footEl().querySelector('[data-role="lfi-import"]').addEventListener("click", submit);
      renderQuota();
      focusHeading();
    }

    async function submit() {
      if (!st || st.busy) return;
      st.busy = true;
      const btn = footEl().querySelector('[data-role="lfi-import"]');
      const back = footEl().querySelector('[data-role="lfi-back"]');
      if (btn) { btn.disabled = true; btn.textContent = "Importing…"; }
      if (back) back.disabled = true;
      showError("");
      const status = stepEl().querySelector('[data-role="lfi-status"]');
      if (status) status.textContent = "Importing…";
      try {
        const result = await S().leadFileImport.submit({
          importId: st.importId,
          fileName: st.fileName,
          rows: L().toSubmission(st.analysis),
          startAutomation: st.startAutomation
        });
        if (!st) return;
        st.result = result;
        if (result.quota) st.quota = result.quota;
        try { await S().leadFileImport.refreshContacts(); } catch (e) { /* the list refreshes on next visit */ }
        if (!st) return;
        renderResult();
      } catch (err) {
        if (!st) return;
        st.busy = false;
        if (status) status.textContent = "";
        const code = err && err.code;
        const minutes = err && err.retryAfterSeconds ? Math.max(1, Math.ceil(err.retryAfterSeconds / 60)) : null;
        showError(
          code === "rate_limited" ? "You've imported several files recently. Please try again" + (minutes ? " in about " + minutes + " minute" + (minutes === 1 ? "" : "s") : " later") + "."
          : code === "too_many_rows" ? L().ROW_LIMIT_MESSAGE
          : code === "request_too_large" ? "This file has too much data for one import. Split it into smaller files."
          : "Something went wrong. Please try again — nothing will be imported twice."
        );
        if (btn) { btn.textContent = "Try again"; }
        renderQuota();
        if (back) back.disabled = false;
      }
    }

    // ------------------------------------------------ step 4: result
    function renderResult() {
      const r = st.result;
      const list = (items) => items.slice(0, 100).map((x) => `<li>Row ${U().esc(x.rowNumber)}: ${U().esc(x.reason)}</li>`).join("");
      stepEl().innerHTML = `
        <h3 data-step-heading tabindex="-1" style="margin:0 0 10px">${r.replayed ? "This import was already done" : "Import complete"}</h3>
        ${r.replayed ? '<p class="form-help" style="margin:0 0 10px">Nothing was imported twice. These are the results of the first attempt.</p>' : ""}
        <div class="settings-status-grid" style="margin-bottom:12px">
          <div class="settings-status-card"><div class="k">New contacts</div><div class="v">${U().esc(r.imported)}</div></div>
          <div class="settings-status-card"><div class="k">Existing contacts updated</div><div class="v">${U().esc(r.updated)}</div></div>
          <div class="settings-status-card"><div class="k">Skipped (no changes)</div><div class="v">${U().esc(r.skipped)}</div></div>
          <div class="settings-status-card"><div class="k">Couldn't import</div><div class="v">${U().esc(r.rejected)}</div></div>
          ${r.dailyLimitSkipped ? `<div class="settings-status-card"><div class="k">Not added — daily limit</div><div class="v">${U().esc(r.dailyLimitSkipped)}</div></div>` : ""}
        </div>
        ${r.dailyLimitSkipped ? `<div class="release-callout release-callout-warning" style="margin-bottom:10px">
          ${U().esc(fmt(r.dailyLimitSkipped))} new contact${r.dailyLimitSkipped === 1 ? " wasn't" : "s weren't"} added because of the daily limit of
          ${U().esc(fmt((r.quota && r.quota.limit) || 200))} new contacts from files. Upload the same file again after
          ${U().esc(L().resetTimeText(r.quota && r.quota.resetsAt))} to add the rest — people already added won't be duplicated.</div>` : ""}
        ${r.rejectedRows.length ? `<div class="release-callout release-callout-warning"><strong>Rows that couldn't be imported</strong>
          <ul style="margin:6px 0 0;padding-left:18px">${list(r.rejectedRows)}</ul></div>` : ""}
        ${r.skippedRows.length ? `<div class="release-callout" style="margin-top:10px"><strong>Repeated in this file</strong>
          <ul style="margin:6px 0 0;padding-left:18px">${list(r.skippedRows)}</ul></div>` : ""}
        <p class="form-help" style="margin:12px 0 0">${st.startAutomation ? "Automated follow-up will start for the new contacts that match an active automation."
          : "No automated follow-up was started for these contacts."}</p>`;
      footEl().innerHTML = `
        <button type="button" class="btn" data-role="lfi-history">View import history</button>
        <button type="button" class="btn btn-primary" data-role="lfi-done">Done</button>`;
      footEl().querySelector('[data-role="lfi-done"]').addEventListener("click", () => handle.close());
      footEl().querySelector('[data-role="lfi-history"]').addEventListener("click", () => {
        handle.close();
        App.app.navigate(IMPORT_HISTORY_ROUTE);
      });
      focusHeading();
    }

    renderChoose();
    return handle;
  }

  return { open };
})();
