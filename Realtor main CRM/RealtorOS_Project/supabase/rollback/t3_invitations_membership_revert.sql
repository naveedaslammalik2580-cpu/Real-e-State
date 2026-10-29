-- REVERT for Phase T3 (invitations and membership management).
--
-- NOT a migration. Run it only to undo
-- 20261007130000_phase_t3_invitations_membership.sql.
--
-- WHAT IT REMOVES
--
--   * the eight reachable membership functions - invite, list, revoke,
--     accept, remove, transfer ownership, change role, leave, delete
--     workspace, list members
--   * the four internal helpers behind them
--   * the membership actions from the audit table's CHECK
--
-- WHAT IT DOES NOT TOUCH, DELIBERATELY
--
--   * workspace_invitations rows. T2a created the table and T3 only
--     taught the database to write it; the rows are history, and a
--     pending invitation that nobody can accept is still a record of
--     having invited somebody.
--   * workspace_members rows. Everybody who has already joined stays
--     joined, with the role they have. What goes is the ability to
--     change any of it from the app.
--   * workspace_permission_changes rows, including ones whose action is
--     one of the membership values being removed from the CHECK. A CHECK
--     constraint is only enforced on write, so existing history survives
--     the narrowing - which is what we want, and also why the narrowing
--     has to be written as it is below rather than as a plain re-add.
--
-- WHAT RUNNING THIS MEANS. A team that is already a team keeps working:
-- RLS, permissions and every data path are T2a/T2b and are untouched.
-- What stops is administration - no new invitations, nobody can be
-- removed or promoted, and an owner cannot hand the workspace over or
-- delete it. The Team pages will show errors where they call these
-- functions, so the app should be rolled back alongside this.
--
-- ORDER. T4 and everything after it do not depend on these functions, so
-- this revert can be run on its own. It must come before the T2b-1 and
-- T2a reverts, which remove the tables underneath it.

set search_path = public;

begin;

-- ============================================================
-- 1. The reachable functions.
-- ============================================================
drop function if exists public.realtoros_invite_member(text, text);
drop function if exists public.realtoros_list_invitations();
drop function if exists public.realtoros_revoke_invitation(uuid);
drop function if exists public.realtoros_accept_invitation(text);
drop function if exists public.realtoros_remove_member(uuid);
drop function if exists public.realtoros_transfer_ownership(uuid);
drop function if exists public.realtoros_change_member_role(uuid, text);
drop function if exists public.realtoros_leave_workspace();
drop function if exists public.realtoros_delete_workspace(text);
drop function if exists public.realtoros_list_members();

-- ============================================================
-- 2. The helpers only those functions used.
--
-- ensure_landing_workspace is T3's; ensure_personal_workspace is T2a's
-- (re-defined by T2b-1) and stays.
-- ============================================================
drop function if exists automation_internal.audit_membership(uuid, uuid, text, uuid, text);
drop function if exists automation_internal.ensure_landing_workspace(uuid);
drop function if exists automation_internal.workspace_is_empty(uuid);
drop function if exists automation_internal.account_email(uuid);

-- ============================================================
-- 3. The audit CHECK, back to permissions-only actions.
--
-- NOT VALID, and that is a deliberate difference from the constraint
-- T2b-1 originally wrote. ADD CONSTRAINT normally validates every
-- existing row, so a plain re-add would fail on any workspace that has
-- ever invited or removed somebody - the history this revert explicitly
-- keeps. NOT VALID narrows what can be written from now on while leaving
-- those rows where they are.
--
-- The visible consequence: pg_get_constraintdef reports "NOT VALID" on
-- this constraint where the pre-T3 one had none. To finish the job on a
-- workspace with no membership history,
--   alter table public.workspace_permission_changes
--     validate constraint workspace_permission_changes_action_check;
-- which checks the rows and clears the flag, or fails and tells you
-- which rows are in the way.
-- ============================================================
alter table public.workspace_permission_changes
  drop constraint if exists workspace_permission_changes_action_check;
alter table public.workspace_permission_changes
  add constraint workspace_permission_changes_action_check
  check (action in ('set_role', 'set_member', 'reset_member'))
  not valid;

-- ============================================================
-- 4. Verify.
-- ============================================================
do $verify$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in (
         'realtoros_invite_member', 'realtoros_list_invitations',
         'realtoros_revoke_invitation', 'realtoros_accept_invitation',
         'realtoros_remove_member', 'realtoros_transfer_ownership',
         'realtoros_change_member_role', 'realtoros_leave_workspace',
         'realtoros_delete_workspace', 'realtoros_list_members')
  ) then
    raise exception 'T3 revert: a membership function still exists';
  end if;

  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'automation_internal'
       and p.proname in ('audit_membership', 'ensure_landing_workspace',
                         'workspace_is_empty', 'account_email')
  ) then
    raise exception 'T3 revert: a T3 helper still exists';
  end if;

  -- T2a's tables and T2b-1's permissions are not T3's to remove.
  if not exists (
    select 1 from information_schema.tables
     where table_schema = 'public' and table_name = 'workspace_invitations'
  ) then
    raise exception 'T3 revert: workspace_invitations was dropped, which belongs to T2a';
  end if;
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'automation_internal' and p.proname = 'ensure_personal_workspace'
  ) then
    raise exception 'T3 revert: ensure_personal_workspace was dropped, which belongs to T2a/T2b-1';
  end if;

  raise notice 'T3 reverted: nobody can be invited, removed or promoted from the app; everybody already in a workspace stays exactly as they are.';
end $verify$;

commit;
