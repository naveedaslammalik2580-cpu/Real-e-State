// Goals: a target for the year, and the progress counted against it.
//
// Progress is the whole product here. A goal that shows the wrong
// number is worse than no goal, so what is pinned is that the figure
// comes from the real records - closed deals, contacts, referrals - and
// not from anything stored on the goal itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { page, domTest, setField, writesOf, plain, settle } from "./crm-helpers.mjs";

const SCRIPTS = [
  "assets/js/core/utils.js",
  "assets/js/core/commission.js",
  "assets/js/core/derived.js",
  "assets/js/core/customization.js",
  "assets/js/app.js",
  "assets/js/pages/goals.js",
];

const YEAR = 2026;

const wonDeal = (over = {}) => Object.assign({
  id: "dl_" + Math.random().toString(36).slice(2, 8),
  name: "Khan — 12 Elm Road", contactId: "ct_1", side: "Buyer",
  stage: "Closed", probability: 100, salePrice: 500000, commissionRate: 3,
  teamSplit: 0, brokerageFee: 0, referralFee: 0, taxReserve: 0,
  closeDate: YEAR + "-06-01", createdAt: YEAR + "-01-01T00:00:00Z",
}, over);

async function goalsPage(seed) {
  const p = await page(SCRIPTS, Object.assign({ today: YEAR + "-10-15" }, seed));
  if (!p) return null;
  await p.window.App.pages.goals.render(p.pane);
  await settle(p.window);
  return p;
}

const dom = (name, fn) => domTest(test, SCRIPTS, name, fn);

dom("with no goals the page invites the first one", async () => {
  const p = await goalsPage({ goals: [] });
  assert.match(p.text(), /goal/i);
  assert.ok(p.pane.querySelector("#addGoalBtn"));
});

dom("a goal shows its target and what has been done against it", async () => {
  const p = await goalsPage({
    goals: [{ id: "gl_1", type: "GCI", year: YEAR, target: 30000, notes: "" }],
    contacts: [{ id: "ct_1", name: "Sarah Khan", role: "Buyer", stage: "Client" }],
    // 500,000 at 3%, nothing deducted, is 15,000 - half of the target.
    deals: [wonDeal({ id: "dl_1" })],
  });
  const shown = p.text();
  assert.match(shown, /30,000|30000/, "the target is on the card: " + shown.slice(0, 300));
  assert.match(shown, /15,000|15000|50%/, "and the progress against it");
});

dom("progress counts this year's closed deals and nothing else", async () => {
  const p = await goalsPage({
    goals: [{ id: "gl_1", type: "GCI", year: YEAR, target: 100000, notes: "" }],
    contacts: [{ id: "ct_1", name: "Sarah Khan", role: "Buyer", stage: "Client" }],
    deals: [
      wonDeal({ id: "dl_won", closeDate: YEAR + "-06-01" }),
      wonDeal({ id: "dl_open", stage: "Under Contract", closeDate: YEAR + "-12-01" }),
      wonDeal({ id: "dl_lastyear", closeDate: (YEAR - 1) + "-06-01" }),
      wonDeal({ id: "dl_lost", stage: "Lost", closeDate: YEAR + "-05-01" }),
    ],
  });
  const progress = p.window.App.derived.allGoalsProgress(p.state);
  assert.ok(Array.isArray(progress) && progress.length === 1, JSON.stringify(progress));
  assert.equal(progress[0].current, 15000,
    "one closed deal this year: not the open one, not last year's, not the lost one");
  assert.equal(progress[0].target, 100000);
});

dom("creating a goal saves the type, year and target as numbers", async () => {
  const p = await goalsPage({ goals: [] });
  p.pane.querySelector("#addGoalBtn").click();
  await settle(p.window);
  const m = p.modal();
  assert.ok(m);

  setField(m, "#gType", "GCI");
  setField(m, "#gYear", String(YEAR));
  setField(m, "#gTarget", "120000");
  m.querySelector('[data-role="save"]').click();
  await settle(p.window);

  const created = writesOf(p, "goals.create");
  assert.equal(created.length, 1, JSON.stringify(p.writes));
  const model = plain(created[0][1]);
  assert.equal(model.type, "GCI");
  assert.equal(model.year, YEAR, "a number, not '2026'");
  assert.equal(model.target, 120000);
});

dom("a goal with no target is refused", async () => {
  const p = await goalsPage({ goals: [] });
  p.pane.querySelector("#addGoalBtn").click();
  await settle(p.window);
  const m = p.modal();
  setField(m, "#gTarget", "0");
  m.querySelector('[data-role="save"]').click();
  await settle(p.window);
  assert.equal(writesOf(p, "goals.create").length, 0,
    "a target of nothing is not a goal: " + JSON.stringify(p.writes));
});

dom("deleting a goal removes it", async () => {
  const p = await goalsPage({
    goals: [{ id: "gl_1", type: "GCI", year: YEAR, target: 30000, notes: "" }],
  });
  const del = p.pane.querySelector("[data-del-goal]");
  assert.ok(del, "there is a way to remove one");
  del.click();
  await settle(p.window);
  // The page asks first; confirm through the dialog it opened.
  const ok = p.document.querySelector('.modal [data-role="ok"]');
  if (ok) { ok.click(); await settle(p.window); }
  assert.equal(writesOf(p, "goals.delete").length, 1, JSON.stringify(p.writes));
});
