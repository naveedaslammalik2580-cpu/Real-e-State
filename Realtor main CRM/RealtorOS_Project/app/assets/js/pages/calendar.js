/* ============================================================
   calendar-page.js — Calendar: month grid + agenda list view.
   Derived from existing showings, tasks, activities, deal close
   dates, and milestone deadlines. No second calendar database.
   ============================================================ */

window.App = window.App || {};
App.pages = App.pages || {};

App.pages.calendar = (function () {
  "use strict";

  const U = () => App.util;
  const S = () => App.store;

  let viewMode = "month"; // "month" | "agenda"
  let currentDate = new Date(); // the month/week being viewed

  function monthStr(d) { return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0"); }

  // ---------- COLLECT ALL CALENDAR EVENTS ----------

  function collectEvents(from, to) {
    const state = S().getState();
    const events = [];
    // Showings
    state.showings.forEach(sh => {
      if (!sh.date) return;
      if (sh.date < from || sh.date > to) return;
      const c = sh.contactId ? state.contacts.find(x => x.id === sh.contactId) : null;
      const p = sh.propertyId ? state.properties.find(x => x.id === sh.propertyId) : null;
      events.push({
        date: sh.date,
        time: sh.startTime || "",
        type: "showing",
        label: (p ? p.address : "Showing") + (c ? " — " + c.name : ""),
        color: "var(--event-showing)",
        link: p ? "#/properties/" + p.id : (c ? "#/contacts/" + c.id : null)
      });
    });
    // Tasks with due dates
    state.tasks.forEach(t => {
      if (!t.dueDate) return;
      if (t.dueDate < from || t.dueDate > to) return;
      if (t.status === "Completed") return;
      events.push({
        date: t.dueDate,
        time: "",
        type: "task",
        label: t.title,
        color: t.priority === "High" ? "var(--event-task-high)" : (t.priority === "Low" ? "var(--event-task-low)" : "var(--event-task-medium)"),
        link: null,
        taskId: t.id
      });
    });
    // Deal close dates
    state.deals.forEach(d => {
      if (!d.closeDate) return;
      if (d.closeDate < from || d.closeDate > to) return;
      const st = state.settings.pipelineStages.find(s => s.name === d.stage);
      if (st && st.terminal) return; // only show active deals
      events.push({
        date: d.closeDate,
        time: "",
        type: "closing",
        label: "Closing: " + d.name,
        color: "var(--event-closing)",
        link: "#/pipeline/" + d.id
      });
    });
    // Milestones with due dates (non-complete)
    state.milestones.forEach(m => {
      if (!m.dueDate || m.status === "Complete") return;
      if (m.dueDate < from || m.dueDate > to) return;
      const deal = m.dealId ? state.deals.find(x => x.id === m.dealId) : null;
      // Skip milestones that duplicate a deal's closing event already shown above
      if (deal && deal.closeDate === m.dueDate && /clos/i.test(m.name || "")) {
        const dst = state.settings.pipelineStages.find(s => s.name === deal.stage);
        if (!dst || !dst.terminal) return;
      }
      events.push({
        date: m.dueDate,
        time: "",
        type: "milestone",
        label: m.name + (deal ? " — " + deal.name : ""),
        color: "var(--event-milestone)",
        link: deal ? "#/pipeline/" + deal.id : null
      });
    });
    // Sort by date then time
    events.sort((a,b) => {
      const dc = a.date.localeCompare(b.date);
      if (dc !== 0) return dc;
      return (a.time||"99:99").localeCompare(b.time||"99:99");
    });
    return events;
  }

  // ---------- RENDER ----------

  async function render(container) {
    App.app.setBreadcrumbs([{ label: "Calendar" }]);
    App.app.setTopActions("");
    container.innerHTML = App.app.loadingHtml();
    await S().ensureLoaded(["showings", "contacts", "properties", "tasks", "deals", "milestones"]);

    container.innerHTML = `
      <div class="page-header">
        <div>
          <div class="page-title">Calendar</div>
          <div class="page-desc">Showings, task deadlines, deal closings, and milestones — all in one view.</div>
        </div>
        <div class="page-actions">
          <button class="btn btn-sm" id="calAddTask">${App.app.icon("plus")} Task</button>
          <button class="btn btn-sm" id="calAddAct">${App.app.icon("plus")} Activity</button>
          <button class="btn btn-sm btn-primary" id="calAddShow">${App.app.icon("plus")} Showing</button>
        </div>
      </div>
      <div class="filter-bar">
        <button class="btn btn-sm" id="calPrev">← Prev</button>
        <strong id="calLabel" style="min-width:140px;text-align:center;font-size: var(--font-size-md);">${formatMonthLabel(currentDate)}</strong>
        <button class="btn btn-sm" id="calNext">Next →</button>
        <button class="btn btn-sm" id="calToday">Today</button>
        <div style="flex:1"></div>
        <button class="btn btn-sm ${viewMode==='month'?'btn-primary':''}" id="calMonth">Month</button>
        <button class="btn btn-sm ${viewMode==='agenda'?'btn-primary':''}" id="calAgenda">Agenda</button>
      </div>
      <div class="card">
        <div class="card-body zero" id="calBody" style="min-height:400px;"></div>
      </div>
    `;

    document.getElementById("calPrev").addEventListener("click", () => { currentDate.setMonth(currentDate.getMonth()-1); rerender(container); });
    document.getElementById("calNext").addEventListener("click", () => { currentDate.setMonth(currentDate.getMonth()+1); rerender(container); });
    document.getElementById("calToday").addEventListener("click", () => { currentDate = new Date(); rerender(container); });
    document.getElementById("calMonth").addEventListener("click", () => { viewMode = "month"; rerender(container); });
    document.getElementById("calAgenda").addEventListener("click", () => { viewMode = "agenda"; rerender(container); });
    document.getElementById("calAddTask").addEventListener("click", () => App.pages.contacts.openTaskModal({}));
    document.getElementById("calAddAct").addEventListener("click", () => App.pages.contacts.openActivityModal({}));
    document.getElementById("calAddShow").addEventListener("click", () => App.pages.contacts.openShowingModal({}));

    renderBody();
  }

  function rerender(container) {
    document.getElementById("calLabel").textContent = formatMonthLabel(currentDate);
    document.getElementById("calMonth").className = "btn btn-sm" + (viewMode==="month"?" btn-primary":"");
    document.getElementById("calAgenda").className = "btn btn-sm" + (viewMode==="agenda"?" btn-primary":"");
    renderBody();
  }

  function renderBody() {
    const el = document.getElementById("calBody");
    if (!el) return;
    if (viewMode === "month") renderMonthGrid(el);
    else renderAgenda(el);
  }

  function formatMonthLabel(d) {
    return d.toLocaleString("en-US", { month: "long", year: "numeric" });
  }

  // ---------- MONTH GRID ----------

  function renderMonthGrid(container) {
    const y = currentDate.getFullYear();
    const m = currentDate.getMonth();
    const first = new Date(y, m, 1);
    const last = new Date(y, m + 1, 0);
    const startDay = first.getDay(); // 0=Sun
    const daysInMonth = last.getDate();
    const todayISO = U().todayISO();

    const from = y + "-" + String(m+1).padStart(2,"0") + "-01";
    const to   = y + "-" + String(m+1).padStart(2,"0") + "-" + String(daysInMonth).padStart(2,"0");
    const events = collectEvents(from, to);

    // Group events by date
    const byDate = {};
    events.forEach(e => { (byDate[e.date] = byDate[e.date] || []).push(e); });

    // Build grid (6 rows × 7 cols max)
    let cells = "";
    const totalSlots = Math.ceil((startDay + daysInMonth) / 7) * 7;
    for (let i = 0; i < totalSlots; i++) {
      const day = i - startDay + 1;
      const valid = day >= 1 && day <= daysInMonth;
      const dateISO = valid ? y + "-" + String(m+1).padStart(2,"0") + "-" + String(day).padStart(2,"0") : "";
      const isToday = dateISO === todayISO;
      const dayEvents = byDate[dateISO] || [];

      cells += `
        <div class="cal-cell ${valid ? '' : 'cal-cell-empty'} ${isToday ? 'cal-cell-today' : ''}">
          ${valid ? `<div class="cal-day">${day}</div>` : ''}
          ${dayEvents.slice(0, 3).map(e => `
            <div class="cal-event" style="border-left-color:${e.color}" ${e.link ? `onclick="location.hash='${e.link}'" role="button" tabindex="0"` : ''} title="${U().esc(e.label)}">
              ${e.time ? `<span class="cal-event-time">${U().esc(e.time)}</span>` : ''}
              <span class="cal-event-label">${U().esc(U().truncate(e.label, 22))}</span>
            </div>
          `).join("")}
          ${dayEvents.length > 3 ? `<div class="cal-more">+${dayEvents.length - 3} more</div>` : ''}
        </div>
      `;
    }

    container.innerHTML = `
      <div class="cal-grid">
        <div class="cal-header">Sun</div><div class="cal-header">Mon</div><div class="cal-header">Tue</div>
        <div class="cal-header">Wed</div><div class="cal-header">Thu</div><div class="cal-header">Fri</div><div class="cal-header">Sat</div>
        ${cells}
      </div>
    `;
  }

  // ---------- AGENDA VIEW ----------

  function renderAgenda(container) {
    const y = currentDate.getFullYear();
    const m = currentDate.getMonth();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const from = y + "-" + String(m+1).padStart(2,"0") + "-01";
    const to   = y + "-" + String(m+1).padStart(2,"0") + "-" + String(daysInMonth).padStart(2,"0");
    const events = collectEvents(from, to);
    const todayISO = U().todayISO();

    if (events.length === 0) {
      container.innerHTML = `<div class="empty" style="padding:var(--empty-padding)"><h3>Nothing this month</h3><p>No showings, tasks, closings, or milestones scheduled.</p></div>`;
      return;
    }

    // Group by date
    const groups = {};
    events.forEach(e => { (groups[e.date] = groups[e.date] || []).push(e); });
    const dates = Object.keys(groups).sort();

    container.innerHTML = dates.map(d => {
      const isToday = d === todayISO;
      const label = isToday ? "Today — " + U().formatDate(d, "long") : U().formatDate(d, "long");
      return `
        <div class="agenda-day${isToday ? ' agenda-today' : ''}">
          <div class="agenda-date">${label}</div>
          ${groups[d].map(e => `
            <div class="item-row${e.link ? ' clickable' : ''}" ${e.link ? `onclick="location.hash='${e.link}'"` : ''}>
              <div class="icon-slot" style="background:color-mix(in srgb, ${e.color} 14%, transparent);color:${e.color};font-size: var(--font-size-xs);font-weight:700;">${eventTypeIcon(e.type)}</div>
              <div class="body">
                <div class="title">${U().esc(e.label)}</div>
                <div class="sub">${capitalize(e.type)}${e.time ? " · " + U().esc(e.time) : ""}</div>
              </div>
            </div>
          `).join("")}
        </div>
      `;
    }).join("");
  }

  function eventTypeIcon(type) {
    switch(type) {
      case "showing": return "🏠";
      case "task": return "✓";
      case "closing": return "💰";
      case "milestone": return "🎯";
      default: return "📅";
    }
  }
  function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ""; }

  return { render };
})();

