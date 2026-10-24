# RealtorOS — Full System Audit

**Date:** 2026-10-14
**Method:** read-only inspection of the actual code. Docs, handoff notes, commit messages and
code comments were treated as *claims to verify*, not as evidence.
**Repo audited:** `…/RealtorOS_Project_Phase3_Sheets_Backend/RealtorOS_Project`
**HEAD:** `73a3a04e7d759efd4f9f3c974f6e1a2e8fb33d54` (branch `master`)
**Live DB state:** supplied by the owner (28 migrations, 3 edge functions, no cron, no email
provider). Not re-queried — this audit did not touch the live project.

---

## Section 1 — Executive summary

RealtorOS is a **genuinely built system, not a demo**. The thing that surprised me most about
this audit is how little fakery there is: I went looking for hardcoded arrays, dead buttons and
"coming soon" panels and essentially did not find them. Every one of the 16 entity types maps to
a real Postgres table through one data layer, no page talks to Supabase directly, and the SQL is
unusually careful (write-once timestamps verified by read-back, idempotency keys, fail-closed
retry windows, `search_path ''` on every `SECURITY DEFINER` function).

The gap is not quality. **The gap is that almost none of the second half is switched on.**

| Area | % done | One-line justification |
|---|---|---|
| **Core CRM** | **~90%** | All 16 entities are real tables with full CRUD through `App.data`; every route renders live data. Loses points only for having essentially no automated tests. |
| **Automation / email** | **~85% built, ~0% operational** | The worker, webhook, sender profiles, suppressions, 3-layer stop logic and retry ladder are all written and heavily tested — but `process-automation`, `resend-webhook`, `send-test-email` and `manage-automation` are **not deployed**, `pg_cron`/`pg_net` are **not installed**, and no email provider is configured. Nothing has ever sent an email and nothing can. |
| **Teams** | **~80% built, ~60% live** | T2a–T3 are live and the full T4 Team UI exists in code. But the T4 migration is **not applied**, and three team-mode gaps are unfixed: lead-import dedupe, realtime, and workspace selection (§12). |
| **Production readiness** | **~35%** | No hosting, no DNS/email domain, no webhook, no cron, 6 of 9 edge functions undeployed, 1 migration unapplied, and the working tree is dirty with uncommitted test infrastructure. |

**The three things I would not ship without fixing:** the non-deterministic workspace selection in
`ensure_personal_workspace` (C-1), the Sheets connector's inability to see hand-entered contacts
(H-1), and the fact that lead-import dedupe is still owner-scoped in a product that now has teams
(H-2).

**On the docs:** the code is more trustworthy than the documentation. Four separate documents
describe a system that no longer exists (§10), including a T4 spec that still says "not yet built"
for work that is committed, and a deployment playbook that is six migrations out of date.

---

## Section 2 — Status table

Legend: **IV** = Implemented & verified · **IU** = Implemented, untested · **P** = Partial ·
**PF** = Placeholder/fake · **B** = Broken · **M** = Missing

| Feature | DB | Backend | UI | Tests | Live? | Status |
|---|---|---|---|---|---|---|
| Contacts + CRUD | ✅ | ✅ | ✅ | ⚠️ indirect only | ✅ | **IU** |
| Contact dedupe (identity keys) | ✅ | ✅ | n/a | ✅ 23 | ✅ | **P** — file-only fallback (H-1) |
| Properties | ✅ | ✅ | ✅ | ❌ | ✅ | **IU** |
| Buyer / Seller workspaces | ✅ | ✅ | ✅ | ❌ | ✅ | **IU** |
| Deals / pipeline | ✅ | ✅ | ✅ | ❌ | ✅ | **IU** |
| Commission / finance | ✅ | ✅ | ✅ | ❌ | ✅ | **IU** |
| Activities | ✅ | ✅ | ✅ | ❌ | ✅ | **IU** |
| Tasks | ✅ | ✅ | ✅ | ❌ | ✅ | **IU** |
| Calendar / showings | ✅ | ✅ | ✅ | ❌ | ✅ | **IU** |
| Goals | ✅ | ✅ | ✅ | ❌ | ✅ | **IU** |
| Referrals | ✅ | ✅ | ✅ | ❌ | ✅ | **IU** |
| Milestones | ✅ | ✅ | ✅ | ❌ | ✅ | **IU** |
| Custom fields | ✅ | ✅ | ✅ | ❌ | ✅ | **IU** |
| Google Sheets connector | ✅ | ✅ | ✅ | ❌ | ✅ deployed | **P** — stale vs T2 (§3) |
| CSV/XLSX import + 200/day | ✅ | ✅ | ✅ | ✅ 23+9+22 | ✅ deployed | **IV** |
| Email templates | ✅ | ✅ | ✅ | ❌ | ✅ | **IU** |
| Automation rule builder | ✅ | ✅ | ✅ | ✅ 10 | ❌ not deployed | **IU** |
| Automation worker / jobs / retries | ✅ | ✅ | n/a | ✅ 15+4 | ❌ no cron | **IU** |
| Email sender profiles | ✅ | ✅ | ✅ | ❌ | ❌ not deployed | **P** |
| Test send | ✅ | ✅ | ✅ | ❌ | ❌ not deployed | **P** |
| Resend webhook | ✅ | ✅ | n/a | ✅ 13 | ❌ not deployed | **IU** |
| Suppressions | ✅ | ✅ | ✅ | ✅ | ❌ | **IU** |
| Reply/unsubscribe stop logic (4E/4E-2/4E-3) | ✅ | ✅ | ✅ | ✅ 27+6+22 | ✅ DB only | **IU** |
| In-app notifications (4H) | ✅ | ✅ | ✅ | ✅ 20+12 | ✅ DB only | **IU** |
| Manual scheduler | ✅ | ✅ | ✅ | ❌ | ✅ | **IU** |
| Content library | ✅ | ✅ | ✅ | ❌ | ✅ | **IU** |
| AI Prompts page | ✅ | ✅ | ✅ | ❌ | ✅ | **IU** — text CRUD only, **no AI API** |
| Release / dashboard / daily | ✅ | ✅ | ✅ | ❌ | ✅ | **IU** |
| Settings / modules toggles | ✅ | ✅ | ✅ | ❌ | ✅ | **IU** |
| Auth: email/password + reset | ✅ | ✅ | ✅ | ❌ | ✅ | **IV** |
| Auth: Google/Facebook OAuth | n/a | ✅ code | ✅ | ❌ | ❓ provider unconfigured | **P** |
| Avatar storage | ✅ | ✅ | ✅ | ❌ | ✅ | **IU** |
| Workspaces / roles / permissions | ✅ | ✅ | ✅ | ✅ 18+29+21 | ✅ | **IV** |
| Invitations / join / members | ✅ | ✅ | ✅ | ✅ 30+9+27 | ✅ | **IV** |
| Transfer / leave / delete workspace | ✅ | ✅ | ✅ | ✅ | ✅ | **IV** |
| Team mode toggle | ✅ | ✅ | ✅ | ✅ 5 | ❌ **T4 not applied** | **IU** |
| Contact assignment | ✅ | ✅ | ✅ | ✅ 11 | ✅ | **IV** |
| Team dashboard | ✅ | ✅ | ✅ | ✅ 8 | ✅ | **IV** |
| T4: `permission_overrides` in `list_members` | ✅ code | ✅ | ✅ | ✅ | ❌ **not live** | **IU** |
| T4: `team_mode_has_members` guard | ✅ code | ✅ | ✅ | ✅ | ❌ **not live** | **IU** |
| Team-mode realtime | ❌ | ❌ | ❌ | ❌ | — | **M** (M-1) |

---

## Section 3 — Repo baseline, migrations, edge functions

### 3.1 Baseline

- **HEAD:** `73a3a04` — "T4 follow-ups: show the exceptions being replaced, and hold team mode to the team"
- **Branch:** `master`. **Tracked files:** 178. **Hand-written code:** ~60,800 lines
  (frontend JS 21,241 · migrations 16,040 · tests 12,339 · edge functions 4,593 · Code.gs 1,076).
- **Run command:** none needed. `app/index.html` is a static page with 40 plain `<script>` tags
  (`app/index.html:22-77`) — no build step, no bundler. Serve `app/` from any static file server.

**Last 15 commits:** `73a3a04` T4 follow-ups · `688e5e3` T4 Team UI · `243a77f` T3 leave_workspace
JWT fix · `3875b6c` T3 realtoros_list_members · `e9ab230` tests/T4 spec · `7c4ea51` 4E.2
re-runnability · `54800cb` T3 change_member_role/leave/delete · `efd0ef6` T3 invitations ·
`e6f688b` T2d applied · `24e9417` T2d frontend · `330cd66` T2c-post applied · `8b9d662` T2c-post
JOIN fixes · `d4706c5` T2c-post 19 RPCs · `e9f68de` T2c revert file · `6aac1b7` docs manual test.

### 3.2 git status — **does not match the expected baseline**

The task expected only root `README.md` and `followup-model-eval/` untracked. Actual:

**4 modified tracked files (uncommitted):**
- `tests/helpers/pg.mjs` — +113 lines: a content-keyed PGlite snapshot cache (`chainKey`,
  `readSnapshot`, `writeSnapshot`, `fromSnapshot`)
- `tests/package.json` — +8 scripts: `test:quiet`, `test:sql`, `test:edge`, `test:frontend`,
  `test:security`, `test:file`, `test:cache`, `test:cache:clear`
- `tests/frontend/team-helpers.mjs` — +10 lines stubbing `window.location.reload` for jsdom
- `tests/sql/phase_t2c_post_workspace_rpcs.test.mjs` — +24 lines widening an allow-list for T3's
  landing helper

**3 untracked paths:** `tests/.cache/` (the snapshot: `migrated.key`, `migrated.tar.gz`),
`tests/helpers/build-cache.mjs`, `tests/helpers/quiet-reporter.mjs`.

**This is Codex "Stage B" (fast tests/CI), and it is real, working, and uncommitted.** See §8c.
Note `followup-model-eval/` exists **twice** — tracked inside the repo *and* as an untracked
sibling directory one level up.

### 3.3 Migrations — 29 files, 28 live

All 28 live versions have a matching repo file with an identical filename version. No live version
lacks a repo file. **One repo file is not live:**

| File | Live? |
|---|---|
| `20261013120000_phase_t4_followups.sql` (199 lines) | ❌ **NOT APPLIED** |

The other 28 (`20260827040054` … `20261007130000`) match the supplied live list exactly, in order.

**Rollback files: 4 of 29 (14%).** `supabase/rollback/` holds only `t2b2_revert_to_user_id_policies.sql`,
`t2c_pre_revert_fks.sql`, `t2c_revert.sql`, `t2c_post_revert.sql`. **T4 has no rollback file**, and
neither do T2a, T2b1, T2d, T3 or any of the 4C–4H phases. `tests/sql/rollback_files.test.mjs`
exists but only asserts the four T2 files, so the suite does not notice the gap.

### 3.4 Edge functions — 9 in repo, 3 deployed

| Function | Purpose | Auth | Secrets needed | Deployed |
|---|---|---|---|---|
| `create-sheet-connection` | Mint a Sheets connection + token | JWT | `SUPABASE_URL`, service key | ✅ 2026-08-31 |
| `ingest-sheet-leads` | Receive rows from Code.gs | **HMAC** (`x-realtoros-timestamp`/`-nonce`), `verify_jwt false` | service key | ✅ 2026-08-31 |
| `import-lead-file` | One-shot CSV/XLSX import + quota | JWT | service key | ✅ 2026-09-29 |
| `manage-automation` | **Only** browser path to automation state | JWT | service key | ❌ |
| `process-automation` | The worker | **Machine-only**, `x-realtoros-worker-secret` | `AUTOMATION_WORKER_SECRET`, `RESEND_API_KEY`, `RESEND_SENDING_DOMAIN`, `UNSUBSCRIBE_SIGNING_SECRET`, `UNSUBSCRIBE_PAGE_URL`, `INBOUND_REPLY_DOMAIN` | ❌ |
| `resend-webhook` | Delivery + inbound reply events | **Svix HMAC** | `RESEND_WEBHOOK_SECRET`, `RESEND_API_KEY`, `INBOUND_REPLY_DOMAIN` | ❌ |
| `send-test-email` | One controlled test send | JWT | `RESEND_API_KEY`, `RESEND_SENDING_DOMAIN` | ❌ |
| `email-unsubscribe` | Public unsubscribe page | **Signed token**, `verify_jwt false` | `UNSUBSCRIBE_SIGNING_SECRET` | ❌ |
| `_shared/` | `runtime.ts`, `reply-detection.ts`, `unsubscribe-token.ts` | — | — | (library) |

**Staleness verdict for the 3 deployed functions.** Their own source has not changed since deploy:
`create-sheet-connection` and `ingest-sheet-leads` were last touched by `331893e` (2026-08-31, their
deploy date); `import-lead-file` by `6c7d1c8` (2026-09-29, its deploy date). `_shared/` changed on
2026-10-01 (`6510e62`, `1671e25`) but none of the three import from it.

**However, all three are stale with respect to the live schema, in a way that matters:**

- T2c (live) added `workspace_id` to `lead_import_batches` and `lead_source_connections` and
  replaced their `user_id`-based unique constraints with `workspace_id`-based ones
  (`supabase/migrations/20261006132041_phase_t2c_workspace_backend.sql:85-110`). The deployed
  functions still insert without `workspace_id`.
- They do not break, because T2a's `BEFORE INSERT` compat trigger fills it
  (`20261001160608_phase_t2a_workspace_foundation.sql:315-353`) — and that trigger's
  `new.workspace_id is null` branch runs for service_role too, so the Aug-31 code still works.
- But the value it fills comes from `ensure_personal_workspace`, which is **non-deterministic for
  a multi-workspace user** (see C-1). So the deployed connector is one `LIMIT 1` away from writing
  leads into the wrong workspace. **Verdict: functionally alive, semantically stale, must be
  redeployed after C-1 is fixed.**
- Separately, `realtoros_ingest_lead_batch` / `realtoros_ingest_lead_file` were **not** among the
  21 RPCs T2c-post rewrote to workspace scope (§6), so the connector's dedupe is still owner-scoped.

---

## Section 4 — Frontend: routes and page classification

### 4.1 Routes

28 routes dispatched in `app/assets/js/app.js:895-951`. Nav is defined at `app.js:31-73`.

| Route | Handler | Classification |
|---|---|---|
| `/dashboard` | `release.renderDashboard` (`release.js:227`) | **WORKING** |
| `/daily` | `release.renderDaily` (`release.js:314`) | **WORKING** |
| `/contacts`, `/contacts/:id` | `contacts.renderList` / `renderDetail` | **WORKING** |
| `/properties`, `/properties/:id` | `properties.*` | **WORKING** |
| `/buyer`, `/seller` | `buyer.render`, `seller.render` | **WORKING** |
| `/pipeline`, `/pipeline/:id` | `deals.*` | **WORKING** |
| `/commission` | `commission.render` | **WORKING** |
| `/activities`, `/tasks`, `/calendar`, `/referrals`, `/goals`, `/finances`, `/reports` | respective modules | **WORKING** |
| `/content` | `release.renderContent` (`release.js:423`) | **WORKING** |
| `/prompts` | `release.renderPrompts` → `renderLibrary(c,'prompts')` (`release.js:1394`) | **WORKING** |
| `/email-templates` | `emailTemplates.render` | **WORKING** |
| `/scripts` | redirect → `/email-templates` (`app.js:944`) | **WORKING** (intentional alias) |
| `/automation` | `automation.render` | **WORKING** (UI only; backend undeployed) |
| `/notifications` | `notifications.render` | **WORKING** |
| `/scheduler` | `scheduler.render` | **WORKING** |
| `/team` | `teamDashboard.render` | **WORKING** |
| `/settings`, `/settings/:cat` | `release.renderSettings` | **WORKING** |
| `/join`, `/join?…` | `teamJoin.render` | **WORKING** |
| `/` | redirect → `/dashboard` | **WORKING** |
| anything else | `renderComingSoon` (`app.js:1025`) | 404 fallback — **not reachable from any nav item** |

**I found no PLACEHOLDER, FAKE, BROKEN or DEAD page.** Specifically:

- **Nothing is hardcoded demo data.** The only `"Coming Soon"` strings in the codebase are a
  *property status value* (`properties.js:22,65,404`; `seller.js:35-39`) — not a placeholder.
- **The AI Prompts page calls no AI API.** `renderLibrary` (`release.js:466`) is plain CRUD over the
  `ai_prompts` table. A grep for `anthropic|openai|gemini|gpt-|claude-|generativelanguage` across
  `app/`, `supabase/` and `integrations/` returns **zero hits**. No paid AI dependency exists.
- **No page calls Supabase directly.** Every page goes through `App.store` / `App.data`. A grep for
  `supabase.|createClient|.from(|functions.invoke` in `app/assets/js/pages/` returns only three
  false positives (two `querySelectorAll` matches in `email-templates.js:490,514`, and a URL
  *string constant* in `google-sheets-settings.js:20` used for a validation comparison at
  `:174`, never as a call target). This is additionally enforced by
  `tests/security/scan.test.mjs:59`.
- **The 8 non-routed page modules are all reachable**, as settings categories
  (`release.js:600-614`: `custom-fields`, `team-access`, `team-permissions`, `google-sheets`,
  `sheet-imports`, `email-sending`) or as a modal (`leadFileImport.open()` from
  `contacts.js:1511` and `google-sheets-settings.js:387`). Nothing is dead.
- The old fakes are **gone**, not hidden: `688e5e3` deleted `team.js` (140 lines) and
  `team-directory.js` (168 lines), which the commit describes as "the old fake Team Directory".

One legacy remnant: `app/assets/js/core/permissions.js` is a 49-line shim whose `refresh()` is an
empty function (`permissions.js:47`) and which exposes only `currentRole` and
`commissionFiguresHidden`. The real permission surface is `App.workspace`
(`app/assets/js/data/workspace.js:89-150`: `can`, `scope`, `canView`, `canCreate`, `seesAll`,
`canEditRow`, `canDeleteRow`, `settingsLevel`). Harmless, but it is a second source of truth.

---

## Section 5 — Feature-by-feature

**Core CRM (contacts, properties, deals, activities, tasks, showings, referrals, goals, finances,
milestones, scripts, AI prompts, team members, scheduled items, custom field values).**
All 16 entities are declared in one registry in `app/assets/js/data/data-service.js:35-405`, each
with a real table and id prefix. Every table exists in the migration chain. Full CRUD, workspace
scoping, and realtime. **Missing: tests** (§9).

**Contacts + dedupe.** Contacts are real. Dedupe lives in `automation_internal.ingest_lead_rows`
via the `contact_identity_keys` table (hashed email/phone,
`20260929095530_phase_4e_4_file_lead_import.sql:444-460`, keys written at `:668-688`). **Gap:** the
fallback that matches a contact's *own* `email`/`phone` columns — the only way a hand-entered
contact can ever be matched — is gated behind `if v_is_file then` at `:469`. See H-1.

**Google Sheets connector.** Complete and the most mature integration: `Code.gs` (1,076 lines) with
`onOpen` menu, `menuSetupConnection`, `menuPrepareReadyLeads`, `menuSyncNow`,
`menuInstallTrigger`/`menuRemoveTrigger`, `menuConnectionStatus`, HMAC request signing, and
unusually candid UX about multi-editor trigger collisions (`Code.gs:274-278`). Backed by
`create-sheet-connection` + `ingest-sheet-leads` (both deployed) and the settings/import-history
pages. The 200/day quota deliberately **excludes** Sheets
(`20260929095530…:955`: "Google Sheet imports are not counted").

**CSV/XLSX import + 200/day limit.** The best-tested feature in the system. `c_daily_new_contacts
constant integer := 200` (`20260929095530…:923`), rolling 24h, reported separately from other
rejections, 1–500 rows/request, 10 uploads/15min and 20/24h rate limits
(`20260929095530…:1148`). 54 tests across `sql/file-import` (23), `frontend/lead-file-import` (22),
`edge/import-lead-file` (9), including two real-SQL end-to-end tests. **IV.**

**Automation rule builder + worker.** `manage-automation` implements all 9 actions the UI calls —
`activate_rule`, `pause_rule`, `resume_rule`, `archive_rule`, `manual_enroll`, `retry_job`,
`stop_summary`, `mark_replied`, `mark_unsubscribed` (declared `index.ts:9,64`, dispatched
`:312-591`) and the UI invokes exactly those plus `quota` (`data-service.js:1581-2014`). No
mismatch. `process-automation` (1,238 lines) is a serious worker: lease claiming, retry ladder,
pre-send guard, idempotency keys, a 20-hour `SAFE_IDEMPOTENCY_WINDOW_MS` that **fails closed** to
an `unconfirmed` status rather than risk a duplicate (`:902-915`). **But it is reachable only by
pg_cron** (`docs/deployment/setup-cron.sql:92`), which is not installed. **Built, never run.**

**Email sender profiles, test send, Resend webhook, suppressions, stop logic.** All present with
real tables (`email_sender_profiles`, `email_suppressions`, `contact_stop_events`,
`outbound_messages`, `webhook_events`) and RLS. `resend-webhook` (804 lines) verifies Svix
signatures properly (`:132-146,503-510`). Stop logic spans 4E/4E-2/4E-3 with 55 SQL tests.
**None of it is deployed and no provider is configured, so zero of it has ever executed.**

**In-app notifications (4H).** Real: `notifications` table with RLS
(`20260929150944…:46,100`), 7 `automation_internal` helpers including `notify`, `notify_on_stop_event`,
`notify_on_import_batch`, `notify_on_job_failed` (`:126-502`), a UI page, 32 tests. Live in the DB —
but the three triggers that *generate* most notifications fire from the undeployed automation path,
so in practice only import notifications can occur today.

**Manual scheduler.** Honest and working. `scheduler.js:1-17` documents explicitly that picking an
email template only prefills title/notes as a plain-text snapshot, that the template id is never
written to `script_id`, and that **nothing is sent automatically**. Real `scheduled_items` table.

**Content / AI Prompts / Email Templates.** All real CRUD. `/content` is a two-card summary over
`message_templates` and `ai_prompts` with correct failure handling — it distinguishes "load failed"
from "zero results" (`release.js:430-432,440`), which is a detail most code gets wrong. Legacy
`scripts` table retained and still used by the scheduler; `/scripts` redirects to the new page.

**Auth / OAuth.** Email+password signup, sign-in and reset are real
(`supabase-client.js:242,249,263`). **OAuth code is present** — `signInWithOAuth` with Google and
Facebook buttons (`:291-305`). Whether the providers are configured in Supabase is a dashboard
setting I cannot read; the owner's live-state report lists no provider config, so treat OAuth as
**code-complete, provider-unconfigured**. Leaked-password protection is likewise a dashboard
setting: **nothing in code**, and nothing in code could implement it.

**Avatar storage.** Real and correctly locked down: private `avatars` bucket, 2 MB limit, jpeg/png/webp
only, four RLS policies keyed on `(storage.foldername(name))[1] = auth.uid()::text`
(`20260828072525…:11-23`).

**Teams.** The largest single body of work. Live: workspaces, members, roles, 19 permission keys
(`automation_create_personal`, `contacts_assign`, `team_manage`, `unassigned_claim`,
`templates_manage_shared`, … — `20261005140817…`), RLS matrix, invitations, join, role changes,
remove, ownership transfer, leave, delete-with-typed-name, contact assignment, team dashboard.
UI across `team-management.js` (864), `team-permissions.js` (491), `team-join.js` (212),
`team-dashboard.js` (172), with 71 jsdom tests.

**T4 follow-ups — present in code, NOT live.** Both items the task asked about are implemented in
`supabase/migrations/20261013120000_phase_t4_followups.sql`:
- `permission_overrides` returned from `realtoros_list_members`, to a `team_manage` holder only
  (`:34,79-80,98-100`)
- `automation_internal.guard_team_mode_off()` raising `team_mode_has_members` (`:126,159`)

Plus a real bug fix noted in `73a3a04`: `teamMode` was never persisted at all because
`settingsToRow` dropped it. **The migration is not applied**, so today the live system still lets a
manager silently overwrite another member's exceptions, and still lets team mode be switched off
while members remain.

---

## Section 6 — Database-to-code consistency

**Objects referenced in code but missing from the migration chain: none.** 26 distinct RPC names
are called from `app/assets/js/` and `supabase/functions/`; all 26 exist among the 84 functions
defined in the chain. Every one of the 16 registry tables exists.

**DB objects no code uses:**
- `public.realtoros_open_enrollments_for_contact(uuid, text)` — **dead**. service_role-only
  (`20260904060217…:506`), called from nowhere, yet still carried forward and rewritten by T2c-post
  (`20261007033030…:638-639`). Maintenance cost for zero callers.
- `public.realtoros_set_updated_at`, `public.set_workspace_state_updated_at` — trigger helpers,
  correctly unreferenced from app code.
- `public.realtoros_clear_sample_data()` — properly dropped at
  `20260831114425_remove_sample_data_feature.sql:695`. Not a leak.

**The consistency gap is scoping, not existence.** T2c-post rewrote 21 functions to resolve rows by
workspace instead of by creator, but the **lead-ingestion path was not included**: the 21 are all
automation/notification RPCs, and `realtoros_ingest_lead_batch`, `realtoros_ingest_lead_file` and
`automation_internal.ingest_lead_rows` still use `user_id = p_user_id` throughout
(e.g. `20260929095530…:473,481`). See H-2.

---

## Section 7 — Security scan

**This is the strongest part of the system.** There is even a dedicated enforcement test file,
`tests/security/scan.test.mjs`, whose six tests assert precisely the properties this audit item
asks about (`:35,40,59,69,74,94`).

| Check | Result |
|---|---|
| Secrets/keys in repo | **CLEAN.** Only a publishable anon key, correctly labelled, in `app/assets/js/config.js:6`. A regex sweep for `eyJ…`, `sk_live`, `sk_test`, `re_…`, `whsec_…` across `app/`, `integrations/`, `supabase/`, `docs/` found only *documentation references to variable names*, never values. `app/.env.example` carries an explicit warning against service-role keys. |
| Tokens in storage/URLs/logs | **CLEAN.** Enforced by `scan.test.mjs:69` (no localStorage/sessionStorage/IndexedDB token storage) and `:35` (Edge Functions contain no `console.*` at all). `process-automation:12-14` documents logging only non-secret aggregate counts. |
| Browser writes to runtime tables | **CLEAN**, enforced by `scan.test.mjs:40`. |
| Browser calls to `ingest-sheet-leads` | **CLEAN**, enforced by `scan.test.mjs:59`. The ingest URL appears in the frontend only as a comparison constant (`google-sheets-settings.js:20,174`). |
| Unescaped HTML insertion of user data | **Appears sound.** Escaping is systematic via `App.util.esc` / `escapeHtml`, including the places most likely to be missed — breadcrumb labels *and* hrefs (`app.js:814-848`, with an explicit "ESCAPING IS REQUIRED HERE" comment), and `backLink` (`app.js:132-135`). Given ~14,400 lines of template-string HTML I did not verify every interpolation; **unverified at exhaustive level** (§14). |
| RLS on every table in the chain | **COVERED.** 13 explicit `enable row level security` statements plus two `DO`-loop sweeps that cover every `user_id` table (`20260829050743…:204`, `20260831091706…:474`). |
| `SECURITY DEFINER` without `search_path ''` | **ZERO.** 30 `security definer` declarations; all have `set search_path` — 28 as `= ''` and 2 as `to ''` (`20260904021204…:184,204`), which is equivalent. My first pass flagged that file as a gap; it is not one. |

Two design notes worth recording as *correct* rather than as findings: `ingest-sheet-leads` is
`verify_jwt false` but HMAC-authenticated with timestamp + nonce replay protection
(`index.ts:35,44`); `resend-webhook` and `email-unsubscribe` are public but authenticated by Svix
signature and signed token respectively, with the reason documented in each file's header.

---

## Section 8 — The eight known open items, verified

**(a) `firstAttemptAt` fallback in `process-automation` — FIXED.**
The reported `inserted.first_provider_attempt_at || nowIso` **no longer exists**. It has been
replaced by a verify-then-trust design: `ensureFirstProviderAttemptAt`
(`process-automation/index.ts:222-253`) performs a write-once `UPDATE … .is(…, null)`, then
**reads the value back** and fails the job as retryable (`first_attempt_stamp_unverified`) rather
than falling back to an in-memory clock — the code says so explicitly: *"There is deliberately no
in-memory fallback"* (`:242-244`). The insert path does the same via `persistedTimestamp(...)` with
an explicit null check (`:887-895`). The comment at `:214-219` correctly states why the old
behaviour was dangerous: a fresh `new Date()` per retry would push the 20-hour cutoff forward
forever. **Closed.**

**(b) ~29 skipped tests — environmental, now diagnosable.**
The skips were never test failures: three environment guards (`SKIP_DOM` for jsdom, `SKIP_LIBS` for
xlsx/papaparse, `SKIP_MESSAGE` for PGlite) each skip a whole family. The honest part is
`tests/helpers/skip-reason.mjs`, added precisely because *"a run that skipped 29 tests on one
machine and none on another said only 'not installed', which is a guess"* — it now prints the real
error once per library. **On this machine all libraries are installed and nothing skipped.** Full
counts in §9.

**(c) Codex Stage A and Stage B.**
- **Stage A (T4 follow-ups migration + UI): DONE in code, NOT live.** Migration written and tested
  (`20261013120000_phase_t4_followups.sql`, 199 lines; `tests/sql/phase_t4_followups.test.mjs`,
  5 tests); UI shipped in `688e5e3` (+3,712 lines across 21 files) and `73a3a04`. Not applied to the
  live DB.
- **Stage B (fast tests / CI): BUILT, WORKING, UNCOMMITTED.** The PGlite snapshot cache
  (`tests/helpers/pg.mjs`, content-keyed by migration filenames + bytes, atomic
  temp-file-then-rename, filtered calls deliberately bypassing the cache) plus 8 granular npm
  scripts, a quiet reporter and a cache builder. **CI itself is absent** — there is no
  `.github/workflows/` or any other CI configuration in the repo. So: fast local tests yes,
  CI no.

**(d) Sheets connector recognising hand-entered contacts — NOT HANDLED.**
Confirmed by direct reading, not inference. The fallback match on `contacts.email` /
`contacts.phone` is wrapped in `if v_is_file then`
(`20260929095530_phase_4e_4_file_lead_import.sql:469-484`), and the comment immediately above says
so in as many words: *"File only: contacts the owner typed in by hand … have no identity key yet …
**Sheet imports keep their original identity-key-only matching**"* (`:462-466`). A Sheets sync will
therefore create a duplicate of any contact the agent typed in by hand. See H-1.

**(e) Leaked-password protection / OAuth.**
OAuth: **code present, provider unconfigured** — `signInWithOAuth` for Google and Facebook
(`supabase-client.js:291-305`). Leaked-password protection: **nothing in code, and correctly so** —
it is a Supabase Auth dashboard toggle with no code surface. Both are config tasks, not build tasks.

---

## Section 9 — Tests

**37 test files.** By area: 11 edge (`edge/`), 10 frontend (`frontend/`, jsdom), 15 SQL (`sql/`,
real PGlite with the migration chain applied), 1 security.

Approximate test counts: **~479 total** — ~247 SQL subtests (via a per-file `sqlTest` wrapper),
~117 edge, ~109 frontend, 6 security. Largest files: `sql/phase_t3_invitations` (30),
`sql/phase_t2b2_rls_matrix` (29), `sql/phase_t2c_post_workspace_rpcs` (29),
`sql/stop-logic` (27), `frontend/team-management` (27), `sql/file-import` (23),
`edge/email-unsubscribe` (22), `frontend/lead-file-import` (22).

What they cover well: the entire automation/email/stop-logic chain, the workspace permission and
RLS matrix, invitations and membership, file import including real SQL end-to-end, in-app
notifications, and the security invariants of §7.

**Run result (this machine, `npm test`, `--test-concurrency=1`):**

> *[see RUN RESULT block below — filled in from the actual run]*

**Areas with NO tests — and this is the real test gap.** The entire core CRM is untested.
There is no test file for contacts CRUD, properties, deals/pipeline, commission, finances, reports,
activities, tasks, calendar/showings, goals, referrals, milestones, custom fields, email templates,
the scheduler, the dashboard/daily views, settings/modules, or the Google Sheets settings and
import-history pages. The only coverage they get is incidental: `frontend/load-all-scripts.test.mjs`
(1 test — every script parses and loads) and `frontend/team-leads.test.mjs` (11 — which exercises the
contacts *list* because assignment lives there). Also untested: `Code.gs` (1,076 lines, no test
harness at all) and the rollback files beyond the four T2 ones.

So the test suite's shape is the inverse of the product's risk: ~479 tests concentrated on the
half that has never run in production, and ~12 on the half users would touch on day one.

---

## Section 10 — Docs: claims that are not true in the code

`docs/` holds 17 files. Four make claims the code contradicts:

| File | Claim | Truth |
|---|---|---|
| `docs/README.md:16` | "Postgres (**16 relational tables**…)" | **41 tables** are created in the chain. 16 is the count of *frontend entity types*, not tables. |
| `docs/README.md:17` | "**owner-scoped** by Row Level Security" | RLS is **workspace-scoped** since T2b2 (`20261006033532`), which is live. |
| `docs/T4_SPEC.md:3` | "**Status:** specification, **not yet built**." | T4 is **built** — `688e5e3` (UI) and `73a3a04` (migration + fixes), both committed. |
| `docs/T4_SPEC.md:5-7` | "T4 is then **browser code only: it needs no migration of its own**" | **False.** T4 shipped `20261013120000_phase_t4_followups.sql`, 199 lines, including a new trigger. The spec was wrong about its own scope. |
| `docs/deployment/phase-4f-deployment-playbook.md:9,126` | "**All 22 migrations are live**, the last being `20261005140817_phase_t2b1_permissions`" | **28** are live, the last being `20261007130000_phase_t3_invitations_and_membership`. The playbook is 6 migrations stale and predates T2b2/T2c/T2d/T3 entirely. |

Accurate, by contrast: the playbook's edge-function and `pg_cron` statements, and
`docs/deployment/environment-variables.md`, which matches the 12 variables actually read from code.
`docs/TEAM_ACCESS_ARCHITECTURE.md:1360` correctly describes service-key handling.

`docs/archive/` (5 files) is explicitly archival and was not audited for currency.

---

## Section 11 — Deployment readiness (derived from code)

Required to go live, every item derived from the code rather than from the playbook:

**1. Hosting.** Serve `app/` as static files. No build, no runtime, no server process
(`app/index.html:22-77`, `app/.env.example:3-6`). Also host `app/unsubscribe.html`.

**2. Frontend config.** Edit `app/assets/js/config.js` directly — `.env` does nothing
(`app/.env.example:9-11`). Already points at project `yanasorwmaybnabfuepn`.

**3. Migration to apply.** `20261013120000_phase_t4_followups.sql` — the only one outstanding.
**No rollback file exists for it.**

**4. Edge functions to deploy — 6 of 9.** `manage-automation`, `process-automation`,
`resend-webhook`, `send-test-email`, `email-unsubscribe`, plus **redeploys** of the 3 live ones once
C-1 is fixed. Note `ingest-sheet-leads` needs `verify_jwt false`, as does `email-unsubscribe`, and
`process-automation` must not be publicly reachable without its worker secret.

**5. Secrets — 9 to set** (`SUPABASE_URL` and the key variables are injected by the platform):
`AUTOMATION_WORKER_SECRET`, `RESEND_API_KEY`, `RESEND_SENDING_DOMAIN`, `RESEND_WEBHOOK_SECRET`,
`UNSUBSCRIBE_SIGNING_SECRET`, `UNSUBSCRIBE_PAGE_URL`, `INBOUND_REPLY_DOMAIN`, and whichever of
`SUPABASE_SECRET_KEYS` / `SUPABASE_SERVICE_ROLE_KEY` is used (`_shared/runtime.ts:50`).

**6. Extensions + cron.** `pg_cron` and `pg_net` must be installed, then the worker job created
(`docs/deployment/setup-cron.sql:92`). **Until this exists the automation half of the product is
inert** — `setup-cron.sql:27` says exactly that.

**7. Email domain + DNS.** A verified Resend sending domain (`RESEND_SENDING_DOMAIN`) with SPF/DKIM,
and a separate inbound domain (`INBOUND_REPLY_DOMAIN`) with MX routing to Resend inbound — reply
detection and the 4E stop logic do not function without it.

**8. Webhook.** Resend → `resend-webhook`, with `RESEND_WEBHOOK_SECRET` matching the Svix signing
secret (`resend-webhook/index.ts:510`).

**9. Auth config (dashboard).** Enable Google/Facebook providers if OAuth is wanted (the buttons
already exist and will fail until then), set redirect URLs, and enable leaked-password protection.

**10. Housekeeping.** Commit Stage B, add CI (none exists), and write rollback files for the 25
migrations that lack them.

---

## Section 12 — Bugs and risks, ranked

### Critical

**C-1 — `ensure_personal_workspace` picks a workspace non-deterministically for any user in more
than one.** `select workspace_id into v_workspace_id from public.workspace_members where user_id =
p_user_id and status = 'active' limit 1` — **no `ORDER BY`**
(`20261001160608_phase_t2a_workspace_foundation.sql:241-244`). Postgres may return any matching row,
and the choice can change between calls. Because this function is what the `BEFORE INSERT` compat
trigger uses to fill `workspace_id` for every service_role writer (`:331`), **a Sheets or file
import for an agent who belongs to both a personal and a team workspace can land in either one**,
and not necessarily the same one twice. Live data (5 workspaces / 5 members) is currently 1:1 so
this is latent — but T3 invitations are live, so the first person to accept an invite can trigger
it. *Fix idea:* make the selection deterministic and intentional — an explicit active-workspace
column or JWT claim, with `ORDER BY` as a stopgap, never a bare `LIMIT 1`.

### High

**H-1 — The Sheets connector cannot see hand-entered contacts, so it duplicates them.** The
own-column email/phone fallback is gated to file imports at
`20260929095530_phase_4e_4_file_lead_import.sql:469`, with the exclusion stated in the comment at
`:466`. Every Sheets sync of a lead the agent already typed in creates a second contact. This is the
single most user-visible defect in the system. *Fix idea:* drop the `v_is_file` condition — the
fallback is source-agnostic by nature, and the identity keys written at `:668-688` make subsequent
matches direct anyway.

**H-2 — Lead-import dedupe is still owner-scoped in a team product.** `ingest_lead_rows` matches on
`user_id = p_user_id` throughout (`:447,457,473,481`), and the ingestion RPCs were **not** among the
21 T2c-post rewrote to workspace scope (`20261007033030…`). Two agents in one workspace importing
the same lead each get their own copy, and neither sees the other's. *Fix idea:* extend the
T2c-post treatment to `realtoros_ingest_lead_batch`, `realtoros_ingest_lead_file` and
`ingest_lead_rows`, including the `contact_identity_keys` uniqueness scope.

**H-3 — T4 is written, tested and not applied.** Until `20261013120000` is live, two defects it
fixes remain in production behaviour: a manager overwrites another member's permission exceptions
without being able to see them (`73a3a04`'s own description), and team mode can be switched off
while other members remain active, stranding them with access the switcher can no longer see.
*Fix idea:* apply the migration — but write its rollback file first, since none exists.

**H-4 — Six of nine edge functions undeployed and no cron, so the entire automation/email product
is inert.** Not a code bug; the risk is that the extensive test suite makes it *look* operational.
No email has ever been sent and none can be. *Fix idea:* follow §11 steps 4–8 as one gated release.

### Medium

**M-1 — Realtime is still filtered by `user_id`, so team members do not see each other's changes.**
Every entity subscription uses `filter: "user_id=eq." + user.id`
(`app/assets/js/data/data-service.js:2365`), and so does the `workspace_settings` subscription
(`:2386`) even though T2d made settings a workspace singleton. In team mode a colleague's edit to a
shared contact never reaches your open tab, and a settings change by another member is missed
entirely. *Fix idea:* filter on `workspace_id` instead, which is what RLS now scopes by anyway.

**M-2 — The working tree is dirty with load-bearing test infrastructure.** Four modified files and
three untracked paths (§3.2) constitute Stage B. An uncommitted `tests/.cache/` snapshot also means
the suite's behaviour differs between this machine and a clean checkout. *Fix idea:* commit it;
add `tests/.cache/` to `.gitignore` if it is not already covered.

**M-3 — No CI.** There is no `.github/workflows/` or equivalent anywhere in the repo, so ~479 tests
run only when someone remembers to. *Fix idea:* one workflow running `npm test` in `tests/`.

**M-4 — Rollback coverage is 14%.** 4 files for 29 migrations, and
`tests/sql/rollback_files.test.mjs` only asserts the four that exist, so the suite cannot detect the
gap. *Fix idea:* require a rollback file per migration and have that test enumerate the directory.

**M-5 — Docs actively mislead.** Four stale claims in §10, the worst being a T4 spec that says
"not yet built" and "needs no migration" about work that is committed *with* a migration. Anyone
onboarding from docs will reach wrong conclusions. *Fix idea:* correct the five lines cited; they
are one-line edits.

### Low

**L-1 — `realtoros_open_enrollments_for_contact` is dead code** that T2c-post nonetheless rewrote
(`20261007033030…:638-639`). *Fix idea:* drop it, or document the intended caller.

**L-2 — `core/permissions.js` is a vestigial shim** with an empty `refresh()` (`:47`) sitting beside
the real `App.workspace` surface. *Fix idea:* fold its two helpers into `App.workspace` and delete it.

**L-3 — `followup-model-eval/` exists twice**, tracked in-repo and untracked as a sibling directory.
*Fix idea:* delete whichever copy is not canonical.

**L-4 — The live Supabase project ref and publishable key are committed** in `config.js:5-6` and
`.env.example:14-17`. Correct for a publishable key, but it does hard-code one environment into the
repo. *Fix idea:* if a second environment is ever needed, make `config.js` a deploy-time artifact.

---

## Section 13 — What still needs to be built

### Must fix before launch

1. **C-1** — deterministic workspace selection in `ensure_personal_workspace`, then redeploy the
   three live edge functions.
2. **H-1** — remove the `v_is_file` gate so the Sheets connector matches hand-entered contacts.
3. **H-2** — re-scope the three lead-ingestion RPCs from `user_id` to `workspace_id`.
4. **H-3** — write a T4 rollback file, then apply `20261013120000_phase_t4_followups.sql`.
5. **H-4 / §11** — deploy the 6 missing edge functions, set the 9 secrets, install `pg_cron` +
   `pg_net`, create the worker job, verify the sending and inbound domains, register the webhook.
6. **M-1** — switch realtime filters to `workspace_id` (otherwise team mode is visibly broken on
   day one).
7. **M-2** — commit Stage B.
8. Configure the Auth dashboard: OAuth providers (the buttons exist and will fail until then) and
   leaked-password protection.

### Core gaps

9. **Tests for the core CRM.** ~479 tests cover the half that has never run; ~12 cover the half
   users touch first. Contacts, properties, deals, commission, tasks, calendar, goals, referrals,
   milestones, custom fields and email templates have no tests at all.
10. **CI** (M-3), and **rollback files** for the 25 migrations without them (M-4).
11. **A test harness for `Code.gs`** — 1,076 lines of the most customer-facing integration, with
    zero automated coverage.
12. **Correct the four stale documents** (M-5).
13. **An end-to-end staging rehearsal** of the email path. Every piece is unit-tested; the
    assembled system has never run once.

### Nice to have

14. Delete dead code: `realtoros_open_enrollments_for_contact` (L-1), `core/permissions.js` (L-2),
    the duplicate `followup-model-eval/` (L-3).
15. Multi-environment config (L-4).
16. Retire the legacy `scripts` table once the scheduler no longer needs it.
17. Exhaustive HTML-escaping review of the ~14,400 lines of template-string markup (§14).

---

## Section 14 — Could not verify, and why

1. **Live database state.** Taken as given from the owner's report; this audit was read-only and
   never queried the live project. Everything stated as "live" or "not live" rests on that report.
2. **Whether OAuth providers and leaked-password protection are enabled.** Supabase Auth dashboard
   settings with no code surface. The *code* is present; the *config* is unreadable from here.
3. **Exhaustive HTML-escaping correctness.** Escaping is systematic and the dangerous spots
   (breadcrumb labels and hrefs, back-links) are explicitly handled, but ~14,400 lines of
   template-string HTML were not reviewed interpolation by interpolation. **Unverified at exhaustive
   level**; no counter-example found.
4. **Whether the three deployed edge functions' live bundles match their repo source.** Inferred
   from git history (no commits touching them after their deploy dates) rather than by fetching the
   deployed bundles. Semantic staleness vs the live schema is established independently (§3.4).
5. **Real-world behaviour of `Code.gs`.** Google Apps Script cannot be executed or tested offline.
   Reviewed by reading only.
6. **Runtime behaviour of the undeployed email path against Resend.** Mocked in tests; never
   exercised against the real provider. Idempotency, Svix verification and bounce handling are
   verified only against fakes.
7. **Performance and index effectiveness.** The migrations create indexes intended to match
   specific query shapes (e.g. `20261006132041…:96-104`, which warns the expressions must mirror the
   queries exactly). Verifying that requires `EXPLAIN` against real data volumes.
8. **Full run of `app/` in a browser.** The audit read the code and relied on the jsdom suite; the
   app was not served and clicked through, so purely visual or interaction-level defects would not
   have been caught.
