// Phase T2d: the frontend becomes workspace-aware.
//
// Two things are tested here, and they are different in kind:
//
//   1. App.workspace - the permission context. One RPC per session,
//      cached, and every accessor answers "no access" before it loads so
//      a page that renders early hides rather than reveals.
//   2. The nav and route guards - which sections a member can reach.
//      Hiding is a courtesy; RLS is the control. These tests only check
//      that the courtesy is applied consistently in both places, so a
//      hidden page cannot be reached by typing its URL.
import { test } from "node:test";
import assert from "node:assert/strict";
import { browser, SKIP_DOM } from "../helpers/browser.mjs";

const WS = ["assets/js/data/workspace.js"];
const APP = ["assets/js/core/utils.js", "assets/js/data/workspace.js", "assets/js/app.js"];

const OWNER = {
  workspace_id: "ws-1", role: "owner",
  team_member_id: "tm-owner", member_id: "m-owner",
  permissions: {
    contacts: { view: "all", edit: "all", delete: "all", create: true },
    deals: { view: "all", edit: "all", delete: "all", create: true },
    work: { view: "all", edit: "all", delete: "all", create: true },
    properties: { view: "all", edit: "all", delete: "all", create: true },
    finance: { view: "all", edit: "all", delete: "all", create: true },
    goals: { view: "all", edit: "all", delete: "all", create: true },
    contacts_assign: true, unassigned_view: true, unassigned_claim: true,
    templates_manage_shared: true, templates_create_personal: true,
    automation_manage_shared: true, automation_create_personal: true,
    imports_file: true, integrations_manage: true, team_manage: true,
    settings: "edit"
  }
};

const AGENT = {
  workspace_id: "ws-1", role: "agent",
  team_member_id: "tm-agent", member_id: "m-agent",
  permissions: {
    contacts: { view: "own", edit: "own", delete: "none", create: true },
    deals: { view: "own", edit: "own", delete: "none", create: true },
    work: { view: "own", edit: "own", delete: "own", create: true },
    properties: { view: "all", edit: "own", delete: "own", create: true },
    finance: { view: "none", edit: "none", delete: "none", create: false },
    goals: { view: "own", edit: "own", delete: "own", create: true },
    contacts_assign: false, unassigned_view: false, unassigned_claim: false,
    templates_manage_shared: false, templates_create_personal: true,
    automation_manage_shared: false, automation_create_personal: true,
    imports_file: true, integrations_manage: false, team_manage: false,
    settings: "none"
  }
};

/** A jsdom window with App.workspace loaded and a stub RPC. */
async function ctx(payload, { scripts = WS, uid = "u-1", failRpc = false } = {}) {
  const b = await browser(scripts, { store: { getState: () => ({ settings: {}, metadata: {} }) } });
  if (!b) return null;
  const calls = { rpc: [] };
  b.window.App.cloud = {
    getUser: () => ({ id: uid }),
    getClient: () => ({
      rpc: async (name) => {
        calls.rpc.push(name);
        if (failRpc) return { data: null, error: new Error("boom") };
        return { data: payload, error: null };
      }
    })
  };
  return { ...b, calls, ws: b.window.App.workspace };
}

function domTest(name, fn) {
  test(name, async (t) => {
    const probe = await browser(WS, {});
    if (!probe) return t.skip(SKIP_DOM);
    await fn();
  });
}

// ---------------------------------------------------------------- context

domTest("before load, every accessor answers no access", async () => {
  const c = await ctx(OWNER);
  assert.equal(c.ws.ready(), false);
  assert.equal(c.ws.id(), null);
  assert.equal(c.ws.role(), null);
  assert.equal(c.ws.isOwner(), false);
  // The important direction: an unloaded context must never grant.
  assert.equal(c.ws.can("team_manage"), false);
  assert.equal(c.ws.canView("contacts"), false);
  assert.equal(c.ws.canCreate("contacts"), false);
  assert.equal(c.ws.scope("contacts", "view"), "none");
  assert.equal(c.ws.settingsLevel(), "none");
  assert.equal(c.ws.canEditSettings(), false);
});

domTest("the owner's context reads back as full access", async () => {
  const c = await ctx(OWNER);
  await c.ws.load();
  assert.equal(c.ws.ready(), true);
  assert.equal(c.ws.id(), "ws-1");
  assert.equal(c.ws.role(), "owner");
  assert.equal(c.ws.isOwner(), true);
  assert.equal(c.ws.teamMemberId(), "tm-owner");
  assert.equal(c.ws.can("team_manage"), true);
  assert.equal(c.ws.seesAll("contacts"), true);
  assert.equal(c.ws.canEditSettings(), true);
});

domTest("the agent's context reflects the preset, including what it denies", async () => {
  const c = await ctx(AGENT);
  await c.ws.load();
  assert.equal(c.ws.role(), "agent");
  assert.equal(c.ws.isOwner(), false);
  assert.equal(c.ws.scope("contacts", "view"), "own");
  assert.equal(c.ws.scope("contacts", "delete"), "none");
  assert.equal(c.ws.seesAll("contacts"), false);
  assert.equal(c.ws.seesAll("properties"), true, "properties view is 'all' in the preset");
  assert.equal(c.ws.canView("finance"), false);
  assert.equal(c.ws.canCreate("finance"), false);
  assert.equal(c.ws.can("imports_file"), true);
  assert.equal(c.ws.can("team_manage"), false);
  assert.equal(c.ws.canViewSettings(), false);
});

domTest("load is cached: concurrent and repeat callers share one RPC", async () => {
  const c = await ctx(OWNER);
  await Promise.all([c.ws.load(), c.ws.load(), c.ws.load()]);
  await c.ws.load();
  assert.equal(c.calls.rpc.length, 1, `one RPC, got ${c.calls.rpc.length}`);
  assert.deepEqual(c.calls.rpc, ["realtoros_my_permissions"]);
});

domTest("force refreshes after a role change", async () => {
  const c = await ctx(OWNER);
  await c.ws.load();
  await c.ws.load(true);
  assert.equal(c.calls.rpc.length, 2);
});

domTest("reset clears the context back to no access", async () => {
  const c = await ctx(OWNER);
  await c.ws.load();
  assert.equal(c.ws.can("team_manage"), true);
  c.ws.reset();
  assert.equal(c.ws.ready(), false);
  assert.equal(c.ws.can("team_manage"), false, "signing out must not leave permissions behind");
});

domTest("a member of no workspace gets no access, not an error", async () => {
  // realtoros_my_permissions returns null for a signed-in user with no
  // active membership. That is a state to render, not a crash.
  const c = await ctx(null);
  const state = await c.ws.load();
  assert.equal(state.workspaceId, null);
  assert.equal(c.ws.ready(), true, "loaded, just with nothing in it");
  assert.equal(c.ws.canView("contacts"), false);
  assert.equal(c.ws.canViewSettings(), false);
});

domTest("an RPC failure rejects and leaves the context closed", async () => {
  const c = await ctx(OWNER, { failRpc: true });
  await assert.rejects(() => c.ws.load());
  assert.equal(c.ws.ready(), false);
  assert.equal(c.ws.can("team_manage"), false);
});

// ---------------------------------------------------------------- own rows

domTest("ownsRow matches the RLS definition of own: assigned to me, or created by me", async () => {
  const c = await ctx(AGENT, { uid: "u-agent" });
  await c.ws.load();
  assert.equal(c.ws.ownsRow({ assigned_to_id: "tm-agent" }), true, "assigned to me");
  assert.equal(c.ws.ownsRow({ user_id: "u-agent" }), true, "created by me");
  assert.equal(c.ws.ownsRow({ assigned_to_id: "tm-other", user_id: "u-other" }), false);
  assert.equal(c.ws.ownsRow({}), false);
  assert.equal(c.ws.ownsRow(null), false);
  // camelCase and the scheduled_items spelling both resolve.
  assert.equal(c.ws.ownsRow({ assignedToId: "tm-agent" }), true);
  assert.equal(c.ws.ownsRow({ assigned_to: "tm-agent" }), true);
});

domTest("canEditRow and canDeleteRow apply the area scope to the row", async () => {
  const c = await ctx(AGENT, { uid: "u-agent" });
  await c.ws.load();
  const mine = { assigned_to_id: "tm-agent" };
  const theirs = { assigned_to_id: "tm-other", user_id: "u-other" };

  // contacts: edit own, delete none.
  assert.equal(c.ws.canEditRow("contacts", mine), true);
  assert.equal(c.ws.canEditRow("contacts", theirs), false);
  assert.equal(c.ws.canDeleteRow("contacts", mine), false, "delete scope is none, even for my own");

  // work: delete own.
  assert.equal(c.ws.canDeleteRow("work", mine), true);
  assert.equal(c.ws.canDeleteRow("work", theirs), false);

  // An owner's 'all' scope ignores ownership.
  const o = await ctx(OWNER, { uid: "u-owner" });
  await o.ws.load();
  assert.equal(o.ws.canEditRow("contacts", theirs), true);
  assert.equal(o.ws.canDeleteRow("contacts", theirs), true);
});

// ---------------------------------------------------------------- nav + routes

/** Boot app.js with a workspace context already loaded. */
async function app(payload) {
  const b = await browser(APP, {
    store: {
      getState: () => ({ settings: {}, metadata: {} }),
      settings: {}
    }
  });
  if (!b) return null;
  b.window.App.cloud = {
    getUser: () => ({ id: "u-1" }),
    getClient: () => ({ rpc: async () => ({ data: payload, error: null }) })
  };
  await b.window.App.workspace.load();
  return b;
}

const navIds = (b) =>
  b.window.App.app.NAV.flatMap((g) => g.items.map((i) => i.id));

domTest("the owner sees every nav item", async () => {
  const b = await app(OWNER);
  const visible = b.window.App.app.NAV
    .flatMap((g) => g.items)
    .filter((it) => !it.area && !it.needsSettings);
  assert.ok(visible.length > 0);
  // Nothing gated is denied to an owner.
  for (const id of ["finances", "commission", "referrals", "goals", "settings"]) {
    assert.ok(navIds(b).includes(id), `${id} exists in NAV`);
  }
});

domTest("the agent loses the finance pages and Settings, keeps the rest", async () => {
  const b = await app(AGENT);
  const ws = b.window.App.workspace;
  // The gated items, decided by the same predicate the sidebar uses.
  assert.equal(ws.canView("finance"), false, "finances / commission / referrals");
  assert.equal(ws.canViewSettings(), false, "settings");
  // And the ones they keep.
  assert.equal(ws.canView("goals"), true);
  assert.equal(ws.canView("contacts"), true);
  assert.equal(ws.canView("properties"), true);
  assert.equal(ws.canView("work"), true);
});

domTest("a hidden route cannot be reached by typing its URL", async () => {
  const b = await app(AGENT);
  const { window } = b;
  window.location.hash = "#/finances";
  await window.App.app.route();
  assert.equal(window.location.hash, "#/dashboard",
    "a denied route redirects rather than rendering");
});

domTest("an allowed route still renders for the agent", async () => {
  const b = await app(AGENT);
  const { window } = b;
  window.location.hash = "#/contacts";
  await window.App.app.route();
  assert.equal(window.location.hash, "#/contacts");
});

domTest("the owner reaches the finance route normally", async () => {
  const b = await app(OWNER);
  const { window } = b;
  window.location.hash = "#/finances";
  await window.App.app.route();
  assert.equal(window.location.hash, "#/finances");
});

// ------------------------------------------- the legacy "Working as" filter
//
// Moved onto App.workspace when core/permissions.js was removed (L-2). It
// is a view preference, not access control, and these tests pin that it
// defaults to full access and only ever hides numbers for "Staff".

/** A window with App.workspace over a store holding the given state. */
async function viewCtx(state) {
  const b = await browser(WS, { store: { getState: () => state } });
  if (!b) return null;
  b.window.App.cloud = {
    getUser: () => ({ id: "u-1" }),
    getClient: () => ({ rpc: async () => ({ data: OWNER, error: null }) })
  };
  return b.window.App.workspace;
}

domTest("with no 'working as' member set, the view is full access", async () => {
  const ws = await viewCtx({ settings: {}, metadata: {} });
  assert.equal(ws.currentRole(), "Owner");
  assert.equal(ws.commissionFiguresHidden(), false);
});

domTest("an unloaded teamMembers cache still reads as full access", async () => {
  // The important direction: a half-loaded page must not hide things.
  const ws = await viewCtx({ settings: { currentTeamMemberId: "tm-9" }, metadata: {} });
  assert.equal(ws.currentRole(), "Owner");
  assert.equal(ws.commissionFiguresHidden(), false);
});

domTest("working as a Staff member hides the commission figures", async () => {
  const ws = await viewCtx({
    settings: { currentTeamMemberId: "tm-9" },
    metadata: {},
    teamMembers: [{ id: "tm-9", role: "Staff", active: true }]
  });
  assert.equal(ws.currentRole(), "Staff");
  assert.equal(ws.commissionFiguresHidden(), true);
});

domTest("an inactive or non-Staff member does not hide anything", async () => {
  const inactive = await viewCtx({
    settings: { currentTeamMemberId: "tm-9" },
    metadata: {},
    teamMembers: [{ id: "tm-9", role: "Staff", active: false }]
  });
  assert.equal(inactive.currentRole(), "Owner", "an inactive member falls back to full access");
  assert.equal(inactive.commissionFiguresHidden(), false);

  const agent = await viewCtx({
    settings: { currentTeamMemberId: "tm-8" },
    metadata: {},
    teamMembers: [{ id: "tm-8", role: "Agent", active: true }]
  });
  assert.equal(agent.commissionFiguresHidden(), false, "only Staff hides the figures");
});

domTest("currentRole is not the real workspace role", async () => {
  // role() comes from the server; currentRole() is the local view filter.
  // Conflating the two is exactly the bug this separation prevents.
  const b = await ctx(AGENT);
  await b.ws.load();
  assert.equal(b.ws.role(), "agent", "the server's role");
  assert.equal(b.ws.currentRole(), "Owner", "the view filter, untouched by it");
});
