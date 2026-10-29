# Supabase Setup — RealtorOS

RealtorOS is a static frontend with **no server of its own** — Supabase is
the entire backend (Auth, Postgres, Realtime, Storage). This document
covers where the configuration lives and what the live project needs to
have configured for the app to work.

## 1. Where the configuration lives

`assets/js/config.js` is the single place the frontend gets its Supabase
connection details:

```js
App.config = {
  url: "https://yanasorwmaybnabfuepn.supabase.co",
  publishableKey: "sb_publishable_..."
};
```

Both values are **public** — the project URL and the publishable
("anon") key are meant to ship inside browser code and are safe there
because every table is protected by Row Level Security (see below).

`assets/js/data/supabase-client.js` (the extracted `App.cloud` module)
reads `App.config.url` / `App.config.publishableKey` to construct the
client and is the *only* file that calls `createClient()`.

**Never put a service-role / secret key anywhere in this project.** A
service-role key bypasses RLS entirely; it must never exist in code that
ships to a browser. `.env.example` at the project root documents the two
public values only, as reference — this is a static app with no build
step, so no `.env` file is ever actually read at runtime.

## 2. Database schema and migrations

All schema changes are recorded, in order, in `supabase/migrations/`:

| Migration | What it does |
|---|---|
| `20260827040054_create_realtoros_workspace_state.sql` | Original single-table (`workspace_state`, one JSONB blob per user) cloud persistence layer. Superseded by the relational schema below but still present for one-time legacy-data migration on a user's first cloud sign-in. |
| `20260828072525_add_realtoros_avatar_storage.sql` | Private `avatars` Storage bucket + per-user RLS policies (path prefix `${auth.uid()}/...`). |
| `20260829050743_migrate_realtoros_to_relational.sql` | The 16 relational tables (`contacts`, `properties`, `deals`, `milestones`, `tasks`, `activities`, `showings`, `referrals`, `goals`, `finance_records`, `scripts`, `ai_prompts`, `scheduled_items`, `custom_field_values`, `team_members`, `workspace_settings`), each owner-only via RLS (`auth.uid() = user_id`), plus the `realtoros_clear_sample_data()` / `realtoros_reset_workspace()` RPCs and Realtime publication for every table. |
| `20260829074753_harden_realtoros_trigger_function.sql` | Revokes public/anon/authenticated EXECUTE on the internal `updated_at` trigger function (it should only ever run as a trigger, never be called directly). |
| `20260829074854_index_realtoros_relationships.sql` | Adds indexes on the composite `(user_id, id)` foreign keys used throughout the relational schema. |
| `20260829082546_realtoros_deal_and_followup_rpcs.sql` | `realtoros_create_deal_with_milestones()` and `realtoros_complete_followup()` — the two multi-row writes (deal + its milestones; a logged activity + the contact's follow-up dates) that need to happen atomically. Both are `SECURITY INVOKER`, ownership-checked via `auth.uid()`, and grant EXECUTE to `authenticated` only. |

To apply these to a **different** Supabase project (e.g. setting up a new
environment), run them in this exact order — either through the Supabase
SQL editor, the Supabase CLI (`supabase db push`), or the same migration
tooling used to build this project. Do not skip or reorder them; later
migrations depend on tables/functions created earlier.

## 3. Authentication

- Email/password sign-up and sign-in, Google OAuth, Facebook OAuth, and
  password-reset are all handled by Supabase Auth — no custom auth server.
- **Redirect URL requirement:** OAuth and password-reset both redirect
  back to `window.location.origin + window.location.pathname` (computed
  at runtime — wherever the app happens to be hosted). In the Supabase
  dashboard, under **Authentication → URL Configuration → Redirect URLs**,
  add every URL you actually serve this app from, for example:
  - `http://localhost:5500/index.html` (local development)
  - `https://your-production-domain.example/index.html` (production)
  Without a matching entry, Supabase will reject the OAuth/reset redirect.
- Session persistence is handled by the Supabase JS client itself
  (`persistSession: true`, `autoRefreshToken: true`,
  `detectSessionInUrl: true` — see `supabase-client.js`). The app never
  manages tokens or sessions manually.

## 4. Storage

- Bucket: `avatars` (private, not public). Files are addressed under a
  per-user folder prefix (`${auth.uid()}/...`); RLS on `storage.objects`
  restricts every operation to that prefix, so users can only ever see or
  modify their own avatar image.
- Avatars are read back through short-lived signed URLs generated
  client-side (`App.cloud.getAvatarSignedUrl`), not public URLs.

## 5. Business data storage

- **No business data is ever stored in `localStorage`, `sessionStorage`,
  or IndexedDB.** Every entity (contacts, properties, deals, tasks, etc.)
  is read and written directly against its own Postgres table through
  Supabase's REST/Realtime client.
- The only browser storage key the app uses at all is
  `realtor_os_v1_onboarding`, a purely cosmetic first-run-wizard flag —
  it holds no business data and losing it just means the welcome wizard
  may show again.
- Supabase Auth may itself persist session tokens internally (in
  `localStorage`, under its own key) as part of `persistSession: true`.
  That is the Supabase SDK's own session-management mechanism, not
  application business-data storage, and is unrelated to and unaffected
  by the onboarding flag above.

## 6. Deployment

This is a static site — anything that serves plain files over HTTP(S)
works:

1. Upload the contents of the `app/` folder (or just `index.html`
   plus `assets/`) to your static host of choice (Netlify, Vercel static
   hosting, GitHub Pages, S3 + CloudFront, Supabase Storage +
   a CDN, etc.).
2. Add the deployed URL to Supabase's Redirect URLs allow-list (see
   Authentication above) — otherwise sign-in via OAuth/password-reset
   will fail on that domain.
3. No build step, bundler, or environment-variable substitution is
   required or used — `assets/js/config.js` already contains the live
   values the deployed site needs.
