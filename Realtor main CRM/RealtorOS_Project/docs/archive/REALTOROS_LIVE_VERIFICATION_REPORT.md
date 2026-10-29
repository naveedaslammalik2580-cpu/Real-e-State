# RealtorOS — Live Supabase Verification

Date: 2026-08-27 UTC  
Project: `yanasorwmaybnabfuepn` (`Realtor OS`)

## Database: verified live

The only application table in `public` is `workspace_state` (RLS enabled, 2 rows at verification). Its live schema is:

| Column | Type | Constraint / default |
|---|---|---|
| `user_id` | `uuid` | Primary key; foreign key to `auth.users(id)` |
| `state` | `jsonb` | Not null; default `{}` |
| `schema_version` | `integer` | Not null; default `3`; check `>= 1` |
| `created_at` | `timestamptz` | Not null; default `now()` |
| `updated_at` | `timestamptz` | Not null; default `now()` |

Supabase reports applied migration `20260827040054 / create_realtoros_workspace_state`. Auth also contains Supabase-managed internal tables such as `auth.users`, `auth.identities`, `auth.sessions`, and refresh-token/audit/MFA/OAuth tables; these are not RealtorOS data tables.

## Frontend connection evidence

`RealtorOS_Online.html` embeds the live project URL `https://yanasorwmaybnabfuepn.supabase.co` and the project publishable key. It constructs a client with `window.supabase.createClient`, reads `workspace_state` on authenticated boot, and upserts it after each normal `App.store` save. The cloud calls are contained in `App.cloud`, not in feature UI modules.

The exact REST paths used by the browser client were tested live with the same project URL/key and real authenticated sessions:

* Account A created and read its workspace: `POST /rest/v1/workspace_state` returned `201`; `GET` returned its marker `account-A` and private contact.
* Account B created and read its own empty workspace: `POST` returned `201`; `GET` returned only B's `account-B` row.

Browser console verification could not be completed: this runtime has no installed Chromium and downloading Playwright Chromium repeatedly timed out. JavaScript parsing did pass for all 30 inline blocks, but that is not a browser console test.

## Authentication test

Project Auth settings show email/password enabled, signup enabled, and `mailer_autoconfirm=false` (email confirmation is required). The real signup endpoint was reached, but its mail sender returned `429 over_email_send_rate_limit`; therefore no email-link confirmation could be performed.

To continue the live RLS test without claiming that email delivery worked, two clearly-labelled, confirmed database test identities were created and authenticated through the real password-token endpoint:

| Account | User ID | Password login |
|---|---|---|
| A | `a1111111-1111-4111-8111-111111111111` | `200`, bearer session returned |
| B | `b2222222-2222-4222-8222-222222222222` | `200`, bearer session returned |

This validates real Supabase password authentication/session issuance, but does **not** validate the user-facing signup email or the browser form itself because of the sender rate limit and missing browser runtime.

## Isolation test: verified live

Using account B's real bearer session:

* `GET /rest/v1/workspace_state?user_id=eq.<A-id>` returned `200 []`.
* Attempting `POST`/upsert with A's `user_id` returned `403` with `new row violates row-level security policy for table "workspace_state"`.

The enforcing policies are:

* SELECT / DELETE: `auth.uid() = user_id`
* INSERT: `WITH CHECK (auth.uid() = user_id)`
* UPDATE: both `USING` and `WITH CHECK` require `auth.uid() = user_id`

## Tenancy model

The implementation is **single-tenant per user**, not a shared multi-user workspace model. Each authenticated user owns exactly one row and cannot share it. True multi-tenant workspaces with memberships, invitations, and Owner/Admin/Manager/Member/Viewer roles are not present; that is a separate future phase.
