// U1b: the one-level sidebar, and the tab bar under each hub.
//
// Two levels of menu became one level plus a tab bar. The promise that
// has to survive that is not visual: it is that nobody gained a page
// they were not allowed to see, nobody lost one they were, and
// everything is still at most two clicks away.
//
// So the personas are tested by NAME rather than by a snapshot hash -
// a hash tells you the menu changed, which you already knew; a name
// tells you who lost what.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { browser, settle, SKIP_DOM } from "../helpers/browser.mjs";

const SCRIPTS = [
  "assets/js/core/utils.js",
  "assets/js/core/customization.js",
  "assets/js/app.js",
];

const open = [];
function closeAll() {
  while (open.length) {
    const b = open.pop();
    try { b.close(); } catch (e) { /* already gone */ }
  }
}

/**
 * The shell, rendered, for one persona.
 *
 * team/manage/finance/goals are the four things the gates actually ask
 * about; `modules` switches a module off the way Settings does.
 */
async function shell({ team = false, manage = false, finance = true,
  goals = true, modules = {} } = {}) {
  const config = { teamMode: team, enabledModules: modules, dashboardWidgets: {} };
  const b = await browser(SCRIPTS, {
    store: {
      getState: () => ({ settings: { customization: config }, metadata: {} }),
      _defaultCustomization: () => config,
      ensureLoaded: async () => {},
      settings: {},
    },
  });
  if (!b) return null;
  open.push(b);
  b.window.App.cloud = { getUser: () => ({ id: "u-1" }), getClient: () => ({}) };
  b.window.App.workspace = {
    ready: () => true, id: () => "ws-1", role: () => manage ? "owner" : "agent",
    teamMemberId: () => "tm-1", permissions: () => ({}),
    can: (k) => k === "team_manage" ? manage : true,
    canView: (a) => a === "finance" ? finance : a === "goals" ? goals : true,
    canViewSettings: () => true, scope: () => "all", seesAll: () => true,
    load: async () => {},
  };

  const rendered = [];
  b.window.App.pages = b.window.App.pages || {};
  const stub = (name) => async () => { rendered.push(name); };
  [["release", ["renderDashboard", "renderDaily", "renderSettings", "renderContent", "renderScripts", "renderPrompts"]],
   ["contacts", ["renderList", "renderDetail", "renderPastClients"]], ["buyer", ["render"]], ["seller", ["render"]],
   ["deals", ["renderPipeline", "renderDealDetail"]], ["properties", ["renderList", "renderDetail"]],
   ["commission", ["render"]], ["calendar", ["render"]], ["tasks", ["render"]],
   ["scheduler", ["render"]], ["automation", ["render", "renderActivity"]], ["emailTemplates", ["render"]],
   ["reports", ["render"]], ["finances", ["render"]], ["goals", ["render"]],
   ["referrals", ["render"]], ["activities", ["render"]], ["teamDashboard", ["render"]],
   ["notifications", ["render"]],
  ].forEach(([page, methods]) => {
    b.window.App.pages[page] = b.window.App.pages[page] || {};
    methods.forEach((m) => { b.window.App.pages[page][m] = stub(page + "." + m); });
  });

  b.window.App.app.renderShell();
  b.window.scrollTo = () => {};
  await settle(b.window);

  return Object.assign({}, b, {
    rendered,
    hubLabels: () => Array.from(b.document.querySelectorAll("#sidebarNav .nav-item"))
      .map((el) => el.textContent.replace(/\s+/g, " ").trim()),
    hubTargets: () => Array.from(b.document.querySelectorAll("#sidebarNav .nav-item"))
      .map((el) => el.getAttribute("data-nav")),
    activeHub: () => {
      const el = b.document.querySelector("#sidebarNav .nav-item.active");
      return el ? el.getAttribute("data-hub") : null;
    },
    tabLabels: () => Array.from(b.document.querySelectorAll("#hubTabs > nav:first-child .hub-tab"))
      .map((el) => el.textContent.trim()),
    tabPaths: () => Array.from(b.document.querySelectorAll("#hubTabs > nav:first-child .hub-tab"))
      .map((el) => el.getAttribute("data-hub-tab")),
    tabBarShown: () => !b.document.getElementById("hubTabs").hidden,
    async visit(path) {
      rendered.length = 0;
      b.window.history.replaceState(null, "", "#" + path);
      await b.window.App.app.route();
      await settle(b.window);
    },
  });
}

function domTest(name, fn) {
  test(name, async (t) => {
    const probe = await browser(SCRIPTS, {
      store: { getState: () => ({ settings: {} }), _defaultCustomization: () => ({}) },
    });
    if (!probe) return t.skip(SKIP_DOM);
    try { probe.close(); } catch (e) {}
    try { await fn(); } finally { closeAll(); }
  });
}

const SOLO = ["Today", "Contacts", "Deals", "Calendar", "Follow-up Plans", "Reports"];

// ---------------------------------------------------------------- personas

domTest("a solo owner sees the six hubs, in order, and no Team", async () => {
  const p = await shell({ team: false, manage: true });
  assert.deepEqual(p.hubLabels(), SOLO,
    "one level, in the order the work happens in");
  assert.deepEqual(p.hubTargets(),
    ["/daily", "/contacts", "/pipeline", "/calendar", "/automation", "/dashboard"],
    "each going to its first visible tab");
  assert.ok(p.document.getElementById("sidebarSettingsBtn"), "and Settings, pinned below");
});

domTest("a team owner with team_manage gets Team as well", async () => {
  const p = await shell({ team: true, manage: true });
  assert.deepEqual(p.hubLabels(), SOLO.concat(["Team"]));
  assert.ok(p.hubTargets().includes("/team"));
});

domTest("an agent in team mode without team_manage does not get Team", async () => {
  const p = await shell({ team: true, manage: false });
  assert.deepEqual(p.hubLabels(), SOLO, "the rule is unchanged: team mode AND the permission");
  assert.ok(!p.hubTargets().includes("/team"));
  assert.ok(p.document.getElementById("sidebarSettingsBtn"), "Settings is still there");
});

domTest("an agent without finance keeps every hub but loses the finance tabs", async () => {
  const p = await shell({ team: true, manage: false, finance: false });
  // Reports still has Overview, Performance, Goals and the activity log,
  // so the hub stays - it is the tabs inside it that go.
  assert.deepEqual(p.hubLabels(), SOLO);

  await p.visit("/dashboard");
  assert.deepEqual(p.tabLabels(), ["Overview", "Performance", "Goals", "Activity log"],
    "no Income & expenses, no Referrals");

  await p.visit("/pipeline");
  assert.deepEqual(p.tabLabels(), ["Pipeline", "Properties"], "and no Commission");

  // The guard itself is untouched: the URL still refuses. (route()
  // bounces by calling navigate(), which sets the hash; the hashchange
  // that would re-render is init()'s, not renderShell()'s, so the hash
  // is what there is to assert on here.)
  await p.visit("/finances");
  assert.equal(p.window.location.hash, "#/dashboard", "typing the URL still bounces");
  assert.deepEqual(p.rendered, [], "and nothing was rendered on the way");
});

domTest("an agent without goals loses only the Goals tab", async () => {
  const p = await shell({ team: true, manage: false, goals: false });
  assert.deepEqual(p.hubLabels(), SOLO);
  await p.visit("/dashboard");
  assert.deepEqual(p.tabLabels(),
    ["Overview", "Performance", "Income & expenses", "Referrals", "Activity log"]);
  await p.visit("/goals");
  assert.equal(p.window.location.hash, "#/dashboard");
});

domTest("Settings is in the sidebar for every persona, gated by nothing", async () => {
  for (const persona of [
    { team: false, manage: true },
    { team: true, manage: false, finance: false, goals: false },
    { team: true, manage: true },
  ]) {
    const p = await shell(persona);
    assert.ok(p.document.getElementById("sidebarSettingsBtn"),
      "Settings: " + JSON.stringify(persona));
  }
});

// ---------------------------------------------------------------- reach

domTest("every page in the old menu remains reachable through hubs and template sections", async () => {
  const p = await shell({ team: true, manage: true });
  // Sidebar target -> the tabs that sidebar click reveals.
  const reachable = new Set();
  p.hubTargets().forEach((first) => reachable.add(first));
  p.window.App.app.HUBS.forEach((hub) => {
    p.window.App.app.hubTabs(hub.id).forEach((tab) => reachable.add(tab.path));
  });
  p.window.App.app.templateSections().forEach(tab => reachable.add(tab.path));
  reachable.add("/settings");   // the pinned gear, one click

  const OLD_MENU = [
    "/dashboard", "/daily", "/contacts", "/buyer", "/seller", "/referrals",
    "/properties", "/pipeline", "/commission", "/automation", "/email-templates",
    "/scheduler", "/content", "/prompts", "/activities", "/tasks", "/calendar",
    "/finances", "/goals", "/reports", "/settings", "/team",
  ];
  const lost = OLD_MENU.filter((path) => !reachable.has(path));
  assert.deepEqual(lost, [], "pages with no way in: " + JSON.stringify(lost));
});

domTest("a hub whose every tab is switched off disappears", async () => {
  // Calendar is Agenda + Tasks + Scheduled. Switch all three off.
  const p = await shell({
    modules: { calendar: false, tasks: false, scheduler: false },
  });
  assert.ok(!p.hubLabels().includes("Calendar"),
    "a hub leading nowhere is not shown: " + JSON.stringify(p.hubLabels()));

  // One left is enough to keep it, and the hub then points at that one.
  const q = await shell({ modules: { calendar: false, scheduler: false } });
  assert.ok(q.hubLabels().includes("Calendar"));
  assert.equal(q.hubTargets()[q.hubLabels().indexOf("Calendar")], "/tasks",
    "the hub links to its first VISIBLE tab, not its first tab");
});

domTest("a switched-off module loses its tab and nothing else", async () => {
  const p = await shell({ modules: { prompts: false } });
  await p.visit("/automation");
  assert.deepEqual(p.tabLabels(), ["Plans", "Templates", "Activity"], "template sections live inside Templates");
  assert.ok(p.hubLabels().includes("Follow-up Plans"), "the hub stays");
});

// ---------------------------------------------------------------- the bar

domTest("the tab bar is on list pages and absent on detail pages", async () => {
  const p = await shell({ team: true, manage: true });

  await p.visit("/contacts");
  assert.ok(p.tabBarShown(), "a list page has one");
  assert.deepEqual(p.tabLabels(), ["All", "Buyers", "Sellers", "Past Clients"]);
  assert.deepEqual(p.tabPaths(), ["/contacts", "/buyer", "/seller", "/past-clients"]);

  await p.visit("/contacts/ct_123");
  assert.equal(p.tabBarShown(), false,
    "a contact's own page is one record, not one of several views of a list");
  assert.equal(p.activeHub(), "contacts", "but the hub is still lit");

  await p.visit("/pipeline/dl_1");
  assert.equal(p.tabBarShown(), false);
  assert.equal(p.activeHub(), "deals");

  // Today and Team have one page each, so a bar would be a row of one.
  await p.visit("/daily");
  assert.equal(p.tabBarShown(), false);
  await p.visit("/team");
  assert.equal(p.tabBarShown(), false);
  // Settings has its own in-page navigation.
  await p.visit("/settings");
  assert.equal(p.tabBarShown(), false);
});

domTest("the current tab is the one marked, for people and for screen readers", async () => {
  const p = await shell({ team: true, manage: true });
  await p.visit("/properties");

  const current = Array.from(p.document.querySelectorAll('#hubTabs [aria-current="page"]'));
  assert.equal(current.length, 1, "exactly one");
  assert.equal(current[0].getAttribute("data-hub-tab"), "/properties");
  assert.ok(current[0].classList.contains("active"), "and it looks it too");

  // Tabs are links, so they can be opened in a new tab and read as links.
  p.document.querySelectorAll("#hubTabs > nav:first-child .hub-tab").forEach((el) => {
    assert.equal(el.tagName, "A");
    assert.match(el.getAttribute("href"), /^#\//);
  });

  // The hub, meanwhile, is marked in the sidebar.
  assert.equal(p.activeHub(), "deals");
  const hubEl = p.document.querySelector("#sidebarNav .nav-item.active");
  assert.equal(hubEl.getAttribute("aria-current"), "page");
});

domTest("clicking a tab goes there, and the narrow-width select does too", async () => {
  const p = await shell({ team: true, manage: true });
  await p.visit("/calendar");

  p.document.querySelector('#hubTabs [data-hub-tab="/tasks"]').click();
  await settle(p.window);
  assert.equal(p.window.location.hash, "#/tasks");

  // Below 640px the same tabs are a select. Both are rendered; CSS
  // picks. Changing it navigates the same way.
  await p.visit("/calendar");
  const select = p.document.getElementById("hubTabSelect");
  assert.ok(select, "the compact control is in the DOM at every width");
  assert.deepEqual(Array.from(select.options).map((o) => o.value),
    p.tabPaths(), "offering exactly the tabs the row does");
  assert.equal(select.value, "/calendar", "showing where you are");
  select.value = "/scheduler";
  select.dispatchEvent(new p.window.Event("change", { bubbles: true }));
  await settle(p.window);
  assert.equal(p.window.location.hash, "#/scheduler");
});

domTest("the first breadcrumb is the hub, and a detail page keeps its own trail", async () => {
  const p = await shell({ team: true, manage: true });
  const trail = () => p.document.getElementById("breadcrumbs").textContent.replace(/\s+/g, " ").trim();

  // A single-crumb trail renders nothing at all - that is existing,
  // deliberate behaviour (the page's own title already says it), so the
  // rename is only visible on a list page that builds a real trail.
  p.window.App.pages.deals.renderPipeline = async () => {
    p.window.App.app.setBreadcrumbs([{ label: "Deals Pipeline" }, { label: "Q4 board" }]);
  };
  await p.visit("/pipeline");
  assert.match(trail(), /Deals/);
  assert.ok(!/Deals Pipeline/.test(trail()),
    "the hub's name, not the page's - the tab bar already says which tab: " + trail());
  assert.match(trail(), /Q4 board/, "and the rest of the page's trail is left alone");

  p.window.App.pages.buyer.render = async () => {
    p.window.App.app.setBreadcrumbs([{ label: "Buyer Workspace" }, { label: "Active" }]);
  };
  await p.visit("/buyer");
  assert.match(trail(), /Contacts/, "a tab is named after its hub, not itself");

  // A detail page sets its own trail while it renders, and keeps it.
  p.window.App.pages.contacts.renderDetail = async () => {
    p.window.App.app.setBreadcrumbs([
      { label: "Contacts", route: "/contacts" }, { label: "Sarah Khan" }]);
  };
  await p.visit("/contacts/ct_1");
  assert.match(trail(), /Contacts/);
  assert.match(trail(), /Sarah Khan/, "untouched: " + trail());
});

domTest("the old two-rail markup is gone", async () => {
  const p = await shell({ team: true, manage: true });
  const nav = p.document.getElementById("sidebarNav");
  assert.equal(nav.querySelectorAll(".rail-btn, .nav-panel, [data-rail-group]").length, 0,
    "no rail, no panels: " + nav.innerHTML.slice(0, 200));
  assert.equal(nav.querySelectorAll('[role="tablist"]').length, 0,
    "and no tablist promising a keyboard contract nothing implements any more");
  // Every item is a link, which is what a destination should be.
  const items = Array.from(nav.querySelectorAll(".nav-item"));
  assert.ok(items.length >= 6);
  items.forEach((el) => {
    assert.equal(el.tagName, "A");
    assert.match(el.getAttribute("href"), /^#\//);
    assert.ok(el.getAttribute("title"), "a title, for the icon-only width");
  });
});


domTest("refreshNav removes newly disabled and denied tabs from both controls", async () => {
  const p = await shell();
  await p.visit("/dashboard");
  p.window.App.store.getState().settings.customization.enabledModules.activities = false;
  p.window.App.workspace.canView = () => false;
  p.window.App.app.refreshNav();
  assert.deepEqual(p.tabPaths(), ["/dashboard", "/reports"]);
  assert.deepEqual(Array.from(p.document.querySelectorAll("#hubTabSelect option"), o => o.value), p.tabPaths());
  assert.equal(p.activeHub(), "reports");
});

domTest("Settings and its category routes mark the pinned destination active", async () => {
  const p = await shell();
  const button = p.document.getElementById("sidebarSettingsBtn");
  for (const path of ["/settings", "/settings/team-permissions?member=wm%252F1"]) {
    await p.visit(path);
    assert.equal(button.getAttribute("aria-current"), "page");
    assert.ok(button.classList.contains("active"));
    assert.equal(p.tabBarShown(), false);
  }
  await p.visit("/daily");
  assert.equal(button.hasAttribute("aria-current"), false);
  assert.equal(button.classList.contains("active"), false);
});

domTest("every visible tab mounts exactly its existing renderer and marks its URL", async () => {
  const p = await shell({ team: true, manage: true });
  for (const hub of p.window.App.app.HUBS) {
    for (const path of hub.tabs) {
      await p.visit(path);
      const entry = p.window.App.app.resolveRoute(path).entry;
      assert.deepEqual(p.rendered, [entry.handler], path);
      assert.equal(p.activeHub(), hub.id, path);
      if (p.tabBarShown()) {
        const template = ["/email-templates", "/content", "/prompts"].includes(path);
        const topPath = template ? "/email-templates" : path;
        assert.equal(p.document.querySelector('#hubTabs [aria-current="page"]').getAttribute("data-hub-tab"), topPath);
        assert.equal(p.document.getElementById("hubTabSelect").value, topPath);
        if (template) assert.equal(p.document.getElementById("templateSectionSelect").value, path);
      }
    }
  }
});

domTest("hub links keep native modified-click behavior and keyboard focus", async () => {
  const p = await shell();
  await p.visit("/contacts");
  for (const selector of ['[data-hub="deals"]', '[data-hub-tab="/buyer"]']) {
    const link = p.document.querySelector(selector);
    link.focus();
    assert.equal(p.document.activeElement, link);
    assert.ok(link.textContent.trim());
    for (const key of ["ctrlKey", "metaKey", "shiftKey", "altKey"]) {
      const event = new p.window.MouseEvent("click", { bubbles: true, cancelable: true, [key]: true });
      link.dispatchEvent(event);
      assert.equal(event.defaultPrevented, false, key);
    }
  }
});


test("sidebar labels remain visible at laptop widths and compact tabs retain their breakpoint", () => {
  const css = readFileSync(new URL("../../app/assets/css/realtoros.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /\.nav-item-label\s*\{[^}]*display:\s*none/);
  assert.doesNotMatch(css, /--sidebar-w:\s*64px/);
  assert.match(css, /@media \(max-width: 640px\)\s*\{\s*\.hub-tabs\s*\{\s*display: none;/);
  assert.match(css, /\.hub-tabs-select\s*\{\s*display: block;/);
  for (const selector of [".nav-item:focus-visible", ".hub-tab:focus-visible", ".sidebar-settings:focus-visible"]) {
    assert.ok(css.includes(selector), selector);
  }
});

domTest("theme switching preserves hub navigation and accessible toggle state", async () => {
  const p = await shell();
  const saved = [];
  const state = p.window.App.store.getState();
  p.window.App.store.getState = () => state;
  p.window.App.store.settings.update = async patch => {
    Object.assign(state.settings, patch);
    saved.push(patch.ui.theme);
  };
  await p.visit("/pipeline");
  const button = p.document.getElementById("themeToggle");
  for (const theme of ["dark", "light"]) {
    button.click();
    await settle(p.window);
    assert.equal(p.document.documentElement.getAttribute("data-theme"), theme);
    assert.equal(button.getAttribute("aria-pressed"), String(theme === "dark"));
    assert.equal(p.activeHub(), "deals");
    assert.deepEqual(p.tabLabels(), ["Pipeline", "Properties", "Commission"]);
  }
  assert.deepEqual(saved, ["dark", "light"]);
});

domTest("Past Clients keeps Contacts active and is selectable on narrow screens", async () => {
  const p = await shell({ modules: { buyer: false, seller: false }, finance: false, goals: false });
  await p.visit("/contacts");
  assert.deepEqual(p.tabLabels(), ["All", "Past Clients"]);
  const select = p.document.getElementById("hubTabSelect");
  select.value = "/past-clients";
  select.dispatchEvent(new p.window.Event("change", { bubbles: true }));
  await settle(p.window);
  assert.equal(p.window.location.hash, "#/past-clients");
  await p.visit("/past-clients");
  assert.equal(p.activeHub(), "contacts");
  assert.deepEqual(p.rendered, ["contacts.renderPastClients"]);
  assert.equal(p.document.querySelector('#hubTabs [aria-current="page"]').getAttribute("href"), "#/past-clients");
  assert.equal(p.document.getElementById("hubTabSelect").value, "/past-clients");
});

domTest("Templates keeps legacy renderers and chooses the first accessible section", async () => {
  for (const modules of [{}, { scripts: false }, { scripts: false, content: false }]) {
    const p = await shell({ modules });
    const sections = p.window.App.app.templateSections();
    const paths = Array.from(sections, s => s.path);
    for (const path of paths) {
      await p.visit(path);
      assert.deepEqual(p.tabLabels(), ["Plans", "Templates", "Activity"]);
      assert.equal(p.tabPaths()[1], paths[0]);
      assert.equal(p.activeHub(), "plans");
      const sectionNav = p.document.querySelector('nav[aria-label="Template sections"]');
      assert.deepEqual(Array.from(sectionNav.querySelectorAll("a"), a => a.getAttribute("data-hub-tab")), paths);
      assert.equal(sectionNav.querySelector('[aria-current="page"]').getAttribute("data-hub-tab"), path);
      const select = p.document.getElementById("templateSectionSelect");
      assert.equal(select.value, path);
      select.value = paths[0];
      select.dispatchEvent(new p.window.Event("change", { bubbles: true }));
      await settle(p.window);
      assert.equal(p.window.location.hash, "#" + paths[0]);
    }
  }
  const p = await shell({ modules: { scripts: false, content: false, prompts: false } });
  await p.visit("/automation");
  assert.deepEqual(p.tabLabels(), ["Plans", "Activity"]);
  const q = await shell({ modules: { automation: false, scripts: false, content: false } });
  await q.visit("/prompts");
  assert.deepEqual(q.tabLabels(), ["Templates"]);
  assert.equal(q.hubTargets()[q.hubLabels().indexOf("Follow-up Plans")], "/prompts");
  await q.visit("/automation/activity");
  assert.equal(q.window.location.hash, "#/dashboard");
});

domTest("Reports preserves its six sections, active URLs and breadcrumbs", async () => {
  const p = await shell();
  const paths = ["/dashboard", "/reports", "/finances", "/goals", "/referrals", "/activities"];
  const labels = ["Overview", "Performance", "Income & expenses", "Goals", "Referrals", "Activity log"];
  for (const path of paths) {
    const entry = p.window.App.app.resolveRoute(path).entry;
    const [page, method] = entry.handler.split(".");
    p.window.App.pages[page][method] = async () => {
      p.window.App.app.setBreadcrumbs([{ label: "Original page" }, { label: labels[paths.indexOf(path)] }]);
    };
    await p.visit(path);
    assert.deepEqual(p.tabPaths(), paths);
    assert.deepEqual(p.tabLabels(), labels);
    assert.equal(p.activeHub(), "reports");
    assert.equal(p.document.getElementById("hubTabSelect").value, path);
    assert.equal(p.document.querySelector('#hubTabs [aria-current="page"]').getAttribute("href"), "#" + path);
    const trail = p.document.getElementById("breadcrumbs").textContent;
    assert.match(trail, /Reports/);
    assert.ok(trail.includes(labels[paths.indexOf(path)]));
    assert.ok(!trail.includes("Original page"));
  }
  const q = await shell({ modules: { reports: false, finances: false, goals: false, referrals: false, activities: false } });
  await q.visit("/dashboard");
  assert.deepEqual(Array.from(q.window.App.app.hubTabs("reports"), tab => tab.path), ["/dashboard"]);
  assert.ok(q.hubLabels().includes("Reports"), "Overview remains reachable");
});

domTest("mobile drawer focuses a destination and returns focus on Escape", async () => {
  const p = await shell();
  const trigger = p.document.getElementById("mobileMenuToggle");
  trigger.focus();
  trigger.click();
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  assert.ok(p.document.getElementById("sidebar").contains(p.document.activeElement));
  p.document.dispatchEvent(new p.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(p.document.activeElement, trigger);
  assert.equal(p.document.getElementById("sidebar").classList.contains("open"), false);
});
