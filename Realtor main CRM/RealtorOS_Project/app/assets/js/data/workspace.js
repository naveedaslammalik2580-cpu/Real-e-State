/* ============================================================
   App.workspace — who the signed-in person is INSIDE their workspace.

   One RPC call per session (realtoros_my_permissions), cached. Everything
   the UI needs to decide what to show comes from here: the workspace id,
   the person's role, their team_members row, and their effective
   permissions after role template + personal overrides are merged.

   This is for SHOWING and HIDING only. It is not security: RLS and the
   service-role RPCs are. A member who edits this in the console sees
   buttons that then fail on the server, which is the correct outcome.

   Shape of permissions (see docs/TEAM_ACCESS_ARCHITECTURE.md 7.0.1):
     six scoped areas - contacts, deals, work, properties, finance, goals
       each { view|edit|delete: 'none'|'own'|'all', create: boolean }
     ten booleans - contacts_assign, unassigned_view, unassigned_claim,
       templates_manage_shared, templates_create_personal,
       automation_manage_shared, automation_create_personal,
       imports_file, integrations_manage, team_manage
     settings - 'none'|'view'|'edit'
   ============================================================ */
window.App = window.App || {};
App.workspace = (function () {
  "use strict";

  const AREAS = ["contacts", "deals", "work", "properties", "finance", "goals"];
  const SCOPES = { none: 0, own: 1, all: 2 };
  const SETTINGS = { none: 0, view: 1, edit: 2 };

  let state = null;          // null until load() succeeds
  let loading = null;        // in-flight promise, so concurrent callers share one RPC
  const listeners = [];

  function client() { return App.cloud.getClient(); }

  function emit() { listeners.slice().forEach(fn => { try { fn(state); } catch (e) {} }); }

  /**
   * Load the caller's workspace context. Safe to call repeatedly: the
   * result is cached for the session and concurrent callers share the
   * same request. Pass true to force a refresh (after a role or
   * permission change).
   */
  async function load(force) {
    if (state && !force) return state;
    if (loading && !force) return loading;
    loading = (async () => {
      const { data, error } = await client().rpc("realtoros_my_permissions");
      if (error) throw error;
      // null means "signed in but not an active member of any workspace".
      // Treated as no access rather than as an error, so the UI can say so.
      state = data ? {
        workspaceId: data.workspace_id || null,
        role: data.role || null,
        teamMemberId: data.team_member_id || null,
        memberId: data.member_id || null,
        permissions: data.permissions || {}
      } : { workspaceId: null, role: null, teamMemberId: null, memberId: null, permissions: {} };
      loading = null;
      emit();
      return state;
    })();
    return loading;
  }

  function reset() { state = null; loading = null; emit(); }

  function onChange(fn) {
    if (typeof fn === "function") listeners.push(fn);
    return () => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  // ---------- accessors ----------
  // Every one of these answers "no access" when the context has not
  // loaded, so a page that renders before load() resolves hides rather
  // than reveals.
  function ready() { return state !== null; }
  function id() { return state && state.workspaceId; }
  function role() { return state && state.role; }
  function teamMemberId() { return state && state.teamMemberId; }
  function memberId() { return state && state.memberId; }
  function isOwner() { return !!state && state.role === "owner"; }
  function permissions() { return (state && state.permissions) || {}; }

  /** One of the ten booleans. False unless explicitly true. */
  function can(key) {
    return permissions()[key] === true;
  }

  /** An area's scope for an action: 'none' | 'own' | 'all'. */
  function scope(area, action) {
    const a = permissions()[area];
    const v = a && a[action];
    return (v === "own" || v === "all") ? v : "none";
  }

  /** Can this person see anything at all in this area? */
  function canView(area) { return scope(area, "view") !== "none"; }

  /** Can they create in this area? */
  function canCreate(area) {
    const a = permissions()[area];
    return !!(a && a.create === true);
  }

  /** Does their scope reach beyond their own rows? */
  function seesAll(area) { return scope(area, "view") === "all"; }

  function settingsLevel() {
    const v = permissions().settings;
    return (v === "view" || v === "edit") ? v : "none";
  }
  function canViewSettings() { return SETTINGS[settingsLevel()] >= SETTINGS.view; }
  function canEditSettings() { return settingsLevel() === "edit"; }

  /**
   * Is this row the person's own, by the same definition the RLS "own"
   * scope uses: assigned to them, or created by them. Pages use this to
   * decide whether to offer Edit on a row their scope only half covers.
   */
  function ownsRow(row) {
    if (!row || !state) return false;
    const assignee = row.assigned_to_id || row.assignedToId || row.assigned_to || null;
    if (assignee && state.teamMemberId && assignee === state.teamMemberId) return true;
    const creator = row.user_id || row.userId || null;
    const uid = App.cloud.getUser && App.cloud.getUser();
    return !!(creator && uid && creator === uid.id);
  }

  /** May they edit this specific row, given their area scope? */
  function canEditRow(area, row) {
    const s = scope(area, "edit");
    if (s === "all") return true;
    if (s === "own") return ownsRow(row);
    return false;
  }

  /** May they delete this specific row? */
  function canDeleteRow(area, row) {
    const s = scope(area, "delete");
    if (s === "all") return true;
    if (s === "own") return ownsRow(row);
    return false;
  }

  /** Comparable rank, for "is at least" questions. */
  function scopeRank(v) { return SCOPES[v] === undefined ? 0 : SCOPES[v]; }

  // ---------- the legacy "Working as" view filter ----------
  //
  // NOT access control, and not related to anything above. Everything else
  // in this module reflects the workspace permissions the server granted;
  // these two reflect a purely local view preference a workspace may still
  // have stored as settings.currentTeamMemberId. They hide numbers on one
  // screen for workflow focus; the data is untouched and still exported in
  // full from Settings - Data & Safety. Never gate anything
  // security-sensitive on them.
  //
  // Kept because an existing workspace may still have the setting; Settings
  // - Team & Access is the way to clear it. They lived in
  // core/permissions.js until that file's only other export (a no-op
  // refresh() for the deleted team.js) made it not worth a module.
  //
  // currentRole() is deliberately NOT role(): role() is the member's real
  // workspace role from the server, this is the directory role of whoever
  // the view is pretending to be.
  function currentRole() {
    if (!App.store || typeof App.store.getState !== "function") return "Owner";
    const s = App.store.getState();
    const id = s && s.settings && s.settings.currentTeamMemberId;
    if (!id) return "Owner"; // unset = full access, the single-user default
    // Synchronous cache read (not the async store facade): this runs
    // mid-render on pages that may not have ensureLoaded("teamMembers")
    // themselves, and an unloaded cache reads as [] here, which correctly
    // falls through to the "Owner / full access" default.
    const member = (s.teamMembers || []).find(m => m.id === id);
    return (member && member.active !== false) ? member.role : "Owner";
  }

  // The one behaviour actually wired up: a Staff view hides the Commission
  // page's dollar figures. Kept as a single named check rather than a
  // generic matrix, so this can never grow silent claims beyond what is
  // really implemented.
  function commissionFiguresHidden() {
    return currentRole() === "Staff";
  }

  return {
    AREAS,
    load, reset, onChange, ready,
    id, role, teamMemberId, memberId, isOwner, permissions,
    can, scope, canView, canCreate, seesAll,
    settingsLevel, canViewSettings, canEditSettings,
    ownsRow, canEditRow, canDeleteRow, scopeRank,
    currentRole, commissionFiguresHidden
  };
})();
