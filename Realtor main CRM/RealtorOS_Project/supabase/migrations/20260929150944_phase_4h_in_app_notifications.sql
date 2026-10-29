-- Phase 4H: in-app notifications.
--
-- Applies on top of the live history (last applied version 20260929095530,
-- phase_4e_4_file_lead_import). Nothing here activates a rule, enrolls a
-- contact, or sends an email. No existing function is changed: the
-- notifications are created by NEW triggers on the tables those functions
-- already write.
--
-- WHAT THIS DOES
--   1. public.notifications: one row per thing the owner should know about
--      (a lead replied, a hot reply, an unsubscribe, a spam report, a
--      bounce, an import finished, a follow-up failed). Plain text only;
--      never message bodies, email addresses or tokens.
--   2. Browser access: read own rows; mark own rows read. Nothing else.
--      A column-level grant (UPDATE (read_at) only) plus owner RLS policies:
--      the browser can set read_at on its own rows and cannot insert,
--      delete, or change any other column (type, title, user_id, ...).
--   3. automation_internal.notify(): the one internal writer, idempotent on
--      (user_id, dedupe_key).
--   4. Triggers (each wraps its work so a notification problem can NEVER
--      roll back or break the import, stop event or job it observes: the
--      error is caught, a WARNING without personal data is raised, and the
--      original statement carries on):
--        a) AFTER INSERT on contact_stop_events -> lead_replied /
--           unsubscribed / spam_report / email_bounced, one per stop event
--           (dedupe 'stop:<event id>'). Replies and unsubscribes the owner
--           marked themselves (source owner_manual) make no notification.
--        b) AFTER INSERT / UPDATE OF status on lead_import_batches, when a
--           batch becomes completed / partial / failed -> import_finished.
--           File uploads: always one per batch. Google Sheet syncs: only
--           when something was imported or rejected, and grouped into one
--           unread notification per connection per hour.
--        c) AFTER UPDATE OF status on automation_jobs, when a job becomes
--           'failed' (terminal) -> followup_failed, one per failure.
--   5. public.realtoros_mark_reply_hot(): service_role-only. resend-webhook
--      calls it after recording a reply its rule-based detector judged
--      "hot"; it turns that reply's own notification into 'hot_reply', so a
--      reply always has exactly one notification.
--
-- Every function: SECURITY INVOKER, empty search_path, EXECUTE revoked from
-- public/anon/authenticated, granted to service_role only.

-- ============================================================
-- 1. TABLE
-- ============================================================
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null
    check (type in ('lead_replied', 'hot_reply', 'unsubscribed', 'spam_report',
                    'email_bounced', 'import_finished', 'followup_failed')),
  title text not null
    check (char_length(title) between 1 and 200
           and title !~ '[\x00-\x1F\x7F]'
           and title !~ '[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+'),
  body text not null default ''
    check (char_length(body) <= 1000
           and body !~ '[\x00-\x1F\x7F]'
           and body !~ '[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+'),
  contact_id text,
  -- Internal app routes only (never a URL): the same allow-list the app
  -- enforces before navigating.
  link_route text
    check (link_route is null
           or link_route ~ '^/(contacts(/[A-Za-z0-9_-]{1,120})?|settings/sheet-imports|automation|notifications)$'),
  dedupe_key text not null
    check (char_length(dedupe_key) between 1 and 200 and dedupe_key !~ '[\x00-\x1F\x7F]'),
  -- Small, structured, and free of message bodies, addresses and tokens:
  -- counts, ids, event type/source, a hot-reply reason code.
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) <= 2048),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  unique (user_id, id),
  unique (user_id, dedupe_key),
  foreign key (user_id, contact_id)
    references public.contacts(user_id, id) on delete set null (contact_id)
);

create index if not exists notifications_user_created_idx
  on public.notifications (user_id, created_at desc);
create index if not exists notifications_user_unread_idx
  on public.notifications (user_id, created_at desc)
  where read_at is null;

comment on table public.notifications is
  'In-app notifications for the owner (Phase 4H). Written only by database triggers through automation_internal.notify() and by realtoros_mark_reply_hot(). The browser may read its own rows and set read_at on them; nothing else.';
comment on column public.notifications.dedupe_key is
  'Idempotency key, unique per owner: stop:<stop event id>, import:<batch id>, job_failed:<job id>:<manual retry count>.';

-- ============================================================
-- 2. ACCESS
-- ============================================================
-- The browser marks notifications read with a plain PATCH of read_at: a
-- column-level UPDATE grant (read_at only) and an owner RLS policy with
-- USING and WITH CHECK, so it can touch only its own rows and only that
-- column. Chosen over an RPC because it needs no extra function, works with
-- the standard client, and both limits (own rows, one column) are enforced
-- by Postgres itself. No INSERT or DELETE for the browser at all.
alter table public.notifications enable row level security;

revoke all on table public.notifications from public, anon, authenticated;
grant select on table public.notifications to authenticated;
grant update (read_at) on table public.notifications to authenticated;
grant all on table public.notifications to service_role;

drop policy if exists notifications_select_own on public.notifications;
create policy notifications_select_own on public.notifications
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists notifications_update_own on public.notifications;
create policy notifications_update_own on public.notifications
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- ============================================================
-- 3. INTERNAL HELPERS
-- ============================================================

-- A contact's name for a notification, or NULL when there is none. Control
-- characters removed, spaces collapsed, at most 80 characters. A "name"
-- containing '@' (an address typed into the name field) is never used, so
-- a notification never shows an email address.
create or replace function automation_internal.notification_contact_name(
  p_user_id uuid,
  p_contact_id text
)
returns text
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_name text;
begin
  if p_contact_id is null then
    return null;
  end if;
  select full_name into v_name
  from public.contacts
  where user_id = p_user_id and id = p_contact_id;
  v_name := btrim(regexp_replace(coalesce(v_name, ''), '[[:space:][:cntrl:]]+', ' ', 'g'));
  if v_name = '' or position('@' in v_name) > 0 then
    return null;
  end if;
  return left(v_name, 80);
end;
$$;

-- The app route for a contact: its detail page when the id is route-safe,
-- otherwise the contact list.
create or replace function automation_internal.notification_contact_route(p_contact_id text)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select case
    when p_contact_id is null then null
    when p_contact_id ~ '^[A-Za-z0-9_-]{1,120}$' then '/contacts/' || p_contact_id
    else '/contacts'
  end;
$$;

-- Free text (a file or connection name) made safe for a notification:
-- control characters and anything shaped like an email address removed,
-- spaces collapsed, cut to p_max characters.
create or replace function automation_internal.notification_plain(p_text text, p_max integer)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select left(btrim(regexp_replace(
    regexp_replace(coalesce(p_text, ''), '[^[:space:]@]*@[^[:space:]@]*', '…', 'g'),
    '[[:space:][:cntrl:]]+', ' ', 'g')), greatest(p_max, 1));
$$;

-- The one internal writer. Idempotent on (user_id, dedupe_key): a second
-- call with the same key changes nothing and returns the existing id.
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
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
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
$$;

-- ============================================================
-- 4a. STOP EVENTS -> reply / unsubscribe / spam / bounce
-- ============================================================
-- contact_stop_events gets exactly one row per APPLIED stop event
-- (realtoros_record_contact_stop_event inserts it last, and a replayed
-- event inserts nothing), so one notification per row is one per event.
create or replace function automation_internal.notify_on_stop_event()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
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
$$;

drop trigger if exists notify_on_stop_event on public.contact_stop_events;
create trigger notify_on_stop_event
  after insert on public.contact_stop_events
  for each row execute function automation_internal.notify_on_stop_event();

-- ============================================================
-- 4b. IMPORT BATCHES -> import_finished
-- ============================================================
-- Both writers (realtoros_ingest_lead_batch for Google Sheets,
-- realtoros_ingest_lead_file for files) insert a batch as 'processing' and
-- update it to completed / partial / failed once, in the same transaction.
-- A replay inserts and updates nothing. The UPDATE trigger fires only on
-- that transition; the INSERT trigger covers any batch ever inserted
-- already final. Either way: exactly once per batch.
--
-- Google Sheet syncs are grouped: if an UNREAD Sheet notification for the
-- same connection was created in the last 60 minutes, it is updated (counts
-- added, created_at refreshed) instead of adding another. Sheet imports for
-- one owner are serialized by realtoros_ingest_lead_batch's advisory lock,
-- and this trigger runs inside that transaction, so grouping cannot race.
create or replace function automation_internal.notify_on_import_batch()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
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
$$;

drop trigger if exists notify_on_import_batch_insert on public.lead_import_batches;
create trigger notify_on_import_batch_insert
  after insert on public.lead_import_batches
  for each row
  when (new.status in ('completed', 'partial', 'failed'))
  execute function automation_internal.notify_on_import_batch();

drop trigger if exists notify_on_import_batch_update on public.lead_import_batches;
create trigger notify_on_import_batch_update
  after update of status on public.lead_import_batches
  for each row
  when (old.status is distinct from new.status
        and new.status in ('completed', 'partial', 'failed')
        and old.status not in ('completed', 'partial', 'failed'))
  execute function automation_internal.notify_on_import_batch();

-- ============================================================
-- 4c. AUTOMATION JOBS -> followup_failed
-- ============================================================
-- 'failed' is terminal for a job; a retry reschedules it as 'pending' and
-- never reaches this trigger. A manual retry (at most one per job) that
-- fails again is a new failure, so the dedupe key includes the job's
-- manual_retry_count.
create or replace function automation_internal.notify_on_job_failed()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
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
$$;

drop trigger if exists notify_on_job_failed on public.automation_jobs;
create trigger notify_on_job_failed
  after update of status on public.automation_jobs
  for each row
  when (new.status = 'failed' and old.status is distinct from 'failed')
  execute function automation_internal.notify_on_job_failed();

-- ============================================================
-- 5. HOT REPLIES
-- ============================================================
-- resend-webhook runs a rule-based detector on the reply (the text itself
-- is never stored) and, when it finds buying/selling intent, calls this
-- with a short reason code AFTER realtoros_record_contact_stop_event has
-- recorded the reply. The reply's notification (dedupe 'stop:<event id>')
-- becomes 'hot_reply' with a title that says why. Idempotent: a duplicate
-- delivery updates the same row to the same values. If the reply's
-- notification does not exist (it could not be created), it is created
-- here as hot_reply under the same key, so there is still exactly one.
-- Read state is never changed.
create or replace function public.realtoros_mark_reply_hot(
  p_user_id uuid,
  p_event_ref text,
  p_reason text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
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
$$;

-- ============================================================
-- 6. GRANTS (service_role only for every function)
-- ============================================================
revoke all on function automation_internal.notification_contact_name(uuid, text) from public, anon, authenticated;
revoke all on function automation_internal.notification_contact_route(text) from public, anon, authenticated;
revoke all on function automation_internal.notification_plain(text, integer) from public, anon, authenticated;
revoke all on function automation_internal.notify(uuid, text, text, text, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function automation_internal.notify_on_stop_event() from public, anon, authenticated;
revoke all on function automation_internal.notify_on_import_batch() from public, anon, authenticated;
revoke all on function automation_internal.notify_on_job_failed() from public, anon, authenticated;
revoke all on function public.realtoros_mark_reply_hot(uuid, text, text) from public, anon, authenticated;

grant execute on function automation_internal.notification_contact_name(uuid, text) to service_role;
grant execute on function automation_internal.notification_contact_route(text) to service_role;
grant execute on function automation_internal.notification_plain(text, integer) to service_role;
grant execute on function automation_internal.notify(uuid, text, text, text, text, text, text, jsonb) to service_role;
grant execute on function automation_internal.notify_on_stop_event() to service_role;
grant execute on function automation_internal.notify_on_import_batch() to service_role;
grant execute on function automation_internal.notify_on_job_failed() to service_role;
grant execute on function public.realtoros_mark_reply_hot(uuid, text, text) to service_role;

comment on function automation_internal.notify(uuid, text, text, text, text, text, text, jsonb) is
  'Internal. The single writer for public.notifications, idempotent on (user_id, dedupe_key). Called only by the Phase 4H notification triggers and realtoros_mark_reply_hot. Not reachable through the API (non-exposed schema); service_role only.';
comment on function public.realtoros_mark_reply_hot(uuid, text, text) is
  'service_role-only. Called by resend-webhook after recording an inbound reply its rule-based detector judged hot. Turns that reply''s notification into hot_reply with a reason (viewing, offer, ready, financing, call_request, availability, price). Idempotent; never stores reply text. Never callable by anon or authenticated.';
