# Supporting pages — W4

- `resources/index.html` lists only existing calculator pages and their included
  explanations. To add a guide, first finish its content and page, then add one
  `li.panel` to the `resource-list` with its actual format, title, summary and URL.
  Do not create empty article routes or link to drafts.
- `contact/index.html` and `assets/contact.js` prepare a local text draft. There
  is no submission endpoint or support email. The user can copy the draft into
  their own notes; no transmission or persistent storage is implemented. With
  JavaScript disabled, preparation is disabled and an explanation is shown.
  Configure a verified delivery route in a separate task before offering Send.
- `about/index.html` describes the platform purpose without a company history,
  team biography or commercial claims.
- `assets/site-config.js` owns `brandName`, currently the descriptive working
  label `Real Estate Tools`. It updates marked header/footer/About labels,
  homepage accessible link names and document titles. RealtorOS is independent.
  Static HTML retains the current label as a no-JavaScript fallback. When a brand
  is finalized, update those fallback labels and titles too for no-JS/search
  clients. This setting does not establish a legal company identity.
- `assets/supporting.css` is loaded only on Resources, Contact and About. It
  reuses shared palette variables. Shared header/footer links are static on all
  eight current pages; keep them consistent when adding another page.

Validation: `node website/tests/w2.cjs` and `node website/tests/w4.cjs` from the
parent workspace. Tests stay inside `website/`; DOM checks use stubs. Browser
layout and native validation checks should also be performed when browser
automation is available. No backend, deployment or W5 work is included.
