# C-1 — Fingerprint verification (corrected files, 2026-10-29)

## What happened

Gate 0 check 4 failed: 7 of the 11 function bodies in the repo did not match the live
database. The owner exported the live definitions (`pg_get_functiondef`, base64). Every
decoded body was validated against the live MD5 fingerprint the owner had already
measured from `pg_proc.prosrc` — **11/11 decoded bodies hash exactly to the live
fingerprints**, so the export used below is byte-exact live state.

## Root causes found (three distinct ones)

1. **CRLF line endings (2 functions).** `realtoros_register_push_subscription` and
   `realtoros_set_notification_preferences` were applied from a Windows/CRLF source.
   Live bodies contain `\r\n`; the repo files are LF. Logic identical — proven two ways:
   CRLF-converting the repo body reproduces the live MD5 exactly, and a lexer pass
   confirms no string literal in either body contains a line break, so line endings
   cannot change any value.
2. **Formatting drift (all 5 T2b1 functions).** The live bodies use compact formatting
   (declarations and statements joined onto shared lines, no spaces inside parentheses:
   `coalesce((select`, `values (`→`values(`). The repo copies were reformatted when the
   Phase B files were authored. Token streams are otherwise identical.
3. **Repo-only extras (2 functions).** The repo copies of `realtoros_set_member_permissions`
   and `realtoros_set_role_permissions` carry comment lines the live bodies do not have;
   `set_member_permissions` additionally declares `v_target_prior_effective jsonb`, which
   occurs exactly once (the declaration) and is never used. No live logic is missing
   from the repo versions, and no repo logic differs from live — but the repo text is
   NOT the live text, so files built from it could not fingerprint-match.

Attributes (language, SECURITY DEFINER, search_path, volatility, argument defaults) and
privileges (`proacl`) from the live export match the repo files' intent for all 11.
Note: live ACLs for the public RPCs also list `service_role`; that grant comes from
elsewhere in the chain, is preserved by CREATE OR REPLACE, and is untouched by C-1.

## The corrected files

- `supabase/rollback/phase_c1_deterministic_workspace_selection_revert.sql` — regenerated:
  every function definition is the live `pg_get_functiondef` output verbatim, followed by
  the original revoke/grant lines and the live comments (the four comments the old
  rollback omitted — authz trio + ensure_personal_workspace — were added from the export).
- `supabase/migrations/20261029120000_phase_c1_deterministic_workspace_selection.sql` —
  rebuilt: each definition is the live text with ONLY the C-1 deterministic-selection
  change applied (workspaces join + `ORDER BY (CASE WHEN w.owner_user_id = <caller>
  THEN 0 ELSE 1 END), w.created_at, w.id`). Token-level diff against live shows no
  other change in any of the 11 functions. The four functions whose live text already
  equalled the repo text keep their original migration blocks unchanged.

## Fingerprint table — corrected rollback vs live database (md5 of prosrc)

| Function | Live (owner-measured) | Corrected rollback | Match |
|---|---|---|---|
| authz.my_role | 824fd929e8596b2dc474b8823a2e7153 | 824fd929e8596b2dc474b8823a2e7153 | ✓ |
| authz.my_team_member_id | 580f31826258751f29fc862bc60e1455 | 580f31826258751f29fc862bc60e1455 | ✓ |
| authz.my_workspace_id | d68fee218a094b027bd91ca7241d9082 | d68fee218a094b027bd91ca7241d9082 | ✓ |
| automation_internal.ensure_personal_workspace | a221b943f5a3b887c55fd225467042c5 | a221b943f5a3b887c55fd225467042c5 | ✓ |
| automation_internal.workspace_of | 94f19675ce8902091a83b2be84ca2417 | 94f19675ce8902091a83b2be84ca2417 | ✓ |
| public.realtoros_my_permissions | b388a2aaa5f57eb826df5efb249e3623 | b388a2aaa5f57eb826df5efb249e3623 | ✓ |
| public.realtoros_register_push_subscription | a2dec6ffb04a35c7af76dd7b134b7a84 | a2dec6ffb04a35c7af76dd7b134b7a84 | ✓ |
| public.realtoros_reset_member_permissions | 3dcea65786d8d36cf077f183e8099785 | 3dcea65786d8d36cf077f183e8099785 | ✓ |
| public.realtoros_set_member_permissions | f4ce6dc00a5686739ce347cd121a3b06 | f4ce6dc00a5686739ce347cd121a3b06 | ✓ |
| public.realtoros_set_notification_preferences | 970ff63070001799d4267ce9e1e740ef | 970ff63070001799d4267ce9e1e740ef | ✓ |
| public.realtoros_set_role_permissions | b229a47eb9e58b9cd58e9bcad9928fde | b229a47eb9e58b9cd58e9bcad9928fde | ✓ |

**11/11 — Gate 0 check 4 now passes against the corrected rollback.**

## Verification procedure (for the application session)

1. Before applying: re-run `C1-FINGERPRINT-CHECK.sql` against live; the "expected"
   values are the Live column above (unchanged — they describe the pre-C-1 state).
2. Apply the corrected migration by CLI (`supabase db push`) per
   `C1-APPLICATION-PROCEDURE.md`. Do NOT paste the migration or rollback into the SQL
   Editor from a Mac/Windows editor that might normalize line endings — the two push
   functions' bodies are CRLF by design, and CLI application preserves file bytes.
3. After applying: the 11 functions' fingerprints will change (that is the migration).
   To prove rollback integrity at any time, run the corrected rollback in a scratch
   transaction (`begin; \i rollback.sql; <fingerprint query>; rollback;`) — the
   fingerprints inside the transaction must equal the Live column, 11/11.

## Offline test results (corrected files, 2026-10-29)

- SQL suite (full chain + C-1 regression + rollback tests): **379/379 pass**
- Security suite: **6/6 pass**
- Edge suite: **200/200 pass**
- Frontend suite: **457/457 pass**

One defect was caught and fixed during testing: `pg_get_functiondef` output has no
terminating semicolon, so the first assembled build left each CREATE unterminated and
the chain failed with a syntax error. The files now terminate each statement outside
the body delimiters; fingerprints are unaffected (verified 11/11 after the fix).

## Status

Corrected files exist ONLY in the local `real-e-state-c1fix` working copy.
Nothing has been pushed, applied, or deployed. Awaiting owner review and approval.
