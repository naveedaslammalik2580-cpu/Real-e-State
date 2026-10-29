// Referrals: who sent whom, and what came of it.
//
// A referral is two contacts and a status, and the thing that goes
// wrong is the two contacts: a referral saved with the referrer and the
// referred the wrong way round is wrong in a way nobody notices until
// the thank-you goes to the lead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { page, domTest, setField, writesOf, plain, settle } from "./crm-helpers.mjs";

const SCRIPTS = [
  "assets/js/core/utils.js",
  "assets/js/core/commission.js",
  "assets/js/core/derived.js",
  "assets/js/core/customization.js",
  "assets/js/app.js",
  "assets/js/pages/referrals.js",
];

const contact = (id, name, over = {}) => Object.assign({
  id, name, role: "Buyer", stage: "Client", temperature: "Warm",
  email: "", phone: "", budget: 0, createdAt: "2026-01-01T00:00:00Z",
}, over);

const CONTACTS = [
  contact("ct_1", "Sarah Khan"),
  contact("ct_2", "Tom Byrne"),
  contact("ct_3", "Priya Shah"),
];

async function refs(referrals, contacts = CONTACTS) {
  const p = await page(SCRIPTS, { referrals, contacts, deals: [], today: "2026-10-15" });
  if (!p) return null;
  await p.window.App.pages.referrals.render(p.pane);
  await settle(p.window);
  return p;
}

const dom = (name, fn) => domTest(test, SCRIPTS, name, fn);

dom("an empty page offers the first referral", async () => {
  const p = await refs([]);
  assert.match(p.text(), /referral/i);
  assert.ok(p.pane.querySelector("#addRefBtn"), "and a way to add one");
});

dom("a referral shows both names, in the right direction", async () => {
  const p = await refs([{
    id: "rf_1", referrerId: "ct_1", referredContactId: "ct_2",
    date: "2026-10-01", status: "New", dealId: null, notes: "", thankYouSent: false, thankYouExpense: 0,
  }]);
  const shown = p.text();
  assert.match(shown, /Sarah Khan/, "the person who referred");
  assert.match(shown, /Tom Byrne/, "and the person referred");
  assert.ok(shown.indexOf("Sarah Khan") < shown.indexOf("Tom Byrne"),
    "from, then to - the direction is the whole record: " + shown);
});

dom("creating a referral saves both ends and the status", async () => {
  const p = await refs([]);
  p.pane.querySelector("#addRefBtn").click();
  await settle(p.window);
  const m = p.modal();
  assert.ok(m);

  setField(m, "#rfFrom", "ct_1");
  setField(m, "#rfTo", "ct_2");
  setField(m, "#rfStatus", "Contacted");
  setField(m, "#rfNotes", "Met at the open house.");
  m.querySelector('[data-role="save"]').click();
  await settle(p.window);

  const created = writesOf(p, "referrals.create");
  assert.equal(created.length, 1, JSON.stringify(p.writes));
  const model = plain(created[0][1]);
  assert.equal(model.referrerId, "ct_1");
  assert.equal(model.referredContactId, "ct_2");
  assert.equal(model.status, "Contacted");
  assert.equal(model.notes, "Met at the open house.");
});

dom("a referral with only one end is refused", async () => {
  const p = await refs([]);
  p.pane.querySelector("#addRefBtn").click();
  await settle(p.window);
  const m = p.modal();

  setField(m, "#rfFrom", "ct_1");   // and nobody referred
  m.querySelector('[data-role="save"]').click();
  await settle(p.window);
  assert.equal(writesOf(p, "referrals.create").length, 0, "nothing written");
  assert.ok(m.querySelector("#rfTo").closest(".form-field").classList.contains("has-error"),
    "and it says which end is missing");
});

dom("the status filter narrows the list", async () => {
  const p = await refs([
    { id: "rf_1", referrerId: "ct_1", referredContactId: "ct_2", date: "2026-10-01",
      status: "New", dealId: null, notes: "", thankYouSent: false, thankYouExpense: 0 },
    { id: "rf_2", referrerId: "ct_2", referredContactId: "ct_3", date: "2026-10-02",
      status: "Closed Won", dealId: null, notes: "", thankYouSent: true, thankYouExpense: 50 },
  ]);
  assert.equal(p.pane.querySelectorAll("[data-ref-id]").length, 2);

  setField(p.document, "#rStatus", "Closed Won");
  await settle(p.window);
  const rows = Array.from(p.pane.querySelectorAll("[data-ref-id]"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].getAttribute("data-ref-id"), "rf_2");
});

dom("a contact's name is escaped wherever the referral shows it", async () => {
  const p = await refs(
    [{ id: "rf_1", referrerId: "ct_evil", referredContactId: "ct_2", date: "2026-10-01",
       status: "New", dealId: null, notes: "", thankYouSent: false, thankYouExpense: 0 }],
    [contact("ct_evil", '<img src=x onerror="window.__pwned=1">'), contact("ct_2", "Tom Byrne")],
  );
  assert.equal(p.pane.querySelectorAll("img").length, 0);
  assert.equal(p.window.__pwned, undefined);
});
