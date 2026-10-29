/* ============================================================
   activities-page.js — Activities module: timeline, CRUD, filters.
   Uses existing store.activities. No new data structures.
   ============================================================ */

window.App = window.App || {};
App.pages = App.pages || {};

App.pages.activities = (function () {
  "use strict";

  const U = () => App.util;
  const S = () => App.store;

  let filters = { search: "", type: "", contactId: "", dealId: "", sort: "date-desc" };

  function actIcon(type) {
    const t = String(type).toLowerCase();
    if (t.includes("call")) return "📞";
    if (t.includes("text")) return "💬";
    if (t.includes("email")) return "✉️";
    if (t.includes("meet")) return "🤝";
    return "📝";
  }
  function outcomeBadge(o) {
    if (!o) return "";
    const cls = o === "Positive" ? "badge-success" : o === "Negative" ? "badge-danger" : "badge-neutral";
    return `<span class="badge ${cls}">${U().esc(o)}</span>`;
  }
  // ---------- LIST PAGE ----------

  async function render(container) {
    App.app.setBreadcrumbs([{ label: "Activities" }]);
    App.app.setTopActions("");
    container.innerHTML = App.app.loadingHtml();
    await S().ensureLoaded(["activities", "contacts", "deals"]);

    const s = S().getState();
    const contacts = s.contacts.slice().sort((a,b) => a.name.localeCompare(b.name));
    const deals = s.deals.slice().sort((a,b) => (a.name||"").localeCompare(b.name||""));

    container.innerHTML = `
      <div class="page-header">
        <div>
          <div class="page-title">Activities</div>
          <div class="page-desc">Every call, email, text, meeting, and note across your business — searchable and filterable.</div>
        </div>
        <div class="page-actions">
          <button class="btn btn-primary" id="addActBtn">${App.app.icon("plus")} Log Activity</button>
        </div>
      </div>
      <div class="filter-bar">
        <div class="search-wrap">
          ${App.app.icon("search")}
          <input type="search" id="aSearch" placeholder="Search subject or notes…" value="${U().esc(filters.search)}">
        </div>
        <select id="aType" aria-label="Type">
          <option value="">All types</option>
          ${s.settings.activityTypes.map(t => `<option value="${t}" ${filters.type===t?"selected":""}>${t}</option>`).join("")}
        </select>
        <select id="aContact" aria-label="Contact">
          <option value="">All contacts</option>
          ${contacts.map(c => `<option value="${c.id}" ${filters.contactId===c.id?"selected":""}>${U().esc(c.name)}</option>`).join("")}
        </select>
        <select id="aDeal" aria-label="Deal">
          <option value="">All deals</option>
          ${deals.map(d => `<option value="${d.id}" ${filters.dealId===d.id?"selected":""}>${U().esc(d.name)}</option>`).join("")}
        </select>
        <select id="aSort" aria-label="Sort">
          <option value="date-desc" ${filters.sort==="date-desc"?"selected":""}>Newest first</option>
          <option value="date-asc" ${filters.sort==="date-asc"?"selected":""}>Oldest first</option>
        </select>
      </div>
      <div class="card">
        <div class="card-header"><div class="card-title" id="aCount">Loading…</div></div>
        <div class="card-body zero" id="aListWrap"></div>
      </div>
    `;

    const rr = () => renderList();
    document.getElementById("aSearch").addEventListener("input", e => { filters.search = e.target.value; rr(); });
    document.getElementById("aType").addEventListener("change", e => { filters.type = e.target.value; rr(); });
    document.getElementById("aContact").addEventListener("change", e => { filters.contactId = e.target.value; rr(); });
    document.getElementById("aDeal").addEventListener("change", e => { filters.dealId = e.target.value; rr(); });
    document.getElementById("aSort").addEventListener("change", e => { filters.sort = e.target.value; rr(); });
    document.getElementById("addActBtn").addEventListener("click", () => openActivityModal(null));
    renderList();
  }

  function renderList() {
    const state = S().getState();
    const all = state.activities;
    let out = all.slice();
    const f = filters;
    if (f.search) {
      const q = f.search.toLowerCase();
      out = out.filter(a => (a.subject||"").toLowerCase().includes(q) || (a.notes||"").toLowerCase().includes(q));
    }
    if (f.type) out = out.filter(a => a.type === f.type);
    if (f.contactId) out = out.filter(a => a.contactId === f.contactId);
    if (f.dealId) out = out.filter(a => a.dealId === f.dealId);
    out.sort((a,b) => f.sort === "date-asc" ? (a.date||"").localeCompare(b.date||"") : (b.date||"").localeCompare(a.date||""));

    document.getElementById("aCount").textContent = `${out.length} of ${all.length} activit${all.length===1?"y":"ies"}`;
    const wrap = document.getElementById("aListWrap");

    if (!out.length) {
      wrap.innerHTML = all.length === 0
        ? `<div class="empty"><div class="empty-icon">${App.app.icon("plus")}</div><h3>No activities logged yet</h3><p>Log your first call, email, meeting, or note. Activities are also created automatically when an automation sequence sends an email.</p><button class="btn btn-primary" onclick="App.pages.activities.openActivityModal(null)">Log Activity</button></div>`
        : `<div class="empty"><h3>No matches</h3><p>Adjust your filters.</p></div>`;
      return;
    }

    wrap.innerHTML = out.map(a => {
      const c = a.contactId ? state.contacts.find(x => x.id === a.contactId) : null;
      const d = a.dealId ? state.deals.find(x => x.id === a.dealId) : null;
      return `
        <div class="item-row clickable" data-act-id="${a.id}">
          <div class="icon-slot">${actIcon(a.type)}</div>
          <div class="body">
            <div class="title">${U().esc(a.subject || a.type)} ${outcomeBadge(a.outcome)}</div>
            <div class="sub">
              ${U().esc(a.type)}
              ${c ? ' · <a class="link" href="#/contacts/'+c.id+'" onclick="event.stopPropagation()">'+U().esc(c.name)+'</a>' : ""}
              ${d ? ' · <a class="link" href="#/pipeline/'+d.id+'" onclick="event.stopPropagation()">'+U().esc(d.name)+'</a>' : ""}
              ${a.notes ? " · " + U().esc(U().truncate(a.notes, 80)) : ""}
            </div>
          </div>
          <div class="meta-right">
            ${a.date ? U().relativeDayLabel(a.date.slice(0,10)) : "—"}
            <div style="font-size: var(--font-size-xs);color:var(--text-soft)">${a.date ? a.date.slice(11,16) : ""}</div>
          </div>
        </div>
      `;
    }).join("");

    wrap.querySelectorAll("[data-act-id]").forEach(el => {
      el.addEventListener("click", () => openActivityModal(el.getAttribute("data-act-id")));
    });
  }

  // ---------- ADD / EDIT MODAL ----------

  // prefill (create only, ignored when editing) lets a quick-add shortcut
  // elsewhere — Contact/Property/Deal detail pages — pre-associate the new
  // activity with a contact. See App.pages.contacts.openActivityModal, the
  // single shared entry point every one of those shortcuts calls.
  async function openActivityModal(id, prefill) {
    const editing = !!id;
    await S().ensureLoaded(["activities", "contacts", "deals"]);
    const state = S().getState();
    const existing = editing ? state.activities.find(x => x.id === id) : null;
    if (editing && !existing) { App.app.toast("Activity not found.", "danger"); return; }

    const s = state;
    const defaults = { type: "Call", date: U().todayISO(), subject: "", contactId: null, dealId: null, outcome: "", notes: "" };
    const a = existing || Object.assign({}, defaults, prefill || {});
    const dateVal = a.date ? a.date.slice(0,10) : U().todayISO();
    const timeVal = a.date && a.date.length > 10 ? a.date.slice(11,16) : new Date().toTimeString().slice(0,5);

    const contacts = state.contacts.slice().sort((x,y) => x.name.localeCompare(y.name));
    const deals = state.deals.slice().sort((x,y) => (x.name||"").localeCompare(y.name||""));

    const body = `
      <form id="actForm" novalidate>
        <div class="form-grid">
          <div class="form-field">
            <label for="afType">Type <span class="req">*</span></label>
            <select id="afType">${s.settings.activityTypes.map(t => `<option value="${t}" ${a.type===t?"selected":""}>${t}</option>`).join("")}</select>
          </div>
          <div class="form-field">
            <label for="afOutcome">Outcome</label>
            <select id="afOutcome"><option value="">—</option>${["Positive","Neutral","Negative"].map(o => `<option value="${o}" ${a.outcome===o?"selected":""}>${o}</option>`).join("")}</select>
          </div>
          <div class="form-field full">
            <label for="afSubject">Subject <span class="req">*</span></label>
            <input type="text" id="afSubject" value="${U().esc(a.subject)}" required>
            <div class="err">Subject is required.</div>
          </div>
          <div class="form-field">
            <label for="afDate">Date</label>
            <input type="date" id="afDate" value="${dateVal}">
          </div>
          <div class="form-field">
            <label for="afTime">Time</label>
            <input type="time" id="afTime" value="${timeVal}">
          </div>
          <div class="form-field">
            <label for="afContact">Contact</label>
            <select id="afContact"><option value="">— none —</option>${contacts.map(c => `<option value="${c.id}" ${a.contactId===c.id?"selected":""}>${U().esc(c.name)}</option>`).join("")}</select>
          </div>
          <div class="form-field">
            <label for="afDeal">Deal</label>
            <select id="afDeal"><option value="">— none —</option>${deals.map(d => `<option value="${d.id}" ${a.dealId===d.id?"selected":""}>${U().esc(d.name)}</option>`).join("")}</select>
          </div>
          <div class="form-field full">
            <label for="afNotes">Notes</label>
            <textarea id="afNotes" rows="4">${U().esc(a.notes)}</textarea>
          </div>
        </div>
      </form>
    `;

    const footer = `
      ${editing ? '<button class="btn btn-danger" data-role="delete">Delete</button>' : ''}
      <button class="btn" data-role="cancel">Cancel</button>
      <button class="btn btn-primary" data-role="save">${editing ? "Save" : "Log Activity"}</button>
    `;

    const handle = App.app.openModal({
      title: editing ? "Edit Activity" : "Log Activity",
      body, footer,
      onOpen: (modal) => {
        modal.querySelector('[data-role="cancel"]').addEventListener("click", () => handle.close());
        modal.querySelector('[data-role="save"]').addEventListener("click", async () => {
          const subField = document.getElementById("afSubject").closest(".form-field");
          subField.classList.remove("has-error");
          const subject = document.getElementById("afSubject").value.trim();
          if (!subject) { subField.classList.add("has-error"); return; }

          const d = document.getElementById("afDate").value;
          const t = document.getElementById("afTime").value;
          const dateISO = d ? d + "T" + (t || "12:00") + ":00" : U().nowISO();

          const patch = {
            type: document.getElementById("afType").value,
            date: dateISO,
            subject,
            contactId: document.getElementById("afContact").value || null,
            dealId: document.getElementById("afDeal").value || null,
            outcome: document.getElementById("afOutcome").value || "",
            notes: document.getElementById("afNotes").value
          };

          const saveBtn = modal.querySelector('[data-role="save"]');
          saveBtn.disabled = true;
          try {
            if (editing) { await S().activities.update(id, patch); App.app.toast("Activity updated.", "success"); }
            else { await S().activities.create(patch); App.app.toast("Activity logged.", "success"); }
            handle.close();
            App.app.route();
          } catch (err) {
            App.app.toast("Could not save activity: " + err.message, "danger");
            saveBtn.disabled = false;
          }
        });
        const delBtn = modal.querySelector('[data-role="delete"]');
        if (delBtn) delBtn.addEventListener("click", () => {
          App.app.confirmDialog({ title: "Delete Activity?", message: "This will permanently delete this activity log.", okLabel: "Delete", danger: true }, async () => {
            try {
              await S().activities.delete(id);
              App.app.toast("Activity deleted.", "success");
              handle.close();
              App.app.route();
            } catch (err) {
              App.app.toast("Could not delete activity: " + err.message, "danger");
            }
          });
        });
      }
    });
  }

  return { render, openActivityModal };
})();

