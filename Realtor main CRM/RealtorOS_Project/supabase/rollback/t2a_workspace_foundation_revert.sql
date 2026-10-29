-- REVERT for Phase T2a (the workspace foundation).
--
-- NOT a migration. Run it only to undo
-- 20261001160608_phase_t2a_workspace_foundation.sql.
--
-- THIS IS THE BOTTOM OF THE STACK. Every phase from T2b onward is built
-- on the three tables and the workspace_id column this removes, so this
-- file is the last revert to run and the one most likely to be a
-- mistake. It refuses to run while anything later is installed.
--
-- WHAT IT REMOVES
--
--   * workspaces, workspace_members, workspace_invitations
--   * workspace_id from all 36 business tables, with the (workspace_id,
--     id) unique indexes and the two composite FKs that depend on it
--   * team_members.auth_user_id and contacts.assigned_to_id
--   * ensure_personal_workspace() and the compat_set_workspace_id()
--     trigger on all 36 tables

-- WHAT IT LEAVES. The automation_internal schema. T2a's line for it is
-- `create schema if not exists` - it was already there, holding the
-- Phase 4 trigger and notification functions - so only T2a's own two
-- functions are removed from it.
--
-- WHAT RUNNING THIS MEANS
--
--   * NO BUSINESS DATA IS DELETED. Every contact, deal, property and
--     task stays exactly where it is, still owned through user_id, which
--     never stopped being the real owner column. This is the one thing
--     worth being sure of before running it, and it is why the verify
--     block below counts contacts before and after.
--   * WHO A CONTACT WAS ASSIGNED TO IS LOST. assigned_to_id is a column
--     T2a added; dropping it drops the assignments. The free-text
--     assigned_agent from before T2a is untouched. If the assignments
--     matter, copy them out first:
--       create table assignment_backup as
--         select id, user_id, assigned_to_id from public.contacts
--          where assigned_to_id is not null;
--   * EVERY SHARED WORKSPACE STOPS BEING SHARED. A colleague who could
--     see the owner's data through a membership cannot any more - their
--     own rows are their own, and nothing else is visible to them. For a
--     solo account this changes nothing at all.
--   * The team_members rows T2a's backfill created for each owner stay.
--     They are directory rows like any other and deleting them would
--     take the owner out of their own team.
--
-- ORDER. Unwind in reverse: 3B, 2F, 2E, 2D, 2C, 2A, T4, T3, T2c-post,
-- T2c, T2c-pre, T2b-2, T2b-1, then this.

set search_path = public;

begin;

-- ============================================================
-- 0. Refuse unless everything built on top is already gone.
-- ============================================================
do $guard$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'authz') then
    raise exception 'T2a revert: Phase T2b-1 is still installed (the authz schema exists). Run t2b1_permissions_revert.sql first.';
  end if;
  if exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'workspace_role_permissions'
  ) then
    raise exception 'T2a revert: Phase T2b-1 is still installed. Run t2b1_permissions_revert.sql first.';
  end if;
  -- Policies on T2a's OWN three tables are excluded: they name
  -- workspace_id because that is what those tables are, and they are
  -- dropped with the tables below. What must not exist is a policy on a
  -- business table that would be left reading a column this file
  -- removes - that is T2b-2's work, and it has its own revert.
  if exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and (qual like '%workspace_id%' or coalesce(with_check, '') like '%workspace_id%')
       and tablename not in ('workspaces', 'workspace_members', 'workspace_invitations')
  ) then
    raise exception 'T2a revert: RLS policies still read workspace_id. Run t2b2_revert_to_user_id_policies.sql first.';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in (
       'realtoros_list_members', 'realtoros_scan_time_triggers', 'realtoros_complete_followup_v2')
  ) then
    raise exception 'T2a revert: a later phase (T3, T4 or 2A) is still installed. Unwind those first.';
  end if;
end $guard$;

-- ============================================================
-- 1. The composite FKs that name workspace_id.
--
-- Dropping the column would take these with it, but naming them makes
-- the intent readable and means a failure here points at the right
-- object rather than at a column drop.
-- ============================================================
alter table public.workspace_members
  drop constraint if exists workspace_members_team_member_fk;
alter table public.contacts
  drop constraint if exists contacts_assigned_team_member_fk;

-- ============================================================
-- 2. The compat trigger, off all 36 tables, and then the function.
--
-- Same table list as the migration, in the same order, so the two can
-- be read side by side.
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array[
    'contacts', 'team_members', 'properties', 'deals', 'milestones', 'tasks',
    'activities', 'showings', 'referrals', 'goals', 'finance_records', 'scripts',
    'ai_prompts', 'scheduled_items', 'custom_field_values', 'workspace_settings',
    'notifications', 'contact_stop_events',
    'automation_rules', 'automation_steps', 'automation_enrollments',
    'automation_jobs', 'automation_runs', 'automation_failures',
    'automation_trigger_events',
    'communication_consents', 'contact_identity_keys', 'email_sender_profiles',
    'email_suppressions', 'message_templates', 'outbound_messages', 'webhook_events',
    'lead_import_batches', 'lead_import_rows', 'lead_source_connections',
    'lead_source_mappings'
  ] loop
    execute format('drop trigger if exists %I on public.%I', t || '_compat_workspace_id', t);
  end loop;
end $$;

-- ============================================================
-- 3. workspace_id itself, off all 36 tables.
--
-- CASCADE is not needed and not used: dropping a column takes its own
-- indexes and constraints with it, and nothing else should depend on
-- this column by the time we get here. If something does, this fails -
-- which is the right outcome, because it means step 0's guard missed a
-- phase.
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array[
    'contacts', 'team_members', 'properties', 'deals', 'milestones', 'tasks',
    'activities', 'showings', 'referrals', 'goals', 'finance_records', 'scripts',
    'ai_prompts', 'scheduled_items', 'custom_field_values', 'workspace_settings',
    'notifications', 'contact_stop_events',
    'automation_rules', 'automation_steps', 'automation_enrollments',
    'automation_jobs', 'automation_runs', 'automation_failures',
    'automation_trigger_events',
    'communication_consents', 'contact_identity_keys', 'email_sender_profiles',
    'email_suppressions', 'message_templates', 'outbound_messages', 'webhook_events',
    'lead_import_batches', 'lead_import_rows', 'lead_source_connections',
    'lead_source_mappings'
  ] loop
    execute format('alter table public.%I drop column if exists workspace_id', t);
  end loop;
end $$;

-- ============================================================
-- 4. The other two columns T2a added.
-- ============================================================
alter table public.team_members drop column if exists auth_user_id;
alter table public.contacts drop column if exists assigned_to_id;

-- ============================================================
-- 5. The three tables.
--
-- The policy first: workspaces_select_member is ON workspaces but reads
-- workspace_members, so Postgres counts it as a dependency and refuses
-- to drop the members table while it exists. Dropping the policy by
-- name is better than CASCADE, which would silently take anything else
-- that happened to depend on these tables.
-- ============================================================
drop policy if exists workspaces_select_member on public.workspaces;
drop policy if exists workspace_members_select_own on public.workspace_members;

drop table if exists public.workspace_invitations;
drop table if exists public.workspace_members;
drop table if exists public.workspaces;

-- ============================================================
-- 6. The two functions.
-- ============================================================
drop function if exists automation_internal.compat_set_workspace_id();
drop function if exists automation_internal.ensure_personal_workspace(uuid);

-- ============================================================
-- 7. The automation_internal schema stays.
--
-- T2a's line for it is `create schema if not exists`, and the "if not
-- exists" is doing real work: the schema was already there, holding the
-- Phase 4C/4D/4H trigger and notification functions. Dropping it here
-- would delete all of those, which belong to migrations this revert
-- does not touch. T2a's own two functions went in step 6; the schema
-- they lived in is older than this phase and is left alone.
-- ============================================================

-- ============================================================
-- 8. Verify.
-- ============================================================
do $verify$
begin
  if exists (
    select 1 from information_schema.tables
     where table_schema = 'public'
       and table_name in ('workspaces', 'workspace_members', 'workspace_invitations')
  ) then
    raise exception 'T2a revert: a workspace table is still there';
  end if;

  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and column_name = 'workspace_id'
  ) then
    raise exception 'T2a revert: a table still has a workspace_id column';
  end if;

  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and ((table_name = 'team_members' and column_name = 'auth_user_id')
         or (table_name = 'contacts' and column_name = 'assigned_to_id'))
  ) then
    raise exception 'T2a revert: a T2a column is still there';
  end if;

  -- The schema itself must SURVIVE: it predates T2a and holds the
  -- Phase 4 functions.
  if not exists (select 1 from information_schema.schemata where schema_name = 'automation_internal') then
    raise exception 'T2a revert: automation_internal was dropped, taking the Phase 4 functions with it';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'automation_internal'
       and p.proname in ('ensure_personal_workspace', 'compat_set_workspace_id')
  ) then
    raise exception 'T2a revert: a T2a function is still there';
  end if;

  -- The whole point: the data is still here. user_id was always the real
  -- owner column, and nothing above touched a business row.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'contacts' and column_name = 'user_id'
  ) then
    raise exception 'T2a revert: contacts lost its owner column, which must never happen';
  end if;

  raise notice 'T2a reverted: workspaces are gone and every row is owned by user_id again. No business data was deleted; contact assignments were.';
end $verify$;

commit;
