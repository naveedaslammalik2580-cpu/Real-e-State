-- Phase 2A: time-based and deal-based automation triggers.
--
-- Today a sequence can only start when something happens to a contact
-- right now: it was created, or its status changed, or somebody enrolled
-- it by hand. 2A adds the four starts a follow-up CRM actually needs:
--
--   follow_up_due       the contact's next follow-up date has arrived
--   no_contact          nobody has contacted this person for N days
--   status_stale        the contact has sat in one status for N days
--   deal_stage_changed  a deal linked to the contact moved to a stage
--
-- WHY THERE IS NO SECOND ENGINE
--
-- The first three are not events - nothing happens at the moment a
-- follow-up date arrives; the date simply passes. So they are DETECTED,
-- by public.realtoros_scan_time_triggers, which does exactly one thing:
-- insert rows into public.automation_trigger_events. From there the
-- existing claim -> match -> eligibility -> enroll path runs unchanged.
-- There is one enrollment path in this system and 2A does not add another.
-- deal_stage_changed is a real event, so it gets a trigger like the two
-- contact events already have.
--
-- WHAT STOPS A TIMER FROM FIRING TWICE
--
-- Every detected occurrence has a deterministic event_key built from the
-- rule, the contact and THE VALUE THAT MADE IT TRUE - the follow-up date,
-- the last-contact date, the status and when it changed. A new unique
-- index on (workspace_id, event_key) makes a second insert for the same
-- occurrence impossible, so the scan can run as often as it likes, from as
-- many workers as it likes. Change the underlying value and the key
-- changes with it, which is correct: a new follow-up date is a new
-- occurrence. See docs/PHASE_2A_NOTES.md.
--
-- WHAT STOPS ACTIVATION FROM EMAILING EVERYBODY
--
-- The dangerous case is "no contact for 30 days" on a workspace with two
-- years of history: every silent contact matches the moment the rule goes
-- live. So the scan only creates an event when the moment the condition
-- BECAME TRUE is at or after the rule's activated_at. Switching a rule on
-- therefore enrolls nobody retroactively. A rule may opt in with
-- trigger_config.include_existing, and daily_enrollment_limit still caps
-- it.
--
-- NOT IN 2A: anniversary and birthday triggers.
--
-- Nothing here schedules anything by itself. pg_cron and pg_net are not
-- installed and this migration does not reference them; the scan runs when
-- process-automation calls it, and that function is not deployed yet. 2A is
-- built and inert until go-live, which is intended.
--
-- Idempotent. Existing trigger types, events and enrollments behave
-- exactly as before: every new column is nullable or defaulted, and an
-- event with rule_id null is matched the way it always was.

-- ============================================================
-- 1. automation_rules: the per-trigger configuration.
--
-- trigger_config holds only what the trigger itself needs (how many days,
-- which hour, which statuses). It is deliberately separate from
-- audience_filter, which stays what it was: the contact-matching filter
-- for contact_status_changed.
-- ============================================================
alter table public.automation_rules
  add column if not exists trigger_config jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.automation_rules'::regclass
       and conname = 'automation_rules_trigger_config_check'
  ) then
    alter table public.automation_rules
      add constraint automation_rules_trigger_config_check
      check (jsonb_typeof(trigger_config) = 'object');
  end if;
end $$;

comment on column public.automation_rules.trigger_config is
  'Phase 2A. Per-trigger settings, validated by automation_internal.validate_trigger_config and snapshotted into runtime_snapshot at activation. {} for the trigger types that need no settings. Not a contact filter - that is audience_filter.';

-- The four new starts. Dropped and recreated because a CHECK cannot be
-- extended in place.
alter table public.automation_rules
  drop constraint if exists automation_rules_trigger_type_check;
alter table public.automation_rules
  add constraint automation_rules_trigger_type_check
  check (trigger_type in (
    'new_lead', 'contact_created', 'contact_status_changed', 'manual',
    'follow_up_due', 'no_contact', 'status_stale', 'deal_stage_changed'));

-- ============================================================
-- 2. automation_trigger_events: whose occurrence this is.
--
-- rule_id: a detected occurrence belongs to ONE rule, because the
-- condition ("30 days of silence") is the rule's own setting - another
-- rule asking for 60 days has a different occurrence at a different time.
-- An event with rule_id null is a real-world event matched against every
-- interested rule, which is how the two existing types work and how
-- deal_stage_changed works.
--
-- event_key: the occurrence's identity. Null for the existing types, so
-- the partial unique index below leaves them completely alone.
-- ============================================================
alter table public.automation_trigger_events
  add column if not exists rule_id uuid,
  add column if not exists event_key text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.automation_trigger_events'::regclass
       and conname = 'automation_trigger_events_workspace_id_rule_id_fkey'
  ) then
    -- Composite, matching how every other workspace-scoped reference in
    -- this schema points at a rule. ON DELETE CASCADE: a deleted rule's
    -- pending occurrences are meaningless.
    alter table public.automation_trigger_events
      add constraint automation_trigger_events_workspace_id_rule_id_fkey
      foreign key (workspace_id, rule_id)
      references public.automation_rules(workspace_id, id) on delete cascade;
  end if;
end $$;

create unique index if not exists automation_trigger_events_event_key_uq
  on public.automation_trigger_events (workspace_id, event_key)
  where event_key is not null;

-- Lets the scan's pre-skip ("is this rule already running for this
-- contact") and the worker's rule_id matching avoid a sequential scan.
create index if not exists automation_trigger_events_rule_idx
  on public.automation_trigger_events (workspace_id, rule_id)
  where rule_id is not null;

alter table public.automation_trigger_events
  drop constraint if exists automation_trigger_events_event_type_check;
alter table public.automation_trigger_events
  add constraint automation_trigger_events_event_type_check
  check (event_type in (
    'contact_created', 'contact_status_changed',
    'follow_up_due', 'no_contact', 'status_stale', 'deal_stage_changed'));

-- A detected occurrence must say which rule it belongs to; a real-world
-- event must not pretend to.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.automation_trigger_events'::regclass
       and conname = 'automation_trigger_events_rule_shape_check'
  ) then
    alter table public.automation_trigger_events
      add constraint automation_trigger_events_rule_shape_check
      check (
        (event_type in ('follow_up_due', 'no_contact', 'status_stale')
           and rule_id is not null and event_key is not null)
        or (event_type in ('contact_created', 'contact_status_changed')
           and rule_id is null)
        or (event_type = 'deal_stage_changed' and rule_id is null)
      );
  end if;
end $$;

comment on column public.automation_trigger_events.rule_id is
  'Phase 2A. The one rule a DETECTED occurrence belongs to (follow_up_due / no_contact / status_stale), because the condition is that rule''s own setting. Null for real-world events, which are matched against every interested rule exactly as before.';
comment on column public.automation_trigger_events.event_key is
  'Phase 2A. Deterministic identity of one occurrence, unique per workspace. Built from the rule, the contact and the value that made the condition true, so re-scanning can never duplicate it and a changed value is correctly a new occurrence. Null for the pre-2A event types.';

-- ============================================================
-- 3. contacts.status_changed_at — when the status last really changed.
--
-- status_stale needs to know how long a contact has sat where it is.
-- updated_at cannot answer that: it moves when anything changes.
-- ============================================================
alter table public.contacts
  add column if not exists status_changed_at timestamptz;

-- Existing rows have no history to recover, so the best available answer
-- is when the row was last touched, falling back to when it was made.
update public.contacts
   set status_changed_at = coalesce(updated_at, created_at)
 where status_changed_at is null;

-- BEFORE UPDATE, because the AFTER trigger that already fires on a status
-- change cannot write to NEW. Fires on every update and checks the status
-- itself, rather than carrying a WHEN clause, so the INSERT default and
-- the UPDATE path are decided in one place.
create or replace function automation_internal.set_contact_status_changed_at()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $fn$
begin
  if TG_OP = 'INSERT' then
    NEW.status_changed_at := coalesce(NEW.status_changed_at, now());
  elsif NEW.status is distinct from OLD.status then
    NEW.status_changed_at := now();
  end if;
  return NEW;
end;
$fn$;

revoke all on function automation_internal.set_contact_status_changed_at()
  from public, anon, authenticated;

-- Runs AFTER contacts_protect_lifecycle_columns_trigger: both are BEFORE
-- triggers on the same table, so they fire in name order, and 'p' sorts
-- before 's'. That order is required. The protect trigger first throws
-- away whatever the browser supplied for status_changed_at; this one then
-- sets the real value when - and only when - the status actually moved. So
-- a browser can cause an honest stamp by changing the status, and can
-- never write a dishonest one.
drop trigger if exists contacts_status_changed_at_trigger on public.contacts;
create trigger contacts_status_changed_at_trigger
  before insert or update on public.contacts
  for each row execute function automation_internal.set_contact_status_changed_at();

comment on column public.contacts.status_changed_at is
  'Phase 2A. When status last actually changed, maintained by a BEFORE trigger and not writable from the browser. Backfilled to coalesce(updated_at, created_at) for rows that predate it.';

-- status_changed_at joins the lifecycle columns the browser may not forge.
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

-- status_stale scans by workspace and age.
create index if not exists contacts_ws_status_changed_idx
  on public.contacts (workspace_id, status, status_changed_at);
-- follow_up_due and no_contact scan by workspace and date.
create index if not exists contacts_ws_next_follow_up_idx
  on public.contacts (workspace_id, next_follow_up)
  where next_follow_up is not null;
create index if not exists contacts_ws_last_contact_idx
  on public.contacts (workspace_id, last_contact);

-- ============================================================
-- 4. deal_stage_changed — a real event, so a real trigger.
--
-- Only when the stage ACTUALLY changes and the deal is linked to a
-- contact: a sequence runs against a person, so a deal with no contact has
-- nobody to enroll. Every other deal edit (value, notes, dates) writes
-- nothing.
-- ============================================================
create or replace function automation_internal.deal_stage_changed_event()
returns trigger
language plpgsql
security definer
set search_path to ''
as $fn$
declare
  v_old_stage text;
  v_changed_at timestamptz := now();
begin
  if NEW.contact_id is null then
    return NEW;
  end if;
  v_old_stage := case when TG_OP = 'UPDATE' then OLD.stage else null end;

  insert into public.automation_trigger_events (
    user_id, workspace_id, contact_id, event_type, payload, event_key, available_at
  )
  values (
    NEW.user_id, NEW.workspace_id, NEW.contact_id, 'deal_stage_changed',
    jsonb_build_object(
      'deal_id', NEW.id,
      'old_stage', v_old_stage,
      'new_stage', NEW.stage,
      'side', NEW.side),
    'deal_stage:' || NEW.id || ':' || NEW.stage || ':' || v_changed_at::text,
    v_changed_at
  )
  on conflict (workspace_id, event_key) where event_key is not null do nothing;

  return NEW;
end;
$fn$;

revoke all on function automation_internal.deal_stage_changed_event()
  from public, anon, authenticated;

-- INSERT as well as UPDATE: a deal created straight into a stage has
-- genuinely reached that stage.
--
-- Two triggers rather than one, because a WHEN clause cannot test TG_OP
-- and OLD does not exist on an INSERT. The UPDATE one carries the WHEN, so
-- the common case - editing a deal without touching its stage - costs
-- nothing. Both call the same function, which reads TG_OP itself.
drop trigger if exists deals_automation_stage_changed_trigger on public.deals;
drop trigger if exists deals_automation_stage_inserted_trigger on public.deals;
create trigger deals_automation_stage_changed_trigger
  after update on public.deals
  for each row
  when (OLD.stage is distinct from NEW.stage)
  execute function automation_internal.deal_stage_changed_event();
create trigger deals_automation_stage_inserted_trigger
  after insert on public.deals
  for each row
  execute function automation_internal.deal_stage_changed_event();

-- ============================================================
-- 5. validate_trigger_config — one definition of what a valid config is.
--
-- Called by the activation path (manage-automation) and usable from the
-- browser's own draft validation, so the rule cannot drift between the two.
-- Returns the NORMALIZED config (defaults filled in) or raises.
--
-- Unknown keys are rejected rather than ignored: a misspelled "day" that
-- silently became the default would be a follow-up sequence firing on the
-- wrong schedule, and the user would have no way to see why.
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

comment on function automation_internal.validate_trigger_config(text, jsonb) is
  'Phase 2A. The single definition of a valid trigger_config. Returns the normalized config with defaults applied, or raises 22023 with a specific code. Unknown keys are rejected rather than ignored.';

-- The public face of the validator.
--
-- PostgREST only exposes the `public` schema, so neither the activation
-- path in manage-automation nor the browser can reach
-- automation_internal.validate_trigger_config directly. This wrapper is
-- how they ask.
--
-- It RETURNS the answer instead of raising, following the convention the
-- rest of these RPCs use: a real failure throws, but an answer the user
-- caused comes back as an object the caller can put into words. So a bad
-- config is { ok: false, code: ... } rather than an exception the edge
-- function would have to parse.
create or replace function public.realtoros_validate_trigger_config(
  p_trigger_type text,
  p_config jsonb
)
returns jsonb
language plpgsql
stable
set search_path to ''
as $fn$
declare
  v_normalized jsonb;
begin
  begin
    v_normalized := automation_internal.validate_trigger_config(p_trigger_type, p_config);
  exception when others then
    -- SQLERRM here is one of this validator's own codes
    -- ('trigger_config_days_out_of_range' and friends). It is generated by
    -- the function above from a fixed set of strings and never contains
    -- user data beyond an offending key name.
    return jsonb_build_object('ok', false, 'code', SQLERRM);
  end;
  return jsonb_build_object('ok', true, 'config', v_normalized);
end;
$fn$;

revoke all on function public.realtoros_validate_trigger_config(text, jsonb)
  from public, anon;
grant execute on function public.realtoros_validate_trigger_config(text, jsonb)
  to authenticated, service_role;

comment on function public.realtoros_validate_trigger_config(text, jsonb) is
  'Phase 2A. Reachable form of automation_internal.validate_trigger_config, for the activation path and for a browser checking a draft. Returns {ok:true, config:<normalized>} or {ok:false, code:<validator code>}; it reads no table and writes nothing.';

-- Drafts are validated on write too, so a config that could never activate
-- cannot be stored in the first place. Normalizes in place.
create or replace function automation_internal.validate_rule_trigger_config()
returns trigger
language plpgsql
security invoker
set search_path to ''
as $fn$
begin
  NEW.trigger_config :=
    automation_internal.validate_trigger_config(NEW.trigger_type, NEW.trigger_config);
  return NEW;
end;
$fn$;

revoke all on function automation_internal.validate_rule_trigger_config()
  from public, anon, authenticated;

drop trigger if exists automation_rules_validate_trigger_config on public.automation_rules;
create trigger automation_rules_validate_trigger_config
  before insert or update of trigger_type, trigger_config on public.automation_rules
  for each row execute function automation_internal.validate_rule_trigger_config();

-- ============================================================
-- 6. Scan throttle state.
--
-- The scan is cheap but not free, and process-automation may run often. One
-- row per workspace records the last scan so a burst of worker runs does
-- not re-scan the same workspace every few seconds. Service-role only: this
-- is worker bookkeeping, not user data, and the browser has no business
-- reading or writing it.
-- ============================================================
create table if not exists public.automation_scan_state (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  last_scanned_at timestamptz not null default now(),
  last_event_count integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.automation_scan_state enable row level security;
revoke all on table public.automation_scan_state from public, anon, authenticated;
grant all on table public.automation_scan_state to service_role;

drop trigger if exists automation_scan_state_set_updated_at on public.automation_scan_state;
create trigger automation_scan_state_set_updated_at
  before update on public.automation_scan_state
  for each row execute function public.realtoros_set_updated_at();

comment on table public.automation_scan_state is
  'Phase 2A. When each workspace was last scanned for time-based trigger occurrences. Worker bookkeeping, service-role only, no RLS policy because no browser role may reach it at all.';

-- ============================================================
-- 7. realtoros_scan_time_triggers — the detector.
--
-- Called by process-automation at the start of a run. Inserts occurrences
-- and returns a small, non-identifying summary. It never sends anything,
-- never enrols anybody, and never touches a rule that is not active.
--
-- HOW A DUE MOMENT IS WORKED OUT
--
-- next_follow_up and last_contact are DATE columns, and status_changed_at
-- is a timestamp, so each condition first yields a local DUE DATE. The
-- occurrence then becomes true at fire_hour on that date IN THE RULE'S
-- TIMEZONE, which is the same timezone 4D already schedules with:
--
--   (due_date + fire_hour hours) AT TIME ZONE rule.timezone
--
-- An occurrence is only inserted once that moment has passed.
--
-- WHO IS IN SCOPE
--
-- A shared rule considers every contact in its workspace. A personal rule
-- considers only the contacts its creator owns - the ones assigned to them,
-- plus unassigned ones they created. "Personal" would mean very little if a
-- private rule quietly emailed the whole team's pipeline.
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
-- 8. Verify.
-- ============================================================
do $verify$
declare
  v_bad text := '';
  v_n integer;
begin
  -- 1. The new trigger types are accepted, the old ones still are.
  for v_n in 1..1 loop
    if not exists (
      select 1 from pg_constraint
       where conrelid = 'public.automation_rules'::regclass
         and conname = 'automation_rules_trigger_type_check'
         and pg_get_constraintdef(oid) like '%follow_up_due%'
         and pg_get_constraintdef(oid) like '%deal_stage_changed%'
         and pg_get_constraintdef(oid) like '%new_lead%'
         and pg_get_constraintdef(oid) like '%manual%'
    ) then
      v_bad := v_bad || E'\n  automation_rules.trigger_type check is wrong';
    end if;
  end loop;

  -- 2. trigger_config exists, defaults to {} and is object-checked.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'automation_rules'
       and column_name = 'trigger_config' and is_nullable = 'NO'
  ) then
    v_bad := v_bad || E'\n  automation_rules.trigger_config is missing or nullable';
  end if;

  -- 3. The event columns, the uniqueness that makes a scan idempotent, and
  --    the shape rule.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'automation_trigger_events'
       and column_name = 'rule_id'
  ) or not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'automation_trigger_events'
       and column_name = 'event_key'
  ) then
    v_bad := v_bad || E'\n  automation_trigger_events is missing rule_id/event_key';
  end if;
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'automation_trigger_events_event_key_uq'
  ) then
    v_bad := v_bad || E'\n  the event_key unique index is missing';
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.automation_trigger_events'::regclass
       and conname = 'automation_trigger_events_workspace_id_rule_id_fkey'
  ) then
    v_bad := v_bad || E'\n  the rule_id foreign key is missing';
  end if;

  -- 4. status_changed_at, backfilled for every existing row.
  if exists (select 1 from public.contacts where status_changed_at is null) then
    v_bad := v_bad || E'\n  some contacts have no status_changed_at after the backfill';
  end if;

  -- 5. Both new triggers are attached.
  select count(*) into v_n from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and not t.tgisinternal
     and ((c.relname = 'contacts' and t.tgname = 'contacts_status_changed_at_trigger')
       or (c.relname = 'deals' and t.tgname = 'deals_automation_stage_changed_trigger')
       or (c.relname = 'deals' and t.tgname = 'deals_automation_stage_inserted_trigger')
       or (c.relname = 'automation_rules' and t.tgname = 'automation_rules_validate_trigger_config'));
  if v_n <> 4 then
    v_bad := v_bad || format(E'\n  expected 4 new triggers, found %s', v_n);
  end if;

  -- 6. The validator agrees with its own contract.
  if automation_internal.validate_trigger_config('no_contact', '{"days": 30}'::jsonb)
     <> '{"days": 30, "fire_hour": 8, "include_existing": false}'::jsonb then
    v_bad := v_bad || E'\n  validate_trigger_config does not apply its defaults';
  end if;
  begin
    perform automation_internal.validate_trigger_config('no_contact', '{"day": 30}'::jsonb);
    v_bad := v_bad || E'\n  validate_trigger_config accepted an unknown key';
  exception when others then null;
  end;
  begin
    perform automation_internal.validate_trigger_config('no_contact', '{}'::jsonb);
    v_bad := v_bad || E'\n  validate_trigger_config accepted no_contact without days';
  exception when others then null;
  end;

  -- 6b. The public validator answers rather than raising.
  if (public.realtoros_validate_trigger_config('no_contact', '{"day": 1}'::jsonb) ->> 'ok') <> 'false' then
    v_bad := v_bad || E'\n  realtoros_validate_trigger_config did not reject an unknown key';
  end if;
  if (public.realtoros_validate_trigger_config('no_contact', '{"days": 7}'::jsonb) ->> 'ok') <> 'true' then
    v_bad := v_bad || E'\n  realtoros_validate_trigger_config rejected a valid config';
  end if;

  -- 7. The scan is reachable by the worker and nobody else.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'realtoros_scan_time_triggers'
       and has_function_privilege('service_role', p.oid, 'EXECUTE')
       and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
       and not has_function_privilege('anon', p.oid, 'EXECUTE')
  ) then
    v_bad := v_bad || E'\n  realtoros_scan_time_triggers grants are wrong';
  end if;

  -- 8. The throttle table is unreachable from the browser.
  if has_table_privilege('authenticated', 'public.automation_scan_state', 'SELECT')
     or has_table_privilege('anon', 'public.automation_scan_state', 'SELECT') then
    v_bad := v_bad || E'\n  automation_scan_state is readable by a browser role';
  end if;

  if v_bad <> '' then
    raise exception 'Phase 2A verification failed:%', v_bad;
  end if;
  raise notice 'Phase 2A: four new trigger types, the scan, the deal-stage event and status_changed_at are in place.';
end $verify$;
