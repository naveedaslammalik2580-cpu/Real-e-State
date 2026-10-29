-- Atomic Google Sheets lead ingestion.
-- Called only by the ingest-sheet-leads Edge Function using the service role.

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
        budget,preferred_area,notes,_sample
      )
      values (
        v_contact_id,v_connection.user_id,v_name,v_email,v_phone,v_type,
        v_status,v_source,v_temperature,v_budget,v_preferred_area,v_notes,false
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

revoke execute on function public.realtoros_ingest_lead_batch(
  uuid,text,text,jsonb
) from public, anon, authenticated;

grant execute on function public.realtoros_ingest_lead_batch(
  uuid,text,text,jsonb
) to service_role;

comment on function public.realtoros_ingest_lead_batch(uuid,text,text,jsonb) is
  'Atomically imports one authenticated Google Sheets batch. Service role only.';
