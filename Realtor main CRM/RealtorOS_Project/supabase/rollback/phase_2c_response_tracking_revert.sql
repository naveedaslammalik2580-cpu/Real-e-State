-- REVERT for Phase 2C (response tracking, reminders, team accountability).
--
-- NOT a migration. Lives in supabase/rollback/ and is never applied as part
-- of the chain. Run it only to undo
-- 20261015130000_phase_2c_response_tracking.sql.
--
-- WHAT IT REMOVES
--
--   * public.realtoros_scan_follow_up_reminders and
--     public.realtoros_rules_for_event
--   * the two new notification types, back to the pre-2C CHECK (the rows
--     that used them are deleted first, or the CHECK could not be restored)
--   * contacts.first_touched_at, both its triggers, both their functions and
--     its two indexes
--   * automation_internal.rule_targets_contact, and with it the shared
--     visibility rule — so realtoros_scan_time_triggers goes back to the
--     Phase 2A definition that carried the clause inline
--   * first_touched_at leaves the lifecycle guard, which returns to the
--     Phase 2A definition verbatim
--
-- ORDER MATTERS. The scan is restored to its 2A form BEFORE the helper it
-- would otherwise still reference is dropped, and the notification CHECK is
-- narrowed only after the rows that violate it are gone.
--
-- WHAT RUNNING THIS MEANS
--
--   * Reminders stop. Nobody is nudged about an untouched lead and no daily
--     summary is produced.
--   * contact_created and contact_status_changed go back to matching rules
--     by CREATOR rather than by workspace. In a team that means a sequence
--     owned by one person stops starting for a teammate's lead — the defect
--     2C fixed.
--   * Every first_touched_at value is lost. It cannot be recovered from the
--     column, though re-applying 2C backfills it again from activities and
--     last_contact, so the loss is mostly recoverable.
--   * Notifications of the two new kinds are DELETED. They are nudges about
--     work, not records of it, and nothing else refers to them.
--
-- The accountability views in the browser read first_touched_at, so they
-- will show "not tracked" rather than numbers until 2C is applied again.
--
-- Only run this if Phase 2C itself is causing a worse problem.

set search_path = public;

begin;

-- ============================================================
-- 1. Stop the reminders and the shared matcher.
-- ============================================================
drop function if exists public.realtoros_scan_follow_up_reminders(timestamptz);
drop function if exists public.realtoros_rules_for_event(uuid);

-- ============================================================
-- 2. The notification types 2C added.
-- ============================================================
delete from public.notifications
 where type in ('contact_untouched', 'overdue_followups');

alter table public.notifications
  drop constraint if exists notifications_type_check;
alter table public.notifications
  add constraint notifications_type_check
  check (type in ('lead_replied', 'hot_reply', 'unsubscribed', 'spam_report',
                  'email_bounced', 'import_finished', 'followup_failed'));

-- ============================================================
-- 3. first_touched_at.
-- ============================================================
drop trigger if exists activities_first_touch_trigger on public.activities;
drop trigger if exists contacts_set_first_touch_trigger on public.contacts;
drop function if exists automation_internal.set_first_touch_from_activity();
drop function if exists automation_internal.set_first_touch_from_contact();
drop index if exists public.contacts_ws_untouched_idx;
drop index if exists public.contacts_ws_first_touch_idx;
alter table public.contacts
  drop column if exists first_touched_at;

-- ============================================================
-- 4. The lifecycle guard, back to the Phase 2A definition.
--
-- Copied verbatim from
-- supabase/migrations/20261015120000_phase_2a_time_based_triggers.sql so
-- that md5(pg_proc.prosrc) matches the pre-2C chain exactly. Do not
-- reformat: tests/sql/rollback_files.test.mjs compares body hashes.
-- ============================================================
create or replace function automation_internal.protect_contact_lifecycle_columns()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $function$
begin
  -- security invoker is required: inside a SECURITY DEFINER function
  -- current_user would be the function owner, not the caller's PostgREST
  -- role, and the check would never fire.
  if current_user in ('authenticated', 'anon') then
    if TG_OP = 'INSERT' then
      NEW.reply_detected_at := null;
      NEW.unsubscribe_detected_at := null;
      -- Phase 2A: left null so the stamping trigger below sets it.
      NEW.status_changed_at := null;
    else
      NEW.reply_detected_at := OLD.reply_detected_at;
      NEW.unsubscribe_detected_at := OLD.unsubscribe_detected_at;
      NEW.status_changed_at := OLD.status_changed_at;
    end if;
  end if;
  return NEW;
end;
$function$;

revoke all on function automation_internal.protect_contact_lifecycle_columns()
  from public, anon, authenticated;


-- ============================================================
-- 5. The detector, back to the Phase 2A definition.
--
-- Also verbatim from the 2A migration: the visibility clause returns to
-- being inline here, which is why this has to happen BEFORE the shared
-- helper is dropped below.
-- ============================================================
create or replace function public.realtoros_scan_time_triggers(
  p_now timestamptz default now(),
  p_limit integer default 500
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_rule record;
  v_now timestamptz := coalesce(p_now, now());
  v_limit integer := coalesce(p_limit, 500);
  v_budget integer;
  v_inserted integer;
  v_total integer := 0;
  v_rules integer := 0;
  v_workspaces integer := 0;
  v_skipped integer := 0;
  v_days integer;
  v_hour integer;
  v_include boolean;
  v_statuses text[];
  v_ws uuid;
  v_owner_tm text;
  c_throttle constant interval := interval '5 minutes';
begin
  if v_limit < 1 or v_limit > 5000 then
    raise exception 'invalid_limit' using errcode = '22023';
  end if;
  v_budget := v_limit;

  -- Workspaces with at least one active time-based rule, that have not been
  -- scanned in the last five minutes. Locked with SKIP LOCKED so two
  -- workers never scan the same workspace at once; the unique event_key is
  -- still the final guard if they somehow do.
  for v_ws in
    select w.id
      from public.workspaces w
     where exists (
             select 1 from public.automation_rules r
              where r.workspace_id = w.id and r.status = 'active'
                and r.trigger_type in ('follow_up_due', 'no_contact', 'status_stale'))
     order by w.id
  loop
    if v_budget <= 0 then exit; end if;

    if not pg_try_advisory_xact_lock(
         hashtextextended('realtoros_scan_time_triggers:' || v_ws::text, 0)) then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    if exists (
      select 1 from public.automation_scan_state s
       where s.workspace_id = v_ws and s.last_scanned_at > v_now - c_throttle
    ) then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_workspaces := v_workspaces + 1;

    for v_rule in
      select r.id, r.user_id, r.workspace_id, r.trigger_type, r.timezone,
             r.visibility, r.activated_at, r.audience_filter, r.trigger_config
        from public.automation_rules r
       where r.workspace_id = v_ws and r.status = 'active'
         and r.trigger_type in ('follow_up_due', 'no_contact', 'status_stale')
       order by r.id
    loop
      if v_budget <= 0 then exit; end if;
      v_rules := v_rules + 1;

      v_hour := coalesce((v_rule.trigger_config ->> 'fire_hour')::integer, 8);
      v_include := coalesce((v_rule.trigger_config ->> 'include_existing')::boolean, false);
      v_days := (v_rule.trigger_config ->> 'days')::integer;
      v_statuses := case
        when v_rule.trigger_config ? 'statuses'
          then array(select jsonb_array_elements_text(v_rule.trigger_config -> 'statuses'))
        else null end;

      -- A personal rule only sees its creator's own contacts. The creator's
      -- directory id is what contacts.assigned_to_id points at.
      v_owner_tm := null;
      if v_rule.visibility = 'personal' then
        select tm.id into v_owner_tm
          from public.team_members tm
         where tm.workspace_id = v_rule.workspace_id
           and tm.auth_user_id = v_rule.user_id
         limit 1;
      end if;

      with candidate as (
        select c.id as contact_id,
               -- The local date the condition is satisfied on.
               case v_rule.trigger_type
                 when 'follow_up_due' then c.next_follow_up
                 when 'no_contact'    then coalesce(c.last_contact, c.created_at::date) + v_days
                 else (c.status_changed_at at time zone v_rule.timezone)::date + v_days
               end as due_date,
               -- The value that identifies this occurrence.
               case v_rule.trigger_type
                 when 'follow_up_due' then c.next_follow_up::text
                 when 'no_contact'    then coalesce(c.last_contact, c.created_at::date)::text
                 else c.status || ':' || c.status_changed_at::text
               end as occurrence
          from public.contacts c
         where c.workspace_id = v_rule.workspace_id
           -- Only contacts the rule is allowed to act on.
           and (v_rule.visibility = 'shared'
                or (v_owner_tm is not null and c.assigned_to_id = v_owner_tm)
                or (c.assigned_to_id is null and c.user_id = v_rule.user_id))
           -- audience_filter, applied exactly as the worker applies it.
           and (not (v_rule.audience_filter ? 'status_equals')
                or c.status = (v_rule.audience_filter ->> 'status_equals'))
           -- The condition's own precondition.
           and case v_rule.trigger_type
                 when 'follow_up_due' then c.next_follow_up is not null
                 when 'no_contact'    then true
                 else c.status_changed_at is not null
                      and (v_statuses is null or c.status = any (v_statuses))
               end
           -- Never start a sequence for somebody who has already said no,
           -- or who this rule is already running for. The worker checks all
           -- of this again through realtoros_check_enrollment_eligibility -
           -- this only avoids creating occurrences that are certain to be
           -- thrown away.
           and not exists (
             select 1 from public.email_suppressions s
              where s.workspace_id = c.workspace_id and s.is_active
                and s.normalized_email = lower(btrim(coalesce(c.email, '')))
                and coalesce(c.email, '') <> '')
           and not exists (
             select 1 from public.communication_consents cc
              where cc.workspace_id = c.workspace_id and cc.contact_id = c.id
                and cc.channel = 'email' and cc.status = 'opted_out')
           and not exists (
             select 1 from public.automation_enrollments ae
              where ae.workspace_id = c.workspace_id and ae.rule_id = v_rule.id
                and ae.contact_id = c.id and ae.status in ('active', 'paused'))
      ), due as (
        select cd.contact_id, cd.occurrence,
               -- fire_hour on the due date, read in the rule's timezone.
               ((cd.due_date::timestamp + make_interval(hours => v_hour))
                  at time zone v_rule.timezone) as due_at
          from candidate cd
         where cd.due_date is not null
      ), ready as (
        select d.contact_id, d.occurrence, d.due_at
          from due d
         where d.due_at <= v_now
           -- THE MASS-SEND GUARD. Without include_existing, an occurrence
           -- that became true before the rule was switched on is history,
           -- not a new thing to act on.
           and (v_include or v_rule.activated_at is null or d.due_at >= v_rule.activated_at)
         order by d.due_at, d.contact_id
         limit v_budget
      )
      insert into public.automation_trigger_events (
        user_id, workspace_id, contact_id, event_type, rule_id, event_key,
        available_at, payload
      )
      select
        -- The RULE's owner, not the contact's: this is what makes
        -- realtoros_enroll_contact and the eligibility check resolve the
        -- rule's own workspace. The contact is identified by contact_id.
        v_rule.user_id, v_rule.workspace_id, r.contact_id, v_rule.trigger_type,
        v_rule.id,
        case v_rule.trigger_type
          when 'follow_up_due' then 'fud:'
          when 'no_contact'    then 'nc:'
          else                      'ss:'
        end || v_rule.id::text || ':' || r.contact_id || ':' || r.occurrence,
        r.due_at,
        jsonb_build_object('rule_id', v_rule.id, 'due_at', r.due_at,
                           'trigger_type', v_rule.trigger_type)
      from ready r
      on conflict (workspace_id, event_key) where event_key is not null do nothing;

      v_inserted := 0;
      get diagnostics v_inserted = row_count;
      v_total := v_total + v_inserted;
      v_budget := v_budget - v_inserted;
    end loop;

    insert into public.automation_scan_state (workspace_id, last_scanned_at, last_event_count)
    values (v_ws, v_now, v_total)
    on conflict (workspace_id) do update
      set last_scanned_at = excluded.last_scanned_at,
          last_event_count = excluded.last_event_count;
  end loop;

  -- Counts only. Never a contact id, an address or a rule name.
  return jsonb_build_object(
    'scanned_workspaces', v_workspaces,
    'scanned_rules', v_rules,
    'events_created', v_total,
    'skipped_workspaces', v_skipped);
end;
$fn$;

revoke all on function public.realtoros_scan_time_triggers(timestamptz, integer)
  from public, anon, authenticated;
grant execute on function public.realtoros_scan_time_triggers(timestamptz, integer)
  to service_role;

comment on function public.realtoros_scan_time_triggers(timestamptz, integer) is
  'Phase 2A. Detects follow_up_due / no_contact / status_stale occurrences for ACTIVE rules and inserts them into automation_trigger_events, keyed so an occurrence can never be recorded twice. Enrols nobody - the existing worker path does that. Without trigger_config.include_existing, an occurrence that predates the rule''s activated_at is ignored, so switching a rule on never enrols a backlog. service_role only.';


-- ============================================================
-- 6. And finally the shared helper itself, now that nothing calls it.
-- ============================================================
drop function if exists automation_internal.rule_targets_contact(uuid, text);

-- ============================================================
-- 7. Verify.
-- ============================================================
do $verify$
declare
  v_bad text := '';
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'contacts'
                and column_name = 'first_touched_at') then
    v_bad := v_bad || E'\n  contacts.first_touched_at still exists';
  end if;

  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where (n.nspname = 'public'
                     and p.proname in ('realtoros_rules_for_event',
                                       'realtoros_scan_follow_up_reminders'))
                 or (n.nspname = 'automation_internal'
                     and p.proname in ('rule_targets_contact',
                                       'set_first_touch_from_activity',
                                       'set_first_touch_from_contact'))) then
    v_bad := v_bad || E'\n  a Phase 2C function still exists';
  end if;

  if exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
              where not t.tgisinternal
                and t.tgname in ('activities_first_touch_trigger',
                                 'contacts_set_first_touch_trigger')) then
    v_bad := v_bad || E'\n  a Phase 2C trigger still exists';
  end if;

  -- The detector must carry its own clause again, and must not reference a
  -- helper that no longer exists.
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'realtoros_scan_time_triggers'
                and p.prosrc like '%rule_targets_contact%') then
    v_bad := v_bad || E'\n  the detector still calls the dropped helper';
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'realtoros_scan_time_triggers'
                    and p.prosrc like '%v_owner_tm%') then
    v_bad := v_bad || E'\n  the detector was not restored to its 2A form';
  end if;

  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'automation_internal'
                and p.proname = 'protect_contact_lifecycle_columns'
                and p.prosrc like '%first_touched_at%') then
    v_bad := v_bad || E'\n  the lifecycle guard still mentions first_touched_at';
  end if;

  if exists (select 1 from public.notifications
              where type in ('contact_untouched', 'overdue_followups')) then
    v_bad := v_bad || E'\n  a Phase 2C notification survived';
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.notifications'::regclass
                    and conname = 'notifications_type_check'
                    and pg_get_constraintdef(oid) not like '%contact_untouched%') then
    v_bad := v_bad || E'\n  the notification type check was not narrowed back';
  end if;

  if v_bad <> '' then
    raise exception 'Phase 2C revert incomplete:%', v_bad;
  end if;
  raise notice 'Phase 2C reverted: reminders, first_touched_at and the shared matcher are gone.';
end $verify$;

commit;
