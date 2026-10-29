// U1a: route behavior must survive changing or removing the visual menu.
import { test } from "node:test";
import assert from "node:assert/strict";
import { browser } from "../helpers/browser.mjs";

const SCRIPTS = ["assets/js/core/utils.js", "assets/js/core/customization.js",
  "assets/js/app.js", "assets/js/pages/team-join.js"];
const CASES = [
  ["/dashboard", "release.renderDashboard", [], "reports", "overview"],
  ["/daily", "release.renderDaily", [], "today", "today"],
  ["/contacts", "contacts.renderList", [], "contacts", "all"],
  ["/past-clients", "contacts.renderPastClients", [], "contacts", "past-clients"],
  ["/properties", "properties.renderList", [], "deals", "properties"],
  ["/buyer", "buyer.render", [], "contacts", "buyers"],
  ["/seller", "seller.render", [], "contacts", "sellers"],
  ["/pipeline", "deals.renderPipeline", [], "deals", "pipeline"],
  ["/commission", "commission.render", [], "deals", "commission"],
  ["/activities", "activities.render", [], "reports", "activity-log"],
  ["/tasks", "tasks.render", [], "calendar", "tasks"],
  ["/team", "teamDashboard.render", [], "team", "overview"],
  ["/scheduler", "scheduler.render", [], "calendar", "scheduled"],
  ["/calendar", "calendar.render", [], "calendar", "agenda"],
  ["/referrals", "referrals.render", [], "reports", "referrals"],
  ["/goals", "goals.render", [], "reports", "goals"],
  ["/finances", "finances.render", [], "reports", "income-expenses"],
  ["/reports", "reports.render", [], "reports", "pipeline"],
  ["/content", "release.renderContent", [], "plans", "templates"],
  ["/email-templates", "emailTemplates.render", [], "plans", "templates"],
  ["/prompts", "release.renderPrompts", [], "plans", "prompts"],
  ["/automation", "automation.render", [], "plans", "plans"],
  ["/automation/activity", "automation.renderActivity", [], "plans", "activity"],
  ["/notifications", "notifications.render", [], null, null],
  ["/settings", "release.renderSettings", [null], "settings", "overview"],
  ["/contacts/ct_%252F", "contacts.renderDetail", ["ct_%252F"], "contacts", "all"],
  ["/properties/p_%2F", "properties.renderDetail", ["p_%2F"], "deals", "properties"],
  ["/pipeline/d_%2520", "deals.renderDealDetail", ["d_%2520"], "deals", "pipeline"],
  ["/settings/team-permissions?member=wm%252F1", "release.renderSettings",
    ["team-permissions?member=wm%252F1"], "settings", ":category"],
  ["/join?token=abc", "teamJoin.render", ["abc"], null, null],
  ["/join?token=a%252Fb", "teamJoin.render", ["a%2Fb"], null, null],
  ["/join", "teamJoin.render", [null], null, null],
];

async function shell(t, { team = true, finance = true, goals = true,
  manage = true, modules = {} } = {}) {
  const config = { teamMode: team, enabledModules: modules, dashboardWidgets: {} };
  const b = await browser(SCRIPTS, { store: {
    getState: () => ({ settings: { customization: config }, metadata: {} }),
    _defaultCustomization: () => config,
  } });
  assert.ok(b, "jsdom is required; route contracts must not skip");
  t.after(() => b.close());
  const { App } = b.window;
  App.cloud = { getUser: () => ({ id: "u-1" }), getClient: () => ({}) };
  App.workspace = { can: k => k === "team_manage" && manage,
    canView: a => a === "finance" ? finance : a === "goals" ? goals : true };
  const calls = [];
  for (const name of new Set(CASES.map(c => c[1]))) {
    const [page, method] = name.split(".");
    App.pages[page] ||= {};
    App.pages[page][method] = async (container, ...args) => {
      assert.equal(container, b.document.getElementById("page"));
      calls.push([name, args]);
    };
  }
  App.app.renderShell();
  b.window.scrollTo = () => {};
  return { ...b, App, calls, config, async visit(path) {
    calls.length = 0;
    b.window.history.replaceState(null, "", path ? "#" + path : b.window.location.pathname);
    await App.app.route();
  } };
}

for (const [path, handler, args, hub, tab] of CASES) {
  test(`route contract: ${path}`, async t => {
    const b = await shell(t);
    b.App.app.NAV.splice(0); // The route registry must work with no menu at all.
    await b.visit(path);
    assert.deepEqual(b.calls, [[handler, args]]);
    const { entry } = b.App.app.resolveRoute(path);
    assert.equal(entry.handler, handler);
    assert.equal(entry.hub, hub);
    assert.equal(entry.tab, tab);
    assert.ok(Object.hasOwn(entry, "moduleId"));
    assert.ok(Object.hasOwn(entry, "permission"));
  });
}

test("empty hash and root use Today while legacy Scripts retains its destination", async t => {
  const b = await shell(t);
  b.App.app.NAV.splice(0);
  await b.visit("");
  assert.deepEqual(b.calls, [["release.renderDaily", []]]);
  for (const [path, target, handler] of [["/", "/daily", "release.renderDaily"],
    ["/scripts", "/email-templates", "emailTemplates.render"]]) {
    await b.visit(path);
    assert.equal(b.window.location.hash, "#" + target);
    assert.deepEqual(b.calls, []);
    await b.App.app.route();
    assert.deepEqual(b.calls, [[handler, []]]);
  }
});

test("unknown routes and unsupported list queries still render Coming Soon", async t => {
  const b = await shell(t);
  for (const path of ["/not-a-page", "/contacts?type=Buyer", "/contacts/a/b", "/join/abc"]) {
    await b.visit(path);
    assert.deepEqual(b.calls, []);
    assert.equal(b.window.location.hash, "#" + path);
    assert.match(b.document.getElementById("page").textContent, /page not found/i);
  }
});

const OPTIONAL = { daily: "/daily", buyer: "/buyer", seller: "/seller",
  referrals: "/referrals", activities: "/activities", tasks: "/tasks",
  calendar: "/calendar", finances: "/finances", goals: "/goals", reports: "/reports",
  content: "/content", scripts: "/email-templates", prompts: "/prompts",
  automation: "/automation", scheduler: "/scheduler" };
for (const [moduleId, path] of Object.entries(OPTIONAL)) {
  test(`disabled ${moduleId} redirects even without its menu item`, async t => {
    const b = await shell(t, { modules: { [moduleId]: false } });
    b.App.app.NAV.splice(0);
    await b.visit(path);
    assert.equal(b.window.location.hash, "#/dashboard");
    assert.deepEqual(b.calls, []);
    await b.App.app.route();
    assert.deepEqual(b.calls, [["release.renderDashboard", []]]);
    await b.App.app.navigate(path);
    assert.equal(b.window.location.hash, "#/dashboard");
  });
}

test("unknown nested paths retain base module guards; Scripts alias reaches its guarded target", async t => {
  const b = await shell(t, { modules: { tasks: false, scripts: false } });
  for (const path of ["/tasks/unknown", "/scripts"]) {
    await b.visit(path);
    assert.equal(b.window.location.hash, "#/dashboard");
  }
  await b.visit("/scripts/unknown");
  assert.equal(b.window.location.hash, "#/scripts/unknown");
  assert.match(b.document.getElementById("page").textContent, /page not found/i);
});

test("locked modules and Settings are not disabled by stored false values", async t => {
  const b = await shell(t, { modules: Object.fromEntries(
    ["dashboard", "contacts", "properties", "pipeline", "commission", "settings"].map(id => [id, false])) });
  for (const path of ["/dashboard", "/contacts", "/properties", "/pipeline", "/commission", "/settings", "/settings/modules"]) {
    await b.visit(path);
    assert.equal(b.calls.length, 1, path);
    assert.equal(b.window.location.hash, "#" + path);
  }
});

for (const [name, options, denied] of [
  ["finance", { finance: false }, ["/finances", "/commission", "/referrals"]],
  ["goals", { goals: false }, ["/goals"]],
  ["solo", { team: false }, ["/team"]],
  ["team member without management", { manage: false }, ["/team"]],
]) {
  test(`permission guard: ${name}`, async t => {
    const b = await shell(t, options);
    b.App.app.NAV.splice(0);
    for (const path of denied) {
      await b.visit(path);
      assert.deepEqual(b.calls, []);
      assert.equal(b.window.location.hash, "#/dashboard");
      await b.App.app.navigate(path);
      assert.equal(b.window.location.hash, "#/dashboard");
    }
    await b.visit("/settings");
    assert.deepEqual(b.calls, [["release.renderSettings", [null]]]);
  });
}

test("unknown nested finance path has no new permission gate", async t => {
  const b = await shell(t, { finance: false });
  await b.visit("/finances/unknown");
  assert.equal(b.window.location.hash, "#/finances/unknown");
  assert.match(b.document.getElementById("page").textContent, /page not found/i);
});

// The four "unchanged menu snapshot" tests that were here are gone,
// and deliberately. They hashed #sidebarNav.innerHTML against HEAD
// 23ce58b to prove U1a changed the ROUTE registry WITHOUT changing the
// menu - which was exactly the right guard for that stage, and is a
// guard U1b exists to break: the two-rail sidebar is now a one-level
// list of hubs.
//
// What they were really protecting - that each persona sees the right
// destinations and no others - is now in
// tests/frontend/sidebar-hubs.test.mjs, per persona and by name rather
// than by hash, which says what it means when it fails. Everything in
// THIS file is still about ROUTES: paths, handlers, params, hub/tab
// metadata and the permission guards, none of which U1b touches.

test("scheduler false hides its tab; absent preference stays enabled without writes", async t => {
  // Scheduler is a tab under Calendar since U1b, so the module switch
  // is read where the tab is built rather than where a menu item was.
  // The rest of the contract is unchanged: absent means enabled, and
  // reading the preference writes nothing.
  const b = await shell(t, { modules: { scheduler: false } });
  const tabs = () => b.App.app.hubTabs("calendar").map(x => x.path);
  assert.ok(!tabs().includes("/scheduler"), "switched off: " + JSON.stringify(tabs()));

  delete b.config.enabledModules.scheduler;
  assert.ok(tabs().includes("/scheduler"), "absent means enabled");

  await b.visit("/scheduler");
  assert.deepEqual(b.calls, [["scheduler.render", []]]);
  assert.deepEqual(b.config.enabledModules, {}, "and nothing was written to find out");
});

test("module settings catalog survives menu removal; detail highlight remains unchanged", async t => {
  const b = await shell(t);
  const catalog = JSON.parse(JSON.stringify(b.App.app.moduleCatalog()));
  assert.deepEqual(catalog, JSON.parse(JSON.stringify(b.App.app.NAV.flatMap(g =>
    g.items.map(it => ({ id: it.id, label: it.label, icon: it.icon, group: g.group }))))));
  await b.visit("/contacts/ct_123");
  assert.ok(b.document.querySelector('[data-nav="/contacts"]').classList.contains("active"));
  b.App.app.NAV.splice(0);
  assert.deepEqual(JSON.parse(JSON.stringify(b.App.app.moduleCatalog())), catalog);
});

test("Today disabled uses Dashboard for root and empty entry", async t => {
  const b = await shell(t, { modules: { daily: false } });
  await b.visit("");
  assert.deepEqual(b.calls, [["release.renderDashboard", []]]);
  await b.visit("/");
  assert.equal(b.window.location.hash, "#/dashboard");
  await b.App.app.route();
  assert.deepEqual(b.calls, [["release.renderDashboard", []]]);
});

test("signed-in boot reads settings before choosing home and preserves explicit links", async t => {
  for (const [path, enabled, handler, args] of [
    ["", true, "release.renderDaily", []],
    ["", false, "release.renderDashboard", []],
    ["/dashboard", true, "release.renderDashboard", []],
    ["/contacts/ct_%252F", true, "contacts.renderDetail", ["ct_%252F"]],
    ["/join?token=a%252Fb", true, "teamJoin.render", ["a%2Fb"]],
    ["/settings/team-permissions?member=wm%252F1", true, "release.renderSettings", ["team-permissions?member=wm%252F1"]],
  ]) {
    const b = await shell(t);
    b.window.history.replaceState(null, "", path ? "#" + path : b.window.location.pathname);
    b.App.cloud.checkSession = async () => ({ id: "u-1" });
    b.App.workspace.load = async () => {};
    b.App.data = {
      onSyncStateChange() {}, onEntityChanged() {}, subscribeRealtime() {},
      migrateLegacyIfNeeded: async () => ({ ok: true }),
    };
    let loaded = false;
    b.App.store.ensureLoaded = async keys => {
      assert.deepEqual(Array.from(keys), ["settings"]);
      b.config.enabledModules.daily = enabled;
      loaded = true;
    };
    await b.App.app.init();
    assert.ok(loaded);
    assert.deepEqual(b.calls, [[handler, args]], path || "normal entry");
    if (path) assert.equal(b.window.location.hash, "#" + path);
  }
});
