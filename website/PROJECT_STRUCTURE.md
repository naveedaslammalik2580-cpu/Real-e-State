# Project structure — W2

The parent workspace is `Real state/`.

```text
Real state/
  Realtor main CRM/             Protected existing CRM; outside website work
  tools/                       Reserved for future independent tool development
  real-estate-tools-website-w1.zip
  website/                     Public static website; serve this as the web root
    index.html                 Homepage
    assets/                    Shared CSS, approved theme, JavaScript and favicon
    assets/tool-registry.js    Central tool metadata and publication status
    assets/tool-directory.js   Published cards, search and category filters
    realtoros/index.html       Public RealtorOS marketing page
    resources/index.html       Resources page
    contact/index.html         Contact scaffold
    tools/index.html           Public searchable tool directory
    tools/commission-calculator/index.html
    tools/mortgage-calculator/index.html
    tools/AUTHORING.md          Reusable layout and tool publication workflow
    tests/w2.cjs               Dependency-free website regression checks
    README.md                  Original preview notes
    ROADMAP.md                 Original future roadmap; not executed in W0
    PROJECT_STRUCTURE.md       This folder guide
```

Both working calculators remain in `website/tools/` and use
`website/assets/site.js`. Their public URLs remain
`/tools/commission-calculator/` and `/tools/mortgage-calculator/`.
The approved palette remains in `assets/theme.css`.

Root `tools/` remains reserved for independently developed tools. A finished
static tool is integrated into `website/tools/<slug>/index.html` with its own
runtime assets, then added to `assets/tool-registry.js` as `published`. The
directory derives cards and categories from published entries only. A sibling
source folder is not automatically a public route. See `tools/AUTHORING.md` for
the reusable layout and publication checklist. Existing calculators were not
moved or duplicated, and their public URLs remain unchanged.

## W2 verification

Run `node website/tests/w2.cjs` from the parent workspace. It checks registry
fields and published destinations, filtering and draft exclusion, navigation,
calculator outputs, JavaScript syntax and internal links within `website/`.
DOM tests use stubs; browser rendering and responsive visual checks remain
manual because browser automation is unavailable. Existing responsive layout
rules are retained; category controls wrap and filtered cards explicitly hide.
No dependencies, backend work, deployment or W3 work were added.

## W0 verification (historical extraction baseline)

- Extracted 13 files directly into `website/`, removing only the ZIP wrapper
  directory. No existing destination files were overwritten.
- All 13 extracted files match the ZIP contents by SHA-256, preserving pages,
  styling and calculator code byte for byte.
- Checked all 7 HTML pages: 155 internal link, fragment and asset references
  resolve within the website.
- JavaScript syntax and 13 calculator assertions passed using Node's VM with
  DOM stubs derived from the actual calculator HTML. Checks cover initial
  outputs, input-triggered updates, zero rates, zero principal and invalid ranges.
- These are static and script checks, not browser rendering tests.
- Existing preview limitations remain: contact delivery, production app links,
  pricing and legal details still require future setup (see `README.md`).
- No CRM access, deployment, backend changes or dependencies. W0 ends here.
