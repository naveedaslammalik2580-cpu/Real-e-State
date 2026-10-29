// Phase 2E, browser side: the setup guide, the getting-started checklist,
// the time zone nudge, the shared starter-pack registry, and the import
// header presets.
//
// The two promises worth pinning hardest: the guide is resumable and
// skippable (a wizard you cannot escape or get back to is worse than none),
// and the packs only ever create drafts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { browser, settle, SKIP_DOM } from "../helpers/browser.mjs";

const open = [];
function closeAll() {
  while (open.length) {
    const b = open.pop();
    try { b.close(); } catch (e) { /* already gone */ }
  }
}

async function load(scripts, opts) {
  const b = await browser(scripts, opts);
  if (!b) return null;
  open.push(b);
  return b;
}

function domTest(name, scripts, fn) {
  test(name, async (t) => {
    const probe = await browser(scripts, { store: { getState: () => ({ settings: {} }) } });
    if (!probe) return t.skip(SKIP_DOM);
    try { probe.close(); } catch (e) {}
    try { await fn(); } finally { closeAll(); }
  });
}

// ---------------------------------------------------------------- presets

const IMPORT_SCRIPTS = ["assets/js/core/utils.js", "assets/js/core/lead-file.js"];

const HEADERS = {
  followupboss: ["First Name", "Last Name", "Emails", "Phones", "Stage", "Source", "Background", "Tags"],
  wiseagent: ["First", "Last", "Email", "Cell", "Categories", "Referred By", "Ranking", "Notes"],
  generic: ["Full Name", "E-mail", "Mobile", "Status", "Lead Source", "Comments", "Birthday"],
};

domTest("each of the three export shapes is recognised and mapped", IMPORT_SCRIPTS, async () => {
  const b = await load(IMPORT_SCRIPTS, { store: { getState: () => ({ settings: {} }) } });
  const L = b.window.App.leadFile;

  // Follow Up Boss: "Emails"/"Phones"/"Background"/"Stage".
  const fub = L.autoMap(HEADERS.followupboss);
  assert.equal(L.detectFormat(HEADERS.followupboss).id, "followupboss");
  assert.equal(fub[HEADERS.followupboss.indexOf("First Name")], "first_name");
  assert.equal(fub[HEADERS.followupboss.indexOf("Emails")], "email");
  assert.equal(fub[HEADERS.followupboss.indexOf("Phones")], "phone");
  assert.equal(fub[HEADERS.followupboss.indexOf("Stage")], "status");
  assert.equal(fub[HEADERS.followupboss.indexOf("Background")], "notes");

  // Wise Agent: "Categories"/"Referred By"/"Ranking".
  const wise = L.autoMap(HEADERS.wiseagent);
  assert.equal(L.detectFormat(HEADERS.wiseagent).id, "wiseagent");
  assert.equal(wise[HEADERS.wiseagent.indexOf("Cell")], "phone");
  assert.equal(wise[HEADERS.wiseagent.indexOf("Categories")], "tags");
  assert.equal(wise[HEADERS.wiseagent.indexOf("Referred By")], "source");

  // A plain spreadsheet, with the punctuation people actually use.
  const gen = L.autoMap(HEADERS.generic);
  assert.equal(L.detectFormat(HEADERS.generic).id, "generic");
  assert.equal(gen[HEADERS.generic.indexOf("Full Name")], "full_name");
  assert.equal(gen[HEADERS.generic.indexOf("E-mail")], "email");
  assert.equal(gen[HEADERS.generic.indexOf("Mobile")], "phone");
  assert.equal(gen[HEADERS.generic.indexOf("Status")], "status");
  assert.equal(gen[HEADERS.generic.indexOf("Comments")], "notes");
});

domTest("the plain column name wins over a numbered one", IMPORT_SCRIPTS, async () => {
  const b = await load(IMPORT_SCRIPTS, { store: { getState: () => ({ settings: {} }) } });
  const L = b.window.App.leadFile;
  // A file with both must import the primary address, whichever order the
  // columns happen to be in.
  const headers = ["Email 2", "Email", "Phone 2", "Phone"];
  const mapping = L.autoMap(headers);
  assert.equal(mapping[headers.indexOf("Email")], "email");
  assert.equal(mapping[headers.indexOf("Phone")], "phone");
  assert.equal(mapping[headers.indexOf("Email 2")], "", "the second address is left out, not imported over the first");
  assert.equal(mapping[headers.indexOf("Phone 2")], "");
});

domTest("a birthday column is recognised and reported as not importable", IMPORT_SCRIPTS, async () => {
  const b = await load(IMPORT_SCRIPTS, { store: { getState: () => ({ settings: {} }) } });
  const L = b.window.App.leadFile;
  const headers = ["Full Name", "Email", "Birthday"];
  const mapping = L.autoMap(headers);

  // Deliberately NOT mapped: the deployed import-lead-file reads a fixed
  // set of keys and would silently drop it, so offering the mapping would
  // lie to the agent.
  assert.equal(mapping[2], "", "birthday is not offered as an import target");
  assert.ok(!L.FIELDS.some((f) => f.key === "birthday"));

  const unsupported = L.unsupportedColumns(headers, mapping);
  assert.equal(unsupported.length, 1, "but it IS named, rather than ignored in silence");
  assert.equal(unsupported[0].header, "Birthday");
  assert.equal(unsupported[0].label, "Birthday");
});

domTest("a mapped Stage column reaches the payload", IMPORT_SCRIPTS, async () => {
  const b = await load(IMPORT_SCRIPTS, { store: { getState: () => ({ settings: {} }) } });
  const L = b.window.App.leadFile;
  const headers = ["Full Name", "Email", "Stage"];
  const mapping = L.autoMap(headers);
  const row = L.buildRow(["Pat Lee", "pat@example.com", "Qualified"], mapping);
  assert.equal(row.status, "Qualified", "the deployed importer reads status, so this lands");
  assert.equal(row.full_name, "Pat Lee");

  // Unmapped, the key is blank - which the server reads as its own default
  // rather than as a blank status.
  const noStage = L.buildRow(["Pat Lee", "pat@example.com"], L.autoMap(["Full Name", "Email"]));
  assert.equal(noStage.status, "");
});

// ---------------------------------------------------------------- packs

const PACK_SCRIPTS = [
  "assets/js/core/utils.js",
  "assets/js/core/starter-packs.js",
];

function packStore(rules, templates, calls) {
  return {
    getState: () => ({
      settings: {
        pipelineStages: [{ name: "New" }, { name: "Closed", terminal: "won" }],
      },
    }),
    messageTemplates: {
      list: async () => templates,
      create: async (m) => {
        calls.push(["template", m.name]);
        const t = Object.assign({ id: "t" + templates.length }, m);
        templates.push(t);
        return t;
      },
    },
    automationRules: {
      list: async () => rules,
      create: async (m) => {
        calls.push(["rule", m.name]);
        const r = Object.assign({ id: "r" + rules.length, status: "draft" }, m);
        rules.push(r);
        return r;
      },
    },
    automationSteps: {
      create: async (ruleId, m) => { calls.push(["step", ruleId, m.actionType]); return m; },
    },
  };
}

async function packs(existingRules = []) {
  const rules = existingRules.slice();
  const templates = [];
  const calls = [];
  const b = await load(PACK_SCRIPTS, { store: packStore(rules, templates, calls) });
  if (!b) return null;
  return Object.assign({}, b, { rules, templates, calls, P: b.window.App.starterPacks });
}

domTest("the registry offers five packs, and the past-client one is four rules", PACK_SCRIPTS, async () => {
  const p = await packs();
  const all = p.P.all();
  assert.deepEqual(plain(all.map((x) => x.id).sort()),
    ["buyer", "openhouse", "pastclient", "revival", "seller"]);
  all.forEach((pack) => {
    assert.ok(pack.name && pack.blurb, pack.id + " needs a name and a blurb for the picker");
  });
  const past = all.find((x) => x.id === "pastclient");
  assert.equal(p.P.itemsOf(past).length, 4, "birthday, anniversary, post-closing, stay in touch");
});

domTest("Stay in touch says its audience with tags_any, not a metadata note", PACK_SCRIPTS, async () => {
  const p = await packs();
  const past = p.P.all().find((x) => x.id === "pastclient");
  const stay = p.P.itemsOf(past).find((i) => i.rule.name === "Stay in touch");
  assert.deepEqual(plain(stay.rule.audienceFilter), { tags_any: ["Past client"] },
    "Phase 2E: the audience is the audience, not a note for the agent to apply by hand");

  // And the open-house pack, which always could say it.
  const oh = p.P.all().find((x) => x.id === "openhouse");
  assert.deepEqual(plain(oh.rule.audienceFilter), { tags_any: ["Open house"] });
});

domTest("installing creates drafts only, with the steps in order", PACK_SCRIPTS, async () => {
  const p = await packs();
  const result = await p.P.install(["buyer"], { timezone: "Asia/Dubai" });

  assert.deepEqual(plain(result.created), ["New buyer lead"]);
  assert.deepEqual(plain(result.failed), []);
  p.rules.forEach((r) => assert.equal(r.status, "draft", "nothing is ever created active"));
  assert.ok(!p.calls.some((c) => c[0] === "rule" && /status/.test(JSON.stringify(c))),
    "and the pack never asks for a status");

  const steps = p.calls.filter((c) => c[0] === "step").map((c) => c[2]);
  assert.deepEqual(plain(steps),
    ["send_email", "wait", "create_task", "wait", "send_email", "wait", "create_task"],
    "welcome, then call, then email, then check in");
  assert.equal(p.rules[0].timezone, "Asia/Dubai", "created in the workspace's zone");
});

domTest("installing twice adds nothing, and an existing rule is untouched", PACK_SCRIPTS, async () => {
  const p = await packs();
  await p.P.install(["buyer", "seller"]);
  const afterFirst = p.calls.length;
  assert.equal(p.rules.length, 2);

  const again = await p.P.install(["buyer", "seller"]);
  assert.equal(p.calls.length, afterFirst, "the second run writes nothing at all");
  assert.deepEqual(plain(again.created), []);
  assert.deepEqual(plain(again.skipped.map((s) => s.reason)), ["already there", "already there"]);
  assert.match(p.P.summarize(again), /Already there/);
});

domTest("a pack whose requirement is missing is skipped with a reason", PACK_SCRIPTS, async () => {
  const p = await packs();
  // A pipeline with no won stage: the post-closing rule has nothing to
  // point at, but its three siblings are fine.
  p.window.App.store.getState = () => ({ settings: { pipelineStages: [{ name: "New" }] } });
  const result = await p.P.install(["pastclient"]);

  assert.ok(!result.created.includes("30 days after closing"));
  assert.equal(result.created.length, 3, "the rest of the pack still installs");
  const skipped = result.skipped.find((s) => s.name === "30 days after closing");
  assert.ok(skipped && /closing stage/.test(skipped.reason), JSON.stringify(result.skipped));
  assert.match(p.P.summarize(result), /Skipped 30 days after closing/);
});

// ---------------------------------------------------------------- onboarding

const OB_SCRIPTS = [
  "assets/js/core/utils.js",
  "assets/js/core/starter-packs.js",
  "assets/js/app.js",
  "assets/js/pages/onboarding.js",
];

function obStore(settings, saved, rules) {
  return {
    ensureLoaded: async () => {},
    getState: () => ({
      contacts: [], activities: [], settings: Object.assign({
        pipelineStages: [{ name: "Closed", terminal: "won" }],
      }, settings),
    }),
    settings: {
      get: () => settings,
      update: async (patch) => { saved.push(patch); Object.assign(settings, patch); return patch; },
      listTimezones: async () => ["UTC", "Asia/Dubai", "Europe/London"],
    },
    messageTemplates: { list: async () => [], create: async (m) => ({ id: "t1", ...m }) },
    automationRules: { list: async () => (rules || []), create: async (m) => ({ id: "r1", status: "draft", ...m }) },
    automationSteps: { create: async () => ({}) },
    emailSenderProfile: { save: async (m) => { saved.push(["sender", m]); return m; } },
  };
}

async function wizard(settings = {}, rules) {
  const saved = [];
  const b = await load(OB_SCRIPTS, { store: obStore(settings, saved, rules) });
  if (!b) return null;
  return Object.assign({}, b, { saved, settings, O: b.window.App.pages.onboarding });
}

// The LAST modal: re-rendering a wizard step opens a new one, and a stale
// node can still be in the document for a tick.
const modal = (p) => {
  const all = p.document.querySelectorAll(".modal");
  return all.length ? all[all.length - 1] : null;
};
// Objects built inside the jsdom window carry that realm's Object
// prototype, so a strict deepEqual against a literal from this realm fails
// on the prototype alone. Comparing the plain data is what these mean.
const plain = (v) => JSON.parse(JSON.stringify(v));
const footerBtn = (p, role) => modal(p).querySelector('[data-role="' + role + '"]');

domTest("the guide only shows when it has not been done, and resumes where it stopped", OB_SCRIPTS, async () => {
  const done = await wizard({ onboardingDone: true });
  assert.equal(done.O.maybeOpen(), false, "a finished workspace is not asked again");
  assert.equal(modal(done), null);
  closeAll();

  const fresh = await wizard({});
  assert.equal(fresh.O.maybeOpen(), true);
  await settle(fresh.window);
  assert.match(modal(fresh).textContent, /Your business/);
  assert.match(modal(fresh).textContent, /1 of 3/);
  closeAll();

  // Closed the browser on step 3: it comes back on step 3, not step 1.
  const resumed = await wizard({ onboardingStep: 3 });
  resumed.O.maybeOpen();
  await settle(resumed.window);
  assert.match(modal(resumed).textContent, /3 of 5/);
  assert.match(modal(resumed).textContent, /Follow-ups to start from/);
});

domTest("step 1 saves the basics, and refuses a bad country code", OB_SCRIPTS, async () => {
  const p = await wizard({});
  p.O.open(1);
  await settle(p.window);
  const m = modal(p);

  m.querySelector("#obName").value = "Dana Reed";
  m.querySelector("#obCountry").value = "971501234567";   // a whole number
  m.querySelector("#obZone").value = "Asia/Dubai";
  footerBtn(p, "next").click();
  await settle(p.window);

  assert.equal(m.querySelector("#obStep1Error").style.display, "block");
  assert.deepEqual(p.saved, [], "nothing is saved while a field is wrong");

  m.querySelector("#obCountry").value = "+971";
  footerBtn(p, "next").click();
  await settle(p.window);

  const patch = p.saved.find((x) => x && x.agentName);
  assert.ok(patch, JSON.stringify(p.saved));
  assert.equal(patch.agentName, "Dana Reed");
  assert.equal(patch.defaultCountryCode, "+971");
  assert.equal(patch.timezone, "Asia/Dubai");
  assert.equal(patch.timezoneConfirmed, true, "choosing a zone is confirming it");
});

domTest("skipping a step moves on and remembers the place", OB_SCRIPTS, async () => {
  const p = await wizard({});
  p.O.open(1);
  await settle(p.window);
  footerBtn(p, "skip").click();
  await settle(p.window);

  assert.match(modal(p).textContent, /2 of 3/);
  assert.ok(p.saved.some((x) => x && x.onboardingStep === 2),
    "the place is recorded, so closing now resumes here");
  // Step 1 collected nothing, so nothing about the business was written.
  assert.ok(!p.saved.some((x) => x && x.agentName));
});

domTest("step 4 takes both halves of a sender or neither, and never enables sending", OB_SCRIPTS, async () => {
  const p = await wizard({ onboardingStep: 4 });
  p.O.open(4);
  await settle(p.window);
  const m = modal(p);
  assert.match(m.textContent, /does not start sending/i, "it says so plainly");

  m.querySelector("#obSenderName").value = "Dana Reed";
  m.querySelector("#obSenderReply").value = "";
  footerBtn(p, "next").click();
  await settle(p.window);
  assert.equal(m.querySelector("#obStep4Error").style.display, "block");
  assert.ok(!p.saved.some((x) => Array.isArray(x) && x[0] === "sender"));

  m.querySelector("#obSenderReply").value = "dana@example.com";
  footerBtn(p, "next").click();
  await settle(p.window);
  const sender = p.saved.find((x) => Array.isArray(x) && x[0] === "sender");
  assert.ok(sender, JSON.stringify(p.saved));
  assert.equal(sender[1].displayName, "Dana Reed");
  assert.equal(sender[1].replyToEmail, "dana@example.com");
  assert.equal(sender[1].isEnabled, false,
    "nothing may be able to send until the agent sets up delivery and turns it on");
});

domTest("the last step marks the guide done", OB_SCRIPTS, async () => {
  const p = await wizard({ onboardingStep: 5 });
  p.O.open(5);
  await settle(p.window);
  assert.match(modal(p).textContent, /3 of 3/);
  footerBtn(p, "next").click();
  await settle(p.window);
  assert.ok(p.saved.some((x) => x && x.onboardingDone === true));
  assert.equal(p.O.isDone(), true, "and it does not come back");
});

// ---------------------------------------------------------------- nudge + list

domTest("the time zone nudge appears only on UTC, and either answer settles it", OB_SCRIPTS, async () => {
  const p = await wizard({ timezone: "UTC" });
  p.window.App.pages.onboarding.browserZone = () => "Asia/Dubai";
  // The module reads its own browserZone, so stub Intl instead.
  p.window.Intl = { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: "Asia/Dubai" }) }) };

  let html = p.O.timezoneNudgeHtml();
  assert.match(html, /Your time zone is UTC. Use Asia\/Dubai\?/);

  // Already answered, or already not UTC: no nudge either way.
  Object.assign(p.settings, { timezoneConfirmed: true });
  assert.equal(p.O.timezoneNudgeHtml(), "", "asked once, never again");
  Object.assign(p.settings, { timezoneConfirmed: false, timezone: "Europe/London" });
  assert.equal(p.O.timezoneNudgeHtml(), "", "and never when a real zone is already set");

  // "Keep UTC" still records that we asked.
  Object.assign(p.settings, { timezone: "UTC", timezoneConfirmed: false });
  const host = p.document.createElement("div");
  host.innerHTML = p.O.timezoneNudgeHtml();
  p.document.body.appendChild(host);
  p.O.wireTimezoneNudge(host, () => {});
  host.querySelector("#tzNudgeKeep").click();
  await settle(p.window);
  const kept = p.saved.find((x) => x && x.timezoneConfirmed === true);
  assert.ok(kept, JSON.stringify(p.saved));
  assert.ok(!("timezone" in kept), "Keep UTC changes no zone, it just stops the asking");
});

domTest("the checklist reflects real data and hides when dismissed", OB_SCRIPTS, async () => {
  const p = await wizard({});
  const state = {
    settings: { agentName: "", timezoneConfirmed: false },
    contacts: [], activities: [], onboardingRules: [],
  };
  let items = p.O.checklist(state);
  assert.equal(items.length, 5);
  assert.deepEqual(plain(items.map((i) => i.done)), [false, false, false, false, false]);

  const full = {
    settings: { agentName: "Dana", timezoneConfirmed: true },
    contacts: [{ id: "c1" }],
    activities: [{ id: "a1" }],
    onboardingRules: [{ id: "r1", status: "active" }],
  };
  items = p.O.checklist(full);
  assert.deepEqual(plain(items.map((i) => i.done)), [true, true, true, true, true]);
  assert.equal(p.O.checklistHtml(full), "", "all done means the card goes away");

  // A draft-only rule counts for "added" but not for "reviewed".
  const drafted = Object.assign({}, full, { onboardingRules: [{ id: "r1", status: "draft" }] });
  const byId = {};
  p.O.checklist(drafted).forEach((i) => { byId[i.id] = i.done; });
  assert.equal(byId.pack, true);
  assert.equal(byId.review, false, "a sequence nobody has touched has not been reviewed");

  assert.equal(p.O.checklistHtml(Object.assign({}, state,
    { settings: { gettingStartedDismissed: true } })), "", "and dismissing hides it");
});

domTest("solo essentials skip optional setup and preserve all module preferences", OB_SCRIPTS, async () => {
  for (const enabledModules of [{}, { prompts: true, scheduler: true }, { prompts: false, scheduler: false }]) {
    const p = await wizard({ customization: { teamMode: false, enabledModules } });
    const before = JSON.stringify(p.settings.customization);
    p.O.open(1);
    footerBtn(p, "skip").click(); await settle(p.window);
    assert.match(modal(p).textContent, /Bring in your contacts/);
    assert.ok(footerBtn(p, "optional"));
    footerBtn(p, "next").click(); await settle(p.window);
    assert.match(modal(p).textContent, /3 of 3/);
    assert.equal(p.settings.onboardingStep, 5, "legacy completion step id retained");
    footerBtn(p, "back").click(); await settle(p.window);
    assert.match(modal(p).textContent, /Bring in your contacts/);
    footerBtn(p, "skip").click(); await settle(p.window);
    footerBtn(p, "next").click(); await settle(p.window);
    assert.equal(p.settings.onboardingDone, true);
    assert.equal(JSON.stringify(p.settings.customization), before);
    assert.equal(p.saved.some(x => Array.isArray(x) && x[0] === "sender"), false);
    assert.equal(p.window.App.store.getState().contacts.length, 0, "no sample contacts added");
    closeAll();
  }
});

domTest("optional setup remains available and team flow retains all five steps", OB_SCRIPTS, async () => {
  const p = await wizard({});
  p.O.open(2);
  footerBtn(p, "optional").click(); await settle(p.window);
  assert.match(modal(p).textContent, /Follow-ups to start from/);
  assert.equal(p.settings.onboardingStep, 3);
  footerBtn(p, "skip").click(); await settle(p.window);
  assert.match(modal(p).textContent, /Who your emails come from/);
  closeAll();
  const team = await wizard({ customization: { teamMode: true } });
  team.O.open(2);
  assert.equal(footerBtn(team, "optional"), null);
  footerBtn(team, "skip").click(); await settle(team.window);
  assert.match(modal(team).textContent, /3 of 5/);
});

domTest("invitation and non-editing member entry never starts workspace setup", OB_SCRIPTS, async () => {
  const p = await wizard({});
  p.window.App.workspace = { canEditSettings: () => true };
  p.window.location.hash = "#/join?token=a%252Fb";
  assert.equal(p.O.maybeOpen(), false);
  assert.equal(p.window.location.hash, "#/join?token=a%252Fb");
  p.window.location.hash = "#/daily";
  p.window.App.workspace.canEditSettings = () => false;
  assert.equal(p.O.maybeOpen(), false);
  assert.equal(modal(p), null);
  assert.deepEqual(p.saved, []);
});

domTest("contact actions reuse Quick Add and file import, saving the resume point", OB_SCRIPTS, async () => {
  for (const action of ["manual", "file"]) {
    const p = await wizard({});
    const calls = [];
    p.window.App.quickAdd = { open: () => calls.push("manual") };
    p.window.App.pages.leadFileImport = { open: () => calls.push("file") };
    p.O.open(2);
    modal(p).querySelector('[data-ob-action="' + action + '"]').click();
    await settle(p.window);
    assert.deepEqual(calls, [action]);
    assert.equal(p.settings.onboardingStep, 2);
    assert.notEqual(p.settings.onboardingDone, true);
    closeAll();
  }
});

domTest("completion failure stays retryable and Today-disabled completion uses Dashboard", OB_SCRIPTS, async () => {
  const p = await wizard({});
  p.O.open(5);
  const update = p.window.App.store.settings.update;
  p.window.App.store.settings.update = async () => { throw new Error("offline"); };
  footerBtn(p, "next").click(); await settle(p.window);
  assert.equal(footerBtn(p, "next").disabled, false);
  assert.notEqual(p.settings.onboardingDone, true);
  p.window.App.store.settings.update = update;
  p.window.App.customization = { isRouteEnabled: route => route !== "/daily" };
  footerBtn(p, "next").click(); await settle(p.window);
  assert.equal(p.settings.onboardingDone, true);
  assert.equal(p.window.location.hash, "#/dashboard");
});
