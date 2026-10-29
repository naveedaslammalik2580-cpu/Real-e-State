// Frontend: the Phase 2A trigger options in the sequence editor.
//
// Three things matter here. The settings the agent picks must reach the
// data layer in the shape the database validator accepts; the sentence that
// explains the trigger must be plain English rather than column names; and
// a saved rule's trigger must be shown without being editable once it is no
// longer a draft.
import { test } from "node:test";
import assert from "node:assert/strict";
import { browser, settle, SKIP_DOM } from "../helpers/browser.mjs";

// Words that belong to the engine, not to an estate agent.
const JARGON = /\b(event|outbox|worker|snapshot|scan|enrollment|trigger_config|fire_hour|include_existing|workspace_id|rule_id|upsert)\b/i;

const SCRIPTS = [
  "assets/js/core/utils.js",
  "assets/js/app.js",
  "assets/js/pages/automation.js",
];

function store(rules, calls) {
  return {
    ensureLoaded: async () => {},
    getState: () => ({
      contacts: [],
      settings: {
        currency: "USD",
        pipelineStages: [{ name: "New" }, { name: "Under Contract" }, { name: "Closed" }],
      },
    }),
    messageTemplates: { list: async () => [] },
    automationRules: {
      list: async () => rules,
      create: async (model) => { calls.push(["create", model]); return { id: "r-new", ...model }; },
      update: async (id, patch) => { calls.push(["update", id, patch]); return { id, ...patch }; },
      delete: async () => true,
    },
    automationSteps: { list: async () => [] },
    automationRuntime: {
      listEnrollments: async () => [],
      listJobs: async () => [],
      listFailures: async () => [],
    },
  };
}

const open = [];

async function page(rules = []) {
  const calls = [];
  const b = await browser(SCRIPTS, { store: store(rules, calls) });
  if (!b) return null;
  open.push(b);
  const pane = b.document.createElement("div");
  b.document.body.appendChild(pane);
  await b.window.App.pages.automation.render(pane);
  await settle(b.window);
  return { ...b, pane, calls };
}

function closeAll() {
  while (open.length) {
    const b = open.pop();
    try { b.close(); } catch (e) { /* already gone */ }
  }
}

function domTest(name, fn) {
  test(name, async (t) => {
    const probe = await page();
    if (!probe) return t.skip(SKIP_DOM);
    try { await fn(probe); } finally { closeAll(); }
  });
}

/** Opens the create-sequence modal and returns it. */
async function modal(p) {
  const addBtn = p.pane.querySelector('[data-role="add-rule"], #automationAddRule, button.btn-primary');
  assert.ok(addBtn, "the page must offer a way to create a sequence");
  addBtn.click();
  await settle(p.window);
  const m = p.document.querySelector(".modal, [role=dialog]") || p.document.body;
  assert.ok(m.querySelector("#autoTrigger"), "the sequence form must be open");
  return m;
}

const setTrigger = async (p, m, value) => {
  const sel = m.querySelector("#autoTrigger");
  sel.value = value;
  sel.dispatchEvent(new p.window.Event("change", { bubbles: true }));
  await settle(p.window);
};

const summary = (m) => (m.querySelector("#autoTriggerSummary") || {}).textContent || "";
// Objects built inside the jsdom window have that realm's Object prototype,
// so a strict deepEqual against a literal from this realm fails on the
// prototype alone. Comparing the plain data is what these tests mean.
const plain = (v) => JSON.parse(JSON.stringify(v));
const shown = (p, el) => !!el && el.style.display !== "none";

// ---------------------------------------------------------------- options

domTest("all four new starts are offered, worded for an agent", async (p) => {
  const m = await modal(p);
  const values = Array.from(m.querySelectorAll("#autoTrigger option")).map((o) => o.value);
  for (const v of ["follow_up_due", "no_contact", "status_stale", "deal_stage_changed"]) {
    assert.ok(values.includes(v), v + " must be offered");
  }
  const labels = Array.from(m.querySelectorAll("#autoTrigger option")).map((o) => o.textContent).join(" | ");
  assert.match(labels, /Follow-up date arrives/);
  assert.match(labels, /No contact for/);
  assert.match(labels, /Stuck in a status/);
  assert.match(labels, /Deal moves to a stage/);
  assert.ok(!JARGON.test(labels), "no engine words in the options: " + labels);
});

domTest("each trigger shows only its own settings", async (p) => {
  const m = await modal(p);

  await setTrigger(p, m, "no_contact");
  assert.ok(shown(p, m.querySelector('[data-audience-group="no_contact"]')), "days field shown");
  assert.ok(!shown(p, m.querySelector('[data-audience-group="status_stale"]')), "status_stale hidden");
  assert.ok(shown(p, m.querySelector("[data-trigger-hour-group]")), "daily hour shown");

  await setTrigger(p, m, "deal_stage_changed");
  assert.ok(shown(p, m.querySelector('[data-audience-group="deal_stage_changed"]')), "deal fields shown");
  assert.ok(!shown(p, m.querySelector("[data-trigger-hour-group]")),
    "a deal change has no daily schedule, so no hour picker");

  await setTrigger(p, m, "manual");
  assert.ok(!shown(p, m.querySelector("[data-trigger-config-group]")),
    "a manual sequence has no trigger settings at all");
});

domTest("the deal stage list comes from the workspace's own pipeline", async (p) => {
  const m = await modal(p);
  await setTrigger(p, m, "deal_stage_changed");
  const stages = Array.from(m.querySelectorAll("#autoCfgToStage option")).map((o) => o.value);
  assert.deepEqual(stages, ["", "New", "Under Contract", "Closed"],
    "blank (any stage) plus the configured stages, in order");
});

// ---------------------------------------------------------------- the sentence

domTest("the summary is a plain sentence naming the days, the hour and the timezone", async (p) => {
  const m = await modal(p);
  m.querySelector("#autoTimezone").value = "Asia/Dubai";
  await setTrigger(p, m, "no_contact");
  m.querySelector("#autoCfgDaysNoContact").value = "30";
  m.querySelector("#autoCfgHour").value = "8";
  m.querySelector("#autoCfgHour").dispatchEvent(new p.window.Event("change", { bubbles: true }));
  await settle(p.window);

  const text = summary(m);
  assert.match(text, /hasn't been contacted for 30 days/);
  assert.match(text, /8:00 AM/);
  assert.match(text, /Asia\/Dubai/);
  assert.ok(!JARGON.test(text), "no engine words in the summary: " + text);
});

domTest("the summary follows the trigger, and warns when the backlog is opted in", async (p) => {
  const m = await modal(p);
  await setTrigger(p, m, "follow_up_due");
  assert.match(summary(m), /follow-up date arrives/i);

  await setTrigger(p, m, "status_stale");
  m.querySelector("#autoCfgDaysStale").value = "14";
  const client = Array.from(m.querySelectorAll(".auto-cfg-status")).find((c) => c.value === "Client");
  client.checked = true;
  client.dispatchEvent(new p.window.Event("change", { bubbles: true }));
  await settle(p.window);
  assert.match(summary(m), /stayed in Client for 14 days/);

  const include = m.querySelector("#autoCfgIncludeExisting");
  include.checked = true;
  include.dispatchEvent(new p.window.Event("change", { bubbles: true }));
  await settle(p.window);
  assert.match(summary(m), /already match will be included/i);
  assert.match(summary(m), /daily limit/i);
});

domTest("the include-existing checkbox says plainly that it can add many at once", async (p) => {
  const m = await modal(p);
  await setTrigger(p, m, "no_contact");
  const group = m.querySelector("[data-trigger-config-group]");
  const text = group.textContent;
  assert.match(text, /Also include contacts who already match/i);
  assert.match(text, /daily limit/i);
  assert.ok(/careful|at once/i.test(text), "the warning has to actually warn: " + text);
});

// ---------------------------------------------------------------- saving

domTest("a draft saves exactly the settings its trigger accepts", async (p) => {
  const m = await modal(p);
  m.querySelector("#autoName").value = "Quiet thirty";
  m.querySelector("#autoTimezone").value = "UTC";
  await setTrigger(p, m, "no_contact");
  m.querySelector("#autoCfgDaysNoContact").value = "30";
  m.querySelector("#autoCfgHour").value = "9";
  m.querySelector('[data-role="save"]').click();
  await settle(p.window);

  const created = p.calls.find((c) => c[0] === "create");
  assert.ok(created, "the draft must be saved");
  assert.equal(created[1].triggerType, "no_contact");
  assert.deepEqual(plain(created[1].triggerConfig),
    { include_existing: false, fire_hour: 9, days: 30 });
  assert.deepEqual(plain(created[1].audienceFilter), {},
    "trigger settings must not leak into the audience filter");
});

domTest("switching the trigger does not carry the previous one's settings into the save", async (p) => {
  const m = await modal(p);
  m.querySelector("#autoName").value = "Stage watcher";
  await setTrigger(p, m, "no_contact");
  m.querySelector("#autoCfgDaysNoContact").value = "45";
  // Change your mind.
  await setTrigger(p, m, "deal_stage_changed");
  m.querySelector("#autoCfgToStage").value = "Under Contract";
  m.querySelector("#autoCfgSide").value = "Seller";
  m.querySelector('[data-role="save"]').click();
  await settle(p.window);

  const created = p.calls.find((c) => c[0] === "create");
  assert.ok(created);
  assert.deepEqual(plain(created[1].triggerConfig),
    { include_existing: false, to_stage: "Under Contract", side: "Seller" });
  assert.ok(!("days" in created[1].triggerConfig), "the abandoned days value must be gone");
  assert.ok(!("fire_hour" in created[1].triggerConfig), "and so must the hour");
});

domTest("a status_stale draft with nothing ticked means any status", async (p) => {
  const m = await modal(p);
  m.querySelector("#autoName").value = "Any status";
  await setTrigger(p, m, "status_stale");
  m.querySelector("#autoCfgDaysStale").value = "7";
  m.querySelector('[data-role="save"]').click();
  await settle(p.window);
  const created = p.calls.find((c) => c[0] === "create");
  assert.ok(created);
  assert.ok(!("statuses" in created[1].triggerConfig),
    "an empty list would be rejected, so the key is simply absent");
});

domTest("an out-of-range day count is refused before anything is sent", async (p) => {
  const m = await modal(p);
  m.querySelector("#autoName").value = "Bad days";
  await setTrigger(p, m, "no_contact");
  m.querySelector("#autoCfgDaysNoContact").value = "0";
  m.querySelector('[data-role="save"]').click();
  await settle(p.window);
  assert.equal(p.calls.filter((c) => c[0] === "create").length, 0, "nothing is saved");
  assert.ok(p.toasts.some((t) => /between 1 and 365/i.test(t.message || String(t))),
    "and the agent is told why: " + JSON.stringify(p.toasts));
});

// ---------------------------------------------------------------- read-only

domTest("an active rule shows its trigger in words, with no way to edit it", async () => {
  const active = {
    id: "r-1", name: "Quiet thirty", trigger_type: "no_contact", status: "active",
    timezone: "Asia/Dubai", audience_filter: {},
    trigger_config: { days: 30, fire_hour: 8, include_existing: false },
    stop_on_reply: true, stop_on_unsubscribe: true, daily_enrollment_limit: 100, metadata: {},
  };
  const p = await page([active]);
  const text = p.pane.textContent;
  assert.match(text, /hasn't been contacted for 30 days/);
  assert.match(text, /Asia\/Dubai/);
  assert.ok(!JARGON.test(text.replace(/Automation/g, "")), "no engine words on the card");
  // No editor for a live rule.
  assert.equal(p.pane.querySelector("#autoCfgDaysNoContact"), null,
    "an active rule must not expose an editable settings field");
});

domTest("user text on a rule card is escaped, never injected", async () => {
  const nasty = {
    id: "r-2", name: '<img src=x onerror="window.__pwned=1">', trigger_type: "deal_stage_changed",
    status: "active", timezone: "UTC", audience_filter: {},
    trigger_config: { to_stage: '</div><script>window.__pwned=1</script>', include_existing: false },
    stop_on_reply: true, stop_on_unsubscribe: true, daily_enrollment_limit: 100, metadata: {},
  };
  const p = await page([nasty]);
  assert.equal(p.window.__pwned, undefined, "nothing executed");
  assert.equal(p.pane.querySelector("img"), null, "the markup was not parsed as markup");
  assert.equal(p.pane.querySelector("script"), null);
  // The text is still shown, as text.
  assert.ok(p.pane.textContent.includes("onerror"), "and it is displayed literally");
});

domTest("Activity reuses plan cards, excludes drafts and has an honest empty state", async () => {
  const rule = { id: "active", name: "Active plan", status: "active", trigger_type: "manual", timezone: "UTC", trigger_config: {}, audience_filter: {} };
  const p = await page([rule, { ...rule, id: "draft", name: "Draft plan", status: "draft" }, { ...rule, id: "archived", name: "Archived plan", status: "archived" }]);
  await p.window.App.pages.automation.renderActivity(p.pane);
  assert.deepEqual(Array.from(p.pane.querySelectorAll("[data-rule-id]"), el => el.getAttribute("data-rule-id")), ["active", "archived"]);
  assert.equal(p.pane.querySelectorAll("[data-view-activity]").length, 2);
  assert.equal(p.pane.querySelector("#autoCreateBtn"), null);
  assert.deepEqual(p.calls, [], "viewing history writes nothing");
  const empty = await page([{ ...rule, status: "draft" }]);
  await empty.window.App.pages.automation.renderActivity(empty.pane);
  assert.match(empty.pane.textContent, /No plan activity yet/);
  await empty.window.App.pages.automation.render(empty.pane);
  assert.ok(empty.pane.querySelector("#autoCreateBtn"), "Plans retains its creation workflow");
  assert.equal(empty.pane.querySelectorAll("[data-rule-id]").length, 1, "draft remains reachable in Plans");
});
