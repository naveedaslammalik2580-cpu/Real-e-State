/* ============================================================
   tasks-page.js — Tasks module: list, CRUD, complete/uncomplete.
   Uses existing store.tasks. No new data structures.
   ============================================================ */

window.App = window.App || {};
App.pages = App.pages || {};

App.pages.tasks = (function () {
  "use strict";

  const U = () => App.util;
  const S = () => App.store;

  let filters = { search: "", status: "", priority: "", contactId: "", dealId: "", sort: "due-asc" };

  function priBadge(p) {
    const cls = p === "High" ? "badge-danger" : p === "Low" ? "badge-neutral" : "badge-warning";
    return `<span class="badge ${cls}">${U().esc(p)}</span>`;
  }
  // ---------- LIST PAGE ----------

  async function render(container) {
    App.app.setBreadcrumbs([{ label: "Tasks" }]);
    App.app.setTopActions("");
    container.innerHTML = App.app.loadingHtml();
    await S().ensureLoaded(["tasks", "contacts", "deals", "teamMembers"]);

    const s = S().getState();
    const contacts = s.contacts.slice().sort((a,b) => a.name.localeCompare(b.name));
    const deals = s.deals.slice().sort((a,b) => (a.name||"").localeCompare(b.name||""));
    const today = U().todayISO();
    const allTasks = s.tasks;
    const overdueCount = allTasks.filter(t => t.dueDate && t.dueDate < today && t.status !== "Completed").length;
    const todayCount = allTasks.filter(t => t.dueDate === today && t.status !== "Completed").length;

    container.innerHTML = `
      <div class="page-header">
        <div>
          <div class="page-title">Tasks</div>
          <div class="page-desc">Everything on your plate — overdue, today, upcoming, and completed. Filter, search, and knock them out.</div>
        </div>
        <div class="page-actions">
          <button class="btn btn-primary" id="addTaskBtn">${App.app.icon("plus")} Add Task</button>
        </div>
      </div>
      <div class="stat-row">
        <div class="stat-card"><div class="k">Open Tasks</div><div class="v">${allTasks.filter(t=>t.status!=="Completed").length}</div></div>
        <div class="stat-card" style="${overdueCount?'border-color:var(--danger)':''}"><div class="k">Overdue</div><div class="v" style="${overdueCount?'color:var(--danger)':''}">${overdueCount}</div></div>
        <div class="stat-card" style="${todayCount?'border-color:var(--warning)':''}"><div class="k">Due Today</div><div class="v">${todayCount}</div></div>
        <div class="stat-card"><div class="k">Completed</div><div class="v">${allTasks.filter(t=>t.status==="Completed").length}</div></div>
      </div>
      <div class="filter-bar">
        <div class="search-wrap">
          ${App.app.icon("search")}
          <input type="search" id="tSearch" placeholder="Search tasks…" value="${U().esc(filters.search)}">
        </div>
        <select id="tStatus" aria-label="Status">
          <option value="">All statuses</option>
          <option value="open" ${filters.status==="open"?"selected":""}>Open</option>
          <option value="overdue" ${filters.status==="overdue"?"selected":""}>Overdue</option>
          <option value="today" ${filters.status==="today"?"selected":""}>Due Today</option>
          <option value="upcoming" ${filters.status==="upcoming"?"selected":""}>Upcoming (7 days)</option>
          <option value="Completed" ${filters.status==="Completed"?"selected":""}>Completed</option>
        </select>
        <select id="tPriority" aria-label="Priority">
          <option value="">All priorities</option>
          ${["High","Medium","Low"].map(p => `<option value="${p}" ${filters.priority===p?"selected":""}>${p}</option>`).join("")}
        </select>
        <select id="tContact" aria-label="Contact">
          <option value="">All contacts</option>
          ${contacts.map(c => `<option value="${c.id}" ${filters.contactId===c.id?"selected":""}>${U().esc(c.name)}</option>`).join("")}
        </select>
        <select id="tSort" aria-label="Sort">
          <option value="due-asc" ${filters.sort==="due-asc"?"selected":""}>Due date (soonest)</option>
          <option value="due-desc" ${filters.sort==="due-desc"?"selected":""}>Due date (latest)</option>
          <option value="pri-asc" ${filters.sort==="pri-asc"?"selected":""}>Priority (highest first)</option>
          <option value="created-desc" ${filters.sort==="created-desc"?"selected":""}>Created (newest)</option>
        </select>
      </div>
      <div class="card">
        <div class="card-header"><div class="card-title" id="tCount">Loading…</div></div>
        <div class="card-body zero" id="tListWrap"></div>
      </div>
    `;

    const rr = () => renderList();
    ["tSearch"].forEach(id => document.getElementById(id).addEventListener("input", e => { filters.search = e.target.value; rr(); }));
    ["tStatus","tPriority","tContact","tSort"].forEach(id => {
      document.getElementById(id).addEventListener("change", e => { filters[id.replace("t","")] = e.target.value; rr(); });
    });
    // Fix key mapping (tStatus → status, tPriority → priority, tContact → contactId, tSort → sort)
    document.getElementById("tStatus").addEventListener("change", e => { filters.status = e.target.value; rr(); });
    document.getElementById("tPriority").addEventListener("change", e => { filters.priority = e.target.value; rr(); });
    document.getElementById("tContact").addEventListener("change", e => { filters.contactId = e.target.value; rr(); });
    document.getElementById("tSort").addEventListener("change", e => { filters.sort = e.target.value; rr(); });
    document.getElementById("addTaskBtn").addEventListener("click", () => openTaskModal(null));
    renderList();
  }

  function renderList() {
    const state = S().getState();
    const all = state.tasks;
    let out = all.slice();
    const f = filters;
    const today = U().todayISO();
    const in7 = U().addDaysISO(today, 7);

    if (f.search) { const q = f.search.toLowerCase(); out = out.filter(t => (t.title||"").toLowerCase().includes(q) || (t.notes||"").toLowerCase().includes(q)); }
    if (f.priority) out = out.filter(t => t.priority === f.priority);
    if (f.contactId) out = out.filter(t => t.contactId === f.contactId);
    if (f.dealId) out = out.filter(t => t.dealId === f.dealId);
    switch (f.status) {
      case "open":      out = out.filter(t => t.status !== "Completed"); break;
      case "overdue":   out = out.filter(t => t.dueDate && t.dueDate < today && t.status !== "Completed"); break;
      case "today":     out = out.filter(t => t.dueDate === today && t.status !== "Completed"); break;
      case "upcoming":  out = out.filter(t => t.dueDate && t.dueDate >= today && t.dueDate <= in7 && t.status !== "Completed"); break;
      case "Completed": out = out.filter(t => t.status === "Completed"); break;
    }

    const priOrder = { High: 0, Medium: 1, Low: 2 };
    switch (f.sort) {
      case "due-desc":    out.sort((a,b) => (b.dueDate||"").localeCompare(a.dueDate||"")); break;
      case "pri-asc":     out.sort((a,b) => (priOrder[a.priority]||1) - (priOrder[b.priority]||1)); break;
      case "created-desc":out.sort((a,b) => (b.createdAt||"").localeCompare(a.createdAt||"")); break;
      default:            out.sort((a,b) => (a.dueDate||"9999").localeCompare(b.dueDate||"9999"));
    }

    document.getElementById("tCount").textContent = `${out.length} of ${all.length} task${all.length===1?"":"s"}`;
    const wrap = document.getElementById("tListWrap");

    if (!out.length) {
      wrap.innerHTML = all.length === 0
        ? `<div class="empty"><div class="empty-icon">${App.app.icon("check")}</div><h3>No tasks yet</h3><p>Add your first task to start staying on top of your to-do list. Tasks are also created automatically by automation sequences with a Create Task step.</p><button class="btn btn-primary" onclick="App.pages.tasks.openTaskModal(null)">Add Task</button></div>`
        : `<div class="empty"><h3>No matches</h3><p>Adjust your filters.</p></div>`;
      return;
    }

    wrap.innerHTML = out.map(t => {
      const overdue = t.dueDate && t.dueDate < today && t.status !== "Completed";
      const isDone = t.status === "Completed";
      const c = t.contactId ? state.contacts.find(x => x.id === t.contactId) : null;
      const d = t.dealId ? state.deals.find(x => x.id === t.dealId) : null;
      return `
        <div class="item-row" data-task-id="${t.id}">
          <button class="task-check ${isDone ? 'checked' : ''}" data-toggle="${t.id}" title="${isDone?'Reopen':'Complete'}" aria-label="${isDone?'Reopen':'Complete'} task">
            ${isDone ? '✓' : ''}
          </button>
          <div class="body clickable" data-edit="${t.id}">
            <div class="title" style="${isDone?'text-decoration:line-through;color:var(--text-muted);':''}">${U().esc(t.title)}</div>
            <div class="sub">
              ${priBadge(t.priority)} · ${U().esc(t.status)}
              ${t.dueDate ? ' · Due ' + U().formatDate(t.dueDate) : ''}
              ${overdue ? ' <span class="badge badge-overdue">Overdue</span>' : ''}
              ${c ? ' · <a class="link" href="#/contacts/'+c.id+'" onclick="event.stopPropagation()">'+U().esc(c.name)+'</a>' : ''}
              ${d ? ' · <a class="link" href="#/pipeline/'+d.id+'" onclick="event.stopPropagation()">'+U().esc(d.name)+'</a>' : ''}
            </div>
          </div>
          <div class="meta-right">${t.dueDate ? U().relativeDayLabel(t.dueDate) : '—'}</div>
        </div>
      `;
    }).join("");

    // Toggle complete
    wrap.querySelectorAll("[data-toggle]").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        btn.disabled = true;
        const tid = btn.getAttribute("data-toggle");
        const task = state.tasks.find(x => x.id === tid);
        if (!task) { btn.disabled = false; return; }
        try {
          if (task.status === "Completed") await S().tasks.update(tid, { status: "To Do" });
          else await S().tasks.complete(tid);
          App.app.route();
        } catch (err) {
          App.app.toast("Could not update task: " + err.message, "danger");
          btn.disabled = false;
        }
      });
    });
    // Click to edit
    wrap.querySelectorAll("[data-edit]").forEach(el => {
      el.addEventListener("click", () => openTaskModal(el.getAttribute("data-edit")));
    });
  }

  // ---------- ADD / EDIT MODAL ----------

  // prefill (create only, ignored when editing) lets a quick-add shortcut
  // elsewhere — Contact/Property/Deal detail pages, Calendar — pre-associate
  // the new task with a contact/deal/property/due date. See
  // App.pages.contacts.openTaskModal, the single shared entry point every
  // one of those shortcuts calls.
  async function openTaskModal(id, prefill) {
    const editing = !!id;
    await S().ensureLoaded(["tasks", "contacts", "deals", "teamMembers"]);
    const state = S().getState();
    const existing = editing ? state.tasks.find(x => x.id === id) : null;
    if (editing && !existing) { App.app.toast("Task not found.", "danger"); return; }

    const s = state;
    const defaults = { title: "", dueDate: null, priority: "Medium", status: "To Do", contactId: null, dealId: null, propertyId: null, assignedToId: null, notes: "" };
    const t = existing || Object.assign({}, defaults, prefill || {});
    const contacts = state.contacts.slice().sort((a,b) => a.name.localeCompare(b.name));
    const deals = state.deals.slice().sort((a,b) => (a.name||"").localeCompare(b.name||""));
    const teamMemberOptions = state.teamMembers.filter(m => m.active !== false || m.id === t.assignedToId)
      .sort((a,b) => (a.name||"").localeCompare(b.name||""));

    const body = `
      <form id="taskForm" novalidate>
        <div class="form-grid">
          <div class="form-field full">
            <label for="tfTitle">Title <span class="req">*</span></label>
            <input type="text" id="tfTitle" value="${U().esc(t.title)}" required>
            <div class="err">Title is required.</div>
          </div>
          <div class="form-field">
            <label for="tfDue">Due Date</label>
            <input type="date" id="tfDue" value="${t.dueDate||""}">
          </div>
          <div class="form-field">
            <label for="tfPri">Priority</label>
            <select id="tfPri">${s.settings.taskPriorities.map(p => `<option value="${p}" ${t.priority===p?"selected":""}>${p}</option>`).join("")}</select>
          </div>
          <div class="form-field">
            <label for="tfStatus">Status</label>
            <select id="tfStatus">${["To Do","In Progress","Completed"].map(st => `<option value="${st}" ${t.status===st?"selected":""}>${st}</option>`).join("")}</select>
          </div>
          <div class="form-field">
            <label for="tfContact">Contact</label>
            <select id="tfContact"><option value="">— none —</option>${contacts.map(c => `<option value="${c.id}" ${t.contactId===c.id?"selected":""}>${U().esc(c.name)}</option>`).join("")}</select>
          </div>
          <div class="form-field full">
            <label for="tfDeal">Deal</label>
            <select id="tfDeal"><option value="">— none —</option>${deals.map(d => `<option value="${d.id}" ${t.dealId===d.id?"selected":""}>${U().esc(d.name)}</option>`).join("")}</select>
          </div>
          <div class="form-field">
            <label for="tfAssignedTo">Assigned To</label>
            <select id="tfAssignedTo"><option value="">— unassigned —</option>${teamMemberOptions.map(m => `<option value="${U().esc(m.id)}" ${t.assignedToId===m.id?"selected":""}>${U().esc(m.name)}${m.active===false?" (inactive)":""}</option>`).join("")}</select>
          </div>
          <div class="form-field full">
            <label for="tfNotes">Notes</label>
            <textarea id="tfNotes" rows="3">${U().esc(t.notes)}</textarea>
          </div>
        </div>
        ${App.customFieldsUI.renderSection("task", editing ? id : null)}
      </form>
    `;

    const footer = `
      ${editing ? '<button class="btn btn-danger" data-role="delete">Delete</button>' : ''}
      <button class="btn" data-role="cancel">Cancel</button>
      <button class="btn btn-primary" data-role="save">${editing ? "Save" : "Add Task"}</button>
    `;

    const handle = App.app.openModal({
      title: editing ? "Edit Task" : "Add Task", body, footer,
      onOpen: (modal) => {
        modal.querySelector('[data-role="cancel"]').addEventListener("click", () => handle.close());
        modal.querySelector('[data-role="save"]').addEventListener("click", async () => {
          const titleField = document.getElementById("tfTitle").closest(".form-field");
          titleField.classList.remove("has-error");
          const title = document.getElementById("tfTitle").value.trim();
          if (!title) { titleField.classList.add("has-error"); return; }
          const missingCustom = App.customFieldsUI.findMissingRequired(document, "task");
          if (missingCustom.length) {
            App.app.toast(`${missingCustom.join(", ")} ${missingCustom.length === 1 ? "is" : "are"} required.`, "danger");
            return;
          }

          const patch = {
            title,
            dueDate: document.getElementById("tfDue").value || null,
            priority: document.getElementById("tfPri").value,
            status: document.getElementById("tfStatus").value,
            contactId: document.getElementById("tfContact").value || null,
            dealId: document.getElementById("tfDeal").value || null,
            // No property picker in this form (matches the previous quick-add
            // form, which also had none) — carries a quick-add shortcut's
            // propertyId prefill straight through instead of dropping it, and
            // is a no-op on edit since it's just the record's own value.
            propertyId: t.propertyId || null,
            assignedToId: document.getElementById("tfAssignedTo").value || null,
            notes: document.getElementById("tfNotes").value
          };
          const customValues = App.customFieldsUI.collectValues(document, "task");
          const saveBtn = modal.querySelector('[data-role="save"]');
          saveBtn.disabled = true;
          let savedId = id;
          try {
            if (editing) { await S().tasks.update(id, patch); App.app.toast("Task updated.", "success"); }
            else { const nt = await S().tasks.create(patch); savedId = nt && nt.id; App.app.toast("Task added.", "success"); }
            if (savedId) await S().customFields.setValues("task", savedId, customValues);
            handle.close();
            App.app.route();
          } catch (err) {
            App.app.toast("Could not save task: " + err.message, "danger");
            saveBtn.disabled = false;
          }
        });
        const delBtn = modal.querySelector('[data-role="delete"]');
        if (delBtn) delBtn.addEventListener("click", () => {
          App.app.confirmDialog({ title: "Delete Task?", message: "This will permanently delete this task.", okLabel: "Delete", danger: true }, async () => {
            try {
              await S().tasks.delete(id);
              App.app.toast("Task deleted.", "success");
              handle.close();
              App.app.route();
            } catch (err) {
              App.app.toast("Could not delete task: " + err.message, "danger");
            }
          });
        });
      }
    });
  }

  return { render, openTaskModal };
})();

