-- Phase 4E.2: stop-logic completion.
--
-- Applies on top of the live history (last applied version 20260904060217,
-- phase_4e_reply_unsubscribe_stop_logic). Additive except for the one
-- function that is deliberately dropped and recreated (section 4), which
-- has no deployed caller: none of send-test-email, resend-webhook,
-- manage-automation or process-automation is deployed, so no running code
-- depends on its old signature.
--
-- Nothing here activates a rule, enrolls a contact, or sends an email.
--
-- Fixes verified gaps in the Phase 4E functions:
--   0. HOTFIX — the Phase 4E contacts trigger function referenced
--      `pg_catalog.current_user`, which is a run-time parse error, so
--      every insert/update of public.contacts fails once 4E is applied.
--      See section 0.
--   1. realtoros_stop_enrollment_on_event used FOR UPDATE SKIP LOCKED and
--      reported 'locked' WITHOUT stopping, so a stop could be silently
--      dropped. It now waits (bounded by lock_timeout) and reports 'retry'
--      on timeout; every caller retries. 'complaint' is a new reason.
--   2. realtoros_record_contact_stop_event accepted only reply/unsubscribe,
--      hardcoded the consent source, and never wrote email_suppressions.
--      It is recreated with a real source, an idempotency reference,
--      complaint and hard-bounce support, suppression writes, and the
--      rule-flag enrollment stops applied in the same transaction.
--   3. There was no single pre-send check covering a job already claimed
--      ('processing'), which a stop never cancels. realtoros_presend_guard
--      is that check; realtoros_skip_claimed_job lets an email step be
--      skipped (not sent) while the rest of the sequence continues.
--
-- Every function stays SECURITY INVOKER with an empty search_path, with
-- EXECUTE revoked from public/anon/authenticated and granted only to
-- service_role — the same pattern as every other RealtorOS RPC. They live
-- in public because the Edge Functions reach them through PostgREST rpc(),
-- which cannot call a non-exposed schema; the grants, not the schema, are
-- what keep the browser out.

-- ============================================================
-- 0. HOTFIX: contacts lifecycle-protect trigger (live since 4E)
-- ============================================================
-- The Phase 4E trigger function tested `pg_catalog.current_user`.
-- current_user is an SQL keyword, not a schema-qualifiable function
-- name, so PostgreSQL parses that as a column of a table called
-- "pg_catalog" and raises 42P01 (missing FROM-clause entry for table
-- "pg_catalog"). PL/pgSQL only parses the expression on first execution,
-- so the migration applied cleanly — but from then on EVERY insert or
-- update of public.contacts fails, for every role, because the trigger
-- runs on all of them.
--
-- Fix: the bare keyword. It cannot be shadowed through search_path (it is
-- not a function lookup at all), and the function already pins
-- search_path to ''. Same name, same signature, same behaviour otherwise.
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
  if current_user in ('authenticated', 'anon') then
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

-- ============================================================
-- 1. JOB SKIP DETAIL COLUMN
-- ============================================================
-- A skipped email step is a COMPLETED job that deliberately sent nothing
-- (the contact unsubscribed on a rule that keeps running, or the address
-- is blocked). automation_jobs.status has no 'skipped' value and adding
-- one would ripple through every Phase 4D function, so the reason is
-- recorded here instead and the job completes normally, letting the
-- sequence advance to its next (e.g. create_task) step.
alter table public.automation_jobs
  add column if not exists skipped_reason text default null;

do $skipped_reason_check$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.automation_jobs'::regclass
      and conname = 'automation_jobs_skipped_reason_check'
  ) then
    alter table public.automation_jobs
      add constraint automation_jobs_skipped_reason_check
      check (skipped_reason is null or char_length(skipped_reason) between 1 and 100);
  end if;
end
$skipped_reason_check$;

comment on column public.automation_jobs.skipped_reason is
  'Why an email step completed WITHOUT sending: contact_unsubscribed | consent_revoked | suppressed. Written server-side only (realtoros_skip_claimed_job). Null for every job that ran normally.';

-- As with cancelled_at/cancelled_reason: no column grant to authenticated,
-- so the browser can read it (existing table-level select) but never
-- write it.

-- ============================================================
-- 1b. REPLY-TOKEN LOOKUP INDEX
-- ============================================================
-- process-automation stores an opaque, deterministic reply token in
-- outbound_messages.metadata->>'reply_token' (40 lowercase hex chars; no
-- id, address or name). resend-webhook resolves an inbound reply to its
-- message by that token. Unique, so a token can only ever resolve to one
-- message; partial, so rows without a token (test sends, pre-4E.2 rows)
-- are not indexed. The equality lookup PostgREST generates implies
-- "is not null", so the planner can use this partial index.
create unique index if not exists outbound_messages_reply_token_idx
  on public.outbound_messages ((metadata ->> 'reply_token'))
  where (metadata ->> 'reply_token') is not null;

-- ============================================================
-- 2. STOP-EVENT LEDGER (idempotency + evidence)
-- ============================================================
-- One row per APPLIED stop event. (user_id, source, event_ref) is unique,
-- so a replayed webhook, a double-submitted unsubscribe form, or a
-- redelivered inbound email returns the original result and changes
-- nothing. A row is written only once every effect of the event has been
-- applied; an event that must be retried leaves no row, so the retry runs
-- in full (every effect is itself idempotent).
--
-- event_ref is always server-derived (a provider event id, a message id,
-- or a server-generated request id) and never a secret: no token, email
-- address or message content is stored here.
create table if not exists public.contact_stop_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  contact_id text not null,
  event_type text not null
    check (event_type in ('reply', 'unsubscribe', 'complaint', 'hard_bounce')),
  source text not null
    check (source in ('provider_webhook', 'unsubscribe_link', 'inbound_email', 'owner_manual')),
  event_ref text not null
    check (char_length(event_ref) between 1 and 200 and event_ref !~ '[\x00-\x1F\x7F]'),
  outbound_message_id uuid,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  result jsonb not null default '{}'::jsonb
    check (jsonb_typeof(result) = 'object'),
  unique (user_id, id),
  unique (user_id, source, event_ref),
  foreign key (user_id, contact_id)
    references public.contacts(user_id, id) on delete cascade,
  foreign key (user_id, outbound_message_id)
    references public.outbound_messages(user_id, id) on delete set null (outbound_message_id)
);

create index if not exists contact_stop_events_contact_idx
  on public.contact_stop_events (user_id, contact_id, recorded_at desc);
create index if not exists contact_stop_events_message_idx
  on public.contact_stop_events (user_id, outbound_message_id)
  where outbound_message_id is not null;

-- Service-role only. RLS is enabled with NO policy, so even a future
-- accidental grant to a browser role would still expose zero rows.
alter table public.contact_stop_events enable row level security;
revoke all on table public.contact_stop_events from public, anon, authenticated;
grant all on table public.contact_stop_events to service_role;

comment on table public.contact_stop_events is
  'Service-role-only ledger of applied contact stop events (reply, unsubscribe, complaint, hard bounce). Unique on (user_id, source, event_ref) for idempotency. Written only by realtoros_record_contact_stop_event. No browser access.';

-- ============================================================
-- 3. STOP ONE ENROLLMENT — blocking lock, explicit retry outcome
-- ============================================================
-- Same signature as Phase 4E (create or replace keeps it one function).
--
-- The Phase 4E version used `for update skip locked` and returned
-- reason='locked' without stopping anything, on the theory that whoever
-- held the lock was stopping the same enrollment. That is not guaranteed:
-- the lock holder can equally be realtoros_complete_job_and_advance or
-- realtoros_reschedule_job, which stop nothing — so the stop was lost.
--
-- Now: a plain `for update`, bounded by the function-level lock_timeout.
-- Every writer that holds an enrollment row lock does so for a short,
-- single-statement-scale transaction, so 3 seconds is ample. On timeout
-- the whole stop (enrollment + its pending jobs) is rolled back as a unit
-- and reason='retry' is returned; callers MUST retry (the webhook returns
-- non-2xx so the provider redelivers; the worker and manual actions retry
-- a bounded number of times).
--
-- The pending-job update is inside the same guarded block: a pending job
-- can be momentarily locked by realtoros_claim_due_jobs, and a timeout
-- there must not leave a stopped enrollment with live pending jobs.
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
set lock_timeout to '3s'
as $function$
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
-- 4. RECORD A CONTACT STOP EVENT — recreated with a new signature
-- ============================================================
-- Dropped (not overloaded) so there is exactly one function of this name
-- and a PostgREST rpc() call can never be ambiguous between two
-- signatures. Safe because no deployed code calls the old one.
drop function if exists public.realtoros_record_contact_stop_event(uuid, text, text, timestamptz);

-- THE single entry point for every contact-level stop, whatever its
-- source. In one transaction, under the contact row lock:
--
--   * idempotency: a (user_id, source, event_ref) already in the ledger
--     returns the stored result and changes nothing;
--   * lifecycle marker (reply / unsubscribe; complaint counts as an
--     unsubscribe) — earliest occurrence wins, never moved later;
--   * unsubscribe / complaint: email consent -> opted_out with the REAL
--     source, and an active suppression ('unsubscribe' / 'complaint');
--   * hard_bounce: an active 'bounce' suppression only — no lifecycle or
--     consent change, no enrollment stop (the pre-send guard skips the
--     email steps; non-email steps continue);
--   * one deterministic activity per (event type, contact), so a replay
--     never adds a second note;
--   * enrollment stops per rule flag: reply -> stop_on_reply;
--     unsubscribe/complaint -> stop_on_unsubscribe. With the flag off the
--     enrollment continues, but consent + suppression still block every
--     email step (enforced by realtoros_presend_guard) — suppression is a
--     legal requirement, not a rule preference.
--
-- Lock order: contact row, then that contact's open enrollments in id
-- order (each via realtoros_stop_enrollment_on_event). Two stop events for
-- the same contact therefore serialize on the contact row and can never
-- deadlock each other.
--
-- outcome values:
--   'recorded'          every effect applied; ledger row written
--   'duplicate'         already applied earlier; stored result returned
--   'retry'             a lock wait timed out; caller MUST retry. Effects
--                       applied before the timeout (lifecycle, consent,
--                       suppression, activity) are kept — they are
--                       idempotent — and no ledger row is written, so the
--                       retry finishes the enrollment stops.
--   'contact_not_found' no such contact for this owner; nothing changed
--   'message_mismatch'  p_outbound_message_id is not this owner's message
--                       for this contact; nothing changed
create or replace function public.realtoros_record_contact_stop_event(
  p_user_id uuid,
  p_contact_id text,
  p_event_type text,
  p_source text,
  p_event_ref text,
  p_outbound_message_id uuid default null,
  p_occurred_at timestamptz default now()
)
returns jsonb
language plpgsql
security invoker
set search_path to ''
set lock_timeout to '3s'
as $function$
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
    or (p_event_type = 'unsubscribe' and p_source in ('unsubscribe_link', 'owner_manual', 'provider_webhook'))
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

-- ============================================================
-- 5. PRE-SEND GUARD (new) — for jobs already claimed by the worker
-- ============================================================
-- A stop cancels only 'pending' jobs, so a job the worker has already
-- claimed ('processing') is protected by THIS check, which the worker
-- calls with its lock token at the start of every job and again
-- immediately before any provider call. Read-only.
--
-- action values (the worker acts on these, never on `reason` alone):
--   'none'   not blocked — proceed
--   'abort'  the caller no longer holds this job's lock; touch nothing
--   'cancel' the enrollment is no longer active (or the contact is gone);
--            cancel the claimed job
--   'stop'   a lifecycle stop applies to the whole sequence; stop the
--            enrollment with `stop_reason`, then cancel the claimed job
--   'skip'   an EMAIL step may not be sent (blocked address, revoked
--            consent, or an unsubscribe on a rule that keeps running);
--            complete the step without sending so later steps continue
create or replace function public.realtoros_presend_guard(
  p_user_id uuid,
  p_job_id uuid,
  p_lock_token uuid
)
returns jsonb
language plpgsql
stable
security invoker
set search_path to ''
as $function$
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

-- ============================================================
-- 6. SKIP A CLAIMED EMAIL STEP (new)
-- ============================================================
-- Lock-token guarded. Records why the step sent nothing, then completes
-- it through realtoros_complete_job_and_advance in the SAME transaction,
-- so the skip reason and the completion (including the automation_runs
-- invariant and scheduling the next step) commit or roll back together.
create or replace function public.realtoros_skip_claimed_job(
  p_user_id uuid,
  p_job_id uuid,
  p_lock_token uuid,
  p_reason text
)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
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

-- ============================================================
-- 7. STOP-HISTORY READ MODEL — now also lists skipped email steps
-- ============================================================
-- Same signature; adds 'skipped_jobs'. Everything else is unchanged.
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

-- ============================================================
-- 8. GRANTS — service_role only, never the browser
-- ============================================================
-- Re-asserted for the replaced functions too (create or replace keeps
-- existing grants, but stating them makes this file self-verifying).
revoke all on function public.realtoros_stop_enrollment_on_event(uuid, uuid, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.realtoros_record_contact_stop_event(uuid, text, text, text, text, uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.realtoros_presend_guard(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.realtoros_skip_claimed_job(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.realtoros_rule_stop_summary(uuid, uuid, integer) from public, anon, authenticated;

grant execute on function public.realtoros_stop_enrollment_on_event(uuid, uuid, text, text, timestamptz) to service_role;
grant execute on function public.realtoros_record_contact_stop_event(uuid, text, text, text, text, uuid, timestamptz) to service_role;
grant execute on function public.realtoros_presend_guard(uuid, uuid, uuid) to service_role;
grant execute on function public.realtoros_skip_claimed_job(uuid, uuid, uuid, text) to service_role;
grant execute on function public.realtoros_rule_stop_summary(uuid, uuid, integer) to service_role;

comment on function public.realtoros_stop_enrollment_on_event(uuid, uuid, text, text, timestamptz) is
  'service_role-only. Stops one active/paused enrollment for a lifecycle event (reply | unsubscribe | complaint | bounce | suppression) and cancels its pending jobs, atomically. Waits for the row lock up to lock_timeout (3s); on timeout changes nothing and returns reason=retry, which every caller must retry. Idempotent: an already-terminal enrollment returns reason=already_terminal. Never cancels a processing job (see realtoros_presend_guard). Never callable by anon or authenticated.';
comment on function public.realtoros_record_contact_stop_event(uuid, text, text, text, text, uuid, timestamptz) is
  'service_role-only. The single entry point for a contact stop event (reply | unsubscribe | complaint | hard_bounce) from provider_webhook | unsubscribe_link | inbound_email | owner_manual. Idempotent on (user_id, source, event_ref). Sets the lifecycle marker (earliest wins), revokes email consent and adds a suppression where required, writes one deterministic activity, and stops enrollments per rule flag — all under the contact row lock. outcome=retry means a lock wait timed out and the caller must retry. Never callable by anon or authenticated.';
comment on function public.realtoros_presend_guard(uuid, uuid, uuid) is
  'service_role-only, read-only. Called by process-automation with its lock token before running a claimed job and immediately before any provider call. Returns {blocked, action: none|abort|cancel|stop|skip, reason, stop_reason}. Never callable by anon or authenticated.';
comment on function public.realtoros_skip_claimed_job(uuid, uuid, uuid, text) is
  'service_role-only. Lock-token guarded: records why a claimed email step sent nothing (contact_unsubscribed | consent_revoked | suppressed) and completes it via realtoros_complete_job_and_advance in the same transaction, so later steps continue. Never callable by anon or authenticated.';
comment on function public.realtoros_rule_stop_summary(uuid, uuid, integer) is
  'service_role-only, read-only. Owner-scoped stop history for one rule: stopped-enrollment counts by reason, recent stopped enrollments, recent cancelled jobs, and recent skipped email steps, with reasons. Backs the automation page via manage-automation. Never callable by anon or authenticated.';
