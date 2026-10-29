// Deals, the pipeline board, and the commission arithmetic behind them.
//
// The money is the part worth pinning hardest. Every figure on this page
// comes out of core/commission.js, so these tests use the real module
// rather than a stub - a test against a stubbed calculator proves the
// stub. What is asserted is the number an agent would check against
// their own sums.
import { test } from "node:test";
import assert from "node:assert/strict";
import { page, domTest, setField, writesOf, plain, settle } from "./crm-helpers.mjs";

const SCRIPTS = [
  "assets/js/core/utils.js",
  "assets/js/core/commission.js",
  "assets/js/core/derived.js",
  "assets/js/core/customization.js",
  "assets/js/ui/custom-fields-ui.js",
  "assets/js/app.js",
  "assets/js/pages/deals.js",
];

const deal = (over = {}) => Object.assign({
  id: "dl_" + Math.random().toString(36).slice(2, 8),
  name: "Khan — 12 Elm Road", contactId: "ct_1", propertyId: null, side: "Buyer",
  // `stage` is the stage NAME. The board matches on it; the id is only
  // ever the column's own attribute.
  stage: "New", probability: 10, salePrice: 500000, commissionRate: 3,
  teamSplit: 0, brokerageFee: 20, referralFee: 0, taxReserve: 25,
  offerDate: null, closeDate: null, notes: "",
  createdAt: "2026-01-01T00:00:00Z",
}, over);

const contact = (over = {}) => Object.assign({
  id: "ct_1", name: "Sarah Khan", role: "Buyer", stage: "Client", temperature: "Warm",
  email: "", phone: "", budget: 0, createdAt: "2026-01-01T00:00:00Z",
}, over);

async function board(seed) {
  const p = await page(SCRIPTS, seed);
  if (!p) return null;
  await p.window.App.pages.deals.renderPipeline(p.pane);
  await settle(p.window);
  return p;
}

const cards = (p) => Array.from(p.pane.querySelectorAll(".kanban-card"));
const columnOf = (p, dealId) => {
  const card = p.pane.querySelector(`[data-deal-id="${dealId}"]`);
  return card ? card.closest(".kanban-col").getAttribute("data-stage-id") : null;
};

const dom = (name, fn) => domTest(test, SCRIPTS, name, fn);

dom("the board puts every live deal in its own column, and closed ones elsewhere", async () => {
  const empty = await board({ deals: [], contacts: [] });
  assert.match(empty.text(), /Create Your First Deal|No deals/i, empty.text());

  const p = await board({
    contacts: [contact()],
    deals: [
      deal({ id: "dl_1", stage: "New" }),
      deal({ id: "dl_2", stage: "Under Contract", name: "Byrne — 8 Oak Lane" }),
      deal({ id: "dl_3", stage: "Closed", name: "Shah — 4 Mill St" }),
    ],
  });
  assert.equal(columnOf(p, "dl_1"), "new");
  assert.equal(columnOf(p, "dl_2"), "uc");

  // The board is the LIVE pipeline: a won or lost deal has left it and
  // lives behind "Closed / Lost", which is why neither the card nor a
  // column for it is here.
  assert.equal(cards(p).length, 2, "the closed deal is not on the board");
  const columns = Array.from(p.pane.querySelectorAll(".kanban-col"))
    .map((c) => c.getAttribute("data-stage-id"));
  assert.deepEqual(columns, ["new", "showing", "uc"],
    "one column per non-terminal stage, including an empty one");

  // And it is one click away, with its figures.
  p.pane.querySelector("#viewTerminal").click();
  await settle(p.window);
  assert.match(p.text(), /Shah — 4 Mill St/, "the closed deal is on the other view");
});

dom("creating a deal saves the figures as numbers", async () => {
  const p = await board({ contacts: [contact()], deals: [] });
  await p.window.App.pages.deals.openDealModal(null);
  await settle(p.window);
  const m = p.modal();
  assert.ok(m, "the form opened");

  setField(m, "#dfName", "Khan — 12 Elm Road");
  setField(m, "#dfContact", "ct_1");
  setField(m, "#dfSide", "Buyer");
  setField(m, "#dfSalePrice", "500000");
  setField(m, "#dfRate", "3");
  m.querySelector('[data-role="save"]').click();
  await settle(p.window);

  const created = writesOf(p, "deals.create").concat(writesOf(p, "deals.createWithMilestones"));
  assert.equal(created.length, 1, "one deal: " + JSON.stringify(p.writes.map((w) => w[0])));
  const model = plain(created[0][1]);
  assert.equal(model.name, "Khan — 12 Elm Road");
  assert.equal(model.contactId, "ct_1");
  assert.equal(model.salePrice, 500000, "a number, not '500000'");
  assert.equal(model.commissionRate, 3);
});

dom("a deal cannot be saved without the things the maths needs", async () => {
  const p = await board({ contacts: [contact()], deals: [] });
  await p.window.App.pages.deals.openDealModal(null);
  await settle(p.window);
  const m = p.modal();

  // No name, no contact: there is nothing to compute or to show.
  m.querySelector('[data-role="save"]').click();
  await settle(p.window);
  assert.equal(writesOf(p, "deals.create").length, 0, "nothing written");
  assert.equal(writesOf(p, "deals.createWithMilestones").length, 0);
});

dom("moving a card to another column moves the deal, once", async () => {
  const p = await board({ contacts: [contact()], deals: [deal({ id: "dl_1", stage: "New" })] });
  const card = p.pane.querySelector('[data-deal-id="dl_1"]');
  const target = p.pane.querySelector('.kanban-col[data-stage-id="uc"]');

  const dt = {
    data: {},
    setData(type, v) { this.data[type] = v; },
    getData(type) { return this.data[type]; },
    dropEffect: "", effectAllowed: "",
  };
  card.dispatchEvent(Object.assign(new p.window.Event("dragstart", { bubbles: true }), { dataTransfer: dt }));
  target.dispatchEvent(Object.assign(new p.window.Event("dragover", { bubbles: true, cancelable: true }), { dataTransfer: dt }));
  target.dispatchEvent(Object.assign(new p.window.Event("drop", { bubbles: true, cancelable: true }), { dataTransfer: dt }));
  await settle(p.window);

  const moves = writesOf(p, "deals.moveToStage");
  assert.equal(moves.length, 1, "one move, not one per event: " + JSON.stringify(p.writes));
  assert.deepEqual([moves[0][1], moves[0][2]], ["dl_1", "uc"],
    "by stage id, which is what the data layer takes");

  // Dropping a card back on the column it came from is a no-op rather
  // than a write.
  const same = p.pane.querySelector('.kanban-col[data-stage-id="new"]');
  const card2 = p.pane.querySelector('[data-deal-id="dl_1"]');
  if (card2 && same) {
    card2.dispatchEvent(Object.assign(new p.window.Event("dragstart", { bubbles: true }), { dataTransfer: dt }));
    same.dispatchEvent(Object.assign(new p.window.Event("drop", { bubbles: true, cancelable: true }), { dataTransfer: dt }));
    await settle(p.window);
  }
  assert.equal(writesOf(p, "deals.moveToStage").length, 1, "still one");
});

dom("won and lost come from the stage's own terminal flag", async () => {
  const p = await board({
    contacts: [contact()],
    deals: [
      deal({ id: "dl_won", stage: "Closed", salePrice: 500000, commissionRate: 3 }),
      deal({ id: "dl_lost", stage: "Lost", salePrice: 400000, commissionRate: 3 }),
      deal({ id: "dl_open", stage: "Under Contract", salePrice: 300000, commissionRate: 3 }),
    ],
  });
  const D = p.window.App.derived;
  const st = p.state;
  // Not the word "Closed" - the flag on the stage. A workspace that
  // renames its stages keeps working, which is the whole reason the
  // pipeline is configurable.
  assert.equal(D.isTerminalWon(st, "Closed"), true);
  assert.equal(D.isTerminalLost(st, "Lost"), true);
  assert.equal(D.isTerminalWon(st, "Under Contract"), false);
  assert.equal(D.isTerminalLost(st, "Under Contract"), false);
  assert.equal(D.isTerminalStage(st, "Under Contract"), false);
  assert.equal(D.isTerminalStage(st, "Closed"), true);

  // An unknown stage is not quietly terminal.
  assert.equal(D.isTerminalWon(st, "Nonsense"), false);
  assert.equal(D.isTerminalStage(st, "Nonsense"), false);
});

dom("the commission maths is the shared calculator's, to the penny", async () => {
  const p = await board({ contacts: [contact()], deals: [] });
  const C = p.window.App.commission;

  // 500,000 at 3% is 15,000 gross. The deductions are each a percentage
  // OF THE GROSS, not of what the previous one left: 20% brokerage is
  // 3,000 and a 25% tax reserve is 3,750, so 15,000 - 6,750 = 8,250.
  const d = { salePrice: 500000, commissionRate: 3, teamSplit: 0,
              brokerageFee: 20, referralFee: 0, taxReserve: 25 };
  assert.equal(C.grossGCI(d), 15000, "gross commission");
  assert.equal(C.netGCI(d), 8250, "what actually lands");

  // The full breakdown agrees with itself, which is what the deal page
  // shows line by line.
  const b = C.breakdown(d);
  assert.equal(b.gross, 15000);
  assert.equal(b.net, 8250);
  assert.equal(b.deductions.brokerageFeeAmt, 3000);
  assert.equal(b.deductions.taxReserveAmt, 3750);
  assert.equal(b.deductions.totalAmt, 6750, "and the deductions add up to the difference");
  assert.equal(b.gross - b.deductions.totalAmt, b.net);

  // A team split takes its own share of the gross.
  assert.equal(C.netGCI(Object.assign({}, d, { teamSplit: 50, taxReserve: 0 })),
    15000 - 7500 - 3000);

  // Weighted by probability is what a forecast is made of.
  assert.equal(C.weightedGCI(Object.assign({}, d, { probability: 40 })), 6000);

  // Zero rate is zero money, not NaN - the one that reaches the screen
  // as "$NaN" if it ever breaks.
  assert.equal(C.grossGCI(Object.assign({}, d, { commissionRate: 0 })), 0);
  assert.equal(C.netGCI(Object.assign({}, d, { commissionRate: 0 })), 0);
});
