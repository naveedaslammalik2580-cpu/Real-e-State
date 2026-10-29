// Shared stubs for the Team UI tests.
//
// The pages under test read three globals besides App.store: App.workspace
// (what the signed-in person may do), App.customization (is this workspace
// run as a team) and App.cloud (who is signed in). None of them is the thing
// being tested here, so each is a plain stub whose values are test inputs -
// which is also the only way to drive one screen through every permission
// shape without a database.
import { browser, settle } from "../helpers/browser.mjs";

export const plain = (v) => JSON.parse(JSON.stringify(v));

const AREAS = ["contacts", "deals", "work", "properties", "finance", "goals"];
const SCOPES = { none: 0, own: 1, all: 2 };
const SETTINGS = { none: 0, view: 1, edit: 2 };

/** A permissions object of the shape realtoros_my_permissions returns. */
export function permissions(overrides = {}) {
  const base = {};
  AREAS.forEach((a) => { base[a] = { view: "own", edit: "own", delete: "none", create: true }; });
  Object.assign(base, {
    contacts_assign: false, unassigned_view: false, unassigned_claim: false,
    templates_manage_shared: false, templates_create_personal: true,
    automation_manage_shared: false, automation_create_personal: true,
    imports_file: true, integrations_manage: false, team_manage: false,
    settings: "none"
  });
  return Object.assign(base, overrides);
}

export function adminPermissions(overrides = {}) {
  const base = {};
  AREAS.forEach((a) => { base[a] = { view: "all", edit: "all", delete: "all", create: true }; });
  return Object.assign(base, {
    contacts_assign: true, unassigned_view: true, unassigned_claim: true,
    templates_manage_shared: true, templates_create_personal: true,
    automation_manage_shared: true, automation_create_personal: true,
    imports_file: true, integrations_manage: true, team_manage: true,
    settings: "edit"
  }, overrides);
}

/** App.workspace, as the pages use it. */
export function makeWorkspace(opts = {}) {
  const perms = opts.permissions || adminPermissions();
  const role = opts.role || "owner";
  let loads = 0;
  return {
    _loads: () => loads,
    AREAS,
    load: async () => { loads++; return {}; },
    reset() {},
    onChange: () => () => {},
    ready: () => true,
    id: () => (opts.workspaceId === undefined ? "ws-1" : opts.workspaceId),
    role: () => role,
    teamMemberId: () => (opts.teamMemberId === undefined ? "tm-self" : opts.teamMemberId),
    memberId: () => "wm-self",
    isOwner: () => role === "owner",
    permissions: () => perms,
    can: (k) => perms[k] === true,
    scope: (area, action) => {
      const a = perms[area];
      const v = a && a[action];
      return (v === "own" || v === "all") ? v : "none";
    },
    canView(area) { return this.scope(area, "view") !== "none"; },
    canCreate: (area) => !!(perms[area] && perms[area].create === true),
    seesAll(area) { return this.scope(area, "view") === "all"; },
    settingsLevel: () => (perms.settings === "view" || perms.settings === "edit") ? perms.settings : "none",
    canViewSettings() { return SETTINGS[this.settingsLevel()] >= SETTINGS.view; },
    canEditSettings() { return this.settingsLevel() === "edit"; },
    ownsRow: () => false,
    canEditRow: () => true,
    canDeleteRow: () => true,
    scopeRank: (v) => (SCOPES[v] === undefined ? 0 : SCOPES[v])
  };
}

/**
 * A recording App.store.team. Every method logs its call and answers with
 * whatever the test queued, so a screen can be driven through each outcome
 * the database functions can return.
 */
export function makeTeamStore(answers = {}) {
  const calls = [];
  const answer = (name, args, fallback) => {
    calls.push({ name, args });
    const a = Object.prototype.hasOwnProperty.call(answers, name) ? answers[name] : undefined;
    if (typeof a === "function") return a(...args);
    if (a instanceof Error) throw a;
    if (a !== undefined) return a;
    return fallback;
  };
  return {
    calls,
    listMembers: async () => answer("listMembers", [], { outcome: "ok", can_manage: true, members: [] }),
    listInvitations: async () => answer("listInvitations", [], { outcome: "ok", invitations: [] }),
    invite: async (...a) => answer("invite", a, { outcome: "invited", invitation_id: "inv-1", token: "t".repeat(64), email: a[0], role: a[1], expires_at: inDays(7) }),
    revokeInvitation: async (...a) => answer("revokeInvitation", a, { outcome: "revoked" }),
    acceptInvitation: async (...a) => answer("acceptInvitation", a, { outcome: "accepted", workspace_id: "ws-1", role: "agent", member_id: "wm-9", team_member_id: "tm-9" }),
    remove: async (...a) => answer("remove", a, { outcome: "removed", member_id: a[0] }),
    changeRole: async (...a) => answer("changeRole", a, { outcome: "changed", member_id: a[0], from_role: "agent", to_role: a[1] }),
    transferOwnership: async (...a) => answer("transferOwnership", a, { outcome: "transferred", new_owner_member_id: a[0], previous_owner_role: "admin" }),
    leave: async () => answer("leave", [], { outcome: "left", left_workspace_id: "ws-1", new_workspace_id: "ws-2", leads_unassigned: 3, items_handed_to_owner: 1 }),
    deleteTeam: async (...a) => answer("deleteTeam", a, { outcome: "deleted", deleted_workspace_id: "ws-1", deleted_name: a[0], new_workspace_id: "ws-2" }),
    rolePermissions: async () => answer("rolePermissions", [], {}),
    setRolePermissions: async (...a) => answer("setRolePermissions", a, { role: a[0], permissions: a[1] }),
    setMemberPermissions: async (...a) => answer("setMemberPermissions", a, { member_id: a[0], overrides: a[1] }),
    resetMemberPermissions: async (...a) => answer("resetMemberPermissions", a, { member_id: a[0], overrides: {} })
  };
}

/** App.store, with only what the team screens touch. */
export function makeStore(opts = {}) {
  const state = Object.assign({
    settings: Object.assign({ currentTeamMemberId: null, agencyName: "" }, opts.settings),
    teamMembers: opts.teamMembers || [],
    contacts: opts.contacts || [],
    deals: opts.deals || [],
    tasks: opts.tasks || []
  }, opts.state);
  const saved = [];
  return {
    saved,
    state,
    team: opts.team || makeTeamStore(),
    ensureLoaded: async () => {},
    getState: () => state,
    resetAllCaches: () => {},
    contacts: {
      update: async (id, patch) => {
        saved.push({ id, patch });
        if (opts.onContactUpdate) return opts.onContactUpdate(id, patch);
        const c = state.contacts.find((x) => x.id === id);
        if (c) Object.assign(c, patch);
        return c;
      }
    },
    settings: {
      get: () => state.settings,
      update: async (patch) => { saved.push({ settings: patch }); Object.assign(state.settings, patch); return state.settings; },
      setTeamMode: async (on) => { saved.push({ teamMode: on }); return { teamMode: on }; }
    }
  };
}

export function inDays(n) {
  return new Date(Date.now() + n * 86400000).toISOString();
}

export function member(over = {}) {
  return Object.assign({
    member_id: "wm-" + (over.member_id || "1"),
    user_id: "u-1",
    team_member_id: "tm-1",
    name: "Rosa Diaz",
    email: "rosa@example.com",
    role: "agent",
    status: "active",
    is_self: false,
    joined_at: inDays(-30),
    updated_at: inDays(-1)
  }, over);
}

export function invitation(over = {}) {
  return Object.assign({
    id: "inv-1",
    email: "new@example.com",
    role: "agent",
    status: "pending",
    expires_at: inDays(5),
    created_at: inDays(-2),
    accepted_at: null,
    invited_by_email: "owner@example.com"
  }, over);
}

/**
 * Loads the real page scripts into jsdom with the stubs in place. Returns
 * null when jsdom is not installed, so each test can skip the same way.
 */
export async function teamBrowser(scripts, opts = {}) {
  const b = await browser(scripts, { store: opts.store, derived: opts.derived });
  if (!b) return null;
  const { window } = b;
  window.App.workspace = opts.workspace || makeWorkspace();
  window.App.customization = opts.customization || { isTeamMode: () => (opts.teamMode === undefined ? true : opts.teamMode) };
  window.App.cloud = opts.cloud || {
    getUser: () => (opts.user === undefined ? { id: "u-self", email: "me@example.com" } : opts.user),
    signOutUser: async () => { b.signedOut = true; }
  };
  if (opts.store) window.App.store = opts.store;
  // Navigation is recorded rather than performed: jsdom has no router, and
  // where a screen sends you is part of what these tests check.
  b.navigations = [];
  window.App.app.navigate = (path) => { b.navigations.push(path); };
  // jsdom has no navigation, and a real reload() logs a "Not implemented"
  // error that drowns out the test output. The page only reloads after
  // signing out, so recording it is enough.
  b.reloaded = 0;
  try {
    Object.defineProperty(window.location, "reload", {
      configurable: true,
      value: () => { b.reloaded++; }
    });
  } catch (e) { /* an older jsdom may refuse; the noise is then cosmetic */ }
  b.refreshedNav = 0;
  window.App.app.refreshNav = () => { b.refreshedNav++; };
  return b;
}

/** Clicks the OK button of the confirm dialog the page just opened. */
export async function confirmOk(b) {
  const ok = b.document.querySelector('.modal [data-role="ok"]');
  if (!ok) throw new Error("no confirm dialog is open");
  ok.click();
  await settle(b.window);
}

export { settle };
