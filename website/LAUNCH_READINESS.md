# W5a — launch readiness

No deployment has been performed. Existing routes and calculator formulas are
preserved. Titles, descriptions and text-only Open Graph/Twitter metadata cover
all eight pages. Resources and Contact metadata describe the actual preview
behavior. Canonicals, og:url, social images, sitemap.xml and robots.txt are
intentionally absent until the production URL and hosting scope are approved.

## Before public launch

- **Brand:** finalize the umbrella label. Update `assets/site-config.js` and all
  static HTML label/title/social metadata fallbacks together; search and social
  crawlers may not execute JavaScript. RealtorOS is the product name.
- **Product screenshots:** replace both labeled placeholders on `/realtoros/`
  with genuine approved screenshots, useful alt text and explicit image
  dimensions. The homepage also retains an illustrative CRM mockup with sample
  records/numbers; approve or replace it before launch. These are not usage stats.
- **App access:** configure the approved app/signup URL and replace the landing
  page's clearly marked access placeholder. Do not present it as working signup
  until the destination is verified.
- **Contact:** no delivery address or backend is configured. The form only
  prepares a copyable draft, does not send it, and does not persist it. Keep this
  wording unless a verified delivery route is implemented and tested separately.
- **Business/legal review:** confirm operator/contact details and which privacy,
  terms, calculator disclaimers and consent requirements apply to the actual
  business, audience, jurisdiction and data handling. No policies or claims of
  legal compliance are supplied here. Review calculator currency/assumptions for
  the intended market. No standalone editorial guides are published.
- **Browser verification:** desktop and narrow-screen rendering, keyboard menu
  behavior, form native validation and real-device behavior remain manual;
  automated tests use DOM stubs. No browser automation is installed.

## Hosting and search configuration (pending URL)

1. Publish only the website's runtime HTML, CSS, JavaScript and approved assets;
   exclude tests and authoring/readiness Markdown. Use `website/` as the document
   root, never its parent. No backend or SPA fallback is needed.
2. Confirm the HTTPS origin and any mount path. Serve directory `index.html`
   pages at their existing trailing-slash routes. Redirect alternate host/scheme
   and slash forms consistently. Unknown paths should return a real HTTP 404,
   not a homepage with status 200. Test all existing deep links.
3. Once that URL is approved, generate a canonical and matching `og:url` for
   each actual page. Generate sitemap entries for `/`, `/tools/`, `/realtoros/`,
   `/about/`, `/resources/`, `/contact/` plus each registry entry whose status is
   `published`. Resolve relative registry URLs under `/tools/`; include the mount
   path if applicable. Verify every entry resolves to a real page. Do not include
   drafts, Markdown, tests, placeholders or invented last-modified dates.
4. Generate robots.txt for the origin root and reference the confirmed absolute
   sitemap URL. Decide indexing deliberately; do not carry preview restrictions
   into production. Protect preview hosting with access controls or hosting-level
   noindex headers as appropriate. robots.txt is not access control. If hosted
   below a path, coordinate origin-level robots.txt with the host owner.
5. Enable HTTPS, compression and correct HTML/CSS/JS/SVG MIME types. Revalidate
   HTML and these unversioned asset URLs; do not give them immutable long-term
   caching until versioned URLs exist. Check host security headers against the
   current inline styles/form handlers before enforcing a restrictive CSP.

The site already uses system fonts, small local assets and deferred scripts;
there are no external font/image dependencies to optimize in W5a. No bundler,
framework, speculative preload or generated domain-dependent output was added.

## Checks

Run from the parent: `node website/tests/w2.cjs`,
`node website/tests/w4.cjs`, and `node website/tests/w5a.cjs`.
All filesystem checks are restricted to `website/`. Stop after W5a.
