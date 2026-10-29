# RealtorOS auth screen update

## Finding

The prior **Create account** button was not a separate registration screen or a complete registration form. It submitted the email and password already entered into the sign-in form to `supabase.auth.signUp()`. It had no registration mode, no confirm-password guard, and competed visually with the sign-in submit button.

## Implemented change

`RealtorOS_Online.html` now has one matched auth card with two accessible modes:

- **Sign in**: email, password, one full-width **Sign in** submit action, and a secondary `Create one` text link.
- **Create account**: email, password, confirm password, one full-width **Create account** submit action, and a secondary `Sign in` text link.

The mode can be changed with the compact Sign in / Create account tab switcher or the secondary text link. Both modes use the existing card, teal primary button, warm off-white page background, navy/semantic text tokens, Inter body font, and Source Serif display heading. No app data, business logic, or non-auth UI was changed.

The registration handler prevents non-matching passwords locally, relies on the existing browser `required`, `type=email`, and `minlength=6` validation, and displays the actual Supabase error text for server-side cases such as duplicate email or rejected password. On successful registration with email confirmation enabled, it displays: `Account created. Check your email to confirm it, then choose Sign in.` If the project is configured not to require confirmation, it retains the existing immediate reload into the app.

No profile fields were added: the live public schema only has `workspace_state`, whose required `user_id` comes from Supabase Auth. There is no separate profile schema or required display-name field.

## Verification performed

| Check | Result | Evidence |
| --- | --- | --- |
| Inline app JavaScript parses | Pass | All 30 inline scripts compiled successfully with Node's `Function` parser. |
| Auth UI implementation present | Pass | Static verification found tab controls, confirmation-password input, `auth.signUp({ email, password })`, and `auth.signInWithPassword({ email, password })`. |
| Live signup request accepted | Pass | On 2026-08-27 06:16:09 UTC, the live Auth API returned HTTP 200 for a newly generated test address. Auth logs recorded `user_confirmation_requested` for user `93aa48e0-156b-40de-b346-ec96d91e1a7a`. |
| Confirmation email dispatched | Pass | The corresponding live Auth log recorded `mail.send`, mail type `confirmation`. |
| Project behavior on confirmation | Confirmed | Live Auth settings report email signups enabled, signup not disabled, and `mailer_autoconfirm: false`; therefore no session is correctly returned until email confirmation. |
| Test-account email confirmation and browser sign-in | Not fully verifiable here | The confirmation email was sent to a generated external test inbox that is not accessible from this workspace. I did not falsely mark the user confirmed or bypass confirmation. Existing prior live password-session verification remains valid, but this new account's email-link step cannot be completed without that inbox. |
| Workspace/profile fields required on signup | None | `public.workspace_state` is RLS-enabled and keyed by the authenticated user's UUID; it has no additional profile fields. |

## Files changed

- `RealtorOS_Online.html` — dedicated sign-in/create-account modes, matching password validation, clear completion/error feedback, and auth-card spacing/polish.
- `REALTOROS_AUTH_SCREEN_UPDATE_REPORT.md` — this report.

## Untouched

The original offline reference remains untouched at `upload/933c0dad-3947-49d0-97e7-549665e1b8e5.html`.

## Review steps

1. Open `RealtorOS_Online.html` through the same local/static host used for the cloud app.
2. On the auth card, switch between **Sign in** and **Create account**. Confirm the single teal submit action and matched layout in each mode.
3. Try mismatched passwords in Create account to confirm the local message appears.
4. Register with an email inbox you control, open the confirmation email, then return to the app and sign in.
5. Verify the app opens the new, initially empty workspace after sign-in.
