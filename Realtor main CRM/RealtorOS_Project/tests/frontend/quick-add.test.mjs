// Phase 2F, browser side: the "+" that is always there, the paste box
// that fills it in, and the three starter packs that can finally say who
// they are for.
//
// The paste parser is the part worth pinning hardest, because it is the
// only thing here that guesses. It is tested on whole messages of the
// shape an agent actually gets - a Zillow-style notification, a
// Rightmove-style one, a forwarded email with a signature, and a plain
// text message - rather than on the fragments it happens to handle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { browser, settle, SKIP_DOM } from "../helpers/browser.mjs";

const open = [];
function closeAll() {
  while (open.length) {
    const b = open.pop();
    try { b.close(); } catch (e) { /* already gone */ }
  }
}

const SCRIPTS = [
  "assets/js/core/utils.js",
  "assets/js/core/follow-up.js",
  "assets/js/core/starter-packs.js",
  "assets/js/app.js",
  "assets/js/core/quick-add.js",
];

function domTest(name, fn) {
  test(name, async (t) => {
    const probe = await browser(SCRIPTS, { store: { getState: () => ({ settings: {} }) } });
    if (!probe) return t.skip(SKIP_DOM);
    try { probe.close(); } catch (e) {}
    try { await fn(); } finally { closeAll(); }
  });
}

// A workspace with whatever contacts the test needs, and a record of
// everything that was written.
async function app(contacts = []) {
  const calls = [];
  const b = await browser(SCRIPTS, {
    store: {
      ensureLoaded: async () => {},
      getState: () => ({
        contacts,
        settings: { leadSources: ["Referral", "Website", "Zillow / Portal", "Other"] },
      }),
      contacts: {
        create: async (m) => {
          calls.push(["create", m]);
          const c = Object.assign({ id: "ct_new" }, m);
          contacts.push(c);
          return c;
        },
        get: async (id) => contacts.find((c) => c.id === id) || null,
        update: async (id, patch) => { calls.push(["update", id, patch]); return patch; },
      },
      activities: { create: async (m) => { calls.push(["activity", m]); return m; } },
      messageTemplates: { list: async () => [] },
    },
  });
  if (!b) return null;
  open.push(b);
  const navigated = [];
  b.window.App.app.navigate = (path) => { navigated.push(path); };
  b.window.App.quickAdd.mount(b.document);
  return Object.assign({}, b, { calls, navigated, contacts });
}

const modal = (p) => {
  const all = p.document.querySelectorAll(".modal");
  return all.length ? all[all.length - 1] : null;
};

async function openForm(p) {
  p.document.getElementById("quickAddBtn").click();
  await settle(p.window);
  return modal(p);
}

const type = (m, sel, value) => {
  const el = m.querySelector(sel);
  el.value = value;
  el.dispatchEvent(new el.ownerDocument.defaultView.Event("input", { bubbles: true }));
};

// ---------------------------------------------------------------- the button

domTest("the + is in the header and floating on mobile, on every page", async () => {
  const p = await app();
  const header = p.document.getElementById("quickAddBtn");
  const fab = p.document.getElementById("quickAddFab");
  assert.ok(header, "the header button exists");
  assert.ok(fab, "and so does the floating one, so a phone always has it");
  assert.equal(header.getAttribute("aria-label"), "Add a contact");
  assert.equal(fab.getAttribute("aria-label"), "Add a contact");
  // It sits beside #topActions, which every route overwrites - inside it
  // the button would vanish on the next navigation.
  assert.ok(!p.document.getElementById("topActions").contains(header),
    "the header button is not inside the per-page action slot");

  // Mounting twice is what a shell re-render does.
  p.window.App.quickAdd.mount(p.document);
  assert.equal(p.document.querySelectorAll("#quickAddBtn").length, 1);
  assert.equal(p.document.querySelectorAll("#quickAddFab").length, 1);

  fab.click();
  await settle(p.window);
  assert.ok(modal(p), "the floating button opens the same form");
});

// ---------------------------------------------------------------- saving

domTest("quick add saves the six fields and nothing else", async () => {
  const p = await app();
  const m = await openForm(p);
  type(m, "#qaName", "  Sarah Khan ");
  type(m, "#qaPhone", "07700 900123");
  type(m, "#qaEmail", "sarah@example.com");
  m.querySelector("#qaType").value = "Seller";
  m.querySelector("#qaSource").value = "Website";
  type(m, "#qaNote", "Met at the Elm Road viewing.");
  m.querySelector('[data-role="save"]').click();
  await settle(p.window);

  const created = p.calls.find((c) => c[0] === "create");
  assert.ok(created, "it saved: " + JSON.stringify(p.calls));
  assert.deepEqual(JSON.parse(JSON.stringify(created[1])), {
    name: "Sarah Khan",
    role: "Seller",
    email: "sarah@example.com",
    phone: "07700 900123",
    source: "Website",
    notes: "Met at the Elm Road viewing.",
  });
});

domTest("Enter saves from a single-line field, and a name is required", async () => {
  const p = await app();
  const m = await openForm(p);
  const phone = m.querySelector("#qaPhone");

  // Nothing typed yet: Enter must not write an empty contact.
  phone.dispatchEvent(new p.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle(p.window);
  assert.equal(p.calls.filter((c) => c[0] === "create").length, 0);
  assert.ok(p.toasts.some((t) => /name/i.test(t.message || "")), JSON.stringify(p.toasts));

  type(m, "#qaName", "Tom Byrne");
  phone.dispatchEvent(new p.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await settle(p.window);
  assert.equal(p.calls.filter((c) => c[0] === "create").length, 1, "Enter saved it");
});

domTest("after saving, the toast offers Open and the Phase 2B quick log", async () => {
  const p = await app();
  const m = await openForm(p);
  type(m, "#qaName", "Sarah Khan");
  m.querySelector('[data-role="save"]').click();
  await settle(p.window);

  const toast = p.toasts.find((t) => /Added Sarah Khan/.test(t.message || ""));
  assert.ok(toast, JSON.stringify(p.toasts));
  const labels = (toast.opts && toast.opts.actions || []).map((a) => String(a.label));
  assert.deepEqual(JSON.parse(JSON.stringify(labels)), ["Open", "Log a call"]);

  toast.opts.actions[0].onClick();
  assert.deepEqual(p.navigated, ["/contacts/ct_new"], "Open goes to the new contact");

  toast.opts.actions[1].onClick();
  await settle(p.window);
  const log = modal(p);
  assert.ok(log && /Log/i.test(log.textContent),
    "Log a call opens the quick log rather than a second form");
});

// ---------------------------------------------------------------- duplicates

domTest("a matching email or phone asks before saving a second copy", async () => {
  const existing = {
    id: "ct_1", name: "Sarah Khan", email: "Sarah@Example.com", phone: "+44 7700 900123",
  };
  const p = await app([existing]);

  // Same address, different capitalisation.
  let m = await openForm(p);
  type(m, "#qaName", "S Khan");
  type(m, "#qaEmail", "sarah@example.com");
  m.querySelector('[data-role="save"]').click();
  await settle(p.window);
  assert.equal(p.calls.filter((c) => c[0] === "create").length, 0, "nothing was written");
  const dup = m.querySelector("#qaDuplicate");
  assert.equal(dup.hidden, false);
  assert.match(dup.textContent, /Looks like Sarah Khan is already here/);
  assert.match(dup.textContent, /open them instead/i);

  dup.querySelector('[data-role="qa-open-dup"]').click();
  await settle(p.window);
  assert.deepEqual(p.navigated, ["/contacts/ct_1"], "and it opens the one already there");

  // Same number written differently - the last nine digits are the same
  // number however it was typed.
  m = await openForm(p);
  type(m, "#qaName", "Sarah K");
  type(m, "#qaPhone", "07700 900123");
  m.querySelector('[data-role="save"]').click();
  await settle(p.window);
  assert.equal(p.calls.filter((c) => c[0] === "create").length, 0);
  assert.match(m.querySelector("#qaDuplicate").textContent, /already here/);

  // It asks, it does not refuse: two people really do share a landline.
  m.querySelector('[data-role="qa-save-anyway"]').click();
  await settle(p.window);
  assert.equal(p.calls.filter((c) => c[0] === "create").length, 1, "Save anyway saves");
});

domTest("a new number and a new address save without a question", async () => {
  const p = await app([{ id: "ct_1", name: "Sarah Khan", email: "sarah@example.com", phone: "07700 900123" }]);
  const m = await openForm(p);
  type(m, "#qaName", "Tom Byrne");
  type(m, "#qaEmail", "tom@example.com");
  type(m, "#qaPhone", "07700 900999");
  m.querySelector('[data-role="save"]').click();
  await settle(p.window);
  assert.equal(p.calls.filter((c) => c[0] === "create").length, 1);
  assert.equal(m.querySelector("#qaDuplicate").hidden, true, "no question was asked");
});

// ---------------------------------------------------------------- paste

const ZILLOW = `From: Zillow <noreply@mail.zillow.com>
Subject: New lead: 42 Elm Road

You have a new lead from Sarah Khan.

Sarah Khan is interested in 42 Elm Road, Springfield (listed at $450,000)
and would like to arrange a viewing.

Contact details
Email: sarah.khan@gmail.com
Phone: (415) 555-0132

Reply to this lead within 5 minutes to improve your response rating.
Do not reply to this email; it was sent from an unmonitored address.`;

const RIGHTMOVE = `From: Rightmove <no-reply@rightmove.co.uk>
Sent: 12 October 2026 09:14
Subject: Property enquiry - 8 Oak Lane, Leeds

You have received a new enquiry from Daniel O'Connor.

Name: Daniel O'Connor
Telephone: +44 7700 900456
Email: d.oconnor@outlook.com

Message:
"Hello, is 8 Oak Lane still available? I am a cash buyer and could view
this weekend. Guide price £325,000 looks right to me."

Rightmove, 2 Waterhouse Square.`;

const SIGNED_EMAIL = `Hi there,

I saw the listing on your website for the flat on Harbour Street and
wondered whether it is still on the market. We are hoping to move before
the end of the year.

Kind regards,
Amara Nwosu
amara.nwosu@workmail.com
07911 123456`;

const TEXT_MESSAGE = `hi - got your number from Jane at the open house on Sunday.
im looking for a 2 bed around Didsbury, budget about 280000.
name is Michael Okafor, best email michael.okafor@gmail.com
mobile 0161 496 0123 - call anytime after 6`;

domTest("paste to fill reads a name, phone and email out of four real messages", async () => {
  const p = await app();
  const extract = (t) => JSON.parse(JSON.stringify(p.window.App.quickAdd.extractFromText(t)));

  assert.deepEqual(extract(ZILLOW), {
    name: "Sarah Khan",
    email: "sarah.khan@gmail.com",
    phone: "(415) 555-0132",
  }, "a Zillow-style notification: the lead's address, not the portal's");

  assert.deepEqual(extract(RIGHTMOVE), {
    name: "Daniel O'Connor",
    email: "d.oconnor@outlook.com",
    phone: "+44 7700 900456",
  }, "a Rightmove-style one: the labelled fields, and £325,000 is not a phone number");

  assert.deepEqual(extract(SIGNED_EMAIL), {
    name: "Amara Nwosu",
    email: "amara.nwosu@workmail.com",
    phone: "07911 123456",
  }, "an email the person typed themselves: the signature is the name");

  assert.deepEqual(extract(TEXT_MESSAGE), {
    name: "Michael Okafor",
    email: "michael.okafor@gmail.com",
    phone: "0161 496 0123",
  }, "a text message: lower case throughout, and 280000 is a budget");

  // And it says so rather than guessing when there is nothing to find.
  assert.deepEqual(extract("Call me back about the house."),
    { name: "", email: "", phone: "" });
});

domTest("pasting fills the form and saves nothing by itself", async () => {
  const p = await app();
  const m = await openForm(p);
  type(m, "#qaPaste", ZILLOW);
  await settle(p.window);

  assert.equal(m.querySelector("#qaName").value, "Sarah Khan");
  assert.equal(m.querySelector("#qaEmail").value, "sarah.khan@gmail.com");
  assert.equal(m.querySelector("#qaPhone").value, "(415) 555-0132");
  assert.equal(p.calls.length, 0, "nothing was written: the agent confirms");
  assert.match(m.querySelector("#qaPasteNote").textContent, /Check it, then press Save/);

  // Still only saved when asked.
  m.querySelector('[data-role="save"]').click();
  await settle(p.window);
  assert.equal(p.calls.filter((c) => c[0] === "create").length, 1);
});

domTest("pasting never overwrites a field the agent typed in", async () => {
  const p = await app();
  const m = await openForm(p);
  type(m, "#qaName", "Sarah (from the viewing)");
  type(m, "#qaPaste", ZILLOW);
  await settle(p.window);

  assert.equal(m.querySelector("#qaName").value, "Sarah (from the viewing)",
    "what they typed stands");
  assert.equal(m.querySelector("#qaEmail").value, "sarah.khan@gmail.com",
    "the fields they left alone are filled");
});

// ---------------------------------------------------------------- the packs

domTest("the starter packs say who they are for instead of asking for a tag", async () => {
  const p = await app();
  const packs = p.window.App.starterPacks.all();
  const byId = {};
  packs.forEach((pack) => { byId[pack.id] = pack; });

  assert.deepEqual(JSON.parse(JSON.stringify(byId.buyer.rule.audienceFilter)),
    { type_in: ["Buyer"] });
  assert.deepEqual(JSON.parse(JSON.stringify(byId.seller.rule.audienceFilter)),
    { type_in: ["Seller"] });
  assert.deepEqual(JSON.parse(JSON.stringify(byId.revival.rule.audienceFilter)),
    { temperature_in: ["Cold"] });

  packs.forEach((pack) => {
    assert.ok(!pack.note, pack.id + " should no longer apologise for a filter it now has");
  });
  // The one that always could say it still does.
  assert.deepEqual(JSON.parse(JSON.stringify(byId.openhouse.rule.audienceFilter)),
    { tags_any: ["Open house"] });
});

domTest("installing a pack again corrects its own untouched draft, and nothing else", async () => {
  const b = await browser(SCRIPTS, { store: null });
  if (!b) return;
  open.push(b);

  const made = (over) => Object.assign({
    id: "r1", name: "New buyer lead", status: "draft", audience_filter: {},
    metadata: { starter_pack: "buyer" },
    created_at: "2026-10-01T10:00:00Z", updated_at: "2026-10-01T10:00:00Z",
  }, over);

  async function install(rules) {
    const calls = [];
    b.window.App.store = {
      getState: () => ({ settings: {} }),
      messageTemplates: {
        list: async () => [{ id: "t1", name: "New buyer lead — welcome", is_active: true }],
        create: async (m) => { calls.push(["template", m]); return Object.assign({ id: "t9" }, m); },
      },
      automationRules: {
        list: async () => rules,
        create: async (m) => { calls.push(["rule", m]); return Object.assign({ id: "r9" }, m); },
        update: async (id, patch) => { calls.push(["ruleUpdate", id, patch]); return patch; },
      },
      automationSteps: { create: async () => ({ id: "s1" }) },
    };
    const result = await b.window.App.starterPacks.install(["buyer"]);
    return { calls, result: JSON.parse(JSON.stringify(result)) };
  }

  // An untouched draft this pack created: it is still the pack's to fix.
  const fresh = await install([made()]);
  const upgrade = fresh.calls.find((c) => c[0] === "ruleUpdate");
  assert.ok(upgrade, "it narrowed the audience: " + JSON.stringify(fresh.calls));
  assert.deepEqual(JSON.parse(JSON.stringify(upgrade[2])), { audienceFilter: { type_in: ["Buyer"] } });
  assert.deepEqual(fresh.result.updated, ["New buyer lead"]);
  assert.equal(fresh.calls.filter((c) => c[0] === "rule").length, 0, "and added nothing");

  // Edited since it was created, activated, or somebody else's rule of
  // the same name: all three belong to the agent now.
  for (const rule of [
    made({ updated_at: "2026-10-09T08:00:00Z" }),
    made({ status: "active" }),
    made({ metadata: {} }),
  ]) {
    const left = await install([rule]);
    assert.equal(left.calls.filter((c) => c[0] === "ruleUpdate").length, 0,
      "left alone: " + JSON.stringify(rule));
    assert.deepEqual(left.result.skipped.map((s) => s.reason), ["already there"]);
  }

  // And once corrected, running it again does nothing at all.
  const again = await install([made({ audience_filter: { type_in: ["Buyer"] } })]);
  assert.equal(again.calls.length, 0, JSON.stringify(again.calls));
});

// ---------------------------------------------------------------- rule builder
//
// The other half of Phase 2F: the audience the packs now use has to be
// something an agent can pick for themselves.

const AUTO_SCRIPTS = [
  "assets/js/core/utils.js",
  "assets/js/core/starter-packs.js",
  "assets/js/app.js",
  "assets/js/pages/automation.js",
];

async function autoPage(contacts, rules = []) {
  const calls = [];
  const b = await browser(AUTO_SCRIPTS, {
    store: {
      ensureLoaded: async () => {},
      getState: () => ({
        contacts,
        settings: { currency: "USD", pipelineStages: [{ name: "New" }] },
      }),
      messageTemplates: { list: async () => [] },
      automationRules: {
        list: async () => rules,
        create: async (m) => { calls.push(["rule", m]); return Object.assign({ id: "r1" }, m); },
        update: async (id, p) => { calls.push(["ruleUpdate", id, p]); return p; },
        delete: async () => true,
      },
      automationSteps: { list: async () => [], create: async () => ({ id: "s" }) },
      automationRuntime: {
        listEnrollments: async () => [], listJobs: async () => [], listFailures: async () => [],
      },
    },
  });
  if (!b) return null;
  open.push(b);
  const pane = b.document.createElement("div");
  b.document.body.appendChild(pane);
  await b.window.App.pages.automation.render(pane);
  await settle(b.window);
  return Object.assign({}, b, { pane, calls });
}

function autoDomTest(name, fn) {
  test(name, async (t) => {
    const probe = await browser(AUTO_SCRIPTS, { store: { getState: () => ({ settings: {} }) } });
    if (!probe) return t.skip(SKIP_DOM);
    try { probe.close(); } catch (e) {}
    try { await fn(); } finally { closeAll(); }
  });
}

const boxes = (m, cls) => Array.from(m.querySelectorAll("." + cls)).map((c) => c.value);
const tick = (m, cls, value) => {
  const box = Array.from(m.querySelectorAll("." + cls)).find((c) => c.value === value);
  box.checked = true;
  box.dispatchEvent(new box.ownerDocument.defaultView.Event("change", { bubbles: true }));
};

autoDomTest("the rule builder picks a type and a temperature, and says so in plain words", async () => {
  // A workspace that renamed one of its types: it is offered too, rather
  // than the four defaults pretending to be the whole list.
  const p = await autoPage([
    { id: "c1", role: "Buyer", temperature: "Hot", tags: [] },
    { id: "c2", role: "Landlord", temperature: "Cold", tags: [] },
  ]);
  p.pane.querySelector("#autoCreateBtn").click();
  await settle(p.window);
  const m = p.document.querySelector(".modal");

  assert.deepEqual(boxes(m, "auto-cfg-type"),
    ["Buyer", "Seller", "Investor", "Referral Partner", "Landlord"],
    "the standard types first, then what this workspace actually uses");
  assert.deepEqual(boxes(m, "auto-cfg-temp"), ["Hot", "Warm", "Cold"]);

  m.querySelector("#autoName").value = "Cold buyers";
  tick(m, "auto-cfg-type", "Buyer");
  tick(m, "auto-cfg-temp", "Cold");
  await settle(p.window);
  const summary = m.querySelector("#autoTriggerSummary").textContent;
  assert.match(summary, /Only Buyer contacts\./);
  assert.match(summary, /Only contacts marked Cold\./);

  m.querySelector('[data-role="save"]').click();
  await settle(p.window);
  const created = p.calls.find((c) => c[0] === "rule");
  assert.ok(created, JSON.stringify(p.calls));
  assert.deepEqual(JSON.parse(JSON.stringify(created[1].audienceFilter)),
    { type_in: ["Buyer"], temperature_in: ["Cold"] },
    "nothing ticked in a list means no filter on it, not an empty one");
});

autoDomTest("editing a rule keeps the audience it already has", async () => {
  const existing = {
    id: "r-edit", name: "New buyer lead", status: "draft", trigger_type: "contact_created",
    timezone: "UTC", trigger_config: {}, metadata: {},
    audience_filter: { type_in: ["Buyer"], temperature_in: ["Cold"], tags_any: ["VIP"] },
    stop_on_reply: true, stop_on_unsubscribe: true, daily_enrollment_limit: 100,
  };
  // No contact carries any of these right now, which is exactly when a
  // rule's audience could get silently dropped.
  const p = await autoPage([], [existing]);
  p.pane.querySelector('[data-edit-rule="r-edit"]').click();
  await settle(p.window);
  const m = p.document.querySelector(".modal");

  const checked = (cls) => Array.from(m.querySelectorAll("." + cls + ":checked")).map((c) => c.value);
  assert.deepEqual(checked("auto-cfg-type"), ["Buyer"]);
  assert.deepEqual(checked("auto-cfg-temp"), ["Cold"]);
  assert.deepEqual(checked("auto-cfg-tag"), ["VIP"], "the 2E tag audience survives an edit too");

  m.querySelector('[data-role="save"]').click();
  await settle(p.window);
  const saved = p.calls.find((c) => c[0] === "ruleUpdate");
  assert.ok(saved, JSON.stringify(p.calls));
  assert.deepEqual(JSON.parse(JSON.stringify(saved[2].audienceFilter)),
    { tags_any: ["VIP"], type_in: ["Buyer"], temperature_in: ["Cold"] },
    "saving an untouched form changes nothing about who it reaches");
});


domTest("header Quick Add has a contrasting light background without changing dark mode", async () => {
  const p = await app();
  const button = p.document.getElementById("quickAddBtn");
  assert.equal(button.textContent, "+");
  const css = readFileSync(new URL("../../app/assets/css/realtoros.css", import.meta.url), "utf8");
  const selector = ':root:not([data-theme="dark"]) .quick-add-btn';
  const start = css.indexOf(selector);
  assert.ok(start >= 0, "a light-only rule must supply the missing background");
  const rule = css.slice(start).match(/\{([^}]+)\}/)[1];
  const token = rule.match(/background:\s*var\((--[\w-]+)\)/)[1];
  const root = css.match(/:root\s*\{([^}]+)\}/)[1];
  const hex = root.match(new RegExp(token + ':\\s*(#[0-9a-f]{6})', 'i'))?.[1];
  assert.ok(hex, "the background token resolves to a defined light-mode colour");
  const luminance = hex.slice(1).match(/../g).map(v => parseInt(v, 16) / 255)
    .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  assert.ok(1.05 / (luminance + 0.05) >= 4.5, "white plus has at least 4.5:1 contrast");
  assert.match(css.match(/\.quick-add-btn\s*\{([^}]+)\}/)[1], /color:\s*#FFFFFF/i);
  for (const theme of [null, "light", "dark"]) {
    if (theme) p.document.documentElement.setAttribute("data-theme", theme);
    else p.document.documentElement.removeAttribute("data-theme");
    assert.equal(button.matches(selector), theme !== "dark");
  }
});
