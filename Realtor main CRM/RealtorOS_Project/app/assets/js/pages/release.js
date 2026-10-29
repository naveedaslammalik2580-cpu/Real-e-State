/* ============================================================
   release-pages.js — final release surfaces that complete the
   existing navigation: Dashboard, Daily View, Growth libraries,
   Settings (including Data & Safety — export/restore/reset), and
   first-run welcome.
   Uses existing store/derived/backup architecture only.
   ============================================================ */

window.App = window.App || {};
App.pages = App.pages || {};

App.pages.release = (function () {
  "use strict";

  const U = () => App.util;
  const S = () => App.store;
  const D = () => App.derived;
  const B = () => App.backup;

  function money(v, compact) {
    const cur = S().getState().settings.currency || "USD";
    return compact ? U().formatCompact(v, cur) : U().formatCurrency(v, cur);
  }

  function emptyMessage(title, text, actionHtml) {
    return `<div class="empty-state"><div class="empty-title">${U().esc(title)}</div><div class="empty-desc">${U().esc(text)}</div>${actionHtml || ""}</div>`;
  }

  // ---------- DASHBOARD ----------

  // Dashboard widget renderers. Each returns an HTML fragment. Widget visibility,
  // order, and module dependencies are controlled from App.customization. The
  // markup and derived-data calls inside each renderer are preserved unchanged.
  const DASHBOARD_WIDGETS = {
    statOverview: function (s) {
      const glance = D().businessAtAGlance(s);
      const comm = D().commissionOverview(s);
      const attention = D().needsAttention(s);
      return `
        <div class="stat-row release-stat-grid" data-widget="statOverview">
          <div class="stat-card"><div class="k">Active Pipeline</div><div class="v">${money(glance.activePipelineValue, true)}</div><div class="sub">${glance.activeDealsCount} active deal${glance.activeDealsCount===1?'':'s'}</div></div>
          <div class="stat-card"><div class="k">Expected Net Commission</div><div class="v">${money(glance.expectedNetCommission, true)}</div><div class="sub">active deals before probability weighting</div></div>
          <div class="stat-card"><div class="k">YTD Closed Net</div><div class="v">${money(comm.ytdNetCommission, true)}</div><div class="sub">closed deals this year</div></div>
          <div class="stat-card"><div class="k">Needs Attention</div><div class="v" style="${attention.totalCount?'color:var(--warning)':''}">${attention.totalCount}</div><div class="sub">follow-ups, tasks, deadlines &amp; closings</div></div>
        </div>`;
    },
    pipelineSnapshot: function (s) {
      const pipeline = D().pipelineSummary(s);
      return `
        <section class="card" data-widget="pipelineSnapshot">
          <div class="card-header"><div class="card-title">Pipeline Snapshot</div><button class="btn btn-sm" data-go="/pipeline">View pipeline</button></div>
          <div class="card-body zero">
            ${pipeline.some(x=>x.count) ? pipeline.map(st => `
              <div class="item-row">
                <div class="icon-slot" style="background:${st.color}22;color:${st.color}"><span class="stage-dot" style="background:${st.color}"></span></div>
                <div class="body"><div class="title">${U().esc(st.stageName)}</div><div class="sub">${st.count} deal${st.count===1?'':'s'} · ${money(st.totalValue, true)}</div></div>
                <div class="meta-right"><strong>${money(st.expectedNetCommission, true)}</strong><br><span>expected net</span></div>
              </div>`).join("") : emptyMessage("No active pipeline yet", "Add a deal to start tracking pipeline value and commission.")}
          </div>
        </section>`;
    },
    needsAttention: function (s) {
      const attention = D().needsAttention(s);
      // Accent the card only when it will actually list something — see
      // attentionRows() for why this is not a raw count of the derived arrays.
      const hasItems = attentionRows(attention).length > 0;
      // "Open Daily View" header button is dropped if the Daily View module is disabled.
      const dailyEnabled = App.customization && App.customization.isModuleEnabled("daily");
      const headerBtn = dailyEnabled
        ? `<button class="btn btn-sm" data-go="/daily">Open Daily View</button>` : "";
      return `
        <section class="card${hasItems ? " card-attention" : ""}" data-widget="needsAttention">
          <div class="card-header"><div class="card-title">Needs Attention</div>${headerBtn}</div>
          <div class="card-body zero">
            ${renderAttention(attention)}
          </div>
        </section>`;
    },
    upcomingClosings: function (s) {
      const closings = D().upcomingClosings(s, 5);
      const calEnabled = App.customization && App.customization.isModuleEnabled("calendar");
      const headerBtn = calEnabled
        ? `<button class="btn btn-sm" data-go="/calendar">Calendar</button>` : "";
      return `
        <section class="card" data-widget="upcomingClosings">
          <div class="card-header"><div class="card-title">Upcoming Closings</div>${headerBtn}</div>
          <div class="card-body zero">
            ${closings.rows.length ? closings.rows.map(r => `
              <div class="item-row clickable" data-go="/pipeline/${U().esc(r.dealId)}">
                <div class="icon-slot">${App.app.icon("home")}</div>
                <div class="body"><div class="title">${U().esc(r.dealName || r.propertyAddress || "Deal")}</div><div class="sub">${U().esc(r.contactName || "Unlinked contact")} · ${U().formatDate(r.closeDate)}</div></div>
                <div class="meta-right"><strong>${money(r.expectedNet, true)}</strong><br><span>${money(r.salePrice, true)} sale</span></div>
              </div>`).join("") : emptyMessage("No closings in the next 30 days", "Upcoming active deal closings will appear here.")}
          </div>
        </section>`;
    },
    goalsProgress: function (s) {
      const goals = D().allGoalsProgress(s).slice(0, 5);
      const GOAL_TYPE_LABELS = { GCI: "Net GCI", ClosedDeals: "Closed Deals", NewClients: "New Clients", Referrals: "Referrals", Appointments: "Appointments" };
      const goalTypeLabel = t => GOAL_TYPE_LABELS[t] || String(t || "").replace(/([a-z])([A-Z])/g, "$1 $2");
      return `
        <section class="card" data-widget="goalsProgress">
          <div class="card-header"><div class="card-title">Goals</div><button class="btn btn-sm" data-go="/goals">View goals</button></div>
          <div class="card-body">
            ${goals.length ? goals.map(g => `
              <div class="release-goal-row">
                <div class="release-goal-head"><strong>${U().esc(goalTypeLabel(g.type))}</strong><span>${Math.round(g.rawPct || 0)}%</span></div>
                <div class="progress-bar-wrap"><div class="progress-bar" style="width:${Math.max(0, Math.min(100, g.pct || 0))}%;background:var(--accent)"></div></div>
                <div class="release-goal-sub">${g.type === 'GCI' ? money(g.current) : Number(g.current).toLocaleString()} of ${g.type === 'GCI' ? money(g.target) : Number(g.target).toLocaleString()} · ${g.year}</div>
              </div>`).join("") : emptyMessage("No goals yet", "Add a business goal to track progress here.")}
          </div>
        </section>`;
    },
    recentActivity: function (s) {
      const recent = D().recentActivity(s, 6);
      return `
        <section class="card" data-widget="recentActivity">
          <div class="card-header"><div class="card-title">Recent Activity</div><button class="btn btn-sm" data-go="/activities">View all</button></div>
          <div class="card-body zero">
            ${recent.length ? recent.map(a => `
              <div class="item-row">
                <div class="icon-slot">${U().esc((a.type || "N").slice(0,1).toUpperCase())}</div>
                <div class="body"><div class="title">${U().esc(a.subject || a.type || "Activity")}</div><div class="sub">${U().esc(a.contactName || a.propertyAddress || a.dealName || "General business activity")}</div></div>
                <div class="meta-right">${U().formatDate(String(a.date || "").slice(0,10), "short")}</div>
              </div>`).join("") : emptyMessage("No recent activity", "Calls, emails, meetings, notes, and other activities will appear here.")}
          </div>
        </section>`;
    },
    // ---- v2 widgets ----
    activeDealsWidget: function (s) {
      const glance = D().businessAtAGlance(s);
      return `<div class="stat-card" data-widget="activeDealsWidget"><div class="k">Active Deals</div><div class="v">${glance.activeDealsCount}</div><div class="sub">${money(glance.activePipelineValue, true)} in active pipeline</div></div>`;
    },
    newLeadsWidget: function (s) {
      const firstStage = s.settings.contactStages[0];
      const count = s.contacts.filter(c => c.stage === firstStage).length;
      return `<div class="stat-card" data-widget="newLeadsWidget"><div class="k">New Leads</div><div class="v">${count}</div><div class="sub">contacts in "${U().esc(firstStage)}"</div></div>`;
    },
    monthlyCommission: function (s) {
      const overview = D().commissionOverview(s);
      const thisMonth = overview.monthlyTrend[overview.monthlyTrend.length - 1];
      return `<div class="stat-card" data-widget="monthlyCommission"><div class="k">Monthly Commission</div><div class="v">${money(thisMonth.amount, true)}</div><div class="sub">${thisMonth.count} deal${thisMonth.count===1?'':'s'} closed in ${thisMonth.label}</div></div>`;
    },
    propertiesWidget: function (s) {
      const summary = D().propertiesSummary(s);
      return `
        <section class="card" data-widget="propertiesWidget">
          <div class="card-header"><div class="card-title">Properties</div><button class="btn btn-sm" data-go="/properties">View properties</button></div>
          <div class="card-body zero">
            ${summary.total ? Object.keys(summary.byStatus).sort().map(st => `
              <div class="item-row"><div class="body"><div class="title">${U().esc(st)}</div></div><div class="meta-right"><strong>${summary.byStatus[st]}</strong></div></div>`).join("")
              : emptyMessage("No properties yet", "Add a property to see status breakdown here.")}
          </div>
        </section>`;
    },
    conversionRate: function (s) {
      const cr = D().conversionRate(s);
      return `<div class="stat-card" data-widget="conversionRate"><div class="k">Conversion Rate</div><div class="v">${cr.decided ? Math.round(cr.rate) + "%" : "—"}</div><div class="sub">${cr.won} won / ${cr.decided} decided</div></div>`;
    },
    teamPerformance: function (s) {
      const rows = D().teamPerformance(s).filter(r => r.activeDeals || r.closedDeals);
      return `
        <section class="card" data-widget="teamPerformance">
          <div class="card-header"><div class="card-title">Team Performance</div><button class="btn btn-sm" data-go="/settings/team-access">Manage team</button></div>
          <div class="card-body zero">
            ${rows.length ? rows.map(r => `
              <div class="item-row"><div class="body"><div class="title">${U().esc(r.memberName)}</div><div class="sub">${r.activeDeals} active · ${r.closedDeals} closed</div></div><div class="meta-right"><strong>${money(r.netCommission, true)}</strong><br><span>net commission</span></div></div>`).join("")
              : emptyMessage("No deals yet", "Assign deals to team members in Settings → Team to see performance here.")}
          </div>
        </section>`;
    },
    revenueWidget: function (s) {
      const fin = D().financeSummary(s);
      return `<div class="stat-card" data-widget="revenueWidget"><div class="k">Revenue (This Month)</div><div class="v">${money(fin.monthNet, true)}</div><div class="sub">${money(fin.monthIncome, true)} income − ${money(fin.monthExpenses, true)} expenses</div></div>`
           + `<div class="stat-card" data-widget="revenueWidget"><div class="k">Revenue (YTD)</div><div class="v">${money(fin.ytdNet, true)}</div><div class="sub">${money(fin.ytdIncome, true)} income − ${money(fin.ytdExpenses, true)} expenses</div></div>`;
    }
  };

  // statOverview renders its own complete, standalone ".stat-row" (unchanged
  // from the original dashboard). The v2 stat widgets below instead each
  // return a bare ".stat-card" fragment, so any consecutive run of them —
  // in whatever order and combination a customer picks — shares ONE
  // ".stat-row" wrapper instead of each getting its own single-tile row.
  const STANDALONE_WIDGETS = new Set(["statOverview"]);
  const STAT_FRAGMENT_WIDGETS = new Set(["activeDealsWidget", "newLeadsWidget", "monthlyCommission", "conversionRate", "revenueWidget"]);

  // Composes the dashboard from three widget "shapes": standalone full-width
  // blocks (statOverview), bare stat-card fragments (batched into shared
  // stat-rows), and cards (paired two-per-row). Order is preserved across
  // shapes; only same-shape neighbors get batched together.
  function composeDashboardWidgets(orderedIds, s) {
    let out = "";
    const cardIds = [];
    const statFragments = [];
    const flushCards = () => {
      for (let i = 0; i < cardIds.length; i += 2) {
        const a = DASHBOARD_WIDGETS[cardIds[i]](s);
        const b = (i + 1 < cardIds.length) ? DASHBOARD_WIDGETS[cardIds[i + 1]](s) : "";
        out += b ? `<div class="release-grid release-grid-2">${a}${b}</div>` : a;
      }
      cardIds.length = 0;
    };
    const flushStats = () => {
      if (statFragments.length) out += `<div class="stat-row release-stat-grid">${statFragments.join("")}</div>`;
      statFragments.length = 0;
    };
    orderedIds.forEach(id => {
      const fn = DASHBOARD_WIDGETS[id];
      if (!fn) return;
      if (STANDALONE_WIDGETS.has(id)) { flushCards(); flushStats(); out += fn(s); return; }
      if (STAT_FRAGMENT_WIDGETS.has(id)) { flushCards(); statFragments.push(fn(s)); return; }
      flushStats(); cardIds.push(id);
    });
    flushCards();
    flushStats();
    return out;
  }

  // Every entity any dashboard widget can possibly read. The Dashboard is
  // deliberately the one page that aggregates across nearly the whole
  // workspace, so loading this much here (once, cached for the session) is
  // expected — it is not the "hydrate all 16 tables on every boot" pattern
  // the migration removed, since this only runs when the Dashboard route is
  // actually visited.
  const DASHBOARD_DEPS = ["contacts","properties","deals","milestones","activities","tasks","showings","referrals","goals","income","expenses","teamMembers"];

  async function renderDashboard(container) {
    App.app.setBreadcrumbs([{ label: "Dashboard" }]);
    // The header "Open Pipeline" shortcut was removed — Deals Pipeline stays
    // fully reachable from the sidebar nav.
    App.app.setTopActions("");
    await S().ensureLoaded(DASHBOARD_DEPS);
    const s = S().getState();

    // Ordered list of widget ids, honoring visibility and module dependencies.
    // Falls back to the default order if App.customization is unavailable
    // (defensive: dashboard must never crash on a bad customization config).
    let orderedIds;
    try {
      orderedIds = (App.customization && App.customization.visibleWidgetsInOrder())
        || Object.keys(DASHBOARD_WIDGETS);
    } catch (e) {
      orderedIds = Object.keys(DASHBOARD_WIDGETS);
    }

    // Phase 2E. The checklist asks whether a starter sequence exists and
    // whether one has been taken off draft; neither is in the dashboard's
    // own state. A failed read leaves those two items unticked, which is
    // the safe direction - it never claims something was done.
    let onboardingRules = [];
    try { onboardingRules = await S().automationRules.list(); }
    catch (err) { onboardingRules = []; }
    const onboardingState = Object.assign({}, s, { onboardingRules });

    const widgetHtml = composeDashboardWidgets(orderedIds, s);
    const emptyDashboard = orderedIds.length === 0
      ? emptyMessage("Dashboard widgets hidden", "Every widget is hidden or its supporting module is disabled. Visit Settings → Customize Workspace to show widgets again.")
      : "";

    // Time-of-day greeting. The name comes from the authenticated Supabase
    // user's metadata via the same App.cloud.getUser() the profile control
    // uses, with the same full_name -> name fallback; if neither is set the
    // greeting stands alone rather than showing an email local-part.
    const hour = new Date().getHours();
    const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
    const user = (App.cloud && App.cloud.getUser) ? App.cloud.getUser() : null;
    const meta = (user && user.user_metadata) || {};
    const firstName = (meta.full_name || meta.name || "").trim().split(/\s+/)[0] || "";
    const greetLine = firstName ? `${greeting}, ${U().esc(firstName)}` : greeting;

    container.innerHTML = `
      <div class="page-header">
        <div>
          <div class="page-title">${greetLine}</div>
          <div class="page-desc">Your pipeline, commissions, priorities, closings, goals, and recent client activity in one place.</div>
        </div>
      </div>
      ${App.pages.onboarding ? App.pages.onboarding.timezoneNudgeHtml() : ""}
      ${App.pages.onboarding ? App.pages.onboarding.checklistHtml(onboardingState) : ""}
      ${widgetHtml}
      ${emptyDashboard}`;

    wireGo(container);
    // Phase 2E. Both of these change what the dashboard should say, so a
    // choice on either re-renders it rather than leaving a stale card.
    if (App.pages.onboarding) {
      App.pages.onboarding.wireTimezoneNudge(container, () => renderDashboard(container));
      App.pages.onboarding.wireChecklist(container, () => renderDashboard(container));
    }
  }

  /* "Your response time" lived here, on the Dashboard, from Phase 2C
     until U2c moved it to Reports > Performance - beside the other
     performance numbers, rather than on the Overview, which is a
     glance at today. The calculation never lived here: it is
     core/response-stats.js, which the Reports card and the Team
     dashboard both still read. */

  // The rows the Needs Attention card will actually show. Extracted so the
  // widget's accent styling and the card's contents are driven by the same
  // list: counting the raw derived arrays instead would put an "act on this"
  // border on a card reading "You're caught up" whenever every non-empty
  // category belonged to a disabled module.
  function attentionRows(a) {
    // Suppress rows whose target module is disabled so we never render dead links.
    const cust = App.customization;
    const routeEnabled = (r) => !cust || cust.isModuleEnabled(routeToModuleId(r));
    return [
      ["Overdue follow-ups", a.overdueFollowUps.length, "/contacts"],
      ["Follow-ups today", a.followUpsToday.length, "/contacts"],
      ["Overdue tasks", a.overdueTasks.length, "/tasks"],
      ["Tasks today", a.tasksToday.length, "/tasks"],
      ["Upcoming showings", a.upcomingShowings.length, "/calendar"],
      ["Deal deadlines", a.dealDeadlines.length, "/calendar"],
      ["Upcoming closings", a.upcomingClosings.length, "/pipeline"],
      ["Past-due closings", a.pastDueClosings.length, "/pipeline"]
    ].filter(r => r[1] > 0 && routeEnabled(r[2]));
  }

  function renderAttention(a) {
    const rows = attentionRows(a);
    if (!rows.length) return emptyMessage("You're caught up", "No overdue or near-term items need attention right now.");
    return rows.map(r => `<button class="release-attention-row" data-go="${r[2]}"><span>${U().esc(r[0])}</span><strong>${r[1]}</strong></button>`).join("");
  }

  // Link availability follows the route registry, not the visual menu.
  function routeToModuleId(route) {
    return App.app && App.app.routeModuleId ? App.app.routeModuleId(route) : "";
  }

  // ---------- DAILY VIEW ----------

  // Today needs activities too: "new, not yet contacted" means no logged
  // activity as well as no last-contact date. Settings carries the default
  // country code the phone links are built with.
  const TODAY_DEPS = ["contacts", "tasks", "activities", "settings"];

  /* ============================================================
   * TODAY (Phase 2B)
   *
   * The screen an agent opens first: who to contact today, in the order
   * they should work through them, each row carrying its own one-tap bar so
   * contacting somebody and recording the result never leaves this page.
   *
   * Everything comes out of the state snapshot ensureLoaded() just
   * populated, so an agent who can only see their own leads sees only their
   * own leads here. The visibility rule is RLS; this page does not
   * re-implement it.
   * ========================================================== */

  const TODAY_SECTION_CAP = 50;
  const TEMP_ORDER = { Hot: 0, Warm: 1, Cold: 2 };

  // Hot before Warm before Cold, then whatever has waited longest.
  function byUrgency(a, b) {
    const ta = TEMP_ORDER[a.temperature] === undefined ? 3 : TEMP_ORDER[a.temperature];
    const tb = TEMP_ORDER[b.temperature] === undefined ? 3 : TEMP_ORDER[b.temperature];
    if (ta !== tb) return ta - tb;
    const da = a.__due || "9999-12-31";
    const db = b.__due || "9999-12-31";
    if (da !== db) return da < db ? -1 : 1;
    return String(a.name || a.title || "").localeCompare(String(b.name || b.title || ""));
  }

  // "3 days overdue" / "Due today" — the thing the agent wants to know,
  // not a raw date.
  function dueText(iso, today) {
    if (!iso) return "";
    const days = U().daysBetween(today, iso);
    if (days === 0) return "Due today";
    if (days < 0) {
      const n = Math.abs(days);
      return n === 1 ? "1 day overdue" : n + " days overdue";
    }
    return days === 1 ? "Due tomorrow" : "Due in " + days + " days";
  }

  function lastContactText(c) {
    if (!c.lastContact) return "Never contacted";
    return "Last contact " + U().formatDate(c.lastContact);
  }

  function isTerminalContactStage_(stage) {
    return stage === "Lost" || stage === "Past Client";
  }

  /* ---- Birthdays and anniversaries (Phase 2D) ----
   *
   * The next seven days, not just today, because a card has to be posted
   * and a message is better early than late. The same yearly-date rule the
   * database uses: 29 February falls back to the 28th in a non-leap year,
   * so somebody born on a leap day is never skipped.
   */
  const CELEBRATION_WINDOW_DAYS = 7;

  function isLeapYear_(year) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  }

  // The stored date as it falls in the given year, as an ISO day string.
  function yearlyDate_(iso, year) {
    if (!iso) return null;
    const parts = String(iso).slice(0, 10).split("-");
    if (parts.length !== 3) return null;
    const month = Number(parts[1]);
    let day = Number(parts[2]);
    if (!month || !day) return null;
    if (month === 2 && day === 29 && !isLeapYear_(year)) day = 28;
    const pad = (n) => (n < 10 ? "0" + n : String(n));
    return year + "-" + pad(month) + "-" + pad(day);
  }

  /** Every birthday and home anniversary falling in the next seven days. */
  function celebrations(state, today) {
    const contacts = Array.isArray(state.contacts) ? state.contacts : [];
    const until = U().addDaysISO(today, CELEBRATION_WINDOW_DAYS);
    const thisYear = Number(String(today).slice(0, 4));
    const rows = [];

    contacts.forEach((c) => {
      if (isTerminalContactStage_(c.stage)) return;
      [["birthday", c.birthday, "Birthday"],
       ["home_anniversary", c.homePurchaseDate, "Home anniversary"]].forEach(([kind, source, label]) => {
        if (!source) return;
        const purchaseYear = Number(String(source).slice(0, 4));
        // This year and next, so the last week of December still sees
        // January.
        for (const year of [thisYear, thisYear + 1]) {
          // A home anniversary has no year zero: the purchase is not an
          // anniversary of itself.
          if (kind === "home_anniversary" && year <= purchaseYear) continue;
          const when = yearlyDate_(source, year);
          if (!when || when < today || when > until) continue;
          const years = kind === "home_anniversary" ? (year - purchaseYear) : null;
          rows.push(Object.assign({}, c, {
            __due: when,
            __celebration: label,
            __years: years
          }));
          break;   // one upcoming occurrence per contact per kind
        }
      });
    });

    // Soonest first; the point of the section is what is coming up next.
    return rows.sort((a, b) => (a.__due === b.__due
      ? String(a.name || "").localeCompare(String(b.name || ""))
      : (a.__due < b.__due ? -1 : 1)));
  }

  function celebrationRowHtml(c, today) {
    const days = U().daysBetween(today, c.__due);
    const when = days === 0 ? "Today" : (days === 1 ? "Tomorrow" : "In " + days + " days");
    const what = c.__years
      ? c.__celebration + " \u00b7 " + c.__years + (c.__years === 1 ? " year" : " years")
      : c.__celebration;
    return `<div class="today-row" data-contact-row="${U().esc(c.id)}">
      <div class="today-row-main">
        <a class="today-row-name link" href="#/contacts/${U().esc(c.id)}">${U().esc(c.name || "Unnamed contact")}</a>
        <div class="today-row-meta">
          <span class="badge badge-neutral">${U().esc(what)}</span>
          <span class="${days === 0 ? "today-due-late" : "today-due"}">${U().esc(when)}</span>
          <span class="today-row-last">${U().esc(U().formatDate(c.__due))}</span>
        </div>
      </div>
      ${App.followUp ? App.followUp.barHtml(c) : ""}
    </div>`;
  }

  /** The five sections, in the order an agent should work through them. */
  function todaySections(state) {
    const today = U().todayISO();
    const contacts = Array.isArray(state.contacts) ? state.contacts : [];
    const tasks = Array.isArray(state.tasks) ? state.tasks : [];
    const activities = Array.isArray(state.activities) ? state.activities : [];
    const fourteenDaysAgo = U().addDaysISO(today, -14);
    const sevenDaysAgo = U().addDaysISO(today, -7);

    // One pass over activities: which contacts have ever been logged.
    const everLogged = Object.create(null);
    activities.forEach((a) => { if (a.contactId) everLogged[a.contactId] = true; });

    const live = contacts.filter((c) => !isTerminalContactStage_(c.stage));
    const mark = (c, due) => Object.assign({}, c, { __due: due });

    const overdue = live
      .filter((c) => c.nextFollowUp && c.nextFollowUp < today)
      .map((c) => mark(c, c.nextFollowUp)).sort(byUrgency);

    const dueTodayRows = live
      .filter((c) => c.nextFollowUp === today)
      .map((c) => mark(c, c.nextFollowUp)).sort(byUrgency);

    const newUncontacted = live
      .filter((c) => !c.lastContact
        && !everLogged[c.id]
        && c.createdAt && String(c.createdAt).slice(0, 10) >= fourteenDaysAgo)
      .map((c) => mark(c, String(c.createdAt).slice(0, 10))).sort(byUrgency);

    const replied = live
      .filter((c) => c.replyDetectedAt && String(c.replyDetectedAt).slice(0, 10) >= sevenDaysAgo)
      .map((c) => mark(c, String(c.replyDetectedAt).slice(0, 10))).sort(byUrgency);

    const openTasks = tasks
      .filter((t) => t.status !== "Completed" && t.dueDate && t.dueDate <= today)
      .map((t) => Object.assign({}, t, { __due: t.dueDate }))
      .sort((a, b) => (a.__due === b.__due
        ? String(a.title || "").localeCompare(String(b.title || ""))
        : (a.__due < b.__due ? -1 : 1)));

    return [
      { id: "overdue", title: "Overdue follow-ups", kind: "contact", rows: overdue, tone: "danger" },
      { id: "today", title: "Follow-ups due today", kind: "contact", rows: dueTodayRows },
      { id: "new", title: "New, not yet contacted", kind: "contact", rows: newUncontacted },
      { id: "replied", title: "Replied recently", kind: "contact", rows: replied },
      { id: "celebrations", title: "Birthdays & anniversaries (next 7 days)",
        kind: "celebration", rows: celebrations(state, today) },
      { id: "tasks", title: "Tasks due or overdue", kind: "task", rows: openTasks, tone: "danger" }
    ].filter((sec) => sec.rows.length > 0);
  }

  function contactRowHtml(c, today) {
    const due = dueText(c.__due, today);
    const late = c.__due && c.__due < today;
    return `<div class="today-row" data-contact-row="${U().esc(c.id)}">
      <div class="today-row-main">
        <a class="today-row-name link" href="#/contacts/${U().esc(c.id)}">${U().esc(c.name || "Unnamed contact")}</a>
        <div class="today-row-meta">
          <span class="badge badge-neutral">${U().esc(c.stage || "")}</span>
          <span class="badge badge-neutral">${U().esc(c.temperature || "")}</span>
          ${due ? `<span class="${late ? "today-due-late" : "today-due"}">${U().esc(due)}</span>` : ""}
          <span class="today-row-last">${U().esc(lastContactText(c))}</span>
        </div>
      </div>
      ${App.followUp ? App.followUp.barHtml(c) : ""}
    </div>`;
  }

  function taskRowHtml(t, today) {
    const due = dueText(t.__due, today);
    const late = t.__due && t.__due < today;
    return `<div class="today-row">
      <div class="today-row-main">
        <div class="today-row-name">${U().esc(t.title || "Untitled task")}</div>
        <div class="today-row-meta">
          <span class="badge badge-neutral">${U().esc(t.priority || "")} priority</span>
          ${due ? `<span class="${late ? "today-due-late" : "today-due"}">${U().esc(due)}</span>` : ""}
        </div>
      </div>
      <div class="fu-bar">
        <button type="button" class="btn btn-sm" data-today-task="${U().esc(t.id)}">Open task</button>
      </div>
    </div>`;
  }

  function sectionHtml(sec, today, shown) {
    const rows = sec.rows.slice(0, shown);
    const more = sec.rows.length - rows.length;
    return `<section class="card today-section" data-today-section="${U().esc(sec.id)}">
      <div class="card-header">
        <div class="card-title">${U().esc(sec.title)}
          <span class="today-count${sec.tone === "danger" ? " today-count-late" : ""}">${sec.rows.length}</span>
        </div>
      </div>
      <div class="card-body zero">
        ${rows.map((r) => (sec.kind === "task"
            ? taskRowHtml(r, today)
            : (sec.kind === "celebration" ? celebrationRowHtml(r, today) : contactRowHtml(r, today)))).join("")}
        ${more > 0
          ? `<div class="today-more"><button type="button" class="btn btn-sm" data-today-more="${U().esc(sec.id)}">Show ${more} more</button></div>`
          : ""}
      </div>
    </section>`;
  }

  async function renderDaily(container) {
    App.app.setBreadcrumbs([{ label: "Today" }]);
    App.app.setTopActions("");
    await S().ensureLoaded(TODAY_DEPS);

    // How many rows each section is currently showing. "Show more" raises it
    // a page at a time rather than rendering thousands of rows at once.
    const shownBySection = Object.create(null);

    const paint = () => {
      const state = S().getState();
      const today = U().todayISO();
      const sections = todaySections(state);
      const total = sections.reduce((n, sec) => n + sec.rows.length, 0);

      container.innerHTML = `
        <div class="page-header">
          <div>
            <div class="page-title">Today</div>
            <div class="page-desc">${U().esc(U().formatDate(today, "long"))} \u00b7 ${
              total ? "who to contact, and what is due." : "nothing needs you right now."
            }</div>
          </div>
        </div>
        ${sections.length
          ? sections.map((sec) => sectionHtml(sec, today, shownBySection[sec.id] || TODAY_SECTION_CAP)).join("")
          : `<section class="card"><div class="card-body">${
              emptyMessage("You are all caught up",
                "Nothing is overdue and nothing is due today. New leads and follow-ups appear here as they come in.")
            }</div></section>`}`;

      wireGo(container);
      // One delegated listener for every bar on the page, re-attached on
      // each paint because innerHTML replaced the nodes it was bound to.
      if (App.followUp) App.followUp.wireBar(container, { onLogged: () => { paint(); } });
    };

    container.addEventListener("click", (e) => {
      const more = e.target.closest("[data-today-more]");
      if (more) {
        const id = more.getAttribute("data-today-more");
        shownBySection[id] = (shownBySection[id] || TODAY_SECTION_CAP) + TODAY_SECTION_CAP;
        paint();
        return;
      }
      const task = e.target.closest("[data-today-task]");
      if (task && App.pages.tasks) App.pages.tasks.openTaskModal(task.getAttribute("data-today-task"));
    });

    paint();
  }

  // The old Daily View's showing and closing rows went with it in Phase 2B;
  // both were navigation only and are still reachable from Calendar and
  // Pipeline. Marking a milestone complete moved to Deal Detail in Phase 2C
  // (see wireMilestoneCompletion in pages/deals.js), beside the milestone
  // it acts on.

  // ---------- GROWTH LIBRARIES ----------

  // Content Library shows Email Templates (Phase 4B) instead of the
  // legacy Scripts preview — Email Templates has fully replaced Scripts
  // in normal user-facing navigation. The legacy `scripts` table/data are
  // untouched; this only changes what Content Library links to.
  async function renderContent(container) {
    App.app.setBreadcrumbs([{ label: "Content Library" }]);
    App.app.setTopActions("");
    await S().ensureLoaded(["aiPrompts"]);
    const prompts = S().getState().aiPrompts;
    let templates = [];
    let templatesError = null;
    try { templates = await S().messageTemplates.list({ orderBy: "name" }); }
    catch (err) { templatesError = (err && err.message) ? err.message : "Unknown error"; }

    container.innerHTML = `
      <div class="page-header"><div><div class="page-title">Content Library</div><div class="page-desc">Ready-to-customize email templates and AI prompt templates included with your workspace.</div></div></div>
      <div class="stat-row release-stat-grid"><div class="stat-card"><div class="k">Email Templates</div><div class="v">${templates.length}</div></div><div class="stat-card"><div class="k">AI Prompts</div><div class="v">${prompts.length}</div></div></div>
      <div class="release-grid release-grid-2">
        <section class="card"><div class="card-header"><div class="card-title">Email Templates</div><button class="btn btn-sm" data-go="/email-templates">Open library</button></div><div class="card-body">${
          templatesError
            ? emptyMessage("Could not load templates", templatesError)
            : (templates.slice(0, 5).map(renderTemplatePreview).join("") || emptyMessage("No templates yet", "Add a template from the Email Templates page."))
        }</div></section>
        <section class="card"><div class="card-header"><div class="card-title">AI Prompts</div><button class="btn btn-sm" data-go="/prompts">Open library</button></div><div class="card-body">${prompts.slice(0,5).map(renderLibraryPreview).join("") || emptyMessage("No prompts", "Add a prompt from the AI Prompts page.")}</div></section>
      </div>`;
    wireGo(container);
  }

  function renderLibraryPreview(r) {
    return `<div class="release-library-preview"><div><span class="badge badge-neutral">${U().esc(r.category || "General")}</span></div><strong>${U().esc(r.title || "Untitled")}</strong><div>${U().esc(U().truncate(r.body || "", 140))}</div></div>`;
  }

  function renderTemplatePreview(t) {
    const statusBadge = t.is_active ? '<span class="badge badge-success">Active</span>' : '<span class="badge badge-neutral">Inactive</span>';
    return `<div class="release-library-preview"><div>${statusBadge}</div><strong>${U().esc(t.name || "Untitled")}</strong><div>${U().esc(U().truncate(t.subject || "(no subject yet)", 140))}</div></div>`;
  }

  async function renderLibrary(container, type) {
    const isScript = type === "scripts";
    const key = isScript ? "scripts" : "aiPrompts";
    const collection = isScript ? S().scripts : S().aiPrompts;
    const label = isScript ? "Scripts" : "AI Prompts";
    await S().ensureLoaded([key]);
    const records = S().getState()[key].slice().sort((a,b)=>(a.category||"").localeCompare(b.category||"") || (a.title||"").localeCompare(b.title||""));
    App.app.setBreadcrumbs([{ label }]);
    App.app.setTopActions("");
    container.innerHTML = `<div class="page-header"><div><div class="page-title">${label}</div><div class="page-desc">Edit, copy, or add your own reusable ${isScript?'client communication scripts':'AI prompt templates'}.</div></div><div class="page-actions"><button class="btn btn-primary" id="libraryAdd">${App.app.icon("plus")} Add ${isScript?'Script':'Prompt'}</button></div></div><div class="filter-bar"><div class="search-wrap">${App.app.icon("search")}<input id="librarySearch" type="search" placeholder="Search ${label.toLowerCase()}…"></div></div><div class="release-library-grid" id="libraryGrid"></div>`;
    const grid = container.querySelector("#libraryGrid");
    const render = () => {
      const q = (container.querySelector("#librarySearch").value||"").trim().toLowerCase();
      const filtered = records.filter(r => !q || [r.title,r.category,r.body].some(v=>String(v||"").toLowerCase().includes(q)));
      grid.innerHTML = filtered.length ? filtered.map(r => `<article class="card release-library-card" data-id="${U().esc(r.id)}"><div class="card-body"><div><span class="badge badge-neutral">${U().esc(r.category||"General")}</span></div><h3>${U().esc(r.title||"Untitled")}</h3><p>${U().esc(r.body||"")}</p><div class="release-card-actions"><button class="btn btn-sm" data-copy="${U().esc(r.id)}">Copy</button><button class="btn btn-sm" data-edit="${U().esc(r.id)}">Edit</button><button class="btn btn-sm btn-danger" data-delete="${U().esc(r.id)}">Delete</button></div></div></article>`).join("") : emptyMessage(`No ${label.toLowerCase()} found`, q?"Try another search.":"Add your first item.");
    };
    render();
    container.querySelector("#librarySearch").addEventListener("input", render);
    document.getElementById("libraryAdd").addEventListener("click", ()=>openLibraryModal(collection, label, null, () => renderLibrary(container, type)));
    grid.addEventListener("click", async e => {
      const copy=e.target.closest("[data-copy]"), edit=e.target.closest("[data-edit]"), del=e.target.closest("[data-delete]");
      const id=(copy||edit||del)?.getAttribute(copy?'data-copy':edit?'data-edit':'data-delete');
      if (!id) return;
      const rec = records.find(r => r.id === id); if(!rec) return;
      if(copy){ copyText(rec.body||""); return; }
      if(edit){ openLibraryModal(collection,label,rec,() => renderLibrary(container, type)); return; }
      App.app.confirmDialog({title:`Delete ${isScript?'script':'prompt'}?`,message:`Delete “${U().esc(rec.title||'Untitled')}”?`,okLabel:"Delete",danger:true},async ()=>{
        try { await collection.delete(id); App.app.toast("Deleted.","success"); await renderLibrary(container, type); }
        catch (err) { App.app.toast("Could not delete: " + err.message, "danger"); }
      });
    });
  }

  function openLibraryModal(collection, label, rec, rerender) {
    const h=App.app.openModal({title:rec?`Edit ${label.slice(0,-1)}`:`Add ${label.slice(0,-1)}`,body:`<div class="form-grid"><label class="field"><span>Category</span><input id="libCat" value="${U().esc(rec?.category||'Follow-up')}"></label><label class="field full"><span>Title</span><input id="libTitle" value="${U().esc(rec?.title||'')}" required></label><label class="field full"><span>Content</span><textarea id="libBody" rows="9">${U().esc(rec?.body||'')}</textarea></label></div>`,footer:`<button class="btn" data-role="cancel">Cancel</button><button class="btn btn-primary" data-role="save">Save</button>`,onOpen:m=>{m.querySelector('[data-role="cancel"]').onclick=()=>h.close();m.querySelector('[data-role="save"]').onclick=async ()=>{
      const title=m.querySelector('#libTitle').value.trim();
      if(!title){App.app.toast('Title is required.','danger');return;}
      const patch={category:m.querySelector('#libCat').value.trim()||'General',title,body:m.querySelector('#libBody').value};
      const saveBtn = m.querySelector('[data-role="save"]'); saveBtn.disabled = true;
      try {
        if (rec) await collection.update(rec.id, patch); else await collection.create(patch);
        h.close();
        App.app.toast('Saved.','success');
        await rerender();
      } catch (err) {
        App.app.toast('Could not save: ' + err.message, 'danger');
        saveBtn.disabled = false;
      }
    };}});
  }

  function copyText(text){
    if(navigator.clipboard && navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(()=>App.app.toast("Copied to clipboard.","success")).catch(()=>fallbackCopy(text));}
    else fallbackCopy(text);
  }
  function fallbackCopy(text){const ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();try{document.execCommand('copy');App.app.toast('Copied to clipboard.','success');}catch(e){App.app.toast('Copy failed. Select the text manually.','danger');}document.body.removeChild(ta);}

  // ---------- SETTINGS ----------

  // ---------- SETTINGS CENTER ----------
  // Redesigned Settings UI only. Store calls and persistence paths stay the
  // same; this layer only changes how configuration is grouped and presented.
  const SETTINGS_CATEGORIES = [
    { id: "business-profile", label: "Business Profile", icon: "cog", group: "Profile" },
    { id: "pipeline",         label: "Pipeline",         icon: "columns", group: "Workspace" },
    { id: "google-sheets",    label: "Google Sheets",    icon: "grid", group: "Integrations" },
    { id: "sheet-imports",    label: "Import History",   icon: "activity", group: "Integrations" },
    { id: "email-sending",    label: "Email Sending",    icon: "chart", group: "Integrations" },
    { id: "notifications",    label: "Notifications",    icon: "bell", group: "Profile" },
    { id: "data-safety",      label: "Data & Safety",    icon: "save", group: "Advanced" },
    { id: "modules",          label: "Modules",          icon: "spark", group: "Features" },
    { id: "dashboard",        label: "Dashboard",        icon: "chart", group: "Features" },
    { id: "custom-fields",    label: "Custom Fields",    icon: "edit", group: "Advanced" },
    { id: "team-access",      label: "Team & Access",    icon: "users", group: "Workspace" },
    // Only once the workspace is being run as a team: there is nobody to set
    // permissions for before that.
    { id: "team-permissions", label: "What people can do", icon: "lock", group: "Workspace", needsTeam: true }
  ];
  const DEFAULT_SETTINGS_CATEGORY = "overview";
  let _settingsLastSaved = null;
  function _updateLastSaved() { _settingsLastSaved = new Date().toLocaleTimeString(); const el = document.getElementById('settingsLastSaved'); if (el) { el.textContent = 'Last saved at ' + _settingsLastSaved; el.style.display = ''; } }

  async function renderSettings(container, category) {
    App.app.setBreadcrumbs([{ label: "Settings" }]);
    App.app.setTopActions("");
    // A category can arrive with a query attached, e.g.
    // /settings/team-permissions?member=<id>. The tab is chosen by the part
    // before the "?"; the query is handed to the category that understands it.
    const rawCategory = category || "";
    const qAt = rawCategory.indexOf("?");
    const catId = qAt === -1 ? rawCategory : rawCategory.slice(0, qAt);
    const catQuery = qAt === -1 ? "" : rawCategory.slice(qAt + 1);
    const known = SETTINGS_CATEGORIES.some(c => c.id === catId && !c.route);
    const activeCat = known ? catId : DEFAULT_SETTINGS_CATEGORY;

    const groupOrder = ["Profile", "Workspace", "Integrations", "Features", "Advanced"];
    const teamOn = !!(App.customization && App.customization.isTeamMode());
    const canManageTeam = !!(App.workspace && App.workspace.can("team_manage"));
    const navHtml = groupOrder.map(group => {
      const rows = SETTINGS_CATEGORIES.filter(c => c.group === group && (!c.needsTeam || (teamOn && canManageTeam))).map(c => {
        const active = c.id === activeCat;
        const attr = c.route ? `data-settings-route="${U().esc(c.route)}"` : `data-settings-cat="${U().esc(c.id)}"`;
        return `<button type="button" class="settings-nav-item${active?" active":""}" ${attr} aria-current="${active?"page":"false"}">${App.app.icon(c.icon)}${U().esc(c.id === "team-access" && !canManageTeam ? "Workspace membership" : c.label)}</button>`;
      }).join("");
      if (group === "Advanced") return `<details class="settings-nav-section" ${SETTINGS_CATEGORIES.some(c => c.id === activeCat && c.group === "Advanced") ? "open" : ""}><summary class="settings-nav-section-title">Advanced</summary>${rows}</details>`;
      return `<div class="settings-nav-section"><div class="settings-nav-section-title">${group}</div>${rows}</div>`;
    }).join("");

    container.innerHTML = `
      <div class="page-header"><div><div class="page-title">Settings</div><div class="page-desc">Manage your profile and workspace. Open Advanced for custom fields and data safety.</div></div></div>
      <div class="settings-shell">
        <nav class="settings-nav" aria-label="Settings categories">${navHtml}<div class="settings-last-saved" id="settingsLastSaved" style="${_settingsLastSaved?'':'display:none'}">${_settingsLastSaved?'Last saved at '+U().esc(_settingsLastSaved):''}</div></nav>
        <div class="settings-content" id="settingsContent"></div>
      </div>`;

    container.querySelectorAll("[data-settings-cat]").forEach(btn => {
      btn.addEventListener("click", () => {
        const cat = btn.getAttribute("data-settings-cat");
        if (cat !== activeCat) {
          if (_bpDirty && activeCat === "business-profile") {
            if (!confirm("You have unsaved changes in Business Profile. Leave without saving?")) return;
            _bpClearDirty();
          }
          App.app.navigate("/settings/" + cat);
        }
      });
    });
    container.querySelectorAll("[data-settings-route]").forEach(btn => {
      btn.addEventListener("click", () => App.app.navigate(btn.getAttribute("data-settings-route")));
    });

    await renderSettingsCategory(container.querySelector("#settingsContent"), activeCat, catQuery);
  }

  // One value out of a query string, without pulling in a URL parser for it.
  function queryValue(query, key) {
    if (!query) return null;
    const parts = String(query).split("&");
    for (let i = 0; i < parts.length; i++) {
      const eq = parts[i].indexOf("=");
      if (eq === -1 || parts[i].slice(0, eq) !== key) continue;
      try { return decodeURIComponent(parts[i].slice(eq + 1)) || null; }
      catch (e) { return parts[i].slice(eq + 1) || null; }
    }
    return null;
  }

  async function renderSettingsCategory(pane, cat, catQuery) {
    if (!pane) return;
    pane.innerHTML = App.app.loadingHtml ? App.app.loadingHtml() : "";
    if (cat === "overview") renderSettingsOverview(pane);
    else if (cat === "modules") renderModulesCategory(pane);
    else if (cat === "dashboard") renderDashboardCategory(pane);
    else if (cat === "pipeline") { await S().ensureLoaded(["deals"]); await renderPipelineCategory(pane); }
    else if (cat === "custom-fields") { if (App.pages.customFieldsSettings) await App.pages.customFieldsSettings.render(pane); }
    else if (cat === "team-access") { if (App.pages.teamManagement) await App.pages.teamManagement.render(pane); }
    else if (cat === "team-permissions") { if (App.pages.teamPermissions) await App.pages.teamPermissions.render(pane, queryValue(catQuery, "member")); }
    else if (cat === "google-sheets") { if (App.pages.googleSheetsSettings) await App.pages.googleSheetsSettings.render(pane); }
    else if (cat === "sheet-imports") { if (App.pages.googleSheetsImportHistory) await App.pages.googleSheetsImportHistory.render(pane); }
    else if (cat === "email-sending") { if (App.pages.emailSendingSettings) await App.pages.emailSendingSettings.render(pane); }
    else if (cat === "notifications") { if (App.pages.pushSettings) await App.pages.pushSettings.render(pane); }
    else if (cat === "data-safety") renderDataSafetyCategory(pane);
    else renderBusinessProfileCategory(pane);
    wireGo(pane);
  }

  /* ---- Business profile field checks (Phase 2C) ----
   *
   * Both of these are shown inline rather than as a toast: the field is
   * right there, and a toast about a field you can see is worse than a line
   * under it. Nothing is saved while either is wrong, because a half-saved
   * settings bag is harder to explain than a refusal.
   */

  // An optional "+" and one to four digits. That is every real country code
  // (1 to 998), and it rejects the things people actually type by mistake:
  // a whole phone number, "00971", letters, or a bare "+".
  const COUNTRY_CODE_PATTERN = /^\+?[0-9]{1,4}$/;

  function showFieldError(pane, id, message) {
    const el = pane.querySelector("#" + id);
    if (!el) return;
    // textContent, not innerHTML: the message is ours, but the field value
    // it may quote is not.
    el.textContent = message || "";
    el.style.display = message ? "block" : "none";
  }

  function normalizedCountryCode(pane) {
    const raw = (qv(pane, "#setCountryCode") || "").trim();
    if (!raw) return "";
    // Stored with the leading + so it reads back the way it was typed.
    return raw.charAt(0) === "+" ? raw : "+" + raw;
  }

  // Phase 2D. The list comes from the server (realtoros_timezone_names,
  // straight out of pg_timezone_names), so the browser can never offer a
  // zone the database would then refuse. A failed load leaves the field a
  // plain text input rather than blocking the screen - the server validates
  // it either way.
  let timezoneNames = null;

  async function fillTimezoneList(pane) {
    const list = pane.querySelector("#setTimezoneList");
    if (!list) return;
    if (timezoneNames === null) {
      try { timezoneNames = await S().settings.listTimezones(); }
      catch (err) { timezoneNames = []; }
    }
    // One fragment, then one insertion: ~400 option elements appended one
    // at a time is a visible pause on a phone.
    const frag = pane.ownerDocument.createDocumentFragment();
    timezoneNames.forEach((name) => {
      const o = pane.ownerDocument.createElement("option");
      o.value = name;   // value, not innerHTML: these are plain strings
      frag.appendChild(o);
    });
    list.innerHTML = "";
    list.appendChild(frag);
  }

  // Blank means "use what the browser says", which is the right default the
  // first time somebody saves: almost always correct, and they can change
  // it. Falls back to UTC if the browser will not say.
  function resolvedTimezone(pane) {
    const typed = (qv(pane, "#setTimezone") || "").trim();
    if (typed) return typed;
    try {
      const guess = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (guess) return guess;
    } catch (e) { /* no Intl, or no zone: fall through */ }
    return "UTC";
  }

  function validateBusinessProfileFields(pane) {
    let ok = true;
    showFieldError(pane, "setCountryCodeError", "");
    showFieldError(pane, "setReminderHoursError", "");
    showFieldError(pane, "setTimezoneError", "");

    // Only checked when it was typed: a blank field is filled from the
    // browser on save, not rejected. The server validates against
    // pg_timezone_names regardless - this is the early, specific message.
    const zone = (qv(pane, "#setTimezone") || "").trim();
    if (zone && Array.isArray(timezoneNames) && timezoneNames.length
        && timezoneNames.indexOf(zone) === -1) {
      showFieldError(pane, "setTimezoneError",
        "Pick a time zone from the list, like Europe/London or Asia/Dubai.");
      ok = false;
    }

    const code = (qv(pane, "#setCountryCode") || "").trim();
    if (code && !COUNTRY_CODE_PATTERN.test(code)) {
      showFieldError(pane, "setCountryCodeError",
        "Enter a country code: an optional + and 1 to 4 digits, like +971 or 1. Leave it blank to dial numbers exactly as stored.");
      ok = false;
    }

    const hoursRaw = (qv(pane, "#setReminderHours") || "").trim();
    const hours = Number(hoursRaw);
    if (!hoursRaw || !Number.isInteger(hours) || hours < 1 || hours > 72) {
      showFieldError(pane, "setReminderHoursError",
        "Enter a whole number of hours between 1 and 72.");
      ok = false;
    }

    if (!ok) {
      const first = pane.querySelector('.field-error[style*="block"]');
      if (first) {
        const field = first.closest(".field");
        const input = field && field.querySelector("input");
        if (input) input.focus();
      }
    }
    return ok;
  }

  // Phase 2E. The guide has to be reachable after it is dismissed: the one
  // thing worse than a wizard is a wizard you cannot get back.
  function renderSetupGuideRow(pane) {
    const row = pane.querySelector("#settingsReopenGuide");
    if (row) row.addEventListener("click", () => App.pages.onboarding.open(1));
  }

  function renderSettingsOverview(pane) {
    const cards = [
      { id: "business-profile", icon: "cog", title: "Business Profile", desc: "Set your name, brokerage, currency" },
      { id: "pipeline", icon: "columns", title: "Pipeline", desc: "Customize your deal stages" },
      { id: "modules", icon: "spark", title: "Modules", desc: "Choose what appears in your sidebar" },
      { id: "google-sheets", icon: "grid", title: "Google Sheets", desc: "Import leads from a Google Sheet automatically" },
      { id: "sheet-imports", icon: "activity", title: "Import History", desc: "Review Google Sheets and file imports, and fix rejected leads" },
      { id: "email-sending", icon: "chart", title: "Email Sending", desc: "Configure your sender identity and safely test email delivery" },
      { id: "notifications", icon: "bell", title: "Notifications", desc: "Get told on your phone when a lead replies, even with RealtorOS closed" },
      // Not "browser-only" since the Supabase migration: buildExport() in
      // backup.js serialises the loaded workspace state, which is hydrated
      // from the account's cloud tables.
      { id: "data-safety", icon: "save", title: "Backup & Safety", desc: "Export or restore your whole workspace as a JSON file" },
      { id: "custom-fields", icon: "edit", title: "Custom Fields", desc: "Add custom fields to contacts, deals, properties and tasks." }
    ];
    const advanced = cards.filter(c => SETTINGS_CATEGORIES.some(cat => cat.id === c.id && cat.group === "Advanced"));
    const first = ["business-profile", "pipeline", "notifications", "modules"];
    const essential = first.map(id => cards.find(c => c.id === id)).concat(cards.filter(c => !advanced.includes(c) && !first.includes(c.id)));
    const cardHtml = c => `<button type="button" class="settings-overview-card" data-overview-cat="${U().esc(c.id)}"><span class="icon-slot">${App.app.icon(c.icon)}</span><h3>${U().esc(c.title)}</h3><p>${U().esc(c.desc)}</p></button>`;
    pane.innerHTML = `
      <div class="settings-category-head">
        <div class="settings-category-title">Settings Overview</div>
        <p class="form-help">Start with your Business Profile, Pipeline and Notifications. More options are grouped in the Settings menu.</p>
      </div>
      <div class="settings-overview-grid">
        ${essential.map(cardHtml).join("")}
        ${App.pages.onboarding ? `<button type="button" class="settings-overview-card" id="settingsReopenGuide"><span class="icon-slot">${App.app.icon("spark")}</span><h3>Setup Guide</h3><p>Walk through the first-run setup again, or finish what you skipped</p></button>` : ""}
      </div>`;
    pane.insertAdjacentHTML("beforeend", `<details><summary>Advanced: Custom Fields and Backup &amp; Safety</summary><div class="settings-overview-grid">${advanced.map(cardHtml).join("")}</div></details>`);
    pane.querySelectorAll("[data-overview-cat]").forEach(card => card.onclick = () => App.app.navigate("/settings/" + card.getAttribute("data-overview-cat")));
    renderSetupGuideRow(pane);
    // Phase 3A. "Install the app" is a card rather than a settings
    // category: there is nothing to configure, only one button whose
    // wording depends on the browser, and core/pwa.js owns all three
    // versions of it.
    if (App.pwa) {
      const slot = document.createElement("div");
      slot.id = "pwaInstallSlot";
      pane.appendChild(slot);
      App.pwa.renderInstallCard(slot);
    }
  }

  // ---------- BUSINESS PROFILE ----------
  let _bpDirty = false;
  function _bpClearDirty() { _bpDirty = false; }
  function _bpSetDirty(pane, dirty) { _bpDirty = !!dirty; const bar = pane && pane.querySelector('#bpStickySave'); if (bar) bar.style.display = dirty ? 'flex' : 'none'; }

  function renderBusinessProfileCategory(pane) {
    _bpClearDirty();
    const s=S().getState(), st=s.settings, cd=st.commissionDefaults, bp=st.businessProfile||{businessType:null,logoDataUri:null,dateFormat:'MM/DD/YYYY'};
    const BUSINESS_TYPES=[['independent','Independent Realtor'],['broker','Broker'],['agency','Agency'],['team','Team']];
    const DATE_FORMATS=['MM/DD/YYYY','DD/MM/YYYY','YYYY-MM-DD'];
    let pendingLogoDataUri; // undefined = no logo change, string/null = save with sticky bar

    function commPreview(rate, team, broker, referral, tax) {
      return App.commission.netGCI({ salePrice: 500000, commissionRate: rate, teamSplit: team, brokerageFee: broker, referralFee: referral, taxReserve: tax });
    }
    const initPreview = commPreview(cd.commissionRate||0, cd.teamSplit||0, cd.brokerageFee||0, cd.referralFee||0, cd.taxReserve||0);
    function commField(id, label, value) {
      return `<label class="field" data-comm-field="${id}"><span>${U().esc(label)}</span><input type="number" min="0" max="100" step="0.1" id="${id}" value="${U().esc(value)}"><div class="field-error-hint" id="${id}Err">Must be between 0 and 100</div></label>`;
    }

    pane.innerHTML=`
      <div class="settings-category-head">
        <div class="settings-category-title">Business Profile</div>
        <p class="form-help">Set the identity, workspace preferences, branding, and commission defaults used for new deals.</p>
      </div>
      <div id="bpTotalWarning" class="settings-warning-banner" style="display:none">Total splits exceed 100% — please review your defaults.</div>
      <section class="card"><div class="card-body">
        <div class="settings-form-section"><div class="settings-section-title">Identity</div>
        <p class="form-help" style="margin:-4px 0 12px">This is your business identity — the name and details that appear on your deals, reports and branding. It is separate from the account you sign in with, which you change from the profile menu in the top-right.</p>
        <div class="form-grid">
          <label class="field"><span>Agent Name</span><input id="setAgent" value="${U().esc(st.agentName||'')}"></label>
          <label class="field"><span>Agency / Brokerage</span><input id="setAgency" value="${U().esc(st.agencyName||'')}"></label>
          <label class="field"><span>Email</span><input type="email" id="setEmail" value="${U().esc(st.agentEmail||'')}"></label>
          <label class="field"><span>Phone</span><input id="setPhone" value="${U().esc(st.agentPhone||'')}"></label>
        </div></div>
        <div class="settings-form-section"><div class="settings-section-title">Workspace Preferences</div><div class="form-grid">
          <label class="field"><span>Currency</span><select id="setCurrency">${['USD','CAD','GBP','EUR','AUD'].map(x=>`<option ${st.currency===x?'selected':''}>${x}</option>`).join('')}</select></label>
          <label class="field"><span>Default country code</span><input id="setCountryCode" maxlength="5" inputmode="tel" placeholder="e.g. +971" value="${U().esc(st.defaultCountryCode || '')}" aria-describedby="setCountryCodeHelp">
            <span class="form-help" id="setCountryCodeHelp">Used when a contact's phone number has no country code, so Call, Text and WhatsApp still reach them. Leave blank to dial numbers exactly as they are stored.</span>
            <span class="field-error" id="setCountryCodeError" role="alert" style="display:none;color:var(--danger)"></span>
          </label>
          <label class="field"><span>Time zone</span>
            <input id="setTimezone" list="setTimezoneList" maxlength="64" placeholder="e.g. Asia/Dubai" value="${U().esc(st.timezone || '')}" aria-describedby="setTimezoneHelp">
            <datalist id="setTimezoneList"></datalist>
            <span class="form-help" id="setTimezoneHelp">Used to decide what counts as "today" for your daily reminders, and when birthday and anniversary messages go out. Start typing a city.</span>
            <span class="field-error" id="setTimezoneError" role="alert" style="display:none;color:var(--danger)"></span>
          </label>
          <label class="field"><span>Remind me if a new contact isn't contacted within</span>
            <span style="display:flex;align-items:center;gap:8px">
              <input id="setReminderHours" type="number" min="1" max="72" step="1" style="max-width:6rem" value="${U().esc(st.followUpReminderHours == null ? 4 : st.followUpReminderHours)}" aria-describedby="setReminderHoursHelp">
              <span>hours</span>
            </span>
            <span class="form-help" id="setReminderHoursHelp">You get a reminder about a new lead nobody has contacted yet. If it is still untouched after a day, whoever manages the team is told too.</span>
            <span class="field-error" id="setReminderHoursError" role="alert" style="display:none;color:var(--danger)"></span>
          </label>
          <label class="field"><span>Business Type</span><select id="setBizType"><option value="">Not set</option>${BUSINESS_TYPES.map(([v,l])=>`<option value="${v}" ${bp.businessType===v?'selected':''}>${l}</option>`).join('')}</select></label>
          <label class="field"><span>Date Format</span><select id="setDateFormat">${DATE_FORMATS.map(f=>`<option ${bp.dateFormat===f?'selected':''}>${f}</option>`).join('')}</select></label>
        </div></div>
        <div class="settings-form-section"><div class="settings-section-title">Branding</div>
          <div class="field"><span>Logo Upload</span><div style="display:flex;align-items:center;gap:10px;margin-top:6px">
            <img id="setLogoPreview" src="${U().esc(bp.logoDataUri||'')}" alt="" style="height:44px;width:44px;object-fit:contain;border:1px solid var(--border);border-radius: var(--radius);background:var(--card);display:${bp.logoDataUri?'block':'none'}">
            <input type="file" id="setLogoFile" accept="image/*" class="sr-only">
            <button class="btn btn-sm" id="setLogoChoose" type="button">${bp.logoDataUri?'Replace Logo':'Upload Logo'}</button>
            <button class="btn btn-sm" id="setLogoClear" type="button" style="display:${bp.logoDataUri?'inline-flex':'none'}">Remove</button>
          </div><div class="form-help">PNG/JPG recommended · Smaller files load faster</div></div>
        </div>
        <div class="settings-form-section"><div class="settings-section-title">Commission Defaults</div><div class="form-grid">
          ${commField('setRate','Commission Rate %',cd.commissionRate)}${commField('setTeam','Team Split %',cd.teamSplit)}${commField('setBroker','Brokerage Fee %',cd.brokerageFee)}${commField('setReferral','Referral Fee %',cd.referralFee)}${commField('setTax','Tax Reserve %',cd.taxReserve)}
        </div><p class="form-help">Defaults apply to new deals only</p>
        <div class="commission-preview-card" id="commPreview">On a $500,000 deal — estimated take-home: <span class="preview-amount" id="commPreviewAmt">${U().formatCurrency(initPreview, st.currency)}</span></div></div>
        <div class="settings-save-bar" id="bpStickySave"><strong>Unsaved changes</strong><span style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" id="cancelBP" type="button">Cancel</button><button class="btn btn-primary" id="saveAllBP" type="button">Save Changes</button></span></div>
      </div></section>`;

    pane.querySelectorAll('input, select').forEach(el => el.addEventListener('input', () => _bpSetDirty(pane, true)));
    pane.querySelectorAll('select').forEach(el => el.addEventListener('change', () => _bpSetDirty(pane, true)));

    function updatePreview() {
      const r = parseFloat(pane.querySelector('#setRate').value)||0;
      const t = parseFloat(pane.querySelector('#setTeam').value)||0;
      const b = parseFloat(pane.querySelector('#setBroker').value)||0;
      const ref = parseFloat(pane.querySelector('#setReferral').value)||0;
      const tax = parseFloat(pane.querySelector('#setTax').value)||0;
      const amt = commPreview(r, t, b, ref, tax);
      const el = pane.querySelector('#commPreviewAmt'); if (el) el.textContent = U().formatCurrency(amt, pane.querySelector('#setCurrency').value || st.currency);
      [['setRate',r],['setTeam',t],['setBroker',b],['setReferral',ref],['setTax',tax]].forEach(([id,v]) => {
        const err = pane.querySelector('#'+id+'Err'); const field = pane.querySelector('[data-comm-field="'+id+'"]');
        if (v > 100 || v < 0) { if(err) err.classList.add('visible'); if(field) field.classList.add('has-field-error'); }
        else { if(err) err.classList.remove('visible'); if(field) field.classList.remove('has-field-error'); }
      });
      const total = r + t + b + ref + tax; const warn = pane.querySelector('#bpTotalWarning'); if (warn) warn.style.display = total > 100 ? '' : 'none';
    }
    ['setRate','setTeam','setBroker','setReferral','setTax','setCurrency'].forEach(id => { const el = pane.querySelector('#'+id); if (el) el.addEventListener('input', updatePreview); if (el) el.addEventListener('change', updatePreview); });
    // Phase 2D: populate the zone list once the pane exists. Deliberately
    // not awaited - the field works as a text input while it loads.
    fillTimezoneList(pane);

    pane.querySelector('#cancelBP').onclick=()=>renderBusinessProfileCategory(pane);
    pane.querySelector('#saveAllBP').onclick=async ()=>{
      const btn = pane.querySelector('#saveAllBP'); const cancelBtn = pane.querySelector('#cancelBP');
      btn.disabled = true; if (cancelBtn) cancelBtn.disabled = true; const orig = btn.textContent; btn.textContent = 'Saving…';
      try {
        if (!validateBusinessProfileFields(pane)) return;
        await S().settings.update({agentName:qv(pane,'#setAgent'),agencyName:qv(pane,'#setAgency'),agentEmail:qv(pane,'#setEmail'),agentPhone:qv(pane,'#setPhone'),currency:qv(pane,'#setCurrency'),defaultCountryCode:normalizedCountryCode(pane),followUpReminderHours:Number(qv(pane,'#setReminderHours')),timezone:resolvedTimezone(pane)});
        const bpPatch={businessType:pane.querySelector('#setBizType').value||null,dateFormat:pane.querySelector('#setDateFormat').value};
        if (pendingLogoDataUri !== undefined) bpPatch.logoDataUri = pendingLogoDataUri;
        const bpRes=await S().settings.updateBusinessProfile(bpPatch);
        if (!bpRes || !bpRes.ok) throw new Error((bpRes&&bpRes.error)||'Could not save business profile.');
        await S().settings.updateCommissionDefaults({commissionRate:nv(pane,'#setRate'),teamSplit:nv(pane,'#setTeam'),brokerageFee:nv(pane,'#setBroker'),referralFee:nv(pane,'#setReferral'),taxReserve:nv(pane,'#setTax')});
        App.app.toast('Business profile saved.','success');
        _bpSetDirty(pane, false);
        _updateLastSaved();
      } catch (err) {
        App.app.toast(err.message || 'Could not save.','danger');
      } finally {
        btn.disabled = false; if (cancelBtn) cancelBtn.disabled = false; btn.textContent = orig;
      }
    };
    function setLogoPreview(value) {
      const img = pane.querySelector('#setLogoPreview');
      const choose = pane.querySelector('#setLogoChoose');
      const clear = pane.querySelector('#setLogoClear');
      if (img) { img.src = value || ''; img.style.display = value ? 'block' : 'none'; }
      if (choose) choose.textContent = value ? 'Replace Logo' : 'Upload Logo';
      if (clear) clear.style.display = value ? 'inline-flex' : 'none';
    }
    const logoFile=pane.querySelector('#setLogoFile'); const logoChoose=pane.querySelector('#setLogoChoose'); if(logoChoose) logoChoose.onclick=()=>logoFile.click();
    if(logoFile) logoFile.onchange=()=>{ const f=logoFile.files&&logoFile.files[0]; if(!f) return; if(!/^image\//.test(f.type)){ App.app.toast('Choose an image file.','danger'); return; } const reader=new FileReader(); reader.onload=()=>{ const nextLogo=String(reader.result||''); const max=S().settings.LOGO_MAX_BYTES || 220000; if(nextLogo && nextLogo.length > max){ App.app.toast('Logo is too large. Choose an image under ~150 KB.','danger'); return; } pendingLogoDataUri=nextLogo; setLogoPreview(pendingLogoDataUri); _bpSetDirty(pane, true); App.app.toast('Logo ready. Click Save Changes to apply.','success'); }; reader.onerror=()=>App.app.toast('Could not read that image file.','danger'); reader.readAsDataURL(f); };
    const logoClear=pane.querySelector('#setLogoClear'); if(logoClear) logoClear.onclick=()=>{ pendingLogoDataUri=null; setLogoPreview(null); _bpSetDirty(pane, true); };
  }

  // ---------- MODULES ----------
  // Settings > Modules. Same two-card Visible/Hidden shape as Settings >
  // Dashboard, so the two screens behave identically.
  //
  // Note this screen keeps its explicit Save model (unsaved banner + Save
  // Changes), unlike Dashboard which persists on every toggle. Toggling here
  // moves the card immediately but does not write until Save, so the banner
  // is what tells you the two have diverged.
  function renderModulesCategory(root) {
    const cust = App.customization; if (!cust) { root.innerHTML = ""; return; }
    const widgetsByModule = {};
    cust.WIDGETS.forEach(w => { if (w.requiresModule) (widgetsByModule[w.requiresModule] = widgetsByModule[w.requiresModule] || []).push(w.label); });

    // Flattened, each module carrying the sidebar group it belongs to. The
    // group travels as a tag on the row rather than as a heading: grouping by
    // section and splitting by visibility are two different hierarchies, and
    // nesting one inside the other fragments a ~20-item list into a dozen
    // near-empty headings.
    const mods = App.app.moduleCatalog();

    const modRow = (m) => {
      const locked = cust.isModuleLocked(m.id);
      const enabled = cust.isModuleEnabled(m.id);
      const deps = widgetsByModule[m.id];
      const hint = deps && deps.length ? ` <span class="settings-help-icon" title="${U().esc("Also hides: " + deps.join(", "))}">?</span>` : "";
      const control = locked
        ? `<span class="split-row-lock" title="Required module — always on" aria-label="Required module, always on">${App.app.icon("lock")}</span>`
        : `<label class="toggle-switch" title="${enabled ? "Enabled" : "Disabled"}">
             <input type="checkbox" class="cust-mod" data-mod="${U().esc(m.id)}" ${enabled ? "checked" : ""}>
             <span class="toggle-track"></span>
           </label>`;
      const sub = locked ? "Core module · Always on" : (enabled ? "Shown in sidebar" : "Hidden from sidebar · Data preserved");
      return `<div class="split-row" data-mod-row="${U().esc(m.id)}" data-locked="${locked ? "1" : "0"}">
        <div class="split-row-main">
          <span class="split-row-icon" aria-hidden="true">${App.app.icon(m.icon)}</span>
          <div class="split-row-label">
            <strong>${U().esc(m.label)}</strong>
            <div class="module-group-tag">${U().esc(m.group)}</div>
            <div class="form-help" data-mod-sub>${sub}${hint}</div>
          </div>
        </div>
        ${control}
      </div>`;
    };

    const shown = mods.filter(m => cust.isModuleLocked(m.id) || cust.isModuleEnabled(m.id));
    const hiddenMods = mods.filter(m => !cust.isModuleLocked(m.id) && !cust.isModuleEnabled(m.id));
    const column = (key, label, cls, rows) => `
      <section class="card split-col" data-col="${key}">
        <div class="card-header">
          <span class="group-pill ${cls}">${label} <span data-count="${key}">${rows.length}</span></span>
        </div>
        <div class="card-body zero split-list" data-list="${key}">
          ${rows.length ? rows.map(modRow).join("") : `<p class="split-empty" data-empty="${key}">No ${key} modules.</p>`}
        </div>
      </section>`;

    root.innerHTML = `
      <div class="settings-category-head">
        <div class="settings-category-title">Modules</div>
        <p class="form-help">Toggle a module to move it between Shown and Hidden, then save. Required modules cannot be turned off.</p>
      </div>
      <div class="unsaved-banner" id="modUnsaved" style="display:none">You have unsaved module changes<button class="btn btn-primary btn-sm" id="modUnsavedSave">Save Changes</button></div>
      <input type="text" class="module-filter-input" id="modFilter" placeholder="Filter modules…">
      <div class="split-columns">
        ${column("shown", "Shown", "group-pill-on", shown)}
        ${column("hidden", "Hidden", "group-pill-off", hiddenMods)}
      </div>
      <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn btn-primary" id="saveModules">Save Changes</button>
        <button class="btn" id="resetModules">Reset Modules to Default</button>
      </div>`;

    const listOf = key => root.querySelector(`[data-list="${key}"]`);

    // Counts and empty placeholders are read back off the live DOM so they stay
    // right after a row moves without a re-render.
    function refreshColumns() {
      ["shown", "hidden"].forEach(key => {
        const list = listOf(key);
        if (!list) return;
        const n = list.querySelectorAll("[data-mod-row]").length;
        const countEl = root.querySelector(`[data-count="${key}"]`);
        if (countEl) countEl.textContent = String(n);
        const empty = list.querySelector(`[data-empty="${key}"]`);
        if (n === 0 && !empty) {
          const ph = document.createElement("p");
          ph.className = "split-empty";
          ph.setAttribute("data-empty", key);
          ph.textContent = "No " + key + " modules.";
          list.appendChild(ph);
        } else if (n > 0 && empty) empty.remove();
      });
    }

    const modFilterEl = root.querySelector("#modFilter");
    if (modFilterEl) modFilterEl.addEventListener("input", () => {
      const q = modFilterEl.value.toLowerCase();
      root.querySelectorAll("[data-mod-row]").forEach(row => {
        const name = (row.querySelector("strong") || {}).textContent || "";
        row.style.display = name.toLowerCase().includes(q) ? "" : "none";
      });
    });

    // Toggling relocates the row to the bottom of the opposite column, matching
    // Settings > Dashboard. Bound to .split-columns rather than root because
    // this function re-renders into root without replacing it, so a listener on
    // root would stack one more copy per re-render.
    const MOVE_MS = 180;
    const modUnsavedEl = root.querySelector("#modUnsaved");
    const columnsEl = root.querySelector(".split-columns");
    if (columnsEl) columnsEl.addEventListener("change", (ev) => {
      const cb = ev.target.closest && ev.target.closest(".cust-mod");
      if (!cb) return;
      const row = cb.closest("[data-mod-row]");
      const list = listOf(cb.checked ? "shown" : "hidden");
      if (!row || !list) return;
      if (modUnsavedEl) modUnsavedEl.style.display = "";

      const label = row.querySelector(".toggle-switch");
      if (label) label.title = cb.checked ? "Enabled" : "Disabled";
      const sub = row.querySelector("[data-mod-sub]");
      if (sub) {
        const hint = sub.querySelector(".settings-help-icon");
        sub.textContent = cb.checked ? "Shown in sidebar" : "Hidden from sidebar · Data preserved";
        if (hint) { sub.appendChild(document.createTextNode(" ")); sub.appendChild(hint); }
      }

      row.classList.add("is-leaving");
      window.setTimeout(() => {
        const empty = list.querySelector("[data-empty]");
        if (empty) empty.remove();
        list.appendChild(row);
        row.classList.remove("is-leaving");
        row.classList.add("is-entering");
        // Force a layout pass so the entering offset paints before the class
        // comes off, otherwise both states coalesce and nothing animates.
        void row.offsetWidth;
        row.classList.remove("is-entering");
        refreshColumns();
      }, MOVE_MS);
    });

    const modUnsavedSave = root.querySelector("#modUnsavedSave");
    if (modUnsavedSave) modUnsavedSave.onclick = () => root.querySelector("#saveModules").click();

    root.querySelector("#saveModules").onclick = async () => {
      const btn = root.querySelector("#saveModules"); btn.disabled = true;
      const patch = {};
      root.querySelectorAll(".cust-mod").forEach(cb => {
        const id = cb.getAttribute("data-mod");
        if (!cust.isModuleLocked(id)) patch[id] = cb.checked;
      });
      try {
        await S().settings.updateEnabledModules(patch);
        App.app.refreshNav();
        App.app.toast("Workspace updated.", "success");
        _updateLastSaved();
        renderModulesCategory(root);
      } catch (err) {
        App.app.toast("Could not save: " + err.message, "danger");
        btn.disabled = false;
      }
    };

    root.querySelector("#resetModules").onclick = () => {
      App.app.confirmDialog({
        title: "Reset modules to default?",
        message: "This resets enabled modules only. Records and dashboard settings are preserved.",
        okLabel: "Reset modules"
      }, async () => {
        try {
          await S().settings.resetEnabledModules();
          App.app.refreshNav();
          App.app.toast("Modules reset to default.", "success");
          renderModulesCategory(root);
        } catch (err) {
          App.app.toast("Reset failed: " + err.message, "danger");
        }
      });
    };

    refreshColumns();
  }

  // ---------- DASHBOARD ----------
  // Settings > Dashboard. Two cards, one per visibility state: a widget's
  // state is its position, not something you decode from a switch. Toggling
  // relocates the row between cards; dragging only reorders inside one.
  function renderDashboardCategory(root) {
    const cust = App.customization; if (!cust) { root.innerHTML = ""; return; }
    const cfg = cust.getConfig();
    const orderedWidgets = cust.WIDGETS.slice()
      .sort((a, b) => ((cfg.dashboardWidgets[a.id] || {}).order || 999) - ((cfg.dashboardWidgets[b.id] || {}).order || 999));
    const isVisible = w => (cfg.dashboardWidgets[w.id] || { visible: true }).visible !== false;

    const widgetRow = (w) => {
      const depMissing = w.requiresModule && !cust.isModuleEnabled(w.requiresModule);
      const depTag = depMissing
        ? `<span class="badge badge-compact" style="background:var(--danger-soft);color:var(--danger)">Needs module</span>` : "";
      const sub = depMissing ? "Hidden until supporting module is enabled" : "Drag to reorder";
      return `<div class="split-row" data-widget-row="${U().esc(w.id)}" draggable="true">
        <div class="split-row-main">
          <span class="drag-handle" aria-hidden="true">&#9776;</span>
          <div class="split-row-label">
            <strong>${U().esc(w.label)}</strong> ${depTag}
            <div class="form-help">${sub}<span class="settings-help-icon" title="${U().esc(w.description || '')}">?</span></div>
          </div>
        </div>
        <label class="toggle-switch" title="${isVisible(w) ? 'Visible' : 'Hidden'}">
          <input type="checkbox" class="cust-widget" data-widget="${U().esc(w.id)}" ${isVisible(w) ? "checked" : ""}>
          <span class="toggle-track"></span>
        </label>
      </div>`;
    };

    const visible = orderedWidgets.filter(isVisible);
    const hidden  = orderedWidgets.filter(w => !isVisible(w));
    const column = (key, label, cls, rows) => `
      <section class="card split-col" data-col="${key}">
        <div class="card-header">
          <span class="group-pill ${cls}">${label} <span data-count="${key}">${rows.length}</span></span>
        </div>
        <div class="card-body zero split-list" data-list="${key}">
          ${rows.length ? rows.map(widgetRow).join("") : `<p class="split-empty" data-empty="${key}">No ${key} widgets.</p>`}
        </div>
      </section>`;

    root.innerHTML = `
      <div class="settings-category-head">
        <div class="settings-category-title">Dashboard</div>
        <p class="form-help">Toggle a widget to move it between Visible and Hidden. Drag to reorder within a list.</p>
      </div>
      <div class="split-columns">
        ${column("visible", "Visible", "group-pill-on", visible)}
        ${column("hidden", "Hidden", "group-pill-off", hidden)}
      </div>
      <div style="margin-top:16px"><button class="btn" id="resetDashboard">Restore Default Dashboard</button></div>`;

    const listOf = key => root.querySelector(`[data-list="${key}"]`);

    // Counts and empty-state placeholders derive from the live DOM, so they
    // stay correct after a row is moved without a full re-render.
    function refreshColumns() {
      ["visible", "hidden"].forEach(key => {
        const list = listOf(key);
        if (!list) return;
        const n = list.querySelectorAll("[data-widget-row]").length;
        const countEl = root.querySelector(`[data-count="${key}"]`);
        if (countEl) countEl.textContent = String(n);
        const empty = list.querySelector(`[data-empty="${key}"]`);
        if (n === 0 && !empty) {
          const ph = document.createElement("p");
          ph.className = "split-empty";
          ph.setAttribute("data-empty", key);
          ph.textContent = "No " + key + " widgets.";
          list.appendChild(ph);
        } else if (n > 0 && empty) empty.remove();
      });
    }

    // Persists the full order as [visible in DOM order, then hidden], so the
    // dashboard renders visible widgets in exactly the sequence shown here.
    function orderPatch() {
      const ids = [];
      ["visible", "hidden"].forEach(key => {
        const list = listOf(key);
        if (list) list.querySelectorAll("[data-widget-row]").forEach(r => ids.push(r.getAttribute("data-widget-row")));
      });
      const patch = {};
      const live = cust.getConfig().dashboardWidgets;
      ids.forEach((wid, idx) => { patch[wid] = Object.assign({}, live[wid], { order: idx + 1 }); });
      return patch;
    }

    root.querySelector("#resetDashboard").onclick = () => {
      App.app.confirmDialog({
        title: "Restore default dashboard?",
        message: "This will reset widget order and visibility. Nothing else in your workspace changes.",
        okLabel: "Restore defaults"
      }, async () => {
        try { await S().settings.resetDashboardWidgets(); App.app.toast("Dashboard restored to default.", "success"); renderDashboardCategory(root); }
        catch (err) { App.app.toast("Reset failed: " + err.message, "danger"); }
      });
    };

    // Toggling relocates the row to the BOTTOM of the opposite column. The
    // node is moved rather than re-rendered, so the transition is visible and
    // the row's drag bindings survive the move.
    //
    // The listener goes on .split-columns, NOT on root: this function
    // re-renders by replacing root's innerHTML while root itself persists, so
    // binding to root would stack one more listener on every re-render and
    // fire a duplicate save per toggle. .split-columns is rebuilt each time.
    const MOVE_MS = 180;
    const columnsEl = root.querySelector(".split-columns");
    if (columnsEl) columnsEl.addEventListener("change", (ev) => {
      const cb = ev.target.closest && ev.target.closest(".cust-widget");
      if (!cb) return;
      const row = cb.closest("[data-widget-row]");
      const id = cb.getAttribute("data-widget");
      const list = listOf(cb.checked ? "visible" : "hidden");
      if (!row || !list) return;

      const label = row.querySelector(".toggle-switch");
      if (label) label.title = cb.checked ? "Visible" : "Hidden";

      row.classList.add("is-leaving");
      window.setTimeout(async () => {
        const empty = list.querySelector("[data-empty]");
        if (empty) empty.remove();
        list.appendChild(row);
        row.classList.remove("is-leaving");
        row.classList.add("is-entering");
        // Force a layout pass so the entering offset actually paints before
        // the class comes off; without it the browser coalesces both states
        // and no transition runs.
        void row.offsetWidth;
        row.classList.remove("is-entering");
        refreshColumns();

        // Ordering is read from the DOM, so it must be computed after the
        // move — reading it before would persist the row's old position.
        const patch = orderPatch();
        patch[id] = Object.assign({}, patch[id], { visible: cb.checked });
        try { await S().settings.updateDashboardWidgets(patch); }
        catch (err) {
          App.app.toast("Could not save: " + err.message, "danger");
          renderDashboardCategory(root);   // resync from stored truth
        }
      }, MOVE_MS);
    });

    // Drag reorder, constrained to one column. A drop whose source and target
    // sit in different lists is ignored: visibility is the toggle's job, and
    // letting a drag change it too would give the row's position and the
    // switch two ways to say the same thing, free to disagree.
    // The dragged NODE is held directly rather than its id: the id would have
    // to be fed back through a selector, and this codebase deliberately avoids
    // CSS.escape (see custom-fields-settings.js) for browser-support reasons.
    let dragRow = null;
    root.querySelectorAll("[data-widget-row]").forEach(row => {
      row.addEventListener("dragstart", e => {
        dragRow = row;
        row.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
      });
      row.addEventListener("dragend", () => { row.classList.remove("dragging"); dragRow = null; });
      row.addEventListener("dragover", e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; });
      row.addEventListener("drop", async e => {
        e.preventDefault();
        const source = dragRow;
        if (!source || source === row) return;
        if (source.parentElement !== row.parentElement) return;   // cross-column drag: ignored
        const rowIsAfter = source.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING;
        row.parentElement.insertBefore(source, rowIsAfter ? row.nextSibling : row);
        refreshColumns();
        try { await S().settings.updateDashboardWidgets(orderPatch()); }
        catch (err) { App.app.toast("Could not save order: " + err.message, "danger"); renderDashboardCategory(root); }
      });
    });

    refreshColumns();
  }

  // ---------- PIPELINE ----------
  async function renderPipelineCategory(root) {
    const s = S().getState(); const stages = s.settings.pipelineStages.slice().sort((a,b) => a.order - b.order);
    const rows = (await Promise.all(stages.map(async st => {
      const usage = await S().settings.countDealsInStage(st.id);
      return `<div class="stage-compact-row" draggable="true" data-stage-row="${U().esc(st.id)}"><div class="stage-compact-main"><span class="drag-handle" title="Drag to reorder">☰</span><span class="stage-dot" style="background:${U().esc(st.color)};display:inline-block;width:12px;height:12px;border-radius:50%;flex-shrink:0"></span><span class="stage-compact-name">${U().esc(st.name)}</span><button class="btn btn-sm btn-ghost stage-deal-link" data-deal-link>${usage} deal${usage===1?'':'s'}</button></div><div class="stage-compact-actions"><button class="btn btn-sm" data-stage-edit="${U().esc(st.id)}">Edit</button></div></div>`;
    }))).join("");
    root.innerHTML = `<div class="settings-category-head"><div class="settings-category-title">Pipeline</div><p class="form-help">Compact stage list · Edit opens advanced controls.</p></div><div class="card"><div class="card-header"><div class="card-title">Deal Stages</div><button class="btn btn-primary btn-sm" id="addStageBtn">+ Add Stage</button></div><div class="card-body zero"><div id="stageList">${rows}</div></div></div>`;
    root.querySelectorAll("[data-deal-link]").forEach(el => el.addEventListener("click", () => App.app.navigate("/pipeline")));
    root.querySelectorAll("[data-stage-edit]").forEach(b => b.addEventListener("click", () => openStageEditModal(root, b.getAttribute("data-stage-edit"))));
    root.querySelector("#addStageBtn").onclick = () => openAddStageModal(root);
    let dragId = null; root.querySelectorAll("[data-stage-row]").forEach(row => { row.addEventListener("dragstart", e => { dragId = row.getAttribute("data-stage-row"); row.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; }); row.addEventListener("dragend", () => { row.classList.remove("dragging"); dragId = null; }); row.addEventListener("dragover", e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }); row.addEventListener("drop", async e => {
      e.preventDefault(); const targetId = row.getAttribute("data-stage-row"); if (!dragId || dragId === targetId) return; const ids = S().getState().settings.pipelineStages.slice().sort((a,b)=>a.order-b.order).map(x=>x.id); const from = ids.indexOf(dragId), to = ids.indexOf(targetId); if (from < 0 || to < 0) return; ids.splice(from,1); ids.splice(to,0,dragId);
      try {
        const next = await S().settings.reorderPipelineStages(ids);
        if (!next) { App.app.toast("Could not reorder stages.", "danger"); return; }
        App.app.toast("Stage order updated.", "success"); _updateLastSaved(); await renderPipelineCategory(root);
      } catch (err) { App.app.toast("Could not reorder stages: " + err.message, "danger"); }
    }); });
  }

  function stageColorChoices(selected) {
    const colors = ["#94A3B8","#60A5FA","#818CF8","#A78BFA","#F59E0B","#10B981","#EF4444","#EC4899"];
    return `<div class="color-swatch-grid" id="stageColorGrid">${colors.map(c => `<span class="color-swatch${c.toLowerCase()===(selected||'').toLowerCase()?' selected':''}" data-color="${U().esc(c)}" style="background:${U().esc(c)}" title="${U().esc(c)}"></span>`).join('')}</div>`;
  }
  function bindColorGrid(root) { root.querySelectorAll("#stageColorGrid .color-swatch").forEach(sw => sw.addEventListener("click", () => { root.querySelectorAll("#stageColorGrid .color-swatch").forEach(x => x.classList.remove("selected")); sw.classList.add("selected"); })); }

  function openStageEditModal(root, stageId) {
    const stage = S().getState().settings.pipelineStages.find(x => x.id === stageId); if (!stage) return;
    const usagePromise = S().settings.countDealsInStage(stageId); const isDefault = S().getState().settings.defaultStageId === stageId;
    usagePromise.then(usage => {
    const h = App.app.openModal({ title: "Edit Pipeline Stage", body: `<div class="form-grid"><label class="field"><span>Stage Name</span><input id="stageEditName" value="${U().esc(stage.name)}"></label><label class="field"><span>Close probability %</span><input id="stageEditProb" type="number" min="0" max="100" step="1" value="${U().esc(stage.probability)}"></label><div class="field"><span>Color</span>${stageColorChoices(stage.color)}</div><label class="field"><span>Stage outcome</span><select id="stageEditTerminal"><option value="" ${!stage.terminal?'selected':''}>In progress</option><option value="won" ${stage.terminal==='won'?'selected':''}>Deal won (closed)</option><option value="lost" ${stage.terminal==='lost'?'selected':''}>Deal lost</option></select></label><label class="field full" style="flex-direction:row;align-items:center;gap:8px"><input type="checkbox" id="stageEditDefault" ${isDefault?'checked':''}> <span style="text-transform:none;letter-spacing:0;font-size: var(--font-size-sm)">Use as default stage for new deals</span></label></div><div class="release-callout" style="margin-top:14px">${usage} deal${usage===1?'':'s'} currently in this stage.</div>`, footer: `<button class="btn btn-danger" data-role="delete">Delete</button><span style="flex:1"></span><button class="btn" data-role="cancel">Cancel</button><button class="btn btn-primary" data-role="save">Save Changes</button>`, onOpen: m => { bindColorGrid(m); m.querySelector('[data-role="cancel"]').onclick = () => h.close(); m.querySelector('[data-role="delete"]').onclick = () => { h.close(); deleteStageFlow(root, stageId); }; m.querySelector('[data-role="save"]').onclick = async () => {
      const name = m.querySelector('#stageEditName').value.trim(); if (!name) { App.app.toast('Stage name is required.', 'danger'); return; }
      const saveBtn = m.querySelector('[data-role="save"]'); saveBtn.disabled = true;
      try {
        const curState = S().getState();
        if (curState.settings.pipelineStages.some(x => x.id !== stageId && x.name.toLowerCase() === name.toLowerCase())) { App.app.toast('Another stage already uses that name.', 'danger'); saveBtn.disabled = false; return; }
        if (name !== (curState.settings.pipelineStages.find(x=>x.id===stageId)||{}).name) {
          const renamed = await S().settings.renamePipelineStage(stageId, name);
          if (!renamed) { App.app.toast('Could not rename stage.', 'danger'); saveBtn.disabled = false; return; }
        }
        const color = (m.querySelector('#stageColorGrid .color-swatch.selected')||{}).getAttribute ? m.querySelector('#stageColorGrid .color-swatch.selected').getAttribute('data-color') : stage.color;
        const probability = U().clamp(m.querySelector('#stageEditProb').value, 0, 100);
        const updatedStages = S().getState().settings.pipelineStages.map(x => x.id === stageId ? Object.assign({}, x, { probability, color }) : x);
        await S().settings.update({ pipelineStages: updatedStages });
        await S().settings.setStageTerminal(stageId, m.querySelector('#stageEditTerminal').value || null);
        if (m.querySelector('#stageEditDefault').checked) await S().settings.setDefaultStage(stageId);
        h.close(); App.app.toast('Stage updated.', 'success'); _updateLastSaved(); await renderPipelineCategory(root);
      } catch (err) {
        App.app.toast('Could not save stage: ' + err.message, 'danger');
        saveBtn.disabled = false;
      }
    }; } });
    }).catch(err => App.app.toast("Could not load stage usage: " + err.message, "danger"));
  }

  function openAddStageModal(root) {
    const h = App.app.openModal({ title: "Add Pipeline Stage", body: `<div class="form-grid"><label class="field"><span>Stage Name</span><input id="newStageName" placeholder="e.g. Property Visit"></label><label class="field"><span>Close probability %</span><input id="newStageProb" type="number" min="0" max="100" step="1" value="10"></label><div class="field full"><span>Color</span>${stageColorChoices('#94A3B8')}</div></div>`, footer: `<button class="btn" data-role="cancel">Cancel</button><button class="btn btn-primary" data-role="save">Add Stage</button>`, onOpen: m => { bindColorGrid(m); m.querySelector('[data-role="cancel"]').onclick = () => h.close(); m.querySelector('[data-role="save"]').onclick = async () => {
      const name = m.querySelector('#newStageName').value.trim(); if (!name) { App.app.toast('Enter a name for the new stage.', 'danger'); return; }
      const saveBtn = m.querySelector('[data-role="save"]'); saveBtn.disabled = true;
      const color = (m.querySelector('#stageColorGrid .color-swatch.selected')||{}).getAttribute ? m.querySelector('#stageColorGrid .color-swatch.selected').getAttribute('data-color') : '#94A3B8';
      try {
        const stage = await S().settings.addPipelineStage({ name, probability: nv(m,'#newStageProb'), color });
        if (!stage) { App.app.toast('Could not add stage — that name may already be in use.', 'danger'); saveBtn.disabled = false; return; }
        h.close(); App.app.toast(`Added "${stage.name}" to the pipeline.`, 'success'); await renderPipelineCategory(root);
      } catch (err) {
        App.app.toast('Could not add stage: ' + err.message, 'danger');
        saveBtn.disabled = false;
      }
    }; } });
  }

  function deleteStageFlow(root, id) {
    const stage = S().getState().settings.pipelineStages.find(x => x.id === id); if (!stage) return;
    S().settings.countDealsInStage(id).then(usage => {
    if (usage === 0) { App.app.confirmDialog({ title: "Delete pipeline stage?", message: `"${App.util.esc(stage.name)}" has no deals in it.`, okLabel: "Delete stage", danger: true }, async () => {
      try {
        const next = await S().settings.deletePipelineStage(id);
        if (!next) { App.app.toast("Could not delete stage.", "danger"); return; }
        App.app.toast("Stage deleted.", "success"); await renderPipelineCategory(root);
      } catch (err) { App.app.toast("Could not delete stage: " + err.message, "danger"); }
    }); return; }
    const otherStages = S().getState().settings.pipelineStages.filter(x => x.id !== id).sort((a,b) => a.order - b.order); if (!otherStages.length) { App.app.toast("Add another stage first.", "danger"); return; }
    const options = otherStages.map(x => `<option value="${U().esc(x.id)}">${U().esc(x.name)}</option>`).join("");
    const h = App.app.openModal({ title: "Move deals before deleting", body: `<p>"${App.util.esc(stage.name)}" has <strong>${usage} deal${usage===1?'':'s'}</strong>. Choose where to move ${usage===1?'it':'them'} first.</p><label class="field"><span>Move to</span><select id="moveTargetStage">${options}</select></label>`, footer: `<button class="btn" data-role="cancel">Cancel</button><button class="btn btn-primary" data-role="ok">Move &amp; Delete Stage</button>`, onOpen: m => { m.querySelector('[data-role="cancel"]').onclick = () => h.close(); m.querySelector('[data-role="ok"]').onclick = async () => {
      const targetId = m.querySelector('#moveTargetStage').value;
      const okBtn = m.querySelector('[data-role="ok"]'); okBtn.disabled = true;
      try {
        const moved = await S().settings.reassignDealsFromStage(id, targetId);
        if (moved === null) { App.app.toast('Could not move deals.', 'danger'); okBtn.disabled = false; return; }
        const next = await S().settings.deletePipelineStage(id);
        h.close();
        if (!next) { App.app.toast(`Moved ${moved} deal(s), but the stage could not be deleted.`, 'danger'); await renderPipelineCategory(root); return; }
        App.app.toast(`Moved ${moved} deal(s) and deleted "${stage.name}".`, 'success'); await renderPipelineCategory(root);
      } catch (err) {
        App.app.toast('Could not complete move: ' + err.message, 'danger');
        okBtn.disabled = false;
      }
    }; } });
    }).catch(err => App.app.toast("Could not load stage usage: " + err.message, "danger"));
  }

  // ---------- DATA & SAFETY ----------
  // Absorbs what used to be the standalone Backup/Restore page (removed —
  // there is no longer a separate /backup route): export, restore-from-file,
  // and reset-entire-workspace all live here now so none of those
  // capabilities were lost when that page went away.
  function renderDataSafetyCategory(root) {
    const s = S().getState();
    const lastBackup = s.metadata.lastBackupAt ? new Date(s.metadata.lastBackupAt).toLocaleString() : "No backup recorded yet";
    root.innerHTML = `<div class="settings-category-head"><div class="settings-category-title">Data &amp; Safety</div><p class="form-help">Your data is stored in your account and synced live — regular exports are still a good idea before major changes.</p></div><div class="settings-status-grid"><div class="settings-status-card"><div class="k">Cloud-synced storage</div><div class="v">Your data is saved to your account</div></div><div class="settings-status-card"><div class="k">Last backup</div><div class="v">${U().esc(lastBackup)}</div></div></div>
      <div class="release-grid release-grid-2">
        <section class="card"><div class="card-header"><div class="card-title">Export Workspace Backup</div></div><div class="card-body"><p>Exports contacts, properties, deals, activities, tasks, showings, milestones, referrals, goals, scripts, prompts, income, expenses, scheduled items, team members, custom fields and their values, business profile, module and dashboard settings, pipeline stages, and metadata.</p><div class="release-callout release-callout-warning"><strong>Export a backup before making major changes, as an extra safety copy.</strong></div><button class="btn btn-primary" id="dsExportBackup" style="margin-top:12px">${App.app.icon('save')} Export JSON Backup</button></div></section>
        <section class="card"><div class="card-header"><div class="card-title">Restore Backup</div></div><div class="card-body"><p>Restoring a backup merges its records into your account — new records are added, and existing records with matching IDs are updated. Nothing is deleted. The file is validated and previewed before you confirm.</p><input type="file" id="backupFile" accept="application/json,.json" class="sr-only"><button class="btn" id="backupChoose">Choose JSON Backup</button><div id="backupPreview" style="margin-top:12px"></div></div></section>
      </div>
      <section class="card card-danger-zone"><div class="card-header"><div class="card-title">Workspace Maintenance</div></div><div class="card-body"><div class="release-maintenance"><div><strong>Reset entire workspace</strong><div>Permanently removes all workspace records and restores default settings in your account.</div></div><button class="btn btn-danger" id="dsReset">Reset All Data</button></div></div></section>`;
    const dsExport = root.querySelector("#dsExportBackup"); if (dsExport) dsExport.onclick = async () => {
      dsExport.disabled = true; const orig = dsExport.innerHTML; dsExport.textContent = "Exporting…";
      try {
        await S().ensureLoaded(Object.keys(App.data.REGISTRY).concat(["settings"]));
        const res = await B().exportToFile(S().getState());
        App.app.toast('Backup exported: ' + res.filename, 'success'); _updateLastSaved(); renderDataSafetyCategory(root);
      } catch (err) {
        App.app.toast('Backup export failed: ' + err.message, 'danger');
        dsExport.disabled = false; dsExport.innerHTML = orig;
      }
    };
    const file = root.querySelector('#backupFile'); root.querySelector('#backupChoose').onclick = () => file.click();
    file.onchange = () => { const f = file.files && file.files[0]; if (!f) return; const reader = new FileReader(); reader.onload = () => previewImport(root, String(reader.result || '')); reader.onerror = () => { root.querySelector('#backupPreview').innerHTML = '<div class="release-callout release-callout-danger">Could not read that file.</div>'; }; reader.readAsText(f); };
    root.querySelector('#dsReset').onclick = () => openResetDialog();
  }

  function qv(root,sel){return root.querySelector(sel).value.trim();}
  function nv(root,sel){return U().clamp(root.querySelector(sel).value,0,100);}

  function previewImport(container,text){
    const box=container.querySelector('#backupPreview'); const v=B().validateImport(text);
    if(!v.valid){box.innerHTML=`<div class="release-callout release-callout-danger"><strong>Not imported.</strong> ${U().esc(v.error)}</div>`;return;}
    const sum=v.summary; box.innerHTML=`<div class="release-callout"><strong>Valid Realtor OS backup</strong><br>${sum.contacts} contacts · ${sum.properties} properties · ${sum.deals} deals · ${sum.tasks} tasks · ${sum.scheduledItems} scheduled item${sum.scheduledItems===1?'':'s'} · ${sum.income} income · ${sum.expenses} expenses · ${sum.teamMembers} team member${sum.teamMembers===1?'':'s'} · ${sum.customFields} custom field${sum.customFields===1?'':'s'}<br><button class="btn btn-primary btn-sm" id="commitBackup" style="margin-top:10px">Restore This Backup</button></div>`;
    box.querySelector('#commitBackup').onclick=()=>App.app.confirmDialog({title:'Restore this backup?',message:'This will merge every record from the backup into your account. New records are added, existing records with matching IDs are updated, and nothing is deleted. Export your current workspace first if you may need it later.',okLabel:'Restore backup',danger:true},async ()=>{
      const btn = box.querySelector('#commitBackup'); if (btn) { btn.disabled = true; btn.textContent = 'Restoring…'; }
      const r=await B().commitImport(v.envelope);
      // restoreFromBackup already writes ui.onboardingStatus into the
      // restored settings bag; nothing reads it now that the old welcome
      // is gone, so there is no second write to make here.
      if(r.ok){ App.data.resetAllCaches(); App.app.toast('Backup restored.','success'); App.app.navigate('/dashboard'); }
      else { App.app.toast(r.error||'Backup could not be restored.','danger'); if (btn) { btn.disabled = false; btn.textContent = 'Restore This Backup'; } }
    });
  }

  function openResetDialog(){
    const h=App.app.openModal({title:'Reset Entire Workspace',body:`<p>This permanently removes every record in your account and restores default settings. This cannot be undone unless you have a JSON backup.</p><label class="field"><span>Type RESET to continue</span><input id="resetConfirm" autocomplete="off"></label>`,footer:`<button class="btn" data-role="cancel">Cancel</button><button class="btn btn-danger" data-role="reset">Reset all data</button>`,onOpen:m=>{m.querySelector('[data-role="cancel"]').onclick=()=>h.close();m.querySelector('[data-role="reset"]').onclick=async ()=>{
      if(m.querySelector('#resetConfirm').value.trim()!=='RESET'){App.app.toast('Type RESET exactly to continue.','danger');return;}
      const btn = m.querySelector('[data-role="reset"]'); btn.disabled = true; const orig = btn.textContent; btn.textContent = 'Resetting…';
      const ok=await S().resetWorkspace();
      if(!ok){App.app.toast('Reset failed. Please try again.','danger'); btn.disabled = false; btn.textContent = orig; return;}
      h.close();App.app.toast('Workspace reset.','success');App.app.navigate('/dashboard');
    };}});
  }

  function wireGo(root){root.querySelectorAll('[data-go]').forEach(el=>el.addEventListener('click',()=>App.app.navigate(el.getAttribute('data-go'))));}

  return {renderDashboard,renderDaily,renderContent,renderScripts:(c)=>renderLibrary(c,'scripts'),renderPrompts:(c)=>renderLibrary(c,'prompts'),renderSettings};
})();

