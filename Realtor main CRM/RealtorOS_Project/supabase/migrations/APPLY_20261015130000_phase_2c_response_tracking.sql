-- RealtorOS — SQL Editor wrapper: Phase 2C response tracking and reminders.
-- Source: supabase/migrations/20261015130000_phase_2c_response_tracking.sql
-- Records itself in supabase_migrations.schema_migrations on success.
--
-- Apply AFTER 20261015120000_phase_2a_time_based_triggers (already live).
-- The migration ends in its own do $verify$ block, so a failed check aborts
-- the transaction and the schema_migrations row with it.
--
-- Applying this notifies nobody and sends nothing: pg_cron is not installed
-- and process-automation is not deployed, so the reminder scan only runs when
-- the worker calls it. It DOES backfill contacts.first_touched_at from
-- existing activities and last_contact dates, which is a one-time write.
-- Do not run until Claude Desktop has dry-run it.

BEGIN;

-- Phase 2C: response tracking, follow-up reminders, team accountability.
--
-- Three things, all of which exist to answer one question an agency owner
-- actually asks: did anybody get back to this lead, and how fast?
--
--   1. The two OLDEST trigger types catch up with the team model. Until now
--      contact_created and contact_status_changed matched rules by the
--      CREATOR's user_id, which predates workspaces entirely. They now
--      match the way Phase 2A's detector does, through ONE shared
--      visibility helper rather than a second copy of the rule.
--
--   2. contacts.first_touched_at — when somebody first actually did
--      something about this lead. Set once and never overwritten, because
--      "time to first touch" is only meaningful if the first touch keeps
--      its original time.
--
--   3. Reminders. A lead nobody has touched after a few hours is the most
--      expensive thing in a CRM, so the worker now nudges the person whose
--      lead it is, and escalates to whoever manages the team if it is still
--      sitting there a day later.
--
-- Nothing here schedules itself. pg_cron and pg_net are still not
-- installed, this migration references neither, and process-automation is
-- still not deployed. The reminder scan runs when the worker calls it, so
-- 2C is inert until go-live, which is intended. Applying it sends nothing
-- and notifies nobody.
--
-- Idempotent. Every new column is nullable, every new function is CREATE OR
-- REPLACE, and the solo case is unchanged by construction: a workspace with
-- one member has exactly one candidate for every rule either way.

-- ============================================================
-- 1. THE SHARED VISIBILITY RULE
--
-- "May this rule act on this contact?" was written inline inside the 2A
-- detector. Phase 2C needs the same answer for the two contact events, and
-- two copies of a permission rule is how permission bugs happen. So it moves
-- here, and the detector is rewritten below to call it.
--
--   shared    any contact in the rule's own workspace
--   personal  only the contacts its creator owns — assigned to them, or
--             unassigned and created by them
--
-- "Personal" would mean very little if a private rule quietly emailed the
-- whole team's pipeline.
--
-- LANGUAGE SQL, deliberately: a simple SQL function is inlinable, so the
-- planner folds this into the calling query instead of calling it per row.
-- SECURITY DEFINER because its callers are service_role functions reasoning
-- about rows across a workspace, not about the caller's own.
-- ============================================================
create or replace function automation_internal.rule_targets_contact(
  p_rule_id uuid,
  p_contact_id text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (
    select 1
      from public.automation_rules r
      join public.contacts c
        on c.workspace_id = r.workspace_id
       and c.id = p_contact_id
     where r.id = p_rule_id
       and (
         r.visibility = 'shared'
         or c.assigned_to_id = (
              select tm.id from public.team_members tm
               where tm.workspace_id = r.workspace_id
                 and tm.auth_user_id = r.user_id
               limit 1)
         or (c.assigned_to_id is null and c.user_id = r.user_id)
       )
  );
$fn$;

revoke all on function automation_internal.rule_targets_contact(uuid, text)
  from public, anon, authenticated;
grant execute on function automation_internal.rule_targets_contact(uuid, text)
  to service_role;

comment on function automation_internal.rule_targets_contact(uuid, text) is
  'Phase 2C. The single definition of whether a rule may act on a contact: a shared rule sees its whole workspace, a personal rule only its creator''s own contacts. Used by realtoros_scan_time_triggers and realtoros_rules_for_event so the rule exists once.';

-- ============================================================
-- 2. WHICH RULES AN EVENT STARTS
--
-- This was spread across the worker in TypeScript, where the two contact
-- events were still matched by creator. Moving it into one function fixes
-- that and makes the matching rule readable in one place, next to the
-- visibility helper it depends on.
--
-- Returns a jsonb ARRAY of rule ids, which is what a PostgREST caller can
-- consume directly. An empty array means nothing starts, which is a normal
-- answer and not an error.
-- ============================================================
create or replace function public.realtoros_rules_for_event(p_event_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_event public.automation_trigger_events%rowtype;
  v_ids jsonb;
  c_statuses constant text[] := array[
    'New Lead', 'Qualified', 'Nurturing', 'Client', 'Past Client', 'Lost'];
begin
  select * into v_event from public.automation_trigger_events where id = p_event_id;
  if not found then
    return '[]'::jsonb;
  end if;

  -- A DETECTED occurrence already names its rule: the condition is that
  -- rule's own setting, so no other rule can own this occurrence. It still
  -- has to be active and still have the trigger type it was detected for,
  -- because the rule may have been paused or edited in between.
  if v_event.event_type in ('follow_up_due', 'no_contact', 'status_stale') then
    if v_event.rule_id is null then
      return '[]'::jsonb;
    end if;
    select coalesce(jsonb_agg(r.id), '[]'::jsonb) into v_ids
      from public.automation_rules r
     where r.id = v_event.rule_id
       and r.workspace_id = v_event.workspace_id
       and r.status = 'active'
       and r.trigger_type = v_event.event_type
       and automation_internal.rule_targets_contact(r.id, v_event.contact_id);
    return v_ids;
  end if;

  -- Everything else is a real-world event, matched against every
  -- interested rule IN THE WORKSPACE. Scoping by workspace rather than by
  -- creator is the Phase 2C change: the contact may be a teammate's while
  -- the rule belongs to somebody else.
  select coalesce(jsonb_agg(r.id order by r.id), '[]'::jsonb) into v_ids
    from public.automation_rules r
   where r.workspace_id = v_event.workspace_id
     and r.status = 'active'
     and automation_internal.rule_targets_contact(r.id, v_event.contact_id)
     and case v_event.event_type
           when 'contact_created' then
             r.trigger_type = 'contact_created'
             or (r.trigger_type = 'new_lead' and v_event.new_status = 'New Lead')
           when 'contact_status_changed' then
             r.trigger_type = 'contact_status_changed'
             and v_event.old_status is distinct from v_event.new_status
             and v_event.new_status = any (c_statuses)
             -- audience_filter is required for this type and names the one
             -- status the sequence reacts to.
             and (r.audience_filter ->> 'status_equals') = v_event.new_status
           when 'deal_stage_changed' then
             r.trigger_type = 'deal_stage_changed'
             -- Both filters are optional; absent means "any".
             and (not (r.trigger_config ? 'to_stage')
                  or (r.trigger_config ->> 'to_stage') = (v_event.payload ->> 'new_stage'))
             and (not (r.trigger_config ? 'side')
                  or (r.trigger_config ->> 'side') = (v_event.payload ->> 'side'))
           else false
         end;
  return v_ids;
end;
$fn$;

revoke all on function public.realtoros_rules_for_event(uuid)
  from public, anon, authenticated;
grant execute on function public.realtoros_rules_for_event(uuid) to service_role;

comment on function public.realtoros_rules_for_event(uuid) is
  'Phase 2C. The rule ids one trigger event starts, as a jsonb array. Scoped by WORKSPACE (was by creator for the two contact events) and gated by automation_internal.rule_targets_contact. A detected occurrence matches only the rule it names. Read-only; service_role only.';

-- ============================================================
-- 3. THE DETECTOR USES THE SHARED HELPER
--
-- Byte for byte the Phase 2A function, with the inline visibility clause
-- and the v_owner_tm lookup it needed replaced by the one call. Nothing
-- else about it changes: same keys, same mass-send guard, same throttle.
-- ============================================================
create or replace function public.realtoros_scan_time_triggers(
  p_now timestamptz default now(),
  p_limit integer default 500
)
returns jsonb
language plpgsql
security definer
set search_path = ''
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
  c_throttle constant interval := interval '5 minutes';
begin
  if v_limit < 1 or v_limit > 5000 then
    raise exception 'invalid_limit' using errcode = '22023';
  end if;
  v_budget := v_limit;

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

      with candidate as (
        select c.id as contact_id,
               case v_rule.trigger_type
                 when 'follow_up_due' then c.next_follow_up
                 when 'no_contact'    then coalesce(c.last_contact, c.created_at::date) + v_days
                 else (c.status_changed_at at time zone v_rule.timezone)::date + v_days
               end as due_date,
               case v_rule.trigger_type
                 when 'follow_up_due' then c.next_follow_up::text
                 when 'no_contact'    then coalesce(c.last_contact, c.created_at::date)::text
                 else c.status || ':' || c.status_changed_at::text
               end as occurrence
          from public.contacts c
         where c.workspace_id = v_rule.workspace_id
           -- Phase 2C: the one shared definition, no longer a copy.
           and automation_internal.rule_targets_contact(v_rule.id, c.id)
           and (not (v_rule.audience_filter ? 'status_equals')
                or c.status = (v_rule.audience_filter ->> 'status_equals'))
           and case v_rule.trigger_type
                 when 'follow_up_due' then c.next_follow_up is not null
                 when 'no_contact'    then true
                 else c.status_changed_at is not null
                      and (v_statuses is null or c.status = any (v_statuses))
               end
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
               ((cd.due_date::timestamp + make_interval(hours => v_hour))
                  at time zone v_rule.timezone) as due_at
          from candidate cd
         where cd.due_date is not null
      ), ready as (
        select d.contact_id, d.occurrence, d.due_at
          from due d
         where d.due_at <= v_now
           and (v_include or v_rule.activated_at is null or d.due_at >= v_rule.activated_at)
         order by d.due_at, d.contact_id
         limit v_budget
      )
      insert into public.automation_trigger_events (
        user_id, workspace_id, contact_id, event_type, rule_id, event_key,
        available_at, payload
      )
      select
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

-- ============================================================
-- 4. contacts.first_touched_at — when somebody first did something.
--
-- SET ONCE. "Time to first touch" is only meaningful if the first touch
-- keeps its original time, so every path below writes it only where it is
-- still null.
--
-- First touch is whichever happens first:
--   * an activity is logged against the contact, or
--   * last_contact goes from empty to a date.
--
-- The Phase 2B quick log does both in one go, which is exactly the case
-- "whichever comes first" exists for.
-- ============================================================
alter table public.contacts
  add column if not exists first_touched_at timestamptz;

comment on column public.contacts.first_touched_at is
  'Phase 2C. When this lead was first actually worked: the first activity logged against it, or the first time last_contact was set. Written once by trigger and never overwritten; not writable from the browser. Null means nobody has touched it yet.';

-- The activity path. SECURITY DEFINER for a reason that matters: the UPDATE
-- below fires contacts' own BEFORE UPDATE triggers, and
-- protect_contact_lifecycle_columns refuses a browser write to
-- first_touched_at by checking current_user. Inside a SECURITY DEFINER
-- function current_user is this function's owner, not 'authenticated', so
-- the protection correctly stands aside for a write the SERVER is making
-- on the browser's behalf. As SECURITY INVOKER the stamp would be silently
-- discarded for every activity logged from the app.
create or replace function automation_internal.set_first_touch_from_activity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if NEW.contact_id is null then
    return NEW;
  end if;
  update public.contacts
     set first_touched_at = coalesce(NEW.created_at, now())
   where id = NEW.contact_id
     and workspace_id = NEW.workspace_id
     and first_touched_at is null;
  return NEW;
end;
$fn$;

revoke all on function automation_internal.set_first_touch_from_activity()
  from public, anon, authenticated;

drop trigger if exists activities_first_touch_trigger on public.activities;
create trigger activities_first_touch_trigger
  after insert on public.activities
  for each row execute function automation_internal.set_first_touch_from_activity();

-- The last_contact path. BEFORE UPDATE, and it must run AFTER
-- contacts_protect_lifecycle_columns_trigger: both are BEFORE triggers on
-- the same table so they fire in name order, and 'contacts_protect…' sorts
-- before 'contacts_set…'. The protect trigger first throws away whatever
-- the browser supplied for first_touched_at; this then sets the honest
-- value. So a browser can cause a true stamp by recording a contact, and
-- can never write a false one.
create or replace function automation_internal.set_first_touch_from_contact()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $fn$
begin
  if NEW.first_touched_at is not null or NEW.last_contact is null then
    return NEW;
  end if;
  -- INSERT is covered as well as UPDATE, because a contact can arrive with
  -- last_contact already set: that is exactly what a file or Sheet import
  -- does when the spreadsheet carries a last-contact column. Such a lead has
  -- demonstrably been worked, so it starts life touched rather than showing
  -- up in the "nobody has contacted this" reminder.
  if TG_OP = 'INSERT' or OLD.last_contact is null then
    NEW.first_touched_at := now();
  end if;
  return NEW;
end;
$fn$;

revoke all on function automation_internal.set_first_touch_from_contact()
  from public, anon, authenticated;

-- `of last_contact` narrows the UPDATE case only; the INSERT case always
-- fires, which is what covers a contact that arrives already contacted.
drop trigger if exists contacts_set_first_touch_trigger on public.contacts;
create trigger contacts_set_first_touch_trigger
  before insert or update of last_contact on public.contacts
  for each row execute function automation_internal.set_first_touch_from_contact();

-- first_touched_at joins the columns the browser may not forge.
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
      -- Phase 2C: a brand new contact has not been touched yet.
      NEW.first_touched_at := null;
    else
      NEW.reply_detected_at := OLD.reply_detected_at;
      NEW.unsubscribe_detected_at := OLD.unsubscribe_detected_at;
      NEW.status_changed_at := OLD.status_changed_at;
      NEW.first_touched_at := OLD.first_touched_at;
    end if;
  end if;
  return NEW;
end;
$function$;

revoke all on function automation_internal.protect_contact_lifecycle_columns()
  from public, anon, authenticated;

-- Backfill: the earliest evidence that anybody worked this lead. Contacts
-- with neither an activity nor a last-contact date stay null, which is the
-- honest answer — not "touched at the moment of this migration".
with touched as (
  select c.id, c.workspace_id,
         least(
           (select min(a.created_at) from public.activities a
             where a.contact_id = c.id and a.workspace_id = c.workspace_id),
           c.last_contact::timestamptz
         ) as first_touch
    from public.contacts c
   where c.first_touched_at is null
)
update public.contacts c
   set first_touched_at = t.first_touch
  from touched t
 where c.id = t.id
   and c.workspace_id = t.workspace_id
   and t.first_touch is not null;

-- The accountability views and the reminder scan both read by workspace
-- and by how long a contact has sat untouched.
create index if not exists contacts_ws_untouched_idx
  on public.contacts (workspace_id, created_at)
  where first_touched_at is null;
create index if not exists contacts_ws_first_touch_idx
  on public.contacts (workspace_id, created_at, first_touched_at);

-- ============================================================
-- 5. TWO MORE KINDS OF NOTIFICATION
-- ============================================================
alter table public.notifications
  drop constraint if exists notifications_type_check;
alter table public.notifications
  add constraint notifications_type_check
  check (type in ('lead_replied', 'hot_reply', 'unsubscribed', 'spam_report',
                  'email_bounced', 'import_finished', 'followup_failed',
                  -- Phase 2C
                  'contact_untouched', 'overdue_followups'));

-- ============================================================
-- 6. realtoros_scan_follow_up_reminders — the nudge.
--
-- Called by process-automation straight after the time-trigger scan. Writes
-- notifications only; it sends no email and enrols nobody.
--
-- WHO HEARS ABOUT AN UNTOUCHED LEAD
--
--   level 1  the person whose lead it is — the assigned agent, or the
--            person who created it if nobody is assigned. After
--            followUpReminderHours (workspace setting, default 4).
--   level 2  whoever can manage the team, but only after a full day AND
--            only in a workspace that actually has other members. A solo
--            agent does not need to be told twice.
--
-- Each level has its own dedupe key per contact per recipient, so a contact
-- produces at most one level-1 and one level-2 notification per person
-- however often the worker runs.
--
-- THE DAILY SUMMARY
--
-- One per person per day, counting only the overdue contacts THAT PERSON
-- can act on: their contacts permission decides whether that is the whole
-- workspace or only their own leads. Nobody is told about work they cannot
-- see. Skipped entirely when the count is zero.
-- ============================================================
create or replace function public.realtoros_scan_follow_up_reminders(
  p_now timestamptz default now()
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_ws record;
  v_row record;
  v_hours integer;
  v_members integer;
  v_level1 integer := 0;
  v_level2 integer := 0;
  v_summaries integer := 0;
  v_recipient uuid;
  v_scope text;
  v_overdue integer;
  v_today date;
  c_escalate constant interval := interval '24 hours';
begin
  for v_ws in select w.id, w.owner_user_id from public.workspaces w order by w.id
  loop
    -- The workspace's own patience, clamped to something sane. A missing or
    -- nonsense setting falls back to four hours rather than failing.
    select greatest(1, least(72,
             coalesce((s.settings_data ->> 'followUpReminderHours')::integer, 4)))
      into v_hours
      from public.workspace_settings s
     where s.workspace_id = v_ws.id
     limit 1;
    if v_hours is null then v_hours := 4; end if;

    select count(*) into v_members
      from public.workspace_members wm
     where wm.workspace_id = v_ws.id and wm.status = 'active';

    -- ---------- untouched leads ----------
    for v_row in
      select c.id, c.full_name, c.created_at, c.assigned_to_id, c.user_id
        from public.contacts c
       where c.workspace_id = v_ws.id
         and c.first_touched_at is null
         and c.status not in ('Lost', 'Past Client')
         and c.created_at <= v_now - make_interval(hours => v_hours)
       order by c.created_at
    loop
      -- Whose lead is it? The assigned agent, else whoever created it.
      v_recipient := null;
      if v_row.assigned_to_id is not null then
        select tm.auth_user_id into v_recipient
          from public.team_members tm
         where tm.workspace_id = v_ws.id and tm.id = v_row.assigned_to_id
         limit 1;
      end if;
      v_recipient := coalesce(v_recipient, v_row.user_id);

      if v_recipient is not null then
        if automation_internal.notify(
             v_recipient, 'contact_untouched',
             'Not contacted yet',
             coalesce(nullif(btrim(v_row.full_name), ''), 'A new contact')
               || ' has been waiting since ' || to_char(v_row.created_at, 'FMDay FMDD Mon')
               || ' with no contact logged.',
             v_row.id, '/contacts/' || v_row.id,
             'untouched:' || v_row.id || ':l1',
             jsonb_build_object('level', 1, 'hours', v_hours)
           ) is not null then
          v_level1 := v_level1 + 1;
        end if;
      end if;

      -- ---------- escalation ----------
      -- Only once it has really been left, and only where there is somebody
      -- else to tell.
      if v_members > 1 and v_row.created_at <= v_now - c_escalate then
        for v_recipient in
          select wm.user_id
            from public.workspace_members wm
           where wm.workspace_id = v_ws.id
             and wm.status = 'active'
             and automation_internal.member_can(v_ws.id, wm.user_id, 'team_manage')
           order by wm.user_id
        loop
          if automation_internal.notify(
               v_recipient, 'contact_untouched',
               'Still not contacted after a day',
               coalesce(nullif(btrim(v_row.full_name), ''), 'A new contact')
                 || ' was added on ' || to_char(v_row.created_at, 'FMDay FMDD Mon')
                 || ' and still has no contact logged.',
               v_row.id, '/contacts/' || v_row.id,
               'untouched:' || v_row.id || ':l2',
               jsonb_build_object('level', 2)
             ) is not null then
            v_level2 := v_level2 + 1;
          end if;
        end loop;
      end if;
    end loop;

    -- ---------- the daily overdue summary ----------
    for v_recipient in
      select wm.user_id
        from public.workspace_members wm
       where wm.workspace_id = v_ws.id and wm.status = 'active'
       order by wm.user_id
    loop
      v_scope := automation_internal.member_permissions(v_ws.id, v_recipient)
                   -> 'contacts' ->> 'view';
      if v_scope is null or v_scope = 'none' then
        continue;
      end if;

      -- "Today" is read in the workspace's own settings timezone where one
      -- exists, and otherwise in UTC: a summary that arrives on the wrong
      -- calendar day is worse than none.
      v_today := (v_now at time zone 'UTC')::date;

      select count(*) into v_overdue
        from public.contacts c
       where c.workspace_id = v_ws.id
         and c.next_follow_up is not null
         and c.next_follow_up < v_today
         and c.status not in ('Lost', 'Past Client')
         and (v_scope = 'all'
              or c.user_id = v_recipient
              or c.assigned_to_id = (
                   select tm.id from public.team_members tm
                    where tm.workspace_id = v_ws.id and tm.auth_user_id = v_recipient
                    limit 1));

      if coalesce(v_overdue, 0) > 0 then
        if automation_internal.notify(
             v_recipient, 'overdue_followups',
             'You have ' || v_overdue || ' overdue follow-'
               || case when v_overdue = 1 then 'up' else 'ups' end,
             'Open Today to work through them.',
             null, '/contacts',
             'overdue:' || v_today::text,
             jsonb_build_object('count', v_overdue)
           ) is not null then
          v_summaries := v_summaries + 1;
        end if;
      end if;
    end loop;
  end loop;

  -- Counts only. Never a name, an address or a contact id.
  return jsonb_build_object(
    'untouched_notified', v_level1,
    'escalated', v_level2,
    'summaries', v_summaries);
end;
$fn$;

revoke all on function public.realtoros_scan_follow_up_reminders(timestamptz)
  from public, anon, authenticated;
grant execute on function public.realtoros_scan_follow_up_reminders(timestamptz)
  to service_role;

comment on function public.realtoros_scan_follow_up_reminders(timestamptz) is
  'Phase 2C. In-app reminders: an untouched new lead nudges whoever owns it after the workspace''s followUpReminderHours, and escalates to team_manage holders after 24 hours in a workspace with more than one active member. Also one daily overdue summary per person, counting only contacts their own permissions let them act on. Writes notifications only; service_role only.';

-- ============================================================
-- 7. Verify.
-- ============================================================
do $verify$
declare
  v_bad text := '';
  v_n integer;
begin
  -- The shared helper exists and is the worker's alone.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'automation_internal' and p.proname = 'rule_targets_contact'
       and has_function_privilege('service_role', p.oid, 'EXECUTE')
       and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ) then
    v_bad := v_bad || E'\n  rule_targets_contact is missing or wrongly granted';
  end if;

  -- The detector really does use it now, rather than carrying a copy.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'realtoros_scan_time_triggers'
       and p.prosrc like '%rule_targets_contact%'
  ) then
    v_bad := v_bad || E'\n  the time-trigger scan does not use the shared helper';
  end if;

  -- first_touched_at exists, is protected, and the two triggers are on.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'contacts'
       and column_name = 'first_touched_at'
  ) then
    v_bad := v_bad || E'\n  contacts.first_touched_at is missing';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'automation_internal'
       and p.proname = 'protect_contact_lifecycle_columns'
       and p.prosrc like '%first_touched_at%'
  ) then
    v_bad := v_bad || E'\n  first_touched_at is not lifecycle-protected';
  end if;

  select count(*) into v_n from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and not t.tgisinternal
     and ((c.relname = 'activities' and t.tgname = 'activities_first_touch_trigger')
       or (c.relname = 'contacts' and t.tgname = 'contacts_set_first_touch_trigger'));
  if v_n <> 2 then
    v_bad := v_bad || format(E'\n  expected 2 first-touch triggers, found %s', v_n);
  end if;

  -- The protect trigger must still sort BEFORE the stamping triggers, or a
  -- browser write would be able to set first_touched_at after all.
  if not ('contacts_protect_lifecycle_columns_trigger' < 'contacts_set_first_touch_trigger') then
    v_bad := v_bad || E'\n  trigger name order no longer protects first_touched_at';
  end if;

  -- The backfill left nobody wrongly stamped: a contact with no activity
  -- and no last_contact must still be null.
  if exists (
    select 1 from public.contacts c
     where c.first_touched_at is not null
       and c.last_contact is null
       and not exists (select 1 from public.activities a
                        where a.contact_id = c.id and a.workspace_id = c.workspace_id)
  ) then
    v_bad := v_bad || E'\n  the backfill stamped a contact that was never touched';
  end if;

  -- The two new notification types are accepted, the seven old ones still are.
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.notifications'::regclass
       and conname = 'notifications_type_check'
       and pg_get_constraintdef(oid) like '%contact_untouched%'
       and pg_get_constraintdef(oid) like '%overdue_followups%'
       and pg_get_constraintdef(oid) like '%lead_replied%'
       and pg_get_constraintdef(oid) like '%followup_failed%'
  ) then
    v_bad := v_bad || E'\n  the notification type check is wrong';
  end if;

  -- Both new RPCs are reachable by the worker and nobody else.
  for v_n in
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('realtoros_rules_for_event', 'realtoros_scan_follow_up_reminders')
       and (not has_function_privilege('service_role', p.oid, 'EXECUTE')
            or has_function_privilege('authenticated', p.oid, 'EXECUTE')
            or has_function_privilege('anon', p.oid, 'EXECUTE'))
  loop
    v_bad := v_bad || E'\n  a Phase 2C RPC has the wrong grants';
  end loop;

  -- And they answer at all, on an empty database.
  if jsonb_typeof(public.realtoros_rules_for_event(gen_random_uuid())) <> 'array' then
    v_bad := v_bad || E'\n  realtoros_rules_for_event did not return an array';
  end if;

  if v_bad <> '' then
    raise exception 'Phase 2C verification failed:%', v_bad;
  end if;
  raise notice 'Phase 2C: shared visibility, first_touched_at and the reminder scan are in place.';
end $verify$;

INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('20261015130000', 'phase_2c_response_tracking');

COMMIT;
