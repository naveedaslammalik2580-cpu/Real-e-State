// Income and expenses: two lists, one form, and the totals underneath.
//
// Money typed into a form is the one place a string that looks like a
// number does real damage, so what is pinned here is that an amount
// arrives as a number, that nothing saves without one, and that the
// totals are the sum of what is actually there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { page, domTest, setField, writesOf, plain, settle } from "./crm-helpers.mjs";

const SCRIPTS = [
  "assets/js/core/utils.js",
  "assets/js/core/commission.js",
  "assets/js/core/derived.js",
  "assets/js/core/customization.js",
  "assets/js/app.js",
  "assets/js/pages/finances.js",
];

const TODAY = "2026-10-15";

const record = (over = {}) => Object.assign({
  id: "fn_" + Math.random().toString(36).slice(2, 8),
  description: "Portal subscription", amount: 120, date: "2026-10-01",
  category: "Other", contactId: null, dealId: null, notes: "",
}, over);

async function money(seed) {
  const p = await page(SCRIPTS, Object.assign({ today: TODAY }, seed));
  if (!p) return null;
  await p.window.App.pages.finances.render(p.pane);
  await settle(p.window);
  return p;
}

const rows = (p) => Array.from(p.pane.querySelectorAll("[data-fin-id]"));
const dom = (name, fn) => domTest(test, SCRIPTS, name, fn);

dom("an empty ledger says so on both tabs", async () => {
  const p = await money({ income: [], expenses: [] });
  assert.equal(rows(p).length, 0);
  const first = p.text();
  p.pane.querySelector("#tabExpenses").click();
  await settle(p.window);
  assert.equal(rows(p).length, 0);
  assert.ok(first.length && p.text().length, "both tabs render rather than going blank");
});

dom("income and expenses are separate lists, switched by their tabs", async () => {
  const p = await money({
    income: [record({ id: "in_1", description: "Commission — Elm Road", amount: 9000 })],
    expenses: [record({ id: "ex_1", description: "Portal subscription", amount: 120 })],
  });

  assert.match(p.text(), /Commission — Elm Road/, "income is the tab that opens first");
  assert.ok(!/Portal subscription/.test(p.text()), "and an expense is not in it");

  p.pane.querySelector("#tabExpenses").click();
  await settle(p.window);
  assert.match(p.text(), /Portal subscription/);
  assert.ok(!/Commission — Elm Road/.test(p.text()), "the two ledgers do not bleed into each other");
});

dom("adding income saves the amount as a number", async () => {
  const p = await money({ income: [], expenses: [] });
  p.pane.querySelector("#addIncBtn").click();
  await settle(p.window);
  const m = p.modal();
  assert.ok(m, "the form opened");

  setField(m, "#ffDesc", "  Commission — Elm Road  ");
  setField(m, "#ffAmount", "9000.50");
  setField(m, "#ffDate", "2026-10-02");
  m.querySelector('[data-role="save"]').click();
  await settle(p.window);

  const created = writesOf(p, "income.create");
  assert.equal(created.length, 1, JSON.stringify(p.writes.map((w) => w[0])));
  const model = plain(created[0][1]);
  assert.equal(model.description, "Commission — Elm Road", "trimmed");
  assert.equal(model.amount, 9000.5, "a number with its pennies, not a string");
  assert.equal(model.date, "2026-10-02");
  assert.equal(writesOf(p, "expenses.create").length, 0, "and it went in the right ledger");
});

dom("adding an expense goes to the other ledger", async () => {
  const p = await money({ income: [], expenses: [] });
  p.pane.querySelector("#addExpBtn").click();
  await settle(p.window);
  const m = p.modal();
  setField(m, "#ffDesc", "Portal subscription");
  setField(m, "#ffAmount", "120");
  m.querySelector('[data-role="save"]').click();
  await settle(p.window);

  assert.equal(writesOf(p, "expenses.create").length, 1);
  assert.equal(writesOf(p, "income.create").length, 0);
});

dom("a record with no description or no amount is refused", async () => {
  const p = await money({ income: [], expenses: [] });
  p.pane.querySelector("#addIncBtn").click();
  await settle(p.window);
  const m = p.modal();

  m.querySelector('[data-role="save"]').click();
  await settle(p.window);
  assert.equal(writesOf(p, "income.create").length, 0, "nothing at all");
  assert.ok(m.querySelector("#ffDesc").closest(".form-field").classList.contains("has-error"));

  // A description but nothing to count.
  setField(m, "#ffDesc", "Commission");
  setField(m, "#ffAmount", "0");
  m.querySelector('[data-role="save"]').click();
  await settle(p.window);
  assert.equal(writesOf(p, "income.create").length, 0, "zero is not an amount");
  assert.ok(m.querySelector("#ffAmount").closest(".form-field").classList.contains("has-error"));
});

dom("the totals are the sum of what is on the page", async () => {
  const p = await money({
    income: [
      record({ id: "in_1", description: "Commission A", amount: 9000, date: "2026-03-01" }),
      record({ id: "in_2", description: "Commission B", amount: 6000, date: "2026-04-01" }),
    ],
    expenses: [record({ id: "ex_1", description: "Portal", amount: 1200, date: "2026-02-01" })],
  });
  const shown = p.text();
  assert.match(shown, /15,000|15000/, "income adds up: " + shown.slice(0, 400));
  assert.match(shown, /1,200|1200/, "expenses too");
  // 15,000 - 1,200 = 13,800 net.
  assert.match(shown, /13,800|13800/, "and the net is the difference");
  assert.ok(!/NaN/.test(p.html()), "no NaN anywhere");
});
