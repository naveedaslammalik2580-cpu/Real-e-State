-- Phase 4E.2 verification — run AFTER applying
-- 20260929041708_phase_4e_2_stop_logic_completion.sql (live).
--
-- READ-ONLY. One result set, one row per check. Every row must show
-- ok = true; any false row names what is wrong in `check_name`/`detail`.
-- Nothing here writes, calls a stop function, or reads contact data.

with
fn as (
  select p.oid, p.proname, pg_get_function_identity_arguments(p.oid) as args,
         p.prosecdef, p.proconfig, p.prosrc, p.proacl
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'realtoros_stop_enrollment_on_event',
      'realtoros_record_contact_stop_event',
      'realtoros_presend_guard',
      'realtoros_skip_claimed_job',
      'realtoros_rule_stop_summary',
      'realtoros_check_enrollment_eligibility',
      'realtoros_open_enrollments_for_contact'
    )
),
expected_sig(proname, args) as (
  values
    ('realtoros_stop_enrollment_on_event',
     'p_user_id uuid, p_enrollment_id uuid, p_reason text, p_contact_id text, p_now timestamp with time zone'),
    ('realtoros_record_contact_stop_event',
     'p_user_id uuid, p_contact_id text, p_event_type text, p_source text, p_event_ref text, p_outbound_message_id uuid, p_occurred_at timestamp with time zone'),
    ('realtoros_presend_guard',
     'p_user_id uuid, p_job_id uuid, p_lock_token uuid'),
    ('realtoros_skip_claimed_job',
     'p_user_id uuid, p_job_id uuid, p_lock_token uuid, p_reason text'),
    ('realtoros_rule_stop_summary',
     'p_user_id uuid, p_rule_id uuid, p_limit integer'),
    ('realtoros_check_enrollment_eligibility',
     'p_user_id uuid, p_contact_id text, p_rule_id uuid'),
    ('realtoros_open_enrollments_for_contact',
     'p_user_id uuid, p_contact_id text')
),
checks(check_name, ok, detail) as (

  -- ---------- function signatures ----------
  select 'signature: ' || e.proname,
         exists (select 1 from fn where fn.proname = e.proname and fn.args = e.args),
         coalesce((select string_agg(fn.args, ' | ') from fn where fn.proname = e.proname), 'MISSING')
  from expected_sig e

  union all
  select 'no overload: realtoros_record_contact_stop_event',
         (select count(*) from fn where proname = 'realtoros_record_contact_stop_event') = 1,
         (select count(*)::text || ' definition(s)' from fn where proname = 'realtoros_record_contact_stop_event')

  union all
  select 'old 4-arg realtoros_record_contact_stop_event is gone',
         not exists (select 1 from fn where proname = 'realtoros_record_contact_stop_event'
                     and args = 'p_user_id uuid, p_contact_id text, p_event_type text, p_now timestamp with time zone'),
         null

  -- ---------- grants: anon / authenticated / PUBLIC = false, service_role = true ----------
  union all
  select 'grant anon=false: ' || fn.proname, not has_function_privilege('anon', fn.oid, 'execute'), fn.args from fn
  union all
  select 'grant authenticated=false: ' || fn.proname, not has_function_privilege('authenticated', fn.oid, 'execute'), fn.args from fn
  union all
  select 'grant service_role=true: ' || fn.proname, has_function_privilege('service_role', fn.oid, 'execute'), fn.args from fn
  union all
  select 'no PUBLIC execute: ' || fn.proname,
         fn.proacl is not null and not exists (
           select 1 from aclexplode(fn.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'
         ),
         fn.args
  from fn

  -- ---------- function hygiene ----------
  union all
  select 'security invoker: ' || fn.proname, not fn.prosecdef, null from fn
  union all
  select 'empty search_path: ' || fn.proname,
         coalesce('search_path=""' = any(fn.proconfig), false),
         array_to_string(fn.proconfig, ', ')
  from fn

  -- ---------- stop function: blocking lock + retry outcome + reasons ----------
  union all
  select 'stop_enrollment_on_event: lock_timeout configured',
         exists (select 1 from fn where proname = 'realtoros_stop_enrollment_on_event'
                 and exists (select 1 from unnest(proconfig) c where c like 'lock_timeout=%')),
         (select array_to_string(proconfig, ', ') from fn where proname = 'realtoros_stop_enrollment_on_event')
  union all
  select 'stop_enrollment_on_event: no SKIP LOCKED',
         exists (select 1 from fn where proname = 'realtoros_stop_enrollment_on_event'
                 and prosrc !~* 'skip\s+locked'),
         null
  union all
  select 'stop_enrollment_on_event: handles lock_not_available -> retry',
         exists (select 1 from fn where proname = 'realtoros_stop_enrollment_on_event'
                 and prosrc ~* 'lock_not_available' and prosrc ~ '''retry'''),
         null
  union all
  select 'stop_enrollment_on_event: allowed reasons include complaint',
         exists (select 1 from fn where proname = 'realtoros_stop_enrollment_on_event'
                 and prosrc like '%(''reply'', ''unsubscribe'', ''complaint'', ''bounce'', ''suppression'')%'),
         null

  -- ---------- record function: event types, sources, suppression ----------
  union all
  select 'record_contact_stop_event: event types',
         exists (select 1 from fn where proname = 'realtoros_record_contact_stop_event'
                 and prosrc like '%(''reply'', ''unsubscribe'', ''complaint'', ''hard_bounce'')%'),
         null
  union all
  select 'record_contact_stop_event: sources',
         exists (select 1 from fn where proname = 'realtoros_record_contact_stop_event'
                 and prosrc like '%(''provider_webhook'', ''unsubscribe_link'', ''inbound_email'', ''owner_manual'')%'),
         null
  union all
  select 'record_contact_stop_event: writes email_suppressions with partial-index ON CONFLICT',
         exists (select 1 from fn where proname = 'realtoros_record_contact_stop_event'
                 and prosrc ~* 'insert\s+into\s+public\.email_suppressions'
                 and prosrc ~* 'on\s+conflict\s*\(user_id,\s*normalized_email\)\s*where\s+is_active'),
         null
  union all
  select 'record_contact_stop_event: consent source is not hardcoded',
         exists (select 1 from fn where proname = 'realtoros_record_contact_stop_event'
                 and prosrc !~ '''webhook''\s*,\s*v_' and prosrc ~ 'p_source,\s*v_at'),
         null
  union all
  select 'record_contact_stop_event: lock_timeout configured',
         exists (select 1 from fn where proname = 'realtoros_record_contact_stop_event'
                 and exists (select 1 from unnest(proconfig) c where c like 'lock_timeout=%')),
         null

  -- ---------- partial unique index the ON CONFLICT relies on ----------
  union all
  select 'index email_suppressions_active_unique_idx is unique + partial on is_active',
         exists (
           select 1 from pg_indexes
           where schemaname = 'public' and indexname = 'email_suppressions_active_unique_idx'
             and indexdef ~* 'unique' and indexdef ~* 'where\s+is_active'
         ),
         (select indexdef from pg_indexes where schemaname = 'public' and indexname = 'email_suppressions_active_unique_idx')

  -- ---------- reply-token lookup index ----------
  union all
  select 'index outbound_messages_reply_token_idx is unique + partial on metadata->>reply_token',
         exists (
           select 1 from pg_indexes
           where schemaname = 'public' and indexname = 'outbound_messages_reply_token_idx'
             and indexdef ~* 'unique' and indexdef ~* 'reply_token' and indexdef ~* 'where'
         ),
         (select indexdef from pg_indexes where schemaname = 'public' and indexname = 'outbound_messages_reply_token_idx')

  -- ---------- new column ----------
  union all
  select 'column automation_jobs.skipped_reason exists',
         exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'automation_jobs' and column_name = 'skipped_reason'),
         null
  union all
  select 'constraint automation_jobs_skipped_reason_check exists',
         exists (select 1 from pg_constraint
                 where conrelid = 'public.automation_jobs'::regclass and conname = 'automation_jobs_skipped_reason_check'),
         null
  union all
  select 'authenticated cannot write automation_jobs.skipped_reason',
         not has_column_privilege('authenticated', 'public.automation_jobs', 'skipped_reason', 'update')
         and not has_column_privilege('authenticated', 'public.automation_jobs', 'skipped_reason', 'insert'),
         null

  -- ---------- new ledger table ----------
  union all
  select 'table contact_stop_events exists',
         to_regclass('public.contact_stop_events') is not null, null
  union all
  select 'contact_stop_events: RLS enabled',
         coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.contact_stop_events')), false), null
  union all
  select 'contact_stop_events: no RLS policies (service-role only)',
         not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'contact_stop_events'),
         (select string_agg(policyname, ', ') from pg_policies where schemaname = 'public' and tablename = 'contact_stop_events')
  union all
  select 'contact_stop_events: anon has no table privileges',
         to_regclass('public.contact_stop_events') is not null
         and not has_table_privilege('anon', 'public.contact_stop_events', 'select, insert, update, delete'),
         null
  union all
  select 'contact_stop_events: authenticated has no table privileges',
         to_regclass('public.contact_stop_events') is not null
         and not has_table_privilege('authenticated', 'public.contact_stop_events', 'select, insert, update, delete'),
         null
  union all
  select 'contact_stop_events: service_role can select + insert',
         to_regclass('public.contact_stop_events') is not null
         and has_table_privilege('service_role', 'public.contact_stop_events', 'select')
         and has_table_privilege('service_role', 'public.contact_stop_events', 'insert'),
         null
  union all
  select 'contact_stop_events: unique (user_id, source, event_ref)',
         exists (select 1 from pg_constraint
                 where conrelid = to_regclass('public.contact_stop_events') and contype = 'u'
                   and pg_get_constraintdef(oid) = 'UNIQUE (user_id, source, event_ref)'),
         null
  union all
  select 'contact_stop_events: event_type check values',
         exists (select 1 from pg_constraint
                 where conrelid = to_regclass('public.contact_stop_events') and contype = 'c'
                   and pg_get_constraintdef(oid) like '%event_type%reply%unsubscribe%complaint%hard_bounce%'),
         null
  union all
  select 'contact_stop_events: source check values',
         exists (select 1 from pg_constraint
                 where conrelid = to_regclass('public.contact_stop_events') and contype = 'c'
                   and pg_get_constraintdef(oid) like '%source%provider_webhook%unsubscribe_link%inbound_email%owner_manual%'),
         null

  -- ---------- 4E hotfix: lifecycle-protect trigger function ----------
  union all
  select 'protect_contact_lifecycle_columns: no pg_catalog.current_user (parse error at run time)',
         exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'automation_internal' and p.proname = 'protect_contact_lifecycle_columns'
                   and p.prosrc !~* 'pg_catalog\.current_user' and p.prosrc ~* '\mcurrent_user\M'),
         null

  -- ---------- unchanged 4E pieces still protected ----------
  union all
  select 'contacts lifecycle-protect trigger still present',
         exists (select 1 from pg_trigger
                 where tgrelid = 'public.contacts'::regclass
                   and tgname = 'contacts_protect_lifecycle_columns_trigger' and not tgisinternal),
         null
  union all
  select 'email_suppressions: authenticated is select-only',
         has_table_privilege('authenticated', 'public.email_suppressions', 'select')
         and not has_table_privilege('authenticated', 'public.email_suppressions', 'insert, update, delete'),
         null
)
select check_name, ok, detail
from checks
order by ok, check_name;
