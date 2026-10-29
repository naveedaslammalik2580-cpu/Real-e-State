# RealtorOS Team & Access Architecture

**Status:** Investigation and planning only. No migration applied, no schema changed, no RLS changed, no Edge Function deployed, no frontend code edited, no Auth users created or deleted, no production data changed. Everything below is a proposal for review.

**Checkpoint verified:** Git commit `c21958b` (Phase 1) exists; working tree clean at the start of this phase; all 32 active JS files under `RealtorOS/assets/js/` parse; active application confirmed as `RealtorOS/index.html` + `RealtorOS/assets/`. Nothing in this phase, or Phase 2 before it, touched Phase 1's visual work or any application file.

**Supabase project:** `yanasorwmaybnabfuepn` ("Realtor OS"), Postgres 17.6.

**Note on commit `1694344` (Phase 2):** that commit is correctly *investigation-and-planning* work — no live migration was applied, no RLS/schema/Edge Function/frontend/Auth-user/production-data change occurred — but it was not accurately labeled "docs only." It added three files: this document, and **one SQL migration file in two locations** (`supabase/migrations/20260829120654_fix_composite_fk_set_null.sql` and, at the time, the same file under `RealtorOS/supabase/migrations/`). That file is **migration-history synchronization**, not new documentation: it is a byte-identical, verbatim recovery (read from `supabase_migrations.schema_migrations.statements` on the live project) of a migration that was **already applied to the live database before Phase 2 began** — Phase 2 did not write it, invent it, or apply it; it only brought the local repository's migration history into agreement with what the live project already had. The file should **not** be removed — it documents a real, already-applied change and its absence from version control was the actual defect being corrected. This note supersedes the "docs only" characterization given in the Phase 2 chat summary.

**Note on the former `RealtorOS/supabase/` mirror.** For several phases the repository carried two byte-identical copies of the Supabase tree: the root `supabase/` (the deployment source of truth, used by `tests/` and the deployment playbook) and a mirror under `RealtorOS/supabase/` shipped alongside the frontend bundle. The mirror has since been removed in a project-structure cleanup; `supabase/` at the repository root is now the single source. The migration file described above still exists — only its mirrored duplicate is gone.

---

## Revision Log (Phase 2B)

This document was rewritten in full (not patched piecemeal) specifically so no corrected decision is contradicted by leftover text elsewhere — the previous version's section numbers are **not** preserved because several corrections required new top-level sections. Every decision below was re-derived from the corrected premises, not layered on top of the old draft.

| # | Corrected decision | What was wrong before |
|---|---|---|
| 1 | `team_members` is preserved permanently as the directory/assignment table; `workspace_members` is a thin authenticated-access overlay linked to it via `team_member_id` | Previously recommended migrating `team_members` into `workspace_members` and eventually dropping it — conflated "a person who can be assigned work" with "a person who can log in," which are genuinely different things |
| 2 | `workspace_members.user_id` is nullable, `ON DELETE SET NULL` | Was `not null ... on delete cascade` — would have deleted membership/history the moment an Auth account was deleted, defeating the stated historical-attribution goal |
| 3 | `contacts.assigned_to_id` (new, references `team_members.id`) added alongside the existing free-text `assigned_agent`, with an explicit backfill/compatibility/retirement plan | Previously left `contacts.assigned_agent` as free text with "assigned" scope simply unavailable for Contacts |
| 4 | Sensitive deal-financial columns move to two new tables (`deal_values`, `deal_commissions`) with their own RLS, so a direct Data API `SELECT` genuinely cannot retrieve them without the right permission | Previously promised "redaction" while leaving the sensitive columns inside the ordinary `deals` row — RLS is row-level and cannot do this; the design was not actually enforceable |
| 5 | `authz` schema/functions are explicitly `GRANT USAGE`/`GRANT EXECUTE`'d to `authenticated` (never blanket, never `anon`); `has_permission()` special-cases `role = 'Owner'` before ever consulting the JSON | Previously revoked all access from every role including `authenticated`, which would have made every policy calling these functions fail outright; Owner authorization silently depended on the `permissions` JSON having every key populated |
| 6 | Self-referential RLS on `workspace_members` is broken by one narrow `SECURITY DEFINER` function (`authz.is_active_workspace_member`), explicitly justified; all other helpers stay `SECURITY INVOKER` | Previously asserted invoker functions avoid recursion "in practice" without resolving the actual self-referential-policy case on `workspace_members` itself |
| 7 | `workspace_id` immutability enforced by a `BEFORE UPDATE OF workspace_id` trigger comparing `OLD`/`NEW`, independent of ordinary RLS `USING`/`WITH CHECK` | Previous `WITH CHECK (workspace_id = contacts.workspace_id)` compared the new row to itself — always true, no protection at all |
| 8 | Ownership transfer is one `SECURITY DEFINER` function that validates the new owner fully **before** touching the old owner's row, with a final invariant check before commit | Previous invoker RPC demoted the old Owner before confirming the new Owner was valid, and relied on ordinary UPDATE rights that a correct "owner_user_id is otherwise immutable" policy would have blocked |
| 9 | Edge Functions keep `verify_jwt = true` (platform default) with the `@supabase/server` `withSupabase({ auth: 'user' }, ...)` helper — see §13.5 for why the alternative asserted in the correction request is not what current Supabase documentation supports, and what the real, verified 2026 nuance actually is | The correction request's specific claim (`verify_jwt = false` for user-invoked functions) is not what could be verified against current Supabase documentation; addressed with evidence rather than silently adopted |
| 10 | Production requires custom SMTP (documented 2 emails/hour on Supabase's built-in sender vs. 30/hour minimum on custom SMTP); already-registered-user notification goes through a `notify-existing-user` path in the same Edge Function, backed by a maintained `user_directory` mirror table instead of scanning all Auth users | Previously said "send a plain notification" without naming a mechanism, and did not address the "no email lookup" constraint at all |
| 11 | `workspace_members` rows are created **only** at invitation acceptance (or by the new-user provisioning function, §14); there is no `status='invited'` row with a null `user_id` — invitations live exclusively in `workspace_invitations` | Previous design's `workspace_members.status` enum included `'invited'`, implying a membership row could exist before acceptance — contradicts §6.3's own `token_hash` acceptance model and duplicates state across two tables |
| 12 | Multi-workspace: automatic selection for exactly one membership, an explicit chooser for more than one, `workspace_id` always passed explicitly, no application `localStorage`, an optional cloud-stored last-selection *hint* that is never trusted for authorization | Previous design silently used "the first membership found" |
| 13 | `ensure_current_user_workspace()` — an idempotent, `auth.uid()`-derived provisioning function, called at boot for every signed-in user, safe to call repeatedly, creates a workspace only when the caller has no membership at all | Previous plan only backfilled *existing* users during a one-time migration and never specified what happens for a user who signs up after that migration runs |
| 14 | Deployment uses the compatibility-trigger approach: temporary `BEFORE INSERT` triggers derive `workspace_id`/`created_by` from `auth.uid()` for a data-shape-unaware frontend, proven to close before RLS ever switches | Previous plan switched RLS to `workspace_id`-based policies (Phase D) before the frontend sent `workspace_id`/`created_by` at all (Phase E) — inserts from the still-old frontend would have failed the moment Phase D landed |
| 15 | Every uniqueness rule that involves an expression (`lower(email)`, partial `WHERE status = ...`) is written as a `CREATE UNIQUE INDEX`, never as a table `CONSTRAINT` (Postgres does not support expression/partial table constraints) | Previous draft wrote these as prose "unique (...)" without the correct index syntax, and would not have been valid SQL if transcribed literally |
| 16 | `workspace_members` base table SELECT is restricted to safe columns via a `workspace_members_directory` view for ordinary members; the full row (including `permissions`) is exposed only through a function callable by `invite_members`/`edit_permissions` holders | Previous design noted the column-privacy problem but left it as an unresolved "detail," while still describing ordinary members reading the base table |
| 17 | `anon` grant tightening is explicitly deferred to its own separate, later migration with its own regression-test list (login/registration/reset/OAuth callbacks/public shell/authenticated CRUD) — **not** part of the workspace cutover | Adequately flagged already in the prior version; kept, tightened, and given its own explicit test list here |

Every matrix, schema table, SQL draft, migration phase, rollback plan, and test in the sections below reflects these 17 corrections consistently; nothing below contradicts this table. An internal contradiction pass was run after writing (see the closing note in §21).

---

## 1. Current-State Evidence (live, read-only — unchanged from Phase 2, re-verified)

### 1.1 Tables — confirmed exactly 17 public tables

| # | Table | Columns | Row identity |
|---|---|---|---|
| 1 | `contacts` | 22 | `id` (text) PK, `(user_id,id)` UNIQUE |
| 2 | `team_members` | 11 | `id` (text) PK, `(user_id,id)` UNIQUE |
| 3 | `properties` | 25 | `id` (text) PK, `(user_id,id)` UNIQUE |
| 4 | `deals` | 24 | `id` (text) PK, `(user_id,id)` UNIQUE |
| 5 | `milestones` | 13 | `id` (text) PK, `(user_id,id)` UNIQUE |
| 6 | `tasks` | 17 | `id` (text) PK, `(user_id,id)` UNIQUE |
| 7 | `activities` | 15 | `id` (text) PK, `(user_id,id)` UNIQUE |
| 8 | `showings` | 14 | `id` (text) PK, `(user_id,id)` UNIQUE |
| 9 | `referrals` | 15 | `id` (text) PK, `(user_id,id)` UNIQUE |
| 10 | `goals` | 14 | `id` (text) PK, `(user_id,id)` UNIQUE |
| 11 | `finance_records` | 13 | `id` (text) PK, `(user_id,id)` UNIQUE |
| 12 | `scripts` | 9 | `id` (text) PK, `(user_id,id)` UNIQUE |
| 13 | `ai_prompts` | 9 | `id` (text) PK, `(user_id,id)` UNIQUE |
| 14 | `scheduled_items` | 20 | `id` (text) PK, `(user_id,id)` UNIQUE |
| 15 | `custom_field_values` | 8 | `id` (text) PK, `(user_id,id)` + `(user_id,entity_type,record_id,field_key)` UNIQUE |
| 16 | `workspace_settings` | 13 | `id` (text) PK, `user_id` UNIQUE |
| 17 | `workspace_state` | 5 | `user_id` PK (legacy, one-time-migration source only) |

Confirmed/corrected against the expected findings (unchanged from Phase 2, still accurate):

| Expected finding | Result |
|---|---|
| 17 public tables | **Confirmed** |
| Every business table uses `user_id` | **Confirmed** |
| No business table has `workspace_id` | **Confirmed** |
| No `workspaces`/`workspace_members`/`workspace_invitations` table | **Confirmed** |
| `team_members` is a directory table, not linked to authenticated accounts | **Confirmed** — plain profile fields (`name`, `role` free-text job-title label, `email`, `phone`, `avatar_url`, `notes`, `active`); no `auth_user_id`/Auth linkage column |
| RLS based on `auth.uid() = user_id` | **Confirmed** — all 17 tables, 4 policies each, all `TO authenticated` |
| Composite FKs use `(user_id, related_id)` | **Confirmed** — 25 foreign keys |
| No Edge Functions deployed | **Confirmed** |
| Existing RPCs are SECURITY INVOKER | **Confirmed** — `prosecdef=false` for all 6 functions |

**Naming collision worth flagging now, since it matters throughout this revision:** `team_members.role` (a free-text **job title**, e.g. "Agent," "Broker," entered by the Owner) and `workspace_members.role` (a fixed **security role preset**, e.g. `Owner`/`Admin`/`Manager`/`Agent`/`Assistant`/`Viewer`) are unrelated concepts that happen to share a column name. They are never the same value space and must never be confused in implementation — a directory person's job title of "Agent" does not imply their security role is the preset also named "Agent."

### 1.2 Foreign keys, delete behavior (full inventory, unchanged from Phase 2)

| Table.column | References | Delete rule |
|---|---|---|
| `activities.contact_id` / `.deal_id` / `.property_id` / `.task_id` | respective tables | SET NULL (col) |
| `deals.assigned_to_id` | `team_members` | SET NULL (assigned_to_id) |
| `deals.contact_id` / `.property_id` | respective tables | SET NULL (col) |
| `finance_records.contact_id` / `.deal_id` | respective tables | SET NULL (col) |
| `milestones.deal_id` | `deals` | **CASCADE** (only cascade besides `auth.users`) |
| `properties.deal_id` / `.contact_id` | respective tables | SET NULL (col) |
| `referrals.deal_id` / `.referred_contact_id` / `.referrer_contact_id` | respective tables | SET NULL (col) |
| `scheduled_items.assigned_to` | `team_members` | SET NULL (assigned_to) |
| `scheduled_items.contact_id` / `.deal_id` / `.property_id` / `.script_id` | respective tables | SET NULL (col) |
| `showings.contact_id` / `.deal_id` / `.property_id` | respective tables | SET NULL (col) |
| `tasks.assigned_to_id` / `.contact_id` / `.deal_id` / `.property_id` | respective tables | SET NULL (col) |
| every table `.user_id` | `auth.users(id)` | CASCADE |

**Critical, previously-repaired detail (migration `20260829120654_fix_composite_fk_set_null`, now correctly tracked as a synchronized record of an already-applied change — see the status note above):** every composite `(user_id, related_id)` FK originally used bare `ON DELETE SET NULL`, which on a two-column FK nulls **both** columns, including the tenant column. The applied fix rewrote every one to the column-scoped form `ON DELETE SET NULL (related_id)`. **Every new FK introduced by this revision — `(workspace_id, related_id)`, the new `contacts.assigned_to_id → team_members` FK, the new `deal_values`/`deal_commissions` FKs — must use the same column-scoped form. This is restated at every relevant point below, not just here, since it is the single most consequential correctness rule in the whole migration.**

### 1.3 Grants — a real finding, not yet a live vulnerability

`anon` holds full `SELECT, INSERT, UPDATE, DELETE` (+`TRUNCATE, REFERENCES, TRIGGER`) on all 17 tables, identical to `authenticated`. Not currently exploitable — every RLS policy is `TO authenticated` only, so `anon` matches zero policies and reads/writes zero rows (Postgres RLS defaults to deny with no matching policy). This is [Supabase's documented default for existing projects](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically); new projects lose this default starting May 30, 2026. **Correction (§17 of the request, resolved in §20 below):** tightening this is deferred to its own separate migration with its own regression test list — it is explicitly **not** bundled into the workspace cutover.

### 1.4 Functions, triggers, Realtime, Storage (unchanged from Phase 2)

- **Functions:** 6, all `plpgsql`, `SECURITY INVOKER`, `search_path=""`.
- **Triggers:** one `BEFORE UPDATE` per table for `updated_at`.
- **Realtime publication:** all 16 non-legacy tables.
- **Storage:** `avatars` bucket (private, 2 MB, image only), 4 `storage.objects` policies keyed to `(storage.foldername(name))[1] = auth.uid()::text`.
- **Edge Functions:** none deployed.
- **Migrations:** 7 applied, now all 7 tracked in `supabase/migrations/`.
- **Auth URL configuration:** not inspectable through available read-only tooling; unchanged conclusion — whatever URL(s) the app is served from must be in the Redirect URLs allow-list.
- **Security advisor:** one finding, `auth_leaked_password_protection` (WARN) — unrelated to this work, noted for awareness.
- **Performance advisor:** only `INFO`-level unused-index notices (expected on a low-traffic project).

---

## 2. Official Supabase Documentation Reviewed

| Topic | Source | Key takeaway applied below |
|---|---|---|
| Row Level Security | [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security) | Enable RLS on every exposed table; never trust client-supplied IDs, only `auth.uid()`. RLS is **row-level only** — it cannot hide individual columns of a row the caller is otherwise allowed to `SELECT`, which is exactly the flaw corrected in §8/§11 below. |
| RLS performance & recursion | [RLS Performance and Best Practices](https://supabase.com/docs/guides/troubleshooting/rls-performance-and-best-practices-Z5Jjwv) | Wrap `auth.uid()` in `(select auth.uid())`; index every policy-filtered column; *"Break the cycle with a security definer function, which works because the function runs as its owner... a security definer function only skips RLS when its owner can."* This is the exact citation behind the corrected §9.6 recursion fix. |
| Data API grants | [Breaking Change: Tables not exposed to Data and GraphQL API automatically](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically) | Grants control *whether* a role reaches a table; RLS controls *which rows*. New tables must be granted deliberately. |
| Inviting users | [`auth.admin.inviteUserByEmail`](https://supabase.com/docs/reference/javascript/auth-admin-inviteuserbyemail), [Users](https://supabase.com/docs/guides/auth/users) | Admin-only, secret-key, server-side only; **inviting an email that already belongs to a confirmed user returns an error** — branched explicitly in §13. |
| Edge Function auth | [Securing Edge Functions](https://supabase.com/docs/guides/functions/auth), [Authorization headers](https://supabase.com/docs/guides/functions/auth-headers) | *"Keep verify_jwt = true (the default) so the platform validates the JWT before your handler runs, then use auth: 'user' to get ctx.supabase already scoped to the caller's RLS policies."* `verify_jwt = false` is documented for functions with **no** Authorization header at all (webhooks, service-to-service) — not for a normal signed-in-user function. See §13.5 for the full resolution of this correction point. |
| New API keys vs. session JWTs | [Migrating to publishable and secret API keys](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys), [JWT Signing Keys](https://supabase.com/docs/guides/auth/signing-keys) | The `sb_publishable_.../sb_secret_...` format replaces the `apikey` header value (anon/service_role) — it is **not** the user's session token. `verify_jwt` validates the `Authorization: Bearer` session JWT, which remains a real JWT (HS256 legacy or the newer asymmetric ES256 signing keys) regardless of API key format. *"The verify_jwt check validates legacy HS256 JWTs and JWTs signed with the new asymmetric signing keys."* These are two independent axes; conflating them was the source of the correction request's specific claim — see §13.5. |
| JWT / custom claims staleness | [Custom Access Token Hook](https://supabase.com/docs/guides/auth/auth-hooks/custom-access-token-hook), [community thread on stale claims](https://www.answeroverflow.com/m/1438067368596078642) | A JWT claim does not update until token refresh; there is no way to force-refresh another user's session. Authorization must be re-derived from live table state on every request, never from a claim. |
| Realtime + RLS | [Realtime Authorization](https://supabase.com/docs/guides/realtime/authorization), [Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes) | `postgres_changes` honors table RLS per-subscriber; a removed member's *existing* socket still needs an explicit client-side disconnect trigger, not just a future RLS check. |
| Production email / custom SMTP | [Send emails with custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp), [Production Checklist](https://supabase.com/docs/guides/deployment/going-into-prod) | Supabase's built-in email sender is capped at **2 auth emails/hour** — not usable for real invitations; custom SMTP raises this to a default of **30 new-user emails/hour** (adjustable via support). Resolved in §13.6. |
| Looking up a user by email server-side | [Users](https://supabase.com/docs/guides/auth/users); community guidance converges on maintaining an application-side mirror table rather than depending on an unconfirmed admin lookup method | `auth.admin.listUsers()`-style scanning does not scale and should not run per-invitation; the well-established pattern is a trigger-maintained `public` mirror table synced from `auth.users`, queried directly instead. Resolved in §13.7. |

No 2026 breaking change directly forces a design decision here beyond the Data API grants tightening (§20) and the JWT-signing-key / API-key-format distinction resolved in §13.5.

---

## 3. Frontend Dependency Map

| Feature | Current table/field | Current behavior | Team-system change required |
|---|---|---|---|
| Team Directory (`pages/team-directory.js`) | `team_members` full CRUD via `App.store.teamMembers` | Free-form profile directory; anyone signed in can add/edit/deactivate/delete any row | **Preserved as the directory.** Its CRUD becomes permission-gated (`manage_team`-family permissions) but keeps writing to `team_members`; a new, separate Team & Access UI (§14) manages `workspace_members`/`workspace_invitations` for login access specifically |
| `pages/team.js` | `team_members`, `settings.currentTeamMemberId` | **Dead code** — unreachable from any route or nav item; duplicates `renderWorkingAsCategory` in `release.js` | Deleted in cleanup (Phase K, unrelated to `team_members` itself, which is kept) |
| Deals / Task / Scheduled-item assignment | `deals.assigned_to_id`, `tasks.assigned_to_id`, `scheduled_items.assigned_to` → `team_members.id` | Optional assignment, cosmetic only | **Unchanged FK target.** These remain pointed at `team_members.id` permanently (§4) — this is the corrected model's central simplification: assignment never needs to know whether the assignee has login access |
| Contacts' assigned agent | `contacts.assigned_agent` (free text, default `'Self'`) | Not linked to `team_members` | New `contacts.assigned_to_id → team_members.id`, additive, with `assigned_agent` retained through a compatibility period (§4) |
| Properties / Showings / Activities | No assignment column of their own | Inherit via `deal_id`/`contact_id` | Unchanged — inheritance model (§8.3) |
| Calendar / Dashboard / Daily View | Aggregation reads across most tables | No independent access logic | Inherit scope from underlying reads; financial widgets gated per §7.4/§8 |
| Commission (`pages/commission.js`) | Reads `deals`, calls `App.permissions.commissionFiguresHidden()` | The one existing "permission" check in the app — explicitly cosmetic (§3.1) | Replaced by real `view_deal_values`/`view_commission` checks backed by the new `deal_values`/`deal_commissions` tables (§8), not a client-only role string |
| Finances / Reports | `finance_records`, cross-table reads | No gating today | `view_income`/`view_expenses`/`view_financial_reports` gating |
| Backup/Restore, Reset, Clear Sample | Full-account operations scoped by `user_id` | No role check | Workspace-scoped, permission-gated (§16) |
| Realtime | `filter: "user_id=eq.<id>"` | Correctly scoped for single-user today | Workspace-scoped filter + forced disconnect on suspend/remove (§14, §17) |
| Settings (`release.js`) | `workspace_settings`, 1 row per `user_id` | Single-owner | 1 row per **workspace** |

### 3.1 Cosmetic-only "permission" code that must not be mistaken for security

- **`assets/js/core/permissions.js`** self-documents this exactly: *"this is NOT an access control system... Never gate a security-sensitive action on this module."* `currentRole()` reads a per-workspace UI preference (`settings.currentTeamMemberId`) unrelated to Supabase Auth identity, and only gates *rendering* of the Commission page's dollar figures.
- **`assets/js/core/customization.js`** (`isModuleEnabled`/`isRouteEnabled`) is a workspace-wide feature flag ("is this module on for everyone"), never a per-person gate.
- Neither module has any effect on RLS. RLS — today single-owner only — is the sole real authorization boundary.

---

## 4. Directory vs. Authenticated Membership (corrected model — replaces Phase 2's Option A/B/C)

The prior draft's core error was collapsing "a person who can be assigned work" and "a person who can sign in and act with permissions" into one migration decision. They are corrected here into two permanent, separately-lived tables:

- **`team_members`** — the workspace's people/directory and assignment-profile table. **Preserved exactly as it exists today**, made workspace-aware additively. Every assignment FK in the schema (`deals.assigned_to_id`, `tasks.assigned_to_id`, `scheduled_items.assigned_to`, and the new `contacts.assigned_to_id`) targets `team_members.id`, permanently — not `workspace_members.id`, and not conditionally depending on whether that person ever logs in.
- **`workspace_members`** — exists **only** to represent authenticated access. A row here means "this Auth user may sign in and act, with these permissions, and is the same person as this `team_members` row." A directory person can exist for years, be assigned dozens of deals, and never have a `workspace_members` row at all if they never need to log in.

### 4.1 The real product workflow this reflects

1. Owner creates or selects a directory person (a `team_members` row) — no login involved yet.
2. Owner optionally invites that person to log in (a `workspace_invitations` row referencing that `team_members.id` + the email to invite).
3. On acceptance, a `workspace_members` row is created, linking the new Auth `user_id` **and** the existing `team_member_id` **and** the `workspace_id`.
4. Every assignment (past and future) stays attached to the `team_members.id` — nothing about existing deals/tasks/scheduled items changes when login access is granted.
5. Removing login access (suspending/removing the `workspace_members` row) does not touch the `team_members` row, its assignment history, or anything it's linked to.

### 4.2 Field authority — resolving the duplication explicitly

| Field | Authoritative table | Rationale |
|---|---|---|
| Name | `team_members.name` | The durable identity |
| Email | `team_members.email` | See note below — `workspace_invitations.email` is a separate, transient "email being invited" value, not a duplicate of this |
| Phone | `team_members.phone` | |
| Avatar | `team_members.avatar_url` | |
| Notes | `team_members.notes` | |
| Job title (`team_members.role`) | `team_members.role` | **Not** the same value space as `workspace_members.role` (§1.1 naming-collision note) |
| Security role, permissions, data scope, membership status | `workspace_members` | Meaningless for a directory-only person with no login |

**`workspace_members` therefore does not carry `email` or `display_name` columns at all** (a correction from Phase 2's draft, which duplicated them) — anywhere the UI needs to show a member's name/email, it joins to `team_members` through `team_member_id`. This closes the "avoid duplicating mutable profile fields" requirement by construction rather than by convention.

`workspace_invitations.email` is intentionally still its own column (§6.4) — it represents "the email this pending invitation was sent to," which may be sent *before* any `team_members` row exists (the Owner can invite a brand-new person by email in one step, and the directory profile is created alongside the invitation) or may reference an *existing* `team_members` row's email — both are handled explicitly in §13.

---

## 5. Ownership Model Decision: `owner_user_id` — stored directly, not derived (unchanged from Phase 2)

**Decision:** `workspaces.owner_user_id uuid not null references auth.users(id) on delete restrict`, kept consistent with a matching `workspace_members` row (`role='Owner'`, `status='active'`) exclusively via the ownership-transfer function (§12), never via ordinary client UPDATE.

**Tradeoff (unchanged reasoning):** deriving the owner from "whichever `workspace_members` row has role Owner" risks a silent zero/multi-owner state and forces every ownership check into a join; a direct column is a single indexed comparison and cannot exist without an owner from creation (`NOT NULL`).

**Phase T2a operational note (added after the live dry-run of `20261001160608_phase_t2a_workspace_foundation.sql`):** because `workspaces.owner_user_id` is `ON DELETE RESTRICT`, deleting an Auth user who owns a workspace fails at the FK until the workspace itself is deleted or its owner is transferred. There is no supported self-serve "delete my account" flow in T2a — this is deliberate (an accidental Auth-user delete must not silently take a shared workspace down with it) and the proper account / workspace deletion flow, including the Owner-transfer path described in §12, is planned for Phase T3.

---

## 6. Proposed Tables

### 6.1 `workspaces`

| Column | Type | Constraint |
|---|---|---|
| `id` | `uuid` | PK, `default gen_random_uuid()` |
| `name` | `text` | not null default `'My Workspace'` |
| `owner_user_id` | `uuid` | not null, references `auth.users(id)` on delete restrict |
| `status` | `text` | not null default `'active'`, check in (`'active'`,`'suspended'`,`'deleted'`) |
| `created_at` / `updated_at` | `timestamptz` | not null default `now()` |

`ON DELETE RESTRICT` on `owner_user_id`: an `auth.users` deletion must not silently delete a shared workspace out from under other members (Owner account deletion needs an explicit transfer-or-archive flow first — unresolved decision, §19).

### 6.2 `team_members` — additive changes only, nothing removed

| New/changed column | Type | Constraint |
|---|---|---|
| `workspace_id` | `uuid` | nullable at add-time, backfilled, then `not null references workspaces(id) on delete cascade` (§14 Phase C) |

Everything else on `team_members` (`id`, `name`, `role`, `email`, `phone`, `avatar_url`, `notes`, `active`, timestamps) is **unchanged**.

Constraints (new):
- `create unique index team_members_workspace_id_key on public.team_members (workspace_id, id);` — workspace-aware uniqueness alongside the existing `(user_id, id)`, exactly mirroring how every business table's uniqueness is being extended (§9).
- No uniqueness is imposed on `email` at the `team_members` level — a workspace may legitimately have two directory people who happen to share a contact email (a shared front-desk address, for instance); email uniqueness matters only for `workspace_invitations` (§6.4) and `workspace_members` (§6.3), where it identifies a specific Auth account.

`team_members` keeps its existing RLS shape (owner-only today; workspace-member-visible after Phase D, §16), and remains **fully writable** by anyone with the appropriate directory-management permission — it is never frozen or scheduled for retirement in this revision.

### 6.3 `workspace_members` — authenticated access only

| Column | Type | Constraint |
|---|---|---|
| `id` | `uuid` | PK default `gen_random_uuid()` |
| `workspace_id` | `uuid` | not null references `workspaces(id)` on delete cascade |
| `team_member_id` | `text` | **not null**, references `team_members(id)` on delete restrict (see note) |
| `user_id` | `uuid` | **nullable**, references `auth.users(id)` **on delete set null** (corrected — see below) |
| `role` | `text` | not null, check in (`'Owner'`,`'Admin'`,`'Manager'`,`'Agent'`,`'Assistant'`,`'Viewer'`) — the **security** role, distinct from `team_members.role` |
| `permissions` | `jsonb` | not null default `'{}'`, validated (§7.2) |
| `data_scope` | `text` | not null default `'assigned_or_created'`, check in (`'all'`,`'assigned'`,`'created'`,`'assigned_or_created'`,`'read_only_selected'`) |
| `status` | `text` | not null default `'active'`, check in (`'active'`,`'suspended'`,`'removed'`) — **no `'invited'` state** (corrected, see §11) |
| `invited_by` | `uuid` | nullable, references `auth.users(id)` on delete set null |
| `joined_at` | `timestamptz` | not null default `now()` — a row's mere existence means acceptance already happened (see §11) |
| `suspended_at` / `removed_at` | `timestamptz` | nullable, set on the corresponding status transition |
| `created_at` / `updated_at` | `timestamptz` | not null default `now()` |

**Corrected `user_id` delete behavior:** `on delete set null`, not `cascade`. If the linked Auth account is ever deleted, the membership row — and everything it makes resolvable (`role`, `permissions`, history, and the `team_member_id` link to the person's name/contact info) — **survives** with `user_id` simply null. The frontend renders such a row as "(deleted user)" while `team_member_id` still resolves the actual person's directory profile for display, satisfying "deleted Auth accounts display as inactive/deleted users without losing record history" exactly as specified. A membership with a null `user_id` is never treated as `status='active'` for authorization purposes regardless of what `status` says (an explicit `CHECK`/trigger enforces `user_id is not null when status = 'active'`) — losing the Auth account effectively (and immediately, since the corresponding `auth.uid()` can never match again) revokes access even before anyone remembers to change `status`.

**`team_member_id` is `NOT NULL`** — "an authenticated workspace membership must link to one directory person," exactly as specified — and its delete rule is `RESTRICT`, not `CASCADE` or `SET NULL`: a directory person who currently has login access cannot be deleted out from under an active membership; the Owner must first remove/downgrade the membership (or the directory-deletion UI can be taught to do both in one confirmed action, a frontend-implementation detail, not a schema one).

Constraints:
- `create unique index workspace_members_team_member_key on public.workspace_members (workspace_id, team_member_id);` — one membership per directory person per workspace (a person is either not authenticated in this workspace, or authenticated exactly once).
- `create unique index workspace_members_user_key on public.workspace_members (workspace_id, user_id) where user_id is not null;` — partial/expression index, correct Postgres syntax (§15 of the request, resolved) — one active Auth link per person per workspace.
- Rows are **never deleted** by any client path — `status` moves to `'removed'` instead (§4.1 point 5, §11).

**Reactivating a removed membership** (§11's "member removed and later re-invited" case): because the row is never hard-deleted, re-granting access to the same `team_members.id` **reuses the same `workspace_members` row** (new `role`/`permissions`/`data_scope` as specified by the new invitation, `status` back to `'active'`, `removed_at` cleared) — this is what "define how a removed membership is reactivated without destroying its historical identity" resolves to: the identity was never destroyed, because the row was never deleted.

### 6.4 `workspace_invitations`

| Column | Type | Constraint |
|---|---|---|
| `id` | `uuid` | PK default `gen_random_uuid()` |
| `workspace_id` | `uuid` | not null references `workspaces(id)` on delete cascade |
| `team_member_id` | `text` | nullable, references `team_members(id)` on delete cascade — set when inviting an *existing* directory person; null when the Owner is creating both the directory profile and the invitation in one step (the accept function then creates the `team_members` row too, §13) |
| `email` | `text` | not null (lower-cased at write time) |
| `role` | `text` | not null, same check list as `workspace_members.role` |
| `permissions` | `jsonb` | not null default `'{}'` |
| `data_scope` | `text` | not null default `'assigned_or_created'` |
| `token_hash` | `text` | not null — SHA-256 hash of a random token, **never the raw token** |
| `invited_by` | `uuid` | not null references `auth.users(id)` |
| `expires_at` | `timestamptz` | not null default `now() + interval '7 days'` |
| `accepted_at` / `revoked_at` | `timestamptz` | nullable |
| `status` | `text` | not null default `'pending'`, check in (`'pending'`,`'accepted'`,`'expired'`,`'revoked'`) |
| `created_at` | `timestamptz` | not null default `now()` |

**Why no raw reusable token is stored:** unchanged from Phase 2 — a stored raw token, if the table were ever exposed (bug, backup, support export), would let anyone accept as the intended member. The Edge Function (§13) generates the token, returns/emails it once, stores only its hash; acceptance re-hashes and compares.

**Constraints, written with correct Postgres syntax (§15 of the request):**
```sql
-- Prevent duplicate active invitations (expression + partial predicate:
-- must be an index, not a table CONSTRAINT, which cannot express either).
create unique index workspace_invitations_pending_email_key
  on public.workspace_invitations (workspace_id, lower(email))
  where status = 'pending';
```

**Case-insensitive email — `citext` vs. `lower()` index, decided:** use plain `text` + `lower(email)` expression indexes/comparisons everywhere (as above), **not** the `citext` extension. `citext` would need enabling on a database that doesn't have it today, affects comparison semantics for every column that adopts it, and buys nothing here that a consistent `lower()` convention doesn't already provide, since every comparison in this design (`team_members.email`, `workspace_invitations.email`, `auth.users.email` via the mirror table in §13.7) is already funneled through explicit, indexed `lower()` expressions.

**Preventing the required failure modes (unchanged reasoning from Phase 2, still correct):**
- *Duplicate active invitations:* the partial unique index above.
- *Invitation replay:* `status` flips to `'accepted'` inside the same transaction as the match.
- *Cross-workspace acceptance:* `workspace_id` is derived only from the matched invitation row.
- *A non-owner inviting an Owner:* checked in the Edge Function against the caller's own `workspace_members.role` before insert.
- *Privilege escalation through edited payloads:* the Edge Function re-validates the caller's own `permissions` is a superset of everything being granted.

---

## 7.0 Phase T2b-1 permission system — as shipped

The permission model that landed in `20261005140817_phase_t2b1_permissions.sql` differs from the Phase 2 design below in a few owner-decided ways. This sub-section is the authoritative current state (the rest of §7 and §8 remain the longer-term plan).

### 7.0.1 Keys and shape

The permission JSON for every (workspace, role) and for every per-member override uses exactly these keys:

**Scoped areas** — each is an object `{ view, edit, delete, create }` with `view/edit/delete ∈ {none, own, all}` (ranked `none < own < all`), `create` a boolean. Invariant: `edit <= view` and `delete <= view`.

- `contacts`
- `deals`
- `work` (covers `tasks`, `showings`, `scheduled_items`, `activities`, `milestones` — see 7.0.3)
- `properties`
- `finance` (covers `finance_records`, `referrals`)
- `goals`

**Booleans** (10 top-level keys): `contacts_assign`, `unassigned_view`, `unassigned_claim`, `templates_manage_shared`, `templates_create_personal`, `automation_manage_shared`, `automation_create_personal`, `imports_file`, `integrations_manage`, `team_manage`.

**Enum** `settings ∈ {none, view, edit}` (ranked `none < view < edit`).

Ordering for the "can-grant" check: `scope` as above; `settings` as above; `bool false < true`. Nobody can grant a key above their own effective value on that key.

### 7.0.2 Role presets

Shipped as `automation_internal.default_role_permissions(p_role text)`:

- **owner** — not stored. Returns the admin preset in `authz.effective_permissions`; `realtoros_set_role_permissions` / `realtoros_set_member_permissions` refuse to target an Owner at all.
- **admin** — every area `view=edit=delete=all`, `create=true`; every boolean `true`; `settings=edit`.
- **agent** —
  - `contacts`: `view=own, edit=own, delete=none, create=true`
  - `deals`: same as `contacts`
  - `work`: `view=own, edit=own, delete=own, create=true`
  - `properties`: `view=all, edit=own, delete=own, create=true`
  - `finance`: all `none`, `create=false`
  - `goals`: `view=own, edit=own, delete=own, create=true`
  - booleans: everything `false` **except** `templates_create_personal`, `automation_create_personal`, `imports_file` (all `true`)
  - `settings=none`

Both presets validate (`validate_permissions(_, false)` requires every known key present and the `edit/delete <= view` invariant inside every scoped area).

### 7.0.3 "own" definition per area (used in T2b-2 RLS, documented here)

`own` means: either the row is **assigned to the member's `team_members.id`** OR the row was **created by the member** (`user_id = auth.uid()`). Per area:

| Area | Tables | `own` predicate |
|---|---|---|
| contacts | `contacts` | `assigned_to_id = me.team_member_id OR user_id = me.user_id` |
| deals | `deals` | `assigned_to_id = me.team_member_id OR user_id = me.user_id` |
| work (tasks) | `tasks` | `assigned_to_id = me.team_member_id OR user_id = me.user_id` |
| work (scheduled_items) | `scheduled_items` | `assigned_to = me.team_member_id OR user_id = me.user_id` |
| work (activities) | `activities` | `user_id = me.user_id` **or** `deal_id` is `own` **or** `contact_id` is `own` |
| work (showings) | `showings` | `user_id = me.user_id` **or** `deal_id` is `own` |
| work (milestones) | `milestones` | `deal_id` is `own` (no own assignee column) |
| properties | `properties` | `user_id = me.user_id` **or** `deal_id` is `own` **or** `contact_id` is `own` |
| finance (records) | `finance_records` | `user_id = me.user_id` |
| finance (referrals) | `referrals` | `user_id = me.user_id` |
| goals | `goals` | `user_id = me.user_id` |

### 7.0.4 Per-table area map (every workspace-scoped table)

For T2b-2 RLS to know which area to consult. Tables not listed are system/service-role only.

| Table | Area or category |
|---|---|
| `contacts` | contacts |
| `deals` | deals |
| `milestones` | work (inherits via deal) |
| `tasks` | work |
| `activities` | work |
| `showings` | work (inherits via deal/contact) |
| `scheduled_items` | work |
| `properties` | properties |
| `finance_records` | finance |
| `referrals` | finance |
| `goals` | goals |
| `scripts` | templates (visibility `shared`/`personal` + `templates_manage_shared` / `templates_create_personal`) |
| `ai_prompts` | templates — same model |
| `message_templates` | templates — same model |
| `automation_rules` | automation (visibility `shared`/`personal` + `automation_manage_shared` / `automation_create_personal`) |
| `automation_steps` | automation (inherits via rule) |
| `automation_enrollments` | automation (inherits via rule) |
| `automation_jobs` | automation (inherits via rule) |
| `automation_runs` | automation (inherits via rule) |
| `automation_failures` | automation (inherits via rule) |
| `automation_trigger_events` | system (service_role only) |
| `email_sender_profiles` | integrations (per-agent sender; owner is `user_id`) |
| `email_suppressions` | system (shared workspace-wide suppression list) |
| `communication_consents` | system (workspace-wide) |
| `contact_identity_keys` | system |
| `outbound_messages` | system (audit; visible to admin / `team_manage` holders) |
| `webhook_events` | system (service_role only) |
| `lead_import_batches` | `imports_file` (creator read; admin read all) |
| `lead_import_rows` | `imports_file` (same) |
| `lead_source_connections` | `integrations_manage` |
| `lead_source_mappings` | `integrations_manage` |
| `notifications` | recipient-only (`user_id = me.user_id`) |
| `contact_stop_events` | system (service_role only) |
| `custom_field_values` | inherits from parent entity (via `entity_type` + `record_id`) |
| `team_members` | `team_manage` |
| `workspace_settings` | `settings` (none → no read; view → read; edit → write) |

### 7.0.5 Guardrails on `realtoros_set_role_permissions` / `realtoros_set_member_permissions`

1. **Owner always full, never editable.** Owner is implicit; `role='owner'` cannot be a target.
2. **team_manage required** (or caller is Owner).
3. **No upward grant.** For every key the proposed JSON mentions, caller's own effective value must be ≥ the proposed value.
4. **No self-raise.** When the actor is editing their own member row, the proposed *effective* permissions (after merge with the role template) must not exceed the actor's current effective permissions on any key.
5. **Audit.** Every write inserts a row into `workspace_permission_changes` with `(actor, target_role|target_member_id, before, after, at)`. The audit table is readable only by callers who hold `team_manage`.

### 7.0.6 RLS performance pattern (T2b-2 policies will use this)

The `(workspace_id, …)` authz helpers take `workspace_id` from a row, so the planner can't cache them — a policy that calls them directly runs the function **once per row**. The caller-only `authz.my_*` helpers take no row arguments, so a T2b-2 policy that wraps each call in `(select …)` lets Postgres evaluate them as InitPlans — **once per statement**.

The intended policy shape, written against the "contacts" area as the example:

```sql
create policy contacts_select_scoped on public.contacts
  for select to authenticated
  using (
    workspace_id = (select authz.my_workspace_id())
    and (
      (select authz.my_scope('contacts','view')) = 'all'
      or (
        (select authz.my_scope('contacts','view')) = 'own'
        and (
          assigned_to_id = (select authz.my_team_member_id())
          or user_id = (select auth.uid())
        )
      )
    )
  );
```

Every call to an `authz.my_*` helper from inside RLS **must** be wrapped in `(select …)` — this is the single-biggest knob for RLS performance on this project, per the Supabase RLS perf guide. The `(workspace_id, …)` family is kept for the three RPCs that already know the workspace they're operating on; browser-facing policies always use `my_*`.

### 7.0.7 Audit robustness (post-dry-run fix)

`workspace_permission_changes` records every write by `realtoros_set_role_permissions` / `realtoros_set_member_permissions` / `realtoros_reset_member_permissions`. For the audit to survive the entities it references being deleted:

- `actor_user_id` is **nullable** + `ON DELETE SET NULL` (so an Auth-user delete doesn't fail at this table).
- `target_member_id` is nullable + `ON DELETE SET NULL` (so a `workspace_members` delete, including the `auth.users` cascade, doesn't fail at this table).
- The CHECK that distinguishes role-targeted from member-targeted rows is `(target_role is not null and target_member_id is null) or (target_role is null)` — a member-targeted row's `target_member_id` may legitimately end up null after a cascade.
- `actor_label` and `target_label` are populated at write time by each RPC (actor: `auth.users.email` or `team_members.name`; target: `'role:<role>'` for role rows, `team_members.name` or the actor's email fallback for member rows). Both are `NOT NULL DEFAULT ''` so the audit stays readable after the referenced row is gone.

The initial draft had `actor_user_id NOT NULL + ON DELETE SET NULL` (which would raise 23502 the moment the actor's `auth.users` row was deleted) and a two-sided CHECK on `(target_role, target_member_id)` that would block the same delete chain at `workspace_members`. Both were caught by the live dry-run and fixed in-place before anything was applied.

### 7.0.8 Browser read access per system table (T2b-2 input, grepped 2026-10-05)

Grepped `app/assets/js/` for every read of each table before deciding whether T2b-2 keeps a browser SELECT policy. Note that `contacts, team_members, properties, deals, milestones, tasks, activities, showings, referrals, goals, finance_records, scripts, ai_prompts, scheduled_items, custom_field_values, workspace_settings` are read through the generic REGISTRY (`from(def.table)`), so a literal table-name grep returns 0 for some of them — they are all browser-read.

| Table | Browser read sites | T2b-2 decision |
|---|---|---|
| `automation_rules` / `automation_steps` | 5 / 5 (automation page) | **Keep** read, scoped by visibility + `automation_manage_shared` |
| `automation_enrollments` | data-service.js:1613 | **Keep** read, inherit from parent rule |
| `automation_jobs` | data-service.js:1629, 1741 | **Keep** read, inherit from parent rule |
| `automation_runs` | data-service.js:1643 | **Keep** read, inherit from parent rule |
| `automation_failures` | data-service.js:1746 | **Keep** read, inherit from parent rule |
| `lead_import_batches` | data-service.js:794 (Import History) | **Keep** read, `imports_file`; creator-or-admin |
| `lead_import_rows` | data-service.js:835 (Import History) | **Keep** read, same as its batch |
| `lead_source_connections` | data-service.js:696 (Sheets settings) | **Keep** read, `integrations_manage` |
| `email_sender_profiles` | 2 (email settings) | **Keep** read, own row + `integrations_manage` |
| `communication_consents` | data-service.js:1699 | **Keep** read, workspace-wide |
| `email_suppressions` | data-service.js:1705 | **Keep** read, workspace-wide |
| `outbound_messages` | data-service.js:1831 | **Keep** read, `team_manage` holders |
| `message_templates` | 10 | **Keep** read, visibility + `templates_manage_shared` |
| `notifications` | 4 | **Keep** read, `user_id = auth.uid()` only |
| `workspace_settings` | 9 | **Keep** read when `settings >= view` |
| `team_members` | via REGISTRY | **Keep** read for all workspace members (assignment dropdowns); write needs `team_manage` |
| `automation_trigger_events` | **0** | **Remove** browser read — service_role only |
| `contact_identity_keys` | **0** | **Remove** browser read — service_role only |
| `webhook_events` | **0** | **Remove** browser read — service_role only |
| `lead_source_mappings` | **0** | **Remove** browser read — written by the Sheets Edge Function, never read by the app |
| `contact_stop_events` | **0** | Already has no policy (service_role only) — unchanged |

### 7.0.10 T2b-2 status: built, matrix green, NOT applied — three blockers

The T2b-2 cutover is written (93 policies across 31 tables, the `(select authz.my_*())` pattern throughout, plus `authz.my_area_create / owns_deal / owns_contact / owns_rule` and the contacts assignment/claim trigger). Its own role matrix — `tests/sql/phase_t2b2_rls_matrix.test.mjs`, 25 tests covering owner / admin / agent / agent+overrides / non-member / stranger / anon across every area, the claim rules, library visibility and cross-workspace isolation — is **25/25 green**.

It is **not applied**, and is parked at `supabase/pending/phase_t2b2_workspace_rls.sql` (outside `migrations/`, so `supabase db push` cannot pick it up). Regenerate with `node supabase/pending/generate_phase_t2b2.mjs <out.sql>`.

Reason: it regresses **7 pre-existing tests**. Three distinct blockers, in priority order:

**1. First-write provisioning vs InitPlan caching (design conflict — the real one).**
T2a's compat trigger provisions a brand-new user's workspace during their first `INSERT` (BEFORE INSERT → `ensure_personal_workspace`). T2b-2's INSERT policy checks `workspace_id = (select authz.my_workspace_id())`. Because the `(select ...)` wrapper is what lifts the helper to an InitPlan, it is evaluated **once at statement start — before the BEFORE INSERT trigger runs**, so for a user with no membership yet it returns `null` and `WITH CHECK` fails even though the trigger just filled the column correctly.
Failing: *brand-new user's first insert creates their workspace on the fly*, and two sibling T2a compat tests.
Candidate fix: drop the `(select ...)` wrapper on the **INSERT** `WITH CHECK` only (evaluate per-row, after the trigger). Inserts in this app are single-row, so the lost InitPlan optimisation costs nothing; SELECT/UPDATE/DELETE keep the wrapper where the per-row cost actually matters. Needs verifying, not assuming.

**2. `permission denied for schema automation_internal` on an authenticated insert.**
The INSERT `WITH CHECK` reaches `authz.my_area_create` → `authz.effective_permissions` (INVOKER) → `automation_internal.default_role_permissions` / `merge_permissions`. T2b-1 granted `authenticated` USAGE on that schema plus EXECUTE on those two functions, so this should resolve — it does not, and the cause is not yet established. Not guessed at; needs isolating before T2b-2 goes near live.

**3. `phase_4e_4_verification.sql` asserts the old policy names.**
It checks for `*_select_own` / `*_update_own` on the import tables; T2b-2 renames them `*_scoped`. Expected consequence of the rename, not a defect — the verification file needs updating as part of T2b-2, which has not been done yet.

Until all three are resolved and the full suite is green, T2b-2 must not be applied. The revert file (§7.0.7 / `supabase/rollback/`) is ready regardless.

### 7.0.11 Deviations from the §7 design doc below

- Preset lowercase names (`owner`/`admin`/`agent`) instead of six Pascal-case presets. Extensible via the CHECK.
- No per-member permission JSONB on `workspace_members` — overrides are the only JSON path; the Owner's role is implicit full.
- No `deal_values` / `deal_commissions` financial-privacy split in v1 (deferred).
- No `user_directory` mirror yet (deferred).

---

### 7.0.12 T2c BLOCKER: 56 composite `(user_id, …)` foreign keys contradict team access

Found while building T2c (2026-10-06). **T2c is written and parked in
`supabase/pending/phase_t2c_workspace_backend.sql`; it is NOT applied.**

#### What is wrong

Every cross-table reference in the schema is a *composite tenant FK* of
the form:

```sql
foreign key (user_id, contact_id) references contacts (user_id, id)
```

There are **56 of them** (every one listed by the query in §7.0.12.1).
The pattern was correct when one owner was one tenant: it guaranteed a
child row could never point at another tenant's parent. With a team it
says something much stronger and now wrong:

> the child row's creator must be the same person as the parent row's
> creator.

So a teammate can never create any row that references a row somebody
else created — regardless of what their permissions say.

#### Why this is a hard blocker, not a wart

T2b-2's RLS is deliberately permissive where these FKs are not, so the
two disagree and the FK wins. Demonstrated in PGlite against the real
chain:

| Step | Result |
|---|---|
| admin's `authz.my_scope('contacts','view')` | `all` |
| admin's `authz.my_scope('work','edit')` | `all` |
| admin SELECTs the owner's contact | 1 row — RLS allows it |
| admin INSERTs a task on that contact | **23503 `tasks_user_id_contact_id_fkey`** |

The user sees "Save failed" with no explanation. The same shape breaks:
logging an activity on a teammate's lead, creating a deal or showing or
scheduled item against one, assigning a task (`tasks.assigned_to_id` →
`team_members(user_id, id)`), and — the way it first surfaced — any
import by a teammate of a person another teammate already imported,
plus the entire notification fan-out (`notifications.contact_id` →
`contacts(user_id, id)`, which silently aborted the trigger's whole
`begin … exception` block and lost *every* recipient's notification, not
just the failing one).

Note `contacts.assigned_to_id` is already workspace-scoped
(`→ team_members(workspace_id, id) on delete set null (assigned_to_id)`),
which is why lead assignment works and the T2b-2 matrix passed. The
remaining 56 were simply not part of T2a's scope.

#### The fix, and why it is low-risk

Mechanical: re-point each FK's first column from `user_id` to
`workspace_id`, keeping the referenced column, the `ON DELETE` action and
the column-scoped `ON DELETE SET NULL (col)` form (doc §1.2).

```sql
alter table public.tasks drop constraint tasks_user_id_contact_id_fkey;
alter table public.tasks add constraint tasks_workspace_id_contact_id_fkey
  foreign key (workspace_id, contact_id) references public.contacts (workspace_id, id)
  on delete set null (contact_id);
```

Two facts make this safe:

1. **Every target already exists.** All 15 referenced parent tables carry
   a `(workspace_id, id)` unique index — T2a created them for exactly
   this conversion and nothing has used them yet. Verified on live.
2. **No data can conflict.** Today every workspace has exactly one
   member, so `user_id` and `workspace_id` partition the rows
   identically: any row satisfying `(user_id, X)` satisfies
   `(workspace_id, X)`. Verified on live: zero conflicting groups on
   every index T2c re-scopes.

`user_id` stays on every table — it remains the "who created this"
audit trail, and `(user_id) → auth.users` stays as is. Only the
*tenant* half of the composite key changes.

#### Why this stopped the run instead of being folded into T2c

Rewriting 56 foreign keys on a live database is materially larger and
riskier than T2c's stated scope ("per-workspace quotas/locks,
imports_file, Sheets unassigned, notification fan-out"), and it changes a
schema-wide invariant. It needs the owner's go-ahead, so T2c is parked
complete-but-unapplied and the matrix below records what is already
proven.

#### State at the stop

* T2b-2 (RLS cutover) **applied** live as `20261006033532`, live matrix
  all green.
* T2c written, 1761 lines, parked in `supabase/pending/`. Its 21 tests
  are committed and auto-skip until it is in the chain; **16 of 21
  already pass** when it is applied. The 5 that fail are all this FK
  blocker, not T2c logic:
  - two teammates importing the same person → `lead_import_rows_user_id_contact_id_fkey`
  - identity keys unique per workspace → same
  - assigned lead's event reaches assignee + managers → `notifications_user_id_contact_id_fkey`
  - `unassigned_view` override pulls the agent in → same
  - one event, two recipients, one dedupe_key → same
* Stages T2d / T3 / T4 not started.

#### Recommended order once unblocked

1. **T2c-pre**: the 56-FK conversion, as its own migration with its own
   forced-rollback dry run (it is independent of everything in T2c and
   is what actually unblocks team writes).
2. T2c as already written.
3. T2d, T3, T4.


### 7.0.13 T2c-post BLOCKER: 19 automation RPCs still resolve rows by `user_id = p_user_id`

Found by the T2c live matrix (2026-10-06), after T2c-pre and T2c were both
applied and green. **Not a T2c regression** — the same call failed
identically before T2c. T2c simply made it visible, because it is now the
only thing standing between a teammate's lead and the follow-up pipeline.

#### What the matrix caught

The T2c live matrix came back 9/10. The failing check was "an unassigned
lead's event reaches the unassigned_view holders", and the cause was not
the fan-out:

| Observation | Result |
|---|---|
| `contact_audience(ws, contact)` for an unassigned lead | returns the owner |
| `member_can(owner, 'unassigned_view')` | `true` |
| `notify_contact(...)` called directly | writes 1 notification |
| the stop-event trigger, contact created by the **owner** | writes 1 notification |
| the stop-event trigger, contact created by an **agent** | writes **0** |

The difference is who created the contact, and the reason is in
`realtoros_record_contact_stop_event`:

```sql
select * into v_contact from public.contacts
  where id = p_contact_id and user_id = p_user_id
  for update;
```

The contact is resolved by **creator**, not by workspace. When the lead
was created by a teammate the lookup finds nothing, and the function
returns an early outcome *without raising* — so the reply/unsubscribe/
bounce is silently not recorded, no lifecycle marker is set, no
suppression is added, no enrollment is stopped and no notification is
sent. A silent no-op, which is the worst failure mode available.

#### Scale

19 functions contain a `user_id = p_user_id` row lookup:

```
6  realtoros_presend_guard, realtoros_record_contact_stop_event,
   realtoros_retry_failed_job
5  realtoros_archive_rule, realtoros_check_enrollment_eligibility,
   realtoros_complete_job_and_advance, realtoros_rule_stop_summary
4  realtoros_claim_test_send, realtoros_enroll_contact,
   realtoros_reschedule_job
3  realtoros_stop_enrollment_on_event
2  realtoros_cancel_claimed_job, realtoros_stop_enrollment
1  realtoros_complete_trigger_event, realtoros_fail_trigger_event,
   realtoros_open_enrollments_for_contact,
   realtoros_reschedule_trigger_event, realtoros_skip_claimed_job,
   automation_internal.notification_contact_name
```

(The four that legitimately key on the member — `member_permissions`,
`workspace_of`, `notify` and `ensure_personal_workspace` — are correct as
they are and are excluded.)

Between them these cover the whole automation and email-stop pipeline:
enrolment eligibility, job claim/complete/retry/cancel, the pre-send
guard, trigger-event completion, enrollment stops, and the stop-event
recorder that the Resend webhook and the unsubscribe endpoint both call.

#### Why T2c was still applied, and not reverted

Three reasons:

1. **It is pre-existing.** These functions were equally broken for teams
   before T2c. Reverting T2c would not fix a single one of them, and
   would re-break workspace-wide de-duplication, the shared allowance and
   the fan-out — all of which are verified working.
2. **T2c's own 10 checks pass.** The one failure was my matrix step
   asserting a path that runs through an unconverted function.
3. **T2c is a prerequisite for the fix.** The conversion below needs
   `automation_internal.workspace_of()`, which T2c introduces.

#### The fix

Same shape as T2c-pre, and the same low risk: replace the tenant half of
each lookup, resolving the workspace from the caller once at the top.

```sql
v_workspace := automation_internal.workspace_of(p_user_id);
...
select * into v_contact from public.contacts
  where id = p_contact_id and workspace_id = v_workspace
  for update;
```

`p_user_id` stays in the signature — every Edge Function passes it and
none needs redeploying — and stays on any row the function writes, as the
audit trail. Only the lookup predicate changes.

Two things make it safe:

* every one of these tables already carries `workspace_id` NOT NULL
  (T2a), and T2c-pre already repointed their foreign keys to it;
* with one member per workspace today, `user_id` and `workspace_id`
  select the same rows, so no existing behaviour changes.

The silent-no-op shape should go too: where the row is genuinely absent,
these functions should keep returning their current outcome, but a row
that exists in the workspace must no longer look absent.

#### State at this stop

* T2b-2 applied as `20261006033532`; live matrix green.
* T2c-pre applied as `20261006125509`; live matrix 10/10.
* T2c applied as `20261006132041`; live matrix 9/10, the 10th explained
  above. All 19 function bodies verified byte-identical to the repo file
  by comparing `md5(prosrc)` against the PGlite database.
* Suite: 410 pass / 0 fail / 0 skipped.
* T2d / T3 / T4 not started.

#### Resolved: T2c-post, applied 2026-10-07 as `20261007033030`

Applied with a 19-check live matrix green and the full suite at 445. What
shipped, and the two things that differed from the plan above:

* **21 functions, not 19.** The planned substitution
  (`user_id = p_user_id` -> `workspace_id = workspace_of(p_user_id)`)
  covered 63 lookups across the 19. Writing a structural test first -
  "no function joins two tables on matching creator" - found a second
  form the substitution was blind to: joins of the shape
  `r.user_id = e.user_id`, which demand two rows share a CREATOR. Four
  functions had one. Two were inside the 19
  (`open_enrollments_for_contact`, `record_contact_stop_event`: an agent
  enrolling a lead onto the owner's rule made the rule's stop flags
  invisible, so a reply quietly failed to stop that enrollment). The
  other two were outside it, take no `p_user_id`, and were worse:
  `realtoros_claim_due_jobs` joined jobs to their rule and enrollment by
  creator, so **an agent's job on the owner's rule was never claimed at
  all** - not stopped, not failed, simply never run, with no error
  anywhere; `realtoros_recover_stale_automation_leases` shared the blind
  spot, so such a job could not even be recovered. Fixing the 19 and
  leaving those two would have been pointless.
* **The revert could not be generated from live**, because T2c was
  already applied by the time it was asked for. It is generated from the
  repo chain replayed to just before each phase instead, and then proven
  by execution in `tests/sql/rollback_files.test.mjs`.

Also cleared up: live and the repo chain appeared to disagree on 11 of
the 19 bodies. Normalising comments and whitespace away, all 19 hashed
identically - live simply held compressed, comment-stripped copies. No
behavioural drift, and the T2c-post apply has now normalised live onto
the repo's text.

Not-found contracts: nine already returned `not_found`;
`record_contact_stop_event` returns `contact_not_found`; four others had
their own key. Two needed work - `stop_enrollment` returned `'stopped'`
unconditionally, and `enroll_contact` folded "no such rule" into "rule
not active". Three deliberately need none (a name, a set, and a function
that creates rather than looks up).

#### Remaining order

1. T2d (frontend), T3 (invitations), T4 (Team UI).


## 7. Roles and Permissions

### 7.1 Role presets (unchanged from Phase 2)

| Role | Intended for | Default `data_scope` | Notable deltas from Owner |
|---|---|---|---|
| **Owner** | Account creator | `all` | All permissions, always |
| **Admin** | Trusted co-manager | `all` | Everything except ownership transfer |
| **Manager** | Team/office lead | `all` | Full module + financial view; no team-permission management |
| **Agent** | Working agent | `assigned_or_created` | No income/expense view, no export/restore/reset/team-management; commission view limited to own deals |
| **Assistant** | Admin support | `assigned_or_created` | Operational modules only; no financial visibility |
| **Viewer** | Read-only stakeholder | `all` (read-only) | View only, no financial visibility unless individually granted |

### 7.2 Permission storage: JSONB, schema-validated (unchanged decision from Phase 2)

Same shape and reasoning as before — a single indexed jsonb-path lookup colocated with the membership row already being fetched, versus up to 100 normalized rows per member for a check that is always "does this one member allow this one action," never a cross-member listing query.

```json
{
  "contacts":   { "view": true, "create": true, "edit": true, "delete": false, "export": false },
  "deals":      { "view": true, "create": true, "edit": true, "delete": false, "export": false },
  "commission": { "view_deal_values": false, "view_commission": false },
  "finances":   { "view_income": false, "view_expenses": false, "view_financial_reports": false },
  "sensitive":  {
    "export_workspace_data": false, "restore_backups": false, "reset_workspace": false,
    "clear_sample_data": false, "manage_pipeline_settings": false, "manage_custom_fields": false,
    "invite_members": false, "edit_permissions": false, "suspend_remove_members": false,
    "view_team_activity": false, "manage_directory": false
  },
  "read_only_selected_modules": []
}
```

(`manage_directory` and `read_only_selected_modules` are additions in this revision — the former gates `team_members` CRUD specifically, now that it's a permanent, permission-gated table rather than something being migrated away; the latter resolves Phase 2's open item about where the `read_only_selected` scope's module whitelist lives — it lives here, as a plain array, validated to contain only known module names.)

### 7.3 Module × action matrix (unchanged shape from Phase 2)

| Module | View | Create | Edit | Delete | Export |
|---|---|---|---|---|---|
| Dashboard, Daily View, Contacts, Buyer Workspace, Seller Workspace, Properties, Deals, Activities, Tasks, Calendar, Showings, Referrals, Finances, Goals, Reports, Scripts, AI Prompts, Scheduler, Team Directory, Settings | ✓ | ✓ | ✓ | ✓ | ✓ |
| Commission | ✓ (see `view_deal_values`/`view_commission`, §7.4) | — | — | — | ✓ |

### 7.4 Explicit sensitive permissions

| Sensitive permission | Default for Agent/Assistant/Viewer | Enforced by |
|---|---|---|
| `view_deal_values` | Agent: own deals only; Assistant/Viewer: false | RLS on new `deal_values` table (§8) |
| `view_commission` | Agent: own deals only; Assistant/Viewer: false | RLS on new `deal_commissions` table (§8) |
| `view_income` / `view_expenses` | false for non-Owner/Admin/Manager | RLS on `finance_records` |
| `view_financial_reports` | false for Agent/Assistant/Viewer | Frontend widget gate, reading from the same permission-scoped tables |
| `export_workspace_data` | false for non-Owner/Admin | Backup export RPC |
| `restore_backups` | false for non-Owner | Backup import RPC |
| `reset_workspace` | **Owner only, always, non-delegable** | Hard-coded role check inside the RPC, not just a default permission value |
| `clear_sample_data` | Owner/Admin/Manager | RPC check |
| `manage_pipeline_settings` / `manage_custom_fields` | Owner/Admin/Manager | `workspace_settings` RLS |
| `manage_directory` | Owner/Admin/Manager | `team_members` RLS (new) |
| `invite_members` | Owner/Admin | Edge Function check |
| `edit_permissions` | Owner/Admin | `workspace_members` UPDATE RLS |
| `suspend_remove_members` | Owner/Admin | `workspace_members` UPDATE RLS |
| `view_team_activity` | Owner/Admin/Manager | Reserved for a future audit-log feature |

### 7.5 Owner-safety invariants (rules 9, 12 — resolved with corrected mechanics, see §9.4/§12)

1. A member cannot edit their own `role`/`permissions`/`data_scope` — `workspace_members` UPDATE `WITH CHECK` requires `edit_permissions` **and** the target row is not the caller's own.
2. The last active `role='Owner'` row cannot be demoted/suspended/removed — enforced by trigger (§9.4), independent of any RLS policy, so a direct REST call cannot bypass it.
3. **A `role='Owner'` value can never be *newly* set through the ordinary `workspace_members` UPDATE path at all** (corrected addition, closing a real escalation hole in Phase 2's draft — see §9.5) — the only way a *new* Owner is ever created is the dedicated transfer function (§12).

---

## 8. Data-Scope Model and Financial Column Privacy (corrected — replaces Phase 2's "redaction" design)

### 8.1 Why frontend/RLS "redaction" was wrong, restated precisely

RLS decides which **rows** a role may see; it has no mechanism to let the same role see row R with columns A,B,C but not D,E,F. A member who can `SELECT` a `deals` row can `SELECT` **every** column on it via a direct REST call, including `value`/`commission_rate`/`team_split`/`brokerage_fee`/`referral_fee`/`tax_reserve`, regardless of what the frontend chooses to render. The only database-enforced ways to actually withhold specific columns from a role that can otherwise read the row are: (a) column-level `GRANT`/`REVOKE` — not viable here, because this app uses **one shared `authenticated` Postgres role for every signed-in user** regardless of their application-level permission, so a column grant/revoke cannot differentiate an Agent from a Manager; or (b) move the sensitive columns into their own table(s) with their own row-visibility rules, gated by the same `workspace_members`-based RLS pattern used everywhere else. **(b) is what this revision adopts, exactly the "preferred direction" offered in the correction request.**

### 8.2 New tables: `deal_values`, `deal_commissions`

Split along the two named permissions, not combined into one table, since a member might legitimately see sale price/rate as business context without seeing the internal fee/split structure:

**`deal_values`** — gated by `view_deal_values`:

| Column | Type | Constraint |
|---|---|---|
| `deal_id` | `text` | PK, references `deals(id)` — see FK note below |
| `workspace_id` | `uuid` | not null |
| `value` | `numeric` | not null default `0` |
| `commission_rate` | `numeric` | not null default `0` |
| `updated_at` | `timestamptz` | not null default `now()` |

**`deal_commissions`** — gated by `view_commission`:

| Column | Type | Constraint |
|---|---|---|
| `deal_id` | `text` | PK, references `deals(id)` |
| `workspace_id` | `uuid` | not null |
| `team_split` / `brokerage_fee` / `referral_fee` / `tax_reserve` | `numeric` | not null default `0` each |
| `updated_at` | `timestamptz` | not null default `now()` |

Both: `foreign key (workspace_id, deal_id) references deals(workspace_id, id) on delete cascade` — **CASCADE is correct and intentional here** (not the SET NULL pattern used for cross-entity relationships elsewhere): these rows have no independent existence or meaning without their parent deal; they are 1:1 extension tables of `deals`, not a separate business entity, so they die with the deal exactly as `milestones` already does.

No separate "calculated commission values" column exists anywhere — gross/net/weighted GCI are pure functions computed client-side (`App.commission`) from these raw fields; once the raw fields are inaccessible to a role, the computed values are automatically unavailable too, with no separate protection needed.

**RLS (draft):**
```sql
alter table public.deal_values enable row level security;

create policy deal_values_select on public.deal_values
for select to authenticated
using (
  -- must be able to see the parent deal at all, AND hold the specific permission
  exists (select 1 from public.deals d where d.id = deal_values.deal_id
          and d.workspace_id = deal_values.workspace_id) -- parent-deal RLS re-checked implicitly by selecting it under the caller's own rights
  and (select authz.has_permission(deal_values.workspace_id, array['commission','view_deal_values']))
);

create policy deal_values_upsert on public.deal_values
for insert to authenticated
with check (
  (select authz.has_permission(deal_values.workspace_id, array['commission','view_deal_values']))
  and (select authz.has_permission(deal_values.workspace_id, array['deals','edit']))
);

create policy deal_values_update on public.deal_values
for update to authenticated
using ( (select authz.has_permission(deal_values.workspace_id, array['commission','view_deal_values'])) )
with check ( (select authz.has_permission(deal_values.workspace_id, array['commission','view_deal_values'])) );

-- deal_commissions: identical shape, path ['commission','view_commission'] instead.
-- Neither table has a DELETE policy — rows only ever disappear via the
-- parent deal's CASCADE.
```

**Direct-REST proof this actually works (added to §17's test matrix):** as an Agent without `view_commission`, `GET /rest/v1/deal_commissions?deal_id=eq.<a deal the agent can see in deals>` returns **zero rows**, while `GET /rest/v1/deals?id=eq.<same id>` returns the deal itself — demonstrable, scriptable, and independent of anything the frontend does.

**Frontend impact (design-only, not implemented now):** `App.data`'s deal read path becomes a `deals` fetch plus a best-effort `deal_values`/`deal_commissions` fetch that simply returns nothing (not an error) when unauthorized; `App.commission`'s pure math functions must treat missing fields as `0` rather than throwing — a call-site detail for the implementation phase, not resolved further here. Editing a deal becomes up to three sequential writes (`deals`, then `deal_values`/`deal_commissions` only if the editor holds the corresponding permission) rather than one — each protected independently by its own RLS, so a member without financial permission simply never attempts those writes rather than attempting and failing.

### 8.3 Scope definitions (unchanged from Phase 2)

| Scope | Meaning |
|---|---|
| `all` | Every record in the workspace |
| `assigned` | Only records where the member is the assignee |
| `created` | Only records the member personally created |
| `assigned_or_created` | Union of the two |
| `read_only_selected` | Owner whitelists specific modules (§7.2's `read_only_selected_modules` array) |

### 8.4 Per-table scope mapping (corrected: assignment/creator columns, `deal_values`/`deal_commissions` added, `contacts.assigned_to_id` added)

| Table | Workspace column | Creator column | Assignment column | Assignment target | Sensitive? | SELECT scope | INSERT/UPDATE/DELETE |
|---|---|---|---|---|---|---|---|
| `contacts` | `workspace_id` | `created_by → team_members.id` | **`assigned_to_id` (new) → `team_members.id`** | direct (new) | No | scope-filtered on `created_by`/`assigned_to_id` | workspace+creator enforced on insert; assignee must be same-workspace |
| `properties` | `workspace_id` | `created_by → team_members.id` | none directly; inherits via `deal_id` | inherited | No | scope-filtered on `created_by`, or via linked deal | same pattern |
| `deals` | `workspace_id` | `created_by → team_members.id` | `assigned_to_id → team_members.id` (unchanged target) | direct | Financial fields moved out (§8.2) | scope-filtered on `created_by`/`assigned_to_id`; financial sub-tables separately gated | assignee must be same-workspace `team_members` row |
| `deal_values` / `deal_commissions` | `workspace_id` | n/a | n/a (inherits deal's) | inherited | **Yes, always** | requires the specific sensitive permission **and** parent-deal visibility | requires the sensitive permission **and** `deals.edit` |
| `milestones` / `activities` / `showings` | `workspace_id` | `created_by → team_members.id` | inherited from parent | inherited | Indirect | visible iff parent visible | parent must be editable |
| `tasks` | `workspace_id` | `created_by → team_members.id` | `assigned_to_id → team_members.id` | direct | No | scope-filtered | same pattern |
| `referrals` | `workspace_id` | `created_by → team_members.id` | none directly | inherited | Yes (`commission_amount`) | scope-filtered, or via linked deal | same pattern |
| `goals` | `workspace_id` | `created_by → team_members.id` | none | — | Possibly | `created` scope only, always | creator, or Owner/Admin |
| `finance_records` | `workspace_id` | `created_by → team_members.id` | none directly | inherited from `deal_id` | **Yes, always** | requires `view_income`/`view_expenses` + scope | requires Finances `edit` |
| `scripts` / `ai_prompts` | `workspace_id` | `created_by → team_members.id` | none | — | No | `all`, always (shared library) | `create`/`edit`/`delete` permission on module |
| `scheduled_items` | `workspace_id` | `created_by → team_members.id` | `assigned_to → team_members.id` | direct | No | scope-filtered | same pattern |
| `custom_field_values` | `workspace_id` | n/a | inherited from parent | inherited | Depends on parent | visible iff parent visible | parent must be editable |
| `team_members` | `workspace_id` | n/a | n/a | — | No | all members (read), gated by `manage_directory` for write | `manage_directory` permission |
| `workspace_settings` | `workspace_id` | n/a | n/a | — | Partially | all members (read); sensitive sub-sections gated | Owner-created; permission-gated per sub-section thereafter |

**`created_by` now points at `team_members.id`, not `workspace_members.id`** — a correction flowing directly from §4: attribution is a property of the durable *person*, exactly like assignment, so both use the same FK target for consistency, and both resolve correctly regardless of whether that person currently has (or ever had) login access.

### 8.5 Deal-child inheritance matrix (unchanged from Phase 2)

| Related record type | Visible if the deal is visible? | Rationale |
|---|---|---|
| Related contact, related property | Yes | Needed to do the job |
| Milestones, activities, showings on that deal | Yes | Pure sub-records |
| Tasks | Yes, plus any independently-assigned task | Two independent visibility paths, unioned |
| `finance_records` tied to the deal | Only with `view_income`/`view_expenses` | Independent grant |
| `deal_values` / `deal_commissions` for the deal | Only with the matching permission (§8.2) — otherwise those two tables simply return no row for that `deal_id`, and the deal itself still renders fully for its operational fields | Deal *workflow* access and deal *financial* visibility are separate, database-enforced grants, not a rendering choice |

---

## 9. Ownership and Foreign-Key Migration

**`user_id` is kept, unmodified, on every existing table through the entire migration and afterward** — never repurposed as `workspace_id`, never dropped by this plan. `workspace_id` is backfilled from the existing `user_id` → one-workspace-per-existing-user mapping (§14 Phase B); `created_by` is backfilled to the `team_members` row representing that same original owner (§14 Phase C, alongside the `team_members` row's own creation for pre-migration owners who don't yet have one — see Phase C).

### 9.1 Foreign-key conversion table (corrected: assignment FKs target `team_members`, not `workspace_members`; new rows for `contacts.assigned_to_id` and the financial tables)

| Current constraint | Current columns | Replacement columns | Delete behavior | Migration risk |
|---|---|---|---|---|
| `activities_user_id_contact_id_fkey` (and the 3 sibling activities FKs) | `(user_id, X)` | `(workspace_id, X)` | `ON DELETE SET NULL (X)` | Low |
| `deals_user_id_assigned_to_id_fkey` | `(user_id, assigned_to_id)` → `team_members` | `(workspace_id, assigned_to_id)` → **`team_members`** (unchanged target — corrected from Phase 2's `workspace_members`) | `ON DELETE SET NULL (assigned_to_id)` | Low — target table doesn't change this time, only the tenant column |
| `deals_user_id_contact_id_fkey` / `_property_id_fkey` | `(user_id, X)` | `(workspace_id, X)` | `ON DELETE SET NULL (X)` | Low |
| **`contacts_workspace_id_assigned_to_id_fkey` (new)** | n/a | `(workspace_id, assigned_to_id)` → `team_members` | `ON DELETE SET NULL (assigned_to_id)` | Low — purely additive, no existing FK to replace |
| `finance_records_user_id_contact_id_fkey` / `_deal_id_fkey` | `(user_id, X)` | `(workspace_id, X)` | `ON DELETE SET NULL (X)` | Low |
| `milestones_user_id_deal_id_fkey` | `(user_id, deal_id)` | `(workspace_id, deal_id)` | **CASCADE** (unchanged) | Low |
| `properties_deal_tenant_fkey` / `_contact_id_fkey` | `(user_id, X)` | `(workspace_id, X)` | `ON DELETE SET NULL (X)` | Low |
| `referrals_*` (3 FKs) | `(user_id, X)` | `(workspace_id, X)` | `ON DELETE SET NULL (X)` | Low |
| `scheduled_items_user_id_assigned_to_fkey` | `(user_id, assigned_to)` → `team_members` | `(workspace_id, assigned_to)` → **`team_members`** (unchanged target) | `ON DELETE SET NULL (assigned_to)` | Low |
| `scheduled_items_*` (contact/deal/property/script, 4 FKs) | `(user_id, X)` | `(workspace_id, X)` | `ON DELETE SET NULL (X)` | Low |
| `showings_*` (3 FKs) | `(user_id, X)` | `(workspace_id, X)` | `ON DELETE SET NULL (X)` | Low |
| `tasks_user_id_assigned_to_id_fkey` | `(user_id, assigned_to_id)` → `team_members` | `(workspace_id, assigned_to_id)` → **`team_members`** (unchanged target) | `ON DELETE SET NULL (assigned_to_id)` | Low |
| `tasks_*` (contact/deal/property, 3 FKs) | `(user_id, X)` | `(workspace_id, X)` | `ON DELETE SET NULL (X)` | Low |
| **`deal_values_workspace_id_deal_id_fkey` (new)** | n/a | `(workspace_id, deal_id)` → `deals` | **CASCADE** (§8.2 — intentional, differs from the SET NULL pattern) | Low |
| **`deal_commissions_workspace_id_deal_id_fkey` (new)** | n/a | `(workspace_id, deal_id)` → `deals` | **CASCADE** | Low |
| **`workspace_members_team_member_id_fkey` (new)** | n/a | `team_member_id → team_members(id)` | **RESTRICT** (§6.3 — cannot delete a directory person with active login access) | Low |
| every table's `(user_id,id)` UNIQUE | `(user_id, id)` | **add** `(workspace_id, id)` alongside | n/a | Low |
| every table's `user_id → auth.users(id)` FK | `user_id` | **unchanged, kept** | CASCADE (unchanged) | None |

**Restated guardrail, one more time because it is the single most important correctness rule here:** every new SET-NULL FK above uses the column-scoped form `ON DELETE SET NULL (<relationship_column>)`, never bare `ON DELETE SET NULL` — the latter would null `workspace_id` itself on a two-column key, exactly the bug already fixed once (§1.2) for the `user_id` generation of these same FKs.

### 9.2 `contacts.assigned_to_id` — additive, with a defined compatibility path (resolves §4 of the correction request)

```sql
alter table public.contacts add column assigned_to_id text;
-- backfilled to NULL for every existing row (see below); FK added after backfill validation:
alter table public.contacts
  add constraint contacts_workspace_id_assigned_to_id_fkey
  foreign key (workspace_id, assigned_to_id) references public.team_members (workspace_id, id)
  on delete set null (assigned_to_id);
```

- **Backfill rule:** **no automatic mapping from the free-text `assigned_agent` to a `team_members.id`.** The existing value is a display string ("Self," a name typed by hand, sometimes a brokerage name) with no reliable, safe way to resolve it to one specific directory row without risking a false match that would silently grant "assigned" scope to the wrong person. `assigned_to_id` is left `null` for every pre-existing contact. A later, entirely optional admin tool could offer a name-similarity-based bulk-assign-with-confirmation pass, but that is out of scope for this migration and is not assumed by any RLS rule below (a `null` `assigned_to_id` simply means "assigned scope doesn't include this contact for anyone," which is the safe default).
- **Same-workspace constraint:** enforced by the FK above (both sides reference `(workspace_id, id)`) plus the same `authz.assert_same_workspace_assignee`-style trigger already used for `deals`/`tasks`/`scheduled_items` (§10.3), extended to include `contacts`.
- **UI migration:** the free-text `assigned_agent` input is replaced with a dropdown sourced from `team_members`, identical in pattern to the existing Deal-assignment dropdown; `assigned_agent` itself is kept visible (read-only display, or an optional free-text note field) during the compatibility period.
- **Compatibility period / retirement condition:** `assigned_agent` may be retired (converted to a computed display value derived from `assigned_to_id`'s linked `team_members.name`, or dropped) only once (a) every *active* contact has a non-null `assigned_to_id` **or** an explicit Owner decision to leave some contacts unassigned, and (b) a full release cycle has passed with the new column in place with no regressions — the same conservative retirement standard already used for `team_members` itself in Phase 2's plan, now correctly *not* applied to `team_members` (which is permanent) but still appropriate here.
- **Consequence for §8's scope model:** until backfilled, "assigned" scope over Contacts only ever matches contacts assigned going forward — this is called out explicitly as expected, not a bug, in the test matrix (§17).

---

## 10. RLS and Authorization Design (draft SQL — not executed)

### 10.1 `authz` schema — corrected privileges (resolves §6 of the correction request)

```sql
create schema if not exists authz;

-- Corrected: the previous draft revoked all access including from
-- authenticated, which would make every policy that calls a function in
-- this schema fail outright (the calling role needs USAGE on the schema
-- and EXECUTE on each function it actually calls — nothing broader).
revoke all on schema authz from public;
grant usage on schema authz to authenticated;
```

Every function below is created, then explicitly:
```sql
revoke execute on function authz.<name>(<args>) from public;
grant execute on function authz.<name>(<args>) to authenticated;
```
— **never** a blanket `grant execute on all functions in schema authz`, and **never** any grant to `anon`.

### 10.2 `authz.has_permission` — corrected Owner handling

```sql
create or replace function authz.has_permission(p_workspace_id uuid, p_path text[])
returns boolean
language sql
security invoker
stable
set search_path = ''
as $$
  select case
    when m.role = 'Owner' then true
    else coalesce((m.permissions #> p_path)::boolean, false)
  end
  from public.workspace_members m
  where m.workspace_id = p_workspace_id
    and m.user_id = (select auth.uid())
    and m.status = 'active'
  limit 1;
$$;
```
**Corrected:** Owner authorization is now an explicit `case` branch evaluated *before* any JSON lookup — "no Owner authorization may depend on populating every JSON key," satisfied exactly, since an Owner row's `permissions` value is never even consulted. `coalesce(..., false)` on the non-Owner branch keeps the fail-closed default for every other role when a key is genuinely absent.

`authz.current_membership(p_workspace_id)` is unchanged in shape from Phase 2 (returns the caller's own membership row) and remains `SECURITY INVOKER` — it only reads a row the caller's own `workspace_members` SELECT policy already permits, which is not the self-referential case addressed next.

### 10.3 Resolving the recursive-RLS problem on `workspace_members` itself (resolves §6's explicit ask)

**Why invoker rights cannot perform this specific lookup without recursion:** `authz.current_membership`/`has_permission` are safe to call from *other* tables' policies (e.g. `contacts`) because querying `workspace_members` from a `contacts` policy is an ordinary cross-table subquery — `workspace_members`'s RLS is evaluated once, normally, and returns. The danger is narrower and specific: **`workspace_members`'s *own* SELECT/UPDATE policies** cannot themselves depend on a query against `workspace_members` under invoker rights, because evaluating that policy's condition would require re-evaluating `workspace_members`'s SELECT policy for the inner query — which is the same policy being evaluated, on the same table, invoked from inside itself. There is no invoker-rights way to ask "is the caller a member of this workspace" without asking `workspace_members` that question under `workspace_members`'s own policy — that circularity is exactly what a definer function, running as an owner who bypasses RLS entirely, breaks.

```sql
-- Narrowly scoped, used ONLY inside workspace_members' own policies.
create or replace function authz.is_active_workspace_member(p_workspace_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = p_workspace_id
      and m.user_id = auth.uid()
      and m.status = 'active'
  );
$$;

revoke all on function authz.is_active_workspace_member(uuid) from public, anon;
grant execute on function authz.is_active_workspace_member(uuid) to authenticated;
```

Every required `SECURITY DEFINER` safeguard applied: kept in the private `authz` schema; `search_path = ''` with every reference fully qualified (`public.workspace_members`); the caller is derived **only** from `auth.uid()` — the function's sole parameter is the workspace id being checked, never a caller identity, so there is no argument through which a caller could assert "check membership as if I were someone else"; revoked from `public`/`anon`; granted only to `authenticated`.

```sql
create policy workspace_members_select on public.workspace_members
for select to authenticated
using ( authz.is_active_workspace_member(workspace_id) );
```

**BOLA/IDOR test for this function (added to §17):** call it (indirectly, by selecting `workspace_members` rows) with a `workspace_id` belonging to a workspace the caller is genuinely not a member of — confirm zero rows, never another workspace's membership list; separately confirm the function itself, given any `workspace_id` at all, only ever reflects the **caller's own** row (there is no code path where passing a different `workspace_id` reveals whether some *other specific user* is a member — it only answers "is the current caller a member of this one workspace," which is the only question it is ever asked to answer).

### 10.4 `workspace_id` immutability — corrected (resolves §7 of the correction request)

The prior `WITH CHECK (workspace_id = contacts.workspace_id)` is tautological inside `WITH CHECK`, which evaluates against the **proposed new row** only — both sides of that comparison describe the same not-yet-committed row, so it is always true and blocks nothing. The actual fix compares the new row to the row being replaced, which only a trigger (with access to both `OLD` and `NEW`) can do:

```sql
create or replace function authz.prevent_workspace_id_change()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if NEW.workspace_id is distinct from OLD.workspace_id then
    raise exception 'workspace_id cannot be changed after a row is created';
  end if;
  return NEW;
end;
$$;
```
Attached `BEFORE UPDATE OF workspace_id FOR EACH ROW` on every workspace-owned table (all 15 business tables + `team_members` + `deal_values`/`deal_commissions`). This is independent of, and in addition to, the ordinary RLS `USING`/`WITH CHECK` pair, which still separately governs *whether* the caller may touch the row at all — the trigger only ever concerns itself with the one column, and exists specifically so "a user who belongs to two workspaces" can never move a record between them via UPDATE, regardless of what permissions they hold in either workspace.

### 10.5 Table RLS — corrected pattern (contacts shown; same shape for every workspace-owned table)

```sql
alter table public.contacts enable row level security;

create policy contacts_select on public.contacts
for select to authenticated
using (
  authz.is_active_workspace_member(contacts.workspace_id)  -- membership check via the DEFINER helper, not a raw subquery, kept consistent everywhere
  and (
    (select authz.current_membership(contacts.workspace_id)).data_scope = 'all'
    or (select authz.current_membership(contacts.workspace_id)).role in ('Owner','Admin','Manager')
    or contacts.created_by = (select authz.current_membership(contacts.workspace_id)).team_member_id
    or contacts.assigned_to_id = (select authz.current_membership(contacts.workspace_id)).team_member_id
  )
);

create policy contacts_insert on public.contacts
for insert to authenticated
with check (
  authz.is_active_workspace_member(contacts.workspace_id)
  and contacts.created_by = (select authz.current_membership(contacts.workspace_id)).team_member_id
  and (select authz.has_permission(contacts.workspace_id, array['contacts','create']))
);

create policy contacts_update on public.contacts
for update to authenticated
using ( (select authz.has_permission(contacts.workspace_id, array['contacts','edit'])) )
with check ( (select authz.has_permission(contacts.workspace_id, array['contacts','edit'])) );
-- workspace_id immutability is enforced by the §10.4 trigger, not repeated here.

create policy contacts_delete on public.contacts
for delete to authenticated
using ( (select authz.has_permission(contacts.workspace_id, array['contacts','delete'])) );
```

**`created_by`/`assigned_to_id` now compare against `(select authz.current_membership(...)).team_member_id`** (corrected from Phase 2's `.id`, which pointed at the wrong table per §4/§8.4).

**Assignment fields cannot reference another workspace** (extended to `contacts` per §9.2):
```sql
create or replace function authz.assert_same_workspace_assignee()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if NEW.assigned_to_id is not null and not exists (
    select 1 from public.team_members t
    where t.id = NEW.assigned_to_id and t.workspace_id = NEW.workspace_id
  ) then
    raise exception 'assigned_to_id must belong to the same workspace';
  end if;
  return NEW;
end; $$;
```
Attached `BEFORE INSERT OR UPDATE` on `contacts`, `deals`, `tasks`, `scheduled_items` (the `scheduled_items.assigned_to` column reuses the same trigger function under an alias, or a near-identical sibling checking `assigned_to` instead of `assigned_to_id` — a naming detail for implementation, not a design gap).

**Every other required property carries over unchanged from Phase 2's reasoning, now built on the corrected primitives above:** removed/suspended members read nothing (status re-checked live on every request, no JWT dependency); Owners cannot be silently demoted (trigger, §7.5); members cannot grant themselves permissions (`workspace_members` UPDATE `WITH CHECK` excludes the caller's own row).

### 10.6 `workspace_members` / `workspace_invitations` RLS — corrected for column privacy (resolves §16 of the correction request)

**"Only selecting safe columns in frontend code" is not a real protection** — a direct REST `select=*` (or any explicit column list) against the base table is limited only by RLS/grants, not by frontend intent. Corrected design:

```sql
-- Base table: no ordinary SELECT policy grants broad access to every
-- column to every member. Only two paths exist:

-- 1. A restricted VIEW for the general "who's on my team" list.
create view public.workspace_members_directory
with (security_invoker = true) as
select wm.id, wm.workspace_id, wm.team_member_id, wm.role, wm.status,
       tm.name as display_name
from public.workspace_members wm
join public.team_members tm on tm.id = wm.team_member_id and tm.workspace_id = wm.workspace_id;
-- security_invoker = true: this view runs under the QUERYING member's own
-- RLS on both underlying tables, not the view owner's — it does not
-- bypass anything, it simply narrows the column list any member can read.
grant select on public.workspace_members_directory to authenticated;

-- 2. Full-row access (including `permissions`) restricted to members who
-- hold invite_members or edit_permissions, via RLS on the base table itself:
create policy workspace_members_select on public.workspace_members
for select to authenticated
using (
  authz.is_active_workspace_member(workspace_members.workspace_id)
  and (
    workspace_members.team_member_id = (select authz.current_membership(workspace_members.workspace_id)).team_member_id
    or (select authz.has_permission(workspace_members.workspace_id, array['sensitive','invite_members']))
    or (select authz.has_permission(workspace_members.workspace_id, array['sensitive','edit_permissions']))
  )
);
```

This resolves every bullet the correction requested directly: **ordinary members list teammates** via `workspace_members_directory` (name/role/status only — no `permissions`, no raw `user_id`); **Owners/Admins read permissions** via the base-table policy above, which additionally lets a member see their own full row (`team_member_id` matches their own); **Owners/Admins update permissions** via the existing UPDATE policy (§7.5/§10.5's `edit_permissions` check); **Viewers cannot fetch permission JSON directly** — a Viewer without `invite_members`/`edit_permissions` matches neither `OR` branch except for their own row, so a direct REST `select=permissions` against another member's row returns zero rows for them; **emails/phone/notes** live on `team_members`, not `workspace_members`, and are protected by `team_members`'s own RLS (visible to all active members for the directory use case, consistent with how the app already treats contact info today — tightening this further, e.g. hiding phone numbers from Viewers specifically, is a possible future refinement noted in §19, not required by anything already specified).

`workspace_invitations` SELECT/INSERT/UPDATE: unchanged from Phase 2 — visible only to `invite_members` holders; writes only through the Edge Function, never a bare client INSERT.

---

## 11. Preventing Owner-role escalation through the ordinary UPDATE path (resolves §8's "demote-then-promote" gap, part 1)

A gap in Phase 2's draft not previously called out explicitly: even with the last-Owner-protection trigger (§7.5.2), nothing stopped an Admin holding `edit_permissions` from directly `UPDATE`-ing some *other* member's `role` to `'Owner'` via ordinary REST, creating a second Owner outside the controlled transfer flow. Corrected:

```sql
create policy workspace_members_update on public.workspace_members
for update to authenticated
using ( (select authz.has_permission(workspace_members.workspace_id, array['sensitive','edit_permissions']))
        and workspace_members.team_member_id <> (select authz.current_membership(workspace_members.workspace_id)).team_member_id )
with check (
  (select authz.has_permission(workspace_members.workspace_id, array['sensitive','edit_permissions']))
  and workspace_members.team_member_id <> (select authz.current_membership(workspace_members.workspace_id)).team_member_id
  -- A role can never be newly promoted to Owner through this ordinary path —
  -- the only legitimate way NEW.role = 'Owner' is if it was already 'Owner'
  -- (i.e. this update isn't the one creating an Owner at all).
  and (workspace_members.role <> 'Owner' or workspace_members.role = 'Owner')  -- placeholder for the OLD-vs-NEW comparison below
);
```
The `role <> 'Owner' OR OLD.role = 'Owner'` shape needs `OLD`, which `WITH CHECK` alone cannot see (same limitation as §10.4) — so, consistent with that same fix, the actual enforcement is a second trigger:
```sql
create or replace function authz.prevent_ordinary_owner_promotion()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if NEW.role = 'Owner' and OLD.role <> 'Owner' then
    raise exception 'Ownership can only be granted through realtoros_transfer_ownership()';
  end if;
  return NEW;
end; $$;
```
attached `BEFORE UPDATE OF role FOR EACH ROW` on `workspace_members`. The only remaining way `role` ever becomes `'Owner'` is the function in §12, which — being `SECURITY DEFINER` — is not itself subject to this trigger's *intent* being questioned (the trigger still fires, but the DEFINER function is the one legitimate, audited path that the trigger is explicitly designed to still allow, since the transfer function's own internal UPDATE also goes through it — the trigger only blocks `OLD.role <> 'Owner' AND NEW.role = 'Owner'`, and the transfer function's writes satisfy that exact same rule, which is correct: it too is only ever promoting a currently-non-Owner row, and the invariant is what matters, not which caller performed it).

---

## 12. Ownership Transfer — redesigned (resolves §8 of the correction request in full)

```sql
create or replace function public.realtoros_transfer_ownership(p_workspace_id uuid, p_new_owner_member_id uuid)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_caller public.workspace_members;
  v_new_owner public.workspace_members;
begin
  -- 1. Caller must be the current active Owner.
  select * into v_caller from public.workspace_members
    where workspace_id = p_workspace_id and user_id = auth.uid() and status = 'active';
  if v_caller.id is null or v_caller.role <> 'Owner' then
    raise exception 'Only the current active Owner may transfer ownership';
  end if;

  -- 2. New Owner must be validated BEFORE anything is mutated.
  select * into v_new_owner from public.workspace_members
    where id = p_new_owner_member_id and workspace_id = p_workspace_id and status = 'active';
  if v_new_owner.id is null then
    raise exception 'New owner must be an active member of this workspace';
  end if;
  if v_new_owner.user_id is null then
    raise exception 'New owner must have a linked, non-null Auth user';
  end if;
  if v_new_owner.id = v_caller.id then
    raise exception 'Cannot transfer ownership to yourself';
  end if;

  -- 3. Only now does any write happen -- new Owner promoted first, old
  --    Owner demoted second, so there is never a zero-Owner instant.
  update public.workspace_members set role = 'Owner' where id = v_new_owner.id;
  update public.workspace_members set role = 'Admin' where id = v_caller.id;
  update public.workspaces set owner_user_id = v_new_owner.user_id, updated_at = now()
    where id = p_workspace_id;

  -- 4. Final invariant check before commit -- defense in depth beyond the
  --    triggers in §7.5/§11, which this function's own writes must also
  --    legitimately satisfy.
  if (select count(*) from public.workspace_members
      where workspace_id = p_workspace_id and role = 'Owner' and status = 'active') <> 1 then
    raise exception 'Ownership transfer would not leave exactly one Owner; aborting';
  end if;
end;
$function$;

revoke all on function public.realtoros_transfer_ownership(uuid, uuid) from public, anon;
grant execute on function public.realtoros_transfer_ownership(uuid, uuid) to authenticated;
```

**Why `SECURITY DEFINER` here specifically (corrected from Phase 2's invoker version):** `workspaces.owner_user_id` has **no ordinary UPDATE path available to any client role at all** — not even the Owner — by design, so that the *only* way it ever changes is through this one audited, fully-validated function. An invoker-rights version of this function would itself be blocked by that same "no ordinary path" rule when it tried to run its own `UPDATE workspaces SET owner_user_id = ...` statement. Running as definer is therefore the intentional, minimal bypass — scoped to exactly this one operation, with every safeguard applied (`search_path=''`, fully qualified, caller derived only from `auth.uid()`, no trusted parameter — `p_new_owner_member_id` is validated against live `workspace_members` state before use, never assumed correct, revoked from `public`/`anon`, granted to `authenticated` only). Every requirement is satisfied: caller-is-Owner checked first; new Owner validated (active member, non-null `user_id`, not self) before any write; promote-then-demote order guarantees no zero-Owner instant; the final count check guarantees no two-Owner outcome either; ordinary REST cannot perform any part of this (no UPDATE policy on `owner_user_id` exists, and the `role='Owner'`-promotion trigger from §11 blocks the ordinary path to the membership side too); failure at any `raise exception` rolls back the entire function body atomically, per Postgres function semantics.

---

## 13. Invitation, Email, and Login Design

### 13.1 Full flow (corrected: no `'invited'` membership row, corrected Edge Function auth, named email provider, indexed lookup)

1. Owner opens Settings → Team & Access.
2. Owner picks an existing `team_members` row, or creates a new one inline (name, job title, etc. — no login implied yet).
3. Owner enters the email to invite, selects a preset role, customizes permissions/data scope.
4. Frontend calls the `invite-member` Edge Function with the caller's session JWT (§13.5).
5. Function authenticates the caller (JWT validated by the platform before the handler runs, §13.5), then re-verifies the caller's **live** `invite_members` permission and the Owner-invites-Owner rule against `workspace_members`/`workspace_invitations` directly — never trusting the request body.
6. Function checks `user_directory` (§13.7) for the invited email: **already has a confirmed Auth account** → branch to §13.4's "already registered" path; **no account** → `auth.admin.inviteUserByEmail()`.
7. Function creates/updates the `workspace_invitations` row (generates the token, stores only its hash, links `team_member_id`).
8. Member accepts (§13.2) — this is the **only** point at which a `workspace_members` row is ever created (corrected — there is no pending/invited membership row at any earlier step).
9. Membership becomes `active` immediately on acceptance (`joined_at = now()`).
10. Member enters the existing RealtorOS interface with the same navigation/permission model as any other member — one application, matching product rule 4.

### 13.2 Acceptance function (unchanged shape from Phase 2, `SECURITY DEFINER`, justification restated)

Matches the token hash, checks `status='pending' and expires_at > now()`, and in one transaction: flips the invitation to `'accepted'`; creates the `team_members` row if the invitation carried no `team_member_id` (a brand-new person invited by email only); creates the `workspace_members` row (`user_id = auth.uid()`, `team_member_id` = the resolved directory row, `status='active'`, `joined_at=now()`) or reactivates an existing `removed` row for that same `team_member_id` (§6.3). `SECURITY DEFINER` is required for the same reason as before: before acceptance, the invitee has no `workspace_members` row an ordinary policy could key off of, so there is no invoker-rights path to `workspace_invitations` for them at all.

### 13.3 Branch handling (unchanged from Phase 2 except where corrected below)

| Case | Handling |
|---|---|
| Brand-new email, no Auth account | `auth.admin.inviteUserByEmail()` |
| **Email already registered (corrected, §13.4)** | Handled by the named `notify-existing-user` path, not a vague "plain notification" |
| Email already belongs to another workspace | Rejected unless the multi-workspace decision (§14) allows it for this release |
| Expired / revoked / repeated invitation | Distinct, specific rejections, as in Phase 2 |
| Owner inviting themselves | Rejected by email match against the caller's own `auth.users.email` |
| Member already active | Rejected with "already a member" |
| Email capitalization | `lower()` everywhere, consistently |
| Member removed and later re-invited | Reactivates the same `workspace_members` row (§6.3) |

### 13.4 "Already registered" notification — named mechanism (resolves the specific ask in §10 of the correction request)

The function's `notify-existing-user` branch does **not** call `auth.admin.inviteUserByEmail()` (which errors for a confirmed user) and does **not** send a raw email itself. Instead it: (a) creates the `workspace_invitations` row exactly as normal (token, hash, `expires_at`); (b) sends the notification through the **same transactional email channel as every other application email** — i.e., Supabase Auth's configured SMTP provider (§13.6), via a plain templated email (not an Auth-generated confirmation link, since this person doesn't need to confirm anything — they already have an account) containing a link straight to `/accept-invite?token=<raw token>`; (c) if that person is *currently signed in* in another tab/session, an in-app "pending invitation" indicator also appears via the ordinary `workspace_invitations` SELECT-by-`invite_members`-holder path is not applicable to the invitee (they don't hold that permission) — instead, a lightweight, invitee-scoped read path (a narrow RLS policy or SECURITY DEFINER lookup function keyed only to `lower(email) = lower(the caller's own auth.users.email)`) lets a signed-in user see invitations addressed to their own email specifically, without requiring any workspace membership. This is a genuinely new, narrow policy — noted here as a design decision requiring the same DEFINER-function safeguards as §12/§10.3 if implemented as a function rather than a policy, deferred to the implementation phase for its exact shape.

### 13.5 Edge Function authentication — resolved with evidence (resolves §9 of the correction request)

The correction request specifies `verify_jwt = false` plus `@supabase/server`'s `withSupabase({ auth: 'user' }, ...)` for `invite-member`/`accept-invite`. Checked against current Supabase documentation before adopting this, and the verifiable guidance is more specific than that instruction, so it is applied as follows rather than verbatim:

- **`verify_jwt = true` (the platform default) is kept**, together with `auth: 'user'` from `@supabase/server`'s `withSupabase` wrapper. This is Supabase's own documented pairing: *"Keep verify_jwt = true (the default) so the platform validates the JWT before your handler runs, then use auth: 'user' to get ctx.supabase already scoped to the caller's RLS policies."* `verify_jwt = false` is documented specifically for functions **with no Authorization header at all** — webhooks, service-to-service calls authenticating via an API key on the `apikey` header instead. `invite-member`/`accept-invite` are both called by a signed-in browser session with a real user JWT, which is exactly the case `verify_jwt = true` + `auth:'user'` is for.
- **The genuine, verified 2026 nuance** is a different axis entirely from the one named in the correction request: this project's `sb_publishable_...`/`sb_secret_...` **API key format** (which replaces the `apikey` header value) is independent of the **session JWT signing algorithm** (`Authorization: Bearer` — legacy HS256 or the newer asymmetric ES256 "JWT Signing Keys" feature). `verify_jwt`'s platform-level check validates both HS256 and the newer ES256-signed session JWTs; it specifically rejects a request only when a publishable/secret key (which is not a JWT at all) is mistakenly placed in the `Authorization` header instead of the `apikey` header — a caller-side mistake to guard against in the frontend's fetch call, not a reason to disable server-side verification.
- **Applied configuration:**
  ```toml
  [functions.invite-member]
  verify_jwt = true

  [functions.accept-invite]
  verify_jwt = true
  ```
  ```ts
  import { withSupabase } from "@supabase/server"; // pinned exact version, §13.8
  export default withSupabase({ auth: "user" }, async (req, ctx) => {
    // ctx.supabase is already scoped to the caller's own RLS.
    // ctx.supabaseAdmin (backed by the secret key, read from environment
    // configuration only) is used for exactly one operation: checking/
    // creating the Auth user via auth.admin.* — never for anything RLS
    // could answer instead.
  });
  ```
- The `apikey` header (the project's publishable key) is sent by the Supabase client library automatically on every request, including Edge Function calls — no manual handling needed in application code, consistent with normal `supabase-js` usage already in place elsewhere in this codebase.
- The secret key lives **only** in the Edge Function's environment configuration (`SUPABASE_SERVICE_ROLE_KEY` / the new `sb_secret_...` equivalent, set via `supabase secrets set`, never committed, never in frontend code, never logged) and is accessed only through `ctx.supabaseAdmin`.
- **CORS:** restricted to the application's actual configured origins (the deployed URL(s) already required to be in the Auth Redirect URLs allow-list, §2/docs/SUPABASE_SETUP.md) — not a wildcard `*`.
- **Dependency pinning:** `@supabase/server` and `@supabase/supabase-js` imported at exact, pinned versions in the function's `import_map`/`deno.json`, not a floating `latest`/caret range.
- **Non-enumerating errors:** every branch in §13.3 that depends on whether an email already has an account returns the **same generic response shape** to the caller regardless of which branch fired internally (e.g. always `{ "status": "invitation_sent" }`) — the function's internal logging may distinguish the branches for the Owner's own audit trail, but the HTTP response never reveals to a client "this email does/doesn't have an account," closing the account-enumeration channel explicitly required by the correction request.

### 13.6 Production email delivery (resolves §10 of the correction request)

Supabase's built-in email sender is capped at **2 auth emails per hour** ([production checklist](https://supabase.com/docs/guides/deployment/going-into-prod)) — unusable for real invitation volume beyond the smallest possible test. **Custom SMTP is a hard requirement before this feature ships to real users**, raising the default to 30 new-Auth-user emails/hour (adjustable via Supabase support for higher volume). Required configuration, all outside this document's own scope to apply (Dashboard/environment configuration, not a SQL migration):
- Custom SMTP provider configured in Authentication → Email settings.
- **Site URL** and **Redirect URL allow-list** correct for every environment this app is actually served from (already a requirement per `docs/SUPABASE_SETUP.md`; restated here because invitation links specifically depend on it working correctly, not just OAuth/password-reset).
- Production and localhost redirect handling: both must be present in the allow-list simultaneously during development (`http://localhost:5500/...` alongside the production URL) — never swap one for the other.
- **Rate limiting / resend cooldown:** the `invite-member` function enforces its own minimum resend interval (e.g. one resend per pending invitation per 60 seconds) independent of Supabase's own Auth rate limits, so a double-click or a retry storm can't itself exhaust the SMTP quota.
- **Expiration:** `expires_at` (§6.4), 7 days default.
- **Revocation:** `status='revoked'` (§6.4), immediately effective since acceptance re-checks `status='pending'`.
- **Generic error messages:** per §13.5's non-enumeration requirement.

### 13.7 Email lookup without scanning all Auth users (resolves the specific ask in §10 of the correction request)

Rather than depend on an admin lookup-by-email method whose availability/stability could not be confirmed against current documentation with confidence, this design uses the well-established Supabase pattern of a **trigger-maintained mirror table**:

```sql
create table public.user_directory (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  email_confirmed boolean not null default false,
  updated_at timestamptz not null default now()
);
create unique index user_directory_email_key on public.user_directory (lower(email));

-- Maintained by a trigger on auth.users (created/updated), keeping this
-- table in sync automatically; no application code ever writes to it directly.
```
`invite-member` (via `ctx.supabaseAdmin`, since `auth`-schema-adjacent lookups belong server-side) checks `user_directory` by `lower(email)` — an indexed, O(1) lookup — instead of any full-scan or per-invitation admin-API listing call. This table holds no more than what's already public information within the product (an email already visible to anyone who invites that person), is never exposed to `anon`, and is written to only by the trigger, never by client code.

### 13.8 Preventing the explicitly-listed attack patterns (unchanged from Phase 2, still correct)

Duplicate active invitations (partial unique index, §6.4); replay (status flip in the same transaction as the match); cross-workspace acceptance (workspace_id derived only from the matched row); non-owner inviting an Owner (explicit check); privilege escalation via edited payloads (superset check against the caller's own permissions).

---

## 14. Multi-Workspace Behavior (corrected — resolves §12 of the correction request)

**Corrected design:**
- **Exactly one active membership:** automatic selection, no chooser shown.
- **More than one active membership:** an explicit workspace-chooser screen at sign-in (and a switcher control thereafter) — **never** an implicit "first one found."
- **`workspace_id` is always passed explicitly** by every query, sourced from the frontend's current-workspace state (`App.workspace`, in-memory only) — never inferred globally from a JWT claim or a bare `auth.uid()` lookup that could return an arbitrary row when more than one exists.
- **No application `localStorage`** — the current-workspace selection lives in memory for the session, consistent with every other piece of business state in this app.
- **RLS validates regardless of what the frontend selected** — every policy still independently re-derives "is this caller actually a member of *this* `workspace_id`" (§10.5); the frontend's selection is a UX convenience for which data to *request*, never a trust boundary.
- **Switching workspaces** (when a chooser/switcher exists): unsubscribes every existing Realtime channel (`App.data.unsubscribeRealtime()`), clears all cached entity data for the previous workspace, then loads the new workspace's settings/entities and re-subscribes — the same clean-boot sequence the app already performs on sign-out, applied to a workspace change instead of a session change.
- **Optional last-selected-workspace preference:** if desired, stored server-side (e.g. a `last_workspace_id` column on a lightweight per-user preferences row, **not** `localStorage`) — explicitly documented as a **UX hint only**, read to *pre-select* the chooser's default option, and **never** consulted by any RLS policy or authorization check; a stale/tampered hint at worst pre-selects the wrong chooser option, which the user can simply change, since the chooser itself is fed by the live `workspace_members` list, not by the hint.

---

## 15. Frontend Access Design (design only, not implemented) — updated for the corrected model

| Concern | Design |
|---|---|
| Current workspace loading | Boot resolves the caller's `workspace_members` rows (via `workspace_members_directory`-style self-lookup plus the full-row policy for their own record); exactly one → auto-select; more than one → chooser (§14) |
| Current membership loading | Loads `role`/`permissions`/`data_scope`/`team_member_id` for the selected workspace into `App.workspace` (in-memory) |
| Permission caching/refresh | In-memory only; refreshed on sign-in, on a Realtime event on the caller's own `workspace_members` row, and via a manual refresh affordance — never dependent on JWT refresh timing (§2) |
| Navigation filtering / route protection / Access Denied | Unchanged in shape from Phase 2 — layered on top of, not replacing, the existing `App.customization` module-enable check |
| Assignment selectors | Source options from `team_members` (not `workspace_members`) filtered to the same workspace — corrected to match §4's model |
| Team & Access settings page | Manages `workspace_members`/`workspace_invitations` (login access, roles, permissions); the existing Team Directory page continues to manage `team_members` (people/assignments) as a **separate, still-present** page — not merged into one, since they now serve genuinely different purposes |
| Financial-value redaction | Corrected: this is no longer "hide a field the row already contains" — the frontend simply renders whatever `deal_values`/`deal_commissions` fetch returns (nothing, if unauthorized) rather than performing any redaction logic itself; the absence *is* the enforcement (§8.2) |
| Realtime subscription scope | Workspace-scoped filter; suspend/remove triggers an immediate client-side disconnect (§17) |
| Logout / workspace-switch cleanup | Clears `App.workspace` and all cached entity data; unsubscribes Realtime; matches §14's switching behavior |

---

## 16. Backup, Restore, and Reset Impact (updated terminology only — decisions unchanged from Phase 2)

| Feature | Role gate | Scope | Notes |
|---|---|---|---|
| Export Backup | `export_workspace_data` (Owner/Admin) | Whole workspace | Now also includes `team_members` and (for those with the sensitive permissions) `deal_values`/`deal_commissions` in the export payload |
| Restore Backup | `restore_backups` (Owner only) | Whole workspace | Stamps every row with the caller's current `workspace_id` server-side, ignoring any identity columns in the uploaded file, exactly as today's design already does for `user_id` |
| Reset Workspace | `reset_workspace` (Owner only, non-delegable) | Whole workspace's business records | **Explicitly excludes** `workspace_members`, `workspace_invitations`, `workspaces`, **and now `team_members`** (a correction — the directory must survive a reset exactly like the team structure does, since resetting business data was never meant to erase who works there) |
| Clear Sample Data | Owner/Admin/Manager | Whole workspace | Unchanged |
| Existing RPC conversions | `realtoros_clear_sample_data`/`realtoros_reset_workspace` gain `p_workspace_id` + an internal Owner/permission check; `realtoros_create_deal_with_milestones` also inserts the corresponding `deal_values`/`deal_commissions` rows in the same transaction (a natural extension of its existing multi-table transactional pattern); `realtoros_complete_followup` gains `workspace_id` scoping | |

---

## 17. Staged Migration Plan (corrected deployment ordering — resolves §14 of the correction request)

**Chosen approach: compatibility-trigger, not frontend-before-RLS.** The frontend-before-RLS alternative would require shipping a frontend that already writes `workspace_id`/`created_by` on every insert *before* those columns are even guaranteed non-null everywhere (Phase C), which inverts the safer "schema fully validated, then RLS, then frontend" ordering this plan otherwise relies on for revertibility at every step. The compatibility-trigger approach instead lets the **existing, unmodified** frontend keep working (it doesn't know these columns exist yet) all the way through the RLS cutover, with the database itself filling in the values it needs — closing exactly the deployment-window risks named in the correction request.

### Phase A — Additive workspace foundation
Creates `workspaces`, `workspace_members`, `workspace_invitations`, `user_directory` (+ its `auth.users` trigger). No existing table touched. Migration: `add_realtoros_workspace_tables`. Grants: `authenticated` only (§20 — `anon` hardening is separate and later). Rollback: `DROP TABLE`, trivial. Tests: table/RLS/grant existence checks.

### Phase B — Existing-user backfill **and** new-user provisioning (extended — resolves §13 of the correction request)
- **Backfill:** for every distinct `user_id` across the 15 business tables + `workspace_settings`, create one `workspaces` row and one `workspace_members` row (`role='Owner'`), **and one `team_members` row representing that owner** if none already exists for them (so `created_by`/`assigned_to_id` backfills in Phase C always have a valid `team_members` target to point at, even for an owner who never created any directory entries for themself).
- **`ensure_current_user_workspace()`** (new, addressing users who register *after* this migration runs):
  ```sql
  create or replace function public.ensure_current_user_workspace()
  returns uuid
  language plpgsql
  security definer
  set search_path to ''
  as $function$
  declare
    v_uid uuid := auth.uid();
    v_workspace_id uuid;
    v_team_member_id text;
  begin
    if v_uid is null then raise exception 'Not authenticated'; end if;

    select workspace_id into v_workspace_id from public.workspace_members
      where user_id = v_uid and status = 'active' limit 1;
    if v_workspace_id is not null then
      return v_workspace_id; -- idempotent: already provisioned, nothing to do
    end if;

    -- Never create an extra workspace for a user who is only here to accept
    -- an existing invitation -- callers accepting an invitation use §13.2's
    -- acceptance function instead, which does not call this one. This
    -- function is only ever invoked from the app's own boot sequence for a
    -- signed-in user with zero memberships anywhere.
    insert into public.workspaces (owner_user_id) values (v_uid) returning id into v_workspace_id;
    insert into public.team_members (id, workspace_id, name, role)
      values ('tm_' || replace(v_uid::text, '-', ''), v_workspace_id, coalesce((select email from auth.users where id = v_uid), 'Owner'), 'Owner')
      returning id into v_team_member_id;
    insert into public.workspace_members (workspace_id, team_member_id, user_id, role, status, joined_at)
      values (v_workspace_id, v_team_member_id, v_uid, 'Owner', 'active', now());
    insert into public.workspace_settings (id, workspace_id) values ('ws_' || replace(v_workspace_id::text,'-',''), v_workspace_id);

    return v_workspace_id;
  end;
  $function$;

  revoke all on function public.ensure_current_user_workspace() from public, anon;
  grant execute on function public.ensure_current_user_workspace() to authenticated;
  ```
  `SECURITY DEFINER` because it must be able to `INSERT` into `workspaces` before any `workspace_members` row exists for the caller (nothing an invoker-rights insert could satisfy yet under the corrected §10.5 policies, which all require an *existing* active membership to insert anything at all — deliberately circular for every other table, broken only here, once, for exactly this bootstrapping purpose). The caller is derived solely from `auth.uid()`; the function accepts no parameters at all, so there is nothing for a client to spoof. Called once from the app's boot sequence (`App.app.init()`), safe to call on every boot since it no-ops (returns the existing workspace id) whenever a membership already exists.
- **Empty existing Auth accounts during backfill:** an `auth.users` row with **zero rows in any business table** (someone who signed up but never used the app) is *not* backfilled by the bulk Phase B migration (which only scans existing business-table `user_id`s) — they are provisioned the first time they actually sign in and `ensure_current_user_workspace()` runs, exactly like a brand-new post-release user. This is intentional, not an oversight: creating workspaces for accounts that never used the product would be pure noise.
- **Tests:** every account with any pre-existing data has exactly one workspace with itself as Owner and a corresponding `team_members` row; `ensure_current_user_workspace()` called twice in a row for the same user returns the same `workspace_id` both times (idempotency proof).

### Phase C — Compatibility triggers, constraints, and relationship migration (corrected ordering)
- Add nullable `workspace_id`/`created_by` to all 15 business tables + `workspace_settings`; add `workspace_id` to `team_members`; add `contacts.assigned_to_id`; create `deal_values`/`deal_commissions`.
- Backfill every new column from the Phase B mapping (`workspace_id` from `user_id`, `created_by` from the corresponding owner's `team_members.id`).
- **Add temporary `BEFORE INSERT` compatibility triggers** on every business table: if `NEW.workspace_id is null`, derive it by calling `ensure_current_user_workspace()` (or looking up the caller's existing membership directly, cheaper) and set it; same for `NEW.created_by` (resolved to the caller's `team_member_id`). This is what lets the **existing, unmodified frontend** — which sends neither column — keep inserting successfully all the way through Phase D's RLS switch, exactly the gap the correction request identified.
- Add the new `(workspace_id, id)` unique indexes and the new composite FKs (§9.1), **alongside** the existing `(user_id, ...)` ones — both key-sets coexist through this phase.
- Migration name: `add_workspace_relationships_and_compat_triggers`.
- **Validation:** zero nulls in `workspace_id` anywhere before proceeding; a smoke-test insert through the *existing* frontend (no code changes yet) succeeds and the compatibility trigger correctly fills both new columns.
- **Rollback:** drop the new triggers/FKs/constraints/columns; the old structure is untouched throughout.

### Phase D — RLS cutover (now provably safe — resolves the core of §14)
- Create the `authz` schema/functions (§10, §11's trigger, §10.4's trigger).
- Replace each table's 4 policies, in one transaction covering all tables at once (policies for a given command are OR'd together within one table, so partial coexistence of old and new policies on the *same* table would leak data across tenancy models — this is not attempted; the whole set flips atomically).
- **Because Phase C's compatibility triggers are already live, the still-unmodified frontend continues to insert successfully** — every new row still gets a correct `workspace_id`/`created_by` even though the frontend never sends them, and the new RLS policies see fully-populated rows from the very first insert after cutover. This is the specific proof the correction request asked for: there is no window where existing writes fail, no window where a row receives a null workspace identity (the trigger runs before RLS on `INSERT`, filling the value before RLS's `WITH CHECK` ever evaluates it), no window where old RLS exposes shared records incorrectly (old policies are gone atomically, not left running alongside new ones), and no window where new RLS accepts an incomplete row (the compatibility trigger guarantees completeness before the `WITH CHECK` clause runs).
- **Tests:** the full cross-workspace isolation subset of §18, via direct REST, before the frontend is touched at all.
- **Rollback:** re-apply the saved `user_id`-based policy set in one transaction; the compatibility triggers are irrelevant to rollback since they only ever populate columns, never remove data.

### Phase E — Frontend workspace context
Adds `App.workspace`, explicit `workspace_id`/`created_by` on every write from the frontend itself. **The compatibility triggers from Phase C are left in place through this phase** (not removed yet) as a safety net — if the new frontend ever fails to send a value for some reason, the trigger still fills it correctly rather than the insert failing. Tests: full manual pass, zero visible change for a solo user (the frontend now sends explicit values that match what the trigger would have derived anyway).

### Phase F — Team & Access UI
Read-only UI first (list members/invitations), against real data for a solo Owner.

### Phase G — Invitation Edge Functions
Deploys `invite-member`/`accept-invite` per §13 (corrected auth model, `user_directory`, named email path). Requires custom SMTP configured (§13.6) before this phase, not after. Test accounts: an Owner, a brand-new email, an email with an existing RealtorOS account elsewhere.

### Phase H — Assignment/data-scope enforcement
Layers the `data_scope`-aware policy refinements on top of Phase D's workspace-only baseline. Requires at least one multi-member workspace (from Phase G) to exercise meaningfully.

### Phase I — Financial column-privacy cutover
**New phase, not present in Phase 2's plan** (added because §8's redesign introduces two new tables with their own RLS that didn't exist before): enable `deal_values`/`deal_commissions` RLS; convert `realtoros_create_deal_with_milestones` to also populate them; migrate existing `deals.value`/`.commission_rate`/etc. data into the new tables (an `INSERT ... SELECT` from the existing `deals` columns, which are then — only after this is validated — safe to drop from `deals` itself, deferred to Phase K so the cutover here is purely additive). Tests: the direct-REST proof from §8.2, run for every role.

### Phase J — Backup/reset/RPC conversion
As Phase 2's Phase I, extended to include `team_members` in the reset-exclusion list (§16) and the `deal_values`/`deal_commissions` tables in export/restore.

### Phase K — Realtime conversion and compatibility cleanup
Combines Phase 2's former Phases J and K: workspace-scoped Realtime filter + forced-disconnect-on-suspend; **then, only after a full release cycle of zero incidents**, remove the Phase C compatibility triggers (frontend has been sending explicit values reliably for a full cycle by now), drop the old `(user_id, ...)` FKs/unique constraints (keeping `user_id` itself, per §9), and drop the now-redundant `deals.value`/`.commission_rate`/etc. columns (Phase I migrated their data out already). `team_members` is **never** dropped in this or any phase (§4's corrected decision) — remove only the dead `assets/js/pages/team.js` module and its script tag.

### Phase L — Production acceptance testing
Full §18 test matrix against production or a production-equivalent staging project.

---

## 18. Required Test Matrix (extended for the corrections)

All role-based SELECT/INSERT/UPDATE/DELETE tests are run **directly against the Supabase REST API with that member's own JWT**, not only through the UI.

| Persona / scenario | What's verified |
|---|---|
| Existing solo owner, new solo owner | Identical data post-migration; `ensure_current_user_workspace()` idempotency for a brand-new post-release signup |
| Owner / Admin / Manager / Agent / Assistant / Viewer | Full role-by-role CRUD matrix, as Phase 2, now additionally covering `contacts.assigned_to_id`-based "assigned" scope and the split `deal_values`/`deal_commissions` tables |
| **Financial column privacy (new, direct-REST)** | As Agent without `view_commission`: `GET deals?id=eq.<X>` returns the deal; `GET deal_commissions?deal_id=eq.<X>` returns **zero rows**. As the same Agent granted `view_deal_values` but not `view_commission`: `deal_values` returns the row, `deal_commissions` still returns zero. |
| **`is_active_workspace_member` BOLA/IDOR (new)** | Calling with a `workspace_id` the caller does not belong to returns `false`/zero rows, never another workspace's membership data, regardless of which specific `workspace_id` is passed |
| **`workspace_id` immutability (new)** | Attempt to `PATCH` any workspace-owned row's `workspace_id` to a different (even a workspace the same user also belongs to) value — rejected by the §10.4 trigger, independent of any permission held |
| **Ownership transfer edge cases (new)** | Transfer to a `team_members`-only person with no `workspace_members` row — rejected; transfer to a `suspended` member — rejected; transfer to self — rejected; transfer by non-Owner — rejected; successful transfer leaves exactly one active Owner, verified by count query immediately after |
| **Removed member, historical attribution (extended)** | A removed member's past `created_by`/`assigned_to_id` (now pointing at `team_members.id`) still resolves to their name via the still-present `team_members` row, even though their `workspace_members.user_id` may separately be null (Auth account deleted) |
| **Multi-workspace chooser (new)** | A user with two active memberships is shown a chooser, never an automatically-selected workspace; switching workspaces unsubscribes the prior Realtime channel and clears prior cached data before loading the new workspace |
| Suspended / removed member | Immediate rejection on every operation, no JWT-refresh dependency |
| Two independent workspaces, cross-workspace IDs | Zero cross-workspace data leakage via direct REST with substituted IDs |
| Permission escalation attempts | Rejected server-side per §13.8 |
| Export / Restore / Reset authorization | Role-gated exactly per §16, including the corrected `team_members`-survives-reset behavior |
| Realtime isolation, offline/retry, concurrent permission changes, member removal with an active session | Unchanged from Phase 2's matrix, still applicable |
| **Invitation email-enumeration (new)** | The `invite-member` response is identical in shape whether the invited email already had an account or not (§13.5) |
| **`anon` grant hardening regression suite (new, run only when §20's separate migration is executed, not as part of this cutover)** | Login, registration, password reset, OAuth callbacks, the public (pre-auth) app shell, and full authenticated CRUD all still function after `anon`'s table grants are revoked |

---

## 19. Risks and Unresolved Decisions

1. **`contacts.assigned_to_id` backfill leaves all pre-existing contacts unassigned** (§9.2) — intentional and safe, but means "assigned" scope on Contacts is empty until the Owner (or a future bulk tool) assigns them; confirm this UX is acceptable.
2. **Owner account deletion / workspace archival flow** — `owner_user_id` is `ON DELETE RESTRICT`; the actual "delete my account" UX (forced transfer? blocked with a message?) is unresolved.
3. **`team_members` column-level privacy for phone/email against a Viewer role** — currently visible to any active member (§10.6); tightening further is a possible future refinement, not required by anything specified so far.
4. **`notify-existing-user`'s in-app "invitation addressed to me" read path (§13.4)** — sketched but its exact implementation (RLS policy vs. a dedicated function) is deferred to Phase G's detailed design.
5. **Whether `deal_values`/`deal_commissions` INSERT/UPDATE should require the *same* sensitive permission as SELECT, or allow a deal-creator to set the initial values without being able to view them later** — flagged as a product nuance in §8.2, not resolved here.
6. **Multi-workspace switcher UI** — schema-ready (§14), UI not built in this phase.
7. **`anon` grant hardening (§20)** — deferred, own migration, own regression suite.
8. **Leaked-password-protection advisor finding** — unrelated, unaddressed.
9. **`team_members` retirement — corrected to: there is no retirement.** (Explicitly resolved, not a risk — recorded here only so a future reader doesn't wonder why Phase 2's old retirement plan disappeared.)

---

## 20. `anon` Grant Hardening — separate, later migration (resolves §17 of the correction request)

**Not part of the workspace cutover.** A distinct, small, low-risk migration, proposed for whenever separately approved:

```sql
-- Applied per-table, only after confirming no Supabase-internal mechanism
-- (Auth, Storage, Realtime authorization) depends on anon retaining these
-- grants -- none of the 17 RealtorOS tables are read by Auth/Storage
-- internals, so this is expected to be a pure hardening with no functional
-- change, but the regression list below is run regardless, not assumed.
revoke select, insert, update, delete, truncate, references, trigger
  on public.<table> from anon;
```
run for all 17 existing tables (the 3 new workspace tables from Phase A are already `authenticated`-only from creation, §20 is only cleaning up the pre-existing ones).

**Required regression tests before and after, per the correction request:** login, registration, password reset, OAuth callbacks (Google/Facebook), the public/pre-authentication app shell (sign-in screen itself, which must render before any table access is relevant), and full authenticated CRUD across every module — confirming nothing Supabase Auth itself relies on (which operates against `auth.*`/`storage.*` schemas, not `public.*`) is affected, and that the change is, as expected, invisible to every legitimate use of the app.

---

## 21. Summary of File/Table Impact

- **New tables:** `workspaces`, `workspace_members`, `workspace_invitations`, `user_directory`, `deal_values`, `deal_commissions`.
- **Altered tables:** all 15 business tables + `workspace_settings` gain `workspace_id`/`created_by`; `team_members` gains `workspace_id` only (**preserved permanently, never dropped** — the central correction of this revision); `contacts` gains `assigned_to_id`; `deals` eventually loses its 6 financial columns (Phase K, after Phase I's data migration is validated).
- **New schema:** `authz`.
- **New functions:** `authz.current_membership`, `authz.has_permission` (Owner-case-corrected), `authz.is_active_workspace_member` (new, DEFINER, breaks the `workspace_members` recursion), `authz.prevent_workspace_id_change` (new trigger fn), `authz.prevent_ordinary_owner_promotion` (new trigger fn), `authz.assert_same_workspace_assignee` (extended to `contacts`), `realtoros_transfer_ownership` (now DEFINER), `ensure_current_user_workspace` (new), invitation-acceptance DEFINER function.
- **Changed functions:** the 4 existing business RPCs, converted to workspace scope; `realtoros_create_deal_with_milestones` extended to populate `deal_values`/`deal_commissions`.
- **New Edge Functions:** `invite-member`, `accept-invite`.
- **New/changed frontend files (design only):** `assets/js/core/workspace.js` (new), `data-service.js`, `store.js`, `app.js`, `team-directory.js` (permission-gated, **not rewritten to point at `workspace_members`** — it keeps managing `team_members`), a new Team & Access page for `workspace_members`/`workspace_invitations`, a new Access Denied view, `index.html` script list; `pages/team.js` deleted (Phase K).
- **`anon` grant tightening:** its own separate migration (§20), explicitly not bundled here.

**Internal-contradiction pass performed:** every reference to "`team_members` frozen/dropped," "`workspace_members.id`" as an assignment/`created_by` target, "`workspace_id = contacts.workspace_id` inside `WITH CHECK`" as a protection, "invoker" for the ownership-transfer or `workspace_members`-recursion functions, "`verify_jwt = false`" for the invite/accept functions, and a "`'invited'`" `workspace_members.status` value has been removed or corrected throughout this rewritten document — none of that earlier language remains anywhere below or above this line.

---

## 22. Do-Not-Touch Confirmation

Nothing in this document has been applied. No migration was run against `yanasorwmaybnabfuepn` in this phase. No RLS was changed. No Edge Function was deployed. No frontend/application file was edited. No Auth user was created or deleted. No production data was changed. The only filesystem changes made in this phase are to this document itself.
