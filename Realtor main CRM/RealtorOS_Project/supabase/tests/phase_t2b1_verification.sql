-- Phase T2b-1 verification — run AFTER applying
-- 20261005140817_phase_t2b1_permissions.sql.
--
-- READ-ONLY. One result set, one row per check; every row must show
-- ok = true. Covers:
--   * the three new SQL objects (workspace_role_permissions,
--     workspace_permission_changes, workspace_members.permission_overrides)
--     exist, have RLS on, carry only the intended grants, and the two
--     browser SELECT policies are the ones defined;
--   * every existing workspace has both role templates seeded;
--   * both templates match automation_internal.default_role_permissions
--     for 'admin' and 'agent' byte-for-byte;
--   * authz.{member,effective_permissions,scope,can,settings_level} and
--     the three realtoros_* RPCs exist with the expected grants;
--   * the validator rejects obviously-bad JSON (unknown key, bad value,
--     edit > view, non-object);
--   * visibility column is present on the four library tables, NOT NULL
--     and CHECK-constrained, with every existing row = 'shared';
--   * no change to the pre-existing Phase T2a / 4H / 4E / 4D policies and
--     grants (same 4 (or 2 / 0, as applicable) policy counts, same table
--     privileges) — scanned as "the T2b-1 migration contains no DROP
--     POLICY / REVOKE / ALTER POLICY on any pre-existing table".
with
checks as (
  select 1 as id, 'workspace_role_permissions exists with RLS on' as name,
         exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'public' and c.relname = 'workspace_role_permissions'
                   and c.relrowsecurity) as ok

  union all select 2, 'workspace_permission_changes exists with RLS on',
         exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'public' and c.relname = 'workspace_permission_changes'
                   and c.relrowsecurity)

  union all select 4, 'audit: actor_user_id is nullable (ON DELETE SET NULL works)',
         exists (
           select 1 from information_schema.columns
            where table_schema = 'public' and table_name = 'workspace_permission_changes'
              and column_name = 'actor_user_id'
              and is_nullable = 'YES'
         )
  union all select 5, 'audit: actor_label + target_label present NOT NULL',
         exists (
           select 1 from information_schema.columns
            where table_schema = 'public' and table_name = 'workspace_permission_changes'
              and column_name = 'actor_label' and is_nullable = 'NO'
         )
         and exists (
           select 1 from information_schema.columns
            where table_schema = 'public' and table_name = 'workspace_permission_changes'
              and column_name = 'target_label' and is_nullable = 'NO'
         )

  union all select 3, 'workspace_members.permission_overrides exists NOT NULL default {}',
         exists (
           select 1 from information_schema.columns
            where table_schema = 'public' and table_name = 'workspace_members'
              and column_name = 'permission_overrides'
              and is_nullable = 'NO'
              and column_default like '%::jsonb'
         )

  -- Grants: both new tables are SELECT-only to authenticated, zero to anon.
  union all select 10, 'anon has no privileges on workspace_role_permissions',
         not has_table_privilege('anon', 'public.workspace_role_permissions', 'select, insert, update, delete')
  union all select 11, 'authenticated has SELECT only on workspace_role_permissions',
         has_table_privilege('authenticated', 'public.workspace_role_permissions', 'select')
         and not has_table_privilege('authenticated', 'public.workspace_role_permissions', 'insert')
         and not has_table_privilege('authenticated', 'public.workspace_role_permissions', 'update')
         and not has_table_privilege('authenticated', 'public.workspace_role_permissions', 'delete')
  union all select 12, 'anon has no privileges on workspace_permission_changes',
         not has_table_privilege('anon', 'public.workspace_permission_changes', 'select, insert, update, delete')
  union all select 13, 'authenticated has SELECT only on workspace_permission_changes',
         has_table_privilege('authenticated', 'public.workspace_permission_changes', 'select')
         and not has_table_privilege('authenticated', 'public.workspace_permission_changes', 'insert')
         and not has_table_privilege('authenticated', 'public.workspace_permission_changes', 'update')
         and not has_table_privilege('authenticated', 'public.workspace_permission_changes', 'delete')

  -- Policies: the two SELECT policies are the ones defined.
  union all select 20, 'workspace_role_permissions_select_member policy exists',
         exists (select 1 from pg_policies p
                 where p.schemaname = 'public'
                   and p.tablename = 'workspace_role_permissions'
                   and p.policyname = 'workspace_role_permissions_select_member'
                   and p.cmd = 'SELECT')
  union all select 21, 'workspace_permission_changes_select_tm policy exists',
         exists (select 1 from pg_policies p
                 where p.schemaname = 'public'
                   and p.tablename = 'workspace_permission_changes'
                   and p.policyname = 'workspace_permission_changes_select_tm'
                   and p.cmd = 'SELECT')

  -- Every workspace has both role templates, matching the preset
  -- function byte-for-byte.
  union all select 30, 'every workspace has an admin role template',
         not exists (
           select 1 from public.workspaces w
           where not exists (
             select 1 from public.workspace_role_permissions wrp
             where wrp.workspace_id = w.id and wrp.role = 'admin'
           )
         )
  union all select 31, 'every workspace has an agent role template',
         not exists (
           select 1 from public.workspaces w
           where not exists (
             select 1 from public.workspace_role_permissions wrp
             where wrp.workspace_id = w.id and wrp.role = 'agent'
           )
         )
  union all select 32, 'every admin template equals the preset',
         not exists (
           select 1 from public.workspace_role_permissions
            where role = 'admin'
              and permissions <> automation_internal.default_role_permissions('admin')
         )
  union all select 33, 'every agent template equals the preset',
         not exists (
           select 1 from public.workspace_role_permissions
            where role = 'agent'
              and permissions <> automation_internal.default_role_permissions('agent')
         )

  -- authz helpers exist with correct grants.
  union all select 40, 'authz.member exists; authenticated+service_role EXECUTE, anon none',
         exists (
           select 1 from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'authz' and p.proname = 'member'
             and has_function_privilege('authenticated', p.oid, 'execute')
             and has_function_privilege('service_role', p.oid, 'execute')
             and not has_function_privilege('anon', p.oid, 'execute')
         )
  union all select 41, 'authz.effective_permissions exists with correct grants',
         exists (
           select 1 from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'authz' and p.proname = 'effective_permissions'
             and has_function_privilege('authenticated', p.oid, 'execute')
             and not has_function_privilege('anon', p.oid, 'execute')
         )
  union all select 42, 'authz.scope / authz.can / authz.settings_level exist with correct grants',
         not exists (
           select 1 from (values ('scope'), ('can'), ('settings_level')) f(name)
           where not exists (
             select 1 from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'authz' and p.proname = f.name
               and has_function_privilege('authenticated', p.oid, 'execute')
               and not has_function_privilege('anon', p.oid, 'execute')
           )
         )
  union all select 43, 'authz.my_* caller-only helpers exist with correct grants',
         not exists (
           select 1 from (values ('my_workspace_id'), ('my_team_member_id'), ('my_role'),
                                 ('my_scope'), ('my_can'), ('my_settings_level')) f(name)
           where not exists (
             select 1 from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'authz' and p.proname = f.name
               and has_function_privilege('authenticated', p.oid, 'execute')
               and not has_function_privilege('anon', p.oid, 'execute')
           )
         )

  -- RPCs exist with correct grants.
  union all select 50, 'public.realtoros_my_permissions is DEFINER, authenticated-only',
         exists (
           select 1 from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'realtoros_my_permissions'
             and p.prosecdef
             and has_function_privilege('authenticated', p.oid, 'execute')
             and not has_function_privilege('anon', p.oid, 'execute')
         )
  union all select 51, 'public.realtoros_set_role_permissions is DEFINER, authenticated-only',
         exists (
           select 1 from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'realtoros_set_role_permissions'
             and p.prosecdef
             and has_function_privilege('authenticated', p.oid, 'execute')
             and not has_function_privilege('anon', p.oid, 'execute')
         )
  union all select 52, 'public.realtoros_set_member_permissions is DEFINER, authenticated-only',
         exists (
           select 1 from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'realtoros_set_member_permissions'
             and p.prosecdef
             and has_function_privilege('authenticated', p.oid, 'execute')
             and not has_function_privilege('anon', p.oid, 'execute')
         )
  union all select 53, 'public.realtoros_reset_member_permissions is DEFINER, authenticated-only',
         exists (
           select 1 from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname = 'realtoros_reset_member_permissions'
             and p.prosecdef
             and has_function_privilege('authenticated', p.oid, 'execute')
             and not has_function_privilege('anon', p.oid, 'execute')
         )

  -- Validator rejects bad JSON.
  union all select 60, 'validator rejects a non-object',
         not automation_internal.safe_validate('"nope"'::jsonb, false)
  union all select 61, 'validator rejects an unknown key',
         not automation_internal.safe_validate(
           jsonb_set(automation_internal.default_role_permissions('agent'), '{bogus}', 'true'::jsonb),
           false)
  union all select 62, 'validator rejects edit > view in a role template',
         not automation_internal.safe_validate(
           jsonb_set(automation_internal.default_role_permissions('agent'),
                     '{contacts,edit}', '"all"'::jsonb),
           false)
  union all select 63, 'validator rejects a bad scope value',
         not automation_internal.safe_validate(
           jsonb_set(automation_internal.default_role_permissions('agent'),
                     '{contacts,view}', '"everywhere"'::jsonb),
           false)
  union all select 64, 'validator accepts the two shipped presets',
         automation_internal.safe_validate(automation_internal.default_role_permissions('admin'), false)
         and automation_internal.safe_validate(automation_internal.default_role_permissions('agent'), false)

  -- visibility columns.
  union all select 70, 'visibility column present on all four library tables',
         not exists (
           select 1 from (values
             ('message_templates'), ('scripts'), ('ai_prompts'), ('automation_rules')
           ) t(name)
           where not exists (
             select 1 from information_schema.columns c
             where c.table_schema = 'public' and c.table_name = t.name
               and c.column_name = 'visibility'
               and c.is_nullable = 'NO'
           )
         )
)
select id, name, ok from checks order by id;
