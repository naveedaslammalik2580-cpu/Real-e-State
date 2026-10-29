-- Phase T4 follow-ups: two gaps the Team UI exposed.
--
-- 1. A MANAGER COULD NOT SEE AN EXCEPTION THEY WERE ABOUT TO REPLACE
--
-- realtoros_set_member_permissions stores a member's exceptions as one
-- set and replaces it wholesale, but nothing let a manager read another
-- member's stored set back: workspace_members is select-your-own-row
-- only, by design. So the exceptions editor had to start from the role
-- template and could silently drop whatever was already there.
-- realtoros_list_members now returns permission_overrides alongside each
-- member - but only to a caller who can manage the team, because the
-- overrides describe what somebody may do and are nobody else's business.
--
-- 2. TURNING TEAM MODE OFF COULD STRAND A TEAM
--
-- Team mode is a UI switch, so it was enforced nowhere. Turning it off
-- while other people are still members does not remove them: they keep
-- their access, while the person who turned it off loses every screen
-- that would show them. The rule belongs in the database, where it
-- applies to any client, so a BEFORE UPDATE trigger on
-- workspace_settings refuses it.
--
-- Idempotent. Additive: no existing object is dropped, and the only
-- function redefined is replaced with the same signature.

-- ============================================================
-- 1. The roster, now carrying each member's exceptions for a manager.
--
-- Identical to the T3 version in every other respect: same signature,
-- same ordering, same visibility rule (a team_manage holder sees
-- suspended and removed people, everybody else sees the active list),
-- same no_workspace answer for somebody with no active membership.
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
      )
      -- The exceptions, for a manager only. '{}' when there are none, so
      -- the UI can tell "no exceptions" from "not allowed to know".
      || case when v_can_manage
              then jsonb_build_object('permission_overrides',
                     coalesce(wm.permission_overrides, '{}'::jsonb))
              else '{}'::jsonb
         end as row
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
  'Phase T4. The caller''s own workspace''s members, joining workspace_members.id (which every membership RPC takes) to the team_members display name. Any active member may call it, because the list is needed to render names; only a team_manage holder sees suspended and removed members, and only they receive each member''s permission_overrides.';

-- ============================================================
-- 2. Team mode cannot be switched off while other people are members.
--
-- WHERE THE FLAG LIVES
--
-- The app's settings are one row per workspace in workspace_settings,
-- where the recognised settings have their own columns and everything
-- else travels in the settings_data bag. Team mode is one of the
-- latter: settings_data -> 'teamMode'.
--
-- WHY A TRIGGER AND NOT AN RPC
--
-- Settings are written by an ordinary authenticated UPDATE on that row
-- (data-service.js updateSettings), not through a function, so a trigger
-- is the only place the rule applies to every caller rather than to the
-- one screen that happens to ask nicely.
--
-- WHO COUNTS AS "SOMEBODY ELSE"
--
-- Everybody active except the person doing it. A server-side caller has
-- no JWT and therefore no auth.uid(), so the workspace owner stands in
-- for them - which is the right reading: a team of one is the owner
-- alone, and that is exactly the case this rule must allow.
-- ============================================================
create or replace function automation_internal.guard_team_mode_off()
returns trigger language plpgsql security definer set search_path = '' as $fn$
declare
  v_was_on boolean;
  v_now_on boolean;
  v_ws uuid;
  v_self uuid;
  v_others int;
begin
  v_was_on := (old.settings_data -> 'teamMode') = 'true'::jsonb;
  v_now_on := (new.settings_data -> 'teamMode') = 'true'::jsonb;

  -- Only the one transition is guarded. Turning it ON, leaving it alone,
  -- and every other settings change pass straight through.
  if not (v_was_on and not v_now_on) then
    return new;
  end if;

  v_ws := coalesce(new.workspace_id, old.workspace_id);
  if v_ws is null then
    return new;
  end if;

  select w.owner_user_id into v_self from public.workspaces w where w.id = v_ws;
  v_self := coalesce((select auth.uid()), v_self);

  select count(*) into v_others
    from public.workspace_members wm
   where wm.workspace_id = v_ws
     and wm.status = 'active'
     and wm.user_id is distinct from v_self;

  if v_others > 0 then
    raise exception 'team_mode_has_members'
      using errcode = 'P0001',
            detail = v_others::text,
            hint = 'Remove the other members before turning team mode off.';
  end if;

  return new;
end;
$fn$;
revoke all on function automation_internal.guard_team_mode_off()
  from public, anon, authenticated;

drop trigger if exists workspace_settings_guard_team_mode on public.workspace_settings;
create trigger workspace_settings_guard_team_mode
  before update on public.workspace_settings
  for each row execute function automation_internal.guard_team_mode_off();

-- ============================================================
-- 3. Verify.
-- ============================================================
do $verify$
declare v_n int;
begin
  select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'realtoros_list_members';
  if v_n <> 1 then
    raise exception 'T4: realtoros_list_members is missing';
  end if;

  select count(*) into v_n from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'workspace_settings'
     and t.tgname = 'workspace_settings_guard_team_mode'
     and not t.tgisinternal;
  if v_n <> 1 then
    raise exception 'T4: the team mode guard trigger is missing';
  end if;

  raise notice 'T4: list_members reports overrides to managers; team mode cannot be switched off under a team.';
end $verify$;
