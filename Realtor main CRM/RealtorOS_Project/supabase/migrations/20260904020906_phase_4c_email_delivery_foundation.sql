-- Phase 4C: secure email delivery foundation.
-- Additive only: existing CRM/automation tables, data, RPCs, RLS, and
-- Realtime are preserved. This migration does not activate automation and
-- does not create any runtime automation record.
--
-- Adds:
--   1. public.email_sender_profiles (owner-writable sender identity)
--   2. Extensions to public.outbound_messages (safe additive columns +
--      widened status set, still SELECT-only for authenticated users)
--   3. public.email_suppressions (runtime-owned; browser SELECT-only)
--
-- No Resend API key, webhook secret, or sending domain is ever stored in
-- any table created or touched here — those remain Edge Function
-- environment variables only (RESEND_API_KEY, RESEND_WEBHOOK_SECRET,
-- RESEND_SENDING_DOMAIN).

-- ---------- 1. EMAIL SENDER PROFILES ----------

create table public.email_sender_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  reply_to_email text not null,
  is_enabled boolean not null default false,
  provider text not null default 'resend'
    check (provider = 'resend'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  -- 1-100 chars, no control characters (blocks CR/LF header-injection).
  check (char_length(display_name) between 1 and 100),
  check (display_name !~ '[\x00-\x1F\x7F]'),
  check (display_name = btrim(display_name)),
  -- A single, reasonably-shaped address: no commas, no display-name
  -- syntax, no control characters, 1-254 chars (RFC 5321 limit).
  check (char_length(reply_to_email) between 1 and 254),
  check (reply_to_email !~ '[\x00-\x1F\x7F]'),
  check (reply_to_email = btrim(reply_to_email)),
  check (
    reply_to_email ~
    '^[A-Za-z0-9.!#$%&''*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$'
  )
);

alter table public.email_sender_profiles enable row level security;
revoke all on table public.email_sender_profiles from public, anon, authenticated;
grant all on table public.email_sender_profiles to service_role;
-- No delete grant: a sender profile is only ever created/edited, never
-- removed by the browser, in this phase.
grant select, insert, update on table public.email_sender_profiles to authenticated;

create policy email_sender_profiles_select_own
  on public.email_sender_profiles
  for select to authenticated
  using ((select auth.uid()) = user_id);

create policy email_sender_profiles_insert_own
  on public.email_sender_profiles
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy email_sender_profiles_update_own
  on public.email_sender_profiles
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create trigger email_sender_profiles_set_updated_at
  before update on public.email_sender_profiles
  for each row execute function public.realtoros_set_updated_at();

comment on table public.email_sender_profiles is
  'Per-user email sender identity (display name + Reply-To) only. Never stores a Resend API key, webhook secret, sending domain, or an arbitrary From address — those are server-only Edge Function configuration.';

-- ---------- 2. OUTBOUND MESSAGES: SAFE ADDITIVE EXTENSION ----------

alter table public.outbound_messages
  add column message_kind text not null default 'automation'
    check (message_kind in ('test', 'manual', 'automation')),
  add column idempotency_key uuid,
  add column sender_display_name text,
  add column sender_address text,
  add column reply_to_email text,
  add column delivery_delayed_at timestamptz,
  add column bounced_at timestamptz,
  add column complained_at timestamptz,
  add column suppressed_at timestamptz,
  add column unsubscribed_at timestamptz;

-- A self-addressed test message has no CRM contact to attach to; every
-- other kind keeps the original not-null + owner-scoped FK requirement.
alter table public.outbound_messages alter column contact_id drop not null;
alter table public.outbound_messages
  add constraint outbound_messages_contact_required_unless_test
  check (message_kind = 'test' or contact_id is not null);

-- Widen the allowed status set. The original constraint was a column
-- CHECK named by Postgres's default convention ({table}_{column}_check).
alter table public.outbound_messages drop constraint outbound_messages_status_check;
alter table public.outbound_messages add constraint outbound_messages_status_check
  check (status in (
    'queued', 'sent', 'delivered', 'delivery_delayed', 'opened', 'clicked',
    'replied', 'bounced', 'complained', 'suppressed', 'failed', 'unsubscribed'
  ));

-- Owner-scoped idempotency: at most one row per (user_id, idempotency_key)
-- whenever a caller supplies one (test sends always do).
create unique index outbound_messages_user_idempotency_idx
  on public.outbound_messages (user_id, idempotency_key)
  where idempotency_key is not null;

-- Re-stated explicitly (already granted by the Phase 4B foundation
-- migration): authenticated users may only ever SELECT their own
-- outbound messages, still gated by the existing
-- outbound_messages_select_own RLS policy. No insert/update/delete grant
-- to authenticated exists or is added here — only service_role (used
-- exclusively by the send-test-email and resend-webhook Edge Functions)
-- may write to this table.
grant select on public.outbound_messages to authenticated;

comment on column public.outbound_messages.sender_display_name is
  'Snapshot of the sender display name used for this specific send, captured at send time.';
comment on column public.outbound_messages.sender_address is
  'Snapshot of the computed From address used for this specific send (server-derived alias @ RESEND_SENDING_DOMAIN) — never a user-supplied address.';
comment on column public.outbound_messages.reply_to_email is
  'Snapshot of the Reply-To address used for this specific send.';

-- ---------- 3. EMAIL SUPPRESSIONS (runtime-owned) ----------

create table public.email_suppressions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  normalized_email text not null,
  reason text not null
    check (reason in ('bounce', 'complaint', 'provider', 'unsubscribe', 'manual')),
  source_message_id uuid,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  unique (user_id, id),
  check (char_length(normalized_email) between 3 and 254),
  check (normalized_email = lower(btrim(normalized_email))),
  check (normalized_email !~ '[\x00-\x1F\x7F]'),
  -- Composite FK: only matches a message row with the SAME user_id, so a
  -- source_message_id belonging to a different user can never be linked.
  foreign key (user_id, source_message_id)
    references public.outbound_messages(user_id, id) on delete set null (source_message_id)
);

-- At most one ACTIVE suppression per (user_id, normalized_email); a
-- reactivated suppression (e.g. a second bounce) reuses/updates the same
-- row rather than creating a duplicate.
create unique index email_suppressions_active_unique_idx
  on public.email_suppressions (user_id, normalized_email)
  where is_active;

create index email_suppressions_user_email_idx
  on public.email_suppressions (user_id, normalized_email);

alter table public.email_suppressions enable row level security;
revoke all on table public.email_suppressions from public, anon, authenticated;
grant all on table public.email_suppressions to service_role;
-- Browser users may only ever read their own suppressions. Only the
-- trusted server/runtime (service_role, used exclusively by
-- send-test-email and resend-webhook) may create, reactivate, or update a
-- suppression — there is no insert/update/delete grant to authenticated.
grant select on public.email_suppressions to authenticated;

create policy email_suppressions_select_own
  on public.email_suppressions
  for select to authenticated
  using ((select auth.uid()) = user_id);

create trigger email_suppressions_set_updated_at
  before update on public.email_suppressions
  for each row execute function public.realtoros_set_updated_at();

comment on table public.email_suppressions is
  'Runtime-owned send-suppression list per user. Only service_role (send-test-email / resend-webhook Edge Functions) may write; browser users may only SELECT their own rows.';
