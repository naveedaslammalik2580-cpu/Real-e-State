-- Removes the legacy sample-data feature from the schema.
--
-- IMPORTANT — READ BEFORE APPLYING. THIS MIGRATION DELETES DATA, AND THAT
-- DELETION IS IRREVERSIBLE:
--   - Every row still explicitly flagged _sample = true (or, for scripts
--     and ai_prompts, is_sample = true) is intentionally deleted, across
--     every account (a migration has no auth.uid() session to scope to,
--     so this is deliberately unscoped by user — it targets every account
--     that still has un-cleared sample rows, not just one).
--   - Every row whose flag is false (i.e. every real, realtor-entered
--     record) is left completely untouched — nothing is deleted based on
--     any criterion other than an explicit true sample flag.
--   - custom_field_values belonging to a deleted sample contact,
--     property, deal, or task are deleted first, matched on both
--     user_id and record_id so cleanup can never cross accounts.
--   - Once the corresponding columns are dropped at the end of this file,
--     there is no remaining way to distinguish sample rows from real
--     ones, or to recover whatever was just deleted, from this schema.
--
-- This migration is a schema/data correction for the sample-data feature
-- removed from the frontend — it is not part of, and has no relationship
-- to, Phase 3A (the separate Google Sheets connector work).
--
-- This file relies on the same execution model every other migration in
-- this repository already relies on: the migration runner applies one
-- file as a single transaction, so a failure on any statement below
-- prevents every later statement — including the column drops — from
-- taking effect. No migration in this repository uses an explicit
-- BEGIN/COMMIT, and adding one here would be inconsistent with that
-- convention (and could conflict with a runner that already wraps the
-- file in its own transaction) without changing the atomicity guarantee.
--
-- Order of operations:
--   1. Delete custom_field_values belonging to flagged sample contacts,
--      properties, deals, and tasks (must happen before step 2 deletes
--      those sample rows, while they can still be matched).
--   2. Delete every row still explicitly flagged as sample, across all
--      tables that carry the flag, in dependency-safe order (the same
--      order the old public.realtoros_clear_sample_data() RPC used).
--   3. Re-create the three RPCs that referenced the sample columns
--      (realtoros_create_deal_with_milestones, realtoros_complete_followup,
--      realtoros_ingest_lead_batch) so they stop reading/writing them —
--      required so those RPCs keep working at all once the columns below
--      are dropped; otherwise every new deal, follow-up, or Google Sheets
--      import would start failing with "column does not exist". Their
--      existing least-privilege grants are re-asserted explicitly.
--   4. Drop the now-unused public.realtoros_clear_sample_data() RPC.
--   5. Drop the _sample / is_sample columns themselves.

-- ---------- 1. Delete custom_field_values for flagged sample records ----------
-- Matched on (user_id, record_id) together, so cleanup can never cross
-- tenant boundaries even though custom_field_values has no direct foreign
-- key to the entity tables (entity_type + record_id is a polymorphic
-- reference, not an FK).

delete from public.custom_field_values cfv
where cfv.entity_type = 'contact'
  and exists (
    select 1 from public.contacts c
    where c.user_id = cfv.user_id and c.id = cfv.record_id and c._sample
  );

delete from public.custom_field_values cfv
where cfv.entity_type = 'property'
  and exists (
    select 1 from public.properties p
    where p.user_id = cfv.user_id and p.id = cfv.record_id and p._sample
  );

delete from public.custom_field_values cfv
where cfv.entity_type = 'deal'
  and exists (
    select 1 from public.deals d
    where d.user_id = cfv.user_id and d.id = cfv.record_id and d._sample
  );

delete from public.custom_field_values cfv
where cfv.entity_type = 'task'
  and exists (
    select 1 from public.tasks t
    where t.user_id = cfv.user_id and t.id = cfv.record_id and t._sample
  );

-- ---------- 2. Delete every explicitly flagged sample row ----------
-- Same dependency order as the old public.realtoros_clear_sample_data(),
-- unscoped by user_id (a migration has no auth.uid() to scope to — this
-- intentionally covers every account). Every table's existing ON DELETE
-- behavior (SET NULL on the child foreign keys defined in
-- 20260829050743_migrate_realtoros_to_relational.sql) is unchanged by
-- this migration; only rows with the flag literally true are removed.

delete from public.activities where _sample;
delete from public.tasks where _sample;
delete from public.showings where _sample;
delete from public.referrals where _sample;
delete from public.milestones where _sample;
delete from public.finance_records where _sample;
delete from public.scheduled_items where _sample;
delete from public.deals where _sample;
delete from public.properties where _sample;
delete from public.contacts where _sample;
delete from public.goals where _sample;
delete from public.scripts where is_sample;
delete from public.ai_prompts where is_sample;

-- ---------- 3. Re-point dependent RPCs away from the sample columns ----------

-- Same as 20260829082546_realtoros_deal_and_followup_rpcs.sql's
-- realtoros_create_deal_with_milestones(), minus all _sample handling.
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
    status, notes, lost_reason
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
    coalesce(p_deal->>'lost_reason','')
  )
  returning * into v_deal;

  for v_milestone in select * from jsonb_array_elements(coalesce(p_milestones, '[]'::jsonb))
  loop
    insert into public.milestones (id, user_id, deal_id, title, order_index, due_date, status, completed, notes)
    values (
      v_milestone->>'id',
      v_uid,
      v_deal.id,
      coalesce(v_milestone->>'title',''),
      coalesce((v_milestone->>'order_index')::int, 99),
      nullif(v_milestone->>'due_date','')::date,
      coalesce(v_milestone->>'status','Pending'),
      coalesce((v_milestone->>'completed')::boolean, false),
      coalesce(v_milestone->>'notes','')
    );
  end loop;

  return jsonb_build_object(
    'deal', to_jsonb(v_deal),
    'milestones', (select coalesce(jsonb_agg(to_jsonb(m)), '[]'::jsonb) from public.milestones m where m.deal_id = v_deal.id and m.user_id = v_uid)
  );
end;
$function$;

-- Re-assert the same least-privilege grants the original migration set:
-- callable only by an authenticated session, never public/anon.
revoke all on function public.realtoros_create_deal_with_milestones(jsonb, jsonb) from public;
revoke all on function public.realtoros_create_deal_with_milestones(jsonb, jsonb) from anon;
grant execute on function public.realtoros_create_deal_with_milestones(jsonb, jsonb) to authenticated;

-- Same as 20260829082546_realtoros_deal_and_followup_rpcs.sql's
-- realtoros_complete_followup(), minus all _sample handling.
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
    id, user_id, type, contact_id, property_id, deal_id, task_id, subject, notes, outcome, date
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
    coalesce((p_activity->>'date')::timestamptz, now())
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

-- Re-assert the same least-privilege grants the original migration set:
-- callable only by an authenticated session, never public/anon.
revoke all on function public.realtoros_complete_followup(jsonb, text, date, date) from public;
revoke all on function public.realtoros_complete_followup(jsonb, text, date, date) from anon;
grant execute on function public.realtoros_complete_followup(jsonb, text, date, date) to authenticated;

-- Same as 20260831093216_add_atomic_sheet_lead_ingestion.sql's
-- realtoros_ingest_lead_batch(), minus the _sample column/value in the
-- new-contact insert. Everything else (validation, hashing, dedup,
-- rate/replay handling) is byte-identical to the original.
create or replace function public.realtoros_ingest_lead_batch(
  p_connection_id uuid,
  p_source_event_id text,
  p_sheet_revision text,
  p_rows jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_connection public.lead_source_connections%rowtype;
  v_existing_batch public.lead_import_batches%rowtype;
  v_batch_id uuid;
  v_row jsonb;
  v_ordinal bigint;
  v_source_key text;
  v_fingerprint text;
  v_name text;
  v_email text;
  v_phone text;
  v_phone_normalized text;
  v_type text;
  v_status text;
  v_source text;
  v_temperature text;
  v_preferred_area text;
  v_notes text;
  v_budget_text text;
  v_budget numeric;
  v_email_hash text;
  v_phone_hash text;
  v_source_contact text;
  v_email_contact text;
  v_phone_contact text;
  v_contact_id text;
  v_is_new boolean;
  v_is_source_link boolean;
  v_error_code text;
  v_error_message text;
  v_total integer;
  v_accepted integer := 0;
  v_duplicates integer := 0;
  v_rejected integer := 0;
  v_imported integer := 0;
  v_final_status text;
begin
  if p_source_event_id is null
     or char_length(btrim(p_source_event_id)) not between 8 and 200 then
    raise exception 'invalid_source_event_id' using errcode = '22023';
  end if;

  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'rows_must_be_an_array' using errcode = '22023';
  end if;

  v_total := jsonb_array_length(p_rows);
  if v_total < 1 or v_total > 500 then
    raise exception 'row_count_must_be_between_1_and_500' using errcode = '22023';
  end if;

  select *
  into v_connection
  from public.lead_source_connections
  where id = p_connection_id
    and status = 'active'
  for update;

  if not found then
    raise exception 'active_connection_not_found' using errcode = 'P0002';
  end if;

  -- Serialize imports per RealtorOS owner so two different sheets cannot
  -- create separate contacts for the same hashed email/phone concurrently.
  perform pg_advisory_xact_lock(
    hashtextextended(v_connection.user_id::text, 824733)
  );

  insert into public.lead_import_batches (
    user_id,
    connection_id,
    source_event_id,
    sheet_revision,
    status,
    source_row_count,
    started_at
  )
  values (
    v_connection.user_id,
    v_connection.id,
    btrim(p_source_event_id),
    nullif(btrim(coalesce(p_sheet_revision, '')), ''),
    'processing',
    v_total,
    now()
  )
  on conflict (user_id, connection_id, source_event_id) do nothing
  returning id into v_batch_id;

  if v_batch_id is null then
    select *
    into strict v_existing_batch
    from public.lead_import_batches
    where user_id = v_connection.user_id
      and connection_id = v_connection.id
      and source_event_id = btrim(p_source_event_id);

    return jsonb_build_object(
      'batch_id', v_existing_batch.id,
      'status', v_existing_batch.status,
      'source_row_count', v_existing_batch.source_row_count,
      'accepted_count', v_existing_batch.accepted_count,
      'duplicate_count', v_existing_batch.duplicate_count,
      'rejected_count', v_existing_batch.rejected_count,
      'imported_count', v_existing_batch.imported_count,
      'replayed', true
    );
  end if;

  for v_row, v_ordinal in
    select value, ordinality
    from jsonb_array_elements(p_rows) with ordinality
  loop
    v_fingerprint := encode(
      extensions.digest(convert_to(v_row::text, 'UTF8'), 'sha256'),
      'hex'
    );
    v_error_code := null;
    v_error_message := null;

    if jsonb_typeof(v_row) <> 'object' then
      v_source_key := 'invalid:' || v_ordinal || ':' || left(v_fingerprint, 16);
      v_error_code := 'row_not_object';
      v_error_message := 'The row must be a JSON object.';
    else
      v_source_key := left(btrim(coalesce(v_row ->> 'lead_id', '')), 200);
      v_name := left(btrim(coalesce(v_row ->> 'full_name', '')), 200);
      v_email := left(lower(btrim(coalesce(v_row ->> 'email', ''))), 320);
      v_phone := left(btrim(coalesce(v_row ->> 'phone', '')), 100);
      v_phone_normalized := nullif(
        regexp_replace(v_phone, '[^0-9]+', '', 'g'),
        ''
      );
      v_type := left(btrim(coalesce(nullif(v_row ->> 'type', ''), 'Buyer')), 100);
      v_status := left(btrim(coalesce(nullif(v_row ->> 'status', ''), 'New Lead')), 100);
      v_source := left(btrim(coalesce(nullif(v_row ->> 'source', ''), 'Google Sheets')), 100);
      v_temperature := left(btrim(coalesce(nullif(v_row ->> 'temperature', ''), 'Warm')), 100);
      v_preferred_area := left(btrim(coalesce(v_row ->> 'preferred_area', '')), 300);
      v_notes := left(btrim(coalesce(v_row ->> 'notes', '')), 10000);
      v_budget_text := regexp_replace(
        btrim(coalesce(v_row ->> 'budget', '')),
        '[,$[:space:]]+',
        '',
        'g'
      );

      if v_budget_text ~ '^[0-9]+([.][0-9]{1,2})?$' then
        v_budget := v_budget_text::numeric;
      else
        v_budget := 0;
      end if;

      if v_source_key = '' then
        v_source_key := 'invalid:' || v_ordinal || ':' || left(v_fingerprint, 16);
        v_error_code := 'missing_lead_id';
        v_error_message := 'lead_id is required.';
      elsif v_name = '' then
        v_error_code := 'missing_full_name';
        v_error_message := 'full_name is required.';
      elsif v_email = '' and v_phone_normalized is null then
        v_error_code := 'missing_contact_channel';
        v_error_message := 'At least one of email or phone is required.';
      end if;
    end if;

    if v_error_code is not null then
      insert into public.lead_import_rows (
        user_id,
        batch_id,
        connection_id,
        source_row_key,
        source_row_number,
        row_fingerprint,
        status,
        error_code,
        error_message,
        error_context,
        last_seen_at
      )
      values (
        v_connection.user_id,
        v_batch_id,
        v_connection.id,
        v_source_key,
        v_ordinal::integer,
        v_fingerprint,
        'rejected',
        v_error_code,
        v_error_message,
        jsonb_build_object('row_number', v_ordinal),
        now()
      )
      on conflict (user_id, connection_id, source_row_key)
      do update set
        batch_id = excluded.batch_id,
        source_row_number = excluded.source_row_number,
        row_fingerprint = excluded.row_fingerprint,
        contact_id = null,
        status = excluded.status,
        error_code = excluded.error_code,
        error_message = excluded.error_message,
        error_context = excluded.error_context,
        last_seen_at = now();

      v_rejected := v_rejected + 1;
      continue;
    end if;

    v_email_hash := case
      when v_email = '' then null
      else encode(extensions.digest(convert_to(v_email, 'UTF8'), 'sha256'), 'hex')
    end;
    v_phone_hash := case
      when v_phone_normalized is null then null
      else encode(extensions.digest(convert_to(v_phone_normalized, 'UTF8'), 'sha256'), 'hex')
    end;

    v_source_contact := null;
    v_email_contact := null;
    v_phone_contact := null;

    select contact_id
    into v_source_contact
    from public.lead_import_rows
    where user_id = v_connection.user_id
      and connection_id = v_connection.id
      and source_row_key = v_source_key;

    if v_email_hash is not null then
      select contact_id
      into v_email_contact
      from public.contact_identity_keys
      where user_id = v_connection.user_id
        and identity_type = 'email'
        and identity_hash = v_email_hash;
    end if;

    if v_phone_hash is not null then
      select contact_id
      into v_phone_contact
      from public.contact_identity_keys
      where user_id = v_connection.user_id
        and identity_type = 'phone'
        and identity_hash = v_phone_hash;
    end if;

    if (v_email_contact is not null and v_phone_contact is not null
        and v_email_contact <> v_phone_contact)
       or (v_source_contact is not null and v_email_contact is not null
           and v_source_contact <> v_email_contact)
       or (v_source_contact is not null and v_phone_contact is not null
           and v_source_contact <> v_phone_contact) then
      insert into public.lead_import_rows (
        user_id,batch_id,connection_id,source_row_key,source_row_number,
        row_fingerprint,status,error_code,error_message,error_context,last_seen_at
      )
      values (
        v_connection.user_id,v_batch_id,v_connection.id,v_source_key,
        v_ordinal::integer,v_fingerprint,'rejected','identity_conflict',
        'The supplied email and phone resolve to different existing contacts.',
        jsonb_build_object('row_number', v_ordinal),now()
      )
      on conflict (user_id, connection_id, source_row_key)
      do update set
        batch_id = excluded.batch_id,
        source_row_number = excluded.source_row_number,
        row_fingerprint = excluded.row_fingerprint,
        contact_id = null,
        status = excluded.status,
        error_code = excluded.error_code,
        error_message = excluded.error_message,
        error_context = excluded.error_context,
        last_seen_at = now();

      v_rejected := v_rejected + 1;
      continue;
    end if;

    v_contact_id := coalesce(v_source_contact, v_email_contact, v_phone_contact);
    v_is_new := v_contact_id is null;
    v_is_source_link := v_source_contact is not null;

    if v_is_new then
      v_contact_id := 'ct_' || replace(gen_random_uuid()::text, '-', '');

      insert into public.contacts (
        id,user_id,full_name,email,phone,type,status,source,temperature,
        budget,preferred_area,notes
      )
      values (
        v_contact_id,v_connection.user_id,v_name,v_email,v_phone,v_type,
        v_status,v_source,v_temperature,v_budget,v_preferred_area,v_notes
      );
    elsif v_is_source_link then
      update public.contacts
      set
        full_name = v_name,
        email = v_email,
        phone = v_phone,
        type = v_type,
        source = v_source,
        temperature = v_temperature,
        budget = v_budget,
        preferred_area = v_preferred_area,
        notes = v_notes
      where user_id = v_connection.user_id
        and id = v_contact_id;
    else
      update public.contacts
      set
        full_name = case when full_name = '' then v_name else full_name end,
        email = case when email = '' then v_email else email end,
        phone = case when phone = '' then v_phone else phone end,
        source = case when source = '' or source = 'Other' then v_source else source end,
        preferred_area = case when preferred_area = '' then v_preferred_area else preferred_area end
      where user_id = v_connection.user_id
        and id = v_contact_id;
    end if;

    if v_email_hash is not null then
      insert into public.contact_identity_keys (
        user_id,contact_id,identity_type,identity_hash,identity_hint,source
      )
      values (
        v_connection.user_id,v_contact_id,'email',v_email_hash,
        left(v_email, 2) || '***','google_sheets'
      )
      on conflict (user_id, identity_type, identity_hash) do nothing;
    end if;

    if v_phone_hash is not null then
      insert into public.contact_identity_keys (
        user_id,contact_id,identity_type,identity_hash,identity_hint,source
      )
      values (
        v_connection.user_id,v_contact_id,'phone',v_phone_hash,
        '***' || right(v_phone_normalized, 4),'google_sheets'
      )
      on conflict (user_id, identity_type, identity_hash) do nothing;
    end if;

    insert into public.lead_import_rows (
      user_id,batch_id,connection_id,contact_id,source_row_key,
      source_row_number,row_fingerprint,status,error_context,last_seen_at
    )
    values (
      v_connection.user_id,v_batch_id,v_connection.id,v_contact_id,
      v_source_key,v_ordinal::integer,v_fingerprint,
      case when v_is_new then 'imported' else 'duplicate' end,
      '{}'::jsonb,now()
    )
    on conflict (user_id, connection_id, source_row_key)
    do update set
      batch_id = excluded.batch_id,
      contact_id = excluded.contact_id,
      source_row_number = excluded.source_row_number,
      row_fingerprint = excluded.row_fingerprint,
      status = excluded.status,
      error_code = null,
      error_message = null,
      error_context = '{}'::jsonb,
      last_seen_at = now();

    if v_is_new then
      v_accepted := v_accepted + 1;
      v_imported := v_imported + 1;
    else
      v_duplicates := v_duplicates + 1;
    end if;
  end loop;

  v_final_status := case
    when v_rejected = v_total then 'failed'
    when v_rejected > 0 then 'partial'
    else 'completed'
  end;

  update public.lead_import_batches
  set
    status = v_final_status,
    accepted_count = v_accepted,
    duplicate_count = v_duplicates,
    rejected_count = v_rejected,
    imported_count = v_imported,
    completed_at = now(),
    error_summary = case
      when v_rejected > 0 then v_rejected || ' row(s) rejected'
      else null
    end
  where id = v_batch_id
    and user_id = v_connection.user_id;

  update public.lead_source_connections
  set
    last_synced_at = now(),
    last_error = case
      when v_rejected = v_total then 'All submitted rows were rejected.'
      else null
    end
  where id = v_connection.id
    and user_id = v_connection.user_id;

  return jsonb_build_object(
    'batch_id', v_batch_id,
    'status', v_final_status,
    'source_row_count', v_total,
    'accepted_count', v_accepted,
    'duplicate_count', v_duplicates,
    'rejected_count', v_rejected,
    'imported_count', v_imported,
    'replayed', false
  );
end;
$$;

-- Re-assert the same least-privilege grants the original migration set:
-- callable only by the service role (this Edge Function authenticates the
-- caller itself via the connector token, not a Supabase user session),
-- never public/anon/authenticated.
revoke execute on function public.realtoros_ingest_lead_batch(
  uuid,text,text,jsonb
) from public, anon, authenticated;
grant execute on function public.realtoros_ingest_lead_batch(
  uuid,text,text,jsonb
) to service_role;

-- ---------- 4. Drop the now-unused RPC ----------
drop function if exists public.realtoros_clear_sample_data();

-- ---------- 5. Drop the sample-flag columns themselves ----------
-- Tables using boolean "_sample":
alter table public.contacts        drop column if exists _sample;
alter table public.properties      drop column if exists _sample;
alter table public.deals           drop column if exists _sample;
alter table public.milestones      drop column if exists _sample;
alter table public.tasks           drop column if exists _sample;
alter table public.activities      drop column if exists _sample;
alter table public.showings        drop column if exists _sample;
alter table public.referrals       drop column if exists _sample;
alter table public.goals           drop column if exists _sample;
alter table public.finance_records drop column if exists _sample;
alter table public.scheduled_items drop column if exists _sample;

-- Tables using boolean "is_sample":
alter table public.scripts     drop column if exists is_sample;
alter table public.ai_prompts  drop column if exists is_sample;
