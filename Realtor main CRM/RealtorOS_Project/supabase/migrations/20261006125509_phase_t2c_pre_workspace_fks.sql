-- Phase T2c-pre: move the tenant half of every composite foreign key
-- from user_id to workspace_id.
--
-- THE PROBLEM
--
-- Every cross-table reference in this schema is a composite tenant FK:
--
--   foreign key (user_id, contact_id) references contacts (user_id, id)
--
-- There are 56 of them. The pattern was right when one owner was one
-- tenant: it made it impossible for a child row to point at another
-- tenant's parent. With a team it says something much stronger, and now
-- wrong:
--
--   the child row's creator must be the same PERSON as the parent
--   row's creator.
--
-- So a teammate cannot create any row that references a row somebody
-- else created, no matter what their permissions say. T2b-2's RLS is
-- deliberately permissive where these FKs are not, and the FK wins.
-- Measured in PGlite against the real chain before writing this:
--
--   admin's authz.my_scope('contacts','view')  -> all
--   admin's authz.my_scope('work','edit')      -> all
--   admin SELECTs the owner's contact          -> 1 row (RLS allows it)
--   admin INSERTs a task on that contact       -> 23503
--                                                 tasks_user_id_contact_id_fkey
--
-- The same shape breaks logging an activity on a teammate's lead,
-- creating a deal / showing / scheduled item against one, assigning a
-- task (tasks.assigned_to_id -> team_members(user_id, id)), a teammate
-- importing a person another teammate already imported, and the whole
-- notification fan-out: notifications.contact_id -> contacts(user_id, id)
-- aborted the trigger's entire begin/exception block, losing EVERY
-- recipient's notification rather than just the failing one.
--
-- THE FIX
--
-- For each of the 56, repoint the first column from user_id to
-- workspace_id and target parent (workspace_id, id), keeping the
-- referenced column, the ON DELETE action, and the column-scoped
-- ON DELETE SET NULL (col) form from doc section 1.2.
--
-- user_id STAYS on every table. It remains "who created this" - the
-- audit trail - and (user_id) -> auth.users is untouched. Only the
-- TENANT half of the composite key changes. The (user_id, id) unique
-- indexes on the parents also stay, which is what keeps
-- supabase/rollback/t2c_pre_revert_fks.sql usable.
--
-- WHY THIS IS SAFE
--
--   1. Every target already exists. All 15 referenced parent tables
--      carry a (workspace_id, id) unique index; T2a created them for
--      exactly this conversion and nothing had used them yet.
--   2. No data can conflict today. Every workspace has exactly one
--      member, so user_id and workspace_id partition the rows
--      identically. Section 1 re-checks that from the data itself and
--      refuses to proceed if it is ever untrue, rather than trusting
--      this note.
--
-- THE LIST IS THE AUTHORITY. The 56 rows below were generated from live
-- pg_constraint, and every reference is named explicitly: child table,
-- the exact OLD constraint name (note properties_deal_tenant_fkey, which
-- does not follow the usual pattern), the referencing column, the parent
-- table, and the delete action. Nothing here is discovered by matching a
-- name pattern, so a constraint cannot be converted by accident or
-- missed silently - section 3 fails if the totals do not come out right.
--
-- Idempotent: an entry whose workspace-scoped constraint already exists
-- is skipped, so re-running the chain is a no-op (the repo's other
-- migrations hold the same property and three tests check it).

do $convert$
declare
  r record;
  v_new text;
  v_bad bigint;
  v_total int := 0;
  v_converted int := 0;
  v_skipped int := 0;
  v_report text := '';
  v_clause text;
begin
  for r in select * from (values
    ('activities', 'activities_user_id_contact_id_fkey', 'contact_id', 'contacts', 'setnull:contact_id'),
    ('activities', 'activities_user_id_deal_id_fkey', 'deal_id', 'deals', 'setnull:deal_id'),
    ('activities', 'activities_user_id_property_id_fkey', 'property_id', 'properties', 'setnull:property_id'),
    ('activities', 'activities_user_id_task_id_fkey', 'task_id', 'tasks', 'setnull:task_id'),
    ('automation_enrollments', 'automation_enrollments_user_id_contact_id_fkey', 'contact_id', 'contacts', 'cascade'),
    ('automation_enrollments', 'automation_enrollments_user_id_rule_id_fkey', 'rule_id', 'automation_rules', 'cascade'),
    ('automation_enrollments', 'automation_enrollments_user_id_source_batch_id_fkey', 'source_batch_id', 'lead_import_batches', 'setnull:source_batch_id'),
    ('automation_failures', 'automation_failures_user_id_job_id_fkey', 'job_id', 'automation_jobs', 'cascade'),
    ('automation_failures', 'automation_failures_user_id_run_id_fkey', 'run_id', 'automation_runs', 'cascade'),
    ('automation_jobs', 'automation_jobs_user_id_contact_id_fkey', 'contact_id', 'contacts', 'cascade'),
    ('automation_jobs', 'automation_jobs_user_id_enrollment_id_fkey', 'enrollment_id', 'automation_enrollments', 'cascade'),
    ('automation_jobs', 'automation_jobs_user_id_rule_id_fkey', 'rule_id', 'automation_rules', 'cascade'),
    ('automation_jobs', 'automation_jobs_user_id_step_id_fkey', 'step_id', 'automation_steps', 'cascade'),
    ('automation_runs', 'automation_runs_user_id_enrollment_id_fkey', 'enrollment_id', 'automation_enrollments', 'cascade'),
    ('automation_runs', 'automation_runs_user_id_job_id_fkey', 'job_id', 'automation_jobs', 'cascade'),
    ('automation_steps', 'automation_steps_user_id_rule_id_fkey', 'rule_id', 'automation_rules', 'cascade'),
    ('automation_steps', 'automation_steps_user_id_template_id_fkey', 'template_id', 'message_templates', 'noaction'),
    ('automation_trigger_events', 'automation_trigger_events_user_id_contact_id_fkey', 'contact_id', 'contacts', 'cascade'),
    ('communication_consents', 'communication_consents_user_id_contact_id_fkey', 'contact_id', 'contacts', 'cascade'),
    ('contact_identity_keys', 'contact_identity_keys_user_id_contact_id_fkey', 'contact_id', 'contacts', 'cascade'),
    ('contact_stop_events', 'contact_stop_events_user_id_contact_id_fkey', 'contact_id', 'contacts', 'cascade'),
    ('contact_stop_events', 'contact_stop_events_user_id_outbound_message_id_fkey', 'outbound_message_id', 'outbound_messages', 'setnull:outbound_message_id'),
    ('deals', 'deals_user_id_assigned_to_id_fkey', 'assigned_to_id', 'team_members', 'setnull:assigned_to_id'),
    ('deals', 'deals_user_id_contact_id_fkey', 'contact_id', 'contacts', 'setnull:contact_id'),
    ('deals', 'deals_user_id_property_id_fkey', 'property_id', 'properties', 'setnull:property_id'),
    ('email_suppressions', 'email_suppressions_user_id_source_message_id_fkey', 'source_message_id', 'outbound_messages', 'setnull:source_message_id'),
    ('finance_records', 'finance_records_user_id_contact_id_fkey', 'contact_id', 'contacts', 'setnull:contact_id'),
    ('finance_records', 'finance_records_user_id_deal_id_fkey', 'deal_id', 'deals', 'setnull:deal_id'),
    ('lead_import_batches', 'lead_import_batches_user_id_connection_id_fkey', 'connection_id', 'lead_source_connections', 'cascade'),
    ('lead_import_rows', 'lead_import_rows_user_id_batch_id_fkey', 'batch_id', 'lead_import_batches', 'cascade'),
    ('lead_import_rows', 'lead_import_rows_user_id_connection_id_fkey', 'connection_id', 'lead_source_connections', 'cascade'),
    ('lead_import_rows', 'lead_import_rows_user_id_contact_id_fkey', 'contact_id', 'contacts', 'setnull:contact_id'),
    ('lead_source_mappings', 'lead_source_mappings_user_id_connection_id_fkey', 'connection_id', 'lead_source_connections', 'cascade'),
    ('milestones', 'milestones_user_id_deal_id_fkey', 'deal_id', 'deals', 'cascade'),
    ('notifications', 'notifications_user_id_contact_id_fkey', 'contact_id', 'contacts', 'setnull:contact_id'),
    ('outbound_messages', 'outbound_messages_user_id_contact_id_fkey', 'contact_id', 'contacts', 'cascade'),
    ('outbound_messages', 'outbound_messages_user_id_job_id_fkey', 'job_id', 'automation_jobs', 'setnull:job_id'),
    ('outbound_messages', 'outbound_messages_user_id_template_id_fkey', 'template_id', 'message_templates', 'setnull:template_id'),
    ('properties', 'properties_deal_tenant_fkey', 'deal_id', 'deals', 'setnull:deal_id'),
    ('properties', 'properties_user_id_contact_id_fkey', 'contact_id', 'contacts', 'setnull:contact_id'),
    ('referrals', 'referrals_user_id_deal_id_fkey', 'deal_id', 'deals', 'setnull:deal_id'),
    ('referrals', 'referrals_user_id_referred_contact_id_fkey', 'referred_contact_id', 'contacts', 'setnull:referred_contact_id'),
    ('referrals', 'referrals_user_id_referrer_contact_id_fkey', 'referrer_contact_id', 'contacts', 'setnull:referrer_contact_id'),
    ('scheduled_items', 'scheduled_items_user_id_assigned_to_fkey', 'assigned_to', 'team_members', 'setnull:assigned_to'),
    ('scheduled_items', 'scheduled_items_user_id_contact_id_fkey', 'contact_id', 'contacts', 'setnull:contact_id'),
    ('scheduled_items', 'scheduled_items_user_id_deal_id_fkey', 'deal_id', 'deals', 'setnull:deal_id'),
    ('scheduled_items', 'scheduled_items_user_id_property_id_fkey', 'property_id', 'properties', 'setnull:property_id'),
    ('scheduled_items', 'scheduled_items_user_id_script_id_fkey', 'script_id', 'scripts', 'setnull:script_id'),
    ('showings', 'showings_user_id_contact_id_fkey', 'contact_id', 'contacts', 'setnull:contact_id'),
    ('showings', 'showings_user_id_deal_id_fkey', 'deal_id', 'deals', 'setnull:deal_id'),
    ('showings', 'showings_user_id_property_id_fkey', 'property_id', 'properties', 'setnull:property_id'),
    ('tasks', 'tasks_user_id_assigned_to_id_fkey', 'assigned_to_id', 'team_members', 'setnull:assigned_to_id'),
    ('tasks', 'tasks_user_id_contact_id_fkey', 'contact_id', 'contacts', 'setnull:contact_id'),
    ('tasks', 'tasks_user_id_deal_id_fkey', 'deal_id', 'deals', 'setnull:deal_id'),
    ('tasks', 'tasks_user_id_property_id_fkey', 'property_id', 'properties', 'setnull:property_id'),
    ('webhook_events', 'webhook_events_user_id_outbound_message_id_fkey', 'outbound_message_id', 'outbound_messages', 'setnull:outbound_message_id')
  ) as v(child, old_name, col, parent, action)
  loop
    v_total := v_total + 1;
    v_new := r.child || '_workspace_id_' || r.col || '_fkey';

    -- Already converted (a re-run of the chain): leave it alone.
    if exists (
      select 1 from pg_constraint c
        join pg_namespace n on n.oid = c.connamespace
       where n.nspname = 'public' and c.conname = v_new
         and c.conrelid = ('public.' || quote_ident(r.child))::regclass
    ) then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- 1. Refuse if any row already points across a workspace boundary:
    --    the new FK would reject it, and failing halfway through 56
    --    ALTERs is worse than not starting.
    execute format(
      'select count(*) from public.%I c
         where c.%I is not null
           and not exists (select 1 from public.%I p
                            where p.id = c.%I and p.workspace_id = c.workspace_id)',
      r.child, r.col, r.parent, r.col)
    into v_bad;
    if v_bad > 0 then
      v_report := v_report || format(E'\n  %s.%s -> %s: %s row(s)', r.child, r.col, r.parent, v_bad);
      continue;
    end if;

    -- 2. Convert. The delete action is carried over verbatim; a plain
    --    SET NULL is never used, because it would null workspace_id too
    --    and orphan the row from its tenant.
    v_clause := case
      when r.action = 'cascade' then ' on delete cascade'
      when r.action like 'setnull:%' then
        ' on delete set null (' || quote_ident(substring(r.action from 9)) || ')'
      when r.action = 'noaction' then ''
      else null
    end;
    if v_clause is null then
      raise exception 'T2c-pre: unknown delete action %s on %s', r.action, r.old_name;
    end if;

    execute format('alter table public.%I drop constraint %I', r.child, r.old_name);
    execute format(
      'alter table public.%I add constraint %I foreign key (workspace_id, %I)
         references public.%I (workspace_id, id)%s',
      r.child, v_new, r.col, r.parent, v_clause);
    v_converted := v_converted + 1;
  end loop;

  if v_total <> 56 then
    raise exception 'T2c-pre: the reference list has % entries, expected 56', v_total;
  end if;

  if v_report <> '' then
    raise exception 'T2c-pre refuses to run: reference(s) already cross a workspace boundary.%',
      v_report;
  end if;

  raise notice 'T2c-pre: % converted, % already workspace-scoped.', v_converted, v_skipped;
end $convert$;

-- ============================================================
-- Confirm the conversion is complete and nothing was missed.
--
-- T2a had already created TWO workspace-scoped composite FKs of its own:
--   contacts_assigned_team_member_fk      (contacts.assigned_to_id)
--   workspace_members_team_member_fk      (workspace_members.team_member_id)
-- Both are column-scoped SET NULL. They are why lead assignment already
-- worked and the T2b-2 matrix passed, and they are counted in the totals
-- below: 56 + 2 = 58 workspace-scoped, 34 + 2 = 36 column-scoped.
-- ============================================================
do $verify$
declare
  v_user_scoped int;
  v_ws_scoped int;
  v_scoped_set_null int;
begin
  select count(*) into v_user_scoped from pg_constraint c
    join pg_namespace n on n.oid = c.connamespace
   where c.contype = 'f' and n.nspname = 'public' and array_length(c.conkey, 1) = 2
     and (select a.attname from pg_attribute a
           where a.attrelid = c.conrelid and a.attnum = c.conkey[1]) = 'user_id';
  if v_user_scoped <> 0 then
    raise exception 'T2c-pre incomplete: % composite FK(s) still start with user_id', v_user_scoped;
  end if;

  select count(*) into v_ws_scoped from pg_constraint c
    join pg_namespace n on n.oid = c.connamespace
   where c.contype = 'f' and n.nspname = 'public' and array_length(c.conkey, 1) = 2
     and (select a.attname from pg_attribute a
           where a.attrelid = c.conrelid and a.attnum = c.conkey[1]) = 'workspace_id';
  if v_ws_scoped <> 58 then
    raise exception 'T2c-pre: expected 58 workspace-scoped composite FKs, found %', v_ws_scoped;
  end if;

  select count(*) into v_scoped_set_null from pg_constraint c
    join pg_namespace n on n.oid = c.connamespace
   where c.contype = 'f' and n.nspname = 'public' and array_length(c.conkey, 1) = 2
     and c.confdeltype = 'n' and c.confdelsetcols is not null
     and (select a.attname from pg_attribute a
           where a.attrelid = c.conrelid and a.attnum = c.conkey[1]) = 'workspace_id';
  if v_scoped_set_null <> 36 then
    raise exception 'T2c-pre: expected 36 column-scoped SET NULL FKs, found %', v_scoped_set_null;
  end if;

  -- A plain SET NULL on a composite tenant FK would null workspace_id
  -- along with the reference, cutting the row loose from its workspace.
  if exists (
    select 1 from pg_constraint c
      join pg_namespace n on n.oid = c.connamespace
     where c.contype = 'f' and n.nspname = 'public' and array_length(c.conkey, 1) = 2
       and c.confdeltype = 'n' and c.confdelsetcols is null
  ) then
    raise exception 'T2c-pre: a composite FK uses plain SET NULL, which would null workspace_id too';
  end if;

  raise notice 'T2c-pre verified: 58 workspace-scoped composite FKs, 0 left on user_id.';
end $verify$;
