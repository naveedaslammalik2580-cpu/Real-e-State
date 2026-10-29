// Phase 3A: the installable shell and the bottom bar.
//
// The service worker is the part worth pinning hardest, and it is the
// part no browser test can reach: it runs in a worker scope with no DOM.
// So it is loaded into a stand-in scope here and its fetch handler is
// driven directly - which is the only way to assert the promise that
// actually matters, that it never puts itself in front of a Supabase
// call, an authenticated request or a write.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { browser, settle, SKIP_DOM } from "../helpers/browser.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(here, "..", "..", "app");
const read = (rel) => fs.readFileSync(path.join(APP, rel), "utf8");

const open = [];
function closeAll() {
  while (open.length) {
    const b = open.pop();
    try { b.close(); } catch (e) { /* already gone */ }
  }
}

const SCRIPTS = [
  "assets/js/core/utils.js",
  "assets/js/core/customization.js",
  "assets/js/core/quick-add.js",
  "assets/js/app.js",
  "assets/js/core/pwa.js",
  "assets/js/core/mobile-nav.js",
];

function domTest(name, fn) {
  test(name, async (t) => {
    const probe = await browser(SCRIPTS, { store: { getState: () => ({ settings: {} }) } });
    if (!probe) return t.skip(SKIP_DOM);
    try { probe.close(); } catch (e) {}
    try { await fn(); } finally { closeAll(); }
  });
}

// What App.customization.getConfig() reads when a workspace has never
// customised anything.
const defaultCustomization = () => ({ teamMode: false, enabledModules: {}, dashboardWidgets: {} });

async function app(opts = {}) {
  const b = await browser(SCRIPTS, {
    store: {
      ensureLoaded: async () => {},
      getState: () => ({ contacts: [], settings: { customization: defaultCustomization() } }),
      _defaultCustomization: defaultCustomization,
      contacts: { create: async (m) => Object.assign({ id: "ct_new" }, m) },
    },
  });
  if (!b) return null;
  open.push(b);
  b.window.App.pwa._reset();
  const navigated = [];
  b.window.App.app.navigate = (p) => { navigated.push(p); };
  // The shell bits mobile-nav leans on, which app.js would have built.
  const toggle = b.document.createElement("button");
  toggle.id = "mobileMenuToggle";
  b.document.body.appendChild(toggle);
  const toggled = [];
  toggle.addEventListener("click", () => toggled.push(1));
  if (opts.mount !== false) {
    b.window.App.mobileNav.init(b.document, b.window);
  }
  return Object.assign({}, b, { navigated, toggled });
}

// ---------------------------------------------------------------- manifest

test("the manifest is valid JSON, installable, and points at icons that exist", () => {
  const raw = read("manifest.webmanifest");
  const m = JSON.parse(raw);   // throws, loudly, if it is not

  assert.equal(m.name, "RealtorOS");
  assert.equal(m.short_name, "RealtorOS");
  assert.equal(m.display, "standalone");
  // Hash routing: the app reads location.hash, so a start_url without
  // the fragment would open the dashboard, not Today.
  assert.match(m.start_url, /#\/daily$/);
  // Relative, so the app installs correctly wherever it is mounted - an
  // absolute "/" start_url is out of scope the moment it is served from
  // a subdirectory, and the browser refuses the manifest.
  assert.ok(m.start_url.startsWith("./"), m.start_url);
  assert.ok(m.scope.startsWith("./"), m.scope);

  // Straight from the CSS tokens, so the status bar matches the app.
  const css = read("assets/css/realtoros.css");
  assert.match(css, new RegExp("--sidebar-bg:\\s*" + m.theme_color, "i"));
  assert.match(css, new RegExp("--bg:\\s*" + m.background_color, "i"));

  // Chrome needs a 192 and a 512 to offer an install, and a maskable
  // one to avoid putting a rounded square inside a circle.
  const bySize = {};
  m.icons.forEach((i) => { bySize[i.sizes + "/" + (i.purpose || "any")] = i; });
  assert.ok(bySize["192x192/any"], "a 192 is required for installability");
  assert.ok(bySize["512x512/any"], "and a 512");
  assert.ok(bySize["512x512/maskable"], "and a maskable one");

  const files = m.icons.map((i) => i.src)
    .concat(m.shortcuts ? m.shortcuts.flatMap((s) => (s.icons || []).map((i) => i.src)) : [])
    .concat(["assets/icons/apple-touch-icon-180.png", "assets/icons/favicon-32.png", "assets/icons/icon.svg"]);
  files.forEach((src) => {
    const abs = path.join(APP, src);
    assert.ok(fs.existsSync(abs), "missing icon file: " + src);
    assert.ok(fs.statSync(abs).size > 200, src + " is suspiciously empty");
  });
  // Real PNGs, not renamed SVGs: the first eight bytes say so.
  m.icons.forEach((i) => {
    const head = fs.readFileSync(path.join(APP, i.src)).subarray(0, 8);
    assert.deepEqual([...head], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], i.src);
  });
});

test("index.html links the manifest, the icons and the install meta tags", () => {
  const html = read("index.html");
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/);
  assert.match(html, /<meta name="theme-color" content="#0B1F33">/);
  assert.match(html, /apple-mobile-web-app-capable/);
  assert.match(html, /apple-touch-icon/);
  assert.match(html, /viewport-fit=cover/);
});

// ---------------------------------------------------------------- the worker
//
// A stand-in for ServiceWorkerGlobalScope: enough of it to run the file
// and call the handlers it registers.

function workerScope(origin = "https://app.example.test") {
  const store = new Map();          // cache name -> Map(absolute url -> response)
  // A real Request.url is always absolute, and so is every key the
  // Cache API stores, so "./index.html" and the navigation to "/" are
  // the same entry. Normalising here is what makes this stand-in behave
  // like the thing it stands in for.
  const norm = (u) => new URL(typeof u === "string" ? u : u.url, origin + "/").href;
  const calls = { fetched: [], put: [], deleted: [] };
  const response = (url, ok = true) => ({
    url, ok, type: "basic", clone() { return response(url, ok); }
  });

  const cacheFor = (name) => {
    if (!store.has(name)) store.set(name, new Map());
    const map = store.get(name);
    return {
      async add(url) {
        calls.fetched.push(norm(url));
        map.set(norm(url), response(norm(url)));
      },
      async put(req, res) {
        calls.put.push(norm(req));
        map.set(norm(req), res);
      },
      async match(req) { return map.get(norm(req)) || null; },
    };
  };

  const scope = {
    location: { origin, href: origin + "/index.html" },
    listeners: {},
    addEventListener(type, fn) { (scope.listeners[type] = scope.listeners[type] || []).push(fn); },
    skipWaiting() { scope.skipWaitingCalled = true; },
    clients: { claim: async () => {} },
    registration: {},
    caches: {
      async open(name) { return cacheFor(name); },
      async keys() { return [...store.keys()]; },
      async delete(name) { calls.deleted.push(name); return store.delete(name); },
      async match(req) {
        for (const map of store.values()) if (map.has(norm(req))) return map.get(norm(req));
        return null;
      },
    },
    fetch: async (req) => {
      const key = norm(req);
      calls.fetched.push(key);
      if (scope.networkDown) throw new Error("offline");
      return response(key);
    },
    calls, store,
  };
  scope.self = scope;
  scope.norm = norm;
  return scope;
}

function loadWorker(scope) {
  const src = read("sw.js");
  // `self`, `caches`, `fetch` and `addEventListener` are globals in a
  // worker; hand them in rather than pretending this is a module.
  const fn = new Function("self", "caches", "fetch", "addEventListener", "location", src);
  fn(scope, scope.caches, scope.fetch, scope.addEventListener.bind(scope), scope.location);
  return scope;
}

const fire = async (scope, type, event) => {
  const waits = [];
  const e = Object.assign({
    waitUntil: (p) => waits.push(p),
    respondWith: (p) => { e.responded = p; waits.push(p); },
  }, event);
  (scope.listeners[type] || []).forEach((fn) => fn(e));
  await Promise.all(waits);
  return e;
};

const req = (url, { method = "GET", headers = {}, mode = "no-cors" } = {}) => ({
  url, method, mode,
  headers: { get: (k) => headers[k.toLowerCase()] || null },
});

test("the worker caches the shell on install and drops old versions on activate", async () => {
  const scope = loadWorker(workerScope());
  await fire(scope, "install", {});

  const names = await scope.caches.keys();
  assert.equal(names.length, 1, "one versioned cache: " + JSON.stringify(names));
  assert.match(names[0], /^realtoros-shell-/, "the version is in the name");
  const cached = [...scope.store.get(names[0]).keys()].map((u) => u.replace(scope.location.origin, ""));
  assert.ok(cached.includes("/index.html"));
  assert.ok(cached.includes("/assets/css/realtoros.css"));
  assert.ok(cached.includes("/assets/js/app.js"));
  assert.ok(cached.includes("/assets/icons/icon-192.png"));
  assert.ok(cached.some((u) => u.endsWith(".woff2")), "the fonts too");
  assert.ok(!scope.skipWaitingCalled, "installing does not take over on its own");

  // An old version hanging around is deleted, and nothing else is.
  scope.store.set("realtoros-shell-older", new Map());
  scope.store.set("something-else-entirely", new Map());
  await fire(scope, "activate", {});
  assert.deepEqual(scope.calls.deleted, ["realtoros-shell-older"]);
});

test("the worker never puts itself in front of Supabase, auth or a write", async () => {
  const scope = loadWorker(workerScope());
  const skipped = [
    ["a Supabase REST read", req("https://abcd.supabase.co/rest/v1/contacts?select=*")],
    ["a Supabase auth call", req("https://abcd.supabase.co/auth/v1/token")],
    ["an Edge Function", req("https://abcd.supabase.co/functions/v1/manage-automation", { method: "POST" })],
    ["anything with an Authorization header",
      req("https://app.example.test/assets/js/app.js", { headers: { authorization: "Bearer x" } })],
    ["a POST", req("https://app.example.test/anything", { method: "POST" })],
    ["a PATCH", req("https://app.example.test/anything", { method: "PATCH" })],
    ["a DELETE", req("https://app.example.test/anything", { method: "DELETE" })],
    ["a third-party script", req("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2")],
  ];
  for (const [what, request] of skipped) {
    assert.equal(scope.isShellRequest(request), false, what + " must be left alone");
    const e = await fire(scope, "fetch", { request });
    assert.equal(e.responded, undefined,
      what + ": respondWith must not be called, so the request goes out as if no worker existed");
  }

  // And the shell itself IS handled, or none of the above means anything.
  assert.equal(scope.isShellRequest(req("https://app.example.test/assets/js/app.js")), true);
});

test("HTML is network-first and falls back to the cached shell offline", async () => {
  const scope = loadWorker(workerScope());
  await fire(scope, "install", {});
  scope.calls.put.length = 0;

  const nav = req("https://app.example.test/", { mode: "navigate" });
  const online = await fire(scope, "fetch", { request: nav });
  const fresh = await online.responded;
  assert.equal(fresh.url, "https://app.example.test/", "the network answered");
  assert.deepEqual(scope.calls.put, [scope.norm("./index.html")],
    "and the fresh copy replaced the cached shell");

  scope.networkDown = true;
  const offline = await fire(scope, "fetch", { request: nav });
  const fallback = await offline.responded;
  // The stored copy is the response the network gave for the
  // navigation, so its URL is the page it was served at - what matters
  // is that something was served rather than the request throwing.
  assert.ok(fallback, "offline, the cached shell is served instead of an error");
  assert.equal(fallback.url, scope.norm("./"));
});

test("a versioned static file is served from the cache without a network call", async () => {
  const scope = loadWorker(workerScope());
  await fire(scope, "install", {});
  scope.calls.fetched.length = 0;

  const e = await fire(scope, "fetch", { request: req("https://app.example.test/assets/js/app.js") });
  const res = await e.responded;
  assert.equal(res.url, scope.norm("./assets/js/app.js"));
  assert.deepEqual(scope.calls.fetched, [], "cache-first means no request at all");
});

test("the worker's shell list covers every local script index.html loads", () => {
  const html = read("index.html");
  const srcs = [...html.matchAll(/<script\s+src=["']([^"']+)["']/g)]
    .map((m) => m[1])
    .filter((s) => !/^https?:\/\//.test(s));
  const sw = read("sw.js");
  const missing = srcs.filter((s) => !sw.includes('"./' + s + '"'));
  assert.deepEqual(missing, [],
    "sw.js would cache a shell that cannot boot without these: " + JSON.stringify(missing));
  // And the other way: nothing listed that is not on disk.
  const listed = [...sw.matchAll(/"\.\/(assets\/[^"]+)"/g)].map((m) => m[1]);
  const gone = listed.filter((f) => !fs.existsSync(path.join(APP, f)));
  assert.deepEqual(gone, [], "sw.js lists files that do not exist: " + JSON.stringify(gone));
});

// ---------------------------------------------------------------- updates

domTest("a waiting worker offers a reload, and only skips waiting when asked", async () => {
  const p = await app();
  const posted = [];
  const waiting = { postMessage: (m) => posted.push(m) };
  const listeners = {};
  const registration = {
    waiting,
    addEventListener: (t, fn) => { listeners[t] = fn; },
  };
  p.window.navigator.serviceWorker = {
    controller: {},                 // a controller means this is an update
    register: async () => registration,
    addEventListener: () => {},
  };

  const reg = await p.window.App.pwa.registerServiceWorker({ window: p.window });
  assert.ok(reg, "it registered");

  const toast = p.toasts.find((t) => /Update available/i.test(t.message || ""));
  assert.ok(toast, "the update is offered: " + JSON.stringify(p.toasts));
  assert.deepEqual(
    JSON.parse(JSON.stringify((toast.opts.actions || []).map((a) => String(a.label)))),
    ["Reload"]);
  assert.deepEqual(posted, [], "and nothing has been skipped yet");

  toast.opts.actions[0].onClick();
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [{ type: "SKIP_WAITING" }],
    "only the button sends it");
});

domTest("registration is skipped, silently, where it cannot work", async () => {
  const p = await app();
  let registered = false;
  p.window.navigator.serviceWorker = {
    controller: null,
    register: async () => { registered = true; return { addEventListener: () => {} }; },
    addEventListener: () => {},
  };

  // jsdom serves this suite over https, which is allowed; an http host
  // that is not localhost is not.
  const insecure = { protocol: "http:", hostname: "staging.example.test" };
  assert.equal(p.window.App.pwa.isSecureContextFor({ location: insecure }), false);
  assert.equal(p.window.App.pwa.isSecureContextFor(
    { location: { protocol: "http:", hostname: "localhost" } }), true);

  const fake = { navigator: p.window.navigator, location: insecure, console: { warn() {} } };
  const out = await p.window.App.pwa.registerServiceWorker({ window: fake });
  assert.equal(out, null, "it returns nothing rather than throwing");
  assert.equal(registered, false);
  assert.equal(p.toasts.length, 0, "and says nothing: the app still works");
});

// ---------------------------------------------------------------- install UI

domTest("the install card has one shape per browser, and none when installed", async () => {
  const p = await app();
  const slot = p.document.createElement("div");
  p.document.body.appendChild(slot);

  // 1. A browser that has not offered anything, and is not iOS.
  p.window.App.pwa.renderInstallCard(slot, {
    matchMedia: () => ({ matches: false }), navigator: { userAgent: "Chrome" },
  });
  assert.ok(slot.querySelector("#pwaNotYet"), "it says the offer has not arrived yet");
  assert.equal(slot.querySelector("#pwaInstallBtn"), null, "and offers no dead button");

  // 2. iPhone Safari: three steps, no button, because there is no API.
  p.window.App.pwa.renderInstallCard(slot, {
    matchMedia: () => ({ matches: false }),
    navigator: { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari" },
  });
  const steps = slot.querySelectorAll("#pwaIosSteps li");
  assert.equal(steps.length, 3, "Share, Add to Home Screen, Add");
  assert.match(steps[0].textContent, /Share/);
  assert.match(steps[1].textContent, /Add to Home Screen/);
  assert.equal(slot.querySelector("#pwaInstallBtn"), null);

  // 3. Chrome, once beforeinstallprompt has fired.
  const win = p.window;
  p.window.App.pwa.captureInstallPrompt(win);
  let prompted = 0;
  const event = new win.Event("beforeinstallprompt");
  event.prompt = () => { prompted++; };
  event.userChoice = Promise.resolve({ outcome: "accepted" });
  win.dispatchEvent(event);
  await settle(win);

  p.window.App.pwa.renderInstallCard(slot, win);
  const btn = slot.querySelector("#pwaInstallBtn");
  assert.ok(btn, "now there is a button");
  btn.click();
  await settle(win);
  assert.equal(prompted, 1, "which runs the browser's own install flow");

  // 4. Already installed: nothing to press.
  p.window.App.pwa.renderInstallCard(slot, {
    matchMedia: (q) => ({ matches: /standalone/.test(q) }), navigator: { userAgent: "Chrome" },
  });
  assert.ok(slot.querySelector("#pwaInstalled"));
  assert.equal(slot.querySelector("#pwaInstallBtn"), null);
});

domTest("the install banner shows once on mobile and remembers being dismissed", async () => {
  const p = await app();
  const win = p.window;
  try { win.localStorage.removeItem(p.window.App.pwa.BANNER_DISMISSED_KEY); } catch (e) {}

  // Nothing to offer yet: no banner rather than a banner that cannot act.
  assert.equal(p.window.App.pwa.mountBanner(p.document, win), null);

  p.window.App.pwa.captureInstallPrompt(win);
  const event = new win.Event("beforeinstallprompt");
  event.prompt = () => {};
  event.userChoice = Promise.resolve({ outcome: "dismissed" });
  win.dispatchEvent(event);
  await settle(win);

  const bar = p.window.App.pwa.mountBanner(p.document, win);
  assert.ok(bar && p.document.getElementById("pwaInstallBanner"), "it is on the page");
  assert.match(bar.textContent, /Install RealtorOS/);

  bar.querySelector("#pwaBannerDismiss").click();
  assert.equal(p.document.getElementById("pwaInstallBanner"), null, "dismissed");
  assert.equal(p.window.App.pwa.mountBanner(p.document, win), null,
    "and it stays dismissed - Settings carries the card for second thoughts");
});

// ---------------------------------------------------------------- bottom bar

domTest("the bottom bar carries five tabs, and + opens the quick add", async () => {
  const p = await app();
  const bar = p.document.getElementById("mobileTabBar");
  assert.ok(bar, "the bar is in the DOM at every width");
  const labels = Array.from(bar.querySelectorAll(".mobile-tab-label")).map((el) => el.textContent);
  assert.deepEqual(JSON.parse(JSON.stringify(labels)),
    ["Today", "Contacts", "+ New", "Deals", "More"]);

  // Only CSS decides whether it is on screen, so desktop is untouched.
  const css = read("assets/css/realtoros.css");
  assert.match(css, /\.mobile-tabs\s*\{\s*display:\s*none;\s*\}/,
    "hidden by default, shown inside the narrow media query");
  assert.match(css, /@media \(max-width: 767px\)/);
  assert.match(css, /env\(safe-area-inset-bottom/, "padded for the home indicator");

  bar.querySelector('[data-tab-route="/contacts"]').click();
  assert.deepEqual(p.navigated, ["/contacts"]);

  bar.querySelector('[data-tab-action="quickAdd"]').click();
  await settle(p.window);
  const modal = p.document.querySelector(".modal");
  assert.ok(modal && modal.querySelector("#qaName"),
    "the middle tab opens the Phase 2F quick add, not a second form");

  bar.querySelector('[data-tab-action="menu"]').click();
  assert.equal(p.toggled.length, 1, "More opens the sidebar that already exists");
});

domTest("the current route lights its tab, and a disabled module loses one", async () => {
  const p = await app();
  const bar = () => p.document.getElementById("mobileTabBar");
  const active = () => Array.from(bar().querySelectorAll(".mobile-tab.active"))
    .map((el) => el.getAttribute("data-tab-route"));

  p.window.location.hash = "";
  p.window.App.app.defaultHome = () => "/daily";
  p.window.App.mobileNav.syncActive(p.document, p.window);
  assert.deepEqual(active(), ["/daily"], "empty-entry home highlights Today");
  p.window.App.app.defaultHome = () => "/dashboard";
  p.window.App.mobileNav.syncActive(p.document, p.window);
  assert.deepEqual(active(), [], "Dashboard fallback does not highlight Today");

  p.window.location.hash = "#/contacts/ct_123";
  p.window.App.mobileNav.syncActive(p.document, p.window);
  assert.deepEqual(active(), ["/contacts"], "a contact's own page is still Contacts");

  p.window.location.hash = "#/past-clients";
  p.window.App.mobileNav.syncActive(p.document, p.window);
  assert.deepEqual(active(), ["/contacts"], "Past Clients belongs to Contacts");

  p.window.location.hash = "#/pipeline";
  p.window.App.mobileNav.syncActive(p.document, p.window);
  assert.deepEqual(active(), ["/pipeline"]);

  // A tab for a page somebody switched off in Settings would lead to the
  // dashboard, so it is not offered.
  p.window.App.customization.isModuleEnabled = (id) => id !== "daily";
  p.window.App.mobileNav.mount(p.document, p.window);
  const routes = Array.from(bar().querySelectorAll("[data-tab-route]"))
    .map((el) => el.getAttribute("data-tab-route"));
  assert.deepEqual(JSON.parse(JSON.stringify(routes)), ["/contacts", "/pipeline"]);
});

domTest("the offline banner follows the connection", async () => {
  const p = await app();
  const banner = p.document.getElementById("offlineBanner");
  assert.ok(banner, "it is built up front and hidden, not created on the event");
  assert.equal(banner.hidden, true, "online: nothing to say");
  assert.match(banner.textContent, /offline/i);
  assert.match(banner.textContent, /connection/i);

  p.window.dispatchEvent(new p.window.Event("offline"));
  assert.equal(banner.hidden, false, "offline: said once, plainly");

  p.window.dispatchEvent(new p.window.Event("online"));
  assert.equal(banner.hidden, true, "and it goes away on its own");
});

domTest("mobile active state follows Contacts and Deals hub deep links", async () => {
  const p = await app();
  for (const [path, target] of [["/buyer", "/contacts"], ["/seller", "/contacts"], ["/past-clients", "/contacts"], ["/properties/pr_1", "/pipeline"], ["/commission", "/pipeline"]]) {
    p.window.location.hash = "#" + path;
    p.window.App.mobileNav.syncActive(p.document, p.window);
    assert.deepEqual(Array.from(p.document.querySelectorAll(".mobile-tab.active"), el => el.dataset.tabRoute), [target]);
  }
});

domTest("push fallback accepts only internal paths from the controlling service worker", async () => {
  const p = await app();
  const worker = new p.window.EventTarget();
  worker.controller = {};
  worker.register = async () => ({});
  Object.defineProperty(p.window.navigator, "serviceWorker", { value: worker, configurable: true });
  p.window.App.pwa.init(p.document, p.window);
  p.window.App.pwa.init(p.document, p.window);
  const send = (url, source = worker.controller) => {
    const event = new p.window.Event("message");
    Object.defineProperties(event, { data: { value: { type: "NAVIGATE", url } }, source: { value: source } });
    worker.dispatchEvent(event);
  };
  for (const url of ["https://evil.test", "//evil.test", "/contacts/../settings", "javascript:alert(1)", "/contacts?x=1"]) send(url);
  send("/contacts/ct_1", {});
  assert.deepEqual(p.navigated, []);
  send("/contacts/ct_1");
  send("/automation");
  assert.deepEqual(p.navigated, ["/contacts/ct_1", "/automation"], "single listener routes through existing guards");
});
