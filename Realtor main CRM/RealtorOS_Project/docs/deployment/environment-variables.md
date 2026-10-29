# RealtorOS — Environment Variable Reference

Complete inventory of every environment variable read by any Edge Function,
produced by searching the actual source:

```bash
grep -rn "Deno.env.get" supabase/functions/ --include='*.ts'
```

Fifteen distinct names are read. Five are supplied automatically by the Supabase
platform; **five must be set manually**; five are optional (two settings, plus
the three Phase 3B push keys, which are optional only in the sense that push
simply does not happen without them).

---

## 1. Secrets you must set manually

| Variable | Used by | Required when | How to obtain |
|---|---|---|---|
| `RESEND_API_KEY` | `send-test-email`, `process-automation`, `resend-webhook` (inbound replies only), **and `manage-automation`** | Before any email can be sent, and before any rule can be activated | Resend Dashboard → API Keys → Create API Key. **Sending access** is enough unless inbound replies are enabled; then the key must also be able to read received emails (`GET /emails/receiving/{id}`). |
| `RESEND_SENDING_DOMAIN` | `send-test-email`, `process-automation`, **and `manage-automation`** | Same as above | The bare domain you verified in Resend, e.g. `mail.example.com`. No scheme, no trailing dot, no `@`. |
| `RESEND_WEBHOOK_SECRET` | `resend-webhook`, **and `manage-automation`** | Before delivery/bounce/complaint/reply events can be processed, and before any rule can be activated | Resend Dashboard → Webhooks → your endpoint → Signing Secret. Starts with `whsec_`. |
| `AUTOMATION_WORKER_SECRET` | `process-automation`, **and `manage-automation`** | Before the cron worker can run, and before any rule can be activated | You generate it: `openssl rand -base64 32` |
| `UNSUBSCRIBE_SIGNING_SECRET` | `process-automation`, `email-unsubscribe`, **and `manage-automation`** | Before any automated email can be sent, and before any rule can be activated | You generate it: `openssl rand -base64 48`. At least 32 characters. |

## 1b. Optional settings

| Variable | Used by | Effect when set | Effect when not set |
|---|---|---|---|
| `UNSUBSCRIBE_PAGE_URL` | `process-automation` | The visible footer link points at this page (the static `app/unsubscribe.html`, wherever the frontend is hosted) with the token in the `#` fragment. Must be `https://…` with no `?` or `#`. | The footer link points at the `email-unsubscribe` function itself. Its confirmation page only renders on a **custom functions domain**; Supabase's default domain serves HTML as plain text. |
| `INBOUND_REPLY_DOMAIN` | `process-automation`, `resend-webhook` | Automated emails get a second Reply-To address `r-<token>@<domain>`, and inbound `email.received` events are matched and recorded as replies. | No automatic reply detection. Replies still reach the agent's own address; the owner can use **Mark as replied**. |

## 1c. Web push (Phase 3B)

All three, or none. The worker reads them together: if any one is missing or
the subject is not a `mailto:`/`https:` URI, the push step is skipped silently
on every run and notifications stay in the app only. That is the intended
pre-go-live state — nothing logs an error and nothing retries.

| Variable | Used by | Required when | How to obtain |
|---|---|---|---|
| `VAPID_PUBLIC_KEY` | `process-automation` | Before any phone notification can be sent | `node tools/make-vapid-keys.mjs`. **Also goes in `app/assets/js/config.js` as `vapidPublicKey`** — it is public by definition and the browser needs it to subscribe. |
| `VAPID_PRIVATE_KEY` | `process-automation` | Same | Printed by the same command. A server secret: never in `config.js`, never in the repo, never in a browser. |
| `VAPID_SUBJECT` | `process-automation` | Same | You choose it: `mailto:you@yourdomain.com`. Push services use it to contact you about your traffic; an address that does not reach anybody is worse than useless. |

Three things have to line up for a notification to arrive, and all three are
easy to forget:

1. the three secrets above, set on the project;
2. the **same** public key in `app/assets/js/config.js` — a browser that
   subscribed with one key cannot be pushed to with another, and the push
   service answers `403`;
3. the app served over https (or localhost), because a service worker is
   required and nothing else may register one.

While `vapidPublicKey` is empty in `config.js`, Settings → Notifications says
"Phone notifications switch on when RealtorOS goes live." and never asks for
the browser permission. That is deliberate: asking and then failing can cost
the permission permanently, with no way back except the browser's own site
settings.

**Rotating these unsubscribes every device.** A subscription is bound to the
public key it was created with, so after a rotation every browser must
subscribe again and old endpoints start returning `403`. Generate once.

The `List-Unsubscribe` header always points at the function (`…/functions/v1/email-unsubscribe?t=…`); one-click unsubscribe from mail apps needs no HTML, so it works on any domain.

### Why `manage-automation` needs all five

This is easy to miss and **will block rule activation** if you skip it.

`manage-automation` declares a `REQUIRED_ENV_VARS` list containing all five
names, and its activation preflight refuses to activate a rule unless every one
of them is present and non-empty:

```
supabase/functions/manage-automation/index.ts
  const REQUIRED_ENV_VARS = [
    "RESEND_API_KEY",
    "RESEND_SENDING_DOMAIN",
    "RESEND_WEBHOOK_SECRET",
    "AUTOMATION_WORKER_SECRET",
    "UNSUBSCRIBE_SIGNING_SECRET",
  ];
```

`manage-automation` never *uses* these values — it only checks that they exist,
as a guard against activating a sequence into an environment that cannot
actually deliver. If any is missing, activation fails with
`provider_not_configured` and the Automation page shows a configuration error.

In Supabase, secrets are set **per project**, not per function, so a single
`supabase secrets set` makes a value visible to every function in the project.

### Setting them

```bash
supabase secrets set RESEND_API_KEY=<VALUE> --project-ref <PROJECT_REF>
supabase secrets set RESEND_SENDING_DOMAIN=<VALUE> --project-ref <PROJECT_REF>
supabase secrets set RESEND_WEBHOOK_SECRET=<VALUE> --project-ref <PROJECT_REF>
supabase secrets set AUTOMATION_WORKER_SECRET=<VALUE> --project-ref <PROJECT_REF>
supabase secrets set UNSUBSCRIBE_SIGNING_SECRET=<VALUE> --project-ref <PROJECT_REF>
# optional
supabase secrets set UNSUBSCRIBE_PAGE_URL=https://<APP_HOST>/unsubscribe.html --project-ref <PROJECT_REF>
supabase secrets set INBOUND_REPLY_DOMAIN=<INBOUND_DOMAIN> --project-ref <PROJECT_REF>
```

Verify (names only — values are never displayed):

```bash
supabase secrets list --project-ref <PROJECT_REF>
```

> **Never** paste a real secret value into a chat message, a commit, a log, a
> screenshot, or any file in this repository. Every document here refers to
> secrets by name only.

> Shell history: a value typed on the command line is written to your shell
> history file. Either prefix the command with a space (if your shell is
> configured with `HIST_IGNORE_SPACE` / `HISTCONTROL=ignorespace`), or clear the
> relevant history entries afterwards.

---

## 2. Variables Supabase provides automatically

These are injected into every Edge Function by the platform. **Do not set them
manually**, and do not put them in `supabase secrets set`.

| Variable | Read by | Notes |
|---|---|---|
| `SUPABASE_URL` | `_shared/runtime.ts`, `create-sheet-connection`, `process-automation` | Project API URL. `runtime.ts` treats it as required and throws if absent. `process-automation` also builds the unsubscribe link from it and refuses to send unless it is `https://`. |
| `SUPABASE_SERVICE_ROLE_KEY` | `_shared/runtime.ts` | Fallback backend key for `createAdminClient()`. |
| `SUPABASE_SECRET_KEYS` | `_shared/runtime.ts` | Newer Supabase key format (a JSON object of named secret keys). **Preferred over** `SUPABASE_SERVICE_ROLE_KEY` when present. |
| `SUPABASE_ANON_KEY` | `_shared/runtime.ts` | Fallback publishable key for `createUserClient()`. |
| `SUPABASE_PUBLISHABLE_KEYS` | `_shared/runtime.ts` | Newer Supabase key format (JSON object of named publishable keys). **Preferred over** `SUPABASE_ANON_KEY` when present. |

### How the key selection works

`_shared/runtime.ts` supports both the legacy single-key format and the newer
named-key JSON format, preferring the newer one:

```
createAdminClient():
  key = namedKey(SUPABASE_SECRET_KEYS) ?? SUPABASE_SERVICE_ROLE_KEY

createUserClient():
  key = namedKey(SUPABASE_PUBLISHABLE_KEYS) ?? SUPABASE_ANON_KEY
```

`namedKey()` parses the JSON and returns the `default` entry if present,
otherwise the first non-empty string value. If parsing fails it returns `null`
and the legacy variable is used.

If **neither** variable in a pair is present, the function throws
`No Supabase backend key is configured.` / `No Supabase publishable key is
configured.` and returns HTTP 500. On a standard Supabase project at least one
of each pair is always injected, so this should not occur.

---

## 3. Per-function requirement matrix

| Function | `RESEND_API_KEY` | `RESEND_SENDING_DOMAIN` | `RESEND_WEBHOOK_SECRET` | `AUTOMATION_WORKER_SECRET` | `UNSUBSCRIBE_SIGNING_SECRET` | Optional | Supabase auto |
|---|:--:|:--:|:--:|:--:|:--:|---|:--:|
| `create-sheet-connection` | — | — | — | — | — | — | yes |
| `ingest-sheet-leads` | — | — | — | — | — | — | yes |
| `send-test-email` | **yes** | **yes** | — | — | — | — | yes |
| `email-unsubscribe` | — | — | — | — | **yes** | — | yes |
| `import-lead-file` | — | — | — | — | — | — | yes |
| `resend-webhook` | inbound replies only | — | **yes** | — | — | `INBOUND_REPLY_DOMAIN` | yes |
| `manage-automation` | presence only | presence only | presence only | presence only | presence only | — | yes |
| `process-automation` | **yes** | **yes** | — | **yes** | **yes** | `UNSUBSCRIBE_PAGE_URL`, `INBOUND_REPLY_DOMAIN` | yes |

"presence only" = the value is never used, only checked for existence during
activation preflight.

---

## 4. Behaviour when a secret is missing

Each function fails closed, in a way that is safe but produces a distinct
symptom. Use this table to diagnose.

| Missing | Symptom |
|---|---|
| `RESEND_API_KEY` or `RESEND_SENDING_DOMAIN` | `process-automation`: the send job is rescheduled as **retriable** with `provider_not_configured` and a 300s backoff — no email is sent and nothing fails permanently. `send-test-email`: returns a provider-not-configured error. With inbound replies on, `resend-webhook` answers **500** to `email.received` (it cannot read the reply), so Resend redelivers later. |
| `RESEND_WEBHOOK_SECRET` | `resend-webhook` returns **HTTP 503 `webhook_not_configured`** and performs **zero** database writes. Resend will retry, so events are not lost. |
| `AUTOMATION_WORKER_SECRET` | `process-automation` returns **HTTP 401 `unauthorized`** for every request, including the cron job. The worker never runs. |
| `UNSUBSCRIBE_SIGNING_SECRET` (or shorter than 32 characters) | `process-automation`: send jobs are rescheduled as **retriable** with `unsubscribe_not_configured` (300s backoff); nothing is sent. `email-unsubscribe`: every link shows the "This unsubscribe link has expired" page. |
| Any of the five required | `manage-automation` refuses to activate any rule: `provider_not_configured` (HTTP 422). |
| Any of `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | `process-automation` skips the push step on every run. Notifications still appear in the app; nothing is queued up and nothing is lost, because rows stay `pending` and go out once the keys are set. No error is logged — this is the normal pre-go-live state. |
| `vapidPublicKey` missing from `config.js` while the secrets are set | The server could push but no browser can subscribe: Settings → Notifications shows the pre-go-live line and nobody ever has a device. |
| `vapidPublicKey` **different** from `VAPID_PUBLIC_KEY` | Subscriptions are created against the wrong key and every push is refused with `403`. The worker counts the failures and, after three attempts, marks each notification `failed`. |

All failures are recoverable simply by setting the secret and, for
`resend-webhook`, letting Resend redeliver.

---

## 5. Rotating a secret

Secrets can be changed at any time; Edge Functions pick up the new value on
their next cold start (redeploy to force it immediately).

| Secret | Rotation procedure |
|---|---|
| `RESEND_API_KEY` | Create a new key in Resend → `supabase secrets set` → verify a test send → revoke the old key in Resend. |
| `RESEND_SENDING_DOMAIN` | Verify the new domain in Resend **first**, then set. Changing this changes every future `From:` address. |
| `RESEND_WEBHOOK_SECRET` | Roll the signing secret in Resend, then set immediately. Events signed with the old secret between the two steps fail verification with HTTP 401 — Resend retries, so set the new value promptly and they recover. |
| `AUTOMATION_WORKER_SECRET` | Set the new value, **then** update the cron job SQL (see `setup-cron.sql`) — it embeds the secret in the request header. |
| `UNSUBSCRIBE_SIGNING_SECRET` | **Avoid unless it leaked.** Every unsubscribe link already sent stops working (it shows "This unsubscribe link has expired"), and reply tokens change for new messages (replies to older emails are no longer matched automatically). If you must rotate, mention the change to recipients through another channel, and handle unsubscribe requests that arrive by reply with **Mark as unsubscribed**. |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | **Avoid unless the private key leaked.** Every device unsubscribes itself in effect: endpoints created against the old key start returning `403`, and each agent has to turn notifications back on per device. If you must, set both secrets and `config.js` in the same deploy, then clear the stale rows: `delete from public.push_subscriptions;` — they cannot be pushed to again. |
| `VAPID_SUBJECT` | Safe to change at any time. It is sent with each push; no subscription depends on it. |
| `INBOUND_REPLY_DOMAIN` | Set up receiving for the new domain first. Replies to emails sent before the change go to the old address; keep it receiving until those conversations end. |

Rotating `AUTOMATION_WORKER_SECRET` requires updating two places. Unschedule the
cron job first, rotate, then reschedule, to avoid a window of failing runs:

```sql
SELECT cron.unschedule('process-automation-worker');
-- rotate the secret, then re-run the schedule command from setup-cron.sql
```
