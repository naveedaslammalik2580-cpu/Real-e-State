-- Phase 2F: an audience can say Buyer, or Cold, not only a tag.
--
-- Phase 2E gave audience_filter one list, tags_any, and three of the five
-- starter packs had to apologise for it in prose: "New buyer lead" applied
-- to every new contact and carried a note telling the agent to tag their
-- buyers "Buyer" and tick it. The contact already says Buyer - it is the
-- `type` column, filled in on the Add Contact form - and it already says
-- Cold, in `temperature`. The audience could not read either.
--
-- So audience_filter gains type_in and temperature_in: lists, matched
-- case-insensitively, exactly like tags_any, and decided in exactly the
-- same place.
--
-- WHERE IT IS DECIDED
--
-- In automation_internal.rule_targets_contact, the single answer to "may
-- this rule act on this contact" that every trigger type already goes
-- through. Phase 2E put tags_any there for that reason; the two new lists
-- go to the same place, so the two contact events, the three timers and
-- the two yearly ones honour them without any caller knowing they exist.
--
-- AND IT IS DECIDED ONCE, LITERALLY
--
-- The three lists ask the identical question - "does any value the contact
-- has match any value the filter wants, ignoring case and surrounding
-- space" - so the question is now written once, in
-- automation_internal.audience_list_matches, and asked three times:
--
--   tags_any        against the contact's tags
--   type_in         against the contact's type
--   temperature_in  against the contact's temperature
--
-- A tag list is many values and a type is one, which is the only
-- difference, and `array[c.type]` is the whole of it. Writing the jsonb
-- dance out three times would have been three places for the empty-list
-- rule to drift.
--
-- THE EMPTY-LIST RULE, AGAIN
--
-- An absent or empty list means NO FILTER, never "match nobody". An empty
-- list is how a UI reports "none ticked", and a rule that silently matched
-- nobody would read as broken. Normalization in the validator stores an
-- empty list as an absent key, so there is one representation either way.
--
-- NO NEW INDEX, DELIBERATELY. tags_any got a GIN index in 2E because a tag
-- list is open-ended. type and temperature hold a handful of distinct
-- values each across a workspace, so an index on them would be read past
-- on every scan and paid for on every contact write.
--
-- SORTING IS COLLATION-PINNED. Every audience list is stored sorted, and
-- "sorted" has to mean the same thing on live Supabase (en_US.UTF-8), in
-- PGlite (which sorts like "C") and in the browser's own copy of the
-- normalization (JavaScript, which compares code units). So the sorts say
-- COLLATE "C" explicitly. The first cut of this file did not, and its
-- verify block failed on live with "2F: type_in is not trimmed,
-- de-duplicated and sorted as expected" - the only reason nothing was
-- applied is that the whole wrapper runs in one transaction.
--
-- RE-RUNNING THIS. Everything is create-or-replace or guarded, and the
-- verify block at the end declares NO VARIABLES - see the note in the 2E
-- migration about `select ... into v_n` outside PL/pgSQL being CREATE
-- TABLE. Applying this file twice is part of the test suite.

-- ============================================================
-- 1. ONE LIST TEST, ASKED THREE TIMES
--
-- Immutable and pure: it reads no table, only the filter it is handed and
-- the values it is handed. A NULL in p_values simply does not match, which
-- is what a contact with no temperature set should do when a rule asks for
-- a temperature.
-- ============================================================
create or replace function automation_internal.audience_list_matches(
  p_filter jsonb,
  p_key text,
  p_values text[]
)
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  select
    -- No filter at all, in any of the three ways it can be absent.
    not (coalesce(p_filter, '{}'::jsonb) ? p_key)
    or jsonb_typeof(p_filter -> p_key) <> 'array'
    or jsonb_array_length(p_filter -> p_key) = 0
    -- Otherwise: any one of the contact's values matching any one of the
    -- wanted values, ignoring case and surrounding space, because these
    -- are typed by people.
    or exists (
         select 1
           from unnest(coalesce(p_values, '{}'::text[])) as have(v)
           join jsonb_array_elements_text(p_filter -> p_key) as wanted(w)
             on lower(btrim(w)) = lower(btrim(have.v))
       );
$fn$;

revoke all on function automation_internal.audience_list_matches(jsonb, text, text[])
  from public, anon, authenticated;
grant execute on function automation_internal.audience_list_matches(jsonb, text, text[])
  to service_role;

comment on function automation_internal.audience_list_matches(jsonb, text, text[]) is
  'Phase 2F. The one definition of an audience list test: an absent, non-array or empty list means no filter; otherwise any of the contact''s values matching any wanted value, case- and space-insensitively. Used by rule_targets_contact for tags_any, type_in and temperature_in.';

-- ============================================================
-- 2. THE AUDIENCE TEST, WITH TYPE AND TEMPERATURE
--
-- Same function, same single place, one more line per list.
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
       -- And whether they are in the audience the rule asked for. All
       -- three lists are ANDed: a rule wanting Buyers tagged "Open house"
       -- means both, which is what two separate controls read as.
       and automation_internal.audience_list_matches(
             r.audience_filter, 'tags_any', coalesce(c.tags, '{}'::text[]))
       and automation_internal.audience_list_matches(
             r.audience_filter, 'type_in', array[c.type])
       and automation_internal.audience_list_matches(
             r.audience_filter, 'temperature_in', array[c.temperature])
  );
$fn$;

revoke all on function automation_internal.rule_targets_contact(uuid, text)
  from public, anon, authenticated;
grant execute on function automation_internal.rule_targets_contact(uuid, text)
  to service_role;

comment on function automation_internal.rule_targets_contact(uuid, text) is
  'Phase 2F. The single definition of whether a rule may act on a contact: visibility (shared sees the workspace, personal only its creator''s own) AND every audience list it carries - tags_any, type_in and temperature_in - each matched case-insensitively with an absent or empty list meaning no filter. Used by realtoros_rules_for_event and both scans, so the rule exists once. status_equals is NOT here: for a status-change event it tests the status the event carries, which is a different question.';

-- ============================================================
-- 3. VALIDATING THE TWO NEW LISTS
--
-- The normalization the three lists share - trim, drop blanks,
-- de-duplicate case-insensitively keeping the first spelling, sort - is
-- now written once too, and raises a code naming the key that was wrong.
--
-- NOTE ON THE CODES. The three tags_any codes are now spelled after the
-- key, so audience_filter_tags_not_array reads
-- audience_filter_tags_any_not_array and so on, with the same meaning.
-- Nothing in the app or the Edge Functions matched those strings; they are
-- surfaced only through realtoros_validate_audience_filter, which returns
-- whichever code the validator raised.
--
-- The VALUES are deliberately not checked against a list. A workspace's
-- contact types and temperatures are the app's own vocabulary, not a
-- database enum (public.contacts.type and .temperature are plain text),
-- and a validator that knew better than the data would reject a workspace
-- that renamed "Investor".
-- ============================================================
create or replace function automation_internal.normalize_audience_list(
  p_key text,
  p_value jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $fn$
declare
  v_out jsonb;
begin
  if jsonb_typeof(p_value) <> 'array' then
    raise exception 'audience_filter_%_not_array', p_key using errcode = '22023';
  end if;
  if jsonb_array_length(p_value) > 20 then
    raise exception 'audience_filter_%_too_many', p_key using errcode = '22023';
  end if;
  -- Every element has to be a string. jsonb_array_elements_text renders an
  -- object as the text '{}' and a number as its digits, so without this
  -- check [{}] would be accepted as a value literally named "{}".
  if exists (
    select 1 from jsonb_array_elements(p_value) as element
     where jsonb_typeof(element) <> 'string'
  ) then
    raise exception 'audience_filter_%_not_strings', p_key using errcode = '22023';
  end if;
  -- `with ordinality` is what makes "the first spelling" mean the first
  -- one the agent actually typed, rather than whichever sorts first.
  --
  -- COLLATE "C" ON EVERY SORT, and it is load-bearing. Without it the
  -- order is the database's own collation, which is not the same
  -- database to database: live Supabase runs en_US.UTF-8, where
  -- ['Investor', 'buyer'] sorts as {buyer, Investor}, and PGlite sorts
  -- like "C", where it is {Investor, buyer}. A stored audience that
  -- depends on the server's locale is a stored value that two
  -- environments disagree about - the browser's own normalizer in
  -- data-service.js sorts with JavaScript's Array#sort, which compares
  -- code units and so IS "C", and the verify block below asserts exact
  -- values. "C" is the one order all three can agree on.
  --
  -- It is only the ORDER that needs this. Equality and lower() are
  -- unaffected: these are deterministic collations, so "Buyer" = "Buyer"
  -- whatever the locale, which is all the matcher asks.
  select coalesce(jsonb_agg(t order by t collate "C"), '[]'::jsonb) into v_out
    from (
      -- The DISTINCT ON expression carries the collation too: Postgres
      -- requires it to match the leading ORDER BY expression exactly,
      -- and "exactly" includes the COLLATE.
      select distinct on (lower(btrim(value)) collate "C") btrim(value) as t
        from jsonb_array_elements_text(p_value) with ordinality as a(value, ord)
       where btrim(value) <> ''
       order by lower(btrim(value)) collate "C", a.ord
    ) d;
  if exists (
    select 1 from jsonb_array_elements_text(v_out) as t
     where char_length(t) > 50
  ) then
    raise exception 'audience_filter_%_too_long', p_key using errcode = '22023';
  end if;
  return v_out;
end;
$fn$;

revoke all on function automation_internal.normalize_audience_list(text, jsonb)
  from public, anon;
grant execute on function automation_internal.normalize_audience_list(text, jsonb)
  to authenticated, service_role;

comment on function automation_internal.normalize_audience_list(text, jsonb) is
  'Phase 2F. The one definition of a valid audience list: at most 20 strings of at most 50 characters, trimmed, blanks dropped, de-duplicated case-insensitively keeping the first spelling, sorted. Raises 22023 with a code naming the key.';

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
  v_list jsonb;
  c_statuses constant text[] := array[
    'New Lead', 'Qualified', 'Nurturing', 'Client', 'Past Client', 'Lost'];
  c_lists constant text[] := array['tags_any', 'type_in', 'temperature_in'];
begin
  if jsonb_typeof(v_filter) <> 'object' then
    raise exception 'audience_filter_not_object' using errcode = '22023';
  end if;

  for v_key in select jsonb_object_keys(v_filter) loop
    if v_key <> 'status_equals' and not (v_key = any (c_lists)) then
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

  -- The three lists, same rules, in the order they are declared, so the
  -- stored object is stable whatever order the keys arrived in.
  foreach v_key in array c_lists loop
    if v_filter ? v_key then
      v_list := automation_internal.normalize_audience_list(v_key, v_filter -> v_key);
      -- An empty result is stored as an absent key rather than an empty
      -- array, so "no filter" has exactly one representation.
      if jsonb_array_length(v_list) > 0 then
        v_out := v_out || jsonb_build_object(v_key, v_list);
      end if;
    end if;
  end loop;

  return v_out;
end;
$fn$;

revoke all on function automation_internal.validate_audience_filter(text, jsonb)
  from public, anon;
grant execute on function automation_internal.validate_audience_filter(text, jsonb)
  to authenticated, service_role;

comment on function automation_internal.validate_audience_filter(text, jsonb) is
  'Phase 2F. The single definition of a valid audience_filter: status_equals (required for contact_status_changed) and the three lists tags_any, type_in and temperature_in. Returns the normalized filter - values trimmed, de-duplicated case-insensitively, sorted, an empty list stored as no key - or raises 22023.';

-- ============================================================
-- 4. Verify.
--
-- NO VARIABLES, deliberately. See the note at the top of this file.
-- ============================================================
do $verify$
begin
  -- ---- all three lists are decided in the one shared helper ----
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'automation_internal' and p.proname = 'rule_targets_contact'
       -- strpos, not LIKE: '_' is a LIKE wildcard, so '%type_in%' also
       -- matches the 'trigger_type in (...)' that every one of these
       -- functions contains, and the check would pass without the feature.
       and strpos(p.prosrc, 'tags_any') > 0
       and strpos(p.prosrc, 'type_in') > 0
       and strpos(p.prosrc, 'temperature_in') > 0
       and strpos(p.prosrc, 'audience_list_matches') > 0
  ) then
    raise exception '2F: rule_targets_contact does not apply all three audience lists';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'automation_internal'
       and p.proname in ('rule_targets_contact', 'audience_list_matches')
       and has_function_privilege('authenticated', p.oid, 'EXECUTE')
  ) then
    raise exception '2F: the matcher is reachable from the browser';
  end if;

  -- Every matching path must still go through it, so none of them needs
  -- its own copy of any of the three rules.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('realtoros_rules_for_event', 'realtoros_scan_time_triggers')
       and strpos(p.prosrc, 'rule_targets_contact') = 0
  ) then
    raise exception '2F: a matching path does not use the shared helper';
  end if;
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('realtoros_rules_for_event', 'realtoros_scan_time_triggers')
       and (strpos(p.prosrc, 'tags_any') > 0 or strpos(p.prosrc, 'type_in') > 0
            or strpos(p.prosrc, 'temperature_in') > 0)
  ) then
    raise exception '2F: a matching path carries its own copy of an audience rule';
  end if;

  -- ---- the validator ----
  --
  -- These expectations are in COLLATE "C" order - upper case before lower
  -- case - because that is what the normalizer now pins. Under the
  -- server's own en_US.UTF-8 the same input would come back as
  -- ["buyer", "Investor"], which is exactly the failure this block caught
  -- on live. The literals below are built with the same collation rather
  -- than typed from memory, so the two cannot drift apart again.
  if automation_internal.validate_audience_filter('contact_created',
       '{"type_in": ["  buyer ", "BUYER", "Investor", ""]}'::jsonb)
     <> jsonb_build_object('type_in',
          (select jsonb_agg(v order by v collate "C")
             from (values ('Investor'::text), ('buyer'::text)) as e(v))) then
    raise exception '2F: type_in is not trimmed, de-duplicated and sorted as expected';
  end if;
  -- Mixed case across several values, which is where a locale sort and a
  -- "C" sort visibly disagree: "C" gives {Alpha, Bravo, beta, zulu},
  -- en_US.UTF-8 gives {Alpha, beta, Bravo, zulu}.
  if automation_internal.validate_audience_filter('contact_created',
       '{"tags_any": ["zulu", "Alpha", "beta", "Bravo"]}'::jsonb)
     <> '{"tags_any": ["Alpha", "Bravo", "beta", "zulu"]}'::jsonb then
    raise exception '2F: audience lists are not sorted in a collation-independent order';
  end if;
  if automation_internal.validate_audience_filter('no_contact',
       '{"temperature_in": ["Cold"], "tags_any": ["VIP"], "type_in": ["Seller"]}'::jsonb)
     <> '{"tags_any": ["VIP"], "type_in": ["Seller"], "temperature_in": ["Cold"]}'::jsonb then
    raise exception '2F: the three lists do not survive together';
  end if;
  if automation_internal.validate_audience_filter('no_contact',
       '{"type_in": [], "temperature_in": ["   "]}'::jsonb) <> '{}'::jsonb then
    raise exception '2F: an empty list should be stored as no filter at all';
  end if;
  begin
    perform automation_internal.validate_audience_filter('no_contact', '{"type_in": "Buyer"}'::jsonb);
    raise exception '2F: a type list that is not a list was accepted';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform automation_internal.validate_audience_filter('no_contact', '{"temperature_in": [1]}'::jsonb);
    raise exception '2F: a temperature that is not a string was accepted';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform automation_internal.validate_audience_filter('no_contact', '{"nope": 1}'::jsonb);
    raise exception '2F: an unknown audience key was accepted';
  exception when sqlstate '22023' then null;
  end;

  -- ---- what Phase 2E promised still holds ----
  if automation_internal.validate_audience_filter('contact_status_changed',
       '{"status_equals": "Qualified"}'::jsonb)
     <> '{"status_equals": "Qualified"}'::jsonb then
    raise exception '2F: status_equals was not preserved';
  end if;
  begin
    perform automation_internal.validate_audience_filter('contact_status_changed', '{}'::jsonb);
    raise exception '2F: a status-change rule was allowed with no status';
  exception when sqlstate '22023' then null;
  end;
  if (public.realtoros_validate_audience_filter('contact_created',
        '{"type_in": ["Buyer"]}'::jsonb) ->> 'ok') <> 'true' then
    raise exception '2F: realtoros_validate_audience_filter rejected a valid type audience';
  end if;

  -- The pin itself, not just its effect: on PGlite the default collation
  -- already sorts like "C", so a future edit that dropped the COLLATE
  -- would pass every behavioural check here and fail again on live.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'automation_internal' and p.proname = 'normalize_audience_list'
       and strpos(p.prosrc, 'collate "C"') > 0
  ) then
    raise exception '2F: normalize_audience_list does not pin its sort collation';
  end if;

  -- ---- the trigger still normalizes a draft on write ----
  if not exists (
    select 1 from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'automation_rules'
       and t.tgname = 'automation_rules_validate_audience_filter'
       and not t.tgisinternal
  ) then
    raise exception '2F: the audience filter is not validated on write';
  end if;

  -- ---- no existing rule was left with an audience it cannot keep ----
  if exists (
    select 1 from public.automation_rules r
     where (select count(*) from jsonb_object_keys(r.audience_filter) as k
             where k not in ('status_equals', 'tags_any', 'type_in', 'temperature_in')) > 0
  ) then
    raise exception '2F: an existing rule carries an audience key the validator would reject';
  end if;

  raise notice '2F: type_in and temperature_in are decided in rule_targets_contact, alongside tags_any, and validated on write.';
end $verify$;
