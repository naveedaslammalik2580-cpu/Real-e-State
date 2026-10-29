-- Phase 4E.3 verification — run AFTER applying
-- 20260929051621_phase_4e_3_unsubscribe_by_reply.sql (live).
--
-- READ-ONLY. One result set, one row per check; every row must show
-- ok = true. Nothing here writes or calls a stop function.
-- (supabase/tests/phase_4e_2_verification.sql should still pass too.)

with
fn as (
  select p.oid, pg_get_function_identity_arguments(p.oid) as args,
         p.prosecdef, p.proconfig, p.prosrc, p.proacl
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'realtoros_record_contact_stop_event'
),
checks(check_name, ok, detail) as (
  select 'exactly one realtoros_record_contact_stop_event',
         (select count(*) from fn) = 1,
         (select count(*)::text || ' definition(s)' from fn)
  union all
  select 'signature unchanged',
         exists (select 1 from fn where args =
           'p_user_id uuid, p_contact_id text, p_event_type text, p_source text, p_event_ref text, p_outbound_message_id uuid, p_occurred_at timestamp with time zone'),
         (select string_agg(args, ' | ') from fn)
  union all
  select 'anon cannot execute', not has_function_privilege('anon', (select oid from fn), 'execute'), null
  union all
  select 'authenticated cannot execute', not has_function_privilege('authenticated', (select oid from fn), 'execute'), null
  union all
  select 'service_role can execute', has_function_privilege('service_role', (select oid from fn), 'execute'), null
  union all
  select 'no PUBLIC execute',
         exists (select 1 from fn where proacl is not null and not exists (
           select 1 from aclexplode(proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE')),
         null
  union all
  select 'security invoker, empty search_path, lock_timeout kept',
         exists (select 1 from fn where not prosecdef
                 and 'search_path=""' = any(proconfig)
                 and exists (select 1 from unnest(proconfig) c where c like 'lock_timeout=%')),
         (select array_to_string(proconfig, ', ') from fn)
  union all
  select 'unsubscribe accepts inbound_email',
         exists (select 1 from fn where prosrc like
           '%p_event_type = ''unsubscribe'' and p_source in (''unsubscribe_link'', ''owner_manual'', ''provider_webhook'', ''inbound_email'')%'),
         null
  union all
  select 'complaint / hard_bounce still provider_webhook only',
         exists (select 1 from fn where prosrc like
           '%p_event_type in (''complaint'', ''hard_bounce'') and p_source = ''provider_webhook''%'),
         null
  union all
  select 'timeline note for a reply-to-unsubscribe',
         exists (select 1 from fn where prosrc like '%They replied asking to be unsubscribed.%'),
         null
)
select check_name, ok, detail from checks order by ok, check_name;
