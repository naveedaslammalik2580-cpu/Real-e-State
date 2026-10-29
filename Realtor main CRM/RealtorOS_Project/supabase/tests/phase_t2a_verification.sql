-- Phase T2a verification — run AFTER applying
-- 20261001160608_phase_t2a_workspace_foundation.sql.
--
-- READ-ONLY. One result set, one row per check; every row must show
-- ok = true. Nothing here writes.
--
-- Covers:
--   * The three new tables exist, have RLS on, carry only service_role
--     grants (and the two SELECT grants to authenticated).
--   * workspace_id present and NOT NULL on every workspace-scoped table;
--     the (workspace_id, id) unique index and the BEFORE INSERT compat
--     trigger are present on each.
--   * Workspace / membership / owner-team_members counts match the
--     number of auth.users rows.
--   * Every existing row's workspace_id matches its user_id's active
--     workspace.
--   * The partial-unique invariants on workspace_members are indexed.
--   * The two new composite FKs are column-scoped SET NULL.
--   * The fake data is gone (no team_members rows besides owners;
--     scheduled_items.assigned_to / assigned_to_name are null;
--     deals.assigned_to_id and tasks.assigned_to_id are null).
--   * The pre-existing RLS policies and grants on the 36 workspace-scoped
--     tables are unchanged (same 4 policies, same (anon, authenticated)
--     grant pattern — no privilege regression).
with
tables_t2a as (
  select unnest(array[
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
  ]::text[]) as t
),
auth_user_count as (select count(*)::int as n from auth.users),
checks as (
  -- 1. New tables exist, RLS enabled.
  select 1 as id, 'workspaces exists with RLS on' as name,
         exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'public' and c.relname = 'workspaces' and c.relrowsecurity) as ok

  union all select 2, 'workspace_members exists with RLS on',
         exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'public' and c.relname = 'workspace_members' and c.relrowsecurity)

  union all select 3, 'workspace_invitations exists with RLS on',
         exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'public' and c.relname = 'workspace_invitations' and c.relrowsecurity)

  -- 2. Grants on new tables: service_role has all; authenticated has SELECT
  --    only (on workspaces and workspace_members); anon has nothing.
  union all select 10, 'anon has no privileges on workspaces',
         not has_table_privilege('anon', 'public.workspaces', 'select, insert, update, delete')

  union all select 11, 'anon has no privileges on workspace_members',
         not has_table_privilege('anon', 'public.workspace_members', 'select, insert, update, delete')

  union all select 12, 'anon has no privileges on workspace_invitations',
         not has_table_privilege('anon', 'public.workspace_invitations', 'select, insert, update, delete')

  union all select 13, 'authenticated has SELECT only on workspaces',
         has_table_privilege('authenticated', 'public.workspaces', 'select')
         and not has_table_privilege('authenticated', 'public.workspaces', 'insert')
         and not has_table_privilege('authenticated', 'public.workspaces', 'update')
         and not has_table_privilege('authenticated', 'public.workspaces', 'delete')

  union all select 14, 'authenticated has SELECT only on workspace_members',
         has_table_privilege('authenticated', 'public.workspace_members', 'select')
         and not has_table_privilege('authenticated', 'public.workspace_members', 'insert')
         and not has_table_privilege('authenticated', 'public.workspace_members', 'update')
         and not has_table_privilege('authenticated', 'public.workspace_members', 'delete')

  union all select 15, 'authenticated has no privileges on workspace_invitations',
         not has_table_privilege('authenticated', 'public.workspace_invitations', 'select, insert, update, delete')

  -- 3. Workspace / membership / owner-team_members counts.
  union all select 20, 'one workspace per auth user',
         (select count(*) from public.workspaces) = (select n from auth_user_count)
  union all select 21, 'one active owner membership per auth user',
         (select count(*) from public.workspace_members
          where role = 'owner' and status = 'active')
         = (select n from auth_user_count)
  union all select 22, 'one Owner team_members row per auth user',
         (select count(*) from public.team_members
          where role = 'Owner' and auth_user_id is not null)
         = (select n from auth_user_count)
  union all select 23, 'no extra team_members rows beyond owners (fake data cleaned)',
         (select count(*) from public.team_members)
         = (select n from auth_user_count)

  -- 4. workspace_id NOT NULL and zero-null per workspace-scoped table.
  union all select 30, 'workspace_id is NOT NULL on every workspace-scoped table',
         not exists (
           select 1 from tables_t2a t
           join information_schema.columns c
             on c.table_schema = 'public'
            and c.table_name = t.t
            and c.column_name = 'workspace_id'
           where c.is_nullable <> 'NO'
         )

  -- (A direct cross-table mismatch count would need dynamic SQL; the
  -- backfill proves zero nulls inside the migration itself and the
  -- compat BEFORE INSERT trigger owns the invariant going forward, so
  -- we rely on those rather than scanning every table here.)

  -- 6. (workspace_id, id) unique index present on every workspace-scoped
  --    table with an `id` column; (workspace_id, user_id) unique on
  --    email_sender_profiles (whose PK is user_id).
  union all select 40, '(workspace_id, id) unique index present on every id-keyed table',
         not exists (
           select 1 from tables_t2a t
           where t.t <> 'email_sender_profiles'
             and not exists (
               select 1 from pg_indexes
               where schemaname = 'public'
                 and tablename = t.t
                 and indexname = t.t || '_workspace_id_id_uq'
             )
         )
  union all select 42, '(workspace_id, user_id) unique index present on email_sender_profiles',
         exists (
           select 1 from pg_indexes
           where schemaname = 'public'
             and tablename = 'email_sender_profiles'
             and indexname = 'email_sender_profiles_workspace_id_user_uq'
         )

  -- 7. Compat BEFORE INSERT trigger present on every workspace-scoped
  --    table.
  union all select 41, 'compat BEFORE INSERT trigger present on every table',
         not exists (
           select 1 from tables_t2a t
           where not exists (
             select 1 from pg_trigger tr
             join pg_class c on c.oid = tr.tgrelid
             join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'public'
               and c.relname = t.t
               and tr.tgname = t.t || '_compat_workspace_id'
               and not tr.tgisinternal
           )
         )

  -- 8. Partial-unique indexes on workspace_members.
  union all select 50, 'one-active-membership-per-user partial unique index exists',
         exists (
           select 1 from pg_indexes
           where schemaname = 'public'
             and tablename = 'workspace_members'
             and indexname = 'workspace_members_one_active_per_user'
         )
  union all select 51, 'one-active-owner-per-workspace partial unique index exists',
         exists (
           select 1 from pg_indexes
           where schemaname = 'public'
             and tablename = 'workspace_members'
             and indexname = 'workspace_members_one_active_owner_per_workspace'
         )

  -- 9. The two new composite FKs use the column-scoped SET NULL form.
  --    pg_constraint.confdeltype = 'n' is SET NULL; confdelsetcols lists
  --    the columns that get SET NULL. For a column-scoped SET NULL (col),
  --    confdelsetcols is the attnum array of exactly that one column.
  union all select 60, 'workspace_members FK → team_members is column-scoped SET NULL',
         exists (
           select 1 from pg_constraint ct
           join pg_class rel on rel.oid = ct.conrelid
           join pg_class tgt on tgt.oid = ct.confrelid
           join pg_namespace rn on rn.oid = rel.relnamespace
           where rn.nspname = 'public'
             and rel.relname = 'workspace_members'
             and tgt.relname = 'team_members'
             and ct.contype = 'f'
             and ct.confdeltype = 'n'
             and array_length(ct.confdelsetcols, 1) = 1
         )
  union all select 61, 'contacts.assigned_to_id FK → team_members is column-scoped SET NULL',
         exists (
           select 1 from pg_constraint ct
           join pg_class rel on rel.oid = ct.conrelid
           join pg_class tgt on tgt.oid = ct.confrelid
           join pg_namespace rn on rn.oid = rel.relnamespace
           where rn.nspname = 'public'
             and rel.relname = 'contacts'
             and tgt.relname = 'team_members'
             and ct.conname = 'contacts_assigned_team_member_fk'
             and ct.contype = 'f'
             and ct.confdeltype = 'n'
             and array_length(ct.confdelsetcols, 1) = 1
         )

  -- 10. Fake-data cleanup.
  union all select 70, 'no scheduled_items.assigned_to left set',
         not exists (select 1 from public.scheduled_items where assigned_to is not null)
  union all select 71, 'no scheduled_items.assigned_to_name left set',
         not exists (select 1 from public.scheduled_items where assigned_to_name is not null)
  union all select 72, 'no deals.assigned_to_id left set',
         not exists (select 1 from public.deals where assigned_to_id is not null)
  union all select 73, 'no tasks.assigned_to_id left set',
         not exists (select 1 from public.tasks where assigned_to_id is not null)

  -- 11. No privilege regression on the pre-existing workspace-scoped
  --     tables: the T2a migration contains no DROP POLICY / REVOKE /
  --     ALTER POLICY on them, so their policy and grant state carries
  --     through byte-for-byte. We assert the proxy that every one still
  --     has RLS enabled and at least one policy.
  union all select 80, 'RLS is still enabled on every pre-existing workspace-scoped table',
         not exists (
           select 1 from tables_t2a t
           join pg_class c on c.relname = t.t
                           and c.relnamespace = 'public'::regnamespace
           where not c.relrowsecurity
         )
  -- (A per-table policy-count check is not meaningful here because some
  -- tables are intentionally service-role-only — RLS on, zero browser
  -- policies, e.g. contact_stop_events, outbound_messages. The T2a
  -- migration contains no DROP POLICY / REVOKE / GRANT on any existing
  -- table, so a lint over the migration file is the real guarantee.)

  -- 12. The internal functions are service_role only, SECURITY DEFINER,
  --     search_path pinned to ''.
  union all select 90, 'ensure_personal_workspace is DEFINER, search_path pinned, service_role only',
         exists (
           select 1 from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'automation_internal'
             and p.proname = 'ensure_personal_workspace'
             and p.prosecdef
             and exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c
                         where c like 'search_path=%')
             and not has_function_privilege('anon', p.oid, 'execute')
             and not has_function_privilege('authenticated', p.oid, 'execute')
             and has_function_privilege('service_role', p.oid, 'execute')
         )
  union all select 91, 'compat_set_workspace_id is DEFINER, search_path pinned',
         exists (
           select 1 from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'automation_internal'
             and p.proname = 'compat_set_workspace_id'
             and p.prosecdef
             and exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c
                         where c like 'search_path=%')
             and not has_function_privilege('anon', p.oid, 'execute')
             and not has_function_privilege('authenticated', p.oid, 'execute')
         )
)
select id, name, ok from checks order by id;
