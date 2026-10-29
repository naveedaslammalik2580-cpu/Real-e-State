// Settings has to be reachable. From anywhere, by anybody, always.
//
// It stopped being so in commit 24e9417 ("T2d: the frontend becomes
// workspace-aware"), which gave the nav item a needsSettings gate.
// canViewSettings() reads permissions().settings and answers false for
// anything that is not "view" or "edit" - including a permissions bag
// that simply has no settings key - so the item vanished from the
// sidebar AND /settings stopped routing, because routeAllowed() asks
// the same question. Nothing inside the Settings screen was gated by
// that permission, so the gate hid everything (the theme included) and
// protected nothing a row policy does not already protect.
//
// Three ways in, tested three ways, with the awkward permissions bag
// each time - because the bug only showed up for the people whose
// permissions came back in an unexpected shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { browser, settle, SKIP_DOM } from "../helpers/browser.mjs";

const SCRIPTS = [
  "assets/js/core/utils.js",
  "assets/js/core/customization.js",
  "assets/js/core/quick-add.js",
  "assets/js/app.js",
  "assets/js/core/mobile-nav.js",
];

const open = [];
function closeAll() {
  while (open.length) {
    const b = open.pop();
    try { b.close(); } catch (e) { /* already gone */ }
  }
}

const defaultCustomization = () => ({ teamMode: false, enabledModules: {}, dashboardWidgets: {} });

/**
 * The app shell, rendered, with a workspace whose permissions are
 * whatever the test says. `permissions: {}` is the shape that broke it.
 */
async function shell(permissions = {}) {
  const b = await browser(SCRIPTS, {
    store: {
      ensureLoaded: async () => {},
      getState: () => ({ settings: { customization: defaultCustomization() }, metadata: {} }),
      _defaultCustomization: defaultCustomization,
      settings: {},
    },
  });
  if (!b) return null;
  open.push(b);

  b.window.App.cloud = { getUser: () => ({ id: "u-1" }), getClient: () => ({}) };
  b.window.App.workspace = {
    ready: () => true,
    id: () => "ws-1",
    role: () => "agent",
    teamMemberId: () => "tm-1",
    permissions: () => permissions,
    can: (k) => permissions[k] === true,
    canView: () => true,
    canViewSettings: () => permissions.settings === "view" || permissions.settings === "edit",
    canEditSettings: () => permissions.settings === "edit",
    scope: () => "all",
    seesAll: () => true,
    load: async () => {},
  };

  // Where a click actually lands. Overriding App.app.navigate would
  // prove nothing - the shell's own handlers call the module's internal
  // binding, not the export - so the Settings page itself is stubbed
  // and the route is read off the hash. That exercises the real path:
  // button -> navigate -> route guard -> renderer.
  const navigated = [];
  b.window.App.pages = b.window.App.pages || {};
  b.window.App.pages.release = {
    renderSettings: async () => { navigated.push("/settings"); },
    renderDashboard: async () => { navigated.push("/dashboard"); },
    renderDaily: async () => {}, renderContent: async () => {},
    renderScripts: async () => {}, renderPrompts: async () => {},
  };
  b.window.App.app.renderShell();
  if (b.window.App.mobileNav) b.window.App.mobileNav.init(b.document, b.window);
  await settle(b.window);
  navigated.length = 0;   // ignore whatever the first render did
  return Object.assign({}, b, {
    navigated, permissions,
    hash: () => String(b.window.location.hash || ""),
    route: async () => { await b.window.App.app.route(); await settle(b.window); },
  });
}

function domTest(name, fn) {
  test(name, async (t) => {
    const probe = await browser(SCRIPTS, {
      store: { getState: () => ({ settings: {} }), _defaultCustomization: defaultCustomization },
    });
    if (!probe) return t.skip(SKIP_DOM);
    try { probe.close(); } catch (e) {}
    try { await fn(); } finally { closeAll(); }
  });
}

// ---------------------------------------------------------------- the rail

domTest("the left rail carries a Settings gear, whatever the permissions say", async () => {
  // The exact bag that hid it: no settings key at all.
  const p = await shell({});
  const gear = p.document.getElementById("sidebarSettingsBtn");
  assert.ok(gear, "it is there");
  assert.match(gear.textContent, /Settings/);
  assert.equal(gear.getAttribute("aria-label"), "Settings");
  assert.ok(gear.querySelector("svg"), "with the gear icon");
  assert.ok(gear.closest(".sidebar-footer"), "at the bottom of the rail");

  gear.click();
  await settle(p.window);
  assert.equal(p.hash(), "#/settings", "the rail gear goes to Settings");
  // The hashchange listener belongs to init(), not renderShell(), so
  // the route is driven here. This is the half that used to bounce to
  // the dashboard: routeAllowed() asked the same gated question.
  await p.route();
  assert.deepEqual(p.navigated, ["/settings"], "and the Settings screen is what renders");
});

domTest("the Settings route is no longer gated away", async () => {
  const p = await shell({});
  // U1b: the sidebar list is hubs, and Settings is not one of them -
  // it is the pinned gear below them. What still has to be true is
  // that nothing gates the route, which is the half that made the gear
  // a dead button while the gate was there.
  assert.equal(p.window.App.app.NAV
    .flatMap((g) => g.items)
    .find((it) => it.route === "/settings").needsSettings, undefined,
    "no needsSettings flag left on it");
  assert.equal(p.window.App.app.ROUTES
    .find((r) => r.path === "/settings").permission, null,
    "and no permission gate on the route either");

  // The hub list is destinations; Settings is deliberately outside it.
  const hubs = Array.from(p.document.querySelectorAll("#sidebarNav [data-nav]"))
    .map((a) => a.getAttribute("data-nav"));
  assert.ok(!hubs.includes("/settings"),
    "not duplicated into the hub list: " + JSON.stringify(hubs));
});

domTest("a member with full settings permission sees it too, once", async () => {
  const p = await shell({ settings: "edit" });
  assert.ok(p.document.getElementById("sidebarSettingsBtn"));
  // Exactly one way in from the sidebar, whatever the permission: the
  // gear. Two entries for one destination is how a menu starts lying
  // about where you are.
  const everywhere = Array.from(p.document.querySelectorAll('#sidebar [data-nav="/settings"]'));
  assert.equal(everywhere.length, 1, "one sidebar entry, not two");
});

// ---------------------------------------------------------------- mobile

domTest("the mobile More tab opens the drawer the gear lives in", async () => {
  const p = await shell({});
  const more = p.document.querySelector('[data-tab-action="menu"]');
  assert.ok(more, "the More tab is on the bottom bar");

  const sidebar = p.document.getElementById("sidebar");
  assert.ok(!sidebar.classList.contains("open"), "closed to begin with");

  more.click();
  await settle(p.window);
  assert.ok(sidebar.classList.contains("open"), "More opens the drawer");

  // And Settings is in it - the same one button, reachable at both widths.
  const gear = sidebar.querySelector("#sidebarSettingsBtn");
  assert.ok(gear, "the gear is inside the drawer");
  gear.click();
  await settle(p.window);
  assert.equal(p.hash(), "#/settings");
  await p.route();
  assert.deepEqual(p.navigated, ["/settings"]);
  assert.ok(!sidebar.classList.contains("open"), "and the drawer closes behind it");
});

// ---------------------------------------------------------------- avatar

domTest("the avatar menu has a Settings item", async () => {
  const p = await shell({});
  const item = p.document.getElementById("profileSettingsBtn");
  assert.ok(item, "it is in the menu");
  assert.equal(item.textContent.trim(), "Settings");
  assert.equal(item.getAttribute("role"), "menuitem");

  // Above Business profile, which is one screen inside Settings: the
  // general door before the particular one.
  const items = Array.from(p.document.querySelectorAll(".profile-menu-item"))
    .map((b) => b.textContent.trim());
  assert.ok(items.indexOf("Settings") < items.indexOf("Business profile"), JSON.stringify(items));

  item.click();
  await settle(p.window);
  assert.equal(p.hash(), "#/settings");
  await p.route();
  assert.deepEqual(p.navigated, ["/settings"]);
  assert.equal(p.document.getElementById("profileMenu").hidden, true, "and the menu closes");
});
