import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { workspace } from "./crm-helpers.mjs";
import { browser, settle } from "../helpers/browser.mjs";

const SCRIPTS = ["assets/js/core/utils.js", "assets/js/core/customization.js", "assets/js/app.js",
  "assets/js/core/quick-add.js", "assets/js/core/mobile-nav.js", "assets/js/core/header-actions.js"];
async function setup(t, { denied = [], create = ["contacts", "deals", "work"], modules = {}, rows = {}, lists = {} } = {}) {
  const config = { enabledModules: modules, teamMode: true, dashboardWidgets: {} };
  const state = { settings: { customization: config, ui: {} }, metadata: {} };
  const calls = [], navigated = [], workflows = [];
  const store = { getState: () => state, _defaultCustomization: () => config, settings: { update: async () => {} } };
  for (const key of ["contacts", "deals", "properties", "tasks"]) {
    store[key] = { list: async opts => { calls.push([key, opts]); return lists[key] ? lists[key]() : (rows[key] || []); } };
  }
  const b = await browser(SCRIPTS, { store }); assert.ok(b, "jsdom required"); t.after(() => b.close());
  const App = b.window.App;
  let workspaceId = "ws-1", userId = "u-1", permissions = { denied, create }, listener, authListener;
  App.cloud = { getUser: () => userId ? ({ id: userId }) : null, getClient: () => ({ auth: { onAuthStateChange: fn => { authListener = fn; return { data: { subscription: { unsubscribe() { authListener = null; } } } }; } } }) };
  App.workspace = { ready: () => true, id: () => workspaceId, permissions: () => permissions,
    canView: a => !permissions.denied.includes(a), canCreate: a => permissions.create.includes(a),
    can: () => false, onChange: fn => { listener = fn; return () => { listener = null; }; } };
  App.quickAdd.open = () => workflows.push(["contact"]);
  App.pages.deals = { openDealModal: (...args) => workflows.push(["deal", ...args]) };
  App.pages.tasks = { openTaskModal: (...args) => workflows.push(["task", ...args]) };
  App.pages.contacts = { openShowingModal: (...args) => workflows.push(["showing", ...args]) };
  App.pages.activities = { openActivityModal: (...args) => workflows.push(["call", ...args]) };
  App.app.renderShell(); App.app.navigate = path => navigated.push(path);
  b.window.scrollTo = () => {};
  for (const storage of [b.window.localStorage, b.window.sessionStorage]) assert.equal(storage.length, 0);
  return { ...b, App, calls, navigated, workflows, state,
    user(id) { userId = id; authListener?.(id ? "SIGNED_IN" : "SIGNED_OUT"); },
    change(id, next = permissions) { workspaceId = id; permissions = next; listener?.(); },
    async search(query) {
      if (!b.document.getElementById("globalSearchInput")) b.document.getElementById("globalSearchBtn").click();
      await settle(b.window);
      const input = b.document.getElementById("globalSearchInput"); input.value = query;
      input.dispatchEvent(new b.window.Event("input", { bubbles: true }));
      await new Promise(resolve => b.window.setTimeout(resolve, 240));
      return input;
    },
    menu() { b.document.getElementById("globalNewBtn").click(); return b.document.getElementById("globalNewMenu"); }
  };
}
const key = (b, target, value, extra = {}) => target.dispatchEvent(new b.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...extra }));

for (const modifier of ["ctrlKey", "metaKey"]) test(modifier + " + K focuses search; Escape restores focus", async t => {
  const b = await setup(t); const button = b.document.getElementById("globalSearchBtn"); button.focus();
  key(b, b.document, "k", { [modifier]: true }); await settle(b.window);
  assert.equal(b.document.activeElement.id, "globalSearchInput");
  key(b, b.document.activeElement, "Escape"); await new Promise(r => b.window.setTimeout(r, 210));
  assert.equal(b.document.getElementById("globalSearchInput"), null); assert.equal(b.document.activeElement, button);
});

test("search groups all four entities, navigates existing URLs, and uses fresh authenticated lists", async t => {
  const b = await setup(t, { rows: { contacts: [{ id: "ct_1", name: "Match Contact", email: "one@example.test" }],
    deals: [{ id: "dl_1", name: "Match Deal", stage: "Offer" }], properties: [{ id: "pr_1", address: "Match Street" }], tasks: [{ id: "tk_1", title: "Match Task" }] } });
  await b.search("match");
  assert.deepEqual(Array.from(b.document.querySelectorAll('#globalSearchResults [role="group"]'), e => e.getAttribute("aria-label")), ["Contacts", "Deals", "Properties", "Tasks"]);
  assert.deepEqual(JSON.parse(JSON.stringify(b.calls)), ["contacts", "deals", "properties", "tasks"].map(k => [k, { force: true, cache: false }]));
  const input = b.document.getElementById("globalSearchInput"); key(b, input, "ArrowDown"); key(b, input, "Enter");
  assert.deepEqual(b.navigated, ["/pipeline/dl_1"]);
  await new Promise(r => b.window.setTimeout(r, 210));
  for (const [index, path] of [[0, "/contacts/ct_1"], [2, "/properties/pr_1"], [3, "/tasks"]]) {
    await b.search("match"); b.document.querySelector('[data-result="' + index + '"]').click();
    assert.equal(b.navigated.at(-1), path); await new Promise(r => b.window.setTimeout(r, 210));
  }
});

test("empty, loading, no results and retry after error", async t => {
  let fail = true; const b = await setup(t, { lists: { contacts: () => { if (fail) throw Error("private details"); return []; } } });
  await b.search(""); assert.equal(b.calls.length, 0);
  const input = b.document.getElementById("globalSearchInput"); input.value = "xx"; input.dispatchEvent(new b.window.Event("input"));
  assert.match(b.document.getElementById("globalSearchStatus").textContent, /Searching/);
  await new Promise(r => b.window.setTimeout(r, 240)); assert.match(b.document.getElementById("globalSearchStatus").textContent, /could not load/);
  assert.ok(!b.document.body.textContent.includes("private details"));
  fail = false; await b.search("missing"); assert.match(b.document.getElementById("globalSearchStatus").textContent, /No matching/);
});

test("rapid typing shares one read; outdated results never replace current query", async t => {
  let resolve; const pending = new Promise(r => { resolve = r; });
  const b = await setup(t, { lists: { contacts: () => pending } });
  await b.search("old"); await b.search("new");
  resolve([{ id: "ct_1", name: "old person" }, { id: "ct_2", name: "new person" }]); await settle(b.window);
  assert.equal(b.calls.filter(c => c[0] === "contacts").length, 1);
  assert.match(b.document.getElementById("globalSearchResults").textContent, /new person/);
  assert.doesNotMatch(b.document.getElementById("globalSearchResults").textContent, /old person/);
});

test("workspace changes discard pending results and close search", async t => {
  let resolve; const b = await setup(t, { lists: { contacts: () => new Promise(r => { resolve = r; }) } });
  await b.search("secret"); b.change("ws-2"); resolve([{ id: "ct_1", name: "secret" }]); await settle(b.window);
  assert.ok(!b.document.body.textContent.includes("secret"));
  await new Promise(r => b.window.setTimeout(r, 210)); assert.equal(b.document.getElementById("globalSearchInput"), null);
});

test("denied areas and disabled modules are never fetched", async t => {
  const b = await setup(t, { denied: ["deals", "properties"], modules: { tasks: false }, rows: { contacts: [{ id: "ct_own", name: "Own Match" }] } });
  await b.search("match"); assert.deepEqual(b.calls.map(c => c[0]), ["contacts"]);
  assert.equal(b.document.querySelectorAll('[role="option"]').length, 1);
  b.change("ws-1", { denied: ["contacts", "deals", "properties", "work"], create: [] });
  await new Promise(r => b.window.setTimeout(r, 210)); await b.search("match");
  assert.equal(b.calls.length, 1); assert.equal(b.document.querySelectorAll('[role="option"]').length, 0);
});

test("untrusted strings are text; queries/results are never persisted", async t => {
  const b = await setup(t, { rows: { contacts: [{ id: "ct_1", name: '<img src=x onerror="alert(1)"> & Match', email: '<script>bad()</script>' }] } });
  await b.search("match"); const results = b.document.getElementById("globalSearchResults");
  assert.equal(results.querySelector("img,script"), null); assert.match(results.textContent, /<img/);
  assert.equal(b.window.localStorage.length, 0); assert.equal(b.window.sessionStorage.length, 0);
});

test("New offers all five existing workflows for an authorized solo owner", async t => {
  const b = await setup(t); b.state.settings.customization.teamMode = false;
  assert.equal(b.document.getElementById("quickAddBtn"), null);
  assert.equal(b.document.getElementById("globalNewBtn").textContent, "+ New");
  for (const id of ["contact", "deal", "task", "showing", "call"]) {
    const menu = b.menu(); assert.equal(menu.querySelectorAll("button").length, 5);
    menu.querySelector('[data-action="' + id + '"]').click(); await settle(b.window); assert.equal(menu.hidden, true);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(b.workflows)), [["contact"], ["deal", null], ["task", null], ["showing", {}], ["call", null, { type: "Call" }]]);
});

test("restricted create permissions and module flags filter New; selection rechecks permission", async t => {
  const b = await setup(t, { create: ["work"], modules: { tasks: false, calendar: false } });
  const menu = b.menu(); assert.deepEqual(Array.from(menu.querySelectorAll("button"), e => e.dataset.action), ["call"]);
  b.App.workspace.canCreate = () => false;
  menu.querySelector("button").click(); await settle(b.window); assert.deepEqual(b.workflows, []);
});

test("New keyboard, Escape, outside click and navigation close with correct focus", async t => {
  const b = await setup(t); const button = b.document.getElementById("globalNewBtn");
  key(b, button, "ArrowDown"); const menu = b.document.getElementById("globalNewMenu");
  assert.equal(b.document.activeElement.dataset.action, "contact"); key(b, menu, "End"); assert.equal(b.document.activeElement.dataset.action, "call");
  key(b, menu, "ArrowUp"); assert.equal(b.document.activeElement.dataset.action, "showing");
  key(b, menu, "Escape"); assert.equal(menu.hidden, true); assert.equal(b.document.activeElement, button);
  b.menu(); b.document.body.click(); assert.equal(menu.hidden, true);
  b.menu(); b.window.dispatchEvent(new b.window.HashChangeEvent("hashchange")); assert.equal(menu.hidden, true);
});

test("mobile FAB retains Quick Add while bottom-bar New uses the shared menu", async t => {
  const b = await setup(t); b.document.getElementById("quickAddFab").click();
  // The FAB closes over the real quick-add open function; it still opens its form.
  await settle(b.window); assert.ok(b.document.getElementById("quickAddForm"));
  b.App.mobileNav.init(b.document, b.window);
  b.document.querySelector('[data-tab-action="quickAdd"]').click();
  const menu = b.document.getElementById("globalNewMenu");
  assert.equal(menu.hidden, false);
  menu.querySelector('[data-action="contact"]').click();
  assert.deepEqual(b.workflows, [["contact"]]);
});


test("transient search reads never consume or overwrite the shared entity cache", async t => {
  const b = await browser(["assets/js/core/utils.js", "assets/js/data/data-service.js"]); assert.ok(b); t.after(() => b.close());
  let rows = [{ id: "ct_cached", full_name: "Cached" }], reads = 0;
  b.window.App.cloud = { getUser: () => ({ id: "u-1" }), getClient: () => ({ from: table => {
    assert.equal(table, "contacts"); return { select: async fields => { assert.equal(fields, "*"); reads++; return { data: rows, error: null }; } };
  } }) };
  await b.window.App.data.list("contacts");
  rows = [{ id: "ct_fresh", full_name: "Fresh" }];
  const result = await b.window.App.data.list("contacts", { cache: false });
  assert.equal(result[0].id, "ct_fresh");
  assert.equal((await b.window.App.data.list("contacts"))[0].id, "ct_cached");
  assert.equal(reads, 2, "transient call bypasses cache; ordinary calls keep their existing behavior");
});


for (const reason of ["workspace", "user", "permissions", "modules"]) test(reason + " changes clear visible results and discard pending reads", async t => {
  let finish;
  const b = await setup(t, { lists: { contacts: () => new Promise(r => { finish = r; }) } });
  await b.search("secret");
  if (reason === "workspace") b.change("ws-2");
  if (reason === "user") b.user("u-2");
  if (reason === "permissions") b.change("ws-1", { denied: ["contacts"], create: [] });
  if (reason === "modules") { b.state.settings.customization.enabledModules.tasks = false; b.App.app.refreshNav(); }
  finish([{ id: "ct_secret", name: "secret record" }]); await settle(b.window);
  assert.ok(!b.document.body.textContent.includes("secret record"));
  assert.equal(b.document.getElementById("globalSearchInput")?.value || "", "");
  await new Promise(r => b.window.setTimeout(r, 210));
  assert.equal(b.document.getElementById("globalSearchInput"), null);
});

test("auth changes remove already-rendered sensitive search results immediately", async t => {
  const b = await setup(t, { rows: { contacts: [{ id: "ct_1", name: "Sensitive person" }] } });
  await b.search("sensitive"); assert.match(b.document.getElementById("globalSearchResults").textContent, /Sensitive/);
  b.user(null); assert.equal(b.document.getElementById("globalSearchResults").textContent, "");
  assert.equal(b.document.getElementById("globalNewBtn").hidden, true);
  assert.equal(b.document.getElementById("globalSearchBtn").disabled, true);
});

test("late transient read cannot overwrite a new workspace's normal cache", async t => {
  const b = await browser(["assets/js/core/utils.js", "assets/js/data/data-service.js"]); assert.ok(b); t.after(() => b.close());
  let finish, slow = true;
  b.window.App.cloud = { getUser: () => ({ id: "u-1" }), getClient: () => ({ from: () => ({ select: () => slow
    ? new Promise(r => { finish = r; }) : Promise.resolve({ data: [{ id: "ct_new", full_name: "New workspace" }], error: null }) }) }) };
  const old = b.window.App.data.list("contacts", { cache: false });
  slow = false; await b.window.App.data.list("contacts");
  finish({ data: [{ id: "ct_old", full_name: "Old workspace" }], error: null }); await old;
  assert.equal((await b.window.App.data.list("contacts"))[0].id, "ct_new");
});

test("all five menu choices open their real existing forms", async t => {
  const b = await setup(t); b.App.store = workspace();
  for (const file of ["core/commission.js", "ui/custom-fields-ui.js", "pages/deals.js", "pages/tasks.js", "pages/activities.js", "pages/contacts.js", "core/quick-add.js"]) {
    b.window.eval(readFileSync(new URL("../../app/assets/js/" + file, import.meta.url), "utf8"));
  }
  for (const [action, form] of [["contact", "quickAddForm"], ["deal", "dealForm"], ["task", "taskForm"], ["showing", "showForm"], ["call", "actForm"]]) {
    b.menu().querySelector('[data-action="' + action + '"]').click(); await settle(b.window);
    assert.ok(b.document.getElementById(form), action + " opens its canonical form");
    if (action === "call") assert.equal(b.document.getElementById("afType").value, "Call");
    b.App.app.closeAllModals(); await new Promise(r => b.window.setTimeout(r, 210));
  }
});

test("New uses theme contrast tokens and hidden controls stay hidden; header wraps on narrow screens", async t => {
  const b = await setup(t);
  for (const theme of ["light", "dark"]) {
    b.document.documentElement.setAttribute("data-theme", theme);
    const button = b.document.getElementById("globalNewBtn");
    assert.ok(button.classList.contains("btn-primary")); assert.equal(button.textContent, "+ New");
    b.menu(); key(b, b.document, "Escape");
  }
  const css = readFileSync(new URL("../../app/assets/css/realtoros.css", import.meta.url), "utf8");
  assert.match(css, /\.header-new\[hidden\]\s*\{\s*display: none/);
  assert.match(css, /#topbar\s*\{[^}]*flex-wrap: wrap/);
  assert.match(css, /\.header-search kbd\s*\{\s*display: none/);
});


test("a new identity cannot reuse the previous user's effective permissions", async t => {
  const b = await setup(t); b.user("u-2");
  assert.equal(b.document.getElementById("globalSearchBtn").disabled, true);
  assert.equal(b.document.getElementById("globalNewBtn").hidden, true);
  key(b, b.document, "k", { ctrlKey: true }); assert.equal(b.document.getElementById("globalSearchInput"), null);
  b.change("ws-2", { denied: [], create: ["contacts"] });
  assert.equal(b.document.getElementById("globalSearchBtn").disabled, false);
  assert.deepEqual(Array.from(b.menu().querySelectorAll("button"), e => e.dataset.action), ["contact"]);
});


test("New menu stays within narrow and laptop viewport edges", async t => {
  const b = await setup(t); const button = b.document.getElementById("globalNewBtn");
  for (const width of [320, 640, 767, 768, 900, 901, 1150, 1440]) {
    b.window.innerWidth = width;
    for (const right of [100, width - 8]) {
      button.getBoundingClientRect = () => ({ right, bottom: 58 });
      const menu = b.menu(); const left = parseFloat(menu.style.left), size = parseFloat(menu.style.width);
      assert.ok(left >= 8 && left + size <= width - 8, width + "px");
      key(b, b.document, "Escape");
    }
  }
});

test("mobile New positions above its trigger, restores focus and shares permission filtering", async t => {
  const b = await setup(t);
  const trigger = b.document.querySelector('[data-tab-action="quickAdd"]');
  trigger.getBoundingClientRect = () => ({ top: 580, bottom: 636, left: 120, right: 190 });
  Object.defineProperty(b.window, "innerWidth", { value: 320, configurable: true });
  Object.defineProperty(b.window, "innerHeight", { value: 640, configurable: true });
  trigger.click();
  const menu = b.document.getElementById("globalNewMenu");
  assert.equal(menu.hidden, false);
  assert.equal(menu.querySelectorAll("[data-action]").length, 5);
  assert.equal(menu.style.top, "auto");
  assert.equal(menu.style.bottom, "68px");
  assert.ok(parseFloat(menu.style.left) + parseFloat(menu.style.width) <= 312);
  key(b, menu, "Escape");
  assert.equal(b.document.activeElement, trigger);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  b.change("ws-1", { denied: [], create: [] });
  assert.equal(trigger.disabled, true);
  assert.equal(menu.hidden, true);
});
