-- RealtorOS automation foundation.
-- Additive only: existing CRM tables, data, RPCs, RLS, and Realtime are preserved.

create table public.lead_source_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  name text not null default 'Google Sheets',
  provider text not null default 'google_sheets'
    check (provider in ('google_sheets')),
  spreadsheet_id text not null,
  spreadsheet_url text not null default '',
  raw_tab_name text not null default 'Raw Leads',
  ready_tab_name text not null default 'Ready',
  status text not null default 'pending'
    check (status in ('pending','active','paused','error','revoked')),
  sync_mode text not null default 'push'
    check (sync_mode in ('push','manual','interval')),
  sync_interval_minutes integer not null default 15
    check (sync_interval_minutes between 5 and 1440),
  connector_token_hash text,
  connector_token_prefix text,
  token_rotated_at timestamptz,
  last_synced_at timestamptz,
  next_sync_at timestamptz,
  last_cursor text,
  last_error text,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  unique (user_id, id),
  unique (user_id, spreadsheet_id, ready_tab_name),
  unique (connector_token_hash),
  check (connector_token_hash is null or connector_token_hash ~ '^[0-9a-f]{64}$'),
  check (connector_token_prefix is null or char_length(connector_token_prefix) between 4 and 16)
);

create table public.lead_source_mappings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  field_map jsonb not null default '{}'::jsonb
    check (jsonb_typeof(field_map) = 'object'),
  required_fields text[] not null default array['full_name']::text[],
  is_active boolean not null default true,
  notes text not null default '',
  unique (user_id, id),
  foreign key (user_id, connection_id)
    references public.lead_source_connections(user_id, id) on delete cascade
);

create table public.lead_import_batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  source_event_id text not null,
  sheet_revision text,
  status text not null default 'received'
    check (status in ('received','processing','completed','partial','failed')),
  source_row_count integer not null default 0 check (source_row_count >= 0),
  accepted_count integer not null default 0 check (accepted_count >= 0),
  duplicate_count integer not null default 0 check (duplicate_count >= 0),
  rejected_count integer not null default 0 check (rejected_count >= 0),
  imported_count integer not null default 0 check (imported_count >= 0),
  started_at timestamptz,
  completed_at timestamptz,
  error_summary text,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  unique (user_id, id),
  unique (user_id, connection_id, source_event_id),
  foreign key (user_id, connection_id)
    references public.lead_source_connections(user_id, id) on delete cascade,
  check (
    accepted_count + duplicate_count + rejected_count <= source_row_count
  )
);

create table public.contact_identity_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  contact_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  identity_type text not null
    check (identity_type in ('email','phone','source')),
  identity_hash text not null check (identity_hash ~ '^[0-9a-f]{64}$'),
  identity_hint text not null default '',
  source text not null default 'automation',
  unique (user_id, id),
  unique (user_id, identity_type, identity_hash),
  foreign key (user_id, contact_id)
    references public.contacts(user_id, id) on delete cascade
);

create table public.lead_import_rows (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  batch_id uuid not null,
  connection_id uuid not null,
  contact_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  source_row_key text not null,
  source_row_number integer check (source_row_number is null or source_row_number > 0),
  row_fingerprint text not null check (row_fingerprint ~ '^[0-9a-f]{64}$'),
  status text not null default 'accepted'
    check (status in ('accepted','duplicate','rejected','imported','failed')),
  error_code text,
  error_message text,
  error_context jsonb not null default '{}'::jsonb
    check (jsonb_typeof(error_context) = 'object'),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (user_id, id),
  unique (user_id, connection_id, source_row_key),
  foreign key (user_id, batch_id)
    references public.lead_import_batches(user_id, id) on delete cascade,
  foreign key (user_id, connection_id)
    references public.lead_source_connections(user_id, id) on delete cascade,
  foreign key (user_id, contact_id)
    references public.contacts(user_id, id) on delete set null (contact_id)
);

create table public.message_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  name text not null,
  channel text not null default 'email'
    check (channel in ('email','sms')),
  subject text not null default '',
  body_text text not null default '',
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  unique (user_id, id),
  unique (user_id, channel, name)
);

create table public.automation_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  name text not null,
  trigger_type text not null default 'new_lead'
    check (trigger_type in ('new_lead','contact_created','contact_status_changed','manual')),
  status text not null default 'draft'
    check (status in ('draft','active','paused','archived')),
  timezone text not null default 'UTC',
  audience_filter jsonb not null default '{}'::jsonb
    check (jsonb_typeof(audience_filter) = 'object'),
  stop_on_reply boolean not null default true,
  stop_on_unsubscribe boolean not null default true,
  daily_enrollment_limit integer not null default 100
    check (daily_enrollment_limit between 1 and 10000),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  unique (user_id, id),
  unique (user_id, name)
);

create table public.automation_steps (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  rule_id uuid not null,
  template_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  step_order integer not null check (step_order > 0),
  action_type text not null
    check (action_type in ('send_email','create_task','wait')),
  delay_minutes integer not null default 0
    check (delay_minutes between 0 and 525600),
  subject_override text,
  config jsonb not null default '{}'::jsonb
    check (jsonb_typeof(config) = 'object'),
  is_active boolean not null default true,
  unique (user_id, id),
  unique (user_id, rule_id, step_order),
  foreign key (user_id, rule_id)
    references public.automation_rules(user_id, id) on delete cascade,
  foreign key (user_id, template_id)
    references public.message_templates(user_id, id),
  check (
    (action_type = 'send_email' and template_id is not null)
    or action_type in ('create_task','wait')
  )
);

create table public.automation_enrollments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  rule_id uuid not null,
  contact_id text not null,
  source_batch_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  status text not null default 'active'
    check (status in ('active','paused','completed','stopped','failed')),
  current_step_order integer not null default 0 check (current_step_order >= 0),
  next_action_at timestamptz,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  stopped_at timestamptz,
  stop_reason text,
  reply_detected_at timestamptz,
  unsubscribe_detected_at timestamptz,
  context jsonb not null default '{}'::jsonb
    check (jsonb_typeof(context) = 'object'),
  unique (user_id, id),
  foreign key (user_id, rule_id)
    references public.automation_rules(user_id, id) on delete cascade,
  foreign key (user_id, contact_id)
    references public.contacts(user_id, id) on delete cascade,
  foreign key (user_id, source_batch_id)
    references public.lead_import_batches(user_id, id) on delete set null (source_batch_id)
);

create table public.automation_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  enrollment_id uuid,
  rule_id uuid,
  step_id uuid,
  contact_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  job_type text not null
    check (job_type in ('send_email','create_task','advance_enrollment')),
  status text not null default 'pending'
    check (status in ('pending','processing','completed','failed','cancelled')),
  scheduled_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 3 check (max_attempts between 1 and 20),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  idempotency_key text not null,
  payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payload) = 'object'),
  unique (user_id, id),
  unique (user_id, idempotency_key),
  foreign key (user_id, enrollment_id)
    references public.automation_enrollments(user_id, id) on delete cascade,
  foreign key (user_id, rule_id)
    references public.automation_rules(user_id, id) on delete cascade,
  foreign key (user_id, step_id)
    references public.automation_steps(user_id, id) on delete cascade,
  foreign key (user_id, contact_id)
    references public.contacts(user_id, id) on delete cascade
);

create table public.automation_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id uuid not null,
  enrollment_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  attempt_number integer not null check (attempt_number > 0),
  status text not null
    check (status in ('processing','completed','failed','cancelled')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  provider_status_code integer,
  provider_response jsonb not null default '{}'::jsonb
    check (jsonb_typeof(provider_response) = 'object'),
  error_code text,
  error_message text,
  unique (user_id, id),
  unique (user_id, job_id, attempt_number),
  foreign key (user_id, job_id)
    references public.automation_jobs(user_id, id) on delete cascade,
  foreign key (user_id, enrollment_id)
    references public.automation_enrollments(user_id, id) on delete cascade
);

create table public.communication_consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  contact_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  channel text not null check (channel in ('email','sms')),
  status text not null default 'unknown'
    check (status in ('unknown','opted_in','opted_out')),
  source text not null default 'import',
  evidence jsonb not null default '{}'::jsonb
    check (jsonb_typeof(evidence) = 'object'),
  effective_at timestamptz not null default now(),
  unique (user_id, id),
  unique (user_id, contact_id, channel),
  foreign key (user_id, contact_id)
    references public.contacts(user_id, id) on delete cascade
);

create table public.outbound_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id uuid,
  contact_id text not null,
  template_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  channel text not null check (channel in ('email','sms')),
  provider text not null,
  provider_message_id text,
  recipient text not null,
  subject text not null default '',
  body_snapshot text not null default '',
  status text not null default 'queued'
    check (status in ('queued','sent','delivered','opened','clicked','replied','bounced','failed','unsubscribed')),
  queued_at timestamptz not null default now(),
  sent_at timestamptz,
  delivered_at timestamptz,
  opened_at timestamptz,
  clicked_at timestamptz,
  replied_at timestamptz,
  failed_at timestamptz,
  error_code text,
  error_message text,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  unique (user_id, id),
  foreign key (user_id, job_id)
    references public.automation_jobs(user_id, id) on delete set null (job_id),
  foreign key (user_id, contact_id)
    references public.contacts(user_id, id) on delete cascade,
  foreign key (user_id, template_id)
    references public.message_templates(user_id, id) on delete set null (template_id)
);

create table public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  outbound_message_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  provider text not null,
  provider_event_id text not null,
  event_type text not null,
  signature_valid boolean not null default false,
  status text not null default 'received'
    check (status in ('received','processed','ignored','failed')),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payload) = 'object'),
  error_message text,
  unique (user_id, id),
  unique (provider, provider_event_id),
  foreign key (user_id, outbound_message_id)
    references public.outbound_messages(user_id, id) on delete set null (outbound_message_id)
);

create table public.automation_failures (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id uuid,
  run_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  category text not null
    check (category in ('validation','authentication','provider','rate_limit','network','database','unknown')),
  error_code text,
  error_message text not null,
  retriable boolean not null default true,
  resolved boolean not null default false,
  resolved_at timestamptz,
  resolution_notes text not null default '',
  context jsonb not null default '{}'::jsonb
    check (jsonb_typeof(context) = 'object'),
  unique (user_id, id),
  foreign key (user_id, job_id)
    references public.automation_jobs(user_id, id) on delete cascade,
  foreign key (user_id, run_id)
    references public.automation_runs(user_id, id) on delete cascade,
  check ((not resolved and resolved_at is null) or resolved)
);

create unique index lead_source_mappings_one_active_idx
  on public.lead_source_mappings (user_id, connection_id)
  where is_active;

create unique index automation_enrollments_one_open_idx
  on public.automation_enrollments (user_id, rule_id, contact_id)
  where status in ('active','paused');

create unique index outbound_messages_provider_message_idx
  on public.outbound_messages (provider, provider_message_id)
  where provider_message_id is not null;

create index lead_source_connections_due_idx
  on public.lead_source_connections (next_sync_at)
  where status = 'active' and sync_mode = 'interval';

create index lead_import_batches_connection_created_idx
  on public.lead_import_batches (user_id, connection_id, created_at desc);

create index contact_identity_keys_contact_idx
  on public.contact_identity_keys (user_id, contact_id);

create index lead_import_rows_batch_idx
  on public.lead_import_rows (user_id, batch_id);

create index lead_import_rows_contact_idx
  on public.lead_import_rows (user_id, contact_id)
  where contact_id is not null;

create index automation_steps_rule_order_idx
  on public.automation_steps (user_id, rule_id, step_order);

create index automation_enrollments_due_idx
  on public.automation_enrollments (next_action_at, id)
  where status = 'active' and next_action_at is not null;

create index automation_enrollments_contact_idx
  on public.automation_enrollments (user_id, contact_id);

create index automation_jobs_claim_idx
  on public.automation_jobs (scheduled_at, id)
  where status = 'pending';

create index automation_jobs_enrollment_idx
  on public.automation_jobs (user_id, enrollment_id)
  where enrollment_id is not null;

create index automation_runs_job_idx
  on public.automation_runs (user_id, job_id, attempt_number desc);

create index outbound_messages_contact_created_idx
  on public.outbound_messages (user_id, contact_id, created_at desc);

create index webhook_events_message_idx
  on public.webhook_events (user_id, outbound_message_id)
  where outbound_message_id is not null;

create index automation_failures_unresolved_idx
  on public.automation_failures (user_id, created_at desc)
  where not resolved;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'lead_source_connections',
    'lead_source_mappings',
    'lead_import_batches',
    'contact_identity_keys',
    'lead_import_rows',
    'message_templates',
    'automation_rules',
    'automation_steps',
    'automation_enrollments',
    'automation_jobs',
    'automation_runs',
    'communication_consents',
    'outbound_messages',
    'webhook_events',
    'automation_failures'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from public, anon, authenticated', table_name);
    execute format('grant all on table public.%I to service_role', table_name);
    execute format(
      'create policy %I on public.%I for select to authenticated using ((select auth.uid()) = user_id)',
      table_name || '_select_own',
      table_name
    );
    execute format(
      'drop trigger if exists %I on public.%I',
      table_name || '_set_updated_at',
      table_name
    );
    execute format(
      'create trigger %I before update on public.%I for each row execute function public.realtoros_set_updated_at()',
      table_name || '_set_updated_at',
      table_name
    );
  end loop;
end
$$;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'lead_source_mappings',
    'message_templates',
    'automation_rules',
    'automation_steps'
  ]
  loop
    execute format(
      'create policy %I on public.%I for insert to authenticated with check ((select auth.uid()) = user_id)',
      table_name || '_insert_own',
      table_name
    );
    execute format(
      'create policy %I on public.%I for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)',
      table_name || '_update_own',
      table_name
    );
    execute format(
      'create policy %I on public.%I for delete to authenticated using ((select auth.uid()) = user_id)',
      table_name || '_delete_own',
      table_name
    );
    execute format(
      'grant select, insert, update, delete on table public.%I to authenticated',
      table_name
    );
  end loop;
end
$$;

create policy lead_source_connections_insert_own
  on public.lead_source_connections
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy lead_source_connections_update_own
  on public.lead_source_connections
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy lead_source_connections_delete_own
  on public.lead_source_connections
  for delete to authenticated
  using ((select auth.uid()) = user_id);

grant select (
  id, user_id, created_at, updated_at, name, provider, spreadsheet_id,
  spreadsheet_url, raw_tab_name, ready_tab_name, status, sync_mode,
  sync_interval_minutes, connector_token_prefix, token_rotated_at,
  last_synced_at, next_sync_at, last_cursor, last_error, metadata
) on public.lead_source_connections to authenticated;

grant insert (
  user_id, name, provider, spreadsheet_id, spreadsheet_url, raw_tab_name,
  ready_tab_name, status, sync_mode, sync_interval_minutes, metadata
) on public.lead_source_connections to authenticated;

grant update (
  name, spreadsheet_id, spreadsheet_url, raw_tab_name, ready_tab_name,
  status, sync_mode, sync_interval_minutes, metadata
) on public.lead_source_connections to authenticated;

grant delete on public.lead_source_connections to authenticated;

grant select on public.lead_import_batches to authenticated;
grant select on public.contact_identity_keys to authenticated;
grant select on public.lead_import_rows to authenticated;
grant select on public.automation_enrollments to authenticated;
grant select on public.automation_jobs to authenticated;
grant select on public.automation_runs to authenticated;
grant select on public.communication_consents to authenticated;
grant select on public.outbound_messages to authenticated;
grant select on public.webhook_events to authenticated;
grant select on public.automation_failures to authenticated;

comment on column public.lead_source_connections.connector_token_hash is
  'SHA-256 hex digest only. The plaintext connector token must never be stored.';

comment on table public.contact_identity_keys is
  'Hashed normalized lead identities used for duplicate-safe imports without constraining manual CRM contacts.';

comment on table public.automation_jobs is
  'Durable automation queue. Workers must claim due rows with FOR UPDATE SKIP LOCKED.';
