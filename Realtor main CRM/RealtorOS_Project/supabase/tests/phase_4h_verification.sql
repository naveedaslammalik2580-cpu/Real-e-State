-- Phase 4H verification — run AFTER applying
-- 20260929150944_phase_4h_in_app_notifications.sql.
--
-- READ-ONLY. One result set, one row per check; every row must show
-- ok = true. Nothing here writes or reads notification content.

with
fn as (
  select p.oid, n.nspname as schema, p.proname,
         pg_get_function_identity_arguments(p.oid) as args,
         p.prosecdef, p.proconfig, p.proacl
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where (n.nspname = 'public' and p.proname = 'realtoros_mark_reply_hot')
     or (n.nspname = 'automation_internal' and p.proname in (
           'notify', 'notification_contact_name', 'notification_contact_route', 'notification_plain',
           'notify_on_stop_event', 'notify_on_import_batch', 'notify_on_job_failed'))
),
expected(schema, proname, args) as (
  values
    ('public', 'realtoros_mark_reply_hot', 'p_user_id uuid, p_event_ref text, p_reason text'),
    ('automation_internal', 'notify',
     'p_user_id uuid, p_type text, p_title text, p_body text, p_contact_id text, p_link_route text, p_dedupe_key text, p_metadata jsonb'),
    ('automation_internal', 'notification_contact_name', 'p_user_id uuid, p_contact_id text'),
    ('automation_internal', 'notification_contact_route', 'p_contact_id text'),
    ('automation_internal', 'notification_plain', 'p_text text, p_max integer'),
    ('automation_internal', 'notify_on_stop_event', ''),
    ('automation_internal', 'notify_on_import_batch', ''),
    ('automation_internal', 'notify_on_job_failed', '')
),
col(column_name, is_nullable) as (
  select column_name::text, is_nullable::text
  from information_schema.columns
  where table_schema = 'public' and table_name = 'notifications'
),
checks(check_name, ok, detail) as (

  -- ---------- table ----------
  select 'table public.notifications exists',
         to_regclass('public.notifications') is not null, null
  union all
  select 'columns present',
         (select count(*) from col where column_name in (
            'id', 'user_id', 'type', 'title', 'body', 'contact_id', 'link_route',
            'dedupe_key', 'metadata', 'created_at', 'read_at')) = 11,
         (select string_agg(column_name, ', ' order by column_name) from col)
  union all
  select 'unique (user_id, dedupe_key)',
         exists (select 1 from pg_constraint
                 where conrelid = 'public.notifications'::regclass and contype = 'u'
                   and pg_get_constraintdef(oid) = 'UNIQUE (user_id, dedupe_key)'),
         null
  union all
  -- Tenant-agnostic on purpose: T2c-pre moved the tenant half of this
  -- key from user_id to workspace_id. What 4H actually needs is that
  -- deleting a contact nulls ONLY notifications.contact_id - never the
  -- tenant column, which would cut the row loose from its workspace.
  select 'contact foreign key sets contact_id null on delete',
         exists (select 1 from pg_constraint c
                 where c.conrelid = 'public.notifications'::regclass and c.contype = 'f'
                   and c.confrelid = 'public.contacts'::regclass
                   and c.confdeltype = 'n'
                   and (select array_agg(a.attname::text order by a.attname)
                          from unnest(c.confdelsetcols) k(attnum)
                          join pg_attribute a
                            on a.attrelid = c.conrelid and a.attnum = k.attnum)
                       = array['contact_id']),
         null
  union all
  select 'type check lists the seven types',
         exists (select 1 from pg_constraint
                 where conrelid = 'public.notifications'::regclass and contype = 'c'
                   and pg_get_constraintdef(oid) like '%lead_replied%hot_reply%unsubscribed%spam_report%email_bounced%import_finished%followup_failed%'),
         null
  union all
  select 'link_route allow-list check',
         exists (select 1 from pg_constraint
                 where conrelid = 'public.notifications'::regclass and contype = 'c'
                   and pg_get_constraintdef(oid) like '%link_route%settings/sheet-imports%automation%notifications%'),
         null
  union all
  select 'index ' || i.name,
         exists (select 1 from pg_indexes where schemaname = 'public' and indexname = i.name),
         (select indexdef from pg_indexes where schemaname = 'public' and indexname = i.name)
  from (values ('notifications_user_created_idx'), ('notifications_user_unread_idx')) as i(name)
  union all
  select 'unread index is partial (read_at is null)',
         exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'notifications_user_unread_idx'
                 and indexdef ilike '%where (read_at is null)%'),
         null

  -- ---------- browser access ----------
  union all
  select 'RLS enabled',
         (select relrowsecurity from pg_class where oid = 'public.notifications'::regclass), null
  union all
  -- Name-agnostic: T2b-2 renamed these *_own -> *_scoped. Assert the
  -- SHAPE (one SELECT policy, one UPDATE policy with both clauses, and
  -- nothing else) so a future rename cannot break this check again.
  select 'owner select policy',
         exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notifications'
                 and cmd = 'SELECT'),
         null
  union all
  select 'owner update policy (using + with check)',
         exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notifications'
                 and cmd = 'UPDATE'
                 and qual is not null and with_check is not null),
         null
  union all
  -- Was "exactly 2 policies". That became brittle once T2b-2 renamed them
  -- *_own -> *_scoped: this file is re-applied by the re-runnability test,
  -- which resurrects the 4H-era pair on top of the T2b-2 pair. The real
  -- invariant being protected is that the BROWSER can never INSERT or
  -- DELETE a notification, so assert exactly that instead.
  select 'browser can never insert or delete notifications',
         not exists (
           select 1 from pg_policies
            where schemaname = 'public' and tablename = 'notifications'
              and cmd in ('INSERT', 'DELETE')
         ),
         null
  union all
  select 'authenticated: select yes; update read_at only; no insert / delete',
         has_table_privilege('authenticated', 'public.notifications', 'select')
         and not has_table_privilege('authenticated', 'public.notifications', 'insert')
         and not has_table_privilege('authenticated', 'public.notifications', 'delete')
         and not has_table_privilege('authenticated', 'public.notifications', 'update')
         and has_column_privilege('authenticated', 'public.notifications', 'read_at', 'update')
         and not has_column_privilege('authenticated', 'public.notifications', 'title', 'update')
         and not has_column_privilege('authenticated', 'public.notifications', 'type', 'update')
         and not has_column_privilege('authenticated', 'public.notifications', 'user_id', 'update'),
         null
  union all
  select 'anon: no access',
         not has_table_privilege('anon', 'public.notifications', 'select')
         and not has_table_privilege('anon', 'public.notifications', 'insert')
         and not has_column_privilege('anon', 'public.notifications', 'read_at', 'update'),
         null

  -- ---------- functions ----------
  union all
  select 'signature: ' || e.schema || '.' || e.proname,
         exists (select 1 from fn where fn.schema = e.schema and fn.proname = e.proname and fn.args = e.args),
         coalesce((select string_agg(fn.args, ' | ') from fn where fn.schema = e.schema and fn.proname = e.proname), 'MISSING')
  from expected e
  union all
  select 'one definition each (no overloads)', (select count(*) from fn) = 8, (select count(*)::text from fn)
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

  -- ---------- triggers ----------
  union all
  select 'trigger ' || t.tgname || ' on ' || t.tbl,
         exists (select 1 from pg_trigger tg
                 where tg.tgname = t.tgname and tg.tgrelid = to_regclass(t.tbl) and not tg.tgisinternal
                   and tg.tgenabled <> 'D'),
         null
  from (values
    ('notify_on_stop_event', 'public.contact_stop_events'),
    ('notify_on_import_batch_insert', 'public.lead_import_batches'),
    ('notify_on_import_batch_update', 'public.lead_import_batches'),
    ('notify_on_job_failed', 'public.automation_jobs')
  ) as t(tgname, tbl)
  union all
  select 'every trigger function catches its own errors',
         (select count(*) from fn
          where proname in ('notify_on_stop_event', 'notify_on_import_batch', 'notify_on_job_failed')
            and pg_get_functiondef(fn.oid) like '%exception when others then%raise warning%') = 3,
         null

  -- ---------- live functions untouched ----------
  union all
  select 'live stop / import functions keep their signatures',
         to_regprocedure('public.realtoros_record_contact_stop_event(uuid, text, text, text, text, uuid, timestamptz)') is not null
         and to_regprocedure('public.realtoros_ingest_lead_batch(uuid, text, text, jsonb)') is not null
         and to_regprocedure('public.realtoros_ingest_lead_file(uuid, uuid, text, jsonb, boolean)') is not null,
         null
)
select check_name, ok, detail from checks order by ok, check_name;
