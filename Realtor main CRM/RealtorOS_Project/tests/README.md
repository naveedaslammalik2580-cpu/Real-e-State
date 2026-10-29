# RealtorOS Offline Tests

The RealtorOS test suite runs locally without contacting Supabase, Resend, or other network services.

Edge Function tests redirect `npm:@supabase/supabase-js` imports to an in-memory fake (`helpers/fake-db.mjs`), replace `fetch` per test, and run SQL tests against an in-process PGlite database.

## Run

**Requirements:** Node.js 23.6 or newer. The suite was developed on Node.js 24 and uses native TypeScript type-stripping.

From the project root:

```sh
cd tests
npm install
npm test
```

Installing dependencies provides PGlite for SQL tests, jsdom for frontend tests, and SheetJS and Papa Parse for parser-related tests.

Without `npm install`, SQL and frontend tests are skipped with a message, while the other tests continue to run.

## Why Tests Run Sequentially

The test script deliberately uses `--test-concurrency=1`. By default, `node --test` can run test files in parallel, with workers running simultaneously. Six SQL test files each start an in-process PGlite PostgreSQL database. Running them together causes the suite to hang indefinitely without producing output.

Running the suite sequentially takes approximately 3.5 minutes. The script also uses `--test-timeout=120000` so a hanging test fails with its name rather than stalling indefinitely.

When running SQL test files manually, preserve both flags:

```sh
node --import ./helpers/register.mjs \
  --test \
  --test-concurrency=1 \
  --test-timeout=120000 \
  --test-reporter=spec \
  "sql/*.test.mjs"
```

### Run One Test File

From the `tests/` directory:

```sh
node --import ./helpers/register.mjs --test edge/first-attempt-at.test.mjs
```

## Test Layout

| Folder | Coverage |
|---|---|
| `edge/` | Edge Functions invoked through their real `Deno.serve` handler with a fake database and a mocked provider |
| `sql/` | Migrations applied in order to PGlite, followed by direct testing of Phase 4E functions |
| `frontend/` | Real page scripts, including `utils.js`, `app.js`, and page modules, rendered in jsdom with a stubbed `App.store` |
| `security/` | Static source scans and live function tests checking that sensitive information is not logged or echoed |
| `helpers/` | Loader hooks, Deno shim, fake Supabase client, and fixtures |

## What These Tests Cannot Prove

- **Real PostgreSQL concurrency:** PGlite uses a single connection, so lock waits and `lock_timeout` cannot occur as they would in real PostgreSQL. Calls described as concurrent run sequentially. The retry path is tested by having the fake RPC return the `retry` outcome.
- **Perfect parity between mocks and SQL:** The JavaScript fakes in `helpers/automation-fixture.mjs` mirror the SQL functions' contracts. The SQL itself is exercised separately in the `sql/` tests.
- **Real provider behavior:** Tests do not establish actual Resend API responses, webhook delivery, or inbound email parsing behavior against live services.
- **Live CDN behavior:** Tests check pinned integrity hashes against the parser library files used by the app, but do not exercise the CDN download itself.
- **Supabase platform behavior:** Offline tests cannot verify PostgREST behavior, JWT verification, or grants as enforced through the Supabase API gateway.

Treat the suite as offline regression coverage, not as a substitute for staging or production integration checks.
