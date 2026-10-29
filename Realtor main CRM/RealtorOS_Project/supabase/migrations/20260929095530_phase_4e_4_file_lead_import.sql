-- Phase 4E.4: import leads from an Excel / CSV file.
--
-- Applies on top of the live history (last applied version 20260929051621,
-- phase_4e_3_unsubscribe_by_reply). Nothing here activates a rule, enrolls
-- a contact, or sends an email.
--
-- WHAT THIS DOES
--   1. lead_import_batches / lead_import_rows gain a source type
--      ('google_sheet' | 'file_upload', default 'google_sheet' so every
--      existing row stays valid) and batches gain a file name. connection_id
--      becomes nullable, but a check constraint allows NULL only for file
--      uploads and requires it for Google Sheet imports. The existing
--      composite foreign keys are unchanged (a NULL connection_id simply
--      is not checked against lead_source_connections).
--   2. The per-row validation / dedup / row-result loop of
--      realtoros_ingest_lead_batch moves, verbatim, into ONE internal
--      function, automation_internal.ingest_lead_rows(), parameterised by
--      source type. realtoros_ingest_lead_batch keeps its exact signature
--      and outer behaviour (validation, connection lock, per-owner advisory
--      lock, batch replay, batch totals, connection sync stamp, return
--      shape) and calls the shared core. Sheet rows take exactly the
--      original code path.
--   3. A new service_role-only realtoros_ingest_lead_file() for file
--      uploads, sharing the same core: up to 500 rows per file, one call,
--      idempotent on (user_id, import id), at most 10 uploads per 15
--      minutes and 20 per 24 hours per owner.
--   4. A daily allowance for FILE UPLOADS ONLY: at most 200 new contacts
--      per owner in any rolling 24 hours (c_daily_new_contacts in
--      realtoros_file_import_quota). Only rows that create a new contact
--      count. Past the allowance, a row that would create a contact is
--      recorded as rejected ('daily_limit_reached'); rows matching existing
--      contacts and in-file duplicates are still processed. Google Sheet
--      imports are not limited and behave exactly as before.
--   5. A service_role-only realtoros_file_import_quota() to read the
--      allowance (limit, used, remaining, resets_at).
--   6. Indexes: two expression indexes on contacts so the file import's
--      match on a contact's stored email / phone is an index lookup, and a
--      partial index on lead_import_rows for counting the allowance.
--
-- AUTOMATION CONTROL (p_start_automation = false)
--   A new contact fires automation_internal.contact_created_event(), which
--   inserts a 'pending' automation_trigger_events row. With automation off,
--   the file import marks that row 'cancelled' (with a reason) in the SAME
--   transaction, immediately after the insert. The row never commits as
--   pending, so the worker can never claim it, and the cancelled row is an
--   audit trail of why. There is no session setting, flag or parameter a
--   browser could set: the only path that cancels an event is this
--   service_role-only function, and browsers have no write grant on
--   automation_trigger_events and no access to automation_internal. With
--   automation on, events are created normally and the existing daily
--   enrollment limit (realtoros_enroll_contact) still applies.
--
-- Every function: SECURITY INVOKER, empty search_path, EXECUTE revoked from
-- public/anon/authenticated, granted to service_role only.

-- ============================================================
-- 1. SCHEMA: source type, file name, nullable connection_id
-- ============================================================
alter table public.lead_import_batches
  add column if not exists source_type text not null default 'google_sheet',
  add column if not exists file_name text;

alter table public.lead_import_rows
  add column if not exists source_type text not null default 'google_sheet';

alter table public.lead_import_batches alter column connection_id drop not null;
alter table public.lead_import_rows alter column connection_id drop not null;

do $constraints$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.lead_import_batches'::regclass
      and conname = 'lead_import_batches_source_type_check'
  ) then
    alter table public.lead_import_batches
      add constraint lead_import_batches_source_type_check
      check (source_type in ('google_sheet', 'file_upload'));
  end if;

  -- A Google Sheet import always has a connection and no file name; a file
  -- upload never has a connection and always has a file name.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.lead_import_batches'::regclass
      and conname = 'lead_import_batches_source_shape_check'
  ) then
    alter table public.lead_import_batches
      add constraint lead_import_batches_source_shape_check
      check (
        (source_type = 'google_sheet' and connection_id is not null and file_name is null)
        or (source_type = 'file_upload' and connection_id is null
            and file_name is not null and char_length(file_name) between 1 and 255
            and file_name !~ '[\x00-\x1F\x7F]')
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.lead_import_rows'::regclass
      and conname = 'lead_import_rows_source_type_check'
  ) then
    alter table public.lead_import_rows
      add constraint lead_import_rows_source_type_check
      check (source_type in ('google_sheet', 'file_upload'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.lead_import_rows'::regclass
      and conname = 'lead_import_rows_source_shape_check'
  ) then
    alter table public.lead_import_rows
      add constraint lead_import_rows_source_shape_check
      check (
        (source_type = 'google_sheet' and connection_id is not null)
        or (source_type = 'file_upload' and connection_id is null)
      );
  end if;
end
$constraints$;

-- File-upload idempotency: one batch per (owner, import id). The import id
-- is stored as source_event_id 'file:<uuid>'. (The existing unique
-- (user_id, connection_id, source_event_id) cannot do this: NULLs are
-- distinct in a unique constraint.)
create unique index if not exists lead_import_batches_file_import_idx
  on public.lead_import_batches (user_id, source_event_id)
  where source_type = 'file_upload';

create index if not exists lead_import_batches_source_created_idx
  on public.lead_import_batches (user_id, source_type, created_at desc);

comment on column public.lead_import_batches.source_type is
  'google_sheet (Apps Script sync through ingest-sheet-leads; connection_id required) or file_upload (one-time file import through import-lead-file; connection_id null, file_name required).';
comment on column public.lead_import_batches.file_name is
  'Original file name for a file upload (control characters removed, at most 255 chars). Null for Google Sheet imports.';
comment on column public.lead_import_rows.source_type is
  'Copied from the batch: google_sheet rows carry connection_id; file_upload rows do not.';

-- Existing grants already cover the new columns: authenticated has
-- table-level SELECT (owner RLS), no insert/update/delete; service_role
-- has everything.

-- File-import fallback matching (section 2) looks up an owner's contact by
-- normalized email and by phone digits. Without these, every imported row
-- scans all of the owner's contacts (and each new contact makes the next
-- scan longer). The lookups in ingest_lead_rows use EXACTLY these
-- expressions and partial predicates so the planner can use them.
create index if not exists contacts_user_email_norm_idx
  on public.contacts (user_id, lower(btrim(email)))
  where email <> '';

create index if not exists contacts_user_phone_norm_idx
  on public.contacts (user_id, regexp_replace(phone, '[^0-9]+', '', 'g'))
  where phone <> '';

-- The daily allowance counts the owner's file rows that created a contact
-- in the last 24 hours (realtoros_file_import_quota).
create index if not exists lead_import_rows_file_new_contacts_idx
  on public.lead_import_rows (user_id, created_at)
  where source_type = 'file_upload' and status = 'imported';

-- ============================================================
-- 2. SHARED CORE: per-row validation, dedup and row results
-- ============================================================
-- The body of the loop is the live realtoros_ingest_lead_batch loop
-- (20260831114425) with v_connection.user_id -> p_user_id,
-- v_connection.id -> p_connection_id and v_batch_id -> p_batch_id. Every
-- difference for files is behind `if v_is_file`; with
-- p_source_type = 'google_sheet' the executed statements are exactly the
-- original ones.
--
-- File-mode rules:
--   * rows have no lead_id: the row key is 'file:<batch id>:<row number>';
--   * a name is optional; an email OR a phone is required;
--   * email shape and phone length are re-checked here (defence in depth
--     behind import-lead-file's own validation), and a row that
--     import-lead-file already rejected arrives as {"_invalid": "<code>"};
--   * a match with an existing contact only fills that contact's EMPTY
--     fields (never overwrites), reported as 'updated' or 'unchanged';
--   * a second row for the same person in the same file is skipped
--     ('duplicate_in_file'), never merged twice;
--   * with p_start_automation = false, a new contact's 'contact_created'
--     trigger event is cancelled in this same transaction;
--   * p_new_contact_allowance is how many NEW contacts this call may still
--     create (the daily allowance left). Rows are processed in file order;
--     once it is used up, a row that would create a contact is recorded as
--     rejected with 'daily_limit_reached' and p_limit_message. Rows that
--     match an existing contact, in-file duplicates and invalid rows are
--     handled as usual and never use the allowance. Google Sheet imports
--     pass NULL for both (no allowance) and take the original path.
-- Returns counts plus the rejected / skipped rows (row number + code +
-- plain-language message) for the caller to show.
create or replace function automation_internal.ingest_lead_rows(
  p_user_id uuid,
  p_connection_id uuid,
  p_batch_id uuid,
  p_rows jsonb,
  p_source_type text,
  p_start_automation boolean,
  p_new_contact_allowance integer,
  p_limit_message text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
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
$$;

revoke all on function automation_internal.ingest_lead_rows(uuid, uuid, uuid, jsonb, text, boolean, integer, text)
  from public, anon, authenticated;
grant execute on function automation_internal.ingest_lead_rows(uuid, uuid, uuid, jsonb, text, boolean, integer, text)
  to service_role;

comment on function automation_internal.ingest_lead_rows(uuid, uuid, uuid, jsonb, text, boolean, integer, text) is
  'Internal. The single per-row validation / dedup / row-result path shared by Google Sheet syncs (realtoros_ingest_lead_batch) and file uploads (realtoros_ingest_lead_file). Caller must hold the per-owner advisory lock and own p_batch_id. Not reachable through the API (non-exposed schema); service_role only.';

-- ============================================================
-- 3. GOOGLE SHEET ENTRY POINT — same signature, same behaviour
-- ============================================================
-- Outer logic unchanged from 20260831114425 line for line: argument
-- validation, active-connection lock, per-owner advisory lock, batch
-- insert or replay, batch totals, connection sync stamp, return shape.
-- Only the row loop now lives in automation_internal.ingest_lead_rows.
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
$$;

revoke execute on function public.realtoros_ingest_lead_batch(
  uuid,text,text,jsonb
) from public, anon, authenticated;
grant execute on function public.realtoros_ingest_lead_batch(
  uuid,text,text,jsonb
) to service_role;

-- ============================================================
-- 4. FILE UPLOAD DAILY ALLOWANCE (new)
-- ============================================================
-- At most c_daily_new_contacts NEW contacts from file uploads per owner in
-- any rolling 24 hours. "Used" is the owner's file rows that created a
-- contact (lead_import_rows.status = 'imported') in the last 24 hours, so
-- matches with existing contacts, in-file duplicates and rejected rows
-- never count, and a replayed import adds no rows. resets_at is when the
-- oldest counted row leaves the window (null when nothing is counted).
-- Google Sheet imports are never counted or limited.
create or replace function public.realtoros_file_import_quota(p_user_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
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
$$;

revoke all on function public.realtoros_file_import_quota(uuid)
  from public, anon, authenticated;
grant execute on function public.realtoros_file_import_quota(uuid)
  to service_role;

comment on function public.realtoros_file_import_quota(uuid) is
  'service_role-only. The owner''s daily allowance of new contacts from file uploads: {limit, used, remaining, resets_at}. The limit (200 per rolling 24 hours) is the constant c_daily_new_contacts. Google Sheet imports are not counted. Read by import-lead-file (owner from the JWT) and by realtoros_ingest_lead_file.';

-- ============================================================
-- 5. FILE UPLOAD ENTRY POINT (new)
-- ============================================================
-- Called only by the import-lead-file Edge Function, with the owner taken
-- from the caller's verified JWT (never from the request body).
--
--   * One call per file, 1-500 rows.
--   * Idempotent on (p_user_id, p_import_id): a retry or double-click
--     returns the first result with replayed = true, imports nothing and
--     uses none of the daily allowance. Checked under the per-owner
--     advisory lock, so two concurrent requests with the same import id
--     cannot both import.
--   * Upload count per owner (checked after the replay check, so a retry
--     is never blocked): at most 10 file imports per 15 minutes and 20 per
--     24 hours; otherwise outcome 'rate_limited' with retry_after_seconds.
--   * Daily allowance of new contacts (section 4), read and used under the
--     same lock, so two uploads in a row share it and can never overshoot.
--
-- outcome: 'imported' | 'replayed' | 'rate_limited'. rejected_count
-- includes the rows in daily_limit_skipped_count (they are stored as
-- rejected). 'quota' is the allowance after this import.
create or replace function public.realtoros_ingest_lead_file(
  p_user_id uuid,
  p_import_id uuid,
  p_file_name text,
  p_rows jsonb,
  p_start_automation boolean default false
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
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
$$;

revoke all on function public.realtoros_ingest_lead_file(uuid, uuid, text, jsonb, boolean)
  from public, anon, authenticated;
grant execute on function public.realtoros_ingest_lead_file(uuid, uuid, text, jsonb, boolean)
  to service_role;

comment on function public.realtoros_ingest_lead_file(uuid, uuid, text, jsonb, boolean) is
  'service_role-only. One-time lead import from a file (import-lead-file Edge Function), 1-500 rows in one call. Idempotent on (p_user_id, p_import_id); at most 10 uploads per 15 min and 20 per 24 h per owner; at most 200 new contacts from files per owner per rolling 24 hours (realtoros_file_import_quota), rows past it are rejected as daily_limit_reached. Shares validation and dedup with Google Sheet imports via automation_internal.ingest_lead_rows. With p_start_automation = false, new contacts'' contact_created automation events are cancelled in the same transaction. Never callable by anon or authenticated.';
