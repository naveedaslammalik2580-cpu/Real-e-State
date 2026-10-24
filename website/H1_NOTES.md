# H1 homepage

## Typography and expansion pass

The homepage now follows: Hero, What Can You Calculate?, How It Works, RealtorOS,
Why Use These Tools?, FAQ, final tools CTA. Use-case links point only to the two
published calculators. The four FAQ items use native `details`/`summary` controls
and work without JavaScript. Search, calculator code and page metadata are intact.

Source Serif 4 (600–700) and Inter (400–700) are self-hosted Latin variable WOFF2
files in `assets/fonts/`, approximately 97 KiB combined, with their SIL Open Font
License files. They were obtained through Google Fonts; licenses come from the
google/fonts repository. `theme.css` declares `font-display: swap` and reliable
serif/system fallbacks. No visitor font request goes to an external font service.
Shared header/footer typography uses medium-weight navigation and a lighter
wordmark; other page layouts have not been changed. Homepage body text, headings,
buttons and new sections use the common font tokens and palette.

The added layouts stack at phone widths, with benefits using two columns on tablet
and four on desktop. Browser automation is unavailable; actual font rendering,
FAQ keyboard/screen-reader behavior and overflow at 375, 390, 768, 1024 and 1440 px
still need visual/browser review. The notes below describe previous H1 stages.

## Final homepage refinement

The hero layout, property image, registry search, calculator links and SEO metadata
remain intact. How It Works uses aligned compact steps. The RealtorOS spotlight
now uses benefit-led feature rows and a compact editorial product overview, not a
placeholder screenshot or simulated application UI. No genuine CRM screenshot
was available. The hero CRM tile also uses a decorative lettermark instead of a
developer-facing placeholder. The closing CTA names the commission and mortgage
calculators. The homepage footer now contains Tools, RealtorOS and Platform links,
with configurable branding and no internal launch notes.

Final changes are isolated to `index.html`, `assets/home.css`, `tests/h1.cjs` and
this note. Shared scripts, calculators and other pages are unchanged. Responsive
rules cover 375/390 px phones, 768 px tablets, 1024 px and wider desktops, including
wrapping footer branding, zero-minimum grid tracks and a scrollable mobile menu.
Browser automation remains unavailable: actual rendering, horizontal overflow and
touch behavior at those widths have **not** been verified in a browser.

The following notes record earlier H1 stages; screenshot placeholders and category
discovery described below have since been replaced by the final design above.

Only the homepage loads `assets/home.css` and `assets/home.js`. Shared navigation,
metadata, calculator routes and other pages retain their existing implementation.
The live search panel and category discovery read the W2 tool registry and filter
for `status: 'published'`. Search matches titles, descriptions, categories and
slugs; results are links, not an autocomplete widget. Static hero cards provide
a no-JavaScript fallback; `tests/h1.cjs` checks their registry alignment. The next
section presents only populated categories plus existing calculator explanations,
instead of repeating the calculator cards. Category links populate and focus the
hero search; without JavaScript the category fallback links to the tools directory.

H1 refinement reduces desktop hero padding from 64px to 36px and its heading
maximum from 5.5rem to 4.2rem. The mobile hero uses 28px padding and a smaller
serif heading. Search and CRM preview cards use tighter spacing, while the larger
CRM placeholder uses a compact landscape ratio. Tablet columns stack at 900px;
phone results become horizontal icon/text rows. No newer screenshots were found
alongside the approved mockup, and browser visual verification remains pending.

Reference used: `reference/wide_high_resolution_website_homepage_mockup_ui.png`.
The requested `references/homepage-approved.png` did not exist. The available
reference matches the supplied description: split editorial hero, architectural
imagery, right-hand search panel, calculator cards and navy CRM feature styling.
Unavailable categories and simulated CRM records were not carried over.

`assets/home-architecture.jpg` is original illustrative imagery generated with the
built-in image-generation tool, then JPEG-encoded for the website (1536 x 1024,
approximately 411 KiB). It is a decorative background, not a real property listing.
The reference mockup is not loaded by the public page. RealtorOS screenshots remain
explicitly labeled placeholders.

Generation prompt:
> Use case: photorealistic-natural. Asset type: decorative real estate website hero background. Create an original wide landscape architectural photograph-style image of a contemporary upscale two-story home, slate roof, warm ivory facade, large warmly lit windows, garden and paved driveway, blue evening sky. Composition: house on right two thirds; softer garden and pale open sky on left for a web text overlay. Natural premium architectural photography, realistic materials. No people, logos, words, UI, watermarks, address numbers, sale signs or statistics. This is illustrative architecture, not a real listing. Landscape 1536x1024.

Checks: `node website/tests/h1.cjs` plus existing W2/W4/W5a suites. Responsive
rules cover desktop, tablet and narrow phones, but these are structural checks.
Browser automation is unavailable: confirm visual fidelity, overflow, search,
keyboard focus and touch navigation at 1440, 1024, 768, 412, 360 and 320 px before
approval. No deployment or W5b work was performed.
