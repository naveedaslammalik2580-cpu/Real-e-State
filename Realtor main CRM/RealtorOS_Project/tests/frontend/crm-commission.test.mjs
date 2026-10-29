// The Commission page, including the state it had no test for: an agent
// working as Staff, where the figures are deliberately not shown.
//
// "Hidden" has to mean hidden. The page swapping in a friendly message
// while the numbers sit in the DOM underneath would pass a glance and
// fail the only thing the setting is for, so these tests read the markup
// rather than the screen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { page, domTest, settle } from "./crm-helpers.mjs";

const SCRIPTS = [
  "assets/js/core/utils.js",
  "assets/js/core/commission.js",
  "assets/js/core/derived.js",
  "assets/js/core/customization.js",
  "assets/js/app.js",
  "assets/js/pages/commission.js",
];

const deal = (over = {}) => Object.assign({
  id: "dl_" + Math.random().toString(36).slice(2, 8),
  name: "Khan — 12 Elm Road", contactId: "ct_1", side: "Buyer",
  stage: "Closed", probability: 100, salePrice: 500000, commissionRate: 3,
  teamSplit: 0, brokerageFee: 20, referralFee: 0, taxReserve: 25,
  closeDate: "2026-09-30", createdAt: "2026-01-01T00:00:00Z",
}, over);

/** A workspace permissions stub. `role` is the "working as" view. */
const asRole = (role) => ({
  can: () => true,
  seesAll: () => true,
  teamMemberId: () => null,
  currentRole: () => role,
  commissionFiguresHidden: () => role === "Staff",
  load: async () => {},
});

async function commissionPage(role, deals) {
  const p = await page(SCRIPTS, {
    deals: deals || [deal({ id: "dl_1" })],
    contacts: [{ id: "ct_1", name: "Sarah Khan", role: "Buyer", stage: "Client" }],
    properties: [], teamMembers: [],
  }, { workspace: asRole(role) });
  if (!p) return null;
  await p.window.App.pages.commission.render(p.pane);
  await settle(p.window);
  return p;
}

const dom = (name, fn) => domTest(test, SCRIPTS, name, fn);

dom("with full access the page shows the figures", async () => {
  const p = await commissionPage("Owner");
  // 500,000 at 3% is 15,000 gross, and the page says so somewhere.
  assert.match(p.text(), /15,000|15000/,
    "the gross commission is on the page: " + p.text().slice(0, 300));
  assert.ok(!/figures are hidden/i.test(p.text()), "and no hidden-state message");
});

dom("working as Staff hides the figures, and no amount is left in the DOM", async () => {
  const p = await commissionPage("Staff");

  assert.match(p.text(), /Commission figures are hidden/i, p.text());
  assert.match(p.text(), /Working as|Switch back/i,
    "and says how to get them back, because this is a view preference rather than a wall");

  // The real test: nothing numeric made it into the markup. Not the
  // gross, not the net, not the sale price, not a currency symbol
  // attached to a figure.
  const html = p.html();
  assert.ok(!/15,?000/.test(html), "no gross commission anywhere in the markup");
  assert.ok(!/8,?250/.test(html), "no net");
  assert.ok(!/500,?000/.test(html), "and not the sale price it is computed from");
  assert.deepEqual(html.match(/\$[\d,]+/g), null, "no currency amount at all: " + html.slice(0, 400));

  // It is a message and a way out, not a broken page.
  assert.ok(p.pane.querySelector("#commissionHiddenSettingsBtn"), "there is a way to Team & Access");
  p.pane.querySelector("#commissionHiddenSettingsBtn").click();
  await settle(p.window);
  assert.deepEqual(p.navigated, ["/settings/team-access"]);
});

dom("hiding is decided per view, not baked into the page", async () => {
  // The same workspace, the same deals, read twice: the only difference
  // is who is looking.
  const staff = await commissionPage("Staff");
  const owner = await commissionPage("Owner");
  assert.ok(/hidden/i.test(staff.text()));
  assert.ok(!/hidden/i.test(owner.text()));
  // And the underlying data was never filtered - the deal is still
  // there for both, which is what makes this a view and not deletion.
  assert.equal(staff.state.deals.length, 1);
  assert.equal(owner.state.deals.length, 1);
});

dom("an empty workspace shows no figures and no error", async () => {
  const p = await commissionPage("Owner", []);
  assert.ok(p.text().length > 0, "the page rendered");
  assert.ok(!/NaN|undefined|Infinity/.test(p.html()),
    "nothing divided by zero on the way: " + p.html().slice(0, 300));
});
