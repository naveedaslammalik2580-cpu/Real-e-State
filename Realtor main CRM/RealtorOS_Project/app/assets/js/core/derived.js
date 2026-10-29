/* ============================================================
   derived.js — all read-only calculations over stored data.
   Pure functions. No side effects. No storage writes.
   These are the numbers the Dashboard and Reports display.
   ============================================================ */

window.App = window.App || {};

App.derived = (function () {
  "use strict";

  const U = App.util;
  const C = App.commission;

  // ---------- STAGE HELPERS ----------

  function stageObj(state, stageName) {
    return state.settings.pipelineStages.find(s => s.name === stageName) || null;
  }
  function isTerminalStage(state, stageName) {
    const s = stageObj(state, stageName);
    return !!(s && s.terminal);
  }
  function isTerminalWon(state, stageName) {
    const s = stageObj(state, stageName);
    return !!(s && s.terminal === "won");
  }
  function isTerminalLost(state, stageName) {
    const s = stageObj(state, stageName);
    return !!(s && s.terminal === "lost");
  }

  // ---------- DEAL FILTERS ----------

  function activeDeals(state) {
    return state.deals.filter(d => !isTerminalStage(state, d.stage));
  }
  function closedDeals(state) {
    return state.deals.filter(d => isTerminalWon(state, d.stage));
  }
  function lostDeals(state) {
    return state.deals.filter(d => isTerminalLost(state, d.stage));
  }

  // ---------- 7A. BUSINESS AT A GLANCE ----------

  function businessAtAGlance(state) {
    const active = activeDeals(state);
    const activePipelineValue = U.sum(active.map(d => U.num(d.salePrice)));
    const expectedNetCommission = active.reduce((t, d) => t + C.netGCI(d), 0);
    const expectedWeightedCommission = active.reduce((t, d) => t + C.weightedGCI(d), 0);
    const activeDealsCount = active.length;
    const today = U.todayISO();
    const closingsThisMonth = state.deals.filter(d =>
      d.closeDate &&
      U.inCurrentMonth(d.closeDate) &&
      d.stage === "Under Contract"
    ).length;
    return {
      activePipelineValue,
      expectedNetCommission,
      expectedWeightedCommission,
      activeDealsCount,
      closingsThisMonth
    };
  }

  // ---------- 7B. NEEDS ATTENTION ----------

  // A contact is skipped from overdue if they're in a "terminal" contact stage.
  function isTerminalContactStage(stage) {
    return stage === "Past Client" || stage === "Lost";
  }

  function needsAttention(state) {
    const today = U.todayISO();
    const in7   = U.addDaysISO(today, 7);
    const in30  = U.addDaysISO(today, 30);

    const overdueFollowUps = state.contacts.filter(c =>
      c.nextFollowUp &&
      c.nextFollowUp < today &&
      !isTerminalContactStage(c.stage)
    );

    const followUpsToday = state.contacts.filter(c =>
      c.nextFollowUp === today &&
      !isTerminalContactStage(c.stage)
    );

    const upcomingShowings = state.showings.filter(s =>
      s.date &&
      s.date >= today &&
      s.date <= in7 &&
      s.status === "Scheduled"
    );

    const dealDeadlines = state.milestones.filter(m =>
      m.dueDate &&
      m.dueDate <= in7 &&
      m.status !== "Complete"
    );

    const upcomingClosings = state.deals.filter(d =>
      d.closeDate &&
      d.closeDate >= today &&
      d.closeDate <= in30 &&
      !isTerminalStage(state, d.stage)
    );

    const overdueTasks = state.tasks.filter(t =>
      t.dueDate &&
      t.dueDate < today &&
      t.status !== "Completed"
    );

    const tasksToday = state.tasks.filter(t =>
      t.dueDate === today &&
      t.status !== "Completed"
    );

    const pastDueClosings = state.deals.filter(d =>
      d.closeDate &&
      d.closeDate < today &&
      !isTerminalStage(state, d.stage)
    );

    return {
      overdueFollowUps,
      followUpsToday,
      upcomingShowings,
      dealDeadlines,
      upcomingClosings,
      overdueTasks,
      tasksToday,
      pastDueClosings,
      totalCount:
        overdueFollowUps.length + followUpsToday.length +
        upcomingShowings.length + dealDeadlines.length +
        upcomingClosings.length + overdueTasks.length +
        tasksToday.length + pastDueClosings.length
    };
  }

  // ---------- 7C. PIPELINE SUMMARY ----------

  function pipelineSummary(state) {
    return state.settings.pipelineStages
      .filter(s => !s.terminal) // active stages only
      .sort((a,b) => a.order - b.order)
      .map(stage => {
        const stageDeals = state.deals.filter(d => d.stage === stage.name);
        return {
          stageId: stage.id,
          stageName: stage.name,
          color: stage.color,
          probability: stage.probability,
          count: stageDeals.length,
          totalValue: U.sum(stageDeals.map(d => U.num(d.salePrice))),
          expectedNetCommission: stageDeals.reduce((t,d) => t + C.netGCI(d), 0),
          weightedCommission: stageDeals.reduce((t,d) => t + C.weightedGCI(d), 0)
        };
      });
  }

  // ---------- 7D. COMMISSION OVERVIEW ----------

  function commissionOverview(state) {
    const active = activeDeals(state);
    const closed = closedDeals(state);
    const closedThisYear = closed.filter(d => d.closeDate && U.inCurrentYear(d.closeDate));

    const ytdNetCommission   = closedThisYear.reduce((t,d) => t + C.netGCI(d), 0);
    const receivedCommission = ytdNetCommission; // v1: Received = Closed
    const pendingCommission  = state.deals
      .filter(d => d.stage === "Under Contract")
      .reduce((t,d) => t + C.netGCI(d), 0);
    const expectedCommission = active.reduce((t,d) => t + C.netGCI(d), 0);

    // Monthly trend — last 12 months (oldest first)
    const trend = [];
    const now = U.parseISODate(U.todayISO());
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0");
      const label = d.toLocaleString("en-US", { month: "short", year: "2-digit" });
      const monthClosed = closed.filter(x =>
        x.closeDate && String(x.closeDate).slice(0,7) === key);
      trend.push({
        key, label,
        amount: monthClosed.reduce((t,x) => t + C.netGCI(x), 0),
        count:  monthClosed.length
      });
    }

    return {
      ytdNetCommission,
      pendingCommission,
      receivedCommission,
      expectedCommission,
      monthlyTrend: trend
    };
  }

  // ---------- 7E. UPCOMING CLOSINGS ----------

  function upcomingClosings(state, limit) {
    const today = U.todayISO();
    const in30  = U.addDaysISO(today, 30);
    const rows = state.deals
      .filter(d => d.closeDate && d.closeDate >= today && d.closeDate <= in30 && !isTerminalStage(state, d.stage))
      .sort((a,b) => a.closeDate.localeCompare(b.closeDate))
      .slice(0, limit || 10)
      .map(d => ({
        dealId: d.id,
        dealName: d.name,
        contactId: d.contactId,
        contactName: contactName(state, d.contactId),
        propertyId: d.propertyId,
        propertyAddress: propertyAddress(state, d.propertyId),
        closeDate: d.closeDate,
        salePrice: U.num(d.salePrice),
        expectedNet: C.netGCI(d),
        stage: d.stage
      }));
    const totalExpectedNet = rows.reduce((t,r) => t + r.expectedNet, 0);
    return { rows, totalExpectedNet };
  }

  // ---------- 7F. CRM / LEAD HEALTH ----------

  function leadHealth(state) {
    const active = state.contacts.filter(c => !isTerminalContactStage(c.stage));
    const today = U.todayISO();
    const in7   = U.addDaysISO(today, 7);
    return {
      totalLeads: active.length,
      hotLeads:   active.filter(c => c.temperature === "Hot").length,
      warmLeads:  active.filter(c => c.temperature === "Warm").length,
      coldLeads:  active.filter(c => c.temperature === "Cold").length,
      followUpsDueThisWeek: state.contacts.filter(c =>
        c.nextFollowUp && c.nextFollowUp <= in7 && !isTerminalContactStage(c.stage)
      ).length,
      leadSourceBreakdown: bucketize(state.contacts, "source")
    };
  }

  function bucketize(items, key) {
    const map = {};
    (items || []).forEach(x => {
      const k = x[key] || "Unknown";
      map[k] = (map[k] || 0) + 1;
    });
    return Object.keys(map).sort().map(k => ({ label: k, count: map[k] }));
  }

  // ---------- 7G. GOALS ----------

  function goalProgress(state, goal) {
    const year = goal.year;
    const closedThisYear = state.deals.filter(d =>
      isTerminalWon(state, d.stage) && d.closeDate && U.dateYear(d.closeDate) === year
    );
    let current = 0;
    switch (goal.type) {
      case "GCI":
        current = closedThisYear.reduce((t,d) => t + C.netGCI(d), 0);
        break;
      case "ClosedDeals":
        current = closedThisYear.length;
        break;
      case "NewClients":
        current = state.contacts.filter(c =>
          c.createdAt && U.dateYear(c.createdAt) === year &&
          (c.stage === "Client" || c.stage === "Past Client")
        ).length;
        break;
      case "Referrals":
        current = state.referrals.filter(r =>
          r.date && U.dateYear(r.date) === year
        ).length;
        break;
      case "Appointments":
        const meetings = state.activities.filter(a =>
          a.type === "Meeting" && a.date && U.dateYear(a.date) === year
        ).length;
        const shows = state.showings.filter(s =>
          s.status === "Completed" && s.date && U.dateYear(s.date) === year
        ).length;
        current = meetings + shows;
        break;
    }
    const target = U.num(goal.target);
    const pct = target > 0 ? (current / target) * 100 : 0;
    return {
      goalId: goal.id,
      type: goal.type,
      year: goal.year,
      target,
      current,
      pct: Math.min(100, pct),
      rawPct: pct,
      overachieved: pct > 100
    };
  }

  function allGoalsProgress(state) {
    return state.goals.map(g => goalProgress(state, g));
  }

  // ---------- 7H. RECENT ACTIVITY ----------

  function recentActivity(state, limit) {
    return state.activities
      .slice()
      .sort((a,b) => (b.date || "").localeCompare(a.date || ""))
      .slice(0, limit || 8)
      .map(a => ({
        id: a.id,
        type: a.type,
        date: a.date,
        subject: a.subject,
        contactName: contactName(state, a.contactId),
        propertyAddress: propertyAddress(state, a.propertyId),
        dealName: dealName(state, a.dealId),
        outcome: a.outcome
      }));
  }

  // ---------- FOLLOW-UP / DEAL / MILESTONE STATUS HELPERS ----------

  function contactFollowUpStatus(contact) {
    if (!contact || !contact.nextFollowUp) return { status: "none" };
    const today = U.todayISO();
    if (contact.nextFollowUp < today)
      return { status: "overdue", daysOverdue: U.daysBetween(contact.nextFollowUp, today) };
    if (contact.nextFollowUp === today) return { status: "due-today" };
    if (contact.nextFollowUp <= U.addDaysISO(today, 7)) return { status: "upcoming" };
    return { status: "future" };
  }

  function dealClosingStatus(state, deal) {
    if (!deal || !deal.closeDate) return { status: "no-date" };
    if (isTerminalStage(state, deal.stage)) return { status: "terminal" };
    const today = U.todayISO();
    if (deal.closeDate < today)
      return { status: "past-due", daysPast: U.daysBetween(deal.closeDate, today) };
    if (deal.closeDate === today) return { status: "closing-today" };
    if (deal.closeDate <= U.addDaysISO(today, 7))  return { status: "this-week" };
    if (deal.closeDate <= U.addDaysISO(today, 30)) return { status: "this-month" };
    return { status: "future" };
  }

  function milestoneStatus(milestone) {
    if (!milestone) return { status: "none" };
    if (milestone.status === "Complete") return { status: "complete" };
    if (!milestone.dueDate) return { status: milestone.status.toLowerCase() };
    const today = U.todayISO();
    if (milestone.dueDate < today)
      return { status: "overdue", daysOverdue: U.daysBetween(milestone.dueDate, today) };
    if (milestone.dueDate === today) return { status: "due-today" };
    if (milestone.dueDate <= U.addDaysISO(today, 7)) return { status: "upcoming" };
    return { status: "future" };
  }

  // ---------- MOBILE DAILY VIEW ----------

  function dailyView(state) {
    const today = U.todayISO();
    return {
      date: today,
      followUpsToday: state.contacts.filter(c => c.nextFollowUp === today && !isTerminalContactStage(c.stage)),
      showingsToday: state.showings.filter(s => s.date === today && s.status === "Scheduled")
                                    .sort((a,b) => (a.startTime||"").localeCompare(b.startTime||"")),
      tasksToday: state.tasks.filter(t => t.dueDate === today && t.status !== "Completed"),
      overdueTasks: state.tasks.filter(t => t.dueDate && t.dueDate < today && t.status !== "Completed"),
      overdueFollowUps: state.contacts.filter(c =>
        c.nextFollowUp && c.nextFollowUp < today && !isTerminalContactStage(c.stage)
      ),
      closingsToday: state.deals.filter(d => d.closeDate === today && !isTerminalStage(state, d.stage)),
      milestonesToday: state.milestones.filter(m => m.dueDate === today && m.status !== "Complete")
    };
  }

  // ---------- CONTACT ENRICHMENT ----------

  function contactName(state, id) {
    if (!id) return "";
    const c = state.contacts.find(c => c.id === id);
    return c ? c.name : "";
  }
  function propertyAddress(state, id) {
    if (!id) return "";
    const p = state.properties.find(p => p.id === id);
    return p ? p.address : "";
  }
  function dealName(state, id) {
    if (!id) return "";
    const d = state.deals.find(d => d.id === id);
    return d ? d.name : "";
  }

  // Property: days on market
  function daysOnMarket(property) {
    if (!property || !property.listingDate) return null;
    if (property.status === "Sold") return null;
    return Math.max(0, U.daysBetween(property.listingDate, U.todayISO()));
  }

  // ---------- v2 — new dashboard widgets ----------
  // Same conventions as everything above: pure, read-only, no storage writes.

  // Properties by status, for the "Properties" dashboard widget.
  function propertiesSummary(state) {
    const byStatus = {};
    state.properties.forEach(p => { byStatus[p.status || "Active"] = (byStatus[p.status || "Active"] || 0) + 1; });
    return { total: state.properties.length, byStatus };
  }

  // Won / (Won + Lost) among deals that have actually reached a terminal
  // stage. Deals still active are excluded — this is a closed-funnel rate,
  // not a percentage of all deals ever created.
  function conversionRate(state) {
    const won = closedDeals(state).length; // closedDeals() = terminal:"won" only, see above
    const lost = lostDeals(state).length;
    const decided = won + lost;
    return { won, lost, decided, rate: decided ? (won / decided) * 100 : 0 };
  }

  // Deal counts + net commission grouped by assigned team member. Deals
  // with no assignedToId are grouped under "Unassigned" so the total always
  // reconciles with businessAtAGlance()/commissionOverview().
  function teamPerformance(state) {
    const rows = {};
    const bump = (key, deal) => {
      if (!rows[key]) rows[key] = { activeDeals: 0, closedDeals: 0, netCommission: 0 };
      rows[key].netCommission += C.netGCI(deal);
      if (isTerminalStage(state, deal.stage)) rows[key].closedDeals += 1; else rows[key].activeDeals += 1;
    };
    state.deals.forEach(d => bump(d.assignedToId || "unassigned", d));
    return Object.keys(rows).map(key => {
      const member = key === "unassigned" ? null : state.teamMembers.find(m => m.id === key);
      return Object.assign({ memberId: key === "unassigned" ? null : key, memberName: member ? member.name : "Unassigned" }, rows[key]);
    }).sort((a, b) => b.netCommission - a.netCommission);
  }

  // Simple net revenue (income - expenses), YTD and this month, for the
  // "Revenue" widget — reuses the existing income/expenses records as-is,
  // no new data collected.
  function financeSummary(state) {
    const ytdIncome   = U.sum(state.income.filter(r => r.date && U.inCurrentYear(r.date)).map(r => r.amount));
    const ytdExpenses = U.sum(state.expenses.filter(r => r.date && U.inCurrentYear(r.date)).map(r => r.amount));
    const monthIncome   = U.sum(state.income.filter(r => r.date && U.inCurrentMonth(r.date)).map(r => r.amount));
    const monthExpenses = U.sum(state.expenses.filter(r => r.date && U.inCurrentMonth(r.date)).map(r => r.amount));
    return {
      ytdIncome, ytdExpenses, ytdNet: ytdIncome - ytdExpenses,
      monthIncome, monthExpenses, monthNet: monthIncome - monthExpenses
    };
  }

  return {
    // Stage helpers
    isTerminalStage, isTerminalWon, isTerminalLost, isTerminalContactStage,
    activeDeals, closedDeals, lostDeals,
    // Dashboard sections
    businessAtAGlance,
    needsAttention,
    pipelineSummary,
    commissionOverview,
    upcomingClosings,
    leadHealth,
    goalProgress, allGoalsProgress,
    recentActivity,
    // Status helpers
    contactFollowUpStatus,
    dealClosingStatus,
    milestoneStatus,
    // Mobile
    dailyView,
    // Enrichment
    contactName, propertyAddress, dealName,
    daysOnMarket,
    // v2 widgets
    propertiesSummary, conversionRate, teamPerformance, financeSummary
  };
})();

