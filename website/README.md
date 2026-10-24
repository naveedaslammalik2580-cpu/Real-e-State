# Real Estate Tools Website — W1 Preview

This folder is a **brand-neutral, static, responsive public website**. RealtorOS is the flagship CRM, but its actual app is not bundled or modified.

## Included functional pages
- `/` — homepage and featured RealtorOS product
- `/tools/` — tool directory with search/category filters
- `/tools/commission-calculator/` — interactive commission calculator (USD estimates)
- `/tools/mortgage-calculator/` — interactive fixed-rate mortgage calculator (USD principal+interest estimates)
- `/realtoros/` — CRM product page
- `/resources/` — guide/resource index
- `/contact/` — contact information scaffold, no invented submission backend

## Preview locally
In this directory run `python -m http.server 8000` (or `py -m http.server 8000` on Windows), then open http://localhost:8000/.

## Edit the site
- `assets/site.css` — existing base layout and page components
- `assets/theme.css` — **approved W1 colour palette and site visual overrides**
- `assets/site.js` — tool calculations, directory search, menu
- Each `index.html` — corresponding page content
- `ROADMAP.md` — what to do in W2 through W6

## Not launch-ready yet
- Working site label **REAL ESTATE TOOLS** is not a chosen umbrella brand.
- Signup/app links and pricing await verified production targets and plan definitions.
- Contact/support address, privacy/terms, analytics/consent and domain/SEO setup await approval.
- Calculator currency and business formulas must be reviewed for target market.
- Preview CRM numbers are illustrative sample data, not actual client records.
- This public site must **not** alter RealtorOS authentication, Supabase, data, permissions or production deployment.
