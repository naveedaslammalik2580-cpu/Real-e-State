// M-1: realtime follows the WORKSPACE, not the creator.
//
// Filtering postgres_changes on user_id meant a teammate's edit to a
// shared contact never reached this browser - the row belongs to them, so
// the socket never offered it. These tests pin the three things that fix
// has to get right: the filter column, waiting for a workspace id instead
// of subscribing without one, and rebuilding the channels when the active
// workspace changes.
//
// What is NOT tested here, because it is not this layer's job: who may see
// which rows. That is RLS. This filter only narrows what the client asks
// for.
import { test } from "node:test";
import assert from "node:assert/strict";
import { browser, SKIP_DOM } from "../helpers/browser.mjs";

const SCRIPTS = [
  "assets/js/config.js",
  "assets/js/core/utils.js",
  "assets/js/data/workspace.js",
  "assets/js/data/data-service.js",
];

/**
 * A jsdom window with App.data loaded over a recording stub client.
 * `permissions` is what realtoros_my_permissions returns, so a test can
 * decide whether a workspace exists and which one.
 */
// data-service.js starts a 30s retry setInterval when it loads, which in
// jsdom belongs to the window and keeps node's event loop alive. So every
// window this file opens is closed again, or the test process never exits.
const open = [];

async function ctx({ uid = "u-1", workspaceId = "ws-1" } = {}) {
  const b = await browser(SCRIPTS, { store: { getState: () => ({ settings: {}, metadata: {} }) } });
  if (!b) return null;
  open.push(b);

  const channels = [];
  const removed = [];
  let payload = workspaceId
    ? { workspace_id: workspaceId, role: "owner", member_id: "m-1", team_member_id: "tm-1", permissions: {} }
    : null;

  const makeChannel = (name) => {
    const ch = { name, subscribed: false, handlers: [] };
    // `type` is the channel event ("postgres_changes"); opts carries its
    // own `event` (the DB event, "*"), so the two are kept apart.
    ch.on = (type, opts) => { ch.handlers.push({ type, ...opts }); return ch; };
    ch.subscribe = () => { ch.subscribed = true; return ch; };
    return ch;
  };

  b.window.App.cloud = {
    getUser: () => ({ id: uid }),
    getClient: () => ({
      rpc: async () => ({ data: payload, error: null }),
      channel: (name) => { const ch = makeChannel(name); channels.push(ch); return ch; },
      removeChannel: (ch) => { removed.push(ch.name); },
    }),
  };

  return {
    ...b,
    channels,
    removed,
    data: b.window.App.data,
    ws: b.window.App.workspace,
    /** Change what the permissions RPC will answer next. */
    setWorkspace: (id) => {
      payload = id
        ? { workspace_id: id, role: "owner", member_id: "m-1", team_member_id: "tm-1", permissions: {} }
        : null;
    },
    /** The channels that actually subscribed. */
    live: () => channels.filter((c) => c.subscribed),
  };
}

function closeAll() {
  while (open.length) {
    const b = open.pop();
    try { b.close(); } catch (e) { /* already gone */ }
  }
}

function domTest(name, fn) {
  test(name, async (t) => {
    const c = await ctx();
    if (!c) return t.skip(SKIP_DOM);
    try { await fn(c); } finally { closeAll(); }
  });
}

// ------------------------------------------------- waiting for a workspace

domTest("with no workspace id yet, nothing is subscribed", async (c) => {
  // This is the real boot order: app.js calls subscribeRealtime() before
  // App.workspace.load() has resolved.
  assert.equal(c.ws.ready(), false);
  c.data.subscribeRealtime();
  assert.deepEqual(c.live(), [], "no channel may be opened without a workspace to filter on");
});

domTest("a member of no workspace never subscribes", async () => {
  const c = await ctx({ workspaceId: null });
  await c.ws.load();
  assert.equal(c.ws.id(), null);
  c.data.subscribeRealtime();
  assert.deepEqual(c.live(), [], "signed in but not an active member: nothing to listen to");
});

// ------------------------------------------------- the filter

domTest("every subscription filters on workspace_id, and none on user_id", async (c) => {
  await c.ws.load();
  c.data.subscribeRealtime();

  const live = c.live();
  assert.equal(live.length, 1, "one channel");
  const handlers = live[0].handlers;
  assert.ok(handlers.length > 1, "a handler per table");

  for (const h of handlers) {
    assert.equal(h.type, "postgres_changes");
    assert.equal(h.event, "*", "every event type, so a delete propagates too");
    assert.equal(h.schema, "public");
    assert.equal(h.filter, "workspace_id=eq.ws-1",
      `${h.table} must be filtered by workspace, not by creator`);
  }
  assert.equal(handlers.some((h) => String(h.filter).startsWith("user_id=")), false,
    "no handler may still filter on user_id");
});

domTest("workspace_settings is filtered by workspace too (T2d made it a workspace singleton)", async (c) => {
  await c.ws.load();
  c.data.subscribeRealtime();
  const settings = c.live()[0].handlers.filter((h) => h.table === "workspace_settings");
  assert.equal(settings.length, 1);
  assert.equal(settings[0].filter, "workspace_id=eq.ws-1");
});

domTest("the entity tables subscribed are the registry's own tables", async (c) => {
  await c.ws.load();
  c.data.subscribeRealtime();
  const tables = c.live()[0].handlers.map((h) => h.table);
  // A sample across the registry rather than the whole list, so adding an
  // entity does not break this test - but these must always be there.
  for (const t of ["contacts", "properties", "deals", "tasks", "team_members", "workspace_settings"]) {
    assert.ok(tables.includes(t), `${t} must be subscribed`);
  }
  assert.equal(new Set(tables).size, tables.length, "no table is subscribed twice");
});

// ------------------------------------------------- following a change

domTest("when the workspace arrives after subscribing, the channels are rebuilt", async (c) => {
  // Boot order again: subscribe first, workspace second.
  c.data.subscribeRealtime();
  assert.deepEqual(c.live(), [], "nothing yet");

  await c.ws.load(); // emits -> the watcher re-subscribes

  const live = c.live();
  assert.equal(live.length, 1, "the arriving workspace opened the channel");
  assert.equal(live[0].handlers[0].filter, "workspace_id=eq.ws-1");
});

domTest("changing the active workspace resubscribes and drops the old channel", async (c) => {
  await c.ws.load();
  c.data.subscribeRealtime();
  const firstName = c.live()[0].name;

  // A join, a leave or an ownership transfer: the context is reloaded and
  // comes back with a different workspace.
  c.setWorkspace("ws-2");
  await c.ws.load(true);

  const live = c.live();
  assert.equal(live.length, 2, "a second channel was opened");
  assert.equal(live[1].handlers[0].filter, "workspace_id=eq.ws-2",
    "the new channel follows the new workspace");
  assert.ok(c.removed.includes(firstName),
    "the old channel must be removed, not left listening to the old workspace");
});

domTest("reloading the same workspace does not churn the channels", async (c) => {
  await c.ws.load();
  c.data.subscribeRealtime();
  const before = c.live().length;
  const removedBefore = c.removed.length;

  await c.ws.load(true); // same workspace id comes back

  assert.equal(c.live().length, before, "no extra channel for the same workspace");
  assert.equal(c.removed.length, removedBefore, "and nothing was torn down");
});

domTest("unsubscribing removes the channel and leaves nothing listening", async (c) => {
  await c.ws.load();
  c.data.subscribeRealtime();
  const name = c.live()[0].name;

  c.data.unsubscribeRealtime();
  assert.ok(c.removed.includes(name));

  // Signing out resets the workspace; that must not quietly resubscribe.
  c.setWorkspace(null);
  c.ws.reset();
  assert.equal(c.removed.filter((n) => n === name).length, 1,
    "no second teardown, and no new channel for a signed-out user");
});
