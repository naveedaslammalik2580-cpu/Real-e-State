-- ============================================================================
-- RealtorOS — Cron Scheduling for process-automation
-- ============================================================================
--
--   *** THIS FILE CONTAINS PLACEHOLDERS. DO NOT COMMIT IT WITH REAL VALUES. ***
--
-- Replace before running:
--   <PROJECT_REF>                 your Supabase project ref (the subdomain in
--                                 https://<PROJECT_REF>.supabase.co)
--   <AUTOMATION_WORKER_SECRET>    the exact value you set with
--                                 `supabase secrets set AUTOMATION_WORKER_SECRET=...`
--
-- Edit a scratch copy outside the repository, or edit here and `git checkout`
-- the file afterwards. Never paste the real secret into a commit, a chat
-- message, a screenshot, or a log.
--
-- ---------------------------------------------------------------------------
-- RUN THIS LAST. It is the switch that makes automation live.
-- ---------------------------------------------------------------------------
-- Before running, confirm:
--   [ ] All five Phase 4C/4D/4E migrations are applied (verify-migrations.sql)
--   [ ] All six Edge Functions are deployed
--   [ ] All four secrets are set (`supabase secrets list`)
--   [ ] The Resend webhook is configured and returns 401 (not 503) when unsigned
--   [ ] A manual worker invocation returned 200 with all counters at zero
--
-- Until this job exists, process-automation never runs on its own, so no
-- automated email can be sent regardless of what else is configured.
--
-- ---------------------------------------------------------------------------
-- TWO THINGS TO UNDERSTAND FIRST
-- ---------------------------------------------------------------------------
--
-- 1. THE WORKER SECRET IS STORED IN THE DATABASE.
--    pg_net needs the secret in the request header, so it is written into the
--    cron.job table's command text, readable by anyone with database admin
--    access. This is the standard Supabase pattern for scheduling Edge
--    Functions and is unavoidable with pg_net. Treat database admin access as
--    equivalent to holding the worker secret. If you rotate the secret you MUST
--    update this job too (see the bottom of this file).
--
-- 2. net.http_post IS FIRE-AND-FORGET.
--    It queues the request and returns immediately. A cron run is recorded as
--    'succeeded' once the request is QUEUED, not once the worker finishes. So
--    cron.job_run_details proves the schedule is firing, NOT that automation is
--    working. For that, check the Edge Function logs and the response counters.
-- ============================================================================


-- ============================================================================
-- STEP 1 — Enable the extensions
-- ============================================================================
-- Both are available on Supabase. Safe to re-run.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Expected: 2 rows.
select extname, extversion
from pg_extension
where extname in ('pg_cron', 'pg_net')
order by extname;


-- ============================================================================
-- STEP 2 — Schedule the worker
-- ============================================================================
-- Recommended starting interval: every 2 minutes.
--
--   INTERVAL OPTIONS
--   ----------------------------------------------------------------------
--   '* * * * *'      every  1 minute    1,440 runs/day   ~1 min  added delay
--   '*/2 * * * *'    every  2 minutes     720 runs/day   ~2 min  added delay  <-- recommended
--   '*/5 * * * *'    every  5 minutes     288 runs/day   ~5 min  added delay
--   '*/15 * * * *'   every 15 minutes      96 runs/day  ~15 min  added delay
--
--   The interval bounds ADDED latency, not total delay: a step scheduled for
--   09:00 under a 5-minute cron runs between 09:00 and 09:05.
--
--   Each run processes at most 25 trigger events and 25 jobs, so a longer
--   interval also means larger batches. Cost is driven by invocation count, not
--   by work done — an idle run is cheap but not free.
--
--   Start at 2 minutes. Lengthen it once you have seen real volume.
--
-- Change the interval later without unscheduling:
--   select cron.alter_job(
--     (select jobid from cron.job where jobname = 'process-automation-worker'),
--     schedule => '*/5 * * * *'
--   );

select cron.schedule(
  'process-automation-worker',
  '*/2 * * * *',
  $job$
  select net.http_post(
    url := 'https://<PROJECT_REF>.supabase.co/functions/v1/process-automation',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-realtoros-worker-secret', '<AUTOMATION_WORKER_SECRET>'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $job$
);

-- Note on timeout_milliseconds: a single run can process up to 25 trigger
-- events plus 25 jobs, each of which may make a provider call with a 10s
-- timeout. 55s leaves comfortable headroom under a 2-minute interval. If your
-- pg_net version does not accept this argument, remove that line — the default
-- applies.


-- ============================================================================
-- STEP 3 — Verify the job was created
-- ============================================================================

-- Expected: 1 row, active = true, schedule = '*/2 * * * *'.
select jobid, jobname, schedule, active, database, username
from cron.job
where jobname = 'process-automation-worker';

-- Expected: after one or two intervals, rows with status = 'succeeded'.
-- Remember: 'succeeded' means the HTTP request was QUEUED, not that the worker
-- did anything useful.
select status, return_message, start_time, end_time
from cron.job_run_details
where jobid = (select jobid from cron.job where jobname = 'process-automation-worker')
order by start_time desc
limit 10;

-- The ACTUAL worker responses, retained briefly by pg_net.
-- Expected: status_code = 200, and a JSON body of counters.
-- A 401 here means the secret in this file does not match the secret set via
-- `supabase secrets set AUTOMATION_WORKER_SECRET`.
select id, status_code, content_type, timed_out, error_msg, created
from net._http_response
order by created desc
limit 20;

-- Then confirm in the Dashboard:
--   Edge Functions > process-automation > Logs
--   Expect one 200 per interval.


-- ============================================================================
-- STEP 4 — Confirm the worker is doing real work
-- ============================================================================
-- Run these a few minutes after enabling the job, once a rule is active and a
-- contact is enrolled.

-- Trigger events should drain from 'pending' to 'completed'.
select status, count(*), max(updated_at) as most_recent
from public.automation_trigger_events
group by status
order by status;

-- Expected: 0 rows. A job stuck 'processing' well past the 300s stale-lease
-- window means the recovery sweep is not running.
select id, status, locked_at, attempts, max_attempts
from public.automation_jobs
where status = 'processing' and locked_at < now() - interval '15 minutes';


-- ============================================================================
-- PAUSE / RESUME / REMOVE  (commented out — for reference)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- EMERGENCY STOP. Halts ALL automation immediately. Always safe: in-flight
-- jobs either finish or are picked up by the stale-lease sweep when the job is
-- rescheduled. Nothing is lost; pending work simply waits.
-- ---------------------------------------------------------------------------
-- select cron.unschedule('process-automation-worker');

-- ---------------------------------------------------------------------------
-- PAUSE WITHOUT DELETING (keeps the definition, including the secret).
-- ---------------------------------------------------------------------------
-- select cron.alter_job(
--   (select jobid from cron.job where jobname = 'process-automation-worker'),
--   active => false
-- );

-- RESUME:
-- select cron.alter_job(
--   (select jobid from cron.job where jobname = 'process-automation-worker'),
--   active => true
-- );

-- ---------------------------------------------------------------------------
-- CHANGE THE INTERVAL:
-- ---------------------------------------------------------------------------
-- select cron.alter_job(
--   (select jobid from cron.job where jobname = 'process-automation-worker'),
--   schedule => '*/5 * * * *'
-- );

-- ---------------------------------------------------------------------------
-- ROTATE AUTOMATION_WORKER_SECRET
-- ---------------------------------------------------------------------------
-- The secret lives in TWO places and both must change together. Unschedule
-- first to avoid a window of failing runs:
--
--   1. select cron.unschedule('process-automation-worker');
--   2. supabase secrets set AUTOMATION_WORKER_SECRET=<NEW_VALUE> --project-ref <PROJECT_REF>
--   3. supabase functions deploy process-automation --project-ref <PROJECT_REF>
--   4. Re-run STEP 2 above with the new value.
--
-- Between steps 1 and 4 no automation runs. Jobs stay pending and are picked
-- up on the first run after rescheduling — nothing is lost.

-- ---------------------------------------------------------------------------
-- CLEAN UP OLD RUN HISTORY (cron.job_run_details grows without bound)
-- ---------------------------------------------------------------------------
-- delete from cron.job_run_details
-- where end_time < now() - interval '7 days';
