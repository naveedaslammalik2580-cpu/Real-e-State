# RealtorOS — Pipeline & Commission OS

A cloud-backed CRM and commission tracker for independent real estate
agents — contacts, properties, buyer/seller pipelines, deals, milestones,
tasks, activities, showings, referrals, goals, finances, reports, team,
and a scheduler, all synced live through [Supabase](https://supabase.com).
The active application (`RealtorOS/`) is a **static vanilla HTML/CSS/JS**
app with no build step, bundler, or frontend framework; a small Supabase
Edge Function backend and a Google Sheets/Apps Script connector extend it
with automated lead ingestion.

## Table of Contents

1. [Key Features](#key-features)
2. [Tech Stack](#tech-stack)
3. [Project Structure](#project-structure)
4. [Prerequisites](#prerequisites)
5. [Installation](#installation)
6. [Configuration](#configuration)
7. [Running the Project](#running-the-project)
8. [Testing](#testing)
9. [Usage / API Endpoints](#usage--api-endpoints)
10. [Contributing](#contributing)
11. [License](#license)

---

## Key Features

- **Core CRM/pipeline modules** (each its own page module under
  `RealtorOS/assets/js/pages/`): Contacts, Properties, Buyer pipeline,
  Seller pipeline, Deals, Commission, Activities, Tasks, Calendar,
  Scheduler, Referrals, Goals, Finances, Reports, Team & Team Directory,
  and Settings (custom fields, release notes).
- **Live sync via Supabase**: every create/read/update/delete goes
  directly against a Postgres table or RPC through the Supabase client —
  no business data is ever kept in `localStorage`/`sessionStorage`/IndexedDB
  (the only browser-storage key in the app is a cosmetic onboarding-wizard
  flag).
- **Multi-device realtime updates** via Supabase Realtime, published on
  every core table.
- **Authentication**: email/password, Google OAuth, Facebook OAuth, and
  password reset, all handled by Supabase Auth.
- **Private avatar storage**: a per-user `avatars` Storage bucket, RLS-
  scoped by `auth.uid()`, served back via short-lived signed URLs.
- **Backup import/export** (`assets/js/data/backup.js`) for exporting and
  restoring a full JSON snapshot of a workspace.
- **Row-Level Security everywhere**: all tables are owner-scoped
  (`auth.uid() = user_id`); atomic multi-row writes (e.g. creating a deal
  with its milestones, completing a follow-up) go through `SECURITY
  INVOKER` Postgres RPCs rather than multiple client-side round-trips.
- **Google Sheets lead connector** (`RealtorOS/integrations/google-sheets/`):
  an Apps Script package a realtor installs into their own lead spreadsheet
  to normalize pasted leads and push them into RealtorOS, with batching
  (≤500 rows/request), retry-with-backoff on 429/5xx, and idempotent replay
  via a per-batch `source_event_id`.
- **Secure ingestion backend** (`supabase/functions/`): a token-authenticated,
  replay-safe, rate-limited Edge Function pipeline
  (`create-sheet-connection` + `ingest-sheet-leads`) that atomically
  imports a batch of sheet rows into contacts, deduplicating by
  hashed email/phone identity.
- **Automation/messaging database foundation**: schema for message
  templates, automation rules/steps, enrollments, jobs, runs,
  communication consents, outbound messages, and webhook events already
  exists in the migrations (`add_realtoros_automation_foundation.sql`) as
  groundwork for future lead-automation features — it is not yet wired
  into the frontend UI.

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML5, CSS3, non-module (classic) JavaScript — no framework, no bundler, no TypeScript on the frontend |
| Frontend/Supabase glue | [`@supabase/supabase-js` v2](https://github.com/supabase/supabase-js) loaded from the jsDelivr CDN in `index.html` |
| Backend / Database | [Supabase](https://supabase.com) — Postgres, Auth, Realtime, Storage |
| Backend functions | Supabase Edge Functions, written in TypeScript on the [Deno](https://deno.com) runtime |
| Database migrations | Plain SQL (PL/pgSQL functions/RPCs, RLS policies) under `supabase/migrations/` |
| Automation connector | Google Apps Script (`Code.gs`, `appsscript.json`) — Google's V8 Apps Script runtime |
| Local dev server | Any static file server (e.g. Python's built-in `http.server`) — no build tooling required |

There is no `package.json`/npm dependency tree anywhere in this
repository — the frontend ships with zero third-party JS beyond the one
CDN `<script>` tag above, and the backend has no dependency manager
beyond Deno's own `npm:` specifier imports inside the two Edge Functions.

## Project Structure

```
RealtorOS_Project/
├── RealtorOS/                        — the maintained application (see RealtorOS/docs/README.md)
│   ├── index.html                    — application entry point (loads assets/js/* in a fixed order)
│   ├── assets/
│   │   ├── css/realtoros.css         — all application styles, one file
│   │   ├── js/
│   │   │   ├── config.js             — Supabase URL + publishable key (public, non-secret)
│   │   │   ├── core/                 — shared logic: utils, commission math, customization, permissions, derived calcs
│   │   │   ├── data/                 — Supabase boundary: client init/auth, per-entity CRUD, App.store facade, backup
│   │   │   ├── ui/                   — shared UI building blocks (custom-fields form renderer)
│   │   │   ├── pages/                — one file per route/page (contacts, properties, deals, tasks, team, …)
│   │   │   ├── app.js                — application shell: router, modals, toasts, confirm dialogs, sidebar
│   │   │   └── boot.js               — starts the app once every module above has loaded
│   │   ├── fonts/                    — self-hosted WOFF2 fonts
│   │   └── illustrations/            — auth-screen illustration
│   ├── supabase/
│   │   ├── config.toml               — per-function config (e.g. `verify_jwt`)
│   │   ├── functions/                — Edge Functions (see below)
│   │   └── migrations/               — every applied SQL migration, in order
│   ├── integrations/google-sheets/   — Google Apps Script lead connector (Code.gs, appsscript.json, README.md)
│   ├── docs/                         — README.md, SUPABASE_SETUP.md, TEAM_ACCESS_ARCHITECTURE.md, archive/ (historical reports)
│   ├── reference/                    — pre-split monolithic HTML backups (historical, not loaded by the app)
│   ├── .env.example                  — documents the two public Supabase config values (not read at runtime)
│   └── .gitignore
├── supabase/                         — byte-identical mirror of RealtorOS/supabase/, kept at the repo root
│                                        so the Supabase CLI (which expects `supabase/` at the working directory
│                                        it's run from) can be invoked from the repository root
├── assets/                           — fonts + illustration only; the asset dependency of RealtorOS_Online.html below
├── RealtorOS_Online.html             — historical single-file build (identical to RealtorOS/reference/RealtorOS_Online_PreSplit_Backup.html);
│                                        superseded by RealtorOS/index.html + assets/, kept for reference
└── upload/…html                      — the original offline, localStorage-only build (identical to
                                          RealtorOS/reference/RealtorOS_Offline_Original.html), kept for historical reference only
```

**Edge Functions** (`supabase/functions/`, mirrored at
`RealtorOS/supabase/functions/`):

| Function | Purpose |
|---|---|
| `create-sheet-connection` | Authenticated (Supabase user JWT) endpoint that registers/rotates a Google Sheets connection for the signed-in user and returns a one-time connector token + ingest URL. |
| `ingest-sheet-leads` | Connector-token-authenticated endpoint (no Supabase user session) that atomically imports a batch of normalized lead rows via the `realtoros_ingest_lead_batch` RPC — timestamp/nonce/replay/rate-limit checked. |
| `_shared/runtime.ts` | Shared helpers: Supabase admin/user client factories, JSON response helper, SHA-256 hashing, connector-token generation, UUID validation, bounded JSON body parsing. |

> **Note on duplication:** `supabase/` and `RealtorOS/supabase/` are kept
> in sync intentionally (confirmed byte-identical); likewise the two
> single-file HTML documents above are historical snapshots, not
> alternate live builds. The one application you run and edit day-to-day
> is `RealtorOS/index.html` + `RealtorOS/assets/`.

## Prerequisites

- A modern web browser (the frontend has no build step and runs directly).
- Any way to serve static files over `http://`/`https://` for local
  development — e.g. **Python 3** (`python -m http.server`) or VS Code's
  **Live Server** extension. Opening `index.html` via `file://` will
  **not** work (Supabase Auth's redirect handling needs a real origin).
- A [Supabase](https://supabase.com) project, if you want to point the
  app at your own backend instead of the one already configured in
  `assets/js/config.js`.
- The [Supabase CLI](https://supabase.com/docs/guides/cli) — optional,
  only needed if you plan to apply migrations or deploy the Edge
  Functions yourself.
- [Deno](https://deno.com) — optional, only needed for local Edge
  Function development outside of `supabase functions deploy`.
- A Google account — optional, only needed to use the Google Sheets
  connector in `RealtorOS/integrations/google-sheets/`.
- **Node.js is not required** — there is no `package.json` or npm
  dependency tree anywhere in this repository.

## Installation

```bash
git clone <this-repository-url>
cd RealtorOS_Project
```

There is no dependency install step — the frontend has zero local npm
dependencies (its one third-party library, `supabase-js`, is loaded from
a CDN in `index.html`), and the Edge Functions resolve their one
dependency (`npm:@supabase/supabase-js`) automatically at deploy/run time
via Deno's `npm:` specifier.

## Configuration

| File | Contains | Secret? |
|---|---|---|
| `RealtorOS/assets/js/config.js` | `App.config.url` (Supabase project URL) and `App.config.publishableKey` (Supabase publishable/anon key) — the only two values the frontend needs | No — both are safe to ship to the browser; every table is protected by Row Level Security |
| `RealtorOS/.env.example` | Documents the same two values for reference | No — this file is **never read at runtime**; it exists purely as documentation, since this is a static app with no build-time environment substitution |
| `RealtorOS/supabase/config.toml` | Per-Edge-Function settings, e.g. `verify_jwt = true` for `create-sheet-connection` and `verify_jwt = false` for `ingest-sheet-leads` (which authenticates via its own connector token instead) | No |
| Supabase project secrets (set in the Supabase dashboard, not in this repo) | `SUPABASE_URL`, `SUPABASE_SECRET_KEYS`/`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_PUBLISHABLE_KEYS`/`SUPABASE_ANON_KEY` — read by `_shared/runtime.ts` inside the Edge Functions | **Yes** — the service-role key must never be committed or shipped to a browser |
| Google Apps Script `PropertiesService.getDocumentProperties()` (set via the sheet's **RealtorOS → Setup Connection** menu, not a file in this repo) | `REALTOROS_INGEST_URL`, `REALTOROS_CONNECTOR_TOKEN`, `REALTOROS_READY_TAB`, `REALTOROS_RAW_TAB` | **Yes** (the connector token) — see `RealtorOS/integrations/google-sheets/README.md` §9 |

**Never** put a Supabase service-role/secret key in `config.js`,
`.env.example`, or anywhere else in the frontend — it bypasses Row Level
Security and must only ever live in the Edge Function's server-side
environment.

## Running the Project

**Frontend (dev mode — there is no separate "build" step):**

```bash
cd RealtorOS
python -m http.server 5500
```

Then open `http://localhost:5500/index.html`. (Any other static file
server, e.g. VS Code Live Server, works the same way.)

**Backend — applying migrations** (via the Supabase CLI, from a directory
containing `supabase/`):

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

Migrations under `supabase/migrations/` must be applied **in filename
order** — later ones depend on tables/functions created earlier. See
`RealtorOS/docs/SUPABASE_SETUP.md` for what each migration does.

**Backend — deploying the Edge Functions:**

```bash
supabase functions deploy create-sheet-connection
supabase functions deploy ingest-sheet-leads
```

**Google Sheets connector:** see
`RealtorOS/integrations/google-sheets/README.md` for the full install
walkthrough (Extensions → Apps Script → paste `Code.gs`/`appsscript.json`
→ authorize → Setup Connection).

## Testing

There is no automated test suite (no test framework, test files, or CI
configuration exist in this repository). To validate changes manually:

- **Frontend:** serve `RealtorOS/` locally (see above) and exercise the
  affected page(s) in a browser; check the console for errors. A quick
  syntax sanity check for any JS file can be run with Node:
  ```bash
  node --check RealtorOS/assets/js/pages/<file>.js
  ```
- **Edge Functions:** `deno check` and `deno lint` can be run against
  `RealtorOS/supabase/functions/<name>/index.ts` if Deno is installed
  locally, before deploying.
- **SQL migrations:** review against a Supabase branch/staging project
  before applying to production, per `RealtorOS/docs/SUPABASE_SETUP.md`.

## Usage / API Endpoints

Both Edge Functions live at
`https://<your-project>.supabase.co/functions/v1/<function-name>` and
accept `POST` only.

### `POST /functions/v1/create-sheet-connection`

Requires a Supabase user session (`Authorization: Bearer <user JWT>`).
Registers (or rotates the token for) a Google Sheets connection.

```json
// Request body
{
  "name": "My Sheet",
  "spreadsheet_url": "https://docs.google.com/spreadsheets/d/…",
  "raw_tab_name": "Raw Leads",
  "ready_tab_name": "Ready",
  "sync_mode": "push",
  "sync_interval_minutes": 15
}
```

```json
// Response
{
  "connection_id": "…",
  "connector_token": "ros_…",
  "connector_token_prefix": "ros_abc12345",
  "ingest_url": "https://<project>.supabase.co/functions/v1/ingest-sheet-leads",
  "configured_at": "2026-08-31T00:00:00.000Z",
  "token_displayed_once": true
}
```

### `POST /functions/v1/ingest-sheet-leads`

Requires a connector token (`Authorization: Bearer ros_…`, no Supabase
user session) plus `X-RealtorOS-Timestamp` (Unix seconds) and
`X-RealtorOS-Nonce` (a UUID) headers.

```json
// Request body
{
  "source_event_id": "<UUID, stable per batch>",
  "sheet_revision": "<opaque fingerprint, optional>",
  "rows": [
    {
      "lead_id": "gs_…", "full_name": "Jane Doe", "email": "jane@example.com",
      "phone": "555-0100", "type": "Buyer", "status": "New Lead",
      "source": "Google Sheets", "temperature": "Warm",
      "budget": "450000", "preferred_area": "Downtown", "notes": "…"
    }
  ]
}
```

```json
// Response
{
  "batch_id": "…",
  "status": "completed",
  "source_row_count": 1,
  "accepted_count": 1,
  "duplicate_count": 0,
  "rejected_count": 0,
  "imported_count": 1,
  "replayed": false
}
```

Full field limits, validation rules, and error codes (401/403/422/429/5xx)
are documented in `RealtorOS/integrations/google-sheets/README.md` §10 and
in the Edge Function source (`RealtorOS/supabase/functions/`).

## Contributing

This repository doesn't currently define a formal contribution process,
but as a general guide:

1. Create a branch off `master` for your change.
2. Keep the frontend framework-free and build-step-free — it is a
   deliberate design constraint (see `RealtorOS/docs/README.md`).
3. Never commit a Supabase service-role/secret key, or a Google Sheets
   connector token, anywhere in the repo.
4. If you change the database schema, add a new, forward-only file under
   `RealtorOS/supabase/migrations/` (and keep `supabase/migrations/` in
   sync) rather than editing an already-applied migration.
5. Describe what you changed and why in your commit message/PR
   description; this project's history favors small, clearly-scoped
   commits (see `git log`).

## License

No license file is currently included in this repository. All rights
reserved by the project owner unless/until a license is added.
