# RealtorOS UI / Design Audit

Scope: `RealtorOS_Online.html` only. This is a code audit; no UI code was changed.

## Executive finding

The main application has a real, mostly coherent **Broker's Book** design system: warm light surfaces, deep navy sidebar, restrained emerald primary action, and serif display headings. The largest consistency risks are not page-by-page redesigns; they are literal color/font/layout exceptions that bypass the token system, especially in SVG charts, calendar event colors, loading/error fallbacks, and highly variable inline spacing.

## All distinct literal hex values

81 normalized values appear in the file (`#FFF` normalizes to `#FFFFFF`):

`#041E19, #059669, #061424, #071120, #0A1523, #0A241F, #0B1F33, #0B5F58, #0D1A2B, #0E2F2A, #0F172A, #0F1E33, #0F2A44, #0F766E, #10203A, #10B981, #111E30, #132B44, #142744, #142E4A, #14304C, #17253A, #1D2C42, #1D4E89, #2A3B54, #2C1F08, #34D399, #3A2A0A, #3B1414, #475569, #4A3611, #5A3608, #5A6779, #5B6472, #60A5FA, #64748B, #667488, #6C7789, #6EE7B7, #7A1B10, #7A4A0A, #818CF8, #8A93A2, #92400E, #93C5FD, #94A0B2, #94A3B8, #A78BFA, #A9B4C4, #B42318, #B45309, #B7C0CD, #B7CFCA, #D3D0C6, #D97706, #DBE7F5, #DC2626, #E6E4DC, #E6F4F1, #E7EEF6, #E8ECF2, #EAEAE4, #EC4899, #EF4444, #EFEDE5, #F0D9A8, #F0F8F6, #F1F0EA, #F59E0B, #F5B7AE, #F6F5F0, #F87171, #FAFAF6, #FAFBFC, #FCA5A5, #FCD34D, #FDA4AF, #FDE68A, #FDECEA, #FDF3E1, #FFFFFF`.

Most are intentional light/dark theme tokens, state colors, or user-selectable pipeline stages. The exceptions below are the values that merit design cleanup.

## Findings — Color

| Severity | Where | Finding |
|---|---|---|
| High | Reports monthly chart, lines 9520–9535 | SVG uses hard-coded `#EAEAE4`, `#B7CFCA`, `#0F766E`, `#8A93A2`, and `#5B6472`. The hard-coded light grid and muted bar colour do not follow dark-theme tokens, so the report chart can look mismatched in dark mode. |
| Medium | Reports closing-summary footer, line 9582 | Uses one-off background `#FAFBFC`, not `var(--surface-sunk)` or another palette token. It is a subtle cool-grey departure from the warm light card system and has no dark override. |
| Medium | Calendar events, lines 10236–10280 | Events use `#818CF8`, `#DC2626`, `#64748B`, `#D97706`, `#059669`, `#F59E0B`. These differ from semantic tokens: danger is `#B42318`, warning is `#B45309`, success/primary is `#0F766E`. They are understandable categorical colours but are not centrally defined or theme-aware. |
| Medium | Sample banner/badges/callouts, lines 1083–1087, 1768–1778, 1825 | Warning content mixes three amber/brown text colours (`#7A4A0A`, `#92400E`, `#5A3608`) and separate border/background values (`#F0D9A8`, `#FDF3E1`), instead of using `--warning` and `--warning-soft`. The visual intent is consistent, implementation is not. |
| Low | Boot loading and failure UI, lines 2181 and 12926–12929 | Uses slate fallback colours `#0F172A`, `#475569`, `#64748B` rather than theme tokens. This screen is temporary, but it does not adapt to dark mode. |
| Low | Toggle switch, line 2040 | Uses literal `#FFFFFF` rather than `var(--card)`. This creates a tiny mismatch in dark mode. |

### Direct answers

* **Sidebar/nav:** consistent across pages. It is a single global `#sidebar` system using `--sidebar-*` tokens; light mode uses `#0B1F33`, dark uses `#071120`. There is no per-page sidebar colour variation.
* **Primary actions:** consistent. Every reviewed Save/Create/Add/Submit action uses `.btn-primary`, which uses `--accent` (`#0F766E` light, `#34D399` dark). No competing primary-button colour was found.
* **Cards/panels:** broadly consistent: `.card` uses `var(--card)`, `var(--border)`, `var(--radius-lg)`, and `var(--shadow-sm)`. Purposeful exceptions include `--surface-sunk` footers/status cards and warnings. The report footer's `#FAFBFC` is the one unexplained one-off.

## Findings — Typography

| Severity | Where | Finding |
|---|---|---|
| Medium | Global tokens, line 78 | `--font` starts with `Inter`, but Inter is not loaded by the file. If unavailable locally, the UI falls back to OS fonts (`SF Pro Text`, Segoe UI, Roboto, Arial), so the rendered typeface differs by device. |
| Medium | Global display token, line 79 | `--font-display` is a fallback chain of system serifs (Iowan/Palatino/Georgia/etc.), not a bundled chosen display face. The aesthetic is intentional, but not visually deterministic across machines. |
| Low | Boot loading/error UI, lines 2181 and 12926 | These bypass `--font` with `-apple-system, Segoe UI, sans-serif`. It is a visible font mismatch during loading or an error state. |
| Medium | Global and component rules | The hierarchy exists, but it is over-granular: body/labels use 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 15.5, etc. This makes future pages prone to near-duplicate sizing rather than a small repeatable scale. |

Current intended hierarchy is clear enough: body `14px`; page title `26px`; stat values `28px`; profile name `24px`; modal titles `18px`; card titles `13.5px`; labels usually `10–12px`. The issue is implementation discipline, not the absence of hierarchy.

## Findings — Login / Auth screen

The auth gate is at lines 2166–2176 and is visually aligned with the application:

* **Gradient:** none. Its background is `var(--bg)`, so it uses the same warm/light or dark base as the main app.
* **Buttons/accent:** Sign in uses the same `.btn-primary` as the dashboard (`--accent`); inputs/card/borders use existing tokens.
* **Typography:** heading uses `--font-display`; labels/body use the global body font. No separate auth font was introduced.
* **Illustration/logo:** none. There is no disconnected illustration or unused split-screen area.
* **Balance:** centred single-card layout, maximum width `420px`, with even `24px` outer padding. It is visually balanced but intentionally minimal rather than branded.

No auth-screen colour/layout inconsistency was found beyond the unbundled font fallback noted above.

## Findings — Layout / sizing

| Severity | Where | Finding |
|---|---|---|
| Medium | Global components and inline-rendered views | The design tokens define radii of 6/8/10px, but raw values also appear at 2, 3, 4, 8, 9, 10, 12, and 16px. Examples: empty icon `12px` (line 883), profile avatar `12px` (line 904), coming-soon icon `16px` (line 1054), Settings icon slot `9px` (line 2001), inline custom-field card `8px` (line 12209). |
| Low | Shadows | Core cards consistently use `--shadow-sm`; modals/auth/save bar use `--shadow-lg`; hover cards use `--shadow-md`. One off-token shadow remains on the toggle thumb (`0 1px 3px rgba(0,0,0,.18)`, line 2043). |
| Medium | Empty states across Contacts/Properties/Buyer/Seller/Pipeline/Reports/Calendar, roughly lines 6681–10418 | Empty-state padding varies widely: global `.empty` is `56px 24px`; inline states use `20px`, `24px 20px`, and Calendar uses `32px`. Consequently some empty cards will feel dense while others feel notably spacious. |
| Low | Settings vs standard cards, lines 1933–1937 | Settings intentionally reduces header/body padding to 12/16px versus the global 14/18px. It is internally consistent in Settings but makes that page denser than dashboard/detail cards. |
| Low | Auth gate, line 2167 | Auth card uses 28px padding, above the common card 18px. This is reasonable for a stand-alone form, not a visual defect. |

## Positive consistency checks

* Light/dark palettes are tokenized and paired consistently.
* The sidebar, topbar, global card, form, modal, and button primitives are shared rather than page-specific.
* Primary action styling is fully centralized.
* No gradients were found anywhere in the frontend.

## Recommended priority if you later approve fixes

1. Tokenize chart and calendar colour values, including dark-mode treatment.
2. Replace `#FAFBFC` report-footer and boot fallback literals with semantic theme tokens.
3. Define a smaller typography scale and a radius/spacing scale, then progressively remove inline values.
4. Decide whether to bundle/serve Inter and a display serif so the brand is consistent across machines.
