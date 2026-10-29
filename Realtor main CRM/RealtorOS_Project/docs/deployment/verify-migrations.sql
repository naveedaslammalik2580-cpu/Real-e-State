-- ============================================================================
-- RealtorOS — Post-Migration Verification
-- ============================================================================
-- Checks the Phase 4C/4D/4E schema, which is already live. After applying
-- the Phase 4E.2 migration, ALSO run supabase/tests/phase_4e_2_verification.sql
-- (every row must be ok = true). Every query here is read-only.
--
-- Run the whole file at once and read the results top to bottom, or run each
-- block individually. Each block states its expected result.
--
-- Contains no secrets, no project reference, and no environment-specific value.
-- ============================================================================


-- ============================================================================
-- 0. MIGRATION LEDGER
-- ============================================================================
-- Expected: 22 rows, in ascending order, ending with 20261005140817
-- (Phase T2b-1 permission system, already live).
-- The last eleven must be (live version numbers; repository files renamed to match):
--   20260904020906, 20260904020954, 20260904021204, 20260904021416,
--   20260904060217, 20260929041708, 20260929051621, 20260929095530,
--   20260929150944, 20261001160608, 20261005140817
select version, name
from supabase_migrations.schema_migrations
order by version;

-- Expected: exactly 9 rows (the Phase 4C/4D/4E/4E.2/4E.3/4E.4/4H set).
select version, name
from supabase_migrations.schema_migrations
where version >= '20260904020906'
order by version;


-- ============================================================================
-- 1. PHASE 4C FOUNDATION — 20260904020906
-- ============================================================================

-- Expected: 2 rows — email_sender_profiles, email_suppressions
select tablename
from pg_tables
where schemaname = 'public'
  and tablename in ('email_sender_profiles', 'email_suppressions')
order by tablename;

-- Expected: 10 rows — every column this migration adds to outbound_messages.
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name = 'outbound_messages'
  and column_name in (
    'message_kind', 'idempotency_key', 'sender_display_name', 'sender_address',
    'reply_to_email', 'delivery_delayed_at', 'bounced_at', 'complained_at',
    'suppressed_at', 'unsubscribed_at'
  )
order by column_name;

-- Expected: is_nullable = 'YES'. This migration drops the NOT NULL so that a
-- Phase 4C test send (which has no contact) can be recorded.
select column_name, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'outbound_messages'
  and column_name = 'contact_id';

-- Expected: RLS enabled on both new tables (rowsecurity = true).
select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
  and tablename in ('email_sender_profiles', 'email_suppressions')
order by tablename;

-- Expected: 2 rows.
--   email_suppressions_active_unique_idx  — UNIQUE (user_id, normalized_email) WHERE is_active
--   email_suppressions_user_email_idx     — (user_id, normalized_email)
select indexname, indexdef
from pg_indexes
where schemaname = 'public' and tablename = 'email_suppressions'
  and indexname like 'email_suppressions%'
order by indexname;

-- Expected: 1 row — outbound_messages_user_idempotency_idx (unique, partial).
select indexname, indexdef
from pg_indexes
where schemaname = 'public' and indexname = 'outbound_messages_user_idempotency_idx';


-- ============================================================================
-- 2. PHASE 4C RELIABILITY — 20260904020954
-- ============================================================================

-- Expected: 3 rows — send_attempt_count, send_attempt_started_at, send_attempt_token
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'outbound_messages'
  and column_name like 'send_attempt%'
order by column_name;

-- Expected: 1 row — realtoros_claim_test_send
select routine_name, security_type
from information_schema.routines
where routine_schema = 'public' and routine_name = 'realtoros_claim_test_send';


-- ============================================================================
-- 3. PHASE 4D EXECUTION — 20260904021204
-- ============================================================================

-- Expected: 1 row — automation_trigger_events
select tablename, rowsecurity
from pg_tables
where schemaname = 'public' and tablename = 'automation_trigger_events';

-- Expected: 1 row — the automation_internal schema.
select nspname from pg_namespace where nspname = 'automation_internal';

-- Expected: 2 rows, both AFTER triggers on public.contacts.
--   contacts_automation_created_trigger         (INSERT)
--   contacts_automation_status_changed_trigger  (UPDATE)
select trigger_name, event_manipulation, action_timing
from information_schema.triggers
where event_object_schema = 'public'
  and event_object_table = 'contacts'
  and trigger_name like 'contacts_automation%'
order by trigger_name, event_manipulation;

-- Expected: 5 rows — the runtime columns on automation_rules.
select column_name
from information_schema.columns
where table_schema = 'public' and table_name = 'automation_rules'
  and column_name in ('runtime_version', 'runtime_snapshot', 'activated_at', 'paused_at', 'archived_at')
order by column_name;

-- Expected: 4 rows — job locking / failure classification columns.
select column_name
from information_schema.columns
where table_schema = 'public' and table_name = 'automation_jobs'
  and column_name in ('lock_token', 'next_retry_at', 'failure_category', 'retriable')
order by column_name;

-- Expected: 4 rows — enrollment idempotency columns.
select column_name
from information_schema.columns
where table_schema = 'public' and table_name = 'automation_enrollments'
  and column_name in ('trigger_event_id', 'trigger_event_key', 'runtime_version', 'paused_at')
order by column_name;

-- Expected: 1 row — automation_enrollments_trigger_event_unique_idx (unique, partial).
select indexname, indexdef
from pg_indexes
where schemaname = 'public' and indexname = 'automation_enrollments_trigger_event_unique_idx';

-- Expected: 8 rows — the core worker RPCs.
select routine_name
from information_schema.routines
where routine_schema = 'public'
  and routine_name in (
    'realtoros_claim_trigger_events', 'realtoros_claim_due_jobs', 'realtoros_enroll_contact',
    'realtoros_complete_job_and_advance', 'realtoros_reschedule_job', 'realtoros_stop_enrollment',
    'realtoros_retry_failed_job', 'realtoros_recover_stale_automation_leases'
  )
order by routine_name;

-- Expected: 2 rows — the SECURITY DEFINER trigger functions that write the
-- outbox on behalf of a user who has no grant on automation_trigger_events.
select routine_name, security_type
from information_schema.routines
where routine_schema = 'automation_internal'
  and routine_name in ('contact_created_event', 'contact_status_changed_event')
order by routine_name;


-- ============================================================================
-- 4. PHASE 4D RELIABILITY — 20260904021416
-- ============================================================================

-- Expected: exactly 13 accepted statuses, including 'unconfirmed':
--   queued, sent, delivery_delayed, delivered, opened, clicked, replied,
--   bounced, complained, suppressed, failed, unsubscribed, unconfirmed
-- Losing any of these would make a legitimate Resend webhook fail the check.
select pg_get_constraintdef(oid) as outbound_status_constraint
from pg_constraint
where conname = 'outbound_messages_status_check'
  and conrelid = 'public.outbound_messages'::regclass;

-- Expected: true. Evaluates the LIVE constraint against every status the
-- resend-webhook handler can write, rather than trusting the text above.
-- The migration runs this same check at apply time and aborts if it fails;
-- this repeats it against the deployed database.
do $$
declare
  v_expr text;
  v_ok boolean;
  v_status text;
  v_required constant text[] := array[
    'queued', 'sent', 'delivery_delayed', 'delivered', 'opened', 'clicked',
    'replied', 'bounced', 'complained', 'suppressed', 'unsubscribed', 'failed',
    'unconfirmed'
  ];
begin
  select pg_get_expr(c.conbin, c.conrelid) into v_expr
  from pg_constraint c
  where c.conrelid = 'public.outbound_messages'::regclass
    and c.conname = 'outbound_messages_status_check';
  if v_expr is null then
    raise exception 'VERIFY FAILED: outbound_messages_status_check is missing';
  end if;
  foreach v_status in array v_required loop
    execute 'select (' || v_expr || ') from (select $1::text as status) as t'
      into v_ok using v_status;
    if v_ok is not true then
      raise exception 'VERIFY FAILED: constraint rejects required status %', v_status;
    end if;
  end loop;
  raise notice 'VERIFY OK: all 13 outbound_messages statuses are accepted';
end
$$;

-- Expected: 2 rows —
--   automation_jobs.manual_retry_count
--   outbound_messages.first_provider_attempt_at
select table_name, column_name, column_default
from information_schema.columns
where table_schema = 'public'
  and (table_name, column_name) in (
    ('automation_jobs', 'manual_retry_count'),
    ('outbound_messages', 'first_provider_attempt_at')
  )
order by table_name;

-- Expected: 5 rows — the RPCs this migration introduces.
select routine_name
from information_schema.routines
where routine_schema = 'public'
  and routine_name in (
    'realtoros_complete_trigger_event', 'realtoros_reschedule_trigger_event',
    'realtoros_fail_trigger_event', 'realtoros_cancel_claimed_job', 'realtoros_archive_rule'
  )
order by routine_name;

-- Expected: max_attempts is constrained BETWEEN 1 AND 20. The manual-retry
-- ceiling in realtoros_retry_failed_job depends on this bound.
select pg_get_constraintdef(oid) as max_attempts_constraint
from pg_constraint
where conrelid = 'public.automation_jobs'::regclass
  and pg_get_constraintdef(oid) like '%max_attempts%';


-- ============================================================================
-- 5. PHASE 4E STOP LOGIC — 20260904060217
-- ============================================================================

-- Expected: 2 rows, both timestamptz, both DEFAULT NULL (column_default null).
select column_name, data_type, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'contacts'
  and column_name in ('reply_detected_at', 'unsubscribe_detected_at')
order by column_name;

-- Expected: 2 rows — cancelled_at (timestamptz), cancelled_reason (text),
-- both DEFAULT NULL.
select column_name, data_type, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'automation_jobs'
  and column_name in ('cancelled_at', 'cancelled_reason')
order by column_name;

-- Expected: 1 row — contacts_lifecycle_stop_idx, a PARTIAL index
-- (WHERE reply_detected_at IS NOT NULL OR unsubscribe_detected_at IS NOT NULL).
select indexname, indexdef
from pg_indexes
where schemaname = 'public' and indexname = 'contacts_lifecycle_stop_idx';

-- Expected: 6 rows —
--   realtoros_check_enrollment_eligibility
--   realtoros_open_enrollments_for_contact
--   realtoros_record_contact_stop_event
--   realtoros_rule_stop_summary
--   realtoros_stop_enrollment            (Phase 4D, matched by the LIKE)
--   realtoros_stop_enrollment_on_event
select routine_name, security_type
from information_schema.routines
where routine_schema = 'public'
  and (routine_name like '%stop%' or routine_name like '%eligibility%')
order by routine_name;

-- Expected: 2 rows — INSERT and UPDATE, both BEFORE.
-- This trigger is what prevents the browser writing the two new contacts
-- columns. public.contacts carries a TABLE-level UPDATE grant to
-- authenticated, and PostgreSQL cannot subtract a column-level revoke from a
-- table-level grant, so a trigger is the enforcement point.
select trigger_name, event_manipulation, action_timing
from information_schema.triggers
where event_object_schema = 'public'
  and event_object_table = 'contacts'
  and trigger_name = 'contacts_protect_lifecycle_columns_trigger'
order by event_manipulation;

-- Expected: 1 row, security_type = 'INVOKER'.
-- It MUST be INVOKER: as DEFINER, current_user would be the function owner
-- rather than the caller's PostgREST role, and the browser-role check would
-- never fire.
select routine_name, security_type
from information_schema.routines
where routine_schema = 'automation_internal'
  and routine_name = 'protect_contact_lifecycle_columns';


-- ============================================================================
-- 6. CROSS-CUTTING SANITY
-- ============================================================================

-- Expected: 19 rows — every realtoros_* RPC across Phases 4C/4D/4E.
select routine_name, security_type
from information_schema.routines
where routine_schema = 'public' and routine_name like 'realtoros_%'
order by routine_name;

-- Expected: 0 rows. Every realtoros_* function is SECURITY INVOKER by design.
select routine_name, security_type
from information_schema.routines
where routine_schema = 'public'
  and routine_name like 'realtoros_%'
  and security_type <> 'INVOKER';

-- Expected: every realtoros_* function pins an empty search_path.
-- Any row returned here is a function missing that hardening.
select p.proname, p.proconfig
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname like 'realtoros_%'
  and (p.proconfig is null or not (p.proconfig @> array['search_path=']))
order by p.proname;

-- Expected: all zero. Nothing should have been sent, enrolled or triggered
-- by the migrations themselves.
select
  (select count(*) from public.outbound_messages)        as outbound_messages,
  (select count(*) from public.automation_enrollments)   as enrollments,
  (select count(*) from public.automation_jobs)          as jobs,
  (select count(*) from public.email_suppressions)       as suppressions,
  (select count(*) from public.webhook_events)           as webhook_events;

-- Expected: 0 active rules. Migrations never activate anything.
select status, count(*) from public.automation_rules group by status order by status;

-- NOTE: automation_trigger_events may legitimately be NON-zero after the
-- Phase 4D migration, because the contacts triggers begin recording every
-- insert and status change from that moment on. Those rows are harmless while
-- no rule is active — the worker matches them against zero active rules and
-- completes them. Expected status here is 'pending' (before the worker runs)
-- or 'completed' (after).
select status, count(*) from public.automation_trigger_events group by status order by status;
