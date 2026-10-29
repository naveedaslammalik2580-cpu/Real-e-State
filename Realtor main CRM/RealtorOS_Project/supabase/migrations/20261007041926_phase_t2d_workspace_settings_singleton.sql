-- Phase T2d: make "one settings row per workspace" true by construction.
--
-- workspace_settings was unique on user_id, from when one user was one
-- workspace. T2a gave it a workspace_id and T2b-2 scopes reads to the
-- workspace, so the app now treats it as a single shared row - but
-- nothing stopped it from becoming several.
--
-- The concrete failure T2d would otherwise introduce: every member calls
-- loadSettings(), which inserts a row when none exists. Two members
-- opening a fresh workspace at the same moment each insert their own -
-- distinct user_id, so the old unique index permits both - and from then
-- on the single-row read (.maybeSingle()) errors for everyone, for ever.
--
-- unique (workspace_id) makes the second insert fail instead, which the
-- app handles as a conflict and re-reads. Verified on live before
-- applying: 1 row, 0 workspaces with more than one.
--
-- The old unique (user_id) goes. It is not merely redundant, it is wrong
-- in two ways now: it would block a second member from ever creating the
-- workspace's row, and it would block an ownership transfer that moves
-- the row's user_id onto someone who already has one elsewhere. user_id
-- stays as the column recording who created the row.
--
-- Idempotent.

create unique index if not exists workspace_settings_workspace_id_uq
  on public.workspace_settings (workspace_id);

alter table public.workspace_settings
  drop constraint if exists workspace_settings_user_id_key;

-- Belt and braces: the index backing that constraint, if it was ever
-- created as a bare index rather than through the constraint.
drop index if exists public.workspace_settings_user_id_key;

-- (user_id, created_at) was for "my settings rows, newest first", a query
-- that no longer exists: there is one row and it is found by workspace.
drop index if exists public.workspace_settings_user_created_idx;

comment on index public.workspace_settings_workspace_id_uq is
  'Phase T2d. One settings row per workspace, enforced rather than assumed: every member calls loadSettings() and would otherwise be able to insert a second row, after which the single-row read fails permanently.';

do $verify$
declare v_n int;
begin
  select count(*) into v_n from pg_indexes
   where schemaname = 'public' and indexname = 'workspace_settings_workspace_id_uq';
  if v_n <> 1 then
    raise exception 'T2d: the per-workspace unique index is missing';
  end if;

  if exists (
    select 1 from pg_constraint
     where conname = 'workspace_settings_user_id_key'
  ) then
    raise exception 'T2d: the per-user unique constraint is still present';
  end if;

  -- Should be impossible now, but prove the data agrees with the new rule.
  if exists (
    select 1 from public.workspace_settings
     group by workspace_id having count(*) > 1
  ) then
    raise exception 'T2d: a workspace already holds more than one settings row';
  end if;

  raise notice 'T2d: workspace_settings is one row per workspace.';
end $verify$;
