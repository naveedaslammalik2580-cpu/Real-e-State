-- ============================================================================
-- RealtorOS — Post-Deployment Security Audit
-- ============================================================================
-- Run in the Supabase Dashboard SQL Editor after all migrations are applied
-- and all Edge Functions are deployed. Every query is read-only.
--
-- Re-run this after any schema change, and again at the end of Phase 4G
-- acceptance testing.
--
-- Contains no secrets, no project reference, and no environment-specific value.
--
-- The single most important check is section 2: it must return ZERO ROWS.
-- ============================================================================


-- ============================================================================
-- 1. ROW LEVEL SECURITY
-- ============================================================================

-- Expected: rowsecurity = true for EVERY row returned.
select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
  and tablename in (
    'automation_rules', 'automation_steps', 'automation_enrollments',
    'automation_jobs', 'automation_runs', 'automation_failures',
    'automation_trigger_events', 'outbound_messages', 'email_suppressions',
    'communication_consents', 'email_sender_profiles', 'webhook_events',
    'message_templates', 'contacts', 'activities', 'tasks'
  )
order by tablename;

-- Expected: 0 rows. Any public.* table without RLS is a finding.
select tablename
from pg_tables
where schemaname = 'public' and rowsecurity = false
order by tablename;

-- Every RLS policy, for review. Expected shape: each table has owner-scoped
-- policies using ((select auth.uid()) = user_id), and the runtime tables that
-- the browser may only read have a SELECT policy only.
select tablename, policyname, cmd, roles::text
from pg_policies
where schemaname = 'public'
order by tablename, cmd, policyname;

-- Expected: automation_trigger_events has a SELECT policy and NO
-- insert/update/delete policy for authenticated — the browser may read its own
-- outbox rows but never write them.
select tablename, policyname, cmd
from pg_policies
where schemaname = 'public' and tablename = 'automation_trigger_events'
order by cmd;


-- ============================================================================
-- 2. RPC GRANTS  ***THE CRITICAL CHECK***
-- ============================================================================

-- Expected: ZERO ROWS.
-- Every realtoros_* RPC is service-role-only. Any row here means the browser
-- (anon or authenticated) can invoke a privileged automation function directly,
-- bypassing manage-automation's ownership and eligibility checks.
select r.routine_name, rp.grantee, rp.privilege_type
from information_schema.routine_privileges rp
join information_schema.routines r
  on r.specific_name = rp.specific_name
 and r.specific_schema = rp.specific_schema
where rp.specific_schema = 'public'
  and r.routine_name in (
    -- Phase 4C
    'realtoros_claim_test_send',
    -- Phase 4D (execution)
    'realtoros_claim_trigger_events', 'realtoros_claim_due_jobs',
    'realtoros_enroll_contact', 'realtoros_complete_job_and_advance',
    'realtoros_reschedule_job', 'realtoros_stop_enrollment',
    'realtoros_retry_failed_job', 'realtoros_recover_stale_automation_leases',
    -- Phase 4D (reliability)
    'realtoros_complete_trigger_event', 'realtoros_reschedule_trigger_event',
    'realtoros_fail_trigger_event', 'realtoros_cancel_claimed_job',
    'realtoros_archive_rule',
    -- Phase 4E
    'realtoros_stop_enrollment_on_event', 'realtoros_record_contact_stop_event',
    'realtoros_check_enrollment_eligibility', 'realtoros_open_enrollments_for_contact',
    'realtoros_rule_stop_summary',
    -- Phase 4E.2
    'realtoros_presend_guard', 'realtoros_skip_claimed_job'
  )
  and rp.grantee in ('anon', 'authenticated', 'PUBLIC')
order by r.routine_name, rp.grantee;

-- Broader sweep: ANY public function granted to anon/authenticated.
-- Some legitimately are (the Phase 3 deal/follow-up RPCs the browser calls
-- directly). Review each and confirm it is intentional; no realtoros_*
-- automation function should appear.
select r.routine_name, rp.grantee, rp.privilege_type
from information_schema.routine_privileges rp
join information_schema.routines r
  on r.specific_name = rp.specific_name
 and r.specific_schema = rp.specific_schema
where rp.specific_schema = 'public'
  and rp.grantee in ('anon', 'authenticated', 'PUBLIC')
order by r.routine_name, rp.grantee;

-- Expected: service_role has EXECUTE on all 19 automation RPCs.
-- A missing grant here means the Edge Functions will fail at runtime.
select r.routine_name, rp.grantee, rp.privilege_type
from information_schema.routine_privileges rp
join information_schema.routines r
  on r.specific_name = rp.specific_name
 and r.specific_schema = rp.specific_schema
where rp.specific_schema = 'public'
  and r.routine_name like 'realtoros_%'
  and rp.grantee = 'service_role'
order by r.routine_name;

-- Expected: 0 rows. Nothing in automation_internal may be browser-callable.
select r.routine_name, rp.grantee, rp.privilege_type
from information_schema.routine_privileges rp
join information_schema.routines r
  on r.specific_name = rp.specific_name
 and r.specific_schema = rp.specific_schema
where rp.specific_schema = 'automation_internal'
  and rp.grantee in ('anon', 'authenticated', 'PUBLIC')
order by r.routine_name;


-- ============================================================================
-- 3. TRIGGERS
-- ============================================================================

-- Expected on public.contacts: 4 automation-related trigger rows —
--   contacts_automation_created_trigger          AFTER  INSERT
--   contacts_automation_status_changed_trigger   AFTER  UPDATE
--   contacts_protect_lifecycle_columns_trigger   BEFORE INSERT
--   contacts_protect_lifecycle_columns_trigger   BEFORE UPDATE
-- (plus any pre-existing updated_at trigger)
select trigger_name, event_manipulation, action_timing, action_orientation
from information_schema.triggers
where event_object_schema = 'public' and event_object_table = 'contacts'
order by trigger_name, event_manipulation;

-- Expected: 2 rows (INSERT + UPDATE), both BEFORE.
-- This is the ONLY thing preventing the browser from writing
-- contacts.reply_detected_at / unsubscribe_detected_at, because contacts
-- carries a table-level UPDATE grant to authenticated and PostgreSQL cannot
-- subtract a column-level revoke from a table-level grant.
-- If this returns 0 rows, the Phase 4E column protection is NOT in effect.
select trigger_name, event_manipulation, action_timing
from information_schema.triggers
where event_object_schema = 'public'
  and event_object_table = 'contacts'
  and trigger_name = 'contacts_protect_lifecycle_columns_trigger'
order by event_manipulation;

-- All triggers on automation-related tables, for review.
select event_object_table, trigger_name, event_manipulation, action_timing
from information_schema.triggers
where event_object_schema = 'public'
  and event_object_table in (
    'contacts', 'automation_rules', 'automation_enrollments', 'automation_jobs',
    'automation_runs', 'automation_trigger_events', 'outbound_messages',
    'email_suppressions', 'communication_consents', 'email_sender_profiles'
  )
order by event_object_table, trigger_name, event_manipulation;


-- ============================================================================
-- 4. SECURITY DEFINER AUDIT
-- ============================================================================

-- Expected: 0 rows.
-- Every public.realtoros_* function is SECURITY INVOKER. A DEFINER function in
-- public that the browser could reach would run with the owner's privileges.
select routine_name, security_type
from information_schema.routines
where routine_schema = 'public'
  and routine_name like 'realtoros_%'
  and security_type = 'DEFINER'
order by routine_name;

-- Every SECURITY DEFINER function anywhere in these schemas.
-- Expected: exactly 2, both in automation_internal, both trigger functions:
--   contact_created_event
--   contact_status_changed_event
-- They must be DEFINER: the authenticated user who inserts their own contact
-- has no grant on automation_trigger_events. They take no parameters and read
-- only NEW/OLD from the row the caller's own RLS-checked write produced, so
-- there is no external input to validate.
--
-- protect_contact_lifecycle_columns must NOT appear here — it is deliberately
-- INVOKER so that current_user is the caller's PostgREST role.
select n.nspname as schema, p.proname as function_name, p.prosecdef as security_definer
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('public', 'automation_internal')
  and p.prosecdef = true
order by n.nspname, p.proname;

-- Expected: 0 rows. Every automation function must pin an empty search_path.
-- A mutable search_path on a DEFINER function is a privilege-escalation vector,
-- and Supabase's Security Advisor flags it.
select n.nspname as schema, p.proname as function_name, p.proconfig
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where (
        (n.nspname = 'public' and p.proname like 'realtoros_%')
        or n.nspname = 'automation_internal'
      )
  and (p.proconfig is null or not (p.proconfig @> array['search_path=']))
order by n.nspname, p.proname;


-- ============================================================================
-- 5. TABLE GRANTS
-- ============================================================================

-- Expected: automation runtime tables grant SELECT only to authenticated
-- (or nothing at all). Any INSERT/UPDATE/DELETE to anon or authenticated on
-- automation_jobs, automation_runs, automation_trigger_events, webhook_events,
-- outbound_messages or email_suppressions is a finding — those are written
-- exclusively by service_role.
select table_name, grantee, string_agg(privilege_type, ', ' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee in ('anon', 'authenticated')
  and table_name in (
    'automation_rules', 'automation_steps', 'automation_enrollments',
    'automation_jobs', 'automation_runs', 'automation_failures',
    'automation_trigger_events', 'outbound_messages', 'email_suppressions',
    'communication_consents', 'email_sender_profiles', 'webhook_events'
  )
group by table_name, grantee
order by table_name, grantee;

-- Expected: 0 rows. anon should have no direct table access at all — the
-- browser is always authenticated before it reads anything.
select table_name, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and grantee = 'anon'
order by table_name, privilege_type;

-- Column-level grants, for review. Phase 4D deliberately withholds column
-- grants for runtime_version / runtime_snapshot on automation_rules so the
-- browser cannot activate a rule by writing the table directly.
select table_name, column_name, grantee, privilege_type
from information_schema.column_privileges
where table_schema = 'public'
  and grantee in ('anon', 'authenticated')
  and table_name in ('automation_rules', 'automation_jobs', 'contacts')
order by table_name, column_name, grantee;


-- ============================================================================
-- 6. PERFORMANCE-CRITICAL INDEXES
-- ============================================================================
-- All four hot lookups are already indexed by the migrations. These queries
-- confirm the indexes survived deployment. Expected: 1 row each.

-- Webhook lookup: outbound_messages by provider message id.
select indexname, indexdef
from pg_indexes
where schemaname = 'public' and indexname = 'outbound_messages_provider_message_idx';

-- Eligibility + stop fan-out: enrollments by contact.
select indexname, indexdef
from pg_indexes
where schemaname = 'public' and indexname = 'automation_enrollments_contact_idx';

-- Job cancellation: jobs by enrollment.
select indexname, indexdef
from pg_indexes
where schemaname = 'public' and indexname = 'automation_jobs_enrollment_idx';

-- Suppression lookup (partial, on is_active).
select indexname, indexdef
from pg_indexes
where schemaname = 'public' and indexname = 'email_suppressions_active_unique_idx';

-- Worker hot path: pending jobs due now.
select indexname, indexdef
from pg_indexes
where schemaname = 'public' and indexname = 'automation_jobs_claim_idx';

-- Full index inventory on the automation tables, for review.
select tablename, indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and tablename in (
    'automation_rules', 'automation_enrollments', 'automation_jobs',
    'automation_runs', 'automation_trigger_events', 'outbound_messages',
    'email_suppressions', 'communication_consents', 'webhook_events', 'contacts'
  )
order by tablename, indexname;


-- ============================================================================
-- 7. DATA INTEGRITY
-- ============================================================================

-- Expected: 0 rows. An enrollment whose rule no longer exists.
-- (The composite FK should make this impossible; this catches drift.)
select e.id as enrollment_id, e.rule_id
from public.automation_enrollments e
left join public.automation_rules r on r.id = e.rule_id and r.user_id = e.user_id
where r.id is null;

-- Expected: 0 rows. A job whose enrollment no longer exists.
select j.id as job_id, j.enrollment_id
from public.automation_jobs j
left join public.automation_enrollments e on e.id = j.enrollment_id and e.user_id = j.user_id
where j.enrollment_id is not null and e.id is null;

-- Expected: 0 rows. A run whose job no longer exists.
select rn.id as run_id, rn.job_id
from public.automation_runs rn
left join public.automation_jobs j on j.id = rn.job_id and j.user_id = rn.user_id
where j.id is null;

-- Expected: 0 rows. An ACTIVE enrollment with no pending or processing job is
-- stranded — it will never advance. Phase 4D's terminal-failure handling and
-- Phase 4E's stop logic both move the enrollment out of 'active' precisely to
-- prevent this.
select e.id as enrollment_id, e.rule_id, e.contact_id, e.next_action_at
from public.automation_enrollments e
where e.status = 'active'
  and not exists (
    select 1 from public.automation_jobs j
    where j.enrollment_id = e.id and j.user_id = e.user_id
      and j.status in ('pending', 'processing')
  );

-- Expected: 0 rows. A claimed job must have exactly one 'processing' run for
-- its current attempt — the Phase 4D run invariant.
select j.id as job_id, j.attempts,
       (select count(*) from public.automation_runs r
        where r.job_id = j.id and r.user_id = j.user_id
          and r.attempt_number = j.attempts and r.status = 'processing') as processing_runs
from public.automation_jobs j
where j.status = 'processing'
  and (select count(*) from public.automation_runs r
       where r.job_id = j.id and r.user_id = j.user_id
         and r.attempt_number = j.attempts and r.status = 'processing') <> 1;

-- Expected: 0 rows. max_attempts must never exceed the database ceiling of 20.
select id, attempts, max_attempts, manual_retry_count
from public.automation_jobs
where max_attempts > 20 or manual_retry_count > 1;

-- Expected: 0 rows. A contact with a revoked email consent must not have an
-- open enrollment — Phase 4E's stop logic and eligibility guard both prevent it.
select e.id as enrollment_id, e.contact_id, e.status
from public.automation_enrollments e
join public.communication_consents c
  on c.user_id = e.user_id and c.contact_id = e.contact_id and c.channel = 'email'
where c.status = 'opted_out'
  and e.status in ('active', 'paused');

-- Expected: 0 rows. A contact with an active suppression must not have an open
-- enrollment.
select e.id as enrollment_id, e.contact_id, e.status
from public.automation_enrollments e
join public.contacts ct on ct.id = e.contact_id and ct.user_id = e.user_id
join public.email_suppressions s
  on s.user_id = e.user_id
 and s.normalized_email = lower(btrim(ct.email))
 and s.is_active
where e.status in ('active', 'paused');


-- ============================================================================
-- 8. OPERATIONAL SNAPSHOT
-- ============================================================================
-- Not pass/fail — this is the "what is the system doing right now" view.

select status, count(*) from public.automation_rules             group by status order by status;
select status, count(*) from public.automation_enrollments       group by status order by status;
select status, count(*) from public.automation_jobs              group by status order by status;
select status, count(*) from public.automation_trigger_events    group by status order by status;
select status, count(*) from public.outbound_messages            group by status order by status;
select reason, is_active, count(*) from public.email_suppressions group by reason, is_active order by reason;

-- Why enrollments have stopped, by reason.
select stop_reason, count(*)
from public.automation_enrollments
where status = 'stopped'
group by stop_reason
order by count(*) desc;

-- Why jobs were cancelled, by reason (Phase 4E).
select cancelled_reason, count(*)
from public.automation_jobs
where status = 'cancelled'
group by cancelled_reason
order by count(*) desc;

-- Unresolved failures needing attention.
select category, error_code, retriable, count(*)
from public.automation_failures
where resolved = false
group by category, error_code, retriable
order by count(*) desc;

-- Webhook health. A rising 'failed' count means the handler is erroring;
-- check the Edge Function logs.
select status, count(*), max(received_at) as most_recent
from public.webhook_events
group by status
order by status;

-- Expected: 0 rows. An event stuck 'processing' well past the 300s stale-lease
-- window means the recovery sweep is not running — check the cron job.
select id, status, locked_at, attempts, max_attempts
from public.automation_trigger_events
where status = 'processing' and locked_at < now() - interval '15 minutes';

select id, status, locked_at, attempts, max_attempts
from public.automation_jobs
where status = 'processing' and locked_at < now() - interval '15 minutes';


-- ============================================================================
-- 9. MANUAL DASHBOARD CHECKS
-- ============================================================================
-- Not runnable as SQL. Complete these in the Supabase Dashboard:
--
--   [ ] Database > Security Advisor    — resolve every ERROR; review WARNINGs.
--                                        "Function Search Path Mutable" should
--                                        not appear (section 4 proves it).
--   [ ] Database > Performance Advisor — review index suggestions. The four hot
--                                        lookups are already covered (section 6);
--                                        ignore low-cardinality status-column
--                                        suggestions until volume justifies them.
--   [ ] Edge Functions > Logs          — confirm NO email address, contact name,
--                                        phone number, message body, API key or
--                                        worker secret appears. The functions
--                                        contain zero console.* calls, so logs
--                                        should hold only platform request lines.
--   [ ] Authentication > Policies      — spot-check that RLS is enforced by
--                                        signing in as a second user and
--                                        confirming they see none of the first
--                                        user's contacts or automation data.
