/* ============================================================
   team-dashboard.js — the Team page.

   One row per person: how many leads they hold, how much work is open,
   how much of it is late, and how many deals they are carrying. Counted
   from the records this account can actually see, so an admin whose own
   view is narrowed sees numbers that match their own lists rather than
   numbers they cannot drill into.

   Depends on: app.js, store.js (App.store.team + the entity caches),
   workspace.js, customization.js, util.js
   ============================================================ */

window.App = window.App || {};
App.pages = App.pages || {};

App.pages.teamDashboard = (function () {
  "use strict";

  const U = () => App.util;
  const S = () => App.store;
  const W = () => App.workspace;

  const DEPS = ["contacts", "deals", "tasks", "teamMembers"];

  function isOpenTask(t) { return t && t.status !== "Completed" && t.status !== "Cancelled"; }
  function isOverdue(t) {
    if (!isOpenTask(t) || !t.dueDate) return false;
    return String(t.dueDate) < U().todayISO();
  }
  function isOpenDeal(d) {
    const s = d && d.stage;
    return !!s && s !== "Won" && s !== "Lost" && s !== "Closed";
  }

  async function render(container) {
    if (!container) return;
    App.app.setBreadcrumbs([{ label: "Team" }]);
    App.app.setTopActions("");
    container.innerHTML = App.app.loadingHtml("your team");

    try {
      await W().load();
      await S().ensureLoaded(DEPS);
    } catch (err) {
      container.innerHTML = App.app.errorHtml("The team page could not load.");
      const retry = container.querySelector('[data-role="route-retry"]');
      if (retry) retry.addEventListener("click", () => render(container));
      return;
    }

    if (App.customization && !App.customization.isTeamMode()) {
      container.innerHTML = header() + `
        <section class="card"><div class="card-body">
          <div class="empty-state">
            <div class="empty-title">Team features are off</div>
            <div class="empty-desc">Turn them on in Settings to invite people and share work.</div>
            <button type="button" class="btn btn-primary" id="teamGoSettings">Open Team &amp; Access</button>
          </div>
        </div></section>`;
      const b = container.querySelector("#teamGoSettings");
      if (b) b.addEventListener("click", () => App.app.navigate("/settings/team-access"));
      return;
    }

    let members = [];
    let rosterFailed = false;
    try {
      const res = await S().team.listMembers();
      if (res && res.outcome === "ok") members = (res.members || []).filter(m => m.status === "active");
      else rosterFailed = true;
    } catch (err) {
      rosterFailed = true;
    }

    if (rosterFailed) {
      container.innerHTML = header() + `
        <section class="card"><div class="card-body">${App.app.errorHtml("The team list could not load.")}</div></section>`;
      const retry = container.querySelector('[data-role="route-retry"]');
      if (retry) retry.addEventListener("click", () => render(container));
      return;
    }

    const state = S().getState();
    const rows = members.map(m => {
      const tmId = m.team_member_id || null;
      const mine = (arr) => tmId ? arr.filter(r => r.assignedToId === tmId) : [];
      const tasks = mine(state.tasks || []);
      return {
        member: m,
        leads: mine(state.contacts || []).length,
        openTasks: tasks.filter(isOpenTask).length,
        overdue: tasks.filter(isOverdue).length,
        deals: mine(state.deals || []).filter(isOpenDeal).length
      };
    });

    const unassignedLeads = (state.contacts || []).filter(c => !c.assignedToId).length;

    container.innerHTML = header() + `
      <section class="card">
        <div class="card-header">
          <div class="card-title">Who is carrying what</div>
          ${W().can("team_manage") ? `<button class="btn btn-sm" id="teamManageBtn">Manage the team</button>` : ""}
        </div>
        <div class="card-body zero">
          ${rows.length ? `
          <div class="table-wrap">
            <table class="tbl tbl-responsive">
              <thead>
                <tr>
                  <th>Person</th><th>Leads</th><th>Open tasks</th><th>Late tasks</th><th>Deals in progress</th>
                </tr>
              </thead>
              <tbody>
                ${rows.map(r => `
                  <tr>
                    <td data-label="Person" class="primary-cell">
                      <strong>${U().esc((r.member.name && String(r.member.name).trim()) || r.member.email || "Someone")}</strong>
                      ${r.member.is_self ? ` <span class="badge badge-neutral">You</span>` : ""}
                      <div class="form-help">${U().esc(r.member.role === "owner" ? "Owner" : r.member.role === "admin" ? "Admin" : "Agent")}</div>
                    </td>
                    <td data-label="Leads">${r.leads}</td>
                    <td data-label="Open tasks">${r.openTasks}</td>
                    <td data-label="Late tasks">${r.overdue
                      ? `<span class="badge badge-overdue">${r.overdue}</span>` : "0"}</td>
                    <td data-label="Deals in progress">${r.deals}</td>
                  </tr>`).join("")}
              </tbody>
            </table>
          </div>` : `
          <div class="empty-state">
            <div class="empty-title">Nobody to show yet</div>
            <div class="empty-desc">Invite somebody in Team &amp; Access and they will appear here.</div>
          </div>`}
        </div>
      </section>
      ${renderResponseTable(members, state)}
      ${unassignedLeads ? `
      <section class="card">
        <div class="card-body">
          <div class="split-row">
            <div class="split-row-main"><div class="split-row-label">
              <strong>${unassignedLeads} lead${unassignedLeads === 1 ? "" : "s"} nobody owns</strong>
              <div class="form-help">Give them to somebody so they do not go cold.</div>
            </div></div>
            <button class="btn btn-sm" id="teamGoUnassigned">Open those leads</button>
          </div>
        </div>
      </section>` : ""}
      <p class="form-help">Counts come from the records you can see, so they match your own lists.</p>`;

    wireResponseTable(container, members, state);

    const manage = container.querySelector("#teamManageBtn");
    if (manage) manage.addEventListener("click", () => App.app.navigate("/settings/team-access"));
    const unassigned = container.querySelector("#teamGoUnassigned");
    if (unassigned) unassigned.addEventListener("click", () => {
      if (App.pages.contacts && App.pages.contacts.showUnassigned) App.pages.contacts.showUnassigned();
      App.app.navigate("/contacts");
    });
  }

  /* ============================================================
   * RESPONSE TIME, PER PERSON (Phase 2C)
   *
   * Managers only, and only in team mode. Not because the numbers are
   * secret, but because "how fast is each person answering leads" is a
   * management conversation, and putting it in front of everybody turns a
   * useful figure into a leaderboard nobody asked for.
   *
   * Computed from the contacts already in the state snapshot, through the
   * same App.responseStats the Dashboard card uses - so a manager and an
   * agent looking at the same person see the same number. RLS decided which
   * contacts are in that array; a manager who cannot see a teammate's leads
   * will see that teammate's row as having none, which is the honest answer
   * rather than a borrowed one.
   * ========================================================== */

  // Column id -> how to read it off a row. `dir` is the direction that puts
  // the thing needing attention first, which is what a manager wants on the
  // first click.
  const RESPONSE_COLUMNS = {
    person: { label: "Person", dir: 1, value: (r) => String(r.name || "").toLowerCase() },
    newContacts: { label: "New leads", dir: -1, value: (r) => r.stats.newContacts },
    withinDay: { label: "Contacted within a day", dir: 1, value: (r) => (r.stats.touchedWithin24hPct == null ? Infinity : r.stats.touchedWithin24hPct) },
    median: { label: "Typical time to first contact", dir: -1, value: (r) => (r.stats.medianTouchMs == null ? -1 : r.stats.medianTouchMs) },
    overdue: { label: "Overdue now", dir: -1, value: (r) => r.stats.overdueNow }
  };

  let responseSort = { key: "overdue", dir: -1 };

  function canSeeResponseTable() {
    if (App.customization && !App.customization.isTeamMode()) return false;
    return !!(W() && W().can && W().can("team_manage"));
  }

  function responseRows(members, state) {
    const R = App.responseStats;
    if (!R) return [];
    const contacts = state.contacts || [];
    const today = U().todayISO();
    const now = Date.now();

    const rows = (members || []).map((m) => {
      const tmId = m.team_member_id || null;
      const theirs = tmId ? contacts.filter((c) => c.assignedToId === tmId) : [];
      return {
        id: m.member_id || m.team_member_id || String(m.user_id || ""),
        name: (m.name && String(m.name).trim()) || m.email || "Someone",
        isSelf: !!m.is_self,
        stats: R.compute(theirs, today, now)
      };
    });

    // The team row counts every contact the viewer can see, including ones
    // nobody owns - those are the team's problem by definition.
    rows.push({
      id: "__team__",
      name: "Whole team",
      isTeam: true,
      stats: R.compute(contacts, today, now)
    });
    return rows;
  }

  function sortResponseRows(rows) {
    const col = Object.prototype.hasOwnProperty.call(RESPONSE_COLUMNS, responseSort.key)
      ? RESPONSE_COLUMNS[responseSort.key] : RESPONSE_COLUMNS.overdue;
    // The team row is a total, not a competitor: it stays at the bottom
    // whichever way the people above it are sorted.
    const people = rows.filter((r) => !r.isTeam);
    const team = rows.filter((r) => r.isTeam);
    people.sort((a, b) => {
      const va = col.value(a), vb = col.value(b);
      if (va === vb) return String(a.name).localeCompare(String(b.name));
      return va < vb ? -responseSort.dir : responseSort.dir;
    });
    return people.concat(team);
  }

  function responseBodyHtml(rows) {
    const R = App.responseStats;
    return sortResponseRows(rows).map((r) => `
      <tr${r.isTeam ? ' class="tbl-total-row"' : ""}>
        <td data-label="Person" class="primary-cell">
          <strong>${U().esc(r.name)}</strong>
          ${r.isSelf ? ' <span class="badge badge-neutral">You</span>' : ""}
        </td>
        <td data-label="New leads">${r.stats.newContacts}</td>
        <td data-label="Contacted within a day">${U().esc(R.formatPct(r.stats.touchedWithin24hPct))}
          ${r.stats.untouched ? `<div class="form-help">${r.stats.untouched} still waiting</div>` : ""}
        </td>
        <td data-label="Typical time to first contact">${U().esc(R.formatDuration(r.stats.medianTouchMs))}</td>
        <td data-label="Overdue now">${r.stats.overdueNow
          ? `<span class="badge badge-overdue">${r.stats.overdueNow}</span>` : "0"}</td>
      </tr>`).join("");
  }

  function renderResponseTable(members, state) {
    if (!canSeeResponseTable() || !App.responseStats) return "";
    const rows = responseRows(members, state);
    const R = App.responseStats;
    const head = Object.keys(RESPONSE_COLUMNS).map((key) => {
      const on = responseSort.key === key;
      const aria = on ? (responseSort.dir === 1 ? "ascending" : "descending") : "none";
      return `<th aria-sort="${aria}">
        <button type="button" class="tbl-sort" data-response-sort="${U().esc(key)}">
          ${U().esc(RESPONSE_COLUMNS[key].label)}${on ? (responseSort.dir === 1 ? " \u2191" : " \u2193") : ""}
        </button>
      </th>`;
    }).join("");

    return `
      <section class="card" id="teamResponseCard">
        <div class="card-header">
          <div class="card-title">How quickly leads get answered</div>
          <span class="badge badge-neutral">last ${R.WINDOW_DAYS} days</span>
        </div>
        <div class="card-body zero">
          <div class="table-wrap">
            <table class="tbl tbl-responsive">
              <thead><tr>${head}</tr></thead>
              <tbody id="teamResponseBody">${responseBodyHtml(rows)}</tbody>
            </table>
          </div>
          <p class="form-help" style="padding:12px 16px 0">A dash means there were no new leads to measure. Counts come from the records you can see.</p>
        </div>
      </section>`;
  }

  function wireResponseTable(container, members, state) {
    const card = container.querySelector("#teamResponseCard");
    if (!card) return;
    const rows = responseRows(members, state);
    card.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-response-sort]");
      if (!btn) return;
      const key = btn.getAttribute("data-response-sort");
      if (!Object.prototype.hasOwnProperty.call(RESPONSE_COLUMNS, key)) return;
      if (responseSort.key === key) {
        responseSort.dir = -responseSort.dir;
      } else {
        responseSort = { key, dir: RESPONSE_COLUMNS[key].dir };
      }
      // Only the body and the header labels change, so the rest of the page
      // and its listeners are left alone.
      const body = card.querySelector("#teamResponseBody");
      if (body) body.innerHTML = responseBodyHtml(rows);
      Object.keys(RESPONSE_COLUMNS).forEach((k) => {
        const b = card.querySelector('[data-response-sort="' + k + '"]');
        if (!b) return;
        const on = responseSort.key === k;
        b.textContent = RESPONSE_COLUMNS[k].label + (on ? (responseSort.dir === 1 ? " \u2191" : " \u2193") : "");
        const th = b.closest("th");
        if (th) th.setAttribute("aria-sort", on ? (responseSort.dir === 1 ? "ascending" : "descending") : "none");
      });
    });
  }

  function header() {
    return `
      <div class="page-header">
        <div>
          <div class="page-title">Team</div>
          <div class="page-desc">How work is spread across the people in this workspace.</div>
        </div>
      </div>`;
  }

  return { render };
})();
