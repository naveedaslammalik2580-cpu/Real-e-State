# RealtorOS — Phase 4G Acceptance Test Checklist

139 numbered checks. Every one is pass/fail against a stated criterion.
Checks 47–62 were rewritten and 84–115 added for Phase 4E.2 (stop-logic
completion, unsubscribe link, manual actions, reply detection).

**Prerequisite:** every STOP GATE in
`phase-4f-deployment-playbook.md` has passed, including the Section 9
smoke tests. Do not start here until the smoke tests are green.

### Before you begin

- Use a **test contact whose email address is yours**. Real email will be sent.
- Have the Supabase SQL Editor open in a second tab — many checks need it.
- Have Dashboard → Edge Functions → Logs open in a third tab.
- **Shorten the waits.** Build test sequences with `delay_minutes` of 1–2. The
  schema allows 0–525600 minutes, so a 1-minute delay is valid and turns a
  multi-day sequence into a few minutes.
- Note your cron interval. "Wait for the worker" means one to two intervals.

### Recording results

| Legend | Meaning |
|---|---|
| PASS | Criterion met exactly |
| FAIL | Criterion not met — stop and investigate before continuing in that area |
| N/A | Not applicable in this environment (record why) |
| DEFER | Cannot be tested yet (record the blocker) |

---

## A. Google Sheets Connection (1–16)

The Apps Script connector lives at
`integrations/google-sheets/Code.gs`.

| # | Check | Pass criterion |
|---|---|---|
| 1 | Navigate to **Settings → Google Sheets** | Page loads; no console error |
| 2 | Create a new connection | Connector token is displayed **once**; the UI states it will not be shown again |
| 3 | Reload the page | The token is **not** shown again — only a masked/absent value. Fails if the full token reappears |
| 4 | Copy the ingest URL | Contains your real project ref and ends `/functions/v1/ingest-sheet-leads` |
| 5 | Install `Code.gs` into the Google Sheet's Apps Script project | Script saves without error |
| 6 | Configure the connector (ingest URL + token) per the in-script instructions | Configuration saves |
| 7 | Create the **Raw Leads** and **Ready** tabs with the documented headers | Both tabs exist with correct headers |
| 8 | Install the 15-minute time-driven trigger | Trigger appears in Apps Script → Triggers |
| 9 | Paste 5+ test rows into **Raw Leads**: valid email+phone; email only; phone only; a duplicate of the first email; one missing every required field | Rows present |
| 10 | Run **Sync Now** | Completes without an Apps Script error |
| 11 | **Settings → Import History** | Batch appears with row counts that add up: total = imported + updated + skipped + rejected |
| 12 | **Contacts** | New contacts exist for the valid rows |
| 13 | Duplicate email | Exactly **one** contact for that address, not two |
| 14 | Row missing required fields | Rejected, with a specific reason in Import History — not silently dropped |
| 15 | Run **Sync Now** again with no changes | Zero new imports; unchanged rows skipped |
| 16 | Add one new lead, modify one existing lead, run **Sync Now** | Exactly one contact created and one updated |

Optionally confirm the automatic trigger fired (wait 15 minutes, or read the
Apps Script execution log).

**SQL cross-check:**
```sql
select status, count(*) from public.lead_import_rows group by status order by status;
select id, started_at, finished_at, status from public.lead_import_batches
order by started_at desc limit 5;
```

---

## B. Email Sending Setup (17–22)

| # | Check | Pass criterion |
|---|---|---|
| 17 | **Settings → Email Sending** | Page loads |
| 18 | Create a sender profile — display name + reply-to = **your own address** | Saves; the verified Resend domain is reflected |
| 19 | **Send Test Email** | UI reports success |
| 20 | Check your inbox | Arrives. `From:` is `agent-<hash>@<SENDING_DOMAIN>`; display name matches; `Reply-To:` is your address |
| 21 | SQL below | One row, `message_kind='test'`, `status='sent'`, non-null `provider_message_id` |
| 22 | Wait ~1 min, re-run SQL | `status` advanced to `delivered`; a `webhook_events` row exists with `status='processed'` |

```sql
-- 21
select id, status, message_kind, sent_at, provider_message_id, first_provider_attempt_at
from public.outbound_messages where message_kind = 'test'
order by created_at desc limit 5;

-- 22
select om.status, om.delivered_at, we.event_type, we.status as event_status, we.signature_valid
from public.outbound_messages om
left join public.webhook_events we on we.outbound_message_id = om.id
where om.message_kind = 'test'
order by om.created_at desc, we.received_at desc limit 10;
```

If 22 fails, the webhook endpoint URL or event subscription is wrong — recheck
playbook Section 6.

---

## C. Email Templates (23–28)

| # | Check | Pass criterion |
|---|---|---|
| 23 | **Email Templates** | Page loads |
| 24 | Create a template using `{{first_name}}` and `{{email}}` | Saves |
| 25 | Merge-field guide | Accessible; lists exactly `first_name`, `full_name`, `email`, `agent_name` |
| 26 | Return to the list | Template appears |
| 27 | Edit and save | Change persists after reload |
| 28 | Create a second template | Both exist and are distinguishable |

Only those four merge tags are allowlisted server-side. An unknown tag must be
rejected at rule activation (`unsupported_merge_tag`) — test this at #32.

---

## D. Automation Rules (29–32)

| # | Check | Pass criterion |
|---|---|---|
| 29 | **Automation** | Page loads |
| 30 | Create a rule: trigger **Contact Created**; Step 1 `send_email` (template 1, `delay_minutes` 0); Step 2 `wait` (`delay_minutes` 1); Step 3 `send_email` (template 2); Step 4 `create_task`; `stop_on_reply` on; `stop_on_unsubscribe` on | Rule and all four steps save |
| 31 | Check the rule's status | **Draft**. Creating a rule can never produce an active one |
| 32 | Temporarily break a step (remove the template, or add an unknown merge tag) and try **Activate** | Activation is refused with a specific reason (`invalid_step_template` / `unsupported_merge_tag` / `sender_profile_unavailable`), not a generic error. Restore the step afterwards |

> If activation fails with **`provider_not_configured`**, one of the four
> secrets is missing. `manage-automation` checks all four exist before
> activating. See `environment-variables.md` §1.

---

## E. Activation and Enrollment (33–44)

| # | Check | Pass criterion |
|---|---|---|
| 33 | **Activate** the rule | Status → **Active**; steps become read-only |
| 34 | Create a new contact with **your own email** (or manually enroll one) | Contact created |
| 35 | Rule → **View Activity** | Enrollment listed as **Active** |
| 36 | Confirm the worker ran (SQL below, plus Edge Function logs) | A run within the last interval |
| 37 | Check your inbox | Step 1 email arrives; merge fields substituted correctly |
| 38 | SQL | An `outbound_messages` row, `message_kind='automation'`, `status='sent'` or later |
| 39 | Contact → Activities | An "Automated follow-up email sent" activity |
| 40 | Contact record | `last_contact` set to today |
| 41 | Wait out the 1-minute delay plus one cron interval | — |
| 42 | Check inbox | Step 3 email arrives (Step 2 is the wait) |
| 43 | **Tasks** | The Step 4 task exists, with correct title and priority |
| 44 | Rule → View Activity | Enrollment status **Completed** |

```sql
-- 36
select status, start_time from cron.job_run_details
where jobid = (select jobid from cron.job where jobname='process-automation-worker')
order by start_time desc limit 5;

-- 38
select id, status, message_kind, subject, sent_at from public.outbound_messages
where message_kind = 'automation' order by created_at desc limit 10;

-- 44 — full trace
select e.status as enrollment, e.current_step_order,
       j.job_type, j.status as job_status, j.attempts, j.cancelled_reason,
       r.attempt_number, r.status as run_status
from public.automation_enrollments e
left join public.automation_jobs j on j.enrollment_id = e.id
left join public.automation_runs r on r.job_id = j.id
order by e.started_at desc, j.scheduled_at, r.attempt_number;
```

---

## F. Delivery Webhooks (45–46)

| # | Check | Pass criterion |
|---|---|---|
| 45 | SQL | Automation messages advance past `sent` (`delivered`, then `opened`/`clicked` if you interact) |
| 46 | SQL | `webhook_events` rows with `signature_valid = true` and `status = 'processed'`; **zero** rows with `status='failed'` |

```sql
select om.status, om.delivered_at, om.opened_at, om.clicked_at,
       we.event_type, we.status as event_status, we.signature_valid
from public.outbound_messages om
join public.webhook_events we on we.outbound_message_id = om.id
where om.message_kind = 'automation'
order by we.received_at desc limit 20;

select status, count(*) from public.webhook_events group by status order by status;
```

---

## G. Stop Logic — Hard Bounce (47–54)

Resend provides deterministic test addresses. Use its documented **hard bounce**
address (check current Resend docs; historically `bounced@resend.dev`). Build
the rule as **email step → task step** (1-minute delays) so you can see the
task still run.

| # | Check | Pass criterion |
|---|---|---|
| 47 | Create a contact with the bounce test address; enroll it in the rule | Contact added |
| 48 | Wait for the worker to send the first email | `outbound_messages` row exists |
| 49 | Wait for the bounce webhook | `webhook_events` row for `email.bounced`, `status='processed'`, `payload->>'bounce_type' = 'Permanent'` |
| 50 | SQL | An `email_suppressions` row, `reason='bounce'`, `is_active=true`, `source_message_id` = that message |
| 51 | SQL | The contact's `reply_detected_at` and `unsubscribe_detected_at` are both **null**; no `communication_consents` change |
| 52 | SQL | The enrollment is **still active** — a hard bounce blocks the address, not the whole automation |
| 53 | Wait for the next steps | Any further **email** step completes with `skipped_reason='suppressed'` and no new `outbound_messages` row; the **task** step still creates a task |
| 54 | Contact page → Follow-up emails card | Shows **"Email blocked because the address could not receive email."** Timeline has "Follow-up email could not be delivered" |

```sql
-- 50
select normalized_email, reason, is_active, source_message_id, created_at
from public.email_suppressions order by created_at desc limit 5;

-- 52/53
select e.id, e.status, e.stop_reason, j.job_type, j.status as job_status, j.skipped_reason
from public.automation_enrollments e
left join public.automation_jobs j on j.enrollment_id = e.id
order by e.started_at desc, j.scheduled_at;
```

**Soft bounce (optional).** If Resend offers a temporary-bounce test address,
use it: expect the webhook row with `bounce_type` other than `Permanent`,
`status='ignored'`, no suppression, and no change to the message status or
enrollment.

---

## H. Stop Logic — Complaint (55–60)

Use Resend's complaint test address if available (historically
`complained@resend.dev`). If not, mark 55–60 DEFER.

| # | Check | Pass criterion |
|---|---|---|
| 55 | Enroll a contact with the complaint test address (rule has `stop_on_unsubscribe` **on**); wait for send + webhook | `webhook_events` row for `email.complained`, `status='processed'` |
| 56 | SQL | Enrollment `status='stopped'`, `stop_reason='complaint'` |
| 57 | SQL | `communication_consents`: `channel='email'`, `status='opted_out'`, `source='provider_webhook'` |
| 58 | SQL | `contacts.unsubscribe_detected_at` is set; `email_suppressions` row with `reason='complaint'` |
| 59 | SQL | Pending jobs cancelled, `cancelled_reason='complaint'`; exactly **one** `contact_stop_events` row for that webhook event (`source='provider_webhook'`, `event_ref` = the Svix id) |
| 60 | Automation page → View Activity | Shows **"Stopped — contact reported spam on <date>"** in a neutral tone |

```sql
-- 57/58
select c.id, c.unsubscribe_detected_at, cc.status as consent_status, cc.source
from public.contacts c
left join public.communication_consents cc
  on cc.contact_id = c.id and cc.user_id = c.user_id and cc.channel = 'email'
where c.unsubscribe_detected_at is not null;

-- 59
select event_type, source, event_ref, recorded_at, result
from public.contact_stop_events order by recorded_at desc limit 10;
```

**Rule flag off (valuable).** Repeat with a second rule whose
`stop_on_unsubscribe` is **off** (email step → task step). Expected: consent
revoked, suppression added, `unsubscribe_detected_at` set, but the enrollment
stays **active**; the next email step completes with a `skipped_reason` and
sends nothing; the task step still runs. Blocking email is a legal requirement,
not a rule preference.

---

## I. Stop Logic — Reply (61–62)

| # | Check | Pass criterion |
|---|---|---|
| 61 | Contact page → **Mark as replied** on an enrolled contact whose rule has `stop_on_reply` on (details in section P) | Enrollment `stop_reason='reply'`; `contacts.reply_detected_at` set; **no** suppression; consent **not** revoked |
| 62 | Automatic reply detection | Covered by section R if inbound replies are configured; otherwise **DEFER** and record it |

---

## J. Pause, Resume, Archive (63–69)

| # | Check | Pass criterion |
|---|---|---|
| 63 | Create and activate a second rule | Active |
| 64 | Enroll a contact | Enrollment active |
| 65 | **Pause** the rule | Status → Paused. New trigger events create **no** new enrollments |
| 66 | Observe an in-flight job | An already-claimed job runs to completion; pausing does not abandon it mid-flight |
| 67 | **Resume** | Status → Active; new trigger events are processed again |
| 68 | **Archive** | Status → Archived; no Resume control offered |
| 69 | SQL | On archive, every open enrollment → `stopped`, `stop_reason='rule_archived'`, and pending jobs cancelled |

```sql
-- 65: create a contact while paused, then confirm no new enrollment
select status, count(*) from public.automation_enrollments group by status;

-- 69
select e.id, e.status, e.stop_reason, j.status as job_status, j.cancelled_reason
from public.automation_enrollments e
left join public.automation_jobs j on j.enrollment_id = e.id
where e.rule_id = '<ARCHIVED_RULE_ID>';
```

> Archive is atomic: it locks the rule row, stops open enrollments, and cancels
> their pending jobs in one transaction. A job already `processing` is left to
> its worker, which re-checks the enrollment before sending and cancels itself.

---

## K. Retry Behaviour (70–72)

Induce a failure that is *not* a stop event — e.g. deactivate the template a
queued step references, or temporarily set a bad `RESEND_API_KEY`. **Restore the
correct value immediately afterwards.**

| # | Check | Pass criterion |
|---|---|---|
| 70 | With a failed, retriable job, click **Retry** | Job returns to `pending`; enrollment reactivates |
| 71 | Wait for the worker | Job is claimed and executed again |
| 72 | Click **Retry** a second time on the same job | **Refused** — `job_not_eligible`. The manual-retry ceiling is one |

```sql
select id, status, attempts, max_attempts, manual_retry_count, retriable,
       failure_category, last_error, completed_at
from public.automation_jobs where status = 'failed' or manual_retry_count > 0
order by updated_at desc limit 10;

-- Expected: 0 rows. Ceilings must hold.
select id, max_attempts, manual_retry_count from public.automation_jobs
where max_attempts > 20 or manual_retry_count > 1;

-- The prior failure is resolved, never deleted.
select job_id, category, error_code, retriable, resolved, resolution_notes
from public.automation_failures order by created_at desc limit 10;
```

> A job whose `max_attempts` already equals 20 is correctly **not** advertised as
> retriable — a retry would need 21, violating the database ceiling.

---

## L. Duplicate Prevention (73–74)

| # | Check | Pass criterion |
|---|---|---|
| 73 | Manually enroll a contact already actively enrolled in the same rule | **Blocked** with a clear message ("already has an open enrollment"), not a silent failure or a second enrollment |
| 74 | SQL | Exactly one open enrollment per (rule, contact) |

```sql
select rule_id, contact_id, count(*) as open_enrollments
from public.automation_enrollments
where status in ('active','paused')
group by rule_id, contact_id having count(*) > 1;
-- Expected: 0 rows
```

---

## M. UI Verification (75–80)

| # | Check | Pass criterion |
|---|---|---|
| 75 | Desktop, 1024px+ | Automation, Email Templates, Email Sending, Import History all render correctly; no overflow |
| 76 | Mobile, 375px | Same pages usable; no horizontal scroll; buttons tappable; tables scroll within their own container |
| 77 | Modals | Open, close via button, close via **Escape**, close via click-outside. Focus returns sensibly |
| 78 | Keyboard | Tab order is logical; **Enter** submits; **Escape** closes; focus is visible throughout |
| 79 | Loading / empty states | Loading indicators show while fetching; empty states are explanatory, not blank |
| 80 | Error states | Disconnect the network, then load the Automation activity panel: a clear error plus a **Retry** control, no unhandled exception in the console |

Check both the stop-summary panel (counts by reason) and the cancelled-steps
list at #75/#76 — they are the newest UI and the most likely to overflow.

---

## N. Data Integrity and Security (81–83)

| # | Check | Pass criterion |
|---|---|---|
| 81 | Run all of `security-audit.sql` | Every "Expected: 0 rows" query returns zero rows. **Section 2 in particular must be empty.** |
| 82 | Orphan / stranded-record queries (audit §7) | Zero orphans; zero stranded active enrollments; the run invariant holds for every processing job |
| 83 | Dashboard → Edge Functions → Logs, all seven functions | **No** email address, contact name, phone number, message body, API key or worker secret anywhere. The functions contain zero `console.*` calls, so only platform request lines should appear |

**Also confirm at #83:**

- Browser DevTools → Network: no Supabase **service-role** key in any request
  the page makes. The browser only ever uses the publishable/anon key plus the
  user's JWT.
- Browser DevTools → Application → Local/Session Storage: no secret, no
  connector token retained after the one-time reveal at check #2.

**Multi-tenant isolation (strongly recommended):** sign in as a second user and
confirm they see none of the first user's contacts, rules, enrollments or
messages. Every table is owner-scoped by RLS; this proves it end to end.

---

## O. Unsubscribe Link (84–93)

Use an automated email that reached your own test inbox (section E).

| # | Check | Pass criterion |
|---|---|---|
| 84 | View the message source | `List-Unsubscribe: <https://<PROJECT_REF>.supabase.co/functions/v1/email-unsubscribe?t=u1.…>` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers present |
| 85 | Read the email | Footer line "Don't want these emails? Unsubscribe here: …" is present, after the template text, even though the template itself has no unsubscribe text |
| 86 | Inspect the link (token part after `t=`) | Contains no email address, no user id and no contact id. Base64-decoding the middle part shows only `p`, `m` (message id), `c` (opaque tag), `e` (expiry) |
| 87 | Open the footer link in a browser | A confirmation page ("Unsubscribe from these emails?") with one button. **Nothing is unsubscribed yet:** `contacts.unsubscribe_detected_at` still null |
| 88 | Press **Unsubscribe** | "You are unsubscribed". SQL: consent `opted_out` with `source='unsubscribe_link'`; `email_suppressions` `reason='unsubscribe'`; one `contact_stop_events` row with `event_ref = 'unsub:<message id>'` |
| 89 | Press the button / open the link again | Still shows success; still exactly one `contact_stop_events` row and one active suppression |
| 90 | Mail app's built-in **Unsubscribe** button (Gmail/Apple Mail), on a fresh contact | Same end state as 88, performed by one-click POST |
| 91 | Change one character in the token and open it | "This unsubscribe link has expired … reply to any of them with the word 'unsubscribe'."; no database change |
| 92 | Open `…/email-unsubscribe?t=` with an empty or random token | Same generic page as 91 — no hint about why |
| 93 | Page source of the confirmation page | No scripts, no images, no external resources; response headers include `Content-Security-Policy: default-src 'none' …` and `X-Robots-Tag: noindex` |

> **Expired links.** Links stop working 180 days after the email was sent.
> Every link that cannot be used — expired, altered or truncated — shows the
> same page: "This unsubscribe link has expired. To stop receiving these
> emails, reply to any of them with the word 'unsubscribe'." Those replies
> arrive in the agent's inbox (the agent's address is always first in
> Reply-To). With automatic reply detection on,
> a reply that is exactly "unsubscribe" (or another listed opt-out phrase)
> unsubscribes the contact automatically — see section S. Without it, act on
> such replies with **Mark as unsubscribed** on the contact page.

> If `UNSUBSCRIBE_PAGE_URL` is **not** set and there is no custom functions
> domain, check 87 shows raw HTML as text. That is the platform limitation
> described in the playbook; set `UNSUBSCRIBE_PAGE_URL` and re-test 85–88.

---

## P. Contact Page Manual Actions (94–101)

| # | Check | Pass criterion |
|---|---|---|
| 94 | Open any contact | A **Follow-up emails** card: "Follow-up emails can be sent to this contact." plus **Mark as replied** and **Mark as unsubscribed** |
| 95 | Click **Mark as replied**, then press **Escape** | Dialog closes, focus returns to the button, nothing changed (SQL: `reply_detected_at` null) |
| 96 | Open it again; press **Tab** repeatedly | Focus cycles inside the dialog only |
| 97 | Confirm | Toast "Marked as replied."; card shows "Contact replied on <date>"; the button disappears; timeline note "You marked this contact as replied." |
| 98 | SQL | `contact_stop_events` row `source='owner_manual'`, `event_type='reply'`; enrollments on rules with `stop_on_reply` stopped with `stop_reason='reply'`; rules without it untouched |
| 99 | **Mark as unsubscribed** on another contact | Card shows "Contact unsubscribed" and "Email blocked because the contact unsubscribed."; consent `opted_out` `source='owner_manual'`; suppression `reason='unsubscribe'` |
| 100 | Automation page → manual enroll that contact | Refused with "This contact unsubscribed, so they can't be added to this automation." (or the email-blocked message) — never a silent no-op |
| 101 | Screen-reader / wording pass on the card, dialogs and activity panel | No "enrollment", "job", "webhook", "suppression", "Resend" or other internal terms |

---

## Q. Guard and Race Behaviour (102–108)

| # | Check | Pass criterion |
|---|---|---|
| 102 | Enroll a contact in a rule (email step, 2-minute delay). Before it sends, **Mark as replied** (rule has `stop_on_reply`) | The pending email step becomes `cancelled`, `cancelled_reason='reply'`; nothing is sent |
| 103 | Same, but mark replied while the worker is mid-run (best effort — watch the logs) | Either the step is cancelled before sending, or the email was already accepted and is recorded as sent with its activity; in both cases **no later step** is scheduled |
| 104 | Rule with `stop_on_reply` **off**; mark replied | The sequence continues and sends |
| 105 | Pause a rule, mark one of its contacts unsubscribed, resume the rule | That enrollment stays `stopped`; no job resurrects |
| 106 | Archive a rule after a stop | The stopped enrollment keeps its original `stop_reason` |
| 107 | Automation page → failures list | A step cancelled by a stop never shows a **Retry** button; `retry_job` on it returns "This step can no longer be tried again." |
| 108 | Worker response counters over a few runs | `jobsSkipped` counts skipped email steps; `jobsErrored` stays 0 |

---

## R. Automatic Reply Detection (109–115) — only if `INBOUND_REPLY_DOMAIN` is set

**Prerequisite:** a separate receiving domain or subdomain set up in Resend
with **MX records** (playbook Section 3.B), in addition to the sending
domain's SPF/DKIM records — or Resend's managed `<id>.resend.app` address.
The sending domain alone cannot receive replies. Without a receiving domain,
mark 109–115 **N/A** and record that replies can only be marked manually with
**Mark as replied** (check #61 and section P).

| # | Check | Pass criterion |
|---|---|---|
| 109 | Message source of a new automated email | `Reply-To:` lists the agent's address **and** `r-<40 hex>@<INBOUND_DOMAIN>` |
| 110 | Reply from your test inbox with a normal message | `webhook_events` row `email.received`, `processed`; `outbound_messages.status='replied'`; `contacts.reply_detected_at` set; `contact_stop_events` `source='inbound_email'` |
| 111 | Same, with `stop_on_reply` on | Enrollment stopped, `stop_reason='reply'` |
| 112 | Turn on an out-of-office responder on the test inbox; trigger another automated email | Timeline note "Automatic reply received"; **no** stop, `reply_detected_at` unchanged |
| 113 | Agent's own inbox | The real reply also arrived there directly |
| 114 | `webhook_events.payload` for the inbound events | Only `type` and `email_id` — no addresses, headers or body |
| 115 | Edge Function logs for `resend-webhook` | No 500s after the first delivery (a 500 means the API key cannot read received emails — see the playbook, Secret 1) |

---

## S. Unsubscribe by Reply (116–120) — needs `INBOUND_REPLY_DOMAIN` (migration #18 is live)

Use a fresh test contact enrolled in a rule with **email → email → task**
steps (1–2 minute delays) and `stop_on_unsubscribe` **off**, so you can see
the later email skipped while the task still runs.

| # | Check | Pass criterion |
|---|---|---|
| 116 | After the first automated email arrives, reply with just **unsubscribe** | `webhook_events` row `email.received`, `processed`; one `contact_stop_events` row `event_type='unsubscribe'`, `source='inbound_email'`, `event_ref='inbound:<received email id>'`; `contacts.unsubscribe_detected_at` set and `reply_detected_at` **null** |
| 117 | SQL + contact page | Consent `opted_out` with `source='inbound_email'`; `email_suppressions` row `reason='unsubscribe'`. The contact card reads "Contact unsubscribed by replying to an email on <date>" and "Email blocked because the contact unsubscribed."; timeline note "They replied asking to be unsubscribed." |
| 118 | Wait for the next steps | The next **email** step completes with a `skipped_reason` and no new `outbound_messages` row (pending follow-up emails are skipped); the **task** step still runs. (With `stop_on_unsubscribe` **on**, the automation stops instead and its pending steps are cancelled.) |
| 119 | Second contact: reply **yes I'm interested, stop by at 5** | Recorded as a **normal reply only**: `event_type='reply'`, `reply_detected_at` set, **no** suppression, consent unchanged, `outbound_messages.status='replied'` |
| 120 | Variations on a third contact: "Unsubscribe!", subject "Re: STOP" with an empty body, "remove me" above quoted history | Each unsubscribes. "Please don't unsubscribe me" and "stop calling after 6pm" are normal replies |

---

## T. Import from File (121–129) — needs `import-lead-file` (migration #19 is already live)

Prepare three files: a CSV and an XLSX with columns **Full Name, E-mail,
Phone Number, Notes**, a few rows each (one row with neither email nor phone,
one repeated person), plus a PDF and a CSV larger than 5 MB.

Limits under test: **500 rows per file**; **200 new contacts per owner per
rolling 24 hours from files** (Google Sheets is not limited); **10 uploads per
15 minutes and 20 per day**. Run 121–128 before 129 so the small files are
not blocked by the daily limit.

| # | Check | Pass criterion |
|---|---|---|
| 121 | Contacts → **Import from file** → the CSV | Columns are matched automatically (Full name, Email, Phone, Notes); the review shows counts of rows ready, needing attention, and likely duplicates, with plain-language reasons; after importing, the result screen counts match and the new contacts appear in the list |
| 122 | Settings → Google Sheets → **Import from file** → the XLSX (add a second sheet to the workbook) | You are asked which sheet to use; the import works the same way. Import History shows **File upload · <file name>** next to Google Sheet imports; the **Source** filter shows each on its own |
| 123 | Choose the PDF | Refused straight away: "Please choose an Excel (.xlsx, .xls) or CSV (.csv) file." Nothing imported |
| 124 | Choose the > 5 MB file | Refused before reading: "That file is larger than 5 MB…". Nothing imported |
| 125 | Import the same CSV a second time (a new upload) | No new contacts: everyone is recognised (updated or skipped). Contacts count unchanged |
| 126 | Import a file with the automation checkbox **off** (the default), with an active "new contact" automation | SQL: the new contacts' `automation_trigger_events` rows are `cancelled` with reason "Imported from a file without automated follow-up."; nothing is enrolled or sent |
| 127 | Same, with the checkbox **on** | The events are `pending`, then processed; the contacts are enrolled (daily enrollment limit still applies) |
| 128 | Google Sheets → **Sync Now** in the connected Sheet (with #19 live) | The sync still imports as before; Import History shows it as **Google Sheet · <connection>** |
| 129 | Import a CSV of **250 new people** (made-up addresses at a domain you control), automation checkbox off. Before importing, note the "You can add N more contacts from files today" line and the preview warning. **After 24 hours**, upload the same file again | Before: the review warns "Only the first N new contacts will be added today…". Result: **200 added** (fewer if earlier checks used some of today's limit) and **50 "Not added — daily limit"**; Import History shows those rows as "Not imported — daily limit of 200 new contacts reached…". Opening the dialog again shows the limit reached with the import button disabled. After the window: the re-upload adds the remaining 50, and the first 200 show as existing contacts (no duplicates). A 501-row file is refused with "Files can have up to 500 rows…" |

```sql
-- 126 / 127
select c.full_name, e.status, e.last_error
from public.automation_trigger_events e
join public.contacts c on c.id = e.contact_id
where e.event_type = 'contact_created'
order by e.created_at desc limit 20;
```

---

## U. In-app Notifications (130–139) — migration #20 is already live

**Checks 130–134 (bell, file-upload and Sheets-sync notifications) are
testable now.** 135–139 need Part 2 (the sending domain,
`resend-webhook`, inbound replies and an active automation); mark them DEFER
until then.

| # | Check | Pass criterion |
|---|---|---|
| 130 | Open the app (with the Phase 4H frontend served) | A bell sits in the header. With nothing unread there is no badge, and its accessible name is "Notifications" |
| 131 | Import a small CSV (3 new people, 1 row with no email or phone) | Within a minute (or on refocusing the tab) the bell shows **1**. The panel shows "File upload finished: 3 added, 1 needs fixing" with the file name; clicking it opens Import History and the badge goes back to 0 |
| 132 | Google Sheets → **Sync Now** with 2 new leads in the Sheet | One notification "Google Sheets sync: 2 new leads". Add 1 more lead and sync again within the hour, without opening the panel: still **one** notification, now "3 new leads" |
| 133 | **Sync Now** with nothing new in the Sheet | No new notification and the badge does not change |
| 134 | Keyboard: Tab to the bell, press Enter; press Escape. Open again and click outside. Use **Mark all as read**, then **See all** | The panel opens with focus inside and closes on Escape with focus back on the bell; a click outside closes it. Mark all clears the badge. See all opens /notifications; each filter (All, Unread, Replies, Hot, Imports, Problems) shows the right items |
| 135 | (Part 2) A test contact replies "Thanks, got it" to a follow-up | One notification "<Name> replied to your follow-up", linking to the contact |
| 136 | (Part 2) A test contact replies "Can we book a viewing on Saturday?" | One notification "🔥 <Name> replied — asked about a viewing" (not two). **Mark as Hot** sets the contact's temperature to Hot. A reply of "Not interested, we already bought" is a plain reply notification |
| 137 | (Part 2) A test contact uses the unsubscribe link; another replies "unsubscribe" | One "unsubscribed" notification each, worded "They used the unsubscribe link…" / "They replied asking to be unsubscribed." Marking a contact unsubscribed yourself makes none |
| 138 | (Part 2) Send to a Resend bounce test address | One notification "A follow-up email to <Name> bounced" |
| 139 | (Part 2) A follow-up that fails for good (for example the sending key removed, after the retries run out) | One notification "A follow-up email to <Name> couldn't be sent", linking to Automation. A step that is only being retried makes none |

```sql
-- 131–139: what was created (no message content is stored)
select type, title, link_route, read_at is not null as read, created_at
from public.notifications
order by created_at desc limit 20;
```

---

## Results Summary

| Area | Checks | Pass | Fail | N/A | Defer |
|---|---|---|---|---|---|
| A. Google Sheets | 1–16 | | | | |
| B. Email Sending Setup | 17–22 | | | | |
| C. Email Templates | 23–28 | | | | |
| D. Automation Rules | 29–32 | | | | |
| E. Activation and Enrollment | 33–44 | | | | |
| F. Delivery Webhooks | 45–46 | | | | |
| G. Stop Logic — Hard Bounce | 47–54 | | | | |
| H. Stop Logic — Complaint | 55–60 | | | | |
| I. Stop Logic — Reply | 61–62 | | | | |
| J. Pause / Resume / Archive | 63–69 | | | | |
| K. Retry Behaviour | 70–72 | | | | |
| L. Duplicate Prevention | 73–74 | | | | |
| M. UI Verification | 75–80 | | | | |
| N. Data Integrity and Security | 81–83 | | | | |
| O. Unsubscribe Link | 84–93 | | | | |
| P. Contact Page Manual Actions | 94–101 | | | | |
| Q. Guard and Race Behaviour | 102–108 | | | | |
| R. Automatic Reply Detection | 109–115 | | | | |
| S. Unsubscribe by Reply | 116–120 | | | | |
| T. Import from File | 121–129 | | | | |
| U. In-app Notifications | 130–139 | | | | |
| **Total** | **139** | | | | |

### Known limitations to record, not investigate

- **#62, #109–120** — automatic reply detection needs Resend Receiving and
  `INBOUND_REPLY_DOMAIN`. Without them, mark DEFER; **Mark as replied** (#61,
  section P) is the supported fallback.
- **#103** — a true mid-send race is timing-dependent; record what you
  observed rather than failing it if the timing could not be hit.
- **#55–60** — depend on Resend offering a complaint test address. If it does
  not, mark DEFER rather than FAIL.

### Cleanup after testing

```sql
-- Review before deleting anything.
select id, name, status from public.automation_rules order by created_at desc;

-- Archive test rules through the UI (never delete an active rule directly —
-- archiving is the transactional path that also stops enrollments and
-- cancels pending jobs).

-- Suppressions created by bounce/complaint testing are intentionally
-- permanent. Deactivate one ONLY if it was a test address you control:
-- update public.email_suppressions set is_active = false where id = '<ID>';
```

Leave the cron job running only if you intend automation to stay live. To stand
down after testing:

```sql
select cron.unschedule('process-automation-worker');
```
