-- RealtorOS cloud migration: exact per-user workspace snapshot storage.
-- The JSONB state intentionally preserves the existing offline schema and IDs.
create table public.workspace_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  schema_version integer not null default 3 check (schema_version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.workspace_state enable row level security;

grant select, insert, update, delete on public.workspace_state to authenticated;

create policy "realtoros_select_own_workspace"
  on public.workspace_state for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "realtoros_insert_own_workspace"
  on public.workspace_state for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "realtoros_update_own_workspace"
  on public.workspace_state for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "realtoros_delete_own_workspace"
  on public.workspace_state for delete to authenticated
  using ((select auth.uid()) = user_id);

create or replace function public.set_workspace_state_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger workspace_state_set_updated_at
before update on public.workspace_state
for each row execute function public.set_workspace_state_updated_at();
