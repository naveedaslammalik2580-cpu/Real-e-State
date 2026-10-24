const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const pages = ['index.html', 'tools/index.html', 'realtoros/index.html', 'about/index.html', 'resources/index.html', 'contact/index.html', 'tools/commission-calculator/index.html', 'tools/mortgage-calculator/index.html', 'tools/home-affordability-calculator/index.html', 'tools/rent-vs-buy-calculator/index.html'];
const titles = new Set(), descriptions = new Set();
for (const page of pages) {
  const html = fs.readFileSync(path.join(root, page), 'utf8');
  const title = [...html.matchAll(/<title>([^<]+)<\/title>/g)];
  const description = [...html.matchAll(/<meta name="description" content="([^"]+)">/g)];
  assert.equal(title.length, 1, page); assert.equal(description.length, 1, page);
  assert(!titles.has(title[0][1]), `Duplicate title: ${page}`); titles.add(title[0][1]);
  assert(!descriptions.has(description[0][1]), `Duplicate description: ${page}`); descriptions.add(description[0][1]);
  for (const key of ['og:title', 'twitter:title']) assert(html.includes(`content="${title[0][1]}"`) && new RegExp(`(?:property|name)="${key}" content="${title[0][1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(html), page);
  for (const key of ['og:description', 'twitter:description']) assert(html.includes(`="${key}" content="${description[0][1]}"`), page);
  assert(html.includes('property="og:type" content="website"'));
  assert(html.includes('name="twitter:card" content="summary"'));
  assert(!/rel="canonical"|property="og:url"/.test(html), 'No unconfigured production URLs');
  assert(html.includes('<html lang="en">')); assert(html.includes('charset="utf-8"'));
  assert(html.includes('class="skip-link" href="#main"'));
  let previous = 0, h1 = 0;
  for (const heading of html.matchAll(/<h([1-6])\b/g)) {
    const level = Number(heading[1]);
    assert(level <= previous + 1, `Skipped heading level in ${page}`);
    previous = level; if (level === 1) h1++;
  }
  assert.equal(h1, 1);
  for (const script of html.matchAll(/<script\b[^>]*src="[^"]+"[^>]*>/g)) assert(/\bdefer\b/.test(script[0]), page);
}
assert(!fs.existsSync(path.join(root, 'sitemap.xml')));
assert(!fs.existsSync(path.join(root, 'robots.txt')));
const contact = fs.readFileSync(path.join(root, 'contact/index.html'), 'utf8');
assert(contact.includes('It does not send or save your enquiry.'));
assert(contact.includes('Your draft (not sent)'));
assert(!/<form[^>]*action=/.test(contact));
console.log('PASS: 10 unique titles/descriptions, matching social metadata, heading order, language/skip links, deferred scripts, no invented canonical/sitemap URLs, honest draft-only contact messaging.');
