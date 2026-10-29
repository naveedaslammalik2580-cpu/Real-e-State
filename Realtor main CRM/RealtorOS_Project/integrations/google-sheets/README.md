# RealtorOS — Google Sheets Connector

This package lets a realtor keep leads in a Google Sheet and push them into
RealtorOS through the existing `ingest-sheet-leads` Edge Function. It is a
Google Apps Script bound to the spreadsheet — nothing in this folder runs on
its own; you paste it into the sheet's script project.

It does **not** scrape, enrich, or invent lead data. It only trims, cases,
and re-shapes whatever is already pasted into the **Raw Leads** tab.

---

## Final workflow

1. The connection owner pastes or replaces leads in **Raw Leads**.
2. Manual **Sync Now** and the 15-minute installable trigger both
   automatically rebuild **Ready** from Raw Leads first — every time, before
   sending anything.
3. **Ready is fully script-managed and must not be edited by hand.** Any
   manual edit to Ready — including an attempt to "fix" a row the backend
   rejected — is simply overwritten the next time Ready is rebuilt.
4. Only changed content is batched and synced: the freshly rebuilt Ready
   content is fingerprinted, and that fingerprint (its "revision") is what
   actually gets compared and sent.
5. Unchanged content that was already successfully synced makes **zero**
   HTTP requests on the next run.
6. **All corrections belong in Raw Leads** — including corrections to rows
   the backend rejected. Ready has nothing of its own to correct.
7. The next run rebuilds Ready from the corrected Raw Leads and sends the
   changed revision.

## 1. Extensions → Apps Script

1. Open the Google Sheet you want to use for lead intake.
2. Menu bar → **Extensions → Apps Script**. This opens a script project
   bound to that spreadsheet (its Document/User Properties, triggers, and
   `SpreadsheetApp` calls are all scoped to this one file).

## 2. Adding `Code.gs` and `appsscript.json`

1. In the Apps Script editor, delete any placeholder `Code.gs` content.
2. Copy the contents of this folder's [`Code.gs`](./Code.gs) into the
   editor's `Code.gs` file.
3. Show manifest file: **Project Settings (gear icon) → check "Show
   `appsscript.json` manifest file in editor"**.
4. Open `appsscript.json` in the editor and replace its contents with this
   folder's [`appsscript.json`](./appsscript.json).
5. Save the project (**Ctrl/Cmd+S**).

## 3. Authorizing the script

1. Reload the spreadsheet. A new **RealtorOS** menu appears next to
   **Help** after a few seconds.
2. Click any RealtorOS menu item (e.g. **Connection Status**). Google will
   prompt you to authorize the script.
3. Choose your Google account, click **Advanced → Go to (project) (unsafe)**
   if you see the "unverified app" screen (this is expected for a script
   you pasted in yourself — it has not been submitted for Google's
   verification review), then **Allow**.
4. Each Google account that wants to run Sync Now or install the trigger
   needs to authorize once for this spreadsheet — authorization, tokens,
   and the trigger are all per-Google-account, not shared automatically
   between editors (see [§9](#9-connector-token-and-property-security) and
   [§7](#7-installingremoving-the-trigger)).

See [§8](#8-required-oauth-scopes) for exactly what permissions are
requested and why.

## 4. Setup Connection

1. In RealtorOS (the web app), create or open the sheet connection for this
   spreadsheet. That step returns:
   - the ingest URL, which is always exactly:
     ```
     https://yanasorwmaybnabfuepn.supabase.co/functions/v1/ingest-sheet-leads
     ```
   - a **connector token** (`ros_…`), shown only once
2. Back in the spreadsheet: **RealtorOS → Setup Connection**.
3. Paste the ingest URL, then the connector token, then confirm (or change)
   the Raw and Ready tab names.
4. **The ingest URL is validated exactly** — only the URL above (an
   optional single trailing slash is tolerated and normalized away) is
   accepted. Any other host, path, port, query string, fragment, or
   embedded credentials is rejected outright, with nothing saved.
5. **The connector token is validated exactly** against `ros_` followed by
   40–100 letters/digits/`_`/`-`. An invalid token is rejected outright —
   there is no "save anyway" option, and an invalid token is never stored.
6. The connector token is saved to **your own Google account's** User
   Properties for this script — not the document's shared properties, and
   not visible to other editors. The ingest URL and tab names are saved to
   the spreadsheet's (shared, non-secret) Document Properties. See
   [§9](#9-connector-token-and-property-security) for exactly what that
   does and doesn't guarantee.
7. Running Setup Connection also clears your account's remembered
   "last successfully synced revision." This is intentional: after a token
   rotation, a different connection, or a tab rename, the old remembered
   revision could otherwise cause the very next sync to be incorrectly
   skipped as "unchanged."
8. Re-run **Setup Connection** at any time to update the URL, rotate your
   token, or rename tabs. Each editor who wants to sync runs this
   separately, with their own token.

## 5. Preparing Ready

Ready is **fully automatic** — you do not need to run this manually before
syncing. **RealtorOS → Sync Now** and the installable trigger always rebuild
Ready from Raw Leads themselves first, every time.

**RealtorOS → Prepare Ready Leads (preview)** runs the exact same
normalization on demand, purely so you can inspect Ready without triggering
a network sync. It is optional.

Normalization:

- Strings are trimmed; email is lower-cased.
- Phone numbers are kept in their original, readable form for display, but
  compared/deduplicated by digits only.
- Column headers are recognized case-insensitively, including common
  variants: `Name`/`Full Name`, `Email`/`Email Address`, `Mobile`/`Phone
  Number`, `Lead Source`, `Budget`, `Area`, `Notes`, plus `Type`, `Status`,
  `Temperature`, and `Lead ID`/`ID`.
- Unrecognized columns are ignored (not copied into Ready).
- If `Type`/`Status`/`Source`/`Temperature` are blank or absent, the same
  defaults the backend itself applies are used: `Buyer` / `New Lead` /
  `Google Sheets` / `Warm`.

**Lead ID stability:** if the Raw sheet has its own `Lead ID`/`ID` column,
that value is preserved verbatim. Otherwise an ID is derived deterministically
from the normalized email (or phone, or name, in that priority order) using a
SHA-256 fingerprint. Rebuilding Ready on unchanged raw data always reproduces
the same `lead_id` — no separate mapping file is needed, and it lines up with
how the backend deduplicates contacts by email/phone.

**Validity (rows that do *not* make it into Ready):**

- Missing **both** email and phone → invalid (no contact channel).
- Missing full name → invalid, *unless* a safe name can be derived from a
  non-empty email prefix (e.g. `jane.doe@example.com` → `Jane Doe`).
- Invalid raw rows are skipped when rebuilding Ready; the confirmation
  dialog (when run via the preview menu item) reports how many were
  skipped and why. **Raw Leads is never modified** — the realtor's pasted
  values are only ever read, never edited or deleted.
- **Every correction — including correcting a row the backend later
  rejects — must be made in Raw Leads.** Ready is rebuilt from scratch on
  every sync, so editing Ready directly accomplishes nothing.

## 6. Sync Now

**RealtorOS → Sync Now**:

1. Rebuilds **Ready** from **Raw Leads**, exactly as §5 describes.
2. Computes a deterministic revision (a SHA-256 fingerprint) of the
   freshly rebuilt Ready content.
3. **If that revision matches your account's last successfully synced
   revision, the sync stops here — zero HTTP requests are made, and an
   accurate "nothing to sync" result is shown.** This also applies to a
   genuinely empty Ready tab: an empty Raw Leads (or one where every row
   was invalid) is a valid, trivially successful outcome, handled without
   any HTTP call, and remembered so a later run on a still-empty sheet
   also skips cleanly.
4. Otherwise, splits the rows into batches honoring **both** backend
   limits — at most 500 rows per request, and a conservative 900,000-byte
   ceiling on the complete UTF-8 JSON request body (the backend's own hard
   limit is 1,000,000 bytes; see [§ Batching, retries, and
   idempotency](#batching-retries-and-idempotency)).
5. POSTs each batch to the exact pinned ingest URL (see
   [§ Request schema](#request-schema) below), never following a redirect.
6. **Validates every 2xx response against the full expected shape** —
   not just the HTTP status. A `2xx` with a missing field, a wrong type, an
   inconsistent count, or an unrecognized `status` (e.g. `"processing"`) is
   treated as a **failed** batch, not a success, and is never retried the
   way a `429`/`5xx` would be.
7. Shows a dialog with **imported / duplicate / rejected** counts, and, if
   any batch could not be submitted (or returned a malformed response),
   which batches failed and why.
8. **Never reports success for a batch whose response was unsuccessful or
   malformed**, and only remembers this revision as successfully synced
   once **every** batch in it has a fully validated successful response.
   If any batch fails, the whole revision is retried in full on the next
   sync — never partially skipped.
9. Rejected rows are **not** a Ready-tab problem: correct the underlying
   values in **Raw Leads**, not Ready. The next sync rebuilds Ready and
   resends the changed revision.

> **Note:** the backend returns only aggregate counts per batch, not a
> per-row reason. If `rejected` is greater than zero, cross-check the
> affected leads' email/phone against existing RealtorOS contacts — the
> most common cause is one lead's email and another's phone already
> pointing at two different contacts (an "identity conflict").

## 7. Installing/removing the trigger

- **Installable triggers run as their creator.** The Google account that
  installs the 15-minute trigger is the account whose connector token and
  synced-revision bookkeeping are used every time it fires — so **the
  RealtorOS connection owner must be the one who configures the token and
  installs the trigger.**
- `ScriptApp.getProjectTriggers()` — which both **Install 15-Minute
  Trigger** and **Remove Sync Trigger** use — **only ever exposes triggers
  the current Google user created.** It cannot see, list, or remove a
  trigger a different editor installed under their own account. This menu
  never claims (and cannot guarantee) that exactly one RealtorOS trigger
  exists globally on this spreadsheet — only that at most one exists **per
  Google account that has ever installed one here.**
- **Other editors of this spreadsheet must not install their own
  additional RealtorOS trigger.** If they do, both triggers fire
  independently, each syncing under its own installer's token and
  bookkeeping, and neither this menu nor Connection Status can see the
  other's.
- **RealtorOS → Install 15-Minute Trigger** first removes any trigger
  *your own account* had previously installed, then installs a fresh one
  that calls the same sync routine as Sync Now, roughly every 15 minutes.
- **RealtorOS → Remove Sync Trigger** removes only the trigger(s) your own
  account can see. Manual **Sync Now** keeps working either way.
- The trigger runs the full network sync, so it is deliberately **not** a
  simple `onEdit` trigger (which cannot make external HTTP requests and
  would fire far too often while a realtor is actively typing).
- Both the manual and triggered sync paths take the same script-wide
  `LockService` lock before touching the network, so a manual sync and a
  scheduled run (from the same script project) can never execute
  concurrently.

## 8. Required OAuth scopes

Declared in `appsscript.json`:

| Scope | Why |
|---|---|
| `spreadsheets.currentonly` | Read Raw Leads, read/write Ready — limited to this bound spreadsheet only, not your whole Drive. |
| `script.external_request` | `UrlFetchApp` calls to the RealtorOS ingest URL. |
| `script.scriptapp` | Create/remove the installable time-based sync trigger. |

`PropertiesService` and the custom menu/dialogs do not require any
additional OAuth scope beyond the above. No Gmail, Drive (broad), or
Contacts scope is requested.

## 9. Connector-token and property security

- The full connector token is written **only** to
  `PropertiesService.getUserProperties()` — scoped to the individual
  Google account that ran Setup Connection. It is **not** shared with
  other editors of the spreadsheet, and is **not** written to a sheet
  cell, so it can't leak through reading, sharing, or exporting the
  visible sheet contents.
- It is **not** intentionally passed to `Logger.log()` or `console.log()`
  anywhere in `Code.gs`. Only a short, non-secret prefix (derived from your
  own account's own saved token, never another editor's) is ever
  displayed, in **Connection Status**.
- **`PropertiesService` is ordinary per-project storage, not a vault and
  not a guaranteed secret store.** It is not encrypted-at-rest in a way
  this script controls or can promise, and it is scoped to the Apps
  Script project, not to a person independent of that project. Treat it
  as "not visible in a cell and not shown to other editors by this
  script's own UI," not as "cryptographically secret no matter who has
  access to this file."
- **A bound Apps Script project inherits the spreadsheet's own
  collaboration/access context.** Anyone you grant edit access to the
  spreadsheet can generally also open and edit the bound script project
  (and, depending on how you shared it, potentially run functions with
  their own authorization). **Do not share this spreadsheet or its bound
  script with editors you don't trust with RealtorOS sync access.**
- This document makes **no guarantee** about what happens to script
  properties if the spreadsheet is copied, exported, or its script project
  is duplicated — Google's own copy/export behavior for bound scripts and
  their properties is outside this script's control, and you should not
  assume properties do or don't carry over without checking directly.
- **Rotate the connector token immediately from RealtorOS** if you suspect
  it may have been exposed (e.g., you shared the script project, not just
  the sheet, with someone you no longer trust). Re-run **Setup Connection**
  afterward with the new token.

## 10. Troubleshooting

| Status | Meaning | What to do |
|---|---|---|
| **401** `invalid_connector_credentials` | Token missing/wrong, rotated in RealtorOS since Setup Connection ran, **or the connection is no longer `active`** (e.g. disabled/deleted from RealtorOS) — the Edge Function returns this same `401` for both a bad token and an inactive connection; it does not return an HTTP `403` for this. | Re-run **Setup Connection** with the current token from RealtorOS, or re-enable the connection in RealtorOS first. |
| **401** `stale_or_invalid_timestamp` | The Sheet's clock/script clock skew exceeds 5 minutes vs. the server, or a retried request is unusually delayed. | Usually transient — **Sync Now** again. Persistent skew is very rare for Apps Script, which uses server time. |
| **409** | Not returned by this endpoint directly; a duplicate `source_event_id` instead **replays** the original batch's stored result. Because `source_event_id` is now derived deterministically from the spreadsheet id, the sheet revision, and the batch index, re-running the *same* unsent revision reliably replays rather than double-importing — this is expected and safe, not an error. | No action needed. |
| **413** `request_too_large` | The complete JSON request body exceeded the backend's 1,000,000-byte hard limit. This script's own 900,000-byte batching ceiling is meant to prevent this from ever happening — seeing it live suggests the local ceiling was bypassed (e.g. a modified `Code.gs`). | Confirm `Code.gs` matches this repository; report as a bug if it still occurs unmodified. |
| Local error: row too large to submit alone | Detected **before any HTTP request is made** — one Ready row's JSON, even entirely on its own, would exceed the script's 900,000-byte local safety ceiling. `Notes` is almost always the cause. | Shorten the flagged row's values (especially Notes) in **Raw Leads**, then run **Sync Now** again. |
| Malformed/inconsistent `2xx` response | The HTTP status was in the `200`–`299` range, but the body wasn't valid JSON, was missing an expected field, had a count of the wrong type, had counts that don't add up, or reported a non-terminal `status` (e.g. `"processing"`). Treated as a **failed batch**, never as success, and never retried as if it were a `429`/`5xx`. | Usually indicates a backend deployment issue or an incompatible API change. Check RealtorOS/Supabase status; report as a bug if it persists. |
| **422** `rows_must_contain_1_to_500_items` / `batch_validation_failed` | A batch somehow had 0 or more than 500 rows (shouldn't happen — this script batches at exactly 500 or fewer). | Report as a bug; check for a modified `Code.gs`. |
| **422** `invalid_source_event_id` / `invalid_nonce` | Internal — should not occur from this script (both are generated to satisfy the backend's UUID format automatically). | Report as a bug if it appears; check for a modified `Code.gs`. |
| **429** `rate_limit_exceeded` | More than 30 batches submitted for this connection in the last minute. | The script already retries this automatically (up to 3 attempts with backoff); if it still fails, wait a minute and run **Sync Now** again. |
| **5xx** | Transient RealtorOS/Supabase-side error. | The script retries automatically (up to 3 attempts); if it still fails, wait and retry, or check RealtorOS status. |
| "Sync busy" / lock not acquired | Another sync (manual or triggered) is already running from this script project. | Wait a few seconds and try **Sync Now** again. |
| "Ready tab has an unexpected header row" | Ready's header was edited by hand or is out of date. | Run **Sync Now** (or **Prepare Ready Leads (preview)**) — Ready is fully script-managed and safe to regenerate; nothing needs fixing in Ready itself. |

Nothing in this troubleshooting flow ever requires viewing or sharing your
full connector token — if support needs to confirm which token is
configured for your account, share only the short prefix shown in
**Connection Status**.

---

## Request schema

```
POST https://yanasorwmaybnabfuepn.supabase.co/functions/v1/ingest-sheet-leads
Authorization: Bearer <connector token>
Content-Type: application/json
X-RealtorOS-Timestamp: <current Unix time, seconds>
X-RealtorOS-Nonce: <new UUID, one per HTTP attempt>

{
  "source_event_id": "<deterministic UUID for this spreadsheet + revision + batch index>",
  "sheet_revision": "<SHA-256 fingerprint of the Ready rows being sent>",
  "rows": [
    {
      "lead_id": "...", "full_name": "...", "email": "...", "phone": "...",
      "type": "...", "status": "...", "source": "...", "temperature": "...",
      "budget": "...", "preferred_area": "...", "notes": "..."
    }
  ]
}
```

The ingest URL above is the **only** endpoint this script will ever send a
request to — it is validated exactly (host, path, and scheme), not merely
checked for an `https://` prefix, and neither Setup Connection nor any
runtime code will accept or send to anything else.

## Batching, retries, and idempotency

- **Two limits are honored together:** at most 500 rows per request, and a
  conservative 900,000-byte ceiling on the complete UTF-8-encoded JSON
  request body (`source_event_id` + `sheet_revision` + `rows`, including
  all JSON punctuation/escaping) — measured in actual UTF-8 bytes, not
  JavaScript string length, since multibyte characters (e.g. emoji, most
  non-Latin scripts) take more UTF-8 bytes than string length would
  suggest. The backend's own hard limit is 1,000,000 bytes; 900,000 leaves
  headroom.
- If a single Ready row cannot fit under the 900,000-byte ceiling even
  entirely on its own, **no HTTP request is made for that revision at
  all** — the script stops locally with a clear error naming the
  oversized row, before any network call.
- **`source_event_id` is deterministic, not random.** Each batch's id is
  derived from the spreadsheet's id, the sheet's current revision
  fingerprint, and that batch's index — the same inputs always produce the
  same id. This means re-running the *same* unsent revision (e.g. after a
  transient failure, or the next scheduled trigger firing before anything
  changed) reproduces identical `source_event_id`s and safely **replays**
  on the backend rather than double-importing, even across separate
  manual/scheduled executions — not just retries within one execution.
- Only HTTP `429` and `5xx` responses (and requests that fail to get any
  HTTP response at all) are retried — up to 3 attempts per batch, with
  exponential backoff (2s, then 4s).
- `400`, `401`, `403`, and `422` are never retried.
- **A `2xx` response with a malformed or internally inconsistent body is
  treated as a failed batch, never retried as if it were a `429`/`5xx`,
  and never advances the "successfully synced" bookkeeping.**
- The same deterministic `source_event_id` is reused across every retry
  attempt of one batch; a fresh `X-RealtorOS-Nonce` and
  `X-RealtorOS-Timestamp` are generated on every individual HTTP attempt,
  including retries.
- A revision is only remembered as "successfully synced" once **every**
  batch belonging to it has returned a fully validated successful
  response — never after a partial run. An unchanged, already-synced
  revision is detected before any batches are built, making zero HTTP
  requests.
- Redirects are never followed (`followRedirects: false`) — a redirect is
  never treated as success, and the connector token is never resent to
  wherever the redirect points.
- Request headers and full lead payloads are never logged — only
  aggregate counts and error codes.
