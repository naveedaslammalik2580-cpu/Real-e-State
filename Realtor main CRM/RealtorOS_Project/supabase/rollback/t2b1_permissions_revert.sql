-- REVERT for Phase T2b-1 (role templates, per-member overrides, authz).
--
-- NOT a migration. Run it only to undo
-- 20261005140817_phase_t2b1_permissions.sql.
--
-- WHAT IT REMOVES
--
--   * the authz schema and every function in it
--   * workspace_role_permissions and workspace_permission_changes
--   * workspace_members.permission_overrides and its validating trigger
--   * the four reachable realtoros_*_permissions functions
--   * the permission helpers in automation_internal
--   * the visibility column on message_templates, scripts, ai_prompts
--     and automation_rules
--
-- ORDER MATTERS MORE HERE THAN ANYWHERE ELSE IN THIS DIRECTORY.
--
-- T2b-2's RLS policies are written in terms of authz.can() and
-- authz.my_workspace_id(). Dropping the authz schema underneath them
-- does not fail - Postgres does not track what a policy expression
-- names - it leaves policies that throw on every query, which looks
-- exactly like the database being down. Phases 2C onward read
-- automation_rules.visibility the same way.
--
-- So this file REFUSES to run while anything later is still installed.
-- Unwind in reverse: 3B, 2F, 2E, 2D, 2C, 2A, T4, T3, T2c-post, T2c,
-- T2b-2, then this.
--
-- WHAT RUNNING THIS MEANS (once the order is right)
--
--   * Every customised role template and every per-member override is
--     deleted. Not parked - deleted. There is nowhere to park them: the
--     tables that describe what a permission IS are what this removes.
--     Re-applying T2b-1 afterwards starts everybody on the shipped
--     presets again.
--   * The whole permission history in workspace_permission_changes goes
--     with it. If that matters, copy it out first:
--       create table permission_history_backup as
--         select * from public.workspace_permission_changes;
--   * Every library row becomes workspace-wide again, because the column
--     that said otherwise is gone. A 'personal' template stops being
--     personal. For a single-agent workspace that is a no-op; for a team
--     it is a disclosure, so read that sentence twice before running
--     this on a shared workspace.

set search_path = public;

begin;

-- ============================================================
-- 0. Refuse unless everything built on top is already gone.
-- ============================================================
do $guard$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'automation_internal' and p.proname = 'rule_targets_contact'
  ) then
    raise exception 'T2b-1 revert: Phase 2C or later is still installed (rule_targets_contact exists), and it reads automation_rules.visibility. Revert the later phases first.';
  end if;
  -- Policies on T2b-1's OWN tables are excluded: they call authz too,
  -- and they go a few statements below with the tables they are on.
  -- What must not exist is a policy on anything else that would be left
  -- pointing at a schema this file is about to delete.
  if exists (
    select 1 from pg_policies
     where schemaname = 'public' and qual like '%authz.%'
       and tablename not in ('workspace_role_permissions', 'workspace_permission_changes')
  ) then
    raise exception 'T2b-1 revert: RLS policies still call authz.*. Run t2b2_revert_to_user_id_policies.sql first.';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'realtoros_invite_member'
  ) then
    raise exception 'T2b-1 revert: Phase T3 is still installed. Run t3_invitations_membership_revert.sql first.';
  end if;
end $guard$;

-- ============================================================
-- 1. The reachable permission functions.
-- ============================================================
drop function if exists public.realtoros_my_permissions();
drop function if exists public.realtoros_set_role_permissions(text, jsonb);
drop function if exists public.realtoros_set_member_permissions(uuid, jsonb);
drop function if exists public.realtoros_reset_member_permissions(uuid);

-- ============================================================
-- 2. The triggers, before the things they validate.
-- ============================================================
drop trigger if exists workspace_members_validate_overrides on public.workspace_members;
drop function if exists automation_internal.validate_member_overrides_row();
drop trigger if exists workspace_role_permissions_validate on public.workspace_role_permissions;
drop function if exists automation_internal.validate_role_permissions_row();

-- ============================================================
-- 3. The two tables. Their own triggers and indexes go with them.
-- ============================================================
drop table if exists public.workspace_permission_changes;
drop table if exists public.workspace_role_permissions;

-- ============================================================
-- 4. The overrides column.
-- ============================================================
alter table public.workspace_members
  drop column if exists permission_overrides;

-- ============================================================
-- 5. The authz schema, whole.
-- ============================================================
drop schema if exists authz cascade;

-- ============================================================
-- 6. The helpers in automation_internal that only permissions used.
-- ============================================================
drop function if exists automation_internal.safe_validate(jsonb, boolean);
drop function if exists automation_internal.permissions_within_actor(jsonb, jsonb);
drop function if exists automation_internal.merge_permissions(jsonb, jsonb);
drop function if exists automation_internal.validate_permissions(jsonb, boolean);
drop function if exists automation_internal.settings_rank(text);
drop function if exists automation_internal.scope_rank(text);
drop function if exists automation_internal.default_role_permissions(text);

-- ============================================================
-- 6b. ensure_personal_workspace, back to T2a's version.
--
-- It is NOT dropped - T2a created it and the chain has no way to make a
-- workspace without it - but T2b-1 replaced the body (to seed the role
-- templates for a new workspace), so restoring the earlier body is part
-- of undoing T2b-1 rather than part of undoing T2a.
--
-- Copied verbatim from
-- supabase/migrations/20261001160608_phase_t2a_workspace_foundation.sql
-- so that md5(pg_proc.prosrc) matches the pre-T2b-1 chain exactly. Do
-- not reformat: tests/sql/rollback_files.test.mjs compares body hashes.
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
    raise exception 'ensure_personal_workspace: user_id is null'
      using errcode = '22023';
  end if;

  -- Idempotent fast path.
  select workspace_id into v_workspace_id
    from public.workspace_members
    where user_id = p_user_id and status = 'active'
    limit 1;
  if v_workspace_id is not null then
    return v_workspace_id;
  end if;

  -- Email is read for the seeded team_members profile. In production the
  -- column exists; in test harnesses that stub auth.users without it, the
  -- row-to-jsonb path returns null and the coalesce below handles it.
  select to_jsonb(u) ->> 'email' into v_email
    from auth.users u where u.id = p_user_id;

  insert into public.workspaces (name, owner_user_id)
    values ('My workspace', p_user_id)
    returning id into v_workspace_id;

  -- Insert workspace_members BEFORE team_members so that any downstream
  -- compat trigger on team_members (which validates the row owner's
  -- active workspace membership) sees this row already present. Then
  -- insert team_members, then set workspace_members.team_member_id to
  -- link the two. team_member_id is nullable; the composite FK
  -- (workspace_id, team_member_id) → team_members ignores nulls.
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

  return v_workspace_id;
end;
$fn$;

revoke all on function automation_internal.ensure_personal_workspace(uuid)
  from public, anon, authenticated;
grant execute on function automation_internal.ensure_personal_workspace(uuid)
  to service_role;

comment on function automation_internal.ensure_personal_workspace(uuid) is
  'Returns the active workspace_id for p_user_id, creating a personal workspace + owner workspace_members row + owner team_members row when none exists. Idempotent. Not callable from the browser; the Phase T2a compatibility trigger reaches it through its own DEFINER context.';

-- ============================================================
-- 7. The visibility column on the four library tables.
-- ============================================================
alter table public.message_templates drop column if exists visibility;
alter table public.scripts drop column if exists visibility;
alter table public.ai_prompts drop column if exists visibility;
alter table public.automation_rules drop column if exists visibility;

-- ============================================================
-- 8. Verify.
-- ============================================================
do $verify$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'authz') then
    raise exception 'T2b-1 revert: the authz schema is still there';
  end if;

  if exists (
    select 1 from information_schema.tables
     where table_schema = 'public'
       and table_name in ('workspace_role_permissions', 'workspace_permission_changes')
  ) then
    raise exception 'T2b-1 revert: a permissions table is still there';
  end if;

  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and ((table_name = 'workspace_members' and column_name = 'permission_overrides')
         or (table_name in ('message_templates','scripts','ai_prompts','automation_rules')
             and column_name = 'visibility'))
  ) then
    raise exception 'T2b-1 revert: a T2b-1 column is still there';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where (n.nspname = 'public' and p.proname like 'realtoros_%permissions%')
        or (n.nspname = 'automation_internal' and p.proname in (
              'default_role_permissions', 'scope_rank', 'settings_rank',
              'validate_permissions', 'safe_validate', 'merge_permissions',
              'validate_role_permissions_row', 'validate_member_overrides_row'))
  ) then
    raise exception 'T2b-1 revert: a permissions function is still there';
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'automation_internal' and p.proname = 'ensure_personal_workspace'
       and strpos(p.prosrc, 'workspace_role_permissions') = 0
  ) then
    raise exception 'T2b-1 revert: ensure_personal_workspace still seeds role templates';
  end if;

  -- T2a's foundation is not T2b-1's to remove.
  if not exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'workspace_members'
  ) then
    raise exception 'T2b-1 revert: workspace_members was dropped, which belongs to T2a';
  end if;

  raise notice 'T2b-1 reverted: role templates, overrides and the authz schema are gone, and every library row is workspace-wide again.';
end $verify$;

commit;
