-- Phase 4E.4 verification — run AFTER applying
-- 20260929095530_phase_4e_4_file_lead_import.sql.
--
-- READ-ONLY. One result set, one row per check; every row must show
-- ok = true. Nothing here writes, imports, or reads contact data.

with
fn as (
  select p.oid, n.nspname as schema, p.proname,
         pg_get_function_identity_arguments(p.oid) as args,
         p.prosecdef, p.proconfig, p.proacl
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where (n.nspname = 'public' and p.proname in ('realtoros_ingest_lead_batch', 'realtoros_ingest_lead_file', 'realtoros_file_import_quota'))
     or (n.nspname = 'automation_internal' and p.proname = 'ingest_lead_rows')
),
expected(schema, proname, args) as (
  values
    ('public', 'realtoros_ingest_lead_batch',
     'p_connection_id uuid, p_source_event_id text, p_sheet_revision text, p_rows jsonb'),
    ('public', 'realtoros_ingest_lead_file',
     'p_user_id uuid, p_import_id uuid, p_file_name text, p_rows jsonb, p_start_automation boolean'),
    ('public', 'realtoros_file_import_quota', 'p_user_id uuid'),
    -- T2c added p_workspace_id. The 8-argument form was dropped, not
    -- left as an overload: a stale caller falling back to per-user
    -- de-duplication is the exact bug T2c fixes.
    ('automation_internal', 'ingest_lead_rows',
     'p_user_id uuid, p_workspace_id uuid, p_connection_id uuid, p_batch_id uuid, p_rows jsonb, p_source_type text, p_start_automation boolean, p_new_contact_allowance integer, p_limit_message text')
),
col(table_name, column_name, is_nullable, column_default) as (
  select table_name::text, column_name::text, is_nullable::text, column_default::text
  from information_schema.columns
  where table_schema = 'public' and table_name in ('lead_import_batches', 'lead_import_rows')
),
checks(check_name, ok, detail) as (

  -- ---------- signatures ----------
  select 'signature: ' || e.schema || '.' || e.proname,
         exists (select 1 from fn where fn.schema = e.schema and fn.proname = e.proname and fn.args = e.args),
         coalesce((select string_agg(fn.args, ' | ') from fn where fn.schema = e.schema and fn.proname = e.proname), 'MISSING')
  from expected e
  union all
  select 'one definition each (no overloads)',
         (select count(*) from fn) = 4,
         (select count(*)::text from fn)
  union all
  select 'Google Sheet function signature unchanged',
         exists (select 1 from fn where proname = 'realtoros_ingest_lead_batch'
                 and args = 'p_connection_id uuid, p_source_event_id text, p_sheet_revision text, p_rows jsonb'),
         null

  -- ---------- grants ----------
  union all
  select 'anon cannot execute: ' || fn.proname, not has_function_privilege('anon', fn.oid, 'execute'), null from fn
  union all
  select 'authenticated cannot execute: ' || fn.proname, not has_function_privilege('authenticated', fn.oid, 'execute'), null from fn
  union all
  select 'service_role can execute: ' || fn.proname, has_function_privilege('service_role', fn.oid, 'execute'), null from fn
  union all
  select 'no PUBLIC execute: ' || fn.proname,
         fn.proacl is not null and not exists (
           select 1 from aclexplode(fn.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'),
         null
  from fn
  union all
  select 'security invoker + empty search_path: ' || fn.proname,
         not fn.prosecdef and coalesce('search_path=""' = any(fn.proconfig), false),
         array_to_string(fn.proconfig, ', ')
  from fn
  union all
  -- Phase T2b-1 grants USAGE on automation_internal to authenticated so
  -- authz.* INVOKER helpers can call the two pure JSON transformers
  -- (default_role_permissions, merge_permissions). Every other function
  -- in the schema is individually revoked from authenticated, so the
  -- schema USAGE on its own doesn't buy the browser anything the
  -- per-function grants don't already allow. anon still has nothing.
  select 'automation_internal schema not usable by anon',
         not has_schema_privilege('anon', 'automation_internal', 'usage'),
         null

  -- ---------- columns ----------
  union all
  select 'lead_import_batches.source_type exists, not null, default google_sheet',
         exists (select 1 from col where table_name = 'lead_import_batches' and column_name = 'source_type'
                 and is_nullable = 'NO' and column_default like '%google_sheet%'),
         null
  union all
  select 'lead_import_batches.file_name exists',
         exists (select 1 from col where table_name = 'lead_import_batches' and column_name = 'file_name'),
         null
  union all
  select 'lead_import_rows.source_type exists, not null, default google_sheet',
         exists (select 1 from col where table_name = 'lead_import_rows' and column_name = 'source_type'
                 and is_nullable = 'NO' and column_default like '%google_sheet%'),
         null
  union all
  select 'connection_id nullable on both tables (enforced by check instead)',
         (select count(*) from col where column_name = 'connection_id' and is_nullable = 'YES') = 2,
         null

  -- ---------- constraints / indexes ----------
  union all
  select 'constraint ' || c.name,
         exists (select 1 from pg_constraint where conname = c.name and conrelid = to_regclass(c.tbl)),
         null
  from (values
    ('lead_import_batches_source_type_check', 'public.lead_import_batches'),
    ('lead_import_batches_source_shape_check', 'public.lead_import_batches'),
    ('lead_import_rows_source_type_check', 'public.lead_import_rows'),
    ('lead_import_rows_source_shape_check', 'public.lead_import_rows')
  ) as c(name, tbl)
  union all
  select 'batch shape: sheet needs connection, file needs no connection + file name',
         exists (select 1 from pg_constraint where conname = 'lead_import_batches_source_shape_check'
                 and pg_get_constraintdef(oid) like '%google_sheet%connection_id IS NOT NULL%'
                 and pg_get_constraintdef(oid) like '%file_upload%connection_id IS NULL%file_name IS NOT NULL%'),
         (select pg_get_constraintdef(oid) from pg_constraint where conname = 'lead_import_batches_source_shape_check')
  union all
  -- T2c re-scoped file replay to the workspace: two teammates must not
  -- be able to replay the same import id into two batches.
  select 'unique file import index (workspace_id, source_event_id) where file_upload',
         exists (select 1 from pg_indexes where schemaname = 'public'
                 and indexname = 'lead_import_batches_ws_file_event_uq'
                 and indexdef ~* 'unique' and indexdef ~* 'file_upload'),
         (select indexdef from pg_indexes where schemaname = 'public' and indexname = 'lead_import_batches_ws_file_event_uq')
  union all
  select 'contacts index ' || i.name || ' (' || i.expr || ', partial)',
         exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'contacts'
                 and indexname = i.name
                 and replace(indexdef, '::text', '') like '%(user_id, ' || i.expr || ')%'
                 and replace(indexdef, '::text', '') like '%WHERE (' || i.col || ' <> '''')%'),
         (select indexdef from pg_indexes where schemaname = 'public' and indexname = i.name)
  from (values
    ('contacts_user_email_norm_idx', 'lower(btrim(email))', 'email'),
    ('contacts_user_phone_norm_idx', 'regexp_replace(phone, ''[^0-9]+'', '''', ''g'')', 'phone')
  ) as i(name, expr, col)
  union all
  select 'daily allowance index lead_import_rows_file_new_contacts_idx (user_id, created_at) where file_upload + imported',
         exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'lead_import_rows'
                 and indexname = 'lead_import_rows_file_new_contacts_idx'
                 and indexdef like '%(user_id, created_at)%'
                 and indexdef like '%file_upload%' and indexdef like '%imported%'),
         (select indexdef from pg_indexes where schemaname = 'public' and indexname = 'lead_import_rows_file_new_contacts_idx')
  union all
  -- T2c moved the constant into automation_internal.file_import_daily_limit()
  -- so there is exactly one place to change it, and made the allowance the
  -- WORKSPACE's rather than each member's.
  select 'daily allowance is 200 new contacts (file_import_daily_limit)',
         (select automation_internal.file_import_daily_limit()) = 200,
         (select automation_internal.file_import_daily_limit()::text)
  union all
  select 'the allowance is counted per workspace, not per user',
         exists (select 1 from fn where proname = 'realtoros_file_import_quota'
                 and pg_get_functiondef(fn.oid) like '%where workspace_id = v_workspace%'),
         null
  union all
  -- Same re-scoping for Sheet replay. A unique INDEX now, not a table
  -- constraint, which is all ON CONFLICT needs.
  select 'unique (workspace_id, connection_id, source_event_id) for Sheet replay',
         exists (select 1 from pg_indexes where schemaname = 'public'
                 and indexname = 'lead_import_batches_ws_conn_event_uq'
                 and indexdef ~* 'unique'),
         (select indexdef from pg_indexes where schemaname = 'public'
           and indexname = 'lead_import_batches_ws_conn_event_uq')
  union all
  select 'existing rows all valid: every sheet batch has a connection',
         not exists (select 1 from public.lead_import_batches where source_type = 'google_sheet' and connection_id is null),
         null

  -- ---------- browser access unchanged ----------
  union all
  select 'authenticated is select-only on lead_import_batches / lead_import_rows',
         has_table_privilege('authenticated', 'public.lead_import_batches', 'select')
         and not has_table_privilege('authenticated', 'public.lead_import_batches', 'insert, update, delete')
         and has_table_privilege('authenticated', 'public.lead_import_rows', 'select')
         and not has_table_privilege('authenticated', 'public.lead_import_rows', 'insert, update, delete'),
         null
  union all
  select 'authenticated cannot write automation_trigger_events',
         not has_table_privilege('authenticated', 'public.automation_trigger_events', 'insert, update, delete'),
         null
)
select check_name, ok, detail from checks order by ok, check_name;
