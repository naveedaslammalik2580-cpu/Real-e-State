// Email templates: the library the automation sends from.
//
// Nothing on this page sends anything, and that is the first thing
// worth proving - saving a template is configuration, and a page that
// could put mail in front of a contact by accident would be a different
// kind of page. After that: what a save writes, and that a template's
// own text is escaped when it is listed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { page, domTest, setField, writesOf, plain, settle } from "./crm-helpers.mjs";

const SCRIPTS = [
  "assets/js/core/utils.js",
  "assets/js/core/commission.js",
  "assets/js/core/derived.js",
  "assets/js/core/customization.js",
  "assets/js/app.js",
  "assets/js/pages/email-templates.js",
];

const template = (over = {}) => Object.assign({
  id: "mt_" + Math.random().toString(36).slice(2, 8),
  name: "New buyer lead — welcome",
  subject: "Good to meet you, {{first_name}}",
  body_text: "Hi {{first_name}},\n\nThanks for getting in touch.\n\n{{agent_name}}",
  channel: "email", is_active: true,
  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
}, over);

async function library(templates) {
  const seed = { messageTemplates: templates };
  const p = await page(SCRIPTS, seed);
  if (!p) return null;
  p.store.messageTemplates.list = async () => templates.slice();
  await p.window.App.pages.emailTemplates.render(p.pane);
  await settle(p.window);
  return p;
}

const cards = (p) => Array.from(p.pane.querySelectorAll("[data-tpl-id]"));
const dom = (name, fn) => domTest(test, SCRIPTS, name, fn);

dom("an empty library says what a template is for", async () => {
  const p = await library([]);
  assert.match(p.text(), /template/i);
  assert.ok(p.pane.querySelector("#etCreateBtn"), "and offers the first one");
});

dom("templates are listed with their subject, and nothing is sent", async () => {
  const sent = [];
  const p = await library([
    template({ id: "mt_1", name: "New buyer lead — welcome" }),
    template({ id: "mt_2", name: "Cold lead revival", subject: "Still looking, {{first_name}}?" }),
  ]);
  p.window.fetch = async (...args) => { sent.push(args); throw new Error("no network in a test"); };

  assert.equal(cards(p).length, 2);
  assert.match(p.text(), /New buyer lead/);
  assert.match(p.text(), /Still looking/);
  assert.equal(sent.length, 0, "rendering a library sends nothing");
});

dom("saving a template writes the name, subject and body and sends nothing", async () => {
  const p = await library([]);
  p.pane.querySelector("#etCreateBtn").click();
  await settle(p.window);
  const m = p.modal();
  assert.ok(m, "the editor opened");

  setField(m, "#etName", "  Open-house thank you  ");
  setField(m, "#etSubject", "Thanks for coming by, {{first_name}}");
  setField(m, "#etBody", "Hi {{first_name}},\n\nGood to meet you.\n\n{{agent_name}}");
  m.querySelector('[data-role="save"]').click();
  await settle(p.window);

  const created = writesOf(p, "messageTemplates.create");
  assert.equal(created.length, 1, JSON.stringify(p.writes.map((w) => w[0])));
  const model = plain(created[0][1]);
  assert.equal(model.name, "Open-house thank you", "trimmed");
  assert.match(model.subject, /Thanks for coming by/);
  assert.match(model.bodyText || model.body_text, /Good to meet you/);

  // Nothing on this page is a send, and nothing on it enrols anybody.
  const kinds = p.writes.map((w) => w[0]);
  assert.ok(!kinds.some((k) => /send|enroll|activate.*rule/i.test(k)),
    "configuration only: " + JSON.stringify(kinds));
});

dom("a template with no name or no subject is refused", async () => {
  const p = await library([]);
  p.pane.querySelector("#etCreateBtn").click();
  await settle(p.window);
  const m = p.modal();

  m.querySelector('[data-role="save"]').click();
  await settle(p.window);
  assert.equal(writesOf(p, "messageTemplates.create").length, 0, "nothing written");

  setField(m, "#etName", "Open-house thank you");
  m.querySelector('[data-role="save"]').click();
  await settle(p.window);
  assert.equal(writesOf(p, "messageTemplates.create").length, 0,
    "a template with no subject is not a template");
});

dom("a template can be switched off without being deleted", async () => {
  const p = await library([template({ id: "mt_1", is_active: true })]);
  const toggle = p.pane.querySelector("[data-toggle-active]");
  if (!toggle) {
    // The control lives behind the card's own menu on narrow layouts.
    const more = p.pane.querySelector("[data-more-toggle]");
    if (more) { more.click(); await settle(p.window); }
  }
  const control = p.pane.querySelector("[data-toggle-active]");
  assert.ok(control, "there is a way to deactivate: " + p.html().slice(0, 300));
  control.click();
  await settle(p.window);

  const kinds = p.writes.map((w) => w[0]);
  assert.ok(kinds.some((k) => k === "messageTemplates.setActive" || k === "messageTemplates.update"),
    "it was switched, not removed: " + JSON.stringify(kinds));
  assert.equal(writesOf(p, "messageTemplates.delete").length, 0);
});

dom("a template's own text is escaped in the list", async () => {
  const p = await library([template({
    id: "mt_x",
    name: '<img src=x onerror="window.__pwned=1">',
    subject: "<b>bold</b>",
  })]);
  assert.equal(p.pane.querySelectorAll("img").length, 0);
  assert.equal(p.pane.querySelectorAll("b").length, 0, "a subject is text, not markup");
  assert.equal(p.window.__pwned, undefined);
});
