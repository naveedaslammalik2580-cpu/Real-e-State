-- Phase 4D: automatic follow-up execution foundation.
-- Additive only. Does not activate any rule, enroll any contact, or send
-- any email — it only builds the database structures and service-role-only
-- RPCs the (separately deployed, never invoked here) manage-automation and
-- process-automation Edge Functions will use.

-- ============================================================
-- 1. HARDEN RULE/STEP MUTATION — DRAFT-ONLY AT THE DATABASE LEVEL
-- ============================================================
-- Column-level grants are the primary control: authenticated can never
-- even name `status` (or the new runtime_* columns below) in an
-- insert/update statement, regardless of RLS. The RLS policies below are
-- a second, independent layer requiring the affected rule to currently be
-- (and, for updates, remain) 'draft'.

revoke insert, update on public.automation_rules from authenticated;
grant insert (
  user_id, name, trigger_type, timezone, audience_filter,
  stop_on_reply, stop_on_unsubscribe, daily_enrollment_limit, metadata
) on public.automation_rules to authenticated;
grant update (
  name, trigger_type, timezone, audience_filter,
  stop_on_reply, stop_on_unsubscribe, daily_enrollment_limit, metadata
) on public.automation_rules to authenticated;

drop policy if exists automation_rules_insert_own on public.automation_rules;
drop policy if exists automation_rules_update_own on public.automation_rules;
drop policy if exists automation_rules_delete_own on public.automation_rules;

create policy automation_rules_insert_own
  on public.automation_rules
  for insert to authenticated
  with check ((select auth.uid()) = user_id and status = 'draft');

create policy automation_rules_update_own
  on public.automation_rules
  for update to authenticated
  using ((select auth.uid()) = user_id and status = 'draft')
  with check ((select auth.uid()) = user_id and status = 'draft');

create policy automation_rules_delete_own
  on public.automation_rules
  for delete to authenticated
  using ((select auth.uid()) = user_id and status = 'draft');

drop policy if exists automation_steps_insert_own on public.automation_steps;
drop policy if exists automation_steps_update_own on public.automation_steps;
drop policy if exists automation_steps_delete_own on public.automation_steps;

create policy automation_steps_insert_own
  on public.automation_steps
  for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.automation_rules r
      where r.id = automation_steps.rule_id and r.user_id = (select auth.uid()) and r.status = 'draft'
    )
  );

create policy automation_steps_update_own
  on public.automation_steps
  for update to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.automation_rules r
      where r.id = automation_steps.rule_id and r.user_id = (select auth.uid()) and r.status = 'draft'
    )
  )
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.automation_rules r
      where r.id = automation_steps.rule_id and r.user_id = (select auth.uid()) and r.status = 'draft'
    )
  );

create policy automation_steps_delete_own
  on public.automation_steps
  for delete to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.automation_rules r
      where r.id = automation_steps.rule_id and r.user_id = (select auth.uid()) and r.status = 'draft'
    )
  );

-- Owner-scoped SELECT (unrestricted by status — active/paused/archived
-- configuration remains readable, just not writable) is unchanged from
-- the Phase 4B foundation migration.

-- ============================================================
-- 2. RUNTIME RULE SNAPSHOT
-- ============================================================
alter table public.automation_rules
  add column runtime_version uuid,
  add column runtime_snapshot jsonb not null default '{}'::jsonb
    check (jsonb_typeof(runtime_snapshot) = 'object'),
  add column activated_at timestamptz,
  add column paused_at timestamptz,
  add column archived_at timestamptz;

comment on column public.automation_rules.runtime_snapshot is
  'Immutable, server-built copy of the validated ordered steps + email/task configuration at activation time. Never includes provider secrets. The worker executes against this snapshot, not the live (possibly since-edited-elsewhere) automation_steps rows, so later template edits never silently change an already-active sequence.';

-- No column grant for these to authenticated -> the browser cannot set
-- them via insert or update (neither is in the column grants above), only
-- service_role (used exclusively by manage-automation) can.

-- ============================================================
-- 3. AUTOMATION TRIGGER-EVENT OUTBOX
-- ============================================================
create table public.automation_trigger_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  contact_id text not null,
  event_type text not null check (event_type in ('contact_created', 'contact_status_changed')),
  old_status text,
  new_status text,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  available_at timestamptz not null default now(),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  locked_at timestamptz,
  locked_by text,
  lock_token uuid,
  processed_at timestamptz,
  last_error text,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id),
  foreign key (user_id, contact_id) references public.contacts(user_id, id) on delete cascade
);

create index automation_trigger_events_pending_idx
  on public.automation_trigger_events (available_at, id)
  where status = 'pending';
create index automation_trigger_events_stale_processing_idx
  on public.automation_trigger_events (locked_at)
  where status = 'processing';
create index automation_trigger_events_contact_idx
  on public.automation_trigger_events (user_id, contact_id);

alter table public.automation_trigger_events enable row level security;
revoke all on table public.automation_trigger_events from public, anon, authenticated;
grant all on table public.automation_trigger_events to service_role;
grant select on table public.automation_trigger_events to authenticated;

create policy automation_trigger_events_select_own
  on public.automation_trigger_events
  for select to authenticated
  using ((select auth.uid()) = user_id);

create trigger automation_trigger_events_set_updated_at
  before update on public.automation_trigger_events
  for each row execute function public.realtoros_set_updated_at();

comment on table public.automation_trigger_events is
  'Durable outbox of contact-created/contact-status-changed events for the automation worker to match against active rules. Service-role write-only; browser may only SELECT its own rows.';

-- ============================================================
-- 4. CONTACT EVENT TRIGGERS (private schema, SECURITY DEFINER, narrow)
-- ============================================================
create schema if not exists automation_internal;
revoke all on schema automation_internal from public, anon, authenticated;
grant usage on schema automation_internal to service_role;

-- SECURITY DEFINER is required here: the authenticated user who legitimately
-- inserts/updates their OWN contacts row has no grant on
-- automation_trigger_events (browser writes there are fully revoked — see
-- section 3). This function accepts no parameters and only ever reads
-- NEW.user_id / NEW.id / NEW.status / OLD.status from the row the caller's
-- own RLS-checked contacts insert/update already produced — there is no
-- externally supplied input of any kind, so there is nothing to validate
-- against SQL injection or a forged tenant id.
create or replace function automation_internal.contact_created_event()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  insert into public.automation_trigger_events (user_id, contact_id, event_type, new_status, payload)
  values (NEW.user_id, NEW.id, 'contact_created', NEW.status, jsonb_build_object('status', NEW.status));
  return NEW;
end;
$function$;

revoke all on function automation_internal.contact_created_event() from public, anon, authenticated;

drop trigger if exists contacts_automation_created_trigger on public.contacts;
create trigger contacts_automation_created_trigger
  after insert on public.contacts
  for each row execute function automation_internal.contact_created_event();

create or replace function automation_internal.contact_status_changed_event()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  insert into public.automation_trigger_events (user_id, contact_id, event_type, old_status, new_status, payload)
  values (NEW.user_id, NEW.id, 'contact_status_changed', OLD.status, NEW.status,
    jsonb_build_object('old_status', OLD.status, 'new_status', NEW.status));
  return NEW;
end;
$function$;

revoke all on function automation_internal.contact_status_changed_event() from public, anon, authenticated;

drop trigger if exists contacts_automation_status_changed_trigger on public.contacts;
create trigger contacts_automation_status_changed_trigger
  after update on public.contacts
  for each row
  when (OLD.status is distinct from NEW.status)
  execute function automation_internal.contact_status_changed_event();

-- Google Sheets-imported contacts flow through the same `contacts` table
-- via the existing ingest-sheet-leads function, so they fire this same
-- trigger without any change to that function.

-- ============================================================
-- 5. ENROLLMENT IDEMPOTENCY
-- ============================================================
alter table public.automation_enrollments
  add column trigger_event_id uuid,
  add column trigger_event_key text,
  add column runtime_version uuid,
  add column paused_at timestamptz;

-- The same (rule, trigger event) can never create a second enrollment,
-- even long after the first one completed (the pre-existing
-- automation_enrollments_one_open_idx only blocks concurrently-OPEN
-- duplicates, not a replay after completion).
create unique index automation_enrollments_trigger_event_unique_idx
  on public.automation_enrollments (user_id, rule_id, trigger_event_id)
  where trigger_event_id is not null;

-- ============================================================
-- 6. JOB LOCKING
-- ============================================================
alter table public.automation_jobs
  add column lock_token uuid,
  add column next_retry_at timestamptz,
  add column failure_category text
    check (failure_category is null or failure_category in
      ('validation', 'authentication', 'provider', 'rate_limit', 'network', 'database', 'unknown')),
  add column retriable boolean not null default true;

create index automation_jobs_stale_processing_idx
  on public.automation_jobs (locked_at)
  where status = 'processing';
create index automation_jobs_failed_retriable_idx
  on public.automation_jobs (user_id, next_retry_at)
  where status = 'failed' and retriable;

-- ============================================================
-- 7. TRANSACTION-SAFE RPCs (service_role only — never browser-callable)
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
    where status = 'pending' and available_at <= now()
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

create or replace function public.realtoros_recover_stale_automation_leases(p_stale_seconds integer)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_events integer;
  v_jobs integer;
begin
  if p_stale_seconds is null or p_stale_seconds <= 0 then
    raise exception 'invalid stale window';
  end if;

  with recovered as (
    update public.automation_trigger_events
    set status = 'pending', locked_at = null, locked_by = null, lock_token = null
    where status = 'processing' and locked_at < now() - make_interval(secs => p_stale_seconds)
    returning id
  )
  select count(*) into v_events from recovered;

  with recovered as (
    update public.automation_jobs
    set status = 'pending', locked_at = null, locked_by = null, lock_token = null
    where status = 'processing' and locked_at < now() - make_interval(secs => p_stale_seconds)
    returning id
  )
  select count(*) into v_jobs from recovered;

  return jsonb_build_object('recovered_events', v_events, 'recovered_jobs', v_jobs);
end;
$function$;

-- Atomically re-validates the rule, enforces the daily limit under a
-- per-rule advisory lock (so concurrent trigger events for the same rule
-- can never together exceed it), guards against duplicate enrollment for
-- the same trigger event or an existing open enrollment, and creates the
-- enrollment plus its first job from the rule's immutable runtime
-- snapshot — all in one transaction.
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

  select * into v_rule from public.automation_rules where id = p_rule_id and user_id = p_user_id;
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
  v_next_day_start := v_day_start + interval '1 day';

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
    update public.automation_jobs
    set status = 'processing', locked_at = now(), locked_by = 'process-automation',
        lock_token = gen_random_uuid(), attempts = attempts + 1, started_at = now()
    where id = any(v_ids)
    returning *;
end;
$function$;

-- Completes a claimed job (verifying the lock token so a stale/expired
-- worker can never overwrite a newer attempt) and, idempotently,
-- schedules exactly one next job from the rule's runtime snapshot — or
-- completes the enrollment when no step remains. A duplicate completion
-- call for an already-completed job is a safe no-op.
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
begin
  select * into v_job from public.automation_jobs where id = p_job_id and user_id = p_user_id for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if v_job.lock_token is distinct from p_lock_token then
    return jsonb_build_object('outcome', 'stale_lock');
  end if;

  if coalesce(p_retriable, false) and v_job.attempts < v_job.max_attempts then
    update public.automation_jobs
      set status = 'pending', scheduled_at = p_next_retry_at, next_retry_at = p_next_retry_at,
          locked_at = null, locked_by = null, lock_token = null,
          last_error = p_error_message, failure_category = coalesce(p_error_category, 'unknown'), retriable = true
      where id = p_job_id;
    return jsonb_build_object('outcome', 'rescheduled');
  end if;

  update public.automation_jobs
    set status = 'failed', completed_at = now(), locked_at = null, locked_by = null, lock_token = null,
        last_error = p_error_message, failure_category = coalesce(p_error_category, 'unknown'),
        retriable = coalesce(p_retriable, false)
    where id = p_job_id;

  insert into public.automation_failures (user_id, job_id, category, error_code, error_message, retriable)
  values (
    p_user_id, p_job_id, coalesce(p_error_category, 'unknown'),
    left(coalesce(p_error_code, 'unknown'), 100), left(coalesce(p_error_message, 'Unknown error'), 500),
    coalesce(p_retriable, false)
  );

  return jsonb_build_object('outcome', 'failed_final');
end;
$function$;

create or replace function public.realtoros_stop_enrollment(
  p_user_id uuid,
  p_enrollment_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
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

-- Browser-triggered (via manage-automation, never directly) retry of one
-- explicitly eligible failed job.
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
  v_job public.automation_jobs%rowtype;
begin
  select * into v_job from public.automation_jobs where id = p_job_id and user_id = p_user_id for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if v_job.status <> 'failed' or not coalesce(v_job.retriable, false) or v_job.attempts >= v_job.max_attempts then
    return jsonb_build_object('outcome', 'not_eligible');
  end if;

  update public.automation_jobs
    set status = 'pending', scheduled_at = now(), next_retry_at = null,
        locked_at = null, locked_by = null, lock_token = null
    where id = p_job_id;

  return jsonb_build_object('outcome', 'retried');
end;
$function$;

revoke all on function public.realtoros_claim_trigger_events(integer) from public, anon, authenticated;
revoke all on function public.realtoros_recover_stale_automation_leases(integer) from public, anon, authenticated;
revoke all on function public.realtoros_enroll_contact(uuid, uuid, text, uuid, text) from public, anon, authenticated;
revoke all on function public.realtoros_claim_due_jobs(integer) from public, anon, authenticated;
revoke all on function public.realtoros_complete_job_and_advance(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.realtoros_reschedule_job(uuid, uuid, uuid, timestamptz, text, text, text, boolean) from public, anon, authenticated;
revoke all on function public.realtoros_stop_enrollment(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.realtoros_retry_failed_job(uuid, uuid) from public, anon, authenticated;

grant execute on function public.realtoros_claim_trigger_events(integer) to service_role;
grant execute on function public.realtoros_recover_stale_automation_leases(integer) to service_role;
grant execute on function public.realtoros_enroll_contact(uuid, uuid, text, uuid, text) to service_role;
grant execute on function public.realtoros_claim_due_jobs(integer) to service_role;
grant execute on function public.realtoros_complete_job_and_advance(uuid, uuid, uuid) to service_role;
grant execute on function public.realtoros_reschedule_job(uuid, uuid, uuid, timestamptz, text, text, text, boolean) to service_role;
grant execute on function public.realtoros_stop_enrollment(uuid, uuid, text) to service_role;
grant execute on function public.realtoros_retry_failed_job(uuid, uuid) to service_role;

comment on function public.realtoros_enroll_contact is
  'service_role-only. Atomically re-validates an active rule, enforces the timezone-aware daily enrollment limit under a per-rule advisory lock, guards duplicate enrollment (same trigger event, or an existing open enrollment), and creates the enrollment plus its first job from the runtime snapshot. Never callable by anon or authenticated.';
comment on function public.realtoros_complete_job_and_advance is
  'service_role-only. Verifies the job''s current lock token, completes it, and idempotently schedules exactly one next job (or completes the enrollment) from the runtime snapshot. Never callable by anon or authenticated.';
