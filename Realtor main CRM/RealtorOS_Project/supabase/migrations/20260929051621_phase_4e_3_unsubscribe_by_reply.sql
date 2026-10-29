-- Phase 4E.3: treat a reply that says "unsubscribe" as a real unsubscribe.
--
-- Applies on top of the live history (last applied version 20260929041708,
-- phase_4e_2_stop_logic_completion).
--
-- The expired-unsubscribe page tells people to reply "unsubscribe", which
-- makes such a reply a legal opt-out request. resend-webhook now detects a
-- strict, rule-based opt-out reply and records it as
-- (event_type 'unsubscribe', source 'inbound_email'). The Phase 4E.2 version
-- of realtoros_record_contact_stop_event rejects that pair, so this
-- migration replaces the function with EXACTLY the 4E.2 body plus two
-- changes, and nothing else:
--
--   a) the source matrix also allows unsubscribe + inbound_email;
--   b) the timeline note for that pair reads
--      'They replied asking to be unsubscribed.'
--
-- Same signature (uuid, text, text, text, text, uuid, timestamptz), so
-- CREATE OR REPLACE keeps it one function: no drop, no new overload.
-- Grants are re-asserted below: service_role only.
--
-- Nothing here activates a rule, enrolls a contact, or sends an email.

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

revoke all on function public.realtoros_record_contact_stop_event(uuid, text, text, text, text, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.realtoros_record_contact_stop_event(uuid, text, text, text, text, uuid, timestamptz) to service_role;

comment on function public.realtoros_record_contact_stop_event(uuid, text, text, text, text, uuid, timestamptz) is
  'service_role-only. The single entry point for a contact stop event (reply | unsubscribe | complaint | hard_bounce) from provider_webhook | unsubscribe_link | inbound_email | owner_manual. Idempotent on (user_id, source, event_ref). Sets the lifecycle marker (earliest wins), revokes email consent and adds a suppression where required, writes one deterministic activity, and stops enrollments per rule flag — all under the contact row lock. outcome=retry means a lock wait timed out and the caller must retry. Phase 4E.3: an unsubscribe may also come from inbound_email (a reply asking to be unsubscribed). Never callable by anon or authenticated.';
