// Phase 2B: the Today screen and the one-tap follow-up bar.
//
// The things worth pinning: the sections an agent sees and the order they
// are worked through, the links the buttons build (a wrong tel: or wa.me
// number means a call to a stranger), and that the quick log writes exactly
// three things on save and nothing at all on cancel.
//
// Nothing here sends a message. Every button is a link handed to the
// agent's own phone, and the tests assert the URL rather than any delivery.
import { test } from "node:test";
import assert from "node:assert/strict";
import { browser, settle, SKIP_DOM } from "../helpers/browser.mjs";

const SCRIPTS = [
  "assets/js/core/utils.js",
  "assets/js/core/follow-up.js",
  "assets/js/app.js",
  "assets/js/pages/release.js",
  "assets/js/pages/tasks.js",
];

const TODAY = "2026-10-15";
const d = (iso) => iso;

/** Contacts are given explicit dates relative to TODAY. */
function world(overrides = {}) {
  const contacts = overrides.contacts || [];
  const tasks = overrides.tasks || [];
  const activities = overrides.activities || [];
  const settings = Object.assign({ currency: "USD", agentName: "Dana Reed" }, overrides.settings || {});
  const writes = [];
  const templates = overrides.templates || [];
  return {
    writes,
    store: {
      ensureLoaded: async () => {},
      getState: () => ({
        contacts, tasks, activities, properties: [], deals: [], showings: [],
        milestones: [], referrals: [], settings,
      }),
      messageTemplates: { list: async () => templates },
      contacts: {
        get: async (id) => contacts.find((c) => c.id === id) || null,
        update: async (id, patch) => {
          writes.push(["contacts.update", id, patch]);
          const c = contacts.find((x) => x.id === id);
          if (c) Object.assign(c, patch);
          return c;
        },
      },
      activities: {
        create: async (model) => { writes.push(["activities.create", model]); return { id: "ac_1", ...model }; },
      },
      tasks: { get: async (id) => tasks.find((t) => t.id === id) || null },
    },
  };
}

const open = [];

async function today(overrides) {
  const w = world(overrides);
  const b = await browser(SCRIPTS, { store: w.store });
  if (!b) return null;
  open.push(b);
  // Freeze "today" so the sections are deterministic.
  b.window.App.util.todayISO = () => TODAY;
  const pane = b.document.createElement("div");
  b.document.body.appendChild(pane);
  await b.window.App.pages.release.renderDaily(pane);
  await settle(b.window);
  return Object.assign({}, b, { pane, writes: w.writes, store: w.store });
}

function closeAll() {
  while (open.length) {
    const b = open.pop();
    try { b.close(); } catch (e) { /* already gone */ }
  }
}

function domTest(name, fn) {
  test(name, async (t) => {
    const probe = await today({});
    if (!probe) return t.skip(SKIP_DOM);
    closeAll();
    try { await fn(); } finally { closeAll(); }
  });
}

const sectionTitles = (p) =>
  Array.from(p.pane.querySelectorAll(".today-section .card-title")).map((el) => el.textContent.replace(/\s+/g, " ").trim());
const rowNames = (p, sectionId) =>
  Array.from(p.pane.querySelectorAll(`[data-today-section="${sectionId}"] .today-row-name`)).map((el) => el.textContent.trim());
const modal = (p) => p.document.querySelector(".modal");

const contact = (over = {}) => Object.assign({
  id: "c" + Math.random().toString(36).slice(2, 8),
  name: "Pat Lee", stage: "New Lead", temperature: "Warm",
  email: "", phone: "", lastContact: null, nextFollowUp: null,
  replyDetectedAt: null, createdAt: "2026-01-01T00:00:00Z",
}, over);

// ---------------------------------------------------------------- sections

domTest("the five sections appear in working order, each with its count", async () => {
  const p = await today({
    contacts: [
      contact({ id: "o1", name: "Overdue One", nextFollowUp: d("2026-10-12") }),
      contact({ id: "t1", name: "Due Today", nextFollowUp: TODAY }),
      contact({ id: "n1", name: "Brand New", createdAt: "2026-10-14T09:00:00Z" }),
      contact({ id: "r1", name: "Replied Recently", replyDetectedAt: "2026-10-13T09:00:00Z", lastContact: "2026-10-01" }),
    ],
    tasks: [{ id: "tk1", title: "Ring the lender", status: "Open", dueDate: "2026-10-14", priority: "High" }],
  });
  assert.deepEqual(sectionTitles(p), [
    "Overdue follow-ups 1",
    "Follow-ups due today 1",
    "New, not yet contacted 1",
    "Replied recently 1",
    "Tasks due or overdue 1",
  ]);
});

domTest("an empty section is hidden, and a completely clear day says so", async () => {
  const p = await today({
    contacts: [contact({ id: "t1", name: "Only One Due", nextFollowUp: TODAY })],
  });
  assert.deepEqual(sectionTitles(p), ["Follow-ups due today 1"]);

  const clear = await today({ contacts: [contact({ id: "x", name: "Nothing Due" })], tasks: [] });
  assert.deepEqual(sectionTitles(clear), []);
  assert.match(clear.pane.textContent, /all caught up/i);
});

domTest("rows run Hot, then Warm, then Cold, and oldest due first inside a temperature", async () => {
  const p = await today({
    contacts: [
      contact({ id: "a", name: "Cold Old", temperature: "Cold", nextFollowUp: "2026-10-01" }),
      contact({ id: "b", name: "Warm New", temperature: "Warm", nextFollowUp: "2026-10-13" }),
      contact({ id: "c", name: "Hot New", temperature: "Hot", nextFollowUp: "2026-10-13" }),
      contact({ id: "e", name: "Hot Old", temperature: "Hot", nextFollowUp: "2026-10-02" }),
      contact({ id: "f", name: "Warm Old", temperature: "Warm", nextFollowUp: "2026-10-05" }),
    ],
  });
  assert.deepEqual(rowNames(p, "overdue"),
    ["Hot Old", "Hot New", "Warm Old", "Warm New", "Cold Old"]);
});

domTest("a row says how overdue it is, and when it was last contacted", async () => {
  const p = await today({
    contacts: [
      contact({ id: "a", name: "Three Days", nextFollowUp: "2026-10-12", lastContact: "2026-09-30" }),
      contact({ id: "b", name: "Never Reached", nextFollowUp: TODAY }),
    ],
  });
  const overdueRow = p.pane.querySelector('[data-contact-row="a"]').textContent;
  assert.match(overdueRow, /3 days overdue/);
  assert.match(overdueRow, /Last contact/);
  const todayRow = p.pane.querySelector('[data-contact-row="b"]').textContent;
  assert.match(todayRow, /Due today/);
  assert.match(todayRow, /Never contacted/);
});

domTest("a contact with a logged activity is not 'not yet contacted'", async () => {
  const p = await today({
    contacts: [
      contact({ id: "fresh", name: "Untouched", createdAt: "2026-10-14T09:00:00Z" }),
      contact({ id: "called", name: "Already Called", createdAt: "2026-10-14T09:00:00Z" }),
      contact({ id: "old", name: "Too Old", createdAt: "2026-08-01T09:00:00Z" }),
    ],
    activities: [{ id: "ac1", contactId: "called", type: "Call" }],
  });
  assert.deepEqual(rowNames(p, "new"), ["Untouched"],
    "a logged activity, or being older than 14 days, takes a contact out of this section");
});

domTest("a section caps at 50 rows and offers the rest", async () => {
  const many = [];
  for (let i = 0; i < 57; i++) {
    many.push(contact({ id: "m" + i, name: "Lead " + String(i).padStart(2, "0"), nextFollowUp: TODAY }));
  }
  const p = await today({ contacts: many });
  assert.equal(rowNames(p, "today").length, 50);
  const more = p.pane.querySelector('[data-today-more="today"]');
  assert.ok(more, "there must be a way to see the rest");
  assert.match(more.textContent, /Show 7 more/);

  more.click();
  await settle(p.window);
  assert.equal(rowNames(p, "today").length, 57);
  assert.equal(p.pane.querySelector('[data-today-more="today"]'), null, "and then no more button");
});

// ---------------------------------------------------------------- the bar

domTest("a button is only offered when the contact can actually be reached that way", async () => {
  const p = await today({
    contacts: [
      contact({ id: "both", name: "Both", nextFollowUp: TODAY, phone: "555 123 4567", email: "both@example.com" }),
      contact({ id: "phone", name: "Phone Only", nextFollowUp: TODAY, phone: "555 123 4567" }),
      contact({ id: "mail", name: "Email Only", nextFollowUp: TODAY, email: "mail@example.com" }),
      contact({ id: "none", name: "Neither", nextFollowUp: TODAY }),
    ],
  });
  const actions = (id) => Array.from(
    p.pane.querySelectorAll(`[data-contact-row="${id}"] [data-fu-action]`)).map((b) => b.getAttribute("data-fu-action"));
  assert.deepEqual(actions("both"), ["call", "sms", "whatsapp", "email", "log"]);
  assert.deepEqual(actions("phone"), ["call", "sms", "whatsapp", "log"]);
  assert.deepEqual(actions("mail"), ["email", "log"]);
  assert.deepEqual(actions("none"), ["log"],
    "with no phone and no email there is still something to record");
});

domTest("tel, sms, wa.me and mailto links are built correctly and URL-encoded", async () => {
  const p = await today({ contacts: [contact({ id: "a", name: "Pat Lee" })] });
  const fu = p.window.App.followUp;
  const c = { id: "a", name: "Pat Lee", phone: "+971 50 123 4567", email: "pat+crm@example.com" };

  assert.equal(fu.telUrl(c, ""), "tel:+971501234567");
  assert.equal(fu.whatsappUrl(c, "", ""), "https://wa.me/971501234567",
    "wa.me takes digits only, with no plus");

  // A message with characters that would otherwise break the URL.
  const msg = "Hi Pat & co — 50% off?\nCall me";
  // Phase 2C: "?&body=" rather than "?body=", which is what makes one link
  // work on both iOS and Android.
  const sms = fu.smsUrl(c, msg, "");
  assert.ok(sms.startsWith("sms:+971501234567?&body="), sms);
  assert.ok(!sms.slice("sms:+971501234567?&body=".length).includes("&"),
    "the ampersand in the message itself is still encoded: " + sms);
  assert.equal(decodeURIComponent(sms.split("?&body=")[1]), msg);

  const wa = fu.whatsappUrl(c, msg, "");
  assert.equal(decodeURIComponent(wa.split("?text=")[1]), msg);

  const mail = fu.mailtoUrl(c, "Your search & shortlist", "Line one\nLine two");
  assert.ok(mail.startsWith("mailto:pat+crm@example.com?"), "the address stays readable: " + mail);
  assert.match(mail, /subject=Your%20search%20%26%20shortlist/);
  assert.equal(decodeURIComponent(mail.split("body=")[1]), "Line one\nLine two");
});

domTest("a number with no country code gets the workspace default, and none without one", async () => {
  const p = await today({ contacts: [contact({ id: "a" })], settings: { defaultCountryCode: "+971" } });
  const fu = p.window.App.followUp;
  const local = { phone: "050 123 4567" };

  // The trunk 0 is not part of the international form.
  assert.equal(fu.parsePhone(local.phone, "+971").digits, "971501234567");
  assert.equal(fu.telUrl(local, "+971"), "tel:+971501234567");
  assert.equal(fu.whatsappUrl(local, "", "+971"), "https://wa.me/971501234567");

  // 00 is the other way of writing +, and must not be prefixed again.
  assert.equal(fu.parsePhone("00971501234567", "+44").digits, "971501234567");
  // An explicit + wins over the default.
  assert.equal(fu.parsePhone("+15551234567", "+971").digits, "15551234567");
  // With no default set, the number is used exactly as stored.
  const bare = fu.parsePhone("5551234567", "");
  assert.equal(bare.digits, "5551234567");
  assert.equal(bare.known, false);
  assert.equal(fu.telUrl({ phone: "5551234567" }, ""), "tel:5551234567");
  // The workspace setting is picked up without being passed in.
  assert.equal(fu.telUrl({ phone: "050 123 4567" }), "tel:+971501234567");
});

domTest("a template fills the merge fields before the agent edits it", async () => {
  const p = await today({
    contacts: [contact({ id: "a", name: "Pat Lee", nextFollowUp: TODAY, phone: "5551234567" })],
    templates: [{
      id: "t1", name: "Check in", is_active: true,
      subject: "Hello {{first_name}}", body_text: "Hi {{first_name}}, it is {{agent_name}}. Reply to {{email}}. {{unknown_tag}}",
    }],
    settings: { agentName: "Dana Reed" },
  });

  p.pane.querySelector('[data-contact-row="a"] [data-fu-action="sms"]').click();
  await settle(p.window);
  const m = modal(p);
  assert.ok(m, "the message picker opens");

  const sel = m.querySelector("#fuTemplate");
  sel.value = "t1";
  sel.dispatchEvent(new p.window.Event("change", { bubbles: true }));
  await settle(p.window);

  assert.equal(m.querySelector("#fuBody").value,
    "Hi Pat, it is Dana Reed. Reply to . {{unknown_tag}}",
    "known tags are filled, a blank value is blank, and an unknown tag is left visible");
});

// ---------------------------------------------------------------- quick log

domTest("saving the quick log writes one activity and moves the contact on", async () => {
  const p = await today({
    contacts: [contact({ id: "a", name: "Pat Lee", nextFollowUp: "2026-10-12", phone: "5551234567" })],
  });
  p.pane.querySelector('[data-contact-row="a"] [data-fu-action="log"]').click();
  await settle(p.window);
  const m = modal(p);

  m.querySelector('[data-fu-outcome="voicemail"]').click();
  m.querySelector("#fuNote").value = "Left a message about the viewing";
  m.querySelector('[data-fu-next="d3"]').click();
  await settle(p.window);
  m.querySelector('[data-role="save"]').click();
  await settle(p.window);

  const created = p.writes.find((w) => w[0] === "activities.create");
  assert.ok(created, "an activity is recorded");
  assert.equal(created[1].type, "Call", "a voicemail is a call in the timeline");
  assert.equal(created[1].outcome, "Left voicemail");
  assert.equal(created[1].contactId, "a");
  assert.equal(created[1].notes, "Left a message about the viewing");

  const updated = p.writes.find((w) => w[0] === "contacts.update");
  assert.ok(updated, "the contact moves on");
  assert.equal(updated[2].lastContact, TODAY);
  assert.equal(updated[2].nextFollowUp, "2026-10-18", "3 days from today");

  // The list redrew, and the row left the overdue section because it is no
  // longer overdue — the agent sees the effect of what they just logged.
  assert.ok(!rowNames(p, "overdue").includes("Pat Lee"),
    "the logged contact must leave the overdue section");
  assert.ok(!sectionTitles(p).some((t) => t.startsWith("Overdue")),
    "and with nothing else overdue the section is gone: " + JSON.stringify(sectionTitles(p)));
});

domTest("'None' records the call without inventing a follow-up date", async () => {
  const p = await today({
    contacts: [contact({ id: "a", name: "Pat Lee", nextFollowUp: "2026-10-12", phone: "5551234567" })],
  });
  p.pane.querySelector('[data-contact-row="a"] [data-fu-action="log"]').click();
  await settle(p.window);
  const m = modal(p);
  m.querySelector('[data-role="save"]').click();   // None is the default
  await settle(p.window);

  const updated = p.writes.find((w) => w[0] === "contacts.update");
  assert.deepEqual(Object.keys(updated[2]), ["lastContact"],
    "only the last-contact date is touched; whatever follow-up was set stays");
});

domTest("cancelling the quick log writes nothing at all", async () => {
  const p = await today({
    contacts: [contact({ id: "a", name: "Pat Lee", nextFollowUp: "2026-10-12" })],
  });
  p.pane.querySelector('[data-contact-row="a"] [data-fu-action="log"]').click();
  await settle(p.window);
  const m = modal(p);
  m.querySelector('[data-fu-outcome="reached"]').click();
  m.querySelector("#fuNote").value = "typed but abandoned";
  m.querySelector('[data-role="cancel"]').click();
  await settle(p.window);

  assert.deepEqual(p.writes, [], "cancel means cancel");
});

// ---------------------------------------------------------------- escaping

domTest("a contact's own text is shown, never executed", async () => {
  const p = await today({
    contacts: [contact({
      id: "x",
      name: '<img src=x onerror="window.__pwned=1">',
      nextFollowUp: TODAY,
      stage: '"><script>window.__pwned=1</script>',
      phone: "5551234567",
    })],
  });
  assert.equal(p.window.__pwned, undefined, "nothing ran");
  assert.equal(p.pane.querySelector("img"), null, "the markup was not parsed as markup");
  assert.equal(p.pane.querySelector("script"), null);
  assert.ok(p.pane.textContent.includes("onerror"), "and the text is still displayed literally");
});
