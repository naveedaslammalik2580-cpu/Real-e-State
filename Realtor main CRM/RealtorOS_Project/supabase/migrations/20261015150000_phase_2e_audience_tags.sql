-- Phase 2E: a tag-aware audience, in the one place that decides it.
--
-- Phase 2D shipped a "Stay in touch" starter rule that was meant to reach
-- past clients and could not say so: audience_filter had no way to express
-- a tag, so the intended audience rode along in the rule's metadata as a
-- note for the agent to apply by hand. That is a workaround, not a feature.
--
-- audience_filter.tags_any fixes it: a list of tags, matched
-- case-insensitively, any one of which puts a contact in the audience.
--
-- WHERE IT IS DECIDED
--
-- In automation_internal.rule_targets_contact, which is already the single
-- answer to "may this rule act on this contact" for every trigger type -
-- the two contact events, the three timers and the two yearly ones all go
-- through it. Adding the tag test there means no caller has to remember to
-- apply it, and there is no second copy to drift.
--
-- status_equals deliberately stays where it is, in each caller. It is not
-- the same kind of question: for contact_status_changed it tests the status
-- the event CARRIES, not the status the contact happens to have now, and
-- folding it in here would silently change that.
--
-- ABOUT RE-RUNNING THIS
--
-- The Phase 2C and 2D wrappers fail on a second run with
-- `ERROR 42P01: relation "v_n" does not exist`. Their verify blocks are the
-- only place that name appears, as `select count(*) into v_n`: in PL/pgSQL
-- that is an assignment, but in plain SQL `SELECT ... INTO v_n` means CREATE
-- TABLE v_n, so on any path where the block is handled as SQL rather than
-- PL/pgSQL the name resolves as a relation - which is exactly that error.
-- PGlite's parser tolerates it, which is why the tests never caught it.
--
-- So the verify block at the end of THIS migration declares no variables at
-- all: every check is a self-contained `if (not) exists (...)` or a scalar
-- subquery, which is the shape of the one migration
-- (20261014120000_sheet_import_matches_manual_contacts) that re-runs
-- cleanly. Everything else here is guarded, and applying it twice is part
-- of the test suite.

-- ============================================================
-- 1. THE AUDIENCE TEST, WITH TAGS
--
-- One function, one definition, every trigger type. The tag comparison is
-- case-insensitive because tags are typed by people: "Past client", "Past
-- Client" and "past client" are the same tag to everybody except a
-- computer.
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
       -- Who the rule is allowed to act on (Phase 2C).
       and (
         r.visibility = 'shared'
         or c.assigned_to_id = (
              select tm.id from public.team_members tm
               where tm.workspace_id = r.workspace_id
                 and tm.auth_user_id = r.user_id
               limit 1)
         or (c.assigned_to_id is null and c.user_id = r.user_id)
       )
       -- Phase 2E: and whether they are in the audience the rule asked
       -- for. An absent or empty tags_any means "no tag filter", NOT "match
       -- nobody" - an empty list is how a UI reports "none ticked", and
       -- silently matching nobody would look like the rule was broken.
       and (
         not (r.audience_filter ? 'tags_any')
         or jsonb_typeof(r.audience_filter -> 'tags_any') <> 'array'
         or jsonb_array_length(r.audience_filter -> 'tags_any') = 0
         or exists (
              select 1
                from unnest(coalesce(c.tags, '{}'::text[])) as contact_tag
                join jsonb_array_elements_text(r.audience_filter -> 'tags_any') as wanted
                  on lower(btrim(wanted)) = lower(btrim(contact_tag))
            )
       )
  );
$fn$;

revoke all on function automation_internal.rule_targets_contact(uuid, text)
  from public, anon, authenticated;
grant execute on function automation_internal.rule_targets_contact(uuid, text)
  to service_role;

comment on function automation_internal.rule_targets_contact(uuid, text) is
  'Phase 2E. The single definition of whether a rule may act on a contact: visibility (shared sees the workspace, personal only its creator''s own) AND audience_filter.tags_any, matched case-insensitively with an absent or empty list meaning no filter. Used by realtoros_rules_for_event and both scans, so the rule exists once. status_equals is NOT here: for a status-change event it tests the status the event carries, which is a different question.';

-- Contacts are filtered by tag now, so the scans want an index for it.
create index if not exists contacts_ws_tags_idx
  on public.contacts using gin (tags);

-- ============================================================
-- 2. VALIDATING audience_filter
--
-- audience_filter had no database validator at all: it was checked in the
-- browser and again in manage-automation at activation. tags_any is a list
-- of free text that reaches a query, so it gets a real one here, on the
-- same model as validate_trigger_config - returns the normalized value or
-- raises 22023 with a specific code.
--
-- Normalizing matters as much as validating: tags are trimmed, blanks
-- dropped, de-duplicated case-insensitively and sorted, so two filters
-- meaning the same audience are the same value.
-- ============================================================
create or replace function automation_internal.validate_audience_filter(
  p_trigger_type text,
  p_filter jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $fn$
declare
  v_filter jsonb := coalesce(p_filter, '{}'::jsonb);
  v_key text;
  v_out jsonb := '{}'::jsonb;
  v_status text;
  v_tags jsonb;
  c_statuses constant text[] := array[
    'New Lead', 'Qualified', 'Nurturing', 'Client', 'Past Client', 'Lost'];
begin
  if jsonb_typeof(v_filter) <> 'object' then
    raise exception 'audience_filter_not_object' using errcode = '22023';
  end if;

  for v_key in select jsonb_object_keys(v_filter) loop
    if v_key not in ('status_equals', 'tags_any') then
      raise exception 'audience_filter_unknown_key_%', v_key using errcode = '22023';
    end if;
  end loop;

  -- status_equals: unchanged, and still REQUIRED for a status-change rule,
  -- which is the one type that cannot work without it.
  if v_filter ? 'status_equals' then
    if jsonb_typeof(v_filter -> 'status_equals') <> 'string' then
      raise exception 'audience_filter_status_not_string' using errcode = '22023';
    end if;
    v_status := v_filter ->> 'status_equals';
    if not (v_status = any (c_statuses)) then
      raise exception 'audience_filter_status_not_allowed' using errcode = '22023';
    end if;
    v_out := v_out || jsonb_build_object('status_equals', v_status);
  elsif p_trigger_type = 'contact_status_changed' then
    raise exception 'audience_filter_status_required' using errcode = '22023';
  end if;

  if v_filter ? 'tags_any' then
    if jsonb_typeof(v_filter -> 'tags_any') <> 'array' then
      raise exception 'audience_filter_tags_not_array' using errcode = '22023';
    end if;
    if jsonb_array_length(v_filter -> 'tags_any') > 20 then
      raise exception 'audience_filter_too_many_tags' using errcode = '22023';
    end if;
    -- Every element has to be a string. jsonb_array_elements_text renders
    -- an object as the text '{}' and a number as its digits, so without
    -- this check [{}] would be accepted as a tag literally named "{}".
    if exists (
      select 1 from jsonb_array_elements(v_filter -> 'tags_any') as element
       where jsonb_typeof(element) <> 'string'
    ) then
      raise exception 'audience_filter_tag_not_string' using errcode = '22023';
    end if;
    -- Trimmed, blanks dropped, de-duplicated without regard to case, and
    -- sorted. The stored form keeps the first spelling of each tag so the
    -- UI shows the agent what they typed.
    -- `with ordinality` is what makes "the first spelling" mean the first
    -- one the agent actually typed, rather than whichever sorts first.
    select coalesce(jsonb_agg(t order by t), '[]'::jsonb) into v_tags
      from (
        select distinct on (lower(btrim(value))) btrim(value) as t
          from jsonb_array_elements_text(v_filter -> 'tags_any') with ordinality as a(value, ord)
         where btrim(value) <> ''
         order by lower(btrim(value)), a.ord
      ) d;
    if exists (
      select 1 from jsonb_array_elements_text(v_tags) as t
       where char_length(t) > 50
    ) then
      raise exception 'audience_filter_tag_too_long' using errcode = '22023';
    end if;
    -- An empty result is stored as an absent key rather than an empty
    -- array, so "no filter" has exactly one representation.
    if jsonb_array_length(v_tags) > 0 then
      v_out := v_out || jsonb_build_object('tags_any', v_tags);
    end if;
  end if;

  return v_out;
end;
$fn$;

revoke all on function automation_internal.validate_audience_filter(text, jsonb)
  from public, anon;
grant execute on function automation_internal.validate_audience_filter(text, jsonb)
  to authenticated, service_role;

comment on function automation_internal.validate_audience_filter(text, jsonb) is
  'Phase 2E. The single definition of a valid audience_filter: status_equals (required for contact_status_changed) and tags_any. Returns the normalized filter - tags trimmed, de-duplicated case-insensitively, sorted, an empty list stored as no key - or raises 22023.';

-- The reachable form, for the activation path and the browser, matching
-- realtoros_validate_trigger_config: an answer rather than an exception.
create or replace function public.realtoros_validate_audience_filter(
  p_trigger_type text,
  p_filter jsonb
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $fn$
declare
  v_normalized jsonb;
begin
  begin
    v_normalized := automation_internal.validate_audience_filter(p_trigger_type, p_filter);
  exception when others then
    return jsonb_build_object('ok', false, 'code', SQLERRM);
  end;
  return jsonb_build_object('ok', true, 'filter', v_normalized);
end;
$fn$;

revoke all on function public.realtoros_validate_audience_filter(text, jsonb)
  from public, anon;
grant execute on function public.realtoros_validate_audience_filter(text, jsonb)
  to authenticated, service_role;

comment on function public.realtoros_validate_audience_filter(text, jsonb) is
  'Phase 2E. Reachable form of automation_internal.validate_audience_filter. Returns {ok:true, filter:<normalized>} or {ok:false, code:<validator code>}; reads no table and writes nothing.';

-- Drafts and activations both validate on write, so an audience that could
-- never match cannot be stored. Normalizes in place.
create or replace function automation_internal.validate_rule_audience_filter()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $fn$
begin
  NEW.audience_filter :=
    automation_internal.validate_audience_filter(NEW.trigger_type, NEW.audience_filter);
  return NEW;
end;
$fn$;

revoke all on function automation_internal.validate_rule_audience_filter()
  from public, anon, authenticated;

drop trigger if exists automation_rules_validate_audience_filter on public.automation_rules;
create trigger automation_rules_validate_audience_filter
  before insert or update of trigger_type, audience_filter on public.automation_rules
  for each row execute function automation_internal.validate_rule_audience_filter();

-- ============================================================
-- 3. UTC BELONGS IN THE PICKER
--
-- realtoros_timezone_names filtered out everything without a '/', which
-- quietly excluded UTC itself - the very value the backfill writes. So a
-- workspace on UTC could not see its own setting in the list.
-- ============================================================
create or replace function public.realtoros_timezone_names()
returns setof text
language sql
stable
set search_path = ''
as $fn$
  -- UTC first, because it is the default and the one people look for. The
  -- explicit sort key is load-bearing: `order by 1` on a UNION sorts the
  -- combined result, which would file UTC under U.
  select z.name from (
    select 0 as rank, 'UTC'::text as name
    union all
    select 1, tz.name from pg_timezone_names tz
     where tz.name not like 'posix/%'
       and tz.name not like 'Etc/%'
       and tz.name like '%/%'
       and tz.name <> 'UTC'
  ) z
  order by z.rank, z.name;
$fn$;

revoke all on function public.realtoros_timezone_names() from public, anon;
grant execute on function public.realtoros_timezone_names() to authenticated, service_role;

comment on function public.realtoros_timezone_names() is
  'Phase 2E. The IANA zone names the settings screen offers, straight from pg_timezone_names, with UTC included - it is the default the backfill writes, so leaving it out meant a workspace could not see its own setting.';

-- ============================================================
-- 4. Verify.
--
-- NO VARIABLES, deliberately. See the note at the top of this file: the
-- `select count(*) into v_n` in the 2C and 2D verify blocks is what makes
-- their wrappers fail on a second run.
-- ============================================================
do $verify$
begin
  -- ---- the audience test lives in the shared helper ----
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'automation_internal' and p.proname = 'rule_targets_contact'
       and p.prosrc like '%tags_any%'
  ) then
    raise exception '2E: rule_targets_contact does not apply tags_any';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'automation_internal' and p.proname = 'rule_targets_contact'
       and has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ) then
    raise exception '2E: rule_targets_contact is reachable from the browser';
  end if;

  -- Every matching path must go through it, so none of them needs its own
  -- copy of the tag rule.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('realtoros_rules_for_event', 'realtoros_scan_time_triggers')
       and p.prosrc not like '%rule_targets_contact%'
  ) then
    raise exception '2E: a matching path does not use the shared helper';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('realtoros_rules_for_event', 'realtoros_scan_time_triggers')
       and p.prosrc like '%tags_any%'
  ) then
    raise exception '2E: a matching path carries its own copy of the tag rule';
  end if;

  -- ---- the validator ----
  if automation_internal.validate_audience_filter('no_contact',
       '{"tags_any": ["  past client ", "PAST CLIENT", "Open House", ""]}'::jsonb)
     <> '{"tags_any": ["Open House", "past client"]}'::jsonb then
    raise exception '2E: tags are not trimmed, de-duplicated and sorted as expected';
  end if;
  if automation_internal.validate_audience_filter('no_contact', '{"tags_any": []}'::jsonb)
     <> '{}'::jsonb then
    raise exception '2E: an empty tag list should be stored as no filter at all';
  end if;
  if automation_internal.validate_audience_filter('contact_created', '{}'::jsonb)
     <> '{}'::jsonb then
    raise exception '2E: an empty audience filter should stay empty';
  end if;

  -- status_equals keeps its old contract, including being required for the
  -- one trigger type that cannot work without it.
  if automation_internal.validate_audience_filter('contact_status_changed',
       '{"status_equals": "Qualified"}'::jsonb)
     <> '{"status_equals": "Qualified"}'::jsonb then
    raise exception '2E: status_equals was not preserved';
  end if;
  begin
    perform automation_internal.validate_audience_filter('contact_status_changed', '{}'::jsonb);
    raise exception '2E: a status-change rule was allowed with no status';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform automation_internal.validate_audience_filter('no_contact', '{"nope": 1}'::jsonb);
    raise exception '2E: an unknown audience key was accepted';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform automation_internal.validate_audience_filter('no_contact', '{"tags_any": "Past client"}'::jsonb);
    raise exception '2E: a tag list that is not a list was accepted';
  exception when sqlstate '22023' then null;
  end;

  -- ---- the reachable wrapper answers rather than raising ----
  if (public.realtoros_validate_audience_filter('no_contact', '{"nope": 1}'::jsonb) ->> 'ok') <> 'false' then
    raise exception '2E: realtoros_validate_audience_filter did not reject an unknown key';
  end if;
  if (public.realtoros_validate_audience_filter('no_contact', '{"tags_any": ["Past client"]}'::jsonb) ->> 'ok') <> 'true' then
    raise exception '2E: realtoros_validate_audience_filter rejected a valid filter';
  end if;

  -- ---- the trigger normalizes a draft on write ----
  if not exists (
    select 1 from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'automation_rules'
       and t.tgname = 'automation_rules_validate_audience_filter'
       and not t.tgisinternal
  ) then
    raise exception '2E: the audience filter is not validated on write';
  end if;

  -- ---- UTC is offered ----
  if (select z from public.realtoros_timezone_names() as z limit 1) <> 'UTC' then
    raise exception '2E: UTC is not the first entry in the time zone list';
  end if;
  if not exists (select 1 from public.realtoros_timezone_names() as z where z = 'Asia/Dubai') then
    raise exception '2E: the time zone list lost its real zones';
  end if;

  -- ---- no existing rule was left with an audience it cannot keep ----
  -- The trigger above only fires on write, so anything already stored is
  -- checked here instead: a rule whose filter would now be rejected would
  -- be a rule nobody could edit.
  if exists (
    select 1 from public.automation_rules r
     where (select count(*) from jsonb_object_keys(r.audience_filter) as k
             where k not in ('status_equals', 'tags_any')) > 0
  ) then
    raise exception '2E: an existing rule carries an audience key the validator would reject';
  end if;

  raise notice '2E: tags_any is decided in rule_targets_contact, audience filters are validated, and UTC is in the picker.';
end $verify$;
