-- REVERT for Phase 3B (web push notifications).
--
-- NOT a migration. Lives in supabase/rollback/ and is never applied as
-- part of the chain. Run it only to undo
-- 20261015170000_phase_3b_push.sql.
--
-- WHAT IT REMOVES
--
--   * both new tables, push_subscriptions and notification_preferences
--   * the four push columns on notifications, and their constraints and
--     index
--   * every function this phase added
--
-- WHAT RUNNING THIS MEANS
--
--   * Every device registration is deleted. Nobody's data is lost - a
--     subscription is a browser address, not a record - but every agent
--     who had turned notifications on has to turn them on again, and
--     until they do their phones go quiet. There is nothing to park in
--     metadata here, unlike the 2E and 2F reverts: an endpoint that is
--     not in this table is an endpoint nothing can send to, so keeping a
--     copy would preserve nothing.
--   * Preferences go with them, which means quiet hours are forgotten. If
--     3B is re-applied later everybody is back on the defaults, so this
--     is worth saying out loud before running it in the evening.
--   * In-app notifications are completely unaffected. Dropping the push
--     columns cannot lose a notification: they only ever recorded what
--     the push worker did about one.
--   * The worker must stop asking for push batches BEFORE this runs, or
--     every run logs a missing-function error. Deploy the previous
--     process-automation first, then run this.
--
-- Only run this if Phase 3B itself is causing a worse problem.

set search_path = public;

begin;

-- ============================================================
-- 1. The queue columns, and everything attached to them.
-- ============================================================
drop index if exists public.notifications_push_pending_idx;

alter table public.notifications
  drop constraint if exists notifications_push_status_check;
alter table public.notifications
  drop constraint if exists notifications_push_attempts_check;

alter table public.notifications
  drop column if exists push_status,
  drop column if exists push_attempts,
  drop column if exists pushed_at,
  drop column if exists push_locked_until;

-- ============================================================
-- 2. The functions.
--
-- Before the tables, so nothing is left referring to a table that has
-- gone; after the columns, for the same reason.
-- ============================================================
drop function if exists public.realtoros_claim_push_batch(integer, timestamptz);
drop function if exists public.realtoros_complete_push(uuid, text, text[]);
drop function if exists public.realtoros_register_push_subscription(text, text, text, text);
drop function if exists public.realtoros_remove_push_subscription(text);
drop function if exists public.realtoros_set_notification_preferences(boolean, text[], time, time);
drop function if exists public.realtoros_notification_preferences();

-- ============================================================
-- 3. The tables.
--
-- notification_preferences first: its default and its CHECK both call
-- push_notification_types(), which goes last.
-- ============================================================
drop table if exists public.notification_preferences;
drop table if exists public.push_subscriptions;

drop function if exists automation_internal.push_notification_types();

-- ============================================================
-- 4. Verify. No variables, for the reason given in the 2E migration.
-- ============================================================
do $verify$
begin
  if exists (
    select 1 from information_schema.tables
     where table_schema = 'public'
       and table_name in ('push_subscriptions', 'notification_preferences')
  ) then
    raise exception '3B revert: a push table still exists';
  end if;

  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'notifications'
       and column_name in ('push_status', 'push_attempts', 'pushed_at', 'push_locked_until')
  ) then
    raise exception '3B revert: a push column is still on notifications';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where (n.nspname = 'public' and p.proname in (
              'realtoros_claim_push_batch', 'realtoros_complete_push',
              'realtoros_register_push_subscription', 'realtoros_remove_push_subscription',
              'realtoros_set_notification_preferences', 'realtoros_notification_preferences'))
        or (n.nspname = 'automation_internal' and p.proname = 'push_notification_types')
  ) then
    raise exception '3B revert: a push function still exists';
  end if;

  -- The notifications themselves are not this revert's business.
  if not exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'notifications'
  ) then
    raise exception '3B revert: the notifications table was dropped, which it must never be';
  end if;

  raise notice '3B reverted: devices and preferences are gone, in-app notifications are untouched.';
end $verify$;

commit;
