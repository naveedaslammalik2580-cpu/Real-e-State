// Settings saves: the filter that has to be on every write, and the
// retry that has to stop.
//
// What happened. Commit 24e9417 ("T2d: the frontend becomes
// workspace-aware") replaced the per-user filter on four
// workspace_settings writes and never added the per-workspace one that
// was meant to take its place. PostgREST refuses an UPDATE with no
// filter outright - 400, "UPDATE requires a WHERE clause" - so every
// settings save failed, and the 30-second sync retry re-sent each one
// for ever. Seventy failures in a morning, no successful save in 24
// hours, and a toast that said "Sync failed — Retry" without ever
// saying why.
//
// So three things are pinned here, and the second is the one a reader
// should not skip: an unfiltered request must never be BUILT. Waiting
// is recoverable; a request the server has already refused is not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { browser, SKIP_DOM } from "../helpers/browser.mjs";

const SCRIPTS = [
  "assets/js/config.js",
  "assets/js/core/utils.js",
  "assets/js/data/workspace.js",
  "assets/js/data/data-service.js",
];

// data-service.js starts a 30s retry setInterval on load, which belongs
// to the jsdom window and keeps node's event loop alive. Every window
// opened here is closed again or the process never exits.
const open = [];
function closeAll() {
  while (open.length) {
    const b = open.pop();
    try { b.close(); } catch (e) { /* already gone */ }
  }
}

/**
 * A recording stub of the Supabase client, detailed enough to tell a
 * filtered request from an unfiltered one.
 *
 * Every builder records the filters applied to it, so a test can assert
 * on what WOULD have gone over the wire rather than on a result.
 */
function stubClient({ rows = {}, failWith = null, permissions = { workspace_id: "ws-1" } } = {}) {
  const requests = [];

  function builder(table, op) {
    const req = { table, op, filters: [], payload: null };
    requests.push(req);
    const self = {
      select: () => self,
      single: () => self,
      maybeSingle: () => self,
      is: (c, v) => { req.filters.push(["is", c, v]); return self; },
      eq: (c, v) => { req.filters.push(["eq", c, v]); return self; },
      in: (c, v) => { req.filters.push(["in", c, v]); return self; },
      order: () => self,
      range: () => self,
      limit: () => self,
      then: (resolve, reject) => {
        const answer = failWith && failWith.table === table && failWith.op === op
          ? { data: null, error: failWith.error }
          : { data: rows[table] !== undefined ? rows[table] : {}, error: null, count: 0 };
        return Promise.resolve(answer).then(resolve, reject);
      },
    };
    return self;
  }

  return {
    requests,
    client: {
      rpc: async () => ({ data: permissions, error: null }),
      from: (table) => ({
        select: (...a) => { const b = builder(table, "select"); return b.select(...a); },
        update: (payload) => { const b = builder(table, "update"); requests[requests.length - 1].payload = payload; return b; },
        upsert: (payload) => { const b = builder(table, "upsert"); requests[requests.length - 1].payload = payload; return b; },
        insert: (payload) => { const b = builder(table, "insert"); requests[requests.length - 1].payload = payload; return b; },
        delete: () => builder(table, "delete"),
      }),
      channel: () => ({ on: function () { return this; }, subscribe: function () { return this; } }),
      removeChannel: () => {},
    },
  };
}

async function ctx(opts = {}) {
  const b = await browser(SCRIPTS, { store: { getState: () => ({ settings: {}, metadata: {} }) } });
  if (!b) return null;
  open.push(b);
  const stub = stubClient(opts);
  b.window.App.cloud = { getUser: () => ({ id: "u-1" }), getClient: () => stub.client };
  // A settings row already loaded, so a save is a plain update.
  b.window.App.data._setSettingsCacheForTest
    ? b.window.App.data._setSettingsCacheForTest()
    : null;
  return Object.assign({}, b, {
    requests: stub.requests,
    data: b.window.App.data,
    ws: b.window.App.workspace,
    writes: (table) => stub.requests.filter((r) => r.table === table && r.op === "update"),
  });
}

function domTest(name, fn) {
  test(name, async (t) => {
    const probe = await browser(SCRIPTS, { store: { getState: () => ({ settings: {}, metadata: {} }) } });
    if (!probe) return t.skip(SKIP_DOM);
    try { probe.close(); } catch (e) {}
    try { await fn(); } finally { closeAll(); }
  });
}

// String(null) rather than join's empty string, so `is read_at null`
// reads as what it is.
const filtersOf = (req) => req.filters.map((f) => f.map((x) => String(x)).join(":"));

// ---------------------------------------------------------------- the filter

domTest("every settings update names the workspace it is updating", async () => {
  const p = await ctx();
  await p.ws.load();
  await p.data.updateSettings({ ui: { theme: "dark" } });

  const updates = p.writes("workspace_settings");
  assert.equal(updates.length, 1, "one write");
  assert.deepEqual(filtersOf(updates[0]), ["eq:workspace_id:ws-1"],
    "with a WHERE clause, which is the whole bug: " + JSON.stringify(updates[0].filters));
});

domTest("the metadata write and the legacy-blob delete are filtered too", async () => {
  const p = await ctx();
  await p.ws.load();
  await p.data.updateMetadata({ lastBackupAt: "2026-10-16T00:00:00Z" });

  const updates = p.writes("workspace_settings");
  assert.equal(updates.length, 1);
  assert.deepEqual(filtersOf(updates[0]), ["eq:workspace_id:ws-1"]);

  // Every update and delete this module builds, checked in one go: a
  // second unfiltered write would be the same outage again.
  const unfiltered = p.requests
    .filter((r) => (r.op === "update" || r.op === "delete") && r.filters.length === 0);
  assert.deepEqual(unfiltered, [], "no unfiltered write of any kind: " + JSON.stringify(unfiltered));
});

domTest("with no workspace loaded, nothing is sent at all", async () => {
  // The permissions call answers with no workspace - a session mid-load,
  // or one whose workspace could not be resolved.
  const p = await ctx({ permissions: null });

  await assert.rejects(
    p.data.updateSettings({ ui: { theme: "dark" } }),
    /still loading|workspace/i,
    "it refuses rather than guessing");

  const updates = p.writes("workspace_settings");
  assert.equal(updates.length, 0,
    "and builds no request: an unfiltered UPDATE is a 400, not a save: " + JSON.stringify(updates));

  // This one IS worth retrying - the workspace may be a moment away.
  const sync = p.data.getSyncState();
  assert.equal(sync.status, "error");
  assert.equal(typeof sync.retry, "function", "so the retry is kept");
});

// ---------------------------------------------------------------- the retry

domTest("a permanent 400 stops after one clear message", async () => {
  const p = await ctx({
    failWith: {
      table: "workspace_settings", op: "update",
      error: { status: 400, code: "PGRST102", message: "UPDATE requires a WHERE clause" },
    },
  });
  await p.ws.load();

  await assert.rejects(p.data.updateSettings({ ui: { theme: "dark" } }));

  const sync = p.data.getSyncState();
  assert.equal(sync.status, "error");
  assert.equal(sync.retry, null,
    "no retry: the 30-second queue would re-send this for ever and the server would refuse it every time");
  assert.match(sync.message, /Could not save your settings/i,
    "and one message that says what happened: " + sync.message);
  assert.ok(!/Retry/i.test(sync.message), "not an invitation to try the impossible");
  assert.equal(p.writes("workspace_settings").length, 1, "tried once, not nine times");
});

domTest("a transient failure retries, and gives up after three", async () => {
  const p = await ctx({
    failWith: {
      table: "workspace_settings", op: "update",
      // No status and no PostgREST code: a dropped connection, which is
      // exactly what the retry is for.
      error: { message: "network error" },
    },
  });
  await p.ws.load();

  await assert.rejects(p.data.updateSettings({ ui: { theme: "dark" } }));
  let sync = p.data.getSyncState();
  assert.match(sync.message, /Retry/i, "first failure: worth another go");
  assert.equal(typeof sync.retry, "function");

  // The queue's own retry, twice more.
  await sync.retry().catch(() => {});
  sync = p.data.getSyncState();
  assert.equal(typeof sync.retry, "function", "second failure: still worth it");

  await sync.retry().catch(() => {});
  sync = p.data.getSyncState();
  assert.equal(sync.retry, null, "third: stop, and say so");
  assert.match(sync.message, /Could not save your settings/i);
  assert.equal(p.writes("workspace_settings").length, 3,
    "three attempts, then silence - not seventy: " + p.writes("workspace_settings").length);
});

// ---------------------------------------------------------------- personal

domTest("notifications are read and written as the caller's own", async () => {
  const p = await ctx({ rows: { notifications: [] } });
  await p.ws.load();

  await p.data.markAllNotificationsRead();
  const all = p.requests.filter((r) => r.table === "notifications" && r.op === "update");
  assert.equal(all.length, 1);
  assert.ok(filtersOf(all[0]).includes("eq:user_id:u-1"),
    '"all" means all of mine: ' + JSON.stringify(all[0].filters));
  assert.ok(filtersOf(all[0]).includes("is:read_at:null"), "and only the unread ones");

  await p.data.markNotificationRead("11111111-2222-3333-4444-555555555555");
  const one = p.requests.filter((r) => r.table === "notifications" && r.op === "update")[1];
  assert.ok(filtersOf(one).includes("eq:user_id:u-1"));

  await p.data.countUnreadNotifications();
  await p.data.listNotifications({});
  const reads = p.requests.filter((r) => r.table === "notifications" && r.op === "select");
  assert.equal(reads.length, 2);
  reads.forEach((r) => assert.ok(filtersOf(r).includes("eq:user_id:u-1"),
    "a notification belongs to one person: " + JSON.stringify(r.filters)));
});
