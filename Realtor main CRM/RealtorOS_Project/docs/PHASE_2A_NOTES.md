# Phase 2A — time-based and deal-based automation triggers

**Status:** built, tested, **not applied to the live project.**
**Migration:** `supabase/migrations/20261015120000_phase_2a_time_based_triggers.sql`
**Rollback:** `supabase/rollback/phase_2a_time_based_triggers_revert.sql`

Before 2A a sequence could only start when something happened to a contact at
that moment: it was created, its status changed, or somebody enrolled it by
hand. 2A adds the four starts a follow-up CRM actually needs.

Anniversary and birthday triggers are **not** part of 2A.

---

## 1. What was added

### Four new trigger types

| `trigger_type` | Starts when | Settings (`trigger_config`) |
|---|---|---|
| `follow_up_due` | the contact's `next_follow_up` date has arrived | `fire_hour` (0–23, default 8) |
| `no_contact` | nobody has contacted the person for N days, counted from `last_contact` or, if blank, `created_at` | `days` (1–365, **required**), `fire_hour` |
| `status_stale` | the contact has stayed in one status for N days, counted from `status_changed_at` | `days` (1–365, **required**), `statuses` (optional list), `fire_hour` |
| `deal_stage_changed` | a deal linked to the contact moves to a stage | `to_stage` (optional), `side` (optional: Buyer/Seller) |

Every type also accepts `include_existing` (boolean, default `false`) — see §3.

### Schema

- `automation_rules.trigger_config jsonb not null default '{}'` with an object
  CHECK. Validated on every draft write by the
  `automation_rules_validate_trigger_config` trigger, and again at activation.
  Frozen into `runtime_snapshot.trigger_config` when the rule is activated, so
  editing a draft later cannot change how a running rule behaves.
- `automation_trigger_events.rule_id` (nullable, composite FK
  `(workspace_id, rule_id)` → `automation_rules`) and `.event_key` (nullable
  text), with a **partial unique index** on `(workspace_id, event_key) where
  event_key is not null`. Pre-2A events keep both null and are untouched.
- A shape CHECK: the three detected types must carry `rule_id` **and**
  `event_key`; `contact_created`, `contact_status_changed` and
  `deal_stage_changed` must not carry `rule_id`.
- `contacts.status_changed_at timestamptz`, maintained by a BEFORE trigger,
  backfilled to `coalesce(updated_at, created_at)`, and protected from the
  browser alongside `reply_detected_at` / `unsubscribe_detected_at`.
- `public.automation_scan_state` — one row per workspace recording the last
  scan. Service-role only, no RLS policy because no browser role can reach it.

### Functions

- `automation_internal.validate_trigger_config(text, jsonb)` — the single
  definition of a valid config. Returns the **normalized** config (defaults
  filled, `statuses` sorted and de-duplicated) or raises `22023` with a
  specific code. Unknown keys are **rejected, not ignored**.
- `public.realtoros_validate_trigger_config(text, jsonb)` — the reachable
  wrapper (PostgREST only exposes `public`). Returns
  `{ok:true, config:…}` or `{ok:false, code:…}`. Granted to `authenticated`
  and `service_role`; reads and writes nothing.
- `public.realtoros_scan_time_triggers(p_now, p_limit)` — the detector.
  `service_role` only.
- `automation_internal.deal_stage_changed_event()` — AFTER INSERT and AFTER
  UPDATE on `deals` (two triggers, because a `WHEN` clause cannot test
  `TG_OP` and `OLD` does not exist on an INSERT).

### Code

- `process-automation` calls the scan **once at the start of each run**, before
  claiming events, so anything that came due since the last run is handled in
  the same run. A scan failure is counted (`counters.scanFailed`) and never
  stops job processing; nothing from the scan's response is echoed.
- `process-automation` matches a detected occurrence against **only** the rule
  named in `rule_id`, and only if that rule is still `active` and still has the
  trigger type the occurrence was detected for. `deal_stage_changed` is matched
  by **workspace** (the deal may belong to a teammate) with the optional
  `to_stage` / `side` filters applied. The two pre-2A types match exactly as
  before.
- `manage-automation` validates `trigger_config` through the database on
  activation (`invalid_trigger_config`, 422) and snapshots the normalized
  value.
- `automation.js` offers the four new starts in plain words, with inline
  settings, a one-sentence summary, and the `include_existing` warning. A
  non-draft rule shows its trigger as a sentence with no editable field.

---

## 2. How an occurrence is identified — the `event_key` rules

A time condition is not an event: nothing *happens* when a follow-up date
arrives, the date simply passes. So the scan can run as often as it likes, from
as many workers as it likes, and must still produce exactly one occurrence. It
does that with a deterministic key plus the unique index.

```
follow_up_due   'fud:' || rule_id || ':' || contact_id || ':' || next_follow_up
no_contact      'nc:'  || rule_id || ':' || contact_id || ':' || coalesce(last_contact, created_at::date)
status_stale    'ss:'  || rule_id || ':' || contact_id || ':' || status || ':' || status_changed_at
deal_stage      'deal_stage:' || deal_id || ':' || new_stage || ':' || <change timestamp>
```

Two consequences, both intended:

- **Re-scanning the same occurrence creates nothing.** The key is identical, so
  `ON CONFLICT DO NOTHING` on the partial unique index drops it.
- **Changing the underlying value IS a new occurrence.** A new follow-up date,
  a fresh `last_contact`, a real status change — each produces a different key
  and therefore a new, correct start.

The key includes `rule_id` because the condition is the rule's own setting: a
rule asking for 30 days of silence and one asking for 60 have genuinely
different occurrences at different times.

**Due moment.** `next_follow_up` and `last_contact` are `DATE` columns, so each
condition first yields a local due *date*. The occurrence becomes true at
`fire_hour` on that date **in the rule's `timezone`** (the same timezone 4D
already schedules with):

```sql
(due_date::timestamp + make_interval(hours => fire_hour)) at time zone rule.timezone
```

An occurrence is inserted only once that moment has passed.

---

## 3. The mass-send safety rule

**This is the most important thing in 2A.**

The dangerous case: a workspace with two years of history switches on "no
contact for 30 days". Every silent contact matches immediately, and the agent
has accidentally emailed their entire database.

So the scan creates an occurrence **only when the moment the condition became
true is at or after the rule's `activated_at`.** Switching a rule on enrols
nobody retroactively; it starts working from that moment forward.

A rule may deliberately opt in with `trigger_config.include_existing = true`.
Even then `daily_enrollment_limit` still applies, so the backlog is enrolled
over days rather than all at once. The UI states this where the checkbox is,
without jargon.

Two further guards, which are protection rather than policy:

- **Throttle.** A workspace is not re-scanned within 5 minutes
  (`automation_scan_state`), so a burst of worker runs does not re-scan
  repeatedly.
- **Budget.** `p_limit` (500 from the worker) caps how many occurrences one run
  may create. The remainder is picked up next run.

**Scope.** A `shared` rule considers every contact in its workspace. A
`personal` rule considers only the contacts its creator owns — those assigned
to them, plus unassigned ones they created. See §6.

**Pre-skip.** The scan will not create an occurrence for a contact who is
suppressed, has opted out of email, or already has an open enrollment in that
same rule. This is only an optimisation: the worker still runs the full
`realtoros_check_enrollment_eligibility` before enrolling anybody.

---

## 4. Nothing runs yet

`pg_cron` and `pg_net` are still not installed, and `process-automation` is
still not deployed. The migration references neither and schedules nothing by
itself. **2A is built and inert until go-live, which is intended.** Applying it
starts no email and enrols nobody; rules stay drafts until a person activates
them.

---

## 5. Post-apply verification queries

Read-only. Run after applying the migration.

```sql
-- 1. Both CHECKs now accept the four new types.
select conname, pg_get_constraintdef(oid)
  from pg_constraint
 where conname in ('automation_rules_trigger_type_check',
                   'automation_trigger_events_event_type_check');

-- 2. The new columns exist, and status_changed_at was backfilled for every row.
select count(*) as contacts_missing_stamp
  from public.contacts where status_changed_at is null;          -- expect 0

select table_name, column_name, is_nullable
  from information_schema.columns
 where table_schema = 'public'
   and (table_name, column_name) in (
     ('automation_rules','trigger_config'),
     ('automation_trigger_events','rule_id'),
     ('automation_trigger_events','event_key'),
     ('contacts','status_changed_at'));                          -- expect 4 rows

-- 3. The uniqueness that makes the scan idempotent.
select indexname, indexdef from pg_indexes
 where schemaname = 'public'
   and indexname = 'automation_trigger_events_event_key_uq';     -- expect 1 row

-- 4. All four new triggers are attached.
select c.relname, t.tgname
  from pg_trigger t join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and not t.tgisinternal
   and t.tgname in ('contacts_status_changed_at_trigger',
                    'deals_automation_stage_changed_trigger',
                    'deals_automation_stage_inserted_trigger',
                    'automation_rules_validate_trigger_config'); -- expect 4 rows

-- 5. The validator behaves. Both are read-only.
select public.realtoros_validate_trigger_config('no_contact', '{"days": 30}'::jsonb);
--   expect {"ok": true, "config": {"days": 30, "fire_hour": 8, "include_existing": false}}
select public.realtoros_validate_trigger_config('no_contact', '{"day": 30}'::jsonb);
--   expect {"ok": false, "code": "trigger_config_unknown_key_day"}

-- 6. Grants: the scan is the worker's alone, and the bookkeeping table is
--    unreachable from a browser.
select p.proname,
       has_function_privilege('service_role',  p.oid, 'EXECUTE') as service_role,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
       has_function_privilege('anon',          p.oid, 'EXECUTE') as anon
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('realtoros_scan_time_triggers',
                     'realtoros_validate_trigger_config');
--   scan: service_role only. validator: service_role + authenticated.

select has_table_privilege('authenticated', 'public.automation_scan_state', 'SELECT') as browser_can_read;
--   expect false

-- 7. A dry run of the detector. SAFE ONLY IF no rule of a 2A type is active
--    yet: with none active it scans nothing and creates nothing. Returns
--    counts only.
select public.realtoros_scan_time_triggers(now(), 1);
--   expect {"scanned_workspaces": 0, "scanned_rules": 0,
--           "events_created": 0, "skipped_workspaces": 0}

-- 8. Nothing has been detected, and no rule uses a new type yet.
select event_type, count(*) from public.automation_trigger_events group by 1;
select trigger_type, status, count(*) from public.automation_rules group by 1, 2;
```

Expected live state right after applying: 31 migrations, no rows in
`automation_scan_state`, no events of the new types, and no rule using one of
the four new trigger types until somebody creates and activates it.

---

## 6. Decisions worth knowing, none of which were in the spec

- **A personal rule only sees its creator's contacts.** The spec said to respect
  `visibility` but not what that means for targeting, and the pre-2A matching
  path does not consider it at all. "Personal" would mean very little if a
  private rule quietly emailed the whole team's pipeline, so the narrow reading
  was taken: `assigned_to_id` = the creator's directory id, plus unassigned
  contacts they created. A `shared` rule sees the whole workspace. **If the
  intent was the broad reading, this is the one line to change** — the
  `v_rule.visibility = 'shared' or …` clause in the scan's `candidate` CTE.
- **A detected event's `user_id` is the RULE's owner, not the contact's.** That
  is what makes `realtoros_enroll_contact` and the eligibility check resolve
  the rule's own workspace, since both derive it from
  `automation_internal.workspace_of(p_user_id)`. The contact is identified by
  `contact_id`, and the composite FK is on `(workspace_id, contact_id)`, so
  nothing requires the two to be the same person.
- **`deal_stage_changed` fires on INSERT too.** A deal created straight into a
  stage has genuinely reached it. A deal with no `contact_id` writes nothing: a
  sequence runs against a person, so there would be nobody to enrol.
- **A deal event is matched by workspace, not by creator.** Unlike the two
  pre-2A contact events, which are still matched by `user_id` so their
  behaviour is unchanged.
- **`status_changed_at` is protected but still browser-caused.** The protect
  trigger discards whatever the browser supplied, then the stamping trigger
  sets the real value when the status actually moved. So a browser can cause an
  honest stamp by changing the status, and can never write a dishonest one.
  Trigger name order (`…protect…` before `…status_changed_at…`) is what makes
  that work and must not be changed.
- **The revert archives rather than deletes.** A rule using a 2A trigger type
  would violate the restored CHECK, so the revert archives it, rewrites its
  type to `manual` and records the original in
  `metadata.phase_2a_reverted_from_trigger_type`. Enrollments, jobs and sent
  mail are untouched.

---

## 7. Tests

| File | Covers |
|---|---|
| `tests/sql/phase_2a_time_triggers.test.mjs` (19) | the validator, one-event-per-occurrence, re-scan and concurrent-scan idempotence, `fire_hour` + timezone, the `include_existing` guard, draft/paused/archived producing nothing, suppressed/opted-out/already-enrolled skipping, workspace isolation and personal-rule scope, the deal trigger, the browser's reach, the limit and throttle, and that the summary leaks nothing |
| `tests/sql/rollback_files.test.mjs` (+4, 14 total) | the revert reproduces the pre-2A functions, indexes, triggers and FKs exactly; columns removed and both CHECKs narrowed; a 2A rule archived rather than deleted; 2A re-applies cleanly |
| `tests/frontend/automation-time-triggers.test.mjs` (12) | the four options worded for an agent, per-trigger fields, the pipeline-driven stage list, the plain-English summary, the include-existing warning, what the draft actually saves, abandoned settings not leaking across a trigger change, out-of-range refusal, read-only for a live rule, and escaping |
| `tests/edge/time-trigger-wiring.test.mjs` (8) | the scan called once before claiming, a scan failure never stopping the queue, nothing from the scan echoed, a detected occurrence starting only its own rule under its own key, a paused rule starting nothing, activation refusing a bad config, and the normalized config being snapshotted |
