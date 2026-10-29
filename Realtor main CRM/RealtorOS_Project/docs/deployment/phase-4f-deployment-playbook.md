# RealtorOS — Phase 4F Production Deployment Playbook

A runbook. Follow it top to bottom. Every section ends with a **STOP GATE** —
do not continue past a gate that has not passed.

**State of the live project** (verified directly on Supabase, updated for
Phase 4H):

- **All 28 migrations through T3 are live**, the last being
  `20261007130000_phase_t3_invitations_and_membership`.
  The repository's migration filenames match the live version numbers.
  **No migration remains to apply for Phase 4F** — but two later ones are
  now pending, neither of which Phase 4F needs:
  - `20261013120000_phase_t4_followups` (the T4 team follow-ups: member
    permission overrides in the roster, and the team-mode guard trigger).
    Rollback: `supabase/rollback/t4_followups_revert.sql`.
  - `20261014120000_sheet_import_matches_manual_contacts` (H-1: a Google
    Sheet import matches a contact entered by hand instead of duplicating
    it). Rollback:
    `supabase/rollback/sheet_import_manual_match_revert.sql`.
- **Deployed Edge Functions:** `create-sheet-connection`,
  `ingest-sheet-leads` and `import-lead-file`. Not deployed:
  `send-test-email`, `resend-webhook`, `manage-automation`,
  `process-automation` and `email-unsubscribe`.
- **No automation data:** 0 rules, enrollments, jobs and outbound messages.
- **`pg_cron` is not enabled.** No cron job exists, no rule is active, no
  email has ever been sent.

Placeholders used throughout: `<PROJECT_REF>`, `<SENDING_DOMAIN>`,
`<AUTOMATION_WORKER_SECRET>`, `<INBOUND_DOMAIN>`. Replace them as you go.
**Never commit a file containing a real value.**

---

## Section 0 — Read this first

### Three things that will bite you if you skip them

**1. Confirm the contacts trigger hotfix is live.**
The Phase 4E migration installed a trigger on `public.contacts` whose function
used `pg_catalog.current_user` — a run-time parse error that made every insert
and update of `contacts` fail. The Phase 4E.2 migration (now live) replaced it.
Confirm once:

```sql
SELECT prosrc ~* 'pg_catalog\.current_user' AS broken
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'automation_internal' AND p.proname = 'protect_contact_lifecycle_columns';
-- Expect false. Then edit and save any contact in the app.
```

**2. `manage-automation` needs five secrets, not just the two you'd expect.**
Its activation preflight checks that `RESEND_API_KEY`, `RESEND_SENDING_DOMAIN`,
`RESEND_WEBHOOK_SECRET`, `AUTOMATION_WORKER_SECRET` and
`UNSUBSCRIBE_SIGNING_SECRET` all exist before it will activate any rule. Miss
one and activation fails with `provider_not_configured`. See
`environment-variables.md` §1.

**3. Every automated email needs a working unsubscribe link.** Without
`UNSUBSCRIBE_SIGNING_SECRET` (32+ characters) the worker sends nothing and
reschedules the job (`unsubscribe_not_configured`). Supabase's default
functions domain serves HTML as plain text, so read Section 4's note on
`UNSUBSCRIBE_PAGE_URL` before choosing where the unsubscribe page lives.

### Deployment order at a glance

```
1. Prerequisites            → accounts, CLI, access
2. Migration                → nothing to apply (all 20 live); run the verification queries
3. Resend domain            → can be done in parallel, must finish before Section 7
4. Secrets                  → 4 now, the webhook secret in Section 6; 2 optional settings
5. Edge Functions           → 6 to deploy, dependency-safe order
6. Resend webhook           → creates the webhook secret; optional inbound replies
7. Cron                     → enable pg_cron + pg_net, then schedule. LAST.
8. Security verification
9. Smoke tests
```

Cron is deliberately last. Until the cron job exists, `process-automation` never
runs on its own, so no automated email can be sent no matter what else is
misconfigured. That gives you a safe window to verify everything.

---

## Section 1 — Prerequisites Checklist

Tick every box before starting.

- [ ] **Supabase project** exists; you have its project ref (the subdomain in
      `https://<PROJECT_REF>.supabase.co`)
- [ ] **Supabase CLI** installed — `supabase --version`
- [ ] **CLI authenticated** — `supabase login`
- [ ] **Project linked** — from the repository root:
      `supabase link --project-ref <PROJECT_REF>`
- [ ] **Database access** — you can open Dashboard → SQL Editor and run
      `SELECT 1;`
- [ ] **Resend account** created
- [ ] **Sending domain chosen.** It must be verified before Section 6 is useful
      and before any real send in Section 9.
- [ ] **DNS access** for that domain (registrar or DNS provider login)
- [ ] **Secret values ready** — see `environment-variables.md`. Generate the
      worker secret and the unsubscribe signing secret now:
      ```bash
      openssl rand -base64 32   # AUTOMATION_WORKER_SECRET
      openssl rand -base64 48   # UNSUBSCRIBE_SIGNING_SECRET
      ```
      Store both in a password manager. The worker secret is needed twice: once
      as a Supabase secret, once inside the cron job SQL.
- [ ] **Decide on inbound replies** (optional, Section 6.B): a receiving
      domain or Resend's managed `<id>.resend.app` address.
- [ ] **A test inbox** you control, for the smoke test in Section 9

### Confirm the repository state

```bash
git log --oneline -12       # the Phase 4E.2 commits, newest first
git status --short          # only ?? README.md
(cd tests && npm install && npm test)   # offline suite: all pass
```

`supabase/` is the single source of truth for configuration, Edge
Functions, migrations and SQL verifications. (A byte-identical mirror
previously lived under `RealtorOS/supabase/` and was shipped with the
frontend bundle; it was removed in a cleanup commit — see
`docs/TEAM_ACCESS_ARCHITECTURE.md` for the history.)

### STOP GATE 1
Every box ticked, and the repository commands give the expected output.

---

## Section 2 — Database Migration

All 28 migrations through T3 are **already live**, the latest being
`20261007130000_phase_t3_invitations_and_membership`. **No migration
remains to apply for Phase 4F.** Do not re-apply any of them. This section
only confirms the live state.

Two later migrations are pending — `20261013120000_phase_t4_followups` and
`20261014120000_sheet_import_matches_manual_contacts` — and are listed in
the state summary at the top of this playbook. Phase 4F does not depend on
either, so this section ignores them.

### Migration inventory

| # | File | Phase | Status |
|---|---|---|---|
| 1–11 | `20260827040054` … `20260831114425` | pre-automation | already live |
| 12 | `20260904020906_phase_4c_email_delivery_foundation.sql` | 4C | already live |
| 13 | `20260904020954_phase_4c_email_delivery_reliability.sql` | 4C | already live |
| 14 | `20260904021204_phase_4d_automation_execution.sql` | 4D | already live |
| 15 | `20260904021416_phase_4d_automation_execution_reliability.sql` | 4D | already live |
| 16 | `20260904060217_phase_4e_reply_unsubscribe_stop_logic.sql` | 4E | already live |
| 17 | `20260929041708_phase_4e_2_stop_logic_completion.sql` | 4E.2 | already live |
| 18 | `20260929051621_phase_4e_3_unsubscribe_by_reply.sql` | 4E.3 | already live |
| 19 | `20260929095530_phase_4e_4_file_lead_import.sql` | 4E.4 | already live |
| 20 | `20260929150944_phase_4h_in_app_notifications.sql` | 4H | already live |
| 21 | `20261001160608_phase_t2a_workspace_foundation.sql` | T2a | already live |
| 22 | `20261005140817_phase_t2b1_permissions.sql` | T2b-1 | **already live — last applied** |

Every file is named with its live version number, so
`supabase migration list --project-ref <PROJECT_REF>` shows no local-only
migration.

### What #20 changed (already live)

- New table `public.notifications`: one row per thing to tell the owner (a
  lead replied, a hot reply, an unsubscribe, a spam report, a bounce, an
  import finished, a follow-up that failed). Plain text; never message
  bodies, email addresses or tokens. The browser can read its own rows and
  set `read_at` on them (column-level grant + owner RLS), nothing else.
- Notifications are created by **new triggers** on `contact_stop_events`,
  `lead_import_batches` and `automation_jobs`. No live function
  (`realtoros_record_contact_stop_event`, `realtoros_ingest_lead_batch`,
  `realtoros_ingest_lead_file`, …) is changed. Each trigger catches its own
  errors: a notification problem can never break an import, a stop event or
  a job update (it only logs a warning with no personal data).
- Google Sheets syncs that bring nothing new make no notification; syncs
  within an hour are grouped into one.
- New service_role-only `realtoros_mark_reply_hot(uuid, text, text)`, used
  by `resend-webhook` (once deployed) to flag a hot reply.

Re-runnable. No existing row was modified.

### What #19 changed (already live)

- `lead_import_batches` / `lead_import_rows` gain `source_type`
  (`google_sheet` | `file_upload`, default `google_sheet`, so every existing
  row stays valid) and batches gain `file_name`. `connection_id` becomes
  nullable, but check constraints require it for Google Sheet imports and
  forbid it for file uploads.
- The Google Sheet row loop moves into one shared internal function,
  `automation_internal.ingest_lead_rows`. `realtoros_ingest_lead_batch`
  keeps its **exact signature and behaviour** — the deployed
  `ingest-sheet-leads` needs no change or redeploy. (An offline regression
  test runs the same Sheet scenario before and after this migration and
  compares every written row.)
- New `realtoros_ingest_lead_file(...)` for file uploads (service_role only):
  up to **500 rows per file**, sent in one call; idempotent per import id;
  at most **10 uploads per 15 minutes and 20 per day** per owner.
- A daily limit for **file uploads only**: at most **200 new contacts per
  owner in any rolling 24 hours**. Only rows that create a contact count;
  rows matching existing contacts, repeats within a file and rejected rows
  do not. Past the limit, rows that would create a contact are recorded as
  "Not imported — daily limit…" (visible in Import History), and uploading
  the same file again after the window adds them. **Google Sheets imports
  are not limited or counted.** The limit is one constant,
  `c_daily_new_contacts`, in the new service_role-only
  `realtoros_file_import_quota(uuid)`, which also answers the app's "You can
  add N more contacts from files today."
- An index on `lead_import_rows` (`lead_import_rows_file_new_contacts_idx`)
  for counting that limit.
- Two indexes on `contacts` (`contacts_user_email_norm_idx`,
  `contacts_user_phone_norm_idx`) so matching a file row against existing
  contacts is an index lookup instead of a scan of every contact. On a large
  `contacts` table, creating them briefly blocks writes to `contacts` while
  they build (seconds for tens of thousands of rows).
- With "Start automated follow-up" unchecked, the new contacts' automation
  events are cancelled in the same transaction (never pending).

Re-runnable. No existing row was modified.

### Verify

Run these read-only queries; **every row must show `ok = true`**:

0. **`supabase/tests/phase_4h_verification.sql`** — the notifications
   table, its checks and indexes, RLS (owner select + update of `read_at`
   only; no insert/delete), the four triggers, and that every new function
   is service_role only.
1. **`supabase/tests/phase_4e_4_verification.sql`** — the new columns and
   constraints, the indexes, the four function signatures
   (including the unchanged Google Sheet one), grants (service_role only),
   and that browsers still cannot write the import tables or automation
   events.
2. **`supabase/tests/phase_4e_3_verification.sql`** and
   **`supabase/tests/phase_4e_2_verification.sql`** — the stop logic (still
   valid with #19 and #20 live).

Then confirm contacts can be written (edit one in the app), that a Google
Sheets **Sync Now** still imports (acceptance check #128), and that a small
file upload shows a notification in the bell (acceptance section U).

### STOP GATE 2
`supabase_migrations.schema_migrations` ends at `20260929150944`, every row of
all four verification queries is `ok = true`, and a contact edit saves.

---

## Section 3 — Resend Sending Domain

Can be done any time from now; must be complete before Section 6 is useful and
before any real send in Section 9. Verification can take minutes to hours, so
starting it now while you continue with Sections 4–5 is a good use of the wait.

1. Log into the Resend dashboard.
2. Go to **Domains** → **Add Domain**.
3. Enter `<SENDING_DOMAIN>`. A subdomain such as `mail.example.com` is
   recommended over the apex domain: it isolates sending reputation and avoids
   clashing with the apex domain's existing MX records.
4. Resend displays the DNS records to create. Typically:
   - **MX** — for the bounce/return path
   - **TXT (SPF)** — authorises Resend to send for the domain
   - **CNAME (DKIM)** — usually two or three records, for message signing
   - **TXT (DMARC)** — optional but strongly recommended
5. Add every record at your DNS provider **exactly** as shown. Common mistakes:
   - Some providers append the zone automatically. If Resend says
     `mail`, and your provider shows the result as `mail.example.com.example.com`,
     enter `mail` only, not the full name.
   - Do not add quotes around TXT values unless your provider requires them.
6. Click **Verify** in Resend. Propagation is usually minutes but the TTL of any
   pre-existing record can extend it.
7. Wait until the domain shows **Verified**.

**Set `RESEND_SENDING_DOMAIN` to the bare domain** — `mail.example.com`. No
`https://`, no `@`, no trailing dot. The worker validates its shape and refuses
anything else.

### 3.B — Receiving domain for automatic reply detection (optional)

The sending domain above only lets Resend **send** mail: its SPF and DKIM
records prove the mail is yours. It does **not** let Resend receive replies.
Automatic reply detection (`INBOUND_REPLY_DOMAIN`, Section 6.B) needs a
**separate receiving domain or subdomain** set up in Resend with **MX
records** pointing at Resend, in addition to the sending domain's SPF/DKIM:

| Purpose | Example | Records | Setting |
|---|---|---|---|
| Sending | `mail.example.com` | SPF (TXT), DKIM (CNAME), return-path MX, DMARC | `RESEND_SENDING_DOMAIN` |
| Receiving replies | `reply.example.com` (or Resend's managed `<id>.resend.app`) | **MX** records Resend shows for Receiving | `INBOUND_REPLY_DOMAIN` |

- Use a **dedicated subdomain** for receiving. Never point the MX records of
  your main domain (where people's normal email arrives) at Resend — that
  would divert all of its email.
- Resend's managed `<id>.resend.app` address needs no DNS at all, if you
  prefer not to add records.
- The receiving domain can be verified any time before Section 6.B; nothing
  else depends on it.

**Without a receiving domain, replies can only be recorded manually** with
**Mark as replied** on the contact page. Replies still reach the agent
directly, because the agent's own address is always first in Reply-To.

### STOP GATE 3
The domain shows **Verified** in Resend. (You may proceed to Sections 4 and 5
while waiting, but not to Section 7.)

---

## Section 4 — Secret Configuration

Supabase secrets are **project-wide**: one `set` makes the value available to
every Edge Function in the project. Secrets can be set before deployment.

Five required secrets. You will set four now and `RESEND_WEBHOOK_SECRET` in
Section 6, after Resend generates it. Two further settings are optional.

See `environment-variables.md` for the complete reference including what breaks
if each is missing.

---

#### Secret 1 of 5 — `RESEND_API_KEY`

- **Used by:** `send-test-email`, `process-automation` (sending); `resend-webhook` (reads received emails when inbound replies are on); `manage-automation` (presence check)
- **Purpose:** authenticates every Resend API call
- **How to obtain:** Resend Dashboard → API Keys → Create API Key. **Sending access** is enough unless you enable inbound replies (Section 6.B): `resend-webhook` then calls `GET /emails/receiving/{id}` to read a reply's headers, which a sending-only key may not be allowed to do. If you enable inbound replies, use a key that can read received emails (check the key permissions Resend offers at the time).

```bash
supabase secrets set RESEND_API_KEY=<VALUE> --project-ref <PROJECT_REF>
```

---

#### Secret 2 of 5 — `RESEND_SENDING_DOMAIN`

- **Used by:** `send-test-email`, `process-automation` (real use); `manage-automation` (presence check)
- **Purpose:** builds the `From:` address as `agent-<hash>@<SENDING_DOMAIN>`
- **How to obtain:** the domain you verified in Section 3. Bare domain only.

```bash
supabase secrets set RESEND_SENDING_DOMAIN=<SENDING_DOMAIN> --project-ref <PROJECT_REF>
```

---

#### Secret 3 of 5 — `AUTOMATION_WORKER_SECRET`

- **Used by:** `process-automation` (real use); `manage-automation` (presence check)
- **Purpose:** the only credential protecting the worker endpoint, which is public at the platform level (`verify_jwt = false`). It is compared in constant time against the `x-realtoros-worker-secret` header.
- **How to obtain:** generate it yourself.

```bash
openssl rand -base64 32
```

```bash
supabase secrets set AUTOMATION_WORKER_SECRET=<VALUE> --project-ref <PROJECT_REF>
```

**Save this value.** You need it again in Section 7, inside the cron job SQL.

---

#### Secret 4 of 5 — `UNSUBSCRIBE_SIGNING_SECRET`

- **Used by:** `process-automation` (signs the unsubscribe link and derives the reply token), `email-unsubscribe` (verifies links); `manage-automation` (presence check)
- **Purpose:** HMAC key for the signed, expiring (180 days), single-purpose unsubscribe token in every automated email. Must be at least 32 characters.
- **How to obtain:** generate it yourself.

```bash
openssl rand -base64 48
```

```bash
supabase secrets set UNSUBSCRIBE_SIGNING_SECRET=<VALUE> --project-ref <PROJECT_REF>
```

**Rotating it invalidates every unsubscribe link already sent** (they show
"This unsubscribe link has expired") and changes reply tokens for new messages. Rotate only
if it leaks.

---

#### Secret 5 of 5 — `RESEND_WEBHOOK_SECRET`

Deferred to **Section 6**, because Resend generates it when you create the
webhook endpoint.

---

#### Optional — `UNSUBSCRIBE_PAGE_URL`

Where the **visible footer link** in each email sends people. The
`List-Unsubscribe` header (used by mail apps' built-in unsubscribe button)
always points at the `email-unsubscribe` function and works everywhere.

- **Not set:** the footer links to the function's own confirmation page. That
  page only renders as a page on a **custom functions domain** — Supabase's
  default `*.supabase.co` domain serves HTML as plain text, so people would see
  raw markup.
- **Set** to the public URL of `app/unsubscribe.html` on wherever the
  frontend is hosted (must be `https://`, no `?` or `#`), e.g.
  `https://app.example.com/unsubscribe.html`. The token travels in the `#`
  fragment, which browsers never send to that host.

**Recommendation:** set it unless you have a custom functions domain.

```bash
supabase secrets set UNSUBSCRIBE_PAGE_URL=https://<APP_HOST>/unsubscribe.html --project-ref <PROJECT_REF>
```

#### Optional — `INBOUND_REPLY_DOMAIN`

Turns on automatic reply detection (Section 6.B). Leave unset to rely on the
owner's **Mark as replied** button only.

---

#### Verify

```bash
supabase secrets list --project-ref <PROJECT_REF>
```

Names appear; values never do. Expect `RESEND_API_KEY`,
`RESEND_SENDING_DOMAIN`, `AUTOMATION_WORKER_SECRET`,
`UNSUBSCRIBE_SIGNING_SECRET` (and, after Section 6, `RESEND_WEBHOOK_SECRET`),
plus any optional settings you chose.

### STOP GATE 4
Four required secrets listed. Do not proceed to Section 5 without them — a deployed
function with a missing secret fails closed, which is safe but confusing to
debug.

---

## Section 5 — Edge Function Deployment

Six functions to deploy. `create-sheet-connection` and `ingest-sheet-leads`
are already live and unchanged by Phase 4E–4E.4 (their only shared import,
`_shared/runtime.ts`, has not changed, and the SQL function
`ingest-sheet-leads` calls keeps its signature), so they need no redeploy.

`_shared/` is **not** a function — it has no `index.ts`, and the Supabase CLI
skips underscore-prefixed directories. Its code is bundled into each function
that imports it, so **any function importing a changed `_shared` file must be
redeployed**. Phase 4E.2 added `_shared/unsubscribe-token.ts` and
`_shared/reply-detection.ts`.

### Function inventory

| # | Function | Purpose | Auth | `verify_jwt` | Called by | Secrets needed | Status |
|---|---|---|---|---|---|---|---|
| 1 | `create-sheet-connection` | Issue a Google Sheets connector token | Supabase user JWT | `true` | Browser | none | live |
| 2 | `ingest-sheet-leads` | Accept lead rows from Apps Script | Connector token + timestamp + nonce + replay/rate checks | `false` | Google Apps Script | none | live |
| 3 | `manage-automation` | Rule activate/pause/resume/archive, manual enroll, retry, stop summary, mark replied/unsubscribed | Supabase user JWT | `true` | Browser | all five, **presence only** | **deploy** |
| 4 | `send-test-email` | One authenticated test send to the caller's own reply-to | Supabase user JWT | `true` | Browser | `RESEND_API_KEY`, `RESEND_SENDING_DOMAIN` | **deploy** |
| 5 | `email-unsubscribe` | Public unsubscribe link: GET confirms, POST / one-click unsubscribes | Signed expiring token | `false` | Email recipients, mail apps | `UNSUBSCRIBE_SIGNING_SECRET` | **deploy (new)** |
| 6 | `resend-webhook` | Delivery events, complaints, hard bounces, inbound replies | Svix signature | `false` | Resend | `RESEND_WEBHOOK_SECRET` (+ `RESEND_API_KEY`, `INBOUND_REPLY_DOMAIN` for replies) | **deploy** |
| 7 | `process-automation` | The automation worker | `x-realtoros-worker-secret`, constant-time compare | `false` | pg_cron | `RESEND_API_KEY`, `RESEND_SENDING_DOMAIN`, `AUTOMATION_WORKER_SECRET`, `UNSUBSCRIBE_SIGNING_SECRET` (+ optional `UNSUBSCRIBE_PAGE_URL`, `INBOUND_REPLY_DOMAIN`) | **deploy** |
| 8 | `import-lead-file` | One-time lead import from an Excel/CSV file (rows parsed in the browser) | Supabase user JWT | `true` | Browser | none (Supabase auto only) | **deploy (new)** — migration #19 is already live |

### `verify_jwt` is already configured

`supabase/config.toml` sets `verify_jwt` per function. The CLI reads it
automatically — **do not pass `--no-verify-jwt`**, and do not change these
settings. Four functions are deliberately public at the platform level because
their callers cannot send a Supabase user JWT, and each authenticates every
request itself:

- `ingest-sheet-leads` — Apps Script has no JWT; uses a connector token
- `resend-webhook` — Resend has no JWT; uses the Svix signature
- `process-automation` — cron has no JWT; uses the worker secret
- `email-unsubscribe` — the person clicking has no account; uses the signed token

### Deployment order

Least-privileged and least-consequential first; the worker last.

---

#### Function 1 of 5 — `manage-automation`

```bash
supabase functions deploy manage-automation --project-ref <PROJECT_REF>
```

**Verify** — unauthenticated request must be rejected by the platform:
```bash
curl -i -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/manage-automation" \
  -H "Content-Type: application/json" -d '{}'
```
Expect **401**. A 404 means the deploy did not land.

---

#### Function 2 of 5 — `send-test-email`

```bash
supabase functions deploy send-test-email --project-ref <PROJECT_REF>
```

**Verify:**
```bash
curl -i -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/send-test-email" \
  -H "Content-Type: application/json" -d '{}'
```
Expect **401**. This sends nothing — it never reaches the provider without a
valid user JWT.

---

#### Function 3 of 5 — `email-unsubscribe`

```bash
supabase functions deploy email-unsubscribe --project-ref <PROJECT_REF>
```

**Verify** — a missing or bad token gets the same generic refusal, and nothing
is written:
```bash
curl -i "https://<PROJECT_REF>.supabase.co/functions/v1/email-unsubscribe?t=bogus"
# Expect 400 with the "This unsubscribe link has expired" page (served as text/plain on
# the default supabase.co domain — expected).

curl -i -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/email-unsubscribe" \
  -H "Content-Type: application/json" -d '{"token":"bogus"}'
# Expect 400 {"error":"invalid_link"}
```

---

#### Function 4 of 5 — `resend-webhook`

```bash
supabase functions deploy resend-webhook --project-ref <PROJECT_REF>
```

**Verify** — no Svix headers means it must refuse before touching the database:
```bash
curl -i -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/resend-webhook" \
  -H "Content-Type: application/json" -d '{}'
```
Expect **401 `signature_required`**.

Uses migration #20 (already live) for the Phase 4H hot-reply step: after recording an
inbound reply, the function runs a rule-based check of the person's own text
(quoted history and signatures ignored) and, when it shows buying/selling
intent, calls `realtoros_mark_reply_hot` so the reply's notification becomes
"🔥 … asked about a viewing". Only a reason code is stored, never the reply
text. If that call fails the reply is still processed normally.

If you get **503 `webhook_not_configured`**, the function is live but
`RESEND_WEBHOOK_SECRET` is not set yet — that is expected at this point and is
resolved in Section 6. It is also the correct fail-closed behaviour: it performs
no database write at all.

---

#### Function 5 of 5 — `process-automation`

Deploy this last. It is inert until Section 7 creates the cron job — nothing
invokes it on its own.

```bash
supabase functions deploy process-automation --project-ref <PROJECT_REF>
```

**Verify** — wrong secret must be rejected:
```bash
curl -i -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/process-automation" \
  -H "Content-Type: application/json" \
  -H "x-realtoros-worker-secret: definitely-not-the-secret" -d '{}'
```
Expect **401 `unauthorized`**.

**Optional — one authenticated dry run.** Safe now, because no rule is active
and no enrollment exists, so it will find nothing to do:
```bash
curl -i -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/process-automation" \
  -H "Content-Type: application/json" \
  -H "x-realtoros-worker-secret: <AUTOMATION_WORKER_SECRET>" -d '{}'
```
Expect **200** with all counters zero:
```json
{"ok":true,"counters":{"recoveredEvents":0,"failedStaleEvents":0,"recoveredJobs":0,
"failedStaleJobs":0,"eventsCompleted":0,"eventsRescheduled":0,"eventsErrored":0,
"enrollmentsCreated":0,"enrollmentsBlocked":0,"jobsCompleted":0,"jobsRescheduled":0,
"jobsCancelled":0,"jobsSkipped":0,"jobsAbandoned":0,"jobsFailedTerminal":0,"jobsErrored":0}}
```

A non-zero `eventsCompleted` is fine and expected if contacts were added after
migration 3 landed — those are queued trigger-event rows being drained against
zero active rules.

#### Function 6 of 6 — `import-lead-file`

Uses migration #19, which is already live (Section 2).

```bash
supabase functions deploy import-lead-file --project-ref <PROJECT_REF>
```

**Verify** — unauthenticated request must be rejected by the platform:
```bash
curl -i -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/import-lead-file" \
  -H "Content-Type: application/json" -d '{}'
```
Expect **401**. Then import a small CSV from the app (acceptance section T).
The import dialog also reads the daily limit through this function
(`{"action":"quota"}`, owner from the JWT).

### Confirm all eight are live

```bash
supabase functions list --project-ref <PROJECT_REF>
```

### STOP GATE 5
All eight functions listed. Every curl returns the expected status. The worker dry
run (if performed) returned 200 with `jobsCompleted: 0`.

---

## Section 6 — Resend Webhook Configuration

1. Resend Dashboard → **Webhooks** → **Add Webhook**.
2. **Endpoint URL:**
   ```
   https://<PROJECT_REF>.supabase.co/functions/v1/resend-webhook
   ```
3. **Select event types.** The handler recognises these, read from
   `EVENT_MAP` in `resend-webhook/index.ts` (checked against Resend's event
   list on 2026-09-28):

   | Event | Sets message status | Stops or blocks anything? |
   |---|---|---|
   | `email.sent` | `sent` | no |
   | `email.delivered` | `delivered` | no |
   | `email.delivery_delayed` | `delivery_delayed` | no |
   | `email.opened` | `opened` | no |
   | `email.clicked` | `clicked` | no |
   | `email.bounced` — `bounce.type` `Permanent` (or missing) | `bounced` | **yes** — address blocked (`bounce`); email steps are skipped, other steps continue |
   | `email.bounced` — any other `bounce.type` (soft) | unchanged | no |
   | `email.complained` | `complained` | **yes** — email blocked + consent revoked; the automation stops if the rule has `stop_on_unsubscribe` |
   | `email.failed` | `failed` | no |
   | `email.suppressed` | `suppressed` | **yes** — address blocked (`provider`); email steps skipped |
   | `email.received` | `replied` on the original message | **yes** — only with inbound replies on (6.B); stops if the rule has `stop_on_reply`; automatic replies never stop anything |

   Resend has no `email.unsubscribed` or `email.replied` event; unsubscribes
   come through `email-unsubscribe` and replies through `email.received`.
   Any other event type is recorded and marked `ignored` — subscribing to extra
   events is harmless.

4. Save the webhook.
5. Copy the **signing secret** (starts with `whsec_`).
6. Set it:
   ```bash
   supabase secrets set RESEND_WEBHOOK_SECRET=<VALUE> --project-ref <PROJECT_REF>
   ```
7. **Redeploy `resend-webhook`** so it picks the value up immediately rather
   than on its next cold start:
   ```bash
   supabase functions deploy resend-webhook --project-ref <PROJECT_REF>
   ```

**Verify:**

```bash
supabase secrets list --project-ref <PROJECT_REF>   # all five required secrets now present

curl -i -X POST "https://<PROJECT_REF>.supabase.co/functions/v1/resend-webhook" \
  -H "Content-Type: application/json" -d '{}'
# Expect 401 signature_required — NOT 503. 503 means the secret is not visible yet.
```

If Resend offers **Send test event**, use it. Then confirm it was received:

```sql
SELECT provider, event_type, status, signature_valid, received_at
FROM public.webhook_events
ORDER BY received_at DESC
LIMIT 5;
```

A test event for an unknown `email_id` is correctly recorded as `ignored` — the
function never guesses which user an unrecognised provider message belongs to.
`signature_valid = true` is the thing to confirm here.

### 6.B — Inbound replies (optional)

Automatic reply detection. Without it, replies still reach the agent (their
own Reply-To address is always first on every automated email) and the owner
can use **Mark as replied** on the contact page.

1. Set up the **receiving domain** described in Section 3.B — a separate
   domain or subdomain with Resend's MX records (or the managed
   `<id>.resend.app` address). The sending domain's SPF/DKIM records alone
   are **not** enough to receive replies.
2. Make sure the webhook from step 3 includes **`email.received`**.
3. Set the domain (bare, lowercase, no `@`):
   ```bash
   supabase secrets set INBOUND_REPLY_DOMAIN=<INBOUND_DOMAIN> --project-ref <PROJECT_REF>
   supabase functions deploy process-automation --project-ref <PROJECT_REF>
   supabase functions deploy resend-webhook --project-ref <PROJECT_REF>
   ```
4. Check `RESEND_API_KEY` can read received emails (Section 4, Secret 1).

From then on, each new automated email's Reply-To is
`<agent address>, r-<40 hex>@<INBOUND_DOMAIN>`. The token is opaque (no id,
name or address). On `email.received`, the webhook matches the token, fetches
the reply's headers from `GET /emails/receiving/{id}`, drops automatic replies
(`Auto-Submitted`, `X-Autoreply`, `Precedence: bulk/auto_reply`, list headers,
system senders, out-of-office subjects) with only a timeline note, and records
a real reply. Nothing from the inbound email is stored.

**Opt-out replies (Phase 4E.3).** A reply whose subject (minus `Re:`/`Fwd:`)
or first written line is **exactly** one of `unsubscribe`, `unsubscribe me`,
`please unsubscribe`, `please unsubscribe me`, `stop`, `remove`, `remove me`,
`please remove me`, `opt out`, `optout`, `opt me out` (any case, punctuation
ignored, quoted history and signatures ignored) is recorded as an
**unsubscribe** — email consent revoked, address blocked, automations that stop
on unsubscribe stopped — not as a reply. A keyword inside a longer sentence
("yes I'm interested, stop by at 5") is an ordinary reply. Requires
migration #18.

> **Not verified against a live provider.** Event name, payload fields and the
> retrieval endpoint were checked against Resend's documentation on
> 2026-09-28, and the offline tests cover the flow with a mocked provider. The
> real receiving setup, the API key permission needed for
> `GET /emails/receiving/{id}`, and the exact header casing in live responses
> must be confirmed in acceptance test section R.

### STOP GATE 6
Five secrets listed. The unsigned curl returns 401, not 503. If you sent a test
event, `signature_valid = true`.

---

## Section 7 — Cron Scheduling for `process-automation`

**This is the switch that makes automation live.** Until this exists, nothing
runs automatically. Do not do this until Gates 2, 5 and 6 have passed.

**`pg_cron` and `pg_net` must be enabled first.** Neither is enabled on the
live project today. Step 1 of `setup-cron.sql` enables both
(`create extension if not exists …`); you can also enable them under
Dashboard → Database → Extensions. Confirm before scheduling anything:

```sql
SELECT extname, extversion FROM pg_extension WHERE extname IN ('pg_cron', 'pg_net');
-- Expect 2 rows
```

Use `setup-cron.sql`. Replace both placeholders, run it in the SQL
Editor, and **do not commit the edited file**.

### Choosing an interval

| Interval | Cron | Runs/day | Worst-case delay | Best for |
|---|---|---|---|---|
| 1 minute | `* * * * *` | 1,440 | ~1 min | Fastest response; highest invocation count |
| **2 minutes** | `*/2 * * * *` | 720 | ~2 min | **Recommended starting point** |
| 5 minutes | `*/5 * * * *` | 288 | ~5 min | Lower cost, still responsive |
| 15 minutes | `*/15 * * * *` | 96 | ~15 min | Minimal cost; fine for non-urgent follow-up |

The interval bounds **added latency**, not total delay: a step scheduled for
09:00 with a 5-minute cron runs between 09:00 and 09:05. Each run processes up to
25 trigger events and 25 jobs, so a longer interval also means larger batches.

Cost is driven by invocations, not by work done — an idle run is cheap but not
free. Start at 2 minutes, then lengthen it once you see real volume.

### Two operational notes

**The worker secret is stored in the database.** `pg_net` needs it in the request
header, so it lives in the `cron.job` table's command text, readable by anyone
with database admin access. This is the standard Supabase pattern for scheduling
Edge Functions. Treat database admin access as equivalent to holding the worker
secret. If you rotate the secret, you must update the cron job too — see
`environment-variables.md` §5.

**`net.http_post` is fire-and-forget.** It queues the request and returns
immediately; the cron run is recorded as succeeded once the request is *queued*,
not once the worker *finishes*. So `cron.job_run_details` tells you the schedule
is firing, not that automation is working. For the latter, check the Edge
Function logs and the `counters` in its response. Responses land in
`net._http_response` (retained briefly) if you want to inspect them:

```sql
SELECT id, status_code, error_msg, created
FROM net._http_response
ORDER BY created DESC
LIMIT 20;
```

### Verify

```sql
-- The job exists and is active.
SELECT jobid, jobname, schedule, active FROM cron.job
WHERE jobname = 'process-automation-worker';

-- It is actually firing. Wait one or two intervals first.
SELECT status, return_message, start_time, end_time
FROM cron.job_run_details
WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname='process-automation-worker')
ORDER BY start_time DESC
LIMIT 10;
-- Expect status = 'succeeded'
```

Then confirm the worker really ran: Dashboard → Edge Functions →
`process-automation` → Logs. Expect a 200 every interval.

### Pause immediately if anything looks wrong

```sql
SELECT cron.unschedule('process-automation-worker');
```

This is the emergency stop for all automation. It takes effect at once and is
always safe — in-flight jobs finish or are recovered by the stale-lease sweep on
the next run.

### STOP GATE 7
The job appears in `cron.job` with `active = true`, `cron.job_run_details` shows
`succeeded`, and the Edge Function logs show 200s.

---

## Section 8 — Post-Deployment Security Verification

Run the whole of `security-audit.sql` in the SQL Editor and check
every result against its comment. Summary of what it proves:

**8.1 — RLS on every table.** All automation and CRM tables must show
`rowsecurity = true`.

**8.2 — No service-role RPC is reachable from the browser.** Must return **zero
rows**. Every `realtoros_*` function revokes all privileges from
`public, anon, authenticated` and grants execute only to `service_role`.
The Phase 4E.2 verification query (Section 2) additionally checks the new and
changed stop functions one by one, and that `contact_stop_events` has RLS on,
no policies, and no browser grants.

**8.3 — The Phase 4E column-protection trigger exists.** Two rows
(`INSERT` and `UPDATE`), both `BEFORE`. This is what stops the browser writing
`contacts.reply_detected_at` / `unsubscribe_detected_at` — necessary because
`contacts` carries a table-level `UPDATE` grant to `authenticated`, and
PostgreSQL cannot subtract a column-level revoke from a table-level grant.

**8.4 — `SECURITY DEFINER` audit.** Expect exactly three, all in
`automation_internal`, none in `public`:
`contact_created_event`, `contact_status_changed_event` (they insert into a table
the calling user has no grant on) and, depending on your Postgres version's
reporting, the lifecycle guard. The lifecycle guard is deliberately
`SECURITY INVOKER` — as definer, `current_user` would be the function owner and
the browser-role check would never fire. **No `public.realtoros_*` function
should be `SECURITY DEFINER`.**

**8.5 — Supabase Security Advisor.** Dashboard → Database → Security Advisor.
Address anything it flags. A "Function Search Path Mutable" warning should not
appear — every function here pins `search_path = ''`.

**8.6 — Supabase Performance Advisor.** Dashboard → Database → Performance
Advisor.

> **The four performance-critical lookups are already indexed.** Verified
> against the migrations — you should not need to add anything:
>
> | Lookup | Index | Defined in |
> |---|---|---|
> | `outbound_messages.provider_message_id` (webhook) | `outbound_messages_provider_message_idx` — unique on `(provider, provider_message_id)` where not null | `20260831091706` |
> | `automation_enrollments` by contact (eligibility, stop fan-out) | `automation_enrollments_contact_idx` on `(user_id, contact_id)` | `20260831091706` |
> | `automation_jobs` by enrollment (cancellation) | `automation_jobs_enrollment_idx` on `(user_id, enrollment_id)` where not null | `20260831091706` |
> | `email_suppressions` active lookup | `email_suppressions_active_unique_idx` on `(user_id, normalized_email)` where `is_active` | `20260904020906` |
>
> Also present: `automation_jobs_claim_idx` on `(scheduled_at, id)` where
> `status='pending'` (the worker's hot path), and
> `contacts_lifecycle_stop_idx` (partial, from Phase 4E), and
> `outbound_messages_reply_token_idx` (unique partial, Phase 4E.2) for
> inbound-reply lookups.
>
> The Advisor may still suggest indexes on low-cardinality `status` columns.
> Ignore those until real query volume justifies them — the partial indexes above
> already encode the status filters.

### STOP GATE 8
8.2 returns zero rows. 8.1 shows RLS everywhere. 8.3 shows both trigger rows. No
unresolved Security Advisor error.

---

## Section 9 — Smoke Test Sequence

In order. **Each step is a gate.**

1. **Migrations** — re-run `supabase/tests/phase_4e_2_verification.sql`; every row `ok = true`.
2. **Functions reachable** — the curls from Section 5 all return their expected status.
3. **Secrets** — `supabase secrets list` shows all five required names.
4. **Resend domain** — status **Verified**.
5. **Webhook** — unsigned curl returns 401, not 503; test event recorded with `signature_valid = true`.
6. **Cron** — job present and `active`; `cron.job_run_details` shows `succeeded`; function logs show 200s.
7. **Test email** — open the app → **Settings → Email Sending**. Save a sender profile whose reply-to is **your own address**. Click **Send Test Email**.
   - Confirm it arrives.
   - Check sender display name, `From:` (`agent-<hash>@<SENDING_DOMAIN>`), and `Reply-To:`.
   - Confirm the record:
     ```sql
     SELECT id, status, message_kind, sent_at, provider_message_id
     FROM public.outbound_messages
     WHERE message_kind = 'test'
     ORDER BY created_at DESC
     LIMIT 5;
     -- Expect status 'sent' and a non-null provider_message_id
     ```
8. **Webhook delivery** — within a minute or two of step 7:
   ```sql
   SELECT om.status, om.delivered_at, we.event_type, we.status AS event_status
   FROM public.outbound_messages om
   LEFT JOIN public.webhook_events we ON we.outbound_message_id = om.id
   WHERE om.message_kind = 'test'
   ORDER BY om.created_at DESC, we.received_at DESC
   LIMIT 10;
   -- Expect outbound status advanced to 'delivered' and event_status 'processed'
   ```
   If the message stays `sent` with no webhook row, the Resend webhook endpoint
   URL is wrong or the events were not subscribed. Recheck Section 6.

9. **Unsubscribe link (first automated email only)** — the first time an
   automation sends (acceptance test 33+), open the message source and confirm:
   - a `List-Unsubscribe: <https://<PROJECT_REF>.supabase.co/functions/v1/email-unsubscribe?t=u1....>` header;
   - `List-Unsubscribe-Post: List-Unsubscribe=One-Click`;
   - the footer line "Don't want these emails? Unsubscribe here: …".
   Test sends from Settings do not carry these (they go to your own address).

**Only after steps 1–8 pass** should you proceed to the acceptance tests in
`phase-4g-acceptance-tests.md`; step 9 is checked during them.

### STOP GATE 9
Steps 1–8 pass. Automation is live and verified end to end.

---

## Section 10 — Rollback Plan

### Emergency stop — halts all automation immediately

```sql
SELECT cron.unschedule('process-automation-worker');
```

No further job is claimed and no further automated email is sent. Everything
else stays intact. This is always the first thing to do if something is wrong.

To also stop inbound events, disable the webhook in the Resend dashboard.

### Failed migration

`supabase db push` wraps each migration in a transaction — a failure rolls that
file back completely and leaves earlier migrations applied. Fix the cause and
re-run; the CLI resumes at the first unapplied file.

If a migration was applied **partially** via the SQL Editor without a
transaction, determine what landed before reversing:

```sql
SELECT column_name FROM information_schema.columns
WHERE table_schema='public' AND table_name='<TABLE>' ORDER BY ordinal_position;

SELECT routine_name FROM information_schema.routines
WHERE routine_schema='public' AND routine_name LIKE 'realtoros_%' ORDER BY routine_name;
```

Phase 4H (#20, `20260929150944`) and 4E.4 (#19) are already live; this
deployment applies no migration. **Prefer rolling forward** in every case.

<details>
<summary><strong>Reverse Phase 4H</strong> (notifications only; nothing else depends on them)</summary>

The app's bell then shows nothing (its reads fail quietly). `resend-webhook`
treats a failed hot-reply mark as best-effort, so it keeps working.

```sql
BEGIN;
DROP TRIGGER IF EXISTS notify_on_stop_event ON public.contact_stop_events;
DROP TRIGGER IF EXISTS notify_on_import_batch_insert ON public.lead_import_batches;
DROP TRIGGER IF EXISTS notify_on_import_batch_update ON public.lead_import_batches;
DROP TRIGGER IF EXISTS notify_on_job_failed ON public.automation_jobs;
DROP FUNCTION IF EXISTS public.realtoros_mark_reply_hot(uuid, text, text);
DROP FUNCTION IF EXISTS automation_internal.notify_on_stop_event();
DROP FUNCTION IF EXISTS automation_internal.notify_on_import_batch();
DROP FUNCTION IF EXISTS automation_internal.notify_on_job_failed();
DROP FUNCTION IF EXISTS automation_internal.notify(uuid, text, text, text, text, text, text, jsonb);
DROP FUNCTION IF EXISTS automation_internal.notification_contact_name(uuid, text);
DROP FUNCTION IF EXISTS automation_internal.notification_contact_route(text);
DROP FUNCTION IF EXISTS automation_internal.notification_plain(text, integer);
DROP TABLE IF EXISTS public.notifications;
COMMIT;
```
Then delete the #20 row from `supabase_migrations.schema_migrations` only if
you intend to re-apply it later.

</details>

<details>
<summary><strong>Reverse Phase 4E.4</strong> (clean only while no file has been imported)</summary>

1. Delete the `import-lead-file` function (`supabase functions delete import-lead-file`).
2. From `20260831114425_remove_sample_data_feature.sql`, re-run only the
   `create or replace function public.realtoros_ingest_lead_batch(...)`
   statement and the `revoke` / `grant` lines right after it, to restore the
   original single-function Sheet import (same signature;
   `ingest-sheet-leads` keeps working).
3. Then:
   ```sql
   BEGIN;
   DROP FUNCTION IF EXISTS public.realtoros_ingest_lead_file(uuid, uuid, text, jsonb, boolean);
   DROP FUNCTION IF EXISTS public.realtoros_file_import_quota(uuid);
   DROP FUNCTION IF EXISTS automation_internal.ingest_lead_rows(uuid, uuid, uuid, jsonb, text, boolean, integer, text);
   DROP INDEX IF EXISTS public.lead_import_rows_file_new_contacts_idx;
   DROP INDEX IF EXISTS public.contacts_user_email_norm_idx;
   DROP INDEX IF EXISTS public.contacts_user_phone_norm_idx;
   -- Only if no file upload was ever recorded (otherwise the NOT NULL fails):
   DELETE FROM public.lead_import_batches WHERE source_type = 'file_upload';
   ALTER TABLE public.lead_import_rows DROP CONSTRAINT IF EXISTS lead_import_rows_source_shape_check,
     DROP CONSTRAINT IF EXISTS lead_import_rows_source_type_check, DROP COLUMN IF EXISTS source_type;
   ALTER TABLE public.lead_import_batches DROP CONSTRAINT IF EXISTS lead_import_batches_source_shape_check,
     DROP CONSTRAINT IF EXISTS lead_import_batches_source_type_check;
   DROP INDEX IF EXISTS public.lead_import_batches_file_import_idx;
   DROP INDEX IF EXISTS public.lead_import_batches_source_created_idx;
   ALTER TABLE public.lead_import_batches DROP COLUMN IF EXISTS source_type, DROP COLUMN IF EXISTS file_name;
   ALTER TABLE public.lead_import_batches ALTER COLUMN connection_id SET NOT NULL;
   ALTER TABLE public.lead_import_rows ALTER COLUMN connection_id SET NOT NULL;
   COMMIT;
   ```
   Deleting file-upload batches removes their history rows (cascade) but
   never the contacts they created.
</details>

<details>
<summary><strong>Reverse Phase 4E.3</strong> (clean)</summary>

Re-run the `create or replace function public.realtoros_record_contact_stop_event(...)`
statement from section 4 of `20260929041708_phase_4e_2_stop_logic_completion.sql`,
then its two grant lines for that function (section 8). That restores the
4E.2 body; the signature and grants are the same. Redeploy `resend-webhook`
from a pre-4E.3 commit first — the 4E.3 code records opt-out replies with the
pair that 4E.2 rejects (it would answer 500 and Resend would keep retrying).
No data is lost; unsubscribes already recorded from replies stay recorded.
</details>

<details>
<summary><strong>Reverse Phase 4E.2</strong> (clean while no automation has run)</summary>

```sql
BEGIN;
DROP FUNCTION IF EXISTS public.realtoros_presend_guard(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.realtoros_skip_claimed_job(uuid, uuid, uuid, text);
DROP FUNCTION IF EXISTS public.realtoros_record_contact_stop_event(uuid, text, text, text, text, uuid, timestamptz);
DROP TABLE IF EXISTS public.contact_stop_events;
DROP INDEX IF EXISTS public.outbound_messages_reply_token_idx;
ALTER TABLE public.automation_jobs DROP CONSTRAINT IF EXISTS automation_jobs_skipped_reason_check;
ALTER TABLE public.automation_jobs DROP COLUMN IF EXISTS skipped_reason;
-- Then re-run sections 3, 4, 7 and 8 of
-- 20260904060217_phase_4e_reply_unsubscribe_stop_logic.sql to restore the
-- 4E versions of realtoros_stop_enrollment_on_event,
-- realtoros_record_contact_stop_event and realtoros_rule_stop_summary.
-- Do NOT re-run its section 1: that would restore the broken trigger.
COMMIT;
```
Data loss: the stop-event ledger and skip reasons. Redeploy `resend-webhook`,
`process-automation`, `manage-automation` and `email-unsubscribe` from a
pre-4E.2 commit (or delete `email-unsubscribe`) — the 4E.2 code calls the
dropped functions.
</details>

The reversals below are for the migrations that are **already live**. They
were written for a first deployment; on the live project they would destroy
real data. Treat them as a last resort.

<details>
<summary><strong>Reverse Phase 4E</strong> (clean; reverse 4E.2 first)</summary>

```sql
BEGIN;
DROP TRIGGER IF EXISTS contacts_protect_lifecycle_columns_trigger ON public.contacts;
DROP FUNCTION IF EXISTS automation_internal.protect_contact_lifecycle_columns();
DROP FUNCTION IF EXISTS public.realtoros_stop_enrollment_on_event(uuid, uuid, text, text, timestamptz);
DROP FUNCTION IF EXISTS public.realtoros_record_contact_stop_event(uuid, text, text, timestamptz);
DROP FUNCTION IF EXISTS public.realtoros_record_contact_stop_event(uuid, text, text, text, text, uuid, timestamptz);
DROP FUNCTION IF EXISTS public.realtoros_check_enrollment_eligibility(uuid, text, uuid);
DROP FUNCTION IF EXISTS public.realtoros_open_enrollments_for_contact(uuid, text);
DROP FUNCTION IF EXISTS public.realtoros_rule_stop_summary(uuid, uuid, integer);
DROP INDEX IF EXISTS public.contacts_lifecycle_stop_idx;
ALTER TABLE public.automation_jobs DROP COLUMN IF EXISTS cancelled_at,
                                   DROP COLUMN IF EXISTS cancelled_reason;
ALTER TABLE public.contacts DROP COLUMN IF EXISTS reply_detected_at,
                            DROP COLUMN IF EXISTS unsubscribe_detected_at;
COMMIT;
```
Data loss: only the lifecycle markers and cancellation reasons. Enrollment
`stop_reason` and `stopped_at` are Phase 4B columns and survive.

**You must also redeploy** `resend-webhook`, `process-automation` and
`manage-automation` from a pre-4E commit — the deployed code calls these RPCs
and will start failing as soon as they are dropped.
</details>

<details>
<summary><strong>Reverse Phase 4D reliability</strong> (hard)</summary>

This migration **replaced** ten of migration 3's functions in place. Dropping
them removes migration 3's versions too. To reverse:

1. Re-apply the function definitions from
   `20260904021204_phase_4d_automation_execution.sql` (they are all
   `CREATE OR REPLACE`, so re-running just that file's function section restores
   the earlier bodies).
2. Then:
   ```sql
   BEGIN;
   DROP FUNCTION IF EXISTS public.realtoros_complete_trigger_event(uuid, uuid, uuid);
   DROP FUNCTION IF EXISTS public.realtoros_reschedule_trigger_event(uuid, uuid, uuid, timestamptz);
   DROP FUNCTION IF EXISTS public.realtoros_fail_trigger_event(uuid, uuid, uuid, text);
   DROP FUNCTION IF EXISTS public.realtoros_cancel_claimed_job(uuid, uuid, uuid);
   DROP FUNCTION IF EXISTS public.realtoros_archive_rule(uuid, uuid);
   ALTER TABLE public.automation_jobs DROP COLUMN IF EXISTS manual_retry_count;
   ALTER TABLE public.outbound_messages DROP COLUMN IF EXISTS first_provider_attempt_at;
   ALTER TABLE public.outbound_messages DROP CONSTRAINT outbound_messages_status_check;
   ALTER TABLE public.outbound_messages ADD CONSTRAINT outbound_messages_status_check
     CHECK (status IN ('queued','sent','delivered','delivery_delayed','opened','clicked',
                       'replied','bounced','complained','suppressed','failed','unsubscribed'));
   COMMIT;
   ```
   The constraint rebuild fails if any row is already `unconfirmed`. Resolve
   those rows first.

**Strongly prefer rolling forward.** Reversing this migration reintroduces the
bugs it fixed (the job-claim Cartesian product in particular).
</details>

<details>
<summary><strong>Reverse Phase 4D execution</strong> (invasive)</summary>

```sql
BEGIN;
DROP TRIGGER IF EXISTS contacts_automation_created_trigger ON public.contacts;
DROP TRIGGER IF EXISTS contacts_automation_status_changed_trigger ON public.contacts;
DROP FUNCTION IF EXISTS automation_internal.contact_created_event();
DROP FUNCTION IF EXISTS automation_internal.contact_status_changed_event();
-- Drop each realtoros_* function this migration created (see its GRANT block
-- for the exact names and signatures).
DROP TABLE IF EXISTS public.automation_trigger_events;
ALTER TABLE public.automation_rules DROP COLUMN IF EXISTS runtime_version,
  DROP COLUMN IF EXISTS runtime_snapshot, DROP COLUMN IF EXISTS activated_at,
  DROP COLUMN IF EXISTS paused_at, DROP COLUMN IF EXISTS archived_at;
ALTER TABLE public.automation_jobs DROP COLUMN IF EXISTS lock_token,
  DROP COLUMN IF EXISTS next_retry_at, DROP COLUMN IF EXISTS failure_category,
  DROP COLUMN IF EXISTS retriable;
ALTER TABLE public.automation_enrollments DROP COLUMN IF EXISTS trigger_event_id,
  DROP COLUMN IF EXISTS trigger_event_key, DROP COLUMN IF EXISTS runtime_version,
  DROP COLUMN IF EXISTS paused_at;
COMMIT;
```
Drops the entire trigger-event outbox and every queued event. Only do this if
no rule has ever been activated.
</details>

<details>
<summary><strong>Reverse Phase 4C</strong> (clean if nothing sent)</summary>

```sql
BEGIN;
DROP FUNCTION IF EXISTS public.realtoros_claim_test_send(uuid, uuid);
ALTER TABLE public.outbound_messages DROP COLUMN IF EXISTS send_attempt_token,
  DROP COLUMN IF EXISTS send_attempt_started_at, DROP COLUMN IF EXISTS send_attempt_count;
DROP TABLE IF EXISTS public.email_suppressions;
DROP TABLE IF EXISTS public.email_sender_profiles;
DROP INDEX IF EXISTS public.outbound_messages_user_idempotency_idx;
ALTER TABLE public.outbound_messages
  DROP COLUMN IF EXISTS message_kind, DROP COLUMN IF EXISTS idempotency_key,
  DROP COLUMN IF EXISTS sender_display_name, DROP COLUMN IF EXISTS sender_address,
  DROP COLUMN IF EXISTS reply_to_email, DROP COLUMN IF EXISTS delivery_delayed_at,
  DROP COLUMN IF EXISTS bounced_at, DROP COLUMN IF EXISTS complained_at,
  DROP COLUMN IF EXISTS suppressed_at, DROP COLUMN IF EXISTS unsubscribed_at;
COMMIT;
```
Dropping `email_suppressions` **destroys the record of who must not be emailed**.
Export it first if anything has ever been sent:
```sql
SELECT * FROM public.email_suppressions;
```
Restoring `outbound_messages.contact_id` to `NOT NULL` requires that no test-send
row (which has a null `contact_id`) remains.
</details>

### Failed function deployment

No previous version exists for the 4C/4D/4E/4E.2 functions, so removal is clean:

```bash
supabase functions delete <FUNCTION_NAME> --project-ref <PROJECT_REF>
```

Delete `process-automation` only after unscheduling the cron job, or every run
will error.

### Bad secret

```bash
supabase secrets set <NAME>=<CORRECT_VALUE> --project-ref <PROJECT_REF>
supabase functions deploy <FUNCTION_NAME> --project-ref <PROJECT_REF>   # force pickup
```

If you changed `AUTOMATION_WORKER_SECRET`, update the cron job too — unschedule,
rotate, reschedule.

### Cron issues

```sql
SELECT cron.unschedule('process-automation-worker');   -- stop
-- fix, then re-run the schedule command from setup-cron.sql
```

### Resend issues

Disable or delete the webhook endpoint in the Resend dashboard. Events stop
arriving; nothing in the database is affected. Re-enabling resumes delivery, and
Resend retries recent failed deliveries.

To stop all sending immediately without touching Resend, unschedule the cron job.

---

## Appendix — Quick reference

```bash
# All 20 migrations are already live. Deploy all Phase 4 functions
# (after secrets are set).
for f in manage-automation send-test-email email-unsubscribe \
         resend-webhook process-automation import-lead-file; do
  supabase functions deploy "$f" --project-ref <PROJECT_REF>
done

# Status
supabase functions list --project-ref <PROJECT_REF>
supabase secrets list --project-ref <PROJECT_REF>
supabase migration list --project-ref <PROJECT_REF>
```

```sql
-- Emergency stop
SELECT cron.unschedule('process-automation-worker');

-- Is the worker firing?
SELECT status, start_time FROM cron.job_run_details
WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname='process-automation-worker')
ORDER BY start_time DESC LIMIT 5;

-- What is the automation engine doing?
SELECT status, count(*) FROM public.automation_jobs GROUP BY status;
SELECT status, count(*) FROM public.automation_enrollments GROUP BY status;
SELECT status, count(*) FROM public.automation_trigger_events GROUP BY status;

-- Anything failing?
SELECT category, error_code, count(*) FROM public.automation_failures
WHERE NOT resolved GROUP BY 1,2 ORDER BY 3 DESC;
```
