-- REVERT for Phase 2E (tag-aware audience, and UTC in the picker).
--
-- NOT a migration. Lives in supabase/rollback/ and is never applied as part
-- of the chain. Run it only to undo
-- 20261015150000_phase_2e_audience_tags.sql.
--
-- WHAT IT REMOVES
--
--   * audience_filter.tags_any from every stored rule, and the tag test
--     from automation_internal.rule_targets_contact, which goes back to the
--     Phase 2C definition verbatim
--   * automation_internal.validate_audience_filter,
--     public.realtoros_validate_audience_filter, and the trigger that
--     normalized a filter on write
--   * UTC from the time zone picker (back to the Phase 2D list)
--   * the tags index
--
-- ORDER MATTERS. The stored filters are stripped BEFORE the validating
-- trigger is dropped, so every rule is left in a shape the pre-2E code
-- understands, and the helper is restored before the thing it stops
-- needing goes.
--
-- WHAT RUNNING THIS MEANS
--
--   * Any rule that targeted an audience by tag silently widens to its
--     whole visibility scope. That is the dangerous part of this revert:
--     a "Stay in touch" rule aimed at past clients would start reaching
--     every quiet contact. The tags_any value is therefore MOVED to
--     metadata.phase_2e_reverted_tags_any rather than thrown away, and any
--     rule that had one is PAUSED - an agent can read what it used to mean
--     and decide, instead of discovering it by way of the sent mail.
--   * A workspace already set to UTC keeps working; UTC just stops
--     appearing in the picker, which is the Phase 2D defect.
--
-- Only run this if Phase 2E itself is causing a worse problem.

set search_path = public;

begin;

-- ============================================================
-- 1. Stop validating, so the rules below can be rewritten freely.
-- ============================================================
drop trigger if exists automation_rules_validate_audience_filter on public.automation_rules;

-- ============================================================
-- 2. Park every tag audience somewhere an agent can find it, and pause
--    those rules rather than letting them quietly widen.
-- ============================================================
update public.automation_rules
   set metadata = metadata || jsonb_build_object(
         'phase_2e_reverted_tags_any', audience_filter -> 'tags_any'),
       audience_filter = audience_filter - 'tags_any',
       status = case when status = 'active' then 'paused' else status end,
       paused_at = case when status = 'active' then now() else paused_at end
 where audience_filter ? 'tags_any';

-- ============================================================
-- 3. The validators go.
-- ============================================================
drop function if exists automation_internal.validate_rule_audience_filter();
drop function if exists public.realtoros_validate_audience_filter(text, jsonb);
drop function if exists automation_internal.validate_audience_filter(text, jsonb);

-- ============================================================
-- 4. The shared helper, back to the Phase 2C definition.
--
-- Copied verbatim from
-- supabase/migrations/20261015130000_phase_2c_response_tracking.sql so that
-- md5(pg_proc.prosrc) matches the pre-2E chain exactly. Do not reformat:
-- tests/sql/rollback_files.test.mjs compares body hashes.
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


-- ============================================================
-- 5. The time zone list, back to the Phase 2D definition (no UTC).
-- ============================================================
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


-- ============================================================
-- 6. The tags index.
-- ============================================================
drop index if exists public.contacts_ws_tags_idx;

-- ============================================================
-- 7. Verify. No variables, for the reason given in the 2E migration.
-- ============================================================
do $verify$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'automation_internal' and p.proname = 'rule_targets_contact'
       and p.prosrc like '%tags_any%'
  ) then
    raise exception '2E revert: rule_targets_contact still applies tags_any';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where (n.nspname = 'public' and p.proname = 'realtoros_validate_audience_filter')
        or (n.nspname = 'automation_internal'
            and p.proname in ('validate_audience_filter', 'validate_rule_audience_filter'))
  ) then
    raise exception '2E revert: an audience validator still exists';
  end if;

  if exists (
    select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
     where not t.tgisinternal and t.tgname = 'automation_rules_validate_audience_filter'
  ) then
    raise exception '2E revert: the audience filter is still validated on write';
  end if;

  if exists (select 1 from public.automation_rules where audience_filter ? 'tags_any') then
    raise exception '2E revert: a rule still carries a tag audience';
  end if;

  if exists (select 1 from public.realtoros_timezone_names() as z where z = 'UTC') then
    raise exception '2E revert: UTC is still in the time zone list';
  end if;

  if exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'contacts_ws_tags_idx'
  ) then
    raise exception '2E revert: the tags index still exists';
  end if;

  raise notice '2E reverted: tag audiences are parked in metadata, those rules are paused, and UTC is out of the picker again.';
end $verify$;

commit;
