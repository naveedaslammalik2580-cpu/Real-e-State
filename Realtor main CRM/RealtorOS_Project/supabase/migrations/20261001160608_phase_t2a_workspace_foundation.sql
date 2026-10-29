-- Phase T2a: workspace foundation (additive only).
--
-- Introduces workspaces / workspace_members / workspace_invitations, adds a
-- nullable workspace_id uuid to every public table that currently has a
-- user_id, backfills one personal workspace per auth user (every existing
-- user becomes the Owner of their own data), attaches a BEFORE INSERT
-- compatibility trigger so the EXISTING, UNMODIFIED frontend keeps working,
-- then enforces workspace_id NOT NULL on every one of those tables.
--
-- Nothing about today's RLS policies, grants on existing tables, or Edge
-- Function behavior changes here. T2b (RLS cutover) and later phases layer
-- on top. See docs/TEAM_ACCESS_ARCHITECTURE.md for the full staging plan.
--
-- Idempotent: every statement uses IF NOT EXISTS / CREATE OR REPLACE / a
-- condition-checked DO block, and the backfill is keyed on
-- `where workspace_id is null`. Safe to re-run.
--
-- Deviations from the design doc (owner decisions, override the doc):
--   * Roles collapsed to lowercase 'owner' | 'admin' | 'agent' (CHECK
--     constraint; more presets can be added later without a schema change).
--   * No per-member permission JSONB in v1.
--   * One ACTIVE membership per user_id (one team per person); enforced via
--     a partial unique index on workspace_members (user_id) WHERE
--     status = 'active'.
--   * No user_directory mirror and no deal_values / deal_commissions split
--     — both deferred.
--   * Team-mode toggle not part of T2a.
--   * All existing team_members rows are deleted (fake data per owner).

-- ============================================================
-- 0. Shared helper schema (reuses the Phase 4D automation_internal schema
--    — service_role only, no public/anon/authenticated grants).
-- ============================================================
create schema if not exists automation_internal;
revoke all on schema automation_internal from public, anon, authenticated;
grant usage on schema automation_internal to service_role;

-- ============================================================
-- 1. NEW TABLES: workspaces, workspace_members, workspace_invitations
-- ============================================================
create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'My workspace',
  owner_user_id uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'agent' check (role in ('owner', 'admin', 'agent')),
  status text not null default 'active' check (status in ('active', 'suspended', 'removed')),
  team_member_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workspace_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  normalized_email text not null,
  role text not null check (role in ('admin', 'agent')),
  token_hash text not null,
  invited_by uuid not null references auth.users(id) on delete restrict,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'revoked', 'expired')),
  expires_at timestamptz not null,
  accepted_by uuid references auth.users(id) on delete set null,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- updated_at bookkeeping on the three new tables (reuses the existing helper).
drop trigger if exists workspaces_set_updated_at on public.workspaces;
create trigger workspaces_set_updated_at
  before update on public.workspaces
  for each row execute function public.realtoros_set_updated_at();

drop trigger if exists workspace_members_set_updated_at on public.workspace_members;
create trigger workspace_members_set_updated_at
  before update on public.workspace_members
  for each row execute function public.realtoros_set_updated_at();

drop trigger if exists workspace_invitations_set_updated_at on public.workspace_invitations;
create trigger workspace_invitations_set_updated_at
  before update on public.workspace_invitations
  for each row execute function public.realtoros_set_updated_at();

-- RLS + grants on the three new tables.
-- Browser: SELECT only, and only its own membership / its workspaces.
-- No INSERT/UPDATE/DELETE policies: every write goes through service_role
-- functions (added in later phases). anon has nothing.
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_invitations enable row level security;

revoke all on public.workspaces from public, anon, authenticated;
revoke all on public.workspace_members from public, anon, authenticated;
revoke all on public.workspace_invitations from public, anon, authenticated;

grant select on public.workspaces to authenticated;
grant select on public.workspace_members to authenticated;
grant all on public.workspaces to service_role;
grant all on public.workspace_members to service_role;
grant all on public.workspace_invitations to service_role;

-- SELECT: the authenticated user may read only their own membership rows.
-- (Non-recursive: this policy filters workspace_members itself by a
-- scalar auth.uid() comparison; nothing in the predicate reads
-- workspace_members through RLS.)
drop policy if exists workspace_members_select_own on public.workspace_members;
create policy workspace_members_select_own
  on public.workspace_members
  for select to authenticated
  using (user_id = (select auth.uid()));

-- SELECT: the authenticated user may read any workspace they are an
-- active member of. The subquery on workspace_members goes through RLS
-- which the policy above already restricts to the caller's own rows, so
-- there is no leak and no recursion.
drop policy if exists workspaces_select_member on public.workspaces;
create policy workspaces_select_member
  on public.workspaces
  for select to authenticated
  using (
    exists (
      select 1 from public.workspace_members wm
      where wm.workspace_id = workspaces.id
        and wm.user_id = (select auth.uid())
        and wm.status = 'active'
    )
  );

-- workspace_invitations: no browser policies in v1 (service_role only).

-- ============================================================
-- 2. ADD workspace_id uuid (nullable at first) TO EVERY user_id TABLE
--    (36 tables). Also:
--      * team_members.auth_user_id (nullable → auth.users, SET NULL)
--      * contacts.assigned_to_id (text, composite FK added in §7)
--
--    workspace_state is intentionally skipped — it is the pre-relational
--    legacy table carried through migrations only as a one-time migration
--    source (see the comment at the top of
--    20260827040054_create_realtoros_workspace_state.sql); it has user_id
--    as its PK with no business rows written since Phase 3 and nothing
--    reads it today.
-- ============================================================
do $$
declare t text;
begin
  foreach t in array array[
    'contacts', 'team_members', 'properties', 'deals', 'milestones', 'tasks',
    'activities', 'showings', 'referrals', 'goals', 'finance_records', 'scripts',
    'ai_prompts', 'scheduled_items', 'custom_field_values', 'workspace_settings',
    'notifications', 'contact_stop_events',
    'automation_rules', 'automation_steps', 'automation_enrollments',
    'automation_jobs', 'automation_runs', 'automation_failures',
    'automation_trigger_events',
    'communication_consents', 'contact_identity_keys', 'email_sender_profiles',
    'email_suppressions', 'message_templates', 'outbound_messages', 'webhook_events',
    'lead_import_batches', 'lead_import_rows', 'lead_source_connections',
    'lead_source_mappings'
  ] loop
    execute format(
      'alter table public.%I add column if not exists workspace_id uuid references public.workspaces(id) on delete cascade',
      t
    );
  end loop;
end $$;

alter table public.team_members
  add column if not exists auth_user_id uuid references auth.users(id) on delete set null;

alter table public.contacts
  add column if not exists assigned_to_id text;

-- ============================================================
-- 3. CLEAN FAKE DATA (before composite FKs, before NOT NULL).
--    Verified live state: one fake team_members row; one scheduled_items
--    row with assigned_to set; all deals.assigned_to_id and
--    tasks.assigned_to_id are null. contacts.assigned_agent (free text)
--    is retained; it is deprecated, not deleted.
--
--    Guarded on "no workspaces exist yet" so a re-run of this migration
--    does not delete the owner team_members rows created by §6's
--    backfill (whose ids are `tm_<uuid-hex>` and which exist only
--    because a prior apply of this very migration created them).
-- ============================================================
do $$
begin
  if not exists (select 1 from public.workspaces) then
    -- scheduled_items.assigned_to_name is `text NOT NULL DEFAULT ''`
    -- (20260829050743_migrate_realtoros_to_relational.sql); clear it to
    -- the empty string, not null (which would raise 23502 on live rows
    -- — caught by the Phase T2a live dry-run, missed by PGlite because
    -- the test db had no scheduled_items rows). scheduled_items.assigned_to,
    -- deals.assigned_to_id and tasks.assigned_to_id are plain `text`
    -- (nullable) so null is correct for those.
    update public.scheduled_items
      set assigned_to = null, assigned_to_name = ''
      where assigned_to is not null or assigned_to_name <> '';

    update public.deals set assigned_to_id = null where assigned_to_id is not null;
    update public.tasks set assigned_to_id = null where assigned_to_id is not null;

    delete from public.team_members;
  end if;
end $$;

-- ============================================================
-- 4. ensure_personal_workspace(p_user_id) — idempotent provisioner.
--
-- SECURITY DEFINER: must INSERT into workspaces / workspace_members /
-- team_members for a user the browser has no grants on. Owner-rights
-- execute. Granted to service_role only; the browser reaches it
-- transitively via the §5 BEFORE INSERT compat trigger, whose own
-- SECURITY DEFINER context picks up EXECUTE on this function through
-- normal ownership.
-- ============================================================
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
    raise exception 'ensure_personal_workspace: user_id is null'
      using errcode = '22023';
  end if;

  -- Idempotent fast path.
  select workspace_id into v_workspace_id
    from public.workspace_members
    where user_id = p_user_id and status = 'active'
    limit 1;
  if v_workspace_id is not null then
    return v_workspace_id;
  end if;

  -- Email is read for the seeded team_members profile. In production the
  -- column exists; in test harnesses that stub auth.users without it, the
  -- row-to-jsonb path returns null and the coalesce below handles it.
  select to_jsonb(u) ->> 'email' into v_email
    from auth.users u where u.id = p_user_id;

  insert into public.workspaces (name, owner_user_id)
    values ('My workspace', p_user_id)
    returning id into v_workspace_id;

  -- Insert workspace_members BEFORE team_members so that any downstream
  -- compat trigger on team_members (which validates the row owner's
  -- active workspace membership) sees this row already present. Then
  -- insert team_members, then set workspace_members.team_member_id to
  -- link the two. team_member_id is nullable; the composite FK
  -- (workspace_id, team_member_id) → team_members ignores nulls.
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

  return v_workspace_id;
end;
$fn$;

revoke all on function automation_internal.ensure_personal_workspace(uuid)
  from public, anon, authenticated;
grant execute on function automation_internal.ensure_personal_workspace(uuid)
  to service_role;

comment on function automation_internal.ensure_personal_workspace(uuid) is
  'Returns the active workspace_id for p_user_id, creating a personal workspace + owner workspace_members row + owner team_members row when none exists. Idempotent. Not callable from the browser; the Phase T2a compatibility trigger reaches it through its own DEFINER context.';

-- ============================================================
-- 5. compat_set_workspace_id() — BEFORE INSERT trigger function.
--
-- Fills NEW.workspace_id for the existing frontend, which still inserts
-- without one. For browser callers that *do* send a value, it must be
-- the row owner's own active workspace or the insert is refused.
--
-- Why SECURITY DEFINER: the function calls ensure_personal_workspace,
-- which the browser has no EXECUTE on. The trigger itself fires
-- implicitly on INSERT and does NOT require EXECUTE on the trigger
-- function from the triggering role (postgres triggers invoke their
-- function from the trigger definition, not the role) — SECURITY DEFINER
-- here is purely so the inner ensure_personal_workspace call has the
-- grants it needs.
-- ============================================================
create or replace function automation_internal.compat_set_workspace_id()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_match integer;
begin
  if new.workspace_id is null then
    if new.user_id is null then
      raise exception 'compat_set_workspace_id: user_id is null, cannot derive workspace'
        using errcode = '22023';
    end if;
    new.workspace_id := automation_internal.ensure_personal_workspace(new.user_id);
  elsif (select auth.uid()) is not null then
    -- Only when the trigger fires inside an authenticated session (JWT
    -- present → auth.uid() returns a value) do we check cross-tenancy.
    -- service_role workers from Edge Functions do not carry a JWT so
    -- auth.uid() is null for them; the Phase T2a-era SECURITY INVOKER
    -- RPCs run as the invoking role, so an invoking browser is still
    -- flagged here. (We can't key off session_user or current_user:
    -- SECURITY DEFINER sets current_user to this function's owner, and
    -- Supabase's connection pooler keeps session_user fixed regardless
    -- of SET ROLE.) See the comment on compat_set_workspace_id.
    select 1 into v_match
      from public.workspace_members
      where workspace_id = new.workspace_id
        and user_id = new.user_id
        and status = 'active'
      limit 1;
    if v_match is null then
      raise exception 'workspace_id does not belong to the row owner'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$fn$;

revoke all on function automation_internal.compat_set_workspace_id()
  from public, anon, authenticated;
grant execute on function automation_internal.compat_set_workspace_id()
  to service_role;

comment on function automation_internal.compat_set_workspace_id() is
  'BEFORE INSERT compatibility trigger function. Fills NEW.workspace_id when the (unmodified) frontend omits it, and refuses browser inserts that supply a workspace_id the row owner is not an active member of. Removed in the Phase K cleanup once every writer sends workspace_id explicitly.';

-- Attach the compat trigger to every table that just got workspace_id.
do $$
declare t text;
begin
  foreach t in array array[
    'contacts', 'team_members', 'properties', 'deals', 'milestones', 'tasks',
    'activities', 'showings', 'referrals', 'goals', 'finance_records', 'scripts',
    'ai_prompts', 'scheduled_items', 'custom_field_values', 'workspace_settings',
    'notifications', 'contact_stop_events',
    'automation_rules', 'automation_steps', 'automation_enrollments',
    'automation_jobs', 'automation_runs', 'automation_failures',
    'automation_trigger_events',
    'communication_consents', 'contact_identity_keys', 'email_sender_profiles',
    'email_suppressions', 'message_templates', 'outbound_messages', 'webhook_events',
    'lead_import_batches', 'lead_import_rows', 'lead_source_connections',
    'lead_source_mappings'
  ] loop
    execute format('drop trigger if exists %I on public.%I', t || '_compat_workspace_id', t);
    execute format(
      'create trigger %I before insert on public.%I for each row execute function automation_internal.compat_set_workspace_id()',
      t || '_compat_workspace_id', t
    );
  end loop;
end $$;

-- ============================================================
-- 6. BACKFILL (idempotent).
--    (a) Call ensure_personal_workspace for every auth.users row — this
--        covers accounts with no business data too, so every current
--        user has a workspace waiting whether or not they ever used it.
--    (b) Set workspace_id on every existing business row from the owner's
--        active workspace. UPDATEs are gated on workspace_id IS NULL, so
--        rerunning this migration is a no-op.
-- ============================================================
do $$
declare u uuid;
begin
  for u in select id from auth.users loop
    perform automation_internal.ensure_personal_workspace(u);
  end loop;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'contacts', 'team_members', 'properties', 'deals', 'milestones', 'tasks',
    'activities', 'showings', 'referrals', 'goals', 'finance_records', 'scripts',
    'ai_prompts', 'scheduled_items', 'custom_field_values', 'workspace_settings',
    'notifications', 'contact_stop_events',
    'automation_rules', 'automation_steps', 'automation_enrollments',
    'automation_jobs', 'automation_runs', 'automation_failures',
    'automation_trigger_events',
    'communication_consents', 'contact_identity_keys', 'email_sender_profiles',
    'email_suppressions', 'message_templates', 'outbound_messages', 'webhook_events',
    'lead_import_batches', 'lead_import_rows', 'lead_source_connections',
    'lead_source_mappings'
  ] loop
    execute format(
      'update public.%I r
         set workspace_id = m.workspace_id
         from public.workspace_members m
         where m.user_id = r.user_id
           and m.status = ''active''
           and m.role = ''owner''
           and r.workspace_id is null',
      t
    );
  end loop;
end $$;

-- Prove zero nulls per table (raise otherwise), then enforce NOT NULL.
do $$
declare t text; v_null bigint;
begin
  foreach t in array array[
    'contacts', 'team_members', 'properties', 'deals', 'milestones', 'tasks',
    'activities', 'showings', 'referrals', 'goals', 'finance_records', 'scripts',
    'ai_prompts', 'scheduled_items', 'custom_field_values', 'workspace_settings',
    'notifications', 'contact_stop_events',
    'automation_rules', 'automation_steps', 'automation_enrollments',
    'automation_jobs', 'automation_runs', 'automation_failures',
    'automation_trigger_events',
    'communication_consents', 'contact_identity_keys', 'email_sender_profiles',
    'email_suppressions', 'message_templates', 'outbound_messages', 'webhook_events',
    'lead_import_batches', 'lead_import_rows', 'lead_source_connections',
    'lead_source_mappings'
  ] loop
    execute format('select count(*) from public.%I where workspace_id is null', t)
      into v_null;
    if v_null > 0 then
      raise exception 'phase_t2a: %.workspace_id still has % null rows after backfill', t, v_null;
    end if;
    execute format('alter table public.%I alter column workspace_id set not null', t);
  end loop;
end $$;

-- ============================================================
-- 7. UNIQUE INDEXES and composite FKs.
--
--   (a) Partial-unique invariants on workspace_members and on
--       workspace_invitations.
--   (b) (workspace_id, id) UNIQUE on every workspace-scoped table —
--       the parent-side index future column-scoped composite FKs
--       (workspace_id, related_id) will target, and the natural
--       workspace-scoped covering index for T2b's RLS.
--   (c) The two composite FKs this phase introduces:
--         workspace_members (workspace_id, team_member_id) → team_members
--         contacts (workspace_id, assigned_to_id)         → team_members
--       Both use the column-scoped ON DELETE SET NULL (col) form so an
--       assignee being removed from the workspace nulls only that one
--       column, not the tenant column (doc §1.2 — restated here).
-- ============================================================

-- (a) workspace_members: one active membership per user, one active
--     owner per workspace, plus a workspace+status lookup index.
create unique index if not exists workspace_members_one_active_per_user
  on public.workspace_members (user_id)
  where status = 'active';

create unique index if not exists workspace_members_one_active_owner_per_workspace
  on public.workspace_members (workspace_id)
  where status = 'active' and role = 'owner';

create index if not exists workspace_members_by_workspace_status
  on public.workspace_members (workspace_id, status);

-- workspace_invitations: at most one pending invitation per
-- (workspace, email); token hash lookup.
create unique index if not exists workspace_invitations_pending_per_email
  on public.workspace_invitations (workspace_id, normalized_email)
  where status = 'pending';
create index if not exists workspace_invitations_token_hash_idx
  on public.workspace_invitations (token_hash);

-- (b) (workspace_id, id) unique on every workspace-scoped table that has
--     an `id` column. email_sender_profiles is the one exception: its PK
--     is user_id (one row per user), so the workspace-scoped parent-side
--     uniqueness is (workspace_id, user_id) instead.
do $$
declare t text;
begin
  foreach t in array array[
    'contacts', 'team_members', 'properties', 'deals', 'milestones', 'tasks',
    'activities', 'showings', 'referrals', 'goals', 'finance_records', 'scripts',
    'ai_prompts', 'scheduled_items', 'custom_field_values', 'workspace_settings',
    'notifications', 'contact_stop_events',
    'automation_rules', 'automation_steps', 'automation_enrollments',
    'automation_jobs', 'automation_runs', 'automation_failures',
    'automation_trigger_events',
    'communication_consents', 'contact_identity_keys',
    'email_suppressions', 'message_templates', 'outbound_messages', 'webhook_events',
    'lead_import_batches', 'lead_import_rows', 'lead_source_connections',
    'lead_source_mappings'
  ] loop
    execute format(
      'create unique index if not exists %I on public.%I (workspace_id, id)',
      t || '_workspace_id_id_uq', t
    );
  end loop;
end $$;

create unique index if not exists email_sender_profiles_workspace_id_user_uq
  on public.email_sender_profiles (workspace_id, user_id);

-- (c) The two column-scoped composite FKs this phase introduces.
alter table public.workspace_members
  drop constraint if exists workspace_members_team_member_fk;
alter table public.workspace_members
  add constraint workspace_members_team_member_fk
  foreign key (workspace_id, team_member_id)
  references public.team_members (workspace_id, id)
  on delete set null (team_member_id);

alter table public.contacts
  drop constraint if exists contacts_assigned_team_member_fk;
alter table public.contacts
  add constraint contacts_assigned_team_member_fk
  foreign key (workspace_id, assigned_to_id)
  references public.team_members (workspace_id, id)
  on delete set null (assigned_to_id);

-- ============================================================
-- 8. Dashboard comments on the new tables and columns.
-- ============================================================
comment on table public.workspaces is
  'Phase T2a. Every account owns a workspace. Solo users have exactly one with owner_user_id = that user; shared teams add more workspace_members in later phases. owner_user_id uses ON DELETE RESTRICT so an auth.users deletion cannot silently drop a shared workspace.';
comment on table public.workspace_members is
  'Phase T2a. One row per (workspace, Auth user). Role is a fixed preset (owner|admin|agent); permission JSON is intentionally omitted in v1. Partial unique indexes enforce (i) one active membership per user and (ii) one active owner per workspace. team_member_id is the directory profile for this member, via a column-scoped composite FK on (workspace_id, team_member_id).';
comment on table public.workspace_invitations is
  'Phase T2a. Table only; invitation Edge Functions arrive in a later phase. Browser has no access (service_role grants only, no RLS SELECT policies).';
comment on column public.team_members.auth_user_id is
  'Phase T2a. When a directory row is also an Auth user (owner today, invited members later), this is the Auth user id; null for directory-only people.';
comment on column public.contacts.assigned_to_id is
  'Phase T2a. The team_members id this contact is assigned to, via the composite FK (workspace_id, assigned_to_id). Coexists with the legacy free-text contacts.assigned_agent column until the UI switches over in a later phase.';
