-- Phase 2D: the past-client and sphere programme, and a workspace time zone.
--
-- A past client is the cheapest lead an agent will ever have, and the thing
-- that keeps them is being remembered on the two days they notice: their
-- birthday, and the anniversary of getting their keys. 2D adds both, plus
-- the two dates they are computed from and the automatic bookkeeping that
-- fills them in when a deal closes.
--
-- It also fixes something 2C left: the daily overdue summary read "today" in
-- UTC, so an agent in Dubai or Los Angeles could get a summary a day out.
-- The workspace now has its own time zone.
--
-- NO NEW ENGINE, AGAIN. birthday and home_anniversary are two more trigger
-- types for the Phase 2A detector, going through the same
-- automation_internal.rule_targets_contact, the same event_key uniqueness
-- and the same claim -> match -> eligibility -> enrol path. The only new
-- arithmetic is "which calendar day is this person's date THIS year", which
-- lives in one function.
--
-- WHY A YEARLY OCCURRENCE IS DIFFERENT
--
-- The three Phase 2A timers measure from a stored moment, so their key is
-- that moment. A birthday recurs, so its key is the YEAR: one greeting per
-- person per year, whatever happens in between. And a late birthday
-- greeting is worse than none, so trigger_config.include_existing is
-- deliberately ignored for these two - an occurrence that passed before the
-- rule was switched on stays passed.
--
-- Nothing here schedules itself. pg_cron and pg_net are still not
-- installed, this migration references neither, and process-automation is
-- still not deployed.
--
-- SAFELY RE-RUNNABLE. Every column, index, constraint, trigger and function
-- below is guarded or replaced, and the one data write (the backfill of
-- settings_data.timezone) only touches rows that do not have the key yet.
-- Proven by applying it twice in PGlite.

-- ============================================================
-- 1. TWO DATES ON A CONTACT
--
-- Ordinary editable fields, unlike the lifecycle columns: the agent types
-- these in, so the browser writes them and the lifecycle guard leaves them
-- alone on purpose.
-- ============================================================
alter table public.contacts
  add column if not exists birthday date,
  add column if not exists home_purchase_date date;

comment on column public.contacts.birthday is
  'Phase 2D. The contact''s birthday, for the birthday trigger. Editable by the agent; only the month and day matter to the trigger, so a missing or placeholder year is harmless.';
comment on column public.contacts.home_purchase_date is
  'Phase 2D. When this person got their keys, for the home-anniversary trigger. Filled in automatically when a deal they are on is marked won, if it is still empty.';

-- The yearly scans read by workspace and date.
create index if not exists contacts_ws_birthday_idx
  on public.contacts (workspace_id, birthday)
  where birthday is not null;
create index if not exists contacts_ws_home_purchase_idx
  on public.contacts (workspace_id, home_purchase_date)
  where home_purchase_date is not null;

-- ============================================================
-- 2. WHAT A YEARLY DATE MEANS
--
-- One definition, because both triggers need it and because the awkward
-- case is easy to get wrong: 29 February. make_date(2027, 2, 29) does not
-- raise an eyebrow, it raises an exception. Somebody born on a leap day has
-- a birthday every year, and in a non-leap year the 28th is when people
-- mark it, so that is what this returns.
-- ============================================================
create or replace function automation_internal.yearly_date(
  p_source date,
  p_year integer
)
returns date
language sql
immutable
set search_path = ''
as $fn$
  select case
    when p_source is null or p_year is null then null
    when extract(month from p_source) = 2 and extract(day from p_source) = 29
         and not (p_year % 4 = 0 and (p_year % 100 <> 0 or p_year % 400 = 0))
      then make_date(p_year, 2, 28)
    else make_date(p_year, extract(month from p_source)::integer, extract(day from p_source)::integer)
  end;
$fn$;

revoke all on function automation_internal.yearly_date(date, integer)
  from public, anon, authenticated;
-- service_role only, like everything else in this schema. The browser has
-- no USAGE on automation_internal at all, so granting EXECUTE here would be
-- unreachable and would only look like an opening. The Today screen does
-- the same arithmetic in JavaScript (yearlyDate_ in pages/release.js),
-- including the leap-day rule, because it is showing a list rather than
-- deciding whether to send anything.
grant execute on function automation_internal.yearly_date(date, integer)
  to service_role;

comment on function automation_internal.yearly_date(date, integer) is
  'Phase 2D. The given date as it falls in the given year. A 29 February source becomes 28 February in a non-leap year, because the person still has a birthday and that is the day it is marked.';

-- ============================================================
-- 3. A DEAL BEING WON IS THE START OF THE RELATIONSHIP
--
-- deals.status is a NOT NULL column holding exactly 'active', 'won' or
-- 'lost', derived by the app from the workspace's own pipeline (the stage
-- carrying terminal: 'won'). So "won" is a real database value and does not
-- depend on what a workspace happens to have called its closing stage.
--
-- Both writes are idempotent by construction - the date only when it is
-- empty, the tag only when it is missing - so a deal that flips out of won
-- and back does not undo or duplicate anything.
--
-- SECURITY DEFINER because in a team the deal and the contact can belong to
-- different people, and the contacts row policies would refuse the write
-- even though the bookkeeping is legitimate.
-- ============================================================
create or replace function automation_internal.deal_won_marks_past_client()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if NEW.contact_id is null or NEW.status <> 'won' then
    return NEW;
  end if;

  update public.contacts c
     set home_purchase_date = coalesce(
           c.home_purchase_date,
           -- The deal's own close date if it has one, otherwise today: the
           -- keys changed hands at some point, and today is the honest
           -- approximation when nobody recorded when.
           NEW.expected_close,
           (now() at time zone coalesce(
              automation_internal.workspace_timezone(c.workspace_id), 'UTC'))::date),
         tags = case
           when c.tags @> array['Past client']::text[] then c.tags
           else c.tags || array['Past client']::text[]
         end
   where c.id = NEW.contact_id
     and c.workspace_id = NEW.workspace_id;

  return NEW;
end;
$fn$;

revoke all on function automation_internal.deal_won_marks_past_client()
  from public, anon, authenticated;

-- Two triggers rather than one: a WHEN clause cannot test TG_OP, and OLD
-- does not exist on an INSERT. The UPDATE one carries the transition test,
-- so editing a deal that is already won costs nothing.
drop trigger if exists deals_won_past_client_update on public.deals;
drop trigger if exists deals_won_past_client_insert on public.deals;
create trigger deals_won_past_client_update
  after update on public.deals
  for each row
  when (NEW.status = 'won' and OLD.status is distinct from 'won')
  execute function automation_internal.deal_won_marks_past_client();
create trigger deals_won_past_client_insert
  after insert on public.deals
  for each row
  when (NEW.status = 'won')
  execute function automation_internal.deal_won_marks_past_client();

-- ============================================================
-- 4. THE WORKSPACE TIME ZONE
--
-- Lives in the settings bag, like every other setting that has no column of
-- its own. Validated HERE rather than trusted: the value is typed by a
-- person, and `at time zone <nonsense>` is an exception that would take a
-- whole scan down with it. An unrecognised or missing zone reads as UTC,
-- which is wrong by at most a day rather than fatal.
-- ============================================================
create or replace function automation_internal.workspace_timezone(
  p_workspace_id uuid
)
returns text
language sql
stable
set search_path = ''
as $fn$
  select coalesce(
    (select s.settings_data ->> 'timezone'
       from public.workspace_settings s
      where s.workspace_id = p_workspace_id
        and s.settings_data ->> 'timezone' is not null
        -- Only a zone Postgres actually knows. pg_timezone_names is the
        -- same list the planner uses for `at time zone`.
        and exists (select 1 from pg_timezone_names tz
                     where tz.name = s.settings_data ->> 'timezone')
      limit 1),
    'UTC');
$fn$;

revoke all on function automation_internal.workspace_timezone(uuid)
  from public, anon, authenticated;
-- service_role only, for the same reason. The settings screen reads the
-- zone out of the settings bag it already has, and public.realtoros_timezone_names
-- below is the browser-facing half.
grant execute on function automation_internal.workspace_timezone(uuid)
  to service_role;

comment on function automation_internal.workspace_timezone(uuid) is
  'Phase 2D. The workspace''s IANA time zone from settings_data.timezone, validated against pg_timezone_names, falling back to UTC. Used so a daily summary lands on the right calendar day.';

-- A readable list for the settings screen, so the browser does not ship a
-- copy of the zone database that drifts from the server's.
create or replace function public.realtoros_timezone_names()
returns setof text
language sql
stable
set search_path = ''
as $fn$
  select tz.name from pg_timezone_names tz
   where tz.name not like 'posix/%'
     and tz.name not like 'Etc/%'
     and tz.name like '%/%'
   order by tz.name;
$fn$;

revoke all on function public.realtoros_timezone_names() from public, anon;
grant execute on function public.realtoros_timezone_names() to authenticated, service_role;

comment on function public.realtoros_timezone_names() is
  'Phase 2D. The IANA zone names the settings screen offers, straight from pg_timezone_names so the list can never disagree with what the server will accept.';

-- Workspaces that have settings but no zone get UTC written explicitly, so
-- the column reads the same as the behaviour. Only rows missing the key are
-- touched, which is what makes this re-runnable.
update public.workspace_settings
   set settings_data = settings_data || jsonb_build_object('timezone', 'UTC')
 where not (settings_data ? 'timezone');

-- ============================================================
-- 5. TWO MORE TRIGGER TYPES
-- ============================================================
alter table public.automation_rules
  drop constraint if exists automation_rules_trigger_type_check;
alter table public.automation_rules
  add constraint automation_rules_trigger_type_check
  check (trigger_type in (
    'new_lead', 'contact_created', 'contact_status_changed', 'manual',
    'follow_up_due', 'no_contact', 'status_stale', 'deal_stage_changed',
    -- Phase 2D
    'birthday', 'home_anniversary'));

alter table public.automation_trigger_events
  drop constraint if exists automation_trigger_events_event_type_check;
alter table public.automation_trigger_events
  add constraint automation_trigger_events_event_type_check
  check (event_type in (
    'contact_created', 'contact_status_changed',
    'follow_up_due', 'no_contact', 'status_stale', 'deal_stage_changed',
    -- Phase 2D
    'birthday', 'home_anniversary'));

-- The two new types are DETECTED, so they must name their rule like the
-- other three.
alter table public.automation_trigger_events
  drop constraint if exists automation_trigger_events_rule_shape_check;
alter table public.automation_trigger_events
  add constraint automation_trigger_events_rule_shape_check
  check (
    (event_type in ('follow_up_due', 'no_contact', 'status_stale',
                    'birthday', 'home_anniversary')
       and rule_id is not null and event_key is not null)
    or (event_type in ('contact_created', 'contact_status_changed')
       and rule_id is null)
    or (event_type = 'deal_stage_changed' and rule_id is null)
  );

-- ---- the validator ----
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
  v_before integer;
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
    -- Phase 2D. include_existing is ACCEPTED and then dropped: a yearly
    -- occurrence that passed before the rule was switched on stays passed,
    -- because a late birthday greeting is worse than none.
    when 'birthday'           then array['days_before', 'fire_hour', 'include_existing']
    when 'home_anniversary'   then array['days_before', 'fire_hour', 'include_existing']
    else array['include_existing']
  end;

  for v_key in select jsonb_object_keys(v_config) loop
    if not (v_key = any (v_allowed)) then
      raise exception 'trigger_config_unknown_key_%', v_key using errcode = '22023';
    end if;
  end loop;

  if p_trigger_type in ('follow_up_due', 'no_contact', 'status_stale',
                        'birthday', 'home_anniversary') then
    if v_config ? 'fire_hour' then
      if jsonb_typeof(v_config -> 'fire_hour') <> 'number' then
        raise exception 'trigger_config_fire_hour_not_number' using errcode = '22023';
      end if;
      v_hour := (v_config ->> 'fire_hour')::numeric::integer;
      if (v_config ->> 'fire_hour')::numeric <> v_hour or v_hour < 0 or v_hour > 23 then
        raise exception 'trigger_config_fire_hour_out_of_range' using errcode = '22023';
      end if;
    else
      -- 9am for a greeting, 8am for a chase: a birthday message at 8am
      -- reads as a reminder, at 9am as a thought.
      v_hour := case when p_trigger_type in ('birthday', 'home_anniversary') then 9 else 8 end;
    end if;
  end if;

  if p_trigger_type = 'follow_up_due' then
    v_out := jsonb_build_object('fire_hour', v_hour, 'include_existing', v_include);

  elsif p_trigger_type in ('birthday', 'home_anniversary') then
    if v_config ? 'days_before' then
      if jsonb_typeof(v_config -> 'days_before') <> 'number' then
        raise exception 'trigger_config_days_before_not_number' using errcode = '22023';
      end if;
      v_before := (v_config ->> 'days_before')::numeric::integer;
      if (v_config ->> 'days_before')::numeric <> v_before or v_before < 0 or v_before > 30 then
        raise exception 'trigger_config_days_before_out_of_range' using errcode = '22023';
      end if;
    else
      v_before := 0;
    end if;
    -- include_existing is normalized away rather than stored: keeping it
    -- would imply it does something here.
    v_out := jsonb_build_object('days_before', v_before, 'fire_hour', v_hour);

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
    v_out := '{}'::jsonb;
  end if;

  return v_out;
end;
$fn$;

revoke all on function automation_internal.validate_trigger_config(text, jsonb)
  from public, anon;
grant execute on function automation_internal.validate_trigger_config(text, jsonb)
  to authenticated, service_role;

-- ---- the matcher knows the two new types are detected ----
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
  c_detected constant text[] := array[
    'follow_up_due', 'no_contact', 'status_stale', 'birthday', 'home_anniversary'];
begin
  select * into v_event from public.automation_trigger_events where id = p_event_id;
  if not found then
    return '[]'::jsonb;
  end if;

  if v_event.event_type = any (c_detected) then
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
             and (r.audience_filter ->> 'status_equals') = v_event.new_status
           when 'deal_stage_changed' then
             r.trigger_type = 'deal_stage_changed'
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
-- 6. THE DETECTOR LEARNS THE YEARLY TYPES
--
-- The three Phase 2A timers keep their exact query, untouched. The two
-- yearly types get their own INSERT inside the same loop, because the shape
-- of the question is different: not "has enough time passed since a stored
-- moment" but "which calendar occurrence is the most recent one that has
-- arrived".
--
-- THREE CANDIDATE YEARS, not one. days_before shifts the due moment
-- EARLIER, so a 5 January birthday with days_before = 10 is due on 26
-- December of the previous year. Last year, this year and next year are all
-- considered, and the most recent occurrence that has actually arrived is
-- the one recorded. Older ones are not: a rule switched on today does not
-- fire off a decade of missed birthdays, because every occurrence still has
-- to fall on or after activated_at.
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
  v_before integer;
  v_include boolean;
  v_statuses text[];
  v_ws uuid;
  v_yearly boolean;
  c_throttle constant interval := interval '5 minutes';
  -- How late a YEARLY occurrence may still be sent. See the `ready` CTE.
  c_grace constant interval := interval '1 day';
  c_types constant text[] := array[
    'follow_up_due', 'no_contact', 'status_stale', 'birthday', 'home_anniversary'];
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
                and r.trigger_type = any (c_types))
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
         and r.trigger_type = any (c_types)
       order by r.id
    loop
      if v_budget <= 0 then exit; end if;
      v_rules := v_rules + 1;
      v_yearly := v_rule.trigger_type in ('birthday', 'home_anniversary');

      v_hour := coalesce((v_rule.trigger_config ->> 'fire_hour')::integer,
                         case when v_yearly then 9 else 8 end);
      v_include := coalesce((v_rule.trigger_config ->> 'include_existing')::boolean, false);
      v_days := (v_rule.trigger_config ->> 'days')::integer;
      v_before := coalesce((v_rule.trigger_config ->> 'days_before')::integer, 0);
      v_statuses := case
        when v_rule.trigger_config ? 'statuses'
          then array(select jsonb_array_elements_text(v_rule.trigger_config -> 'statuses'))
        else null end;

      if v_yearly then
        -- ---------- birthday / home_anniversary ----------
        with eligible as (
          select c.id as contact_id,
                 case v_rule.trigger_type
                   when 'birthday' then c.birthday
                   else c.home_purchase_date
                 end as source
            from public.contacts c
           where c.workspace_id = v_rule.workspace_id
             and automation_internal.rule_targets_contact(v_rule.id, c.id)
             and (not (v_rule.audience_filter ? 'status_equals')
                  or c.status = (v_rule.audience_filter ->> 'status_equals'))
             and case v_rule.trigger_type
                   when 'birthday' then c.birthday is not null
                   else c.home_purchase_date is not null
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
        ), occurrences as (
          -- Last year, this year, next year: days_before can pull an
          -- occurrence back across the new year.
          select e.contact_id, e.source,
                 (extract(year from (v_now at time zone v_rule.timezone))::integer + offs) as occ_year
            from eligible e
            cross join generate_series(-1, 1) as offs
        ), dated as (
          select o.contact_id, o.occ_year,
                 (((automation_internal.yearly_date(o.source, o.occ_year)
                      - make_interval(days => v_before))::timestamp
                    + make_interval(hours => v_hour))
                   at time zone v_rule.timezone) as due_at
            from occurrences o
           where automation_internal.yearly_date(o.source, o.occ_year) is not null
             -- A home anniversary has no year zero: the purchase year is the
             -- purchase, not an anniversary of it.
             and (v_rule.trigger_type <> 'home_anniversary'
                  or o.occ_year > extract(year from o.source)::integer)
        ), ready as (
          -- One row per contact: the most recent occurrence that has
          -- arrived, and ONLY IF IT ARRIVED RECENTLY.
          --
          -- The grace window is the whole point. Without it, a rule
          -- switched on in June would look back, find last year's birthday
          -- in the candidate years, see that it is "due" and send a
          -- greeting a year late. The same bound means a worker that was
          -- down over a birthday skips it rather than sending it stale:
          -- a late birthday greeting is worse than none, which is also why
          -- include_existing is deliberately not consulted here.
          --
          -- days_before already lets the agent choose to send early, so
          -- this only ever trims the late side.
          select distinct on (d.contact_id)
                 d.contact_id, d.occ_year, d.due_at
            from dated d
           where d.due_at <= v_now
             and d.due_at > v_now - c_grace
             and (v_rule.activated_at is null or d.due_at >= v_rule.activated_at)
           order by d.contact_id, d.due_at desc
        ), capped as (
          select r.contact_id, r.occ_year, r.due_at
            from ready r
           order by r.due_at, r.contact_id
           limit v_budget
        )
        insert into public.automation_trigger_events (
          user_id, workspace_id, contact_id, event_type, rule_id, event_key,
          available_at, payload
        )
        select
          v_rule.user_id, v_rule.workspace_id, cp.contact_id, v_rule.trigger_type,
          v_rule.id,
          case v_rule.trigger_type when 'birthday' then 'bd:' else 'ha:' end
            || v_rule.id::text || ':' || cp.contact_id || ':' || cp.occ_year::text,
          cp.due_at,
          jsonb_build_object('rule_id', v_rule.id, 'due_at', cp.due_at,
                             'trigger_type', v_rule.trigger_type,
                             'year', cp.occ_year)
        from capped cp
        on conflict (workspace_id, event_key) where event_key is not null do nothing;

      else
        -- ---------- the Phase 2A timers, unchanged ----------
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
      end if;

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
-- 7. THE DAILY SUMMARY LANDS ON THE RIGHT DAY
--
-- Identical to the Phase 2C function except for one line: "today" is now
-- read in the workspace's own zone instead of UTC. Same signature, same
-- grants, same dedupe keys.
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
  v_zone text;
  c_escalate constant interval := interval '24 hours';
begin
  for v_ws in select w.id, w.owner_user_id from public.workspaces w order by w.id
  loop
    select greatest(1, least(72,
             coalesce((s.settings_data ->> 'followUpReminderHours')::integer, 4)))
      into v_hours
      from public.workspace_settings s
     where s.workspace_id = v_ws.id
     limit 1;
    if v_hours is null then v_hours := 4; end if;

    -- Phase 2D: the workspace's own zone, validated, UTC if it has none.
    v_zone := automation_internal.workspace_timezone(v_ws.id);

    select count(*) into v_members
      from public.workspace_members wm
     where wm.workspace_id = v_ws.id and wm.status = 'active';

    for v_row in
      select c.id, c.full_name, c.created_at, c.assigned_to_id, c.user_id
        from public.contacts c
       where c.workspace_id = v_ws.id
         and c.first_touched_at is null
         and c.status not in ('Lost', 'Past Client')
         and c.created_at <= v_now - make_interval(hours => v_hours)
       order by c.created_at
    loop
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
               || ' has been waiting since '
               || to_char(v_row.created_at at time zone v_zone, 'FMDay FMDD Mon')
               || ' with no contact logged.',
             v_row.id, '/contacts/' || v_row.id,
             'untouched:' || v_row.id || ':l1',
             jsonb_build_object('level', 1, 'hours', v_hours)
           ) is not null then
          v_level1 := v_level1 + 1;
        end if;
      end if;

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
                 || ' was added on '
                 || to_char(v_row.created_at at time zone v_zone, 'FMDay FMDD Mon')
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

      -- THE PHASE 2D FIX. Read in the workspace's zone, so a summary never
      -- arrives on the wrong calendar day and the once-per-day dedupe key
      -- means the day the agent is actually living in.
      v_today := (v_now at time zone v_zone)::date;

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
-- 8. Verify.
-- ============================================================
do $verify$
declare
  v_bad text := '';
  v_n integer;
begin
  -- The two dates exist and are NOT lifecycle-protected: the agent types
  -- them in, so the browser must be able to write them.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'contacts'
       and column_name in ('birthday', 'home_purchase_date')
       and is_nullable = 'YES'
  ) then
    v_bad := v_bad || E'\n  the two new contact dates are missing';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'automation_internal'
       and p.proname = 'protect_contact_lifecycle_columns'
       and (p.prosrc like '%birthday%' or p.prosrc like '%home_purchase_date%')
  ) then
    v_bad := v_bad || E'\n  the new dates were wrongly added to the lifecycle guard';
  end if;

  -- Leap day, both ways.
  if automation_internal.yearly_date('2000-02-29'::date, 2027) <> '2027-02-28'::date then
    v_bad := v_bad || E'\n  a leap-day birthday does not fall back to 28 February';
  end if;
  if automation_internal.yearly_date('2000-02-29'::date, 2028) <> '2028-02-29'::date then
    v_bad := v_bad || E'\n  a leap-day birthday is wrong in a leap year';
  end if;
  if automation_internal.yearly_date('1990-07-04'::date, 2026) <> '2026-07-04'::date then
    v_bad := v_bad || E'\n  an ordinary date is wrong';
  end if;

  -- Both CHECKs accept the new types and still accept the old ones.
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.automation_rules'::regclass
       and conname = 'automation_rules_trigger_type_check'
       and pg_get_constraintdef(oid) like '%birthday%'
       and pg_get_constraintdef(oid) like '%home_anniversary%'
       and pg_get_constraintdef(oid) like '%no_contact%'
       and pg_get_constraintdef(oid) like '%new_lead%'
  ) then
    v_bad := v_bad || E'\n  the trigger_type check is wrong';
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.automation_trigger_events'::regclass
       and conname = 'automation_trigger_events_event_type_check'
       and pg_get_constraintdef(oid) like '%birthday%'
       and pg_get_constraintdef(oid) like '%home_anniversary%'
  ) then
    v_bad := v_bad || E'\n  the event_type check is wrong';
  end if;

  -- The validator knows the new types, with their own defaults.
  if automation_internal.validate_trigger_config('birthday', '{}'::jsonb)
     <> '{"days_before": 0, "fire_hour": 9}'::jsonb then
    v_bad := v_bad || E'\n  the birthday defaults are wrong';
  end if;
  begin
    perform automation_internal.validate_trigger_config('birthday', '{"days_before": 31}'::jsonb);
    v_bad := v_bad || E'\n  days_before accepted a value above 30';
  exception when others then null;
  end;
  begin
    perform automation_internal.validate_trigger_config('birthday', '{"days": 3}'::jsonb);
    v_bad := v_bad || E'\n  the birthday validator accepted a foreign key';
  exception when others then null;
  end;
  -- include_existing is accepted, then dropped.
  if automation_internal.validate_trigger_config('home_anniversary', '{"include_existing": true}'::jsonb)
       ? 'include_existing' then
    v_bad := v_bad || E'\n  include_existing should be normalized away for a yearly trigger';
  end if;

  -- The detector and the matcher both know the new types.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'realtoros_scan_time_triggers'
       and p.prosrc like '%home_anniversary%' and p.prosrc like '%yearly_date%'
  ) then
    v_bad := v_bad || E'\n  the detector does not handle the yearly types';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'realtoros_rules_for_event'
       and p.prosrc like '%home_anniversary%'
  ) then
    v_bad := v_bad || E'\n  the matcher does not treat the yearly types as detected';
  end if;

  -- The summary reads the workspace zone rather than UTC.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'realtoros_scan_follow_up_reminders'
       and p.prosrc like '%workspace_timezone%'
  ) then
    v_bad := v_bad || E'\n  the reminder summary still reads today in UTC';
  end if;

  -- An unknown zone falls back rather than raising.
  if automation_internal.workspace_timezone(gen_random_uuid()) <> 'UTC' then
    v_bad := v_bad || E'\n  an unknown workspace does not fall back to UTC';
  end if;

  -- Every workspace that has settings now states a zone.
  if exists (select 1 from public.workspace_settings where not (settings_data ? 'timezone')) then
    v_bad := v_bad || E'\n  a workspace_settings row has no timezone after the backfill';
  end if;

  -- Both deal triggers are attached.
  select count(*) into v_n from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'deals' and not t.tgisinternal
     and t.tgname in ('deals_won_past_client_update', 'deals_won_past_client_insert');
  if v_n <> 2 then
    v_bad := v_bad || format(E'\n  expected 2 won-deal triggers, found %s', v_n);
  end if;

  -- The zone list is for the browser; the detector is not.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'realtoros_timezone_names'
       and has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ) then
    v_bad := v_bad || E'\n  the timezone list is not readable by the browser';
  end if;
  -- And nothing new in automation_internal pretends to be browser-facing,
  -- which it could not be: the browser has no USAGE on that schema.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'automation_internal'
       and p.proname in ('yearly_date', 'workspace_timezone')
       and has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ) then
    v_bad := v_bad || E'\n  a private helper carries a pointless browser grant';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'realtoros_scan_time_triggers'
       and has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ) then
    v_bad := v_bad || E'\n  the detector is reachable from the browser';
  end if;

  if v_bad <> '' then
    raise exception 'Phase 2D verification failed:%', v_bad;
  end if;
  raise notice 'Phase 2D: birthdays, home anniversaries, the won-deal bookkeeping and the workspace time zone are in place.';
end $verify$;
