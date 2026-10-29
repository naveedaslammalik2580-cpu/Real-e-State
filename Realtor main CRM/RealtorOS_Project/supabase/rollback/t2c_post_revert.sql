-- REVERT for Phase T2c-post (the team-aware automation pipeline).
--
-- NOT a migration. Lives in supabase/rollback/ and is never applied as
-- part of the chain. Run it only to undo T2c-post.
--
-- Restores all 21 functions to resolving their rows by CREATOR instead
-- of by workspace, and removes the two not-found contracts T2c-post
-- added (stop_enrollment's existence check and enroll_contact's split
-- between "no such rule" and "rule not active").
--
-- 21, not 19: the two worker sweepers - realtoros_claim_due_jobs and
-- realtoros_recover_stale_automation_leases - joined jobs to their rule
-- and enrollment by creator and were converted alongside the 19.
--
-- GENERATED, AND THE ONE CAVEAT ABOUT FORMATTING
--
-- Every CREATE OR REPLACE below is the pg_get_functiondef() text of the
-- pre-T2c-post state, taken from the repo's migration chain replayed in
-- PGlite. It was NOT retyped.
--
-- Live held logically identical but differently formatted copies of these
-- same functions - compressed onto fewer lines and with the SQL comments
-- stripped. That was checked rather than assumed: with comments and
-- whitespace normalised away, all 19 bodies hashed identically on live
-- and in the repo chain. So this file restores the same LOGIC live had,
-- in the repo's formatting. If you later diff live against this file and
-- see whitespace or comment differences, that is expected and is not
-- drift.
--
-- WHAT RUNNING THIS MEANS
--
-- It reinstates the defect T2c-post fixed: a reply, unsubscribe,
-- complaint or bounce against a lead created by a teammate will again be
-- silently not recorded - no lifecycle marker, no suppression, no
-- enrollment stop, no notification, and a success response to the
-- caller. Only run it if T2c-post itself is causing a worse problem.
--
-- It touches no data and no table structure: functions only.

set search_path = public;

begin;

-- ---- automation_internal.notification_contact_name(p_user_id uuid, p_contact_id text)
CREATE OR REPLACE FUNCTION automation_internal.notification_contact_name(p_user_id uuid, p_contact_id text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  v_name text;
begin
  if p_contact_id is null then
    return null;
  end if;
  select full_name into v_name
  from public.contacts
  where user_id = p_user_id and id = p_contact_id;
  v_name := btrim(regexp_replace(coalesce(v_name, ''), '[[:space:][:cntrl:]]+', ' ', 'g'));
  if v_name = '' or position('@' in v_name) > 0 then
    return null;
  end if;
  return left(v_name, 80);
end;
$function$;

-- ---- public.realtoros_archive_rule(p_user_id uuid, p_rule_id uuid)
CREATE OR REPLACE FUNCTION public.realtoros_archive_rule(p_user_id uuid, p_rule_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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

-- ---- public.realtoros_cancel_claimed_job(p_user_id uuid, p_job_id uuid, p_lock_token uuid)
CREATE OR REPLACE FUNCTION public.realtoros_cancel_claimed_job(p_user_id uuid, p_job_id uuid, p_lock_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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

-- ---- public.realtoros_check_enrollment_eligibility(p_user_id uuid, p_contact_id text, p_rule_id uuid)
CREATE OR REPLACE FUNCTION public.realtoros_check_enrollment_eligibility(p_user_id uuid, p_contact_id text, p_rule_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_contact public.contacts%rowtype;
  v_rule public.automation_rules%rowtype;
  v_normalized_email text;
begin
  select * into v_contact from public.contacts
    where id = p_contact_id and user_id = p_user_id;
  if not found then
    return jsonb_build_object('eligible', false, 'block_reason', 'contact_not_found');
  end if;

  select * into v_rule from public.automation_rules
    where id = p_rule_id and user_id = p_user_id;
  if not found then
    return jsonb_build_object('eligible', false, 'block_reason', 'rule_not_found');
  end if;

  -- 1. Active suppression (bounce, complaint, provider, unsubscribe,
  --    manual) — always blocked, regardless of any rule setting.
  --    email_suppressions is keyed by normalized address, not contact id.
  v_normalized_email := lower(btrim(coalesce(v_contact.email, '')));
  if v_normalized_email <> '' and exists (
    select 1 from public.email_suppressions
    where user_id = p_user_id and normalized_email = v_normalized_email and is_active
  ) then
    return jsonb_build_object('eligible', false, 'block_reason', 'suppressed');
  end if;

  -- 2. Revoked email consent — always blocked.
  if exists (
    select 1 from public.communication_consents
    where user_id = p_user_id and contact_id = p_contact_id
      and channel = 'email' and status = 'opted_out'
  ) then
    return jsonb_build_object('eligible', false, 'block_reason', 'consent_revoked');
  end if;

  -- 3. Rule-level lifecycle stops.
  if v_contact.unsubscribe_detected_at is not null and v_rule.stop_on_unsubscribe then
    return jsonb_build_object('eligible', false, 'block_reason', 'contact_unsubscribed');
  end if;
  if v_contact.reply_detected_at is not null and v_rule.stop_on_reply then
    return jsonb_build_object('eligible', false, 'block_reason', 'contact_replied');
  end if;

  -- 4. Duplicate prevention: one open enrollment per (rule, contact).
  if exists (
    select 1 from public.automation_enrollments
    where user_id = p_user_id and rule_id = p_rule_id and contact_id = p_contact_id
      and status in ('active', 'paused')
  ) then
    return jsonb_build_object('eligible', false, 'block_reason', 'duplicate_enrollment');
  end if;

  return jsonb_build_object('eligible', true, 'block_reason', null);
end;
$function$;

-- ---- public.realtoros_claim_due_jobs(p_batch_size integer)
CREATE OR REPLACE FUNCTION public.realtoros_claim_due_jobs(p_batch_size integer)
 RETURNS SETOF automation_jobs
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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

-- ---- public.realtoros_claim_test_send(p_user_id uuid, p_idempotency_key uuid, p_template_id uuid, p_recipient text, p_subject text, p_body_snapshot text, p_sender_display_name text, p_sender_address text, p_reply_to_email text, p_short_window_seconds integer, p_short_window_max integer, p_daily_window_seconds integer, p_daily_window_max integer, p_lease_seconds integer)
CREATE OR REPLACE FUNCTION public.realtoros_claim_test_send(p_user_id uuid, p_idempotency_key uuid, p_template_id uuid, p_recipient text, p_subject text, p_body_snapshot text, p_sender_display_name text, p_sender_address text, p_reply_to_email text, p_short_window_seconds integer, p_short_window_max integer, p_daily_window_seconds integer, p_daily_window_max integer, p_lease_seconds integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_existing public.outbound_messages%rowtype;
  v_new public.outbound_messages%rowtype;
  v_short_count bigint;
  v_daily_count bigint;
  v_oldest_short timestamptz;
  v_oldest_daily timestamptz;
  v_lease_expired boolean;
begin
  if p_short_window_seconds is null or p_short_window_seconds <= 0
    or p_daily_window_seconds is null or p_daily_window_seconds <= 0
    or p_lease_seconds is null or p_lease_seconds <= 0
    or p_short_window_max is null or p_short_window_max <= 0
    or p_daily_window_max is null or p_daily_window_max <= 0
  then
    raise exception 'invalid rate-limit/lease parameters';
  end if;

  -- Serialized per-user only — other users proceed fully in parallel.
  -- Released automatically at transaction end.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 4242));

  select * into v_existing
    from public.outbound_messages
    where user_id = p_user_id and idempotency_key = p_idempotency_key;

  if found then
    if v_existing.status = 'queued' then
      v_lease_expired := v_existing.send_attempt_started_at is null
        or v_existing.send_attempt_started_at < (now() - make_interval(secs => p_lease_seconds));
      if v_lease_expired then
        update public.outbound_messages
          set send_attempt_token = gen_random_uuid(),
              send_attempt_started_at = now(),
              send_attempt_count = send_attempt_count + 1
          where id = v_existing.id
          returning * into v_new;
        return jsonb_build_object(
          'outcome', 'retry_claimed',
          'message_id', v_new.id,
          'send_attempt_token', v_new.send_attempt_token,
          'send_attempt_count', v_new.send_attempt_count
        );
      else
        return jsonb_build_object(
          'outcome', 'in_progress',
          'retry_after_seconds',
          greatest(1, p_lease_seconds - floor(extract(epoch from (now() - v_existing.send_attempt_started_at)))::integer)
        );
      end if;
    else
      return jsonb_build_object('outcome', 'existing', 'message_id', v_existing.id);
    end if;
  end if;

  select count(*), min(created_at) into v_short_count, v_oldest_short
    from public.outbound_messages
    where user_id = p_user_id and message_kind = 'test'
      and created_at >= now() - make_interval(secs => p_short_window_seconds);
  if v_short_count >= p_short_window_max then
    return jsonb_build_object(
      'outcome', 'rate_limited',
      'retry_after_seconds',
      greatest(1, ceil(extract(epoch from (v_oldest_short + make_interval(secs => p_short_window_seconds) - now())))::integer)
    );
  end if;

  select count(*), min(created_at) into v_daily_count, v_oldest_daily
    from public.outbound_messages
    where user_id = p_user_id and message_kind = 'test'
      and created_at >= now() - make_interval(secs => p_daily_window_seconds);
  if v_daily_count >= p_daily_window_max then
    return jsonb_build_object(
      'outcome', 'rate_limited',
      'retry_after_seconds',
      greatest(1, ceil(extract(epoch from (v_oldest_daily + make_interval(secs => p_daily_window_seconds) - now())))::integer)
    );
  end if;

  insert into public.outbound_messages (
    user_id, contact_id, template_id, message_kind, idempotency_key,
    channel, provider, recipient, subject, body_snapshot,
    sender_display_name, sender_address, reply_to_email,
    status, queued_at, send_attempt_token, send_attempt_started_at, send_attempt_count
  ) values (
    p_user_id, null, p_template_id, 'test', p_idempotency_key,
    'email', 'resend', p_recipient, p_subject, p_body_snapshot,
    p_sender_display_name, p_sender_address, p_reply_to_email,
    'queued', now(), gen_random_uuid(), now(), 1
  )
  returning * into v_new;

  return jsonb_build_object(
    'outcome', 'created',
    'message_id', v_new.id,
    'send_attempt_token', v_new.send_attempt_token,
    'send_attempt_count', v_new.send_attempt_count
  );
exception
  when unique_violation then
    -- Lost a race to a concurrent claim for the same key (defensive only
    -- — the advisory lock above already prevents this in practice). The
    -- winning row now exists; return it rather than erroring.
    select * into v_existing from public.outbound_messages
      where user_id = p_user_id and idempotency_key = p_idempotency_key;
    if found then
      return jsonb_build_object('outcome', 'existing', 'message_id', v_existing.id);
    end if;
    raise;
end;
$function$;

-- ---- public.realtoros_complete_job_and_advance(p_user_id uuid, p_job_id uuid, p_lock_token uuid)
CREATE OR REPLACE FUNCTION public.realtoros_complete_job_and_advance(p_user_id uuid, p_job_id uuid, p_lock_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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

-- ---- public.realtoros_complete_trigger_event(p_user_id uuid, p_event_id uuid, p_lock_token uuid)
CREATE OR REPLACE FUNCTION public.realtoros_complete_trigger_event(p_user_id uuid, p_event_id uuid, p_lock_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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

-- ---- public.realtoros_enroll_contact(p_user_id uuid, p_rule_id uuid, p_contact_id text, p_trigger_event_id uuid, p_trigger_event_key text)
CREATE OR REPLACE FUNCTION public.realtoros_enroll_contact(p_user_id uuid, p_rule_id uuid, p_contact_id text, p_trigger_event_id uuid, p_trigger_event_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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

-- ---- public.realtoros_fail_trigger_event(p_user_id uuid, p_event_id uuid, p_lock_token uuid, p_error text)
CREATE OR REPLACE FUNCTION public.realtoros_fail_trigger_event(p_user_id uuid, p_event_id uuid, p_lock_token uuid, p_error text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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

-- ---- public.realtoros_open_enrollments_for_contact(p_user_id uuid, p_contact_id text)
CREATE OR REPLACE FUNCTION public.realtoros_open_enrollments_for_contact(p_user_id uuid, p_contact_id text)
 RETURNS TABLE(enrollment_id uuid, rule_id uuid, status text, stop_on_reply boolean, stop_on_unsubscribe boolean)
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  select e.id, e.rule_id, e.status, r.stop_on_reply, r.stop_on_unsubscribe
  from public.automation_enrollments e
  join public.automation_rules r on r.id = e.rule_id and r.user_id = e.user_id
  where e.user_id = p_user_id
    and e.contact_id = p_contact_id
    and e.status in ('active', 'paused')
  order by e.started_at, e.id;
$function$;

-- ---- public.realtoros_presend_guard(p_user_id uuid, p_job_id uuid, p_lock_token uuid)
CREATE OR REPLACE FUNCTION public.realtoros_presend_guard(p_user_id uuid, p_job_id uuid, p_lock_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  v_job public.automation_jobs%rowtype;
  v_enrollment public.automation_enrollments%rowtype;
  v_rule public.automation_rules%rowtype;
  v_contact public.contacts%rowtype;
  v_normalized text;
  v_is_email boolean;
begin
  select * into v_job from public.automation_jobs where id = p_job_id and user_id = p_user_id;
  if not found then
    return jsonb_build_object('blocked', true, 'action', 'abort', 'reason', 'job_not_found');
  end if;
  if v_job.status <> 'processing' or v_job.lock_token is distinct from p_lock_token then
    return jsonb_build_object('blocked', true, 'action', 'abort', 'reason', 'lock_lost');
  end if;

  select * into v_enrollment from public.automation_enrollments
    where id = v_job.enrollment_id and user_id = p_user_id;
  if not found or v_enrollment.status <> 'active' then
    return jsonb_build_object('blocked', true, 'action', 'cancel', 'reason', 'enrollment_inactive');
  end if;

  select * into v_contact from public.contacts where id = v_job.contact_id and user_id = p_user_id;
  if not found then
    return jsonb_build_object('blocked', true, 'action', 'cancel', 'reason', 'contact_not_found');
  end if;

  select * into v_rule from public.automation_rules where id = v_job.rule_id and user_id = p_user_id;
  if not found then
    return jsonb_build_object('blocked', true, 'action', 'cancel', 'reason', 'rule_not_found');
  end if;

  -- Lifecycle stops that end the whole sequence (every job type).
  if v_contact.reply_detected_at is not null and v_rule.stop_on_reply then
    return jsonb_build_object('blocked', true, 'action', 'stop', 'reason', 'contact_replied', 'stop_reason', 'reply');
  end if;
  if v_contact.unsubscribe_detected_at is not null and v_rule.stop_on_unsubscribe then
    return jsonb_build_object('blocked', true, 'action', 'stop', 'reason', 'contact_unsubscribed', 'stop_reason', 'unsubscribe');
  end if;

  v_is_email := v_job.job_type = 'send_email';
  if not v_is_email then
    return jsonb_build_object('blocked', false, 'action', 'none', 'reason', null);
  end if;

  -- Email-only blocks. These never stop the sequence by themselves: the
  -- email step is skipped and any later non-email step still runs.
  v_normalized := lower(btrim(coalesce(v_contact.email, '')));
  if v_normalized <> '' and exists (
    select 1 from public.email_suppressions
    where user_id = p_user_id and normalized_email = v_normalized and is_active
  ) then
    return jsonb_build_object('blocked', true, 'action', 'skip', 'reason', 'suppressed');
  end if;
  if exists (
    select 1 from public.communication_consents
    where user_id = p_user_id and contact_id = v_job.contact_id and channel = 'email' and status = 'opted_out'
  ) then
    return jsonb_build_object('blocked', true, 'action', 'skip', 'reason', 'consent_revoked');
  end if;
  if v_contact.unsubscribe_detected_at is not null then
    return jsonb_build_object('blocked', true, 'action', 'skip', 'reason', 'contact_unsubscribed');
  end if;

  return jsonb_build_object('blocked', false, 'action', 'none', 'reason', null);
end;
$function$;

-- ---- public.realtoros_record_contact_stop_event(p_user_id uuid, p_contact_id text, p_event_type text, p_source text, p_event_ref text, p_outbound_message_id uuid, p_occurred_at timestamp with time zone)
CREATE OR REPLACE FUNCTION public.realtoros_record_contact_stop_event(p_user_id uuid, p_contact_id text, p_event_type text, p_source text, p_event_ref text, p_outbound_message_id uuid DEFAULT NULL::uuid, p_occurred_at timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
 SET lock_timeout TO '3s'
AS $function$
declare
  v_at timestamptz := coalesce(p_occurred_at, now());
  v_contact public.contacts%rowtype;
  v_prior jsonb;
  v_recipient text;
  v_normalized text;
  v_first_occurrence boolean := false;
  v_consent_revoked boolean := false;
  v_suppression_reason text;
  v_suppression_added boolean := false;
  v_rows integer;
  v_row record;
  v_stop jsonb;
  v_stop_reason text;
  v_stopped integer := 0;
  v_jobs_cancelled integer := 0;
  v_continuing integer := 0;
  v_retry boolean := false;
  v_subject text;
  v_notes text;
  v_outcome_label text;
  v_result jsonb;
begin
  if p_event_type is null or p_event_type not in ('reply', 'unsubscribe', 'complaint', 'hard_bounce') then
    raise exception 'invalid contact stop event type';
  end if;
  if p_source is null or p_source not in ('provider_webhook', 'unsubscribe_link', 'inbound_email', 'owner_manual') then
    raise exception 'invalid contact stop event source';
  end if;
  -- Which source may report which event. Anything else is a caller bug.
  if not (
    (p_event_type = 'reply' and p_source in ('inbound_email', 'owner_manual', 'provider_webhook'))
    or (p_event_type = 'unsubscribe' and p_source in ('unsubscribe_link', 'owner_manual', 'provider_webhook', 'inbound_email'))
    or (p_event_type in ('complaint', 'hard_bounce') and p_source = 'provider_webhook')
  ) then
    raise exception 'invalid contact stop event source for this event type';
  end if;
  if p_event_ref is null or char_length(p_event_ref) not between 1 and 200 or p_event_ref ~ '[\x00-\x1F\x7F]' then
    raise exception 'invalid contact stop event reference';
  end if;

  begin
    select * into v_contact from public.contacts
      where id = p_contact_id and user_id = p_user_id
      for update;
  exception when lock_not_available then
    return jsonb_build_object('outcome', 'retry', 'recorded', false);
  end;
  if not found then
    return jsonb_build_object('outcome', 'contact_not_found', 'recorded', false);
  end if;

  -- Checked under the contact lock, so two concurrent deliveries of the
  -- same event cannot both get past it.
  select result into v_prior from public.contact_stop_events
    where user_id = p_user_id and source = p_source and event_ref = p_event_ref;
  if found then
    return v_prior || jsonb_build_object('outcome', 'duplicate');
  end if;

  if p_outbound_message_id is not null then
    select recipient into v_recipient from public.outbound_messages
      where id = p_outbound_message_id and user_id = p_user_id and contact_id = p_contact_id;
    if not found then
      return jsonb_build_object('outcome', 'message_mismatch', 'recorded', false);
    end if;
  end if;

  -- ---- lifecycle marker (earliest occurrence wins) ----
  if p_event_type = 'reply' then
    update public.contacts
      set reply_detected_at = v_at
      where id = p_contact_id and user_id = p_user_id
        and (reply_detected_at is null or reply_detected_at > v_at);
    get diagnostics v_rows = row_count;
    v_first_occurrence := v_contact.reply_detected_at is null and v_rows = 1;
  elsif p_event_type in ('unsubscribe', 'complaint') then
    update public.contacts
      set unsubscribe_detected_at = v_at
      where id = p_contact_id and user_id = p_user_id
        and (unsubscribe_detected_at is null or unsubscribe_detected_at > v_at);
    get diagnostics v_rows = row_count;
    v_first_occurrence := v_contact.unsubscribe_detected_at is null and v_rows = 1;
  end if;

  -- ---- consent (unsubscribe / complaint) ----
  if p_event_type in ('unsubscribe', 'complaint') then
    insert into public.communication_consents (
      user_id, contact_id, channel, status, source, effective_at, evidence
    ) values (
      p_user_id, p_contact_id, 'email', 'opted_out', p_source, v_at,
      jsonb_build_object(
        'event_type', p_event_type, 'source', p_source, 'event_ref', p_event_ref,
        'outbound_message_id', p_outbound_message_id, 'recorded_at', now()
      )
    )
    on conflict (user_id, contact_id, channel) do update
      set status = 'opted_out',
          source = excluded.source,
          effective_at = excluded.effective_at,
          evidence = excluded.evidence
      -- Already opted out -> change nothing, preserving the original
      -- source and effective_at.
      where communication_consents.status is distinct from 'opted_out';
    v_consent_revoked := true;
  end if;

  -- ---- suppression (unsubscribe / complaint / hard bounce) ----
  v_suppression_reason := case p_event_type
    when 'unsubscribe' then 'unsubscribe'
    when 'complaint' then 'complaint'
    when 'hard_bounce' then 'bounce'
    else null end;
  if v_suppression_reason is not null then
    -- The address that actually received the message when known (the
    -- contact's email may have been edited since), else the contact's.
    v_normalized := lower(btrim(coalesce(v_recipient, v_contact.email, '')));
    if char_length(v_normalized) between 3 and 254
       and v_normalized !~ '[\x00-\x1F\x7F]'
       and position('@' in v_normalized) > 1 then
      insert into public.email_suppressions (user_id, normalized_email, reason, source_message_id, is_active, metadata)
      values (
        p_user_id, v_normalized, v_suppression_reason, p_outbound_message_id, true,
        jsonb_build_object('source', p_source, 'event_ref', p_event_ref, 'contact_id', p_contact_id)
      )
      on conflict (user_id, normalized_email) where is_active do nothing;
      get diagnostics v_rows = row_count;
      v_suppression_added := v_rows = 1;
    end if;
  end if;

  -- ---- one plain-language activity per (event type, contact) ----
  v_subject := case p_event_type
    when 'reply' then 'Contact replied to a follow-up email'
    when 'unsubscribe' then 'Contact unsubscribed from follow-up emails'
    when 'complaint' then 'Contact reported a follow-up email as spam'
    else 'Follow-up email could not be delivered' end;
  v_outcome_label := case p_event_type
    when 'reply' then 'Replied'
    when 'unsubscribe' then 'Unsubscribed'
    when 'complaint' then 'Reported as spam'
    else 'Email blocked' end;
  v_notes := case
    when p_event_type = 'reply' and p_source = 'owner_manual' then 'You marked this contact as replied.'
    when p_event_type = 'reply' and p_source = 'inbound_email' then 'Their reply was detected automatically.'
    when p_event_type = 'reply' then 'The email service reported a reply.'
    when p_event_type = 'unsubscribe' and p_source = 'owner_manual' then 'You marked this contact as unsubscribed.'
    when p_event_type = 'unsubscribe' and p_source = 'unsubscribe_link' then 'They used the unsubscribe link in a follow-up email.'
    when p_event_type = 'unsubscribe' and p_source = 'inbound_email' then 'They replied asking to be unsubscribed.'
    when p_event_type = 'unsubscribe' then 'The email service reported that they unsubscribed.'
    when p_event_type = 'complaint' then 'Their email service reported the message as spam.'
    else 'The email address permanently rejected the message.' end
  || case
    when p_event_type = 'reply' then ' Automations set to stop when a contact replies will not continue for them.'
    when p_event_type = 'hard_bounce' then ' Email to this address is now blocked. Other automation steps, such as tasks, continue.'
    else ' Email to this contact is now blocked.' end;

  insert into public.activities (id, user_id, type, contact_id, subject, description, outcome, notes, date)
  values (
    'automation-stop-' || p_event_type || '-' || p_contact_id,
    p_user_id,
    case when p_event_type = 'reply' then 'Email' else 'Note' end,
    p_contact_id,
    v_subject,
    '',
    v_outcome_label,
    v_notes,
    v_at
  )
  on conflict (id) do nothing;

  -- ---- enrollment stops, per rule flag, in id order ----
  if p_event_type in ('reply', 'unsubscribe', 'complaint') then
    v_stop_reason := case p_event_type when 'reply' then 'reply' when 'unsubscribe' then 'unsubscribe' else 'complaint' end;
    for v_row in
      select e.id as enrollment_id, r.stop_on_reply, r.stop_on_unsubscribe
      from public.automation_enrollments e
      join public.automation_rules r on r.id = e.rule_id and r.user_id = e.user_id
      where e.user_id = p_user_id
        and e.contact_id = p_contact_id
        and e.status in ('active', 'paused')
      order by e.id
    loop
      if (p_event_type = 'reply' and v_row.stop_on_reply)
         or (p_event_type in ('unsubscribe', 'complaint') and v_row.stop_on_unsubscribe) then
        v_stop := public.realtoros_stop_enrollment_on_event(
          p_user_id, v_row.enrollment_id, v_stop_reason, p_contact_id, v_at
        );
        if v_stop ->> 'reason' = 'retry' then
          v_retry := true;
        elsif (v_stop ->> 'enrollment_stopped')::boolean then
          v_stopped := v_stopped + 1;
          v_jobs_cancelled := v_jobs_cancelled + coalesce((v_stop ->> 'jobs_cancelled')::integer, 0);
        end if;
      else
        v_continuing := v_continuing + 1;
      end if;
    end loop;
  end if;

  v_result := jsonb_build_object(
    'recorded', true,
    'event_type', p_event_type,
    'first_occurrence', v_first_occurrence,
    'consent_revoked', v_consent_revoked,
    'suppression_added', v_suppression_added,
    'enrollments_stopped', v_stopped,
    'jobs_cancelled', v_jobs_cancelled,
    'enrollments_continuing', v_continuing
  );

  if v_retry then
    return v_result || jsonb_build_object('outcome', 'retry');
  end if;

  insert into public.contact_stop_events (
    user_id, contact_id, event_type, source, event_ref, outbound_message_id, occurred_at, result
  ) values (
    p_user_id, p_contact_id, p_event_type, p_source, p_event_ref, p_outbound_message_id, v_at, v_result
  );

  return v_result || jsonb_build_object('outcome', 'recorded');
end;
$function$;

-- ---- public.realtoros_recover_stale_automation_leases(p_stale_seconds integer)
CREATE OR REPLACE FUNCTION public.realtoros_recover_stale_automation_leases(p_stale_seconds integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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

-- ---- public.realtoros_reschedule_job(p_user_id uuid, p_job_id uuid, p_lock_token uuid, p_next_retry_at timestamp with time zone, p_error_category text, p_error_code text, p_error_message text, p_retriable boolean)
CREATE OR REPLACE FUNCTION public.realtoros_reschedule_job(p_user_id uuid, p_job_id uuid, p_lock_token uuid, p_next_retry_at timestamp with time zone, p_error_category text, p_error_code text, p_error_message text, p_retriable boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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

-- ---- public.realtoros_reschedule_trigger_event(p_user_id uuid, p_event_id uuid, p_lock_token uuid, p_available_at timestamp with time zone)
CREATE OR REPLACE FUNCTION public.realtoros_reschedule_trigger_event(p_user_id uuid, p_event_id uuid, p_lock_token uuid, p_available_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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

-- ---- public.realtoros_retry_failed_job(p_user_id uuid, p_job_id uuid)
CREATE OR REPLACE FUNCTION public.realtoros_retry_failed_job(p_user_id uuid, p_job_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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

-- ---- public.realtoros_rule_stop_summary(p_user_id uuid, p_rule_id uuid, p_limit integer)
CREATE OR REPLACE FUNCTION public.realtoros_rule_stop_summary(p_user_id uuid, p_rule_id uuid, p_limit integer DEFAULT 20)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_counts jsonb;
  v_stopped jsonb;
  v_cancelled jsonb;
  v_skipped jsonb;
begin
  if not exists (
    select 1 from public.automation_rules where id = p_rule_id and user_id = p_user_id
  ) then
    return jsonb_build_object('found', false);
  end if;

  select coalesce(jsonb_object_agg(reason, n), '{}'::jsonb) into v_counts
  from (
    select coalesce(stop_reason, 'unknown') as reason, count(*) as n
    from public.automation_enrollments
    where user_id = p_user_id and rule_id = p_rule_id and status = 'stopped'
    group by 1
  ) t;

  select coalesce(jsonb_agg(row), '[]'::jsonb) into v_stopped
  from (
    select jsonb_build_object(
      'enrollment_id', e.id, 'contact_id', e.contact_id,
      'stop_reason', e.stop_reason, 'stopped_at', e.stopped_at,
      'reply_detected_at', e.reply_detected_at,
      'unsubscribe_detected_at', e.unsubscribe_detected_at
    ) as row
    from public.automation_enrollments e
    where e.user_id = p_user_id and e.rule_id = p_rule_id and e.status = 'stopped'
    order by e.stopped_at desc nulls last, e.id
    limit v_limit
  ) s;

  select coalesce(jsonb_agg(row), '[]'::jsonb) into v_cancelled
  from (
    select jsonb_build_object(
      'job_id', j.id, 'enrollment_id', j.enrollment_id, 'contact_id', j.contact_id,
      'job_type', j.job_type, 'cancelled_reason', j.cancelled_reason, 'cancelled_at', j.cancelled_at
    ) as row
    from public.automation_jobs j
    where j.user_id = p_user_id and j.rule_id = p_rule_id and j.status = 'cancelled'
      and j.cancelled_at is not null
    order by j.cancelled_at desc, j.id
    limit v_limit
  ) c;

  select coalesce(jsonb_agg(row), '[]'::jsonb) into v_skipped
  from (
    select jsonb_build_object(
      'job_id', j.id, 'enrollment_id', j.enrollment_id, 'contact_id', j.contact_id,
      'job_type', j.job_type, 'skipped_reason', j.skipped_reason, 'completed_at', j.completed_at
    ) as row
    from public.automation_jobs j
    where j.user_id = p_user_id and j.rule_id = p_rule_id and j.skipped_reason is not null
    order by j.completed_at desc nulls last, j.id
    limit v_limit
  ) k;

  return jsonb_build_object(
    'found', true,
    'stopped_counts', v_counts,
    'stopped_enrollments', v_stopped,
    'cancelled_jobs', v_cancelled,
    'skipped_jobs', v_skipped
  );
end;
$function$;

-- ---- public.realtoros_skip_claimed_job(p_user_id uuid, p_job_id uuid, p_lock_token uuid, p_reason text)
CREATE OR REPLACE FUNCTION public.realtoros_skip_claimed_job(p_user_id uuid, p_job_id uuid, p_lock_token uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_job public.automation_jobs%rowtype;
begin
  if p_reason is null or p_reason not in ('contact_unsubscribed', 'consent_revoked', 'suppressed') then
    raise exception 'invalid skip reason';
  end if;

  select * into v_job from public.automation_jobs where id = p_job_id and user_id = p_user_id for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if v_job.status <> 'processing' then return jsonb_build_object('outcome', 'not_processing'); end if;
  if v_job.lock_token is distinct from p_lock_token then return jsonb_build_object('outcome', 'stale_lock'); end if;
  if v_job.job_type <> 'send_email' then return jsonb_build_object('outcome', 'not_email'); end if;

  update public.automation_jobs set skipped_reason = p_reason where id = p_job_id;

  return public.realtoros_complete_job_and_advance(p_user_id, p_job_id, p_lock_token)
    || jsonb_build_object('skipped_reason', p_reason);
end;
$function$;

-- ---- public.realtoros_stop_enrollment(p_user_id uuid, p_enrollment_id uuid, p_reason text)
CREATE OR REPLACE FUNCTION public.realtoros_stop_enrollment(p_user_id uuid, p_enrollment_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  update public.automation_enrollments
    set status = 'stopped', stopped_at = now(), stop_reason = left(coalesce(p_reason, 'stopped'), 200), next_action_at = null
    where id = p_enrollment_id and user_id = p_user_id and status in ('active', 'paused');

  update public.automation_jobs
    set status = 'cancelled'
    where enrollment_id = p_enrollment_id and user_id = p_user_id and status = 'pending';

  return jsonb_build_object('outcome', 'stopped');
end;
$function$;

-- ---- public.realtoros_stop_enrollment_on_event(p_user_id uuid, p_enrollment_id uuid, p_reason text, p_contact_id text, p_now timestamp with time zone)
CREATE OR REPLACE FUNCTION public.realtoros_stop_enrollment_on_event(p_user_id uuid, p_enrollment_id uuid, p_reason text, p_contact_id text DEFAULT NULL::text, p_now timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
 SET lock_timeout TO '3s'
AS $function$
declare
  v_enrollment public.automation_enrollments%rowtype;
  v_jobs_cancelled integer := 0;
  v_now timestamptz := coalesce(p_now, now());
begin
  if p_reason is null or p_reason not in ('reply', 'unsubscribe', 'complaint', 'bounce', 'suppression') then
    raise exception 'invalid stop reason';
  end if;

  begin
    select * into v_enrollment
      from public.automation_enrollments
      where id = p_enrollment_id and user_id = p_user_id
      for update;

    if not found then
      return jsonb_build_object('enrollment_stopped', false, 'jobs_cancelled', 0, 'reason', 'not_found');
    end if;

    -- Defense in depth: never stop an enrollment that belongs to a
    -- different contact than the event resolved to.
    if p_contact_id is not null and v_enrollment.contact_id is distinct from p_contact_id then
      return jsonb_build_object('enrollment_stopped', false, 'jobs_cancelled', 0, 'reason', 'contact_mismatch');
    end if;

    -- Idempotent: an already stopped/completed/failed enrollment is left
    -- exactly as it is, including its original stop reason and timestamp.
    if v_enrollment.status not in ('active', 'paused') then
      return jsonb_build_object('enrollment_stopped', false, 'jobs_cancelled', 0, 'reason', 'already_terminal');
    end if;

    update public.automation_enrollments
      set status = 'stopped',
          stopped_at = v_now,
          stop_reason = p_reason,
          next_action_at = null,
          reply_detected_at = case
            when p_reason = 'reply' then coalesce(reply_detected_at, v_now) else reply_detected_at end,
          unsubscribe_detected_at = case
            when p_reason in ('unsubscribe', 'complaint') then coalesce(unsubscribe_detected_at, v_now)
            else unsubscribe_detected_at end
      where id = p_enrollment_id and user_id = p_user_id;

    -- Only unclaimed ('pending') jobs are cancelled. A 'processing' job is
    -- owned by a worker holding a lock token and a live automation_runs
    -- row; realtoros_presend_guard is what stops it before it sends.
    -- Rows are never deleted.
    with cancelled as (
      update public.automation_jobs
        set status = 'cancelled', cancelled_at = v_now, cancelled_reason = p_reason
        where user_id = p_user_id
          and enrollment_id = p_enrollment_id
          and status = 'pending'
        returning 1
    )
    select count(*) into v_jobs_cancelled from cancelled;
  exception when lock_not_available then
    -- Everything in this block (enrollment + jobs) is rolled back together.
    return jsonb_build_object('enrollment_stopped', false, 'jobs_cancelled', 0, 'reason', 'retry');
  end;

  return jsonb_build_object(
    'enrollment_stopped', true,
    'jobs_cancelled', v_jobs_cancelled,
    'reason', p_reason
  );
end;
$function$;

-- ============================================================
-- Verify the revert: the creator lookups and creator joins are both back.
-- ============================================================
do $verify$
declare
  v_n int;
  v_joins int;
  v_bad text := '';
begin
  select count(*) into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'automation_internal')
     and p.prosrc ~ 'user_id[[:space:]]*=[[:space:]]*p_user_id'
     and p.proname not in ('member_permissions', 'workspace_of', 'notify',
                           'ensure_personal_workspace');
  if v_n <> 19 then
    v_bad := v_bad || format(E'\n  %s of 19 functions resolve by creator', v_n);
  end if;

  select count(*) into v_joins
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'automation_internal')
     and p.prosrc ~ '[a-z]+[.]user_id[[:space:]]*=[[:space:]]*[a-z]+[.]user_id';
  if v_joins <> 4 then
    v_bad := v_bad || format(E'\n  %s of 4 functions join on matching creator', v_joins);
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'realtoros_stop_enrollment'
       and p.prosrc like '%T2c-post%'
  ) then
    v_bad := v_bad || E'\n  stop_enrollment still carries the T2c-post guard';
  end if;

  if v_bad <> '' then
    raise exception 'T2c-post revert incomplete:%', v_bad;
  end if;
  raise notice 'T2c-post reverted: all 21 functions resolve by creator again.';
end $verify$;

commit;
