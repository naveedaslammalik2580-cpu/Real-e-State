# Phase T4 — Team UI

**Status:** BUILT. The screens below shipped in commit `688e5e3` ("T4: the Team
UI"), and the follow-ups in `73a3a04`.
**Prerequisite:** the T3 migration (`supabase/migrations/*_phase_t3_invitations_membership.sql`)
must be applied to the target project.

**Correction to this spec:** it says below that T4 is browser code only and needs
no migration of its own. That turned out to be wrong. Building the screens
exposed two gaps that had to be closed in the database, so T4 also ships
`supabase/migrations/20261013120000_phase_t4_followups.sql` (199 lines):

1. `realtoros_list_members` returns each member's `permission_overrides` to a
   `team_manage` holder. Without it the exceptions editor had to start from the
   role template and silently dropped whatever was already stored, because
   `workspace_members` is select-your-own-row only.
2. A `BEFORE UPDATE` trigger on `workspace_settings`
   (`automation_internal.guard_team_mode_off`) refuses switching team mode off
   while any other member is still active, raising `team_mode_has_members`.
   Team mode was a UI switch enforced nowhere.

It also fixed a bug that made the second point moot on its own: `teamMode` was
never persisted at all, because `settingsToRow` mapped only `enabledModules`,
`dashboardWidgets` and `branding` out of customization.

That migration is **not yet applied to the live project**. Its rollback file is
`supabase/rollback/t4_followups_revert.sql`.

This document is self-contained. Everything an implementer needs — the RPC
contracts, the existing front-end conventions, the permission model, the
screens, the empty states and the tests — is below. No other document needs to
be read.

---

## 1. What already exists

### 1.1 The app shell

Plain-browser, no build step. Scripts are plain `<script>` tags in
`app/index.html`, each file an IIFE that hangs itself off a global `App`:

```js
window.App = window.App || {};
App.pages = App.pages || {};
App.pages.teamManagement = (function () { "use strict"; /* ... */ })();
```

Relevant files:

| Path | What it is |
| --- | --- |
| `app/index.html` | the only script manifest; a new page file must be added here |
| `app/assets/js/app.js` | nav model (`NAV`), the router, `App.app.navigate/icon/setBreadcrumbs/setTopActions/toast` |
| `app/assets/js/pages/release.js` | `SETTINGS_CATEGORIES` + `renderSettings` / `renderSettingsCategory` — the Settings shell every settings screen plugs into |
| `app/assets/js/data/data-service.js` | `App.store` — every Supabase call the UI makes, as named async methods |
| `app/assets/js/data/workspace.js` | `App.workspace` — the caller's role and permissions, for showing/hiding |
| `app/assets/js/pages/team.js` | Settings → **Active Identity** (`cat: "team"`), the "working as" selector. Legacy, local-only. Not this phase. |
| `app/assets/js/pages/team-directory.js` | the `/team-dir` route — the `team_members` **directory** (names, phones, notes). Legacy, local-only. Not this phase. |

T4 is a NEW screen. `team.js` and `team-directory.js` must not be repurposed:
the directory is "who exists as a label you can assign work to", T4 is "who has
an account and what they may do". Different tables (`team_members` vs
`workspace_members`), different concepts.

### 1.2 How a Settings screen is registered

Three edits, following `custom-fields-settings.js` exactly:

1. `app/index.html` — add `<script src="assets/js/pages/team-management.js"></script>`.
2. `release.js`, `SETTINGS_CATEGORIES` (around line 518) — add to the `TEAM` group:
   ```js
   { id: "team-access", label: "Team & Access", icon: "users", group: "TEAM" },
   ```
   Leave the two existing `TEAM` rows (`team` → Active Identity, `team-directory`
   → `/team-dir`) alone.
3. `release.js`, `renderSettingsCategory` — add a branch in the same style:
   ```js
   else if (cat === "team-access") { if (App.pages.teamManagement) await App.pages.teamManagement.render(pane); }
   ```

The category renders into a `pane` element the shell supplies. The page owns
everything inside it and nothing outside it.

The **accept** screen is NOT a settings category: it is reached from a link by
someone who may not be a member of anything yet. Add it as a top-level route in
`app.js`, in the same `else if` chain as the other routes, with no `NAV` entry:

```js
else if (path === "/join") await App.pages.teamJoin.render(page, tokenFromLocation());
```

Keep the token parsing in one small exported function inside `team-join.js` so
it can be tested directly, and match whatever `app.js` already does for routing
(if the app is hash-routed, the token has to live in the hash).

### 1.3 `App.workspace` — the permission source

One cached RPC per session (`realtoros_my_permissions`). API:

```js
await App.workspace.load(force)   // resolves to the context; pass true to refresh
App.workspace.ready()             // false until load() has resolved
App.workspace.id()                // workspace id, or null
App.workspace.role()              // 'owner' | 'admin' | 'agent' | null
App.workspace.memberId()          // the CALLER's workspace_members.id
App.workspace.teamMemberId()      // the caller's team_members.id
App.workspace.isOwner()
App.workspace.can('team_manage')  // one of the ten permission booleans
App.workspace.canViewSettings() / canEditSettings()
App.workspace.onChange(fn)        // returns an unsubscribe function
```

Every accessor answers "no access" before `load()` resolves, so a screen that
renders early hides rather than reveals.

**This is for showing and hiding only. It is not security.** The RPCs re-check
every permission server-side; a member who edits `App.workspace` in the console
gets buttons that fail on the server, which is the correct outcome. T4 must not
treat a client-side check as sufficient, and must not hide a server refusal by
pretending the action succeeded.

### 1.4 How `data-service.js` wraps an RPC

Match this shape (condensed from `createDealWithMilestones`):

```js
async function inviteMember(email, role) {
  requireUser();
  const { data, error } = await client().rpc("realtoros_invite_member", { p_email: email, p_role: role });
  if (error) throw error;
  return data;                     // the jsonb outcome object, unchanged
}
```

Rules the existing code follows and T4 must follow:

- One method per RPC, camelCase, added to the big `return { ... }` object at the
  end of the module (around line 2393).
- Arguments are passed as `p_`-prefixed keys, exactly as the SQL declares them.
- A Postgres error is **thrown**; a business outcome is **returned**. These RPCs
  return an `outcome` string for everything a user can cause and raise only for
  "not authenticated" and "permission required" (SQLSTATE 42501). So `catch`
  means "this went wrong" and a non-success `outcome` means "the server said no,
  here is why" — the second must be rendered as a message, never as a thrown
  error.
- `setSyncState(...)` is for cached-entity writes. Membership operations are not
  cached entities: leave sync state alone and report through the screen plus
  `App.app.toast`.
- After any call that changes the caller's own role, membership or workspace
  (`acceptInvitation`, `leaveWorkspace`, `deleteWorkspace`, and
  `transferOwnership`, because it demotes the caller), call
  `await App.workspace.load(true)` and `App.store.resetAllCaches()` before
  re-rendering: their permissions and their whole data scope have changed.

---

## 2. Listing the members

### 2.1 Why it is an RPC

Nothing the browser can read gives the UI a usable roster:

- `public.workspace_members` is `revoke all` from `authenticated` apart from
  `select`, and its only select policy is `workspace_members_select_own`
  (`user_id = auth.uid()`). A manager can read **their own** membership row and
  no one else's.
- `public.team_members` IS readable workspace-wide
  (`team_members_select_scoped`: `workspace_id = authz.my_workspace_id()`), but
  holds only the directory label — `name`, `role` as a display string
  (`'Admin'`/`'Agent'`), `email`, `active` — and **not** `workspace_members.id`.
- Every management RPC (`realtoros_remove_member`,
  `realtoros_change_member_role`, `realtoros_transfer_ownership`, and T2b-1's
  `realtoros_set_member_permissions` / `realtoros_reset_member_permissions`)
  takes `p_member_id uuid` = `workspace_members.id`.

So T3 supplies `realtoros_list_members`, which joins the two and is the only
way the UI learns the ids it needs to act on anyone.

### 2.2 `realtoros_list_members()`

**Any active member may call it** — the roster is needed to render a name next
to a lead, a deal or a task, so it is not gated on `team_manage`. What differs
is how much comes back.

| outcome | payload |
| --- | --- |
| `ok` | `can_manage` (boolean), `members: [...]` |
| `no_workspace` | the caller has no active membership |
| raises | not authenticated |

Each member row:

| field | notes |
| --- | --- |
| `member_id` | `workspace_members.id` — **this is what every membership RPC takes** |
| `user_id` | for "this is you" comparisons |
| `team_member_id` | the directory row, for assignment UI |
| `name` | the directory name, falling back to the local part of the email, so a row always has something to render |
| `email` | normalized, from the auth account |
| `role` | `owner` \| `admin` \| `agent` |
| `status` | `active` \| `suspended` \| `removed` |
| `is_self` | true on the caller's own row |
| `joined_at`, `updated_at` | timestamps |

Ordering is decided server-side so every caller agrees: owner first, then
admins, then agents, alphabetically by email within a rank.

**Visibility.** A `team_manage` holder gets the whole roster, including
`suspended` and `removed` people, because that is the list they administer.
Everyone else gets the `active` members only, so somebody leaving or being
removed is not announced to the whole workspace. `can_manage` tells the UI
which of the two lists it just received, so it does not have to decide
separately. A suspended or removed person gets `no_workspace`.

`data-service.js` method: `listMembers()`.

---

## 3. The T3 RPC contract

All ten (the nine below plus `realtoros_list_members` from §2) are
`security definer`, take `p_`-prefixed arguments and return `jsonb` with an
`outcome` key. "Raises" means a thrown Postgres error with SQLSTATE
42501, which the client sees as a rejected promise.

### 3.1 `realtoros_invite_member(p_email text, p_role text)`
Needs `team_manage`.

| outcome | meaning / payload |
| --- | --- |
| `invited` | `invitation_id`, **`token`**, `email`, `role`, `expires_at` |
| `invalid_role` | `p_role` was not `admin` or `agent` |
| `invalid_email` | length not 3–254, no `@` after position 1, or whitespace/control characters |
| `already_a_member` | that address is an active member |
| `already_invited` | a live pending invitation for that address exists |
| `no_workspace` | the caller has no active membership |
| raises | not authenticated; `team_manage` missing |

The invitation lives **7 days**. `token` is 32 random bytes as hex and is
returned **exactly once** — only its SHA-256 hash is stored and the plaintext
cannot be recovered. A lost token means revoke and re-invite. So the UI shows
the link immediately, makes copying it the primary action, and says plainly that
it cannot be shown again.

### 3.2 `realtoros_list_invitations()`
Needs `team_manage`. `{ outcome: 'ok', invitations: [...] }`, newest first. Each
row: `id`, `email`, `role`, `status`, `expires_at`, `created_at`, `accepted_at`,
`invited_by_email`. `status` is `pending`, `accepted`, `revoked` or `expired`; a
pending row past its expiry reports `expired` immediately, without waiting for
any sweeper. Never returns `token_hash`. Also `no_workspace`; raises as above.

### 3.3 `realtoros_revoke_invitation(p_invitation_id uuid)`
Needs `team_manage`. Outcomes: `revoked` (also when already revoked — it is
idempotent), `not_found`, `already_accepted` (remove the member instead),
`no_workspace`; raises as above.

### 3.4 `realtoros_accept_invitation(p_token text)`
**Needs only an authenticated session** — the caller is not a member yet.

| outcome | meaning / payload |
| --- | --- |
| `accepted` | `workspace_id`, `role`, `member_id`, `team_member_id` |
| `invalid_token` | no such token, or shorter than 16 characters |
| `expired` | past `expires_at` (the row is marked expired as a side effect) |
| `revoked` / `accepted` | the invitation's own status, echoed back |
| `email_mismatch` | + `invited_email`: the signed-in account's email is not the invited address |
| `already_a_member` | they are already active in that workspace |
| `own_workspace_not_empty` | their current workspace holds real work |

`email_mismatch` is what makes a forwarded link useless to anyone else: the
invitation is for an **address**, not for whoever holds the link.

`own_workspace_not_empty` needs real copy, not an error code. One active
membership per person is enforced by a unique index, so accepting means setting
the caller's auto-provisioned personal workspace aside — which the server only
does when that workspace holds no contacts, deals, properties, tasks, finance
records, goals, automation rules or scheduled items. Otherwise it refuses rather
than orphan their work. Tell them: this account already has data in its own
workspace, so it cannot join another; use a different account, or clear it first.

### 3.5 `realtoros_remove_member(p_member_id uuid)`
Needs `team_manage`. Outcomes: `removed` (+ `member_id`), `not_found`,
`already_removed`, `cannot_remove_owner` (transfer ownership first),
`cannot_remove_self` (use Leave), `no_workspace`; raises as above. Sets
`status = 'removed'` and deactivates the directory row; never deletes, so
historical assignments still resolve to a person.

### 3.6 `realtoros_change_member_role(p_member_id uuid, p_role text)`
Needs `team_manage`. Target role is `admin` or `agent`.

| outcome | meaning / payload |
| --- | --- |
| `changed` | `member_id`, `from_role`, `to_role` |
| `unchanged` | + `role`: already that role |
| `invalid_role` | not `admin`/`agent` |
| `not_found` / `not_active` | |
| `cannot_change_owner` | the owner changes only via transfer |
| `exceeds_your_permissions` | + `role`, **`reason`** |
| `no_workspace` | |

`exceeds_your_permissions` means the proposed role would confer a permission the
actor does not hold — nobody grants what they do not have. `reason` names the
specific permission that blocked it, and the UI must show it rather than a
generic refusal.

### 3.7 `realtoros_transfer_ownership(p_member_id uuid)`
**Owner only** — it raises 42501 for anyone else, `team_manage` is not enough.
Outcomes: `transferred` (+ `new_owner_member_id`, `previous_owner_role: 'admin'`),
`not_found`, `target_not_active`, `already_owner`, `no_workspace`. The sitting
owner becomes an **admin**; they do not leave. Not reversible by the caller
afterwards — only the new owner can transfer back. Confirm explicitly.

### 3.8 `realtoros_leave_workspace()`
Any active non-owner; no permission needed. Outcomes: `left` (+
`left_workspace_id`, `new_workspace_id`, `leads_unassigned`,
`items_handed_to_owner`), `owner_cannot_leave`, `not_a_member`, `no_workspace`.

What leaving does, which the confirmation must state because none of it is
reversible by the person leaving: their contacts, deals, tasks and scheduled
items are **unassigned but stay in the workspace**; their **personal** templates,
scripts, prompts and automation rules pass **to the owner** (shared ones already
belong to the workspace and are untouched); their membership and directory row
are deactivated, not deleted; and they are landed in a workspace of their own, so
they are never signed in with nowhere to be.

### 3.9 `realtoros_delete_workspace(p_confirm_name text)`
**Owner only** (raises 42501 otherwise). Outcomes: `deleted` (+
`deleted_workspace_id`, `deleted_name`, `new_workspace_id`),
`other_members_present` (+ `active_members`), `name_mismatch` (+
`expected_name`), `no_workspace`. Everything in the workspace is deleted by
cascade, including its audit history. The typed name must match exactly after
trimming, **case-sensitively on purpose**. Removing the other members is a
separate, visible decision and has to be done first.

---

## 4. Screens

### 4.1 Settings → Team & Access (`/settings/team-access`)

`App.pages.teamManagement.render(pane)`. The main screen, in this order:

1. **Gate.** `await App.workspace.load()`. If `!App.workspace.can('team_manage')`,
   render only the no-permission state (§5) and stop — do not call any list RPC,
   because it would raise.
2. **Members** — from `listMembers()` (§2.2), filtering to `status: 'active'`.
   One row per active member: name
   (falling back to email), email, a role badge, "You" on the caller's own row,
   and a per-row action menu:
   - **Change role** → `changeMemberRole(memberId, role)`. Hidden on the owner's
     row and on the caller's own row.
   - **Remove** → confirm, then `removeMember(memberId)`. Hidden on the owner's
     row and on the caller's own row.
   - **Make owner** → `transferOwnership(memberId)`. Shown only when
     `App.workspace.isOwner()`, and only on an active non-owner row. The
     confirmation says the caller becomes an admin.
   - **Permissions** → optional in v1: the existing per-member permission RPCs
     (`realtoros_set_member_permissions` / `realtoros_reset_member_permissions`,
     both taking the same `member_id`). If not built, do not show the entry.

   A collapsed **Former members** section lists the `status: 'removed'` and
   `status: 'suspended'` rows, read-only, so a manager can see that someone's
   history is intact. Those rows only arrive when `can_manage` is true, so the
   section simply never appears for anyone else.
3. **Invitations** — from `listInvitations()`. One row per invitation: email,
   role, status badge, expiry as relative time ("expires in 5 days" /
   "expired"), who invited them. Action: **Revoke** on pending rows only →
   `revokeInvitation(id)`. `already_accepted` renders as "they have already
   joined — remove them from Members instead".
4. **Invite** — email, role (`admin` | `agent`), submit. On `invited`, render the
   copy-link panel (§4.2) and refresh the invitations list. Map the other
   outcomes to a message under the field: `invalid_email` → "That does not look
   like an email address."; `already_a_member` → "They are already in this
   workspace."; `already_invited` → "They already have a pending invitation."
   with a pointer to the row; `invalid_role` is unreachable from a closed
   `<select>`, so treat it as a bug and log it.
5. **Leave workspace** — shown to active **non-owners** (not inside the owner
   danger zone). Confirm with §3.8's consequences spelled out, then
   `leaveWorkspace()`; on `left`, refresh `App.workspace`, reset caches, navigate
   to `/dashboard` with a toast naming the new workspace.
6. **Danger zone — delete workspace** — owner only. A modal that requires typing
   the workspace name exactly (case-sensitive; say so) and states that
   everything, including the audit history, goes. Submit →
   `deleteWorkspace(typedName)`. `other_members_present` → "Remove the other N
   members first." (use `active_members`); `name_mismatch` → "The name did not
   match." — do **not** pre-fill or auto-correct from `expected_name`, the typing
   is the guard; `deleted` → reset caches, navigate to `/dashboard`, toast.

Every destructive action (remove, transfer, leave, delete) confirms first and
states what cannot be undone. Nothing here is optimistic: re-read the affected
list after the RPC returns, so what is shown is what the server did.

### 4.2 The invite copy-link panel

**v1 is copy-link only. T4 sends no email and must not imply that it does.**

On `invited`, show a panel built from the returned token — the join URL
(`<origin>/#/join?token=<token>`, matching the app's routing style) — with:

- a read-only, fully selectable field holding the URL;
- a **Copy link** button (`navigator.clipboard.writeText`, with a
  `document.execCommand('copy')` + select-all fallback, and a visible success
  state either way);
- the sentence: this link is shown **once** and cannot be retrieved later; if it
  is lost, revoke the invitation and send a new one;
- who it is for and when it expires ("for alice@example.com · expires in 7 days");
- a note that the link only works for the invited address.

The token must not be written to `localStorage`, into the current page's URL, or
to any log. The panel is dismissible, and dismissing it is a deliberate "I have
copied it" action.

### 4.3 Join (`/join?token=...`)

`App.pages.teamJoin.render(page, token)`. Reached by the invited person, who may
not be a member of anything yet and may arrive in a cold browser.

1. Not signed in → ask them to sign in or sign up **with the invited address**,
   preserving the token across the round trip and saying why (the invitation is
   tied to that address). Do not drop the token on redirect.
2. Signed in → show what they are accepting and one primary **Accept invitation**
   button → `acceptInvitation(token)`.
3. On `accepted`: `App.workspace.load(true)`, `App.store.resetAllCaches()`, then
   navigate to `/dashboard` with a toast naming the workspace and role.
4. Outcome copy — all expected, none a crash:
   - `invalid_token` → "This invitation link is not valid. Ask for a new one."
   - `expired` → "This invitation has expired. Ask for a new one."
   - `revoked` → "This invitation was revoked."
   - `accepted` (status echo) → "This invitation has already been used."
   - `email_mismatch` → "This invitation is for `invited_email`. You are signed
     in as X. Sign in with the invited address." Offer a sign-out action.
   - `already_a_member` → "You are already in this workspace." → `/dashboard`.
   - `own_workspace_not_empty` → the §3.4 copy.
5. No token, or a malformed one → the §5 empty state, not a blank screen.

---

## 5. Empty and blocked states

Each is a short heading, one sentence of explanation, and at most one action.

| Where | When | What it says |
| --- | --- | --- |
| Team & Access | `!can('team_manage')` | "You do not have permission to manage this workspace's team." No list, no actions. |
| Team & Access | `no_workspace` from any RPC | "You are not an active member of a workspace." Link to `/dashboard`. |
| Members | only the caller is active | "You are the only person here. Invite someone below to share this workspace." → focuses the invite form. |
| Former members | none | the section is hidden entirely, not an empty box. |
| Invitations | none | "No invitations yet. Invite someone and copy the link to them." |
| Invitations | the pending ones are all expired | still listed, each badged "expired", with Revoke, plus a line that expired invitations can no longer be used. |
| Join | no/blank token | "This link is missing its invitation token. Ask for a new link." |
| Any list | the RPC threw | "Could not load the team." + a Retry that re-runs the same call. Never a half-rendered list. |
| Everywhere | `App.workspace.ready() === false` | the standard loading state (`App.app.loadingHtml()`), never a flash of the no-permission state. |

---

## 6. Expected tests

Tests live in `tests/` and never touch the network. Runner:
`node --import ./helpers/register.mjs --test --test-concurrency=1 "**/*.test.mjs"`
from `tests/` (`npm test`).

### 6.1 Front-end — `tests/frontend/team-management.test.mjs`

Pattern: `tests/frontend/notifications.test.mjs`. Real page scripts in jsdom with
a stub `App.store`:

```js
import { browser, settle, SKIP_DOM } from "../helpers/browser.mjs";
const SCRIPTS = ["assets/js/core/utils.js", "assets/js/app.js", "assets/js/pages/team-management.js"];
const b = await browser(SCRIPTS, { store: makeStore(...) });
if (!b) return t.skip(SKIP_DOM);
```

Stub `App.workspace` as well as `App.store`, so each permission shape is a test
input. Cover:

1. `team_manage: false` → the no-permission state renders and **no** store method
   is called (assert the call log is empty — this is the test that catches a gate
   added after the fetch).
2. `team_manage: true` → members and invitations render; the caller's row shows
   "You" and offers neither Remove nor Change role.
3. The owner's row never offers Remove or Change role, for any caller.
4. **Make owner** appears only when the caller is the owner, and never on the
   owner's own row or a removed row.
5. Invite success renders the copy-link panel, the panel contains the token
   exactly once, and **Copy link** writes the URL to a stubbed
   `navigator.clipboard`.
6. Each invite failure outcome (`invalid_email`, `already_a_member`,
   `already_invited`) renders its message and leaves the form filled in.
7. Each join-screen outcome in §4.3 renders its own copy; `email_mismatch` shows
   the invited address from the payload.
8. `exceeds_your_permissions` renders the `reason` string from the payload.
9. Delete workspace: a mismatched name calls nothing; `other_members_present`
   shows the count from the payload; the correct name calls `deleteWorkspace`
   once with the typed string.
10. Remove, leave and transfer each require a confirmation before the store
    method is called, and each refreshes the list afterwards.
11. No token on the join screen → the missing-token state, and no RPC call.
12. A thrown RPC error renders the retry state, and Retry re-runs the call.

### 6.2 Data service

With a fake Supabase client, in the style of the existing data-service tests:
each new method calls the right RPC name with exactly the right `p_` keys; a
returned `error` throws; an `outcome` payload is returned unchanged (not
reshaped, not thrown); and the four caller-affecting methods
(`acceptInvitation`, `leaveWorkspace`, `deleteWorkspace`, `transferOwnership`)
refresh `App.workspace` and reset caches.

### 6.3 SQL

No new SQL tests are needed. `tests/sql/phase_t3_invitations.test.mjs` already
covers all ten RPCs, `realtoros_list_members` included: that the `member_id` it
returns is the one the membership RPCs accept, that an agent gets the list but
not the removed or suspended rows while a manager gets both, and that it never
reaches another workspace. Those tests must keep passing untouched. If T4 adds
SQL of its own, follow their shape — PGlite, the real migration chain via
`migratedDb()` from `tests/helpers/pg.mjs`, `SKIP_MESSAGE` when PGlite is
absent, and a `NOT_APPLIED` guard when the migration is not in the chain.

### 6.4 Do not

Do not add a test that replays an applied migration onto the full chain. A
migration's inline verification guard is written against the schema as it stood
at its own position, and applied migrations are immutable. Test re-runnability at
the chain position the migration occupies — see the re-runnability test in
`tests/sql/stop-logic.test.mjs` for the shape.

---

## 7. Out of scope for v1

- **Sending invitation emails.** Copy-link only: no Edge Function, no Resend
  call, no "resend email" button.
- Bulk invite, CSV invite, or an invite link that anyone can use (every
  invitation is bound to one address by design).
- Editing the role **templates** (`realtoros_set_role_permissions`) — its own
  screen.
- Merging the legacy `team_members` directory UI into this screen.
- Changing the `workspace_invitations` deny-all posture or adding an RLS policy
  to it.
