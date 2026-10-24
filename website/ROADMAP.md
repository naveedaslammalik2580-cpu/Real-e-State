# Real Estate Tools Website — Implementation Roadmap

## Product positioning
This **public website** is a multi-tool real estate platform. The existing **RealtorOS** CRM is its flagship product and remains a separate application. The public website should attract people through useful free tools and guide interested agents to RealtorOS. Its final umbrella brand has **not** been chosen.

## W1 — Foundation and Homepage (implemented in this prototype)
- Retain the seven-page prototype and two independent browser calculators.
- Apply the approved RealtorOS-inspired palette (navy, warm ivory, white, teal, muted gold).
- Create a consistent desktop/mobile public-site header, footer, buttons, cards and typography.
- Clarify two homepage paths: Explore free tools / Discover RealtorOS.
- No connection to production CRM; no changes to existing CRM files.

**Acceptance:** navigation works on desktop and mobile; footer links work; calculators work; no non-existent destinations; no horizontal overflow at common mobile widths.

## URL architecture (planned, publish as working pages only)
- Public homepage: `/`
- Tool directory: `/tools/`
- Individual tools: `/tools/<tool-slug>/`
- Future categories, once populated: `/tools/category/<slug>/`
- CRM marketing: `/realtoros/`; eventual pricing: `/realtoros/pricing/`
- Content: `/resources/` and later `/resources/<article-slug>/`
- Contact: `/contact/`; legal: `/privacy/`, `/terms/` after review
- CRM application: proposed `app.<future-domain>` kept outside the public-site codebase

## W2 — Tool architecture and directory
- Make a reusable page template for future free tools (inputs, instructions, outputs, disclaimer, related tools).
- Add category filters, search, SEO title/description, and an accessible empty state.
- Deliver each new tool only when functional; do not publish placeholders.
- Validate calculator conventions such as currency, region, formulas, rounding, and edge cases.

## W3 — RealtorOS product conversion
- Create a final flagship product landing page using real approved feature screenshots.
- Add outcome-first sections: follow-up, contacts, deals, plans, reports, and solo-to-team growth.
- Connect verified signup/login links only after deployment configuration is confirmed.
- Draft accurate product pricing/FAQ after plans and support terms have been decided.

## W4 — Supporting pages and content
- Resources index and original guides; About and Contact using verified company information.
- Pricing page if pricing is actually defined; never invent tiers or public promises.
- Privacy Policy, Terms, cookies/analytics disclosures authored after product/data-flow review.
- Reusable footer navigation and support pathways.

## W5 — Launch readiness
- Final domain and URLs: public site on root/www; CRM on app subdomain (proposal, not configured).
- Verify Supabase project URL, production auth and real signup/login experience separately.
- Canonical URLs, robots/sitemap, OG preview, analytics/consent, accessibility and performance.
- Android/mobile, narrow desktop, keyboard, touch and cross-browser checks; HTTPS and link tests.
- Soft launch after functioning tools and contact/support details are in place.

## W6 — Grow the tools library
- Add small tools one at a time using the same template and design tokens.
- Build editorial material and relevant contextual CRM discovery, based on authentic needs and usage.
- Improve from actual users rather than shipping empty directories or speculative features.

## Guardrails
1. Separate project from RealtorOS CRM; do not change CRM routes, backend, roles, permissions, auth or RLS.
2. Branding stays provisional; retain RealtorOS as a product identity.
3. Preserve working functionality, including no-login calculators.
4. Avoid fictional metrics, invented testimonials, fabricated pricing or dead CTAs.
5. Each stage should be reviewed before starting the next; use compact Codex prompts when connecting to a local repo.

## Colour tokens
- Deep Navy `#102131`
- Warm Ivory `#F6F5F0`
- White `#FFFFFF`
- Teal `#0F766E`
- Muted Gold `#C49B52`
- Text `#0B1F33`
