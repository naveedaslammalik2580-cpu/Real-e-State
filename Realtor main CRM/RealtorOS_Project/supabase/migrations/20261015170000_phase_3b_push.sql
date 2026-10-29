-- Phase 3B: notifications that reach a phone that is not open.
--
-- Phase 4H put notifications in the app and Phase 2C started creating
-- useful ones - a lead replied, a follow-up is overdue. All of them are
-- only seen by somebody who already has RealtorOS open, which is the one
-- state an agent is usually not in. 3A made the app installable; this
-- makes it able to tap somebody on the shoulder.
--
-- WHAT IS HERE
--
--   * push_subscriptions - one row per browser that said yes. Written by
--     the browser only through two SECURITY DEFINER functions, never
--     directly, because the row carries the workspace and the owner and
--     neither is the browser's to choose.
--   * notification_preferences - whether to push at all, which kinds, and
--     the hours not to.
--   * four columns on notifications, so a notification knows whether it
--     has been pushed. The queue is the notifications table itself: a
--     second queue table would be a second thing to get out of step with
--     the first.
--   * two service-role RPCs, claim and complete, in the shape the existing
--     worker already uses everywhere else - SKIP LOCKED, a short lease, an
--     explicit completion.
--
-- NOTHING HERE SENDS ANYTHING. The sending lives in the worker. This
-- migration can be applied long before the VAPID keys exist: with no keys
-- the worker skips the step, rows stay 'pending', and nothing breaks.
--
-- COLLATION. Every ORDER BY on text says COLLATE "C" - live is
-- en_US.UTF-8 and PGlite is not, and Phase 2F was a whole wrapper failing
-- on exactly that difference.
--
-- RE-RUNNING. Everything is guarded or create-or-replace, and the verify
-- block declares NO VARIABLES (see the 2E migration for why a
-- `select ... into v_n` outside PL/pgSQL is a CREATE TABLE).

-- ============================================================
-- 1. THE DEVICES
--
-- An endpoint is the address of one browser on one device, minted by
-- Google or Apple or Mozilla. It is unique globally, which is what makes
-- re-registering safe: the same browser coming back is an UPDATE, never a
-- second row, and a device handed to a new colleague moves to them rather
-- than quietly delivering the old owner's notifications.
--
-- The keys are not secrets of ours - they are the device's public key and
-- a salt, useless without the endpoint - but they are still only ever read
-- by the service role.
-- ============================================================
create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique
    check (endpoint ~ '^https://' and char_length(endpoint) between 20 and 2000),
  p256dh text not null check (char_length(p256dh) between 20 and 200),
  auth text not null check (char_length(auth) between 8 and 64),
  -- What the agent will see in the device list. Theirs to type, so it is
  -- length-capped and stripped of control characters like every other
  -- free-text column in this schema.
  device_label text not null default ''
    check (char_length(device_label) <= 60 and device_label !~ '[\x00-\x1F\x7F]'),
  created_at timestamptz not null default now(),
  last_success_at timestamptz,
  failure_count integer not null default 0 check (failure_count >= 0)
);

create index if not exists push_subscriptions_user_idx
  on public.push_subscriptions (user_id, created_at desc);
create index if not exists push_subscriptions_workspace_idx
  on public.push_subscriptions (workspace_id);

comment on table public.push_subscriptions is
  'Phase 3B. One row per browser that agreed to notifications. The browser may read its own rows and nothing else; all writes go through realtoros_register_push_subscription / realtoros_remove_push_subscription, which set the owner and workspace from the session rather than the request.';

alter table public.push_subscriptions enable row level security;
revoke all on table public.push_subscriptions from public, anon, authenticated;
-- SELECT only. No insert, update or delete grant at all: the two RPCs are
-- the only way in, so there is no path where a browser names its own
-- workspace_id or somebody else's user_id.
grant select on table public.push_subscriptions to authenticated;
grant all on table public.push_subscriptions to service_role;

drop policy if exists push_subscriptions_select_own on public.push_subscriptions;
create policy push_subscriptions_select_own on public.push_subscriptions
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- ============================================================
-- 2. THE PREFERENCES
--
-- One row per person. Absent means the defaults, which are "yes, all of
-- them, at any hour" - a notification somebody has opted into by turning
-- the browser permission on should not then be silently filtered.
-- ============================================================

-- The kinds that exist today, as one list the table default, the
-- validator and the claim all read. Adding a type later means adding it
-- here and nowhere else.
create or replace function automation_internal.push_notification_types()
returns text[]
language sql
immutable
set search_path = ''
as $fn$
  select array[
    'lead_replied', 'hot_reply', 'unsubscribed', 'spam_report',
    'email_bounced', 'import_finished', 'followup_failed',
    'contact_untouched', 'overdue_followups'
  ]::text[];
$fn$;

revoke all on function automation_internal.push_notification_types() from public, anon;
grant execute on function automation_internal.push_notification_types()
  to authenticated, service_role;

comment on function automation_internal.push_notification_types() is
  'Phase 3B. The notification types a push can carry - the same list as the notifications_type_check constraint. The default for notification_preferences.push_types and the allow-list the setter validates against.';

create table if not exists public.notification_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  push_enabled boolean not null default true,
  push_types text[] not null default automation_internal.push_notification_types(),
  -- Both or neither: half a window is not a window, and the check says so
  -- rather than the claim having to guess.
  quiet_start time,
  quiet_end time,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notification_preferences_quiet_pair
    check ((quiet_start is null) = (quiet_end is null)),
  constraint notification_preferences_types_known
    check (push_types <@ automation_internal.push_notification_types())
);

comment on table public.notification_preferences is
  'Phase 3B. Per-person push preferences. No row means the defaults: push on, every type, no quiet hours. Written only through realtoros_set_notification_preferences.';

alter table public.notification_preferences enable row level security;
revoke all on table public.notification_preferences from public, anon, authenticated;
grant select on table public.notification_preferences to authenticated;
grant all on table public.notification_preferences to service_role;

drop policy if exists notification_preferences_select_own on public.notification_preferences;
create policy notification_preferences_select_own on public.notification_preferences
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- ============================================================
-- 3. THE QUEUE, WHICH IS THE NOTIFICATIONS TABLE
--
-- push_status on the notification itself rather than a push_queue table.
-- A queue row would have to be created by something, kept in step with
-- its notification, and cleaned up; a column cannot drift from the row it
-- is on.
--
-- EXISTING ROWS ARE 'skipped', NOT 'pending'. Every notification created
-- before today has already been seen in the app or has stopped mattering,
-- and a backfill of 'pending' would mean every agent's phone buzzing
-- through months of history the first time the worker runs. The column is
-- therefore added with 'skipped' as its default - which is what existing
-- rows get - and the default is then changed to 'pending' for new ones.
-- ============================================================
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'notifications'
       and column_name = 'push_status'
  ) then
    alter table public.notifications
      add column push_status text not null default 'skipped';
    -- New rows from here on are candidates; the rows that existed a
    -- moment ago are not.
    alter table public.notifications
      alter column push_status set default 'pending';
  end if;
end $$;

alter table public.notifications
  add column if not exists push_attempts integer not null default 0,
  add column if not exists pushed_at timestamptz,
  add column if not exists push_locked_until timestamptz;

alter table public.notifications
  drop constraint if exists notifications_push_status_check;
alter table public.notifications
  add constraint notifications_push_status_check
  check (push_status in ('pending', 'sent', 'skipped', 'failed'));

alter table public.notifications
  drop constraint if exists notifications_push_attempts_check;
alter table public.notifications
  add constraint notifications_push_attempts_check
  check (push_attempts between 0 and 10);

-- The claim's own index: the pending few, oldest first, out of however
-- many notifications exist.
create index if not exists notifications_push_pending_idx
  on public.notifications (created_at)
  where push_status = 'pending';

comment on column public.notifications.push_status is
  'Phase 3B. pending = waiting for the worker; sent = at least one device accepted it; skipped = push is off, the type is off, there are no devices, or the row predates Phase 3B; failed = three attempts, all refused.';

-- The browser can already UPDATE read_at on its own rows. These four
-- columns are deliberately NOT added to that grant: whether something was
-- pushed is the server's account of what it did.

-- ============================================================
-- 4. REGISTERING A DEVICE
--
-- SECURITY DEFINER because the browser is not allowed to write the table
-- and must not be allowed to choose the owner or the workspace. Both come
-- from the session: auth.uid(), and the one active membership it has.
-- ============================================================
create or replace function public.realtoros_register_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_label text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_user uuid := (select auth.uid());
  v_workspace uuid;
  v_label text := left(btrim(coalesce(p_label, '')), 60);
  v_id uuid;
  v_reassigned boolean := false;
begin
  if v_user is null then
    return jsonb_build_object('outcome', 'not_signed_in');
  end if;

  select wm.workspace_id into v_workspace
    from public.workspace_members wm
   where wm.user_id = v_user and wm.status = 'active'
   limit 1;
  if v_workspace is null then
    return jsonb_build_object('outcome', 'no_workspace');
  end if;

  -- Shape only. The endpoint and keys are minted by the browser's push
  -- service and are opaque to us; what matters is that they are the right
  -- sort of thing and cannot be a novel.
  if p_endpoint is null or p_endpoint !~ '^https://' or char_length(p_endpoint) > 2000
     or char_length(p_endpoint) < 20 then
    return jsonb_build_object('outcome', 'invalid_endpoint');
  end if;
  if p_p256dh is null or char_length(p_p256dh) not between 20 and 200
     or p_auth is null or char_length(p_auth) not between 8 and 64 then
    return jsonb_build_object('outcome', 'invalid_keys');
  end if;
  -- Control characters would travel into a header or a log.
  if p_endpoint ~ '[\x00-\x1F\x7F]' or p_p256dh ~ '[^A-Za-z0-9_=-]' or p_auth ~ '[^A-Za-z0-9_=-]' then
    return jsonb_build_object('outcome', 'invalid_keys');
  end if;
  v_label := regexp_replace(v_label, '[\x00-\x1F\x7F]', '', 'g');

  -- Did this endpoint already belong to somebody else? Worth saying so in
  -- the answer, because it is the one case that removes another person's
  -- device - a shared iPad, or a colleague signing in on this browser.
  select (s.user_id <> v_user) into v_reassigned
    from public.push_subscriptions s where s.endpoint = p_endpoint;

  insert into public.push_subscriptions
    (workspace_id, user_id, endpoint, p256dh, auth, device_label)
  values (v_workspace, v_user, p_endpoint, p_p256dh, p_auth, v_label)
  on conflict (endpoint) do update
    set workspace_id = excluded.workspace_id,
        user_id = excluded.user_id,
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        -- A re-register with no label keeps the one that is there, so a
        -- silent refresh does not wipe what the agent typed.
        device_label = case when excluded.device_label = '' then public.push_subscriptions.device_label
                            else excluded.device_label end,
        -- A browser that just re-subscribed is healthy whatever happened
        -- to the endpoint it replaced.
        failure_count = 0
  returning id into v_id;

  return jsonb_build_object(
    'outcome', 'registered',
    'id', v_id,
    'reassigned', coalesce(v_reassigned, false));
end;
$fn$;

revoke all on function public.realtoros_register_push_subscription(text, text, text, text)
  from public, anon;
grant execute on function public.realtoros_register_push_subscription(text, text, text, text)
  to authenticated;

comment on function public.realtoros_register_push_subscription(text, text, text, text) is
  'Phase 3B. Records this browser as a push device for the signed-in user. The owner and workspace come from the session, never the request. Re-registering the same endpoint updates it; an endpoint that belonged to another user moves to the caller.';

create or replace function public.realtoros_remove_push_subscription(
  p_endpoint text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_user uuid := (select auth.uid());
  v_removed integer;
begin
  if v_user is null then
    return jsonb_build_object('outcome', 'not_signed_in');
  end if;
  -- Own rows only, enforced here because SECURITY DEFINER bypasses RLS.
  delete from public.push_subscriptions
   where endpoint = p_endpoint and user_id = v_user;
  get diagnostics v_removed = row_count;
  return jsonb_build_object('outcome', case when v_removed > 0 then 'removed' else 'not_found' end,
                            'removed', v_removed);
end;
$fn$;

revoke all on function public.realtoros_remove_push_subscription(text) from public, anon;
grant execute on function public.realtoros_remove_push_subscription(text) to authenticated;

comment on function public.realtoros_remove_push_subscription(text) is
  'Phase 3B. Forgets one of the caller''s own push devices. Somebody else''s endpoint is simply not found.';

-- ============================================================
-- 5. THE PREFERENCES SETTER AND READER
-- ============================================================
create or replace function public.realtoros_set_notification_preferences(
  p_push_enabled boolean,
  p_push_types text[],
  p_quiet_start time default null,
  p_quiet_end time default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_user uuid := (select auth.uid());
  v_workspace uuid;
  v_types text[];
begin
  if v_user is null then
    return jsonb_build_object('outcome', 'not_signed_in');
  end if;
  select wm.workspace_id into v_workspace
    from public.workspace_members wm
   where wm.user_id = v_user and wm.status = 'active'
   limit 1;
  if v_workspace is null then
    return jsonb_build_object('outcome', 'no_workspace');
  end if;

  if (p_quiet_start is null) <> (p_quiet_end is null) then
    return jsonb_build_object('outcome', 'invalid_quiet_hours');
  end if;

  -- De-duplicated and sorted, COLLATE "C" so the stored array is the same
  -- array whatever the server's locale (Phase 2F learnt this the hard
  -- way). An unknown type is a rejection rather than a silent drop: the
  -- UI and the database disagreeing about what exists is worth knowing.
  if p_push_types is null then
    v_types := automation_internal.push_notification_types();
  else
    if exists (
      select 1 from unnest(p_push_types) as t
       where not (t = any (automation_internal.push_notification_types()))
    ) then
      return jsonb_build_object('outcome', 'unknown_type');
    end if;
    -- Distinct first, ordered second. Postgres requires an aggregate's
    -- ORDER BY expression to match its argument exactly, and `t collate
    -- "C"` is not `t`, so the two steps are separated rather than
    -- dropping the collation.
    v_types := array(
      select d.t from (select distinct u.t from unnest(p_push_types) as u(t)) d
       order by d.t collate "C");
  end if;

  insert into public.notification_preferences
    (user_id, workspace_id, push_enabled, push_types, quiet_start, quiet_end, updated_at)
  values (v_user, v_workspace, coalesce(p_push_enabled, true), v_types,
          p_quiet_start, p_quiet_end, now())
  on conflict (user_id) do update
    set workspace_id = excluded.workspace_id,
        push_enabled = excluded.push_enabled,
        push_types = excluded.push_types,
        quiet_start = excluded.quiet_start,
        quiet_end = excluded.quiet_end,
        updated_at = now();

  return jsonb_build_object('outcome', 'saved', 'push_types', to_jsonb(v_types));
end;
$fn$;

revoke all on function public.realtoros_set_notification_preferences(boolean, text[], time, time)
  from public, anon;
grant execute on function public.realtoros_set_notification_preferences(boolean, text[], time, time)
  to authenticated;

comment on function public.realtoros_set_notification_preferences(boolean, text[], time, time) is
  'Phase 3B. Saves the caller''s own push preferences. Types are checked against automation_internal.push_notification_types() and stored sorted under COLLATE "C"; quiet hours are both or neither.';

-- What the settings screen reads: the stored row, or the defaults spelled
-- out, so the UI never has to carry a second copy of what "unset" means.
create or replace function public.realtoros_notification_preferences()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select jsonb_build_object(
    'push_enabled', coalesce(p.push_enabled, true),
    'push_types', to_jsonb(coalesce(p.push_types, automation_internal.push_notification_types())),
    'quiet_start', p.quiet_start,
    'quiet_end', p.quiet_end,
    'all_types', to_jsonb(automation_internal.push_notification_types()),
    'stored', (p.user_id is not null))
    from (select (select auth.uid()) as uid) me
    left join public.notification_preferences p on p.user_id = me.uid
   where me.uid is not null;
$fn$;

revoke all on function public.realtoros_notification_preferences() from public, anon;
grant execute on function public.realtoros_notification_preferences() to authenticated;

comment on function public.realtoros_notification_preferences() is
  'Phase 3B. The caller''s effective push preferences - the stored row or the defaults - plus the full list of types, so the settings screen has one source for both.';

-- ============================================================
-- 6. CLAIMING A BATCH
--
-- Same shape as every other claim in this system: SKIP LOCKED so two
-- workers never take the same row, a short lease so a worker that dies
-- does not strand it, and an explicit completion.
--
-- The decisions are made HERE rather than in the worker, because they all
-- need the database anyway (preferences, devices, the workspace's time
-- zone) and because a decision made in SQL is one a test can pin without
-- a running function.
-- ============================================================
create or replace function public.realtoros_claim_push_batch(
  p_limit integer default 20,
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $fn$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 20), 100));
  v_now timestamptz := coalesce(p_now, now());
  v_row record;
  v_prefs record;
  v_tz text;
  v_local timestamp;
  v_time time;
  v_quiet boolean;
  v_resume timestamptz;
  v_subs jsonb;
  v_out jsonb := '[]'::jsonb;
  v_skipped integer := 0;
  v_deferred integer := 0;
begin
  for v_row in
    select n.id, n.user_id, n.workspace_id, n.type, n.title, n.body, n.link_route
      from public.notifications n
     where n.push_status = 'pending'
       and (n.push_locked_until is null or n.push_locked_until < v_now)
     order by n.created_at
     limit v_limit
     for update skip locked
  loop
    -- Preferences, or the defaults if this person has never opened the
    -- settings screen.
    select coalesce(p.push_enabled, true) as push_enabled,
           coalesce(p.push_types, automation_internal.push_notification_types()) as push_types,
           p.quiet_start, p.quiet_end
      into v_prefs
      from (select 1) one
      left join public.notification_preferences p on p.user_id = v_row.user_id;

    -- Switched off, or this kind switched off.
    if not v_prefs.push_enabled or not (v_row.type = any (v_prefs.push_types)) then
      update public.notifications
         set push_status = 'skipped', push_locked_until = null
       where id = v_row.id;
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- Quiet hours, in the workspace's own time zone. A window that wraps
    -- midnight (22:00 to 07:00, the normal case) is the OR; one that does
    -- not (09:00 to 17:00) is the AND.
    if v_prefs.quiet_start is not null then
      v_tz := automation_internal.workspace_timezone(v_row.workspace_id);
      v_local := v_now at time zone v_tz;
      v_time := v_local::time;
      v_quiet := case
        when v_prefs.quiet_start < v_prefs.quiet_end
          then v_time >= v_prefs.quiet_start and v_time < v_prefs.quiet_end
        when v_prefs.quiet_start > v_prefs.quiet_end
          then v_time >= v_prefs.quiet_start or v_time < v_prefs.quiet_end
        -- start = end is a zero-length window, not a whole day of silence.
        else false
      end;
      if v_quiet then
        -- Held, not dropped: it goes out when the window ends, which is
        -- the next time quiet_end comes round locally.
        v_resume := (case
          when v_time < v_prefs.quiet_end
            then date_trunc('day', v_local)::date + v_prefs.quiet_end
          else date_trunc('day', v_local)::date + 1 + v_prefs.quiet_end
        end) at time zone v_tz;
        update public.notifications
           set push_locked_until = v_resume
         where id = v_row.id;
        v_deferred := v_deferred + 1;
        continue;
      end if;
    end if;

    -- The devices. Ordered oldest first, and by endpoint under COLLATE
    -- "C" to break ties the same way on every server.
    select coalesce(jsonb_agg(jsonb_build_object(
             'endpoint', s.endpoint, 'p256dh', s.p256dh, 'auth', s.auth)
             order by s.created_at, s.endpoint collate "C"), '[]'::jsonb)
      into v_subs
      from public.push_subscriptions s
     where s.user_id = v_row.user_id;

    if jsonb_array_length(v_subs) = 0 then
      update public.notifications
         set push_status = 'skipped', push_locked_until = null
       where id = v_row.id;
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- Leased for two minutes: long enough for a slow push service, short
    -- enough that a worker killed mid-batch costs one cycle.
    update public.notifications
       set push_locked_until = v_now + interval '2 minutes'
     where id = v_row.id;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'id', v_row.id,
      'type', v_row.type,
      'title', v_row.title,
      'body', v_row.body,
      -- The app route, which is all the payload is allowed to carry
      -- besides the two lines of text.
      'url', v_row.link_route,
      'subscriptions', v_subs));
  end loop;

  return jsonb_build_object('claimed', v_out, 'skipped', v_skipped, 'deferred', v_deferred);
end;
$fn$;

revoke all on function public.realtoros_claim_push_batch(integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.realtoros_claim_push_batch(integer, timestamptz) to service_role;

comment on function public.realtoros_claim_push_batch(integer, timestamptz) is
  'Phase 3B. Leases up to p_limit pending notifications for pushing and returns each with its recipient''s devices. Marks skipped when push is off, the type is off, or there are no devices; defers rather than skips inside quiet hours, using the workspace time zone. p_now exists so the quiet-hours behaviour is testable.';

-- ============================================================
-- 7. COMPLETING ONE
--
-- The worker reports what the push services said. Two things matter: a
-- 404 or a 410 means that device is gone for good and the row has to go,
-- and three failures is enough.
-- ============================================================
create or replace function public.realtoros_complete_push(
  p_notification_id uuid,
  p_outcome text,
  p_dead_endpoints text[] default null
)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $fn$
declare
  v_user uuid;
  v_attempts integer;
  v_removed integer := 0;
  v_status text;
begin
  if p_outcome is null or p_outcome not in ('sent', 'failed', 'skipped') then
    return jsonb_build_object('outcome', 'invalid_outcome');
  end if;

  select n.user_id, n.push_attempts into v_user, v_attempts
    from public.notifications n where n.id = p_notification_id
     for update;
  if v_user is null then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  -- Gone means gone: a 404/410 endpoint will never work again, and
  -- keeping it would mean failing against it on every future
  -- notification for ever.
  if p_dead_endpoints is not null and array_length(p_dead_endpoints, 1) > 0 then
    delete from public.push_subscriptions
     where user_id = v_user and endpoint = any (p_dead_endpoints);
    get diagnostics v_removed = row_count;
  end if;

  if p_outcome = 'sent' then
    update public.push_subscriptions
       set last_success_at = now(), failure_count = 0
     where user_id = v_user
       and (p_dead_endpoints is null or not (endpoint = any (p_dead_endpoints)));
    update public.notifications
       set push_status = 'sent', pushed_at = now(), push_locked_until = null,
           push_attempts = push_attempts + 1
     where id = p_notification_id;
    v_status := 'sent';
  elsif p_outcome = 'skipped' then
    update public.notifications
       set push_status = 'skipped', push_locked_until = null
     where id = p_notification_id;
    v_status := 'skipped';
  else
    -- A refusal that is not "this device is gone" counts against the
    -- device, so a browser that has quietly stopped accepting pushes
    -- becomes visible in the device list rather than silently eating
    -- every notification.
    update public.push_subscriptions
       set failure_count = failure_count + 1
     where user_id = v_user
       and (p_dead_endpoints is null or not (endpoint = any (p_dead_endpoints)));
    v_attempts := coalesce(v_attempts, 0) + 1;
    if v_attempts >= 3 then
      update public.notifications
         set push_status = 'failed', push_attempts = v_attempts, push_locked_until = null
       where id = p_notification_id;
      v_status := 'failed';
    else
      -- Back in the queue, after a wait that grows with the attempt.
      update public.notifications
         set push_status = 'pending', push_attempts = v_attempts,
             push_locked_until = now() + (v_attempts * interval '5 minutes')
       where id = p_notification_id;
      v_status := 'pending';
    end if;
  end if;

  return jsonb_build_object('outcome', v_status, 'attempts', coalesce(v_attempts, 0),
                            'removed_devices', v_removed);
end;
$fn$;

revoke all on function public.realtoros_complete_push(uuid, text, text[])
  from public, anon, authenticated;
grant execute on function public.realtoros_complete_push(uuid, text, text[]) to service_role;

comment on function public.realtoros_complete_push(uuid, text, text[]) is
  'Phase 3B. Records the result of pushing one notification. Dead endpoints (404/410) are deleted; other failures increment failure_count and retry with a growing delay, up to three attempts.';

-- ============================================================
-- 8. Verify. NO VARIABLES, deliberately.
-- ============================================================
do $verify$
begin
  -- ---- the tables exist and the browser cannot write them ----
  if not exists (select 1 from information_schema.tables
                  where table_schema = 'public' and table_name = 'push_subscriptions') then
    raise exception '3B: push_subscriptions is missing';
  end if;
  if not exists (select 1 from information_schema.tables
                  where table_schema = 'public' and table_name = 'notification_preferences') then
    raise exception '3B: notification_preferences is missing';
  end if;
  if exists (
    select 1 from information_schema.role_table_grants
     where table_schema = 'public'
       and table_name in ('push_subscriptions', 'notification_preferences')
       and grantee = 'authenticated'
       and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
  ) then
    raise exception '3B: the browser can write a push table directly';
  end if;
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'push_subscriptions' and c.relrowsecurity
  ) then
    raise exception '3B: push_subscriptions has no row level security';
  end if;
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'notification_preferences' and c.relrowsecurity
  ) then
    raise exception '3B: notification_preferences has no row level security';
  end if;

  -- ---- one endpoint, one row ----
  if not exists (
    select 1 from pg_constraint c
      join pg_class t on t.oid = c.conrelid
     where t.relname = 'push_subscriptions' and c.contype = 'u'
       and pg_get_constraintdef(c.oid) like '%endpoint%'
  ) then
    raise exception '3B: endpoint is not unique, so re-registering would duplicate';
  end if;

  -- ---- the queue columns, and the backfill ----
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'notifications'
       and column_name = 'push_status' and column_default like '%pending%'
  ) then
    raise exception '3B: new notifications do not default to pending';
  end if;
  if exists (select 1 from public.notifications where push_status is null) then
    raise exception '3B: a notification has no push status';
  end if;

  -- ---- the claim and complete are server-side only ----
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('realtoros_claim_push_batch', 'realtoros_complete_push')
       and has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ) then
    raise exception '3B: the push queue is reachable from the browser';
  end if;
  -- ---- and the two registration functions are not ----
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'realtoros_register_push_subscription'
       and has_function_privilege('authenticated', p.oid, 'EXECUTE')
       and p.prosecdef
  ) then
    raise exception '3B: the browser cannot register a device';
  end if;

  -- ---- the type list is one list ----
  if not (automation_internal.push_notification_types() @> array['lead_replied', 'overdue_followups']::text[]) then
    raise exception '3B: the push type list does not match the notification types';
  end if;
  -- Every type the notifications table allows must be pushable, or a
  -- notification could exist that no preference can ever describe.
  if exists (
    select 1 from unnest(automation_internal.push_notification_types()) as t
     where t not in ('lead_replied', 'hot_reply', 'unsubscribed', 'spam_report',
                     'email_bounced', 'import_finished', 'followup_failed',
                     'contact_untouched', 'overdue_followups')
  ) then
    raise exception '3B: the push type list has a type the notifications table would reject';
  end if;

  -- ---- claiming an empty queue is a no-op, not an error ----
  if (public.realtoros_claim_push_batch(1) ->> 'skipped') is null then
    raise exception '3B: the claim does not report what it skipped';
  end if;

  raise notice '3B: devices, preferences and the push queue are in place. Nothing is sent until the VAPID keys are set.';
end $verify$;
