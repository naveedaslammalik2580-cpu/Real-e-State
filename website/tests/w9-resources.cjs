// W9 — Resources redesign guards.
// Locks the CaptionX-style Resources hub and the standalone guide articles:
// exactly five real guide cards (no invented dates), the legacy hub anchors
// still resolve, both articles exist with correct canonicals and matching
// card metadata, the calculator directory is intact, and the shared
// stylesheet lives in assets/. Dependency-free. Run: node website/tests/w9-resources.cjs
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = (() => { const dist = path.resolve(__dirname, '..', 'dist'); if (!fs.existsSync(path.join(dist, 'index.html'))) { console.error('website/dist not found. Run "npm --prefix website run build" first (tests run against the Astro build output).'); process.exit(1); } return dist; })();
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
let passed = 0;
function check(name, value) { assert(value, name); passed++; }
function equal(name, actual, expected) { assert.deepEqual(actual, expected, name); passed++; }

const hub = read('resources/index.html');
const mortgage = read('resources/mortgage-payments/index.html');
const commission = read('resources/real-estate-commission/index.html');
const affordability = read('resources/how-much-house-can-i-afford/index.html');
const caprate = read('resources/what-is-a-good-cap-rate/index.html');
const rentvsbuy = read('resources/should-i-rent-or-buy-a-house/index.html');
const css = read('assets/resources.css');

// Hub: intro + exactly four real cards, no dates, no extra features.
check('hub H1', hub.includes('<h1>Real Estate Resources</h1>'));
check('hub intro copy', hub.includes('Practical guides to buying, selling, financing and investing in real estate.'));
equal('exactly five article cards', (hub.match(/class="article-card"/g) || []).length, 5);
check('mortgage card title', hub.includes('<h2 id="mortgage-title">Understanding Mortgage Payments</h2>'));
check('commission card title', hub.includes('<h2 id="commission-title">Understanding Real Estate Commission</h2>'));
check('affordability card title', hub.includes('<h2 id="affordability-title">How Much House Can I Afford?</h2>'));
check('mortgage card link', hub.includes('href="mortgage-payments/"'));
check('commission card link', hub.includes('href="real-estate-commission/"'));
check('affordability card link', hub.includes('href="how-much-house-can-i-afford/"'));
check('cap rate card title', hub.includes('<h2 id="cap-rate-title">What Is a Good Cap Rate?</h2>'));
check('cap rate card link', hub.includes('href="what-is-a-good-cap-rate/"'));
check('rent vs buy card title', hub.includes('<h2 id="rent-vs-buy-title">Should I Rent or Buy a House?</h2>'));
check('rent vs buy card link', hub.includes('href="should-i-rent-or-buy-a-house/"'));
check('no dates on cards', !hub.includes('card-date') && !/<time[\s>]/.test(hub));
check('no search/filter/newsletter on hub', !/article-search|category-filter|newsletter/.test(hub));
for (const [name, card] of [['mortgage', hub.match(/<article class="article-card" id="mortgage-guide">[\s\S]*?<\/article>/)[0]],
                            ['commission', hub.match(/<article class="article-card" id="commission-guide">[\s\S]*?<\/article>/)[0]],
                            ['affordability', hub.match(/<article class="article-card" id="affordability-guide">[\s\S]*?<\/article>/)[0]],
                            ['cap rate', hub.match(/<article class="article-card" id="cap-rate-guide">[\s\S]*?<\/article>/)[0]],
                            ['rent vs buy', hub.match(/<article class="article-card" id="rent-vs-buy-guide">[\s\S]*?<\/article>/)[0]]]) {
  const desc = card.match(/<p class="article-card-desc">([\s\S]*?)<\/p>/)[1].replace(/<[^>]+>/g, '');
  const words = desc.trim().split(/\s+/).length;
  check(`${name} card description 25-40 words (${words})`, words >= 25 && words <= 40);
  check(`${name} card single link`, (card.match(/<a\s/g) || []).length === 1);
}

// Legacy anchors still resolve on the hub.
for (const id of ['mortgage-guide', 'commission-guide', 'affordability-guide', 'cap-rate-guide', 'rent-vs-buy-guide', 'calculators', 'available-title', 'mortgage-title', 'commission-title', 'affordability-title', 'cap-rate-title', 'rent-vs-buy-title', 'reading-title']) check(`hub anchor #${id}`, hub.includes(`id="${id}"`));

// Calculator directory intact: all ten tools linked from the hub.
for (const slug of ['mortgage-calculator', 'home-affordability-calculator', 'rent-vs-buy-calculator', 'bridge-loan-calculator',
  'cap-rate-calculator', 'noi-calculator', 'roi-calculator', 'property-investment-calculator',
  'capital-gains-tax-calculator', 'commission-calculator']) {
  check(`hub directory links ${slug}`, hub.includes(`href="../tools/${slug}/"`));
}

// Standalone articles: identity, SEO and template wiring.
for (const [name, page, slug, title] of [
  ['mortgage', mortgage, 'mortgage-payments', 'Understanding Mortgage Payments'],
  ['commission', commission, 'real-estate-commission', 'Understanding Real Estate Commission'],
  ['affordability', affordability, 'how-much-house-can-i-afford', 'How Much House Can I Afford?'],
  ['cap rate', caprate, 'what-is-a-good-cap-rate', 'What Is a Good Cap Rate for a Rental Property?'],
  ['rent vs buy', rentvsbuy, 'should-i-rent-or-buy-a-house', 'Should I Rent or Buy a House?']]) {
  equal(`${name} exactly one H1`, (page.match(/<h1>/g) || []).length, 1);
  check(`${name} H1 text`, page.includes(`<h1>${title}</h1>`));
  check(`${name} canonical`, page.includes(`rel="canonical" href="https://everyrealestatecalculator.com/resources/${slug}/"`));
  check(`${name} shared stylesheet`, page.includes('href="../../assets/resources.css"'));
  check(`${name} no article breadcrumbs or metadata row`, !/class="(?:breadcrumbs|article-meta|article-readtime|chip)"/.test(page));
  check(`${name} no inline scripts`, !/<script(?![^>]*\bsrc=)/i.test(page));
  check(`${name} no inline handlers`, !/<[^>]*\son[a-z]+\s*=/i.test(page));
  check(`${name} no invented date`, !/<time[\s>]/.test(page) && !page.includes('Last updated'));
}
check('mortgage article links its calculator', mortgage.includes('href="../../tools/mortgage-calculator/"'));
check('commission article links its calculator', commission.includes('href="../../tools/commission-calculator/"'));
check('affordability article links its calculator', affordability.includes('href="../../tools/home-affordability-calculator/"'));
check('cap rate article links its calculator', caprate.includes('href="../../tools/cap-rate-calculator/"'));
check('rent vs buy article links its calculator', rentvsbuy.includes('href="../../tools/rent-vs-buy-calculator/"'));
check('rent vs buy article links the affordability guide', rentvsbuy.includes('href="../how-much-house-can-i-afford/"'));
check('cap rate article links the affordability guide', caprate.includes('href="../how-much-house-can-i-afford/"'));
check('articles cross-link', mortgage.includes('href="../real-estate-commission/"') && commission.includes('href="../mortgage-payments/"'));
check('affordability article links the mortgage guide', affordability.includes('href="../mortgage-payments/"'));
// The mortgage guide now states the calculator's real model (tax, insurance,
// HOA dues and PMI are added when entered); the old false exclusion is gone.
check('mortgage fix: added when entered', mortgage.includes('plus property tax, homeowner insurance, HOA dues and PMI whenever you enter them'));
check('mortgage fix: old exclusion removed', !mortgage.includes('The result excludes property taxes') && !mortgage.includes('It does not model rate changes, extra payments'));
check('commission example identifies the current mode and role', commission.includes('Choose Agent Earnings and keep your role set to Both sides, with referral and franchise fees at 0%'));
check('commission split accounts for side and fees', commission.includes('Your percentage of the applicable side after referral and franchise fees.'));
for (const title of ['Understanding Mortgage Payments', 'Understanding Real Estate Commission', 'How Much House Can I Afford?', 'What Is a Good Cap Rate?', 'Should I Rent or Buy a House?']) {
  check(title + ' card link has a distinct accessible name', hub.includes('aria-label="Read article: ' + title + '"'));
}

// Card metadata remains part of the directory; article headers start at H1.
for (const [id, category, minutes] of [['mortgage-guide', 'Mortgage', '3'], ['commission-guide', 'For agents', '2'], ['affordability-guide', 'Buying', '8'], ['cap-rate-guide', 'Investing', '10'], ['rent-vs-buy-guide', 'Buying', '15']]) {
  const card = hub.match(new RegExp('<article class="article-card" id="' + id + '">[\\s\\S]*?</article>'))[0];
  check(id + ' card badge unchanged', card.includes('<span class="chip">' + category + '</span>'));
  check(id + ' card reading time unchanged', card.includes('<span class="read-time">' + minutes + ' min read</span>'));
}

// Sitemap carries all five articles plus the legal pages; 23 URLs in total.
const sm = read('sitemap.xml');
equal('sitemap 29 URLs', (sm.match(/<loc>/g) || []).length, 29); // +1: down-payment-calculator (2026-11-22), +1: rental-yield-calculator (2026-11-24), +1: commercial-real-estate-calculator (2026-11-24), +1: irr-calculator (2026-11-24), +1: depreciation-calculator (2026-11-25), +1: wholesale-calculator (2026-11-25)
check('sitemap privacy page', sm.includes('<loc>https://everyrealestatecalculator.com/privacy-policy/</loc>'));
check('sitemap terms page', sm.includes('<loc>https://everyrealestatecalculator.com/terms/</loc>'));
check('sitemap mortgage article', sm.includes('<loc>https://everyrealestatecalculator.com/resources/mortgage-payments/</loc>'));
check('sitemap commission article', sm.includes('<loc>https://everyrealestatecalculator.com/resources/real-estate-commission/</loc>'));
check('sitemap affordability article', sm.includes('<loc>https://everyrealestatecalculator.com/resources/how-much-house-can-i-afford/</loc>'));
check('sitemap cap rate article', sm.includes('<loc>https://everyrealestatecalculator.com/resources/what-is-a-good-cap-rate/</loc>'));
check('sitemap rent vs buy article', sm.includes('<loc>https://everyrealestatecalculator.com/resources/should-i-rent-or-buy-a-house/</loc>'));

// Centralized stylesheet: shared file exists, page-local copy is gone.
check('shared resources.css in assets', fs.existsSync(path.join(root, 'assets/resources.css')));
check('page-local resources.css removed', !fs.existsSync(path.join(root, 'resources/resources.css')));
check('grid tokens in shared css', css.includes('grid-template-columns: repeat(3, minmax(0, 1fr))') && css.includes('border-radius: 15px'));

console.log(`W9 Resources: ${passed} passed, 0 failed (Resources hub cards, standalone articles, anchors, sitemap, shared stylesheet).`);
