-- REVERT for Phase T2c (the team-aware backend).
--
-- NOT a migration. Lives in supabase/rollback/ and is never applied as
-- part of the chain. Run it only to undo T2c (20261006132041).
--
-- HOW THIS WAS GENERATED, and the one caveat.
--
-- T2c was already applied to live when this file was asked for, so the
-- pre-T2c definitions were no longer on the server to copy. They were
-- taken instead from the authoritative source: the repo's own migration
-- chain, replayed in PGlite up to but excluding T2c. Every CREATE OR
-- REPLACE below is the pg_get_functiondef() text of that pre-T2c state,
-- not retyped by hand.
--
-- The file is then PROVEN rather than trusted: applying it to a
-- full-chain database must reproduce the pre-T2c state exactly, compared
-- by md5(prosrc) per function. The pre-T2c body checksums are recorded
-- beside each function below, and the verification block at the end
-- re-checks them at run time and raises if any differs.
--
-- WHAT IT RESTORES
--
--   * the 9 functions T2c replaced, including the 8-argument
--     automation_internal.ingest_lead_rows (per-user de-duplication);
--   * the 4 unique CONSTRAINTS and 2 unique INDEXES T2c dropped;
--   * and it drops the 10 functions and 12 indexes T2c introduced.
--
-- WHAT IT DOES NOT TOUCH
--
--   * T2c-pre's foreign keys. Those are a separate phase with their own
--     revert (t2c_pre_revert_fks.sql). Running this file alone leaves the
--     database in the state it was in after T2c-pre and before T2c,
--     which is a coherent, tested state: FKs keyed on workspace_id,
--     uniqueness and import logic keyed on user_id.
--   * any data. Nothing here inserts, updates or deletes a row.
--
-- WHEN IT WILL FAIL, AND WHY THAT IS RIGHT
--
-- Restoring the user-scoped UNIQUE constraints fails if, by then, a
-- workspace holds two rows that differ only by creator - exactly what
-- T2c's workspace-wide de-duplication is designed to prevent, and what a
-- real team would start producing. That failure means genuine
-- cross-member data exists and reverting would have to decide what to
-- merge. Do not force it.

set search_path = public;

begin;

-- ============================================================
-- 1. Restore the 9 functions T2c replaced.
--
-- CREATE OR REPLACE keeps existing grants, so nothing has to be
-- re-granted here except on ingest_lead_rows, which T2c dropped
-- outright (section 2).
-- ============================================================
-- === automation_internal.ingest_lead_rows(p_user_id uuid, p_connection_id uuid, p_batch_id uuid, p_rows jsonb, p_source_type text, p_start_automation boolean, p_new_contact_allowance integer, p_limit_message text)  body md5 1bfcaf5fa10f7013a8c0193a9ab988cb
CREATE OR REPLACE FUNCTION automation_internal.ingest_lead_rows(p_user_id uuid, p_connection_id uuid, p_batch_id uuid, p_rows jsonb, p_source_type text, p_start_automation boolean, p_new_contact_allowance integer, p_limit_message text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_is_file boolean;
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
  v_source_given boolean;
  v_temperature text;
  v_preferred_area text;
  v_notes text;
  v_tags text[];
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
  v_dup_of integer;
  v_changed integer;
  v_row_context jsonb;
  v_accepted integer := 0;
  v_duplicates integer := 0;
  v_rejected integer := 0;
  v_imported integer := 0;
  v_updated integer := 0;
  v_unchanged integer := 0;
  v_in_file_dups integer := 0;
  v_limited integer := 0;
  v_allowance_left integer;
  v_problems jsonb := '[]'::jsonb;
begin
  if p_source_type is null or p_source_type not in ('google_sheet', 'file_upload') then
    raise exception 'invalid_source_type' using errcode = '22023';
  end if;
  v_is_file := p_source_type = 'file_upload';
  if v_is_file and p_connection_id is not null then
    raise exception 'file_upload_has_no_connection' using errcode = '22023';
  end if;
  if not v_is_file and p_connection_id is null then
    raise exception 'google_sheet_requires_connection' using errcode = '22023';
  end if;
  if v_is_file and (p_new_contact_allowance is null or p_new_contact_allowance < 0
                    or coalesce(p_limit_message, '') = '') then
    raise exception 'file_upload_requires_allowance' using errcode = '22023';
  end if;
  if not v_is_file and (p_new_contact_allowance is not null or p_limit_message is not null) then
    raise exception 'google_sheet_has_no_allowance' using errcode = '22023';
  end if;
  v_allowance_left := p_new_contact_allowance;

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
      v_error_message := case when v_is_file
        then 'This row could not be read.'
        else 'The row must be a JSON object.' end;
      if v_is_file then
        v_source_key := 'file:' || p_batch_id || ':' || v_ordinal;
      end if;
    else
      if v_is_file then
        v_source_key := 'file:' || p_batch_id || ':' || v_ordinal;
      else
        v_source_key := left(btrim(coalesce(v_row ->> 'lead_id', '')), 200);
      end if;
      v_name := left(btrim(coalesce(v_row ->> 'full_name', '')), 200);
      v_email := left(lower(btrim(coalesce(v_row ->> 'email', ''))), 320);
      v_phone := left(btrim(coalesce(v_row ->> 'phone', '')), 100);
      v_phone_normalized := nullif(
        regexp_replace(v_phone, '[^0-9]+', '', 'g'),
        ''
      );
      v_type := left(btrim(coalesce(nullif(v_row ->> 'type', ''), 'Buyer')), 100);
      v_status := left(btrim(coalesce(nullif(v_row ->> 'status', ''), 'New Lead')), 100);
      v_source_given := btrim(coalesce(v_row ->> 'source', '')) <> '';
      v_source := left(btrim(coalesce(nullif(v_row ->> 'source', ''),
        case when v_is_file then 'File import' else 'Google Sheets' end)), 100);
      v_temperature := left(btrim(coalesce(nullif(v_row ->> 'temperature', ''), 'Warm')), 100);
      v_preferred_area := left(btrim(coalesce(v_row ->> 'preferred_area', '')), 300);
      v_notes := left(btrim(coalesce(v_row ->> 'notes', '')), 10000);
      v_tags := '{}'::text[];
      if v_is_file and jsonb_typeof(v_row -> 'tags') = 'array' then
        select coalesce(array_agg(t order by ord), '{}'::text[]) into v_tags
        from (
          select left(btrim(value), 50) as t, min(ordinality) as ord
          from jsonb_array_elements_text(v_row -> 'tags') with ordinality
          where btrim(value) <> ''
          group by left(btrim(value), 50)
          order by min(ordinality)
          limit 20
        ) tag_list;
      end if;
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

      if v_is_file then
        if v_row ? '_invalid' then
          v_error_code := case when v_row ->> '_invalid' in
            ('missing_contact_channel', 'invalid_email', 'invalid_phone', 'row_not_object')
            then v_row ->> '_invalid' else 'row_not_object' end;
        elsif v_email = '' and v_phone_normalized is null then
          v_error_code := 'missing_contact_channel';
        elsif v_email <> '' and (
          char_length(v_email) > 254
          or v_email !~ '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
        ) then
          v_error_code := 'invalid_email';
        elsif v_phone_normalized is not null
          and char_length(v_phone_normalized) not between 7 and 15 then
          v_error_code := 'invalid_phone';
        end if;
        v_error_message := case v_error_code
          when 'missing_contact_channel' then 'Needs an email address or a phone number.'
          when 'invalid_email' then 'The email address doesn''t look right.'
          when 'invalid_phone' then 'The phone number doesn''t look right.'
          when 'row_not_object' then 'This row could not be read.'
          else null end;
      elsif v_source_key = '' then
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
        source_type,
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
        p_user_id,
        p_batch_id,
        p_connection_id,
        p_source_type,
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
      v_problems := v_problems || jsonb_build_object(
        'row_number', v_ordinal, 'code', v_error_code, 'message', v_error_message);
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

    -- A Sheet row is linked to its contact by lead_id; a file row never is.
    if not v_is_file then
      select contact_id
      into v_source_contact
      from public.lead_import_rows
      where user_id = p_user_id
        and connection_id = p_connection_id
        and source_row_key = v_source_key;
    end if;

    if v_email_hash is not null then
      select contact_id
      into v_email_contact
      from public.contact_identity_keys
      where user_id = p_user_id
        and identity_type = 'email'
        and identity_hash = v_email_hash;
    end if;

    if v_phone_hash is not null then
      select contact_id
      into v_phone_contact
      from public.contact_identity_keys
      where user_id = p_user_id
        and identity_type = 'phone'
        and identity_hash = v_phone_hash;
    end if;

    -- File only: contacts the owner typed in by hand (or created before
    -- imports kept identity keys) have no identity key yet, so also match
    -- on the contact's own stored email / phone, normalized the same way.
    -- The identity keys written below then make future matches direct.
    -- Sheet imports keep their original identity-key-only matching.
    -- These two queries match contacts_user_email_norm_idx and
    -- contacts_user_phone_norm_idx exactly (expression and predicate).
    if v_is_file then
      if v_email_contact is null and v_email <> '' then
        select id into v_email_contact
        from public.contacts
        where user_id = p_user_id and email <> '' and lower(btrim(email)) = v_email
        order by created_at, id
        limit 1;
      end if;
      if v_phone_contact is null and v_phone_normalized is not null then
        select id into v_phone_contact
        from public.contacts
        where user_id = p_user_id and phone <> ''
          and regexp_replace(phone, '[^0-9]+', '', 'g') = v_phone_normalized
        order by created_at, id
        limit 1;
      end if;
    end if;

    if (v_email_contact is not null and v_phone_contact is not null
        and v_email_contact <> v_phone_contact)
       or (v_source_contact is not null and v_email_contact is not null
           and v_source_contact <> v_email_contact)
       or (v_source_contact is not null and v_phone_contact is not null
           and v_source_contact <> v_phone_contact) then
      v_error_message := case when v_is_file
        then 'The email and phone number belong to two different existing contacts.'
        else 'The supplied email and phone resolve to different existing contacts.' end;
      insert into public.lead_import_rows (
        user_id,batch_id,connection_id,source_type,source_row_key,source_row_number,
        row_fingerprint,status,error_code,error_message,error_context,last_seen_at
      )
      values (
        p_user_id,p_batch_id,p_connection_id,p_source_type,v_source_key,
        v_ordinal::integer,v_fingerprint,'rejected','identity_conflict',
        v_error_message,
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
      v_problems := v_problems || jsonb_build_object(
        'row_number', v_ordinal, 'code', 'identity_conflict', 'message', v_error_message);
      continue;
    end if;

    v_contact_id := coalesce(v_source_contact, v_email_contact, v_phone_contact);
    v_is_new := v_contact_id is null;
    v_is_source_link := v_source_contact is not null;
    v_row_context := '{}'::jsonb;

    -- File only: the same person twice in one file is imported once.
    if v_is_file and not v_is_new then
      select source_row_number into v_dup_of
      from public.lead_import_rows
      where user_id = p_user_id and batch_id = p_batch_id and contact_id = v_contact_id
      order by source_row_number
      limit 1;
      if found then
        v_error_message := 'Same person as row ' || v_dup_of || ' — skipped.';
        insert into public.lead_import_rows (
          user_id,batch_id,connection_id,source_type,contact_id,source_row_key,
          source_row_number,row_fingerprint,status,error_code,error_message,error_context,last_seen_at
        )
        values (
          p_user_id,p_batch_id,null,p_source_type,v_contact_id,v_source_key,
          v_ordinal::integer,v_fingerprint,'duplicate','duplicate_in_file',v_error_message,
          jsonb_build_object('row_number', v_ordinal, 'outcome', 'duplicate_in_file', 'duplicate_of_row', v_dup_of),
          now()
        );
        v_duplicates := v_duplicates + 1;
        v_in_file_dups := v_in_file_dups + 1;
        v_problems := v_problems || jsonb_build_object(
          'row_number', v_ordinal, 'code', 'duplicate_in_file', 'message', v_error_message);
        continue;
      end if;
    end if;

    -- File only: the daily allowance of new contacts is used up. The row
    -- is recorded (so Import History shows why) but creates nothing.
    if v_is_file and v_is_new and v_allowance_left <= 0 then
      insert into public.lead_import_rows (
        user_id,batch_id,connection_id,source_type,source_row_key,source_row_number,
        row_fingerprint,status,error_code,error_message,error_context,last_seen_at
      )
      values (
        p_user_id,p_batch_id,null,p_source_type,v_source_key,v_ordinal::integer,
        v_fingerprint,'rejected','daily_limit_reached',p_limit_message,
        jsonb_build_object('row_number', v_ordinal),now()
      );
      v_rejected := v_rejected + 1;
      v_limited := v_limited + 1;
      v_problems := v_problems || jsonb_build_object(
        'row_number', v_ordinal, 'code', 'daily_limit_reached', 'message', p_limit_message);
      continue;
    end if;

    if v_is_new then
      v_contact_id := 'ct_' || replace(gen_random_uuid()::text, '-', '');

      if v_is_file then
        insert into public.contacts (
          id,user_id,full_name,email,phone,type,status,source,temperature,
          budget,preferred_area,notes,tags
        )
        values (
          v_contact_id,p_user_id,v_name,v_email,v_phone,v_type,
          v_status,v_source,v_temperature,v_budget,v_preferred_area,v_notes,v_tags
        );

        v_allowance_left := v_allowance_left - 1;

        -- Automation off: the 'contact_created' event the insert trigger
        -- just wrote is cancelled before this transaction commits, so it is
        -- never visible to the worker as pending.
        if not coalesce(p_start_automation, false) then
          update public.automation_trigger_events
            set status = 'cancelled',
                processed_at = now(),
                last_error = 'Imported from a file without automated follow-up.'
            where user_id = p_user_id
              and contact_id = v_contact_id
              and event_type = 'contact_created'
              and status = 'pending';
        end if;
      else
        insert into public.contacts (
          id,user_id,full_name,email,phone,type,status,source,temperature,
          budget,preferred_area,notes
        )
        values (
          v_contact_id,p_user_id,v_name,v_email,v_phone,v_type,
          v_status,v_source,v_temperature,v_budget,v_preferred_area,v_notes
        );
      end if;
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
      where user_id = p_user_id
        and id = v_contact_id;
    elsif v_is_file then
      -- Fill only the existing contact's EMPTY fields; never overwrite.
      -- Touches the row only when something would actually change.
      update public.contacts
      set
        full_name = case when full_name = '' then v_name else full_name end,
        email = case when email = '' then v_email else email end,
        phone = case when phone = '' then v_phone else phone end,
        source = case when v_source_given and (source = '' or source = 'Other') then v_source else source end,
        preferred_area = case when preferred_area = '' then v_preferred_area else preferred_area end,
        notes = case when notes = '' then v_notes else notes end,
        budget = case when budget = 0 then v_budget else budget end,
        tags = case when tags = '{}'::text[] then v_tags else tags end
      where user_id = p_user_id
        and id = v_contact_id
        and (
          (full_name = '' and v_name <> '')
          or (email = '' and v_email <> '')
          or (phone = '' and v_phone <> '')
          or (v_source_given and (source = '' or source = 'Other') and source <> v_source)
          or (preferred_area = '' and v_preferred_area <> '')
          or (notes = '' and v_notes <> '')
          or (budget = 0 and v_budget <> 0)
          or (tags = '{}'::text[] and v_tags <> '{}'::text[])
        );
      get diagnostics v_changed = row_count;
      v_row_context := jsonb_build_object('outcome', case when v_changed = 1 then 'updated' else 'unchanged' end);
      if v_changed = 1 then v_updated := v_updated + 1; else v_unchanged := v_unchanged + 1; end if;
    else
      update public.contacts
      set
        full_name = case when full_name = '' then v_name else full_name end,
        email = case when email = '' then v_email else email end,
        phone = case when phone = '' then v_phone else phone end,
        source = case when source = '' or source = 'Other' then v_source else source end,
        preferred_area = case when preferred_area = '' then v_preferred_area else preferred_area end
      where user_id = p_user_id
        and id = v_contact_id;
    end if;

    if v_email_hash is not null then
      insert into public.contact_identity_keys (
        user_id,contact_id,identity_type,identity_hash,identity_hint,source
      )
      values (
        p_user_id,v_contact_id,'email',v_email_hash,
        left(v_email, 2) || '***',
        case when v_is_file then 'file_upload' else 'google_sheets' end
      )
      on conflict (user_id, identity_type, identity_hash) do nothing;
    end if;

    if v_phone_hash is not null then
      insert into public.contact_identity_keys (
        user_id,contact_id,identity_type,identity_hash,identity_hint,source
      )
      values (
        p_user_id,v_contact_id,'phone',v_phone_hash,
        '***' || right(v_phone_normalized, 4),
        case when v_is_file then 'file_upload' else 'google_sheets' end
      )
      on conflict (user_id, identity_type, identity_hash) do nothing;
    end if;

    insert into public.lead_import_rows (
      user_id,batch_id,connection_id,source_type,contact_id,source_row_key,
      source_row_number,row_fingerprint,status,error_context,last_seen_at
    )
    values (
      p_user_id,p_batch_id,p_connection_id,p_source_type,v_contact_id,
      v_source_key,v_ordinal::integer,v_fingerprint,
      case when v_is_new then 'imported' else 'duplicate' end,
      v_row_context,now()
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

  return jsonb_build_object(
    'accepted_count', v_accepted,
    'duplicate_count', v_duplicates,
    'rejected_count', v_rejected,
    'imported_count', v_imported,
    'updated_count', v_updated,
    'unchanged_count', v_unchanged,
    'in_file_duplicate_count', v_in_file_dups,
    'daily_limit_skipped_count', v_limited,
    'problems', v_problems
  );
end;
$function$;

-- === automation_internal.notify(p_user_id uuid, p_type text, p_title text, p_body text, p_contact_id text, p_link_route text, p_dedupe_key text, p_metadata jsonb)  body md5 def077564da47207b6a7c977182c60c8
CREATE OR REPLACE FUNCTION automation_internal.notify(p_user_id uuid, p_type text, p_title text, p_body text, p_contact_id text, p_link_route text, p_dedupe_key text, p_metadata jsonb DEFAULT '{}'::jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_id uuid;
begin
  insert into public.notifications (
    user_id, type, title, body, contact_id, link_route, dedupe_key, metadata
  ) values (
    p_user_id,
    p_type,
    left(btrim(regexp_replace(coalesce(p_title, ''), '[[:cntrl:]]+', ' ', 'g')), 200),
    left(btrim(regexp_replace(coalesce(p_body, ''), '[[:cntrl:]]+', ' ', 'g')), 1000),
    p_contact_id,
    p_link_route,
    p_dedupe_key,
    coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (user_id, dedupe_key) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.notifications
    where user_id = p_user_id and dedupe_key = p_dedupe_key;
  end if;
  return v_id;
end;
$function$;

-- === automation_internal.notify_on_stop_event()  body md5 8b250d6ab86d845713dfb885948b38d6
CREATE OR REPLACE FUNCTION automation_internal.notify_on_stop_event()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_name text;
  v_who text;
  v_type text;
  v_title text;
  v_body text;
begin
  -- The owner did this themselves; telling them about it is noise.
  if new.source = 'owner_manual' and new.event_type in ('reply', 'unsubscribe') then
    return null;
  end if;

  begin
    v_name := automation_internal.notification_contact_name(new.user_id, new.contact_id);
    v_who := coalesce(v_name, 'A contact');

    if new.event_type = 'reply' then
      v_type := 'lead_replied';
      v_title := v_who || ' replied to your follow-up';
      v_body := 'Their reply is in your email inbox. Automations set to stop when a contact replies have stopped for them.';
    elsif new.event_type = 'unsubscribe' then
      v_type := 'unsubscribed';
      v_title := v_who || ' unsubscribed from your follow-up emails';
      v_body := case new.source
        when 'unsubscribe_link' then 'They used the unsubscribe link in a follow-up email.'
        when 'inbound_email' then 'They replied asking to be unsubscribed.'
        else 'The email service reported that they unsubscribed.'
      end || ' No more follow-up emails will be sent to them.';
    elsif new.event_type = 'complaint' then
      v_type := 'spam_report';
      v_title := v_who || ' reported a follow-up email as spam';
      v_body := 'No more follow-up emails will be sent to them.';
    else
      v_type := 'email_bounced';
      v_title := 'A follow-up email to ' || coalesce(v_name, 'a contact') || ' bounced';
      v_body := 'Their email address rejected the message, so email to it is now blocked. Check the address on their contact.';
    end if;

    perform automation_internal.notify(
      new.user_id, v_type, v_title, v_body, new.contact_id,
      automation_internal.notification_contact_route(new.contact_id),
      'stop:' || new.id::text,
      jsonb_build_object('event_type', new.event_type, 'source', new.source)
    );
  exception when others then
    raise warning 'RealtorOS: a notification could not be created (SQLSTATE %); the stop event was saved normally.', sqlstate;
  end;
  return null;
end;
$function$;

-- === automation_internal.notify_on_job_failed()  body md5 baa26fd9c837908595178e524755edff
CREATE OR REPLACE FUNCTION automation_internal.notify_on_job_failed()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_who text;
  v_title text;
begin
  begin
    v_who := coalesce(automation_internal.notification_contact_name(new.user_id, new.contact_id), 'a contact');
    v_title := case when new.job_type = 'send_email'
      then 'A follow-up email to ' || v_who || ' couldn''t be sent'
      else 'An automation step for ' || v_who || ' couldn''t be completed'
    end;
    perform automation_internal.notify(
      new.user_id, 'followup_failed', v_title,
      'Open Automation to see what went wrong.',
      new.contact_id, '/automation',
      'job_failed:' || new.id::text || ':' || coalesce(new.manual_retry_count, 0)::text,
      jsonb_build_object('job_id', new.id, 'job_type', new.job_type, 'attempts', new.attempts)
    );
  exception when others then
    raise warning 'RealtorOS: a notification could not be created (SQLSTATE %); the job update was saved normally.', sqlstate;
  end;
  return null;
end;
$function$;

-- === automation_internal.notify_on_import_batch()  body md5 ae247d7bf526dbf130f63739d2469349
CREATE OR REPLACE FUNCTION automation_internal.notify_on_import_batch()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_added integer;
  v_updated integer;
  v_fix integer;
  v_held integer;
  v_batches integer;
  v_parts text[];
  v_title text;
  v_body text;
  v_source_name text;
  v_existing public.notifications%rowtype;
begin
  if new.status not in ('completed', 'partial', 'failed') then
    return null;
  end if;
  if tg_op = 'UPDATE' and old.status in ('completed', 'partial', 'failed') then
    return null;
  end if;

  begin
    if new.source_type = 'file_upload' then
      v_added := coalesce(new.imported_count, 0);
      v_updated := coalesce((new.metadata ->> 'updated_count')::integer, 0);
      v_held := coalesce((new.metadata ->> 'daily_limit_skipped_count')::integer, 0);
      v_fix := greatest(coalesce(new.rejected_count, 0) - v_held, 0);
      v_parts := array[]::text[];
      if v_added > 0 then v_parts := v_parts || (v_added || ' added'); end if;
      if v_updated > 0 then v_parts := v_parts || (v_updated || ' updated'); end if;
      if v_fix > 0 then
        v_parts := v_parts || (v_fix || case when v_fix = 1 then ' needs fixing' else ' need fixing' end);
      end if;
      if v_held > 0 then v_parts := v_parts || (v_held || ' held back by today''s limit'); end if;

      v_title := 'File upload finished: '
        || coalesce(nullif(array_to_string(v_parts, ', '), ''), 'no new contacts');
      v_source_name := automation_internal.notification_plain(new.file_name, 100);
      v_body := case when v_source_name <> '' then 'From "' || v_source_name || '". ' else '' end
        || 'Open Import History for the details.';

      perform automation_internal.notify(
        new.user_id, 'import_finished', v_title, v_body, null,
        '/settings/sheet-imports', 'import:' || new.id::text,
        jsonb_build_object(
          'source_type', 'file_upload', 'batch_id', new.id, 'status', new.status,
          'imported', v_added, 'updated', v_updated, 'need_fixing', v_fix, 'held_back', v_held
        )
      );
    else
      -- A quiet sync (nothing new, nothing wrong) makes no notification.
      if coalesce(new.imported_count, 0) = 0 and coalesce(new.rejected_count, 0) = 0 then
        return null;
      end if;

      select * into v_existing
      from public.notifications
      where user_id = new.user_id
        and type = 'import_finished'
        and read_at is null
        and metadata ->> 'source_type' = 'google_sheet'
        and metadata ->> 'connection_id' = new.connection_id::text
        and created_at > now() - interval '60 minutes'
      order by created_at desc
      limit 1
      for update;

      v_added := coalesce(new.imported_count, 0) + coalesce((v_existing.metadata ->> 'imported')::integer, 0);
      v_fix := coalesce(new.rejected_count, 0) + coalesce((v_existing.metadata ->> 'need_fixing')::integer, 0);
      v_batches := 1 + coalesce((v_existing.metadata ->> 'batches')::integer, 0);

      v_parts := array[]::text[];
      if v_added > 0 then
        v_parts := v_parts || (v_added || case when v_added = 1 then ' new lead' else ' new leads' end);
      end if;
      if v_fix > 0 then
        v_parts := v_parts || (v_fix || case when v_fix = 1 then ' needs fixing' else ' need fixing' end);
      end if;
      v_title := 'Google Sheets sync: ' || array_to_string(v_parts, ', ');

      select automation_internal.notification_plain(name, 60) into v_source_name
      from public.lead_source_connections
      where id = new.connection_id and user_id = new.user_id;
      v_body := case when coalesce(v_source_name, '') <> '' then 'From "' || v_source_name || '"' else 'From your Google Sheet' end
        || case when v_batches > 1 then ', ' || v_batches || ' syncs in the last hour' else '' end
        || '. Open Import History for the details.';

      if v_existing.id is not null then
        update public.notifications
        set title = left(v_title, 200),
            body = left(v_body, 1000),
            created_at = now(),
            metadata = v_existing.metadata || jsonb_build_object(
              'imported', v_added, 'need_fixing', v_fix, 'batches', v_batches,
              'batch_id', new.id, 'status', new.status
            )
        where id = v_existing.id;
      else
        perform automation_internal.notify(
          new.user_id, 'import_finished', v_title, v_body, null,
          '/settings/sheet-imports', 'import:' || new.id::text,
          jsonb_build_object(
            'source_type', 'google_sheet', 'connection_id', new.connection_id,
            'batch_id', new.id, 'status', new.status,
            'imported', v_added, 'need_fixing', v_fix, 'batches', v_batches
          )
        );
      end if;
    end if;
  exception when others then
    raise warning 'RealtorOS: a notification could not be created (SQLSTATE %); the import was saved normally.', sqlstate;
  end;
  return null;
end;
$function$;

-- === public.realtoros_file_import_quota(p_user_id uuid)  body md5 7e9fb9139bed144616b77a32dfb3e3f9
CREATE OR REPLACE FUNCTION public.realtoros_file_import_quota(p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
declare
  c_daily_new_contacts constant integer := 200;
  c_window constant interval := interval '24 hours';
  v_used integer;
  v_oldest timestamptz;
begin
  if p_user_id is null then
    raise exception 'user_required' using errcode = '22023';
  end if;

  select count(*)::integer, min(created_at)
  into v_used, v_oldest
  from public.lead_import_rows
  where user_id = p_user_id
    and source_type = 'file_upload'
    and status = 'imported'
    and created_at > now() - c_window;

  return jsonb_build_object(
    'limit', c_daily_new_contacts,
    'used', v_used,
    'remaining', greatest(0, c_daily_new_contacts - v_used),
    'resets_at', v_oldest + c_window
  );
end;
$function$;

-- === public.realtoros_ingest_lead_file(p_user_id uuid, p_import_id uuid, p_file_name text, p_rows jsonb, p_start_automation boolean)  body md5 4abbaefb7633193d12019a875b01509f
CREATE OR REPLACE FUNCTION public.realtoros_ingest_lead_file(p_user_id uuid, p_import_id uuid, p_file_name text, p_rows jsonb, p_start_automation boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  c_max_rows constant integer := 500;
  c_short_window constant interval := interval '15 minutes';
  c_short_max constant integer := 10;
  c_daily_window constant interval := interval '24 hours';
  c_daily_max constant integer := 20;
  v_file_name text;
  v_event_id text;
  v_existing public.lead_import_batches%rowtype;
  v_batch_id uuid;
  v_total integer;
  v_count bigint;
  v_oldest timestamptz;
  v_quota jsonb;
  v_limit_message text;
  v_result jsonb;
  v_rejected integer;
  v_final_status text;
  v_start boolean := coalesce(p_start_automation, false);
begin
  if p_user_id is null then
    raise exception 'user_required' using errcode = '22023';
  end if;
  if p_import_id is null then
    raise exception 'import_id_required' using errcode = '22023';
  end if;
  v_file_name := left(btrim(regexp_replace(coalesce(p_file_name, ''), '[\x00-\x1F\x7F]+', '', 'g')), 255);
  if v_file_name = '' then
    raise exception 'file_name_required' using errcode = '22023';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'rows_must_be_an_array' using errcode = '22023';
  end if;
  v_total := jsonb_array_length(p_rows);
  if v_total < 1 or v_total > c_max_rows then
    raise exception 'row_count_must_be_between_1_and_500' using errcode = '22023';
  end if;

  -- Same per-owner lock as Google Sheet imports: file and sheet imports for
  -- one owner never run concurrently, so dedup and the allowance cannot race.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 824733));

  v_event_id := 'file:' || p_import_id::text;

  select * into v_existing from public.lead_import_batches
    where user_id = p_user_id and source_type = 'file_upload' and source_event_id = v_event_id;
  if found then
    return jsonb_build_object(
      'outcome', 'replayed',
      'replayed', true,
      'batch_id', v_existing.id,
      'status', v_existing.status,
      'source_row_count', v_existing.source_row_count,
      'imported_count', v_existing.imported_count,
      'updated_count', coalesce((v_existing.metadata ->> 'updated_count')::integer, 0),
      'unchanged_count', coalesce((v_existing.metadata ->> 'unchanged_count')::integer, 0),
      'in_file_duplicate_count', coalesce((v_existing.metadata ->> 'in_file_duplicate_count')::integer, 0),
      'daily_limit_skipped_count', coalesce((v_existing.metadata ->> 'daily_limit_skipped_count')::integer, 0),
      'rejected_count', v_existing.rejected_count,
      'problems', coalesce((
        select jsonb_agg(jsonb_build_object(
          'row_number', r.source_row_number, 'code', r.error_code, 'message', r.error_message)
          order by r.source_row_number)
        from public.lead_import_rows r
        where r.user_id = p_user_id and r.batch_id = v_existing.id
          and (r.status = 'rejected' or r.error_code = 'duplicate_in_file')
      ), '[]'::jsonb),
      'quota', public.realtoros_file_import_quota(p_user_id)
    );
  end if;

  select count(*), min(created_at) into v_count, v_oldest
    from public.lead_import_batches
    where user_id = p_user_id and source_type = 'file_upload'
      and created_at >= now() - c_short_window;
  if v_count >= c_short_max then
    return jsonb_build_object('outcome', 'rate_limited', 'retry_after_seconds',
      greatest(1, ceil(extract(epoch from (v_oldest + c_short_window - now())))::integer));
  end if;
  select count(*), min(created_at) into v_count, v_oldest
    from public.lead_import_batches
    where user_id = p_user_id and source_type = 'file_upload'
      and created_at >= now() - c_daily_window;
  if v_count >= c_daily_max then
    return jsonb_build_object('outcome', 'rate_limited', 'retry_after_seconds',
      greatest(1, ceil(extract(epoch from (v_oldest + c_daily_window - now())))::integer));
  end if;

  -- The allowance left before this import, and the message for rows past
  -- it. Everything counted was imported before this upload, so 24 hours
  -- after this import the full allowance is available again. The message
  -- names no clock time (the database does not know the owner's
  -- timezone); the app shows local times from quota.resets_at.
  v_quota := public.realtoros_file_import_quota(p_user_id);
  v_limit_message := 'Not imported — daily limit of ' || (v_quota ->> 'limit')
    || ' new contacts reached. Upload this file again 24 hours after this import to add the rest.';

  insert into public.lead_import_batches (
    user_id, connection_id, source_type, file_name, source_event_id,
    status, source_row_count, started_at, metadata
  ) values (
    p_user_id, null, 'file_upload', v_file_name, v_event_id,
    'processing', v_total, now(), jsonb_build_object('start_automation', v_start)
  )
  returning id into v_batch_id;

  v_result := automation_internal.ingest_lead_rows(
    p_user_id, null, v_batch_id, p_rows, 'file_upload', v_start,
    (v_quota ->> 'remaining')::integer, v_limit_message
  );
  v_rejected := (v_result ->> 'rejected_count')::integer;
  v_final_status := case
    when v_rejected = v_total then 'failed'
    when v_rejected > 0 then 'partial'
    else 'completed'
  end;

  update public.lead_import_batches
  set
    status = v_final_status,
    accepted_count = (v_result ->> 'accepted_count')::integer,
    duplicate_count = (v_result ->> 'duplicate_count')::integer,
    rejected_count = v_rejected,
    imported_count = (v_result ->> 'imported_count')::integer,
    completed_at = now(),
    error_summary = case when v_rejected > 0 then v_rejected || ' row(s) rejected' else null end,
    metadata = metadata || jsonb_build_object(
      'updated_count', (v_result ->> 'updated_count')::integer,
      'unchanged_count', (v_result ->> 'unchanged_count')::integer,
      'in_file_duplicate_count', (v_result ->> 'in_file_duplicate_count')::integer,
      'daily_limit_skipped_count', (v_result ->> 'daily_limit_skipped_count')::integer
    )
  where id = v_batch_id and user_id = p_user_id;

  return jsonb_build_object(
    'outcome', 'imported',
    'replayed', false,
    'batch_id', v_batch_id,
    'status', v_final_status,
    'source_row_count', v_total,
    'imported_count', (v_result ->> 'imported_count')::integer,
    'updated_count', (v_result ->> 'updated_count')::integer,
    'unchanged_count', (v_result ->> 'unchanged_count')::integer,
    'in_file_duplicate_count', (v_result ->> 'in_file_duplicate_count')::integer,
    'daily_limit_skipped_count', (v_result ->> 'daily_limit_skipped_count')::integer,
    'rejected_count', v_rejected,
    'problems', v_result -> 'problems',
    'quota', public.realtoros_file_import_quota(p_user_id)
  );
end;
$function$;

-- === public.realtoros_ingest_lead_batch(p_connection_id uuid, p_source_event_id text, p_sheet_revision text, p_rows jsonb)  body md5 a69a106d8fe2f575f24f09ad791e68ef
CREATE OR REPLACE FUNCTION public.realtoros_ingest_lead_batch(p_connection_id uuid, p_source_event_id text, p_sheet_revision text, p_rows jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_connection public.lead_source_connections%rowtype;
  v_existing_batch public.lead_import_batches%rowtype;
  v_batch_id uuid;
  v_total integer;
  v_result jsonb;
  v_accepted integer;
  v_duplicates integer;
  v_rejected integer;
  v_imported integer;
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

  -- Serialize imports per RealtorOS owner so two different sheets (or a
  -- sheet and a file upload) cannot create separate contacts for the same
  -- hashed email/phone concurrently.
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

  v_result := automation_internal.ingest_lead_rows(
    v_connection.user_id, v_connection.id, v_batch_id, p_rows, 'google_sheet', true, null, null
  );
  v_accepted := (v_result ->> 'accepted_count')::integer;
  v_duplicates := (v_result ->> 'duplicate_count')::integer;
  v_rejected := (v_result ->> 'rejected_count')::integer;
  v_imported := (v_result ->> 'imported_count')::integer;

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
$function$;

-- === public.realtoros_mark_reply_hot(p_user_id uuid, p_event_ref text, p_reason text)  body md5 9d042c2b1463da51f19fd4328a42627b
CREATE OR REPLACE FUNCTION public.realtoros_mark_reply_hot(p_user_id uuid, p_event_ref text, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_event public.contact_stop_events%rowtype;
  v_label text;
  v_title text;
  v_rows integer;
begin
  if p_user_id is null or p_event_ref is null then
    raise exception 'user and event reference are required' using errcode = '22023';
  end if;
  v_label := case p_reason
    when 'viewing' then 'asked about a viewing'
    when 'offer' then 'mentioned making an offer'
    when 'ready' then 'said they''re ready to move'
    when 'financing' then 'said their financing is ready'
    when 'call_request' then 'asked you to call'
    when 'availability' then 'asked if it''s still available'
    when 'price' then 'asked about the price'
    else null
  end;
  if v_label is null then
    raise exception 'invalid hot reply reason' using errcode = '22023';
  end if;

  select * into v_event
  from public.contact_stop_events
  where user_id = p_user_id
    and source = 'inbound_email'
    and event_type = 'reply'
    and event_ref = p_event_ref;
  if not found then
    return jsonb_build_object('outcome', 'no_reply_event');
  end if;

  v_title := '🔥 ' || coalesce(automation_internal.notification_contact_name(p_user_id, v_event.contact_id), 'A contact')
    || ' replied — ' || v_label;

  update public.notifications
  set type = 'hot_reply',
      title = left(v_title, 200),
      metadata = metadata || jsonb_build_object('hot_reason', p_reason)
  where user_id = p_user_id
    and dedupe_key = 'stop:' || v_event.id::text
    and type in ('lead_replied', 'hot_reply');
  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    perform automation_internal.notify(
      p_user_id, 'hot_reply', v_title,
      'Their reply is in your email inbox. Automations set to stop when a contact replies have stopped for them.',
      v_event.contact_id,
      automation_internal.notification_contact_route(v_event.contact_id),
      'stop:' || v_event.id::text,
      jsonb_build_object('event_type', 'reply', 'source', 'inbound_email', 'hot_reason', p_reason)
    );
  end if;

  return jsonb_build_object('outcome', 'marked', 'reason', p_reason);
end;
$function$;

-- ============================================================
-- 2. The 8-argument ingest_lead_rows was DROPPED by T2c, not replaced,
--    so it comes back as a fresh function and needs its grants again.
--    Then the 9-argument version goes.
-- ============================================================
revoke all on function automation_internal.ingest_lead_rows(
  uuid, uuid, uuid, jsonb, text, boolean, integer, text)
  from public, anon, authenticated;
grant execute on function automation_internal.ingest_lead_rows(
  uuid, uuid, uuid, jsonb, text, boolean, integer, text) to service_role;

drop function if exists automation_internal.ingest_lead_rows(
  uuid, uuid, uuid, uuid, jsonb, text, boolean, integer, text);

-- ============================================================
-- 3. Drop the 10 functions T2c introduced.
--
-- Order matters: the wrappers go before the helpers they call, so a
-- partial run never leaves a function whose dependency is gone.
-- ============================================================
drop function if exists automation_internal.notify_contact(
  uuid, text, text, text, text, text, text, jsonb);
drop function if exists automation_internal.notify_permission(
  uuid, text, text, text, text, text, text, text, jsonb);
drop function if exists automation_internal.notify_many(
  uuid[], uuid, text, text, text, text, text, text, jsonb);
drop function if exists automation_internal.contact_audience(uuid, text);
drop function if exists automation_internal.permission_audience(uuid, text);
drop function if exists automation_internal.notification_contact_name_ws(uuid, text);
drop function if exists automation_internal.member_can(uuid, uuid, text);
drop function if exists automation_internal.member_permissions(uuid, uuid);
drop function if exists automation_internal.file_import_daily_limit();
-- workspace_of goes LAST: the restored notify() above does not use it,
-- but T2c's did, and a half-applied revert should never leave a live
-- function pointing at a missing one.
drop function if exists automation_internal.workspace_of(uuid);

-- ============================================================
-- 4. Restore the uniqueness rules T2c re-scoped.
--
-- Four were table CONSTRAINTS and two were bare unique INDEXES; each
-- comes back as whatever it was, under its original name.
-- ============================================================
alter table public.contact_identity_keys
  add constraint contact_identity_keys_user_id_identity_type_identity_hash_key
  unique (user_id, identity_type, identity_hash);

alter table public.lead_import_rows
  add constraint lead_import_rows_user_id_connection_id_source_row_key_key
  unique (user_id, connection_id, source_row_key);

alter table public.lead_import_batches
  add constraint lead_import_batches_user_id_connection_id_source_event_id_key
  unique (user_id, connection_id, source_event_id);

alter table public.lead_source_connections
  add constraint lead_source_connections_user_id_spreadsheet_id_ready_tab_na_key
  unique (user_id, spreadsheet_id, ready_tab_name);

create unique index if not exists lead_import_batches_file_import_idx
  on public.lead_import_batches using btree (user_id, source_event_id)
  where (source_type = 'file_upload'::text);

create unique index if not exists lead_source_mappings_one_active_idx
  on public.lead_source_mappings using btree (user_id, connection_id)
  where is_active;

-- ============================================================
-- 5. Drop the 12 indexes T2c added.
-- ============================================================
drop index if exists public.contact_identity_keys_ws_identity_uq;
drop index if exists public.contact_identity_keys_ws_contact_idx;
drop index if exists public.lead_import_rows_ws_source_uq;
drop index if exists public.lead_import_rows_ws_file_new_idx;
drop index if exists public.lead_import_rows_ws_batch_idx;
drop index if exists public.lead_import_batches_ws_conn_event_uq;
drop index if exists public.lead_import_batches_ws_file_event_uq;
drop index if exists public.lead_import_batches_ws_source_created_idx;
drop index if exists public.contacts_ws_email_norm_idx;
drop index if exists public.contacts_ws_phone_norm_idx;
drop index if exists public.lead_source_connections_ws_sheet_uq;
drop index if exists public.lead_source_mappings_ws_one_active_uq;

-- ============================================================
-- 6. Prove the revert landed on the pre-T2c state.
--
-- The checksums are of pg_proc.prosrc - the raw body text - captured
-- from the repo chain replayed up to but excluding T2c. If any differs,
-- what was restored is not what T2c replaced, and the transaction rolls
-- back rather than leaving a half-reverted database.
-- ============================================================
do $verify$
declare
  r record;
  v_actual text;
  v_bad text := '';
begin
  for r in select * from (values
    ('automation_internal', 'ingest_lead_rows', '1bfcaf5fa10f7013a8c0193a9ab988cb'),
    ('automation_internal', 'notify', 'def077564da47207b6a7c977182c60c8'),
    ('automation_internal', 'notify_on_stop_event', '8b250d6ab86d845713dfb885948b38d6'),
    ('automation_internal', 'notify_on_job_failed', 'baa26fd9c837908595178e524755edff'),
    ('automation_internal', 'notify_on_import_batch', 'ae247d7bf526dbf130f63739d2469349'),
    ('public', 'realtoros_file_import_quota', '7e9fb9139bed144616b77a32dfb3e3f9'),
    ('public', 'realtoros_ingest_lead_file', '4abbaefb7633193d12019a875b01509f'),
    ('public', 'realtoros_ingest_lead_batch', 'a69a106d8fe2f575f24f09ad791e68ef'),
    ('public', 'realtoros_mark_reply_hot', '9d042c2b1463da51f19fd4328a42627b')
  ) as v(sch, fn, want_md5)
  loop
    select md5(p.prosrc) into v_actual
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = r.sch and p.proname = r.fn
     limit 1;
    if v_actual is null then
      v_bad := v_bad || format(E'\n  %s.%s is MISSING', r.sch, r.fn);
    elsif v_actual <> r.want_md5 then
      v_bad := v_bad || format(E'\n  %s.%s body is %s, expected %s',
        r.sch, r.fn, v_actual, r.want_md5);
    end if;
  end loop;

  if exists (
    select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'automation_internal' and p.proname = 'member_can'
  ) then
    v_bad := v_bad || E'\n  automation_internal.member_can still exists';
  end if;

  if (select count(*) from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
       where ns.nspname = 'automation_internal' and p.proname = 'ingest_lead_rows') <> 1 then
    v_bad := v_bad || E'\n  ingest_lead_rows does not have exactly one signature';
  end if;

  if v_bad <> '' then
    raise exception 'T2c revert did not reproduce the pre-T2c state:%', v_bad;
  end if;
  raise notice 'T2c reverted: all 9 function bodies match the pre-T2c chain.';
end $verify$;

commit;
