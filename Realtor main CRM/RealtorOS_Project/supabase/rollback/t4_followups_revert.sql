-- REVERT for Phase T4 follow-ups.
--
-- NOT a migration. Lives in supabase/rollback/ and is never applied as
-- part of the chain. Run it only to undo
-- 20261013120000_phase_t4_followups.sql.
--
-- T4 did exactly two things, and this undoes both:
--
--   1. It redefined public.realtoros_list_members() to return each
--      member's permission_overrides to a team_manage holder. Restored
--      below to the T3 definition, byte for byte, with T3's grants and
--      T3's comment.
--
--   2. It added automation_internal.guard_team_mode_off() and the
--      BEFORE UPDATE trigger workspace_settings_guard_team_mode on
--      public.workspace_settings. Both dropped below.
--
-- T4 created no table, column, index or constraint and wrote no data, so
-- there is nothing else to put back. Running this touches functions and
-- one trigger only.
--
-- WHAT RUNNING THIS MEANS
--
-- It reinstates the two defects T4 fixed:
--
--   - A manager editing another member's permission exceptions can no
--     longer read the stored set back, so the exceptions editor starts
--     from the role template again and silently drops whatever was
--     already there.
--   - Team mode can be switched off while other people are still active
--     members. They keep their access; the person who switched it off
--     loses every screen that would show them.
--
-- Only run it if T4 itself is causing a worse problem.

set search_path = public;

begin;

-- ============================================================
-- 1. public.realtoros_list_members() back to the T3 definition.
--
-- Copied verbatim from
-- supabase/migrations/20261007130000_phase_t3_invitations_membership.sql
-- so that md5(pg_proc.prosrc) matches the pre-T4 chain exactly. Do not
-- reformat: tests/sql/rollback_files.test.mjs compares body hashes.
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
-- 2. Remove the team-mode guard.
--
-- The trigger goes first: dropping the function while the trigger still
-- references it would be refused.
-- ============================================================
drop trigger if exists workspace_settings_guard_team_mode on public.workspace_settings;
drop function if exists automation_internal.guard_team_mode_off();

-- ============================================================
-- 3. Verify.
-- ============================================================
do $verify$
declare
  v_bad text := '';
  v_n int;
begin
  -- list_members must exist, and must no longer mention the overrides.
  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'realtoros_list_members';
  if v_n <> 1 then
    v_bad := v_bad || E'\n  realtoros_list_members is missing';
  elsif exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'realtoros_list_members'
       and p.prosrc like '%permission_overrides%'
  ) then
    v_bad := v_bad || E'\n  realtoros_list_members still returns permission_overrides';
  end if;

  -- The guard function and its trigger must both be gone.
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'automation_internal' and p.proname = 'guard_team_mode_off'
  ) then
    v_bad := v_bad || E'\n  guard_team_mode_off still exists';
  end if;

  select count(*) into v_n from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'workspace_settings'
     and t.tgname = 'workspace_settings_guard_team_mode'
     and not t.tgisinternal;
  if v_n <> 0 then
    v_bad := v_bad || E'\n  the team mode guard trigger still exists';
  end if;

  if v_bad <> '' then
    raise exception 'T4 revert incomplete:%', v_bad;
  end if;
  raise notice 'T4 reverted: list_members is the T3 roster again; team mode is unguarded.';
end $verify$;

commit;
