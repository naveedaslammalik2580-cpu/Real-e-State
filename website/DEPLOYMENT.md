# Website deployment packaging

The website is a static site. What gets deployed is **not** the `website/`
folder as it sits in the repository — it is a clean package built from it,
containing only the files the live site needs.

## Build the package

```bash
node website/scripts/package-deploy.mjs
```

- Requires only Node.js (built-in modules; no `npm install`, no network).
- Output: `website/dist-production/` — a build artifact, gitignored,
  never committed. Rebuild it whenever a website file changes.
- A different output folder can be chosen with `--out <dir>`.

## What the package contains (56 files)

Every page (home, tools index, about, contact, resources, RealtorOS), all
10 calculators (`index.html` + `calculator.css` + `calculator.js` each),
the shared assets (CSS, JS, favicon), the subset fonts **with their OFL
licence texts**, and the hero image. Files are copied byte-for-byte; the
build never modifies content, so the packaged site is exactly the site
the test suites ran against.

## What is excluded, and why

| Excluded | Why |
|---|---|
| `tests/` (5 suites) | Development-only; they stay in the repo and run in CI. |
| `reference/` (1.76 MB mockup) | Design reference of record — kept in the repo, never shipped. |
| `scripts/` | The packaging tooling itself. |
| `*.md` documents (incl. this file) | Development documentation. |
| `.gitignore`, `dist-production/` | Repo/build housekeeping. |

## Verification (runs as part of the build)

The build fails with a non-zero exit and a named problem list unless all
of these hold for the packaged directory:

1. Every packaged file is **byte-identical** to its source file.
2. **No excluded artifact** is present in the package.
3. Every relative `href`/`src` in the packaged HTML and every `url()` in
   the packaged CSS **resolves to a file inside the package** (directory
   links resolve to their `index.html`) — 554 references at the time of
   writing.
4. Every packaged JavaScript file **parses**.
5. No packaged page carries an **inline event-handler attribute**, a
   **javascript: URL**, or an **inline `<script>` block** — the site stays
   compatible with a strict `script-src 'self'` Content Security Policy
   (the header itself is a hosting setting, enabled separately).

The same build runs in CI (`.github/workflows/website-tests.yml`,
`package` job), which also uploads the verified package as the
`website-production` workflow artifact.

## Deploying

Upload the **contents** of `website/dist-production/` as the web root —
not the folder itself, and not the repository's `website/` folder.

Before the first public deploy, the launch items tracked outside this
document still apply: production values in `assets/site-config.js` (the
CRM base URL is a localhost development value), hosting security headers
/CSP and HTTPS/HSTS, and the legal pages. See the production-readiness
audit for the full checklist.
