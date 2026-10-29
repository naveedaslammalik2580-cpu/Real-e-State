-- REVERT for Phase T2d (one workspace_settings row per workspace).
--
-- NOT a migration. Run it only to undo
-- 20261007041926_phase_t2d_workspace_settings_singleton.sql.
--
-- WHAT IT DOES. Puts the per-user unique constraint back on
-- workspace_settings and drops the per-workspace one, returning the table
-- to the shape it had when one user was one workspace.
--
-- WHAT RUNNING THIS MEANS. The defect T2d fixed comes back: two members
-- of the same workspace can each insert their own settings row, after
-- which the single-row read (.maybeSingle()) errors for everyone in that
-- workspace, permanently. That is not a theoretical risk - it is what
-- happens the first time two people open a fresh shared workspace at the
-- same moment.
--
-- IT CAN ALSO FAIL, AND THAT IS THE POINT. If any workspace already holds
-- more than one settings row, the unique (user_id) cannot be restored
-- where two rows share a user, and more importantly a workspace with two
-- rows is exactly the state T2d exists to prevent. The guard below refuses
-- rather than leaving the table half-reverted.
--
-- (user_id, created_at) is restored too. Nothing queries it any more, but
-- its absence is the other half of what T2d changed, and these revert
-- files are compared against the pre-phase schema index for index.

set search_path = public;

begin;

-- ============================================================
-- 1. Refuse if the data has moved on.
-- ============================================================
do $guard$
begin
  if exists (
    select 1 from public.workspace_settings
     group by user_id having count(*) > 1
  ) then
    raise exception 'T2d revert: a user owns more than one settings row, so unique (user_id) cannot be restored';
  end if;
end $guard$;

-- ============================================================
-- 2. Back to unique (user_id).
--
-- As a CONSTRAINT, not a bare index: that is how
-- 20260829050743_migrate_realtoros_to_relational.sql declared it
-- (`user_id uuid not null unique`), and a constraint and an index of the
-- same name are not the same object to pg_constraint.
-- ============================================================
alter table public.workspace_settings
  drop constraint if exists workspace_settings_user_id_key;
alter table public.workspace_settings
  add constraint workspace_settings_user_id_key unique (user_id);

create index if not exists workspace_settings_user_created_idx
  on public.workspace_settings (user_id, created_at desc);

-- ============================================================
-- 3. And the per-workspace rule goes.
-- ============================================================
drop index if exists public.workspace_settings_workspace_id_uq;

-- ============================================================
-- 4. Verify.
-- ============================================================
do $verify$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'workspace_settings_user_id_key'
  ) then
    raise exception 'T2d revert: the per-user unique constraint was not restored';
  end if;
  if exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'workspace_settings_workspace_id_uq'
  ) then
    raise exception 'T2d revert: the per-workspace unique index is still there';
  end if;
  raise notice 'T2d reverted: workspace_settings is unique per user again, and a shared workspace can grow a second settings row.';
end $verify$;

commit;
