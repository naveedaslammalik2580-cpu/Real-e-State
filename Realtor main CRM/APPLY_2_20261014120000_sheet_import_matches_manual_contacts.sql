-- RealtorOS — SQL Editor wrapper 2 of 2. APPLY AFTER WRAPPER 1.
-- Source: supabase/migrations/20261014120000_sheet_import_matches_manual_contacts.sql
-- Records itself in supabase_migrations.schema_migrations on success.
-- Do not run until Claude Desktop has dry-run it.

BEGIN;

-- Phase H-1: a Google Sheet import must recognise contacts entered by hand.
--
-- THE DEFECT
--
-- Lead rows are matched to existing contacts through
-- public.contact_identity_keys - a hashed email / phone per contact,
-- written by the importer itself. A contact the agent typed into the
-- Contacts page has no identity key, because nothing imported it. So a
-- Sheet row for somebody already in the CRM matched nothing and created
-- a SECOND contact, every sync, for the same person.
--
-- Phase 4E.4 fixed this for file uploads by also matching on the
-- contact's own stored email / phone columns, but deliberately left Sheet
-- imports on identity-key-only matching ("File only", the comment said).
-- That split has no justification: the fallback is a property of the
-- contact being matched, not of where the row came from.
--
-- THE CHANGE
--
-- automation_internal.ingest_lead_rows is redefined with the `v_is_file`
-- gate around the email / phone fallback REMOVED, so the fallback now
-- runs for Sheet rows too. Everything else is byte for byte the Phase T2c
-- definition:
--
--   * same signature, SECURITY DEFINER, `search_path ''`, owner, grants;
--   * still workspace-scoped (`where workspace_id = p_workspace_id`), so
--     a contact in another workspace is still never matched;
--   * still `order by created_at, id limit 1`, so when two contacts share
--     an address the oldest wins, deterministically;
--   * the `identity_conflict` rejection still fires when the email and
--     the phone resolve to two different contacts;
--   * every other use of `v_is_file` is untouched - the connection_id and
--     allowance argument validation, the tags column, the in-file
--     duplicate check, the daily allowance, the field-fill rules and the
--     identity-key `source` label all still distinguish the two sources.
--
-- WHY NOTHING ELSE NEEDS TO CHANGE
--
-- The identity-key writes at the end of the loop were never gated on the
-- source, so a Sheet row that matches by fallback writes its email and
-- phone keys exactly as a file row does. The next sync therefore matches
-- directly by key and never reaches the fallback again.
--
-- A matched Sheet row is handled by the branch that already handles a
-- Sheet row matched by identity key (the final `else`: fill the existing
-- contact's empty fields, never overwrite). No new merge rule is
-- introduced - a row that now matches is treated exactly as a row that
-- already matched.
--
-- Idempotent. Replaces one function; creates, drops and alters nothing
-- else, and writes no data.

create or replace function automation_internal.ingest_lead_rows(
  p_user_id uuid,
  p_workspace_id uuid,
  p_connection_id uuid,
  p_batch_id uuid,
  p_rows jsonb,
  p_source_type text,
  p_start_automation boolean,
  p_new_contact_allowance integer,
  p_limit_message text
)
returns jsonb language plpgsql set search_path = '' as $fn$
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
  if p_workspace_id is null then
    raise exception 'workspace_required' using errcode = '22023';
  end if;
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
        user_id, workspace_id, batch_id, connection_id, source_type,
        source_row_key, source_row_number, row_fingerprint, status,
        error_code, error_message, error_context, last_seen_at
      )
      values (
        p_user_id, p_workspace_id, p_batch_id, p_connection_id, p_source_type,
        v_source_key, v_ordinal::integer, v_fingerprint, 'rejected',
        v_error_code, v_error_message,
        jsonb_build_object('row_number', v_ordinal), now()
      )
      on conflict (workspace_id, connection_id, source_row_key)
      do update set
        user_id = excluded.user_id,
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
      where workspace_id = p_workspace_id
        and connection_id = p_connection_id
        and source_row_key = v_source_key;
    end if;

    -- Identity lookups are WORKSPACE-wide: whoever on the team imported
    -- this person first, the same contact is found now.
    if v_email_hash is not null then
      select contact_id
      into v_email_contact
      from public.contact_identity_keys
      where workspace_id = p_workspace_id
        and identity_type = 'email'
        and identity_hash = v_email_hash;
    end if;

    if v_phone_hash is not null then
      select contact_id
      into v_phone_contact
      from public.contact_identity_keys
      where workspace_id = p_workspace_id
        and identity_type = 'phone'
        and identity_hash = v_phone_hash;
    end if;

    -- Contacts typed in by hand (or created before imports kept identity
    -- keys) have no identity key yet, so also match on the contact's own
    -- stored email / phone, normalized the same way. This runs for BOTH
    -- sources (H-1): it is the contact that lacks a key, which has
    -- nothing to do with where this row came from. These two queries
    -- match contacts_ws_email_norm_idx and contacts_ws_phone_norm_idx
    -- exactly (expression and predicate).
    if v_email_contact is null and v_email <> '' then
      select id into v_email_contact
      from public.contacts
      where workspace_id = p_workspace_id and email <> '' and lower(btrim(email)) = v_email
      order by created_at, id
      limit 1;
    end if;
    if v_phone_contact is null and v_phone_normalized is not null then
      select id into v_phone_contact
      from public.contacts
      where workspace_id = p_workspace_id and phone <> ''
        and regexp_replace(phone, '[^0-9]+', '', 'g') = v_phone_normalized
      order by created_at, id
      limit 1;
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
        user_id,workspace_id,batch_id,connection_id,source_type,source_row_key,
        source_row_number,row_fingerprint,status,error_code,error_message,
        error_context,last_seen_at
      )
      values (
        p_user_id,p_workspace_id,p_batch_id,p_connection_id,p_source_type,v_source_key,
        v_ordinal::integer,v_fingerprint,'rejected','identity_conflict',
        v_error_message,
        jsonb_build_object('row_number', v_ordinal),now()
      )
      on conflict (workspace_id, connection_id, source_row_key)
      do update set
        user_id = excluded.user_id,
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
      where workspace_id = p_workspace_id and batch_id = p_batch_id
        and contact_id = v_contact_id
      order by source_row_number
      limit 1;
      if found then
        v_error_message := 'Same person as row ' || v_dup_of || ' — skipped.';
        insert into public.lead_import_rows (
          user_id,workspace_id,batch_id,connection_id,source_type,contact_id,
          source_row_key,source_row_number,row_fingerprint,status,error_code,
          error_message,error_context,last_seen_at
        )
        values (
          p_user_id,p_workspace_id,p_batch_id,null,p_source_type,v_contact_id,
          v_source_key,v_ordinal::integer,v_fingerprint,'duplicate',
          'duplicate_in_file',v_error_message,
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

    -- File only: the workspace's daily allowance is used up. The row is
    -- recorded (so Import History shows why) but creates nothing.
    if v_is_file and v_is_new and v_allowance_left <= 0 then
      insert into public.lead_import_rows (
        user_id,workspace_id,batch_id,connection_id,source_type,source_row_key,
        source_row_number,row_fingerprint,status,error_code,error_message,
        error_context,last_seen_at
      )
      values (
        p_user_id,p_workspace_id,p_batch_id,null,p_source_type,v_source_key,
        v_ordinal::integer,v_fingerprint,'rejected','daily_limit_reached',
        p_limit_message,
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

      -- assigned_to_id is deliberately NOT set: imported leads land
      -- unassigned so a manager distributes them (decision 3).
      if v_is_file then
        insert into public.contacts (
          id,user_id,workspace_id,full_name,email,phone,type,status,source,
          temperature,budget,preferred_area,notes,tags
        )
        values (
          v_contact_id,p_user_id,p_workspace_id,v_name,v_email,v_phone,v_type,
          v_status,v_source,v_temperature,v_budget,v_preferred_area,v_notes,v_tags
        );

        v_allowance_left := v_allowance_left - 1;

        -- Automation off: the 'contact_created' event the insert trigger
        -- just wrote is cancelled before this transaction commits, so it
        -- is never visible to the worker as pending.
        if not coalesce(p_start_automation, false) then
          update public.automation_trigger_events
            set status = 'cancelled',
                processed_at = now(),
                last_error = 'Imported from a file without automated follow-up.'
            where workspace_id = p_workspace_id
              and contact_id = v_contact_id
              and event_type = 'contact_created'
              and status = 'pending';
        end if;
      else
        insert into public.contacts (
          id,user_id,workspace_id,full_name,email,phone,type,status,source,
          temperature,budget,preferred_area,notes
        )
        values (
          v_contact_id,p_user_id,p_workspace_id,v_name,v_email,v_phone,v_type,
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
      where workspace_id = p_workspace_id
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
      where workspace_id = p_workspace_id
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
      where workspace_id = p_workspace_id
        and id = v_contact_id;
    end if;

    if v_email_hash is not null then
      insert into public.contact_identity_keys (
        user_id,workspace_id,contact_id,identity_type,identity_hash,identity_hint,source
      )
      values (
        p_user_id,p_workspace_id,v_contact_id,'email',v_email_hash,
        left(v_email, 2) || '***',
        case when v_is_file then 'file_upload' else 'google_sheets' end
      )
      on conflict (workspace_id, identity_type, identity_hash) do nothing;
    end if;

    if v_phone_hash is not null then
      insert into public.contact_identity_keys (
        user_id,workspace_id,contact_id,identity_type,identity_hash,identity_hint,source
      )
      values (
        p_user_id,p_workspace_id,v_contact_id,'phone',v_phone_hash,
        '***' || right(v_phone_normalized, 4),
        case when v_is_file then 'file_upload' else 'google_sheets' end
      )
      on conflict (workspace_id, identity_type, identity_hash) do nothing;
    end if;

    insert into public.lead_import_rows (
      user_id,workspace_id,batch_id,connection_id,source_type,contact_id,
      source_row_key,source_row_number,row_fingerprint,status,error_context,last_seen_at
    )
    values (
      p_user_id,p_workspace_id,p_batch_id,p_connection_id,p_source_type,v_contact_id,
      v_source_key,v_ordinal::integer,v_fingerprint,
      case when v_is_new then 'imported' else 'duplicate' end,
      v_row_context,now()
    )
    on conflict (workspace_id, connection_id, source_row_key)
    do update set
      user_id = excluded.user_id,
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
$fn$;
revoke all on function automation_internal.ingest_lead_rows(
  uuid, uuid, uuid, uuid, jsonb, text, boolean, integer, text)
  from public, anon, authenticated;
grant execute on function automation_internal.ingest_lead_rows(
  uuid, uuid, uuid, uuid, jsonb, text, boolean, integer, text) to service_role;
comment on function automation_internal.ingest_lead_rows(
  uuid, uuid, uuid, uuid, jsonb, text, boolean, integer, text) is
  'Phase H-1. Lead row ingestion, de-duplicated per WORKSPACE so teammates never create two contacts for one person. Matches on identity keys first, then on the contact''s own email / phone for BOTH sources, so a contact entered by hand is recognised by a Google Sheet import instead of being duplicated. Imported leads are left unassigned on purpose. p_user_id stays the audit trail of who imported.';

-- ============================================================
-- Verify.
-- ============================================================
do $verify$
begin
  -- Exactly one ingest_lead_rows, still the 9-argument workspace-scoped
  -- signature. (Argument TYPES, not pg_get_function_identity_arguments,
  -- which also prints the parameter names.)
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'automation_internal' and p.proname = 'ingest_lead_rows'
       and p.pronargs = 9
       and oidvectortypes(p.proargtypes)
           = 'uuid, uuid, uuid, uuid, jsonb, text, boolean, integer, text'
  ) then
    raise exception 'H-1: the 9-argument ingest_lead_rows is missing';
  end if;

  -- The fallback must no longer be gated on the source. The gate was the
  -- only `if v_is_file then` immediately preceding the contacts lookup.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'automation_internal' and p.proname = 'ingest_lead_rows'
       and p.prosrc ~ 'if v_is_file then\s*\n\s*if v_email_contact is null'
  ) then
    raise exception 'H-1: the email/phone fallback is still gated on v_is_file';
  end if;

  -- And it must still be there at all, workspace-scoped and ordered.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'automation_internal' and p.proname = 'ingest_lead_rows'
       and p.prosrc like '%lower(btrim(email)) = v_email%'
       and p.prosrc like '%order by created_at, id%'
  ) then
    raise exception 'H-1: the email/phone fallback is missing';
  end if;

  raise notice 'H-1: a Sheet import now matches contacts entered by hand.';
end $verify$;

INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('20261014120000', 'sheet_import_matches_manual_contacts');

COMMIT;
