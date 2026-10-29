-- Phase 4D correction: automation execution reliability.
-- Additive only. Does not modify the already-committed
-- 20260902092814_phase_4d_automation_execution.sql migration. Every
-- function here is created with `create or replace function` using the
-- SAME name (and, where unchanged, the same parameter signature) as its
-- Phase 4D counterpart, which is the standard, safe way to correct an
-- already-committed function without touching the migration that first
-- defined it. New functions/columns are clearly marked as new below.
--
-- This migration does not activate any rule, enroll any contact, or send
-- any email.

-- ============================================================
-- 1. SCHEMA ADDITIONS
-- ============================================================

-- A strict, bounded ceiling on MANUAL retries, independent of (and on top
-- of) the automatic attempts/max_attempts ceiling — see
-- realtoros_retry_failed_job below.
alter table public.automation_jobs
  add column manual_retry_count integer not null default 0 check (manual_retry_count >= 0);

comment on column public.automation_jobs.manual_retry_count is
  'How many times a human has used Retry on this job via manage-automation. Capped at 1 in realtoros_retry_failed_job — a strict, bounded ceiling separate from the automatic attempts/max_attempts retry budget.';

-- Persists the time of the FIRST provider attempt for an automation email
-- job, so a later ambiguous-outcome retry can be judged against a
-- conservative safety window well inside Resend's 24-hour idempotency-key
-- retention, without ever needing a second idempotency key for the same
-- job. Never overwritten after the first attempt.
alter table public.outbound_messages
  add column first_provider_attempt_at timestamptz;

comment on column public.outbound_messages.first_provider_attempt_at is
  'Set once, at the first provider attempt for this message, and never overwritten. Used to enforce a conservative cutoff (well under Resend''s 24-hour idempotency-key retention) beyond which the same job must never be retried against the provider again.';

-- 'unconfirmed': a definitively unresolved delivery outcome — the safe
-- idempotency retry window closed before a confirmed sent/failed result
-- was ever obtained. Never resent, never claimed as delivered; flagged
-- for manual review via automation_failures instead.
-- The constraint is rebuilt as the COMPLETE Phase 4C status set plus the
-- single new 'unconfirmed' value. Every status resend-webhook can write
-- (its EVENT_MAP targets and its STATUS_PRIORITY ladder, including
-- 'delivery_delayed', 'complained', 'suppressed' and 'unsubscribed') must
-- stay accepted -- dropping any of them would make a legitimate provider
-- webhook fail this check constraint and lose a real delivery signal.
alter table public.outbound_messages drop constraint outbound_messages_status_check;
alter table public.outbound_messages add constraint outbound_messages_status_check
  check (status in (
    'queued', 'sent', 'delivery_delayed', 'delivered', 'opened', 'clicked',
    'replied', 'bounced', 'complained', 'suppressed', 'failed', 'unsubscribed',
    'unconfirmed'
  ));

-- Verification: evaluate the constraint's OWN expression (not a second copy
-- of the list) against every status resend-webhook's STATUS_PRIORITY and
-- EVENT_MAP can produce, plus 'unconfirmed'. If any one were rejected this
-- migration raises and is never committed, so the webhook and the database
-- can never silently drift apart.
do $verify_outbound_statuses$
declare
  v_expr text;
  v_ok boolean;
  v_status text;
  v_required constant text[] := array[
    -- every key of resend-webhook STATUS_PRIORITY (a superset of every
    -- EVENT_MAP target status)
    'queued', 'sent', 'delivery_delayed', 'delivered', 'opened', 'clicked',
    'replied', 'bounced', 'complained', 'suppressed', 'unsubscribed', 'failed',
    -- plus the one status this migration introduces
    'unconfirmed'
  ];
begin
  select pg_get_expr(c.conbin, c.conrelid) into v_expr
    from pg_constraint c
    where c.conrelid = 'public.outbound_messages'::regclass
      and c.conname = 'outbound_messages_status_check';
  if v_expr is null then
    raise exception 'outbound_messages_status_check is missing';
  end if;

  foreach v_status in array v_required loop
    execute 'select (' || v_expr || ') from (select $1::text as status) as t'
      into v_ok using v_status;
    if v_ok is not true then
      raise exception 'outbound_messages_status_check rejects required status %', v_status;
    end if;
  end loop;
end
$verify_outbound_statuses$;

-- ============================================================
-- 2. TRIGGER-EVENT LOCK-TOKEN-PROTECTED RPCs (new)
-- ============================================================
-- The worker must never update automation_trigger_events directly after
-- claiming one (see corrected process-automation/index.ts) — only through
-- these three, each requiring the event's current lock token and current
-- status = 'processing'. A stale/mismatched token, or an event no longer
-- 'processing' (already completed/rescheduled/failed by an earlier,
-- possibly-since-superseded call), makes zero changes and returns a
-- distinguishable, non-'completed' outcome — never silently treated as
-- success by the caller.

create or replace function public.realtoros_complete_trigger_event(
  p_user_id uuid,
  p_event_id uuid,
  p_lock_token uuid
)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_event public.automation_trigger_events%rowtype;
begin
  select * into v_event from public.automation_trigger_events where id = p_event_id and user_id = p_user_id for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if v_event.status <> 'processing' then return jsonb_build_object('outcome', 'not_processing'); end if;
  if v_event.lock_token is distinct from p_lock_token then return jsonb_build_object('outcome', 'stale_lock'); end if;

  update public.automation_trigger_events
    set status = 'completed', processed_at = now(), locked_at = null, locked_by = null, lock_token = null
    where id = p_event_id;

  return jsonb_build_object('outcome', 'completed');
end;
$function$;

create or replace function public.realtoros_reschedule_trigger_event(
  p_user_id uuid,
  p_event_id uuid,
  p_lock_token uuid,
  p_available_at timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_event public.automation_trigger_events%rowtype;
begin
  if p_available_at is null then raise exception 'invalid available_at'; end if;

  select * into v_event from public.automation_trigger_events where id = p_event_id and user_id = p_user_id for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if v_event.status <> 'processing' then return jsonb_build_object('outcome', 'not_processing'); end if;
  if v_event.lock_token is distinct from p_lock_token then return jsonb_build_object('outcome', 'stale_lock'); end if;

  update public.automation_trigger_events
    set status = 'pending', available_at = p_available_at, locked_at = null, locked_by = null, lock_token = null
    where id = p_event_id;

  return jsonb_build_object('outcome', 'rescheduled');
end;
$function$;

create or replace function public.realtoros_fail_trigger_event(
  p_user_id uuid,
  p_event_id uuid,
  p_lock_token uuid,
  p_error text
)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_event public.automation_trigger_events%rowtype;
begin
  select * into v_event from public.automation_trigger_events where id = p_event_id and user_id = p_user_id for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if v_event.status <> 'processing' then return jsonb_build_object('outcome', 'not_processing'); end if;
  if v_event.lock_token is distinct from p_lock_token then return jsonb_build_object('outcome', 'stale_lock'); end if;

  update public.automation_trigger_events
    set status = 'failed', locked_at = null, locked_by = null, lock_token = null,
        last_error = left(coalesce(p_error, 'processing_failed'), 500)
    where id = p_event_id;

  return jsonb_build_object('outcome', 'failed');
end;
$function$;

-- ============================================================
-- 3. JOB CANCELLATION RPC (new) — lock-token-guarded, records the run
-- ============================================================
create or replace function public.realtoros_cancel_claimed_job(
  p_user_id uuid,
  p_job_id uuid,
  p_lock_token uuid
)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_job public.automation_jobs%rowtype;
  v_runs_updated integer;
begin
  select * into v_job from public.automation_jobs where id = p_job_id and user_id = p_user_id for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if v_job.status <> 'processing' then return jsonb_build_object('outcome', 'not_processing'); end if;
  if v_job.lock_token is distinct from p_lock_token then return jsonb_build_object('outcome', 'stale_lock'); end if;

  update public.automation_jobs
    set status = 'cancelled', locked_at = null, locked_by = null, lock_token = null
    where id = p_job_id;

  update public.automation_runs
    set status = 'cancelled', finished_at = now()
    where user_id = p_user_id and job_id = p_job_id and attempt_number = v_job.attempts and status = 'processing';

  -- Run invariant. realtoros_claim_due_jobs inserts exactly one
  -- 'processing' run per (job, attempt) in the same transaction that
  -- claims the job, and the lock-token check above already proved this
  -- caller still holds THIS attempt's claim -- so exactly one run row must
  -- have been transitioned here. Zero means the durable record of the
  -- attempt is missing; raising rolls the cancellation back rather than
  -- recording a job outcome with no corresponding run.
  get diagnostics v_runs_updated = row_count;
  if v_runs_updated <> 1 then
    raise exception 'automation_runs invariant violated: % processing run(s) for job % attempt %',
      v_runs_updated, p_job_id, v_job.attempts;
  end if;

  return jsonb_build_object('outcome', 'cancelled');
end;
$function$;

-- ============================================================
-- 4. ATOMIC ARCHIVE RPC (new) — replaces manage-automation's inline,
--    multi-request archive sequence with one transaction.
-- ============================================================
-- A job already claimed ('processing') before archive is never touched
-- here — it is left for the worker to finish or fail on its own.
-- realtoros_complete_job_and_advance and realtoros_reschedule_job both
-- re-check the OWNING ENROLLMENT's status before ever scheduling a next
-- step, and this function sets every open enrollment to 'stopped' inside
-- this same transaction, so a step can never be scheduled again after an
-- enrollment has been archived-stopped — the enrollment row's lock
-- (`for update` inside those other functions) is what makes this
-- ordering safe even for a job that is mid-flight exactly as archive runs.
create or replace function public.realtoros_archive_rule(
  p_user_id uuid,
  p_rule_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_rule public.automation_rules%rowtype;
  v_enrollment_ids uuid[];
begin
  select * into v_rule from public.automation_rules where id = p_rule_id and user_id = p_user_id for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if v_rule.status not in ('active', 'paused') then return jsonb_build_object('outcome', 'invalid_transition'); end if;

  update public.automation_rules
    set status = 'archived', archived_at = now()
    where id = p_rule_id and user_id = p_user_id;

  select array_agg(id) into v_enrollment_ids
    from public.automation_enrollments
    where user_id = p_user_id and rule_id = p_rule_id and status in ('active', 'paused');

  if v_enrollment_ids is not null then
    update public.automation_jobs
      set status = 'cancelled'
      where user_id = p_user_id and enrollment_id = any(v_enrollment_ids) and status = 'pending';

    update public.automation_enrollments
      set status = 'stopped', stopped_at = now(), stop_reason = 'rule_archived', next_action_at = null
      where user_id = p_user_id and id = any(v_enrollment_ids);
  end if;

  return jsonb_build_object('outcome', 'archived');
end;
$function$;

-- ============================================================
-- 5. CLAIM QUERIES — never claim a row already at max_attempts
-- ============================================================
create or replace function public.realtoros_claim_trigger_events(p_batch_size integer)
returns setof public.automation_trigger_events
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_ids uuid[];
begin
  if p_batch_size is null or p_batch_size <= 0 or p_batch_size > 100 then
    raise exception 'invalid batch size';
  end if;

  select array_agg(t.id) into v_ids from (
    select id from public.automation_trigger_events
    where status = 'pending' and available_at <= now() and attempts < max_attempts
    order by available_at, id
    limit p_batch_size
    for update skip locked
  ) t;

  if v_ids is null then
    return;
  end if;

  return query
    update public.automation_trigger_events
    set status = 'processing', locked_at = now(), locked_by = 'process-automation',
        lock_token = gen_random_uuid(), attempts = attempts + 1
    where id = any(v_ids)
    returning *;
end;
$function$;

-- Also inserts exactly one 'processing' automation_runs row per claimed
-- job, keyed by (user_id, job_id, attempt_number) — the durable,
-- unambiguous record of this specific attempt (see section 1 of the
-- original migration for the underlying unique constraint).
create or replace function public.realtoros_claim_due_jobs(p_batch_size integer)
returns setof public.automation_jobs
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_ids uuid[];
begin
  if p_batch_size is null or p_batch_size <= 0 or p_batch_size > 100 then
    raise exception 'invalid batch size';
  end if;

  select array_agg(j.id) into v_ids from (
    select aj.id
    from public.automation_jobs aj
    join public.automation_rules ar on ar.id = aj.rule_id and ar.user_id = aj.user_id
    join public.automation_enrollments ae on ae.id = aj.enrollment_id and ae.user_id = aj.user_id
    where aj.status = 'pending'
      and aj.scheduled_at <= now()
      and aj.attempts < aj.max_attempts
      and ar.status = 'active'
      and ae.status = 'active'
    order by aj.scheduled_at, aj.id
    limit p_batch_size
    for update of aj skip locked
  ) j;

  if v_ids is null then
    return;
  end if;

  return query
  with updated as (
    update public.automation_jobs
    set status = 'processing', locked_at = now(), locked_by = 'process-automation',
        lock_token = gen_random_uuid(), attempts = attempts + 1, started_at = now()
    where id = any(v_ids)
    returning *
  ),
  ins as (
    insert into public.automation_runs (user_id, job_id, enrollment_id, attempt_number, status, started_at)
    select user_id, id, enrollment_id, attempts, 'processing', now() from updated
    returning job_id
  )
  -- Exactly one row per claimed job. The run insert returns its own
  -- job_id, so this is a strict one-to-one join. The previous
  -- `left join ins on true` was a Cartesian product returning
  -- (claimed jobs x inserted runs) rows -- 9 rows for 3 jobs, 625 for 25.
  --
  -- There is deliberately NO `on conflict ... do nothing` here: a
  -- pre-existing run for (user_id, job_id, attempt_number) is an invariant
  -- violation, and the resulting unique_violation rolls the entire claim
  -- back. That is strictly safer than swallowing it, which would either
  -- drop the job from the result set (silently claimed, never processed,
  -- and locked until stale-lease recovery) or hand out a claimed job with
  -- no 'processing' run record at all.
  select u.* from updated u join ins on ins.job_id = u.id;
end;
$function$;

-- ============================================================
-- 6. STALE-LEASE RECOVERY — attempts-aware, terminal-fails exhausted
--    items instead of looping them forever, and keeps run/failure/
--    enrollment history coherent.
-- ============================================================
create or replace function public.realtoros_recover_stale_automation_leases(p_stale_seconds integer)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_events_recovered integer := 0;
  v_events_failed integer := 0;
  v_jobs_recovered integer := 0;
  v_jobs_failed integer := 0;
  v_job record;
begin
  if p_stale_seconds is null or p_stale_seconds <= 0 then
    raise exception 'invalid stale window';
  end if;

  -- Trigger events: recoverable (attempts < max_attempts) -> pending;
  -- exhausted -> terminally failed, never looped forever.
  with recovered as (
    update public.automation_trigger_events
    set status = 'pending', locked_at = null, locked_by = null, lock_token = null
    where status = 'processing' and locked_at < now() - make_interval(secs => p_stale_seconds)
      and attempts < max_attempts
    returning id
  )
  select count(*) into v_events_recovered from recovered;

  with failed as (
    update public.automation_trigger_events
    set status = 'failed', locked_at = null, locked_by = null, lock_token = null,
        last_error = 'stale_lease_max_attempts_exhausted'
    where status = 'processing' and locked_at < now() - make_interval(secs => p_stale_seconds)
      and attempts >= max_attempts
    returning id
  )
  select count(*) into v_events_failed from failed;

  -- Jobs, recoverable: back to pending; the abandoned in-flight attempt's
  -- own run row is marked failed (it really didn't finish), while the job
  -- itself becomes eligible for a fresh attempt (a new run row is created
  -- at the next claim).
  with stale_recoverable as (
    select id from public.automation_jobs
    where status = 'processing' and locked_at < now() - make_interval(secs => p_stale_seconds)
      and attempts < max_attempts
    for update skip locked
  ),
  recovered as (
    update public.automation_jobs j
    set status = 'pending', locked_at = null, locked_by = null, lock_token = null
    from stale_recoverable sr where j.id = sr.id
    returning j.id, j.user_id, j.attempts
  ),
  runs_failed as (
    update public.automation_runs r
    set status = 'failed', finished_at = now(), error_message = 'stale_lease_recovered'
    from recovered where r.user_id = recovered.user_id and r.job_id = recovered.id
      and r.attempt_number = recovered.attempts and r.status = 'processing'
    returning 1
  )
  -- `runs_failed` is a data-modifying CTE, so PostgreSQL executes it
  -- exactly once and to completion whether or not the primary query reads
  -- its output. Counting `recovered` on its own is therefore both correct
  -- and exact; the previous `left join runs_failed on true` multiplied the
  -- recovered-job count by the number of updated run rows.
  select count(*) into v_jobs_recovered from recovered;

  -- Jobs, exhausted (attempts already at max_attempts): terminal failure,
  -- durable failure history, and the owning enrollment moved to a
  -- coherent terminal state (never left stranded active with no pending
  -- or processing job) — the same model as realtoros_reschedule_job's
  -- failed_final branch.
  for v_job in
    select id, user_id, enrollment_id, attempts
    from public.automation_jobs
    where status = 'processing' and locked_at < now() - make_interval(secs => p_stale_seconds)
      and attempts >= max_attempts
    for update skip locked
  loop
    update public.automation_jobs
      set status = 'failed', completed_at = now(), locked_at = null, locked_by = null, lock_token = null,
          last_error = 'stale_lease_max_attempts_exhausted', failure_category = 'unknown', retriable = false
      where id = v_job.id;

    update public.automation_runs
      set status = 'failed', finished_at = now(), error_message = 'stale_lease_max_attempts_exhausted'
      where user_id = v_job.user_id and job_id = v_job.id and attempt_number = v_job.attempts and status = 'processing';

    insert into public.automation_failures (user_id, job_id, category, error_code, error_message, retriable)
    values (v_job.user_id, v_job.id, 'unknown', 'stale_lease_exhausted',
      'The worker lease expired after the maximum number of attempts.', false);

    update public.automation_enrollments
      set status = 'failed', stopped_at = now(), stop_reason = 'job_attempts_exhausted', next_action_at = null
      where id = v_job.enrollment_id and user_id = v_job.user_id and status in ('active', 'paused');

    update public.automation_jobs
      set status = 'cancelled'
      where enrollment_id = v_job.enrollment_id and user_id = v_job.user_id and status = 'pending';

    v_jobs_failed := v_jobs_failed + 1;
  end loop;

  return jsonb_build_object(
    'recovered_events', v_events_recovered, 'failed_events', v_events_failed,
    'recovered_jobs', v_jobs_recovered, 'failed_jobs', v_jobs_failed
  );
end;
$function$;

-- ============================================================
-- 7. DST-SAFE DAILY ENROLLMENT LIMIT
-- ============================================================
-- Only the day-boundary arithmetic changes from the original function:
-- the next local-day boundary is now derived by adding one calendar day
-- to today's LOCAL wall-clock midnight and converting that back to a
-- timestamptz, never by adding a fixed 24-hour interval to a timestamptz
-- (which is wrong on a DST-transition day, when the local day is 23 or
-- 25 hours long).
create or replace function public.realtoros_enroll_contact(
  p_user_id uuid,
  p_rule_id uuid,
  p_contact_id text,
  p_trigger_event_id uuid,
  p_trigger_event_key text
)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_rule public.automation_rules%rowtype;
  v_steps jsonb;
  v_first_step jsonb;
  v_enrollment_id uuid;
  v_job_id uuid;
  v_daily_count bigint;
  v_day_start timestamptz;
  v_next_day_start timestamptz;
  v_idem text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_rule_id::text, 7171));

  -- The advisory lock only serializes enrollment against OTHER enrollment
  -- calls; it means nothing to Pause, Resume or Archive, which never take
  -- it. `for update` on the rule row is what serializes this function
  -- against every rule status transition:
  --
  --   * if enrollment locks the active rule first, Pause/Archive blocks on
  --     that row lock until this transaction commits, so this enrollment
  --     (and its first job) finishes coherently against a rule that really
  --     was active at the time;
  --   * if Pause or Archive commits first, this `select ... for update`
  --     waits, then re-reads the row at its NEW committed version, sees
  --     'paused'/'archived', and returns 'ineligible' having created zero
  --     enrollment rows and zero job rows.
  --
  -- realtoros_archive_rule already takes the same `for update` on the same
  -- row, and manage-automation's Pause/Resume take the equivalent row lock
  -- via their UPDATE, so those two orderings are the only possible ones
  -- and both are safe.
  select * into v_rule from public.automation_rules
    where id = p_rule_id and user_id = p_user_id
    for update;
  if not found or v_rule.status <> 'active' or v_rule.runtime_version is null then
    return jsonb_build_object('outcome', 'ineligible', 'reason', 'rule_not_active');
  end if;

  if p_trigger_event_id is not null and exists (
    select 1 from public.automation_enrollments
    where user_id = p_user_id and rule_id = p_rule_id and trigger_event_id = p_trigger_event_id
  ) then
    return jsonb_build_object('outcome', 'duplicate');
  end if;

  if exists (
    select 1 from public.automation_enrollments
    where user_id = p_user_id and rule_id = p_rule_id and contact_id = p_contact_id
      and status in ('active', 'paused')
  ) then
    return jsonb_build_object('outcome', 'duplicate');
  end if;

  v_day_start := date_trunc('day', now() at time zone v_rule.timezone) at time zone v_rule.timezone;
  -- DST-safe: add one calendar day to the LOCAL midnight timestamp (no
  -- timezone attached yet), then convert that local midnight back to a
  -- timestamptz — never `v_day_start + interval '1 day'` on the
  -- timestamptz itself, which silently adds a fixed 24 hours and lands on
  -- the wrong wall-clock instant on a 23- or 25-hour local day.
  v_next_day_start := ((v_day_start at time zone v_rule.timezone) + interval '1 day') at time zone v_rule.timezone;

  select count(*) into v_daily_count
    from public.automation_enrollments
    where user_id = p_user_id and rule_id = p_rule_id
      and started_at >= v_day_start and started_at < v_next_day_start;
  if v_daily_count >= v_rule.daily_enrollment_limit then
    return jsonb_build_object(
      'outcome', 'rate_limited',
      'retry_after_seconds', greatest(1, ceil(extract(epoch from (v_next_day_start - now())))::integer)
    );
  end if;

  v_steps := coalesce(v_rule.runtime_snapshot -> 'steps', '[]'::jsonb);
  select s into v_first_step from jsonb_array_elements(v_steps) s
    order by (s ->> 'step_order')::integer asc limit 1;
  if v_first_step is null then
    return jsonb_build_object('outcome', 'ineligible', 'reason', 'no_steps');
  end if;

  begin
    insert into public.automation_enrollments (
      user_id, rule_id, contact_id, status, current_step_order,
      trigger_event_id, trigger_event_key, runtime_version,
      next_action_at, started_at, context
    ) values (
      p_user_id, p_rule_id, p_contact_id, 'active', 0,
      p_trigger_event_id, p_trigger_event_key, v_rule.runtime_version,
      now() + make_interval(mins => (v_first_step ->> 'delay_minutes')::integer),
      now(), '{}'::jsonb
    )
    returning id into v_enrollment_id;
  exception when unique_violation then
    return jsonb_build_object('outcome', 'duplicate');
  end;

  v_idem := v_enrollment_id::text || ':' || v_rule.runtime_version::text || ':' || (v_first_step ->> 'step_order');
  insert into public.automation_jobs (
    user_id, enrollment_id, rule_id, contact_id, job_type, status, scheduled_at, idempotency_key, payload
  ) values (
    p_user_id, v_enrollment_id, p_rule_id, p_contact_id,
    case (v_first_step ->> 'action_type')
      when 'send_email' then 'send_email'
      when 'create_task' then 'create_task'
      else 'advance_enrollment'
    end,
    'pending',
    now() + make_interval(mins => (v_first_step ->> 'delay_minutes')::integer),
    v_idem,
    v_first_step
  )
  returning id into v_job_id;

  return jsonb_build_object('outcome', 'enrolled', 'enrollment_id', v_enrollment_id, 'job_id', v_job_id);
end;
$function$;

-- ============================================================
-- 8. JOB COMPLETION — also completes this attempt's run record
-- ============================================================
create or replace function public.realtoros_complete_job_and_advance(
  p_user_id uuid,
  p_job_id uuid,
  p_lock_token uuid
)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_job public.automation_jobs%rowtype;
  v_enrollment public.automation_enrollments%rowtype;
  v_rule public.automation_rules%rowtype;
  v_steps jsonb;
  v_current_order integer;
  v_next_step jsonb;
  v_idem text;
  v_new_job_id uuid;
  v_runs_updated integer;
begin
  select * into v_job from public.automation_jobs where id = p_job_id and user_id = p_user_id for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if v_job.lock_token is distinct from p_lock_token then
    return jsonb_build_object('outcome', 'stale_lock');
  end if;
  if v_job.status = 'completed' then
    return jsonb_build_object('outcome', 'already_completed');
  end if;

  update public.automation_jobs
    set status = 'completed', completed_at = now(), locked_at = null, locked_by = null, lock_token = null
    where id = p_job_id;

  update public.automation_runs
    set status = 'completed', finished_at = now()
    where user_id = p_user_id and job_id = p_job_id and attempt_number = v_job.attempts and status = 'processing';

  -- Run invariant: never silently complete a job whose 'processing' run
  -- record is missing. The lock-token check above already proved this
  -- caller still holds THIS attempt's claim, and the claim itself inserted
  -- exactly one run for (job, attempt), so exactly one row must have moved
  -- to 'completed'. Raising rolls back the whole completion (and any
  -- enrollment advance below it), leaving the job 'processing' with its
  -- lock token intact for a later attempt or stale-lease recovery, rather
  -- than reporting success against a missing attempt record.
  get diagnostics v_runs_updated = row_count;
  if v_runs_updated <> 1 then
    raise exception 'automation_runs invariant violated: % processing run(s) for job % attempt %',
      v_runs_updated, p_job_id, v_job.attempts;
  end if;

  select * into v_enrollment from public.automation_enrollments where id = v_job.enrollment_id and user_id = p_user_id for update;
  if not found or v_enrollment.status <> 'active' then
    return jsonb_build_object('outcome', 'completed_no_advance');
  end if;

  select * into v_rule from public.automation_rules where id = v_enrollment.rule_id and user_id = p_user_id;
  v_steps := coalesce(v_rule.runtime_snapshot -> 'steps', '[]'::jsonb);
  v_current_order := coalesce((v_job.payload ->> 'step_order')::integer, v_enrollment.current_step_order);

  select s into v_next_step from jsonb_array_elements(v_steps) s
    where (s ->> 'step_order')::integer > v_current_order
    order by (s ->> 'step_order')::integer asc limit 1;

  if v_next_step is null then
    update public.automation_enrollments
      set status = 'completed', completed_at = now(), next_action_at = null, current_step_order = v_current_order
      where id = v_enrollment.id;
    return jsonb_build_object('outcome', 'enrollment_completed');
  end if;

  v_idem := v_enrollment.id::text || ':' || v_enrollment.runtime_version::text || ':' || (v_next_step ->> 'step_order');
  begin
    insert into public.automation_jobs (
      user_id, enrollment_id, rule_id, contact_id, job_type, status, scheduled_at, idempotency_key, payload
    ) values (
      p_user_id, v_enrollment.id, v_enrollment.rule_id, v_enrollment.contact_id,
      case (v_next_step ->> 'action_type')
        when 'send_email' then 'send_email'
        when 'create_task' then 'create_task'
        else 'advance_enrollment'
      end,
      'pending',
      now() + make_interval(mins => (v_next_step ->> 'delay_minutes')::integer),
      v_idem,
      v_next_step
    )
    returning id into v_new_job_id;
  exception when unique_violation then
    select id into v_new_job_id from public.automation_jobs
      where user_id = p_user_id and idempotency_key = v_idem;
  end;

  update public.automation_enrollments
    set current_step_order = v_current_order,
        next_action_at = now() + make_interval(mins => (v_next_step ->> 'delay_minutes')::integer)
    where id = v_enrollment.id;

  return jsonb_build_object('outcome', 'advanced', 'next_job_id', v_new_job_id);
end;
$function$;

-- ============================================================
-- 9. JOB RESCHEDULE/FAIL — records the run, and a terminal failure now
--    always leaves the owning enrollment in a coherent terminal state.
-- ============================================================
create or replace function public.realtoros_reschedule_job(
  p_user_id uuid,
  p_job_id uuid,
  p_lock_token uuid,
  p_next_retry_at timestamptz,
  p_error_category text,
  p_error_code text,
  p_error_message text,
  p_retriable boolean
)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_job public.automation_jobs%rowtype;
  v_final_retriable boolean;
  v_runs_updated integer;
begin
  select * into v_job from public.automation_jobs where id = p_job_id and user_id = p_user_id for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if v_job.lock_token is distinct from p_lock_token then
    return jsonb_build_object('outcome', 'stale_lock');
  end if;
  if v_job.status = 'completed' then
    return jsonb_build_object('outcome', 'already_completed');
  end if;

  -- This attempt itself always ends as failed in its own run record,
  -- whether or not the job as a whole gets another automatic attempt.
  update public.automation_runs
    set status = 'failed', finished_at = now(),
        error_code = left(coalesce(p_error_code, 'unknown'), 100),
        error_message = left(coalesce(p_error_message, 'Unknown error'), 500)
    where user_id = p_user_id and job_id = p_job_id and attempt_number = v_job.attempts and status = 'processing';

  -- Run invariant: the attempt being reported on must actually exist as a
  -- 'processing' run. The lock-token check above already proved this
  -- caller still holds THIS attempt's claim. Raising rolls the whole
  -- reschedule/fail back and leaves the job 'processing' with its lock
  -- intact (stale-lease recovery will pick it up) rather than recording a
  -- job outcome that no run record backs.
  get diagnostics v_runs_updated = row_count;
  if v_runs_updated <> 1 then
    raise exception 'automation_runs invariant violated: % processing run(s) for job % attempt %',
      v_runs_updated, p_job_id, v_job.attempts;
  end if;

  if coalesce(p_retriable, false) and v_job.attempts < v_job.max_attempts then
    update public.automation_jobs
      set status = 'pending', scheduled_at = p_next_retry_at, next_retry_at = p_next_retry_at,
          locked_at = null, locked_by = null, lock_token = null,
          last_error = p_error_message, failure_category = coalesce(p_error_category, 'unknown'), retriable = true
      where id = p_job_id;
    return jsonb_build_object('outcome', 'rescheduled');
  end if;

  -- The retriable flag on the job and on automation_failures is what the
  -- UI advertises as "manually retriable", so it must agree with whether a
  -- manual Retry can ACTUALLY still succeed. All three conditions are
  -- required, and realtoros_retry_failed_job re-checks the identical three:
  --
  --   1. the provider/operation failure is logically retriable at all;
  --   2. the bounded manual-retry ceiling is unused (manual_retry_count < 1);
  --   3. max_attempts < 20 -- automation_jobs.max_attempts is constrained to
  --      `between 1 and 20`, and a manual retry must raise it by exactly one
  --      to buy the extra attempt, so a job already at 20 could only be
  --      retried by writing 21 and violating the constraint. Advertising
  --      such a job as retriable would offer the user a Retry that can
  --      never succeed.
  v_final_retriable := coalesce(p_retriable, false)
    and v_job.manual_retry_count < 1
    and v_job.max_attempts < 20;

  update public.automation_jobs
    set status = 'failed', completed_at = now(), locked_at = null, locked_by = null, lock_token = null,
        last_error = p_error_message, failure_category = coalesce(p_error_category, 'unknown'),
        retriable = v_final_retriable
    where id = p_job_id;

  insert into public.automation_failures (user_id, job_id, category, error_code, error_message, retriable)
  values (
    p_user_id, p_job_id, coalesce(p_error_category, 'unknown'),
    left(coalesce(p_error_code, 'unknown'), 100), left(coalesce(p_error_message, 'Unknown error'), 500),
    v_final_retriable
  );

  -- A terminal job failure must never leave an active enrollment stranded
  -- with no pending or processing job: the enrollment itself becomes
  -- failed, any stray pending job for it is cancelled, and
  -- next_action_at is cleared. All history (this job, its runs, the
  -- failure just inserted) is preserved.
  update public.automation_enrollments
    set status = 'failed', stopped_at = now(),
        stop_reason = left(coalesce(p_error_code, 'job_failed'), 200), next_action_at = null
    where id = v_job.enrollment_id and user_id = p_user_id and status in ('active', 'paused');

  update public.automation_jobs
    set status = 'cancelled'
    where enrollment_id = v_job.enrollment_id and user_id = p_user_id and status = 'pending' and id <> p_job_id;

  return jsonb_build_object('outcome', 'failed_final');
end;
$function$;

-- ============================================================
-- 10. MANUAL RETRY -- bounded, lock-ordered, coherent with rule/
--     enrollment/failure state
-- ============================================================
-- One additional manual attempt is granted per job (manual_retry_count is
-- capped at 1) on top of, and independent from, the automatic
-- attempts/max_attempts budget -- max_attempts is bumped by exactly 1 in
-- the same update so the claim query's own `attempts < max_attempts` guard
-- (section 5) does not itself block this one extra, explicitly authorized
-- attempt. No history is reset or erased: attempts, prior runs and prior
-- failures all remain exactly as they were, and the superseded failure is
-- marked resolved, never deleted.
--
-- LOCK ORDER. realtoros_archive_rule locks the RULE row first and only
-- then touches that rule's enrollments and jobs. This function must use
-- the same order or the two can deadlock, and worse, a retry that locked
-- the job first could read a not-yet-archived rule and reactivate an
-- enrollment whose rule is being archived in a concurrent transaction. So:
--
--   1. determine the owning rule id with an unlocked, read-only lookup
--      (nothing is decided from it -- it is only used to find the row to
--      lock);
--   2. lock the RULE row (`for update`) -- same first lock as Archive;
--   3. re-read and lock the JOB row (`for update`);
--   4. revalidate ownership, job eligibility, the ceilings, the enrollment
--      and the rule status against those freshly locked rows;
--   5. perform the retry.
--
-- Either interleaving with Archive is then safe: if Archive commits first,
-- step 2 waits, then sees status 'archived' and returns 'not_eligible'
-- having changed nothing; if this function commits first, Archive waits on
-- the rule row, then cancels the just-made-pending job and stops the
-- just-reactivated enrollment as part of its own transaction.
create or replace function public.realtoros_retry_failed_job(
  p_user_id uuid,
  p_job_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_rule_id uuid;
  v_rule public.automation_rules%rowtype;
  v_job public.automation_jobs%rowtype;
  v_enrollment public.automation_enrollments%rowtype;
  v_new_max_attempts integer;
  v_retry_at timestamptz := now();
begin
  -- 1. Determine the owning rule WITHOUT holding any job lock. Nothing is
  --    decided from this read; it is re-validated in step 4 against the
  --    locked job row.
  select rule_id into v_rule_id
    from public.automation_jobs
    where id = p_job_id and user_id = p_user_id;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;

  -- 2. Lock the rule row FIRST -- the same lock, in the same order, that
  --    realtoros_archive_rule takes.
  select * into v_rule from public.automation_rules
    where id = v_rule_id and user_id = p_user_id
    for update;
  if not found then return jsonb_build_object('outcome', 'not_eligible'); end if;

  -- 3. Only now re-read and lock the job row.
  select * into v_job from public.automation_jobs
    where id = p_job_id and user_id = p_user_id
    for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;

  -- 4. Revalidate everything against the freshly locked rows.
  -- 4a. Ownership: the job's rule must still be the rule actually locked.
  if v_job.rule_id is distinct from v_rule.id then
    return jsonb_build_object('outcome', 'not_eligible');
  end if;
  -- 4b. The rule must still be active as of the locked read (an Archive or
  --     Pause that committed while step 2 waited is visible here).
  if v_rule.status is distinct from 'active' then
    return jsonb_build_object('outcome', 'not_eligible');
  end if;
  -- 4c. Job eligibility.
  if v_job.status <> 'failed' or not coalesce(v_job.retriable, false) then
    return jsonb_build_object('outcome', 'not_eligible');
  end if;
  -- 4d. Bounded manual-retry ceiling.
  if v_job.manual_retry_count >= 1 then
    return jsonb_build_object('outcome', 'not_eligible');
  end if;
  -- 4e. Database ceiling: automation_jobs.max_attempts is constrained to
  --     `between 1 and 20`, and this retry must raise it by exactly one.
  --     A job already at 20 can never be retried -- rejected here rather
  --     than allowed to violate the constraint.
  if v_job.max_attempts >= 20 then
    return jsonb_build_object('outcome', 'not_eligible');
  end if;
  -- 4f. The enrollment must exist and be in a state this retry may
  --     legitimately resume. 'stopped' (archived rule, opt-out,
  --     suppression) and 'completed' are never reactivated.
  select * into v_enrollment from public.automation_enrollments
    where id = v_job.enrollment_id and user_id = p_user_id
    for update;
  if not found then return jsonb_build_object('outcome', 'not_eligible'); end if;
  if v_enrollment.status not in ('active', 'failed') then
    return jsonb_build_object('outcome', 'not_eligible');
  end if;

  -- 5. Perform the retry.
  -- Guarded increment: step 4e already proved max_attempts <= 19, and
  -- `least(..., 20)` makes exceeding the database ceiling impossible even
  -- if that guard were ever weakened.
  v_new_max_attempts := least(v_job.max_attempts + 1, 20);

  update public.automation_jobs
    set status = 'pending',
        scheduled_at = v_retry_at,
        next_retry_at = null,
        -- a stale completed_at from the terminal failure would otherwise
        -- describe a job that is pending again
        completed_at = null,
        locked_at = null, locked_by = null, lock_token = null,
        manual_retry_count = manual_retry_count + 1,
        max_attempts = v_new_max_attempts
    where id = p_job_id;

  -- attempts, prior automation_runs and prior automation_failures rows are
  -- all deliberately left untouched: the history of what already happened
  -- is preserved in full. Because attempts is unchanged and max_attempts
  -- grew by exactly one, the claim query's `attempts < max_attempts` guard
  -- now permits exactly one additional claim and no more.

  -- Reactivate the enrollment if THIS job's earlier terminal failure is
  -- what stopped it, so the worker's claim query (which only claims jobs
  -- whose enrollment is 'active') can pick this job up again.
  -- next_action_at is set to the same instant the job is scheduled for, so
  -- the enrollment's advertised next action and the job's schedule agree.
  update public.automation_enrollments
    set status = 'active', stopped_at = null, stop_reason = null,
        next_action_at = v_retry_at
    where id = v_enrollment.id and user_id = p_user_id
      and status in ('active', 'failed');

  -- Resolve (never delete) the prior unresolved failure(s) for this job,
  -- so a later success never leaves a stale "active failure" behind.
  update public.automation_failures
    set resolved = true, resolved_at = now(), resolution_notes = 'Manually retried.'
    where user_id = p_user_id and job_id = p_job_id and resolved = false;

  return jsonb_build_object('outcome', 'retried');
end;
$function$;

-- ============================================================
-- 11. GRANTS — new functions, and re-asserted for every replaced one
-- ============================================================
revoke all on function public.realtoros_complete_trigger_event(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.realtoros_reschedule_trigger_event(uuid, uuid, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.realtoros_fail_trigger_event(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.realtoros_cancel_claimed_job(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.realtoros_archive_rule(uuid, uuid) from public, anon, authenticated;
revoke all on function public.realtoros_claim_trigger_events(integer) from public, anon, authenticated;
revoke all on function public.realtoros_claim_due_jobs(integer) from public, anon, authenticated;
revoke all on function public.realtoros_recover_stale_automation_leases(integer) from public, anon, authenticated;
revoke all on function public.realtoros_enroll_contact(uuid, uuid, text, uuid, text) from public, anon, authenticated;
revoke all on function public.realtoros_complete_job_and_advance(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.realtoros_reschedule_job(uuid, uuid, uuid, timestamptz, text, text, text, boolean) from public, anon, authenticated;
revoke all on function public.realtoros_retry_failed_job(uuid, uuid) from public, anon, authenticated;

grant execute on function public.realtoros_complete_trigger_event(uuid, uuid, uuid) to service_role;
grant execute on function public.realtoros_reschedule_trigger_event(uuid, uuid, uuid, timestamptz) to service_role;
grant execute on function public.realtoros_fail_trigger_event(uuid, uuid, uuid, text) to service_role;
grant execute on function public.realtoros_cancel_claimed_job(uuid, uuid, uuid) to service_role;
grant execute on function public.realtoros_archive_rule(uuid, uuid) to service_role;
grant execute on function public.realtoros_claim_trigger_events(integer) to service_role;
grant execute on function public.realtoros_claim_due_jobs(integer) to service_role;
grant execute on function public.realtoros_recover_stale_automation_leases(integer) to service_role;
grant execute on function public.realtoros_enroll_contact(uuid, uuid, text, uuid, text) to service_role;
grant execute on function public.realtoros_complete_job_and_advance(uuid, uuid, uuid) to service_role;
grant execute on function public.realtoros_reschedule_job(uuid, uuid, uuid, timestamptz, text, text, text, boolean) to service_role;
grant execute on function public.realtoros_retry_failed_job(uuid, uuid) to service_role;

comment on function public.realtoros_archive_rule is
  'service_role-only. Atomically archives an active/paused rule, stops every open enrollment, cancels their pending jobs, and preserves all history in one transaction. Never callable by anon or authenticated.';
comment on function public.realtoros_retry_failed_job is
  'service_role-only. Grants exactly one bounded additional manual attempt for an eligible failed, retriable job whose rule is still active and whose max_attempts is still under the database ceiling of 20: locks the rule row before the job row (the same order realtoros_archive_rule uses, so a retry can never reactivate an enrollment whose rule is being archived), reactivates a failed enrollment, resolves the prior failure record, and never resets attempt history. A second manual retry of the same job is always rejected. Never callable by anon or authenticated.';
