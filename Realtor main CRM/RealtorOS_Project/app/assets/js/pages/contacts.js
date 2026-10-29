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
    if (!c.assignedToId) return `<span class="badge badge-neutral">Nobody yet</span>`;
    const name = memberNameById(c.assignedToId);
    const mine = App.workspace && App.workspace.teamMemberId() === c.assignedToId;
    return `${U().esc(name || "Someone who has left")}${mine ? ' <span class="badge badge-neutral">You</span>' : ""}`;
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
    return `<span class="badge ${cls}"><span class="dot"></span>${U().esc(temp)}</span>`;
  }
  function stagePill(stage) {
    return `<span class="stage-pill">${U().esc(stage || "—")}</span>`;
  }
  function followUpCell(contact) {
    const status = D().contactFollowUpStatus(contact);
    if (status.status === "none") return '<span style="color:var(--text-soft)">—</span>';
    const label = U().formatDate(contact.nextFollowUp);
    if (status.status === "overdue") return `<span class="badge badge-overdue">${status.daysOverdue} day${status.daysOverdue === 1 ? '' : 's'} overdue</span>`;
    if (status.status === "due-today") return `<span class="badge badge-today">Today</span>`;
    return `<span>${label}</span>`;
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
    App.app.setBreadcrumbs(pastOnly ? [{ label: "Contacts", route: "/contacts" }, { label: "Past Clients" }] : [{ label: "Contacts" }]);
    App.app.setTopActions("");
    container.innerHTML = App.app.loadingHtml();
    await S().ensureLoaded(["contacts"]);

    const s = S().getState();
    const settings = s.settings;

    container.innerHTML = `
      <div class="page-header">
        <div>
          <div class="page-title">${pastOnly ? "Past Clients" : "Contacts"}</div>
          <div class="page-desc">Your relationships — buyers, sellers, investors, and referral partners. Click any contact to see everything connected to them.</div>
        </div>
        <div class="page-actions">
          <button class="btn" id="importFileBtn" title="One-time upload from a file">Import from file</button>
          <button class="btn btn-primary" id="addContactBtn">${App.app.icon("plus")} Add Contact</button>
        </div>
      </div>

      <div class="filter-bar">
        <div class="search-wrap">
          ${App.app.icon("search")}
          <input type="search" id="cSearch" placeholder="Search name, email, or phone…" value="${U().esc(listFilters.search)}">
        </div>
        <select id="cRole" aria-label="Filter by role">
          <option value="">All roles</option>
          ${["Buyer","Seller","Investor","Referral Partner"].map(r =>
            `<option value="${r}" ${listFilters.role===r?"selected":""}>${r}</option>`).join("")}
        </select>
        <select id="cStage" aria-label="Filter by stage" ${pastOnly ? "disabled" : ""}>
          ${pastOnly ? '<option value="Past Client">Past Client</option>' : `
          <option value="">All stages</option>
          ${settings.contactStages.map(st =>
            `<option value="${st}" ${listFilters.stage===st?"selected":""}>${st}</option>`).join("")}
          `}
        </select>
        <!-- Source and Temperature are the two lowest-priority filters here, so
             they live behind "More filters" rather than on the main row: six
             controls is one more than the row fits at common widths. Their
             select ids are unchanged, so the change handlers below still bind
             to them exactly as before. -->
        <span class="filter-more">
          <button type="button" class="btn btn-sm filter-more-toggle" id="cMoreBtn"
                  aria-haspopup="true" aria-expanded="false" aria-controls="cMorePanel">
            More filters<span class="filter-more-count" id="cMoreCount" hidden></span>
          </button>
          <div class="filter-more-panel" id="cMorePanel" role="group" aria-label="Additional filters" hidden>
            <label class="filter-more-field">
              <span>Source</span>
              <select id="cSource" aria-label="Filter by source">
                <option value="">All sources</option>
                ${settings.leadSources.map(src =>
                  `<option value="${src}" ${listFilters.source===src?"selected":""}>${src}</option>`).join("")}
              </select>
            </label>
            <label class="filter-more-field">
              <span>Temperature</span>
              <select id="cTemp" aria-label="Filter by temperature">
                <option value="">All temperatures</option>
                ${["Hot","Warm","Cold"].map(t =>
                  `<option value="${t}" ${listFilters.temp===t?"selected":""}>${t}</option>`).join("")}
              </select>
            </label>
            <button type="button" class="btn btn-sm" id="cMoreClear">Clear these filters</button>
          </div>
        </span>
        ${showsOwners() ? `
        <select id="cOwner" aria-label="Filter by who owns the lead">
          <option value="" ${listFilters.owner === "" ? "selected" : ""}>All leads</option>
          <option value="mine" ${listFilters.owner === "mine" ? "selected" : ""}>My leads</option>
          <option value="unassigned" ${listFilters.owner === "unassigned" ? "selected" : ""}>Nobody owns yet</option>
        </select>` : ""}
        <select id="cSort" aria-label="Sort by">
          <option value="name-asc" ${listFilters.sort==="name-asc"?"selected":""}>Name (A–Z)</option>
          <option value="name-desc" ${listFilters.sort==="name-desc"?"selected":""}>Name (Z–A)</option>
          <option value="followup-asc" ${listFilters.sort==="followup-asc"?"selected":""}>Next Follow-up (soonest)</option>
          <option value="lastcontact-desc" ${listFilters.sort==="lastcontact-desc"?"selected":""}>Last Contact (newest)</option>
          <option value="created-desc" ${listFilters.sort==="created-desc"?"selected":""}>Created (newest)</option>
        </select>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title" id="cCountLabel">Loading…</div>
        </div>
        <div class="card-body zero" id="cTableWrap"></div>
      </div>
    `;

    // Wire up filter controls
    const rerender = () => renderTable();
    document.getElementById("cSearch").addEventListener("input", (e) => { listFilters.search = e.target.value; rerender(); });
    document.getElementById("cRole").addEventListener("change", (e) => { listFilters.role = e.target.value; rerender(); });
    document.getElementById("cStage").addEventListener("change", (e) => { listFilters.stage = e.target.value; rerender(); });
    document.getElementById("cSource").addEventListener("change", (e) => { listFilters.source = e.target.value; syncMoreCount(); rerender(); });
    document.getElementById("cTemp").addEventListener("change", (e) => { listFilters.temp = e.target.value; syncMoreCount(); rerender(); });
    wireMoreFilters();
    const ownerSel = document.getElementById("cOwner");
    if (ownerSel) ownerSel.addEventListener("change", (e) => {
      listFilters.owner = e.target.value;
      selectedIds = [];
      rerender();
    });
    document.getElementById("cSort").addEventListener("change", (e) => { listFilters.sort = e.target.value; rerender(); });
    document.getElementById("addContactBtn").addEventListener("click", () => openContactModal(null));
    document.getElementById("importFileBtn").addEventListener("click", openFileImport);

    renderTable();
  }

  // "More filters" popover. The badge exists so a filter the user can no
  // longer see on the row can still announce that it is narrowing the list —
  // a hidden active filter with no indicator reads as lost data.
  function syncMoreCount() {
    const badge = document.getElementById("cMoreCount");
    if (!badge) return;
    const n = (listFilters.source ? 1 : 0) + (listFilters.temp ? 1 : 0);
    badge.textContent = n ? String(n) : "";
    badge.hidden = n === 0;
    const btn = document.getElementById("cMoreBtn");
    if (btn) btn.classList.toggle("has-active", n > 0);
  }

  function closeMorePanel() {
    const panel = document.getElementById("cMorePanel");
    const btn = document.getElementById("cMoreBtn");
    if (panel) panel.hidden = true;
    if (btn) btn.setAttribute("aria-expanded", "false");
  }

  // Dismissal listeners are attached once per render to `document`, and are
  // removed again the moment the panel closes, so repeated renders of this
  // page never stack duplicates on document.
  function wireMoreFilters() {
    const btn = document.getElementById("cMoreBtn");
    const panel = document.getElementById("cMorePanel");
    const clear = document.getElementById("cMoreClear");
    if (!btn || !panel) return;

    const onDocClick = (ev) => { if (!ev.target.closest || !ev.target.closest(".filter-more")) { closeMorePanel(); detach(); } };
    const onKey = (ev) => { if (ev.key === "Escape") { closeMorePanel(); detach(); btn.focus(); } };
    function detach() {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
    }

    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const willOpen = panel.hidden;
      panel.hidden = !willOpen;
      btn.setAttribute("aria-expanded", String(willOpen));
      if (willOpen) {
        document.addEventListener("click", onDocClick);
        document.addEventListener("keydown", onKey);
      } else detach();
    });

    if (clear) clear.addEventListener("click", () => {
      listFilters.source = ""; listFilters.temp = "";
      const src = document.getElementById("cSource"); if (src) src.value = "";
      const tmp = document.getElementById("cTemp"); if (tmp) tmp.value = "";
      syncMoreCount();
      renderTable();
    });

    syncMoreCount();
  }

  // ---------- GIVING LEADS TO PEOPLE ----------

  function bulkBarHtml(count) {
    const members = assignableMembers();
    return `
      <div class="filter-bar" data-bulk-bar style="${count ? "" : "display:none"}">
        <strong data-bulk-count>${count} selected</strong>
        <select id="cBulkMember" aria-label="Give the selected leads to">
          <option value="">Choose a person…</option>
          <option value="__none__">Nobody — put them back in the pool</option>
          ${members.map(m => `<option value="${U().esc(m.id)}">${U().esc(m.name)}</option>`).join("")}
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
      if (countEl) countEl.textContent = selectedIds.length + " selected";
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
      if (!pick.value) { App.app.toast("Choose who the leads should go to.", "danger"); pick.focus(); return; }
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
          App.app.toast(ids.length + " lead" + (ids.length === 1 ? "" : "s") + " handed over.", "success");
        } else if (failures < ids.length) {
          App.app.toast((ids.length - failures) + " handed over, " + failures + " refused.", "danger");
        } else {
          App.app.toast("Could not hand these leads over.", "danger");
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
        if (!me) { App.app.toast("Your own team record is missing, so this cannot be claimed.", "danger"); return; }
        btn.disabled = true;
        try {
          await S().contacts.update(id, { assignedToId: me });
          App.app.toast("This lead is yours.", "success");
          renderTable();
        } catch (err) {
          btn.disabled = false;
          App.app.toast("Somebody else may have taken it. Refresh to see.", "danger");
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
    switch (f.sort) {
      case "name-desc":        out.sort((a,b) => (b.name||"").localeCompare(a.name||"")); break;
      case "followup-asc":     out.sort((a,b) => (a.nextFollowUp||"9999").localeCompare(b.nextFollowUp||"9999")); break;
      case "lastcontact-desc": out.sort((a,b) => (b.lastContact||"").localeCompare(a.lastContact||"")); break;
      case "created-desc":     out.sort((a,b) => (b.createdAt||"").localeCompare(a.createdAt||"")); break;
      default:                 out.sort((a,b) => (a.name||"").localeCompare(b.name||""));
    }
    return out;
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
    document.getElementById("cCountLabel").textContent =
      `${filtered.length} of ${all.length} contact${all.length === 1 ? "" : "s"}`;

    if (!filtered.length) {
      if (pastClientsOnly && all.length === 0) {
        wrap.innerHTML = `<div class="empty"><h3>No past clients yet</h3><p>Contacts with the Past Client stage appear here. Update a contact using the existing contact form.</p></div>`;
      } else if (all.length === 0) {
        wrap.innerHTML = `
          <div class="empty">
            <div class="empty-icon">${App.app.icon("plus")}</div>
            <h3>No contacts yet</h3>
            <p>Import leads from a file or Google Sheets, or add your first contact manually. Leads, past clients, and referral partners all belong here.</p>
            <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center">
              <button class="btn btn-primary" onclick="App.pages.contacts.openContactModal(null)">Add Your First Contact</button>
              <button class="btn btn-ghost" onclick="App.pages.contacts.openFileImport()">Import from file</button>
              <button class="btn btn-ghost" onclick="App.app.navigate('/settings/google-sheets')">Import from Google Sheets</button>
            </div>
          </div>`;
      } else {
        wrap.innerHTML = `
          <div class="empty">
            <h3>No matches</h3>
            <p>Try clearing filters or adjusting your search.</p>
          </div>`;
      }
      return;
    }

    wrap.innerHTML = `
      <div class="table-wrap">
        <table class="tbl tbl-responsive">
          <thead>
            <tr>
              ${assignAllowed ? `<th class="actions"><input type="checkbox" id="cSelectAll" aria-label="Select every lead shown"></th>` : ""}
              <th>Name</th>
              ${ownersShown ? `<th>Belongs to</th>` : ""}
              <th>Role</th>
              <th>Stage</th>
              <th>Temp</th>
              <th>Next Follow-up</th>
              <th>Source</th>
              <th>Phone</th>
              <th class="actions">&nbsp;</th>
            </tr>
          </thead>
          <tbody>
            ${filtered.map(c => `
              <tr class="clickable" data-id="${c.id}">
                ${assignAllowed ? `<td class="actions" data-label="">
                  <input type="checkbox" class="c-pick" data-pick="${c.id}"
                         ${selectedIds.indexOf(c.id) !== -1 ? "checked" : ""}
                         aria-label="Select ${U().esc(c.name || "this lead")}">
                </td>` : ""}
                <td data-label="Name" class="primary-cell">
                  <a href="#/contacts/${c.id}" class="link" data-nav-block>${U().esc(c.name || "(unnamed)")}</a>
                </td>
                ${ownersShown ? `<td data-label="Belongs to">${ownerCell(c)}</td>` : ""}
                <td data-label="Role">${U().esc(c.role || "—")}</td>
                <td data-label="Stage">${stagePill(c.stage)}</td>
                <td data-label="Temp">${tempBadge(c.temperature)}</td>
                <td data-label="Next Follow-up">${followUpCell(c)}</td>
                <td data-label="Source">${U().esc(c.source || "—")}</td>
                <td data-label="Phone">${U().esc(c.phone || "—")}</td>
                <td class="actions" data-label="">
                  ${(!c.assignedToId && claimAllowed) ? `<button class="btn btn-sm" data-claim="${c.id}">Claim</button>` : ""}
                  <button class="btn btn-sm btn-ghost" data-edit="${c.id}" aria-label="Edit ${U().esc(c.name)}">${App.app.icon("edit")}</button>
                </td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;

    if (assignAllowed) wireBulkBar(wrap, filtered);
    if (claimAllowed) wireClaim(wrap);

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
      App.app.setBreadcrumbs([{ label: "Contacts", route: "/contacts" }, { label: "Not Found" }]);
      container.innerHTML = `
        <div class="empty">
          <h3>Contact not found</h3>
          <p>This contact may have been deleted or the link is out of date.</p>
          <a href="#/contacts" class="btn btn-primary">Back to Contacts</a>
        </div>`;
      return;
    }

    App.app.setBreadcrumbs([
      { label: "Contacts", route: "/contacts" },
      { label: contact.name || "(unnamed)" }
    ]);
    App.app.setTopActions(`
      <button class="btn" id="editContactBtn">${App.app.icon("edit")} Edit</button>
      <button class="btn btn-danger" id="deleteContactBtn">${App.app.icon("trash")} Delete</button>
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
      followupNote = ` <span class="badge badge-overdue" style="margin-left:6px">${status.daysOverdue} day${status.daysOverdue === 1 ? '' : 's'} overdue</span>`;
    } else if (status.status === "due-today") {
      followupNote = `<span class="badge badge-today" style="margin-left:8px">Due today</span>`;
    } else if (status.status === "upcoming") {
      followupNote = `<span class="badge badge-upcoming" style="margin-left:8px">Upcoming</span>`;
    }

    container.innerHTML = `
      ${App.app.backLink("/contacts", "Contacts")}
      <div class="detail-grid">
        <div class="col">
          <div class="card">
            <div class="profile-hero">
              <div class="avatar">${U().esc(avatarInitials(contact.name))}</div>
              <div class="name">${U().esc(contact.name || "(unnamed)")}</div>
              <div class="subline">
                <span>${U().esc(contact.role || "—")}</span>
                <span>·</span>
                ${stagePill(contact.stage)}
                <span>·</span>
                ${tempBadge(contact.temperature)}
              </div>
            </div>

            <div class="card-body">
              <div class="meta">
                <div><div class="k">Email</div><div class="v">${U().esc(contact.email) || '<span style="color:var(--text-soft)">—</span>'}</div></div>
                <div><div class="k">Phone</div><div class="v">${U().esc(contact.phone) || '<span style="color:var(--text-soft)">—</span>'}</div></div>
                <div><div class="k">Last Contact</div><div class="v">${contact.lastContact ? U().formatDate(contact.lastContact) : '<span style="color:var(--text-soft)">—</span>'}</div></div>
                <div><div class="k">Next Follow-up</div><div class="v">${contact.nextFollowUp ? U().formatDate(contact.nextFollowUp) + followupNote : '<span style="color:var(--text-soft)">—</span>'}</div></div>
                <div><div class="k">Birthday</div><div class="v">${contact.birthday ? U().esc(U().formatDate(contact.birthday)) : '<span style="color:var(--text-soft)">—</span>'}</div></div>
                <div><div class="k">Home purchase</div><div class="v">${contact.homePurchaseDate ? U().esc(U().formatDate(contact.homePurchaseDate)) : '<span style="color:var(--text-soft)">—</span>'}</div></div>
                <div><div class="k">Budget</div><div class="v">${contact.budget ? U().formatCurrency(contact.budget, state.settings.currency) : '<span style="color:var(--text-soft)">—</span>'}</div></div>
                <div><div class="k">Preferred Area</div><div class="v">${U().esc(contact.preferredArea) || '<span style="color:var(--text-soft)">—</span>'}</div></div>
                <div><div class="k">Source</div><div class="v">${U().esc(contact.source) || '<span style="color:var(--text-soft)">—</span>'}</div></div>
                <div><div class="k">Assigned Agent</div><div class="v">${U().esc(contact.assignedAgent) || '<span style="color:var(--text-soft)">—</span>'}</div></div>
                ${showsOwners() ? `<div><div class="k">Belongs to</div><div class="v" id="cDetailOwner">${ownerControl(contact)}</div></div>` : ""}
              </div>
              ${contact.notes ? `
                <div style="margin-top: 18px; padding-top: 18px; border-top: 1px solid var(--border);">
                  <div class="k" style="font-size: var(--font-size-xs);color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:600;margin-bottom:6px;">Notes</div>
                  <div style="white-space:pre-wrap;">${U().esc(contact.notes)}</div>
                </div>` : ""}
            </div>
          </div>

          ${renderRelatedDealsCard(contact, relatedDeals, state)}
          ${renderRelatedPropertiesCard(contact, relatedProperties, state)}
          ${renderRelatedActivitiesCard(contact, relatedActivities)}
          ${renderRelatedShowingsCard(contact, relatedShowings, state)}
          ${renderReferralsCard(contact, relatedReferralsA, relatedReferralsB, state)}
        </div>

        <div class="col">
          <div class="card" id="contactOneTapCard">
            <div class="card-header"><div class="card-title">Contact them</div></div>
            <div class="card-body">
              ${App.followUp ? App.followUp.barHtml(contact) : ""}
              <p class="form-help" style="margin:8px 0 0">Opens your own phone or mail app. RealtorOS never sends these for you.</p>
            </div>
          </div>
          <div class="card">
            <div class="card-header"><div class="card-title">Quick Actions</div></div>
            <div class="card-body" style="display:flex;flex-direction:column;gap:8px;">
              <button class="btn btn-primary btn-block" id="quickAddDeal">${App.app.icon("plus")} Create Deal</button>
              <button class="btn btn-block" id="quickAddActivity">${App.app.icon("plus")} Log Activity</button>
              <button class="btn btn-block" id="quickAddTask">${App.app.icon("plus")} Add Task</button>
              <button class="btn btn-block" id="quickAddShowing">${App.app.icon("plus")} Schedule Showing</button>
              <button class="btn btn-block" id="quickAddProperty">${App.app.icon("plus")} Add Property</button>
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
                <div><div class="k" style="font-size: var(--font-size-xs);color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:600;">Related deals</div><div style="font-size: var(--font-size-xl);font-weight:700;">${relatedDeals.length}</div></div>
                <div><div class="k" style="font-size: var(--font-size-xs);color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:600;">Related properties</div><div style="font-size: var(--font-size-xl);font-weight:700;">${relatedProperties.length}</div></div>
                <div><div class="k" style="font-size: var(--font-size-xs);color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:600;">Total activities</div><div style="font-size: var(--font-size-xl);font-weight:700;">${relatedActivities.length}</div></div>
                <div><div class="k" style="font-size: var(--font-size-xs);color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;font-weight:600;">Open tasks</div><div style="font-size: var(--font-size-xl);font-weight:700;">${relatedTasks.filter(t => t.status !== "Completed").length}</div></div>
              </div>
            </div>
          </div>
          <!-- Tasks sits in the aside rather than the main column: it is a short
               checklist that reads fine at this width, and moving it evens out
               a 7-against-2 split that left most of this column empty. -->
          ${renderRelatedTasksCard(contact, relatedTasks)}
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
      return `<select id="cOwnerPick" aria-label="Who this lead belongs to">
        <option value="">Nobody yet</option>
        ${members.map(m => `<option value="${U().esc(m.id)}" ${contact.assignedToId === m.id ? "selected" : ""}>${U().esc(m.name)}</option>`).join("")}
      </select>`;
    }
    if (!contact.assignedToId && canClaim()) {
      return `${ownerCell(contact)} <button class="btn btn-sm" id="cOwnerClaim">Claim this lead</button>`;
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
          App.app.toast(next ? "Handed over to " + (memberNameById(next) || "them") + "." : "Back in the pool.", "success");
          await renderDetail(container, contact.id);
        } catch (err) {
          pick.value = before;
          pick.disabled = false;
          App.app.toast("Could not change who this belongs to.", "danger");
        }
      });
    }
    const claim = container.querySelector("#cOwnerClaim");
    if (claim) claim.addEventListener("click", async () => {
      const me = App.workspace ? App.workspace.teamMemberId() : null;
      if (!me) { App.app.toast("Your own team record is missing, so this cannot be claimed.", "danger"); return; }
      claim.disabled = true;
      try {
        await S().contacts.update(contact.id, { assignedToId: me });
        App.app.toast("This lead is yours.", "success");
        await renderDetail(container, contact.id);
      } catch (err) {
        claim.disabled = false;
        App.app.toast("Somebody else may have taken it. Refresh to see.", "danger");
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
      body.innerHTML = '<p class="form-help" style="margin:0">Email status could not be loaded right now.</p>';
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
      lines.push(`<span class="badge badge-neutral"><span class="dot"></span>Contact replied</span> <span class="form-help">on ${U().esc(shortDate(status.replyDetectedAt))}</span>`);
    }
    if (status.unsubscribeDetectedAt) {
      const how = Object.prototype.hasOwnProperty.call(UNSUBSCRIBE_HOW, status.optOutSource) ? UNSUBSCRIBE_HOW[status.optOutSource] + " " : "";
      lines.push(`<span class="badge badge-neutral"><span class="dot"></span>Contact unsubscribed</span> <span class="form-help">${U().esc(how)}on ${U().esc(shortDate(status.unsubscribeDetectedAt))}</span>`);
    }
    if (status.emailBlocked) {
      const why = Object.prototype.hasOwnProperty.call(BLOCK_REASON_LABELS, status.blockedReason) ? BLOCK_REASON_LABELS[status.blockedReason] : BLOCK_REASON_LABELS.manual;
      lines.push(`<span class="badge badge-warning"><span class="dot"></span>Email blocked</span> <span class="form-help">because ${U().esc(why)}.</span>`);
    } else if (status.emailOptedOut && !status.unsubscribeDetectedAt) {
      lines.push(`<span class="badge badge-warning"><span class="dot"></span>Email blocked</span> <span class="form-help">because the contact opted out of email.</span>`);
    }
    const summary = lines.length
      ? lines.map((l) => `<div>${l}</div>`).join("")
      : '<p class="form-help" style="margin:0">Follow-up emails can be sent to this contact.</p>';
    const actions = [];
    if (!status.replyDetectedAt) actions.push('<button type="button" class="btn btn-block" data-role="mark-replied">Mark as replied</button>');
    if (!status.unsubscribeDetectedAt) actions.push('<button type="button" class="btn btn-block" data-role="mark-unsubscribed">Mark as unsubscribed</button>');
    return `
      <div style="display:flex;flex-direction:column;gap:8px;">${summary}</div>
      ${actions.length ? `<div style="display:flex;flex-direction:column;gap:8px;margin-top:14px;">${actions.join("")}</div>` : ""}`;
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
        App.app.toast(isReply ? "Marked as replied." : "Marked as unsubscribed.", "success");
        await loadEmailStatusCard(contactId);
      } catch (err) {
        const code = err && err.code;
        const known = {
          try_again: "Something went wrong. Please try again.",
          contact_not_found: "This contact no longer exists.",
          request_ambiguous: "We couldn't confirm that was saved. Refresh the page to check before trying again."
        };
        App.app.toast(Object.prototype.hasOwnProperty.call(known, code) ? known[code] : "That couldn't be saved. Please try again.", "danger");
        button.disabled = false;
      }
    });
  }

  // ---------- RELATED-RECORD CARDS ----------

  function renderRelatedDealsCard(contact, deals, state) {
    return `
      <div class="card">
        <div class="card-header">
          <div class="card-title">Related Deals</div>
          <span class="badge badge-neutral">${deals.length}</span>
        </div>
        <div class="card-body zero">
          ${deals.length === 0 ? `
            <div class="empty" style="padding:var(--empty-padding)">
              <p>No deals for this contact yet.</p>
            </div>
          ` : deals.map(d => {
            const p = d.propertyId ? state.properties.find(x => x.id === d.propertyId) : null;
            const net = C().netGCI(d);
            const cur = state.settings.currency;
            return `
              <div class="item-row">
                <div class="icon-slot">${App.app.icon("dollar")}</div>
                <div class="body">
                  <div class="title">${U().esc(d.name)}</div>
                  <div class="sub">
                    ${U().esc(d.stage)} · ${U().esc(d.side)} side
                    ${p ? " · " + U().esc(p.address) : ""}
                    ${d.closeDate ? " · Close " + U().formatDate(d.closeDate) : ""}
                  </div>
                </div>
                <div class="meta-right">
                  <div style="font-weight:600;color:var(--text);">${U().formatCurrency(d.salePrice, cur)}</div>
                  <div style="font-size: var(--font-size-xs);">Net ${U().formatCurrency(net, cur)}</div>
                </div>
              </div>
            `;
          }).join("")}
        </div>
      </div>
    `;
  }

  function renderRelatedPropertiesCard(contact, properties, state) {
    return `
      <div class="card">
        <div class="card-header">
          <div class="card-title">Related Properties</div>
          <span class="badge badge-neutral">${properties.length}</span>
        </div>
        <div class="card-body zero">
          ${properties.length === 0 ? `
            <div class="empty" style="padding:var(--empty-padding)">
              <p>No properties linked to this contact.</p>
            </div>
          ` : properties.map(p => `
            <div class="item-row clickable" onclick="location.hash='#/properties/${p.id}'">
              <div class="icon-slot">${App.app.icon("home")}</div>
              <div class="body">
                <div class="title">${U().esc(p.address)} ${p.mls ? `<span style="font-size: var(--font-size-xs);color:var(--text-soft);font-weight:500;">${U().esc(p.mls)}</span>` : ""}</div>
                <div class="sub">
                  ${U().esc(p.status)}
                  ${p.beds ? " · " + p.beds + "bd" : ""}${p.baths ? "/" + p.baths + "ba" : ""}
                  ${p.sqft ? " · " + p.sqft.toLocaleString() + " sqft" : ""}
                </div>
              </div>
              <div class="meta-right">
                <div style="font-weight:600;color:var(--text);">${p.listPrice ? U().formatCurrency(p.listPrice, state.settings.currency) : "—"}</div>
              </div>
            </div>
          `).join("")}
        </div>
      </div>
    `;
  }

  function renderRelatedActivitiesCard(contact, activities) {
    return `
      <div class="card">
        <div class="card-header">
          <div class="card-title">Activity Timeline</div>
          <span class="badge badge-neutral">${activities.length}</span>
        </div>
        <div class="card-body zero">
          ${activities.length === 0 ? `
            <div class="empty" style="padding:var(--empty-padding)">
              <p>No activities logged yet. Use "Log Activity" to record calls, emails, meetings, and notes.</p>
            </div>
          ` : activities.slice(0, 10).map(a => `
            <div class="item-row">
              <div class="icon-slot">${activityIcon(a.type)}</div>
              <div class="body">
                <div class="title">${U().esc(a.subject || a.type)} <span style="font-weight:500;color:var(--text-muted);font-size: var(--font-size-xs);">· ${U().esc(a.type)}</span></div>
                ${a.notes ? `<div class="sub">${U().esc(U().truncate(a.notes, 120))}</div>` : ""}
              </div>
              <div class="meta-right">${a.date ? U().relativeDayLabel(a.date.slice(0,10)) : "—"}</div>
            </div>
          `).join("")}
        </div>
      </div>
    `;
  }

  function renderRelatedShowingsCard(contact, showings, state) {
    return `
      <div class="card">
        <div class="card-header">
          <div class="card-title">Showings</div>
          <span class="badge badge-neutral">${showings.length}</span>
        </div>
        <div class="card-body zero">
          ${showings.length === 0 ? `
            <div class="empty" style="padding:var(--empty-padding)">
              <p>No showings scheduled.</p>
            </div>
          ` : showings.map(sh => {
            const p = sh.propertyId ? state.properties.find(x => x.id === sh.propertyId) : null;
            return `
              <div class="item-row">
                <div class="icon-slot">${App.app.icon("home")}</div>
                <div class="body">
                  <div class="title">${p ? U().esc(p.address) : "Property removed"}</div>
                  <div class="sub">${U().formatDate(sh.date)} · ${U().esc(sh.startTime || "")} · ${U().esc(sh.status)}</div>
                </div>
              </div>
            `;
          }).join("")}
        </div>
      </div>
    `;
  }

  function renderRelatedTasksCard(contact, tasks) {
    const open = tasks.filter(t => t.status !== "Completed");
    const done = tasks.filter(t => t.status === "Completed");
    return `
      <div class="card">
        <div class="card-header">
          <div class="card-title">Tasks</div>
          <span class="badge badge-neutral">${open.length} open · ${done.length} done</span>
        </div>
        <div class="card-body zero">
          ${tasks.length === 0 ? `
            <div class="empty" style="padding:var(--empty-padding)">
              <p>No tasks yet.</p>
            </div>
          ` : tasks.map(t => {
            const overdue = t.dueDate && t.dueDate < U().todayISO() && t.status !== "Completed";
            return `
              <div class="item-row">
                <div class="icon-slot" style="background:${t.status === "Completed" ? "var(--success-soft)" : "var(--accent-soft)"};color:${t.status === "Completed" ? "var(--success)" : "var(--accent)"};">
                  ${App.app.icon("check")}
                </div>
                <div class="body">
                  <div class="title" style="${t.status === "Completed" ? "text-decoration:line-through;color:var(--text-muted);" : ""}">${U().esc(t.title)}</div>
                  <div class="sub">
                    ${U().esc(t.priority)} priority · ${U().esc(t.status)}
                    ${t.dueDate ? " · Due " + U().formatDate(t.dueDate) : ""}
                    ${overdue ? ' <span class="badge badge-overdue">Overdue</span>' : ""}
                  </div>
                </div>
              </div>
            `;
          }).join("")}
        </div>
      </div>
    `;
  }

  function renderReferralsCard(contact, referralsFromThem, referralsAboutThem, state) {
    const total = referralsFromThem.length + referralsAboutThem.length;
    if (total === 0) return "";
    return `
      <div class="card">
        <div class="card-header">
          <div class="card-title">Referrals</div>
          <span class="badge badge-neutral">${total}</span>
        </div>
        <div class="card-body zero">
          ${referralsFromThem.map(r => {
            const to = state.contacts.find(x => x.id === r.referredContactId);
            return `
              <div class="item-row">
                <div class="icon-slot">${App.app.icon("share")}</div>
                <div class="body">
                  <div class="title">Referred ${to ? U().esc(to.name) : "someone"}</div>
                  <div class="sub">${U().formatDate(r.date)} · ${U().esc(r.status)}</div>
                </div>
              </div>
            `;
          }).join("")}
          ${referralsAboutThem.map(r => {
            const from = state.contacts.find(x => x.id === r.referrerId);
            return `
              <div class="item-row">
                <div class="icon-slot">${App.app.icon("share")}</div>
                <div class="body">
                  <div class="title">Referred by ${from ? U().esc(from.name) : "someone"}</div>
                  <div class="sub">${U().formatDate(r.date)} · ${U().esc(r.status)}</div>
                </div>
              </div>
            `;
          }).join("")}
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
    if (editing && !existing) { App.app.toast("Contact not found.", "danger"); return; }

    const s = S().getState();
    const c = existing || {
      name: "", role: "Buyer", email: "", phone: "",
      stage: s.settings.contactStages[0], source: "Referral", temperature: "Warm",
      lastContact: null, nextFollowUp: null, birthday: null, homePurchaseDate: null,
      budget: 0, preferredArea: "", assignedAgent: "Self", notes: ""
    };

    const body = `
      <form id="contactForm" novalidate>
        <div class="form-grid">
          <div class="form-field full">
            <label for="fName">Name <span class="req">*</span></label>
            <input type="text" id="fName" value="${U().esc(c.name)}" required autofocus>
            <div class="err">Name is required.</div>
          </div>
          <div class="form-field">
            <label for="fRole">Role <span class="req">*</span></label>
            <select id="fRole" required>
              ${["Buyer","Seller","Investor","Referral Partner"].map(r =>
                `<option value="${r}" ${c.role===r?"selected":""}>${r}</option>`).join("")}
            </select>
          </div>
          <div class="form-field">
            <label for="fStage">Stage</label>
            <select id="fStage">
              ${s.settings.contactStages.map(st =>
                `<option value="${st}" ${c.stage===st?"selected":""}>${st}</option>`).join("")}
            </select>
          </div>
          <div class="form-field">
            <label for="fEmail">Email</label>
            <input type="email" id="fEmail" value="${U().esc(c.email)}">
            <div class="err">Please enter a valid email address.</div>
          </div>
          <div class="form-field">
            <label for="fPhone">Phone</label>
            <input type="tel" id="fPhone" value="${U().esc(c.phone)}">
          </div>
          <div class="form-field">
            <label for="fSource">Source</label>
            <select id="fSource">
              ${s.settings.leadSources.map(src =>
                `<option value="${src}" ${c.source===src?"selected":""}>${src}</option>`).join("")}
            </select>
          </div>
          <div class="form-field">
            <label for="fTemp">Temperature</label>
            <select id="fTemp">
              ${["Hot","Warm","Cold"].map(t =>
                `<option value="${t}" ${c.temperature===t?"selected":""}>${t}</option>`).join("")}
            </select>
          </div>
          <div class="form-field">
            <label for="fLast">Last Contact</label>
            <input type="date" id="fLast" value="${c.lastContact || ""}">
          </div>
          <div class="form-field">
            <label for="fNext">Next Follow-up</label>
            <input type="date" id="fNext" value="${c.nextFollowUp || ""}">
          </div>
          <div class="form-field">
            <label for="fBirthday">Birthday</label>
            <input type="date" id="fBirthday" value="${c.birthday || ""}">
            <p class="form-help">Only the day and month are used, so an unknown year is fine.</p>
          </div>
          <div class="form-field">
            <label for="fHomePurchase">Home purchase date</label>
            <input type="date" id="fHomePurchase" value="${c.homePurchaseDate || ""}">
            <p class="form-help">Filled in for you when a deal is marked won, if it is still empty.</p>
          </div>
          <div class="form-field">
            <label for="fBudget">Budget (${U().currencySymbol(s.settings.currency)})</label>
            <input type="number" id="fBudget" value="${c.budget || 0}" min="0" step="1000">
          </div>
          <div class="form-field">
            <label for="fArea">Preferred Area</label>
            <input type="text" id="fArea" value="${U().esc(c.preferredArea)}">
          </div>
          <div class="form-field full">
            <label for="fNotes">Notes</label>
            <textarea id="fNotes" rows="4">${U().esc(c.notes)}</textarea>
          </div>
        </div>
        ${App.customFieldsUI.renderSection("contact", editing ? id : null)}
      </form>
    `;

    const handle = App.app.openModal({
      title: editing ? "Edit Contact" : "Add Contact",
      body,
      footer: `
        <button class="btn" data-role="cancel">Cancel</button>
        <button class="btn btn-primary" data-role="save">${editing ? "Save Changes" : "Add Contact"}</button>
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
      App.app.toast(`${missingCustom.join(", ")} ${missingCustom.length === 1 ? "is" : "are"} required.`, "danger");
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
        App.app.toast("Contact updated.", "success");
      } else {
        const c = await S().contacts.create(patch);
        savedId = c.id;
        App.app.toast(`Added ${c.name}.`, "success");
      }
      await S().customFields.setValues("contact", savedId, customValues);
      handle.close();
      App.app.route();
    } catch (err) {
      App.app.toast("Could not save contact: " + err.message, "danger");
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  async function openDeleteContactConfirm(id) {
    await S().ensureLoaded(["contacts"]);
    const contact = S().getState().contacts.find(c => c.id === id);
    if (!contact) { App.app.toast("Contact not found.", "danger"); return; }
    let preview;
    try {
      preview = await S().contacts.delete(id); // returns needsConfirmation payload
    } catch (err) {
      App.app.toast("Could not check related records: " + err.message, "danger");
      return;
    }
    App.app.confirmDialog({
      title: "Delete Contact?",
      message: `This will permanently remove <strong>${U().esc(contact.name)}</strong> from your CRM.`,
      impact: preview.impact,
      okLabel: "Delete Contact",
      danger: true
    }, async () => {
      try {
        const result = await S().contacts.delete(id, { force: true });
        if (result.deleted) {
          App.app.toast("Contact deleted.", "success");
          App.app.navigate("/contacts");
        } else {
          App.app.toast("Delete failed.", "danger");
        }
      } catch (err) {
        App.app.toast("Delete failed: " + err.message, "danger");
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
    const body = `
      <form id="showForm" novalidate>
        <div class="form-grid">
          <div class="form-field">
            <label for="sDate">Date <span class="req">*</span></label>
            <input type="date" id="sDate" value="${prefill.date || U().todayISO()}" required>
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
              ${state.contacts.slice().sort((a,b) => a.name.localeCompare(b.name)).map(c =>
                `<option value="${c.id}" ${prefill.contactId===c.id?"selected":""}>${U().esc(c.name)}</option>`).join("")}
            </select>
            <div class="err">Contact is required.</div>
          </div>
          <div class="form-field">
            <label for="sProperty">Property <span class="req">*</span></label>
            <select id="sProperty" required>
              <option value="">— select —</option>
              ${state.properties.map(p =>
                `<option value="${p.id}" ${prefill.propertyId===p.id?"selected":""}>${U().esc(p.address)}</option>`).join("")}
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
      title: "Schedule Showing",
      body,
      footer: `
        <button class="btn" data-role="cancel">Cancel</button>
        <button class="btn btn-primary" data-role="save">Add Showing</button>
      `,
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
            App.app.toast("Showing scheduled.", "success");
            handle.close();
            App.app.route();
          } catch (err) {
            App.app.toast("Could not save showing: " + err.message, "danger");
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
    if (!contact) { App.app.toast("This contact no longer exists.", "danger"); return; }

    const s = S().getState();
    const status = D().contactFollowUpStatus(contact);
    const statusBadge = status.status === "overdue" ? `<span class="badge badge-overdue">${status.daysOverdue} day${status.daysOverdue === 1 ? '' : 's'} overdue</span>`
      : status.status === "due-today" ? `<span class="badge badge-today">Due today</span>`
      : followUpCell(contact);

    const info = `
      <div class="meta" style="margin-bottom:18px;">
        <div><div class="k">Contact</div><div class="v">${U().esc(contact.name || "(unnamed)")}</div></div>
        <div><div class="k">Follow-up status</div><div class="v">${statusBadge}</div></div>
        <div><div class="k">Role</div><div class="v">${U().esc(contact.role || "—")}</div></div>
        <div><div class="k">Stage</div><div class="v">${stagePill(contact.stage)}</div></div>
        <div><div class="k">Temperature</div><div class="v">${tempBadge(contact.temperature)}</div></div>
        <div><div class="k">Phone</div><div class="v">${contact.phone ? U().esc(contact.phone) : '<span style="color:var(--text-soft)">—</span>'}</div></div>
        <div><div class="k">Email</div><div class="v">${contact.email ? U().esc(contact.email) : '<span style="color:var(--text-soft)">—</span>'}</div></div>
        <div><div class="k">Last contact</div><div class="v">${contact.lastContact ? U().formatDate(contact.lastContact) : '<span style="color:var(--text-soft)">—</span>'}</div></div>
        <div><div class="k">Current follow-up date</div><div class="v">${contact.nextFollowUp ? U().formatDate(contact.nextFollowUp) : '<span style="color:var(--text-soft)">—</span>'}</div></div>
        ${contact.preferredArea ? `<div><div class="k">Preferred area</div><div class="v">${U().esc(contact.preferredArea)}</div></div>` : ""}
      </div>
      ${contact.notes ? `<div style="margin-bottom:18px;padding:10px 12px;background:var(--surface-sunk);border-radius:var(--radius-sm);">
        <div style="font-size:var(--font-size-2xs);color:var(--text-muted);text-transform:uppercase;letter-spacing:0.08em;font-weight:600;margin-bottom:3px;">Notes</div>
        <div style="font-size:var(--font-size-sm);color:var(--text);white-space:pre-wrap;">${U().esc(U().truncate(contact.notes, 220))}</div>
      </div>` : ""}
    `;

    const body = `
      ${info}
      <form id="fuForm" novalidate>
        <div class="form-grid">
          <div class="form-field">
            <label for="fuType">Activity method <span class="req">*</span></label>
            <select id="fuType">${s.settings.activityTypes.map(t => `<option value="${t}">${t}</option>`).join("")}</select>
          </div>
          <div class="form-field">
            <label for="fuDate">Date</label>
            <input type="date" id="fuDate" value="${U().todayISO()}">
          </div>
          <div class="form-field full">
            <label for="fuSubject">Subject <span class="req">*</span></label>
            <input type="text" id="fuSubject" placeholder="e.g. Follow-up call" required>
            <div class="err">Subject is required.</div>
          </div>
          <div class="form-field">
            <label for="fuOutcome">Outcome</label>
            <select id="fuOutcome"><option value="">—</option>${["Positive","Neutral","Negative"].map(o => `<option value="${o}">${o}</option>`).join("")}</select>
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
            <input type="date" id="fuCustomDate" value="${U().addDaysISO(U().todayISO(), 7)}">
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
      title: "Log Follow-up",
      wide: true,
      body,
      footer: `
        <button class="btn" data-role="viewContact">View full contact</button>
        <button class="btn" data-role="cancel">Cancel</button>
        <button class="btn btn-primary" data-role="save">Save Follow-up</button>
      `,
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
            type: modal.querySelector("#fuType").value,
            date: activityDateISO,
            subject,
            contactId: contact.id,
            outcome: modal.querySelector("#fuOutcome").value || "",
            notes: modal.querySelector("#fuNotes").value
          };

          try {
            await App.store.completeFollowUp(patch, contact.id, dateVal, nextFollowUp);
            App.app.toast("Follow-up logged.", "success");
            handle.close();
            App.app.route();
          } catch (err) {
            saveBtn.disabled = false;
            App.app.toast("Could not save follow-up: " + err.message, "danger");
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
      onImported: () => {
        if (lastListContainer && lastListContainer.isConnected && lastListContainer.querySelector("#importFileBtn")) {
          renderContactList(lastListContainer, pastClientsOnly);
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

