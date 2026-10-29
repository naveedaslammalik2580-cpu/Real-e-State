-- Phase 4E: reply, unsubscribe, and lifecycle stop logic.
--
-- Additive only. Does not modify any already-committed migration.
-- Nothing here activates a rule, enrolls a contact, or sends an email.
--
-- WHAT ALREADY EXISTED (verified against the committed schema before
-- writing this migration, so that nothing is duplicated):
--
--   * public.automation_enrollments.status already allows 'stopped', and
--     the table already has stopped_at, stop_reason, reply_detected_at and
--     unsubscribe_detected_at. This migration reuses stop_reason rather
--     than adding a second, near-identical 'stopped_reason' column.
--   * public.automation_jobs.status already allows 'cancelled'. Only the
--     cancelled_at / cancelled_reason detail columns are new.
--   * public.automation_rules already has stop_on_reply and
--     stop_on_unsubscribe (both default true).
--   * This project uses no enum types anywhere — every status is text with
--     a check constraint — so there are no enum values to add.
--   * public.contacts.id is TEXT, not uuid, and every automation table
--     references it as text. All contact parameters below are text.
--
-- WHERE THESE FUNCTIONS LIVE. PostgREST can only invoke functions in an
-- exposed schema, and the Edge Functions reach these through
-- supabase.rpc(...). A function in a non-exposed schema (private,
-- automation_internal) would therefore be completely uncallable by the
-- webhook and the worker. They are instead created in public following the
-- exact pattern every other RealtorOS RPC uses — `security invoker`, an
-- empty search_path, all privileges revoked from public/anon/authenticated,
-- and execute granted only to service_role. That yields the required
-- property (service-role only; no browser access of any kind) without
-- breaking invocability.

-- ============================================================
-- 1. CONTACT LIFECYCLE COLUMNS
-- ============================================================
-- Contact-level (cross-rule) first-occurrence markers. The equivalents on
-- automation_enrollments are per-enrollment; these are what makes a reply
-- or unsubscribe detected under ONE rule able to block enrollment into
-- every other rule for the same contact.
alter table public.contacts
  add column if not exists reply_detected_at timestamptz default null,
  add column if not exists unsubscribe_detected_at timestamptz default null;

comment on column public.contacts.reply_detected_at is
  'First time this contact was observed replying to an automated email. Set once, server-side only, and never overwritten. Used with automation_rules.stop_on_reply to block further enrollment.';
comment on column public.contacts.unsubscribe_detected_at is
  'First time this contact was observed unsubscribing. Set once, server-side only, and never overwritten. Used with automation_rules.stop_on_unsubscribe to block further enrollment; the authoritative send-time block is the revoked communication_consents row.';

create index if not exists contacts_lifecycle_stop_idx
  on public.contacts (user_id)
  where reply_detected_at is not null or unsubscribe_detected_at is not null;

-- public.contacts carries a TABLE-level `grant select, insert, update,
-- delete ... to authenticated` (see the Phase 3 relational migration), so
-- unlike the automation tables — where withholding a column grant is
-- enough — a new column here would be browser-writable by default. In
-- PostgreSQL a column-level REVOKE cannot subtract from a table-level
-- grant, and converting contacts to per-column grants would risk silently
-- breaking every other CRM write. A BEFORE trigger enforces it instead:
-- for the browser roles these two columns are simply not writable, on
-- INSERT or UPDATE, whatever the request claims.
create or replace function automation_internal.protect_contact_lifecycle_columns()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  -- security invoker is required: inside a SECURITY DEFINER function
  -- current_user would be the function owner, not the caller's PostgREST
  -- role, and the check would never fire.
  if pg_catalog.current_user in ('authenticated', 'anon') then
    if TG_OP = 'INSERT' then
      NEW.reply_detected_at := null;
      NEW.unsubscribe_detected_at := null;
    else
      NEW.reply_detected_at := OLD.reply_detected_at;
      NEW.unsubscribe_detected_at := OLD.unsubscribe_detected_at;
    end if;
  end if;
  return NEW;
end;
$function$;

revoke all on function automation_internal.protect_contact_lifecycle_columns() from public, anon, authenticated;

drop trigger if exists contacts_protect_lifecycle_columns_trigger on public.contacts;
create trigger contacts_protect_lifecycle_columns_trigger
  before insert or update on public.contacts
  for each row execute function automation_internal.protect_contact_lifecycle_columns();

-- ============================================================
-- 2. JOB CANCELLATION DETAIL COLUMNS
-- ============================================================
-- 'cancelled' is already an accepted automation_jobs.status; only the
-- reason/timestamp detail is new, so the UI can tell a job that was
-- deliberately cancelled by a stop event apart from one that failed.
alter table public.automation_jobs
  add column if not exists cancelled_at timestamptz default null,
  add column if not exists cancelled_reason text default null;

comment on column public.automation_jobs.cancelled_reason is
  'Why a job was cancelled: reply | unsubscribe | bounce | suppression | enrollment_inactive | contact_ineligible | rule_archived. Written server-side only.';

-- No column grant to authenticated for either column -> the browser can
-- read them (table-level select) but can never write them.

-- ============================================================
-- 3. STOP AN ENROLLMENT ON A LIFECYCLE EVENT (new)
-- ============================================================
-- Atomically: stop one non-terminal enrollment, and cancel every job of
-- that enrollment that has not already been claimed by a worker.
--
-- A 'processing' job is deliberately NOT cancelled here: it is owned by a
-- worker holding a live lock token and exactly one 'processing'
-- automation_runs row (the Phase 4D run invariant). Cancelling it behind
-- the worker's back would break that lease. Instead the worker's own
-- pre-execution guard (see process-automation) re-reads the enrollment
-- before it sends anything and cancels the job through the
-- lock-token-guarded path, so an in-flight job still stops without an
-- email going out.
create or replace function public.realtoros_stop_enrollment_on_event(
  p_user_id uuid,
  p_enrollment_id uuid,
  p_reason text,
  p_contact_id text default null,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_enrollment public.automation_enrollments%rowtype;
  v_jobs_cancelled integer := 0;
  v_now timestamptz := coalesce(p_now, now());
begin
  if p_reason is null or p_reason not in ('reply', 'unsubscribe', 'bounce', 'suppression') then
    raise exception 'invalid stop reason';
  end if;

  -- `skip locked` rather than a plain `for update`: two webhook events for
  -- the same contact (a bounce and an unsubscribe, say) can arrive
  -- simultaneously, and blocking one behind the other would hold a webhook
  -- HTTP request open for the duration. Reporting 'locked' instead lets
  -- the caller treat it as a benign no-op — the transaction that DOES hold
  -- the lock is itself stopping the same enrollment, so the outcome is
  -- identical either way.
  select * into v_enrollment
    from public.automation_enrollments
    where id = p_enrollment_id and user_id = p_user_id
    for update skip locked;

  if not found then
    -- Distinguish "row is locked right now" from "row does not exist":
    -- `skip locked` returns no row for both.
    if exists (
      select 1 from public.automation_enrollments
      where id = p_enrollment_id and user_id = p_user_id
    ) then
      return jsonb_build_object('enrollment_stopped', false, 'jobs_cancelled', 0, 'reason', 'locked');
    end if;
    return jsonb_build_object('enrollment_stopped', false, 'jobs_cancelled', 0, 'reason', 'not_found');
  end if;

  -- Defense in depth: never stop an enrollment that belongs to a different
  -- contact than the event resolved to.
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
          when p_reason = 'unsubscribe' then coalesce(unsubscribe_detected_at, v_now) else unsubscribe_detected_at end
    where id = p_enrollment_id and user_id = p_user_id;

  with cancelled as (
    update public.automation_jobs
      set status = 'cancelled', cancelled_at = v_now, cancelled_reason = p_reason
      where user_id = p_user_id
        and enrollment_id = p_enrollment_id
        and status = 'pending'
      returning 1
  )
  select count(*) into v_jobs_cancelled from cancelled;

  return jsonb_build_object(
    'enrollment_stopped', true,
    'jobs_cancelled', v_jobs_cancelled,
    'reason', p_reason
  );
end;
$function$;

-- ============================================================
-- 4. RECORD A CONTACT-LEVEL STOP EVENT (new)
-- ============================================================
-- First occurrence wins for the lifecycle timestamp; consent revocation
-- and the activity record are both idempotent, so a replayed webhook
-- changes nothing.
create or replace function public.realtoros_record_contact_stop_event(
  p_user_id uuid,
  p_contact_id text,
  p_event_type text,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_first_occurrence boolean := false;
  v_consent_revoked boolean := false;
begin
  if p_event_type is null or p_event_type not in ('reply', 'unsubscribe') then
    raise exception 'invalid contact stop event type';
  end if;

  -- Lock the contact row so two concurrent stop events for the same
  -- contact cannot both see a null timestamp and both claim to be first.
  perform 1 from public.contacts
    where id = p_contact_id and user_id = p_user_id
    for update;
  if not found then
    return jsonb_build_object('recorded', false, 'reason', 'contact_not_found');
  end if;

  -- `is null` in the WHERE clause is what makes this write-once: a second
  -- delivery of the same event updates zero rows and leaves the original
  -- timestamp intact.
  if p_event_type = 'reply' then
    update public.contacts
      set reply_detected_at = v_now
      where id = p_contact_id and user_id = p_user_id and reply_detected_at is null;
  else
    update public.contacts
      set unsubscribe_detected_at = v_now
      where id = p_contact_id and user_id = p_user_id and unsubscribe_detected_at is null;
  end if;
  v_first_occurrence := found;

  -- An unsubscribe revokes email consent outright. This is the
  -- authoritative send-time block: process-automation and
  -- manage-automation both already refuse to send to an 'opted_out'
  -- contact, independently of any rule-level stop flag.
  if p_event_type = 'unsubscribe' then
    insert into public.communication_consents (
      user_id, contact_id, channel, status, source, effective_at, evidence
    ) values (
      p_user_id, p_contact_id, 'email', 'opted_out', 'webhook', v_now,
      jsonb_build_object('event', 'unsubscribe', 'recorded_at', v_now)
    )
    on conflict (user_id, contact_id, channel) do update
      set status = 'opted_out',
          source = 'webhook',
          effective_at = excluded.effective_at,
          evidence = excluded.evidence
      -- Already opted out -> change nothing, preserving the original
      -- effective_at. This is what makes a replayed webhook a true no-op.
      where communication_consents.status is distinct from 'opted_out';
    v_consent_revoked := true;
  end if;

  -- Deterministic id -> replaying the same event never creates a second
  -- activity row. No email address or message content is stored here.
  insert into public.activities (id, user_id, type, contact_id, subject, description, outcome, notes, date)
  values (
    'automation-stop-' || p_event_type || '-' || p_contact_id,
    p_user_id,
    case when p_event_type = 'reply' then 'Email' else 'Note' end,
    p_contact_id,
    case when p_event_type = 'reply' then 'Contact replied to an automated email'
         else 'Contact unsubscribed from automated email' end,
    '',
    case when p_event_type = 'reply' then 'Replied' else 'Unsubscribed' end,
    case when p_event_type = 'reply'
      then 'Detected automatically. Sequences with "stop on reply" will not enroll this contact again.'
      else 'Detected automatically. Email consent has been revoked and no further automated email will be sent.' end,
    v_now
  )
  on conflict (id) do nothing;

  return jsonb_build_object(
    'recorded', true,
    'first_occurrence', v_first_occurrence,
    'consent_revoked', v_consent_revoked
  );
end;
$function$;

-- ============================================================
-- 5. ENROLLMENT ELIGIBILITY GUARD (new)
-- ============================================================
-- A read-only pre-check. It never mutates anything, so it is always safe
-- to call speculatively, and it returns the FIRST blocking reason found in
-- a deliberate order: hard, contact-wide blocks first, then rule-level
-- lifecycle stops, then duplicate prevention.
--
-- On the stop_on_unsubscribe interpretation: a revoked email consent is an
-- unconditional block (checked before any rule flag is consulted), because
-- consent governs whether an email may be sent at all. stop_on_unsubscribe
-- governs automation BEHAVIOUR — whether a detected unsubscribe also halts
-- sequences — and so is checked separately against the contact's
-- unsubscribe_detected_at marker. A contact whose consent was later
-- explicitly re-granted is therefore still blocked from rules that set
-- stop_on_unsubscribe, and is eligible for rules that do not.
create or replace function public.realtoros_check_enrollment_eligibility(
  p_user_id uuid,
  p_contact_id text,
  p_rule_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
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

-- ============================================================
-- 6. RESOLVE THE ENROLLMENTS A STOP EVENT APPLIES TO (new)
-- ============================================================
-- Returns the open enrollments for one contact together with the owning
-- rule's stop flags, so the webhook can decide — in one round trip, and
-- without any browser-reachable view over the automation runtime — which
-- of them a given event type must actually stop.
create or replace function public.realtoros_open_enrollments_for_contact(
  p_user_id uuid,
  p_contact_id text
)
returns table (
  enrollment_id uuid,
  rule_id uuid,
  status text,
  stop_on_reply boolean,
  stop_on_unsubscribe boolean
)
language sql
security invoker
set search_path to ''
as $function$
  select e.id, e.rule_id, e.status, r.stop_on_reply, r.stop_on_unsubscribe
  from public.automation_enrollments e
  join public.automation_rules r on r.id = e.rule_id and r.user_id = e.user_id
  where e.user_id = p_user_id
    and e.contact_id = p_contact_id
    and e.status in ('active', 'paused')
  order by e.started_at, e.id;
$function$;

-- ============================================================
-- 7. STOP-HISTORY READ MODEL (new)
-- ============================================================
-- Owner-scoped, read-only aggregate backing the automation page's stop
-- panel. Returned as a single jsonb document so manage-automation can pass
-- it straight through without re-shaping (and without ever exposing a
-- table the browser is not allowed to read directly).
create or replace function public.realtoros_rule_stop_summary(
  p_user_id uuid,
  p_rule_id uuid,
  p_limit integer default 20
)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_counts jsonb;
  v_stopped jsonb;
  v_cancelled jsonb;
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

  return jsonb_build_object(
    'found', true,
    'stopped_counts', v_counts,
    'stopped_enrollments', v_stopped,
    'cancelled_jobs', v_cancelled
  );
end;
$function$;

-- ============================================================
-- 8. GRANTS — service_role only, never the browser
-- ============================================================
revoke all on function public.realtoros_stop_enrollment_on_event(uuid, uuid, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.realtoros_record_contact_stop_event(uuid, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.realtoros_check_enrollment_eligibility(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.realtoros_open_enrollments_for_contact(uuid, text) from public, anon, authenticated;
revoke all on function public.realtoros_rule_stop_summary(uuid, uuid, integer) from public, anon, authenticated;

grant execute on function public.realtoros_stop_enrollment_on_event(uuid, uuid, text, text, timestamptz) to service_role;
grant execute on function public.realtoros_record_contact_stop_event(uuid, text, text, timestamptz) to service_role;
grant execute on function public.realtoros_check_enrollment_eligibility(uuid, text, uuid) to service_role;
grant execute on function public.realtoros_open_enrollments_for_contact(uuid, text) to service_role;
grant execute on function public.realtoros_rule_stop_summary(uuid, uuid, integer) to service_role;

comment on function public.realtoros_stop_enrollment_on_event is
  'service_role-only. Atomically stops one non-terminal enrollment for a lifecycle event (reply | unsubscribe | bounce | suppression) and cancels its unclaimed pending jobs, returning how many. Idempotent: an already-terminal enrollment returns enrollment_stopped=false with reason=already_terminal and changes nothing. Uses FOR UPDATE SKIP LOCKED so concurrent webhook events never block each other. Never cancels a claimed (processing) job — the worker''s own pre-send guard stops that one. Never callable by anon or authenticated.';
comment on function public.realtoros_record_contact_stop_event is
  'service_role-only. Records a contact-level reply or unsubscribe: sets the lifecycle timestamp once (first occurrence wins, never overwritten), revokes email consent for an unsubscribe, and writes one deterministic activity row. Fully idempotent under webhook replay. Never callable by anon or authenticated.';
comment on function public.realtoros_check_enrollment_eligibility is
  'service_role-only, read-only. Returns {eligible, block_reason} for a (contact, rule) pair. Blocks unconditionally on an active suppression or revoked email consent; blocks on a detected unsubscribe/reply only when the rule sets stop_on_unsubscribe/stop_on_reply; and blocks a duplicate open enrollment. Never callable by anon or authenticated.';
comment on function public.realtoros_rule_stop_summary is
  'service_role-only, read-only. Owner-scoped stop history for one rule: stopped-enrollment counts by reason, recent stopped enrollments, and recent cancelled jobs with reasons. Backs the automation page''s read-only stop panel via manage-automation. Never callable by anon or authenticated.';
