-- Phase T2c: the backend becomes team-aware.
--
-- T2a gave every row a workspace_id and T2b-2 made RLS enforce it. The
-- server-side paths, though, still treat ONE OWNER as the tenant: the
-- import quota, the import lock, lead de-duplication and notification
-- delivery are all keyed on user_id. In a team that is wrong in four
-- separate ways:
--
--   * two agents importing the same person create two contacts, because
--     identity keys are unique per user rather than per workspace;
--   * the advisory lock that is supposed to stop that race is taken on
--     the IMPORTER's user_id, so it does not serialize teammates at all;
--   * the daily allowance is per user, so a team multiplies it;
--   * a notification goes to whoever's user_id is on the row, which for
--     an imported lead is the importer and for a sheet sync is the
--     connection's creator - not the person responsible for the lead.
--
-- T2c fixes all four. The guiding rule: THE WORKSPACE IS THE TENANT.
--
-- Owner decisions recorded here because they change behaviour:
--
--   1. Lead identity is WORKSPACE-WIDE. One real person is one contact
--      per workspace, no matter which teammate imported them. This is
--      implied by "per-workspace locks" (a workspace lock guarding
--      per-user de-duplication would protect nothing) and is required
--      for a shared contact list not to show the same person twice.
--      Verified against live before writing this: zero conflicting
--      groups on every index this re-scopes, so it is a no-op for
--      existing rows.
--
--   2. The file-import allowance (200 new contacts / 24h) becomes a
--      WHOLE-WORKSPACE allowance, exactly as "per-workspace quotas"
--      says. Note the consequence: a five-agent team shares 200/day
--      rather than getting 200 each. The constant is in one place
--      (automation_internal.file_import_daily_limit()) so raising it is
--      a one-line change if that proves too tight.
--
--   3. Imported leads stay UNASSIGNED (assigned_to_id null) so a manager
--      distributes them. This already happened by omission; T2c makes it
--      explicit and a test pins it.
--
--   4. imports_file is enforced INSIDE the RPC, not only by RLS. The
--      Edge Function calls as service_role, which bypasses RLS entirely,
--      so RLS alone would let an agent without imports_file import.
--
-- Additive and idempotent: new indexes are created before the old ones
-- are dropped, and every function is CREATE OR REPLACE.

-- ============================================================
-- 1. Re-scope uniqueness from the user to the workspace.
--
-- Each block creates the workspace-scoped index first and only drops the
-- user-scoped one once that succeeded, so a failure leaves the old
-- constraint in force rather than no constraint at all.
--
-- Safety guard: if live data ever did hold a cross-user duplicate inside
-- one workspace, CREATE UNIQUE INDEX fails and the whole migration rolls
-- back. That is the intended outcome - silently merging two people's
-- contacts would be worse than stopping.
-- ============================================================

-- 1.1 contact_identity_keys: the email/phone -> contact map that makes
--     de-duplication possible at all.
create unique index if not exists contact_identity_keys_ws_identity_uq
  on public.contact_identity_keys (workspace_id, identity_type, identity_hash);
alter table public.contact_identity_keys
  drop constraint if exists contact_identity_keys_user_id_identity_type_identity_hash_key;
create index if not exists contact_identity_keys_ws_contact_idx
  on public.contact_identity_keys (workspace_id, contact_id);

-- 1.2 lead_import_rows: one row per source key per connection. NULL
--     connection_id (file uploads) stays distinct exactly as before,
--     because NULLs never collide in a unique index.
create unique index if not exists lead_import_rows_ws_source_uq
  on public.lead_import_rows (workspace_id, connection_id, source_row_key);
alter table public.lead_import_rows
  drop constraint if exists lead_import_rows_user_id_connection_id_source_row_key_key;
create index if not exists lead_import_rows_ws_file_new_idx
  on public.lead_import_rows (workspace_id, created_at)
  where source_type = 'file_upload' and status = 'imported';
create index if not exists lead_import_rows_ws_batch_idx
  on public.lead_import_rows (workspace_id, batch_id);

-- 1.3 lead_import_batches: replay detection, for both sources.
create unique index if not exists lead_import_batches_ws_conn_event_uq
  on public.lead_import_batches (workspace_id, connection_id, source_event_id);
alter table public.lead_import_batches
  drop constraint if exists lead_import_batches_user_id_connection_id_source_event_id_key;
create unique index if not exists lead_import_batches_ws_file_event_uq
  on public.lead_import_batches (workspace_id, source_event_id)
  where source_type = 'file_upload';
drop index if exists public.lead_import_batches_file_import_idx;
create index if not exists lead_import_batches_ws_source_created_idx
  on public.lead_import_batches (workspace_id, source_type, created_at desc);

-- 1.4 contacts: the fallback match on a contact's own email / phone.
--     These two must mirror the queries in ingest_lead_rows exactly
--     (same expression, same predicate) or the planner will not use them.
create index if not exists contacts_ws_email_norm_idx
  on public.contacts (workspace_id, lower(btrim(email)))
  where email <> '';
create index if not exists contacts_ws_phone_norm_idx
  on public.contacts (workspace_id, regexp_replace(phone, '[^0-9]+', '', 'g'))
  where phone <> '';

-- 1.5 Sheets: one connection per spreadsheet tab per WORKSPACE, and one
--     active mapping per connection per workspace.
create unique index if not exists lead_source_connections_ws_sheet_uq
  on public.lead_source_connections (workspace_id, spreadsheet_id, ready_tab_name);
alter table public.lead_source_connections
  drop constraint if exists lead_source_connections_user_id_spreadsheet_id_ready_tab_na_key;
create unique index if not exists lead_source_mappings_ws_one_active_uq
  on public.lead_source_mappings (workspace_id, connection_id)
  where is_active;
drop index if exists public.lead_source_mappings_one_active_idx;

-- ============================================================
-- 2. Server-side permission evaluation.
--
-- authz.* is deliberately caller-scoped: every helper reads auth.uid()
-- and can only ever answer about the caller. That is what makes it safe
-- in RLS, but it is useless to a service_role worker that must ask "what
-- may THIS member do?". These are the admin-side equivalents:
-- service_role only, never granted to the browser.
-- ============================================================
create or replace function automation_internal.member_permissions(
  p_workspace_id uuid,
  p_user_id uuid
)
returns jsonb language plpgsql stable set search_path = '' as $fn$
declare
  v_role text; v_overrides jsonb; v_template jsonb;
begin
  if p_workspace_id is null or p_user_id is null then
    return null;
  end if;
  select wm.role, wm.permission_overrides into v_role, v_overrides
    from public.workspace_members wm
   where wm.workspace_id = p_workspace_id
     and wm.user_id = p_user_id
     and wm.status = 'active';
  if v_role is null then
    return null;
  end if;
  -- The owner's full permissions are never stored and never editable.
  if v_role = 'owner' then
    return authz.default_role_permissions('admin');
  end if;
  select wrp.permissions into v_template
    from public.workspace_role_permissions wrp
   where wrp.workspace_id = p_workspace_id and wrp.role = v_role;
  if v_template is null then
    v_template := authz.default_role_permissions(v_role);
  end if;
  return authz.merge_permissions(v_template, coalesce(v_overrides, '{}'::jsonb));
end;
$fn$;
revoke all on function automation_internal.member_permissions(uuid, uuid)
  from public, anon, authenticated;
grant execute on function automation_internal.member_permissions(uuid, uuid) to service_role;
comment on function automation_internal.member_permissions(uuid, uuid) is
  'Phase T2c. The admin-side twin of authz.effective_permissions: answers for ANY member, not just the caller, so a service_role worker can decide who may do what. service_role only.';

create or replace function automation_internal.member_can(
  p_workspace_id uuid,
  p_user_id uuid,
  p_key text
)
returns boolean language sql stable set search_path = '' as $fn$
  select coalesce(
    (automation_internal.member_permissions(p_workspace_id, p_user_id) ->> p_key)::boolean,
    false);
$fn$;
revoke all on function automation_internal.member_can(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function automation_internal.member_can(uuid, uuid, text) to service_role;
comment on function automation_internal.member_can(uuid, uuid, text) is
  'Phase T2c. One boolean permission for one member, evaluated server-side. service_role only.';

-- The workspace a user acts in. Unlike authz.my_workspace_id() this takes
-- the user explicitly, because the caller here is a trusted worker.
create or replace function automation_internal.workspace_of(p_user_id uuid)
returns uuid language sql stable set search_path = '' as $fn$
  select wm.workspace_id from public.workspace_members wm
   where wm.user_id = p_user_id and wm.status = 'active'
   limit 1;
$fn$;
revoke all on function automation_internal.workspace_of(uuid) from public, anon, authenticated;
grant execute on function automation_internal.workspace_of(uuid) to service_role;
comment on function automation_internal.workspace_of(uuid) is
  'Phase T2c. The one active workspace of a user (one active membership per person is a hard invariant from T2a). service_role only.';

-- ============================================================
-- 3. The file-import allowance, per WORKSPACE.
--
-- The limit lives in its own function so there is exactly one place to
-- change it, and so tests can assert the number without copying it.
-- ============================================================
create or replace function automation_internal.file_import_daily_limit()
returns integer language sql immutable set search_path = '' as $fn$
  select 200;
$fn$;
revoke all on function automation_internal.file_import_daily_limit() from public, anon;
grant execute on function automation_internal.file_import_daily_limit()
  to authenticated, service_role;

-- Signature unchanged on purpose: import-lead-file passes the signed-in
-- user and does not need redeploying for this change.
create or replace function public.realtoros_file_import_quota(p_user_id uuid)
returns jsonb language plpgsql stable set search_path = '' as $fn$
declare
  c_window constant interval := interval '24 hours';
  v_limit integer := automation_internal.file_import_daily_limit();
  v_workspace uuid;
  v_used integer;
  v_oldest timestamptz;
begin
  if p_user_id is null then
    raise exception 'user_required' using errcode = '22023';
  end if;
  v_workspace := automation_internal.workspace_of(p_user_id);
  if v_workspace is null then
    raise exception 'workspace_required' using errcode = '22023';
  end if;

  -- Counted across the WHOLE workspace: the allowance is the team's, not
  -- each member's, so a team cannot multiply it by adding people.
  select count(*)::integer, min(created_at)
    into v_used, v_oldest
    from public.lead_import_rows
   where workspace_id = v_workspace
     and source_type = 'file_upload'
     and status = 'imported'
     and created_at > now() - c_window;

  return jsonb_build_object(
    'limit', v_limit,
    'used', v_used,
    'remaining', greatest(0, v_limit - v_used),
    'resets_at', v_oldest + c_window
  );
end;
$fn$;
comment on function public.realtoros_file_import_quota(uuid) is
  'Phase T2c. The file-import allowance for the caller''s WORKSPACE (was per user). Signature unchanged so import-lead-file needs no redeploy.';

-- ============================================================
-- 4. ingest_lead_rows: match and de-duplicate per workspace.
--
-- The workspace is now passed in rather than derived, so the caller's
-- choice is explicit and a mismatch cannot hide. user_id is still
-- recorded on every row - it is the audit trail of WHO imported, which
-- the workspace_id does not replace.
--
-- Imported leads are left UNASSIGNED on purpose (see decision 3): a
-- manager distributes them afterwards. Nothing here writes
-- assigned_to_id.
-- ============================================================
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

    -- File only: contacts typed in by hand (or created before imports
    -- kept identity keys) have no identity key yet, so also match on the
    -- contact's own stored email / phone, normalized the same way. These
    -- two queries match contacts_ws_email_norm_idx and
    -- contacts_ws_phone_norm_idx exactly (expression and predicate).
    if v_is_file then
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
  'Phase T2c. Lead row ingestion, de-duplicated per WORKSPACE (was per user) so teammates never create two contacts for one person. Imported leads are left unassigned on purpose. p_user_id stays the audit trail of who imported.';

-- The 8-argument T2a signature is gone: leaving it callable would let a
-- stale caller silently fall back to per-user de-duplication, which is
-- the exact bug this phase fixes.
drop function if exists automation_internal.ingest_lead_rows(
  uuid, uuid, uuid, jsonb, text, boolean, integer, text);

-- ============================================================
-- 5. The file-import entry point: workspace lock, workspace replay,
--    and the imports_file permission.
-- ============================================================
create or replace function public.realtoros_ingest_lead_file(
  p_user_id uuid,
  p_import_id uuid,
  p_file_name text,
  p_rows jsonb,
  p_start_automation boolean default false
)
returns jsonb language plpgsql set search_path = '' as $fn$
declare
  c_max_rows constant integer := 500;
  c_short_window constant interval := interval '15 minutes';
  c_short_max constant integer := 10;
  c_daily_window constant interval := interval '24 hours';
  c_daily_max constant integer := 20;
  v_workspace uuid;
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

  v_workspace := automation_internal.workspace_of(p_user_id);
  if v_workspace is null then
    raise exception 'workspace_required' using errcode = '22023';
  end if;

  -- The Edge Function calls this as service_role, which bypasses RLS, so
  -- the imports_file permission has to be checked HERE. Without this an
  -- agent whose role template withholds imports_file could still import.
  if not automation_internal.member_can(v_workspace, p_user_id, 'imports_file') then
    raise exception 'imports_file permission required' using errcode = '42501';
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

  -- The lock is on the WORKSPACE, not the importer. That is the whole
  -- point: two teammates uploading the same person at the same moment
  -- must serialize, and a per-user lock would let them straight through.
  perform pg_advisory_xact_lock(hashtextextended(v_workspace::text, 824733));

  v_event_id := 'file:' || p_import_id::text;

  select * into v_existing from public.lead_import_batches
    where workspace_id = v_workspace and source_type = 'file_upload'
      and source_event_id = v_event_id;
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
        where r.workspace_id = v_workspace and r.batch_id = v_existing.id
          and (r.status = 'rejected' or r.error_code = 'duplicate_in_file')
      ), '[]'::jsonb),
      'quota', public.realtoros_file_import_quota(p_user_id)
    );
  end if;

  -- Burst and daily batch limits are the workspace's too, for the same
  -- reason as the allowance.
  select count(*), min(created_at) into v_count, v_oldest
    from public.lead_import_batches
    where workspace_id = v_workspace and source_type = 'file_upload'
      and created_at >= now() - c_short_window;
  if v_count >= c_short_max then
    return jsonb_build_object('outcome', 'rate_limited', 'retry_after_seconds',
      greatest(1, ceil(extract(epoch from (v_oldest + c_short_window - now())))::integer));
  end if;
  select count(*), min(created_at) into v_count, v_oldest
    from public.lead_import_batches
    where workspace_id = v_workspace and source_type = 'file_upload'
      and created_at >= now() - c_daily_window;
  if v_count >= c_daily_max then
    return jsonb_build_object('outcome', 'rate_limited', 'retry_after_seconds',
      greatest(1, ceil(extract(epoch from (v_oldest + c_daily_window - now())))::integer));
  end if;

  -- The allowance left before this import, and the message for rows past
  -- it. The message names no clock time (the database does not know the
  -- timezone); the app shows local times from quota.resets_at.
  v_quota := public.realtoros_file_import_quota(p_user_id);
  v_limit_message := 'Not imported — daily limit of ' || (v_quota ->> 'limit')
    || ' new contacts reached. Upload this file again 24 hours after this import to add the rest.';

  insert into public.lead_import_batches (
    user_id, workspace_id, connection_id, source_type, file_name, source_event_id,
    status, source_row_count, started_at, metadata
  ) values (
    p_user_id, v_workspace, null, 'file_upload', v_file_name, v_event_id,
    'processing', v_total, now(), jsonb_build_object('start_automation', v_start)
  )
  returning id into v_batch_id;

  v_result := automation_internal.ingest_lead_rows(
    p_user_id, v_workspace, null, v_batch_id, p_rows, 'file_upload', v_start,
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
  where id = v_batch_id and workspace_id = v_workspace;

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
$fn$;
comment on function public.realtoros_ingest_lead_file(uuid, uuid, text, jsonb, boolean) is
  'Phase T2c. File import, scoped to the caller''s WORKSPACE: workspace advisory lock, workspace-wide replay and allowance, and an explicit imports_file check because the Edge Function calls as service_role and RLS does not apply. Signature unchanged - no redeploy needed.';

-- ============================================================
-- 6. The Google Sheets entry point, same treatment.
--
-- A Sheet connection belongs to the workspace, so the lock and the
-- replay key are the workspace's. The connection's creator stays on the
-- rows as the audit trail.
-- ============================================================
create or replace function public.realtoros_ingest_lead_batch(
  p_connection_id uuid,
  p_source_event_id text,
  p_sheet_revision text,
  p_rows jsonb
)
returns jsonb language plpgsql set search_path = '' as $fn$
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

  -- Serialize per WORKSPACE so two different sheets, or a sheet and a
  -- teammate's file upload, cannot create separate contacts for the same
  -- hashed email/phone concurrently.
  perform pg_advisory_xact_lock(
    hashtextextended(v_connection.workspace_id::text, 824733)
  );

  insert into public.lead_import_batches (
    user_id,
    workspace_id,
    connection_id,
    source_event_id,
    sheet_revision,
    status,
    source_row_count,
    started_at
  )
  values (
    v_connection.user_id,
    v_connection.workspace_id,
    v_connection.id,
    btrim(p_source_event_id),
    nullif(btrim(coalesce(p_sheet_revision, '')), ''),
    'processing',
    v_total,
    now()
  )
  on conflict (workspace_id, connection_id, source_event_id) do nothing
  returning id into v_batch_id;

  if v_batch_id is null then
    select *
    into strict v_existing_batch
    from public.lead_import_batches
    where workspace_id = v_connection.workspace_id
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
    v_connection.user_id, v_connection.workspace_id, v_connection.id,
    v_batch_id, p_rows, 'google_sheet', true, null, null
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
    and workspace_id = v_connection.workspace_id;

  update public.lead_source_connections
  set
    last_synced_at = now(),
    last_error = case
      when v_rejected = v_total then 'All submitted rows were rejected.'
      else null
    end
  where id = v_connection.id
    and workspace_id = v_connection.workspace_id;

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
$fn$;
comment on function public.realtoros_ingest_lead_batch(uuid, text, text, jsonb) is
  'Phase T2c. Google Sheet ingestion, scoped to the connection''s WORKSPACE: workspace advisory lock and workspace-wide replay key. Signature unchanged - no redeploy needed.';

-- ============================================================
-- 7. Notification fan-out.
--
-- Until now a notification went to the user_id on the triggering row.
-- For a team that is the wrong person: an imported lead's row carries
-- the IMPORTER, and a sheet sync carries whoever created the connection.
--
-- The rule T2c adopts:
--   * a lead event goes to the ASSIGNED agent, plus everyone who can
--     reassign leads (contacts_assign - owner and admins), so managers
--     stay informed while agents only hear about their own;
--   * if the lead is UNASSIGNED, it goes to everyone holding
--     unassigned_view, which is who is expected to pick it up;
--   * a permission-shaped event (an import finishing, a sync failing)
--     goes to everyone holding the relevant permission.
--
-- dedupe_key stays PER USER: notifications are personal, and the unique
-- index is (user_id, dedupe_key), so the same event reaching three
-- people is three rows with the same key and no conflict.
-- ============================================================

-- notify() keeps its signature and now fills workspace_id, which
-- notifications requires (NOT NULL since T2a).
create or replace function automation_internal.notify(
  p_user_id uuid,
  p_type text,
  p_title text,
  p_body text,
  p_contact_id text,
  p_link_route text,
  p_dedupe_key text,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid language plpgsql set search_path = '' as $fn$
declare
  v_id uuid;
  v_workspace uuid;
begin
  v_workspace := automation_internal.workspace_of(p_user_id);
  if v_workspace is null then
    -- No active membership means nobody to notify. Silent by design:
    -- a notification must never break the write that triggered it.
    return null;
  end if;

  insert into public.notifications (
    user_id, workspace_id, type, title, body, contact_id, link_route,
    dedupe_key, metadata
  ) values (
    p_user_id,
    v_workspace,
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
$fn$;
revoke all on function automation_internal.notify(
  uuid, text, text, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function automation_internal.notify(
  uuid, text, text, text, text, text, text, jsonb) to service_role;

-- Who should hear about this contact?
create or replace function automation_internal.contact_audience(
  p_workspace_id uuid,
  p_contact_id text
)
returns setof uuid language plpgsql stable set search_path = '' as $fn$
declare
  v_assignee text;
  v_found boolean := false;
  r record;
begin
  if p_workspace_id is null then
    return;
  end if;

  if p_contact_id is not null then
    select c.assigned_to_id into v_assignee
      from public.contacts c
     where c.workspace_id = p_workspace_id and c.id = p_contact_id;
  end if;

  for r in
    select wm.user_id, wm.team_member_id
      from public.workspace_members wm
     where wm.workspace_id = p_workspace_id and wm.status = 'active'
  loop
    if v_assignee is not null then
      -- Assigned: the agent who holds it, plus anyone who could reassign it.
      if r.team_member_id = v_assignee
         or automation_internal.member_can(p_workspace_id, r.user_id, 'contacts_assign') then
        v_found := true;
        return next r.user_id;
      end if;
    else
      -- Unassigned: whoever is expected to pick it up.
      if automation_internal.member_can(p_workspace_id, r.user_id, 'unassigned_view') then
        v_found := true;
        return next r.user_id;
      end if;
    end if;
  end loop;

  -- Never drop a notification on the floor: if nobody matched, the
  -- workspace owner hears about it.
  if not v_found then
    return query
      select w.owner_user_id from public.workspaces w where w.id = p_workspace_id;
  end if;
end;
$fn$;
revoke all on function automation_internal.contact_audience(uuid, text)
  from public, anon, authenticated;
grant execute on function automation_internal.contact_audience(uuid, text) to service_role;
comment on function automation_internal.contact_audience(uuid, text) is
  'Phase T2c. Who hears about a contact: its assigned agent plus contacts_assign holders, or - when unassigned - every unassigned_view holder. Falls back to the workspace owner so a notification is never dropped. service_role only.';

create or replace function automation_internal.permission_audience(
  p_workspace_id uuid,
  p_key text
)
returns setof uuid language plpgsql stable set search_path = '' as $fn$
declare
  v_found boolean := false;
  r record;
begin
  if p_workspace_id is null or p_key is null then
    return;
  end if;
  for r in
    select wm.user_id from public.workspace_members wm
     where wm.workspace_id = p_workspace_id and wm.status = 'active'
  loop
    if automation_internal.member_can(p_workspace_id, r.user_id, p_key) then
      v_found := true;
      return next r.user_id;
    end if;
  end loop;
  if not v_found then
    return query
      select w.owner_user_id from public.workspaces w where w.id = p_workspace_id;
  end if;
end;
$fn$;
revoke all on function automation_internal.permission_audience(uuid, text)
  from public, anon, authenticated;
grant execute on function automation_internal.permission_audience(uuid, text) to service_role;
comment on function automation_internal.permission_audience(uuid, text) is
  'Phase T2c. Every active member holding one permission, with the workspace owner as the fallback. service_role only.';

-- Fan out one notification to a list of recipients. One row each, same
-- dedupe_key, which is safe because the unique index is per user.
create or replace function automation_internal.notify_many(
  p_user_ids uuid[],
  p_workspace_id uuid,
  p_type text,
  p_title text,
  p_body text,
  p_contact_id text,
  p_link_route text,
  p_dedupe_key text,
  p_metadata jsonb default '{}'::jsonb
)
returns integer language plpgsql set search_path = '' as $fn$
declare
  v_sent integer := 0;
  v_user uuid;
begin
  if p_user_ids is null or p_workspace_id is null then
    return 0;
  end if;
  foreach v_user in array p_user_ids loop
    if v_user is null then continue; end if;
    insert into public.notifications (
      user_id, workspace_id, type, title, body, contact_id, link_route,
      dedupe_key, metadata
    ) values (
      v_user,
      p_workspace_id,
      p_type,
      left(btrim(regexp_replace(coalesce(p_title, ''), '[[:cntrl:]]+', ' ', 'g')), 200),
      left(btrim(regexp_replace(coalesce(p_body, ''), '[[:cntrl:]]+', ' ', 'g')), 1000),
      p_contact_id,
      p_link_route,
      p_dedupe_key,
      coalesce(p_metadata, '{}'::jsonb)
    )
    on conflict (user_id, dedupe_key) do nothing;
    v_sent := v_sent + 1;
  end loop;
  return v_sent;
end;
$fn$;
revoke all on function automation_internal.notify_many(
  uuid[], uuid, text, text, text, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function automation_internal.notify_many(
  uuid[], uuid, text, text, text, text, text, text, jsonb) to service_role;
comment on function automation_internal.notify_many(uuid[], uuid, text, text, text, text, text, text, jsonb) is
  'Phase T2c. One notification to many recipients: one row each, sharing a dedupe_key, which is safe because notifications unique index is (user_id, dedupe_key). service_role only.';

-- Convenience wrappers the triggers call.
create or replace function automation_internal.notify_contact(
  p_workspace_id uuid,
  p_type text,
  p_title text,
  p_body text,
  p_contact_id text,
  p_link_route text,
  p_dedupe_key text,
  p_metadata jsonb default '{}'::jsonb
)
returns integer language sql set search_path = '' as $fn$
  select automation_internal.notify_many(
    (select coalesce(array_agg(u), '{}'::uuid[])
       from automation_internal.contact_audience(p_workspace_id, p_contact_id) u),
    p_workspace_id, p_type, p_title, p_body, p_contact_id, p_link_route,
    p_dedupe_key, p_metadata);
$fn$;
revoke all on function automation_internal.notify_contact(
  uuid, text, text, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function automation_internal.notify_contact(
  uuid, text, text, text, text, text, text, jsonb) to service_role;

create or replace function automation_internal.notify_permission(
  p_workspace_id uuid,
  p_key text,
  p_type text,
  p_title text,
  p_body text,
  p_contact_id text,
  p_link_route text,
  p_dedupe_key text,
  p_metadata jsonb default '{}'::jsonb
)
returns integer language sql set search_path = '' as $fn$
  select automation_internal.notify_many(
    (select coalesce(array_agg(u), '{}'::uuid[])
       from automation_internal.permission_audience(p_workspace_id, p_key) u),
    p_workspace_id, p_type, p_title, p_body, p_contact_id, p_link_route,
    p_dedupe_key, p_metadata);
$fn$;
revoke all on function automation_internal.notify_permission(
  uuid, text, text, text, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function automation_internal.notify_permission(
  uuid, text, text, text, text, text, text, text, jsonb) to service_role;

-- ============================================================
-- 8. Rewire the Phase 4H notification triggers onto the fan-out.
--
-- The wrappers above change nothing on their own: the triggers still
-- addressed new.user_id. These replacements route each event to the
-- people the §7 rule names.
--
-- Audience per event, and why:
--   lead_replied / unsubscribed / spam_report / email_bounced
--     -> notify_contact. These are about ONE LEAD, so the person
--        holding that lead must hear, and whoever could reassign it
--        should too.
--   followup_failed
--     -> notify_contact, same reasoning: it is that lead's automation.
--   import_finished (file upload)
--     -> the UPLOADER alone. They are standing in front of the dialog
--        waiting for it; telling the whole team that a colleague
--        uploaded a file is noise, not information.
--   import_finished (Google Sheet)
--     -> integrations_manage holders. Nobody clicked it, so there is no
--        "uploader"; the people who own the integration are the ones who
--        can act on a failing sync.
--
-- Wording, titles, dedupe keys, metadata and the "saved normally"
-- exception handling are all unchanged. Only the scope of the lookups
-- and the choice of recipients changes.
-- ============================================================

-- Contact lookup by WORKSPACE: in a team the lead may belong to a
-- colleague, so the per-user lookup would come back empty and every
-- notification would read "A contact".
create or replace function automation_internal.notification_contact_name_ws(
  p_workspace_id uuid,
  p_contact_id text
)
returns text language plpgsql stable set search_path = '' as $fn$
declare
  v_name text;
begin
  if p_contact_id is null or p_workspace_id is null then
    return null;
  end if;
  select full_name into v_name
  from public.contacts
  where workspace_id = p_workspace_id and id = p_contact_id;
  v_name := btrim(regexp_replace(coalesce(v_name, ''), '[[:space:][:cntrl:]]+', ' ', 'g'));
  if v_name = '' or position('@' in v_name) > 0 then
    return null;
  end if;
  return left(v_name, 80);
end;
$fn$;
revoke all on function automation_internal.notification_contact_name_ws(uuid, text)
  from public, anon, authenticated;
grant execute on function automation_internal.notification_contact_name_ws(uuid, text)
  to service_role;

-- 8a. contact_stop_events -> the lead's people.
create or replace function automation_internal.notify_on_stop_event()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  v_name text;
  v_who text;
  v_type text;
  v_title text;
  v_body text;
begin
  -- Someone did this by hand; telling them about it is noise.
  if new.source = 'owner_manual' and new.event_type in ('reply', 'unsubscribe') then
    return null;
  end if;

  begin
    v_name := automation_internal.notification_contact_name_ws(new.workspace_id, new.contact_id);
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

    perform automation_internal.notify_contact(
      new.workspace_id, v_type, v_title, v_body, new.contact_id,
      automation_internal.notification_contact_route(new.contact_id),
      'stop:' || new.id::text,
      jsonb_build_object('event_type', new.event_type, 'source', new.source)
    );
  exception when others then
    raise warning 'RealtorOS: a notification could not be created (SQLSTATE %); the stop event was saved normally.', sqlstate;
  end;
  return null;
end;
$$;

-- 8b. automation_jobs -> the lead's people.
create or replace function automation_internal.notify_on_job_failed()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  v_who text;
  v_title text;
begin
  begin
    v_who := coalesce(
      automation_internal.notification_contact_name_ws(new.workspace_id, new.contact_id),
      'a contact');
    v_title := case when new.job_type = 'send_email'
      then 'A follow-up email to ' || v_who || ' couldn''t be sent'
      else 'An automation step for ' || v_who || ' couldn''t be completed'
    end;
    perform automation_internal.notify_contact(
      new.workspace_id, 'followup_failed', v_title,
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
$$;

-- 8c. lead_import_batches -> the uploader, or integrations_manage.
--
-- The 60-minute Sheet grouping is kept, but applied PER RECIPIENT: each
-- person's own unread Sheet notification is the one that gets updated.
-- Grouping across recipients would be wrong - one teammate reading it
-- would decide what another teammate sees.
create or replace function automation_internal.notify_on_import_batch()
returns trigger language plpgsql security invoker set search_path = '' as $$
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
  v_recipient uuid;
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

      -- The uploader alone: this is the reply to something they just did.
      perform automation_internal.notify_many(
        array[new.user_id], new.workspace_id, 'import_finished', v_title, v_body, null,
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

      select automation_internal.notification_plain(name, 60) into v_source_name
      from public.lead_source_connections
      where id = new.connection_id and workspace_id = new.workspace_id;

      for v_recipient in
        select u from automation_internal.permission_audience(
          new.workspace_id, 'integrations_manage') u
      loop
        v_existing := null;
        select * into v_existing
        from public.notifications
        where user_id = v_recipient
          and type = 'import_finished'
          and read_at is null
          and metadata ->> 'source_type' = 'google_sheet'
          and metadata ->> 'connection_id' = new.connection_id::text
          and created_at > now() - interval '60 minutes'
        order by created_at desc
        limit 1
        for update;

        v_added := coalesce(new.imported_count, 0)
          + coalesce((v_existing.metadata ->> 'imported')::integer, 0);
        v_fix := coalesce(new.rejected_count, 0)
          + coalesce((v_existing.metadata ->> 'need_fixing')::integer, 0);
        v_batches := 1 + coalesce((v_existing.metadata ->> 'batches')::integer, 0);

        v_parts := array[]::text[];
        if v_added > 0 then
          v_parts := v_parts || (v_added || case when v_added = 1 then ' new lead' else ' new leads' end);
        end if;
        if v_fix > 0 then
          v_parts := v_parts || (v_fix || case when v_fix = 1 then ' needs fixing' else ' need fixing' end);
        end if;
        v_title := 'Google Sheets sync: ' || array_to_string(v_parts, ', ');

        v_body := case when coalesce(v_source_name, '') <> ''
            then 'From "' || v_source_name || '"' else 'From your Google Sheet' end
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
          perform automation_internal.notify_many(
            array[v_recipient], new.workspace_id, 'import_finished', v_title, v_body, null,
            '/settings/sheet-imports', 'import:' || new.id::text,
            jsonb_build_object(
              'source_type', 'google_sheet', 'connection_id', new.connection_id,
              'batch_id', new.id, 'status', new.status,
              'imported', v_added, 'need_fixing', v_fix, 'batches', v_batches
            )
          );
        end if;
      end loop;
    end if;
  exception when others then
    raise warning 'RealtorOS: a notification could not be created (SQLSTATE %); the import was saved normally.', sqlstate;
  end;
  return null;
end;
$$;

-- 8d. realtoros_mark_reply_hot: the hot-reply upgrade, fanned out the
--     same way. The reason labels, the title and the
--     type in ('lead_replied','hot_reply') guard are exactly as before;
--     only the lookup scope and the recipients change.
create or replace function public.realtoros_mark_reply_hot(
  p_user_id uuid,
  p_event_ref text,
  p_reason text
)
returns jsonb language plpgsql set search_path = '' as $fn$
declare
  v_workspace uuid;
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

  v_workspace := automation_internal.workspace_of(p_user_id);
  if v_workspace is null then
    raise exception 'workspace_required' using errcode = '22023';
  end if;

  -- Found by WORKSPACE: the reply may belong to a teammate's lead, and
  -- the webhook authenticates the connection's owner, not the assignee.
  select * into v_event
  from public.contact_stop_events
  where workspace_id = v_workspace
    and source = 'inbound_email'
    and event_type = 'reply'
    and event_ref = p_event_ref;
  if not found then
    return jsonb_build_object('outcome', 'no_reply_event');
  end if;

  v_title := '🔥 ' || coalesce(
      automation_internal.notification_contact_name_ws(v_workspace, v_event.contact_id),
      'A contact')
    || ' replied — ' || v_label;

  -- Upgrade EVERY recipient's copy of that reply notification, not just
  -- one person's.
  update public.notifications
  set type = 'hot_reply',
      title = left(v_title, 200),
      metadata = metadata || jsonb_build_object('hot_reason', p_reason)
  where workspace_id = v_workspace
    and dedupe_key = 'stop:' || v_event.id::text
    and type in ('lead_replied', 'hot_reply');
  get diagnostics v_rows = row_count;

  if v_rows = 0 then
    perform automation_internal.notify_contact(
      v_workspace, 'hot_reply', v_title,
      'Their reply is in your email inbox. Automations set to stop when a contact replies have stopped for them.',
      v_event.contact_id,
      automation_internal.notification_contact_route(v_event.contact_id),
      'stop:' || v_event.id::text,
      jsonb_build_object('event_type', 'reply', 'source', 'inbound_email', 'hot_reason', p_reason)
    );
  end if;

  return jsonb_build_object('outcome', 'marked', 'reason', p_reason);
end;
$fn$;
comment on function public.realtoros_mark_reply_hot(uuid, text, text) is
  'Phase T2c. Unchanged behaviour except scope: the reply event is found by WORKSPACE and the hot_reply upgrade is applied to every recipient copy of that notification, not just the owner one. service_role only.';
