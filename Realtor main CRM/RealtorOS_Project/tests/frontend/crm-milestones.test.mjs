// Milestones: a deal's timeline, and the one button that advances it.
//
// Completing the wrong milestone silently shifts a deal's whole
// timeline, which is why the control asks first. These tests pin that
// it asks, that it writes only after the answer, and that "overdue"
// means what a date says rather than what a status says.
import { test } from "node:test";
import assert from "node:assert/strict";
import { page, domTest, writesOf, settle } from "./crm-helpers.mjs";

const SCRIPTS = [
  "assets/js/core/utils.js",
  "assets/js/core/commission.js",
  "assets/js/core/derived.js",
  "assets/js/core/customization.js",
  "assets/js/ui/custom-fields-ui.js",
  "assets/js/app.js",
  "assets/js/pages/deals.js",
];

const TODAY = "2026-10-15";

const DEAL = {
  id: "dl_1", name: "Khan — 12 Elm Road", contactId: "ct_1", propertyId: null, side: "Buyer",
  stage: "Under Contract", probability: 85, salePrice: 500000, commissionRate: 3,
  teamSplit: 0, brokerageFee: 20, referralFee: 0, taxReserve: 25,
  offerDate: "2026-09-01", closeDate: "2026-11-01", notes: "",
  createdAt: "2026-01-01T00:00:00Z",
};

const milestone = (over = {}) => Object.assign({
  id: "ms_" + Math.random().toString(36).slice(2, 8),
  dealId: "dl_1", name: "Survey booked", dueDate: "2026-10-20",
  status: "Pending", order: 1, notes: "",
}, over);

async function detail(milestones) {
  const p = await page(SCRIPTS, {
    deals: [DEAL],
    contacts: [{ id: "ct_1", name: "Sarah Khan", role: "Buyer", stage: "Client" }],
    properties: [], milestones, activities: [], tasks: [], showings: [],
    today: TODAY,
  });
  if (!p) return null;
  await p.window.App.pages.deals.renderDealDetail(p.pane, "dl_1");
  await settle(p.window);
  return p;
}

const dom = (name, fn) => domTest(test, SCRIPTS, name, fn);

dom("a deal's milestones are listed in their own order", async () => {
  const p = await detail([
    milestone({ id: "ms_2", name: "Searches back", order: 2, dueDate: "2026-10-25" }),
    milestone({ id: "ms_1", name: "Survey booked", order: 1, dueDate: "2026-10-20" }),
    milestone({ id: "ms_3", name: "Exchange", order: 3, dueDate: "2026-10-30" }),
  ]);
  const shown = p.text();
  assert.ok(shown.indexOf("Survey booked") < shown.indexOf("Searches back"),
    "by order, not by the order they arrived: " + shown.slice(0, 300));
  assert.ok(shown.indexOf("Searches back") < shown.indexOf("Exchange"));
});

dom("the card counts how many are done", async () => {
  const p = await detail([
    milestone({ id: "ms_1", name: "Survey booked", status: "Complete", order: 1 }),
    milestone({ id: "ms_2", name: "Searches back", status: "Pending", order: 2 }),
    milestone({ id: "ms_3", name: "Exchange", status: "Pending", order: 3 }),
  ]);
  assert.match(p.text(), /1 \/ 3/, "one of three: " + p.text().slice(0, 400));
});

dom("completing a milestone asks first, and writes only on yes", async () => {
  const p = await detail([milestone({ id: "ms_1", name: "Survey booked" })]);
  const btn = p.pane.querySelector("[data-complete-milestone]");
  assert.ok(btn, "there is a way to complete one");

  btn.click();
  await settle(p.window);
  assert.equal(writesOf(p, "milestones.complete").length, 0,
    "nothing is written while the question is still on screen");
  const dialog = p.document.querySelector(".modal");
  assert.ok(dialog, "it asked");
  assert.match(dialog.textContent, /Survey booked/,
    "and named the milestone, because completing the wrong one is the mistake");

  dialog.querySelector('[data-role="ok"]').click();
  await settle(p.window);
  const done = writesOf(p, "milestones.complete");
  assert.equal(done.length, 1, JSON.stringify(p.writes));
  assert.equal(done[0][1], "ms_1");
  assert.equal(p.state.milestones[0].status, "Complete");
});

dom("cancelling the question writes nothing", async () => {
  const p = await detail([milestone({ id: "ms_1", name: "Survey booked" })]);
  p.pane.querySelector("[data-complete-milestone]").click();
  await settle(p.window);
  const dialog = p.document.querySelector(".modal");
  dialog.querySelector('[data-role="cancel"]').click();
  await settle(p.window);
  assert.equal(writesOf(p, "milestones.complete").length, 0);
  assert.equal(p.state.milestones[0].status, "Pending", "still waiting, as it was");
});

dom("overdue is read off the due date, and a completed one never is", async () => {
  const p = await detail([milestone({ id: "ms_1" })]);
  const D = p.window.App.derived;

  assert.equal(D.milestoneStatus({ status: "Pending", dueDate: "2026-10-01" }).status, "overdue");
  assert.equal(D.milestoneStatus({ status: "Pending", dueDate: TODAY }).status, "due-today");
  assert.equal(D.milestoneStatus({ status: "Pending", dueDate: "2026-10-18" }).status, "upcoming");
  assert.equal(D.milestoneStatus({ status: "Pending", dueDate: "2026-12-01" }).status, "future");
  assert.equal(D.milestoneStatus({ status: "Complete", dueDate: "2026-01-01" }).status, "complete",
    "finished is finished, however late it was");
  assert.equal(D.milestoneStatus(null).status, "none", "and nothing is not overdue");
});

dom("a milestone's name is escaped", async () => {
  const p = await detail([milestone({ id: "ms_x", name: '<img src=x onerror="window.__pwned=1">' })]);
  assert.equal(p.pane.querySelectorAll("img").length, 0);
  assert.equal(p.window.__pwned, undefined);
});
