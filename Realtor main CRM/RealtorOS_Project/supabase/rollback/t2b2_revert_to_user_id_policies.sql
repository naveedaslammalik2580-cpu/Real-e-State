-- T2b-2 REVERT — restores the pre-T2b-2 policy set exactly.
--
-- Generated from live pg_policies on the project immediately BEFORE the
-- T2b-2 policy switch (109 policies across 40 tables). This file lives in
-- supabase/rollback/ and is NEVER picked up by `supabase db push` or the
-- migration runner — apply it by hand (or via apply_migration) only to undo
-- T2b-2.
--
-- It also restores the grants T2b-2 revokes, so a revert leaves the
-- database byte-for-byte equivalent to its pre-T2b-2 authorization state.
--
-- Safe to re-run: every CREATE POLICY is preceded by DROP POLICY IF EXISTS.
--
-- After applying, verify:
--   select count(*) from pg_policies where schemaname='public';   -- 109
--   -- and, as the owner, that their contacts are readable again.

-- ---------- own-row CRUD tables ----------

drop policy if exists activities_select_own on public.activities;
create policy activities_select_own on public.activities as permissive for select to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists activities_insert_own on public.activities;
create policy activities_insert_own on public.activities as permissive for insert to authenticated
  with check (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists activities_update_own on public.activities;
create policy activities_update_own on public.activities as permissive for update to authenticated
  using (( SELECT auth.uid() AS uid) = user_id)
  with check (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists activities_delete_own on public.activities;
create policy activities_delete_own on public.activities as permissive for delete to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists ai_prompts_select_own on public.ai_prompts;
create policy ai_prompts_select_own on public.ai_prompts as permissive for select to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists ai_prompts_insert_own on public.ai_prompts;
create policy ai_prompts_insert_own on public.ai_prompts as permissive for insert to authenticated
  with check (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists ai_prompts_update_own on public.ai_prompts;
create policy ai_prompts_update_own on public.ai_prompts as permissive for update to authenticated
  using (( SELECT auth.uid() AS uid) = user_id)
  with check (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists ai_prompts_delete_own on public.ai_prompts;
create policy ai_prompts_delete_own on public.ai_prompts as permissive for delete to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists contacts_select_own on public.contacts;
create policy contacts_select_own on public.contacts as permissive for select to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists contacts_insert_own on public.contacts;
create policy contacts_insert_own on public.contacts as permissive for insert to authenticated
  with check (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists contacts_update_own on public.contacts;
create policy contacts_update_own on public.contacts as permissive for update to authenticated
  using (( SELECT auth.uid() AS uid) = user_id)
  with check (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists contacts_delete_own on public.contacts;
create policy contacts_delete_own on public.contacts as permissive for delete to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists custom_field_values_select_own on public.custom_field_values;
create policy custom_field_values_select_own on public.custom_field_values as permissive for select to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists custom_field_values_insert_own on public.custom_field_values;
create policy custom_field_values_insert_own on public.custom_field_values as permissive for insert to authenticated
  with check (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists custom_field_values_update_own on public.custom_field_values;
create policy custom_field_values_update_own on public.custom_field_values as permissive for update to authenticated
  using (( SELECT auth.uid() AS uid) = user_id)
  with check (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists custom_field_values_delete_own on public.custom_field_values;
create policy custom_field_values_delete_own on public.custom_field_values as permissive for delete to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists deals_select_own on public.deals;
create policy deals_select_own on public.deals as permissive for select to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists deals_insert_own on public.deals;
create policy deals_insert_own on public.deals as permissive for insert to authenticated
  with check (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists deals_update_own on public.deals;
create policy deals_update_own on public.deals as permissive for update to authenticated
  using (( SELECT auth.uid() AS uid) = user_id)
  with check (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists deals_delete_own on public.deals;
create policy deals_delete_own on public.deals as permissive for delete to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists finance_records_select_own on public.finance_records;
create policy finance_records_select_own on public.finance_records as permissive for select to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists finance_records_insert_own on public.finance_records;
create policy finance_records_insert_own on public.finance_records as permissive for insert to authenticated
  with check (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists finance_records_update_own on public.finance_records;
create policy finance_records_update_own on public.finance_records as permissive for update to authenticated
  using (( SELECT auth.uid() AS uid) = user_id)
  with check (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists finance_records_delete_own on public.finance_records;
create policy finance_records_delete_own on public.finance_records as permissive for delete to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists goals_select_own on public.goals;
create policy goals_select_own on public.goals as permissive for select to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists goals_insert_own on public.goals;
create policy goals_insert_own on public.goals as permissive for insert to authenticated
  with check (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists goals_update_own on public.goals;
create policy goals_update_own on public.goals as permissive for update to authenticated
  using (( SELECT auth.uid() AS uid) = user_id)
  with check (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists goals_delete_own on public.goals;
create policy goals_delete_own on public.goals as permissive for delete to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists lead_source_connections_select_own on public.lead_source_connections;
create policy lead_source_connections_select_own on public.lead_source_connections as permissive for select to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists lead_source_connections_insert_own on public.lead_source_connections;
create policy lead_source_connections_insert_own on public.lead_source_connections as permissive for insert to authenticated
  with check (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists lead_source_connections_update_own on public.lead_source_connections;
create policy lead_source_connections_update_own on public.lead_source_connections as permissive for update to authenticated
  using (( SELECT auth.uid() AS uid) = user_id)
  with check (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists lead_source_connections_delete_own on public.lead_source_connections;
create policy lead_source_connections_delete_own on public.lead_source_connections as permissive for delete to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists lead_source_mappings_select_own on public.lead_source_mappings;
create policy lead_source_mappings_select_own on public.lead_source_mappings as permissive for select to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists lead_source_mappings_insert_own on public.lead_source_mappings;
create policy lead_source_mappings_insert_own on public.lead_source_mappings as permissive for insert to authenticated
  with check (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists lead_source_mappings_update_own on public.lead_source_mappings;
create policy lead_source_mappings_update_own on public.lead_source_mappings as permissive for update to authenticated
  using (( SELECT auth.uid() AS uid) = user_id)
  with check (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists lead_source_mappings_delete_own on public.lead_source_mappings;
create policy lead_source_mappings_delete_own on public.lead_source_mappings as permissive for delete to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists message_templates_select_own on public.message_templates;
create policy message_templates_select_own on public.message_templates as permissive for select to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists message_templates_insert_own on public.message_templates;
create policy message_templates_insert_own on public.message_templates as permissive for insert to authenticated
  with check (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists message_templates_update_own on public.message_templates;
create policy message_templates_update_own on public.message_templates as permissive for update to authenticated
  using (( SELECT auth.uid() AS uid) = user_id)
  with check (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists message_templates_delete_own on public.message_templates;
create policy message_templates_delete_own on public.message_templates as permissive for delete to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists milestones_select_own on public.milestones;
create policy milestones_select_own on public.milestones as permissive for select to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists milestones_insert_own on public.milestones;
create policy milestones_insert_own on public.milestones as permissive for insert to authenticated
  with check (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists milestones_update_own on public.milestones;
create policy milestones_update_own on public.milestones as permissive for update to authenticated
  using (( SELECT auth.uid() AS uid) = user_id)
  with check (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists milestones_delete_own on public.milestones;
create policy milestones_delete_own on public.milestones as permissive for delete to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists properties_select_own on public.properties;
create policy properties_select_own on public.properties as permissive for select to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists properties_insert_own on public.properties;
create policy properties_insert_own on public.properties as permissive for insert to authenticated
  with check (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists properties_update_own on public.properties;
create policy properties_update_own on public.properties as permissive for update to authenticated
  using (( SELECT auth.uid() AS uid) = user_id)
  with check (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists properties_delete_own on public.properties;
create policy properties_delete_own on public.properties as permissive for delete to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists referrals_select_own on public.referrals;
create policy referrals_select_own on public.referrals as permissive for select to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists referrals_insert_own on public.referrals;
create policy referrals_insert_own on public.referrals as permissive for insert to authenticated
  with check (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists referrals_update_own on public.referrals;
create policy referrals_update_own on public.referrals as permissive for update to authenticated
  using (( SELECT auth.uid() AS uid) = user_id)
  with check (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists referrals_delete_own on public.referrals;
create policy referrals_delete_own on public.referrals as permissive for delete to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists scheduled_items_select_own on public.scheduled_items;
create policy scheduled_items_select_own on public.scheduled_items as permissive for select to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists scheduled_items_insert_own on public.scheduled_items;
create policy scheduled_items_insert_own on public.scheduled_items as permissive for insert to authenticated
  with check (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists scheduled_items_update_own on public.scheduled_items;
create policy scheduled_items_update_own on public.scheduled_items as permissive for update to authenticated
  using (( SELECT auth.uid() AS uid) = user_id)
  with check (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists scheduled_items_delete_own on public.scheduled_items;
create policy scheduled_items_delete_own on public.scheduled_items as permissive for delete to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists scripts_select_own on public.scripts;
create policy scripts_select_own on public.scripts as permissive for select to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists scripts_insert_own on public.scripts;
create policy scripts_insert_own on public.scripts as permissive for insert to authenticated
  with check (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists scripts_update_own on public.scripts;
create policy scripts_update_own on public.scripts as permissive for update to authenticated
  using (( SELECT auth.uid() AS uid) = user_id)
  with check (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists scripts_delete_own on public.scripts;
create policy scripts_delete_own on public.scripts as permissive for delete to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists showings_select_own on public.showings;
create policy showings_select_own on public.showings as permissive for select to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists showings_insert_own on public.showings;
create policy showings_insert_own on public.showings as permissive for insert to authenticated
  with check (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists showings_update_own on public.showings;
create policy showings_update_own on public.showings as permissive for update to authenticated
  using (( SELECT auth.uid() AS uid) = user_id)
  with check (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists showings_delete_own on public.showings;
create policy showings_delete_own on public.showings as permissive for delete to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists tasks_select_own on public.tasks;
create policy tasks_select_own on public.tasks as permissive for select to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists tasks_insert_own on public.tasks;
create policy tasks_insert_own on public.tasks as permissive for insert to authenticated
  with check (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists tasks_update_own on public.tasks;
create policy tasks_update_own on public.tasks as permissive for update to authenticated
  using (( SELECT auth.uid() AS uid) = user_id)
  with check (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists tasks_delete_own on public.tasks;
create policy tasks_delete_own on public.tasks as permissive for delete to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists team_members_select_own on public.team_members;
create policy team_members_select_own on public.team_members as permissive for select to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists team_members_insert_own on public.team_members;
create policy team_members_insert_own on public.team_members as permissive for insert to authenticated
  with check (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists team_members_update_own on public.team_members;
create policy team_members_update_own on public.team_members as permissive for update to authenticated
  using (( SELECT auth.uid() AS uid) = user_id)
  with check (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists team_members_delete_own on public.team_members;
create policy team_members_delete_own on public.team_members as permissive for delete to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists workspace_settings_select_own on public.workspace_settings;
create policy workspace_settings_select_own on public.workspace_settings as permissive for select to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists workspace_settings_insert_own on public.workspace_settings;
create policy workspace_settings_insert_own on public.workspace_settings as permissive for insert to authenticated
  with check (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists workspace_settings_update_own on public.workspace_settings;
create policy workspace_settings_update_own on public.workspace_settings as permissive for update to authenticated
  using (( SELECT auth.uid() AS uid) = user_id)
  with check (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists workspace_settings_delete_own on public.workspace_settings;
create policy workspace_settings_delete_own on public.workspace_settings as permissive for delete to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

-- ---------- workspace_state (legacy policy names) ----------

drop policy if exists realtoros_select_own_workspace on public.workspace_state;
create policy realtoros_select_own_workspace on public.workspace_state as permissive for select to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists realtoros_insert_own_workspace on public.workspace_state;
create policy realtoros_insert_own_workspace on public.workspace_state as permissive for insert to authenticated
  with check (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists realtoros_update_own_workspace on public.workspace_state;
create policy realtoros_update_own_workspace on public.workspace_state as permissive for update to authenticated
  using (( SELECT auth.uid() AS uid) = user_id)
  with check (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists realtoros_delete_own_workspace on public.workspace_state;
create policy realtoros_delete_own_workspace on public.workspace_state as permissive for delete to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

-- ---------- service-written tables: browser SELECT only ----------

drop policy if exists automation_enrollments_select_own on public.automation_enrollments;
create policy automation_enrollments_select_own on public.automation_enrollments as permissive for select to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists automation_failures_select_own on public.automation_failures;
create policy automation_failures_select_own on public.automation_failures as permissive for select to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists automation_jobs_select_own on public.automation_jobs;
create policy automation_jobs_select_own on public.automation_jobs as permissive for select to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists automation_runs_select_own on public.automation_runs;
create policy automation_runs_select_own on public.automation_runs as permissive for select to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists automation_trigger_events_select_own on public.automation_trigger_events;
create policy automation_trigger_events_select_own on public.automation_trigger_events as permissive for select to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists communication_consents_select_own on public.communication_consents;
create policy communication_consents_select_own on public.communication_consents as permissive for select to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists contact_identity_keys_select_own on public.contact_identity_keys;
create policy contact_identity_keys_select_own on public.contact_identity_keys as permissive for select to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists email_suppressions_select_own on public.email_suppressions;
create policy email_suppressions_select_own on public.email_suppressions as permissive for select to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists lead_import_batches_select_own on public.lead_import_batches;
create policy lead_import_batches_select_own on public.lead_import_batches as permissive for select to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists lead_import_rows_select_own on public.lead_import_rows;
create policy lead_import_rows_select_own on public.lead_import_rows as permissive for select to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists outbound_messages_select_own on public.outbound_messages;
create policy outbound_messages_select_own on public.outbound_messages as permissive for select to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists webhook_events_select_own on public.webhook_events;
create policy webhook_events_select_own on public.webhook_events as permissive for select to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

-- ---------- email_sender_profiles (no delete policy) ----------

drop policy if exists email_sender_profiles_select_own on public.email_sender_profiles;
create policy email_sender_profiles_select_own on public.email_sender_profiles as permissive for select to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists email_sender_profiles_insert_own on public.email_sender_profiles;
create policy email_sender_profiles_insert_own on public.email_sender_profiles as permissive for insert to authenticated
  with check (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists email_sender_profiles_update_own on public.email_sender_profiles;
create policy email_sender_profiles_update_own on public.email_sender_profiles as permissive for update to authenticated
  using (( SELECT auth.uid() AS uid) = user_id)
  with check (( SELECT auth.uid() AS uid) = user_id);

-- ---------- notifications (select + mark-read only) ----------

drop policy if exists notifications_select_own on public.notifications;
create policy notifications_select_own on public.notifications as permissive for select to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists notifications_update_own on public.notifications;
create policy notifications_update_own on public.notifications as permissive for update to authenticated
  using (( SELECT auth.uid() AS uid) = user_id)
  with check (( SELECT auth.uid() AS uid) = user_id);

-- ---------- automation_rules (writes only while draft) ----------

drop policy if exists automation_rules_select_own on public.automation_rules;
create policy automation_rules_select_own on public.automation_rules as permissive for select to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists automation_rules_insert_own on public.automation_rules;
create policy automation_rules_insert_own on public.automation_rules as permissive for insert to authenticated
  with check ((( SELECT auth.uid() AS uid) = user_id) AND (status = 'draft'::text));

drop policy if exists automation_rules_update_own on public.automation_rules;
create policy automation_rules_update_own on public.automation_rules as permissive for update to authenticated
  using ((( SELECT auth.uid() AS uid) = user_id) AND (status = 'draft'::text))
  with check ((( SELECT auth.uid() AS uid) = user_id) AND (status = 'draft'::text));

drop policy if exists automation_rules_delete_own on public.automation_rules;
create policy automation_rules_delete_own on public.automation_rules as permissive for delete to authenticated
  using ((( SELECT auth.uid() AS uid) = user_id) AND (status = 'draft'::text));

-- ---------- automation_steps (parent rule must be draft) ----------

drop policy if exists automation_steps_select_own on public.automation_steps;
create policy automation_steps_select_own on public.automation_steps as permissive for select to authenticated
  using (( SELECT auth.uid() AS uid) = user_id);

drop policy if exists automation_steps_insert_own on public.automation_steps;
create policy automation_steps_insert_own on public.automation_steps as permissive for insert to authenticated
  with check ((( SELECT auth.uid() AS uid) = user_id) AND (EXISTS ( SELECT 1
   FROM automation_rules r
  WHERE ((r.id = automation_steps.rule_id) AND (r.user_id = ( SELECT auth.uid() AS uid)) AND (r.status = 'draft'::text)))));

drop policy if exists automation_steps_update_own on public.automation_steps;
create policy automation_steps_update_own on public.automation_steps as permissive for update to authenticated
  using ((( SELECT auth.uid() AS uid) = user_id) AND (EXISTS ( SELECT 1
   FROM automation_rules r
  WHERE ((r.id = automation_steps.rule_id) AND (r.user_id = ( SELECT auth.uid() AS uid)) AND (r.status = 'draft'::text)))))
  with check ((( SELECT auth.uid() AS uid) = user_id) AND (EXISTS ( SELECT 1
   FROM automation_rules r
  WHERE ((r.id = automation_steps.rule_id) AND (r.user_id = ( SELECT auth.uid() AS uid)) AND (r.status = 'draft'::text)))));

drop policy if exists automation_steps_delete_own on public.automation_steps;
create policy automation_steps_delete_own on public.automation_steps as permissive for delete to authenticated
  using ((( SELECT auth.uid() AS uid) = user_id) AND (EXISTS ( SELECT 1
   FROM automation_rules r
  WHERE ((r.id = automation_steps.rule_id) AND (r.user_id = ( SELECT auth.uid() AS uid)) AND (r.status = 'draft'::text)))));

-- ---------- workspace / permission tables ----------

drop policy if exists workspace_members_select_own on public.workspace_members;
create policy workspace_members_select_own on public.workspace_members as permissive for select to authenticated
  using ((user_id = ( SELECT auth.uid() AS uid)));

drop policy if exists workspaces_select_member on public.workspaces;
create policy workspaces_select_member on public.workspaces as permissive for select to authenticated
  using ((EXISTS ( SELECT 1
   FROM workspace_members wm
  WHERE ((wm.workspace_id = workspaces.id) AND (wm.user_id = ( SELECT auth.uid() AS uid)) AND (wm.status = 'active'::text)))));

drop policy if exists workspace_role_permissions_select_member on public.workspace_role_permissions;
create policy workspace_role_permissions_select_member on public.workspace_role_permissions as permissive for select to authenticated
  using ((EXISTS ( SELECT 1
   FROM workspace_members wm
  WHERE ((wm.workspace_id = workspace_role_permissions.workspace_id) AND (wm.user_id = ( SELECT auth.uid() AS uid)) AND (wm.status = 'active'::text)))));

drop policy if exists workspace_permission_changes_select_tm on public.workspace_permission_changes;
create policy workspace_permission_changes_select_tm on public.workspace_permission_changes as permissive for select to authenticated
  using (authz.can(workspace_id, 'team_manage'::text));

-- ---------- grants restored ----------
-- T2b-2 revokes INSERT/UPDATE/DELETE (and SELECT) from anon on every public
-- table. Pre-T2b-2, anon held full DML on the 17 original tables and
-- authenticated held full DML on every own-row CRUD table. This restores
-- that exact state. (anon matched zero policies, so the grants were never
-- exploitable — but a revert must be faithful, not "better".)
do $grants$
declare t text;
begin
  foreach t in array array[
    'activities','ai_prompts','contacts','custom_field_values','deals',
    'finance_records','goals','milestones','properties','referrals',
    'scheduled_items','scripts','showings','tasks','team_members',
    'workspace_settings','workspace_state'
  ] loop
    execute format('grant select, insert, update, delete on public.%I to anon, authenticated', t);
  end loop;

  foreach t in array array[
    'lead_source_connections','lead_source_mappings','message_templates',
    'email_sender_profiles','notifications','automation_rules','automation_steps'
  ] loop
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;

  foreach t in array array[
    'automation_enrollments','automation_failures','automation_jobs',
    'automation_runs','automation_trigger_events','communication_consents',
    'contact_identity_keys','email_suppressions','lead_import_batches',
    'lead_import_rows','outbound_messages','webhook_events'
  ] loop
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $grants$;
