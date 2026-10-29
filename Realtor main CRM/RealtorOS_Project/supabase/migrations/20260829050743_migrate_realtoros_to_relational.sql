-- RealtorOS relational persistence.
-- workspace_state is intentionally retained until every user has migrated.

create or replace function public.realtoros_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.contacts (
  id text primary key, user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  full_name text not null default '', email text not null default '', phone text not null default '',
  type text not null default 'Buyer', status text not null default 'New Lead',
  source text not null default 'Other', temperature text not null default 'Warm',
  last_contact date, next_follow_up date, budget numeric not null default 0,
  preferred_area text not null default '', assigned_agent text not null default 'Self',
  address text not null default '', notes text not null default '', tags text[] not null default '{}',
  avatar_url text, custom_fields jsonb not null default '{}', _sample boolean not null default false,
  unique (user_id, id)
);

create table if not exists public.team_members (
  id text primary key, user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  name text not null default '', role text not null default 'Agent', email text not null default '',
  phone text not null default '', avatar_url text, notes text not null default '', active boolean not null default true,
  unique (user_id, id)
);

create table if not exists public.properties (
  id text primary key, user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  address text not null default '', city text not null default '', state text not null default '', zip text not null default '',
  mls text not null default '', url text not null default '', price numeric not null default 0,
  offer_price numeric not null default 0, bedrooms integer not null default 0, bathrooms numeric not null default 0,
  sqft integer not null default 0, type text not null default '', status text not null default 'Active',
  listing_date date, target_close date, description text not null default '', images text[] not null default '{}',
  contact_id text, deal_id text, notes text not null default '', _sample boolean not null default false,
  unique (user_id, id),
  foreign key (user_id, contact_id) references public.contacts(user_id, id) on delete set null
);

create table if not exists public.deals (
  id text primary key, user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  title text not null default '', contact_id text, property_id text, assigned_to_id text,
  side text not null default 'Buyer', stage text not null default 'New', probability numeric not null default 10,
  offer_date date, contract_date date, expected_close date, value numeric not null default 0,
  commission_rate numeric not null default 0, team_split numeric not null default 0,
  brokerage_fee numeric not null default 0, referral_fee numeric not null default 0,
  tax_reserve numeric not null default 0, status text not null default 'active',
  notes text not null default '', lost_reason text not null default '', _sample boolean not null default false,
  unique (user_id, id),
  foreign key (user_id, contact_id) references public.contacts(user_id, id) on delete set null,
  foreign key (user_id, property_id) references public.properties(user_id, id) on delete set null,
  foreign key (user_id, assigned_to_id) references public.team_members(user_id, id) on delete set null
);

alter table public.properties
  add constraint properties_deal_tenant_fkey foreign key (user_id, deal_id)
  references public.deals(user_id, id) on delete set null;

create table if not exists public.milestones (
  id text primary key, user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  deal_id text not null, title text not null default '', completed boolean not null default false,
  due_date date, order_index integer not null default 99, status text not null default 'Pending',
  completed_at timestamptz, notes text not null default '', _sample boolean not null default false,
  unique (user_id, id),
  foreign key (user_id, deal_id) references public.deals(user_id, id) on delete cascade
);

create table if not exists public.tasks (
  id text primary key, user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  title text not null default '', description text not null default '', due_date date,
  completed boolean not null default false, completed_at timestamptz, priority text not null default 'Medium',
  status text not null default 'To Do', contact_id text, property_id text, deal_id text, assigned_to_id text,
  notes text not null default '', _sample boolean not null default false,
  unique (user_id, id),
  foreign key (user_id, contact_id) references public.contacts(user_id, id) on delete set null,
  foreign key (user_id, property_id) references public.properties(user_id, id) on delete set null,
  foreign key (user_id, deal_id) references public.deals(user_id, id) on delete set null,
  foreign key (user_id, assigned_to_id) references public.team_members(user_id, id) on delete set null
);

create table if not exists public.activities (
  id text primary key, user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  type text not null default 'Note', contact_id text, property_id text, deal_id text, task_id text,
  description text not null default '', subject text not null default '', notes text not null default '',
  outcome text not null default '', date timestamptz not null default now(), _sample boolean not null default false,
  unique (user_id, id),
  foreign key (user_id, contact_id) references public.contacts(user_id, id) on delete set null,
  foreign key (user_id, property_id) references public.properties(user_id, id) on delete set null,
  foreign key (user_id, deal_id) references public.deals(user_id, id) on delete set null,
  foreign key (user_id, task_id) references public.tasks(user_id, id) on delete set null
);

create table if not exists public.showings (
  id text primary key, user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  property_id text, contact_id text, deal_id text, date date, start_time text not null default '10:00',
  end_time text not null default '', notes text not null default '', feedback text not null default '',
  status text not null default 'Scheduled', _sample boolean not null default false,
  unique (user_id, id),
  foreign key (user_id, property_id) references public.properties(user_id, id) on delete set null,
  foreign key (user_id, contact_id) references public.contacts(user_id, id) on delete set null,
  foreign key (user_id, deal_id) references public.deals(user_id, id) on delete set null
);

create table if not exists public.referrals (
  id text primary key, user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  referrer_name text not null default '', referrer_contact_id text, referred_contact_id text, deal_id text,
  date date not null default current_date, status text not null default 'New', commission_amount numeric not null default 0,
  thank_you_sent boolean not null default false, thank_you_expense numeric not null default 0,
  notes text not null default '', _sample boolean not null default false,
  unique (user_id, id),
  foreign key (user_id, referrer_contact_id) references public.contacts(user_id, id) on delete set null,
  foreign key (user_id, referred_contact_id) references public.contacts(user_id, id) on delete set null,
  foreign key (user_id, deal_id) references public.deals(user_id, id) on delete set null
);

create table if not exists public.goals (
  id text primary key, user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  title text not null default '', type text not null default 'GCI', target_value numeric not null default 0,
  current_value numeric not null default 0, unit text not null default '', period text not null default '',
  year integer, deadline date, notes text not null default '', _sample boolean not null default false,
  unique (user_id, id)
);

create table if not exists public.finance_records (
  id text primary key, user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  type text not null check (type in ('income','expense')), amount numeric not null default 0,
  category text not null default '', description text not null default '', date date not null default current_date,
  deal_id text, contact_id text, notes text not null default '', _sample boolean not null default false,
  unique (user_id, id),
  foreign key (user_id, deal_id) references public.deals(user_id, id) on delete set null,
  foreign key (user_id, contact_id) references public.contacts(user_id, id) on delete set null
);

create table if not exists public.scripts (
  id text primary key, user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  title text not null default '', category text not null default 'Follow-up', content text not null default '',
  tags text[] not null default '{}', is_sample boolean not null default false,
  unique (user_id, id)
);

create table if not exists public.ai_prompts (
  id text primary key, user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  title text not null default '', category text not null default 'Follow-up', prompt_text text not null default '',
  tags text[] not null default '{}', is_sample boolean not null default false,
  unique (user_id, id)
);

create table if not exists public.scheduled_items (
  id text primary key, user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  title text not null default '', type text not null default '', date date, time text not null default '', duration integer,
  contact_id text, property_id text, deal_id text, script_id text, script_title text not null default '',
  date_time timestamptz, assigned_to text, assigned_to_name text not null default '',
  notes text not null default '', completed boolean not null default false, _sample boolean not null default false,
  unique (user_id, id),
  foreign key (user_id, contact_id) references public.contacts(user_id, id) on delete set null,
  foreign key (user_id, property_id) references public.properties(user_id, id) on delete set null,
  foreign key (user_id, deal_id) references public.deals(user_id, id) on delete set null,
  foreign key (user_id, script_id) references public.scripts(user_id, id) on delete set null,
  foreign key (user_id, assigned_to) references public.team_members(user_id, id) on delete set null
);

create table if not exists public.custom_field_values (
  id text primary key, user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  entity_type text not null, record_id text not null, field_key text not null, field_value jsonb,
  unique (user_id, entity_type, record_id, field_key), unique (user_id, id)
);

create table if not exists public.workspace_settings (
  id text primary key, user_id uuid not null unique references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  pipeline_stages jsonb not null default '[]', commission_defaults jsonb not null default '{}',
  custom_field_definitions jsonb not null default '[]', module_toggles jsonb not null default '{}',
  business_profile jsonb not null default '{}', ui_preferences jsonb not null default '{}',
  settings_data jsonb not null default '{}', metadata jsonb not null default '{}',
  migration_completed_at timestamptz
);

do $$
declare t text;
begin
  foreach t in array array['contacts','team_members','properties','deals','milestones','tasks','activities','showings','referrals','goals','finance_records','scripts','ai_prompts','scheduled_items','custom_field_values','workspace_settings'] loop
    execute format('create index if not exists %I on public.%I (user_id, created_at desc)', t || '_user_created_idx', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_select_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_update_own', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete_own', t);
    execute format('create policy %I on public.%I for select to authenticated using ((select auth.uid()) = user_id)', t || '_select_own', t);
    execute format('create policy %I on public.%I for insert to authenticated with check ((select auth.uid()) = user_id)', t || '_insert_own', t);
    execute format('create policy %I on public.%I for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)', t || '_update_own', t);
    execute format('create policy %I on public.%I for delete to authenticated using ((select auth.uid()) = user_id)', t || '_delete_own', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('drop trigger if exists %I on public.%I', t || '_set_updated_at', t);
    execute format('create trigger %I before update on public.%I for each row execute function public.realtoros_set_updated_at()', t || '_set_updated_at', t);
  end loop;
end $$;

create or replace function public.realtoros_clear_sample_data()
returns void language plpgsql security invoker set search_path = '' as $$
begin
  delete from public.activities where user_id = (select auth.uid()) and _sample;
  delete from public.tasks where user_id = (select auth.uid()) and _sample;
  delete from public.showings where user_id = (select auth.uid()) and _sample;
  delete from public.referrals where user_id = (select auth.uid()) and _sample;
  delete from public.milestones where user_id = (select auth.uid()) and _sample;
  delete from public.finance_records where user_id = (select auth.uid()) and _sample;
  delete from public.scheduled_items where user_id = (select auth.uid()) and _sample;
  delete from public.deals where user_id = (select auth.uid()) and _sample;
  delete from public.properties where user_id = (select auth.uid()) and _sample;
  delete from public.contacts where user_id = (select auth.uid()) and _sample;
  delete from public.goals where user_id = (select auth.uid()) and _sample;
  delete from public.scripts where user_id = (select auth.uid()) and is_sample;
  delete from public.ai_prompts where user_id = (select auth.uid()) and is_sample;
end;
$$;

create or replace function public.realtoros_reset_workspace()
returns void language plpgsql security invoker set search_path = '' as $$
begin
  delete from public.activities where user_id = (select auth.uid());
  delete from public.tasks where user_id = (select auth.uid());
  delete from public.showings where user_id = (select auth.uid());
  delete from public.referrals where user_id = (select auth.uid());
  delete from public.milestones where user_id = (select auth.uid());
  delete from public.finance_records where user_id = (select auth.uid());
  delete from public.scheduled_items where user_id = (select auth.uid());
  delete from public.deals where user_id = (select auth.uid());
  delete from public.properties where user_id = (select auth.uid());
  delete from public.contacts where user_id = (select auth.uid());
  delete from public.goals where user_id = (select auth.uid());
  delete from public.scripts where user_id = (select auth.uid());
  delete from public.ai_prompts where user_id = (select auth.uid());
  delete from public.team_members where user_id = (select auth.uid());
  delete from public.custom_field_values where user_id = (select auth.uid());
  delete from public.workspace_settings where user_id = (select auth.uid());
end;
$$;

revoke all on function public.realtoros_clear_sample_data() from public, anon;
revoke all on function public.realtoros_reset_workspace() from public, anon;
grant execute on function public.realtoros_clear_sample_data() to authenticated;
grant execute on function public.realtoros_reset_workspace() to authenticated;

do $$
declare t text;
begin
  foreach t in array array['contacts','team_members','properties','deals','milestones','tasks','activities','showings','referrals','goals','finance_records','scripts','ai_prompts','scheduled_items','custom_field_values','workspace_settings'] loop
    if not exists (
      select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then execute format('alter publication supabase_realtime add table public.%I', t); end if;
  end loop;
end $$;
