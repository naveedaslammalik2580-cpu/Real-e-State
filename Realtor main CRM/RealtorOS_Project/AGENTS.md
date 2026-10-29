## Standing working rules (RealtorOS)

### Testing
- NEVER run the full test suite unless the owner explicitly asks for it in that same message.
- Run only the test files related to the change, one by one:
  cd tests; node --test --test-concurrency=1 <file(s)>
- Do not do clean-cache full runs. To prove a clean checkout works, clear the cache and run 2-3 small files.
- At the end of every task, list: (1) the exact targeted test commands, (2) one full-suite command
  (npm run test:quiet) for the owner to run manually when they choose.
- Never run tests in parallel (always --test-concurrency=1).

### Safety
- Never touch live Supabase (no migrations applied, no deploys, no secrets, no SQL against the live project).
  Claude Desktop dry-runs migrations; the owner applies them in the SQL Editor.
- Never edit an applied migration. New changes = new migration file + a rollback file in supabase/rollback/.
- Never edit root README.md, followup-model-eval/ (either copy), or integrations/google-sheets/* unless asked.
- Stage files by explicit path only. Never `git add .` or `git add -A`. One commit per logical part.
- No npm install/update unless a dependency is missing - stop and ask first.
- If the code contradicts the prompt in a way that matters, stop and report before changing it.

### Efficiency
- Keep reports short: files changed, commits, deviations, open questions, test commands. No long recaps.
- Read only the files you need. Do not re-read or re-scan the whole repo for small tasks.
