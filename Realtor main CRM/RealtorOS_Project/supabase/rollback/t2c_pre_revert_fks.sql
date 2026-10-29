-- REVERT for Phase T2c-pre: put all 56 composite tenant foreign keys back
-- on (user_id, ...).
--
-- NOT a migration. Lives in supabase/rollback/ and is never applied as
-- part of the chain. Run it only to undo T2c-pre.
--
-- Generated from LIVE pg_constraint on project yanasorwmaybnabfuepn on
-- 2026-10-06, BEFORE T2c-pre was applied: every ADD CONSTRAINT below is
-- the exact pg_get_constraintdef() text of the constraint as it stood,
-- including the original constraint name (note
-- properties_deal_tenant_fkey, which does not follow the usual naming).
--
-- This works because T2c-pre leaves the (user_id, id) unique indexes on
-- every parent table in place; it only repoints the foreign keys. If
-- those indexes are ever dropped, this file stops working and the revert
-- has to recreate them first.
--
-- Running it will FAIL if, by then, any child row references a parent row
-- created by a different user - which is exactly what T2c-pre makes
-- possible. That failure is correct and informative: it means the team
-- has created genuinely cross-member references, and reverting would
-- have to decide what to do with them. Do not force it.

set search_path = public;

begin;

alter table public.activities drop constraint if exists activities_workspace_id_contact_id_fkey;
alter table public.activities add constraint activities_user_id_contact_id_fkey
  foreign key (user_id, contact_id) references contacts(user_id, id) on delete set null (contact_id);

alter table public.activities drop constraint if exists activities_workspace_id_deal_id_fkey;
alter table public.activities add constraint activities_user_id_deal_id_fkey
  foreign key (user_id, deal_id) references deals(user_id, id) on delete set null (deal_id);

alter table public.activities drop constraint if exists activities_workspace_id_property_id_fkey;
alter table public.activities add constraint activities_user_id_property_id_fkey
  foreign key (user_id, property_id) references properties(user_id, id) on delete set null (property_id);

alter table public.activities drop constraint if exists activities_workspace_id_task_id_fkey;
alter table public.activities add constraint activities_user_id_task_id_fkey
  foreign key (user_id, task_id) references tasks(user_id, id) on delete set null (task_id);

alter table public.automation_enrollments drop constraint if exists automation_enrollments_workspace_id_contact_id_fkey;
alter table public.automation_enrollments add constraint automation_enrollments_user_id_contact_id_fkey
  foreign key (user_id, contact_id) references contacts(user_id, id) on delete cascade;

alter table public.automation_enrollments drop constraint if exists automation_enrollments_workspace_id_rule_id_fkey;
alter table public.automation_enrollments add constraint automation_enrollments_user_id_rule_id_fkey
  foreign key (user_id, rule_id) references automation_rules(user_id, id) on delete cascade;

alter table public.automation_enrollments drop constraint if exists automation_enrollments_workspace_id_source_batch_id_fkey;
alter table public.automation_enrollments add constraint automation_enrollments_user_id_source_batch_id_fkey
  foreign key (user_id, source_batch_id) references lead_import_batches(user_id, id) on delete set null (source_batch_id);

alter table public.automation_failures drop constraint if exists automation_failures_workspace_id_job_id_fkey;
alter table public.automation_failures add constraint automation_failures_user_id_job_id_fkey
  foreign key (user_id, job_id) references automation_jobs(user_id, id) on delete cascade;

alter table public.automation_failures drop constraint if exists automation_failures_workspace_id_run_id_fkey;
alter table public.automation_failures add constraint automation_failures_user_id_run_id_fkey
  foreign key (user_id, run_id) references automation_runs(user_id, id) on delete cascade;

alter table public.automation_jobs drop constraint if exists automation_jobs_workspace_id_contact_id_fkey;
alter table public.automation_jobs add constraint automation_jobs_user_id_contact_id_fkey
  foreign key (user_id, contact_id) references contacts(user_id, id) on delete cascade;

alter table public.automation_jobs drop constraint if exists automation_jobs_workspace_id_enrollment_id_fkey;
alter table public.automation_jobs add constraint automation_jobs_user_id_enrollment_id_fkey
  foreign key (user_id, enrollment_id) references automation_enrollments(user_id, id) on delete cascade;

alter table public.automation_jobs drop constraint if exists automation_jobs_workspace_id_rule_id_fkey;
alter table public.automation_jobs add constraint automation_jobs_user_id_rule_id_fkey
  foreign key (user_id, rule_id) references automation_rules(user_id, id) on delete cascade;

alter table public.automation_jobs drop constraint if exists automation_jobs_workspace_id_step_id_fkey;
alter table public.automation_jobs add constraint automation_jobs_user_id_step_id_fkey
  foreign key (user_id, step_id) references automation_steps(user_id, id) on delete cascade;

alter table public.automation_runs drop constraint if exists automation_runs_workspace_id_enrollment_id_fkey;
alter table public.automation_runs add constraint automation_runs_user_id_enrollment_id_fkey
  foreign key (user_id, enrollment_id) references automation_enrollments(user_id, id) on delete cascade;

alter table public.automation_runs drop constraint if exists automation_runs_workspace_id_job_id_fkey;
alter table public.automation_runs add constraint automation_runs_user_id_job_id_fkey
  foreign key (user_id, job_id) references automation_jobs(user_id, id) on delete cascade;

alter table public.automation_steps drop constraint if exists automation_steps_workspace_id_rule_id_fkey;
alter table public.automation_steps add constraint automation_steps_user_id_rule_id_fkey
  foreign key (user_id, rule_id) references automation_rules(user_id, id) on delete cascade;

-- No ON DELETE action on this one, exactly as it was.
alter table public.automation_steps drop constraint if exists automation_steps_workspace_id_template_id_fkey;
alter table public.automation_steps add constraint automation_steps_user_id_template_id_fkey
  foreign key (user_id, template_id) references message_templates(user_id, id);

alter table public.automation_trigger_events drop constraint if exists automation_trigger_events_workspace_id_contact_id_fkey;
alter table public.automation_trigger_events add constraint automation_trigger_events_user_id_contact_id_fkey
  foreign key (user_id, contact_id) references contacts(user_id, id) on delete cascade;

alter table public.communication_consents drop constraint if exists communication_consents_workspace_id_contact_id_fkey;
alter table public.communication_consents add constraint communication_consents_user_id_contact_id_fkey
  foreign key (user_id, contact_id) references contacts(user_id, id) on delete cascade;

alter table public.contact_identity_keys drop constraint if exists contact_identity_keys_workspace_id_contact_id_fkey;
alter table public.contact_identity_keys add constraint contact_identity_keys_user_id_contact_id_fkey
  foreign key (user_id, contact_id) references contacts(user_id, id) on delete cascade;

alter table public.contact_stop_events drop constraint if exists contact_stop_events_workspace_id_contact_id_fkey;
alter table public.contact_stop_events add constraint contact_stop_events_user_id_contact_id_fkey
  foreign key (user_id, contact_id) references contacts(user_id, id) on delete cascade;

alter table public.contact_stop_events drop constraint if exists contact_stop_events_workspace_id_outbound_message_id_fkey;
alter table public.contact_stop_events add constraint contact_stop_events_user_id_outbound_message_id_fkey
  foreign key (user_id, outbound_message_id) references outbound_messages(user_id, id) on delete set null (outbound_message_id);

alter table public.deals drop constraint if exists deals_workspace_id_assigned_to_id_fkey;
alter table public.deals add constraint deals_user_id_assigned_to_id_fkey
  foreign key (user_id, assigned_to_id) references team_members(user_id, id) on delete set null (assigned_to_id);

alter table public.deals drop constraint if exists deals_workspace_id_contact_id_fkey;
alter table public.deals add constraint deals_user_id_contact_id_fkey
  foreign key (user_id, contact_id) references contacts(user_id, id) on delete set null (contact_id);

alter table public.deals drop constraint if exists deals_workspace_id_property_id_fkey;
alter table public.deals add constraint deals_user_id_property_id_fkey
  foreign key (user_id, property_id) references properties(user_id, id) on delete set null (property_id);

alter table public.email_suppressions drop constraint if exists email_suppressions_workspace_id_source_message_id_fkey;
alter table public.email_suppressions add constraint email_suppressions_user_id_source_message_id_fkey
  foreign key (user_id, source_message_id) references outbound_messages(user_id, id) on delete set null (source_message_id);

alter table public.finance_records drop constraint if exists finance_records_workspace_id_contact_id_fkey;
alter table public.finance_records add constraint finance_records_user_id_contact_id_fkey
  foreign key (user_id, contact_id) references contacts(user_id, id) on delete set null (contact_id);

alter table public.finance_records drop constraint if exists finance_records_workspace_id_deal_id_fkey;
alter table public.finance_records add constraint finance_records_user_id_deal_id_fkey
  foreign key (user_id, deal_id) references deals(user_id, id) on delete set null (deal_id);

alter table public.lead_import_batches drop constraint if exists lead_import_batches_workspace_id_connection_id_fkey;
alter table public.lead_import_batches add constraint lead_import_batches_user_id_connection_id_fkey
  foreign key (user_id, connection_id) references lead_source_connections(user_id, id) on delete cascade;

alter table public.lead_import_rows drop constraint if exists lead_import_rows_workspace_id_batch_id_fkey;
alter table public.lead_import_rows add constraint lead_import_rows_user_id_batch_id_fkey
  foreign key (user_id, batch_id) references lead_import_batches(user_id, id) on delete cascade;

alter table public.lead_import_rows drop constraint if exists lead_import_rows_workspace_id_connection_id_fkey;
alter table public.lead_import_rows add constraint lead_import_rows_user_id_connection_id_fkey
  foreign key (user_id, connection_id) references lead_source_connections(user_id, id) on delete cascade;

alter table public.lead_import_rows drop constraint if exists lead_import_rows_workspace_id_contact_id_fkey;
alter table public.lead_import_rows add constraint lead_import_rows_user_id_contact_id_fkey
  foreign key (user_id, contact_id) references contacts(user_id, id) on delete set null (contact_id);

alter table public.lead_source_mappings drop constraint if exists lead_source_mappings_workspace_id_connection_id_fkey;
alter table public.lead_source_mappings add constraint lead_source_mappings_user_id_connection_id_fkey
  foreign key (user_id, connection_id) references lead_source_connections(user_id, id) on delete cascade;

alter table public.milestones drop constraint if exists milestones_workspace_id_deal_id_fkey;
alter table public.milestones add constraint milestones_user_id_deal_id_fkey
  foreign key (user_id, deal_id) references deals(user_id, id) on delete cascade;

alter table public.notifications drop constraint if exists notifications_workspace_id_contact_id_fkey;
alter table public.notifications add constraint notifications_user_id_contact_id_fkey
  foreign key (user_id, contact_id) references contacts(user_id, id) on delete set null (contact_id);

alter table public.outbound_messages drop constraint if exists outbound_messages_workspace_id_contact_id_fkey;
alter table public.outbound_messages add constraint outbound_messages_user_id_contact_id_fkey
  foreign key (user_id, contact_id) references contacts(user_id, id) on delete cascade;

alter table public.outbound_messages drop constraint if exists outbound_messages_workspace_id_job_id_fkey;
alter table public.outbound_messages add constraint outbound_messages_user_id_job_id_fkey
  foreign key (user_id, job_id) references automation_jobs(user_id, id) on delete set null (job_id);

alter table public.outbound_messages drop constraint if exists outbound_messages_workspace_id_template_id_fkey;
alter table public.outbound_messages add constraint outbound_messages_user_id_template_id_fkey
  foreign key (user_id, template_id) references message_templates(user_id, id) on delete set null (template_id);

-- NOTE the original name here: properties_deal_tenant_fkey, not the
-- properties_user_id_deal_id_fkey the pattern would suggest.
alter table public.properties drop constraint if exists properties_workspace_id_deal_id_fkey;
alter table public.properties add constraint properties_deal_tenant_fkey
  foreign key (user_id, deal_id) references deals(user_id, id) on delete set null (deal_id);

alter table public.properties drop constraint if exists properties_workspace_id_contact_id_fkey;
alter table public.properties add constraint properties_user_id_contact_id_fkey
  foreign key (user_id, contact_id) references contacts(user_id, id) on delete set null (contact_id);

alter table public.referrals drop constraint if exists referrals_workspace_id_deal_id_fkey;
alter table public.referrals add constraint referrals_user_id_deal_id_fkey
  foreign key (user_id, deal_id) references deals(user_id, id) on delete set null (deal_id);

alter table public.referrals drop constraint if exists referrals_workspace_id_referred_contact_id_fkey;
alter table public.referrals add constraint referrals_user_id_referred_contact_id_fkey
  foreign key (user_id, referred_contact_id) references contacts(user_id, id) on delete set null (referred_contact_id);

alter table public.referrals drop constraint if exists referrals_workspace_id_referrer_contact_id_fkey;
alter table public.referrals add constraint referrals_user_id_referrer_contact_id_fkey
  foreign key (user_id, referrer_contact_id) references contacts(user_id, id) on delete set null (referrer_contact_id);

alter table public.scheduled_items drop constraint if exists scheduled_items_workspace_id_assigned_to_fkey;
alter table public.scheduled_items add constraint scheduled_items_user_id_assigned_to_fkey
  foreign key (user_id, assigned_to) references team_members(user_id, id) on delete set null (assigned_to);

alter table public.scheduled_items drop constraint if exists scheduled_items_workspace_id_contact_id_fkey;
alter table public.scheduled_items add constraint scheduled_items_user_id_contact_id_fkey
  foreign key (user_id, contact_id) references contacts(user_id, id) on delete set null (contact_id);

alter table public.scheduled_items drop constraint if exists scheduled_items_workspace_id_deal_id_fkey;
alter table public.scheduled_items add constraint scheduled_items_user_id_deal_id_fkey
  foreign key (user_id, deal_id) references deals(user_id, id) on delete set null (deal_id);

alter table public.scheduled_items drop constraint if exists scheduled_items_workspace_id_property_id_fkey;
alter table public.scheduled_items add constraint scheduled_items_user_id_property_id_fkey
  foreign key (user_id, property_id) references properties(user_id, id) on delete set null (property_id);

alter table public.scheduled_items drop constraint if exists scheduled_items_workspace_id_script_id_fkey;
alter table public.scheduled_items add constraint scheduled_items_user_id_script_id_fkey
  foreign key (user_id, script_id) references scripts(user_id, id) on delete set null (script_id);

alter table public.showings drop constraint if exists showings_workspace_id_contact_id_fkey;
alter table public.showings add constraint showings_user_id_contact_id_fkey
  foreign key (user_id, contact_id) references contacts(user_id, id) on delete set null (contact_id);

alter table public.showings drop constraint if exists showings_workspace_id_deal_id_fkey;
alter table public.showings add constraint showings_user_id_deal_id_fkey
  foreign key (user_id, deal_id) references deals(user_id, id) on delete set null (deal_id);

alter table public.showings drop constraint if exists showings_workspace_id_property_id_fkey;
alter table public.showings add constraint showings_user_id_property_id_fkey
  foreign key (user_id, property_id) references properties(user_id, id) on delete set null (property_id);

alter table public.tasks drop constraint if exists tasks_workspace_id_assigned_to_id_fkey;
alter table public.tasks add constraint tasks_user_id_assigned_to_id_fkey
  foreign key (user_id, assigned_to_id) references team_members(user_id, id) on delete set null (assigned_to_id);

alter table public.tasks drop constraint if exists tasks_workspace_id_contact_id_fkey;
alter table public.tasks add constraint tasks_user_id_contact_id_fkey
  foreign key (user_id, contact_id) references contacts(user_id, id) on delete set null (contact_id);

alter table public.tasks drop constraint if exists tasks_workspace_id_deal_id_fkey;
alter table public.tasks add constraint tasks_user_id_deal_id_fkey
  foreign key (user_id, deal_id) references deals(user_id, id) on delete set null (deal_id);

alter table public.tasks drop constraint if exists tasks_workspace_id_property_id_fkey;
alter table public.tasks add constraint tasks_user_id_property_id_fkey
  foreign key (user_id, property_id) references properties(user_id, id) on delete set null (property_id);

alter table public.webhook_events drop constraint if exists webhook_events_workspace_id_outbound_message_id_fkey;
alter table public.webhook_events add constraint webhook_events_user_id_outbound_message_id_fkey
  foreign key (user_id, outbound_message_id) references outbound_messages(user_id, id) on delete set null (outbound_message_id);

-- Confirm the revert landed: 56 user-scoped composite FKs, 0 workspace-scoped.
do $check$
declare v_user int; v_ws int;
begin
  select count(*) into v_user from pg_constraint c
    join pg_namespace n on n.oid = c.connamespace
   where c.contype='f' and n.nspname='public' and array_length(c.conkey,1)=2
     and (select a.attname from pg_attribute a
           where a.attrelid=c.conrelid and a.attnum=c.conkey[1]) = 'user_id';
  select count(*) into v_ws from pg_constraint c
    join pg_namespace n on n.oid = c.connamespace
   where c.contype='f' and n.nspname='public' and array_length(c.conkey,1)=2
     and (select a.attname from pg_attribute a
           where a.attrelid=c.conrelid and a.attnum=c.conkey[1]) = 'workspace_id'
     -- T2a's own two workspace-scoped composite FKs are not ours to undo.
     and c.conname not in ('contacts_assigned_team_member_fk',
                           'workspace_members_team_member_fk');
  if v_user <> 56 or v_ws <> 0 then
    raise exception 'revert incomplete: % user-scoped (want 56), % workspace-scoped (want 0)',
      v_user, v_ws;
  end if;
  raise notice 'T2c-pre reverted: 56 composite FKs are back on (user_id, ...).';
end $check$;

commit;
