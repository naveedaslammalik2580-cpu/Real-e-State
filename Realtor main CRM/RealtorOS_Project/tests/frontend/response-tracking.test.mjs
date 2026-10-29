// Phase 2C, browser side: the three small fixes and the two accountability
// views.
//
// The response-time arithmetic is the part worth pinning. It is the number a
// manager will quote at somebody, so a median that silently became a mean,
// or a percentage computed from the wrong denominator, is not a cosmetic
// bug.
import { test } from "node:test";
import assert from "node:assert/strict";
import { browser, settle, SKIP_DOM } from "../helpers/browser.mjs";

const TODAY = "2026-10-15";
const NOW = Date.parse(TODAY + "T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

const open = [];
function closeAll() {
  while (open.length) {
    const b = open.pop();
    try { b.close(); } catch (e) { /* already gone */ }
  }
}

function domTest(name, scripts, fn) {
  test(name, async (t) => {
    const probe = await browser(scripts, { store: { getState: () => ({ settings: {} }) } });
    if (!probe) return t.skip(SKIP_DOM);
    try { probe.close(); } catch (e) {}
    try { await fn(); } finally { closeAll(); }
  });
}

async function load(scripts, opts) {
  const b = await browser(scripts, opts);
  if (!b) return null;
  open.push(b);
  if (b.window.App.util) b.window.App.util.todayISO = () => TODAY;
  return b;
}

// ---------------------------------------------------------------- 1b. sms

domTest("the text link uses ?&body=, which both iOS and Android accept",
  ["assets/js/core/utils.js", "assets/js/core/follow-up.js"], async () => {
    const b = await load(["assets/js/core/utils.js", "assets/js/core/follow-up.js"], {
      store: { getState: () => ({ settings: {} }) }
    });
    const fu = b.window.App.followUp;
    const c = { phone: "+15551234567" };

    const url = fu.smsUrl(c, "Hi there", "");
    assert.ok(url.startsWith("sms:+15551234567?&body="),
      "iOS drops a plain ?body=, so the empty first parameter has to be there: " + url);
    assert.equal(decodeURIComponent(url.split("?&body=")[1]), "Hi there");

    // No message means no parameter at all, rather than a dangling "?&".
    assert.equal(fu.smsUrl(c, "", ""), "sms:+15551234567");
  });

// ---------------------------------------------------------------- the maths

domTest("response stats: median not mean, and the right denominator",
  ["assets/js/core/utils.js", "assets/js/core/response-stats.js"], async () => {
    const b = await load(["assets/js/core/utils.js", "assets/js/core/response-stats.js"], {
      store: { getState: () => ({ settings: {} }) }
    });
    const R = b.window.App.responseStats;

    const made = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();
    const contacts = [
      // Touched after 1h, 2h, 3h — and one after 20 days, which would wreck
      // a mean and must not move the median far.
      { id: "a", createdAt: made(5), firstTouchedAt: new Date(NOW - 5 * DAY + HOUR).toISOString() },
      { id: "b", createdAt: made(5), firstTouchedAt: new Date(NOW - 5 * DAY + 2 * HOUR).toISOString() },
      { id: "c", createdAt: made(5), firstTouchedAt: new Date(NOW - 5 * DAY + 3 * HOUR).toISOString() },
      { id: "d", createdAt: made(25), firstTouchedAt: new Date(NOW - 25 * DAY + 20 * DAY).toISOString() },
      // Never touched: counts as a new lead, but contributes no duration.
      { id: "e", createdAt: made(2), firstTouchedAt: null },
      // Older than the window: ignored entirely.
      { id: "f", createdAt: made(40), firstTouchedAt: new Date(NOW - 40 * DAY + HOUR).toISOString() },
    ];

    const s = R.compute(contacts, TODAY, NOW);
    assert.equal(s.newContacts, 5, "the 40-day-old contact is outside the window");
    assert.equal(s.untouched, 1);
    assert.equal(s.touchedWithin24h, 3, "three of the four touched ones were same-day");
    assert.equal(s.touchedWithin24hPct, 60, "3 of 5 NEW leads, not 3 of 4 touched ones");
    // Durations are 1h, 2h, 3h, 20d -> median of four is (2h + 3h) / 2.
    assert.equal(s.medianTouchMs, 2.5 * HOUR, "the 20-day outlier must not drag the middle");
    assert.equal(R.formatDuration(s.medianTouchMs), "2h 30m");
  });

domTest("with no new leads the numbers are blank rather than zero",
  ["assets/js/core/utils.js", "assets/js/core/response-stats.js"], async () => {
    const b = await load(["assets/js/core/utils.js", "assets/js/core/response-stats.js"], {
      store: { getState: () => ({ settings: {} }) }
    });
    const R = b.window.App.responseStats;
    const s = R.compute([], TODAY, NOW);
    assert.equal(s.newContacts, 0);
    assert.equal(s.touchedWithin24hPct, null, "nothing to divide is not 0%");
    assert.equal(s.medianTouchMs, null);
    assert.equal(R.formatPct(null), "—");
    assert.equal(R.formatDuration(null), "—");
  });

domTest("overdue counts only live contacts that are actually past due",
  ["assets/js/core/utils.js", "assets/js/core/response-stats.js"], async () => {
    const b = await load(["assets/js/core/utils.js", "assets/js/core/response-stats.js"], {
      store: { getState: () => ({ settings: {} }) }
    });
    const R = b.window.App.responseStats;
    const s = R.compute([
      { id: "a", createdAt: new Date(NOW).toISOString(), nextFollowUp: "2026-10-14", stage: "New Lead" },
      { id: "b", createdAt: new Date(NOW).toISOString(), nextFollowUp: TODAY, stage: "New Lead" },
      { id: "c", createdAt: new Date(NOW).toISOString(), nextFollowUp: "2026-10-14", stage: "Lost" },
      { id: "d", createdAt: new Date(NOW).toISOString(), nextFollowUp: "2026-10-14", stage: "Past Client" },
      { id: "e", createdAt: new Date(NOW).toISOString(), nextFollowUp: null, stage: "New Lead" },
    ], TODAY, NOW);
    assert.equal(s.overdueNow, 1, "due today is not overdue, and a closed lead is nobody's chase");
  });

// ---------------------------------------------------------------- reports
//
// U2c moved this card from the Dashboard (Reports > Overview) to
// Reports > Performance, where the other performance numbers are. The
// calculation did not move with it - App.responseStats is the same
// module the Team dashboard reads - so what is tested here is the
// placement, the words, and that the card joined the Reports page
// properly enough to be exported with the rest of it.

const REPORTS = [
  "assets/js/core/utils.js",
  "assets/js/core/response-stats.js",
  "assets/js/core/commission.js",
  "assets/js/core/derived.js",
  "assets/js/app.js",
  "assets/js/pages/reports.js",
];

const DASH = [
  "assets/js/core/utils.js",
  "assets/js/core/response-stats.js",
  "assets/js/core/commission.js",
  "assets/js/core/derived.js",
  "assets/js/app.js",
  "assets/js/pages/release.js",
];

function reportStore(contacts) {
  const empty = {
    contacts, properties: [], deals: [], milestones: [], activities: [], tasks: [],
    showings: [], referrals: [], goals: [], income: [], expenses: [], teamMembers: [],
    settings: { currency: "USD", pipelineStages: [{ name: "New Lead" }] },
    metadata: {},
  };
  return { ensureLoaded: async () => {}, getState: () => empty };
}

async function reportsPage(contacts) {
  const b = await load(REPORTS, { store: reportStore(contacts) });
  if (!b) return null;
  b.window.App.customization = Object.assign({}, b.window.App.customization, {
    isModuleEnabled: () => true,
  });
  const pane = b.document.createElement("div");
  b.document.body.appendChild(pane);
  await b.window.App.pages.reports.render(pane);
  await settle(b.window);
  return Object.assign({}, b, { pane });
}

/** The card, found the way the export finds every card: by its title. */
const responseCard = (p) => Array.from(p.pane.querySelectorAll(".report-card"))
  .find((c) => /Response Time/i.test((c.querySelector(".card-title") || {}).textContent || ""));

const TOUCHED = (daysAgo, hoursAfter) => ({
  id: "a", name: "A", stage: "New Lead",
  createdAt: new Date(NOW - daysAgo * DAY).toISOString(),
  firstTouchedAt: new Date(NOW - daysAgo * DAY + hoursAfter * HOUR).toISOString(),
});

domTest("the response card is on Reports, with the four numbers in plain words", REPORTS, async () => {
  const p = await reportsPage([
    TOUCHED(3, 1),
    { id: "b", name: "B", stage: "New Lead",
      createdAt: new Date(NOW - 3 * DAY).toISOString(),
      firstTouchedAt: null, nextFollowUp: "2026-10-01" },
  ]);
  const card = responseCard(p);
  assert.ok(card, "the card is on the Reports page: "
    + Array.from(p.pane.querySelectorAll(".card-title")).map((t) => t.textContent).join(", "));

  const text = card.textContent.replace(/\s+/g, " ");
  assert.match(text, /last 30 days/);
  assert.match(text, /New Leads/);
  assert.match(text, /Not Contacted Yet/);
  assert.match(text, /50%/, "one of two touched within a day");
  assert.match(text, /Typical Time to First Contact/);
  assert.match(text, /Overdue Follow-ups/);
  assert.match(text, /half were faster, half slower/, "the median, said in words");
  // No jargon from the engine side of the app.
  assert.ok(!/first_touched_at|median m|workspace_id|RLS/i.test(text), text);
});

domTest("it sits with the other performance cards, not on its own", REPORTS, async () => {
  const p = await reportsPage([TOUCHED(2, 2)]);
  const titles = Array.from(p.pane.querySelectorAll(".reports-grid .report-card .card-title"))
    .map((t) => t.textContent.trim());
  assert.ok(titles.includes("Response Time"), JSON.stringify(titles));
  // Every pre-existing card is still there, in order, with the new one
  // next to the contacts it is about.
  assert.deepEqual(titles, [
    "Sales / Pipeline", "Commission", "Contacts / Leads", "Response Time",
    "Activities", "Tasks", "Referrals", "Financial",
  ]);
});

domTest("the card explains itself when there is nothing to measure", REPORTS, async () => {
  const p = await reportsPage([]);
  const card = responseCard(p);
  assert.ok(card, "the card stays put rather than vanishing");
  assert.match(card.textContent, /No new leads in the last 30 days/);
});

domTest("the Reports export picks it up like any other card", REPORTS, async () => {
  const p = await reportsPage([TOUCHED(3, 1)]);
  const card = responseCard(p);

  // The CSV export scrapes .report-kpis > div > .rk/.rv from each
  // .report-card. Using the page's own card component is what makes
  // that work with no export code at all - so the structure is the
  // assertion.
  const pairs = Array.from(card.querySelectorAll(".report-kpis > div"))
    .map((cell) => [cell.querySelector(".rk").textContent.trim(),
                    cell.querySelector(".rv").textContent.trim()]);
  assert.equal(pairs.length, 5, JSON.stringify(pairs));
  assert.deepEqual(pairs.map((x) => x[0]), [
    "New Leads", "Not Contacted Yet", "Contacted Within a Day",
    "Typical Time to First Contact", "Overdue Follow-ups",
  ]);
  assert.equal(pairs[0][1], "1");

  // And the per-section export button is added to it, like the others.
  assert.ok(card.querySelector(".report-card-export"),
    "its own Export button: " + card.innerHTML.slice(0, 200));
});

domTest("the Dashboard no longer carries a second copy", DASH, async () => {
  const b = await load(DASH, { store: reportStore([TOUCHED(3, 1)]) });
  if (!b) return;
  b.window.App.customization = Object.assign({}, b.window.App.customization, {
    visibleWidgetsInOrder: () => [],
    isModuleEnabled: () => true,
  });
  const pane = b.document.createElement("div");
  b.document.body.appendChild(pane);
  await b.window.App.pages.release.renderDashboard(pane);
  await settle(b.window);

  assert.equal(pane.querySelector(".response-card"), null,
    "the old placement is gone - two cards reading the same numbers is how they start disagreeing");
  assert.ok(!/Your response time/i.test(pane.textContent),
    "and no stray heading left behind");
});

// ---------------------------------------------------------------- team table

const TEAM = [
  "assets/js/core/utils.js",
  "assets/js/core/response-stats.js",
  "assets/js/core/customization.js",
  "assets/js/data/workspace.js",
  "assets/js/app.js",
  "assets/js/pages/team-dashboard.js",
];

async function teamPage({ teamMode = true, canManage = true, contacts = [], members = [] } = {}) {
  const b = await load(TEAM, {
    store: {
      ensureLoaded: async () => {},
      getState: () => ({
        contacts, deals: [], tasks: [], teamMembers: [],
        settings: { currency: "USD" }, metadata: {},
      }),
      team: { listMembers: async () => ({ outcome: "ok", members }) },
    },
  });
  if (!b) return null;
  b.window.App.customization = Object.assign({}, b.window.App.customization, {
    isTeamMode: () => teamMode,
    isModuleEnabled: () => true,
  });
  b.window.App.workspace = Object.assign({}, b.window.App.workspace, {
    load: async () => {},
    can: (key) => (key === "team_manage" ? canManage : true),
  });
  const pane = b.document.createElement("div");
  b.document.body.appendChild(pane);
  await b.window.App.pages.teamDashboard.render(pane);
  await settle(b.window);
  return Object.assign({}, b, { pane });
}

const MEMBERS = [
  { member_id: "m1", team_member_id: "tm1", name: "Fast Fiona", role: "agent", status: "active", is_self: false },
  { member_id: "m2", team_member_id: "tm2", name: "Slow Sam", role: "agent", status: "active", is_self: false },
];

function teamContacts() {
  const made = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();
  return [
    // Fiona: both touched within the hour.
    { id: "f1", assignedToId: "tm1", stage: "New Lead", createdAt: made(4), firstTouchedAt: new Date(NOW - 4 * DAY + HOUR).toISOString() },
    { id: "f2", assignedToId: "tm1", stage: "New Lead", createdAt: made(3), firstTouchedAt: new Date(NOW - 3 * DAY + HOUR).toISOString() },
    // Sam: one touched after three days, one never, one overdue.
    { id: "s1", assignedToId: "tm2", stage: "New Lead", createdAt: made(8), firstTouchedAt: new Date(NOW - 8 * DAY + 3 * DAY).toISOString() },
    { id: "s2", assignedToId: "tm2", stage: "New Lead", createdAt: made(2), firstTouchedAt: null, nextFollowUp: "2026-10-10" },
    // Nobody's: part of the team total only.
    { id: "u1", assignedToId: null, stage: "New Lead", createdAt: made(1), firstTouchedAt: null },
  ];
}

domTest("a manager in team mode sees a row per agent plus a team total", TEAM, async () => {
  const p = await teamPage({ contacts: teamContacts(), members: MEMBERS });
  const card = p.pane.querySelector("#teamResponseCard");
  assert.ok(card, "the table is there for a manager");

  const rows = Array.from(card.querySelectorAll("tbody tr"))
    .map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => td.textContent.replace(/\s+/g, " ").trim()));
  assert.equal(rows.length, 3, "two people and the team");
  assert.equal(rows[rows.length - 1][0], "Whole team", "the total stays at the bottom");

  const fiona = rows.find((r) => r[0].includes("Fast Fiona"));
  const sam = rows.find((r) => r[0].includes("Slow Sam"));
  assert.equal(fiona[1], "2");
  assert.match(fiona[2], /100%/);
  assert.equal(sam[1], "2");
  assert.match(sam[2], /0%/, "one touched after three days, one not at all");
  assert.match(sam[2], /1 still waiting/);
  assert.equal(sam[4], "1", "Sam has the overdue one");

  // The team row counts the unassigned lead too.
  const team = rows[rows.length - 1];
  assert.equal(team[1], "5", "including the lead nobody owns");
});

domTest("the table is hidden from an agent, and outside team mode", TEAM, async () => {
  const asAgent = await teamPage({ contacts: teamContacts(), members: MEMBERS, canManage: false });
  assert.equal(asAgent.pane.querySelector("#teamResponseCard"), null,
    "how fast each person answers is a management conversation");
  closeAll();

  const solo = await teamPage({ contacts: teamContacts(), members: MEMBERS, teamMode: false });
  assert.equal(solo.pane.querySelector("#teamResponseCard"), null,
    "and there is no team to compare in a single-agent workspace");
});

domTest("clicking a column sorts by it, and clicking again reverses", TEAM, async () => {
  const p = await teamPage({ contacts: teamContacts(), members: MEMBERS });
  const card = p.pane.querySelector("#teamResponseCard");
  const names = () => Array.from(card.querySelectorAll("tbody tr td:first-child"))
    .map((td) => td.textContent.trim().split(/\s+/).slice(0, 2).join(" "));

  const btn = card.querySelector('[data-response-sort="withinDay"]');
  btn.click();
  await settle(p.window);
  const first = names();
  assert.equal(first[0], "Slow Sam", "worst first, because that is the one to act on");

  btn.click();
  await settle(p.window);
  assert.equal(names()[0], "Fast Fiona", "and the other way on a second click");
  assert.equal(names()[names().length - 1], "Whole team", "the total never joins the ranking");

  const th = btn.closest("th");
  assert.ok(["ascending", "descending"].includes(th.getAttribute("aria-sort")),
    "the sorted column says so to a screen reader");
});

domTest("a teammate's name is shown, never executed", TEAM, async () => {
  const p = await teamPage({
    contacts: [],
    members: [{
      member_id: "m1", team_member_id: "tm1", status: "active",
      name: '<img src=x onerror="window.__pwned=1">', role: "agent", is_self: false,
    }],
  });
  assert.equal(p.window.__pwned, undefined);
  const card = p.pane.querySelector("#teamResponseCard");
  assert.equal(card.querySelector("img"), null, "the markup was not parsed as markup");
  assert.ok(card.textContent.includes("onerror"), "and the text is displayed literally");
});

// ---------------------------------------------------------------- 1a. milestones

const DEAL = [
  "assets/js/core/utils.js",
  "assets/js/core/response-stats.js",
  "assets/js/core/commission.js",
  "assets/js/core/derived.js",
  "assets/js/app.js",
  "assets/js/pages/deals.js",
];

async function dealDetail(milestones) {
  const completed = [];
  const deal = {
    id: "d1", name: "12 Oak Street", title: "12 Oak Street", contactId: null, propertyId: null,
    stage: "New", side: "Buyer", status: "active", value: 500000, probability: 50,
    commissionRate: 3, teamSplit: 0, brokerageFee: 0, referralFee: 0, taxReserve: 0,
    closeDate: null, notes: "",
  };
  const b = await load(DEAL, {
    store: {
      ensureLoaded: async () => {},
      getState: () => ({
        deals: [deal], contacts: [], properties: [], milestones, activities: [], tasks: [],
        showings: [], teamMembers: [],
        settings: { currency: "USD", pipelineStages: [{ name: "New" }], commissionDefaults: {} },
        metadata: {},
      }),
      deals: { get: async () => deal },
      milestones: {
        get: async (id) => milestones.find((m) => m.id === id) || null,
        complete: async (id) => {
          completed.push(id);
          const m = milestones.find((x) => x.id === id);
          if (m) m.status = "Complete";
          return m;
        },
      },
    },
  });
  if (!b) return null;
  const pane = b.document.createElement("div");
  b.document.body.appendChild(pane);
  await b.window.App.pages.deals.renderDealDetail(pane, "d1");
  await settle(b.window);
  return Object.assign({}, b, { pane, completed });
}

domTest("an incomplete milestone offers Mark complete, a complete one does not", DEAL, async () => {
  const p = await dealDetail([
    { id: "ms1", dealId: "d1", name: "Inspection", order: 1, status: "Pending", dueDate: "2026-10-20" },
    { id: "ms2", dealId: "d1", name: "Closing", order: 2, status: "Complete", dueDate: "2026-11-01" },
  ]);
  const buttons = Array.from(p.pane.querySelectorAll("[data-complete-milestone]"))
    .map((b) => b.getAttribute("data-complete-milestone"));
  assert.deepEqual(buttons, ["ms1"], "only the one still outstanding");
});

domTest("Mark complete confirms first, mentions the due date, and then saves", DEAL, async () => {
  const p = await dealDetail([
    { id: "ms1", dealId: "d1", name: "Inspection", order: 1, status: "Pending", dueDate: "2026-10-20" },
  ]);
  p.pane.querySelector('[data-complete-milestone="ms1"]').click();
  await settle(p.window);

  const dialog = p.document.querySelector(".modal");
  assert.ok(dialog, "it asks first - completing the wrong one shifts a whole timeline");
  const text = dialog.textContent.replace(/\s+/g, " ");
  assert.match(text, /Mark Milestone Complete/);
  assert.match(text, /Inspection/);
  assert.match(text, /was due/i, "including when it was due");
  assert.deepEqual(p.completed, [], "and nothing is saved until it is confirmed");

  const ok = Array.from(dialog.querySelectorAll("button"))
    .find((b) => /mark complete/i.test(b.textContent));
  assert.ok(ok, "the confirm button says what it does");
  ok.click();
  await settle(p.window);
  assert.deepEqual(p.completed, ["ms1"], "then the existing store method does the work");
});

domTest("cancelling the confirm completes nothing", DEAL, async () => {
  const p = await dealDetail([
    { id: "ms1", dealId: "d1", name: "Inspection", order: 1, status: "Pending", dueDate: null },
  ]);
  p.pane.querySelector('[data-complete-milestone="ms1"]').click();
  await settle(p.window);
  const dialog = p.document.querySelector(".modal");
  const cancel = Array.from(dialog.querySelectorAll("button"))
    .find((b) => /cancel/i.test(b.textContent));
  cancel.click();
  await settle(p.window);
  assert.deepEqual(p.completed, []);
});

// ---------------------------------------------------------------- 1c. country code

const SETTINGS = [
  "assets/js/core/utils.js",
  "assets/js/core/response-stats.js",
  "assets/js/core/commission.js",
  "assets/js/core/derived.js",
  "assets/js/app.js",
  "assets/js/pages/release.js",
];

async function businessProfile(settings = {}) {
  const saved = [];
  const b = await load(SETTINGS, {
    store: {
      ensureLoaded: async () => {},
      getState: () => ({
        contacts: [], properties: [], deals: [], milestones: [], activities: [], tasks: [],
        showings: [], referrals: [], goals: [], income: [], expenses: [], teamMembers: [],
        settings: Object.assign({ currency: "USD", pipelineStages: [], commissionDefaults: {} }, settings),
        metadata: {},
      }),
      settings: {
        get: () => Object.assign({ currency: "USD" }, settings),
        update: async (patch) => { saved.push(patch); return patch; },
        updateBusinessProfile: async () => ({}),
        updateCommissionDefaults: async () => ({}),
      },
    },
  });
  if (!b) return null;
  const pane = b.document.createElement("div");
  b.document.body.appendChild(pane);
  await b.window.App.pages.release.renderSettings(pane, "business-profile");
  await settle(b.window);
  return Object.assign({}, b, { pane, saved });
}

const saveSettings = async (p) => {
  const btn = Array.from(p.pane.querySelectorAll("button"))
    .find((b) => /^save/i.test(b.textContent.trim()));
  assert.ok(btn, "the settings pane has a save button");
  btn.click();
  await settle(p.window);
};

domTest("a bad country code is refused inline, and nothing is saved", SETTINGS, async () => {
  const p = await businessProfile();
  const field = p.pane.querySelector("#setCountryCode");
  assert.ok(field, "the field is on the business profile");

  for (const bad of ["971501234567", "+", "abc", "+12345", "00971"]) {
    field.value = bad;
    p.saved.length = 0;
    await saveSettings(p);
    const err = p.pane.querySelector("#setCountryCodeError");
    assert.equal(err.style.display, "block", bad + " should be refused");
    assert.match(err.textContent, /1 to 4 digits/);
    assert.deepEqual(p.saved, [], "nothing is written while a field is wrong: " + bad);
  }
});

domTest("a good country code saves, normalized with its plus, and blank is allowed", SETTINGS, async () => {
  const p = await businessProfile();
  const field = p.pane.querySelector("#setCountryCode");

  field.value = "971";
  await saveSettings(p);
  assert.equal(p.saved.length, 1);
  assert.equal(p.saved[0].defaultCountryCode, "+971", "stored with the plus it will be dialled with");
  assert.equal(p.pane.querySelector("#setCountryCodeError").style.display, "none");

  p.saved.length = 0;
  field.value = "+44";
  await saveSettings(p);
  assert.equal(p.saved[0].defaultCountryCode, "+44");

  // Blank means "dial numbers exactly as stored", which is a valid choice.
  p.saved.length = 0;
  field.value = "";
  await saveSettings(p);
  assert.equal(p.saved[0].defaultCountryCode, "");
});

domTest("the reminder hours field is bounded, and saves with the rest", SETTINGS, async () => {
  const p = await businessProfile({ followUpReminderHours: 6 });
  const hours = p.pane.querySelector("#setReminderHours");
  assert.ok(hours, "the reminder setting is on the business profile");
  assert.equal(hours.value, "6", "it shows what the workspace has set");

  for (const bad of ["0", "73", "", "2.5"]) {
    hours.value = bad;
    p.saved.length = 0;
    await saveSettings(p);
    assert.equal(p.pane.querySelector("#setReminderHoursError").style.display, "block",
      bad + " hours should be refused");
    assert.deepEqual(p.saved, [], "and nothing saved");
  }

  hours.value = "12";
  p.saved.length = 0;
  await saveSettings(p);
  assert.equal(p.saved[0].followUpReminderHours, 12);
});
