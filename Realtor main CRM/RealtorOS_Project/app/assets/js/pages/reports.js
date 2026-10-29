/* ============================================================
   reports-page.js — Business Reports center.
   All numbers derived from existing store + derived + commission.
   No hardcoded business numbers. Read-only view.
   ============================================================ */

window.App = window.App || {};
App.pages = App.pages || {};

App.pages.reports = (function () {
  "use strict";

  const U = () => App.util;
  const S = () => App.store;
  const D = () => App.derived;
  const C = () => App.commission;

  async function render(container) {
    App.app.setBreadcrumbs([{ label: "Reports" }]);
    App.app.setTopActions("");
    container.innerHTML = App.app.loadingHtml();
    await S().ensureLoaded(["deals", "contacts", "activities", "tasks", "referrals", "income", "expenses", "milestones", "properties"]);

    const s = S().getState();
    const cur = s.settings.currency;
    const fmt = (v) => U().formatCurrency(v, cur);
    const fmtC = (v) => U().formatCompact(v, cur);

    container.innerHTML = `
      <div class="page-header">
        <div>
          <div class="page-title">Reports</div>
          <div class="page-desc">Business intelligence across your pipeline, commission, contacts, activities, tasks, referrals, and finances — every number is calculated live.</div>
        </div>
        <div class="page-actions">
          <span class="action-more" id="reportExport">
            <button type="button" class="btn btn-primary action-more-toggle" id="reportExportBtn"
                    aria-haspopup="true" aria-expanded="false" aria-controls="reportExportMenu">
              ${App.app.icon("save")} Export
            </button>
            <span class="action-more-menu" id="reportExportMenu" role="menu" hidden>
              <button type="button" class="dropdown-action" role="menuitem" data-export="print">Print / Save as PDF</button>
              <button type="button" class="dropdown-action" role="menuitem" data-export="csv">Export summary (CSV)</button>
            </span>
          </span>
        </div>
      </div>
      <div class="reports-grid">
        ${renderPipelineReport(s, cur, fmt, fmtC)}
        ${renderCommissionReport(s, cur, fmt, fmtC)}
        ${renderContactReport(s)}
        ${renderResponseTimeReport(s)}
        ${renderActivityReport(s)}
        ${renderTaskReport(s)}
        ${renderReferralReport(s, cur, fmtC)}
        ${renderFinancialReport(s, cur, fmt, fmtC)}
      </div>
    `;

    wireExport(container);
  }

  // ---------- EXPORT ----------
  // Both exports read the rendered cards rather than recomputing from state:
  // the point of "export this report" is to get what is on screen, and
  // re-deriving it would duplicate every calculation in this file with a
  // second chance to disagree with the view.
  //
  // Scope, stated plainly: this exports each card's headline KPIs. The
  // in-card breakdown rows (By Stage, and similar) carry no stable markup to
  // key off and are not included, and values come out formatted as displayed
  // (compact currency such as "$1.2M"), not as raw numbers. For full,
  // unformatted records use Settings > Data & Safety > Export workspace,
  // which writes every stored field as JSON.

  function csvCell(v) {
    const t = String(v == null ? "" : v);
    return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
  }

  // [section, metric, value] triples for one .report-card.
  function scrapeCard(card) {
    const titleEl = card.querySelector(".card-title");
    const section = titleEl ? titleEl.textContent.trim() : "Report";
    const rows = [];
    card.querySelectorAll(".report-kpis > div").forEach(cell => {
      const k = cell.querySelector(".rk");
      const v = cell.querySelector(".rv");
      if (k && v) rows.push([section, k.textContent.trim(), v.textContent.trim()]);
    });
    return rows;
  }

  function downloadCsv(rows, filename) {
    const body = [["Section", "Metric", "Value"]].concat(rows)
      .map(r => r.map(csvCell).join(",")).join("\r\n");
    // A BOM so Excel opens UTF-8 correctly instead of mangling the currency
    // symbols these values are full of.
    const blob = new Blob(["﻿" + body], { type: "text/csv;charset=utf-8" });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(() => window.URL.revokeObjectURL(url), 100);
  }

  function stamp() {
    const d = new Date();
    const pad = n => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function wireExport(container) {
    const wrap = container.querySelector("#reportExport");
    const btn = container.querySelector("#reportExportBtn");
    const menu = container.querySelector("#reportExportMenu");
    if (!wrap || !btn || !menu) return;

    function close() { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); detach(); }
    function onDocClick(ev) { if (!ev.target.closest || !ev.target.closest("#reportExport")) close(); }
    function onKey(ev) { if (ev.key === "Escape") { close(); btn.focus(); } }
    function detach() {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onKey);
    }

    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const willOpen = menu.hidden;
      menu.hidden = !willOpen;
      btn.setAttribute("aria-expanded", String(willOpen));
      if (willOpen) {
        document.addEventListener("click", onDocClick);
        document.addEventListener("keydown", onKey);
      } else detach();
    });

    menu.addEventListener("click", (ev) => {
      const action = ev.target.closest("[data-export]");
      if (!action) return;
      close();
      if (action.getAttribute("data-export") === "print") { window.print(); return; }
      const rows = [];
      container.querySelectorAll(".report-card").forEach(card => { rows.push.apply(rows, scrapeCard(card)); });
      if (!rows.length) { App.app.toast("Nothing to export yet.", "danger"); return; }
      downloadCsv(rows, "realtoros-reports-" + stamp() + ".csv");
      App.app.toast("Report summary exported.", "success");
    });

    // Per-card export, so a single section (Commission, most often) can be
    // pulled without the other six.
    container.querySelectorAll(".report-card").forEach(card => {
      const header = card.querySelector(".card-header");
      if (!header) return;
      const one = document.createElement("button");
      one.type = "button";
      one.className = "btn btn-sm btn-ghost report-card-export";
      one.textContent = "Export";
      one.title = "Export this section as CSV";
      one.addEventListener("click", () => {
        const rows = scrapeCard(card);
        if (!rows.length) { App.app.toast("Nothing to export in this section.", "danger"); return; }
        const name = (rows[0][0] || "section").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        downloadCsv(rows, "realtoros-" + name + "-" + stamp() + ".csv");
        App.app.toast("Section exported.", "success");
      });
      header.appendChild(one);
    });
  }

  // ---------- 1. PIPELINE ----------

  function renderPipelineReport(s, cur, fmt, fmtC) {
    const glance = D().businessAtAGlance(s);
    const pipe = D().pipelineSummary(s);
    const active = D().activeDeals(s);
    const avgDeal = active.length > 0 ? glance.activePipelineValue / active.length : 0;

    return `
      <div class="card report-card">
        <div class="card-header"><div class="card-title">Sales / Pipeline</div></div>
        <div class="card-body">
          <div class="report-kpis">
            <div><span class="rk">Active Deals</span><span class="rv">${glance.activeDealsCount}</span></div>
            <div><span class="rk">Pipeline Value</span><span class="rv">${fmtC(glance.activePipelineValue)}</span></div>
            <div><span class="rk">Expected Net</span><span class="rv">${fmtC(glance.expectedNetCommission)}</span></div>
            <div><span class="rk">Weighted</span><span class="rv">${fmtC(glance.expectedWeightedCommission)}</span></div>
            <div><span class="rk">Avg Deal Value</span><span class="rv">${fmtC(avgDeal)}</span></div>
            <div><span class="rk">Closings This Month</span><span class="rv">${glance.closingsThisMonth}</span></div>
          </div>
          ${pipe.length > 0 ? `
            <div style="margin-top:16px;">
              <div style="font-size: var(--font-size-xs);font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;">By Stage</div>
              ${pipe.map(st => `
                <div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border);font-size: var(--font-size-sm);">
                  <span class="stage-dot" style="background:${st.color}"></span>
                  <span style="flex:1;font-weight:600;">${U().esc(st.stageName)}</span>
                  <span>${st.count} deal${st.count===1?'':'s'}</span>
                  <span style="font-variant-numeric:tabular-nums;">${fmtC(st.totalValue)}</span>
                  <span style="color:var(--text-muted);font-size: var(--font-size-xs);">Net ${fmtC(st.expectedNetCommission)}</span>
                </div>
              `).join("")}
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }

  // ---------- 2. COMMISSION ----------

  function renderCommissionReport(s, cur, fmt, fmtC) {
    const overview = D().commissionOverview(s);
    const glance = D().businessAtAGlance(s);
    const allDeals = s.deals;
    const totalGross = allDeals.reduce((t,d) => t + C().grossGCI(d), 0);
    const totalNet = allDeals.reduce((t,d) => t + C().netGCI(d), 0);
    const totalWeighted = allDeals.reduce((t,d) => t + C().weightedGCI(d), 0);

    return `
      <div class="card report-card">
        <div class="card-header"><div class="card-title">Commission</div></div>
        <div class="card-body">
          <div class="report-kpis">
            <div><span class="rk">Total Gross GCI</span><span class="rv">${fmtC(totalGross)}</span></div>
            <div><span class="rk">Total Net GCI</span><span class="rv">${fmtC(totalNet)}</span></div>
            <div><span class="rk">Weighted Pipeline</span><span class="rv">${fmtC(totalWeighted)}</span></div>
            <div><span class="rk">YTD Closed Net</span><span class="rv">${fmtC(overview.ytdNetCommission)}</span></div>
            <div><span class="rk">Pending (Under Contract)</span><span class="rv">${fmtC(overview.pendingCommission)}</span></div>
            <div><span class="rk">Expected (Active)</span><span class="rv">${fmtC(overview.expectedCommission)}</span></div>
          </div>
          ${overview.monthlyTrend.length > 0 ? `
            <div style="margin-top:16px;">
              <div style="font-size: var(--font-size-xs);font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;">Monthly Trend (Last 12)</div>
              ${overview.monthlyTrend.filter(m => m.amount > 0 || m.count > 0).map(m => `
                <div style="display:flex;align-items:center;gap:10px;padding:4px 0;font-size: var(--font-size-sm);">
                  <span style="width:60px;color:var(--text-muted)">${m.label}</span>
                  <span style="flex:1;font-weight:600;">${fmt(m.amount)}</span>
                  <span style="color:var(--text-soft)">${m.count} deal${m.count===1?'':'s'}</span>
                </div>
              `).join("") || '<div style="color:var(--text-soft);font-size: var(--font-size-sm)">No closings in the last 12 months.</div>'}
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }

  // ---------- 3. CONTACTS ----------

  function renderContactReport(s) {
    const all = s.contacts;
    const health = D().leadHealth(s);
    const buyers = all.filter(c => c.role === "Buyer").length;
    const sellers = all.filter(c => c.role === "Seller").length;
    const investors = all.filter(c => c.role === "Investor").length;
    const partners = all.filter(c => c.role === "Referral Partner").length;
    const pastClients = all.filter(c => c.stage === "Past Client").length;

    return `
      <div class="card report-card">
        <div class="card-header"><div class="card-title">Contacts / Leads</div></div>
        <div class="card-body">
          <div class="report-kpis">
            <div><span class="rk">Total Contacts</span><span class="rv">${all.length}</span></div>
            <div><span class="rk">Active Leads</span><span class="rv">${health.totalLeads}</span></div>
            <div><span class="rk">Buyers</span><span class="rv">${buyers}</span></div>
            <div><span class="rk">Sellers</span><span class="rv">${sellers}</span></div>
            <div><span class="rk">Investors</span><span class="rv">${investors}</span></div>
            <div><span class="rk">Referral Partners</span><span class="rv">${partners}</span></div>
            <div><span class="rk">Past Clients</span><span class="rv">${pastClients}</span></div>
          </div>
          <div style="margin-top:16px;">
            <div style="font-size: var(--font-size-xs);font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;">By Temperature</div>
            <div class="report-kpis">
              <div><span class="rk">🔥 Hot</span><span class="rv">${health.hotLeads}</span></div>
              <div><span class="rk">🌤 Warm</span><span class="rv">${health.warmLeads}</span></div>
              <div><span class="rk">❄️ Cold</span><span class="rv">${health.coldLeads}</span></div>
            </div>
          </div>
          ${health.leadSourceBreakdown.length > 0 ? `
            <div style="margin-top:16px;">
              <div style="font-size: var(--font-size-xs);font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;">By Source</div>
              ${health.leadSourceBreakdown.map(s => `
                <div style="display:flex;justify-content:space-between;padding:3px 0;font-size: var(--font-size-sm);">
                  <span>${U().esc(s.label)}</span><span style="font-weight:600">${s.count}</span>
                </div>
              `).join("")}
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }

  // ---------- 3b. RESPONSE TIME (moved here in U2c) ----------
  //
  // "Am I actually working my leads" belongs with the other performance
  // numbers, not on the Overview, which is a glance at today. It moved
  // here whole: the same App.responseStats.compute() the Dashboard
  // called and the Team dashboard still calls, with no new calculation
  // and no second definition of a window or a median.
  //
  // It is a .report-card with .report-kpis, like every other card on
  // this page, which is what makes it pick up the grid, both themes,
  // the responsive columns, the CSV export and its own section-export
  // button without a line of new CSS or export code. The Dashboard
  // version used .stat-card tiles; those belonged to the Dashboard's
  // visual language, not to this data.
  function renderResponseTimeReport(s) {
    if (!App.responseStats) return "";
    const R = App.responseStats;
    const stats = R.compute(s.contacts, U().todayISO(), Date.now());

    // Always rendered, including with nothing to show: "no new leads in
    // the last 30 days" is an answer, and a card that disappears reads
    // as a bug.
    const body = stats.newContacts === 0
      ? `<div style="color:var(--text-soft);font-size: var(--font-size-sm)">
           No new leads in the last ${R.WINDOW_DAYS} days. Response time appears here as soon as new contacts come in.
         </div>`
      : `<div class="report-kpis">
          <div><span class="rk">New Leads</span><span class="rv">${stats.newContacts}</span></div>
          <div><span class="rk">Not Contacted Yet</span><span class="rv">${stats.untouched}</span></div>
          <div><span class="rk">Contacted Within a Day</span><span class="rv">${U().esc(R.formatPct(stats.touchedWithin24hPct))}</span></div>
          <div><span class="rk">Typical Time to First Contact</span><span class="rv">${U().esc(R.formatDuration(stats.medianTouchMs))}</span></div>
          <div><span class="rk">Overdue Follow-ups</span><span class="rv">${stats.overdueNow}</span></div>
        </div>
        <div style="margin-top:12px;color:var(--text-soft);font-size: var(--font-size-xs)">
          ${stats.touchedWithin24h} of ${stats.newContacts} new leads were contacted within a day. Typical time is the median: half were faster, half slower.
        </div>`;

    return `
      <div class="card report-card">
        <div class="card-header">
          <div class="card-title">Response Time</div>
          <span class="badge badge-neutral">last ${R.WINDOW_DAYS} days</span>
        </div>
        <div class="card-body">${body}</div>
      </div>
    `;
  }

  // ---------- 4. ACTIVITIES ----------

  function renderActivityReport(s) {
    const all = s.activities;
    const byType = {};
    all.forEach(a => { byType[a.type] = (byType[a.type] || 0) + 1; });
    const thisMonth = U().todayISO().slice(0, 7);
    const thisMonthCount = all.filter(a => a.date && a.date.slice(0,7) === thisMonth).length;

    return `
      <div class="card report-card">
        <div class="card-header"><div class="card-title">Activities</div></div>
        <div class="card-body">
          <div class="report-kpis">
            <div><span class="rk">Total Activities</span><span class="rv">${all.length}</span></div>
            <div><span class="rk">This Month</span><span class="rv">${thisMonthCount}</span></div>
          </div>
          <div style="margin-top:16px;">
            <div style="font-size: var(--font-size-xs);font-weight:600;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:8px;">By Type</div>
            ${Object.keys(byType).sort().map(type => `
              <div style="display:flex;justify-content:space-between;padding:3px 0;font-size: var(--font-size-sm);">
                <span>${U().esc(type)}</span><span style="font-weight:600">${byType[type]}</span>
              </div>
            `).join("") || '<div style="color:var(--text-soft);font-size: var(--font-size-sm)">No activities yet.</div>'}
          </div>
        </div>
      </div>
    `;
  }

  // ---------- 5. TASKS ----------

  function renderTaskReport(s) {
    const all = s.tasks;
    const today = U().todayISO();
    const open = all.filter(t => t.status !== "Completed").length;
    const completed = all.filter(t => t.status === "Completed").length;
    const overdue = all.filter(t => t.dueDate && t.dueDate < today && t.status !== "Completed").length;
    const dueToday = all.filter(t => t.dueDate === today && t.status !== "Completed").length;
    const completionRate = all.length > 0 ? Math.round((completed / all.length) * 100) : 0;

    return `
      <div class="card report-card">
        <div class="card-header"><div class="card-title">Tasks</div></div>
        <div class="card-body">
          <div class="report-kpis">
            <div><span class="rk">Total Tasks</span><span class="rv">${all.length}</span></div>
            <div><span class="rk">Open</span><span class="rv">${open}</span></div>
            <div><span class="rk">Completed</span><span class="rv">${completed}</span></div>
            <div><span class="rk">Overdue</span><span class="rv" style="${overdue?'color:var(--danger)':''}">${overdue}</span></div>
            <div><span class="rk">Due Today</span><span class="rv">${dueToday}</span></div>
            <div><span class="rk">Completion Rate</span><span class="rv">${completionRate}%</span></div>
          </div>
        </div>
      </div>
    `;
  }

  // ---------- 6. REFERRALS ----------

  function renderReferralReport(s, cur, fmtC) {
    const all = s.referrals;
    const converted = all.filter(r => r.status === "Closed Won").length;
    const active = all.filter(r => !["Closed Won","Closed Lost"].includes(r.status)).length;
    const convRate = all.length > 0 ? Math.round((converted / all.length) * 100) : 0;
    const refDealIds = new Set(all.filter(r => r.dealId).map(r => r.dealId));
    const refPipeline = s.deals.filter(d => refDealIds.has(d.id) && !D().isTerminalStage(s, d.stage))
                               .reduce((t,d) => t + U().num(d.salePrice), 0);

    return `
      <div class="card report-card">
        <div class="card-header"><div class="card-title">Referrals</div></div>
        <div class="card-body">
          <div class="report-kpis">
            <div><span class="rk">Total Referrals</span><span class="rv">${all.length}</span></div>
            <div><span class="rk">Active</span><span class="rv">${active}</span></div>
            <div><span class="rk">Converted</span><span class="rv">${converted}</span></div>
            <div><span class="rk">Conversion Rate</span><span class="rv">${convRate}%</span></div>
            <div><span class="rk">Referral Pipeline</span><span class="rv">${fmtC(refPipeline)}</span></div>
          </div>
        </div>
      </div>
    `;
  }

  // ---------- 7. FINANCIAL ----------

  function renderFinancialReport(s, cur, fmt, fmtC) {
    const today = U().todayISO();
    const thisYear = U().dateYear(today);
    const thisMonth = today.slice(0, 7);
    const allInc = s.income;
    const allExp = s.expenses;
    const totalInc = allInc.reduce((t,r) => t + U().num(r.amount), 0);
    const totalExp = allExp.reduce((t,r) => t + U().num(r.amount), 0);
    const ytdInc = allInc.filter(r => r.date && U().dateYear(r.date) === thisYear).reduce((t,r) => t + U().num(r.amount), 0);
    const ytdExp = allExp.filter(r => r.date && U().dateYear(r.date) === thisYear).reduce((t,r) => t + U().num(r.amount), 0);
    const monthInc = allInc.filter(r => r.date && r.date.slice(0,7) === thisMonth).reduce((t,r) => t + U().num(r.amount), 0);
    const monthExp = allExp.filter(r => r.date && r.date.slice(0,7) === thisMonth).reduce((t,r) => t + U().num(r.amount), 0);

    return `
      <div class="card report-card">
        <div class="card-header"><div class="card-title">Financial</div></div>
        <div class="card-body">
          <div class="report-kpis">
            <div><span class="rk">Total Income</span><span class="rv" style="color:var(--success)">${fmtC(totalInc)}</span></div>
            <div><span class="rk">Total Expenses</span><span class="rv" style="color:var(--danger)">${fmtC(totalExp)}</span></div>
            <div><span class="rk">Net Income</span><span class="rv" style="color:${totalInc-totalExp>=0?'var(--success)':'var(--danger)'}">${fmtC(totalInc - totalExp)}</span></div>
            <div><span class="rk">YTD Income</span><span class="rv">${fmt(ytdInc)}</span></div>
            <div><span class="rk">YTD Expenses</span><span class="rv">${fmt(ytdExp)}</span></div>
            <div><span class="rk">YTD Net</span><span class="rv">${fmt(ytdInc - ytdExp)}</span></div>
            <div><span class="rk">This Month Income</span><span class="rv">${fmt(monthInc)}</span></div>
            <div><span class="rk">This Month Expenses</span><span class="rv">${fmt(monthExp)}</span></div>
            <div><span class="rk">This Month Net</span><span class="rv">${fmt(monthInc - monthExp)}</span></div>
          </div>
        </div>
      </div>
    `;
  }

  return { render };
})();

