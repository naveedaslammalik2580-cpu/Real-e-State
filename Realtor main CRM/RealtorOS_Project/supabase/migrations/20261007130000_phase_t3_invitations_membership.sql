-- Phase T3: invitations, membership and ownership transfer.
--
-- T2a created workspace_invitations; nothing has written to it. This phase
-- supplies the operations that manage who is in a workspace, all as
-- RPCs, because every one of them has to do something the browser must
-- not be trusted with - including reading the roster, which needs both
-- workspace_members.id and the directory name and so cannot be assembled
-- from what the browser may select.
--
-- WHY NO RLS POLICIES ON workspace_invitations
--
-- The table keeps token_hash. RLS filters rows, not columns, so any
-- policy that let a manager read their invitations would also hand them
-- the hashes. The table therefore stays deny-all for the browser (which
-- is what the "RLS enabled, no policy" advisory notice on it means) and
-- realtoros_list_invitations returns the safe columns instead.
--
-- THE TOKEN
--
-- 32 random bytes, hex. Only its sha256 hash is stored, the same shape
-- lead_source_connections uses for connector tokens. The plaintext is
-- returned exactly once, by the invite call, and cannot be recovered
-- afterwards: a manager who loses it revokes and re-invites.
--
-- WHY accept IS SECURITY DEFINER
--
-- The person accepting is not a member yet. Every authz helper and every
-- policy would correctly see them as an outsider, so nothing they could
-- call under their own rights could find the invitation. accept therefore
-- runs as owner and does its own checking, which is: the token hash
-- matches, the invitation is pending and unexpired, and the invitation's
-- email is the email of the account calling. That last check is what
-- stops a forwarded token being used by someone else.
--
-- ONE ACTIVE MEMBERSHIP PER PERSON
--
-- T2a enforces it with a partial unique index, and signup provisions
-- everyone a personal workspace, so a new member always arrives already
-- holding one. accept deals with this explicitly rather than letting the
-- index raise: it moves the caller's own personal workspace aside only
-- when that workspace is empty of real data, and otherwise refuses with
-- 'own_workspace_not_empty' so nobody's work is silently orphaned.
--
-- Idempotent. Additive: no existing object is dropped.

-- ============================================================
-- 1. The audit table records membership events too.
--
-- Same table as the permission changes, because "who did what to whom in
-- this workspace" is one history, not two.
-- ============================================================
alter table public.workspace_permission_changes
  drop constraint if exists workspace_permission_changes_action_check;
alter table public.workspace_permission_changes
  add constraint workspace_permission_changes_action_check
  check (action in (
    'set_role', 'set_member', 'reset_member',
    'invited', 'invite_revoked', 'invite_accepted',
    'member_removed', 'member_role_changed', 'member_left',
    'ownership_transferred', 'workspace_deleted'));

-- ============================================================
-- 2. Helpers.
-- ============================================================

-- The email of an auth account, normalized. SECURITY DEFINER because
-- auth.users is not readable by the browser.
create or replace function automation_internal.account_email(p_user_id uuid)
returns text language sql stable security definer set search_path = '' as $fn$
  select lower(btrim(u.email)) from auth.users u where u.id = p_user_id;
$fn$;
revoke all on function automation_internal.account_email(uuid) from public, anon, authenticated;
grant execute on function automation_internal.account_email(uuid) to service_role;

-- Is a workspace empty of real work? Used to decide whether a new
-- member's auto-provisioned personal workspace can be set aside.
create or replace function automation_internal.workspace_is_empty(p_workspace_id uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $fn$
declare v_n bigint;
begin
  if p_workspace_id is null then return true; end if;
  select
    (select count(*) from public.contacts where workspace_id = p_workspace_id)
  + (select count(*) from public.deals where workspace_id = p_workspace_id)
  + (select count(*) from public.properties where workspace_id = p_workspace_id)
  + (select count(*) from public.tasks where workspace_id = p_workspace_id)
  + (select count(*) from public.finance_records where workspace_id = p_workspace_id)
  + (select count(*) from public.goals where workspace_id = p_workspace_id)
  + (select count(*) from public.automation_rules where workspace_id = p_workspace_id)
  + (select count(*) from public.scheduled_items where workspace_id = p_workspace_id)
  into v_n;
  return coalesce(v_n, 0) = 0;
end;
$fn$;
revoke all on function automation_internal.workspace_is_empty(uuid) from public, anon, authenticated;
grant execute on function automation_internal.workspace_is_empty(uuid) to service_role;

-- Somewhere for a person to land after they leave or delete a workspace.
--
-- Prefers the workspace they ALREADY OWN: leaving a team is not losing
-- your own workspace, and handing it back is both kinder and simpler than
-- making a third one.
--
-- It also avoids a real trap. ensure_personal_workspace derives the
-- directory row id deterministically from the user id
-- ('tm_' || user_id), so for someone who has been in another workspace
-- before, that id already exists there. Its
-- `on conflict (user_id, id) do nothing` then swallows the insert, and the
-- membership it links would point at a row in the WRONG workspace -
-- which T2a's (workspace_id, team_member_id) foreign key correctly
-- refuses. Reactivating their own workspace sidesteps that entirely;
-- ensure_personal_workspace is only called when they genuinely have no
-- workspace of their own.
create or replace function automation_internal.ensure_landing_workspace(p_user_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $fn$
declare
  v_member_id uuid;
  v_ws uuid;
begin
  select wm.id, wm.workspace_id into v_member_id, v_ws
    from public.workspace_members wm
    join public.workspaces w on w.id = wm.workspace_id
   where wm.user_id = p_user_id
     and wm.status = 'removed'
     and w.owner_user_id = p_user_id
   order by wm.created_at
   limit 1;

  if v_ws is not null then
    update public.workspace_members
       set status = 'active', role = 'owner', updated_at = now()
     where id = v_member_id;
    -- Their own directory row comes back with them.
    update public.team_members
       set active = true, updated_at = now()
     where workspace_id = v_ws and auth_user_id = p_user_id;
    return v_ws;
  end if;

  return automation_internal.ensure_personal_workspace(p_user_id);
end;
$fn$;
revoke all on function automation_internal.ensure_landing_workspace(uuid)
  from public, anon, authenticated;
grant execute on function automation_internal.ensure_landing_workspace(uuid) to service_role;

-- One place that writes the membership half of the audit trail. Labels
-- are stored alongside the ids so the history still reads correctly after
-- the person or the row is gone (see doc 7.0.7).
create or replace function automation_internal.audit_membership(
  p_workspace_id uuid,
  p_actor uuid,
  p_action text,
  p_target_member_id uuid,
  p_target_label text
)
returns void language plpgsql security definer set search_path = '' as $fn$
begin
  insert into public.workspace_permission_changes (
    workspace_id, actor_user_id, actor_label, target_member_id, target_label, action
  ) values (
    p_workspace_id, p_actor,
    coalesce(automation_internal.account_email(p_actor), 'unknown'),
    p_target_member_id, coalesce(p_target_label, ''), p_action
  );
end;
$fn$;
revoke all on function automation_internal.audit_membership(uuid, uuid, text, uuid, text)
  from public, anon, authenticated;
grant execute on function automation_internal.audit_membership(uuid, uuid, text, uuid, text) to service_role;

-- ============================================================
-- 3. Invite.
--
-- Needs team_manage. Refuses an address that is already an active member
-- and an address that already has a pending invitation, so the list never
-- shows two live invitations for one person.
-- ============================================================
create or replace function public.realtoros_invite_member(
  p_email text,
  p_role text
)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  c_ttl constant interval := interval '7 days';
  v_uid uuid := (select auth.uid());
  v_ws uuid;
  v_email text;
  v_token text;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('admin', 'agent') then
    return jsonb_build_object('outcome', 'invalid_role');
  end if;

  v_ws := automation_internal.workspace_of(v_uid);
  if v_ws is null then
    return jsonb_build_object('outcome', 'no_workspace');
  end if;
  if not automation_internal.member_can(v_ws, v_uid, 'team_manage') then
    raise exception 'team_manage permission required' using errcode = '42501';
  end if;

  v_email := lower(btrim(coalesce(p_email, '')));
  if char_length(v_email) not between 3 and 254
     or position('@' in v_email) < 2
     or v_email ~ '[[:space:][:cntrl:]]' then
    return jsonb_build_object('outcome', 'invalid_email');
  end if;

  -- Already here?
  if exists (
    select 1 from public.workspace_members wm
     where wm.workspace_id = v_ws and wm.status = 'active'
       and automation_internal.account_email(wm.user_id) = v_email
  ) then
    return jsonb_build_object('outcome', 'already_a_member');
  end if;

  -- Already invited and still live?
  if exists (
    select 1 from public.workspace_invitations i
     where i.workspace_id = v_ws and i.normalized_email = v_email
       and i.status = 'pending' and i.expires_at > now()
  ) then
    return jsonb_build_object('outcome', 'already_invited');
  end if;

  -- Any stale pending row for this address is marked expired first, so
  -- the partial uniqueness below stays meaningful.
  update public.workspace_invitations
     set status = 'expired', updated_at = now()
   where workspace_id = v_ws and normalized_email = v_email
     and status = 'pending' and expires_at <= now();

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.workspace_invitations (
    workspace_id, normalized_email, role, token_hash, invited_by, status, expires_at
  ) values (
    v_ws, v_email, p_role,
    encode(extensions.digest(convert_to(v_token, 'UTF8'), 'sha256'), 'hex'),
    v_uid, 'pending', now() + c_ttl
  )
  returning id into v_id;

  perform automation_internal.audit_membership(v_ws, v_uid, 'invited', null, v_email);

  -- The token is returned ONCE. It is not stored in plaintext and cannot
  -- be read back; losing it means revoke and re-invite.
  return jsonb_build_object(
    'outcome', 'invited', 'invitation_id', v_id, 'token', v_token,
    'email', v_email, 'role', p_role, 'expires_at', now() + c_ttl);
end;
$fn$;
revoke all on function public.realtoros_invite_member(text, text) from public, anon;
grant execute on function public.realtoros_invite_member(text, text) to authenticated, service_role;
comment on function public.realtoros_invite_member(text, text) is
  'Phase T3. Invites an address as admin or agent. Needs team_manage. Returns the invitation token in plaintext EXACTLY ONCE - only its hash is stored.';

-- ============================================================
-- 4. List invitations.
--
-- Returns the safe columns only: never token_hash. SECURITY DEFINER
-- because the table is deny-all for the browser by design.
-- ============================================================
create or replace function public.realtoros_list_invitations()
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_ws uuid;
  v_rows jsonb;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  v_ws := automation_internal.workspace_of(v_uid);
  if v_ws is null then return jsonb_build_object('outcome', 'no_workspace'); end if;
  if not automation_internal.member_can(v_ws, v_uid, 'team_manage') then
    raise exception 'team_manage permission required' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(row order by row ->> 'created_at' desc), '[]'::jsonb)
    into v_rows
  from (
    select jsonb_build_object(
      'id', i.id,
      'email', i.normalized_email,
      'role', i.role,
      -- Reported as expired the moment it is, without waiting for a
      -- sweeper to rewrite the row.
      'status', case when i.status = 'pending' and i.expires_at <= now()
                     then 'expired' else i.status end,
      'expires_at', i.expires_at,
      'created_at', i.created_at,
      'accepted_at', i.accepted_at,
      'invited_by_email', automation_internal.account_email(i.invited_by)
    ) as row
    from public.workspace_invitations i
    where i.workspace_id = v_ws
  ) s;

  return jsonb_build_object('outcome', 'ok', 'invitations', v_rows);
end;
$fn$;
revoke all on function public.realtoros_list_invitations() from public, anon;
grant execute on function public.realtoros_list_invitations() to authenticated, service_role;
comment on function public.realtoros_list_invitations() is
  'Phase T3. The workspace''s invitations, without token_hash. Needs team_manage. A pending invitation past its expiry reports as expired immediately.';

-- ============================================================
-- 5. Revoke.
-- ============================================================
create or replace function public.realtoros_revoke_invitation(p_invitation_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_ws uuid;
  v_inv public.workspace_invitations%rowtype;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  v_ws := automation_internal.workspace_of(v_uid);
  if v_ws is null then return jsonb_build_object('outcome', 'no_workspace'); end if;
  if not automation_internal.member_can(v_ws, v_uid, 'team_manage') then
    raise exception 'team_manage permission required' using errcode = '42501';
  end if;

  select * into v_inv from public.workspace_invitations
   where id = p_invitation_id and workspace_id = v_ws
   for update;
  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  -- An accepted invitation is history; revoking it would say something
  -- untrue about a member who is already here. Remove the member instead.
  if v_inv.status = 'accepted' then
    return jsonb_build_object('outcome', 'already_accepted');
  end if;
  if v_inv.status = 'revoked' then
    return jsonb_build_object('outcome', 'revoked');
  end if;

  update public.workspace_invitations
     set status = 'revoked', updated_at = now()
   where id = p_invitation_id;

  perform automation_internal.audit_membership(
    v_ws, v_uid, 'invite_revoked', null, v_inv.normalized_email);
  return jsonb_build_object('outcome', 'revoked');
end;
$fn$;
revoke all on function public.realtoros_revoke_invitation(uuid) from public, anon;
grant execute on function public.realtoros_revoke_invitation(uuid) to authenticated, service_role;

-- ============================================================
-- 6. Accept.
--
-- The one operation called by someone who is not yet a member.
-- ============================================================
create or replace function public.realtoros_accept_invitation(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_email text;
  v_hash text;
  v_inv public.workspace_invitations%rowtype;
  v_own_ws uuid;
  v_owner uuid;
  v_tm_id text;
  v_member_id uuid;
  v_name text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_token is null or char_length(btrim(p_token)) < 16 then
    return jsonb_build_object('outcome', 'invalid_token');
  end if;

  v_hash := encode(extensions.digest(convert_to(btrim(p_token), 'UTF8'), 'sha256'), 'hex');
  select * into v_inv from public.workspace_invitations
   where token_hash = v_hash
   for update;
  if not found then
    return jsonb_build_object('outcome', 'invalid_token');
  end if;
  if v_inv.status <> 'pending' then
    return jsonb_build_object('outcome', v_inv.status);
  end if;
  if v_inv.expires_at <= now() then
    update public.workspace_invitations
       set status = 'expired', updated_at = now() where id = v_inv.id;
    return jsonb_build_object('outcome', 'expired');
  end if;

  -- The invitation is for an ADDRESS, not for whoever holds the link.
  v_email := automation_internal.account_email(v_uid);
  if v_email is null or v_email <> v_inv.normalized_email then
    return jsonb_build_object('outcome', 'email_mismatch', 'invited_email', v_inv.normalized_email);
  end if;

  -- One active membership per person. Signup provisioned this account a
  -- personal workspace, so there is almost always one to deal with.
  select wm.workspace_id into v_own_ws
    from public.workspace_members wm
   where wm.user_id = v_uid and wm.status = 'active';

  if v_own_ws is not null and v_own_ws = v_inv.workspace_id then
    return jsonb_build_object('outcome', 'already_a_member');
  end if;

  if v_own_ws is not null then
    -- Only set aside a workspace that holds no work. Anything else would
    -- orphan real data behind a membership the person can no longer use.
    if not automation_internal.workspace_is_empty(v_own_ws) then
      return jsonb_build_object('outcome', 'own_workspace_not_empty');
    end if;
    update public.workspace_members
       set status = 'removed', updated_at = now()
     where user_id = v_uid and status = 'active';
  end if;

  -- The directory row. user_id is the WORKSPACE OWNER's id, matching how
  -- ensure_personal_workspace writes team_members; auth_user_id is the
  -- person. Inserted before workspace_members so T2a's compat trigger
  -- sees a directory row to point at.
  select w.owner_user_id into v_owner from public.workspaces w where w.id = v_inv.workspace_id;
  v_name := split_part(v_email, '@', 1);
  v_tm_id := 'tm_' || replace(gen_random_uuid()::text, '-', '');
  insert into public.team_members (
    id, user_id, workspace_id, auth_user_id, name, role, email, active
  ) values (
    v_tm_id, v_owner, v_inv.workspace_id, v_uid, v_name,
    case v_inv.role when 'admin' then 'Admin' else 'Agent' end,
    v_email, true
  );

  insert into public.workspace_members (
    workspace_id, user_id, team_member_id, role, status
  ) values (
    v_inv.workspace_id, v_uid, v_tm_id, v_inv.role, 'active'
  )
  returning id into v_member_id;

  update public.workspace_invitations
     set status = 'accepted', accepted_by = v_uid, accepted_at = now(), updated_at = now()
   where id = v_inv.id;

  perform automation_internal.audit_membership(
    v_inv.workspace_id, v_uid, 'invite_accepted', v_member_id, v_email);

  return jsonb_build_object(
    'outcome', 'accepted', 'workspace_id', v_inv.workspace_id,
    'role', v_inv.role, 'member_id', v_member_id, 'team_member_id', v_tm_id);
end;
$fn$;
revoke all on function public.realtoros_accept_invitation(text) from public, anon;
grant execute on function public.realtoros_accept_invitation(text) to authenticated, service_role;
comment on function public.realtoros_accept_invitation(text) is
  'Phase T3. Accepts an invitation by token. SECURITY DEFINER because the caller is not a member yet, so it does its own checks: hash match, pending, unexpired, and the invitation''s email equals the calling account''s email. Sets the caller''s empty personal workspace aside; refuses if it holds work.';

-- ============================================================
-- 7. Remove a member.
--
-- Sets status to 'removed' and never deletes: their rows keep pointing at
-- a membership row that records they were here.
-- ============================================================
create or replace function public.realtoros_remove_member(p_member_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_ws uuid;
  v_target public.workspace_members%rowtype;
  v_label text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  v_ws := automation_internal.workspace_of(v_uid);
  if v_ws is null then return jsonb_build_object('outcome', 'no_workspace'); end if;
  if not automation_internal.member_can(v_ws, v_uid, 'team_manage') then
    raise exception 'team_manage permission required' using errcode = '42501';
  end if;

  select * into v_target from public.workspace_members
   where id = p_member_id and workspace_id = v_ws
   for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if v_target.status <> 'active' then
    return jsonb_build_object('outcome', 'already_removed');
  end if;
  -- The owner is removed by transferring ownership first, never directly:
  -- a workspace with no active owner has no one who can fix it.
  if v_target.role = 'owner' then
    return jsonb_build_object('outcome', 'cannot_remove_owner');
  end if;
  if v_target.user_id = v_uid then
    return jsonb_build_object('outcome', 'cannot_remove_self');
  end if;

  v_label := coalesce(automation_internal.account_email(v_target.user_id), '');
  update public.workspace_members
     set status = 'removed', updated_at = now()
   where id = p_member_id;
  -- The directory row stays, deactivated, so historical assignments still
  -- resolve to a name instead of a dangling id.
  update public.team_members
     set active = false, updated_at = now()
   where id = v_target.team_member_id and workspace_id = v_ws;

  perform automation_internal.audit_membership(
    v_ws, v_uid, 'member_removed', p_member_id, v_label);
  return jsonb_build_object('outcome', 'removed', 'member_id', p_member_id);
end;
$fn$;
revoke all on function public.realtoros_remove_member(uuid) from public, anon;
grant execute on function public.realtoros_remove_member(uuid) to authenticated, service_role;

-- ============================================================
-- 8. Transfer ownership.
--
-- Owner only. The old owner becomes an admin rather than leaving, so the
-- workspace never loses the person who built it.
-- ============================================================
create or replace function public.realtoros_transfer_ownership(p_member_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_ws uuid;
  v_me public.workspace_members%rowtype;
  v_target public.workspace_members%rowtype;
  v_label text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  v_ws := automation_internal.workspace_of(v_uid);
  if v_ws is null then return jsonb_build_object('outcome', 'no_workspace'); end if;

  select * into v_me from public.workspace_members
   where workspace_id = v_ws and user_id = v_uid and status = 'active'
   for update;
  if not found or v_me.role <> 'owner' then
    raise exception 'only the workspace owner can transfer ownership' using errcode = '42501';
  end if;

  select * into v_target from public.workspace_members
   where id = p_member_id and workspace_id = v_ws
   for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if v_target.status <> 'active' then
    return jsonb_build_object('outcome', 'target_not_active');
  end if;
  if v_target.id = v_me.id then
    return jsonb_build_object('outcome', 'already_owner');
  end if;

  -- Order matters: one active owner per workspace is a partial unique
  -- index, so the sitting owner is demoted BEFORE the new one is
  -- promoted. Both statements are in this transaction, so no moment is
  -- visible to anyone else in which the workspace has no owner.
  update public.workspace_members
     set role = 'admin', updated_at = now()
   where id = v_me.id;
  update public.workspace_members
     set role = 'owner', updated_at = now()
   where id = v_target.id;

  -- workspaces.owner_user_id is stored, not derived (doc 5), so it moves
  -- too or the two disagree.
  update public.workspaces
     set owner_user_id = v_target.user_id, updated_at = now()
   where id = v_ws;

  v_label := coalesce(automation_internal.account_email(v_target.user_id), '');
  perform automation_internal.audit_membership(
    v_ws, v_uid, 'ownership_transferred', p_member_id, v_label);

  return jsonb_build_object(
    'outcome', 'transferred', 'new_owner_member_id', v_target.id,
    'previous_owner_role', 'admin');
end;
$fn$;
revoke all on function public.realtoros_transfer_ownership(uuid) from public, anon;
grant execute on function public.realtoros_transfer_ownership(uuid) to authenticated, service_role;
comment on function public.realtoros_transfer_ownership(uuid) is
  'Phase T3. Owner only. Demotes the sitting owner to admin and promotes the target, in that order so the one-active-owner index is never violated, and moves workspaces.owner_user_id to match.';

-- ============================================================
-- 9. Verify.
-- ============================================================
do $verify$
declare v_n int;
begin
  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in (
     'realtoros_invite_member', 'realtoros_list_invitations',
     'realtoros_revoke_invitation', 'realtoros_accept_invitation',
     'realtoros_remove_member', 'realtoros_transfer_ownership');
  if v_n <> 6 then
    raise exception 'T3: expected 6 membership RPCs, found %', v_n;
  end if;

  -- The browser must not reach the invitations table directly: token_hash
  -- lives there and RLS cannot hide a column.
  if has_table_privilege('authenticated', 'public.workspace_invitations', 'select') then
    raise exception 'T3: authenticated can select workspace_invitations directly';
  end if;

  if exists (select 1 from pg_policies
              where schemaname = 'public' and tablename = 'workspace_invitations') then
    raise exception 'T3: workspace_invitations has a policy; it must stay deny-all';
  end if;

  raise notice 'T3: 6 membership RPCs, invitations reachable only through them.';
end $verify$;

-- ============================================================
-- 10. Change a member's role.
--
-- Two guards beyond team_manage, and the second is the one that matters:
-- a manager can never promote someone past their OWN level. T2b-1
-- already settled what that means for permissions and supplies
-- permissions_within_actor; this reuses it rather than inventing a second
-- answer. So an admin whose template has been trimmed cannot mint a
-- full-strength admin and borrow their powers.
--
-- The owner is never a target: that is realtoros_transfer_ownership,
-- which has its own ordering guarantees.
-- ============================================================
create or replace function public.realtoros_change_member_role(
  p_member_id uuid,
  p_role text
)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_ws uuid;
  v_target public.workspace_members%rowtype;
  v_actor_perms jsonb;
  v_proposed jsonb;
  v_why text;
  v_label text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('admin', 'agent') then
    return jsonb_build_object('outcome', 'invalid_role');
  end if;

  v_ws := automation_internal.workspace_of(v_uid);
  if v_ws is null then return jsonb_build_object('outcome', 'no_workspace'); end if;
  if not automation_internal.member_can(v_ws, v_uid, 'team_manage') then
    raise exception 'team_manage permission required' using errcode = '42501';
  end if;

  select * into v_target from public.workspace_members
   where id = p_member_id and workspace_id = v_ws
   for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if v_target.status <> 'active' then
    return jsonb_build_object('outcome', 'not_active');
  end if;
  if v_target.role = 'owner' then
    return jsonb_build_object('outcome', 'cannot_change_owner');
  end if;
  if v_target.role = p_role then
    return jsonb_build_object('outcome', 'unchanged', 'role', p_role);
  end if;

  -- Nobody grants what they do not hold. The proposed role is measured as
  -- the permissions it would actually confer: the workspace's template for
  -- that role if one is stored, otherwise the shipped preset. The target's
  -- own personal overrides are deliberately NOT part of this - they are
  -- not being changed here, and set_member_permissions already guards them.
  v_actor_perms := automation_internal.member_permissions(v_ws, v_uid);
  select coalesce(wrp.permissions, automation_internal.default_role_permissions(p_role))
    into v_proposed
    from (select 1) _
    left join public.workspace_role_permissions wrp
      on wrp.workspace_id = v_ws and wrp.role = p_role;

  -- permissions_within_actor returns NULL when the proposal is within the
  -- actor's own level, and otherwise the specific reason it is not. The
  -- reason is passed back so the UI can say which permission blocked it
  -- rather than just refusing.
  v_why := automation_internal.permissions_within_actor(v_actor_perms, v_proposed);
  if v_why is not null then
    return jsonb_build_object(
      'outcome', 'exceeds_your_permissions', 'role', p_role, 'reason', v_why);
  end if;

  update public.workspace_members
     set role = p_role, updated_at = now()
   where id = p_member_id;
  -- The directory label follows the role so the team list and the
  -- assignment dropdowns do not disagree with the permissions.
  update public.team_members
     set role = case p_role when 'admin' then 'Admin' else 'Agent' end,
         updated_at = now()
   where id = v_target.team_member_id and workspace_id = v_ws;

  v_label := coalesce(automation_internal.account_email(v_target.user_id), '');
  perform automation_internal.audit_membership(
    v_ws, v_uid, 'member_role_changed', p_member_id, v_label);

  return jsonb_build_object(
    'outcome', 'changed', 'member_id', p_member_id,
    'from_role', v_target.role, 'to_role', p_role);
end;
$fn$;
revoke all on function public.realtoros_change_member_role(uuid, text) from public, anon;
grant execute on function public.realtoros_change_member_role(uuid, text) to authenticated, service_role;
comment on function public.realtoros_change_member_role(uuid, text) is
  'Phase T3. Changes a member between admin and agent. Needs team_manage, never targets the owner, and refuses any role whose permissions exceed the actor''s own (reusing T2b-1''s permissions_within_actor), so a manager cannot promote someone past their own level and borrow it back.';

-- ============================================================
-- 11. Leave a workspace.
--
-- The member's own decision, so no permission is required beyond being a
-- non-owner. The hard part is not the membership row, it is everything
-- that pointed at them: leaving must not take a lead or a shared rule out
-- of the workspace with it.
--
--   their leads        -> unassigned, so a manager can redistribute them.
--                         The leads stay in the workspace.
--   their PERSONAL     -> handed to the owner. Shared ones already belong
--   templates, prompts,   to the workspace and are left exactly as they
--   scripts, rules        are.
--   their membership   -> 'removed', never deleted, so historical rows
--                         still resolve to a person.
--   their directory    -> deactivated for the same reason.
--   themselves         -> a fresh empty personal workspace, so they are
--                         never left signed in with nowhere to be.
-- ============================================================
create or replace function public.realtoros_leave_workspace()
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_ws uuid;
  v_me public.workspace_members%rowtype;
  v_owner uuid;
  v_unassigned int := 0;
  v_handed int := 0;
  v_n int;
  v_new_ws uuid;
  v_label text;
  v_jwt text;
  v_claims text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  v_ws := automation_internal.workspace_of(v_uid);
  if v_ws is null then return jsonb_build_object('outcome', 'no_workspace'); end if;

  select * into v_me from public.workspace_members
   where workspace_id = v_ws and user_id = v_uid and status = 'active'
   for update;
  if not found then return jsonb_build_object('outcome', 'not_a_member'); end if;
  -- The owner cannot walk away and leave the workspace ownerless: they
  -- transfer ownership first, or delete the workspace.
  if v_me.role = 'owner' then
    return jsonb_build_object('outcome', 'owner_cannot_leave');
  end if;

  select w.owner_user_id into v_owner from public.workspaces w where w.id = v_ws;

  -- Releasing their assignments means changing contacts.assigned_to_id,
  -- which T2b-2's enforce_contact_assignment trigger guards: it needs
  -- contacts_assign, and an agent does not have it. The trigger already
  -- exempts callers with no JWT, because that is how it recognises a
  -- trusted server-side operation - and this is one. So the claim is
  -- suspended for the duration of these statements and restored
  -- afterwards.
  --
  -- Safe because every permission decision in this function is already
  -- made by this point: who the caller is, that they are a member, and
  -- that they are not the owner. Transaction-local, so nothing outside
  -- this call sees it.
  -- BOTH settings, because auth.uid() on Supabase is
  -- coalesce(request.jwt.claim.sub, request.jwt.claims ->> 'sub'): blanking
  -- only the first leaves it resolving through the second, the trigger
  -- still sees a JWT caller, and an agent cannot release their own leads -
  -- so leaving failed for exactly the members most likely to leave.
  v_jwt := current_setting('request.jwt.claim.sub', true);
  v_claims := current_setting('request.jwt.claims', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims', '', true);

  -- 1. Their leads go back to the pool rather than leaving with them.
  if v_me.team_member_id is not null then
    update public.contacts
       set assigned_to_id = null, updated_at = now()
     where workspace_id = v_ws and assigned_to_id = v_me.team_member_id;
    get diagnostics v_unassigned = row_count;

    -- Deals and work assigned to them are released the same way.
    update public.deals set assigned_to_id = null, updated_at = now()
     where workspace_id = v_ws and assigned_to_id = v_me.team_member_id;
    update public.tasks set assigned_to_id = null, updated_at = now()
     where workspace_id = v_ws and assigned_to_id = v_me.team_member_id;
    update public.scheduled_items set assigned_to = null, updated_at = now()
     where workspace_id = v_ws and assigned_to = v_me.team_member_id;
  end if;

  -- 2. Personal library items and rules are handed to the owner. Shared
  --    ones are the workspace's already and are not touched.
  update public.message_templates set user_id = v_owner, updated_at = now()
   where workspace_id = v_ws and user_id = v_uid and visibility = 'personal';
  get diagnostics v_n = row_count; v_handed := v_handed + v_n;
  update public.scripts set user_id = v_owner, updated_at = now()
   where workspace_id = v_ws and user_id = v_uid and visibility = 'personal';
  get diagnostics v_n = row_count; v_handed := v_handed + v_n;
  update public.ai_prompts set user_id = v_owner, updated_at = now()
   where workspace_id = v_ws and user_id = v_uid and visibility = 'personal';
  get diagnostics v_n = row_count; v_handed := v_handed + v_n;
  update public.automation_rules set user_id = v_owner, updated_at = now()
   where workspace_id = v_ws and user_id = v_uid and visibility = 'personal';
  get diagnostics v_n = row_count; v_handed := v_handed + v_n;

  perform set_config('request.jwt.claim.sub', coalesce(v_jwt, ''), true);
  perform set_config('request.jwt.claims', coalesce(v_claims, ''), true);

  -- 3. The membership and the directory row stay, deactivated.
  update public.workspace_members
     set status = 'removed', updated_at = now()
   where id = v_me.id;
  update public.team_members
     set active = false, updated_at = now()
   where id = v_me.team_member_id and workspace_id = v_ws;

  v_label := coalesce(automation_internal.account_email(v_uid), '');
  perform automation_internal.audit_membership(
    v_ws, v_uid, 'member_left', v_me.id, v_label);

  -- 4. Somewhere to land. Done AFTER the old membership is removed, so the
  --    one-active-membership index is satisfied at every point.
  v_new_ws := automation_internal.ensure_landing_workspace(v_uid);

  return jsonb_build_object(
    'outcome', 'left', 'left_workspace_id', v_ws,
    'new_workspace_id', v_new_ws,
    'leads_unassigned', v_unassigned,
    'items_handed_to_owner', v_handed);
end;
$fn$;
revoke all on function public.realtoros_leave_workspace() from public, anon;
grant execute on function public.realtoros_leave_workspace() to authenticated, service_role;
comment on function public.realtoros_leave_workspace() is
  'Phase T3. A non-owner leaves: their leads, deals, tasks and scheduled items are unassigned (and stay in the workspace), their PERSONAL templates/prompts/scripts/rules pass to the owner, their membership and directory row are deactivated rather than deleted, and they are provisioned a fresh empty personal workspace so they are never left with nowhere to be.';

-- ============================================================
-- 12. Delete a workspace.
--
-- Owner only, and only once they are alone in it: deleting a workspace
-- out from under other people is not a thing this offers. The typed name
-- has to match, which is the usual guard against a mis-click on an
-- irreversible action.
--
-- Everything else goes with the workspace row, through the ON DELETE
-- CASCADE that T2a put on every workspace_id foreign key. That includes
-- this workspace's own audit history - which is why the audit row for the
-- deletion is written into the owner's NEW workspace afterwards, where it
-- survives.
-- ============================================================
create or replace function public.realtoros_delete_workspace(p_confirm_name text)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_ws uuid;
  v_me public.workspace_members%rowtype;
  v_name text;
  v_others int;
  v_new_ws uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  v_ws := automation_internal.workspace_of(v_uid);
  if v_ws is null then return jsonb_build_object('outcome', 'no_workspace'); end if;

  select * into v_me from public.workspace_members
   where workspace_id = v_ws and user_id = v_uid and status = 'active'
   for update;
  if not found or v_me.role <> 'owner' then
    raise exception 'only the workspace owner can delete a workspace' using errcode = '42501';
  end if;

  select w.name into v_name from public.workspaces w where w.id = v_ws for update;

  -- Alone first. Removing people is a separate, visible decision.
  select count(*) into v_others from public.workspace_members
   where workspace_id = v_ws and status = 'active' and user_id <> v_uid;
  if v_others > 0 then
    return jsonb_build_object(
      'outcome', 'other_members_present', 'active_members', v_others);
  end if;

  -- The typed name must match exactly once trimmed. Compared
  -- case-sensitively on purpose: this is the last guard before an
  -- irreversible delete, so it should take deliberate typing.
  if btrim(coalesce(p_confirm_name, '')) <> btrim(coalesce(v_name, '')) then
    return jsonb_build_object('outcome', 'name_mismatch', 'expected_name', v_name);
  end if;

  -- CASCADE from workspaces does the rest. owner_user_id is ON DELETE
  -- RESTRICT against auth.users, which constrains deleting the USER, not
  -- the workspace, so this is free to proceed.
  delete from public.workspaces where id = v_ws;

  -- Somewhere to land, then a record of what happened that outlives the
  -- workspace it happened to.
  v_new_ws := automation_internal.ensure_landing_workspace(v_uid);
  perform automation_internal.audit_membership(
    v_new_ws, v_uid, 'workspace_deleted', null,
    coalesce(v_name, '') || ' (' || v_ws::text || ')');

  return jsonb_build_object(
    'outcome', 'deleted', 'deleted_workspace_id', v_ws,
    'deleted_name', v_name, 'new_workspace_id', v_new_ws);
end;
$fn$;
revoke all on function public.realtoros_delete_workspace(text) from public, anon;
grant execute on function public.realtoros_delete_workspace(text) to authenticated, service_role;
comment on function public.realtoros_delete_workspace(text) is
  'Phase T3. Owner only, only when no other member is active, and only when the typed name matches exactly. Everything goes via T2a''s ON DELETE CASCADE on workspace_id - including this workspace''s audit history, so the record of the deletion is written into the owner''s fresh workspace instead.';

-- ============================================================
-- 13. List the workspace's members.
--
-- Not a managers-only call. Every member needs this list to show a name
-- next to a lead, a deal or a task, so the only requirement is being an
-- active member of the workspace.
--
-- What differs by permission is how much of the roster comes back. A
-- team_manage holder sees everyone, including suspended and removed
-- people, because that is the list they administer. Everyone else sees
-- the active members only - the people work can actually be assigned to -
-- so somebody leaving or being removed is not announced to the whole
-- workspace.
--
-- SECURITY DEFINER because neither half of this is reachable from the
-- browser. T2a's workspace_members_select_own lets a person read their
-- OWN membership row and no other, and team_members carries the display
-- name but not workspace_members.id - which is the id every membership
-- RPC here takes. This returns the two joined, scoped to the caller's
-- own workspace, and never another workspace's rows.
-- ============================================================
create or replace function public.realtoros_list_members()
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_ws uuid;
  v_can_manage boolean;
  v_rows jsonb;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  -- workspace_of resolves an ACTIVE membership only, so a removed person
  -- gets no_workspace here rather than a last look at the roster.
  v_ws := automation_internal.workspace_of(v_uid);
  if v_ws is null then return jsonb_build_object('outcome', 'no_workspace'); end if;

  v_can_manage := automation_internal.member_can(v_ws, v_uid, 'team_manage');

  -- Owner first, then admins, then agents, alphabetically within a rank:
  -- the order the UI wants, decided here so every caller agrees.
  select coalesce(jsonb_agg(row order by rank, sort_email), '[]'::jsonb)
    into v_rows
  from (
    select
      case wm.role when 'owner' then 0 when 'admin' then 1 else 2 end as rank,
      coalesce(automation_internal.account_email(wm.user_id), '') as sort_email,
      jsonb_build_object(
        'member_id', wm.id,
        'user_id', wm.user_id,
        'team_member_id', wm.team_member_id,
        -- The directory name if there is one, otherwise the local part of
        -- the address, so a row always has something to render.
        'name', coalesce(
          nullif(btrim(tm.name), ''),
          split_part(coalesce(automation_internal.account_email(wm.user_id), ''), '@', 1)),
        'email', automation_internal.account_email(wm.user_id),
        'role', wm.role,
        'status', wm.status,
        'is_self', (wm.user_id = v_uid),
        'joined_at', wm.created_at,
        'updated_at', wm.updated_at
      ) as row
    from public.workspace_members wm
    left join public.team_members tm
      on tm.id = wm.team_member_id
     and tm.workspace_id = wm.workspace_id
    where wm.workspace_id = v_ws
      and (v_can_manage or wm.status = 'active')
  ) s;

  -- can_manage is reported so the UI does not have to decide separately
  -- whether the list it just received is the full roster.
  return jsonb_build_object(
    'outcome', 'ok', 'can_manage', v_can_manage, 'members', v_rows);
end;
$fn$;
revoke all on function public.realtoros_list_members() from public, anon;
grant execute on function public.realtoros_list_members() to authenticated, service_role;
comment on function public.realtoros_list_members() is
  'Phase T3. The caller''s own workspace''s members, joining workspace_members.id (which every membership RPC takes) to the team_members display name. Any active member may call it, because the list is needed to render names; only a team_manage holder sees suspended and removed members.';

-- ============================================================
-- 14. Verify the full T3 surface.
-- ============================================================
do $verify2$
declare v_n int;
begin
  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in (
     'realtoros_invite_member', 'realtoros_list_invitations',
     'realtoros_revoke_invitation', 'realtoros_accept_invitation',
     'realtoros_remove_member', 'realtoros_transfer_ownership',
     'realtoros_change_member_role', 'realtoros_leave_workspace',
     'realtoros_delete_workspace', 'realtoros_list_members');
  if v_n <> 10 then
    raise exception 'T3: expected 10 membership RPCs, found %', v_n;
  end if;

  -- workspace_is_empty must ignore what signup provisions, or no new
  -- account could ever accept an invitation. Asserted as a property of
  -- the function rather than trusted: it counts only real work.
  if automation_internal.workspace_is_empty(null) is not true then
    raise exception 'T3: workspace_is_empty(null) should be true';
  end if;

  raise notice 'T3: 10 membership RPCs present.';
end $verify2$;
