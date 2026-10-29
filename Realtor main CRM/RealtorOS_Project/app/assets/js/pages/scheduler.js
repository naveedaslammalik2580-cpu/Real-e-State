/* ============================================================
   scheduler.js — Scheduler page.
   Schedule a follow-up from a Script (legacy library) or an active Email
   Template, with a date/time. Stores scheduled items in the main
   App.store scheduledItems collection, so they are included in JSON
   export/import backups.

   Phase 4B: an Email Template may be picked here to help create a manual
   scheduled reminder — this only prefills the item's title, type, and a
   non-secret note (the template's name). Nothing is sent automatically:
   the user still picks the date/time, saves manually, and later performs
   and completes the action manually. The chosen template's id is never
   written to `script_id` (that column is a foreign key into the legacy
   `scripts` table, not message_templates) and no other column is
   repurposed as a hidden template reference — the template is only ever
   captured as a plain-text snapshot (title/notes), matching the current
   scheduled_items schema without any migration.
   ============================================================ */
window.App = window.App || {};
App.pages = App.pages || {};
App.pages.scheduler = (function () {
  "use strict";
  const S = () => App.store;
  const U = () => App.util;
  function loadSchedule() {
    return S().getState().scheduledItems;
  }

  async function render(container) {
    App.app.setBreadcrumbs([{ label: "Scheduler" }]);
    App.app.setTopActions("");
    container.innerHTML = App.app.loadingHtml();
    await S().ensureLoaded(["scheduledItems", "scripts", "teamMembers"]);

    // A failed templates query must never be read as "zero templates" —
    // Scripts and existing scheduled items still render either way, but
    // the two states (genuine empty vs. failed load) are shown distinctly
    // below, with an escaped, retryable warning for the failure case.
    let templates = [];
    let templatesError = null;
    try { templates = await S().messageTemplates.list({ activeOnly: true, orderBy: "name" }); }
    catch (err) { templatesError = (err && err.message) ? err.message : "Unknown error"; }

    const schedule = loadSchedule().slice().sort((a,b) => new Date(a.dateTime) - new Date(b.dateTime));
    const scripts = S().getState().scripts;
    const now = new Date();

    const upcoming = schedule.filter(s => new Date(s.dateTime) >= now);
    const past = schedule.filter(s => new Date(s.dateTime) < now);

    function scheduleRow(item, isPast) {
      const isEmail = item.type === "email";
      const script = !isEmail ? scripts.find(s => s.id === item.scriptId) : null;
      const displayTitle = isEmail ? (item.title || "Email") : (script ? script.title : (item.scriptTitle || item.title || "Unknown script"));
      const dt = new Date(item.dateTime);
      const dateStr = dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      const timeStr = dt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      const statusBadge = isPast
        ? (item.completed ? '<span class="badge badge-success">Done</span>' : '<span class="badge badge-warning">Missed</span>')
        : '<span class="badge badge-info">Upcoming</span>';
      const sourceBadge = isEmail
        ? '<span class="badge badge-neutral">Email Template</span>'
        : (script ? '<span class="badge badge-neutral">'+U().esc(script.category||"General")+'</span>' : '<span class="badge badge-danger">Script deleted</span>');

      return `
        <div class="release-maintenance" data-sch-id="${U().esc(item.id)}" style="align-items:center">
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <strong>${U().esc(displayTitle)}</strong>
              ${statusBadge}
              ${sourceBadge}
            </div>
            <div class="form-help" style="margin-top:3px">${U().esc(dateStr)} at ${U().esc(timeStr)}${item.notes ? ' · ' + U().esc(item.notes) : ''}</div>
            ${item.assignedTo ? '<div class="form-help">Assigned to: <strong>' + U().esc(item.assignedToName || item.assignedTo) + '</strong></div>' : ''}
          </div>
          <span style="display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap">
            ${!isPast ? '<button class="btn btn-sm" data-sch-done="'+U().esc(item.id)+'">Mark done</button>' : ''}
            ${isPast && !item.completed ? '<button class="btn btn-sm" data-sch-done="'+U().esc(item.id)+'">Mark done</button>' : ''}
            <button class="btn btn-sm" data-sch-edit="${U().esc(item.id)}">Edit</button>
            <button class="btn btn-sm btn-danger" data-sch-del="${U().esc(item.id)}">Delete</button>
          </span>
        </div>`;
    }

    container.innerHTML = `
      <div class="page-header"><div><div class="page-title">Scheduler</div><div class="page-desc">Schedule a follow-up from a Script or an active Email Template, set a date and time, and optionally assign it to a team member. Nothing is sent automatically — you complete each item yourself.</div></div><div class="page-actions"><button class="btn btn-primary" id="schAddBtn">${App.app.icon("plus")} Schedule Follow-up</button></div></div>
      ${templatesError ? `<div class="release-callout release-callout-warning" style="margin-bottom:16px">
        <strong>Email Templates could not be loaded.</strong>
        <p style="margin:6px 0 10px">${U().esc(templatesError)}</p>
        <p class="form-help" style="margin:0 0 10px">Scripts and your existing scheduled items are still shown below.</p>
        <button type="button" class="btn btn-sm" id="schTemplatesRetry">Retry</button>
      </div>` : ''}
      <div class="stat-row release-stat-grid">
        <div class="stat-card"><div class="k">Total Scheduled</div><div class="v">${schedule.length}</div></div>
        <div class="stat-card"><div class="k">Upcoming</div><div class="v">${upcoming.length}</div></div>
        <div class="stat-card"><div class="k">Completed</div><div class="v">${schedule.filter(s=>s.completed).length}</div></div>
        <div class="stat-card"><div class="k">Available Scripts</div><div class="v">${scripts.length}</div></div>
        <div class="stat-card"><div class="k">Active Email Templates</div><div class="v">${templatesError ? "—" : templates.length}</div></div>
      </div>
      ${(!templatesError && scripts.length === 0 && templates.length === 0) ? '<div class="release-callout" style="margin-bottom:16px">Nothing to schedule from yet. <button class="btn btn-sm" data-go="/email-templates">Add an Email Template</button></div>' : ''}
      <div class="card"><div class="card-header"><div class="card-title">Upcoming</div></div><div class="card-body zero">
        ${upcoming.length ? upcoming.map(s => scheduleRow(s, false)).join("") : '<div class="empty-row"><p class="form-help" style="margin:0">Nothing scheduled. Click &ldquo;Schedule Follow-up&rdquo; to add one.</p></div>'}
      </div></div>
      ${past.length ? `<div class="card" style="margin-top:16px"><div class="card-header"><div class="card-title">Past</div></div><div class="card-body zero">
        ${past.map(s => scheduleRow(s, true)).join("")}
      </div></div>` : ''}`;

    // Add button
    document.getElementById("schAddBtn").addEventListener("click", () => openScheduleModal(null, scripts, templates, templatesError, () => render(container)));

    const templatesRetryBtn = document.getElementById("schTemplatesRetry");
    if (templatesRetryBtn) templatesRetryBtn.addEventListener("click", () => render(container));

    // Mark done
    container.querySelectorAll("[data-sch-done]").forEach(b => b.addEventListener("click", async () => {
      const item = S().getState().scheduledItems.find(x => x.id === b.getAttribute("data-sch-done"));
      if (!item) return;
      try {
        await S().scheduledItems.update(item.id, { completed: true });
        App.app.toast("Marked as done.", "success");
        render(container);
      } catch (err) {
        App.app.toast("Could not update: " + err.message, "danger");
      }
    }));

    // Edit
    container.querySelectorAll("[data-sch-edit]").forEach(b => b.addEventListener("click", () => {
      const items = loadSchedule();
      const item = items.find(s => s.id === b.getAttribute("data-sch-edit"));
      if (item) openScheduleModal(item, scripts, templates, templatesError, () => render(container));
    }));

    // Delete
    container.querySelectorAll("[data-sch-del]").forEach(b => b.addEventListener("click", () => {
      App.app.confirmDialog({ title: "Delete scheduled item?", message: "This removes the scheduled entry. The Script or Email Template itself is not affected.", okLabel: "Delete", danger: true }, async () => {
        try {
          await S().scheduledItems.delete(b.getAttribute("data-sch-del"));
          App.app.toast("Deleted.", "success");
          render(container);
        } catch (err) {
          App.app.toast("Could not delete: " + err.message, "danger");
        }
      });
    }));

    container.querySelectorAll("[data-go]").forEach(el => {
      el.addEventListener("click", () => App.app.navigate(el.getAttribute("data-go")));
    });
  }

  function openScheduleModal(existing, scripts, templates, templatesError, onDone) {
    const members = S().getState().teamMembers.filter(m => m.active !== false);
    const now = new Date();
    const defaultDate = existing ? existing.dateTime.slice(0, 16) : new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const initialSource = existing && existing.type === "email" ? "email" : "script";

    // scheduled_items only ever stores a plain-text title snapshot, never
    // a template id — so an existing email-type item whose original
    // template was renamed, deactivated, deleted, or simply couldn't be
    // loaded this time (templatesError) has no way to be matched back to
    // one of the currently active `templates`. Rather than leave the
    // select on nothing (which would silently drop the saved reference
    // the instant the user saves any unrelated change), offer the saved
    // snapshot itself as a distinct, always-selectable option.
    const isExistingEmail = !!(existing && existing.type === "email");
    const hasMatchingActiveTemplate = isExistingEmail && templates.some(t => t.name === existing.title);
    const showSavedOption = isExistingEmail && !hasMatchingActiveTemplate;

    const h = App.app.openModal({
      title: existing ? "Edit Scheduled Item" : "Schedule a Follow-up",
      wide: true,
      body: `<div class="form-grid">
        <label class="field full"><span>Source</span><select id="schSource">
          <option value="script" ${initialSource === "script" ? "selected" : ""}>Script (legacy library)</option>
          <option value="email" ${initialSource === "email" ? "selected" : ""}>Email Template</option>
        </select></label>

        <div data-source-group="script" class="full" style="display:${initialSource === "script" ? "flex" : "none"};flex-direction:column;gap:14px">
          <label class="field"><span>Script</span><select id="schScript">
            <option value="">Select a script…</option>
            ${scripts.map(s => `<option value="${App.util.esc(s.id)}" ${existing && existing.type !== "email" && existing.scriptId === s.id ? "selected" : ""}>${App.util.esc(s.title)} (${App.util.esc(s.category||"General")})</option>`).join("")}
          </select></label>
        </div>

        <div data-source-group="email" class="full" style="display:${initialSource === "email" ? "flex" : "none"};flex-direction:column;gap:14px">
          <label class="field"><span>Email Template</span><select id="schTemplate">
            <option value="">Select an active template…</option>
            ${showSavedOption ? `<option value="__saved__" selected>${App.util.esc(existing.title || "Saved template")} (saved reference)</option>` : ""}
            ${templates.map(t => `<option value="${App.util.esc(t.id)}" ${hasMatchingActiveTemplate && existing.title === t.name ? "selected" : ""}>${App.util.esc(t.name)}</option>`).join("")}
          </select></label>
          ${showSavedOption ? '<p class="form-help">This item\'s original template was renamed, deactivated, deleted, or could not be loaded — its saved title is kept unless you pick a different template above.</p>' : ''}
          ${templatesError ? `<div class="release-callout release-callout-warning" style="margin-top:4px"><strong>Could not load Email Templates.</strong><p style="margin:6px 0 0">${App.util.esc(templatesError)}</p></div>` : (!templates.length && !showSavedOption ? '<p class="form-help">No active Email Templates yet — create one on the Email Templates page.</p>' : '')}
          <p class="form-help">Selecting a template only prefills the title and a note below. Nothing is sent — you still pick the date/time, save manually, and complete this yourself later.</p>
        </div>

        <label class="field"><span>Date &amp; Time</span><input type="datetime-local" id="schDateTime" value="${App.util.esc(defaultDate)}"></label>
        <label class="field"><span>Assign to</span><select id="schAssign">
          <option value="">Unassigned</option>
          ${members.map(m => `<option value="${App.util.esc(m.id)}" ${existing && existing.assignedTo === m.id ? "selected" : ""}>${App.util.esc(m.name)} — ${App.util.esc(m.role)}</option>`).join("")}
        </select></label>
        <label class="field full"><span>Notes (optional)</span><input id="schNotes" value="${App.util.esc(existing?.notes||"")}" placeholder="e.g. Call after showing"></label>
      </div>`,
      footer: `<button class="btn" data-role="cancel">Cancel</button><button class="btn btn-primary" data-role="save">${existing ? "Save Changes" : "Schedule"}</button>`,
      onOpen: m => {
        m.querySelector('[data-role="cancel"]').onclick = () => h.close();

        const sourceSelect = m.querySelector("#schSource");
        const syncGroups = () => {
          const src = sourceSelect.value;
          m.querySelectorAll("[data-source-group]").forEach(g => { g.style.display = g.getAttribute("data-source-group") === src ? "flex" : "none"; });
        };
        sourceSelect.addEventListener("change", syncGroups);

        // Prefill notes with a non-secret template reference the first
        // time a template is picked for a NEW item — never overwrites a
        // note the user has already started typing.
        const templateSelect = m.querySelector("#schTemplate");
        templateSelect.addEventListener("change", () => {
          if (existing) return;
          const notesEl = m.querySelector("#schNotes");
          const t = templates.find(x => x.id === templateSelect.value);
          if (t && !notesEl.value.trim()) notesEl.value = "Email template: " + t.name;
        });

        const saveBtn = m.querySelector('[data-role="save"]');
        saveBtn.onclick = async () => {
          if (saveBtn.disabled) return;
          const source = sourceSelect.value;
          const dateTime = m.querySelector("#schDateTime").value;
          if (!dateTime) { App.app.toast("Pick a date and time.", "danger"); return; }

          let entry;
          if (source === "email") {
            const selectedValue = m.querySelector("#schTemplate").value;
            if (!selectedValue) { App.app.toast("Select an Email Template.", "danger"); return; }
            // The template id itself is never stored anywhere on this row
            // (script_id is a foreign key into the legacy scripts table,
            // not message_templates) — only its name, as a plain snapshot.
            if (selectedValue === "__saved__") {
              // The original template can't currently be resolved
              // (renamed/deactivated/deleted/unavailable) — preserve the
              // existing snapshot exactly rather than losing it.
              entry = { type: "email", scriptId: null, scriptTitle: "", title: existing.title };
            } else {
              const template = templates.find(t => t.id === selectedValue);
              entry = { type: "email", scriptId: null, scriptTitle: "", title: template ? template.name : "Email" };
            }
          } else {
            const scriptId = m.querySelector("#schScript").value;
            if (!scriptId) { App.app.toast("Select a script.", "danger"); return; }
            const script = scripts.find(s => s.id === scriptId);
            entry = { type: "script", scriptId, scriptTitle: script ? script.title : "Unknown", title: script ? script.title : "Unknown" };
          }

          const assignId = m.querySelector("#schAssign").value || null;
          const assignMember = assignId ? S().getState().teamMembers.find(x => x.id === assignId) : null;
          Object.assign(entry, {
            dateTime,
            assignedTo: assignId,
            assignedToName: assignMember ? assignMember.name : null,
            notes: m.querySelector("#schNotes").value.trim(),
            completed: existing ? existing.completed : false
          });
          if (existing) entry.id = existing.id;

          saveBtn.disabled = true;
          try {
            if (existing) await S().scheduledItems.update(existing.id, entry);
            else await S().scheduledItems.create(entry);
            h.close();
            App.app.toast(existing ? "Schedule updated." : "Item scheduled.", "success");
            if (onDone) onDone();
          } catch (err) {
            App.app.toast("Could not save: " + err.message, "danger");
            saveBtn.disabled = false;
          }
        };
      }
    });
  }

  return { render };
})();
