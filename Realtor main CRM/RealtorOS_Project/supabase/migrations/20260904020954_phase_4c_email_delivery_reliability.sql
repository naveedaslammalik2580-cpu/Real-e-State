-- Phase 4C correction: atomic claim + rate-limit for test sends.
-- Additive only. Does not modify the already-committed
-- 20260902075704_phase_4c_email_delivery_foundation.sql migration, and
-- does not touch any automation runtime table.
--
-- Adds a narrow lease so a single logical send attempt (one
-- idempotency_key) can be safely retried after a timeout, a malformed
-- provider response, or our own status-update failure, without ever
-- allowing two concurrent attempts to both call the provider.

alter table public.outbound_messages
  add column send_attempt_token uuid,
  add column send_attempt_started_at timestamptz,
  add column send_attempt_count integer not null default 0
    check (send_attempt_count >= 0);

comment on column public.outbound_messages.send_attempt_token is
  'Opaque per-attempt lease token. A new value is issued only when a stale (expired) lease is reclaimed for a retry of the same idempotency_key.';
comment on column public.outbound_messages.send_attempt_started_at is
  'When the current send attempt lease began. A queued row whose lease has expired is safe to reclaim and retry with the same idempotency_key.';

-- Claims an idempotency key and, only under a per-user advisory
-- transaction lock (so concurrent requests for the SAME user are fully
-- serialized), atomically decides one of:
--   'existing'       — a terminal (non-queued) row already exists; the
--                       caller must return it as-is, no provider call.
--   'in_progress'     — another attempt is actively leasing this same key
--                       right now; the caller must not call the provider.
--   'retry_claimed'   — the prior lease expired; a retry of the SAME
--                       provider call (same Idempotency-Key) is safe.
--   'rate_limited'    — the user is over the short or daily test-send
--                       limit; retry_after_seconds is the actual wait.
--   'created'         — a brand-new row was inserted; proceed to call
--                       the provider.
-- SECURITY INVOKER (not DEFINER): this function never needs to escalate
-- an unprivileged caller's rights — only service_role may ever execute
-- it (see the revoke/grant below), and service_role already has full
-- table access, so running as the caller's own (already-trusted)
-- privileges is the safer choice.
create or replace function public.realtoros_claim_test_send(
  p_user_id uuid,
  p_idempotency_key uuid,
  p_template_id uuid,
  p_recipient text,
  p_subject text,
  p_body_snapshot text,
  p_sender_display_name text,
  p_sender_address text,
  p_reply_to_email text,
  p_short_window_seconds integer,
  p_short_window_max integer,
  p_daily_window_seconds integer,
  p_daily_window_max integer,
  p_lease_seconds integer
)
returns jsonb
language plpgsql
security invoker
set search_path to ''
as $function$
declare
  v_existing public.outbound_messages%rowtype;
  v_new public.outbound_messages%rowtype;
  v_short_count bigint;
  v_daily_count bigint;
  v_oldest_short timestamptz;
  v_oldest_daily timestamptz;
  v_lease_expired boolean;
begin
  if p_short_window_seconds is null or p_short_window_seconds <= 0
    or p_daily_window_seconds is null or p_daily_window_seconds <= 0
    or p_lease_seconds is null or p_lease_seconds <= 0
    or p_short_window_max is null or p_short_window_max <= 0
    or p_daily_window_max is null or p_daily_window_max <= 0
  then
    raise exception 'invalid rate-limit/lease parameters';
  end if;

  -- Serialized per-user only — other users proceed fully in parallel.
  -- Released automatically at transaction end.
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 4242));

  select * into v_existing
    from public.outbound_messages
    where user_id = p_user_id and idempotency_key = p_idempotency_key;

  if found then
    if v_existing.status = 'queued' then
      v_lease_expired := v_existing.send_attempt_started_at is null
        or v_existing.send_attempt_started_at < (now() - make_interval(secs => p_lease_seconds));
      if v_lease_expired then
        update public.outbound_messages
          set send_attempt_token = gen_random_uuid(),
              send_attempt_started_at = now(),
              send_attempt_count = send_attempt_count + 1
          where id = v_existing.id
          returning * into v_new;
        return jsonb_build_object(
          'outcome', 'retry_claimed',
          'message_id', v_new.id,
          'send_attempt_token', v_new.send_attempt_token,
          'send_attempt_count', v_new.send_attempt_count
        );
      else
        return jsonb_build_object(
          'outcome', 'in_progress',
          'retry_after_seconds',
          greatest(1, p_lease_seconds - floor(extract(epoch from (now() - v_existing.send_attempt_started_at)))::integer)
        );
      end if;
    else
      return jsonb_build_object('outcome', 'existing', 'message_id', v_existing.id);
    end if;
  end if;

  select count(*), min(created_at) into v_short_count, v_oldest_short
    from public.outbound_messages
    where user_id = p_user_id and message_kind = 'test'
      and created_at >= now() - make_interval(secs => p_short_window_seconds);
  if v_short_count >= p_short_window_max then
    return jsonb_build_object(
      'outcome', 'rate_limited',
      'retry_after_seconds',
      greatest(1, ceil(extract(epoch from (v_oldest_short + make_interval(secs => p_short_window_seconds) - now())))::integer)
    );
  end if;

  select count(*), min(created_at) into v_daily_count, v_oldest_daily
    from public.outbound_messages
    where user_id = p_user_id and message_kind = 'test'
      and created_at >= now() - make_interval(secs => p_daily_window_seconds);
  if v_daily_count >= p_daily_window_max then
    return jsonb_build_object(
      'outcome', 'rate_limited',
      'retry_after_seconds',
      greatest(1, ceil(extract(epoch from (v_oldest_daily + make_interval(secs => p_daily_window_seconds) - now())))::integer)
    );
  end if;

  insert into public.outbound_messages (
    user_id, contact_id, template_id, message_kind, idempotency_key,
    channel, provider, recipient, subject, body_snapshot,
    sender_display_name, sender_address, reply_to_email,
    status, queued_at, send_attempt_token, send_attempt_started_at, send_attempt_count
  ) values (
    p_user_id, null, p_template_id, 'test', p_idempotency_key,
    'email', 'resend', p_recipient, p_subject, p_body_snapshot,
    p_sender_display_name, p_sender_address, p_reply_to_email,
    'queued', now(), gen_random_uuid(), now(), 1
  )
  returning * into v_new;

  return jsonb_build_object(
    'outcome', 'created',
    'message_id', v_new.id,
    'send_attempt_token', v_new.send_attempt_token,
    'send_attempt_count', v_new.send_attempt_count
  );
exception
  when unique_violation then
    -- Lost a race to a concurrent claim for the same key (defensive only
    -- — the advisory lock above already prevents this in practice). The
    -- winning row now exists; return it rather than erroring.
    select * into v_existing from public.outbound_messages
      where user_id = p_user_id and idempotency_key = p_idempotency_key;
    if found then
      return jsonb_build_object('outcome', 'existing', 'message_id', v_existing.id);
    end if;
    raise;
end;
$function$;

revoke all on function public.realtoros_claim_test_send(
  uuid, uuid, uuid, text, text, text, text, text, text, integer, integer, integer, integer, integer
) from public, anon, authenticated;
grant execute on function public.realtoros_claim_test_send(
  uuid, uuid, uuid, text, text, text, text, text, text, integer, integer, integer, integer, integer
) to service_role;

comment on function public.realtoros_claim_test_send is
  'service_role-only. Atomically claims a test-send idempotency key under a per-user advisory lock: returns existing/in_progress/retry_claimed/rate_limited/created. Not callable by anon or authenticated — never expose as a browser-facing RPC.';
