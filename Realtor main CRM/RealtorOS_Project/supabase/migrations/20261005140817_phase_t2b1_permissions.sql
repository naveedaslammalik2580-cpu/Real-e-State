-- Phase T2b-1: permission system (additive only).
--
-- Introduces role templates + per-member overrides, the authz schema that
-- RLS will call in T2b-2, three browser-callable RPCs for reading and
-- editing permissions, an audit table for every change, and a visibility
-- flag (shared|personal) on the four library tables (message_templates,
-- scripts, ai_prompts, automation_rules).
--
-- NOTHING in this phase changes existing RLS policies, grants on existing
-- tables, or Edge Function behavior. Policies switch in T2b-2.
--
-- Model (fixed, validated keys):
--
--   Scoped areas — each with
--     view: 'none' | 'own' | 'all'
--     edit: 'none' | 'own' | 'all'
--     delete: 'none' | 'own' | 'all'
--     create: boolean
--     Invariant: edit <= view, delete <= view (none < own < all).
--   Areas: contacts, deals, work, properties, finance, goals.
--
--   Booleans (10): contacts_assign, unassigned_view, unassigned_claim,
--     templates_manage_shared, templates_create_personal,
--     automation_manage_shared, automation_create_personal,
--     imports_file, integrations_manage, team_manage.
--
--   Enum: settings in ('none','view','edit').
--
-- Ordering: scope none<own<all, settings none<view<edit, bool false<true.
--
-- Owners are implicit full and never stored. workspace_role_permissions
-- has 'admin' and 'agent' rows per workspace, each seeded on workspace
-- creation and backfilled for existing workspaces.
--
-- Idempotent: CREATE IF NOT EXISTS / CREATE OR REPLACE throughout; the
-- role-permission seed uses ON CONFLICT DO NOTHING; the visibility column
-- is added with IF NOT EXISTS and a DEFAULT that fills existing rows.

-- ============================================================
-- 0. Schemas and helpers.
-- ============================================================
create schema if not exists automation_internal;
revoke all on schema automation_internal from public, anon;
-- authenticated gets USAGE on this schema (not CREATE / anything else)
-- so authz.* INVOKER functions can call the two pure JSON helpers that
-- live here (default_role_permissions, merge_permissions). Each function
-- in this schema is individually revoked from authenticated by default
-- and granted back only where safe.
grant usage on schema automation_internal to authenticated, service_role;

create schema if not exists authz;
revoke all on schema authz from public, anon;
grant usage on schema authz to authenticated, service_role;

-- ============================================================
-- 1. Permission presets (callable from the seed path, the backfill,
--    the UI's "reset to default" button, and the test suite).
-- ============================================================
create or replace function automation_internal.default_role_permissions(p_role text)
returns jsonb
language sql
immutable
set search_path = ''
as $fn$
  select case
    when p_role = 'admin' then jsonb_build_object(
      'contacts',   jsonb_build_object('view','all','edit','all','delete','all','create', true),
      'deals',      jsonb_build_object('view','all','edit','all','delete','all','create', true),
      'work',       jsonb_build_object('view','all','edit','all','delete','all','create', true),
      'properties', jsonb_build_object('view','all','edit','all','delete','all','create', true),
      'finance',    jsonb_build_object('view','all','edit','all','delete','all','create', true),
      'goals',      jsonb_build_object('view','all','edit','all','delete','all','create', true),
      'contacts_assign',           true,
      'unassigned_view',           true,
      'unassigned_claim',          true,
      'templates_manage_shared',   true,
      'templates_create_personal', true,
      'automation_manage_shared',  true,
      'automation_create_personal',true,
      'imports_file',              true,
      'integrations_manage',       true,
      'team_manage',               true,
      'settings',                  'edit'
    )
    when p_role = 'agent' then jsonb_build_object(
      'contacts',   jsonb_build_object('view','own','edit','own','delete','none','create', true),
      'deals',      jsonb_build_object('view','own','edit','own','delete','none','create', true),
      'work',       jsonb_build_object('view','own','edit','own','delete','own', 'create', true),
      'properties', jsonb_build_object('view','all','edit','own','delete','own', 'create', true),
      'finance',    jsonb_build_object('view','none','edit','none','delete','none','create', false),
      'goals',      jsonb_build_object('view','own','edit','own','delete','own', 'create', true),
      'contacts_assign',           false,
      'unassigned_view',           false,
      'unassigned_claim',          false,
      'templates_manage_shared',   false,
      'templates_create_personal', true,
      'automation_manage_shared',  false,
      'automation_create_personal',true,
      'imports_file',              true,
      'integrations_manage',       false,
      'team_manage',               false,
      'settings',                  'none'
    )
    else null::jsonb
  end;
$fn$;

revoke all on function automation_internal.default_role_permissions(text)
  from public, anon;
grant execute on function automation_internal.default_role_permissions(text)
  to authenticated, service_role;

comment on function automation_internal.default_role_permissions(text) is
  'Phase T2b-1. Returns the hard-coded preset permission JSON for ''admin'' or ''agent'' (null for anything else, including ''owner'' which is implicit full). Seeded on workspace creation; applied again by the UI''s reset-to-default button through realtoros_set_role_permissions.';

-- ============================================================
-- 2. Validation function and ordering helpers.
-- ============================================================

-- Scope ranking: none=0, own=1, all=2.
create or replace function automation_internal.scope_rank(p text)
returns int language sql immutable set search_path = '' as $fn$
  select case p when 'none' then 0 when 'own' then 1 when 'all' then 2 else null end;
$fn$;
revoke all on function automation_internal.scope_rank(text) from public, anon, authenticated;
grant execute on function automation_internal.scope_rank(text) to service_role;

-- Settings ranking: none=0, view=1, edit=2.
create or replace function automation_internal.settings_rank(p text)
returns int language sql immutable set search_path = '' as $fn$
  select case p when 'none' then 0 when 'view' then 1 when 'edit' then 2 else null end;
$fn$;
revoke all on function automation_internal.settings_rank(text) from public, anon, authenticated;
grant execute on function automation_internal.settings_rank(text) to service_role;

-- Validator. Raises on invalid shape, unknown keys, bad values, scope
-- orderings edit>view / delete>view, non-object input. For role
-- templates (p_is_overrides=false) every key is required; for overrides
-- (p_is_overrides=true) any subset of valid keys is allowed.
create or replace function automation_internal.validate_permissions(p jsonb, p_is_overrides boolean)
returns boolean
language plpgsql
immutable
set search_path = ''
as $fn$
declare
  v_known_areas constant text[] := array['contacts','deals','work','properties','finance','goals'];
  v_known_bools constant text[] := array[
    'contacts_assign','unassigned_view','unassigned_claim',
    'templates_manage_shared','templates_create_personal',
    'automation_manage_shared','automation_create_personal',
    'imports_file','integrations_manage','team_manage'
  ];
  v_known_keys constant text[] := v_known_areas || v_known_bools || array['settings'];
  v_key text;
  v_area_rec record;
  v_view_rank int;
  v_edit_rank int;
  v_delete_rank int;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'permissions must be a JSON object' using errcode = '22023';
  end if;

  -- Reject unknown keys up front (both role and overrides).
  for v_key in select k from jsonb_object_keys(p) k loop
    if not (v_key = any (v_known_keys)) then
      raise exception 'unknown permission key: %', v_key using errcode = '22023';
    end if;
  end loop;

  -- For role templates, every known key must be present.
  if not p_is_overrides then
    foreach v_key in array v_known_keys loop
      if not (p ? v_key) then
        raise exception 'missing required permission key: %', v_key using errcode = '22023';
      end if;
    end loop;
  end if;

  -- Scoped areas: shape and scope ordering.
  foreach v_key in array v_known_areas loop
    if p ? v_key then
      if jsonb_typeof(p -> v_key) <> 'object' then
        raise exception 'permissions.% must be an object', v_key using errcode = '22023';
      end if;

      -- No unknown sub-keys inside a scoped area.
      declare v_subkey text;
      begin
        for v_subkey in select k from jsonb_object_keys(p -> v_key) k loop
          if not (v_subkey = any (array['view','edit','delete','create'])) then
            raise exception 'permissions.%: unknown sub-key %', v_key, v_subkey using errcode = '22023';
          end if;
        end loop;
      end;

      -- For role templates every sub-key is required; for overrides any
      -- subset is permitted.
      if not p_is_overrides then
        if not ((p -> v_key) ? 'view'
            and (p -> v_key) ? 'edit'
            and (p -> v_key) ? 'delete'
            and (p -> v_key) ? 'create') then
          raise exception 'permissions.% must include view/edit/delete/create', v_key using errcode = '22023';
        end if;
      end if;

      if (p -> v_key) ? 'view' then
        v_view_rank := automation_internal.scope_rank(p -> v_key ->> 'view');
        if v_view_rank is null then
          raise exception 'permissions.%.view must be one of none|own|all', v_key using errcode = '22023';
        end if;
      end if;
      if (p -> v_key) ? 'edit' then
        v_edit_rank := automation_internal.scope_rank(p -> v_key ->> 'edit');
        if v_edit_rank is null then
          raise exception 'permissions.%.edit must be one of none|own|all', v_key using errcode = '22023';
        end if;
      end if;
      if (p -> v_key) ? 'delete' then
        v_delete_rank := automation_internal.scope_rank(p -> v_key ->> 'delete');
        if v_delete_rank is null then
          raise exception 'permissions.%.delete must be one of none|own|all', v_key using errcode = '22023';
        end if;
      end if;
      if (p -> v_key) ? 'create' then
        if jsonb_typeof(p -> v_key -> 'create') <> 'boolean' then
          raise exception 'permissions.%.create must be boolean', v_key using errcode = '22023';
        end if;
      end if;

      -- Rule: edit, delete <= view. Only enforce when both are present
      -- in the input (role templates will always satisfy this; overrides
      -- enforce it after merging with the role template, see RPC).
      if (p -> v_key) ? 'view' and (p -> v_key) ? 'edit' and v_edit_rank > v_view_rank then
        raise exception 'permissions.%: edit (%) must be <= view (%)',
          v_key, p -> v_key ->> 'edit', p -> v_key ->> 'view' using errcode = '22023';
      end if;
      if (p -> v_key) ? 'view' and (p -> v_key) ? 'delete' and v_delete_rank > v_view_rank then
        raise exception 'permissions.%: delete (%) must be <= view (%)',
          v_key, p -> v_key ->> 'delete', p -> v_key ->> 'view' using errcode = '22023';
      end if;
    end if;
  end loop;

  -- Booleans.
  foreach v_key in array v_known_bools loop
    if p ? v_key and jsonb_typeof(p -> v_key) <> 'boolean' then
      raise exception 'permissions.% must be boolean', v_key using errcode = '22023';
    end if;
  end loop;

  -- settings enum.
  if p ? 'settings' then
    if jsonb_typeof(p -> 'settings') <> 'string'
       or automation_internal.settings_rank(p ->> 'settings') is null then
      raise exception 'permissions.settings must be one of none|view|edit' using errcode = '22023';
    end if;
  end if;

  return true;
end;
$fn$;

revoke all on function automation_internal.validate_permissions(jsonb, boolean)
  from public, anon, authenticated;
grant execute on function automation_internal.validate_permissions(jsonb, boolean)
  to service_role;

comment on function automation_internal.validate_permissions(jsonb, boolean) is
  'Phase T2b-1. Validator for role permission templates (p_is_overrides=false — every known key required) and per-member overrides (p_is_overrides=true — any subset). Raises 22023 on any violation (unknown key/sub-key, wrong value type, scope ordering edit>view or delete>view, non-object). Used by the trigger that gates workspace_role_permissions and workspace_members writes.';

-- Exception-swallowing wrapper used by the verification SQL (and by
-- tests) to classify a JSON blob as valid-or-not without raising.
create or replace function automation_internal.safe_validate(p jsonb, p_is_overrides boolean)
returns boolean
language plpgsql
immutable
set search_path = ''
as $fn$
begin
  perform automation_internal.validate_permissions(p, p_is_overrides);
  return true;
exception when others then
  return false;
end;
$fn$;
revoke all on function automation_internal.safe_validate(jsonb, boolean) from public, anon, authenticated;
grant execute on function automation_internal.safe_validate(jsonb, boolean) to service_role;

-- ============================================================
-- 3. workspace_role_permissions (per-workspace role template).
-- ============================================================
create table if not exists public.workspace_role_permissions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  role text not null check (role in ('admin', 'agent')),
  permissions jsonb not null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, role)
);

alter table public.workspace_role_permissions enable row level security;

revoke all on public.workspace_role_permissions from public, anon, authenticated;
grant select on public.workspace_role_permissions to authenticated;
grant all on public.workspace_role_permissions to service_role;

-- SELECT: members of the workspace may read their workspace's role
-- templates. Browser INSERT/UPDATE/DELETE goes through the SECURITY
-- DEFINER RPCs defined below.
drop policy if exists workspace_role_permissions_select_member on public.workspace_role_permissions;
create policy workspace_role_permissions_select_member
  on public.workspace_role_permissions
  for select to authenticated
  using (
    exists (
      select 1 from public.workspace_members wm
      where wm.workspace_id = workspace_role_permissions.workspace_id
        and wm.user_id = (select auth.uid())
        and wm.status = 'active'
    )
  );

drop trigger if exists workspace_role_permissions_set_updated_at on public.workspace_role_permissions;
create trigger workspace_role_permissions_set_updated_at
  before update on public.workspace_role_permissions
  for each row execute function public.realtoros_set_updated_at();

-- Validate JSON on insert/update.
create or replace function automation_internal.validate_role_permissions_row()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  perform automation_internal.validate_permissions(new.permissions, false);
  return new;
end;
$fn$;
revoke all on function automation_internal.validate_role_permissions_row() from public, anon, authenticated;

drop trigger if exists workspace_role_permissions_validate on public.workspace_role_permissions;
create trigger workspace_role_permissions_validate
  before insert or update of permissions on public.workspace_role_permissions
  for each row execute function automation_internal.validate_role_permissions_row();

-- ============================================================
-- 4. workspace_members.permission_overrides jsonb (+ validation).
-- ============================================================
alter table public.workspace_members
  add column if not exists permission_overrides jsonb not null default '{}'::jsonb;

create or replace function automation_internal.validate_member_overrides_row()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  perform automation_internal.validate_permissions(coalesce(new.permission_overrides, '{}'::jsonb), true);
  return new;
end;
$fn$;
revoke all on function automation_internal.validate_member_overrides_row() from public, anon, authenticated;

drop trigger if exists workspace_members_validate_overrides on public.workspace_members;
create trigger workspace_members_validate_overrides
  before insert or update of permission_overrides on public.workspace_members
  for each row execute function automation_internal.validate_member_overrides_row();

-- ============================================================
-- 5. workspace_permission_changes (audit).
-- ============================================================
create table if not exists public.workspace_permission_changes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- actor_user_id is nullable + ON DELETE SET NULL: the audit row survives
  -- the actor's auth.users deletion, with actor_label as a readable
  -- snapshot taken at write time.
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_label text not null default '',
  target_role text check (target_role is null or target_role in ('admin','agent')),
  -- target_member_id is ON DELETE SET NULL for the same reason; the CHECK
  -- below treats a null target_member_id as valid for member-target rows
  -- so the delete isn't blocked. target_label keeps the row readable.
  target_member_id uuid references public.workspace_members(id) on delete set null,
  target_label text not null default '',
  action text not null check (action in ('set_role','set_member','reset_member')),
  before_permissions jsonb,
  after_permissions jsonb,
  at timestamptz not null default now(),
  check (
    (target_role is not null and target_member_id is null)  -- role-target row
    or (target_role is null)                                -- member-target row (possibly nulled on delete)
  )
);

alter table public.workspace_permission_changes enable row level security;
revoke all on public.workspace_permission_changes from public, anon, authenticated;
grant select on public.workspace_permission_changes to authenticated;
grant all on public.workspace_permission_changes to service_role;

create index if not exists workspace_permission_changes_by_workspace
  on public.workspace_permission_changes (workspace_id, at desc);
create index if not exists workspace_permission_changes_workspace_id_id_uq
  on public.workspace_permission_changes (workspace_id, id);

-- ============================================================
-- 6. authz schema — read-only helpers RLS calls in T2b-2.
--
-- All INVOKER: a non-member calling any of these functions reaches
-- workspace_members / workspace_role_permissions through RLS, which
-- (per T2a's SELECT policies and this phase's new SELECT policy) only
-- yields rows the caller is a member of. So:
--   * authz.member(ws)                    returns null for non-members;
--   * authz.effective_permissions(ws)     returns null for non-members;
--   * authz.scope / authz.can / authz.settings_level all fail-closed
--     on null → 'none' / false / 'none'.
-- This is why none of them need SECURITY DEFINER — they cannot leak
-- another workspace's data.
-- ============================================================

-- Returns (role, team_member_id, user_id) for the caller's active
-- membership of p_workspace_id, or null when the caller isn't an active
-- member. STABLE so the planner can batch calls inside an RLS policy.
create or replace function authz.member(p_workspace_id uuid)
returns table (role text, team_member_id text, user_id uuid)
language sql
stable
set search_path = ''
as $fn$
  select wm.role, wm.team_member_id, wm.user_id
    from public.workspace_members wm
   where wm.workspace_id = p_workspace_id
     and wm.user_id = (select auth.uid())
     and wm.status = 'active'
   limit 1;
$fn$;
revoke all on function authz.member(uuid) from public, anon;
grant execute on function authz.member(uuid) to authenticated, service_role;

-- Returns the fully-merged permission JSON for the caller in
-- p_workspace_id. Owner always returns the admin preset. Admin/agent
-- return the role template jsonb_concat'd with their overrides. Non-
-- members return NULL.
create or replace function authz.effective_permissions(p_workspace_id uuid)
returns jsonb
language plpgsql
stable
set search_path = ''
as $fn$
declare
  v_role text;
  v_overrides jsonb;
  v_template jsonb;
begin
  select m.role into v_role from authz.member(p_workspace_id) m;
  if v_role is null then
    return null;
  end if;
  if v_role = 'owner' then
    -- Implicit full. The admin preset is identical to "full" by design;
    -- using it here avoids a second code path.
    return automation_internal.default_role_permissions('admin');
  end if;
  select wm.permission_overrides into v_overrides
    from public.workspace_members wm
    where wm.workspace_id = p_workspace_id
      and wm.user_id = (select auth.uid())
      and wm.status = 'active';
  select wrp.permissions into v_template
    from public.workspace_role_permissions wrp
    where wrp.workspace_id = p_workspace_id
      and wrp.role = v_role;
  if v_template is null then
    -- No row yet (should never happen post-seed; defensive): fall back
    -- to the preset for the role rather than returning null.
    v_template := automation_internal.default_role_permissions(v_role);
  end if;
  return automation_internal.merge_permissions(v_template, coalesce(v_overrides, '{}'::jsonb));
end;
$fn$;
revoke all on function authz.effective_permissions(uuid) from public, anon;
grant execute on function authz.effective_permissions(uuid) to authenticated, service_role;

-- Deep-merges per-area objects: overrides' sub-keys replace the
-- template's, missing sub-keys stay from the template. Top-level
-- non-object keys (booleans, settings) are a straight override.
create or replace function automation_internal.merge_permissions(p_template jsonb, p_overrides jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $fn$
declare
  v_merged jsonb := p_template;
  v_key text;
  v_val jsonb;
begin
  if p_overrides is null or jsonb_typeof(p_overrides) <> 'object' then
    return v_merged;
  end if;
  for v_key, v_val in select * from jsonb_each(p_overrides) loop
    if jsonb_typeof(v_val) = 'object'
       and v_merged ? v_key
       and jsonb_typeof(v_merged -> v_key) = 'object' then
      v_merged := v_merged || jsonb_build_object(v_key, (v_merged -> v_key) || v_val);
    else
      v_merged := v_merged || jsonb_build_object(v_key, v_val);
    end if;
  end loop;
  return v_merged;
end;
$fn$;
revoke all on function automation_internal.merge_permissions(jsonb, jsonb) from public, anon;
grant execute on function automation_internal.merge_permissions(jsonb, jsonb) to authenticated, service_role;

-- Convenience lookups. Non-member callers get 'none' / false by default.
create or replace function authz.scope(p_workspace_id uuid, p_area text, p_action text)
returns text
language sql
stable
set search_path = ''
as $fn$
  select coalesce(authz.effective_permissions(p_workspace_id) -> p_area ->> p_action, 'none');
$fn$;
revoke all on function authz.scope(uuid, text, text) from public, anon;
grant execute on function authz.scope(uuid, text, text) to authenticated, service_role;

create or replace function authz.can(p_workspace_id uuid, p_key text)
returns boolean
language sql
stable
set search_path = ''
as $fn$
  select coalesce((authz.effective_permissions(p_workspace_id) ->> p_key)::boolean, false);
$fn$;
revoke all on function authz.can(uuid, text) from public, anon;
grant execute on function authz.can(uuid, text) to authenticated, service_role;

create or replace function authz.settings_level(p_workspace_id uuid)
returns text
language sql
stable
set search_path = ''
as $fn$
  select coalesce(authz.effective_permissions(p_workspace_id) ->> 'settings', 'none');
$fn$;
revoke all on function authz.settings_level(uuid) from public, anon;
grant execute on function authz.settings_level(uuid) to authenticated, service_role;

-- ---------- Caller-only convenience helpers (for RLS performance) ----------
-- The (ws, …) functions above take workspace_id from a row, so a policy
-- like `authz.scope(workspace_id, 'contacts', 'view') = 'all'` would call
-- the function once per row. These no-argument wrappers resolve the
-- caller's single active workspace once per statement — the T2b-2
-- policies wrap each call in (select …) so Postgres evaluates it as an
-- InitPlan.
--
-- Non-member callers get null / 'none' / false from every one of these,
-- same fail-closed semantics as the (ws, …) family.
create or replace function authz.my_workspace_id()
returns uuid language sql stable set search_path = '' as $fn$
  select workspace_id from public.workspace_members
    where user_id = (select auth.uid()) and status = 'active' limit 1;
$fn$;
revoke all on function authz.my_workspace_id() from public, anon;
grant execute on function authz.my_workspace_id() to authenticated, service_role;

create or replace function authz.my_team_member_id()
returns text language sql stable set search_path = '' as $fn$
  select team_member_id from public.workspace_members
    where user_id = (select auth.uid()) and status = 'active' limit 1;
$fn$;
revoke all on function authz.my_team_member_id() from public, anon;
grant execute on function authz.my_team_member_id() to authenticated, service_role;

create or replace function authz.my_role()
returns text language sql stable set search_path = '' as $fn$
  select role from public.workspace_members
    where user_id = (select auth.uid()) and status = 'active' limit 1;
$fn$;
revoke all on function authz.my_role() from public, anon;
grant execute on function authz.my_role() to authenticated, service_role;

create or replace function authz.my_scope(p_area text, p_action text)
returns text language sql stable set search_path = '' as $fn$
  select coalesce(authz.effective_permissions(authz.my_workspace_id()) -> p_area ->> p_action, 'none');
$fn$;
revoke all on function authz.my_scope(text, text) from public, anon;
grant execute on function authz.my_scope(text, text) to authenticated, service_role;

create or replace function authz.my_can(p_key text)
returns boolean language sql stable set search_path = '' as $fn$
  select coalesce((authz.effective_permissions(authz.my_workspace_id()) ->> p_key)::boolean, false);
$fn$;
revoke all on function authz.my_can(text) from public, anon;
grant execute on function authz.my_can(text) to authenticated, service_role;

create or replace function authz.my_settings_level()
returns text language sql stable set search_path = '' as $fn$
  select coalesce(authz.effective_permissions(authz.my_workspace_id()) ->> 'settings', 'none');
$fn$;
revoke all on function authz.my_settings_level() from public, anon;
grant execute on function authz.my_settings_level() to authenticated, service_role;

-- SELECT policy for the audit table: only team_manage holders see it.
drop policy if exists workspace_permission_changes_select_tm on public.workspace_permission_changes;
create policy workspace_permission_changes_select_tm
  on public.workspace_permission_changes
  for select to authenticated
  using (authz.can(workspace_permission_changes.workspace_id, 'team_manage'));

-- ============================================================
-- 7. "Can grant" helper used by set_role / set_member.
--
-- For every key the proposed JSON mentions, the actor's own effective
-- permissions must be >= the proposed value. Returns a text error
-- message when a violation is found, null on success.
-- ============================================================
create or replace function automation_internal.permissions_within_actor(
  p_actor_effective jsonb,
  p_proposed jsonb
) returns text
language plpgsql
immutable
set search_path = ''
as $fn$
declare
  v_known_areas constant text[] := array['contacts','deals','work','properties','finance','goals'];
  v_known_bools constant text[] := array[
    'contacts_assign','unassigned_view','unassigned_claim',
    'templates_manage_shared','templates_create_personal',
    'automation_manage_shared','automation_create_personal',
    'imports_file','integrations_manage','team_manage'
  ];
  v_key text;
  v_sub text;
  v_actor_rank int;
  v_proposed_rank int;
begin
  if p_proposed is null then
    return null;
  end if;

  foreach v_key in array v_known_areas loop
    if p_proposed ? v_key then
      foreach v_sub in array array['view','edit','delete'] loop
        if (p_proposed -> v_key) ? v_sub then
          v_actor_rank := automation_internal.scope_rank(p_actor_effective -> v_key ->> v_sub);
          v_proposed_rank := automation_internal.scope_rank(p_proposed -> v_key ->> v_sub);
          if v_proposed_rank > coalesce(v_actor_rank, 0) then
            return format('cannot grant %s.%s=%s; your own is %s',
              v_key, v_sub, p_proposed -> v_key ->> v_sub,
              coalesce(p_actor_effective -> v_key ->> v_sub, 'none'));
          end if;
        end if;
      end loop;
      if (p_proposed -> v_key) ? 'create' then
        if (p_proposed -> v_key -> 'create')::boolean
           and not coalesce((p_actor_effective -> v_key -> 'create')::boolean, false) then
          return format('cannot grant %s.create=true; your own is false', v_key);
        end if;
      end if;
    end if;
  end loop;

  foreach v_key in array v_known_bools loop
    if p_proposed ? v_key
       and (p_proposed -> v_key)::boolean
       and not coalesce((p_actor_effective -> v_key)::boolean, false) then
      return format('cannot grant %s=true; your own is false', v_key);
    end if;
  end loop;

  if p_proposed ? 'settings' then
    v_actor_rank := automation_internal.settings_rank(p_actor_effective ->> 'settings');
    v_proposed_rank := automation_internal.settings_rank(p_proposed ->> 'settings');
    if v_proposed_rank > coalesce(v_actor_rank, 0) then
      return format('cannot grant settings=%s; your own is %s',
        p_proposed ->> 'settings',
        coalesce(p_actor_effective ->> 'settings', 'none'));
    end if;
  end if;

  return null;
end;
$fn$;
revoke all on function automation_internal.permissions_within_actor(jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function automation_internal.permissions_within_actor(jsonb, jsonb)
  to service_role;

-- ============================================================
-- 8. Browser-callable RPCs.
-- ============================================================

-- Returns the caller's workspace, role, team_member_id and effective
-- permissions. Used by the frontend on boot (T2d).
create or replace function public.realtoros_my_permissions()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_wm record;
  v_perms jsonb;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select wm.workspace_id, wm.role, wm.team_member_id, wm.id as member_id
    into v_wm
    from public.workspace_members wm
    where wm.user_id = v_uid and wm.status = 'active'
    limit 1;
  if v_wm.workspace_id is null then
    return null;
  end if;
  if v_wm.role = 'owner' then
    v_perms := automation_internal.default_role_permissions('admin');
  else
    select automation_internal.merge_permissions(
      coalesce(wrp.permissions, automation_internal.default_role_permissions(v_wm.role)),
      coalesce(wm2.permission_overrides, '{}'::jsonb)
    ) into v_perms
    from public.workspace_members wm2
    left join public.workspace_role_permissions wrp
      on wrp.workspace_id = v_wm.workspace_id and wrp.role = v_wm.role
    where wm2.id = v_wm.member_id;
  end if;
  return jsonb_build_object(
    'workspace_id', v_wm.workspace_id,
    'role', v_wm.role,
    'team_member_id', v_wm.team_member_id,
    'member_id', v_wm.member_id,
    'permissions', v_perms
  );
end;
$fn$;
revoke all on function public.realtoros_my_permissions() from public, anon;
grant execute on function public.realtoros_my_permissions() to authenticated;
comment on function public.realtoros_my_permissions() is
  'Phase T2b-1. Returns {workspace_id, role, team_member_id, member_id, permissions} for the caller''s active workspace membership (null if none). SECURITY DEFINER + search_path=''; authenticated-only.';

-- Set a workspace role template.
create or replace function public.realtoros_set_role_permissions(
  p_role text,
  p_permissions jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_actor record;
  v_actor_effective jsonb;
  v_denial text;
  v_before jsonb;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  if p_role not in ('admin','agent') then
    raise exception 'role must be admin or agent (owner is implicit full)' using errcode = '22023';
  end if;

  select wm.workspace_id, wm.role, wm.id as member_id
    into v_actor
    from public.workspace_members wm
    where wm.user_id = v_uid and wm.status = 'active'
    limit 1;
  if v_actor.workspace_id is null then
    raise exception 'no active workspace membership' using errcode = '42501';
  end if;

  if v_actor.role = 'owner' then
    v_actor_effective := automation_internal.default_role_permissions('admin');
  else
    v_actor_effective := authz.effective_permissions(v_actor.workspace_id);
    if not coalesce((v_actor_effective ->> 'team_manage')::boolean, false) then
      raise exception 'team_manage required' using errcode = '42501';
    end if;
  end if;

  -- Shape + ordering validation first (also runs through the trigger
  -- on INSERT, but we want to raise cleaner errors before auditing).
  perform automation_internal.validate_permissions(p_permissions, false);

  -- Grant limit: no key may exceed the actor's own effective permission.
  v_denial := automation_internal.permissions_within_actor(v_actor_effective, p_permissions);
  if v_denial is not null then
    raise exception '%', v_denial using errcode = '42501';
  end if;

  select wrp.permissions into v_before
    from public.workspace_role_permissions wrp
    where wrp.workspace_id = v_actor.workspace_id and wrp.role = p_role;

  insert into public.workspace_role_permissions (workspace_id, role, permissions, updated_by)
    values (v_actor.workspace_id, p_role, p_permissions, v_uid)
    on conflict (workspace_id, role)
    do update set permissions = excluded.permissions, updated_by = v_uid;

  insert into public.workspace_permission_changes
    (workspace_id, actor_user_id, actor_label,
     target_role, target_member_id, target_label,
     action, before_permissions, after_permissions)
    values (
      v_actor.workspace_id, v_uid,
      coalesce(
        (select to_jsonb(u) ->> 'email' from auth.users u where u.id = v_uid),
        (select tm.name from public.team_members tm
          where tm.workspace_id = v_actor.workspace_id and tm.auth_user_id = v_uid
          limit 1),
        ''
      ),
      p_role, null, 'role:' || p_role,
      'set_role', v_before, p_permissions
    );

  return jsonb_build_object('workspace_id', v_actor.workspace_id, 'role', p_role, 'permissions', p_permissions);
end;
$fn$;
revoke all on function public.realtoros_set_role_permissions(text, jsonb) from public, anon;
grant execute on function public.realtoros_set_role_permissions(text, jsonb) to authenticated;
comment on function public.realtoros_set_role_permissions(text, jsonb) is
  'Phase T2b-1. Updates the workspace''s role template for admin or agent. Caller must be owner, or an active member with team_manage. No key may exceed the caller''s own effective permission. Writes an audit row. Owner is never a valid target (role is implicit full).';

-- Set per-member overrides.
create or replace function public.realtoros_set_member_permissions(
  p_member_id uuid,
  p_overrides jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_actor record;
  v_target record;
  v_actor_effective jsonb;
  v_target_role_template jsonb;
  v_proposed_effective jsonb;
  v_target_prior_effective jsonb;
  v_denial text;
  v_before jsonb;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;

  select wm.workspace_id, wm.role, wm.id as member_id
    into v_actor
    from public.workspace_members wm
    where wm.user_id = v_uid and wm.status = 'active'
    limit 1;
  if v_actor.workspace_id is null then
    raise exception 'no active workspace membership' using errcode = '42501';
  end if;

  select wm.workspace_id, wm.role, wm.permission_overrides, wm.id, wm.user_id, wm.team_member_id
    into v_target
    from public.workspace_members wm
    where wm.id = p_member_id;
  if v_target.id is null then
    raise exception 'target member not found' using errcode = '42704';
  end if;
  if v_target.workspace_id <> v_actor.workspace_id then
    raise exception 'target member is in a different workspace' using errcode = '42501';
  end if;
  if v_target.role = 'owner' then
    raise exception 'the Owner''s permissions are not editable' using errcode = '42501';
  end if;

  if v_actor.role = 'owner' then
    v_actor_effective := automation_internal.default_role_permissions('admin');
  else
    v_actor_effective := authz.effective_permissions(v_actor.workspace_id);
    if not coalesce((v_actor_effective ->> 'team_manage')::boolean, false) then
      raise exception 'team_manage required' using errcode = '42501';
    end if;
  end if;

  perform automation_internal.validate_permissions(coalesce(p_overrides, '{}'::jsonb), true);

  -- Overrides must land <= the actor's own effective permissions.
  v_denial := automation_internal.permissions_within_actor(v_actor_effective, p_overrides);
  if v_denial is not null then
    raise exception '%', v_denial using errcode = '42501';
  end if;

  -- Compute proposed effective permission for the target and enforce
  -- edit/delete <= view inside each area after the merge.
  select wrp.permissions into v_target_role_template
    from public.workspace_role_permissions wrp
    where wrp.workspace_id = v_target.workspace_id and wrp.role = v_target.role;
  if v_target_role_template is null then
    v_target_role_template := automation_internal.default_role_permissions(v_target.role);
  end if;
  v_proposed_effective := automation_internal.merge_permissions(v_target_role_template, coalesce(p_overrides, '{}'::jsonb));
  -- Re-validate as a role (every key present, including the ordering
  -- rule). validate_permissions with p_is_overrides=false enforces it.
  perform automation_internal.validate_permissions(v_proposed_effective, false);

  -- Self-raise guard: when the actor is editing their own membership,
  -- the proposed effective permissions must not exceed the actor's
  -- *current* effective permissions on any key.
  if v_actor.member_id = v_target.id then
    v_denial := automation_internal.permissions_within_actor(v_actor_effective, v_proposed_effective);
    if v_denial is not null then
      raise exception 'cannot raise your own permissions: %', v_denial using errcode = '42501';
    end if;
  end if;

  -- Record the before snapshot (overrides) so the audit stays small.
  v_before := v_target.permission_overrides;

  update public.workspace_members
    set permission_overrides = coalesce(p_overrides, '{}'::jsonb),
        updated_at = now()
    where id = p_member_id;

  insert into public.workspace_permission_changes
    (workspace_id, actor_user_id, actor_label,
     target_role, target_member_id, target_label,
     action, before_permissions, after_permissions)
    values (
      v_actor.workspace_id, v_uid,
      coalesce(
        (select to_jsonb(u) ->> 'email' from auth.users u where u.id = v_uid),
        (select tm.name from public.team_members tm
          where tm.workspace_id = v_actor.workspace_id and tm.auth_user_id = v_uid
          limit 1),
        ''
      ),
      null, p_member_id,
      coalesce(
        (select tm.name from public.team_members tm
          where tm.workspace_id = v_target.workspace_id and tm.id = v_target.team_member_id),
        (select to_jsonb(u) ->> 'email' from auth.users u where u.id = v_target.user_id),
        'member:' || p_member_id::text
      ),
      'set_member', v_before, p_overrides
    );

  return jsonb_build_object('member_id', p_member_id, 'overrides', coalesce(p_overrides, '{}'::jsonb));
end;
$fn$;
revoke all on function public.realtoros_set_member_permissions(uuid, jsonb) from public, anon;
grant execute on function public.realtoros_set_member_permissions(uuid, jsonb) to authenticated;
comment on function public.realtoros_set_member_permissions(uuid, jsonb) is
  'Phase T2b-1. Sets per-member permission_overrides. Caller must have team_manage (or be owner); may not target the Owner; may not grant above their own effective permissions; may not raise their own permissions through self-edit. Writes an audit row.';

-- Clear a member's overrides.
create or replace function public.realtoros_reset_member_permissions(p_member_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_actor record;
  v_target record;
  v_before jsonb;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  select wm.workspace_id, wm.role
    into v_actor
    from public.workspace_members wm
    where wm.user_id = v_uid and wm.status = 'active'
    limit 1;
  if v_actor.workspace_id is null then
    raise exception 'no active workspace membership' using errcode = '42501';
  end if;
  select wm.workspace_id, wm.role, wm.permission_overrides, wm.id, wm.user_id, wm.team_member_id
    into v_target
    from public.workspace_members wm
    where wm.id = p_member_id;
  if v_target.id is null then
    raise exception 'target member not found' using errcode = '42704';
  end if;
  if v_target.workspace_id <> v_actor.workspace_id then
    raise exception 'target member is in a different workspace' using errcode = '42501';
  end if;
  if v_target.role = 'owner' then
    raise exception 'the Owner''s permissions are not editable' using errcode = '42501';
  end if;
  if v_actor.role <> 'owner'
     and not coalesce((authz.effective_permissions(v_actor.workspace_id) ->> 'team_manage')::boolean, false) then
    raise exception 'team_manage required' using errcode = '42501';
  end if;

  v_before := v_target.permission_overrides;
  update public.workspace_members
    set permission_overrides = '{}'::jsonb, updated_at = now()
    where id = p_member_id;
  insert into public.workspace_permission_changes
    (workspace_id, actor_user_id, actor_label,
     target_role, target_member_id, target_label,
     action, before_permissions, after_permissions)
    values (
      v_actor.workspace_id, v_uid,
      coalesce(
        (select to_jsonb(u) ->> 'email' from auth.users u where u.id = v_uid),
        (select tm.name from public.team_members tm
          where tm.workspace_id = v_actor.workspace_id and tm.auth_user_id = v_uid
          limit 1),
        ''
      ),
      null, p_member_id,
      coalesce(
        (select tm.name from public.team_members tm
          where tm.workspace_id = v_target.workspace_id and tm.id = v_target.team_member_id),
        (select to_jsonb(u) ->> 'email' from auth.users u where u.id = v_target.user_id),
        'member:' || p_member_id::text
      ),
      'reset_member', v_before, '{}'::jsonb
    );
  return jsonb_build_object('member_id', p_member_id, 'overrides', '{}'::jsonb);
end;
$fn$;
revoke all on function public.realtoros_reset_member_permissions(uuid) from public, anon;
grant execute on function public.realtoros_reset_member_permissions(uuid) to authenticated;
comment on function public.realtoros_reset_member_permissions(uuid) is
  'Phase T2b-1. Clears a member''s permission_overrides to {}. Same authorization rules as realtoros_set_member_permissions. Writes an audit row.';

-- ============================================================
-- 9. Seed presets on workspace creation + backfill existing workspaces.
--
-- Also extend automation_internal.ensure_personal_workspace so future
-- new signups get their role presets alongside their workspace.
-- ============================================================
create or replace function automation_internal.ensure_personal_workspace(p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_workspace_id uuid;
  v_team_member_id text;
  v_email text;
begin
  if p_user_id is null then
    raise exception 'ensure_personal_workspace: user_id is null' using errcode = '22023';
  end if;

  select workspace_id into v_workspace_id
    from public.workspace_members
    where user_id = p_user_id and status = 'active'
    limit 1;
  if v_workspace_id is not null then
    return v_workspace_id;
  end if;

  select to_jsonb(u) ->> 'email' into v_email
    from auth.users u where u.id = p_user_id;

  insert into public.workspaces (name, owner_user_id)
    values ('My workspace', p_user_id)
    returning id into v_workspace_id;

  insert into public.workspace_members (
    workspace_id, user_id, role, status, team_member_id
  )
  values (v_workspace_id, p_user_id, 'owner', 'active', null);

  v_team_member_id := 'tm_' || replace(p_user_id::text, '-', '');
  insert into public.team_members (
    id, user_id, workspace_id, auth_user_id,
    name, role, email, phone, active
  )
  values (
    v_team_member_id, p_user_id, v_workspace_id, p_user_id,
    coalesce(nullif(v_email, ''), 'Owner'), 'Owner',
    coalesce(v_email, ''), '', true
  )
  on conflict (user_id, id) do nothing;

  update public.workspace_members
    set team_member_id = v_team_member_id
    where workspace_id = v_workspace_id
      and user_id = p_user_id
      and team_member_id is null;

  -- Seed the role templates for this workspace. Idempotent: re-running
  -- the function returns the existing workspace at the top, so this
  -- block never fires twice; the on-conflict is belt-and-braces for a
  -- future call path.
  insert into public.workspace_role_permissions (workspace_id, role, permissions, updated_by)
    values
      (v_workspace_id, 'admin', automation_internal.default_role_permissions('admin'), p_user_id),
      (v_workspace_id, 'agent', automation_internal.default_role_permissions('agent'), p_user_id)
    on conflict (workspace_id, role) do nothing;

  return v_workspace_id;
end;
$fn$;

-- Backfill role templates for every workspace that doesn't have them.
insert into public.workspace_role_permissions (workspace_id, role, permissions, updated_by)
select w.id, 'admin', automation_internal.default_role_permissions('admin'), w.owner_user_id
  from public.workspaces w
  where not exists (
    select 1 from public.workspace_role_permissions wrp
    where wrp.workspace_id = w.id and wrp.role = 'admin'
  );
insert into public.workspace_role_permissions (workspace_id, role, permissions, updated_by)
select w.id, 'agent', automation_internal.default_role_permissions('agent'), w.owner_user_id
  from public.workspaces w
  where not exists (
    select 1 from public.workspace_role_permissions wrp
    where wrp.workspace_id = w.id and wrp.role = 'agent'
  );

-- ============================================================
-- 10. visibility column on the four library tables (schema only; the
--     T2b-2 RLS policies will enforce shared vs personal visibility).
-- ============================================================
alter table public.message_templates
  add column if not exists visibility text not null default 'shared'
  check (visibility in ('shared','personal'));
alter table public.scripts
  add column if not exists visibility text not null default 'shared'
  check (visibility in ('shared','personal'));
alter table public.ai_prompts
  add column if not exists visibility text not null default 'shared'
  check (visibility in ('shared','personal'));
alter table public.automation_rules
  add column if not exists visibility text not null default 'shared'
  check (visibility in ('shared','personal'));

comment on column public.message_templates.visibility is
  'Phase T2b-1 (schema only; policy enforced in T2b-2). ''shared'' means visible to anyone with the templates_manage_shared permission; ''personal'' means visible only to the creator unless they have templates_manage_shared. Existing rows default to ''shared''.';
comment on column public.scripts.visibility is
  'Phase T2b-1. Same model as message_templates.visibility — see that column''s comment.';
comment on column public.ai_prompts.visibility is
  'Phase T2b-1. Same model as message_templates.visibility — see that column''s comment.';
comment on column public.automation_rules.visibility is
  'Phase T2b-1 (schema only). ''shared'' = workspace-wide, editable by holders of automation_manage_shared; ''personal'' = creator-only. Existing rows default to ''shared''.';

-- ============================================================
-- 11. Table / column comments on the new permission objects.
-- ============================================================
comment on table public.workspace_role_permissions is
  'Phase T2b-1. One row per (workspace, role) for role in (''admin'',''agent''). The Owner is never stored (implicit full permissions). Validated by a BEFORE INSERT/UPDATE trigger that calls automation_internal.validate_permissions. Browser reads via RLS; writes only via realtoros_set_role_permissions.';
comment on table public.workspace_permission_changes is
  'Phase T2b-1. Append-only audit of role / member permission changes made through the realtoros_set_role_permissions / realtoros_set_member_permissions / realtoros_reset_member_permissions RPCs. Readable by team_manage holders only; written by the RPCs themselves. actor_user_id and target_member_id are both ON DELETE SET NULL so an auth.users or workspace_members delete never fails on this table; actor_label and target_label snapshot the actor''s email/name and the target''s role or team member name at write time so the audit stays readable after the referenced row is gone.';
comment on column public.workspace_members.permission_overrides is
  'Phase T2b-1. Per-member overrides on top of the workspace''s role template. {} means "use the template as-is". Only the keys that differ are stored. Validated by a BEFORE INSERT/UPDATE trigger.';

comment on function authz.member(uuid) is
  'Phase T2b-1. STABLE / INVOKER. The caller''s active (role, team_member_id, user_id) in p_workspace_id, or empty when they are not an active member. Non-member calls return no rows because workspace_members RLS filters to the caller''s own rows.';
comment on function authz.effective_permissions(uuid) is
  'Phase T2b-1. STABLE / INVOKER. Caller''s fully-merged permission JSON for p_workspace_id (owner → implicit full; else role template deep-merged with permission_overrides). Returns NULL when the caller is not an active member. Cannot leak another workspace: both reads (workspace_members, workspace_role_permissions) go through RLS.';
comment on function authz.scope(uuid, text, text) is
  'Phase T2b-1. Returns the caller''s scope (''none''|''own''|''all'') for an area/action (e.g. authz.scope(ws, ''contacts'', ''view'')). Non-members get ''none''.';
comment on function authz.can(uuid, text) is
  'Phase T2b-1. Boolean lookup for the top-level boolean permission keys (e.g. authz.can(ws, ''team_manage'')). Non-members get false.';
comment on function authz.settings_level(uuid) is
  'Phase T2b-1. Returns the settings level (''none''|''view''|''edit''). Non-members get ''none''.';

comment on function authz.my_workspace_id() is
  'Phase T2b-1. The caller''s single active workspace_id. Wrap in (select …) inside RLS so Postgres evaluates it once per statement.';
comment on function authz.my_team_member_id() is
  'Phase T2b-1. The caller''s team_members id in their active workspace. Used in the ''own'' predicate alongside auth.uid().';
comment on function authz.my_role() is
  'Phase T2b-1. The caller''s role in their active workspace (owner|admin|agent) or null.';
comment on function authz.my_scope(text, text) is
  'Phase T2b-1. Caller-only scope lookup. T2b-2 RLS pattern: (select authz.my_scope(''contacts'', ''view'')) = ''all''.';
comment on function authz.my_can(text) is
  'Phase T2b-1. Caller-only boolean lookup. T2b-2 RLS pattern: (select authz.my_can(''team_manage'')).';
comment on function authz.my_settings_level() is
  'Phase T2b-1. Caller-only settings level lookup.';
