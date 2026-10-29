// Phase 3B, browser side: turning notifications on for a device, the
// states that are not "on", and the service worker's two push handlers.
//
// The states are the point. Push has six of them and five need different
// words - blocked is not off, an iPhone in a tab is not unsupported, and
// "no keys on the server yet" is not a failure at all. A screen that
// collapses those into one button is a screen that asks for a permission
// it cannot use and loses it for good.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { browser, settle, SKIP_DOM } from "../helpers/browser.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(here, "..", "..", "app");

const open = [];
function closeAll() {
  while (open.length) {
    const b = open.pop();
    try { b.close(); } catch (e) { /* already gone */ }
  }
}

const SCRIPTS = [
  "assets/js/core/utils.js",
  "assets/js/app.js",
  "assets/js/core/pwa.js",
  "assets/js/core/push.js",
  "assets/js/pages/push-settings.js",
];

function domTest(name, fn) {
  test(name, async (t) => {
    const probe = await browser(SCRIPTS, { store: { getState: () => ({ settings: {} }) } });
    if (!probe) return t.skip(SKIP_DOM);
    try { probe.close(); } catch (e) {}
    try { await fn(); } finally { closeAll(); }
  });
}

/**
 * A browser with a push stack that behaves the way the test asks:
 * permission, whether a subscription already exists, and what the
 * permission prompt answers.
 */
async function app(opts = {}) {
  const {
    vapidKey = "BPublicKeyForTests",
    permission = "default",
    answers = "granted",
    existing = null,
    devices = [],
    prefs = {
      push_enabled: true,
      push_types: ["lead_replied", "hot_reply"],
      quiet_start: null, quiet_end: null,
      all_types: ["lead_replied", "hot_reply", "overdue_followups"],
      stored: true,
    },
    userAgent = "Mozilla/5.0 (Windows NT 10.0) Chrome/120",
    pushManager = true,
  } = opts;

  const calls = [];
  const b = await browser(SCRIPTS, {
    store: {
      ensureLoaded: async () => {},
      getState: () => ({ settings: {} }),
      push: {
        devices: async () => devices,
        register: async (sub, label) => { calls.push(["register", sub, label]); return { outcome: "registered" }; },
        remove: async (endpoint) => { calls.push(["remove", endpoint]); return { outcome: "removed" }; },
        preferences: async () => prefs,
        savePreferences: async (p) => { calls.push(["savePrefs", p]); return { outcome: "saved" }; },
      },
    },
  });
  if (!b) return null;
  open.push(b);

  b.window.App.config = { vapidPublicKey: vapidKey };
  Object.defineProperty(b.window.navigator, "userAgent", { value: userAgent, configurable: true });

  let subscription = existing;
  const subscribed = [];
  if (pushManager) {
    b.window.PushManager = function () {};
    b.window.navigator.serviceWorker = {
      ready: Promise.resolve({
        pushManager: {
          getSubscription: async () => subscription,
          subscribe: async (options) => {
            subscribed.push(options);
            subscription = {
              endpoint: "https://fcm.googleapis.com/fcm/send/this-browser",
              toJSON: () => ({
                endpoint: "https://fcm.googleapis.com/fcm/send/this-browser",
                keys: { p256dh: "BKeyFromBrowser", auth: "AuthFromBrowser" },
              }),
              unsubscribe: async () => { subscription = null; calls.push(["unsubscribe"]); return true; },
            };
            return subscription;
          },
        },
      }),
    };
  } else {
    delete b.window.navigator.serviceWorker;
  }

  b.window.Notification = {
    permission,
    requestPermission: async () => {
      b.window.Notification.permission = answers;
      return answers;
    },
  };

  const pane = b.document.createElement("div");
  b.document.body.appendChild(pane);
  return Object.assign({}, b, { pane, calls, subscribed, current: () => subscription });
}

const renderPane = async (p) => {
  await p.window.App.pages.pushSettings.render(p.pane);
  await settle(p.window);
  return p.pane;
};

const text = (p) => p.pane.textContent.replace(/\s+/g, " ");

// ---------------------------------------------------------------- states

domTest("with no key configured it says so, and never asks for permission", async () => {
  const p = await app({ vapidKey: "" });
  await renderPane(p);

  assert.match(text(p), /switch on when RealtorOS goes live/);
  assert.equal(p.pane.querySelector("#pushEnableBtn"), null,
    "no button, because pressing it could only fail");
  assert.equal(p.pane.querySelector("#pushPrefsCard"), null,
    "and nothing to configure for something that cannot run yet");
  assert.equal(p.window.Notification.permission, "default",
    "the permission prompt was never even considered");
});

domTest("an iPhone in a Safari tab is told to install first, not that it cannot", async () => {
  const p = await app({
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari",
    pushManager: false,
  });
  await renderPane(p);

  const shown = text(p);
  assert.match(shown, /Home Screen/, "there is a way to do this, and it is three taps");
  assert.match(shown, /16\.4/, "and a version, because older iPhones genuinely cannot");
  assert.ok(!/cannot show notifications/.test(shown),
    "it must not read as 'your phone cannot do this' - it can: " + shown);
  assert.equal(p.pane.querySelector("#pushEnableBtn"), null);
});

domTest("blocked is its own state, and says where to undo it", async () => {
  const p = await app({ permission: "denied" });
  await renderPane(p);

  const shown = text(p);
  assert.match(shown, /blocked/i);
  assert.match(shown, /site settings/i,
    "the browser will not ask again, so the only way out is its own settings");
  assert.equal(p.pane.querySelector("#pushEnableBtn"), null,
    "and no button that the browser would silently refuse");
});

// ---------------------------------------------------------------- enabling

domTest("turning it on asks, subscribes with the key, and registers the device", async () => {
  const p = await app({ permission: "default", answers: "granted" });
  await renderPane(p);

  const btn = p.pane.querySelector("#pushEnableBtn");
  assert.ok(btn, "there is a button to press: " + text(p));
  btn.click();
  await settle(p.window);

  assert.equal(p.subscribed.length, 1, "it subscribed once");
  assert.equal(p.subscribed[0].userVisibleOnly, true,
    "required by every browser: a push that shows nothing is not allowed");
  assert.ok(p.subscribed[0].applicationServerKey instanceof p.window.Uint8Array
    || p.subscribed[0].applicationServerKey instanceof Uint8Array,
    "the VAPID key goes in as bytes, not as the base64 string");

  const registered = p.calls.find((c) => c[0] === "register");
  assert.ok(registered, "and it told the server: " + JSON.stringify(p.calls));
  assert.deepEqual(JSON.parse(JSON.stringify(registered[1])), {
    endpoint: "https://fcm.googleapis.com/fcm/send/this-browser",
    p256dh: "BKeyFromBrowser",
    auth: "AuthFromBrowser",
  });
  assert.match(String(registered[2]), /Windows PC \(Chrome\)/,
    "with a label a person can recognise, not a user-agent string");

  assert.ok(p.toasts.some((t) => /on for this device/i.test(t.message || "")),
    JSON.stringify(p.toasts));
  // And the screen now offers the opposite.
  assert.ok(p.pane.querySelector("#pushDisableBtn"));
});

domTest("a refused prompt is reported as blocked, and nothing is registered", async () => {
  const p = await app({ permission: "default", answers: "denied" });
  await renderPane(p);
  p.pane.querySelector("#pushEnableBtn").click();
  await settle(p.window);

  assert.equal(p.subscribed.length, 0);
  assert.equal(p.calls.filter((c) => c[0] === "register").length, 0);
  assert.ok(p.toasts.some((t) => /blocked/i.test(t.message || "")), JSON.stringify(p.toasts));
});

// ---------------------------------------------------------------- devices

domTest("the devices list shows what is subscribed and can remove one", async () => {
  const p = await app({
    permission: "granted",
    existing: {
      endpoint: "https://fcm.googleapis.com/fcm/send/this-browser",
      unsubscribe: async () => true,
    },
    devices: [
      { id: "d1", endpoint: "https://fcm.googleapis.com/fcm/send/old-phone",
        device_label: "Old iPhone", created_at: "2026-09-01T10:00:00Z", failure_count: 0 },
      { id: "d2", endpoint: "https://fcm.googleapis.com/fcm/send/this-browser",
        device_label: "Windows PC (Chrome)", created_at: "2026-10-10T10:00:00Z", failure_count: 4 },
    ],
  });
  await renderPane(p);

  const rows = p.pane.querySelectorAll(".push-device");
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /Old iPhone/);
  assert.match(rows[1].textContent, /not accepting notifications lately/,
    "a device that keeps refusing says so, rather than silently eating everything");

  rows[0].querySelector("[data-remove-device]").click();
  await settle(p.window);
  const removed = p.calls.find((c) => c[0] === "remove");
  assert.ok(removed, JSON.stringify(p.calls));
  assert.equal(removed[1], "https://fcm.googleapis.com/fcm/send/old-phone",
    "removing a row removes that endpoint, not this browser's");
});

domTest("the preferences save as plain names, times and nothing else", async () => {
  const p = await app({ permission: "granted" });
  await renderPane(p);

  // Plain names, not database strings.
  const list = p.pane.querySelector("#pushTypeList").textContent;
  assert.match(list, /A lead replies/);
  assert.match(list, /Follow-ups are overdue/);
  assert.ok(!/overdue_followups/.test(list), "no database identifiers on screen: " + list);

  const boxes = Array.from(p.pane.querySelectorAll(".push-type-box"));
  assert.deepEqual(boxes.filter((b) => b.checked).map((b) => b.value),
    ["lead_replied", "hot_reply"], "what is stored is what is ticked");

  boxes.find((b) => b.value === "overdue_followups").checked = true;
  p.pane.querySelector("#pushQuietStart").value = "22:00";
  p.pane.querySelector("#pushQuietEnd").value = "07:00";
  p.pane.querySelector("#pushSavePrefs").click();
  await settle(p.window);

  const saved = p.calls.find((c) => c[0] === "savePrefs");
  assert.ok(saved, JSON.stringify(p.calls));
  assert.deepEqual(JSON.parse(JSON.stringify(saved[1])), {
    pushEnabled: true,
    pushTypes: ["lead_replied", "hot_reply", "overdue_followups"],
    quietStart: "22:00",
    quietEnd: "07:00",
  });

  // Half a window is refused here rather than by the database.
  p.pane.querySelector("#pushQuietEnd").value = "";
  p.pane.querySelector("#pushSavePrefs").click();
  await settle(p.window);
  assert.ok(p.toasts.some((t) => /both a start and an end/i.test(t.message || "")),
    JSON.stringify(p.toasts));
  assert.equal(p.calls.filter((c) => c[0] === "savePrefs").length, 1, "and nothing was sent");
});

// ---------------------------------------------------------------- the worker
//
// sw.js runs in a scope with no DOM, so it is loaded into a stand-in and
// its two new handlers are called directly - the same approach as the 3A
// fetch tests, which still have to pass unchanged.

function workerScope() {
  const scope = {
    location: { origin: "https://app.example.test" },
    listeners: {},
    addEventListener(type, fn) { (scope.listeners[type] = scope.listeners[type] || []).push(fn); },
    skipWaiting() {},
    shown: [],
    registration: {
      showNotification: (title, options) => { scope.shown.push({ title, options }); return Promise.resolve(); },
    },
    windows: [],
    opened: [],
    clients: {
      claim: async () => {},
      matchAll: async () => scope.windows,
      openWindow: async (url) => { scope.opened.push(url); },
    },
    caches: { open: async () => ({ add: async () => {}, put: async () => {}, match: async () => null }),
              keys: async () => [], delete: async () => true, match: async () => null },
    fetch: async () => new Response(""),
  };
  scope.self = scope;
  const src = fs.readFileSync(path.join(APP, "sw.js"), "utf8");
  new Function("self", "caches", "fetch", "addEventListener", "location", src)(
    scope, scope.caches, scope.fetch, scope.addEventListener.bind(scope), scope.location);
  return scope;
}

const fire = async (scope, type, event) => {
  const waits = [];
  const e = Object.assign({ waitUntil: (p) => waits.push(p) }, event);
  (scope.listeners[type] || []).forEach((fn) => fn(e));
  await Promise.all(waits);
  return e;
};

test("a push shows a notification, and a malformed one still shows something", async () => {
  const scope = workerScope();

  await fire(scope, "push", {
    data: { json: () => ({ id: "n1", title: "A lead replied", body: "Have a look", url: "/contacts/ct_1" }) },
  });
  assert.equal(scope.shown.length, 1);
  assert.equal(scope.shown[0].title, "A lead replied");
  assert.equal(scope.shown[0].options.body, "Have a look");
  assert.deepEqual(scope.shown[0].options.data, { url: "/contacts/ct_1" });
  assert.equal(scope.shown[0].options.tag, "n1",
    "tagged with the notification id, so a repeat replaces rather than stacks");
  assert.match(scope.shown[0].options.icon, /icon-192/);

  // An absolute URL is not a route and must not be followed.
  await fire(scope, "push", { data: { json: () => ({ title: "x", url: "https://evil.example" }) } });
  assert.deepEqual(scope.shown[1].options.data, { url: "/dashboard" });

  // A push with no payload at all: browsers send these, and showing
  // nothing can cost the site its permission.
  await fire(scope, "push", { data: { json: () => { throw new Error("not json"); } } });
  assert.equal(scope.shown[2].title, "RealtorOS");
  await fire(scope, "push", {});
  assert.equal(scope.shown.length, 4, "even an empty push shows something");
});

test("tapping a notification reuses an open window before opening another", async () => {
  const scope = workerScope();
  const focused = [];
  const navigated = [];
  scope.windows = [{
    url: "https://app.example.test/#/dashboard",
    focus: async () => { focused.push(1); },
    navigate: async (u) => { navigated.push(u); },
  }];

  let closed = 0;
  await fire(scope, "notificationclick", {
    notification: { close: () => { closed++; }, data: { url: "/contacts/ct_1" } },
  });
  assert.equal(closed, 1, "the notification goes away when tapped");
  assert.equal(focused.length, 1, "the window already open is the one to use");
  assert.deepEqual(navigated, ["./#/contacts/ct_1"]);
  assert.deepEqual(scope.opened, [], "no second copy of the app");

  // Nothing open: then, and only then, open a window.
  const fresh = workerScope();
  await fire(fresh, "notificationclick", {
    notification: { close: () => {}, data: { url: "/contacts" } },
  });
  assert.deepEqual(fresh.opened, ["./#/contacts"]);
});
