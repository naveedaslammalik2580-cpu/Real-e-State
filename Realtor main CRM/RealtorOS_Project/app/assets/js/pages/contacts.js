/* ============================================================
   contacts.js — Contacts CRM: list, filters, detail, forms.
   Depends on: app.js, store.js, derived.js, util.js, commission.js
   ============================================================ */

window.App = window.App || {};
App.pages = App.pages || {};

App.pages.contacts = (function () {
  "use strict";

  const U = () => App.util;
  const S = () => App.store;
  const D = () => App.derived;
  const C = () => App.commission;

  // UI state (list filters)
  const allFilters = { search: "", role: "", stage: "", source: "", temp: "", owner: "", sort: "name-asc" };
  const pastFilters = { ...allFilters };
  let listFilters = allFilters;
  let pastClientsOnly = false;

  // Rows ticked for a bulk hand-over. Ids rather than row objects, so the
  // selection survives a re-render and can never hold a stale copy.
  let selectedIds = [];

  // ---------- TEAM: WHO OWNS A LEAD ----------
  //
  // All of this is dormant unless team features are on AND the person can
  // see more than their own leads, so a single agent's Contacts page is
  // exactly as it was.
  function teamOn() {
    return !!(App.customization && App.customization.isTeamMode());
  }
  function canAssign() { return teamOn() && App.workspace && App.workspace.can("contacts_assign"); }
  function canClaim() { return teamOn() && App.workspace && App.workspace.can("unassigned_claim"); }
  // The owner column only earns its space when more than one person could
  // appear in it.
  function showsOwners() {
    if (!teamOn() || !App.workspace) return false;
    return App.workspace.can("contacts_assign") || App.workspace.seesAll("contacts") ||
           App.workspace.can("unassigned_view");
  }
  function assignableMembers() {
    return (S().getState().teamMembers || []).filter(m => m.active !== false);
  }
  function memberNameById(id) {
    if (!id) return null;
    const m = (S().getState().teamMembers || []).find(x => x.id === id);
    return m ? m.name : null;
  }
  function ownerCell(c) {
    if (!c.assignedToId) return App.i18n.markup(`<span class="badge badge-neutral">Nobody yet</span>`);
    const name = memberNameById(c.assignedToId);
    const mine = App.workspace && App.workspace.teamMemberId() === c.assignedToId;
    return `${U().esc(name || "Someone who has left")}${mine ? App.i18n.markup(' <span class="badge badge-neutral">You</span>') : ""}`;
  }

  /** Opens Contacts showing only the leads nobody owns. Used by the Team page. */
  function showUnassigned() {
    allFilters.owner = "unassigned";
  }

  // Every entity Contact Detail's related-record cards read from.
  const DETAIL_DEPS = ["contacts", "properties", "deals", "activities", "tasks", "showings", "referrals"];

  // ---------- HELPERS ----------

  function tempBadge(temp) {
    const cls = temp === "Hot" ? "badge-hot" : temp === "Warm" ? "badge-warm" : "badge-cold";
    return App.i18n.html`<span class="badge ${App.i18n.value(() => (cls))}"><span class="dot"></span>${App.i18n.value(() => (U().esc(temp)))}</span>`;
  }
  function stagePill(stage) {
    return App.i18n.html`<span class="stage-pill">${App.i18n.value(() => (U().esc(stage || "—")))}</span>`;
  }
  function followUpCell(contact) {
    const status = D().contactFollowUpStatus(contact);
    if (status.status === "none") return App.i18n.markup('<span style="color:var(--text-soft)">—</span>');
    const label = U().formatDate(contact.nextFollowUp);
    if (status.status === "overdue") return App.i18n.html`<span class="badge badge-overdue">${App.i18n.value(() => (status.daysOverdue))} day${App.i18n.value(() => (status.daysOverdue === 1 ? '' : 's'))} overdue</span>`;
    if (status.status === "due-today") return App.i18n.markup(`<span class="badge badge-today">Today</span>`);
    return App.i18n.html`<span>${App.i18n.value(() => (label))}</span>`;
  }
  function avatarInitials(name) {
    return (name || "?").split(" ").map(w => w[0]).slice(0, 2).join("").toUpperCase();
  }
  // ---------- LIST PAGE ----------

  // The list's container, so a finished file import can refresh it.
  let lastListContainer = null;

  function renderList(container) { return renderContactList(container, false); }
  function renderPastClients(container) { return renderContactList(container, true); }

  async function renderContactList(container, pastOnly) {
    if (pastClientsOnly !== pastOnly) selectedIds = [];
    pastClientsOnly = pastOnly;
    listFilters = pastOnly ? pastFilters : allFilters;
    lastListContainer = container;
    App.app.setBreadcrumbs(pastOnly ? [{ get label() { return App.i18n.t("Contacts"); }, route: "/contacts" }, { get label() { return App.i18n.t("Past Clients"); } }] : [{ get label() { return App.i18n.t("Contacts"); } }]);
    App.app.setTopActions("");
    container.innerHTML = App.app.loadingHtml();
    await S().ensureLoaded(["contacts"]);

    const s = S().getState();
    const settings = s.settings;

    const uploadIcon = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>';

    container.innerHTML = App.i18n.html`
      <div class="page-header">
        <div><div class="page-title">${App.i18n.value(() => (pastOnly ? App.i18n.t("Past Clients") : App.i18n.t("Contacts")))}</div></div>
        <div class="page-actions">
          <button class="btn btn-import" id="importFileBtn" title="Import from file" aria-label="Import from file">${App.i18n.value(() => (uploadIcon))}<span class="btn-label">Import</span></button>
          <button class="btn btn-primary" id="addContactBtn">${App.i18n.value(() => (App.app.icon("plus")))} Add Contact</button>
        </div>
      </div>

      <div class="card contacts-card">
        <div class="contacts-toolbar filter-bar" id="cToolbar">
          <div class="contacts-toolbar-left">
            <div class="search-wrap">
              ${App.i18n.value(() => (App.app.icon("search")))}
              <input type="search" id="cSearch" placeholder="Search name, email, or phone…" value="${App.i18n.value(() => (U().esc(listFilters.search)))}">
            </div>
            <button type="button" class="btn filters-toggle" id="cFiltersBtn" aria-expanded="false" aria-controls="cFilterPanel">
              Filters<span class="filters-count" id="cFiltersCount" hidden></span>
            </button>
            <div class="contacts-filter-panel" id="cFilterPanel">
              <select id="cStage" aria-label="Filter by stage" ${App.i18n.value(() => (pastOnly ? "disabled" : ""))}>
                ${App.i18n.value(() => (pastOnly ? App.i18n.markup('<option value="Past Client">Past Client</option>') : App.i18n.html`
                <option value="">All stages</option>
                ${App.i18n.value(() => (settings.contactStages.map(st =>
                  App.i18n.html`<option value="${App.i18n.value(() => (st))}" ${App.i18n.value(() => (listFilters.stage===st?"selected":""))}>${App.i18n.value(() => (st))}</option>`).join("")))}
                `))}
              </select>
              <select id="cSource" aria-label="Filter by source">
                <option value="">All sources</option>
                ${App.i18n.value(() => (settings.leadSources.map(src =>
                  App.i18n.html`<option value="${App.i18n.value(() => (src))}" ${App.i18n.value(() => (listFilters.source===src?"selected":""))}>${App.i18n.value(() => (src))}</option>`).join("")))}
              </select>
              <select id="cTemp" aria-label="Filter by temperature">
                <option value="">All temps</option>
                ${App.i18n.value(() => (["Hot","Warm","Cold"].map(t =>
                  App.i18n.html`<option value="${App.i18n.value(() => (t))}" ${App.i18n.value(() => (listFilters.temp===t?"selected":""))}>${App.i18n.value(() => (App.i18n.t(t)))}</option>`).join("")))}
              </select>
              ${App.i18n.value(() => (showsOwners() ? App.i18n.html`
              <select id="cOwner" aria-label="Filter by who owns the lead">
                <option value="" ${App.i18n.value(() => (listFilters.owner === "" ? "selected" : ""))}>All leads</option>
                <option value="mine" ${App.i18n.value(() => (listFilters.owner === "mine" ? "selected" : ""))}>My leads</option>
                <option value="unassigned" ${App.i18n.value(() => (listFilters.owner === "unassigned" ? "selected" : ""))}>Nobody owns yet</option>
              </select>` : ""))}
              <select id="cSortMobile" class="contacts-sort-mobile" aria-label="Sort by">
                <option value="name-asc" ${App.i18n.value(() => (listFilters.sort==="name-asc"?"selected":""))}>Name (A–Z)</option>
                <option value="name-desc" ${App.i18n.value(() => (listFilters.sort==="name-desc"?"selected":""))}>Name (Z–A)</option>
                <option value="stage-asc" ${App.i18n.value(() => (listFilters.sort==="stage-asc"?"selected":""))}>Stage (A–Z)</option>
                <option value="stage-desc" ${App.i18n.value(() => (listFilters.sort==="stage-desc"?"selected":""))}>Stage (Z–A)</option>
                <option value="temp-desc" ${App.i18n.value(() => (listFilters.sort==="temp-desc"?"selected":""))}>Temp (Hot first)</option>
                <option value="temp-asc" ${App.i18n.value(() => (listFilters.sort==="temp-asc"?"selected":""))}>Temp (Cold first)</option>
                <option value="followup-asc" ${App.i18n.value(() => (listFilters.sort==="followup-asc"?"selected":""))}>Follow-up (soonest)</option>
                <option value="followup-desc" ${App.i18n.value(() => (listFilters.sort==="followup-desc"?"selected":""))}>Follow-up (latest)</option>
              </select>
            </div>
            <button type="button" class="btn-text-clear" id="cClearBtn" hidden>Clear</button>
          </div>
          <div class="contacts-toolbar-right">
            <span class="toolbar-count" id="cCountLabel">Loading…</span>
          </div>
        </div>
        <div class="card-body zero" id="cTableWrap"></div>
      </div>
    `;

    // Wire up filter controls
    const syncClearBtn = () => {
      const btn = document.getElementById("cClearBtn");
      if (btn) {
        const active = !!(listFilters.search || (!pastOnly && listFilters.stage) || listFilters.source || listFilters.temp);
        btn.hidden = !active;
      }
      const badge = document.getElementById("cFiltersCount");
      const filterBtn = document.getElementById("cFiltersBtn");
      const n = (!pastOnly && listFilters.stage ? 1 : 0) + (listFilters.source ? 1 : 0) + (listFilters.temp ? 1 : 0);
      if (badge) {
        App.i18n.setText(badge, App.i18n.value(() => (n ? String(n) : "")));
        badge.hidden = n === 0;
      }
      if (filterBtn) filterBtn.classList.toggle("has-active", n > 0);
    };
    const rerender = () => { syncClearBtn(); renderTable(); };
    document.getElementById("cSearch").addEventListener("input", (e) => { listFilters.search = e.target.value; rerender(); });
    document.getElementById("cStage").addEventListener("change", (e) => { listFilters.stage = e.target.value; rerender(); });
    document.getElementById("cSource").addEventListener("change", (e) => { listFilters.source = e.target.value; rerender(); });
    document.getElementById("cTemp").addEventListener("change", (e) => { listFilters.temp = e.target.value; rerender(); });
    const filtersBtn = document.getElementById("cFiltersBtn");
    const filterPanel = document.getElementById("cFilterPanel");
    if (filtersBtn && filterPanel) {
      filtersBtn.addEventListener("click", () => {
        const open = filterPanel.classList.toggle("open");
        filtersBtn.setAttribute("aria-expanded", String(open));
      });
    }
    const sortMobile = document.getElementById("cSortMobile");
    if (sortMobile) sortMobile.addEventListener("change", (e) => {
      listFilters.sort = e.target.value;
      renderTable();
    });
    document.getElementById("cClearBtn").addEventListener("click", () => {
      listFilters.search = "";
      if (!pastOnly) listFilters.stage = "";
      listFilters.source = "";
      listFilters.temp = "";
      const sEl = document.getElementById("cSearch"); if (sEl) sEl.value = "";
      const stEl = document.getElementById("cStage"); if (stEl && !pastOnly) stEl.value = "";
      const srEl = document.getElementById("cSource"); if (srEl) srEl.value = "";
      const tEl = document.getElementById("cTemp"); if (tEl) tEl.value = "";
      rerender();
    });
    const ownerSel = document.getElementById("cOwner");
    if (ownerSel) ownerSel.addEventListener("change", (e) => {
      listFilters.owner = e.target.value;
      selectedIds = [];
      rerender();
    });
    document.getElementById("addContactBtn").addEventListener("click", () => openContactModal(null));
    document.getElementById("importFileBtn").addEventListener("click", openFileImport);

    syncClearBtn();
    renderTable();
  }

  // ---------- GIVING LEADS TO PEOPLE ----------

  function bulkBarHtml(count) {
    const members = assignableMembers();
    return App.i18n.html`
      <div class="filter-bar" data-bulk-bar style="${App.i18n.value(() => (count ? "" : "display:none"))}">
        <strong data-bulk-count>${App.i18n.value(() => (count))} selected</strong>
        <select id="cBulkMember" aria-label="Give the selected leads to">
          <option value="">Choose a person…</option>
          <option value="__none__">Nobody — put them back in the pool</option>
          ${App.i18n.value(() => (members.map(m => App.i18n.html`<option value="${App.i18n.value(() => (U().esc(m.id)))}">${App.i18n.value(() => (U().esc(m.name)))}</option>`).join("")))}
        </select>
        <button class="btn btn-sm btn-primary" id="cBulkAssign">Hand over</button>
        <button class="btn btn-sm" id="cBulkClear">Clear selection</button>
      </div>`;
  }

  function wireBulkBar(wrap, filtered) {
    wrap.insertAdjacentHTML("afterbegin", bulkBarHtml(selectedIds.length));
    const bar = wrap.querySelector("[data-bulk-bar]");
    const countEl = wrap.querySelector("[data-bulk-count]");
    const selectAll = wrap.querySelector("#cSelectAll");

    const sync = () => {
      if (countEl) App.i18n.setText(countEl, App.i18n.value(() => (selectedIds.length + App.i18n.t(" selected"))));
      if (bar) bar.style.display = selectedIds.length ? "" : "none";
      if (selectAll) selectAll.checked = filtered.length > 0 && selectedIds.length === filtered.length;
    };

    wrap.querySelectorAll(".c-pick").forEach(cb => {
      cb.addEventListener("change", () => {
        const id = cb.getAttribute("data-pick");
        const at = selectedIds.indexOf(id);
        if (cb.checked && at === -1) selectedIds.push(id);
        else if (!cb.checked && at !== -1) selectedIds.splice(at, 1);
        sync();
      });
    });

    if (selectAll) selectAll.addEventListener("change", () => {
      selectedIds = selectAll.checked ? filtered.map(c => c.id) : [];
      wrap.querySelectorAll(".c-pick").forEach(cb => { cb.checked = selectAll.checked; });
      sync();
    });

    const clear = wrap.querySelector("#cBulkClear");
    if (clear) clear.addEventListener("click", () => {
      selectedIds = [];
      wrap.querySelectorAll(".c-pick").forEach(cb => { cb.checked = false; });
      sync();
    });

    const go = wrap.querySelector("#cBulkAssign");
    const pick = wrap.querySelector("#cBulkMember");
    if (go && pick) go.addEventListener("click", async () => {
      if (!selectedIds.length) return;
      if (!pick.value) { App.app.toast(App.i18n.t("Choose who the leads should go to."), "danger"); pick.focus(); return; }
      const memberId = pick.value === "__none__" ? null : pick.value;
      const name = memberId ? (memberNameById(memberId) || "that person") : "nobody";
      const ids = selectedIds.slice();
      App.app.confirmDialog({
        title: "Hand over " + ids.length + " lead" + (ids.length === 1 ? "" : "s") + "?",
        message: memberId
          ? "They will belong to " + name + " from now on."
          : "They go back in the pool for anybody to claim."
      }, async () => {
        go.disabled = true;
        const failures = await assignMany(ids, memberId);
        go.disabled = false;
        if (!failures) {
          App.app.toast(ids.length + App.i18n.t(" lead") + (ids.length === 1 ? "" : "s") + App.i18n.t(" handed over."), "success");
        } else if (failures < ids.length) {
          App.app.toast((ids.length - failures) + App.i18n.t(" handed over, ") + failures + App.i18n.t(" refused."), "danger");
        } else {
          App.app.toast(App.i18n.t("Could not hand these leads over."), "danger");
        }
        selectedIds = [];
        renderTable();
      });
    });

    sync();
  }

  // One at a time, on purpose: the per-row check that guards assignment
  // runs per row, so a part-refused batch has to be reported honestly
  // rather than as a single all-or-nothing result.
  async function assignMany(ids, memberId) {
    let failures = 0;
    for (let i = 0; i < ids.length; i++) {
      try {
        await S().contacts.update(ids[i], { assignedToId: memberId });
      } catch (err) {
        failures++;
      }
    }
    return failures;
  }

  function wireClaim(wrap) {
    wrap.querySelectorAll("[data-claim]").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-claim");
        const me = App.workspace ? App.workspace.teamMemberId() : null;
        if (!me) { App.app.toast(App.i18n.t("Your own team record is missing, so this cannot be claimed."), "danger"); return; }
        btn.disabled = true;
        try {
          await S().contacts.update(id, { assignedToId: me });
          App.app.toast(App.i18n.t("This lead is yours."), "success");
          renderTable();
        } catch (err) {
          btn.disabled = false;
          App.app.toast(App.i18n.t("Somebody else may have taken it. Refresh to see."), "danger");
        }
      });
    });
  }

  function applyFilters(contacts) {
    let out = contacts.slice();
    const f = listFilters;
    if (f.search) {
      const q = f.search.toLowerCase();
      out = out.filter(c =>
        (c.name || "").toLowerCase().includes(q) ||
        (c.email || "").toLowerCase().includes(q) ||
        (c.phone || "").toLowerCase().includes(q)
      );
    }
    if (f.role)   out = out.filter(c => c.role === f.role);
    if (f.stage)  out = out.filter(c => c.stage === f.stage);
    if (f.source) out = out.filter(c => c.source === f.source);
    if (f.temp)   out = out.filter(c => c.temperature === f.temp);
    if (f.owner === "unassigned") out = out.filter(c => !c.assignedToId);
    else if (f.owner === "mine") {
      const me = App.workspace ? App.workspace.teamMemberId() : null;
      out = out.filter(c => me && c.assignedToId === me);
    }

    // Sort
    const TEMP_RANK = { Hot: 3, Warm: 2, Cold: 1 };
    switch (f.sort) {
      case "name-desc":     out.sort((a,b) => (b.name||"").localeCompare(a.name||"")); break;
      case "stage-asc":     out.sort((a,b) => (a.stage||"").localeCompare(b.stage||"")); break;
      case "stage-desc":    out.sort((a,b) => (b.stage||"").localeCompare(a.stage||"")); break;
      case "temp-asc":      out.sort((a,b) => (TEMP_RANK[a.temperature]||0) - (TEMP_RANK[b.temperature]||0)); break;
      case "temp-desc":     out.sort((a,b) => (TEMP_RANK[b.temperature]||0) - (TEMP_RANK[a.temperature]||0)); break;
      case "followup-asc":  out.sort((a,b) => (a.nextFollowUp||"9999").localeCompare(b.nextFollowUp||"9999")); break;
      case "followup-desc": out.sort((a,b) => (b.nextFollowUp||"").localeCompare(a.nextFollowUp||"")); break;
      default:              out.sort((a,b) => (a.name||"").localeCompare(b.name||""));
    }
    return out;
  }

  function sortTh(col, label) {
    const isAsc = listFilters.sort === col + "-asc";
    const isDesc = listFilters.sort === col + "-desc";
    const ariaSort = isAsc ? "ascending" : isDesc ? "descending" : "none";
    const ind = isAsc ? "↑" : isDesc ? "↓" : "";
    return App.i18n.html`<th aria-sort="${App.i18n.value(() => (ariaSort))}"><button type="button" class="tbl-sort-btn${App.i18n.value(() => ((isAsc || isDesc) ? " is-sorted" : ""))}" data-sort-col="${App.i18n.value(() => (col))}"><span>${App.i18n.value(() => (App.i18n.t(label)))}</span>${App.i18n.value(() => (ind ? `<span class="tbl-sort-ind" aria-hidden="true">${ind}</span>` : ""))}</button></th>`;
  }

  function renderTable() {
    const contacts = S().getState().contacts;
    // Same persisted stage used by Reports and Buyer/Seller workspaces.
    const all = pastClientsOnly ? contacts.filter(c => c.stage === "Past Client") : contacts;
    const filtered = applyFilters(all);
    const wrap = document.getElementById("cTableWrap");
    const assignAllowed = canAssign();
    const claimAllowed = canClaim();
    const ownersShown = showsOwners();
    // Ticks for rows that have scrolled out of the filter are dropped, so a
    // bulk hand-over can only ever touch what is actually on screen.
    const visible = {};
    filtered.forEach(c => { visible[c.id] = true; });
    selectedIds = selectedIds.filter(id => visible[id]);
    const countLabel = filtered.length === all.length
      ? App.i18n.text`${App.i18n.value(() => (all.length))} contact${App.i18n.value(() => (all.length === 1 ? "" : "s"))}`
      : App.i18n.text`${App.i18n.value(() => (filtered.length))} of ${App.i18n.value(() => (all.length))} contact${App.i18n.value(() => (all.length === 1 ? "" : "s"))}`;
    App.i18n.setText(document.getElementById("cCountLabel"), countLabel);

    if (!filtered.length) {
      if (pastClientsOnly && all.length === 0) {
        wrap.innerHTML = App.i18n.markup(`<div class="empty"><h3>No past clients yet</h3><p>Contacts with the Past Client stage appear here. Update a contact using the existing contact form.</p></div>`);
      } else if (all.length === 0) {
        wrap.innerHTML = App.i18n.html`
          <div class="empty">
            <div class="empty-icon">${App.i18n.value(() => (App.app.icon("plus")))}</div>
            <h3>No contacts yet</h3>
            <p>Import leads from a file or Google Sheets, or add your first contact manually. Leads, past clients, and referral partners all belong here.</p>
            <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center">
              <button class="btn btn-primary" onclick="App.pages.contacts.openContactModal(null)">Add Your First Contact</button>
              <button class="btn btn-ghost" onclick="App.pages.contacts.openFileImport()">Import from file</button>
              <button class="btn btn-ghost" onclick="App.app.navigate('/settings/google-sheets')">Import from Google Sheets</button>
            </div>
          </div>`;
      } else {
        wrap.innerHTML = App.i18n.markup(`
          <div class="empty">
            <h3>No matches</h3>
            <p>Try clearing filters or adjusting your search.</p>
          </div>`);
      }
      return;
    }

    wrap.innerHTML = App.i18n.html`
      <div class="table-wrap">
        <table class="tbl tbl-responsive">
          <thead>
            <tr>
              ${App.i18n.value(() => (assignAllowed ? App.i18n.markup(`<th class="actions"><input type="checkbox" id="cSelectAll" aria-label="Select every lead shown"></th>`) : ""))}
              ${App.i18n.value(() => (sortTh("name", "Name")))}
              ${App.i18n.value(() => (ownersShown ? App.i18n.markup(`<th>Belongs to</th>`) : ""))}
              <th>Role</th>
              ${App.i18n.value(() => (sortTh("stage", "Stage")))}
              ${App.i18n.value(() => (sortTh("temp", "Temp")))}
              ${App.i18n.value(() => (sortTh("followup", "Next Follow-up")))}
              <th>Source</th>
              <th>Phone</th>
              <th class="actions">&nbsp;</th>
            </tr>
          </thead>
          <tbody>
            ${App.i18n.value(() => (filtered.map(c => App.i18n.html`
              <tr class="clickable" data-id="${App.i18n.value(() => (c.id))}">
                ${App.i18n.value(() => (assignAllowed ? App.i18n.html`<td class="actions" data-label="">
                  <input type="checkbox" class="c-pick" data-pick="${App.i18n.value(() => (c.id))}"
                         ${App.i18n.value(() => (selectedIds.indexOf(c.id) !== -1 ? "checked" : ""))}
                         aria-label="Select ${App.i18n.value(() => (U().esc(c.name || "this lead")))}">
                </td>` : ""))}
                <td data-label="Name" class="primary-cell">
                  <a href="#/contacts/${App.i18n.value(() => (c.id))}" class="link" data-nav-block>${App.i18n.value(() => (U().esc(c.name || App.i18n.t("(unnamed)"))))}</a>
                </td>
                ${App.i18n.value(() => (ownersShown ? App.i18n.html`<td data-label="Belongs to">${App.i18n.value(() => (ownerCell(c)))}</td>` : ""))}
                <td data-label="Role">${App.i18n.value(() => (U().esc(c.role || "—")))}</td>
                <td data-label="Stage">${App.i18n.value(() => (stagePill(c.stage)))}</td>
                <td data-label="Temp">${App.i18n.value(() => (tempBadge(c.temperature)))}</td>
                <td data-label="Next Follow-up">${App.i18n.value(() => (followUpCell(c)))}</td>
                <td data-label="Source">${App.i18n.value(() => (U().esc(c.source || "—")))}</td>
                <td data-label="Phone">${App.i18n.value(() => {
                  const raw = c.phone ? String(c.phone) : "";
                  const tel = raw.replace(/[^0-9+]/g, "");
                  return (raw && tel)
                    ? `<a href="tel:${U().esc(tel)}" class="link">${U().esc(raw)}</a>`
                    : U().esc(raw || "—");
                })}</td>
                <td class="actions" data-label="">
                  ${App.i18n.value(() => ((!c.assignedToId && claimAllowed) ? App.i18n.html`<button class="btn btn-sm" data-claim="${App.i18n.value(() => (c.id))}">Claim</button>` : ""))}
                  <button class="btn btn-sm btn-ghost" data-edit="${App.i18n.value(() => (c.id))}" aria-label="Edit ${App.i18n.value(() => (U().esc(c.name)))}">${App.i18n.value(() => (App.app.icon("edit")))}</button>
                </td>
              </tr>
            `).join("")))}
          </tbody>
        </table>
      </div>
    `;

    if (assignAllowed) wireBulkBar(wrap, filtered);
    if (claimAllowed) wireClaim(wrap);

    wrap.querySelectorAll("[data-sort-col]").forEach(btn => {
      btn.addEventListener("click", () => {
        const col = btn.getAttribute("data-sort-col");
        listFilters.sort = listFilters.sort === col + "-asc" ? col + "-desc" : col + "-asc";
        const sm = document.getElementById("cSortMobile");
        if (sm) sm.value = listFilters.sort;
        renderTable();
      });
    });

    // Row clicks -> detail
    wrap.querySelectorAll("tr.clickable").forEach(tr => {
      tr.addEventListener("click", (e) => {
        if (e.target.closest("button, a, input, select, label")) return;
        App.app.navigate("/contacts/" + tr.getAttribute("data-id"));
      });
    });
    wrap.querySelectorAll("[data-edit]").forEach(btn => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        openContactModal(btn.getAttribute("data-edit"));
      });
    });
  }

  // ---------- DETAIL PAGE ----------

  async function renderDetail(container, id) {
    container.innerHTML = App.app.loadingHtml();
    await S().ensureLoaded(DETAIL_DEPS);
    const state = S().getState();
    const contact = state.contacts.find(c => c.id === id);
    if (!contact) {
      App.app.setBreadcrumbs([{ get label() { return App.i18n.t("Contacts"); }, route: "/contacts" }, { get label() { return App.i18n.t("Not Found"); } }]);
      container.innerHTML = App.i18n.markup(`
        <div class="empty">
          <h3>Contact not found</h3>
          <p>This contact may have been deleted or the link is out of date.</p>
          <a href="#/contacts" class="btn btn-primary">Back to Contacts</a>
        </div>`);
      return;
    }

    App.app.setBreadcrumbs([
      { get label() { return App.i18n.t("Contacts"); }, route: "/contacts" },
      { label: contact.name || "(unnamed)" }
    ]);
    App.app.setTopActions(App.i18n.html`
      <button class="btn" id="editContactBtn">${App.i18n.value(() => (App.app.icon("edit")))} Edit</button>
      <button class="btn btn-danger" id="deleteContactBtn">${App.i18n.value(() => (App.app.icon("trash")))} Delete</button>
    `);

    const status = D().contactFollowUpStatus(contact);
    const relatedProperties = state.properties.filter(p => p.contactId === id);
    const relatedDeals      = state.deals.filter(d => d.contactId === id);
    const relatedActivities = state.activities.filter(a => a.contactId === id)
                              .sort((a,b) => (b.date||"").localeCompare(a.date||""));
    const relatedTasks      = state.tasks.filter(t => t.contactId === id);
    const relatedShowings   = state.showings.filter(sh => sh.contactId === id)
                              .sort((a,b) => (b.date||"").localeCompare(a.date||""));
    const relatedReferralsA = state.referrals.filter(r => r.referrerId === id);
    const relatedReferralsB = state.referrals.filter(r => r.referredContactId === id);

    let followupNote = "";
    if (status.status === "overdue") {
      followupNote = App.i18n.html` <span class="badge badge-overdue" style="margin-left:6px">${App.i18n.value(() => (status.daysOverdue))} day${App.i18n.value(() => (status.daysOverdue === 1 ? '' : 's'))} overdue</span>`;
    } else if (status.status === "due-today") {
      followupNote = App.i18n.markup(`<span class="badge badge-today" style="margin-left:8px">Due today</span>`);
    } else if (status.status === "upcoming") {
      followupNote = App.i18n.markup(`<span class="badge badge-upcoming" style="margin-left:8px">Upcoming</span>`);
    }

    container.innerHTML = App.i18n.html`
      ${App.i18n.value(() => (App.app.backLink("/contacts", "Contacts")))}
      <div class="detail-grid">
        <div class="col">
          <div class="card">
            <div class="profile-hero">
              <div class="avatar">${App.i18n.value(() => (U().esc(avatarInitials(contact.name))))}</div>
              <div class="name">${App.i18n.value(() => (U().esc(contact.name || App.i18n.t("(unnamed)"))))}</div>
              <div class="subline">
                <span>${App.i18n.value(() => (U().esc(contact.role || "—")))}</span>
                <span>·</span>
                ${App.i18n.value(() => (stagePill(contact.stage)))}
                <span>·</span>
                ${App.i18n.value(() => (tempBadge(contact.temperature)))}
              </div>
            </div>

            <div class="card-body">
              <div class="meta">
                <div><div class="k">Email</div><div class="v">${App.i18n.value(() => (U().esc(contact.email) || App.i18n.markup('<span style="color:var(--text-soft)">—</span>')))}</div></div>
                <div><div class="k">Phone</div><div class="v">${App.i18n.value(() => (U().esc(contact.phone) || App.i18n.markup('<span style="color:var(--text-soft)">—</span>')))}</div></div>
                <div><div class="k">Last Contact</div><div class="v">${App.i18n.value(() => (contact.lastContact ? U().formatDate(contact.lastContact) : App.i18n.markup('<span style="color:var(--text-soft)">—</span>')))}</div></div>
                <div><div class="k">Next Follow-up</div><div class="v">${App.i18n.value(() => (contact.nextFollowUp ? U().formatDate(contact.nextFollowUp) + followupNote : App.i18n.markup('<span style="color:var(--text-soft)">—</span>')))}</div></div>
                <div><div class="k">Birthday</div><div class="v">${App.i18n.value(() => (contact.birthday ? U().esc(U().formatDate(contact.birthday)) : App.i18n.markup('<span style="color:var(--text-soft)">—</span>')))}</div></div>
                <div><div class="k">Home purchase</div><div class="v">${App.i18n.value(() => (contact.homePurchaseDate ? U().esc(U().formatDate(contact.homePurchaseDate)) : App.i18n.markup('<span style="color:var(--text-soft)">—</span>')))}</div></div>
                <div><div class="k">Budget</div><div class="v">${App.i18n.value(() => (contact.budget ? U().formatCurrency(contact.budget, state.settings.currency) : App.i18n.markup('<span style="color:var(--text-soft)">—</span>')))}</div></div>
                <div><div class="k">Preferred Area</div><div class="v">${App.i18n.value(() => (U().esc(contact.preferredArea) || App.i18n.markup('<span style="color:var(--text-soft)">—</span>')))}</div></div>
                <div><div class="k">Source</div><div class="v">${App.i18n.value(() => (U().esc(contact.source) || App.i18n.markup('<span style="color:var(--text-soft)">—</span>')))}</div></div>
                <div><div class="k">Assigned Agent</div><div class="v">${App.i18n.value(() => (U().esc(contact.assignedAgent) || App.i18n.markup('<span style="color:var(--text-soft)">—</span>')))}</div></div>
                ${App.i18n.value(() => (showsOwners() ? App.i18n.html`<div><div class="k">Belongs to</div><div class="v" id="cDetailOwner">${App.i18n.value(() => (ownerControl(contact)))}</div></div>` : ""))}
              </div>
              ${App.i18n.value(() => (contact.notes ? App.i18n.html`
                <div style="margin-top: 18px; padding-top: 18px; border-top: 1px solid var(--border);">
                  <div class="k" style="font-size: var(--font-size-xs);color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:600;margin-bottom:6px;">Notes</div>
                  <div style="white-space:pre-wrap;">${App.i18n.value(() => (U().esc(contact.notes)))}</div>
                </div>` : ""))}
            </div>
          </div>

          ${App.i18n.value(() => (renderRelatedDealsCard(contact, relatedDeals, state)))}
          ${App.i18n.value(() => (renderRelatedPropertiesCard(contact, relatedProperties, state)))}
          ${App.i18n.value(() => (renderRelatedActivitiesCard(contact, relatedActivities)))}
          ${App.i18n.value(() => (renderRelatedShowingsCard(contact, relatedShowings, state)))}
          ${App.i18n.value(() => (renderReferralsCard(contact, relatedReferralsA, relatedReferralsB, state)))}
        </div>

        <div class="col">
          <div class="card" id="contactOneTapCard">
            <div class="card-header"><div class="card-title">Contact them</div></div>
            <div class="card-body">
              ${App.i18n.value(() => (App.followUp ? App.followUp.barHtml(contact) : ""))}
              <p class="form-help" style="margin:8px 0 0">Opens your own phone or mail app. RealtorCRM never sends these for you.</p>
            </div>
          </div>
          <div class="card">
            <div class="card-header"><div class="card-title">Quick Actions</div></div>
            <div class="card-body" style="display:flex;flex-direction:column;gap:8px;">
              <button class="btn btn-primary btn-block" id="quickAddDeal">${App.i18n.value(() => (App.app.icon("plus")))} Create Deal</button>
              <button class="btn btn-block" id="quickAddActivity">${App.i18n.value(() => (App.app.icon("plus")))} Log Activity</button>
              <button class="btn btn-block" id="quickAddTask">${App.i18n.value(() => (App.app.icon("plus")))} Add Task</button>
              <button class="btn btn-block" id="quickAddShowing">${App.i18n.value(() => (App.app.icon("plus")))} Schedule Showing</button>
              <button class="btn btn-block" id="quickAddProperty">${App.i18n.value(() => (App.app.icon("plus")))} Add Property</button>
            </div>
          </div>
          <div class="card" id="contactEmailStatusCard">
            <div class="card-header"><div class="card-title">Follow-up emails</div></div>
            <div class="card-body" data-role="email-status-body" aria-live="polite">
              <p class="form-help" style="margin:0">Loading…</p>
            </div>
          </div>
          <div class="card">
            <div class="card-header"><div class="card-title">Summary</div></div>
            <div class="card-body">
              <div style="display:flex;flex-direction:column;gap:14px;">
                <div><div class="k" style="font-size: var(--font-size-xs);color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:600;">Related deals</div><div style="font-size: var(--font-size-xl);font-weight:700;">${App.i18n.value(() => (relatedDeals.length))}</div></div>
                <div><div class="k" style="font-size: var(--font-size-xs);color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:600;">Related properties</div><div style="font-size: var(--font-size-xl);font-weight:700;">${App.i18n.value(() => (relatedProperties.length))}</div></div>
                <div><div class="k" style="font-size: var(--font-size-xs);color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:600;">Total activities</div><div style="font-size: var(--font-size-xl);font-weight:700;">${App.i18n.value(() => (relatedActivities.length))}</div></div>
                <div><div class="k" style="font-size: var(--font-size-xs);color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:600;">Open tasks</div><div style="font-size: var(--font-size-xl);font-weight:700;">${App.i18n.value(() => (relatedTasks.filter(t => t.status !== "Completed").length))}</div></div>
              </div>
            </div>
          </div>
          ${App.i18n.value(() => (renderRelatedTasksCard(contact, relatedTasks)))}
        </div>
      </div>
    `;

    // Wire up top actions
    document.getElementById("editContactBtn").addEventListener("click", () => openContactModal(id));
    document.getElementById("deleteContactBtn").addEventListener("click", () => openDeleteContactConfirm(id));

    // Quick actions
    document.getElementById("quickAddDeal").addEventListener("click", () => {
      // Pre-fill contact and side based on contact role
      const side = contact.role === "Seller" ? "Seller" : (contact.role === "Investor" ? "Buyer" : "Buyer");
      const dealName = contact.name + " — New Deal";
      App.pages.deals.openDealModal(null, { contactId: id, side, name: dealName });
    });
    document.getElementById("quickAddActivity").addEventListener("click", () => openActivityModal({ contactId: id }));
    document.getElementById("quickAddTask").addEventListener("click", () => openTaskModal({ contactId: id }));
    document.getElementById("quickAddShowing").addEventListener("click", () => openShowingModal({ contactId: id }));
    document.getElementById("quickAddProperty").addEventListener("click", () => {
      App.pages.properties.openPropertyModal(null, { contactId: id });
    });

    wireOneTapBar(container, contact);

    wireOwnerControl(container, contact);
    loadEmailStatusCard(id);
  }

  // ---------- FOLLOW-UP EMAIL STATUS (Phase 4E.2) ----------
  // Read-only status plus the owner's two manual actions. Both actions go
  // through App.store -> manage-automation; this page never writes
  // contacts, consents or email blocks itself.

  const BLOCK_REASON_LABELS = {
    bounce: "the address could not receive email",
    complaint: "the contact reported an email as spam",
    unsubscribe: "the contact unsubscribed",
    provider: "the email service blocked this address",
    manual: "email to this address was blocked"
  };

  // How someone unsubscribed, in words (keyed by the consent record's source).
  const UNSUBSCRIBE_HOW = {
    inbound_email: "by replying to an email",
    unsubscribe_link: "using the unsubscribe link",
    owner_manual: "(marked by you)",
    provider_webhook: "after reporting an email as spam"
  };

  // ---------- ONE LEAD'S OWNER ----------

  function ownerControl(contact) {
    if (canAssign()) {
      const members = assignableMembers();
      return App.i18n.html`<select id="cOwnerPick" aria-label="Who this lead belongs to">
        <option value="">Nobody yet</option>
        ${App.i18n.value(() => (members.map(m => App.i18n.html`<option value="${App.i18n.value(() => (U().esc(m.id)))}" ${App.i18n.value(() => (contact.assignedToId === m.id ? "selected" : ""))}>${App.i18n.value(() => (U().esc(m.name)))}</option>`).join("")))}
      </select>`;
    }
    if (!contact.assignedToId && canClaim()) {
      return App.i18n.html`${App.i18n.value(() => (ownerCell(contact)))} <button class="btn btn-sm" id="cOwnerClaim">Claim this lead</button>`;
    }
    return ownerCell(contact);
  }

  // Phase 2B. One delegated listener for the card above; re-rendering the
  // whole detail page after a log is the simplest correct refresh, since the
  // last-contact date, the next follow-up and the activity list all change.
  function wireOneTapBar(container, contact) {
    const card = container.querySelector("#contactOneTapCard");
    if (!card || !App.followUp) return;
    App.followUp.wireBar(card, {
      onLogged: async () => { await renderDetail(container, contact.id); }
    });
  }

  function wireOwnerControl(container, contact) {
    const pick = container.querySelector("#cOwnerPick");
    if (pick) {
      const before = pick.value;
      pick.addEventListener("change", async () => {
        const next = pick.value || null;
        pick.disabled = true;
        try {
          await S().contacts.update(contact.id, { assignedToId: next });
          App.app.toast(next ? App.i18n.t("Handed over to ") + (memberNameById(next) || "them") + "." : App.i18n.t("Back in the pool."), "success");
          await renderDetail(container, contact.id);
        } catch (err) {
          pick.value = before;
          pick.disabled = false;
          App.app.toast(App.i18n.t("Could not change who this belongs to."), "danger");
        }
      });
    }
    const claim = container.querySelector("#cOwnerClaim");
    if (claim) claim.addEventListener("click", async () => {
      const me = App.workspace ? App.workspace.teamMemberId() : null;
      if (!me) { App.app.toast(App.i18n.t("Your own team record is missing, so this cannot be claimed."), "danger"); return; }
      claim.disabled = true;
      try {
        await S().contacts.update(contact.id, { assignedToId: me });
        App.app.toast(App.i18n.t("This lead is yours."), "success");
        await renderDetail(container, contact.id);
      } catch (err) {
        claim.disabled = false;
        App.app.toast(App.i18n.t("Somebody else may have taken it. Refresh to see."), "danger");
      }
    });
  }

  function shortDate(value) {
    const d = value ? new Date(value) : null;
    if (!d || isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  async function loadEmailStatusCard(contactId) {
    const card = document.getElementById("contactEmailStatusCard");
    if (!card) return;
    const body = card.querySelector('[data-role="email-status-body"]');
    const runtime = S().automationRuntime;
    if (!runtime || typeof runtime.contactEmailStatus !== "function") { card.hidden = true; return; }
    let status = null;
    try {
      status = await runtime.contactEmailStatus(contactId);
    } catch (e) {
      if (document.getElementById("contactEmailStatusCard") !== card) return;
      body.innerHTML = App.i18n.markup('<p class="form-help" style="margin:0">Email status could not be loaded right now.</p>');
      return;
    }
    // The user may have navigated away while this loaded.
    if (document.getElementById("contactEmailStatusCard") !== card) return;
    if (!status) { card.hidden = true; return; }
    body.innerHTML = renderEmailStatus(status);
    wireEmailStatusActions(body, contactId, status);
  }

  function renderEmailStatus(status) {
    const lines = [];
    if (status.replyDetectedAt) {
      lines.push(App.i18n.html`<span class="badge badge-neutral"><span class="dot"></span>Contact replied</span> <span class="form-help">on ${App.i18n.value(() => (U().esc(shortDate(status.replyDetectedAt))))}</span>`);
    }
    if (status.unsubscribeDetectedAt) {
      const how = Object.prototype.hasOwnProperty.call(UNSUBSCRIBE_HOW, status.optOutSource) ? UNSUBSCRIBE_HOW[status.optOutSource] + " " : "";
      lines.push(App.i18n.html`<span class="badge badge-neutral"><span class="dot"></span>Contact unsubscribed</span> <span class="form-help">${App.i18n.value(() => (U().esc(how)))}on ${App.i18n.value(() => (U().esc(shortDate(status.unsubscribeDetectedAt))))}</span>`);
    }
    if (status.emailBlocked) {
      const why = Object.prototype.hasOwnProperty.call(BLOCK_REASON_LABELS, status.blockedReason) ? BLOCK_REASON_LABELS[status.blockedReason] : BLOCK_REASON_LABELS.manual;
      lines.push(App.i18n.html`<span class="badge badge-warning"><span class="dot"></span>Email blocked</span> <span class="form-help">because ${App.i18n.value(() => (U().esc(why)))}.</span>`);
    } else if (status.emailOptedOut && !status.unsubscribeDetectedAt) {
      lines.push(App.i18n.markup(`<span class="badge badge-warning"><span class="dot"></span>Email blocked</span> <span class="form-help">because the contact opted out of email.</span>`));
    }
    const summary = lines.length
      ? lines.map((l) => App.i18n.html`<div>${App.i18n.value(() => (l))}</div>`).join("")
      : App.i18n.markup('<p class="form-help" style="margin:0">Follow-up emails can be sent to this contact.</p>');
    const actions = [];
    if (!status.replyDetectedAt) actions.push(App.i18n.markup('<button type="button" class="btn btn-block" data-role="mark-replied">Mark as replied</button>'));
    if (!status.unsubscribeDetectedAt) actions.push(App.i18n.markup('<button type="button" class="btn btn-block" data-role="mark-unsubscribed">Mark as unsubscribed</button>'));
    return App.i18n.html`
      <div style="display:flex;flex-direction:column;gap:8px;">${App.i18n.value(() => (summary))}</div>
      ${App.i18n.value(() => (actions.length ? App.i18n.html`<div style="display:flex;flex-direction:column;gap:8px;margin-top:14px;">${App.i18n.value(() => (actions.join("")))}</div>` : ""))}`;
  }

  function wireEmailStatusActions(body, contactId, status) {
    const replied = body.querySelector('[data-role="mark-replied"]');
    const unsubscribed = body.querySelector('[data-role="mark-unsubscribed"]');
    if (replied) replied.addEventListener("click", () => confirmEmailStatusAction(replied, contactId, "replied"));
    if (unsubscribed) unsubscribed.addEventListener("click", () => confirmEmailStatusAction(unsubscribed, contactId, "unsubscribed"));
  }

  function confirmEmailStatusAction(button, contactId, kind) {
    const isReply = kind === "replied";
    App.app.confirmDialog({
      title: isReply ? "Mark as replied?" : "Mark as unsubscribed?",
      message: isReply
        ? "Automations set to stop when a contact replies will stop for this contact. This is noted on their timeline and can't be undone from here."
        : "This contact won't receive any more follow-up emails, and automations set to stop on unsubscribe will stop. This is noted on their timeline and can't be undone from here.",
      okLabel: isReply ? "Mark as replied" : "Mark as unsubscribed",
      danger: !isReply
    }, async () => {
      if (button.disabled) return;
      button.disabled = true;
      try {
        if (isReply) await S().automationRuntime.markReplied(contactId);
        else await S().automationRuntime.markUnsubscribed(contactId);
        App.app.toast(isReply ? App.i18n.t("Marked as replied.") : App.i18n.t("Marked as unsubscribed."), "success");
        await loadEmailStatusCard(contactId);
      } catch (err) {
        const code = err && err.code;
        const known = {
          try_again: "Something went wrong. Please try again.",
          contact_not_found: "This contact no longer exists.",
          request_ambiguous: "We couldn't confirm that was saved. Refresh the page to check before trying again."
        };
        App.app.toast(Object.prototype.hasOwnProperty.call(known, code) ? known[code] : App.i18n.t("That couldn't be saved. Please try again."), "danger");
        button.disabled = false;
      }
    });
  }

  // ---------- RELATED-RECORD CARDS ----------

  function renderRelatedDealsCard(contact, deals, state) {
    return App.i18n.html`
      <div class="card">
        <div class="card-header">
          <div class="card-title">Related Deals</div>
          <span class="badge badge-neutral">${App.i18n.value(() => (deals.length))}</span>
        </div>
        <div class="card-body zero">
          ${App.i18n.value(() => (deals.length === 0 ? App.i18n.markup(`
            <div class="empty" style="padding:var(--empty-padding)">
              <p>No deals for this contact yet.</p>
            </div>
          `) : deals.map(d => {
            const p = d.propertyId ? state.properties.find(x => x.id === d.propertyId) : null;
            const net = C().netGCI(d);
            const cur = state.settings.currency;
            return App.i18n.html`
              <div class="item-row">
                <div class="icon-slot">${App.i18n.value(() => (App.app.icon("dollar")))}</div>
                <div class="body">
                  <div class="title">${App.i18n.value(() => (U().esc(d.name)))}</div>
                  <div class="sub">
                    ${App.i18n.value(() => (U().esc(d.stage)))} · ${App.i18n.value(() => (U().esc(d.side)))} side
                    ${App.i18n.value(() => (p ? " · " + U().esc(p.address) : ""))}
                    ${App.i18n.value(() => (d.closeDate ? " · Close " + U().formatDate(d.closeDate) : ""))}
                  </div>
                </div>
                <div class="meta-right">
                  <div style="font-weight:600;color:var(--text);">${App.i18n.value(() => (U().formatCurrency(d.salePrice, cur)))}</div>
                  <div style="font-size: var(--font-size-xs);">Net ${App.i18n.value(() => (U().formatCurrency(net, cur)))}</div>
                </div>
              </div>
            `;
          }).join("")))}
        </div>
      </div>
    `;
  }

  function renderRelatedPropertiesCard(contact, properties, state) {
    return App.i18n.html`
      <div class="card">
        <div class="card-header">
          <div class="card-title">Related Properties</div>
          <span class="badge badge-neutral">${App.i18n.value(() => (properties.length))}</span>
        </div>
        <div class="card-body zero">
          ${App.i18n.value(() => (properties.length === 0 ? App.i18n.markup(`
            <div class="empty" style="padding:var(--empty-padding)">
              <p>No properties linked to this contact.</p>
            </div>
          `) : properties.map(p => App.i18n.html`
            <div class="item-row clickable" onclick="location.hash='#/properties/${App.i18n.value(() => (p.id))}'">
              <div class="icon-slot">${App.i18n.value(() => (App.app.icon("home")))}</div>
              <div class="body">
                <div class="title">${App.i18n.value(() => (U().esc(p.address)))} ${App.i18n.value(() => (p.mls ? App.i18n.html`<span style="font-size: var(--font-size-xs);color:var(--text-soft);font-weight:500;">${App.i18n.value(() => (U().esc(p.mls)))}</span>` : ""))}</div>
                <div class="sub">
                  ${App.i18n.value(() => (U().esc(p.status)))}
                  ${App.i18n.value(() => (p.beds ? " · " + p.beds + "bd" : ""))}${App.i18n.value(() => (p.baths ? "/" + p.baths + "ba" : ""))}
                  ${App.i18n.value(() => (p.sqft ? " · " + p.sqft.toLocaleString() + " sqft" : ""))}
                </div>
              </div>
              <div class="meta-right">
                <div style="font-weight:600;color:var(--text);">${App.i18n.value(() => (p.listPrice ? U().formatCurrency(p.listPrice, state.settings.currency) : "—"))}</div>
              </div>
            </div>
          `).join("")))}
        </div>
      </div>
    `;
  }

  function renderRelatedActivitiesCard(contact, activities) {
    return App.i18n.html`
      <div class="card">
        <div class="card-header">
          <div class="card-title">Activity Timeline</div>
          <span class="badge badge-neutral">${App.i18n.value(() => (activities.length))}</span>
        </div>
        <div class="card-body zero">
          ${App.i18n.value(() => (activities.length === 0 ? App.i18n.markup(`
            <div class="empty" style="padding:var(--empty-padding)">
              <p>No activities logged yet. Use "Log Activity" to record calls, emails, meetings, and notes.</p>
            </div>
          `) : activities.slice(0, 10).map(a => App.i18n.html`
            <div class="item-row">
              <div class="icon-slot">${App.i18n.value(() => (activityIcon(a.type)))}</div>
              <div class="body">
                <div class="title">${App.i18n.value(() => (U().esc(a.subject || a.type)))} <span style="font-weight:500;color:var(--text-muted);font-size: var(--font-size-xs);">· ${App.i18n.value(() => (U().esc(a.type)))}</span></div>
                ${App.i18n.value(() => (a.notes ? App.i18n.html`<div class="sub">${App.i18n.value(() => (U().esc(U().truncate(a.notes, 120))))}</div>` : ""))}
              </div>
              <div class="meta-right">${App.i18n.value(() => (a.date ? U().relativeDayLabel(a.date.slice(0,10)) : "—"))}</div>
            </div>
          `).join("")))}
        </div>
      </div>
    `;
  }

  function renderRelatedShowingsCard(contact, showings, state) {
    return App.i18n.html`
      <div class="card">
        <div class="card-header">
          <div class="card-title">Showings</div>
          <span class="badge badge-neutral">${App.i18n.value(() => (showings.length))}</span>
        </div>
        <div class="card-body zero">
          ${App.i18n.value(() => (showings.length === 0 ? App.i18n.markup(`
            <div class="empty" style="padding:var(--empty-padding)">
              <p>No showings scheduled.</p>
            </div>
          `) : showings.map(sh => {
            const p = sh.propertyId ? state.properties.find(x => x.id === sh.propertyId) : null;
            return App.i18n.html`
              <div class="item-row">
                <div class="icon-slot">${App.i18n.value(() => (App.app.icon("home")))}</div>
                <div class="body">
                  <div class="title">${App.i18n.value(() => (p ? U().esc(p.address) : App.i18n.t("Property removed")))}</div>
                  <div class="sub">${App.i18n.value(() => (U().formatDate(sh.date)))} · ${App.i18n.value(() => (U().esc(sh.startTime || "")))} · ${App.i18n.value(() => (U().esc(sh.status)))}</div>
                </div>
              </div>
            `;
          }).join("")))}
        </div>
      </div>
    `;
  }

  function renderRelatedTasksCard(contact, tasks) {
    const open = tasks.filter(t => t.status !== "Completed");
    const done = tasks.filter(t => t.status === "Completed");
    return App.i18n.html`
      <div class="card">
        <div class="card-header">
          <div class="card-title">Tasks</div>
          <span class="badge badge-neutral">${App.i18n.value(() => (open.length))} open · ${App.i18n.value(() => (done.length))} done</span>
        </div>
        <div class="card-body zero">
          ${App.i18n.value(() => (tasks.length === 0 ? App.i18n.markup(`
            <div class="empty" style="padding:var(--empty-padding)">
              <p>No tasks yet.</p>
            </div>
          `) : tasks.map(t => {
            const overdue = t.dueDate && t.dueDate < U().todayISO() && t.status !== "Completed";
            return App.i18n.html`
              <div class="item-row">
                <div class="icon-slot" style="background:${App.i18n.value(() => (t.status === "Completed" ? "var(--success-soft)" : "var(--accent-soft)"))};color:${App.i18n.value(() => (t.status === "Completed" ? "var(--success)" : "var(--accent)"))};">
                  ${App.i18n.value(() => (App.app.icon("check")))}
                </div>
                <div class="body">
                  <div class="title" style="${App.i18n.value(() => (t.status === "Completed" ? "text-decoration:line-through;color:var(--text-muted);" : ""))}">${App.i18n.value(() => (U().esc(t.title)))}</div>
                  <div class="sub">
                    ${App.i18n.value(() => (U().esc(t.priority)))} priority · ${App.i18n.value(() => (U().esc(t.status)))}
                    ${App.i18n.value(() => (t.dueDate ? " · Due " + U().formatDate(t.dueDate) : ""))}
                    ${App.i18n.value(() => (overdue ? App.i18n.markup(' <span class="badge badge-overdue">Overdue</span>') : ""))}
                  </div>
                </div>
              </div>
            `;
          }).join("")))}
        </div>
      </div>
    `;
  }

  function renderReferralsCard(contact, referralsFromThem, referralsAboutThem, state) {
    const total = referralsFromThem.length + referralsAboutThem.length;
    if (total === 0) return "";
    return App.i18n.html`
      <div class="card">
        <div class="card-header">
          <div class="card-title">Referrals</div>
          <span class="badge badge-neutral">${App.i18n.value(() => (total))}</span>
        </div>
        <div class="card-body zero">
          ${App.i18n.value(() => (referralsFromThem.map(r => {
            const to = state.contacts.find(x => x.id === r.referredContactId);
            return App.i18n.html`
              <div class="item-row">
                <div class="icon-slot">${App.i18n.value(() => (App.app.icon("share")))}</div>
                <div class="body">
                  <div class="title">Referred ${App.i18n.value(() => (to ? U().esc(to.name) : App.i18n.t("someone")))}</div>
                  <div class="sub">${App.i18n.value(() => (U().formatDate(r.date)))} · ${App.i18n.value(() => (U().esc(r.status)))}</div>
                </div>
              </div>
            `;
          }).join("")))}
          ${App.i18n.value(() => (referralsAboutThem.map(r => {
            const from = state.contacts.find(x => x.id === r.referrerId);
            return App.i18n.html`
              <div class="item-row">
                <div class="icon-slot">${App.i18n.value(() => (App.app.icon("share")))}</div>
                <div class="body">
                  <div class="title">Referred by ${App.i18n.value(() => (from ? U().esc(from.name) : App.i18n.t("someone")))}</div>
                  <div class="sub">${App.i18n.value(() => (U().formatDate(r.date)))} · ${App.i18n.value(() => (U().esc(r.status)))}</div>
                </div>
              </div>
            `;
          }).join("")))}
        </div>
      </div>
    `;
  }

  function activityIcon(type) {
    const t = String(type).toLowerCase();
    if (t.includes("call")) return "📞";
    if (t.includes("text")) return "💬";
    if (t.includes("email")) return "✉️";
    if (t.includes("meet")) return "🤝";
    return "📝";
  }

  // ---------- CONTACT MODAL (ADD / EDIT) ----------

  async function openContactModal(id) {
    const editing = !!id;
    await S().ensureLoaded(["contacts"]);
    const existing = editing ? S().getState().contacts.find(c => c.id === id) : null;
    if (editing && !existing) { App.app.toast(App.i18n.t("Contact not found."), "danger"); return; }

    const s = S().getState();
    const c = existing || {
      name: "", role: "Buyer", email: "", phone: "",
      stage: s.settings.contactStages[0], source: "Referral", temperature: "Warm",
      lastContact: null, nextFollowUp: null, birthday: null, homePurchaseDate: null,
      budget: 0, preferredArea: "", assignedAgent: "Self", notes: ""
    };

    const body = App.i18n.html`
      <form id="contactForm" novalidate>
        <div class="form-grid">
          <div class="form-field full">
            <label for="fName">Name <span class="req">*</span></label>
            <input type="text" id="fName" value="${App.i18n.value(() => (U().esc(c.name)))}" required autofocus>
            <div class="err">Name is required.</div>
          </div>
          <div class="form-field">
            <label for="fRole">Role <span class="req">*</span></label>
            <select id="fRole" required>
              ${App.i18n.value(() => (["Buyer","Seller","Investor","Referral Partner"].map(r =>
                App.i18n.html`<option value="${App.i18n.value(() => (r))}" ${App.i18n.value(() => (c.role===r?"selected":""))}>${App.i18n.value(() => (App.i18n.t(r)))}</option>`).join("")))}
            </select>
          </div>
          <div class="form-field">
            <label for="fStage">Stage</label>
            <select id="fStage">
              ${App.i18n.value(() => (s.settings.contactStages.map(st =>
                App.i18n.html`<option value="${App.i18n.value(() => (st))}" ${App.i18n.value(() => (c.stage===st?"selected":""))}>${App.i18n.value(() => (st))}</option>`).join("")))}
            </select>
          </div>
          <div class="form-field">
            <label for="fEmail">Email</label>
            <input type="email" id="fEmail" value="${App.i18n.value(() => (U().esc(c.email)))}">
            <div class="err">Please enter a valid email address.</div>
          </div>
          <div class="form-field">
            <label for="fPhone">Phone</label>
            <input type="tel" id="fPhone" value="${App.i18n.value(() => (U().esc(c.phone)))}">
          </div>
          <div class="form-field">
            <label for="fSource">Source</label>
            <select id="fSource">
              ${App.i18n.value(() => (s.settings.leadSources.map(src =>
                App.i18n.html`<option value="${App.i18n.value(() => (src))}" ${App.i18n.value(() => (c.source===src?"selected":""))}>${App.i18n.value(() => (src))}</option>`).join("")))}
            </select>
          </div>
          <div class="form-field">
            <label for="fTemp">Temperature</label>
            <select id="fTemp">
              ${App.i18n.value(() => (["Hot","Warm","Cold"].map(t =>
                App.i18n.html`<option value="${App.i18n.value(() => (t))}" ${App.i18n.value(() => (c.temperature===t?"selected":""))}>${App.i18n.value(() => (App.i18n.t(t)))}</option>`).join("")))}
            </select>
          </div>
          <div class="form-field">
            <label for="fLast">Last Contact</label>
            <input type="date" id="fLast" value="${App.i18n.value(() => (c.lastContact || ""))}">
          </div>
          <div class="form-field">
            <label for="fNext">Next Follow-up</label>
            <input type="date" id="fNext" value="${App.i18n.value(() => (c.nextFollowUp || ""))}">
          </div>
          <div class="form-field">
            <label for="fBirthday">Birthday</label>
            <input type="date" id="fBirthday" value="${App.i18n.value(() => (c.birthday || ""))}">
            <p class="form-help">Only the day and month are used, so an unknown year is fine.</p>
          </div>
          <div class="form-field">
            <label for="fHomePurchase">Home purchase date</label>
            <input type="date" id="fHomePurchase" value="${App.i18n.value(() => (c.homePurchaseDate || ""))}">
            <p class="form-help">Filled in for you when a deal is marked won, if it is still empty.</p>
          </div>
          <div class="form-field">
            <label for="fBudget">Budget (${App.i18n.value(() => (U().currencySymbol(s.settings.currency)))})</label>
            <input type="number" id="fBudget" value="${App.i18n.value(() => (c.budget || 0))}" min="0" step="1000">
          </div>
          <div class="form-field">
            <label for="fArea">Preferred Area</label>
            <input type="text" id="fArea" value="${App.i18n.value(() => (U().esc(c.preferredArea)))}">
          </div>
          <div class="form-field full">
            <label for="fNotes">Notes</label>
            <textarea id="fNotes" rows="4">${App.i18n.value(() => (U().esc(c.notes)))}</textarea>
          </div>
        </div>
        ${App.i18n.value(() => (App.customFieldsUI.renderSection("contact", editing ? id : null)))}
      </form>
    `;

    const handle = App.app.openModal({
      title: editing ? "Edit Contact" : "Add Contact",
      body,
      footer: App.i18n.html`
        <button class="btn" data-role="cancel">Cancel</button>
        <button class="btn btn-primary" data-role="save">${App.i18n.value(() => (editing ? App.i18n.t("Save Changes") : App.i18n.t("Add Contact")))}</button>
      `,
      onOpen: (modal) => {
        modal.querySelector('[data-role="cancel"]').addEventListener("click", () => handle.close());
        modal.querySelector('[data-role="save"]').addEventListener("click", () => submitContactForm(editing, id, handle));
        // Submit on enter (for single-line inputs)
        modal.querySelector("#contactForm").addEventListener("keydown", (e) => {
          if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") {
            e.preventDefault();
            submitContactForm(editing, id, handle);
          }
        });
      }
    });
  }

  async function submitContactForm(editing, id, handle) {
    const $ = (sel) => document.querySelector(sel);
    const nameField = $("#fName").closest(".form-field");
    const emailField = $("#fEmail").closest(".form-field");
    nameField.classList.remove("has-error");
    emailField.classList.remove("has-error");

    const name = $("#fName").value.trim();
    const email = $("#fEmail").value.trim();

    let valid = true;
    if (!name) { nameField.classList.add("has-error"); valid = false; }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      emailField.classList.add("has-error"); valid = false;
    }
    const missingCustom = App.customFieldsUI.findMissingRequired(document, "contact");
    if (missingCustom.length) {
      App.app.toast(App.i18n.text`${App.i18n.value(() => (missingCustom.join(", ")))} ${App.i18n.value(() => (missingCustom.length === 1 ? "is" : "are"))} required.`, "danger");
      valid = false;
    }
    if (!valid) return;

    const patch = {
      name: name,
      role: $("#fRole").value,
      email: email,
      phone: $("#fPhone").value.trim(),
      stage: $("#fStage").value,
      source: $("#fSource").value,
      temperature: $("#fTemp").value,
      lastContact: $("#fLast").value || null,
      nextFollowUp: $("#fNext").value || null,
      birthday: $("#fBirthday").value || null,
      homePurchaseDate: $("#fHomePurchase").value || null,
      budget: U().num($("#fBudget").value),
      preferredArea: $("#fArea").value.trim(),
      notes: $("#fNotes").value
    };
    const customValues = App.customFieldsUI.collectValues(document, "contact");

    const saveBtn = document.querySelector('#contactForm')?.closest(".modal")?.querySelector('[data-role="save"]');
    if (saveBtn) saveBtn.disabled = true;

    let savedId = id;
    try {
      if (editing) {
        await S().contacts.update(id, patch);
        App.app.toast(App.i18n.t("Contact updated."), "success");
      } else {
        const c = await S().contacts.create(patch);
        savedId = c.id;
        App.app.toast(App.i18n.text`Added ${App.i18n.value(() => (c.name))}.`, "success");
      }
      await S().customFields.setValues("contact", savedId, customValues);
      handle.close();
      App.app.route();
    } catch (err) {
      App.app.toast(App.i18n.t("Could not save contact: ") + err.message, "danger");
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  async function openDeleteContactConfirm(id) {
    await S().ensureLoaded(["contacts"]);
    const contact = S().getState().contacts.find(c => c.id === id);
    if (!contact) { App.app.toast(App.i18n.t("Contact not found."), "danger"); return; }
    let preview;
    try {
      preview = await S().contacts.delete(id); // returns needsConfirmation payload
    } catch (err) {
      App.app.toast(App.i18n.t("Could not check related records: ") + err.message, "danger");
      return;
    }
    App.app.confirmDialog({
      get title() { return App.i18n.t("Delete Contact?"); },
      message: App.i18n.html`This will permanently remove <strong>${App.i18n.value(() => (U().esc(contact.name)))}</strong> from your CRM.`,
      impact: preview.impact,
      okLabel: "Delete Contact",
      danger: true
    }, async () => {
      try {
        const result = await S().contacts.delete(id, { force: true });
        if (result.deleted) {
          App.app.toast(App.i18n.t("Contact deleted."), "success");
          App.app.navigate("/contacts");
        } else {
          App.app.toast(App.i18n.t("Delete failed."), "danger");
        }
      } catch (err) {
        App.app.toast(App.i18n.t("Delete failed: ") + err.message, "danger");
      }
    });
  }

  // ---------- ACTIVITY QUICK-ADD MODAL ----------

  // Quick-add-activity shortcut, called from Contacts/Properties/Deals
  // detail pages with a small { contactId } prefill. This used to carry its
  // own duplicate activity form; it now delegates to the canonical form in
  // activities.js so there is exactly one place that renders activity
  // fields, validates them, and saves — every quick-add entry point
  // automatically gets the same fields (Deal, Time) as the main Activities
  // page, for free.
  function openActivityModal(prefill) {
    return App.pages.activities.openActivityModal(null, prefill);
  }

  // ---------- TASK QUICK-ADD MODAL ----------

  // Quick-add-task shortcut, called from Contacts/Properties/Deals/Calendar
  // detail pages with a small { contactId, dealId, propertyId, dueDate }
  // prefill. This used to carry its own duplicate task form; it now delegates
  // to the canonical form in tasks-page.js so there is exactly one place that
  // renders task fields, validates required custom fields, and saves a task
  // — every quick-add entry point automatically gets the same fields (Status,
  // Assigned To, Custom Fields) as the main Tasks page, for free.
  function openTaskModal(prefill) {
    return App.pages.tasks.openTaskModal(null, prefill);
  }

  // ---------- SHOWING QUICK-ADD MODAL ----------

  async function openShowingModal(prefill) {
    prefill = prefill || {};
    await S().ensureLoaded(["contacts", "properties"]);
    const state = S().getState();
    const body = App.i18n.html`
      <form id="showForm" novalidate>
        <div class="form-grid">
          <div class="form-field">
            <label for="sDate">Date <span class="req">*</span></label>
            <input type="date" id="sDate" value="${App.i18n.value(() => (prefill.date || U().todayISO()))}" required>
            <div class="err">Date is required.</div>
          </div>
          <div class="form-field">
            <label for="sStart">Start Time</label>
            <input type="time" id="sStart" value="10:00">
          </div>
          <div class="form-field">
            <label for="sContact">Contact <span class="req">*</span></label>
            <select id="sContact" required>
              <option value="">— select —</option>
              ${App.i18n.value(() => (state.contacts.slice().sort((a,b) => a.name.localeCompare(b.name)).map(c =>
                App.i18n.html`<option value="${App.i18n.value(() => (c.id))}" ${App.i18n.value(() => (prefill.contactId===c.id?"selected":""))}>${App.i18n.value(() => (U().esc(c.name)))}</option>`).join("")))}
            </select>
            <div class="err">Contact is required.</div>
          </div>
          <div class="form-field">
            <label for="sProperty">Property <span class="req">*</span></label>
            <select id="sProperty" required>
              <option value="">— select —</option>
              ${App.i18n.value(() => (state.properties.map(p =>
                App.i18n.html`<option value="${App.i18n.value(() => (p.id))}" ${App.i18n.value(() => (prefill.propertyId===p.id?"selected":""))}>${App.i18n.value(() => (U().esc(p.address)))}</option>`).join("")))}
            </select>
            <div class="err">Property is required.</div>
          </div>
          <div class="form-field full">
            <label for="sNotes">Notes</label>
            <textarea id="sNotes" rows="3"></textarea>
          </div>
        </div>
      </form>
    `;
    const handle = App.app.openModal({
      get title() { return App.i18n.t("Schedule Showing"); },
      body,
      footer: App.i18n.markup(`
        <button class="btn" data-role="cancel">Cancel</button>
        <button class="btn btn-primary" data-role="save">Add Showing</button>
      `),
      onOpen: (modal) => {
        modal.querySelector('[data-role="cancel"]').addEventListener("click", () => handle.close());
        modal.querySelector('[data-role="save"]').addEventListener("click", async () => {
          const date = document.querySelector("#sDate");
          const contact = document.querySelector("#sContact");
          const property = document.querySelector("#sProperty");
          [date, contact, property].forEach(el => el.closest(".form-field").classList.remove("has-error"));
          let valid = true;
          if (!date.value)    { date.closest(".form-field").classList.add("has-error"); valid = false; }
          if (!contact.value) { contact.closest(".form-field").classList.add("has-error"); valid = false; }
          if (!property.value){ property.closest(".form-field").classList.add("has-error"); valid = false; }
          if (!valid) return;

          const saveBtn = modal.querySelector('[data-role="save"]');
          saveBtn.disabled = true;
          try {
            await S().showings.create({
              date: date.value,
              startTime: document.querySelector("#sStart").value || "10:00",
              contactId: contact.value,
              propertyId: property.value,
              // No deal picker in this form — carries a quick-add shortcut's
              // dealId prefill straight through (e.g. from Deal Detail's
              // "Schedule Showing" button) instead of silently dropping it,
              // which previously left the showing missing from that deal's
              // related-showings list.
              dealId: prefill.dealId || null,
              status: "Scheduled",
              notes: document.querySelector("#sNotes").value
            });
            App.app.toast(App.i18n.t("Showing scheduled."), "success");
            handle.close();
            App.app.route();
          } catch (err) {
            App.app.toast(App.i18n.t("Could not save showing: ") + err.message, "danger");
            saveBtn.disabled = false;
          }
        });
      }
    });
  }

  // ---------- DAILY VIEW FOLLOW-UP QUICK-ACTION MODAL ----------
  // Opened only from Daily View's "Follow-up" / "Overdue follow-up" rows
  // (see App.pages.release.renderDaily). Logs an Activity and advances the
  // contact's lastContact/nextFollowUp as one atomic operation through the
  // realtoros_complete_followup RPC (App.store.completeFollowUp), replacing
  // the old client-side App.store.runBatch() pairing.
  async function openFollowUpModal(contactId) {
    await S().ensureLoaded(["contacts"]);
    const contact = S().getState().contacts.find(c => c.id === contactId);
    if (!contact) { App.app.toast(App.i18n.t("This contact no longer exists."), "danger"); return; }
    // One activity id per opening of this modal, reused by every save
    // attempt from it: a retry after a lost response fails on the
    // activity's primary key instead of writing a duplicate.
    const attemptId = U().uid("ac");

    const s = S().getState();
    const status = D().contactFollowUpStatus(contact);
    const statusBadge = status.status === "overdue" ? App.i18n.html`<span class="badge badge-overdue">${App.i18n.value(() => (status.daysOverdue))} day${App.i18n.value(() => (status.daysOverdue === 1 ? '' : 's'))} overdue</span>`
      : status.status === "due-today" ? App.i18n.markup(`<span class="badge badge-today">Due today</span>`)
      : followUpCell(contact);

    const info = App.i18n.html`
      <div class="meta" style="margin-bottom:18px;">
        <div><div class="k">Contact</div><div class="v">${App.i18n.value(() => (U().esc(contact.name || App.i18n.t("(unnamed)"))))}</div></div>
        <div><div class="k">Follow-up status</div><div class="v">${App.i18n.value(() => (statusBadge))}</div></div>
        <div><div class="k">Role</div><div class="v">${App.i18n.value(() => (U().esc(contact.role || "—")))}</div></div>
        <div><div class="k">Stage</div><div class="v">${App.i18n.value(() => (stagePill(contact.stage)))}</div></div>
        <div><div class="k">Temperature</div><div class="v">${App.i18n.value(() => (tempBadge(contact.temperature)))}</div></div>
        <div><div class="k">Phone</div><div class="v">${App.i18n.value(() => (contact.phone ? U().esc(contact.phone) : App.i18n.markup('<span style="color:var(--text-soft)">—</span>')))}</div></div>
        <div><div class="k">Email</div><div class="v">${App.i18n.value(() => (contact.email ? U().esc(contact.email) : App.i18n.markup('<span style="color:var(--text-soft)">—</span>')))}</div></div>
        <div><div class="k">Last contact</div><div class="v">${App.i18n.value(() => (contact.lastContact ? U().formatDate(contact.lastContact) : App.i18n.markup('<span style="color:var(--text-soft)">—</span>')))}</div></div>
        <div><div class="k">Current follow-up date</div><div class="v">${App.i18n.value(() => (contact.nextFollowUp ? U().formatDate(contact.nextFollowUp) : App.i18n.markup('<span style="color:var(--text-soft)">—</span>')))}</div></div>
        ${App.i18n.value(() => (contact.preferredArea ? App.i18n.html`<div><div class="k">Preferred area</div><div class="v">${App.i18n.value(() => (U().esc(contact.preferredArea)))}</div></div>` : ""))}
      </div>
      ${App.i18n.value(() => (contact.notes ? App.i18n.html`<div style="margin-bottom:18px;padding:10px 12px;background:var(--surface-sunk);border-radius:var(--radius-sm);">
        <div style="font-size:var(--font-size-2xs);color:var(--text-muted);text-transform:uppercase;letter-spacing:0.08em;font-weight:600;margin-bottom:3px;">Notes</div>
        <div style="font-size:var(--font-size-sm);color:var(--text);white-space:pre-wrap;">${App.i18n.value(() => (U().esc(U().truncate(contact.notes, 220))))}</div>
      </div>` : ""))}
    `;

    const body = App.i18n.html`
      ${App.i18n.value(() => (info))}
      <form id="fuForm" novalidate>
        <div class="form-grid">
          <div class="form-field">
            <label for="fuType">Activity method <span class="req">*</span></label>
            <select id="fuType">${App.i18n.value(() => (s.settings.activityTypes.map(t => App.i18n.html`<option value="${App.i18n.value(() => (t))}">${App.i18n.value(() => (t))}</option>`).join("")))}</select>
          </div>
          <div class="form-field">
            <label for="fuDate">Date</label>
            <input type="date" id="fuDate" value="${App.i18n.value(() => (U().todayISO()))}">
          </div>
          <div class="form-field full">
            <label for="fuSubject">Subject <span class="req">*</span></label>
            <input type="text" id="fuSubject" placeholder="e.g. Follow-up call" required>
            <div class="err">Subject is required.</div>
          </div>
          <div class="form-field">
            <label for="fuOutcome">Outcome</label>
            <select id="fuOutcome"><option value="">—</option>${App.i18n.value(() => (["Positive","Neutral","Negative"].map(o => App.i18n.html`<option value="${App.i18n.value(() => (o))}">${App.i18n.value(() => (App.i18n.t(o)))}</option>`).join("")))}</select>
          </div>
          <div class="form-field">
            <label for="fuNext">Next follow-up</label>
            <select id="fuNext">
              <option value="tomorrow">Tomorrow</option>
              <option value="3days">In 3 days</option>
              <option value="1week" selected>In 1 week</option>
              <option value="custom">Custom date…</option>
              <option value="none">No next follow-up</option>
            </select>
          </div>
          <div class="form-field" id="fuCustomWrap" style="display:none;">
            <label for="fuCustomDate">Custom follow-up date <span class="req">*</span></label>
            <input type="date" id="fuCustomDate" value="${App.i18n.value(() => (U().addDaysISO(U().todayISO(), 7)))}">
            <div class="err">Pick a custom date.</div>
          </div>
          <div class="form-field full">
            <label for="fuNotes">Notes</label>
            <textarea id="fuNotes" rows="3"></textarea>
          </div>
        </div>
      </form>
    `;

    const handle = App.app.openModal({
      get title() { return App.i18n.t("Log Follow-up"); },
      wide: true,
      body,
      footer: App.i18n.markup(`
        <button class="btn" data-role="viewContact">View full contact</button>
        <button class="btn" data-role="cancel">Cancel</button>
        <button class="btn btn-primary" data-role="save">Save Follow-up</button>
      `),
      onOpen: (modal) => {
        const nextSel = modal.querySelector("#fuNext");
        const customWrap = modal.querySelector("#fuCustomWrap");
        // .form-field sets display:flex, so the plain `hidden` attribute
        // (UA display:none) would be silently overridden by that rule —
        // toggle inline style instead rather than adding a new global CSS
        // override for this one field.
        const syncCustomVisibility = () => { customWrap.style.display = nextSel.value === "custom" ? "flex" : "none"; };
        nextSel.addEventListener("change", syncCustomVisibility);

        modal.querySelector('[data-role="cancel"]').addEventListener("click", () => handle.close());
        modal.querySelector('[data-role="viewContact"]').addEventListener("click", () => {
          handle.close();
          App.app.navigate(`/contacts/${contact.id}`);
        });

        const saveBtn = modal.querySelector('[data-role="save"]');
        saveBtn.addEventListener("click", async () => {
          if (saveBtn.disabled) return; // guard against duplicate submission
          const subjectField = modal.querySelector("#fuSubject").closest(".form-field");
          subjectField.classList.remove("has-error");
          const subject = modal.querySelector("#fuSubject").value.trim();
          let valid = true;
          if (!subject) { subjectField.classList.add("has-error"); valid = false; }

          const nextChoice = nextSel.value;
          const customDate = modal.querySelector("#fuCustomDate").value;
          customWrap.classList.remove("has-error");
          if (nextChoice === "custom" && !customDate) { customWrap.classList.add("has-error"); valid = false; }
          if (!valid) return;

          saveBtn.disabled = true;

          const dateVal = modal.querySelector("#fuDate").value || U().todayISO();
          const activityDateISO = dateVal + "T" + new Date().toTimeString().slice(0,8);
          const today = U().todayISO();
          let nextFollowUp = null;
          if (nextChoice === "tomorrow") nextFollowUp = U().addDaysISO(today, 1);
          else if (nextChoice === "3days") nextFollowUp = U().addDaysISO(today, 3);
          else if (nextChoice === "1week") nextFollowUp = U().addDaysISO(today, 7);
          else if (nextChoice === "custom") nextFollowUp = customDate;

          const patch = {
            id: attemptId,
            type: modal.querySelector("#fuType").value,
            date: activityDateISO,
            subject,
            contactId: contact.id,
            outcome: modal.querySelector("#fuOutcome").value || "",
            notes: modal.querySelector("#fuNotes").value
          };

          try {
            await App.store.completeFollowUp(patch, contact.id, dateVal, nextFollowUp);
            App.app.toast(App.i18n.t("Follow-up logged."), "success");
            handle.close();
            App.app.route();
          } catch (err) {
            saveBtn.disabled = false;
            App.app.toast(App.i18n.t("Could not save follow-up: ") + err.message, "danger");
          }
        });
      }
    });
  }

  // "Import from file" — a one-time upload. Re-renders the list afterwards
  // if the user is still on it.
  function openFileImport() {
    if (!App.pages.leadFileImport) return;
    App.pages.leadFileImport.open({
      onImported: async () => {
        if (lastListContainer && lastListContainer.isConnected && lastListContainer.querySelector("#cTableWrap")) {
          const tabActions = document.getElementById("hubTabActions");
          const alreadyRelocated = !!(tabActions && tabActions.children.length > 0);
          await renderContactList(lastListContainer, pastClientsOnly);
          if (alreadyRelocated) {
            const hdr = lastListContainer.querySelector(".page-header");
            const actions = hdr && hdr.querySelector(".page-actions");
            if (actions) tabActions.replaceChildren(...actions.children);
            if (hdr) hdr.remove();
          }
        }
      }
    });
  }

  return {
    showUnassigned,
    renderList,
    renderPastClients,
    renderDetail,
    openFileImport,
    openContactModal,
    openActivityModal,
    openTaskModal,
    openShowingModal,
    openFollowUpModal
  };
})();

