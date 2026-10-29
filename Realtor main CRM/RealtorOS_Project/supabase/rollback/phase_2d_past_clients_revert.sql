-- REVERT for Phase 2D (past-client programme and workspace time zone).
--
-- NOT a migration. Lives in supabase/rollback/ and is never applied as part
-- of the chain. Run it only to undo
-- 20261015140000_phase_2d_past_clients.sql.
--
-- WHAT IT REMOVES
--
--   * the birthday and home_anniversary trigger types, and any rule or
--     pending occurrence using them
--   * contacts.birthday and contacts.home_purchase_date, with their indexes
--   * automation_internal.yearly_date,
--     automation_internal.workspace_timezone,
--     public.realtoros_timezone_names, and the won-deal bookkeeping
--     (automation_internal.deal_won_marks_past_client plus both triggers)
--   * the validator, the matcher, the detector and the reminder scan all go
--     back to their previous definitions, verbatim, so the daily summary
--     reads "today" in UTC again
--
-- WHAT IT DELIBERATELY LEAVES ALONE
--
--   * settings_data.timezone. It is an ordinary setting in the bag, nothing
--     after this revert reads it, and a stray key is harmless - whereas
--     deleting it would throw away a value somebody chose.
--   * The "Past client" TAGS and home_purchase_date VALUES already written
--     by the won-deal trigger. The column goes, so the dates go with it, but
--     the tags are ordinary contact data the agent now filters on. Removing
--     them would be destroying the user's own records to undo our feature.
--
-- ORDER MATTERS. Rows that would violate the narrowed CHECKs are removed
-- first, and the detector is restored before the helper it stops needing is
-- dropped.
--
-- WHAT RUNNING THIS MEANS
--
--   * No birthday or anniversary greetings. Rules of those types are
--     ARCHIVED and rewritten to 'manual' (the one pre-2D type that starts
--     nothing by itself), with the original recorded in
--     metadata.phase_2d_reverted_from_trigger_type. Their enrollments, jobs
--     and sent mail are untouched.
--   * The daily overdue summary can again land on the wrong calendar day
--     for anybody not living in UTC - the defect 2D fixed.
--   * Closing a deal stops marking the contact as a past client.
--
-- Only run this if Phase 2D itself is causing a worse problem.

set search_path = public;

begin;

-- ============================================================
-- 1. Stop the won-deal bookkeeping and the browser-facing helpers.
-- ============================================================
drop trigger if exists deals_won_past_client_update on public.deals;
drop trigger if exists deals_won_past_client_insert on public.deals;
drop function if exists automation_internal.deal_won_marks_past_client();
drop function if exists public.realtoros_timezone_names();

-- ============================================================
-- 2. Retire the rules and occurrences the pre-2D CHECKs forbid.
-- ============================================================
update public.automation_rules
   set status = 'archived',
       archived_at = coalesce(archived_at, now())
 where trigger_type in ('birthday', 'home_anniversary')
   and status <> 'archived';

update public.automation_rules
   set metadata = metadata || jsonb_build_object(
         'phase_2d_reverted_from_trigger_type', trigger_type),
       trigger_type = 'manual',
       trigger_config = '{}'::jsonb
 where trigger_type in ('birthday', 'home_anniversary');

delete from public.automation_trigger_events
 where event_type in ('birthday', 'home_anniversary');

-- ============================================================
-- 3. Narrow both CHECKs, and the shape rule with them.
-- ============================================================
alter table public.automation_rules
  drop constraint if exists automation_rules_trigger_type_check;
alter table public.automation_rules
  add constraint automation_rules_trigger_type_check
  check (trigger_type in (
    'new_lead', 'contact_created', 'contact_status_changed', 'manual',
    'follow_up_due', 'no_contact', 'status_stale', 'deal_stage_changed'));

alter table public.automation_trigger_events
  drop constraint if exists automation_trigger_events_event_type_check;
alter table public.automation_trigger_events
  add constraint automation_trigger_events_event_type_check
  check (event_type in (
    'contact_created', 'contact_status_changed',
    'follow_up_due', 'no_contact', 'status_stale', 'deal_stage_changed'));

alter table public.automation_trigger_events
  drop constraint if exists automation_trigger_events_rule_shape_check;
alter table public.automation_trigger_events
  add constraint automation_trigger_events_rule_shape_check
  check (
    (event_type in ('follow_up_due', 'no_contact', 'status_stale')
       and rule_id is not null and event_key is not null)
    or (event_type in ('contact_created', 'contact_status_changed')
       and rule_id is null)
    or (event_type = 'deal_stage_changed' and rule_id is null)
  );

-- ============================================================
-- 4. The validator, back to the Phase 2A definition.
--
-- Everything from here down is copied verbatim from the migration that
-- last defined it, so that md5(pg_proc.prosrc) matches the pre-2D chain
-- exactly. Do not reformat: tests/sql/rollback_files.test.mjs compares body
-- hashes.
-- ============================================================
create or replace function automation_internal.validate_trigger_config(
  p_trigger_type text,
  p_config jsonb
)
returns jsonb
language plpgsql
immutable
set search_path to ''
as $fn$
declare
  v_config jsonb := coalesce(p_config, '{}'::jsonb);
  v_allowed text[];
  v_key text;
  v_days integer;
  v_hour integer;
  v_statuses jsonb;
  v_status text;
  v_out jsonb;
  v_include boolean;
  c_statuses constant text[] := array[
    'New Lead', 'Qualified', 'Nurturing', 'Client', 'Past Client', 'Lost'];
  c_sides constant text[] := array['Buyer', 'Seller'];
begin
  if jsonb_typeof(v_config) <> 'object' then
    raise exception 'trigger_config_not_object' using errcode = '22023';
  end if;

  -- include_existing is meaningful for every type: it is the opt-in to
  -- enrolling people who already match.
  if v_config ? 'include_existing' then
    if jsonb_typeof(v_config -> 'include_existing') <> 'boolean' then
      raise exception 'trigger_config_include_existing_not_boolean' using errcode = '22023';
    end if;
    v_include := (v_config -> 'include_existing')::boolean;
  else
    v_include := false;
  end if;

  v_allowed := case p_trigger_type
    when 'follow_up_due'      then array['fire_hour', 'include_existing']
    when 'no_contact'         then array['days', 'fire_hour', 'include_existing']
    when 'status_stale'       then array['days', 'statuses', 'fire_hour', 'include_existing']
    when 'deal_stage_changed' then array['to_stage', 'side', 'include_existing']
    else array['include_existing']   -- the pre-2A types carry no settings
  end;

  for v_key in select jsonb_object_keys(v_config) loop
    if not (v_key = any (v_allowed)) then
      raise exception 'trigger_config_unknown_key_%', v_key using errcode = '22023';
    end if;
  end loop;

  -- fire_hour: the local hour the daily check runs, for the three
  -- time-based types.
  if p_trigger_type in ('follow_up_due', 'no_contact', 'status_stale') then
    if v_config ? 'fire_hour' then
      if jsonb_typeof(v_config -> 'fire_hour') <> 'number' then
        raise exception 'trigger_config_fire_hour_not_number' using errcode = '22023';
      end if;
      v_hour := (v_config ->> 'fire_hour')::numeric::integer;
      if (v_config ->> 'fire_hour')::numeric <> v_hour or v_hour < 0 or v_hour > 23 then
        raise exception 'trigger_config_fire_hour_out_of_range' using errcode = '22023';
      end if;
    else
      v_hour := 8;
    end if;
  end if;

  if p_trigger_type = 'follow_up_due' then
    v_out := jsonb_build_object('fire_hour', v_hour, 'include_existing', v_include);

  elsif p_trigger_type in ('no_contact', 'status_stale') then
    if not (v_config ? 'days') then
      raise exception 'trigger_config_days_required' using errcode = '22023';
    end if;
    if jsonb_typeof(v_config -> 'days') <> 'number' then
      raise exception 'trigger_config_days_not_number' using errcode = '22023';
    end if;
    v_days := (v_config ->> 'days')::numeric::integer;
    if (v_config ->> 'days')::numeric <> v_days or v_days < 1 or v_days > 365 then
      raise exception 'trigger_config_days_out_of_range' using errcode = '22023';
    end if;
    v_out := jsonb_build_object('days', v_days, 'fire_hour', v_hour, 'include_existing', v_include);

    if p_trigger_type = 'status_stale' then
      -- statuses is optional: absent means any status counts.
      if v_config ? 'statuses' then
        v_statuses := v_config -> 'statuses';
        if jsonb_typeof(v_statuses) <> 'array' then
          raise exception 'trigger_config_statuses_not_array' using errcode = '22023';
        end if;
        if jsonb_array_length(v_statuses) = 0 then
          raise exception 'trigger_config_statuses_empty' using errcode = '22023';
        end if;
        if jsonb_array_length(v_statuses) > array_length(c_statuses, 1) then
          raise exception 'trigger_config_statuses_too_many' using errcode = '22023';
        end if;
        for v_status in select jsonb_array_elements_text(v_statuses) loop
          if not (v_status = any (c_statuses)) then
            raise exception 'trigger_config_status_not_allowed' using errcode = '22023';
          end if;
        end loop;
        -- Stored sorted and de-duplicated, so two configs meaning the same
        -- thing are the same value.
        select jsonb_agg(s order by s) into v_statuses
          from (select distinct jsonb_array_elements_text(v_config -> 'statuses') as s) d;
        v_out := v_out || jsonb_build_object('statuses', v_statuses);
      end if;
    end if;

  elsif p_trigger_type = 'deal_stage_changed' then
    v_out := jsonb_build_object('include_existing', v_include);
    if v_config ? 'to_stage' then
      if jsonb_typeof(v_config -> 'to_stage') <> 'string' then
        raise exception 'trigger_config_to_stage_not_string' using errcode = '22023';
      end if;
      v_status := btrim(v_config ->> 'to_stage');
      if v_status = '' or char_length(v_status) > 100 then
        raise exception 'trigger_config_to_stage_invalid' using errcode = '22023';
      end if;
      v_out := v_out || jsonb_build_object('to_stage', v_status);
    end if;
    if v_config ? 'side' then
      if jsonb_typeof(v_config -> 'side') <> 'string' then
        raise exception 'trigger_config_side_not_string' using errcode = '22023';
      end if;
      v_status := btrim(v_config ->> 'side');
      if not (v_status = any (c_sides)) then
        raise exception 'trigger_config_side_invalid' using errcode = '22023';
      end if;
      v_out := v_out || jsonb_build_object('side', v_status);
    end if;

  else
    -- new_lead, contact_created, contact_status_changed, manual: nothing to
    -- configure. include_existing is accepted and normalized away so an
    -- older client that always sends it is not broken by this migration.
    v_out := '{}'::jsonb;
  end if;

  return v_out;
end;
$fn$;

revoke all on function automation_internal.validate_trigger_config(text, jsonb)
  from public, anon;
-- The browser may validate a draft against the same rule the server
-- enforces. It reads nothing and writes nothing.
grant execute on function automation_internal.validate_trigger_config(text, jsonb)
  to authenticated, service_role;


-- ============================================================
-- 5. The matcher, back to the Phase 2C definition.
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


-- ============================================================
-- 6. The detector, back to the Phase 2C definition.
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
-- 7. The reminder scan, back to the Phase 2C definition (UTC).
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


-- ============================================================
-- 8. And finally the two helpers, now that nothing calls them.
-- ============================================================
drop function if exists automation_internal.yearly_date(date, integer);
drop function if exists automation_internal.workspace_timezone(uuid);

-- ============================================================
-- 9. The two contact dates.
-- ============================================================
drop index if exists public.contacts_ws_birthday_idx;
drop index if exists public.contacts_ws_home_purchase_idx;
alter table public.contacts
  drop column if exists birthday,
  drop column if exists home_purchase_date;

-- ============================================================
-- 10. Verify.
-- ============================================================
do $verify$
declare
  v_bad text := '';
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'contacts'
                and column_name in ('birthday', 'home_purchase_date')) then
    v_bad := v_bad || E'\n  a Phase 2D contact date still exists';
  end if;

  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where (n.nspname = 'public' and p.proname = 'realtoros_timezone_names')
                 or (n.nspname = 'automation_internal'
                     and p.proname in ('yearly_date', 'workspace_timezone',
                                       'deal_won_marks_past_client'))) then
    v_bad := v_bad || E'\n  a Phase 2D function still exists';
  end if;

  if exists (select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
              where not t.tgisinternal
                and t.tgname in ('deals_won_past_client_update',
                                 'deals_won_past_client_insert')) then
    v_bad := v_bad || E'\n  a won-deal trigger still exists';
  end if;

  if exists (select 1 from public.automation_rules
              where trigger_type in ('birthday', 'home_anniversary')) then
    v_bad := v_bad || E'\n  a rule still carries a Phase 2D trigger type';
  end if;

  -- The four restored functions must no longer mention anything 2D added.
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname in ('public', 'automation_internal')
                and p.proname in ('realtoros_scan_time_triggers',
                                  'realtoros_rules_for_event',
                                  'realtoros_scan_follow_up_reminders',
                                  'validate_trigger_config')
                and (p.prosrc like '%yearly_date%'
                     or p.prosrc like '%home_anniversary%'
                     or p.prosrc like '%days_before%'
                     or p.prosrc like '%workspace_timezone%')) then
    v_bad := v_bad || E'\n  a restored function still references Phase 2D';
  end if;

  -- And the summary must be reading UTC again.
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public'
                    and p.proname = 'realtoros_scan_follow_up_reminders'
                    and p.prosrc like '%at time zone ''UTC''%') then
    v_bad := v_bad || E'\n  the summary was not restored to reading today in UTC';
  end if;

  if v_bad <> '' then
    raise exception 'Phase 2D revert incomplete:%', v_bad;
  end if;
  raise notice 'Phase 2D reverted: the yearly triggers, the two dates and the workspace time zone are gone.';
end $verify$;

commit;
