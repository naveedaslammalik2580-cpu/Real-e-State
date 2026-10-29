// Generates the T2b-2 RLS cutover migration.
//
// Every policy is built from a small spec so the (select authz.my_*())
// pattern is applied uniformly — that wrapping is what makes Postgres
// evaluate the helper once per statement instead of once per row.
import fs from "node:fs";

const WS = `workspace_id = (select authz.my_workspace_id())`;
const UID = `(select auth.uid())`;
const TM = `(select authz.my_team_member_id())`;
const sc = (a, v) => `(select authz.my_scope('${a}','${v}'))`;
const can = (k) => `(select authz.my_can('${k}'))`;
const mkcreate = (a) => `(select authz.my_area_create('${a}'))`;
// INSERT WITH CHECK must NOT use the cached (select ...) form for the
// workspace test: T2a's compat trigger can create the membership during
// this very statement, and an InitPlan is evaluated before BEFORE INSERT
// triggers run. A per-row EXISTS sees the freshly-created row.
const WS_INSERT = (t) => `exists (\n      select 1 from public.workspace_members m\n       where m.workspace_id = ${t}.workspace_id\n         and m.user_id = (select auth.uid())\n         and m.status = 'active'\n    )`;

const L = [];
const w = (s = "") => L.push(s);

// ---------------------------------------------------------------- header
w(`-- Phase T2b-2: the security rule switch — workspace + permission RLS.
--
-- Replaces every user_id-based policy with a workspace_id + permission
-- aware one, atomically. Written against the area map and the "own"
-- definitions in docs/TEAM_ACCESS_ARCHITECTURE.md §7.0.3-§7.0.4, the
-- browser-read decisions in §7.0.8, and the caller-scoped helper pattern
-- in §7.0.6.
--
-- Shape of every area policy:
--   workspace_id = (select authz.my_workspace_id())
--   and ( (select authz.my_scope(<area>,<verb>)) = 'all'
--      or ((select authz.my_scope(<area>,<verb>)) = 'own' and <own-predicate>) )
--
-- Each authz.my_*() call is wrapped in (select ...) so the planner lifts
-- it to an InitPlan (once per statement, not once per row).
--
-- The OWNER is unaffected: owner scope is 'all' everywhere, so every
-- policy reduces to the workspace check, and every existing row already
-- carries the owner's workspace_id (T2a backfill). The current unmodified
-- frontend keeps working: it filters by user_id (harmless, still true for
-- the owner's own rows) and inserts without workspace_id (T2a's compat
-- trigger fills it before RLS evaluates WITH CHECK).
--
-- Idempotent: every CREATE POLICY is preceded by DROP POLICY IF EXISTS.

-- ============================================================
-- 0. Make authz SELF-CONTAINED.
--
-- authz.effective_permissions is SECURITY INVOKER (deliberately - that
-- is what makes it unable to leak another workspace). Until now it
-- reached into automation_internal for two pure JSON helpers, which
-- forced authenticated to hold USAGE on that schema. Any migration
-- chain ending on an earlier revoke all on schema automation_internal
-- from ... authenticated therefore broke the INVOKER path with
-- "permission denied for schema automation_internal".
--
-- Fix: authz keeps its OWN copies of the pure helpers, and
-- automation_internal goes back to service_role-only.
-- ============================================================
create or replace function authz.scope_rank(p text)
returns int language sql immutable set search_path = '' as $fn$
  select case p when 'none' then 0 when 'own' then 1 when 'all' then 2 else null end;
$fn$;
revoke all on function authz.scope_rank(text) from public, anon;
grant execute on function authz.scope_rank(text) to authenticated, service_role;

create or replace function authz.settings_rank(p text)
returns int language sql immutable set search_path = '' as $fn$
  select case p when 'none' then 0 when 'view' then 1 when 'edit' then 2 else null end;
$fn$;
revoke all on function authz.settings_rank(text) from public, anon;
grant execute on function authz.settings_rank(text) to authenticated, service_role;

-- Byte-identical to automation_internal.default_role_permissions. A test
-- asserts the two stay equal so they cannot drift apart.
create or replace function authz.default_role_permissions(p_role text)
returns jsonb language sql immutable set search_path = '' as $fn$
  select case
    when p_role = 'admin' then jsonb_build_object(
      'contacts',   jsonb_build_object('view','all','edit','all','delete','all','create', true),
      'deals',      jsonb_build_object('view','all','edit','all','delete','all','create', true),
      'work',       jsonb_build_object('view','all','edit','all','delete','all','create', true),
      'properties', jsonb_build_object('view','all','edit','all','delete','all','create', true),
      'finance',    jsonb_build_object('view','all','edit','all','delete','all','create', true),
      'goals',      jsonb_build_object('view','all','edit','all','delete','all','create', true),
      'contacts_assign', true, 'unassigned_view', true, 'unassigned_claim', true,
      'templates_manage_shared', true, 'templates_create_personal', true,
      'automation_manage_shared', true, 'automation_create_personal', true,
      'imports_file', true, 'integrations_manage', true, 'team_manage', true,
      'settings', 'edit')
    when p_role = 'agent' then jsonb_build_object(
      'contacts',   jsonb_build_object('view','own','edit','own','delete','none','create', true),
      'deals',      jsonb_build_object('view','own','edit','own','delete','none','create', true),
      'work',       jsonb_build_object('view','own','edit','own','delete','own', 'create', true),
      'properties', jsonb_build_object('view','all','edit','own','delete','own', 'create', true),
      'finance',    jsonb_build_object('view','none','edit','none','delete','none','create', false),
      'goals',      jsonb_build_object('view','own','edit','own','delete','own', 'create', true),
      'contacts_assign', false, 'unassigned_view', false, 'unassigned_claim', false,
      'templates_manage_shared', false, 'templates_create_personal', true,
      'automation_manage_shared', false, 'automation_create_personal', true,
      'imports_file', true, 'integrations_manage', false, 'team_manage', false,
      'settings', 'none')
    else null::jsonb
  end;
$fn$;
revoke all on function authz.default_role_permissions(text) from public, anon;
grant execute on function authz.default_role_permissions(text) to authenticated, service_role;

create or replace function authz.merge_permissions(p_template jsonb, p_overrides jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $fn$
declare
  v_merged jsonb := p_template; v_key text; v_val jsonb;
begin
  if p_overrides is null or jsonb_typeof(p_overrides) <> 'object' then
    return v_merged;
  end if;
  for v_key, v_val in select * from jsonb_each(p_overrides) loop
    if jsonb_typeof(v_val) = 'object' and v_merged ? v_key
       and jsonb_typeof(v_merged -> v_key) = 'object' then
      v_merged := v_merged || jsonb_build_object(v_key, (v_merged -> v_key) || v_val);
    else
      v_merged := v_merged || jsonb_build_object(v_key, v_val);
    end if;
  end loop;
  return v_merged;
end;
$fn$;
revoke all on function authz.merge_permissions(jsonb, jsonb) from public, anon;
grant execute on function authz.merge_permissions(jsonb, jsonb) to authenticated, service_role;

-- Repoint the INVOKER chain at the authz copies.
create or replace function authz.effective_permissions(p_workspace_id uuid)
returns jsonb language plpgsql stable set search_path = '' as $fn$
declare
  v_role text; v_overrides jsonb; v_template jsonb;
begin
  select m.role into v_role from authz.member(p_workspace_id) m;
  if v_role is null then return null; end if;
  if v_role = 'owner' then
    return authz.default_role_permissions('admin');
  end if;
  select wm.permission_overrides into v_overrides
    from public.workspace_members wm
    where wm.workspace_id = p_workspace_id
      and wm.user_id = (select auth.uid()) and wm.status = 'active';
  select wrp.permissions into v_template
    from public.workspace_role_permissions wrp
    where wrp.workspace_id = p_workspace_id and wrp.role = v_role;
  if v_template is null then
    v_template := authz.default_role_permissions(v_role);
  end if;
  return authz.merge_permissions(v_template, coalesce(v_overrides, '{}'::jsonb));
end;
$fn$;
revoke all on function authz.effective_permissions(uuid) from public, anon;
grant execute on function authz.effective_permissions(uuid) to authenticated, service_role;

-- automation_internal returns to service_role-only. Everything in it the
-- browser still depends on is SECURITY DEFINER (the realtoros_* RPCs,
-- the compat trigger, the validators), so they keep working with no
-- authenticated access to the schema at all.
revoke all on schema automation_internal from public, anon, authenticated;
grant usage on schema automation_internal to service_role;

-- ============================================================
-- 0b. Eager workspace provisioning (blocker 1, part 1).
--
-- A brand-new auth user gets their workspace at signup instead of on
-- their first write. Non-fatal by design: if provisioning fails the
-- signup still succeeds, and T2a's BEFORE INSERT compat trigger stays
-- as the fallback.
-- ============================================================
create or replace function automation_internal.provision_workspace_on_signup()
returns trigger language plpgsql security definer set search_path = '' as $fn$
begin
  begin
    perform automation_internal.ensure_personal_workspace(new.id);
  exception when others then
    raise warning 'ensure_personal_workspace failed for % (signup continues; compat trigger retries on first write): %',
      new.id, sqlerrm;
  end;
  return new;
end;
$fn$;
revoke all on function automation_internal.provision_workspace_on_signup() from public, anon, authenticated;

drop trigger if exists realtoros_provision_workspace on auth.users;
create trigger realtoros_provision_workspace
  after insert on auth.users
  for each row execute function automation_internal.provision_workspace_on_signup();

-- ============================================================
-- 0c. Extra authz helpers this phase needs.
-- ============================================================

-- Area 'create' is a boolean inside the area object, not a scope string.
create or replace function authz.my_area_create(p_area text)
returns boolean language sql stable set search_path = '' as $fn$
  select coalesce((authz.effective_permissions(authz.my_workspace_id())
                   -> p_area ->> 'create')::boolean, false);
$fn$;
revoke all on function authz.my_area_create(text) from public, anon;
grant execute on function authz.my_area_create(text) to authenticated, service_role;
comment on function authz.my_area_create(text) is
  'Phase T2b-2. Caller-only boolean for an area''s create flag. Wrap in (select ...) inside RLS.';

-- Ownership probes for child tables that inherit through a parent.
-- SECURITY DEFINER so a policy on the CHILD does not re-enter the
-- PARENT's RLS (which would recurse or silently over-filter). Safe:
-- each one derives the workspace from auth.uid() itself and can only
-- ever answer about the caller's own workspace, so it cannot be used
-- to probe another tenant.
create or replace function authz.owns_deal(p_deal_id text)
returns boolean language sql stable security definer set search_path = '' as $fn$
  select exists (
    select 1 from public.deals d
     where d.id = p_deal_id
       and d.workspace_id = authz.my_workspace_id()
       and (d.assigned_to_id = authz.my_team_member_id() or d.user_id = (select auth.uid()))
  );
$fn$;
revoke all on function authz.owns_deal(text) from public, anon;
grant execute on function authz.owns_deal(text) to authenticated, service_role;
comment on function authz.owns_deal(text) is
  'Phase T2b-2. True when the deal is in the caller''s workspace AND assigned to them or created by them. SECURITY DEFINER to avoid child-policy recursion into deals'' own RLS; scoped to the caller''s workspace so it cannot probe another tenant.';

create or replace function authz.owns_contact(p_contact_id text)
returns boolean language sql stable security definer set search_path = '' as $fn$
  select exists (
    select 1 from public.contacts c
     where c.id = p_contact_id
       and c.workspace_id = authz.my_workspace_id()
       and (c.assigned_to_id = authz.my_team_member_id() or c.user_id = (select auth.uid()))
  );
$fn$;
revoke all on function authz.owns_contact(text) from public, anon;
grant execute on function authz.owns_contact(text) to authenticated, service_role;
comment on function authz.owns_contact(text) is
  'Phase T2b-2. True when the contact is in the caller''s workspace AND assigned to them or created by them. Same DEFINER rationale as authz.owns_deal.';

create or replace function authz.owns_rule(p_rule_id uuid)
returns boolean language sql stable security definer set search_path = '' as $fn$
  select exists (
    select 1 from public.automation_rules r
     where r.id = p_rule_id
       and r.workspace_id = authz.my_workspace_id()
       and (r.visibility = 'shared' and authz.my_can('automation_manage_shared')
            or r.user_id = (select auth.uid()))
  );
$fn$;
revoke all on function authz.owns_rule(uuid) from public, anon;
grant execute on function authz.owns_rule(uuid) to authenticated, service_role;
comment on function authz.owns_rule(uuid) is
  'Phase T2b-2. True when the automation rule is visible to the caller: in their workspace and either shared (with automation_manage_shared) or created by them.';
`);

// ---------------------------------------------------------------- area tables
// [table, area, ownPredicate, {extraSelect}]
const OWN_ASSIGNED = (col) => `(${col} = ${TM} or user_id = ${UID})`;
const AREAS = [
  // contacts: unassigned rows are additionally visible with
  // unassigned_view, and additionally UPDATE-able with unassigned_claim
  // (that is the claim flow — the trigger below then restricts what the
  // new assignee may be).
  ["contacts",        "contacts",   OWN_ASSIGNED("assigned_to_id"),
    { extraSelect: `(assigned_to_id is null and ${can("unassigned_view")})`,
      extraUpdate: `(assigned_to_id is null and ${can("unassigned_claim")})` }],
  ["deals",           "deals",      OWN_ASSIGNED("assigned_to_id")],
  ["tasks",           "work",       OWN_ASSIGNED("assigned_to_id")],
  ["scheduled_items", "work",       OWN_ASSIGNED("assigned_to")],
  ["activities",      "work",
    `(user_id = ${UID} or (deal_id is not null and (select authz.owns_deal(deal_id))) or (contact_id is not null and (select authz.owns_contact(contact_id))))`],
  ["showings",        "work",
    `(user_id = ${UID} or (deal_id is not null and (select authz.owns_deal(deal_id))))`],
  ["milestones",      "work",
    `(deal_id is not null and (select authz.owns_deal(deal_id)))`],
  ["properties",      "properties",
    `(user_id = ${UID} or (deal_id is not null and (select authz.owns_deal(deal_id))) or (contact_id is not null and (select authz.owns_contact(contact_id))))`],
  ["finance_records", "finance",    `(user_id = ${UID})`],
  ["referrals",       "finance",    `(user_id = ${UID})`],
  ["goals",           "goals",      `(user_id = ${UID})`],
  // custom_field_values: simplest safe option — treat as creator-owned.
  // (Full parent inheritance via entity_type/record_id is deferred; noted
  // in the migration comment.)
  ["custom_field_values", "contacts", `(user_id = ${UID})`],
];

function pol(table, name, cmd, using, check) {
  w(`drop policy if exists ${name} on public.${table};`);
  let s = `create policy ${name} on public.${table}\n  for ${cmd} to authenticated`;
  if (using) s += `\n  using (\n    ${using}\n  )`;
  if (check) s += `\n  with check (\n    ${check}\n  )`;
  w(s + ";");
  w();
}

const scoped = (area, verb, own, extra) => {
  let p = `${WS}\n    and (\n      ${sc(area, verb)} = 'all'\n      or (${sc(area, verb)} = 'own' and ${own})`;
  if (extra) p += `\n      or ${extra}`;
  return p + `\n    )`;
};

w(`-- ============================================================
-- 1. Area tables. SELECT by view scope, INSERT needs create + own
--    identity, UPDATE by edit scope (workspace pinned by WITH CHECK),
--    DELETE by delete scope.
-- ============================================================`);
for (const [t, area, own, opt = {}] of AREAS) {
  w(`-- ${t} (area: ${area})`);
  pol(t, `${t}_select_scoped`, "select",
      scoped(area, "view", own, opt.extraSelect), null);
  pol(t, `${t}_insert_scoped`, "insert", null,
      `${WS_INSERT(t)}\n    and user_id = ${UID}\n    and ${mkcreate(area)}`);
  pol(t, `${t}_update_scoped`, "update",
      scoped(area, "edit", own, opt.extraUpdate), `${WS}`);
  pol(t, `${t}_delete_scoped`, "delete",
      scoped(area, "delete", own), null);
}

// ---------------------------------------------------------------- assignment trigger
w(`-- ============================================================
-- 1b. The assignment / claim rule on contacts.
--
-- RLS decides WHICH rows you may update; this trigger decides whether
-- you may change the ASSIGNEE on one, which RLS alone cannot express
-- (it needs OLD vs NEW).
--
--   * assigned_to_id unchanged               -> always fine
--   * changing it, with contacts_assign      -> fine (admins, owner)
--   * claiming an UNASSIGNED lead for YOURSELF with unassigned_claim
--                                            -> fine
--   * anything else                          -> refused
--
-- It also pins workspace_id: no row may be moved between workspaces.
-- service_role (no JWT, so auth.uid() is null) is exempt — the Edge
-- Functions assign leads on the workspace's behalf.
-- ============================================================
create or replace function automation_internal.enforce_contact_assignment()
returns trigger language plpgsql security definer set search_path = ''
as $fn$
begin
  if new.workspace_id is distinct from old.workspace_id then
    raise exception 'a contact cannot be moved to another workspace'
      using errcode = '42501';
  end if;

  if new.assigned_to_id is not distinct from old.assigned_to_id then
    return new;
  end if;

  -- Trusted server-side callers (no JWT) may assign freely.
  if (select auth.uid()) is null then
    return new;
  end if;

  if authz.my_can('contacts_assign') then
    return new;
  end if;

  if old.assigned_to_id is null
     and new.assigned_to_id = authz.my_team_member_id()
     and authz.my_can('unassigned_claim') then
    return new;
  end if;

  raise exception 'changing the assigned agent needs contacts_assign (or unassigned_claim, to claim an unassigned lead for yourself)'
    using errcode = '42501';
end;
$fn$;
revoke all on function automation_internal.enforce_contact_assignment() from public, anon, authenticated;

drop trigger if exists contacts_enforce_assignment on public.contacts;
create trigger contacts_enforce_assignment
  before update on public.contacts
  for each row execute function automation_internal.enforce_contact_assignment();
`);

// ---------------------------------------------------------------- libraries
w(`-- ============================================================
-- 2. Library tables: shared rows readable by every member; personal
--    rows only by their creator (or a *_manage_shared holder).
--    Creating/editing a shared row needs *_manage_shared; a personal
--    row needs *_create_personal and creator = me.
-- ============================================================`);
const LIBS = [
  ["scripts",           "templates_manage_shared", "templates_create_personal"],
  ["ai_prompts",        "templates_manage_shared", "templates_create_personal"],
  ["message_templates", "templates_manage_shared", "templates_create_personal"],
];
for (const [t, mgr, personal] of LIBS) {
  const readable = `${WS}\n    and (\n      visibility = 'shared'\n      or user_id = ${UID}\n      or ${can(mgr)}\n    )`;
  const writable = `${WS}\n    and (\n      (visibility = 'shared' and ${can(mgr)})\n      or (visibility = 'personal' and user_id = ${UID} and ${can(personal)})\n    )`;
  w(`-- ${t}`);
  pol(t, `${t}_select_scoped`, "select", readable, null);
  pol(t, `${t}_insert_scoped`, "insert", null, `${writable}\n    and user_id = ${UID}`);
  pol(t, `${t}_update_scoped`, "update", writable, writable);
  pol(t, `${t}_delete_scoped`, "delete", writable, null);
}

// automation_rules: same model, plus the existing draft-only write rule.
w(`-- automation_rules (shared/personal + the pre-existing draft-only write rule)`);
{
  const t = "automation_rules";
  const readable = `${WS}\n    and (\n      visibility = 'shared'\n      or user_id = ${UID}\n      or ${can("automation_manage_shared")}\n    )`;
  const writable = `${WS}\n    and status = 'draft'\n    and (\n      (visibility = 'shared' and ${can("automation_manage_shared")})\n      or (visibility = 'personal' and user_id = ${UID} and ${can("automation_create_personal")})\n    )`;
  pol(t, `${t}_select_scoped`, "select", readable, null);
  pol(t, `${t}_insert_scoped`, "insert", null, `${writable}\n    and user_id = ${UID}`);
  pol(t, `${t}_update_scoped`, "update", writable, writable);
  pol(t, `${t}_delete_scoped`, "delete", writable, null);
}

// automation children inherit from the rule.
w(`-- ============================================================
-- 3. Automation child tables inherit visibility from their rule.
--    automation_failures has no rule_id, so it falls back to the
--    workspace + automation_manage_shared/creator test.
-- ============================================================`);
for (const t of ["automation_steps", "automation_enrollments", "automation_jobs"]) {
  pol(t, `${t}_select_scoped`, "select",
      `${WS}\n    and (rule_id is not null and (select authz.owns_rule(rule_id)))`, null);
}
pol("automation_runs", "automation_runs_select_scoped", "select",
    `${WS}\n    and (\n      user_id = ${UID}\n      or ${can("automation_manage_shared")}\n    )`, null);
pol("automation_failures", "automation_failures_select_scoped", "select",
    `${WS}\n    and (\n      user_id = ${UID}\n      or ${can("automation_manage_shared")}\n    )`, null);

// automation_steps writes (draft rule) — keep parity with the old policy set.
w(`-- automation_steps writes still require the parent rule to be draft.`);
{
  const stepW = `${WS}\n    and (select authz.owns_rule(rule_id))\n    and exists (\n      select 1 from public.automation_rules r\n      where r.id = automation_steps.rule_id and r.status = 'draft'\n    )`;
  pol("automation_steps", "automation_steps_insert_scoped", "insert", null, `${stepW}\n    and user_id = ${UID}`);
  pol("automation_steps", "automation_steps_update_scoped", "update", stepW, stepW);
  pol("automation_steps", "automation_steps_delete_scoped", "delete", stepW, null);
}

// ---------------------------------------------------------------- specials
w(`-- ============================================================
-- 4. Non-area tables, per the §7.0.8 read decisions.
-- ============================================================`);

w(`-- notifications: strictly the recipient's own rows.`);
pol("notifications", "notifications_select_scoped", "select",
    `${WS} and user_id = ${UID}`, null);
pol("notifications", "notifications_update_scoped", "update",
    `${WS} and user_id = ${UID}`, `${WS} and user_id = ${UID}`);

w(`-- workspace_settings: one row per workspace. Read at settings >= view,
-- write only at settings = edit.`);
pol("workspace_settings", "workspace_settings_select_scoped", "select",
    `${WS}\n    and (select authz.my_settings_level()) in ('view','edit')`, null);
pol("workspace_settings", "workspace_settings_insert_scoped", "insert", null,
    `${WS}\n    and (select authz.my_settings_level()) = 'edit'`);
pol("workspace_settings", "workspace_settings_update_scoped", "update",
    `${WS}\n    and (select authz.my_settings_level()) = 'edit'`,
    `${WS}\n    and (select authz.my_settings_level()) = 'edit'`);

w(`-- team_members: every member reads the directory (assignment dropdowns);
-- writing needs team_manage.`);
pol("team_members", "team_members_select_scoped", "select", `${WS}`, null);
pol("team_members", "team_members_insert_scoped", "insert", null, `${WS} and ${can("team_manage")}`);
pol("team_members", "team_members_update_scoped", "update",
    `${WS} and ${can("team_manage")}`, `${WS} and ${can("team_manage")}`);
pol("team_members", "team_members_delete_scoped", "delete",
    `${WS} and ${can("team_manage")}`, null);

w(`-- email_sender_profiles: your own sender row, or any with integrations_manage.`);
pol("email_sender_profiles", "email_sender_profiles_select_scoped", "select",
    `${WS} and (user_id = ${UID} or ${can("integrations_manage")})`, null);
pol("email_sender_profiles", "email_sender_profiles_insert_scoped", "insert", null,
    `${WS} and user_id = ${UID}`);
pol("email_sender_profiles", "email_sender_profiles_update_scoped", "update",
    `${WS} and (user_id = ${UID} or ${can("integrations_manage")})`,
    `${WS} and (user_id = ${UID} or ${can("integrations_manage")})`);

w(`-- Workspace-wide suppression / consent lists: every member may read.`);
pol("communication_consents", "communication_consents_select_scoped", "select", `${WS}`, null);
pol("email_suppressions", "email_suppressions_select_scoped", "select", `${WS}`, null);

w(`-- outbound_messages: the send audit trail — team_manage holders only.`);
pol("outbound_messages", "outbound_messages_select_scoped", "select",
    `${WS} and ${can("team_manage")}`, null);

w(`-- Import history: your own uploads, or all of them with team_manage.`);
pol("lead_import_batches", "lead_import_batches_select_scoped", "select",
    `${WS}\n    and ${can("imports_file")}\n    and (user_id = ${UID} or ${can("team_manage")})`, null);
pol("lead_import_rows", "lead_import_rows_select_scoped", "select",
    `${WS}\n    and ${can("imports_file")}\n    and (user_id = ${UID} or ${can("team_manage")})`, null);

w(`-- Sheets connections: integrations_manage.`);
for (const cmd of ["select", "insert", "update", "delete"]) {
  const pred = `${WS} and ${can("integrations_manage")}`;
  pol("lead_source_connections", `lead_source_connections_${cmd}_scoped`, cmd,
      cmd === "insert" ? null : pred, (cmd === "insert" || cmd === "update") ? pred : null);
}

// ---------------------------------------------------------------- drop old
w(`-- ============================================================
-- 5. Drop the superseded user_id policies, and remove browser read from
--    the four tables nothing in app/ reads (§7.0.8).
-- ============================================================
-- Dropped by an EXPLICIT inventory of the 101 superseded policies: the
-- 109 captured in supabase/rollback/ minus the 8 that must survive
-- (workspace_members, workspaces, the two authz tables, and
-- workspace_state's legacy four). Never by name pattern - a pattern also
-- matches workspace_members_select_own, which every authz helper reads
-- through; dropping it would null my_workspace_id() for everyone and
-- lock the entire app out.
do $drop$
declare r record;
begin
  for r in select * from (values
    ('activities', 'activities_delete_own'),
    ('activities', 'activities_insert_own'),
    ('activities', 'activities_select_own'),
    ('activities', 'activities_update_own'),
    ('ai_prompts', 'ai_prompts_delete_own'),
    ('ai_prompts', 'ai_prompts_insert_own'),
    ('ai_prompts', 'ai_prompts_select_own'),
    ('ai_prompts', 'ai_prompts_update_own'),
    ('automation_enrollments', 'automation_enrollments_select_own'),
    ('automation_failures', 'automation_failures_select_own'),
    ('automation_jobs', 'automation_jobs_select_own'),
    ('automation_rules', 'automation_rules_delete_own'),
    ('automation_rules', 'automation_rules_insert_own'),
    ('automation_rules', 'automation_rules_select_own'),
    ('automation_rules', 'automation_rules_update_own'),
    ('automation_runs', 'automation_runs_select_own'),
    ('automation_steps', 'automation_steps_delete_own'),
    ('automation_steps', 'automation_steps_insert_own'),
    ('automation_steps', 'automation_steps_select_own'),
    ('automation_steps', 'automation_steps_update_own'),
    ('automation_trigger_events', 'automation_trigger_events_select_own'),
    ('communication_consents', 'communication_consents_select_own'),
    ('contact_identity_keys', 'contact_identity_keys_select_own'),
    ('contacts', 'contacts_delete_own'),
    ('contacts', 'contacts_insert_own'),
    ('contacts', 'contacts_select_own'),
    ('contacts', 'contacts_update_own'),
    ('custom_field_values', 'custom_field_values_delete_own'),
    ('custom_field_values', 'custom_field_values_insert_own'),
    ('custom_field_values', 'custom_field_values_select_own'),
    ('custom_field_values', 'custom_field_values_update_own'),
    ('deals', 'deals_delete_own'),
    ('deals', 'deals_insert_own'),
    ('deals', 'deals_select_own'),
    ('deals', 'deals_update_own'),
    ('email_sender_profiles', 'email_sender_profiles_insert_own'),
    ('email_sender_profiles', 'email_sender_profiles_select_own'),
    ('email_sender_profiles', 'email_sender_profiles_update_own'),
    ('email_suppressions', 'email_suppressions_select_own'),
    ('finance_records', 'finance_records_delete_own'),
    ('finance_records', 'finance_records_insert_own'),
    ('finance_records', 'finance_records_select_own'),
    ('finance_records', 'finance_records_update_own'),
    ('goals', 'goals_delete_own'),
    ('goals', 'goals_insert_own'),
    ('goals', 'goals_select_own'),
    ('goals', 'goals_update_own'),
    ('lead_import_batches', 'lead_import_batches_select_own'),
    ('lead_import_rows', 'lead_import_rows_select_own'),
    ('lead_source_connections', 'lead_source_connections_delete_own'),
    ('lead_source_connections', 'lead_source_connections_insert_own'),
    ('lead_source_connections', 'lead_source_connections_select_own'),
    ('lead_source_connections', 'lead_source_connections_update_own'),
    ('lead_source_mappings', 'lead_source_mappings_delete_own'),
    ('lead_source_mappings', 'lead_source_mappings_insert_own'),
    ('lead_source_mappings', 'lead_source_mappings_select_own'),
    ('lead_source_mappings', 'lead_source_mappings_update_own'),
    ('message_templates', 'message_templates_delete_own'),
    ('message_templates', 'message_templates_insert_own'),
    ('message_templates', 'message_templates_select_own'),
    ('message_templates', 'message_templates_update_own'),
    ('milestones', 'milestones_delete_own'),
    ('milestones', 'milestones_insert_own'),
    ('milestones', 'milestones_select_own'),
    ('milestones', 'milestones_update_own'),
    ('notifications', 'notifications_select_own'),
    ('notifications', 'notifications_update_own'),
    ('outbound_messages', 'outbound_messages_select_own'),
    ('properties', 'properties_delete_own'),
    ('properties', 'properties_insert_own'),
    ('properties', 'properties_select_own'),
    ('properties', 'properties_update_own'),
    ('referrals', 'referrals_delete_own'),
    ('referrals', 'referrals_insert_own'),
    ('referrals', 'referrals_select_own'),
    ('referrals', 'referrals_update_own'),
    ('scheduled_items', 'scheduled_items_delete_own'),
    ('scheduled_items', 'scheduled_items_insert_own'),
    ('scheduled_items', 'scheduled_items_select_own'),
    ('scheduled_items', 'scheduled_items_update_own'),
    ('scripts', 'scripts_delete_own'),
    ('scripts', 'scripts_insert_own'),
    ('scripts', 'scripts_select_own'),
    ('scripts', 'scripts_update_own'),
    ('showings', 'showings_delete_own'),
    ('showings', 'showings_insert_own'),
    ('showings', 'showings_select_own'),
    ('showings', 'showings_update_own'),
    ('tasks', 'tasks_delete_own'),
    ('tasks', 'tasks_insert_own'),
    ('tasks', 'tasks_select_own'),
    ('tasks', 'tasks_update_own'),
    ('team_members', 'team_members_delete_own'),
    ('team_members', 'team_members_insert_own'),
    ('team_members', 'team_members_select_own'),
    ('team_members', 'team_members_update_own'),
    ('webhook_events', 'webhook_events_select_own'),
    ('workspace_settings', 'workspace_settings_delete_own'),
    ('workspace_settings', 'workspace_settings_insert_own'),
    ('workspace_settings', 'workspace_settings_select_own'),
    ('workspace_settings', 'workspace_settings_update_own')
  ) as v(tbl, pol)
  loop
    execute format('drop policy if exists %I on public.%I', r.pol, r.tbl);
  end loop;
end $drop$;

-- Legacy workspace_state keeps its user_id policies: it is the
-- pre-relational table, has no workspace_id, and nothing reads it.
-- (Simplest safe option; noted rather than migrated.)

-- ============================================================
-- 6. anon loses every table privilege in public. Nothing in the app
--    uses the anon role for data (auth happens first), so SELECT goes
--    too, not just the writes.
-- ============================================================
do $anon$
declare t record;
begin
  for t in select c.relname from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r'
  loop
    execute format('revoke all on public.%I from anon', t.relname);
  end loop;
end $anon$;
`);

fs.writeFileSync(process.argv[2], L.join("\n"));
const n = (fs.readFileSync(process.argv[2], "utf8").match(/^create policy /gm) || []).length;
console.error(`wrote ${process.argv[2]} policies=${n}`);
