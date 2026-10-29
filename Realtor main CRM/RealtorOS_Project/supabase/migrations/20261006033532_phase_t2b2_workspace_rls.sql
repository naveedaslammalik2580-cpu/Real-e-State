-- Phase T2b-2: the security rule switch — workspace + permission RLS.
--
-- Replaces every user_id-based policy with a workspace_id + permission
-- aware one, atomically. Written against the area map and the "own"
-- definitions in docs/TEAM_ACCESS_ARCHITECTURE.md §7.0.3-§7.0.4, the
-- browser-read decisions in §7.0.8, and the caller-scoped helper pattern
-- in §7.0.6.
--
-- Shape of every area policy:
--   workspace_id = (select authz.my_workspace_id())
--   and ( (select authz.my_scope(<area>,<verb>)) = 'all'
--      or ((select authz.my_scope(<area>,<verb>)) = 'own' and <own-predicate>) )
--
-- Each authz.my_*() call is wrapped in (select ...) so the planner lifts
-- it to an InitPlan (once per statement, not once per row).
--
-- The OWNER is unaffected: owner scope is 'all' everywhere, so every
-- policy reduces to the workspace check, and every existing row already
-- carries the owner's workspace_id (T2a backfill). The current unmodified
-- frontend keeps working: it filters by user_id (harmless, still true for
-- the owner's own rows) and inserts without workspace_id (T2a's compat
-- trigger fills it before RLS evaluates WITH CHECK).
--
-- Idempotent: every CREATE POLICY is preceded by DROP POLICY IF EXISTS.

-- ============================================================
-- 0. Make authz SELF-CONTAINED.
--
-- authz.effective_permissions is SECURITY INVOKER (deliberately - that
-- is what makes it unable to leak another workspace). Until now it
-- reached into automation_internal for two pure JSON helpers, which
-- forced authenticated to hold USAGE on that schema. Any migration
-- chain ending on an earlier revoke all on schema automation_internal
-- from ... authenticated therefore broke the INVOKER path with
-- "permission denied for schema automation_internal".
--
-- Fix: authz keeps its OWN copies of the pure helpers, and
-- automation_internal goes back to service_role-only.
-- ============================================================
create or replace function authz.scope_rank(p text)
returns int language sql immutable set search_path = '' as $fn$
  select case p when 'none' then 0 when 'own' then 1 when 'all' then 2 else null end;
$fn$;
revoke all on function authz.scope_rank(text) from public, anon;
grant execute on function authz.scope_rank(text) to authenticated, service_role;

create or replace function authz.settings_rank(p text)
returns int language sql immutable set search_path = '' as $fn$
  select case p when 'none' then 0 when 'view' then 1 when 'edit' then 2 else null end;
$fn$;
revoke all on function authz.settings_rank(text) from public, anon;
grant execute on function authz.settings_rank(text) to authenticated, service_role;

-- Byte-identical to automation_internal.default_role_permissions. A test
-- asserts the two stay equal so they cannot drift apart.
create or replace function authz.default_role_permissions(p_role text)
returns jsonb language sql immutable set search_path = '' as $fn$
  select case
    when p_role = 'admin' then jsonb_build_object(
      'contacts',   jsonb_build_object('view','all','edit','all','delete','all','create', true),
      'deals',      jsonb_build_object('view','all','edit','all','delete','all','create', true),
      'work',       jsonb_build_object('view','all','edit','all','delete','all','create', true),
      'properties', jsonb_build_object('view','all','edit','all','delete','all','create', true),
      'finance',    jsonb_build_object('view','all','edit','all','delete','all','create', true),
      'goals',      jsonb_build_object('view','all','edit','all','delete','all','create', true),
      'contacts_assign', true, 'unassigned_view', true, 'unassigned_claim', true,
      'templates_manage_shared', true, 'templates_create_personal', true,
      'automation_manage_shared', true, 'automation_create_personal', true,
      'imports_file', true, 'integrations_manage', true, 'team_manage', true,
      'settings', 'edit')
    when p_role = 'agent' then jsonb_build_object(
      'contacts',   jsonb_build_object('view','own','edit','own','delete','none','create', true),
      'deals',      jsonb_build_object('view','own','edit','own','delete','none','create', true),
      'work',       jsonb_build_object('view','own','edit','own','delete','own', 'create', true),
      'properties', jsonb_build_object('view','all','edit','own','delete','own', 'create', true),
      'finance',    jsonb_build_object('view','none','edit','none','delete','none','create', false),
      'goals',      jsonb_build_object('view','own','edit','own','delete','own', 'create', true),
      'contacts_assign', false, 'unassigned_view', false, 'unassigned_claim', false,
      'templates_manage_shared', false, 'templates_create_personal', true,
      'automation_manage_shared', false, 'automation_create_personal', true,
      'imports_file', true, 'integrations_manage', false, 'team_manage', false,
      'settings', 'none')
    else null::jsonb
  end;
$fn$;
revoke all on function authz.default_role_permissions(text) from public, anon;
grant execute on function authz.default_role_permissions(text) to authenticated, service_role;

create or replace function authz.merge_permissions(p_template jsonb, p_overrides jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $fn$
declare
  v_merged jsonb := p_template; v_key text; v_val jsonb;
begin
  if p_overrides is null or jsonb_typeof(p_overrides) <> 'object' then
    return v_merged;
  end if;
  for v_key, v_val in select * from jsonb_each(p_overrides) loop
    if jsonb_typeof(v_val) = 'object' and v_merged ? v_key
       and jsonb_typeof(v_merged -> v_key) = 'object' then
      v_merged := v_merged || jsonb_build_object(v_key, (v_merged -> v_key) || v_val);
    else
      v_merged := v_merged || jsonb_build_object(v_key, v_val);
    end if;
  end loop;
  return v_merged;
end;
$fn$;
revoke all on function authz.merge_permissions(jsonb, jsonb) from public, anon;
grant execute on function authz.merge_permissions(jsonb, jsonb) to authenticated, service_role;

-- Repoint the INVOKER chain at the authz copies.
create or replace function authz.effective_permissions(p_workspace_id uuid)
returns jsonb language plpgsql stable set search_path = '' as $fn$
declare
  v_role text; v_overrides jsonb; v_template jsonb;
begin
  select m.role into v_role from authz.member(p_workspace_id) m;
  if v_role is null then return null; end if;
  if v_role = 'owner' then
    return authz.default_role_permissions('admin');
  end if;
  select wm.permission_overrides into v_overrides
    from public.workspace_members wm
    where wm.workspace_id = p_workspace_id
      and wm.user_id = (select auth.uid()) and wm.status = 'active';
  select wrp.permissions into v_template
    from public.workspace_role_permissions wrp
    where wrp.workspace_id = p_workspace_id and wrp.role = v_role;
  if v_template is null then
    v_template := authz.default_role_permissions(v_role);
  end if;
  return authz.merge_permissions(v_template, coalesce(v_overrides, '{}'::jsonb));
end;
$fn$;
revoke all on function authz.effective_permissions(uuid) from public, anon;
grant execute on function authz.effective_permissions(uuid) to authenticated, service_role;

-- automation_internal returns to service_role-only. Everything in it the
-- browser still depends on is SECURITY DEFINER (the realtoros_* RPCs,
-- the compat trigger, the validators), so they keep working with no
-- authenticated access to the schema at all.
revoke all on schema automation_internal from public, anon, authenticated;
grant usage on schema automation_internal to service_role;

-- ============================================================
-- 0b. Eager workspace provisioning (blocker 1, part 1).
--
-- A brand-new auth user gets their workspace at signup instead of on
-- their first write. Non-fatal by design: if provisioning fails the
-- signup still succeeds, and T2a's BEFORE INSERT compat trigger stays
-- as the fallback.
-- ============================================================
create or replace function automation_internal.provision_workspace_on_signup()
returns trigger language plpgsql security definer set search_path = '' as $fn$
begin
  begin
    perform automation_internal.ensure_personal_workspace(new.id);
  exception when others then
    raise warning 'ensure_personal_workspace failed for % (signup continues; compat trigger retries on first write): %',
      new.id, sqlerrm;
  end;
  return new;
end;
$fn$;
revoke all on function automation_internal.provision_workspace_on_signup() from public, anon, authenticated;

drop trigger if exists realtoros_provision_workspace on auth.users;
create trigger realtoros_provision_workspace
  after insert on auth.users
  for each row execute function automation_internal.provision_workspace_on_signup();

-- ============================================================
-- 0c. Extra authz helpers this phase needs.
-- ============================================================

-- Area 'create' is a boolean inside the area object, not a scope string.
create or replace function authz.my_area_create(p_area text)
returns boolean language sql stable set search_path = '' as $fn$
  select coalesce((authz.effective_permissions(authz.my_workspace_id())
                   -> p_area ->> 'create')::boolean, false);
$fn$;
revoke all on function authz.my_area_create(text) from public, anon;
grant execute on function authz.my_area_create(text) to authenticated, service_role;
comment on function authz.my_area_create(text) is
  'Phase T2b-2. Caller-only boolean for an area''s create flag. Wrap in (select ...) inside RLS.';

-- Ownership probes for child tables that inherit through a parent.
-- SECURITY DEFINER so a policy on the CHILD does not re-enter the
-- PARENT's RLS (which would recurse or silently over-filter). Safe:
-- each one derives the workspace from auth.uid() itself and can only
-- ever answer about the caller's own workspace, so it cannot be used
-- to probe another tenant.
create or replace function authz.owns_deal(p_deal_id text)
returns boolean language sql stable security definer set search_path = '' as $fn$
  select exists (
    select 1 from public.deals d
     where d.id = p_deal_id
       and d.workspace_id = authz.my_workspace_id()
       and (d.assigned_to_id = authz.my_team_member_id() or d.user_id = (select auth.uid()))
  );
$fn$;
revoke all on function authz.owns_deal(text) from public, anon;
grant execute on function authz.owns_deal(text) to authenticated, service_role;
comment on function authz.owns_deal(text) is
  'Phase T2b-2. True when the deal is in the caller''s workspace AND assigned to them or created by them. SECURITY DEFINER to avoid child-policy recursion into deals'' own RLS; scoped to the caller''s workspace so it cannot probe another tenant.';

create or replace function authz.owns_contact(p_contact_id text)
returns boolean language sql stable security definer set search_path = '' as $fn$
  select exists (
    select 1 from public.contacts c
     where c.id = p_contact_id
       and c.workspace_id = authz.my_workspace_id()
       and (c.assigned_to_id = authz.my_team_member_id() or c.user_id = (select auth.uid()))
  );
$fn$;
revoke all on function authz.owns_contact(text) from public, anon;
grant execute on function authz.owns_contact(text) to authenticated, service_role;
comment on function authz.owns_contact(text) is
  'Phase T2b-2. True when the contact is in the caller''s workspace AND assigned to them or created by them. Same DEFINER rationale as authz.owns_deal.';

create or replace function authz.owns_rule(p_rule_id uuid)
returns boolean language sql stable security definer set search_path = '' as $fn$
  select exists (
    select 1 from public.automation_rules r
     where r.id = p_rule_id
       and r.workspace_id = authz.my_workspace_id()
       and (r.visibility = 'shared' and authz.my_can('automation_manage_shared')
            or r.user_id = (select auth.uid()))
  );
$fn$;
revoke all on function authz.owns_rule(uuid) from public, anon;
grant execute on function authz.owns_rule(uuid) to authenticated, service_role;
comment on function authz.owns_rule(uuid) is
  'Phase T2b-2. True when the automation rule is visible to the caller: in their workspace and either shared (with automation_manage_shared) or created by them.';

-- ============================================================
-- 1. Area tables. SELECT by view scope, INSERT needs create + own
--    identity, UPDATE by edit scope (workspace pinned by WITH CHECK),
--    DELETE by delete scope.
-- ============================================================
-- contacts (area: contacts)
drop policy if exists contacts_select_scoped on public.contacts;
create policy contacts_select_scoped on public.contacts
  for select to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (select authz.my_scope('contacts','view')) = 'all'
      or ((select authz.my_scope('contacts','view')) = 'own' and (assigned_to_id = (select authz.my_team_member_id()) or user_id = (select auth.uid())))
      or (assigned_to_id is null and (select authz.my_can('unassigned_view')))
    )
  );

drop policy if exists contacts_insert_scoped on public.contacts;
create policy contacts_insert_scoped on public.contacts
  for insert to authenticated
  with check (
    exists (
      select 1 from public.workspace_members m
       where m.workspace_id = contacts.workspace_id
         and m.user_id = (select auth.uid())
         and m.status = 'active'
    )
    and user_id = (select auth.uid())
    and (select authz.my_area_create('contacts'))
  );

drop policy if exists contacts_update_scoped on public.contacts;
create policy contacts_update_scoped on public.contacts
  for update to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (select authz.my_scope('contacts','edit')) = 'all'
      or ((select authz.my_scope('contacts','edit')) = 'own' and (assigned_to_id = (select authz.my_team_member_id()) or user_id = (select auth.uid())))
      or (assigned_to_id is null and (select authz.my_can('unassigned_claim')))
    )
  )
  with check (
    workspace_id = (select authz.my_workspace_id())
  );

drop policy if exists contacts_delete_scoped on public.contacts;
create policy contacts_delete_scoped on public.contacts
  for delete to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (select authz.my_scope('contacts','delete')) = 'all'
      or ((select authz.my_scope('contacts','delete')) = 'own' and (assigned_to_id = (select authz.my_team_member_id()) or user_id = (select auth.uid())))
    )
  );

-- deals (area: deals)
drop policy if exists deals_select_scoped on public.deals;
create policy deals_select_scoped on public.deals
  for select to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (select authz.my_scope('deals','view')) = 'all'
      or ((select authz.my_scope('deals','view')) = 'own' and (assigned_to_id = (select authz.my_team_member_id()) or user_id = (select auth.uid())))
    )
  );

drop policy if exists deals_insert_scoped on public.deals;
create policy deals_insert_scoped on public.deals
  for insert to authenticated
  with check (
    exists (
      select 1 from public.workspace_members m
       where m.workspace_id = deals.workspace_id
         and m.user_id = (select auth.uid())
         and m.status = 'active'
    )
    and user_id = (select auth.uid())
    and (select authz.my_area_create('deals'))
  );

drop policy if exists deals_update_scoped on public.deals;
create policy deals_update_scoped on public.deals
  for update to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (select authz.my_scope('deals','edit')) = 'all'
      or ((select authz.my_scope('deals','edit')) = 'own' and (assigned_to_id = (select authz.my_team_member_id()) or user_id = (select auth.uid())))
    )
  )
  with check (
    workspace_id = (select authz.my_workspace_id())
  );

drop policy if exists deals_delete_scoped on public.deals;
create policy deals_delete_scoped on public.deals
  for delete to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (select authz.my_scope('deals','delete')) = 'all'
      or ((select authz.my_scope('deals','delete')) = 'own' and (assigned_to_id = (select authz.my_team_member_id()) or user_id = (select auth.uid())))
    )
  );

-- tasks (area: work)
drop policy if exists tasks_select_scoped on public.tasks;
create policy tasks_select_scoped on public.tasks
  for select to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (select authz.my_scope('work','view')) = 'all'
      or ((select authz.my_scope('work','view')) = 'own' and (assigned_to_id = (select authz.my_team_member_id()) or user_id = (select auth.uid())))
    )
  );

drop policy if exists tasks_insert_scoped on public.tasks;
create policy tasks_insert_scoped on public.tasks
  for insert to authenticated
  with check (
    exists (
      select 1 from public.workspace_members m
       where m.workspace_id = tasks.workspace_id
         and m.user_id = (select auth.uid())
         and m.status = 'active'
    )
    and user_id = (select auth.uid())
    and (select authz.my_area_create('work'))
  );

drop policy if exists tasks_update_scoped on public.tasks;
create policy tasks_update_scoped on public.tasks
  for update to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (select authz.my_scope('work','edit')) = 'all'
      or ((select authz.my_scope('work','edit')) = 'own' and (assigned_to_id = (select authz.my_team_member_id()) or user_id = (select auth.uid())))
    )
  )
  with check (
    workspace_id = (select authz.my_workspace_id())
  );

drop policy if exists tasks_delete_scoped on public.tasks;
create policy tasks_delete_scoped on public.tasks
  for delete to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (select authz.my_scope('work','delete')) = 'all'
      or ((select authz.my_scope('work','delete')) = 'own' and (assigned_to_id = (select authz.my_team_member_id()) or user_id = (select auth.uid())))
    )
  );

-- scheduled_items (area: work)
drop policy if exists scheduled_items_select_scoped on public.scheduled_items;
create policy scheduled_items_select_scoped on public.scheduled_items
  for select to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (select authz.my_scope('work','view')) = 'all'
      or ((select authz.my_scope('work','view')) = 'own' and (assigned_to = (select authz.my_team_member_id()) or user_id = (select auth.uid())))
    )
  );

drop policy if exists scheduled_items_insert_scoped on public.scheduled_items;
create policy scheduled_items_insert_scoped on public.scheduled_items
  for insert to authenticated
  with check (
    exists (
      select 1 from public.workspace_members m
       where m.workspace_id = scheduled_items.workspace_id
         and m.user_id = (select auth.uid())
         and m.status = 'active'
    )
    and user_id = (select auth.uid())
    and (select authz.my_area_create('work'))
  );

drop policy if exists scheduled_items_update_scoped on public.scheduled_items;
create policy scheduled_items_update_scoped on public.scheduled_items
  for update to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (select authz.my_scope('work','edit')) = 'all'
      or ((select authz.my_scope('work','edit')) = 'own' and (assigned_to = (select authz.my_team_member_id()) or user_id = (select auth.uid())))
    )
  )
  with check (
    workspace_id = (select authz.my_workspace_id())
  );

drop policy if exists scheduled_items_delete_scoped on public.scheduled_items;
create policy scheduled_items_delete_scoped on public.scheduled_items
  for delete to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (select authz.my_scope('work','delete')) = 'all'
      or ((select authz.my_scope('work','delete')) = 'own' and (assigned_to = (select authz.my_team_member_id()) or user_id = (select auth.uid())))
    )
  );

-- activities (area: work)
drop policy if exists activities_select_scoped on public.activities;
create policy activities_select_scoped on public.activities
  for select to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (select authz.my_scope('work','view')) = 'all'
      or ((select authz.my_scope('work','view')) = 'own' and (user_id = (select auth.uid()) or (deal_id is not null and (select authz.owns_deal(deal_id))) or (contact_id is not null and (select authz.owns_contact(contact_id)))))
    )
  );

drop policy if exists activities_insert_scoped on public.activities;
create policy activities_insert_scoped on public.activities
  for insert to authenticated
  with check (
    exists (
      select 1 from public.workspace_members m
       where m.workspace_id = activities.workspace_id
         and m.user_id = (select auth.uid())
         and m.status = 'active'
    )
    and user_id = (select auth.uid())
    and (select authz.my_area_create('work'))
  );

drop policy if exists activities_update_scoped on public.activities;
create policy activities_update_scoped on public.activities
  for update to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (select authz.my_scope('work','edit')) = 'all'
      or ((select authz.my_scope('work','edit')) = 'own' and (user_id = (select auth.uid()) or (deal_id is not null and (select authz.owns_deal(deal_id))) or (contact_id is not null and (select authz.owns_contact(contact_id)))))
    )
  )
  with check (
    workspace_id = (select authz.my_workspace_id())
  );

drop policy if exists activities_delete_scoped on public.activities;
create policy activities_delete_scoped on public.activities
  for delete to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (select authz.my_scope('work','delete')) = 'all'
      or ((select authz.my_scope('work','delete')) = 'own' and (user_id = (select auth.uid()) or (deal_id is not null and (select authz.owns_deal(deal_id))) or (contact_id is not null and (select authz.owns_contact(contact_id)))))
    )
  );

-- showings (area: work)
drop policy if exists showings_select_scoped on public.showings;
create policy showings_select_scoped on public.showings
  for select to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (select authz.my_scope('work','view')) = 'all'
      or ((select authz.my_scope('work','view')) = 'own' and (user_id = (select auth.uid()) or (deal_id is not null and (select authz.owns_deal(deal_id)))))
    )
  );

drop policy if exists showings_insert_scoped on public.showings;
create policy showings_insert_scoped on public.showings
  for insert to authenticated
  with check (
    exists (
      select 1 from public.workspace_members m
       where m.workspace_id = showings.workspace_id
         and m.user_id = (select auth.uid())
         and m.status = 'active'
    )
    and user_id = (select auth.uid())
    and (select authz.my_area_create('work'))
  );

drop policy if exists showings_update_scoped on public.showings;
create policy showings_update_scoped on public.showings
  for update to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (select authz.my_scope('work','edit')) = 'all'
      or ((select authz.my_scope('work','edit')) = 'own' and (user_id = (select auth.uid()) or (deal_id is not null and (select authz.owns_deal(deal_id)))))
    )
  )
  with check (
    workspace_id = (select authz.my_workspace_id())
  );

drop policy if exists showings_delete_scoped on public.showings;
create policy showings_delete_scoped on public.showings
  for delete to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (select authz.my_scope('work','delete')) = 'all'
      or ((select authz.my_scope('work','delete')) = 'own' and (user_id = (select auth.uid()) or (deal_id is not null and (select authz.owns_deal(deal_id)))))
    )
  );

-- milestones (area: work)
drop policy if exists milestones_select_scoped on public.milestones;
create policy milestones_select_scoped on public.milestones
  for select to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (select authz.my_scope('work','view')) = 'all'
      or ((select authz.my_scope('work','view')) = 'own' and (deal_id is not null and (select authz.owns_deal(deal_id))))
    )
  );

drop policy if exists milestones_insert_scoped on public.milestones;
create policy milestones_insert_scoped on public.milestones
  for insert to authenticated
  with check (
    exists (
      select 1 from public.workspace_members m
       where m.workspace_id = milestones.workspace_id
         and m.user_id = (select auth.uid())
         and m.status = 'active'
    )
    and user_id = (select auth.uid())
    and (select authz.my_area_create('work'))
  );

drop policy if exists milestones_update_scoped on public.milestones;
create policy milestones_update_scoped on public.milestones
  for update to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (select authz.my_scope('work','edit')) = 'all'
      or ((select authz.my_scope('work','edit')) = 'own' and (deal_id is not null and (select authz.owns_deal(deal_id))))
    )
  )
  with check (
    workspace_id = (select authz.my_workspace_id())
  );

drop policy if exists milestones_delete_scoped on public.milestones;
create policy milestones_delete_scoped on public.milestones
  for delete to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (select authz.my_scope('work','delete')) = 'all'
      or ((select authz.my_scope('work','delete')) = 'own' and (deal_id is not null and (select authz.owns_deal(deal_id))))
    )
  );

-- properties (area: properties)
drop policy if exists properties_select_scoped on public.properties;
create policy properties_select_scoped on public.properties
  for select to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (select authz.my_scope('properties','view')) = 'all'
      or ((select authz.my_scope('properties','view')) = 'own' and (user_id = (select auth.uid()) or (deal_id is not null and (select authz.owns_deal(deal_id))) or (contact_id is not null and (select authz.owns_contact(contact_id)))))
    )
  );

drop policy if exists properties_insert_scoped on public.properties;
create policy properties_insert_scoped on public.properties
  for insert to authenticated
  with check (
    exists (
      select 1 from public.workspace_members m
       where m.workspace_id = properties.workspace_id
         and m.user_id = (select auth.uid())
         and m.status = 'active'
    )
    and user_id = (select auth.uid())
    and (select authz.my_area_create('properties'))
  );

drop policy if exists properties_update_scoped on public.properties;
create policy properties_update_scoped on public.properties
  for update to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (select authz.my_scope('properties','edit')) = 'all'
      or ((select authz.my_scope('properties','edit')) = 'own' and (user_id = (select auth.uid()) or (deal_id is not null and (select authz.owns_deal(deal_id))) or (contact_id is not null and (select authz.owns_contact(contact_id)))))
    )
  )
  with check (
    workspace_id = (select authz.my_workspace_id())
  );

drop policy if exists properties_delete_scoped on public.properties;
create policy properties_delete_scoped on public.properties
  for delete to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (select authz.my_scope('properties','delete')) = 'all'
      or ((select authz.my_scope('properties','delete')) = 'own' and (user_id = (select auth.uid()) or (deal_id is not null and (select authz.owns_deal(deal_id))) or (contact_id is not null and (select authz.owns_contact(contact_id)))))
    )
  );

-- finance_records (area: finance)
drop policy if exists finance_records_select_scoped on public.finance_records;
create policy finance_records_select_scoped on public.finance_records
  for select to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (select authz.my_scope('finance','view')) = 'all'
      or ((select authz.my_scope('finance','view')) = 'own' and (user_id = (select auth.uid())))
    )
  );

drop policy if exists finance_records_insert_scoped on public.finance_records;
create policy finance_records_insert_scoped on public.finance_records
  for insert to authenticated
  with check (
    exists (
      select 1 from public.workspace_members m
       where m.workspace_id = finance_records.workspace_id
         and m.user_id = (select auth.uid())
         and m.status = 'active'
    )
    and user_id = (select auth.uid())
    and (select authz.my_area_create('finance'))
  );

drop policy if exists finance_records_update_scoped on public.finance_records;
create policy finance_records_update_scoped on public.finance_records
  for update to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (select authz.my_scope('finance','edit')) = 'all'
      or ((select authz.my_scope('finance','edit')) = 'own' and (user_id = (select auth.uid())))
    )
  )
  with check (
    workspace_id = (select authz.my_workspace_id())
  );

drop policy if exists finance_records_delete_scoped on public.finance_records;
create policy finance_records_delete_scoped on public.finance_records
  for delete to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (select authz.my_scope('finance','delete')) = 'all'
      or ((select authz.my_scope('finance','delete')) = 'own' and (user_id = (select auth.uid())))
    )
  );

-- referrals (area: finance)
drop policy if exists referrals_select_scoped on public.referrals;
create policy referrals_select_scoped on public.referrals
  for select to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (select authz.my_scope('finance','view')) = 'all'
      or ((select authz.my_scope('finance','view')) = 'own' and (user_id = (select auth.uid())))
    )
  );

drop policy if exists referrals_insert_scoped on public.referrals;
create policy referrals_insert_scoped on public.referrals
  for insert to authenticated
  with check (
    exists (
      select 1 from public.workspace_members m
       where m.workspace_id = referrals.workspace_id
         and m.user_id = (select auth.uid())
         and m.status = 'active'
    )
    and user_id = (select auth.uid())
    and (select authz.my_area_create('finance'))
  );

drop policy if exists referrals_update_scoped on public.referrals;
create policy referrals_update_scoped on public.referrals
  for update to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (select authz.my_scope('finance','edit')) = 'all'
      or ((select authz.my_scope('finance','edit')) = 'own' and (user_id = (select auth.uid())))
    )
  )
  with check (
    workspace_id = (select authz.my_workspace_id())
  );

drop policy if exists referrals_delete_scoped on public.referrals;
create policy referrals_delete_scoped on public.referrals
  for delete to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (select authz.my_scope('finance','delete')) = 'all'
      or ((select authz.my_scope('finance','delete')) = 'own' and (user_id = (select auth.uid())))
    )
  );

-- goals (area: goals)
drop policy if exists goals_select_scoped on public.goals;
create policy goals_select_scoped on public.goals
  for select to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (select authz.my_scope('goals','view')) = 'all'
      or ((select authz.my_scope('goals','view')) = 'own' and (user_id = (select auth.uid())))
    )
  );

drop policy if exists goals_insert_scoped on public.goals;
create policy goals_insert_scoped on public.goals
  for insert to authenticated
  with check (
    exists (
      select 1 from public.workspace_members m
       where m.workspace_id = goals.workspace_id
         and m.user_id = (select auth.uid())
         and m.status = 'active'
    )
    and user_id = (select auth.uid())
    and (select authz.my_area_create('goals'))
  );

drop policy if exists goals_update_scoped on public.goals;
create policy goals_update_scoped on public.goals
  for update to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (select authz.my_scope('goals','edit')) = 'all'
      or ((select authz.my_scope('goals','edit')) = 'own' and (user_id = (select auth.uid())))
    )
  )
  with check (
    workspace_id = (select authz.my_workspace_id())
  );

drop policy if exists goals_delete_scoped on public.goals;
create policy goals_delete_scoped on public.goals
  for delete to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (select authz.my_scope('goals','delete')) = 'all'
      or ((select authz.my_scope('goals','delete')) = 'own' and (user_id = (select auth.uid())))
    )
  );

-- custom_field_values (area: contacts)
drop policy if exists custom_field_values_select_scoped on public.custom_field_values;
create policy custom_field_values_select_scoped on public.custom_field_values
  for select to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (select authz.my_scope('contacts','view')) = 'all'
      or ((select authz.my_scope('contacts','view')) = 'own' and (user_id = (select auth.uid())))
    )
  );

drop policy if exists custom_field_values_insert_scoped on public.custom_field_values;
create policy custom_field_values_insert_scoped on public.custom_field_values
  for insert to authenticated
  with check (
    exists (
      select 1 from public.workspace_members m
       where m.workspace_id = custom_field_values.workspace_id
         and m.user_id = (select auth.uid())
         and m.status = 'active'
    )
    and user_id = (select auth.uid())
    and (select authz.my_area_create('contacts'))
  );

drop policy if exists custom_field_values_update_scoped on public.custom_field_values;
create policy custom_field_values_update_scoped on public.custom_field_values
  for update to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (select authz.my_scope('contacts','edit')) = 'all'
      or ((select authz.my_scope('contacts','edit')) = 'own' and (user_id = (select auth.uid())))
    )
  )
  with check (
    workspace_id = (select authz.my_workspace_id())
  );

drop policy if exists custom_field_values_delete_scoped on public.custom_field_values;
create policy custom_field_values_delete_scoped on public.custom_field_values
  for delete to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (select authz.my_scope('contacts','delete')) = 'all'
      or ((select authz.my_scope('contacts','delete')) = 'own' and (user_id = (select auth.uid())))
    )
  );

-- ============================================================
-- 1b. The assignment / claim rule on contacts.
--
-- RLS decides WHICH rows you may update; this trigger decides whether
-- you may change the ASSIGNEE on one, which RLS alone cannot express
-- (it needs OLD vs NEW).
--
--   * assigned_to_id unchanged               -> always fine
--   * changing it, with contacts_assign      -> fine (admins, owner)
--   * claiming an UNASSIGNED lead for YOURSELF with unassigned_claim
--                                            -> fine
--   * anything else                          -> refused
--
-- It also pins workspace_id: no row may be moved between workspaces.
-- service_role (no JWT, so auth.uid() is null) is exempt — the Edge
-- Functions assign leads on the workspace's behalf.
-- ============================================================
create or replace function automation_internal.enforce_contact_assignment()
returns trigger language plpgsql security definer set search_path = ''
as $fn$
begin
  if new.workspace_id is distinct from old.workspace_id then
    raise exception 'a contact cannot be moved to another workspace'
      using errcode = '42501';
  end if;

  if new.assigned_to_id is not distinct from old.assigned_to_id then
    return new;
  end if;

  -- Trusted server-side callers (no JWT) may assign freely.
  if (select auth.uid()) is null then
    return new;
  end if;

  if authz.my_can('contacts_assign') then
    return new;
  end if;

  if old.assigned_to_id is null
     and new.assigned_to_id = authz.my_team_member_id()
     and authz.my_can('unassigned_claim') then
    return new;
  end if;

  raise exception 'changing the assigned agent needs contacts_assign (or unassigned_claim, to claim an unassigned lead for yourself)'
    using errcode = '42501';
end;
$fn$;
revoke all on function automation_internal.enforce_contact_assignment() from public, anon, authenticated;

drop trigger if exists contacts_enforce_assignment on public.contacts;
create trigger contacts_enforce_assignment
  before update on public.contacts
  for each row execute function automation_internal.enforce_contact_assignment();

-- ============================================================
-- 2. Library tables: shared rows readable by every member; personal
--    rows only by their creator (or a *_manage_shared holder).
--    Creating/editing a shared row needs *_manage_shared; a personal
--    row needs *_create_personal and creator = me.
-- ============================================================
-- scripts
drop policy if exists scripts_select_scoped on public.scripts;
create policy scripts_select_scoped on public.scripts
  for select to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      visibility = 'shared'
      or user_id = (select auth.uid())
      or (select authz.my_can('templates_manage_shared'))
    )
  );

drop policy if exists scripts_insert_scoped on public.scripts;
create policy scripts_insert_scoped on public.scripts
  for insert to authenticated
  with check (
    workspace_id = (select authz.my_workspace_id())
    and (
      (visibility = 'shared' and (select authz.my_can('templates_manage_shared')))
      or (visibility = 'personal' and user_id = (select auth.uid()) and (select authz.my_can('templates_create_personal')))
    )
    and user_id = (select auth.uid())
  );

drop policy if exists scripts_update_scoped on public.scripts;
create policy scripts_update_scoped on public.scripts
  for update to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (visibility = 'shared' and (select authz.my_can('templates_manage_shared')))
      or (visibility = 'personal' and user_id = (select auth.uid()) and (select authz.my_can('templates_create_personal')))
    )
  )
  with check (
    workspace_id = (select authz.my_workspace_id())
    and (
      (visibility = 'shared' and (select authz.my_can('templates_manage_shared')))
      or (visibility = 'personal' and user_id = (select auth.uid()) and (select authz.my_can('templates_create_personal')))
    )
  );

drop policy if exists scripts_delete_scoped on public.scripts;
create policy scripts_delete_scoped on public.scripts
  for delete to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (visibility = 'shared' and (select authz.my_can('templates_manage_shared')))
      or (visibility = 'personal' and user_id = (select auth.uid()) and (select authz.my_can('templates_create_personal')))
    )
  );

-- ai_prompts
drop policy if exists ai_prompts_select_scoped on public.ai_prompts;
create policy ai_prompts_select_scoped on public.ai_prompts
  for select to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      visibility = 'shared'
      or user_id = (select auth.uid())
      or (select authz.my_can('templates_manage_shared'))
    )
  );

drop policy if exists ai_prompts_insert_scoped on public.ai_prompts;
create policy ai_prompts_insert_scoped on public.ai_prompts
  for insert to authenticated
  with check (
    workspace_id = (select authz.my_workspace_id())
    and (
      (visibility = 'shared' and (select authz.my_can('templates_manage_shared')))
      or (visibility = 'personal' and user_id = (select auth.uid()) and (select authz.my_can('templates_create_personal')))
    )
    and user_id = (select auth.uid())
  );

drop policy if exists ai_prompts_update_scoped on public.ai_prompts;
create policy ai_prompts_update_scoped on public.ai_prompts
  for update to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (visibility = 'shared' and (select authz.my_can('templates_manage_shared')))
      or (visibility = 'personal' and user_id = (select auth.uid()) and (select authz.my_can('templates_create_personal')))
    )
  )
  with check (
    workspace_id = (select authz.my_workspace_id())
    and (
      (visibility = 'shared' and (select authz.my_can('templates_manage_shared')))
      or (visibility = 'personal' and user_id = (select auth.uid()) and (select authz.my_can('templates_create_personal')))
    )
  );

drop policy if exists ai_prompts_delete_scoped on public.ai_prompts;
create policy ai_prompts_delete_scoped on public.ai_prompts
  for delete to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (visibility = 'shared' and (select authz.my_can('templates_manage_shared')))
      or (visibility = 'personal' and user_id = (select auth.uid()) and (select authz.my_can('templates_create_personal')))
    )
  );

-- message_templates
drop policy if exists message_templates_select_scoped on public.message_templates;
create policy message_templates_select_scoped on public.message_templates
  for select to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      visibility = 'shared'
      or user_id = (select auth.uid())
      or (select authz.my_can('templates_manage_shared'))
    )
  );

drop policy if exists message_templates_insert_scoped on public.message_templates;
create policy message_templates_insert_scoped on public.message_templates
  for insert to authenticated
  with check (
    workspace_id = (select authz.my_workspace_id())
    and (
      (visibility = 'shared' and (select authz.my_can('templates_manage_shared')))
      or (visibility = 'personal' and user_id = (select auth.uid()) and (select authz.my_can('templates_create_personal')))
    )
    and user_id = (select auth.uid())
  );

drop policy if exists message_templates_update_scoped on public.message_templates;
create policy message_templates_update_scoped on public.message_templates
  for update to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (visibility = 'shared' and (select authz.my_can('templates_manage_shared')))
      or (visibility = 'personal' and user_id = (select auth.uid()) and (select authz.my_can('templates_create_personal')))
    )
  )
  with check (
    workspace_id = (select authz.my_workspace_id())
    and (
      (visibility = 'shared' and (select authz.my_can('templates_manage_shared')))
      or (visibility = 'personal' and user_id = (select auth.uid()) and (select authz.my_can('templates_create_personal')))
    )
  );

drop policy if exists message_templates_delete_scoped on public.message_templates;
create policy message_templates_delete_scoped on public.message_templates
  for delete to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (visibility = 'shared' and (select authz.my_can('templates_manage_shared')))
      or (visibility = 'personal' and user_id = (select auth.uid()) and (select authz.my_can('templates_create_personal')))
    )
  );

-- automation_rules (shared/personal + the pre-existing draft-only write rule)
drop policy if exists automation_rules_select_scoped on public.automation_rules;
create policy automation_rules_select_scoped on public.automation_rules
  for select to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      visibility = 'shared'
      or user_id = (select auth.uid())
      or (select authz.my_can('automation_manage_shared'))
    )
  );

drop policy if exists automation_rules_insert_scoped on public.automation_rules;
create policy automation_rules_insert_scoped on public.automation_rules
  for insert to authenticated
  with check (
    workspace_id = (select authz.my_workspace_id())
    and status = 'draft'
    and (
      (visibility = 'shared' and (select authz.my_can('automation_manage_shared')))
      or (visibility = 'personal' and user_id = (select auth.uid()) and (select authz.my_can('automation_create_personal')))
    )
    and user_id = (select auth.uid())
  );

drop policy if exists automation_rules_update_scoped on public.automation_rules;
create policy automation_rules_update_scoped on public.automation_rules
  for update to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and status = 'draft'
    and (
      (visibility = 'shared' and (select authz.my_can('automation_manage_shared')))
      or (visibility = 'personal' and user_id = (select auth.uid()) and (select authz.my_can('automation_create_personal')))
    )
  )
  with check (
    workspace_id = (select authz.my_workspace_id())
    and status = 'draft'
    and (
      (visibility = 'shared' and (select authz.my_can('automation_manage_shared')))
      or (visibility = 'personal' and user_id = (select auth.uid()) and (select authz.my_can('automation_create_personal')))
    )
  );

drop policy if exists automation_rules_delete_scoped on public.automation_rules;
create policy automation_rules_delete_scoped on public.automation_rules
  for delete to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and status = 'draft'
    and (
      (visibility = 'shared' and (select authz.my_can('automation_manage_shared')))
      or (visibility = 'personal' and user_id = (select auth.uid()) and (select authz.my_can('automation_create_personal')))
    )
  );

-- ============================================================
-- 3. Automation child tables inherit visibility from their rule.
--    automation_failures has no rule_id, so it falls back to the
--    workspace + automation_manage_shared/creator test.
-- ============================================================
drop policy if exists automation_steps_select_scoped on public.automation_steps;
create policy automation_steps_select_scoped on public.automation_steps
  for select to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (rule_id is not null and (select authz.owns_rule(rule_id)))
  );

drop policy if exists automation_enrollments_select_scoped on public.automation_enrollments;
create policy automation_enrollments_select_scoped on public.automation_enrollments
  for select to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (rule_id is not null and (select authz.owns_rule(rule_id)))
  );

drop policy if exists automation_jobs_select_scoped on public.automation_jobs;
create policy automation_jobs_select_scoped on public.automation_jobs
  for select to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (rule_id is not null and (select authz.owns_rule(rule_id)))
  );

drop policy if exists automation_runs_select_scoped on public.automation_runs;
create policy automation_runs_select_scoped on public.automation_runs
  for select to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      user_id = (select auth.uid())
      or (select authz.my_can('automation_manage_shared'))
    )
  );

drop policy if exists automation_failures_select_scoped on public.automation_failures;
create policy automation_failures_select_scoped on public.automation_failures
  for select to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      user_id = (select auth.uid())
      or (select authz.my_can('automation_manage_shared'))
    )
  );

-- automation_steps writes still require the parent rule to be draft.
drop policy if exists automation_steps_insert_scoped on public.automation_steps;
create policy automation_steps_insert_scoped on public.automation_steps
  for insert to authenticated
  with check (
    workspace_id = (select authz.my_workspace_id())
    and (select authz.owns_rule(rule_id))
    and exists (
      select 1 from public.automation_rules r
      where r.id = automation_steps.rule_id and r.status = 'draft'
    )
    and user_id = (select auth.uid())
  );

drop policy if exists automation_steps_update_scoped on public.automation_steps;
create policy automation_steps_update_scoped on public.automation_steps
  for update to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (select authz.owns_rule(rule_id))
    and exists (
      select 1 from public.automation_rules r
      where r.id = automation_steps.rule_id and r.status = 'draft'
    )
  )
  with check (
    workspace_id = (select authz.my_workspace_id())
    and (select authz.owns_rule(rule_id))
    and exists (
      select 1 from public.automation_rules r
      where r.id = automation_steps.rule_id and r.status = 'draft'
    )
  );

drop policy if exists automation_steps_delete_scoped on public.automation_steps;
create policy automation_steps_delete_scoped on public.automation_steps
  for delete to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (select authz.owns_rule(rule_id))
    and exists (
      select 1 from public.automation_rules r
      where r.id = automation_steps.rule_id and r.status = 'draft'
    )
  );

-- ============================================================
-- 4. Non-area tables, per the §7.0.8 read decisions.
-- ============================================================
-- notifications: strictly the recipient's own rows.
drop policy if exists notifications_select_scoped on public.notifications;
create policy notifications_select_scoped on public.notifications
  for select to authenticated
  using (
    workspace_id = (select authz.my_workspace_id()) and user_id = (select auth.uid())
  );

drop policy if exists notifications_update_scoped on public.notifications;
create policy notifications_update_scoped on public.notifications
  for update to authenticated
  using (
    workspace_id = (select authz.my_workspace_id()) and user_id = (select auth.uid())
  )
  with check (
    workspace_id = (select authz.my_workspace_id()) and user_id = (select auth.uid())
  );

-- workspace_settings: one row per workspace. Read at settings >= view,
-- write only at settings = edit.
drop policy if exists workspace_settings_select_scoped on public.workspace_settings;
create policy workspace_settings_select_scoped on public.workspace_settings
  for select to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (select authz.my_settings_level()) in ('view','edit')
  );

drop policy if exists workspace_settings_insert_scoped on public.workspace_settings;
create policy workspace_settings_insert_scoped on public.workspace_settings
  for insert to authenticated
  with check (
    workspace_id = (select authz.my_workspace_id())
    and (select authz.my_settings_level()) = 'edit'
  );

drop policy if exists workspace_settings_update_scoped on public.workspace_settings;
create policy workspace_settings_update_scoped on public.workspace_settings
  for update to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (select authz.my_settings_level()) = 'edit'
  )
  with check (
    workspace_id = (select authz.my_workspace_id())
    and (select authz.my_settings_level()) = 'edit'
  );

-- team_members: every member reads the directory (assignment dropdowns);
-- writing needs team_manage.
drop policy if exists team_members_select_scoped on public.team_members;
create policy team_members_select_scoped on public.team_members
  for select to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
  );

drop policy if exists team_members_insert_scoped on public.team_members;
create policy team_members_insert_scoped on public.team_members
  for insert to authenticated
  with check (
    workspace_id = (select authz.my_workspace_id()) and (select authz.my_can('team_manage'))
  );

drop policy if exists team_members_update_scoped on public.team_members;
create policy team_members_update_scoped on public.team_members
  for update to authenticated
  using (
    workspace_id = (select authz.my_workspace_id()) and (select authz.my_can('team_manage'))
  )
  with check (
    workspace_id = (select authz.my_workspace_id()) and (select authz.my_can('team_manage'))
  );

drop policy if exists team_members_delete_scoped on public.team_members;
create policy team_members_delete_scoped on public.team_members
  for delete to authenticated
  using (
    workspace_id = (select authz.my_workspace_id()) and (select authz.my_can('team_manage'))
  );

-- email_sender_profiles: your own sender row, or any with integrations_manage.
drop policy if exists email_sender_profiles_select_scoped on public.email_sender_profiles;
create policy email_sender_profiles_select_scoped on public.email_sender_profiles
  for select to authenticated
  using (
    workspace_id = (select authz.my_workspace_id()) and (user_id = (select auth.uid()) or (select authz.my_can('integrations_manage')))
  );

drop policy if exists email_sender_profiles_insert_scoped on public.email_sender_profiles;
create policy email_sender_profiles_insert_scoped on public.email_sender_profiles
  for insert to authenticated
  with check (
    workspace_id = (select authz.my_workspace_id()) and user_id = (select auth.uid())
  );

drop policy if exists email_sender_profiles_update_scoped on public.email_sender_profiles;
create policy email_sender_profiles_update_scoped on public.email_sender_profiles
  for update to authenticated
  using (
    workspace_id = (select authz.my_workspace_id()) and (user_id = (select auth.uid()) or (select authz.my_can('integrations_manage')))
  )
  with check (
    workspace_id = (select authz.my_workspace_id()) and (user_id = (select auth.uid()) or (select authz.my_can('integrations_manage')))
  );

-- Workspace-wide suppression / consent lists: every member may read.
drop policy if exists communication_consents_select_scoped on public.communication_consents;
create policy communication_consents_select_scoped on public.communication_consents
  for select to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
  );

drop policy if exists email_suppressions_select_scoped on public.email_suppressions;
create policy email_suppressions_select_scoped on public.email_suppressions
  for select to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
  );

-- outbound_messages: the send audit trail — team_manage holders only.
drop policy if exists outbound_messages_select_scoped on public.outbound_messages;
create policy outbound_messages_select_scoped on public.outbound_messages
  for select to authenticated
  using (
    workspace_id = (select authz.my_workspace_id()) and (select authz.my_can('team_manage'))
  );

-- Import history: your own uploads, or all of them with team_manage.
drop policy if exists lead_import_batches_select_scoped on public.lead_import_batches;
create policy lead_import_batches_select_scoped on public.lead_import_batches
  for select to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (select authz.my_can('imports_file'))
    and (user_id = (select auth.uid()) or (select authz.my_can('team_manage')))
  );

drop policy if exists lead_import_rows_select_scoped on public.lead_import_rows;
create policy lead_import_rows_select_scoped on public.lead_import_rows
  for select to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (select authz.my_can('imports_file'))
    and (user_id = (select auth.uid()) or (select authz.my_can('team_manage')))
  );

-- Sheets connections: integrations_manage.
drop policy if exists lead_source_connections_select_scoped on public.lead_source_connections;
create policy lead_source_connections_select_scoped on public.lead_source_connections
  for select to authenticated
  using (
    workspace_id = (select authz.my_workspace_id()) and (select authz.my_can('integrations_manage'))
  );

drop policy if exists lead_source_connections_insert_scoped on public.lead_source_connections;
create policy lead_source_connections_insert_scoped on public.lead_source_connections
  for insert to authenticated
  with check (
    workspace_id = (select authz.my_workspace_id()) and (select authz.my_can('integrations_manage'))
  );

drop policy if exists lead_source_connections_update_scoped on public.lead_source_connections;
create policy lead_source_connections_update_scoped on public.lead_source_connections
  for update to authenticated
  using (
    workspace_id = (select authz.my_workspace_id()) and (select authz.my_can('integrations_manage'))
  )
  with check (
    workspace_id = (select authz.my_workspace_id()) and (select authz.my_can('integrations_manage'))
  );

drop policy if exists lead_source_connections_delete_scoped on public.lead_source_connections;
create policy lead_source_connections_delete_scoped on public.lead_source_connections
  for delete to authenticated
  using (
    workspace_id = (select authz.my_workspace_id()) and (select authz.my_can('integrations_manage'))
  );

-- ============================================================
-- 5. Drop the superseded user_id policies, and remove browser read from
--    the four tables nothing in app/ reads (§7.0.8).
-- ============================================================
-- Dropped by an EXPLICIT inventory of the 101 superseded policies: the
-- 109 captured in supabase/rollback/ minus the 8 that must survive
-- (workspace_members, workspaces, the two authz tables, and
-- workspace_state's legacy four). Never by name pattern - a pattern also
-- matches workspace_members_select_own, which every authz helper reads
-- through; dropping it would null my_workspace_id() for everyone and
-- lock the entire app out.
do $drop$
declare r record;
begin
  for r in select * from (values
    ('activities', 'activities_delete_own'),
    ('activities', 'activities_insert_own'),
    ('activities', 'activities_select_own'),
    ('activities', 'activities_update_own'),
    ('ai_prompts', 'ai_prompts_delete_own'),
    ('ai_prompts', 'ai_prompts_insert_own'),
    ('ai_prompts', 'ai_prompts_select_own'),
    ('ai_prompts', 'ai_prompts_update_own'),
    ('automation_enrollments', 'automation_enrollments_select_own'),
    ('automation_failures', 'automation_failures_select_own'),
    ('automation_jobs', 'automation_jobs_select_own'),
    ('automation_rules', 'automation_rules_delete_own'),
    ('automation_rules', 'automation_rules_insert_own'),
    ('automation_rules', 'automation_rules_select_own'),
    ('automation_rules', 'automation_rules_update_own'),
    ('automation_runs', 'automation_runs_select_own'),
    ('automation_steps', 'automation_steps_delete_own'),
    ('automation_steps', 'automation_steps_insert_own'),
    ('automation_steps', 'automation_steps_select_own'),
    ('automation_steps', 'automation_steps_update_own'),
    ('automation_trigger_events', 'automation_trigger_events_select_own'),
    ('communication_consents', 'communication_consents_select_own'),
    ('contact_identity_keys', 'contact_identity_keys_select_own'),
    ('contacts', 'contacts_delete_own'),
    ('contacts', 'contacts_insert_own'),
    ('contacts', 'contacts_select_own'),
    ('contacts', 'contacts_update_own'),
    ('custom_field_values', 'custom_field_values_delete_own'),
    ('custom_field_values', 'custom_field_values_insert_own'),
    ('custom_field_values', 'custom_field_values_select_own'),
    ('custom_field_values', 'custom_field_values_update_own'),
    ('deals', 'deals_delete_own'),
    ('deals', 'deals_insert_own'),
    ('deals', 'deals_select_own'),
    ('deals', 'deals_update_own'),
    ('email_sender_profiles', 'email_sender_profiles_insert_own'),
    ('email_sender_profiles', 'email_sender_profiles_select_own'),
    ('email_sender_profiles', 'email_sender_profiles_update_own'),
    ('email_suppressions', 'email_suppressions_select_own'),
    ('finance_records', 'finance_records_delete_own'),
    ('finance_records', 'finance_records_insert_own'),
    ('finance_records', 'finance_records_select_own'),
    ('finance_records', 'finance_records_update_own'),
    ('goals', 'goals_delete_own'),
    ('goals', 'goals_insert_own'),
    ('goals', 'goals_select_own'),
    ('goals', 'goals_update_own'),
    ('lead_import_batches', 'lead_import_batches_select_own'),
    ('lead_import_rows', 'lead_import_rows_select_own'),
    ('lead_source_connections', 'lead_source_connections_delete_own'),
    ('lead_source_connections', 'lead_source_connections_insert_own'),
    ('lead_source_connections', 'lead_source_connections_select_own'),
    ('lead_source_connections', 'lead_source_connections_update_own'),
    ('lead_source_mappings', 'lead_source_mappings_delete_own'),
    ('lead_source_mappings', 'lead_source_mappings_insert_own'),
    ('lead_source_mappings', 'lead_source_mappings_select_own'),
    ('lead_source_mappings', 'lead_source_mappings_update_own'),
    ('message_templates', 'message_templates_delete_own'),
    ('message_templates', 'message_templates_insert_own'),
    ('message_templates', 'message_templates_select_own'),
    ('message_templates', 'message_templates_update_own'),
    ('milestones', 'milestones_delete_own'),
    ('milestones', 'milestones_insert_own'),
    ('milestones', 'milestones_select_own'),
    ('milestones', 'milestones_update_own'),
    ('notifications', 'notifications_select_own'),
    ('notifications', 'notifications_update_own'),
    ('outbound_messages', 'outbound_messages_select_own'),
    ('properties', 'properties_delete_own'),
    ('properties', 'properties_insert_own'),
    ('properties', 'properties_select_own'),
    ('properties', 'properties_update_own'),
    ('referrals', 'referrals_delete_own'),
    ('referrals', 'referrals_insert_own'),
    ('referrals', 'referrals_select_own'),
    ('referrals', 'referrals_update_own'),
    ('scheduled_items', 'scheduled_items_delete_own'),
    ('scheduled_items', 'scheduled_items_insert_own'),
    ('scheduled_items', 'scheduled_items_select_own'),
    ('scheduled_items', 'scheduled_items_update_own'),
    ('scripts', 'scripts_delete_own'),
    ('scripts', 'scripts_insert_own'),
    ('scripts', 'scripts_select_own'),
    ('scripts', 'scripts_update_own'),
    ('showings', 'showings_delete_own'),
    ('showings', 'showings_insert_own'),
    ('showings', 'showings_select_own'),
    ('showings', 'showings_update_own'),
    ('tasks', 'tasks_delete_own'),
    ('tasks', 'tasks_insert_own'),
    ('tasks', 'tasks_select_own'),
    ('tasks', 'tasks_update_own'),
    ('team_members', 'team_members_delete_own'),
    ('team_members', 'team_members_insert_own'),
    ('team_members', 'team_members_select_own'),
    ('team_members', 'team_members_update_own'),
    ('webhook_events', 'webhook_events_select_own'),
    ('workspace_settings', 'workspace_settings_delete_own'),
    ('workspace_settings', 'workspace_settings_insert_own'),
    ('workspace_settings', 'workspace_settings_select_own'),
    ('workspace_settings', 'workspace_settings_update_own')
  ) as v(tbl, pol)
  loop
    execute format('drop policy if exists %I on public.%I', r.pol, r.tbl);
  end loop;
end $drop$;

-- Legacy workspace_state keeps its user_id policies: it is the
-- pre-relational table, has no workspace_id, and nothing reads it.
-- (Simplest safe option; noted rather than migrated.)

-- ============================================================
-- 6. anon loses every table privilege in public. Nothing in the app
--    uses the anon role for data (auth happens first), so SELECT goes
--    too, not just the writes.
-- ============================================================
do $anon$
declare t record;
begin
  for t in select c.relname from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r'
  loop
    execute format('revoke all on public.%I from anon', t.relname);
  end loop;
end $anon$;
