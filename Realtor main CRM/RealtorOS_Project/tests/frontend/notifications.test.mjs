// Phase 4H frontend: the notification bell, panel and /notifications page.
// Real page scripts in jsdom with a stub App.store; the data service is
// exercised with a fake Supabase query builder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { browser, settle, SKIP_DOM } from "../helpers/browser.mjs";

const plain = (v) => JSON.parse(JSON.stringify(v));
const deq = (a, b, m) => assert.deepEqual(plain(a), plain(b), m);
const SCRIPTS = ["assets/js/core/utils.js", "assets/js/app.js", "assets/js/pages/notifications.js"];
const minsAgo = (m) => new Date(Date.now() - m * 60000).toISOString();

function makeStore(rows) {
  const data = rows.map((r) => ({ read_at: null, body: "", contact_id: null, link_route: null, ...r }));
  const calls = { unreadCount: 0, list: [], markRead: [], markAll: 0, contactUpdates: [] };
  const store = {
    getState: () => ({ settings: {}, metadata: {} }),
    notifications: {
      unreadCount: async () => { calls.unreadCount++; return data.filter((n) => !n.read_at).length; },
      list: async (opts = {}) => {
        calls.list.push(opts);
        let r = data;
        if (opts.filter === "unread") r = r.filter((n) => !n.read_at);
        if (opts.filter === "hot") r = r.filter((n) => n.type === "hot_reply");
        const off = opts.offset || 0;
        return { rows: r.slice(off, off + (opts.limit || 20)), total: r.length };
      },
      markRead: async (id) => { calls.markRead.push(id); const n = data.find((x) => x.id === id); if (n && !n.read_at) n.read_at = new Date().toISOString(); },
      markAllRead: async () => { calls.markAll++; data.forEach((n) => { if (!n.read_at) n.read_at = new Date().toISOString(); }); },
    },
    contacts: { update: async (id, patch) => { calls.contactUpdates.push([id, patch]); return { id }; } },
  };
  return { store, calls, data };
}

const ROWS = [
  { id: "00000000-0000-4000-8000-000000000001", type: "hot_reply", title: "🔥 Sarah Ahmed replied — asked about a viewing", contact_id: "ct_1", link_route: "/contacts/ct_1", created_at: minsAgo(5) },
  { id: "00000000-0000-4000-8000-000000000002", type: "import_finished", title: "File upload finished: 3 added", link_route: "/settings/sheet-imports", created_at: minsAgo(90) },
  { id: "00000000-0000-4000-8000-000000000003", type: "lead_replied", title: "Pat replied to your follow-up", contact_id: "ct_2", link_route: "https://evil.example.com", created_at: minsAgo(60 * 30), read_at: minsAgo(10) },
  { id: "00000000-0000-4000-8000-000000000004", type: "followup_failed", title: "<img src=x onerror=alert(1)>", body: "<script>alert(2)</script>", link_route: "/automation", created_at: minsAgo(0.2) },
];

async function mounted(t, rows = ROWS, opts = {}) {
  const s = makeStore(rows);
  const b = await browser(SCRIPTS, { store: s.store });
  if (!b) { t.skip(SKIP_DOM); return null; }
  const nav = [];
  b.window.App.app.navigate = (r) => nav.push(r);
  const host = b.document.createElement("div");
  const outside = b.document.createElement("button");
  b.document.body.append(host, outside);
  b.window.App.notificationsUI.mount(host, opts);
  await settle(b.window);
  const $ = (sel) => host.querySelector(sel);
  const done = () => { b.window.App.notificationsUI.stop(); b.close(); };
  return { ...b, ...s, nav, host, outside, $, done };
}

async function openPanel(d) {
  d.$("#notifBell").click();
  await settle(d.window);
}

test("badge: hidden at 0, the count up to 9, then 9+; the bell's name says how many", async (t) => {
  const d = await mounted(t);
  if (!d) return;
  assert.equal(d.$("#notifBadge").textContent, "3");
  assert.equal(d.$("#notifBadge").hidden, false);
  assert.equal(d.$("#notifBell").getAttribute("aria-label"), "Notifications, 3 unread");
  d.done();
  const none = await mounted(t, []);
  assert.equal(none.$("#notifBadge").hidden, true);
  assert.equal(none.$("#notifBell").getAttribute("aria-label"), "Notifications");
  none.done();
  const many = await mounted(t, Array.from({ length: 12 }, (_, i) => ({ id: `00000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`, type: "import_finished", title: `n${i}`, created_at: minsAgo(i) })));
  assert.equal(many.$("#notifBadge").textContent, "9+");
  many.done();
  const U = none.window.App.notificationsUI;
  assert.deepEqual([0, 1, 9, 10].map(U.badgeText), ["", "1", "9", "9+"]);
});

test("panel: latest 20, newest first, unread highlighted, relative times, type icons; Escape closes and returns focus", async (t) => {
  const d = await mounted(t);
  if (!d) return;
  await openPanel(d);
  assert.equal(d.$("#notifBell").getAttribute("aria-expanded"), "true");
  assert.equal(d.$("#notifPanel").hidden, false);
  assert.equal(d.document.activeElement.id, "notifPanelTitle", "focus moves into the panel");
  deq(d.calls.list.at(-1), { limit: 20 });
  const items = [...d.host.querySelectorAll(".notif-item")];
  assert.equal(items.length, 4);
  deq(items.map((i) => i.classList.contains("notif-unread")), [true, true, false, true]);
  const text = d.host.textContent.replace(/\s+/g, " ");
  assert.match(text, /5 min ago/);
  assert.match(text, /1 hour ago/);
  assert.match(text, /yesterday/);
  assert.match(text, /just now/);
  assert.ok(d.host.querySelector(".notif-tone-hot svg"), "hot icon");
  d.document.dispatchEvent(new d.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(d.$("#notifPanel").hidden, true);
  assert.equal(d.document.activeElement.id, "notifBell");
  d.done();
});

test("panel: a click outside closes it; the bell toggles it", async (t) => {
  const d = await mounted(t);
  if (!d) return;
  await openPanel(d);
  d.outside.click();
  assert.equal(d.$("#notifPanel").hidden, true);
  await openPanel(d);
  d.$("#notifBell").click();
  assert.equal(d.$("#notifPanel").hidden, true);
  d.done();
});

test("clicking a notification marks it read and goes to its allow-listed route", async (t) => {
  const d = await mounted(t);
  if (!d) return;
  await openPanel(d);
  d.host.querySelector(`[data-notif-open="${ROWS[0].id}"]`).click();
  await settle(d.window);
  deq(d.calls.markRead, [ROWS[0].id]);
  deq(d.nav, ["/contacts/ct_1"]);
  assert.equal(d.$("#notifPanel").hidden, true);
  assert.equal(d.$("#notifBadge").textContent, "2");
  d.done();
});

test("an external or unknown link is never followed; an already-read one is not re-marked", async (t) => {
  const d = await mounted(t);
  if (!d) return;
  await openPanel(d);
  d.host.querySelector(`[data-notif-open="${ROWS[2].id}"]`).click();
  await settle(d.window);
  deq(d.calls.markRead, [], "already read");
  deq(d.nav, [], "https link ignored");
  const U = d.window.App.notificationsUI;
  deq(["/contacts/ct_1", "/settings/sheet-imports", "/automation", "/notifications", "/contacts"].map(U.safeRoute),
    ["/contacts/ct_1", "/settings/sheet-imports", "/automation", "/notifications", "/contacts"]);
  for (const bad of ["https://x.com", "//x.com", "javascript:alert(1)", "/contacts/../settings", "/settings/team", "/automation?x", null, 42]) {
    assert.equal(U.safeRoute(bad), null, String(bad));
  }
  d.done();
});

test("mark all as read clears the badge", async (t) => {
  const d = await mounted(t);
  if (!d) return;
  await openPanel(d);
  d.host.querySelector('[data-role="notif-mark-all"]').click();
  await settle(d.window);
  assert.equal(d.calls.markAll, 1);
  assert.equal(d.$("#notifBadge").hidden, true);
  assert.equal(d.host.querySelectorAll(".notif-unread").length, 0);
  d.done();
});

test("every notification text is escaped", async (t) => {
  const d = await mounted(t);
  if (!d) return;
  await openPanel(d);
  assert.equal(d.host.querySelector("img"), null);
  assert.equal(d.host.querySelector("script"), null);
  assert.ok(d.host.textContent.includes("<img src=x onerror=alert(1)>"));
  assert.ok(d.host.textContent.includes("<script>alert(2)</script>"));
  d.done();
});

test("Mark as Hot: only on replies with a contact; sets temperature Hot through the contact update", async (t) => {
  const d = await mounted(t);
  if (!d) return;
  await openPanel(d);
  const hotButtons = [...d.host.querySelectorAll("[data-notif-hot]")].map((b) => b.getAttribute("data-notif-hot"));
  deq(hotButtons, [ROWS[0].id, ROWS[2].id]);
  const btn = d.host.querySelector(`[data-notif-hot="${ROWS[2].id}"]`);
  btn.click();
  await settle(d.window);
  deq(d.calls.contactUpdates, [["ct_2", { temperature: "Hot" }]]);
  assert.equal(btn.textContent, "Marked as Hot");
  assert.equal(btn.disabled, true);
  deq(d.nav, [], "marking hot does not navigate");
  assert.ok(d.toasts.some((x) => /marked as Hot/.test(x.message)));
  d.done();
});

test("polling: the count refreshes on a timer while visible, pauses while hidden, and refreshes on focus", async (t) => {
  const d = await mounted(t, ROWS, { pollMs: 15 });
  if (!d) return;
  let visibility = "visible";
  Object.defineProperty(d.document, "visibilityState", { configurable: true, get: () => visibility });
  const U = d.window.App.notificationsUI;
  const start = d.calls.unreadCount;
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(d.calls.unreadCount >= start + 2, "polled while visible");
  assert.equal(U._isPolling(), true);

  visibility = "hidden";
  d.document.dispatchEvent(new d.window.Event("visibilitychange"));
  assert.equal(U._isPolling(), false);
  const paused = d.calls.unreadCount;
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(d.calls.unreadCount, paused, "no polling while hidden");

  visibility = "visible";
  d.document.dispatchEvent(new d.window.Event("visibilitychange"));
  assert.equal(U._isPolling(), true);
  assert.ok(d.calls.unreadCount > paused, "refreshed on becoming visible");

  const beforeFocus = d.calls.unreadCount;
  d.window.dispatchEvent(new d.window.Event("focus"));
  assert.ok(d.calls.unreadCount > beforeFocus, "refreshed on focus");
  d.done();
  assert.equal(U._isPolling(), false, "stop() ends polling");
});

test("/notifications page: filters, paging, mark all as read, item actions", async (t) => {
  const rows = Array.from({ length: 30 }, (_, i) => ({
    id: `00000000-0000-4000-8000-0000000002${String(i).padStart(2, "0")}`,
    type: i % 3 === 0 ? "hot_reply" : "import_finished",
    title: `Item ${i}`, created_at: minsAgo(i), contact_id: i % 3 === 0 ? `ct_${i}` : null,
    link_route: i % 3 === 0 ? `/contacts/ct_${i}` : "/settings/sheet-imports",
  }));
  const s = makeStore(rows);
  const b = await browser(SCRIPTS, { store: s.store });
  if (!b) return t.skip(SKIP_DOM);
  const nav = [];
  b.window.App.app.navigate = (r) => nav.push(r);
  b.window.App.notificationsUI.refresh = async () => {};
  const page = b.document.createElement("main");
  b.document.body.appendChild(page);
  await b.window.App.pages.notifications.render(page);
  await settle(b.window);

  const filters = [...page.querySelectorAll("[data-filter]")].map((x) => x.textContent);
  deq(filters, ["All", "Unread", "Replies", "Hot", "Imports", "Problems"]);
  assert.equal(page.querySelectorAll(".notif-item").length, 25);
  deq(s.calls.list.at(-1), { filter: "all", limit: 25, offset: 0 });
  assert.match(page.textContent.replace(/\s+/g, " "), /1–25 of 30/);
  page.querySelector('[data-role="notif-next"]').click();
  await settle(b.window);
  deq(s.calls.list.at(-1), { filter: "all", limit: 25, offset: 25 });
  assert.equal(page.querySelectorAll(".notif-item").length, 5);

  page.querySelector('[data-filter="hot"]').click();
  await settle(b.window);
  deq(s.calls.list.at(-1), { filter: "hot", limit: 25, offset: 0 });
  assert.equal(page.querySelector('[data-filter="hot"]').getAttribute("aria-pressed"), "true");
  assert.equal(page.querySelector('[data-filter="all"]').getAttribute("aria-pressed"), "false");
  assert.equal(page.querySelectorAll(".notif-item").length, 10);

  page.querySelector(".notif-open").click();
  await settle(b.window);
  deq(nav, ["/contacts/ct_0"]);

  page.querySelector('[data-role="notif-page-mark-all"]').click();
  await settle(b.window);
  assert.equal(s.calls.markAll, 1);
  page.querySelector('[data-filter="unread"]').click();
  await settle(b.window);
  assert.match(page.textContent, /Nothing here for this filter\./);
  b.close();
});

test("relative time wording", async (t) => {
  const b = await browser(SCRIPTS, { store: makeStore([]).store });
  if (!b) return t.skip(SKIP_DOM);
  const rt = b.window.App.notificationsUI.relativeTime;
  const now = "2026-09-29T12:00:00Z";
  deq(["2026-09-29T11:59:40Z", "2026-09-29T11:55:00Z", "2026-09-29T11:00:00Z", "2026-09-29T09:00:00Z", "2026-09-28T11:00:00Z", "2026-09-25T12:00:00Z"]
    .map((x) => rt(x, now)), ["just now", "5 min ago", "1 hour ago", "3 hours ago", "yesterday", "4 days ago"]);
  assert.equal(rt("not a date", now), "");
  b.close();
});

// ---------------------------------------------------------------- data service

// A chainable stand-in for the Supabase query builder: records every call,
// resolves to the given result when awaited.
function fakeClient(result = { data: [], error: null, count: 0 }) {
  const log = [];
  const builder = () => {
    const calls = [];
    const q = new Proxy({}, {
      get(_, prop) {
        if (prop === "then") return (res, rej) => Promise.resolve(result).then(res, rej);
        return (...args) => { calls.push([prop, ...args]); return q; };
      },
    });
    return { q, calls };
  };
  return {
    log,
    client: { from: (table) => { const b = builder(); log.push({ table, calls: b.calls }); return b.q; } },
  };
}

async function dataService(t, result) {
  const b = await browser(["assets/js/core/utils.js", "assets/js/data/data-service.js"]);
  if (!b) { t.skip(SKIP_DOM); return null; }
  const fc = fakeClient(result);
  b.window.App.cloud = { getUser: () => ({ id: "44444444-4444-4444-8444-444444444444" }), getClient: () => fc.client };
  return { ...b, fc, D: b.window.App.data };
}

// The owner filter is back, and this test says so where it used to say
// the opposite.
//
// T2d (24e9417) stripped `.eq("user_id", ...)` from all four of these
// along with every other per-user filter, on the reasoning that
// workspace RLS made them wrong in both directions. That reasoning does
// not apply to notifications: notifications_select_scoped is
// `workspace_id = my_workspace_id() AND user_id = auth.uid()`, so these
// rows are strictly personal and always were. The filter narrows
// nothing and hides nothing - it makes the request say what the policy
// already enforces, which is how a reader can tell "all" means "all of
// mine" without going to look the policy up.
test("data service: list with filters, unread count, mark read, mark all read — own rows, said out loud", async (t) => {
  const d = await dataService(t, { data: [{ id: "x" }], error: null, count: 7 });
  if (!d) return;
  // Every window this test opens carries data-service's 30-second retry
  // interval, which keeps node's event loop alive. Without the finally
  // a failing assertion does not fail the run - it hangs it.
  try {
  const ME = "44444444-4444-4444-8444-444444444444";
  const r = await d.D.listNotifications({ filter: "replies", limit: 20, offset: 0 });
  deq(r, { rows: [{ id: "x" }], total: 7, limit: 20, offset: 0 });
  const calls = (i) => plain(d.fc.log[i].calls);
  assert.equal(d.fc.log[0].table, "notifications");
  deq(calls(0).filter((c) => ["eq", "in", "is", "range"].includes(c[0])),
    [["eq", "user_id", ME], ["in", "type", ["lead_replied", "hot_reply"]], ["range", 0, 19]]);
  await d.D.listNotifications({ filter: "unread" });
  deq(calls(1).filter((c) => ["in", "is"].includes(c[0])), [["is", "read_at", null]]);
  await d.D.listNotifications({ filter: "problems" });
  deq(calls(2).find((c) => c[0] === "in"), ["in", "type", ["unsubscribed", "spam_report", "email_bounced", "followup_failed"]]);
  await assert.rejects(d.D.listNotifications({ filter: "everything" }), /Invalid notification filter/);

  assert.equal(await d.D.countUnreadNotifications(), 7);
  deq(calls(3).filter((c) => ["eq", "is"].includes(c[0])),
    [["eq", "user_id", ME], ["is", "read_at", null]]);

  await d.D.markNotificationRead("00000000-0000-4000-8000-000000000001");
  const upd = calls(4);
  assert.deepEqual(Object.keys(upd.find((c) => c[0] === "update")[1]), ["read_at"], "only read_at is ever written");
  deq(upd.filter((c) => ["eq", "is"].includes(c[0])),
    [["eq", "user_id", ME], ["eq", "id", "00000000-0000-4000-8000-000000000001"], ["is", "read_at", null]]);
  await assert.rejects(d.D.markNotificationRead("not-an-id"), /valid notification id/);

  await d.D.markAllNotificationsRead();
  const all = calls(5);
  assert.deepEqual(Object.keys(all.find((c) => c[0] === "update")[1]), ["read_at"]);
  deq(all.filter((c) => ["eq", "is"].includes(c[0])),
    [["eq", "user_id", ME], ["is", "read_at", null]],
    '"mark all read" means all of mine - without the filter the request asks for everybody\'s');

  // Every one of the six, including the three reads.
  for (let i = 0; i <= 5; i++) {
    assert.equal(calls(i).some((c) => c[0] === "eq" && c[1] === "user_id" && c[2] === ME), true,
      `call ${i} must name its owner`);
  }
  } finally {
    d.close();
  }
});
