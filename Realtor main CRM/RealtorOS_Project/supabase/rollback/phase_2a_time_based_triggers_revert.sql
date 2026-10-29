-- REVERT for Phase 2A (time-based and deal-based automation triggers).
--
-- NOT a migration. Lives in supabase/rollback/ and is never applied as
-- part of the chain. Run it only to undo
-- 20261015120000_phase_2a_time_based_triggers.sql.
--
-- WHAT IT REMOVES
--
--   * public.realtoros_scan_time_triggers and public.automation_scan_state
--   * the four new trigger types, back to the pre-2A CHECK on
--     automation_rules.trigger_type and automation_trigger_events.event_type
--   * automation_rules.trigger_config, its CHECK, its validating trigger
--     and both validator functions
--   * automation_trigger_events.rule_id and .event_key, their foreign key,
--     their indexes and the shape CHECK
--   * contacts.status_changed_at, its trigger, its function and its
--     indexes, and automation_internal.protect_contact_lifecycle_columns
--     goes back to the Phase 4E.2 definition, verbatim
--   * both deals stage-change triggers and their function
--
-- ORDER MATTERS. The CHECKs are narrowed only AFTER the rows that would
-- violate them are gone, and each function is dropped only after the
-- trigger that references it.
--
-- WHAT RUNNING THIS MEANS
--
-- Any rule using one of the four new trigger types would violate the
-- restored CHECK. Such rules are ARCHIVED rather than deleted - archiving
-- is this system's existing state for a rule that has stopped for good,
-- and it keeps every enrollment, job and message the rule ever produced -
-- and their trigger_type is rewritten to 'manual', the one pre-2A type
-- that starts nothing by itself. The original value is kept in
-- metadata.phase_2a_reverted_from_trigger_type so nothing is lost.
--
-- Pending detected occurrences of those types are deleted: an occurrence
-- of a trigger type that no longer exists can never be processed.
-- Enrollments already created, and mail already sent, are untouched.
--
-- If archiving those rules is not acceptable, stop and deal with them by
-- hand first. The verify block at the end refuses to finish if anything is
-- left over.
--
-- Only run this if Phase 2A itself is causing a worse problem.

set search_path = public;

begin;

-- ============================================================
-- 1. Stop the detector, and remove its bookkeeping.
-- ============================================================
drop function if exists public.realtoros_scan_time_triggers(timestamptz, integer);
drop table if exists public.automation_scan_state;

-- ============================================================
-- 2. The deal stage event.
-- ============================================================
drop trigger if exists deals_automation_stage_changed_trigger on public.deals;
drop trigger if exists deals_automation_stage_inserted_trigger on public.deals;
drop function if exists automation_internal.deal_stage_changed_event();

-- ============================================================
-- 3. Retire the rules and occurrences the pre-2A CHECKs forbid.
-- ============================================================
update public.automation_rules
   set status = 'archived',
       archived_at = coalesce(archived_at, now())
 where trigger_type in ('follow_up_due', 'no_contact', 'status_stale', 'deal_stage_changed')
   and status <> 'archived';

update public.automation_rules
   set metadata = metadata || jsonb_build_object(
         'phase_2a_reverted_from_trigger_type', trigger_type),
       trigger_type = 'manual',
       trigger_config = '{}'::jsonb
 where trigger_type in ('follow_up_due', 'no_contact', 'status_stale', 'deal_stage_changed');

delete from public.automation_trigger_events
 where event_type in ('follow_up_due', 'no_contact', 'status_stale', 'deal_stage_changed');

-- ============================================================
-- 4. automation_trigger_events back to its pre-2A shape.
-- ============================================================
alter table public.automation_trigger_events
  drop constraint if exists automation_trigger_events_rule_shape_check;
alter table public.automation_trigger_events
  drop constraint if exists automation_trigger_events_workspace_id_rule_id_fkey;
drop index if exists public.automation_trigger_events_event_key_uq;
drop index if exists public.automation_trigger_events_rule_idx;
alter table public.automation_trigger_events
  drop column if exists rule_id,
  drop column if exists event_key;

alter table public.automation_trigger_events
  drop constraint if exists automation_trigger_events_event_type_check;
alter table public.automation_trigger_events
  add constraint automation_trigger_events_event_type_check
  check (event_type in ('contact_created', 'contact_status_changed'));

-- ============================================================
-- 5. automation_rules back to its pre-2A shape.
-- ============================================================
drop trigger if exists automation_rules_validate_trigger_config on public.automation_rules;
drop function if exists automation_internal.validate_rule_trigger_config();
-- The public wrapper first: it calls the internal validator.
drop function if exists public.realtoros_validate_trigger_config(text, jsonb);
drop function if exists automation_internal.validate_trigger_config(text, jsonb);

alter table public.automation_rules
  drop constraint if exists automation_rules_trigger_config_check;
alter table public.automation_rules
  drop column if exists trigger_config;

alter table public.automation_rules
  drop constraint if exists automation_rules_trigger_type_check;
alter table public.automation_rules
  add constraint automation_rules_trigger_type_check
  check (trigger_type in ('new_lead', 'contact_created', 'contact_status_changed', 'manual'));

-- ============================================================
-- 6. contacts.status_changed_at, and the lifecycle guard it joined.
-- ============================================================
drop trigger if exists contacts_status_changed_at_trigger on public.contacts;
drop function if exists automation_internal.set_contact_status_changed_at();
drop index if exists public.contacts_ws_status_changed_idx;
drop index if exists public.contacts_ws_next_follow_up_idx;
drop index if exists public.contacts_ws_last_contact_idx;
alter table public.contacts
  drop column if exists status_changed_at;

-- The next statement is copied verbatim from
-- supabase/migrations/20260929041708_phase_4e_2_stop_logic_completion.sql
-- so that md5(pg_proc.prosrc) matches the pre-2A chain exactly. Do not
-- reformat: tests/sql/rollback_files.test.mjs compares body hashes.
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
    else
      NEW.reply_detected_at := OLD.reply_detected_at;
      NEW.unsubscribe_detected_at := OLD.unsubscribe_detected_at;
    end if;
  end if;
  return NEW;
end;
$function$;

revoke all on function automation_internal.protect_contact_lifecycle_columns() from public, anon, authenticated;

-- ============================================================
-- 7. Verify.
-- ============================================================
do $verify$
declare
  v_bad text := '';
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'automation_rules'
                and column_name = 'trigger_config') then
    v_bad := v_bad || E'
  automation_rules.trigger_config still exists';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'automation_trigger_events'
                and column_name in ('rule_id', 'event_key')) then
    v_bad := v_bad || E'
  automation_trigger_events still has rule_id/event_key';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'contacts'
                and column_name = 'status_changed_at') then
    v_bad := v_bad || E'
  contacts.status_changed_at still exists';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where (n.nspname = 'public' and p.proname in ('realtoros_scan_time_triggers',
                                                            'realtoros_validate_trigger_config'))
                 or (n.nspname = 'automation_internal'
                     and p.proname in ('validate_trigger_config',
                                       'validate_rule_trigger_config',
                                       'deal_stage_changed_event',
                                       'set_contact_status_changed_at'))) then
    v_bad := v_bad || E'
  a Phase 2A function still exists';
  end if;
  if exists (select 1 from pg_tables
              where schemaname = 'public' and tablename = 'automation_scan_state') then
    v_bad := v_bad || E'
  automation_scan_state still exists';
  end if;
  if exists (select 1 from public.automation_rules
              where trigger_type in ('follow_up_due', 'no_contact',
                                     'status_stale', 'deal_stage_changed')) then
    v_bad := v_bad || E'
  a rule still carries a Phase 2A trigger type';
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.automation_rules'::regclass
       and conname = 'automation_rules_trigger_type_check'
       and pg_get_constraintdef(oid) not like '%follow_up_due%') then
    v_bad := v_bad || E'
  the trigger_type check was not narrowed back';
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'automation_internal'
                and p.proname = 'protect_contact_lifecycle_columns'
                and p.prosrc like '%status_changed_at%') then
    v_bad := v_bad || E'
  the lifecycle guard still mentions status_changed_at';
  end if;

  if v_bad <> '' then
    raise exception 'Phase 2A revert incomplete:%', v_bad;
  end if;
  raise notice 'Phase 2A reverted: the four new trigger types, the scan and status_changed_at are gone.';
end $verify$;

commit;
