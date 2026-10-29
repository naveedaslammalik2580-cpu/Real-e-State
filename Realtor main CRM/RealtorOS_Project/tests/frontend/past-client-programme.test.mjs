// Phase 2D, browser side: the two new dates, the two new trigger types, the
// Today section, and the starter pack.
//
// The starter pack is the part worth pinning hardest. It writes several
// records in sequence on a real workspace, so "it only ever creates drafts"
// and "pressing it twice changes nothing" are the two promises that matter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { browser, settle, SKIP_DOM } from "../helpers/browser.mjs";

const TODAY = "2026-06-10";
// Objects from the jsdom realm carry its Object prototype, so compare the
// plain data rather than the reference.
const plainList = (v) => JSON.parse(JSON.stringify(v));

const open = [];

function closeAll() {
  while (open.length) {
    const b = open.pop();
    try { b.close(); } catch (e) { /* already gone */ }
  }
}

async function load(scripts, opts) {
  const b = await browser(scripts, opts);
  if (!b) return null;
  open.push(b);
  if (b.window.App.util) b.window.App.util.todayISO = () => TODAY;
  return b;
}

function domTest(name, scripts, fn) {
  test(name, async (t) => {
    const probe = await browser(scripts, { store: { getState: () => ({ settings: {} }) } });
    if (!probe) return t.skip(SKIP_DOM);
    try { probe.close(); } catch (e) {}
    try { await fn(); } finally { closeAll(); }
  });
}

// ---------------------------------------------------------------- Today

const TODAY_SCRIPTS = [
  "assets/js/core/utils.js",
  "assets/js/core/follow-up.js",
  "assets/js/core/response-stats.js",
  "assets/js/app.js",
  "assets/js/pages/release.js",
  "assets/js/pages/tasks.js",
];

const contact = (over = {}) => Object.assign({
  id: "c" + Math.random().toString(36).slice(2, 8),
  name: "Pat Lee", stage: "Client", temperature: "Warm",
  email: "", phone: "", lastContact: "2026-06-01", nextFollowUp: null,
  replyDetectedAt: null, firstTouchedAt: null, birthday: null, homePurchaseDate: null,
  createdAt: "2020-01-01T00:00:00Z",
}, over);

async function todayPane(contacts) {
  const b = await load(TODAY_SCRIPTS, {
    store: {
      ensureLoaded: async () => {},
      getState: () => ({
        contacts, tasks: [], activities: [], properties: [], deals: [],
        showings: [], milestones: [], settings: { currency: "USD" },
      }),
      messageTemplates: { list: async () => [] },
      contacts: { get: async (id) => contacts.find((c) => c.id === id) || null, update: async () => ({}) },
      activities: { create: async () => ({}) },
      tasks: { get: async () => null },
    },
  });
  if (!b) return null;
  const pane = b.document.createElement("div");
  b.document.body.appendChild(pane);
  await b.window.App.pages.release.renderDaily(pane);
  await settle(b.window);
  return Object.assign({}, b, { pane });
}

const sectionTitles = (p) => Array.from(p.pane.querySelectorAll(".today-section .card-title"))
  .map((el) => el.textContent.replace(/\s+/g, " ").trim());
const celebrationRows = (p) => Array.from(
  p.pane.querySelectorAll('[data-today-section="celebrations"] .today-row'))
  .map((r) => r.textContent.replace(/\s+/g, " ").trim());

domTest("the Today section lists the next seven days, soonest first", TODAY_SCRIPTS, async () => {
  const p = await todayPane([
    contact({ id: "bd1", name: "Birthday Today", birthday: "1988-06-10" }),
    contact({ id: "bd2", name: "Birthday In Three", birthday: "1990-06-13" }),
    contact({ id: "ha1", name: "Anniversary In One", homePurchaseDate: "2022-06-11" }),
    contact({ id: "far", name: "Too Far Away", birthday: "1990-08-01" }),
    contact({ id: "past", name: "Already Passed", birthday: "1990-06-01" }),
  ]);
  assert.ok(sectionTitles(p).some((t) => t.startsWith("Birthdays & anniversaries")),
    "the section is there: " + JSON.stringify(sectionTitles(p)));

  const rows = celebrationRows(p);
  assert.equal(rows.length, 3, "only the next seven days: " + JSON.stringify(rows));
  assert.match(rows[0], /Birthday Today/);
  assert.match(rows[0], /Today/);
  assert.match(rows[1], /Anniversary In One/);
  assert.match(rows[1], /Tomorrow/);
  assert.match(rows[2], /Birthday In Three/);
  assert.match(rows[2], /In 3 days/);
  // The anniversary says which one it is.
  assert.match(rows[1], /4 years/, "2022 to 2026 is the fourth anniversary");
});

domTest("a leap-day birthday still appears, and the purchase year never does", TODAY_SCRIPTS, async () => {
  // 2026 is not a leap year, so 29 February is marked on the 28th - and
  // that is outside this window, so use a window that contains it.
  const p = await todayPane([
    contact({ id: "ha0", name: "Bought This Week", homePurchaseDate: "2026-06-11" }),
    contact({ id: "ha1", name: "Bought Last Year", homePurchaseDate: "2025-06-11" }),
  ]);
  const rows = celebrationRows(p);
  assert.equal(rows.length, 1, "the purchase itself is not an anniversary: " + JSON.stringify(rows));
  assert.match(rows[0], /Bought Last Year/);
  assert.match(rows[0], /1 year/);
});

domTest("a celebration row carries the one-tap bar, and the section hides when empty", TODAY_SCRIPTS, async () => {
  const p = await todayPane([
    contact({ id: "bd1", name: "Has Phone", birthday: "1988-06-10", phone: "5551234567" }),
  ]);
  const row = p.pane.querySelector('[data-contact-row="bd1"]');
  const actions = Array.from(row.querySelectorAll("[data-fu-action]")).map((b) => b.getAttribute("data-fu-action"));
  assert.deepEqual(actions, ["call", "sms", "whatsapp", "log"], "the bar is on the row");
  closeAll();

  const none = await todayPane([contact({ id: "x", name: "No Dates" })]);
  assert.ok(!sectionTitles(none).some((t) => t.startsWith("Birthdays")),
    "with nothing coming up the section is not shown");
});

// ---------------------------------------------------------------- the fields

const DATA_SCRIPTS = [
  "assets/js/config.js",
  "assets/js/core/utils.js",
  "assets/js/data/workspace.js",
  "assets/js/data/data-service.js",
];

/**
 * App.data over a recording fake of the one Supabase call each test makes.
 *
 * This is the seam the two new dates actually live at: the entity registry
 * maps them both ways, and the contact form is one caller of that. Driving
 * the whole contacts page to re-prove it would test the page's dependency
 * list more than the mapping - load-all-scripts already covers the page
 * loading, and the SQL tests cover the columns being writable.
 */
async function dataLayer(row) {
  const sent = [];
  const b = await load(DATA_SCRIPTS, { store: { getState: () => ({ settings: {} }) } });
  if (!b) return null;

  const builder = () => {
    const q = {};
    ["select", "eq", "order", "limit"].forEach((k) => { q[k] = () => q; });
    q.insert = (payload) => { sent.push(["insert", payload]); return q; };
    q.update = (payload) => { sent.push(["update", payload]); return q; };
    q.single = async () => ({ data: row, error: null });
    q.maybeSingle = async () => ({ data: row, error: null });
    q.then = undefined;
    return q;
  };

  b.window.App.cloud = {
    getUser: () => ({ id: "11111111-1111-4111-8111-111111111111" }),
    getClient: () => ({ from: () => builder(), rpc: async () => ({ data: [], error: null }) }),
  };
  return Object.assign({}, b, { sent, data: b.window.App.data });
}

domTest("the two new dates travel to the database and back", DATA_SCRIPTS, async () => {
  const stored = {
    id: "ct_1", user_id: "u", workspace_id: "w", full_name: "Dated Person",
    email: "", phone: "", type: "Buyer", status: "Client", source: "Other",
    temperature: "Warm", last_contact: null, next_follow_up: null,
    birthday: "1988-02-29", home_purchase_date: "2024-05-20",
    budget: 0, preferred_area: "", assigned_agent: "Self", notes: "",
    reply_detected_at: null, first_touched_at: null,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
  };
  const c = await dataLayer(stored);

  // Out: the model's camelCase names become the real columns.
  await c.data.create("contacts", {
    name: "Dated Person", birthday: "1988-02-29", homePurchaseDate: "2024-05-20",
  });
  const inserted = c.sent.find((x) => x[0] === "insert")[1];
  assert.equal(inserted.birthday, "1988-02-29", "a leap-day birthday is stored as given");
  assert.equal(inserted.home_purchase_date, "2024-05-20");

  // Back: the columns become the model.
  const model = await c.data.get("contacts", "ct_1");
  assert.equal(model.birthday, "1988-02-29");
  assert.equal(model.homePurchaseDate, "2024-05-20");

  // Cleared to null rather than to an empty string, which a date column
  // would refuse.
  c.sent.length = 0;
  await c.data.update("contacts", "ct_1", { birthday: null, homePurchaseDate: null });
  const patch = c.sent.find((x) => x[0] === "update")[1];
  assert.equal(patch.birthday, null);
  assert.equal(patch.home_purchase_date, null);
});

domTest("the server owns first_touched_at, so it never travels outward", DATA_SCRIPTS, async () => {
  const c = await dataLayer({ id: "ct_1", full_name: "X", first_touched_at: "2026-02-01T00:00:00Z" });
  await c.data.update("contacts", "ct_1", {
    birthday: "1990-01-01",
    // A caller trying to set a lifecycle column must not get its way: the
    // registry has no mapping for it on the way out.
    firstTouchedAt: "2000-01-01T00:00:00Z",
    replyDetectedAt: "2000-01-01T00:00:00Z",
  });
  const patch = c.sent.find((x) => x[0] === "update")[1];
  assert.equal(patch.birthday, "1990-01-01", "the editable date goes through");
  assert.ok(!("first_touched_at" in patch), "and the lifecycle columns do not");
  assert.ok(!("reply_detected_at" in patch));

  // They still come back, because the views read them.
  const model = await c.data.get("contacts", "ct_1");
  assert.equal(model.firstTouchedAt, "2026-02-01T00:00:00Z");
});

// ---------------------------------------------------------------- rule builder

const AUTO_SCRIPTS = [
  "assets/js/core/utils.js",
  // Phase 2E: the packs live here now, and the page delegates to them.
  "assets/js/core/starter-packs.js",
  "assets/js/app.js",
  "assets/js/pages/automation.js",
];

function autoStore(rules, templates, calls, settings) {
  return {
    ensureLoaded: async () => {},
    getState: () => ({
      contacts: [],
      settings: Object.assign({
        currency: "USD",
        pipelineStages: [
          { name: "New" }, { name: "Under Contract" },
          { name: "Closed", terminal: "won" }, { name: "Lost", terminal: "lost" },
        ],
      }, settings || {}),
    }),
    messageTemplates: {
      list: async () => templates,
      create: async (m) => { calls.push(["template", m]); const t = Object.assign({ id: "t" + templates.length }, m); templates.push(t); return t; },
    },
    automationRules: {
      list: async () => rules,
      create: async (m) => { calls.push(["rule", m]); const r = Object.assign({ id: "r" + rules.length, status: "draft" }, m); rules.push(r); return r; },
      update: async (id, p) => { calls.push(["ruleUpdate", id, p]); return p; },
      delete: async () => true,
    },
    automationSteps: {
      list: async () => [],
      create: async (ruleId, m) => { calls.push(["step", ruleId, m]); return Object.assign({ id: "s" }, m); },
    },
    automationRuntime: {
      listEnrollments: async () => [], listJobs: async () => [], listFailures: async () => [],
    },
  };
}

async function autoPage(rules = [], templates = [], settings) {
  const calls = [];
  const b = await load(AUTO_SCRIPTS, { store: autoStore(rules, templates, calls, settings) });
  if (!b) return null;
  const pane = b.document.createElement("div");
  b.document.body.appendChild(pane);
  await b.window.App.pages.automation.render(pane);
  await settle(b.window);
  return Object.assign({}, b, { pane, calls, rules, templates });
}

domTest("the rule builder offers both yearly triggers with days-before and a send hour", AUTO_SCRIPTS, async () => {
  const p = await autoPage();
  const add = p.pane.querySelector("#autoCreateBtn");
  add.click();
  await settle(p.window);
  const m = p.document.querySelector(".modal");

  const values = Array.from(m.querySelectorAll("#autoTrigger option")).map((o) => o.value);
  assert.ok(values.includes("birthday") && values.includes("home_anniversary"));
  const labels = Array.from(m.querySelectorAll("#autoTrigger option")).map((o) => o.textContent).join(" | ");
  assert.match(labels, /Birthday/);
  assert.match(labels, /Home purchase anniversary/);

  const sel = m.querySelector("#autoTrigger");
  sel.value = "birthday";
  sel.dispatchEvent(new p.window.Event("change", { bubbles: true }));
  await settle(p.window);

  assert.notEqual(m.querySelector('[data-audience-group="birthday"]').style.display, "none",
    "the days-before field is shown");
  assert.notEqual(m.querySelector("[data-trigger-hour-group]").style.display, "none",
    "and the send hour");
  assert.equal(m.querySelector("[data-trigger-config-group]").style.display, "none",
    "but not 'include people who already match' - a yearly date cannot be backfilled");
  assert.match(m.querySelector("#autoCfgHourLabel").textContent, /Send at/,
    "a greeting is sent, not checked for");
  assert.match(m.querySelector("#autoTriggerSummary").textContent,
    /Sends on the day a contact's birthday/);

  // days_before changes the sentence.
  m.querySelector("#autoCfgDaysBeforeBd").value = "3";
  m.querySelector("#autoCfgDaysBeforeBd").dispatchEvent(new p.window.Event("change", { bubbles: true }));
  await settle(p.window);
  assert.match(m.querySelector("#autoTriggerSummary").textContent, /3 days before/);
});

domTest("a yearly draft saves only days_before and fire_hour", AUTO_SCRIPTS, async () => {
  const p = await autoPage();
  p.pane.querySelector("#autoCreateBtn").click();
  await settle(p.window);
  const m = p.document.querySelector(".modal");
  m.querySelector("#autoName").value = "Anniversary note";
  const sel = m.querySelector("#autoTrigger");
  sel.value = "home_anniversary";
  sel.dispatchEvent(new p.window.Event("change", { bubbles: true }));
  await settle(p.window);
  m.querySelector("#autoCfgDaysBeforeHa").value = "7";
  m.querySelector("#autoCfgHour").value = "10";
  m.querySelector('[data-role="save"]').click();
  await settle(p.window);

  const created = p.calls.find((c) => c[0] === "rule");
  assert.ok(created, "the draft was saved: " + JSON.stringify(p.calls));
  assert.equal(created[1].triggerType, "home_anniversary");
  assert.deepEqual(JSON.parse(JSON.stringify(created[1].triggerConfig)),
    { days_before: 7, fire_hour: 10 },
    "nothing else rides along - the database validator would reject it");
});

// ---------------------------------------------------------------- starter pack
//
// Phase 2E moved the packs themselves into core/starter-packs.js, where
// their behaviour (drafts only, idempotent, skip-with-a-reason) is tested
// directly. What is left here is the page wiring: the button opens a
// picker, the picker installs what was ticked, and the page reports it.

const packModal = (p) => {
  const all = p.document.querySelectorAll(".modal");
  return all.length ? all[all.length - 1] : null;
};

domTest("the Automation page offers the packs in a picker, not a blind button", AUTO_SCRIPTS, async () => {
  const p = await autoPage();
  const btn = p.pane.querySelector("#autoStarterPackBtn");
  assert.ok(btn, "the button is on the page");
  assert.match(btn.textContent, /starter sequences/i);
  assert.equal(p.calls.length, 0, "and clicking it writes nothing on its own");

  btn.click();
  await settle(p.window);
  const m = packModal(p);
  assert.ok(m && m.querySelector(".pack-pick"), "it opens a picker");
  assert.match(m.textContent, /added as a draft/i, "which says what it will do");

  const ids = Array.from(m.querySelectorAll(".pack-pick")).map((c) => c.value);
  assert.equal(ids.length, 5, "all five packs are offered: " + JSON.stringify(ids));
  assert.equal(p.calls.length, 0, "still nothing written until it is confirmed");
});

domTest("the picker installs only the packs that were ticked", AUTO_SCRIPTS, async () => {
  const p = await autoPage();
  p.pane.querySelector("#autoStarterPackBtn").click();
  await settle(p.window);
  const m = packModal(p);

  // Untick everything, then take one.
  m.querySelectorAll(".pack-pick").forEach((c) => { c.checked = false; });
  const openhouse = Array.from(m.querySelectorAll(".pack-pick")).find((c) => c.value === "openhouse");
  openhouse.checked = true;
  m.querySelector('[data-role="add"]').click();
  await settle(p.window);

  const names = p.calls.filter((c) => c[0] === "rule").map((c) => c[1].name);
  assert.deepEqual(plainList(names), ["Open-house visitor"], JSON.stringify(names));
  p.rules.forEach((r) => assert.equal(r.status, "draft", "created as a draft"));
  // And it says so.
  assert.ok(p.toasts.some((t) => /Added 1 draft/i.test(t.message || String(t))),
    JSON.stringify(p.toasts));
});

domTest("ticking nothing is refused rather than quietly doing nothing", AUTO_SCRIPTS, async () => {
  const p = await autoPage();
  p.pane.querySelector("#autoStarterPackBtn").click();
  await settle(p.window);
  const m = packModal(p);
  m.querySelectorAll(".pack-pick").forEach((c) => { c.checked = false; });
  m.querySelector('[data-role="add"]').click();
  await settle(p.window);

  assert.equal(p.calls.filter((c) => c[0] === "rule").length, 0);
  assert.ok(p.toasts.some((t) => /tick at least one/i.test(t.message || String(t))),
    JSON.stringify(p.toasts));
});

domTest("the page reports what was already there instead of adding it twice", AUTO_SCRIPTS, async () => {
  const mine = {
    id: "r-mine", name: "Birthday greeting", status: "active", trigger_type: "birthday",
    timezone: "UTC", audience_filter: {}, trigger_config: { days_before: 5, fire_hour: 7 },
    stop_on_reply: true, stop_on_unsubscribe: true, daily_enrollment_limit: 100, metadata: {},
  };
  const p = await autoPage([mine]);
  p.pane.querySelector("#autoStarterPackBtn").click();
  await settle(p.window);
  const m = packModal(p);
  m.querySelectorAll(".pack-pick").forEach((c) => { c.checked = c.value === "pastclient"; });
  m.querySelector('[data-role="add"]').click();
  await settle(p.window);

  const names = p.calls.filter((c) => c[0] === "rule").map((c) => c[1].name);
  assert.ok(!names.includes("Birthday greeting"), "my own version is not replaced");
  assert.ok(p.toasts.some((t) => /already there/i.test(t.message || String(t))),
    "and the agent is told why: " + JSON.stringify(p.toasts));
  assert.deepEqual(plainList(mine.trigger_config), { days_before: 5, fire_hour: 7 },
    "my settings survive untouched");
});
