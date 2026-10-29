-- Two narrowly-scoped, SECURITY INVOKER RPCs for the two multi-row writes the
-- client cannot otherwise perform atomically. Both enforce auth.uid()
-- ownership on every row they touch (RLS still applies under SECURITY
-- INVOKER), are stripped of EXECUTE for public/anon, and granted only to
-- authenticated. IDs are generated client-side (same uid() convention as
-- every other record) and passed in, so no extension/schema dependency for
-- id generation is introduced here.

create or replace function public.realtoros_create_deal_with_milestones(
  p_deal jsonb,
  p_milestones jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_deal public.deals;
  v_milestone jsonb;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;
  if p_deal->>'id' is null or p_deal->>'id' = '' then
    raise exception 'Deal id is required';
  end if;

  insert into public.deals (
    id, user_id, title, contact_id, property_id, assigned_to_id, side, stage,
    probability, offer_date, contract_date, expected_close, value,
    commission_rate, team_split, brokerage_fee, referral_fee, tax_reserve,
    status, notes, lost_reason, _sample
  ) values (
    p_deal->>'id', v_uid,
    coalesce(p_deal->>'title',''),
    nullif(p_deal->>'contact_id',''),
    nullif(p_deal->>'property_id',''),
    nullif(p_deal->>'assigned_to_id',''),
    coalesce(p_deal->>'side','Buyer'),
    coalesce(p_deal->>'stage','New'),
    coalesce((p_deal->>'probability')::numeric, 10),
    nullif(p_deal->>'offer_date','')::date,
    nullif(p_deal->>'contract_date','')::date,
    nullif(p_deal->>'expected_close','')::date,
    coalesce((p_deal->>'value')::numeric, 0),
    coalesce((p_deal->>'commission_rate')::numeric, 0),
    coalesce((p_deal->>'team_split')::numeric, 0),
    coalesce((p_deal->>'brokerage_fee')::numeric, 0),
    coalesce((p_deal->>'referral_fee')::numeric, 0),
    coalesce((p_deal->>'tax_reserve')::numeric, 0),
    coalesce(p_deal->>'status','active'),
    coalesce(p_deal->>'notes',''),
    coalesce(p_deal->>'lost_reason',''),
    coalesce((p_deal->>'_sample')::boolean, false)
  )
  returning * into v_deal;

  for v_milestone in select * from jsonb_array_elements(coalesce(p_milestones, '[]'::jsonb))
  loop
    insert into public.milestones (id, user_id, deal_id, title, order_index, due_date, status, completed, notes, _sample)
    values (
      v_milestone->>'id',
      v_uid,
      v_deal.id,
      coalesce(v_milestone->>'title',''),
      coalesce((v_milestone->>'order_index')::int, 99),
      nullif(v_milestone->>'due_date','')::date,
      coalesce(v_milestone->>'status','Pending'),
      coalesce((v_milestone->>'completed')::boolean, false),
      coalesce(v_milestone->>'notes',''),
      v_deal._sample
    );
  end loop;

  return jsonb_build_object(
    'deal', to_jsonb(v_deal),
    'milestones', (select coalesce(jsonb_agg(to_jsonb(m)), '[]'::jsonb) from public.milestones m where m.deal_id = v_deal.id and m.user_id = v_uid)
  );
end;
$function$;

revoke all on function public.realtoros_create_deal_with_milestones(jsonb, jsonb) from public;
revoke all on function public.realtoros_create_deal_with_milestones(jsonb, jsonb) from anon;
grant execute on function public.realtoros_create_deal_with_milestones(jsonb, jsonb) to authenticated;

create or replace function public.realtoros_complete_followup(
  p_activity jsonb,
  p_contact_id text,
  p_last_contact date,
  p_next_follow_up date
)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_uid uuid := (select auth.uid());
  v_activity public.activities;
  v_contact public.contacts;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;
  if p_activity->>'id' is null or p_activity->>'id' = '' then
    raise exception 'Activity id is required';
  end if;
  if p_contact_id is null or p_contact_id = '' then
    raise exception 'Contact id is required';
  end if;

  insert into public.activities (
    id, user_id, type, contact_id, property_id, deal_id, task_id, subject, notes, outcome, date, _sample
  ) values (
    p_activity->>'id', v_uid,
    coalesce(p_activity->>'type','Note'),
    nullif(p_activity->>'contact_id',''),
    nullif(p_activity->>'property_id',''),
    nullif(p_activity->>'deal_id',''),
    nullif(p_activity->>'task_id',''),
    coalesce(p_activity->>'subject',''),
    coalesce(p_activity->>'notes',''),
    coalesce(p_activity->>'outcome',''),
    coalesce((p_activity->>'date')::timestamptz, now()),
    coalesce((p_activity->>'_sample')::boolean, false)
  )
  returning * into v_activity;

  update public.contacts
  set last_contact = p_last_contact,
      next_follow_up = p_next_follow_up
  where id = p_contact_id and user_id = v_uid
  returning * into v_contact;

  if v_contact.id is null then
    raise exception 'Contact not found or not owned by current user';
  end if;

  return jsonb_build_object('activity', to_jsonb(v_activity), 'contact', to_jsonb(v_contact));
end;
$function$;

revoke all on function public.realtoros_complete_followup(jsonb, text, date, date) from public;
revoke all on function public.realtoros_complete_followup(jsonb, text, date, date) from anon;
grant execute on function public.realtoros_complete_followup(jsonb, text, date, date) to authenticated;
