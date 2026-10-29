-- REVERT for Phase 2F (audience by contact type and temperature).
--
-- NOT a migration. Lives in supabase/rollback/ and is never applied as part
-- of the chain. Run it only to undo
-- 20261015160000_phase_2f_audience_type_temp.sql.
--
-- WHAT IT REMOVES
--
--   * audience_filter.type_in and .temperature_in from every stored rule
--   * the two new helpers, automation_internal.audience_list_matches and
--     automation_internal.normalize_audience_list
--   * the type and temperature tests from
--     automation_internal.rule_targets_contact and
--     automation_internal.validate_audience_filter, both of which go back
--     to the Phase 2E definitions verbatim - tags_any keeps working
--
-- ORDER MATTERS. The stored filters are stripped FIRST, while the 2F
-- validator that still understands those keys is the one on the write
-- path; only then are the Phase 2E functions put back. Reversing that
-- order would make every UPDATE below fail with
-- audience_filter_unknown_key_type_in.
--
-- WHAT RUNNING THIS MEANS
--
--   * Any rule that targeted buyers, or cold contacts, silently widens to
--     everybody its other filters still allow. That is the dangerous part:
--     a "New buyer lead" sequence would start welcoming sellers. So the
--     values are MOVED to metadata.phase_2f_reverted_type_in /
--     .phase_2f_reverted_temperature_in rather than thrown away, and any
--     rule that had one is PAUSED - an agent can read what it used to mean
--     and decide, instead of discovering it by way of the sent mail. This
--     is exactly what the 2E revert does for tags_any.
--   * A rule that only ever used tags_any is untouched.
--
-- Only run this if Phase 2F itself is causing a worse problem.

set search_path = public;

begin;

-- ============================================================
-- 1. Park every type / temperature audience somewhere an agent can find
--    it, and pause those rules rather than letting them quietly widen.
--
-- Done while the 2F validator is still in place, so these writes pass.
-- ============================================================
update public.automation_rules
   set metadata = metadata
         || case when audience_filter ? 'type_in'
                 then jsonb_build_object('phase_2f_reverted_type_in',
                                         audience_filter -> 'type_in')
                 else '{}'::jsonb end
         || case when audience_filter ? 'temperature_in'
                 then jsonb_build_object('phase_2f_reverted_temperature_in',
                                         audience_filter -> 'temperature_in')
                 else '{}'::jsonb end,
       audience_filter = (audience_filter - 'type_in') - 'temperature_in',
       status = case when status = 'active' then 'paused' else status end,
       paused_at = case when status = 'active' then now() else paused_at end
 where audience_filter ? 'type_in'
    or audience_filter ? 'temperature_in';

-- ============================================================
-- 2. The audience validator, back to the Phase 2E definition.
--
-- Copied verbatim from
-- supabase/migrations/20261015150000_phase_2e_audience_tags.sql so that
-- md5(pg_proc.prosrc) matches the pre-2F chain exactly. Do not reformat:
-- tests/sql/rollback_files.test.mjs compares body hashes.
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

-- ============================================================
-- 3. The shared matcher, back to the Phase 2E definition.
--
-- Also copied verbatim from the 2E migration, for the same reason.
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

-- ============================================================
-- 4. The two helpers nothing references any more.
-- ============================================================
drop function if exists automation_internal.normalize_audience_list(text, jsonb);
drop function if exists automation_internal.audience_list_matches(jsonb, text, text[]);

-- ============================================================
-- 5. Verify. No variables, for the reason given in the 2E migration.
-- ============================================================
do $verify$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'automation_internal'
       and p.proname in ('audience_list_matches', 'normalize_audience_list')
  ) then
    raise exception '2F revert: a Phase 2F helper still exists';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'automation_internal'
       and p.proname in ('rule_targets_contact', 'validate_audience_filter')
       -- strpos, not LIKE: '_' is a LIKE wildcard and would match
       -- 'trigger_type in (...)' as well.
       and (strpos(p.prosrc, 'type_in') > 0 or strpos(p.prosrc, 'temperature_in') > 0)
  ) then
    raise exception '2F revert: type_in or temperature_in is still understood';
  end if;

  -- tags_any is Phase 2E and must survive this revert untouched.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'automation_internal' and p.proname = 'rule_targets_contact'
       and strpos(p.prosrc, 'tags_any') > 0
  ) then
    raise exception '2F revert: the tag audience was lost as well';
  end if;

  if exists (
    select 1 from public.automation_rules
     where audience_filter ? 'type_in' or audience_filter ? 'temperature_in'
  ) then
    raise exception '2F revert: a rule still carries a type or temperature audience';
  end if;

  raise notice '2F reverted: type and temperature audiences are parked in metadata, those rules are paused, and tags_any still works.';
end $verify$;

commit;
