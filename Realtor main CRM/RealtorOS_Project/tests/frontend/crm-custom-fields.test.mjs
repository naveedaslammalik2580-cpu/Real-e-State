// Custom fields: defining one, and the forms it then appears on.
//
// Two halves that have to agree: the settings screen that defines a
// field, and the section every entity form renders from those
// definitions. A field that can be defined but never appears, or
// appears but never saves, is the failure worth catching - so both
// halves are exercised here.
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
  "assets/js/pages/custom-fields-settings.js",
];

const def = (over = {}) => Object.assign({
  id: "cf_1", entity: "contact", label: "Mortgage broker", type: "text",
  required: false, active: true, order: 1, options: [],
}, over);

async function settings(definitions, values = []) {
  const p = await page(SCRIPTS, {
    settings: { customFields: { definitions } },
    customFieldValues: values,
  });
  if (!p) return null;
  await p.window.App.pages.customFieldsSettings.render(p.pane);
  await settle(p.window);
  return p;
}

const dom = (name, fn) => domTest(test, SCRIPTS, name, fn);

dom("with no fields defined the screen explains what they are for", async () => {
  const p = await settings([]);
  assert.match(p.text(), /custom field/i, p.text().slice(0, 200));
  assert.ok(p.pane.querySelector("#cfAddBtn"), "and offers to add one");
});

dom("defining a field saves its label, type and entity", async () => {
  const p = await settings([]);
  setField(p.pane, "#cfNewLabel", "  Mortgage broker  ");
  setField(p.pane, "#cfNewType", "text");
  p.pane.querySelector("#cfAddBtn").click();
  await settle(p.window);

  const defined = writesOf(p, "customFields.define");
  assert.equal(defined.length, 1, JSON.stringify(p.writes));
  assert.equal(defined[0][1], "contact", "on the entity whose tab is open");
  assert.equal(plain(defined[0][2]).label, "Mortgage broker", "trimmed");
  assert.equal(plain(defined[0][2]).type, "text");
});

dom("a field with no label, or a duplicate one, is not created", async () => {
  const p = await settings([def({ id: "cf_1", label: "Mortgage broker" })]);

  p.pane.querySelector("#cfAddBtn").click();
  await settle(p.window);
  assert.equal(p.state.settings.customFields.definitions.length, 1, "a blank label adds nothing");

  // The same name again, in a different case: one field, not two.
  setField(p.pane, "#cfNewLabel", "mortgage BROKER");
  p.pane.querySelector("#cfAddBtn").click();
  await settle(p.window);
  assert.equal(p.state.settings.customFields.definitions.length, 1,
    "a duplicate label is refused whatever its capitalisation");
});

dom("the fields are listed per entity, and switching tabs switches the list", async () => {
  const p = await settings([
    def({ id: "cf_1", entity: "contact", label: "Mortgage broker" }),
    def({ id: "cf_2", entity: "deal", label: "Solicitor", order: 1 }),
  ]);
  assert.match(p.text(), /Mortgage broker/);
  assert.ok(!/Solicitor/.test(p.text()), "a deal's field is not on the contact tab");

  const dealTab = p.pane.querySelector('[data-cf-tab="deal"]');
  assert.ok(dealTab, "there is a tab per entity");
  dealTab.click();
  await settle(p.window);
  assert.match(p.text(), /Solicitor/);
  assert.ok(!/Mortgage broker/.test(p.text()));
});

dom("turning a field off keeps it, and it stops appearing on forms", async () => {
  const p = await settings([def({ id: "cf_1", label: "Mortgage broker", active: true })]);
  const toggle = p.pane.querySelector("[data-cf-toggle]");
  assert.ok(toggle, "there is a switch");
  toggle.click();
  await settle(p.window);

  const off = writesOf(p, "customFields.setActive");
  assert.equal(off.length, 1, JSON.stringify(p.writes));
  assert.equal(off[0][1], "cf_1");
  assert.equal(off[0][2], false, "switched off, not deleted");
  assert.equal(p.state.settings.customFields.definitions.length, 1, "the definition is still there");

  // And the forms stop offering it, which is the point of "off".
  const active = p.store.customFields.activeDefinitionsFor("contact");
  assert.equal(active.length, 0);
});

dom("a defined field renders on an entity form and its value is collected", async () => {
  const p = await settings([
    def({ id: "cf_1", entity: "contact", label: "Mortgage broker", type: "text", order: 1 }),
    def({ id: "cf_2", entity: "contact", label: "Chain free", type: "checkbox", order: 2 }),
    def({ id: "cf_off", entity: "contact", label: "Retired field", type: "text", active: false, order: 3 }),
  ]);

  // This is the same call every entity form makes.
  const host = p.document.createElement("form");
  host.innerHTML = p.window.App.customFieldsUI.renderSection("contact", null);
  p.document.body.appendChild(host);

  assert.match(host.textContent, /Mortgage broker/);
  assert.match(host.textContent, /Chain free/);
  assert.ok(!/Retired field/.test(host.textContent), "a field switched off is not on the form");

  const inputs = host.querySelectorAll("input, select, textarea");
  assert.ok(inputs.length >= 2, "both live fields have a control");
  const text = host.querySelector('[data-cf-field="cf_1"]') || inputs[0];
  text.value = "Dana at Northside";
  const box = host.querySelector('[data-cf-field="cf_2"]') || inputs[1];
  if (box && box.type === "checkbox") box.checked = true;

  const collected = p.window.App.customFieldsUI.collectValues(host, "contact");
  assert.equal(plain(collected).cf_1, "Dana at Northside",
    "what was typed comes back out: " + JSON.stringify(plain(collected)));
});

dom("a required custom field is reported as missing rather than saved empty", async () => {
  const p = await settings([
    def({ id: "cf_1", entity: "contact", label: "Mortgage broker", type: "text", required: true }),
  ]);
  const host = p.document.createElement("form");
  host.innerHTML = p.window.App.customFieldsUI.renderSection("contact", null);
  p.document.body.appendChild(host);

  const missing = p.window.App.customFieldsUI.findMissingRequired(host, "contact");
  assert.deepEqual(plain(missing), ["Mortgage broker"],
    "named, so the form can say which one: " + JSON.stringify(plain(missing)));

  const input = host.querySelector("input, select, textarea");
  input.value = "Dana at Northside";
  assert.deepEqual(plain(p.window.App.customFieldsUI.findMissingRequired(host, "contact")), []);
});

dom("a field label is escaped on the settings screen and on a form", async () => {
  const p = await settings([
    def({ id: "cf_x", label: '<img src=x onerror="window.__pwned=1">', type: "text" }),
  ]);
  assert.equal(p.pane.querySelectorAll("img").length, 0);

  const host = p.document.createElement("form");
  host.innerHTML = p.window.App.customFieldsUI.renderSection("contact", null);
  p.document.body.appendChild(host);
  assert.equal(host.querySelectorAll("img").length, 0, "and on the form it generates");
  assert.equal(p.window.__pwned, undefined);
});
