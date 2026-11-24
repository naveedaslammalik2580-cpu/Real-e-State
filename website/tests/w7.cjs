// W7 — Final SEO launch content guards (2026-11-09).
// Locks the content corrections from the final SEO implementation:
// no stale two-calculator wording, no false mortgage-FAQ claim, the tools
// index carries static indexable descriptions for all ten tools, the CGT
// page cites its IRS sources, Cap Rate/NOI carry their new sections, the
// Bridge comparison exists, "Follow-up Plans" is not marketed anywhere,
// RealtorCRM states the free early-access offer, the protected media
// placeholders are untouched, and no legal page is published yet.
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
let passed = 0; const failures = [];
function check(name, cond) { if (cond) { passed++; } else { failures.push(name); } }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
const PAGES = ['index.html', 'tools/index.html', 'about/index.html', 'contact/index.html',
  'resources/index.html', 'real-estate-crm/index.html',
  ...['mortgage-calculator','commission-calculator','home-affordability-calculator','rent-vs-buy-calculator',
      'cap-rate-calculator','bridge-loan-calculator','property-investment-calculator',
      'capital-gains-tax-calculator','roi-calculator','noi-calculator'].map(s => `tools/${s}/index.html`)];
const all = PAGES.map(read).join('\n');

// 1. Stale two-calculator era wording is gone everywhere.
for (const stale of ['currently published Commission and Mortgage', 'current Commission and Mortgage',
  'The mortgage estimate excludes taxes, insurance', 'free Commission and Mortgage calculators, with clear inputs']) {
  check(`stale wording absent: "${stale.slice(0, 40)}"`, !all.includes(stale));
}
// 2. Homepage states the ten-calculator reality.
const home = read('index.html');
check('homepage says all ten calculators', home.includes('All ten calculators are ready to use'));
check('homepage FAQ free answer updated', home.includes('All ten calculators are free to use'));
check('homepage mortgage FAQ corrected', home.includes('plus property tax, homeowners insurance, HOA dues and PMI'));
// 3. Inactive automation is not marketed anywhere.
check('"Follow-up Plans" absent from all pages', !all.includes('Follow-up Plans'));
// 4. Tools index: static directory lists all ten tools with links.
const tools = read('tools/index.html');
for (const slug of ['mortgage-calculator','home-affordability-calculator','rent-vs-buy-calculator','bridge-loan-calculator',
  'cap-rate-calculator','noi-calculator','property-investment-calculator','roi-calculator',
  'capital-gains-tax-calculator','commission-calculator']) {
  check(`tools directory links ${slug}`, tools.includes(`<li><a href="${slug}/">`));
}
check('tools meta updated', tools.includes('Explore 10 free real estate calculators'));
// 5. CGT sources + mistakes.
const cgt = read('tools/capital-gains-tax-calculator/index.html');
for (const u of ['irs.gov/publications/p523', 'irs.gov/taxtopics/tc409', 'irs.gov/publications/p544',
  'irs.gov/publications/p946', 'net-investment-income-tax']) {
  check(`CGT cites ${u}`, cgt.includes(u));
}
check('CGT has Common mistakes', cgt.includes('<h2>Common mistakes</h2>'));
check('CGT has Sources', cgt.includes('<h2>Sources</h2>'));
// 6. Cap Rate + NOI.
const cap = read('tools/cap-rate-calculator/index.html');
check('cap rate formula section', cap.includes('<h2>The cap rate formula</h2>') && cap.includes('Estimated value = NOI ÷ Cap rate'));
check('cap rate distinct example', cap.includes('5.66%') && cap.includes('$35,078.08'));
check('cap rate mistakes', cap.includes('<h2>Common mistakes</h2>'));
const noi = read('tools/noi-calculator/index.html');
check('NOI meta rewritten', noi.includes('why the mortgage stays out'));
// Corrected 2026-11-14 (design-system task): the expense-side paragraph
// previously said $11,546.40 / 42.6%, contradicting the worked example on
// the same page ($9,506.40 expenses, 37.90% ratio, tax 44% of expenses).
// The assertion now locks the corrected figures.
check('NOI expense narrative', noi.includes('Reading the expense side of the example') && noi.includes('absorbs 37.90%') && noi.includes('about 44% of all expenses'));
// 7. Bridge comparison + mistakes sections.
check('bridge comparison', read('tools/bridge-loan-calculator/index.html').includes('Bridge loan, HELOC, or home-equity loan?'));
for (const slug of ['mortgage-calculator','commission-calculator','home-affordability-calculator','property-investment-calculator']) {
  check(`${slug} mistakes section`, read(`tools/${slug}/index.html`).includes(slug === 'commission-calculator' ? '<h2>Common Commission Calculation Mistakes</h2>' : slug === 'mortgage-calculator' ? '<h2>Common Mortgage Mistakes to Avoid</h2>' : '<h2>Common mistakes</h2>'));
}
// 8. RealtorCRM: early access stated, placeholders byte-identical text.
const rc = read('real-estate-crm/index.html');
check('realtorcrm meta early access', rc.includes('Free during early access'));
check('realtorcrm access section early access', rc.includes('RealtorCRM is free during early access — organize your contacts'));
check('demo placeholder untouched', rc.includes('RealtorCRM Product Demo') && rc.includes('Add your product video or screenshots here'));
check('mobile placeholder untouched', rc.includes('RealtorCRM Mobile Preview') && rc.includes('Add your real mobile screenshot here'));
// 9. About product scope and methodology, integrated into the approach section.
const about = read('about/index.html');
check('about verified CRM scope', about.includes('organize contacts, deals, appointments and follow-ups') && !about.includes('Follow-up Plans'));
check('about methodology', ['formulas, inputs and assumptions', 'Worked examples', 'understand and check their results', 'Every estimate has limitations', 'not as a replacement for professional financial, legal or tax advice'].every(text => about.includes(text)));
// 10. Privacy and terms pages are published; sitemap exactly 23 URLs (18 site
// pages + the five standalone Resources guides).
check('privacy page published in website tree', fs.existsSync(path.join(ROOT, 'privacy-policy', 'index.html')));
check('terms page published in website tree', fs.existsSync(path.join(ROOT, 'terms', 'index.html')));
const sm = read('sitemap.xml');
check('sitemap still 23 URLs', (sm.match(/<loc>/g) || []).length === 23);
console.log(`W7: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log('  FAIL:', f);
process.exit(failures.length ? 1 : 0);
