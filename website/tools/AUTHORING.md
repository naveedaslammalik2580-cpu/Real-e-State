# Publishing an individual tool

`assets/tool-registry.js` is the directory's source of truth. Each entry requires
`slug`, `title`, `category`, `description`, `status` and `publicUrl`; `icon` is
optional. Use a unique lowercase hyphenated slug, a human-readable category
(reuse `Finance & numbers` where appropriate), and a URL of `<slug>/`, relative
to this directory. Only the exact status `published` is displayed. Draft entries
do not create public pages or categories. Status controls directory discovery,
not access protection for files placed in the public website.

1. Develop a new tool independently in root `tools/<slug>/` if needed. Keep drafts
   there until functional; do not add placeholder HTML pages under `website/tools/`.
2. Prepare the completed static page at `website/tools/<slug>/index.html` and
   its own scoped script, for example `calculator.js` in that same folder.
   Transfer only finished runtime assets, not development dependencies or secrets.
3. Use the layout pattern below. Keep the shared header/footer, skip link and
   mobile menu markup consistent with the existing calculator pages. Include
   `../../assets/site.css` followed by `../../assets/theme.css` and the favicon.
   Include deferred `../../assets/site.js` and your page-specific script.
4. Verify labels, keyboard access, formulas, boundary/invalid inputs, narrow
   layouts and links. Scope script selectors to your form and use unique IDs;
   do not put new calculation logic in the shared directory script.
5. Add one complete registry entry with `status: 'published'` once the real page
   passes checks. The directory automatically creates its card and category;
   searches match title, description, category and slug. No directory HTML edits
   or build step are needed. Run `node website/tests/w2.cjs` from the parent.

The two existing calculators stay exactly where they are. Root `tools/` is not
the public `/tools/` URL. Serve `website/` as the static document root (relative
links also support mounting it under a path). Publishing here means inclusion in
the local website; deployment is a separate task.

## Reusable page layout

This is an authoring snippet, not a public placeholder page. Replace bracketed
content and add real labeled inputs and working logic before publishing. Reuse
the header/footer shell from the existing tool pages; do not copy their form IDs
or calculator logic. Use a unique form such as `<slug>-form`.

```html
<main id="main">
  <section class="page-hero">
    <div class="wrap">
      <span class="eyebrow">Real estate, simplified</span>
      <h1>[Tool title]</h1>
      <p>[Purpose and scope]</p>
    </div>
  </section>
  <section class="section">
    <div class="wrap calculator-layout">
      <div class="panel">
        <h2>[Input section title]</h2>
        <form id="[unique-form-id]">
          <div class="form-grid">
            <!-- Each .form-field contains a label linked to a unique input
                 with class="field", units, constraints and helpful defaults. -->
          </div>
        </form>
        <p class="disclaimer">[Assumptions and limitations]</p>
      </div>
      <aside class="result" aria-live="polite" aria-atomic="true">
        <small>[Primary result label]</small>
        <div class="result-number" id="[unique-result-id]">[Result]</div>
        <div class="result-row"><span>[Supporting label]</span><b>[Value]</b></div>
      </aside>
    </div>
    <div class="wrap content">
      <h2>How it works</h2><p>[Explain the actual calculation or method]</p>
      <p><a href="../">Explore all tools</a></p>
    </div>
  </section>
</main>
```

The existing classes provide responsive input/result columns, stacked mobile
fields, and approved navy (`--navy`), ivory (`--paper`), teal (`--teal`) and gold
(`--gold`) styling. Reuse these tokens; keep any new styles scoped to the tool.
Keep focus indicators, readable labels, error messages and a viewport meta tag.
Do not modify the shared palette or create a new framework for each tool.
