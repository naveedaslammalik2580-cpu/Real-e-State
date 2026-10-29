// Contacts: the list, its filters, and the form that writes a contact.
//
// This is the page every other page hangs off, and it had no test of its
// own. What is pinned here is what an agent would notice breaking: the
// rows that show, the filters that narrow them, what the form actually
// saves, and that a contact's name is escaped on the way to the screen.
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
  "assets/js/pages/contacts.js",
];

const contact = (over = {}) => Object.assign({
  id: "ct_" + Math.random().toString(36).slice(2, 8),
  name: "Sarah Khan", role: "Buyer", email: "sarah@example.com", phone: "07700 900123",
  stage: "New Lead", source: "Referral", temperature: "Warm",
  lastContact: null, nextFollowUp: null, birthday: null, homePurchaseDate: null,
  budget: 0, preferredArea: "", assignedAgent: "Self", assignedToId: null, notes: "",
  createdAt: "2026-01-01T00:00:00Z",
}, over);

async function list(contacts, opts) {
  const p = await page(SCRIPTS, { contacts }, opts);
  if (!p) return null;
  await p.window.App.pages.contacts.renderList(p.pane);
  await settle(p.window);
  return p;
}

const rows = (p) => Array.from(p.pane.querySelectorAll("tbody tr.clickable"));
const names = (p) => rows(p).map((r) => r.querySelector(".primary-cell").textContent.trim());

const dom = (name, fn) => domTest(test, SCRIPTS, name, fn);

dom("the list shows every contact, and an empty workspace says what to do", async () => {
  const empty = await list([]);
  assert.equal(rows(empty).length, 0);
  assert.match(empty.text(), /No contacts yet|Add Your First Contact/i,
    "an empty list offers the first step rather than an empty table: " + empty.text());

  const p = await list([
    contact({ id: "ct_1", name: "Sarah Khan" }),
    contact({ id: "ct_2", name: "Tom Byrne", role: "Seller", stage: "Client" }),
  ]);
  assert.deepEqual(names(p), ["Sarah Khan", "Tom Byrne"], "sorted by name, which is the default");
  assert.match(p.text(), /Seller/);
  assert.match(p.text(), /Client/);
});

dom("a contact's own text is escaped, never rendered as markup", async () => {
  const p = await list([contact({
    id: "ct_x",
    name: '<img src=x onerror="window.__pwned=1">Mallory',
    preferredArea: "<b>Nowhere</b>",
  })]);
  // The name is data. It appears as text and creates no elements.
  assert.equal(p.pane.querySelectorAll("img").length, 0, "no element was created from a name");
  assert.equal(p.window.__pwned, undefined);
  assert.match(p.text(), /Mallory/, "and it is still shown, as the characters they typed");
  assert.ok(p.html().includes("&lt;img"), "escaped in the markup: " + p.html().slice(0, 200));
});

dom("the filters narrow the list, and clearing them brings it back", async () => {
  const p = await list([
    contact({ id: "ct_1", name: "Sarah Khan", role: "Buyer", stage: "New Lead", temperature: "Hot" }),
    contact({ id: "ct_2", name: "Tom Byrne", role: "Seller", stage: "Client", temperature: "Cold" }),
    contact({ id: "ct_3", name: "Priya Shah", role: "Buyer", stage: "Client", temperature: "Warm" }),
  ]);
  assert.equal(rows(p).length, 3);

  setField(p.document, "#cRole", "Buyer");
  await settle(p.window);
  assert.deepEqual(names(p), ["Priya Shah", "Sarah Khan"], "the two buyers, A-Z");

  setField(p.document, "#cStage", "Client");
  await settle(p.window);
  assert.deepEqual(names(p), ["Priya Shah"], "the filters narrow together, not instead of each other");

  setField(p.document, "#cRole", "");
  setField(p.document, "#cStage", "");
  await settle(p.window);
  assert.equal(rows(p).length, 3, "and clearing them brings everybody back");

  // Search looks at name, email and phone - an agent types whichever
  // they have to hand.
  setField(p.document, "#cSearch", "900123");
  await settle(p.window);
  assert.equal(rows(p).length, 3, "every seeded contact shares that number");
  setField(p.document, "#cSearch", "priya");
  await settle(p.window);
  assert.deepEqual(names(p), ["Priya Shah"], "and it is case-insensitive");

  setField(p.document, "#cSearch", "nobody at all");
  await settle(p.window);
  assert.equal(rows(p).length, 0);
  assert.match(p.text(), /No matches/i, "which says so differently from an empty workspace");
});

dom("the form creates a contact with what was typed and nothing else", async () => {
  const p = await list([]);
  await p.window.App.pages.contacts.openContactModal(null);
  await settle(p.window);
  const m = p.modal();
  assert.ok(m, "the form opened");

  setField(m, "#fName", "  Priya Shah  ");
  setField(m, "#fEmail", "priya@example.com");
  setField(m, "#fPhone", "0161 496 0123");
  setField(m, "#fRole", "Investor");
  setField(m, "#fStage", "Qualified");
  setField(m, "#fTemp", "Hot");
  setField(m, "#fBudget", "450000");
  setField(m, "#fNotes", "Met at the Elm Road viewing.");
  m.querySelector('[data-role="save"]').click();
  await settle(p.window);

  const created = writesOf(p, "contacts.create");
  assert.equal(created.length, 1, "one contact, once: " + JSON.stringify(p.writes));
  const model = plain(created[0][1]);
  assert.equal(model.name, "Priya Shah", "trimmed");
  assert.equal(model.role, "Investor");
  assert.equal(model.stage, "Qualified");
  assert.equal(model.temperature, "Hot");
  assert.equal(model.budget, 450000, "a number, not the string from the input");
  assert.equal(model.notes, "Met at the Elm Road viewing.");
  assert.equal(p.state.contacts.length, 1);
});

dom("a nameless or malformed contact is refused before anything is written", async () => {
  const p = await list([]);
  await p.window.App.pages.contacts.openContactModal(null);
  await settle(p.window);
  const m = p.modal();

  // No name at all.
  m.querySelector('[data-role="save"]').click();
  await settle(p.window);
  assert.equal(writesOf(p, "contacts.create").length, 0, "nothing was written");
  assert.ok(m.querySelector("#fName").closest(".form-field").classList.contains("has-error"),
    "and the field says which one it is");

  // A name, but an address that is not one.
  setField(m, "#fName", "Priya Shah");
  setField(m, "#fEmail", "priya@@nowhere");
  m.querySelector('[data-role="save"]').click();
  await settle(p.window);
  assert.equal(writesOf(p, "contacts.create").length, 0);
  assert.ok(m.querySelector("#fEmail").closest(".form-field").classList.contains("has-error"));

  // Fixed, and it saves.
  setField(m, "#fEmail", "priya@example.com");
  m.querySelector('[data-role="save"]').click();
  await settle(p.window);
  assert.equal(writesOf(p, "contacts.create").length, 1);
});

dom("editing prefills from the contact and saves only the edit", async () => {
  const existing = contact({ id: "ct_1", name: "Sarah Khan", stage: "New Lead", budget: 300000 });
  const p = await list([existing]);

  p.pane.querySelector('[data-edit="ct_1"]').click();
  await settle(p.window);
  const m = p.modal();
  assert.equal(m.querySelector("#fName").value, "Sarah Khan", "prefilled");
  assert.equal(m.querySelector("#fStage").value, "New Lead");
  assert.equal(Number(m.querySelector("#fBudget").value), 300000);

  setField(m, "#fStage", "Client");
  m.querySelector('[data-role="save"]').click();
  await settle(p.window);

  const updates = writesOf(p, "contacts.update");
  assert.equal(updates.length, 1);
  assert.equal(updates[0][1], "ct_1", "the one that was edited");
  assert.equal(plain(updates[0][2]).stage, "Client");
  assert.equal(plain(updates[0][2]).name, "Sarah Khan", "and everything else goes back unchanged");
  assert.equal(writesOf(p, "contacts.create").length, 0, "an edit is not a create");
});

// ---------------------------------------------------------------- Phase 2D
//
// The two date fields the past-client programme added. They had no test:
// the SQL side was covered and the form was not, so a field that stopped
// prefilling would have shipped quietly.

dom("the birthday and home purchase dates render, prefill and save", async () => {
  const existing = contact({
    id: "ct_1", name: "Sarah Khan",
    birthday: "1988-06-10", homePurchaseDate: "2022-03-15",
  });
  const p = await list([existing]);
  p.pane.querySelector('[data-edit="ct_1"]').click();
  await settle(p.window);
  const m = p.modal();

  const birthday = m.querySelector("#fBirthday");
  const purchase = m.querySelector("#fHomePurchase");
  assert.ok(birthday && purchase, "both fields are on the form");
  assert.equal(birthday.type, "date", "a date picker, not free text");
  assert.equal(purchase.type, "date");
  assert.equal(birthday.value, "1988-06-10", "prefilled from the contact");
  assert.equal(purchase.value, "2022-03-15");
  // The year of a birthday is usually unknown, and the form says so.
  assert.match(m.textContent, /day and month/i);

  setField(m, "#fBirthday", "1988-06-11");
  setField(m, "#fHomePurchase", "");
  m.querySelector('[data-role="save"]').click();
  await settle(p.window);

  const patch = plain(writesOf(p, "contacts.update")[0][2]);
  assert.equal(patch.birthday, "1988-06-11", "the change is saved");
  assert.equal(patch.homePurchaseDate, null,
    "and a cleared date is null rather than an empty string, which is what the column takes");
});

dom("a new contact can be given both dates straight away", async () => {
  const p = await list([]);
  await p.window.App.pages.contacts.openContactModal(null);
  await settle(p.window);
  const m = p.modal();
  assert.equal(m.querySelector("#fBirthday").value, "", "empty on a new contact");

  setField(m, "#fName", "Tom Byrne");
  setField(m, "#fBirthday", "1979-12-01");
  setField(m, "#fHomePurchase", "2021-08-20");
  m.querySelector('[data-role="save"]').click();
  await settle(p.window);

  const model = plain(writesOf(p, "contacts.create")[0][1]);
  assert.equal(model.birthday, "1979-12-01");
  assert.equal(model.homePurchaseDate, "2021-08-20");
});

dom("Past Clients uses the existing stage, independent filters and unchanged contact links", async () => {
  const p = await list([
    contact({ id: "past", name: "Past Buyer", stage: "Past Client" }),
    contact({ id: "seller", name: "Past Seller", role: "Seller", stage: "Past Client" }),
    contact({ id: "active", name: "Active Buyer", homePurchaseDate: "2020-01-01" }),
    contact({ id: "role", name: "Wrong classification", role: "Past Client" }),
  ]);
  setField(p.document, "#cStage", "New Lead");
  await p.window.App.pages.contacts.renderPastClients(p.pane);
  assert.deepEqual(names(p), ["Past Buyer", "Past Seller"]);
  assert.equal(p.document.querySelector("#cStage").disabled, true);
  assert.equal(p.document.querySelector("#cStage").value, "Past Client");
  assert.equal(p.pane.querySelector('a[href="#/contacts/past"]').getAttribute("href"), "#/contacts/past");
  setField(p.document, "#cRole", "Seller");
  assert.deepEqual(names(p), ["Past Seller"]);
  await p.window.App.pages.contacts.renderList(p.pane);
  assert.deepEqual(names(p), ["Active Buyer", "Wrong classification"]);
  await p.window.App.pages.contacts.renderPastClients(p.pane);
  assert.deepEqual(names(p), ["Past Seller"], "each view retains its own filters");
});

dom("Past Clients reuses edit and import refresh without losing its scope", async () => {
  const p = await list([contact({ id: "past", name: "Past Buyer", stage: "Past Client" }), contact({ id: "active" })]);
  await p.window.App.pages.contacts.renderPastClients(p.pane);
  p.pane.querySelector('[data-edit="past"]').click();
  await settle(p.window);
  setField(p.modal(), "#fStage", "Client");
  p.modal().querySelector('[data-role="save"]').click();
  await settle(p.window);
  assert.equal(writesOf(p, "contacts.update").length, 1);
  await p.window.App.pages.contacts.renderPastClients(p.pane);
  assert.equal(rows(p).length, 0);
  assert.match(p.text(), /No past clients yet/);
  let imported;
  p.window.App.pages.leadFileImport = { open: options => { imported = options.onImported; } };
  p.pane.querySelector("#importFileBtn").click();
  p.state.contacts.push(contact({ id: "imported", name: "Imported Past", stage: "Past Client" }));
  imported();
  await settle(p.window);
  assert.deepEqual(names(p), ["Imported Past"]);
  assert.equal(p.document.querySelector(".page-title").textContent, "Past Clients");
});
