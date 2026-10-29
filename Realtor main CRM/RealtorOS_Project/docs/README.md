# RealtorOS — Pipeline & Commission OS

A cloud-backed CRM and commission tracker for independent real estate
agents: contacts, properties, deals/pipeline, milestones, tasks,
activities, showings, referrals, goals, finances, scripts/AI prompts,
team, and scheduler — all synced live through Supabase.

This is a static **vanilla HTML/CSS/JS** application. There is no build
step, no bundler, and no framework (no React/Vue/Angular, no
TypeScript, no Vite/Webpack) — it runs as-is from any static file server.

## 1. Project overview

- **Frontend:** plain HTML + CSS + classic (non-module) JavaScript,
  organized under `assets/`.
- **Backend:** Supabase — Postgres (42 relational tables, one row per
  record, **workspace-scoped** by Row Level Security since Phase T2b2;
  16 of those tables are the CRM entity types the frontend reads and
  writes directly, the rest back automation, email delivery, imports and
  the team/permission system), Supabase Auth
  (email/password + Google/Facebook OAuth + password reset), Supabase
  Realtime (live updates across tabs/devices), and Supabase Storage
  (private per-user avatar images).
- **Global namespace:** every module attaches to a single `window.App`
  object (`App.util`, `App.store`, `App.data`, `App.pages.*`, etc.),
  exactly as in the original single-file build — extracting the files
  did not change this.
- **Business data never touches browser storage.** The only
  `localStorage` key the app uses at all is the cosmetic first-run-wizard
  flag `realtor_os_v1_onboarding`. See
  [`SUPABASE_SETUP.md`](SUPABASE_SETUP.md#5-business-data-storage) for
  the full explanation, including how this differs from Supabase Auth's
  own internal session persistence.

## 2. Final directory structure

```
RealtorOS_Project/
├── app/                           — the served website (uploaded to the static host)
│   ├── index.html                 — application entry point
│   ├── unsubscribe.html           — the static unsubscribe-confirmation page
│   ├── assets/
│   │   ├── css/
│   │   │   └── realtoros.css      — all application styles (one file, original rule order preserved)
│   │   ├── js/
│   │   │   ├── config.js          — Supabase URL + publishable key (public, non-secret)
│   │   │   ├── core/              — pure/shared logic: utils, commission math, customization, permissions, derived calculations
│   │   │   ├── data/              — the Supabase boundary: client init/auth, per-entity CRUD, the App.store facade, backup import/export
│   │   │   ├── ui/                — shared UI building blocks (custom-fields form renderer)
│   │   │   ├── pages/             — one file per route/page module (contacts, properties, deals, tasks, settings, …)
│   │   │   ├── app.js             — application shell: router, modals, toasts, confirm dialogs, sidebar
│   │   │   └── boot.js            — the single line that starts the app once every module above has loaded
│   │   ├── fonts/                 — 4 self-hosted WOFF2 font files
│   │   └── illustrations/         — the auth-screen SVG illustration
│   ├── .env.example               — documents the two public config values (see SUPABASE_SETUP.md — not read at runtime)
│   └── .gitignore
├── integrations/
│   └── google-sheets/             — the Apps Script lead connector users install in their own Sheet (not served)
│       ├── Code.gs                — the connector script
│       ├── appsscript.json        — Apps Script manifest
│       └── README.md              — installation instructions
├── supabase/                      — single source for Supabase config, Edge Functions, SQL migrations and verifications
│   ├── config.toml
│   ├── functions/                 — Edge Functions (and _shared/ helpers)
│   ├── migrations/                — every applied SQL migration, in order (see SUPABASE_SETUP.md)
│   └── tests/                     — SQL verification scripts
├── docs/
│   ├── README.md                  — this file
│   ├── SUPABASE_SETUP.md          — Supabase configuration, schema, auth, deployment
│   ├── TEAM_ACCESS_ARCHITECTURE.md — team access / permissions architecture
│   ├── archive/                   — historical audit/completion reports from earlier work on this project
│   └── deployment/                — operator-facing deployment playbooks, acceptance tests, cron/verify SQL
└── tests/                         — offline Node test suite (edge/, sql/, frontend/, security/, helpers/)
```

See the extraction report delivered alongside this cleanup for the exact
original-script-number → new-file mapping and load order.

## 3. Running locally

From the repository root:

```bash
python -m http.server 5500 --directory app
```

or use VS Code's **Live Server** extension pointed at this folder.

Then open:

```
http://localhost:5500/index.html
```

The app must be served over `http://` (or `https://`) — opening
`index.html` directly via `file://` will not work, because the browser
blocks cross-origin script/module loading and Supabase Auth's redirect
handling needs a real origin.

## 4. Supabase configuration

See [`SUPABASE_SETUP.md`](SUPABASE_SETUP.md) for the full write-up:
project URL/key location (`assets/js/config.js`), the complete migration
list and what each one does, authentication redirect-URL requirements,
Storage bucket setup, and deployment notes.

## 5. Database migrations

Located in [`supabase/migrations/`](../supabase/migrations/), applied in
filename order. They are the authoritative, exact SQL that was run
against the live project (recovered directly from Supabase's own
migration history, not retyped from memory).

## 6. Authentication redirect URLs

OAuth (Google/Facebook) and password-reset flows redirect back to
wherever the app is currently served from
(`window.location.origin + window.location.pathname`, computed at
runtime). Every URL you actually serve this app from — local dev,
staging, production — must be added to Supabase's
**Authentication → URL Configuration → Redirect URLs** allow-list, or
those flows will fail on that URL. Details and examples are in
[`SUPABASE_SETUP.md`](SUPABASE_SETUP.md#3-authentication).

## 7. Deployment

Any static file host works — there is no server-side process and no
build step. Upload this folder's contents as-is. See
[`SUPABASE_SETUP.md`](SUPABASE_SETUP.md#6-deployment) for the short
checklist (mainly: remember to add the deployed URL to Supabase's
redirect allow-list).

## 8. Business data and localStorage

Confirmed: no page, modal, or store module reads or writes business data
through `localStorage`, `sessionStorage`, or IndexedDB. Every create,
read, update, and delete goes directly through a Supabase table or RPC
call. The only application `localStorage` key in the entire codebase is
the onboarding-wizard flag `realtor_os_v1_onboarding`, which holds no
business data.

## 9. Supabase Auth's own session persistence

Supabase Auth manages its own session/token persistence internally
(`persistSession: true`, `autoRefreshToken: true`,
`detectSessionInUrl: true`, passed to `createClient()` in
`assets/js/data/supabase-client.js`). This is the Supabase SDK's
mechanism for keeping a user signed in across reloads — it is separate
from, and not a form of, the application storing business data locally.

## 10. Service-role key warning

**Never add a Supabase service-role (secret) key to this project.** This
is a static frontend with no server; a service-role key bypasses Row
Level Security entirely, so it must never be embedded in code that ships
to a browser. Only the public project URL and publishable ("anon") key
belong in `assets/js/config.js` or `.env.example`.

## 11. Backup / reference files

The two historical HTML snapshots (`RealtorOS_Online_PreSplit_Backup.html`
and `RealtorOS_Offline_Original.html`) that previously lived under
`reference/` have been removed in the project-structure cleanup. If
either is ever needed, recover it from git history (tag
`pre-cleanup`).
