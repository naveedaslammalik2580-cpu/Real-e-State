/* ============================================================
   email-templates.js — Settings → Marketing → Email Templates.
   Configuration-only Email Templates UI (public.message_templates,
   channel = 'email' only). Nothing on this page ever sends an email,
   calls an email provider, or enrolls a contact — every action here is a
   plain SELECT/INSERT/UPDATE/DELETE against message_templates, performed
   through App.store/App.data. Saving, activating, duplicating, and
   deleting a template are all local configuration edits only.

   Preview is always plain text: template subject/body are escaped and
   shown as literal text, never interpreted as HTML.

   Replaces the user-facing "Scripts" page. The legacy `scripts` table and
   its data are left completely untouched by this module — the one write
   this page can trigger against legacy data is a COPY (via
   App.store.legacyScriptImport), never a modification or deletion of the
   original Script rows.

   Depends on: app.js, store.js (App.store.messageTemplates,
   App.store.legacyScriptImport), util.js
   ============================================================ */

window.App = window.App || {};
App.pages = App.pages || {};

App.pages.emailTemplates = (function () {
  "use strict";

  const U = () => App.util;
  const S = () => App.store;

  const NAME_MAX = 100;
  const SUBJECT_MAX = 200;
  const BODY_MAX = 50000;

  function copyPlainText(text) {
    const done = () => App.app.toast("Copied to clipboard.", "success");
    const fail = () => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); done(); }
      catch (e) { App.app.toast("Copy failed. Select the text manually.", "danger"); }
      document.body.removeChild(ta);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text || "").then(done).catch(fail);
    } else {
      fail();
    }
  }

  /* ============================================================
   * RENDER ENTRY POINT
   * ========================================================== */

  async function render(pane) {
    if (!pane) return;
    App.app.setBreadcrumbs([{ label: "Email Templates" }]);
    App.app.setTopActions("");

    const state = {
      templates: [],
      loaded: false,
      error: null,
      search: "",
      statusFilter: "" // "" | "active" | "inactive"
    };

    pane.innerHTML = App.app.loadingHtml ? App.app.loadingHtml("email templates") : "";
    renderShell(pane, state);
    await loadTemplates(pane, state);
  }

  function renderShell(pane, state) {
    pane.innerHTML = `
      <div class="page-header">
        <div>
          <div class="page-title">Email Templates</div>
          <div class="page-desc">Create reusable emails for manual follow-up and future RealtorOS automation.</div>
        </div>
        <div class="page-actions">
          <button type="button" class="btn" id="etImportBtn">Import Existing Scripts</button>
          <button type="button" class="btn btn-primary" id="etCreateBtn">${App.app.icon("plus")} Create Template</button>
        </div>
      </div>

      <div class="release-callout" style="margin-bottom:16px">
        <strong>Saving a template does not send an email.</strong>
        <p style="margin:6px 0 0">Active templates are what automation sequences send. Nothing on this page sends a message on its own — delivery only happens when a sequence you have activated runs.</p>
      </div>

      <div class="filter-bar">
        <div class="search-wrap">${App.app.icon("search")}<input id="etSearch" type="search" placeholder="Search templates…" aria-label="Search templates"></div>
        <label class="field" style="margin:0">
          <span class="sr-only">Status</span>
          <select id="etStatusFilter" aria-label="Filter by status">
            <option value="">All templates</option>
            <option value="active">Active only</option>
            <option value="inactive">Inactive only</option>
          </select>
        </label>
      </div>
      <p id="etLiveStatus" class="profile-edit-message" aria-live="polite" role="status"></p>

      <div class="release-library-grid" id="etGrid"></div>
    `;

    pane.querySelector("#etCreateBtn").addEventListener("click", () => openTemplateModal(pane, state, null, null));
    pane.querySelector("#etImportBtn").addEventListener("click", () => openImportModal(pane, state));
    pane.querySelector("#etSearch").addEventListener("input", (e) => {
      state.search = e.target.value || "";
      renderGrid(pane, state);
    });
    pane.querySelector("#etStatusFilter").addEventListener("change", (e) => {
      state.statusFilter = e.target.value || "";
      renderGrid(pane, state);
    });
  }

  function setLive(pane, text, kind) {
    const el = pane.querySelector("#etLiveStatus");
    if (!el) return;
    el.textContent = text || "";
    el.className = "profile-edit-message" + (kind ? " " + kind : "");
  }

  /* ============================================================
   * LIST + FILTER
   * ========================================================== */

  async function loadTemplates(pane, state) {
    setLive(pane, "Loading templates…");
    try {
      state.templates = await S().messageTemplates.list({ orderBy: "name" });
      state.loaded = true;
      state.error = null;
      renderGrid(pane, state);
      setLive(pane, state.templates.length
        ? "Loaded " + state.templates.length + " template" + (state.templates.length === 1 ? "" : "s") + "."
        : "No templates yet.");
    } catch (err) {
      state.error = (err && err.message) ? err.message : "Unknown error";
      renderGrid(pane, state);
      setLive(pane, "Could not load templates.", "error");
    }
  }

  function matchesFilters(t, state) {
    if (state.statusFilter === "active" && !t.is_active) return false;
    if (state.statusFilter === "inactive" && t.is_active) return false;
    const q = state.search.trim().toLowerCase();
    if (!q) return true;
    return [t.name, t.subject, t.body_text].some(v => String(v || "").toLowerCase().includes(q));
  }

  function renderGrid(pane, state) {
    const grid = pane.querySelector("#etGrid");
    if (!grid) return;

    if (state.error) {
      grid.innerHTML = `
        <div class="empty-state" role="alert">
          <div class="empty-title">Could not load templates</div>
          <div class="empty-desc">${U().esc(state.error)}</div>
          <button type="button" class="btn btn-primary" id="etRetry">Retry</button>
        </div>`;
      const retryBtn = grid.querySelector("#etRetry");
      if (retryBtn) retryBtn.addEventListener("click", () => loadTemplates(pane, state));
      return;
    }

    if (!state.templates.length) {
      grid.innerHTML = `
        <div class="empty-state">
          <div class="empty-title">No email templates yet</div>
          <div class="empty-desc">Create your first template, or import your existing Scripts using the button above.</div>
        </div>`;
      return;
    }

    const filtered = state.templates.filter(t => matchesFilters(t, state));
    if (!filtered.length) {
      grid.innerHTML = `
        <div class="empty-state">
          <div class="empty-title">No templates match</div>
          <div class="empty-desc">Try a different search or status filter.</div>
        </div>`;
      return;
    }

    grid.innerHTML = filtered.map(renderCard).join("");
    wireCardActions(grid, pane, state);
  }

  function renderCard(t) {
    const statusBadge = t.is_active
      ? '<span class="badge badge-success"><span class="dot"></span>Active</span>'
      : '<span class="badge badge-neutral"><span class="dot"></span>Inactive</span>';
    const subjectHtml = t.subject ? U().esc(t.subject) : "<em>(no subject yet — edit to add one)</em>";
    return `
      <article class="card release-library-card" data-tpl-id="${U().esc(t.id)}">
        <div class="card-body">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:space-between">
            <h3 style="margin:0;word-break:break-word">${U().esc(t.name)}</h3>
            ${statusBadge}
          </div>
          <div class="form-help" style="margin:8px 0 2px">Subject</div>
          <p style="margin:0">${subjectHtml}</p>
          <div class="form-help" style="margin:8px 0 2px">Body</div>
          <p>${U().esc(U().truncate(t.body_text || "", 220))}</p>
          <!-- Seven flat buttons buried the one people actually want. Edit,
               the active toggle and Delete stay on the card; the four
               read-only/copy helpers move behind a More menu. Every action is
               still present, and each keeps its original data-* attribute, so
               the existing delegated handler in wireCardActions() matches them
               unchanged wherever they now sit.
               Order is Edit | Deactivate | Delete | More: the overflow menu is
               always the last element in an action row, never wedged between
               two primary buttons. The menu stays right-anchored to its own
               .action-more wrapper, so moving it to the end needs no CSS
               change. -->
          <div class="release-card-actions">
            <button type="button" class="btn btn-sm" data-edit="${U().esc(t.id)}">Edit</button>
            <button type="button" class="btn btn-sm" data-toggle-active="${U().esc(t.id)}">${t.is_active ? "Deactivate" : "Activate"}</button>
            <button type="button" class="btn btn-sm btn-danger" data-delete="${U().esc(t.id)}">Delete</button>
            <span class="action-more">
              <button type="button" class="btn btn-sm action-more-toggle" data-more-toggle="${U().esc(t.id)}"
                      aria-haspopup="true" aria-expanded="false"
                      aria-label="More actions for ${U().esc(t.name)}" title="More actions">
                <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>
              </button>
              <span class="action-more-menu" data-more-menu="${U().esc(t.id)}" role="menu" hidden>
                <button type="button" class="dropdown-action" role="menuitem" data-preview="${U().esc(t.id)}">Preview</button>
                <button type="button" class="dropdown-action" role="menuitem" data-copy-subject="${U().esc(t.id)}">Copy Subject</button>
                <button type="button" class="dropdown-action" role="menuitem" data-copy-body="${U().esc(t.id)}">Copy Body</button>
                <button type="button" class="dropdown-action" role="menuitem" data-duplicate="${U().esc(t.id)}">Duplicate</button>
              </span>
            </span>
          </div>
        </div>
      </article>`;
  }

  // ---------- "MORE" MENU ----------
  // Closes every open menu in `root` and resets its toggle's aria-expanded.
  function closeAllMoreMenus(root) {
    const scope = root || document;
    scope.querySelectorAll("[data-more-menu]").forEach(m => { m.hidden = true; });
    scope.querySelectorAll("[data-more-toggle]").forEach(t => t.setAttribute("aria-expanded", "false"));
  }

  // The outside-click and Escape dismissals live on `document`, so they are
  // installed exactly once for the module rather than once per render —
  // wireCardActions() runs again on every re-render, and re-registering there
  // would leak a listener each time.
  let moreDismissalWired = false;
  function ensureMoreMenuDismissal() {
    if (moreDismissalWired) return;
    moreDismissalWired = true;
    document.addEventListener("click", (ev) => {
      // A click on the toggle or inside the menu is handled by the grid
      // listener below; anything else dismisses.
      if (ev.target.closest && ev.target.closest(".action-more")) return;
      closeAllMoreMenus(document);
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") closeAllMoreMenus(document);
    });
  }

  function wireCardActions(grid, pane, state) {
    ensureMoreMenuDismissal();

    // Registered before the action handler below, but neither stops
    // propagation, so an action inside the menu still runs — the menu simply
    // closes with it.
    grid.addEventListener("click", (e) => {
      const toggle = e.target.closest("[data-more-toggle]");
      if (toggle) {
        // Find the menu as the toggle's own sibling rather than by id lookup,
        // so no selector escaping is needed for the template id.
        const wrap = toggle.closest(".action-more");
        const menu = wrap && wrap.querySelector("[data-more-menu]");
        const willOpen = !!menu && menu.hidden;
        closeAllMoreMenus(document);   // only one menu open at a time
        if (willOpen) {
          menu.hidden = false;
          toggle.setAttribute("aria-expanded", "true");
        }
        return;
      }
      // Any action chosen inside a menu closes it.
      if (e.target.closest("[data-more-menu]")) closeAllMoreMenus(document);
    });

    grid.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-preview],[data-copy-subject],[data-copy-body],[data-edit],[data-duplicate],[data-toggle-active],[data-delete]");
      if (!btn) return;
      const id = btn.getAttribute("data-preview") || btn.getAttribute("data-copy-subject") || btn.getAttribute("data-copy-body") ||
        btn.getAttribute("data-edit") || btn.getAttribute("data-duplicate") || btn.getAttribute("data-toggle-active") || btn.getAttribute("data-delete");
      const tpl = state.templates.find(t => t.id === id);
      if (!tpl) return;

      if (btn.hasAttribute("data-preview")) { openPreviewModal(tpl); return; }
      if (btn.hasAttribute("data-copy-subject")) { copyPlainText(tpl.subject || ""); return; }
      if (btn.hasAttribute("data-copy-body")) { copyPlainText(tpl.body_text || ""); return; }
      if (btn.hasAttribute("data-edit")) { openTemplateModal(pane, state, tpl, null); return; }
      if (btn.hasAttribute("data-duplicate")) { openTemplateModal(pane, state, null, tpl); return; }
      if (btn.hasAttribute("data-toggle-active")) { toggleActive(pane, state, tpl, btn); return; }
      if (btn.hasAttribute("data-delete")) { confirmDelete(pane, state, tpl); return; }
    });
  }

  async function toggleActive(pane, state, tpl, btn) {
    if (btn.disabled) return;
    const nextActive = !tpl.is_active;
    btn.disabled = true;
    try {
      // Activating always re-validates the owner-scoped stored template
      // (name/subject/body) server-side — a subjectless or empty-body
      // template (e.g. a freshly imported Script) cannot become active
      // this way; deactivating has no such requirement.
      if (nextActive) await S().messageTemplates.activate(tpl.id);
      else await S().messageTemplates.setActive(tpl.id, false);
      App.app.toast(nextActive ? "Template activated." : "Template deactivated.", "success");
      await loadTemplates(pane, state);
    } catch (err) {
      App.app.toast("Could not update: " + ((err && err.message) || "Unknown error"), "danger");
      btn.disabled = false;
    }
  }

  function confirmDelete(pane, state, tpl) {
    App.app.confirmDialog({
      title: "Delete template?",
      message: `Delete &ldquo;${U().esc(tpl.name)}&rdquo;? This cannot be undone. No email has ever been sent from this template.`,
      okLabel: "Delete",
      danger: true
    }, async () => {
      try {
        await S().messageTemplates.delete(tpl.id);
        App.app.toast("Deleted.", "success");
        await loadTemplates(pane, state);
      } catch (err) {
        App.app.toast("Could not delete: " + ((err && err.message) || "Unknown error"), "danger");
      }
    });
  }

  /* ============================================================
   * PREVIEW (plain text only — never renders the body as HTML)
   * ========================================================== */

  function openPreviewModal(tpl) {
    const h = App.app.openModal({
      title: "Preview",
      wide: true,
      body: `
        <div class="release-callout" style="margin-bottom:12px">
          <strong>Plain-text preview only.</strong>
          <p style="margin:6px 0 0">This shows exactly what is saved. No HTML is rendered from the body, and previewing never sends anything.</p>
        </div>
        <label class="field full"><span>Template name</span></label>
        <p style="margin:0 0 10px;word-break:break-word">${U().esc(tpl.name)}</p>
        <label class="field full"><span>Subject</span></label>
        <p style="margin:0 0 10px;white-space:pre-wrap;word-break:break-word">${tpl.subject ? U().esc(tpl.subject) : "(no subject yet)"}</p>
        <label class="field full"><span>Body</span></label>
        <p style="margin:0;white-space:pre-wrap;word-break:break-word;max-height:50vh;overflow:auto">${U().esc(tpl.body_text || "")}</p>
      `,
      footer: `<button class="btn btn-primary" data-role="close">Close</button>`,
      onOpen: (m) => { m.querySelector('[data-role="close"]').onclick = () => h.close(); }
    });
  }

  /* ============================================================
   * CREATE / EDIT / DUPLICATE FORM
   * ========================================================== */

  function openTemplateModal(pane, state, existing, duplicateFrom) {
    const source = existing || duplicateFrom;
    const isEdit = !!existing;
    const initialName = duplicateFrom ? ((duplicateFrom.name || "") + " (Copy)").slice(0, NAME_MAX) : (existing ? existing.name : "");
    const initialSubject = source ? (source.subject || "") : "";
    const initialBody = source ? (source.body_text || "") : "";
    const initialActive = existing ? existing.is_active : true;

    const h = App.app.openModal({
      title: isEdit ? "Edit Template" : (duplicateFrom ? "Duplicate Template" : "Create Template"),
      wide: true,
      body: `
        <div class="release-callout" style="margin-bottom:12px">
          <strong>Saving does not send an email.</strong>
          <p style="margin:6px 0 0">Sending only happens from a test send, a Scheduler item, or an active Automation sequence step that uses this template.</p>
        </div>
        <div class="form-grid">
          <label class="field full"><span>Template name</span><input id="etName" maxlength="${NAME_MAX}" value="${U().esc(initialName)}" required></label>
          <label class="field full"><span>Subject</span><input id="etSubject" maxlength="${SUBJECT_MAX}" value="${U().esc(initialSubject)}" required></label>
          <label class="field full"><span>Email body</span><textarea id="etBody" rows="10" required>${U().esc(initialBody)}</textarea></label>
          <p class="form-help full" style="margin:-6px 0 0">
            Merge fields (Automation sequences only): <code>{{first_name}}</code>, <code>{{full_name}}</code>,
            <code>{{email}}</code>, <code>{{agent_name}}</code>. Plain text only — a missing value is left blank,
            and any other <code>{{tag}}</code> will block activation of a sequence using this template.
          </p>
          <label class="field" style="flex-direction:row;align-items:center;gap:10px">
            <span>Active</span>
            <span class="toggle-switch"><input type="checkbox" id="etActive" ${initialActive ? "checked" : ""}><span class="toggle-track"></span></span>
          </label>
        </div>
      `,
      footer: `<button class="btn" data-role="cancel">Cancel</button><button class="btn btn-primary" data-role="save">${isEdit ? "Save Changes" : "Create Template"}</button>`,
      onOpen: (m) => {
        m.querySelector('[data-role="cancel"]').onclick = () => h.close();
        const saveBtn = m.querySelector('[data-role="save"]');
        saveBtn.onclick = async () => {
          if (saveBtn.disabled) return; // prevent duplicate submission
          const name = m.querySelector("#etName").value.trim();
          const subject = m.querySelector("#etSubject").value.trim();
          const body = m.querySelector("#etBody").value.trim();
          const isActive = m.querySelector("#etActive").checked;
          if (!name || name.length > NAME_MAX) { App.app.toast("Template name must be 1-100 characters.", "danger"); return; }
          if (!subject || subject.length > SUBJECT_MAX) { App.app.toast("Subject must be 1-200 characters.", "danger"); return; }
          if (!body || body.length > BODY_MAX) { App.app.toast("Email body must be non-empty and at most 50,000 characters.", "danger"); return; }

          saveBtn.disabled = true;
          try {
            if (isEdit) {
              await S().messageTemplates.update(existing.id, { name, subject, bodyText: body, isActive });
              App.app.toast("Template saved.", "success");
            } else {
              await S().messageTemplates.create({ name, subject, bodyText: body, isActive });
              App.app.toast("Template created.", "success");
            }
            h.close();
            await loadTemplates(pane, state);
          } catch (err) {
            App.app.toast("Could not save: " + ((err && err.message) || "Unknown error"), "danger");
            saveBtn.disabled = false;
          }
        };
      }
    });
  }

  /* ============================================================
   * LEGACY SCRIPT IMPORT (explicit, user-controlled, idempotent)
   * ========================================================== */

  function openImportModal(pane, state) {
    const h = App.app.openModal({
      title: "Import Existing Scripts",
      wide: true,
      body: `<div id="etImportBody">${App.app.loadingHtml ? App.app.loadingHtml("eligible Scripts") : ""}</div>`,
      footer: `<button class="btn" data-role="cancel">Close</button><button class="btn btn-primary" data-role="import" disabled>Import Selected</button>`,
      onOpen: (m) => {
        m.querySelector('[data-role="cancel"]').onclick = () => h.close();
        loadImportEligibility(m, pane, state);
      }
    });
  }

  async function loadImportEligibility(m, pane, state) {
    const bodyEl = m.querySelector("#etImportBody");
    const importBtn = m.querySelector('[data-role="import"]');
    try {
      const result = await S().legacyScriptImport.listEligible();
      if (!result.eligible.length) {
        bodyEl.innerHTML = `<p class="form-help">No eligible Scripts to import right now (${U().esc(result.totalScripts)} Script(s) total, ${U().esc(result.alreadyImportedCount)} already imported).</p>`;
        return;
      }
      bodyEl.innerHTML = `
        <p class="form-help">${U().esc(result.eligible.length)} eligible Script(s) found — ${U().esc(result.totalScripts)} total, ${U().esc(result.alreadyImportedCount)} already imported. Importing copies each selected Script into Email Templates; the original Script is never changed or deleted, and importing again never creates a duplicate.</p>
        <p class="form-help">Legacy Scripts don't have an email subject, so every imported template is created <strong>inactive</strong> with an empty subject and needs review — add a subject, review the body, then activate it before it can be used in a Scheduler item or a Send Email step.</p>
        <label class="release-maintenance" style="align-items:center"><input type="checkbox" id="etImportAll" checked><span>Select all</span></label>
        <div style="max-height:320px;overflow:auto;margin-top:8px" id="etImportList">
          ${result.eligible.map(s => `
            <label class="release-maintenance" style="align-items:center">
              <input type="checkbox" class="et-import-check" value="${U().esc(s.id)}" checked>
              <span>${U().esc(s.title || "Untitled")} <span class="badge badge-neutral">${U().esc(s.category || "General")}</span></span>
            </label>`).join("")}
        </div>
        <div id="etImportConfirm" hidden style="margin-top:12px"></div>
        <p id="etImportResult" aria-live="polite" class="profile-edit-message" style="margin-top:10px"></p>
      `;
      importBtn.disabled = false;
      const selectAll = m.querySelector("#etImportAll");
      const checks = () => Array.from(m.querySelectorAll(".et-import-check"));
      selectAll.addEventListener("change", () => { checks().forEach(c => { c.checked = selectAll.checked; }); });
      checks().forEach(c => c.addEventListener("change", () => {
        selectAll.checked = checks().every(x => x.checked);
      }));
      importBtn.onclick = () => showImportConfirmation(m, pane, state, importBtn);
    } catch (err) {
      bodyEl.innerHTML = `
        <div class="empty-state" role="alert">
          <div class="empty-title">Could not load Scripts</div>
          <div class="empty-desc">${U().esc((err && err.message) || "Unknown error")}</div>
        </div>`;
    }
  }

  // Confirmation is rendered INLINE inside this same, already-open modal
  // rather than via App.app.confirmDialog — the shared modal system adds
  // one document-level Escape handler per open modal, so stacking a
  // second modal on top of this one is avoidable risk here, not a need.
  // importBtn is disabled the instant this is shown (synchronously, before
  // anything else) so a rapid double-click on "Import Selected" can only
  // ever show the confirmation once.
  function showImportConfirmation(m, pane, state, importBtn) {
    if (importBtn.disabled) return;
    const selectedIds = Array.from(m.querySelectorAll(".et-import-check:checked")).map(c => c.value);
    if (!selectedIds.length) { App.app.toast("Select at least one Script to import.", "danger"); return; }

    importBtn.disabled = true;
    const confirmArea = m.querySelector("#etImportConfirm");
    if (!confirmArea) return;
    confirmArea.hidden = false;
    confirmArea.innerHTML = `
      <div class="release-callout release-callout-warning">
        <strong>Import ${selectedIds.length} Script${selectedIds.length === 1 ? "" : "s"}?</strong>
        <p style="margin:6px 0 10px">Each selected Script is copied into Email Templates as an <strong>inactive</strong>, needs-review draft (empty subject). The original Script is not changed or deleted.</p>
        <button type="button" class="btn" id="etImportCancel">Cancel / Keep Editing</button>
        <button type="button" class="btn btn-primary" id="etImportConfirmBtn">Yes, Import</button>
      </div>
    `;
    confirmArea.querySelector("#etImportCancel").onclick = () => {
      if (confirmArea.querySelector("#etImportCancel").disabled) return;
      confirmArea.hidden = true;
      confirmArea.innerHTML = "";
      importBtn.disabled = false; // zero import calls were made
    };
    confirmArea.querySelector("#etImportConfirmBtn").onclick = () => runImport(m, pane, state, importBtn, selectedIds, confirmArea);
  }

  async function runImport(m, pane, state, importBtn, selectedIds, confirmArea) {
    // Disable both inline-confirm buttons and the checklist immediately —
    // a rapid double-click on "Yes, Import" makes exactly one import call.
    confirmArea.querySelectorAll("button").forEach(b => { b.disabled = true; });
    m.querySelectorAll(".et-import-check, #etImportAll").forEach(c => { c.disabled = true; });
    const resultEl = m.querySelector("#etImportResult");
    if (resultEl) resultEl.textContent = "Importing…";
    try {
      const result = await S().legacyScriptImport.importByIds(selectedIds);
      const summary = "Imported " + result.imported + " (inactive — add a subject, review, then activate), skipped " + result.skipped + ", failed " + result.failed + ".";
      if (resultEl) resultEl.textContent = summary;
      App.app.toast(summary, result.failed ? "danger" : "success");
      confirmArea.hidden = true;
      confirmArea.innerHTML = "";
      await loadTemplates(pane, state);
    } catch (err) {
      const message = "Import failed: " + ((err && err.message) || "Unknown error");
      if (resultEl) resultEl.textContent = message;
      App.app.toast(message, "danger");
      confirmArea.hidden = true;
      confirmArea.innerHTML = "";
      importBtn.disabled = false;
      m.querySelectorAll(".et-import-check, #etImportAll").forEach(c => { c.disabled = false; });
    }
  }

  return { render };
})();
