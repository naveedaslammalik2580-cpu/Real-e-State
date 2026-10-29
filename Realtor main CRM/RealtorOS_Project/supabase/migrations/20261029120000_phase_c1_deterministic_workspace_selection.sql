-- Phase C-1: deterministic workspace selection.
--
-- THE DEFECT. Eleven functions resolved "the caller's workspace" with a
-- bare LIMIT 1 and no ORDER BY over the caller's ACTIVE memberships:
--
--   authz.my_workspace_id(), authz.my_team_member_id(), authz.my_role()
--   automation_internal.ensure_personal_workspace(uuid)
--   automation_internal.workspace_of(uuid)
--   public.realtoros_my_permissions()
--   public.realtoros_set_role_permissions(text, jsonb)
--   public.realtoros_set_member_permissions(uuid, jsonb)
--   public.realtoros_reset_member_permissions(uuid)
--   public.realtoros_register_push_subscription(text, text, text, text)
--   public.realtoros_set_notification_preferences(boolean, text[], time, time)
--
-- Postgres returns an unspecified row for LIMIT 1 without ORDER BY, so
-- IF a user ever held two active memberships, different calls could
-- route them to different workspaces in the same session. Every T2b-2
-- RLS policy depends on the authz.* helpers, so the blast radius would
-- be the whole workspace isolation model.
--
-- WHY IT IS LATENT TODAY (found while writing the regression tests,
-- 2026-10-29): T2a enforces one ACTIVE membership per person with the
-- partial unique index workspace_members_one_active_per_user, an owner
-- decision recorded in that migration, and T3's accept-invitation flow
-- removes the previous active membership before activating a new one.
-- So at most one row can match status='active' today, and the bare
-- LIMIT 1 is deterministic in effect. This migration is therefore
-- defense-in-depth, not a behaviour change: it makes the selection
-- rule explicit in the functions themselves, so the day the
-- one-active-membership constraint is ever relaxed (a multi-team
-- feature is the obvious candidate), the routing is already defined
-- instead of silently becoming unspecified.
--
-- THE RULE (identical in all eleven places, and total - no ties):
--
--   order by (case when workspaces.owner_user_id = <the user> then 0
--                  else 1 end),          -- an owned workspace first
--            workspaces.created_at,       -- then the earliest created
--            workspaces.id;               -- uuid primary key: final tiebreak
--
-- workspaces.id is unique, so the ordering can never tie and every call
-- returns the same workspace for the same user until membership or
-- ownership actually changes.
--
-- WHAT THIS MIGRATION DOES NOT DO. No table, column, index, constraint
-- or RLS policy is created, altered or dropped; no data is written.
-- Function names, signatures, return types, SECURITY DEFINER settings,
-- search_path hardening, grants and comments are preserved verbatim -
-- only the membership pick inside each body gains the join + ORDER BY.
-- (The second LIMIT 1 in the three set/reset RPCs is an audit-log name
-- lookup on team_members scoped to the already-chosen workspace and the
-- caller; it is not a workspace selection and is deliberately untouched.)
--
-- The revert file is supabase/rollback/phase_c1_deterministic_workspace_selection_revert.sql
-- and restores the previous definitions byte for byte.
--
-- NOT APPLIED to any live project by this file's existence: it joins the
-- chain for the next owner-run application, like every migration here.


-- ============================================================
-- 1. authz.my_workspace_id (was: 20261005140817_phase_t2b1_permissions.sql)
create or replace function authz.my_workspace_id()
returns uuid language sql stable set search_path = '' as $fn$
  select wm.workspace_id from public.workspace_members wm
    join public.workspaces w on w.id = wm.workspace_id
    where wm.user_id = (select auth.uid()) and wm.status = 'active'
    order by (case when w.owner_user_id = (select auth.uid()) then 0 else 1 end), w.created_at, w.id
    limit 1;
$fn$;
revoke all on function authz.my_workspace_id() from public, anon;
grant execute on function authz.my_workspace_id() to authenticated, service_role;

-- 2. authz.my_team_member_id (was: 20261005140817_phase_t2b1_permissions.sql)
create or replace function authz.my_team_member_id()
returns text language sql stable set search_path = '' as $fn$
  select wm.team_member_id from public.workspace_members wm
    join public.workspaces w on w.id = wm.workspace_id
    where wm.user_id = (select auth.uid()) and wm.status = 'active'
    order by (case when w.owner_user_id = (select auth.uid()) then 0 else 1 end), w.created_at, w.id
    limit 1;
$fn$;
revoke all on function authz.my_team_member_id() from public, anon;
grant execute on function authz.my_team_member_id() to authenticated, service_role;

-- 3. authz.my_role (was: 20261005140817_phase_t2b1_permissions.sql)
create or replace function authz.my_role()
returns text language sql stable set search_path = '' as $fn$
  select wm.role from public.workspace_members wm
    join public.workspaces w on w.id = wm.workspace_id
    where wm.user_id = (select auth.uid()) and wm.status = 'active'
    order by (case when w.owner_user_id = (select auth.uid()) then 0 else 1 end), w.created_at, w.id
    limit 1;
$fn$;
revoke all on function authz.my_role() from public, anon;
grant execute on function authz.my_role() to authenticated, service_role;

-- 4. automation_internal.ensure_personal_workspace (was: 20261005140817_phase_t2b1_permissions.sql (superseding the T2a definition))
create or replace function automation_internal.ensure_personal_workspace(p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_workspace_id uuid;
  v_team_member_id text;
  v_email text;
begin
  if p_user_id is null then
    raise exception 'ensure_personal_workspace: user_id is null' using errcode = '22023';
  end if;

  select wm.workspace_id into v_workspace_id
    from public.workspace_members wm
    join public.workspaces w on w.id = wm.workspace_id
    where wm.user_id = p_user_id and wm.status = 'active'
    order by (case when w.owner_user_id = p_user_id then 0 else 1 end), w.created_at, w.id
    limit 1;
  if v_workspace_id is not null then
    return v_workspace_id;
  end if;

  select to_jsonb(u) ->> 'email' into v_email
    from auth.users u where u.id = p_user_id;

  insert into public.workspaces (name, owner_user_id)
    values ('My workspace', p_user_id)
    returning id into v_workspace_id;

  insert into public.workspace_members (
    workspace_id, user_id, role, status, team_member_id
  )
  values (v_workspace_id, p_user_id, 'owner', 'active', null);

  v_team_member_id := 'tm_' || replace(p_user_id::text, '-', '');
  insert into public.team_members (
    id, user_id, workspace_id, auth_user_id,
    name, role, email, phone, active
  )
  values (
    v_team_member_id, p_user_id, v_workspace_id, p_user_id,
    coalesce(nullif(v_email, ''), 'Owner'), 'Owner',
    coalesce(v_email, ''), '', true
  )
  on conflict (user_id, id) do nothing;

  update public.workspace_members
    set team_member_id = v_team_member_id
    where workspace_id = v_workspace_id
      and user_id = p_user_id
      and team_member_id is null;

  -- Seed the role templates for this workspace. Idempotent: re-running
  -- the function returns the existing workspace at the top, so this
  -- block never fires twice; the on-conflict is belt-and-braces for a
  -- future call path.
  insert into public.workspace_role_permissions (workspace_id, role, permissions, updated_by)
    values
      (v_workspace_id, 'admin', automation_internal.default_role_permissions('admin'), p_user_id),
      (v_workspace_id, 'agent', automation_internal.default_role_permissions('agent'), p_user_id)
    on conflict (workspace_id, role) do nothing;

  return v_workspace_id;
end;
$fn$;

-- 5. automation_internal.workspace_of (was: 20261006132041_phase_t2c_workspace_backend.sql)
create or replace function automation_internal.workspace_of(p_user_id uuid)
returns uuid language sql stable set search_path = '' as $fn$
  select wm.workspace_id from public.workspace_members wm
   join public.workspaces w on w.id = wm.workspace_id
   where wm.user_id = p_user_id and wm.status = 'active'
   order by (case when w.owner_user_id = p_user_id then 0 else 1 end), w.created_at, w.id
   limit 1;
$fn$;
revoke all on function automation_internal.workspace_of(uuid) from public, anon, authenticated;
grant execute on function automation_internal.workspace_of(uuid) to service_role;
comment on function automation_internal.workspace_of(uuid) is
  'Phase T2c. The one active workspace of a user (one active membership per person is a hard invariant from T2a). service_role only.';

-- 6. public.realtoros_my_permissions (was: 20261005140817_phase_t2b1_permissions.sql)
create or replace function public.realtoros_my_permissions()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_wm record;
  v_perms jsonb;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select wm.workspace_id, wm.role, wm.team_member_id, wm.id as member_id
    into v_wm
    from public.workspace_members wm
    join public.workspaces w on w.id = wm.workspace_id
    where wm.user_id = v_uid and wm.status = 'active'
    order by (case when w.owner_user_id = v_uid then 0 else 1 end), w.created_at, w.id
    limit 1;
  if v_wm.workspace_id is null then
    return null;
  end if;
  if v_wm.role = 'owner' then
    v_perms := automation_internal.default_role_permissions('admin');
  else
    select automation_internal.merge_permissions(
      coalesce(wrp.permissions, automation_internal.default_role_permissions(v_wm.role)),
      coalesce(wm2.permission_overrides, '{}'::jsonb)
    ) into v_perms
    from public.workspace_members wm2
    left join public.workspace_role_permissions wrp
      on wrp.workspace_id = v_wm.workspace_id and wrp.role = v_wm.role
    where wm2.id = v_wm.member_id;
  end if;
  return jsonb_build_object(
    'workspace_id', v_wm.workspace_id,
    'role', v_wm.role,
    'team_member_id', v_wm.team_member_id,
    'member_id', v_wm.member_id,
    'permissions', v_perms
  );
end;
$fn$;
revoke all on function public.realtoros_my_permissions() from public, anon;
grant execute on function public.realtoros_my_permissions() to authenticated;
comment on function public.realtoros_my_permissions() is
  'Phase T2b-1. Returns {workspace_id, role, team_member_id, member_id, permissions} for the caller''s active workspace membership (null if none). SECURITY DEFINER + search_path=''; authenticated-only.';

-- 7. public.realtoros_set_role_permissions (was: 20261005140817_phase_t2b1_permissions.sql)
create or replace function public.realtoros_set_role_permissions(
  p_role text,
  p_permissions jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_actor record;
  v_actor_effective jsonb;
  v_denial text;
  v_before jsonb;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  if p_role not in ('admin','agent') then
    raise exception 'role must be admin or agent (owner is implicit full)' using errcode = '22023';
  end if;

  select wm.workspace_id, wm.role, wm.id as member_id
    into v_actor
    from public.workspace_members wm
    join public.workspaces w on w.id = wm.workspace_id
    where wm.user_id = v_uid and wm.status = 'active'
    order by (case when w.owner_user_id = v_uid then 0 else 1 end), w.created_at, w.id
    limit 1;
  if v_actor.workspace_id is null then
    raise exception 'no active workspace membership' using errcode = '42501';
  end if;

  if v_actor.role = 'owner' then
    v_actor_effective := automation_internal.default_role_permissions('admin');
  else
    v_actor_effective := authz.effective_permissions(v_actor.workspace_id);
    if not coalesce((v_actor_effective ->> 'team_manage')::boolean, false) then
      raise exception 'team_manage required' using errcode = '42501';
    end if;
  end if;

  -- Shape + ordering validation first (also runs through the trigger
  -- on INSERT, but we want to raise cleaner errors before auditing).
  perform automation_internal.validate_permissions(p_permissions, false);

  -- Grant limit: no key may exceed the actor's own effective permission.
  v_denial := automation_internal.permissions_within_actor(v_actor_effective, p_permissions);
  if v_denial is not null then
    raise exception '%', v_denial using errcode = '42501';
  end if;

  select wrp.permissions into v_before
    from public.workspace_role_permissions wrp
    where wrp.workspace_id = v_actor.workspace_id and wrp.role = p_role;

  insert into public.workspace_role_permissions (workspace_id, role, permissions, updated_by)
    values (v_actor.workspace_id, p_role, p_permissions, v_uid)
    on conflict (workspace_id, role)
    do update set permissions = excluded.permissions, updated_by = v_uid;

  insert into public.workspace_permission_changes
    (workspace_id, actor_user_id, actor_label,
     target_role, target_member_id, target_label,
     action, before_permissions, after_permissions)
    values (
      v_actor.workspace_id, v_uid,
      coalesce(
        (select to_jsonb(u) ->> 'email' from auth.users u where u.id = v_uid),
        (select tm.name from public.team_members tm
          where tm.workspace_id = v_actor.workspace_id and tm.auth_user_id = v_uid
          limit 1),
        ''
      ),
      p_role, null, 'role:' || p_role,
      'set_role', v_before, p_permissions
    );

  return jsonb_build_object('workspace_id', v_actor.workspace_id, 'role', p_role, 'permissions', p_permissions);
end;
$fn$;
revoke all on function public.realtoros_set_role_permissions(text, jsonb) from public, anon;
grant execute on function public.realtoros_set_role_permissions(text, jsonb) to authenticated;
comment on function public.realtoros_set_role_permissions(text, jsonb) is
  'Phase T2b-1. Updates the workspace''s role template for admin or agent. Caller must be owner, or an active member with team_manage. No key may exceed the caller''s own effective permission. Writes an audit row. Owner is never a valid target (role is implicit full).';

-- 8. public.realtoros_set_member_permissions (was: 20261005140817_phase_t2b1_permissions.sql)
create or replace function public.realtoros_set_member_permissions(
  p_member_id uuid,
  p_overrides jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_actor record;
  v_target record;
  v_actor_effective jsonb;
  v_target_role_template jsonb;
  v_proposed_effective jsonb;
  v_target_prior_effective jsonb;
  v_denial text;
  v_before jsonb;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;

  select wm.workspace_id, wm.role, wm.id as member_id
    into v_actor
    from public.workspace_members wm
    join public.workspaces w on w.id = wm.workspace_id
    where wm.user_id = v_uid and wm.status = 'active'
    order by (case when w.owner_user_id = v_uid then 0 else 1 end), w.created_at, w.id
    limit 1;
  if v_actor.workspace_id is null then
    raise exception 'no active workspace membership' using errcode = '42501';
  end if;

  select wm.workspace_id, wm.role, wm.permission_overrides, wm.id, wm.user_id, wm.team_member_id
    into v_target
    from public.workspace_members wm
    where wm.id = p_member_id;
  if v_target.id is null then
    raise exception 'target member not found' using errcode = '42704';
  end if;
  if v_target.workspace_id <> v_actor.workspace_id then
    raise exception 'target member is in a different workspace' using errcode = '42501';
  end if;
  if v_target.role = 'owner' then
    raise exception 'the Owner''s permissions are not editable' using errcode = '42501';
  end if;

  if v_actor.role = 'owner' then
    v_actor_effective := automation_internal.default_role_permissions('admin');
  else
    v_actor_effective := authz.effective_permissions(v_actor.workspace_id);
    if not coalesce((v_actor_effective ->> 'team_manage')::boolean, false) then
      raise exception 'team_manage required' using errcode = '42501';
    end if;
  end if;

  perform automation_internal.validate_permissions(coalesce(p_overrides, '{}'::jsonb), true);

  -- Overrides must land <= the actor's own effective permissions.
  v_denial := automation_internal.permissions_within_actor(v_actor_effective, p_overrides);
  if v_denial is not null then
    raise exception '%', v_denial using errcode = '42501';
  end if;

  -- Compute proposed effective permission for the target and enforce
  -- edit/delete <= view inside each area after the merge.
  select wrp.permissions into v_target_role_template
    from public.workspace_role_permissions wrp
    where wrp.workspace_id = v_target.workspace_id and wrp.role = v_target.role;
  if v_target_role_template is null then
    v_target_role_template := automation_internal.default_role_permissions(v_target.role);
  end if;
  v_proposed_effective := automation_internal.merge_permissions(v_target_role_template, coalesce(p_overrides, '{}'::jsonb));
  -- Re-validate as a role (every key present, including the ordering
  -- rule). validate_permissions with p_is_overrides=false enforces it.
  perform automation_internal.validate_permissions(v_proposed_effective, false);

  -- Self-raise guard: when the actor is editing their own membership,
  -- the proposed effective permissions must not exceed the actor's
  -- *current* effective permissions on any key.
  if v_actor.member_id = v_target.id then
    v_denial := automation_internal.permissions_within_actor(v_actor_effective, v_proposed_effective);
    if v_denial is not null then
      raise exception 'cannot raise your own permissions: %', v_denial using errcode = '42501';
    end if;
  end if;

  -- Record the before snapshot (overrides) so the audit stays small.
  v_before := v_target.permission_overrides;

  update public.workspace_members
    set permission_overrides = coalesce(p_overrides, '{}'::jsonb),
        updated_at = now()
    where id = p_member_id;

  insert into public.workspace_permission_changes
    (workspace_id, actor_user_id, actor_label,
     target_role, target_member_id, target_label,
     action, before_permissions, after_permissions)
    values (
      v_actor.workspace_id, v_uid,
      coalesce(
        (select to_jsonb(u) ->> 'email' from auth.users u where u.id = v_uid),
        (select tm.name from public.team_members tm
          where tm.workspace_id = v_actor.workspace_id and tm.auth_user_id = v_uid
          limit 1),
        ''
      ),
      null, p_member_id,
      coalesce(
        (select tm.name from public.team_members tm
          where tm.workspace_id = v_target.workspace_id and tm.id = v_target.team_member_id),
        (select to_jsonb(u) ->> 'email' from auth.users u where u.id = v_target.user_id),
        'member:' || p_member_id::text
      ),
      'set_member', v_before, p_overrides
    );

  return jsonb_build_object('member_id', p_member_id, 'overrides', coalesce(p_overrides, '{}'::jsonb));
end;
$fn$;
revoke all on function public.realtoros_set_member_permissions(uuid, jsonb) from public, anon;
grant execute on function public.realtoros_set_member_permissions(uuid, jsonb) to authenticated;
comment on function public.realtoros_set_member_permissions(uuid, jsonb) is
  'Phase T2b-1. Sets per-member permission_overrides. Caller must have team_manage (or be owner); may not target the Owner; may not grant above their own effective permissions; may not raise their own permissions through self-edit. Writes an audit row.';

-- 9. public.realtoros_reset_member_permissions (was: 20261005140817_phase_t2b1_permissions.sql)
create or replace function public.realtoros_reset_member_permissions(p_member_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_actor record;
  v_target record;
  v_before jsonb;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  select wm.workspace_id, wm.role
    into v_actor
    from public.workspace_members wm
    join public.workspaces w on w.id = wm.workspace_id
    where wm.user_id = v_uid and wm.status = 'active'
    order by (case when w.owner_user_id = v_uid then 0 else 1 end), w.created_at, w.id
    limit 1;
  if v_actor.workspace_id is null then
    raise exception 'no active workspace membership' using errcode = '42501';
  end if;
  select wm.workspace_id, wm.role, wm.permission_overrides, wm.id, wm.user_id, wm.team_member_id
    into v_target
    from public.workspace_members wm
    where wm.id = p_member_id;
  if v_target.id is null then
    raise exception 'target member not found' using errcode = '42704';
  end if;
  if v_target.workspace_id <> v_actor.workspace_id then
    raise exception 'target member is in a different workspace' using errcode = '42501';
  end if;
  if v_target.role = 'owner' then
    raise exception 'the Owner''s permissions are not editable' using errcode = '42501';
  end if;
  if v_actor.role <> 'owner'
     and not coalesce((authz.effective_permissions(v_actor.workspace_id) ->> 'team_manage')::boolean, false) then
    raise exception 'team_manage required' using errcode = '42501';
  end if;

  v_before := v_target.permission_overrides;
  update public.workspace_members
    set permission_overrides = '{}'::jsonb, updated_at = now()
    where id = p_member_id;
  insert into public.workspace_permission_changes
    (workspace_id, actor_user_id, actor_label,
     target_role, target_member_id, target_label,
     action, before_permissions, after_permissions)
    values (
      v_actor.workspace_id, v_uid,
      coalesce(
        (select to_jsonb(u) ->> 'email' from auth.users u where u.id = v_uid),
        (select tm.name from public.team_members tm
          where tm.workspace_id = v_actor.workspace_id and tm.auth_user_id = v_uid
          limit 1),
        ''
      ),
      null, p_member_id,
      coalesce(
        (select tm.name from public.team_members tm
          where tm.workspace_id = v_target.workspace_id and tm.id = v_target.team_member_id),
        (select to_jsonb(u) ->> 'email' from auth.users u where u.id = v_target.user_id),
        'member:' || p_member_id::text
      ),
      'reset_member', v_before, '{}'::jsonb
    );
  return jsonb_build_object('member_id', p_member_id, 'overrides', '{}'::jsonb);
end;
$fn$;
revoke all on function public.realtoros_reset_member_permissions(uuid) from public, anon;
grant execute on function public.realtoros_reset_member_permissions(uuid) to authenticated;
comment on function public.realtoros_reset_member_permissions(uuid) is
  'Phase T2b-1. Clears a member''s permission_overrides to {}. Same authorization rules as realtoros_set_member_permissions. Writes an audit row.';

-- 10. public.realtoros_register_push_subscription (was: 20261015170000_phase_3b_push.sql)
create or replace function public.realtoros_register_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_label text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_user uuid := (select auth.uid());
  v_workspace uuid;
  v_label text := left(btrim(coalesce(p_label, '')), 60);
  v_id uuid;
  v_reassigned boolean := false;
begin
  if v_user is null then
    return jsonb_build_object('outcome', 'not_signed_in');
  end if;

  select wm.workspace_id into v_workspace
    from public.workspace_members wm
   join public.workspaces w on w.id = wm.workspace_id
   where wm.user_id = v_user and wm.status = 'active'
   order by (case when w.owner_user_id = v_user then 0 else 1 end), w.created_at, w.id
   limit 1;
  if v_workspace is null then
    return jsonb_build_object('outcome', 'no_workspace');
  end if;

  -- Shape only. The endpoint and keys are minted by the browser's push
  -- service and are opaque to us; what matters is that they are the right
  -- sort of thing and cannot be a novel.
  if p_endpoint is null or p_endpoint !~ '^https://' or char_length(p_endpoint) > 2000
     or char_length(p_endpoint) < 20 then
    return jsonb_build_object('outcome', 'invalid_endpoint');
  end if;
  if p_p256dh is null or char_length(p_p256dh) not between 20 and 200
     or p_auth is null or char_length(p_auth) not between 8 and 64 then
    return jsonb_build_object('outcome', 'invalid_keys');
  end if;
  -- Control characters would travel into a header or a log.
  if p_endpoint ~ '[\x00-\x1F\x7F]' or p_p256dh ~ '[^A-Za-z0-9_=-]' or p_auth ~ '[^A-Za-z0-9_=-]' then
    return jsonb_build_object('outcome', 'invalid_keys');
  end if;
  v_label := regexp_replace(v_label, '[\x00-\x1F\x7F]', '', 'g');

  -- Did this endpoint already belong to somebody else? Worth saying so in
  -- the answer, because it is the one case that removes another person's
  -- device - a shared iPad, or a colleague signing in on this browser.
  select (s.user_id <> v_user) into v_reassigned
    from public.push_subscriptions s where s.endpoint = p_endpoint;

  insert into public.push_subscriptions
    (workspace_id, user_id, endpoint, p256dh, auth, device_label)
  values (v_workspace, v_user, p_endpoint, p_p256dh, p_auth, v_label)
  on conflict (endpoint) do update
    set workspace_id = excluded.workspace_id,
        user_id = excluded.user_id,
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        -- A re-register with no label keeps the one that is there, so a
        -- silent refresh does not wipe what the agent typed.
        device_label = case when excluded.device_label = '' then public.push_subscriptions.device_label
                            else excluded.device_label end,
        -- A browser that just re-subscribed is healthy whatever happened
        -- to the endpoint it replaced.
        failure_count = 0
  returning id into v_id;

  return jsonb_build_object(
    'outcome', 'registered',
    'id', v_id,
    'reassigned', coalesce(v_reassigned, false));
end;
$fn$;
revoke all on function public.realtoros_register_push_subscription(text, text, text, text)
  from public, anon;
grant execute on function public.realtoros_register_push_subscription(text, text, text, text)
  to authenticated;
comment on function public.realtoros_register_push_subscription(text, text, text, text) is
  'Phase 3B. Records this browser as a push device for the signed-in user. The owner and workspace come from the session, never the request. Re-registering the same endpoint updates it; an endpoint that belonged to another user moves to the caller.';

-- 11. public.realtoros_set_notification_preferences (was: 20261015170000_phase_3b_push.sql)
create or replace function public.realtoros_set_notification_preferences(
  p_push_enabled boolean,
  p_push_types text[],
  p_quiet_start time default null,
  p_quiet_end time default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_user uuid := (select auth.uid());
  v_workspace uuid;
  v_types text[];
begin
  if v_user is null then
    return jsonb_build_object('outcome', 'not_signed_in');
  end if;
  select wm.workspace_id into v_workspace
    from public.workspace_members wm
   join public.workspaces w on w.id = wm.workspace_id
   where wm.user_id = v_user and wm.status = 'active'
   order by (case when w.owner_user_id = v_user then 0 else 1 end), w.created_at, w.id
   limit 1;
  if v_workspace is null then
    return jsonb_build_object('outcome', 'no_workspace');
  end if;

  if (p_quiet_start is null) <> (p_quiet_end is null) then
    return jsonb_build_object('outcome', 'invalid_quiet_hours');
  end if;

  -- De-duplicated and sorted, COLLATE "C" so the stored array is the same
  -- array whatever the server's locale (Phase 2F learnt this the hard
  -- way). An unknown type is a rejection rather than a silent drop: the
  -- UI and the database disagreeing about what exists is worth knowing.
  if p_push_types is null then
    v_types := automation_internal.push_notification_types();
  else
    if exists (
      select 1 from unnest(p_push_types) as t
       where not (t = any (automation_internal.push_notification_types()))
    ) then
      return jsonb_build_object('outcome', 'unknown_type');
    end if;
    -- Distinct first, ordered second. Postgres requires an aggregate's
    -- ORDER BY expression to match its argument exactly, and `t collate
    -- "C"` is not `t`, so the two steps are separated rather than
    -- dropping the collation.
    v_types := array(
      select d.t from (select distinct u.t from unnest(p_push_types) as u(t)) d
       order by d.t collate "C");
  end if;

  insert into public.notification_preferences
    (user_id, workspace_id, push_enabled, push_types, quiet_start, quiet_end, updated_at)
  values (v_user, v_workspace, coalesce(p_push_enabled, true), v_types,
          p_quiet_start, p_quiet_end, now())
  on conflict (user_id) do update
    set workspace_id = excluded.workspace_id,
        push_enabled = excluded.push_enabled,
        push_types = excluded.push_types,
        quiet_start = excluded.quiet_start,
        quiet_end = excluded.quiet_end,
        updated_at = now();

  return jsonb_build_object('outcome', 'saved', 'push_types', to_jsonb(v_types));
end;
$fn$;
revoke all on function public.realtoros_set_notification_preferences(boolean, text[], time, time)
  from public, anon;
grant execute on function public.realtoros_set_notification_preferences(boolean, text[], time, time)
  to authenticated;
comment on function public.realtoros_set_notification_preferences(boolean, text[], time, time) is
  'Phase 3B. Saves the caller''s own push preferences. Types are checked against automation_internal.push_notification_types() and stored sorted under COLLATE "C"; quiet hours are both or neither.';

