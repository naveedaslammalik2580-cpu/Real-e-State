const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const html = read('index.html'), css = read('assets/home.css');
const ctx = { window: {} }; vm.runInNewContext(read('assets/tool-registry.js'), ctx);
const registry = ctx.window.realEstateTools;
const published = registry.filter(t => t.status === 'published');
const fallback = [...html.matchAll(/data-home-tool="([^"]+)" href="([^"]+)"/g)];
assert.deepEqual(fallback.map(m => [m[1], m[2]]), Array.from(published, t => [t.slug, 'tools/' + t.publicUrl]));
class Element {
  constructor() { this.children = []; this.attributes = {}; this.value = ''; this.listeners = {}; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(k, v) { this.attributes[k] = v; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  focus() { this.focused = true; }
}
function render(tools) {
  const grid = new Element();
  const ids = { 'home-search': new Element(), 'home-search-results': new Element(), 'home-search-status': new Element() };
  vm.runInNewContext(read('assets/home.js'), { window: { realEstateTools: tools }, document: { getElementById: id => ids[id], createElement: () => new Element() } });
  grid.ids = ids;
  return grid;
}
const cards = render([...registry, { slug: 'draft', status: 'draft', publicUrl: 'draft/' }]).ids['home-search-results'].children;
assert.equal(cards.length, published.length);
assert.deepEqual(cards.map(c => c.href), Array.from(published, t => 'tools/' + t.publicUrl));
assert.equal(render([]).ids['home-search-results'].children[0].textContent, 'No tools are published yet.');
assert.equal(render(undefined).children.length, 0);
const live = render([...registry, { slug:'draft', title:'Hidden draft', status:'draft', publicUrl:'draft/' }]);
const search = live.ids['home-search'], results = live.ids['home-search-results'], status = live.ids['home-search-status'];
assert.equal(results.children.length, 3);
search.value = ' MORTGAGE '; search.listeners.input();
assert.equal(results.children.length, 1); assert.equal(results.children[0].href, 'tools/mortgage-calculator/');
search.value = 'transaction fees'; search.listeners.input();
assert.equal(results.children[0].href, 'tools/commission-calculator/');
search.value = 'draft'; search.listeners.input(); assert.equal(status.textContent, '0 tools found');
assert(results.children[0].textContent.includes('No matching tools'));
search.value = ''; search.listeners.input(); assert.equal(status.textContent, '3 tools found');
assert.equal(render([]).ids['home-search-status'].textContent, '0 tools found');
search.value = 'Finance & numbers'; search.listeners.input();
assert.equal(status.textContent, '3 tools found');
const section = html.match(/<section class="section home-how"[\s\S]*?<\/section>/)[0];
assert(section.includes('From numbers to clarity in seconds.'));
assert.equal((section.match(/<li>/g) || []).length, 3);
for (const title of ['Choose a Tool', 'Enter Your Details', 'Understand Your Results']) assert(section.includes('<h3>' + title + '</h3>'));
assert(section.includes('href="tools/"')); assert(section.includes('href="resources/"'));
assert(css.includes('.home .home-how-steps {display:grid;grid-template-columns:repeat(3,minmax(0,1fr))'));
assert(css.includes('@media(max-width:760px){.home .home-how-steps {grid-template-columns:minmax(0,1fr)'));
assert(!html.includes('class="home-tool-grid"'), 'No duplicate large calculator cards');
assert(html.includes('class="home-product-overview"'));
assert(!/Screenshot placeholder|Genuine preview pending|home-screenshot/.test(html));
const footer = html.match(/<footer[\s\S]*?<\/footer>/)[0];
assert(!/Before launch|Working name|brand pending|Static demonstration|finalized before public launch/.test(footer));
assert(footer.includes('data-brand-name'));
for (const href of ['tools/', 'tools/commission-calculator/', 'tools/mortgage-calculator/', 'tools/home-affordability-calculator/', 'realtoros/', 'resources/', 'about/', 'contact/']) assert(footer.includes(`href="${href}"`));
assert(css.includes('.home .footer .brand {display:inline-flex'));
assert(css.includes('max-width:100%;white-space:normal'));
assert(css.includes('max-height:calc(100dvh - 68px);overflow-y:auto'));
assert(!/Sarah M\.|James C\.|Emily W\.|Illustrative sample|crm-line|small-insight/.test(html));
assert(html.indexOf('assets/tool-registry.js') < html.indexOf('assets/home.js'));
assert(html.includes('id="free-tools"'));
for (const width of [1000,760,540]) assert(css.includes(`max-width:${width}px`));
assert(css.includes('grid-template-columns:minmax(0,1fr)'));
assert(css.includes('min-height:48px'));
const sections = [...html.matchAll(/<section class="([^"]+)"/g)].map(m => m[1]);
assert.deepEqual(sections, ['home-hero', 'section home-use-cases', 'section home-how', 'home-product', 'section home-benefits-section', 'section home-faq', 'home-closing']);
const cases = html.match(/<section class="section home-use-cases"[\s\S]*?<\/section>/)[0];
const caseLinks = [...cases.matchAll(/href="([^"]+)"/g)].map(m => m[1]);
assert.deepEqual(caseLinks, Array.from(published, t => 'tools/' + t.publicUrl));
const faq = html.match(/<section class="section home-faq"[\s\S]*?<\/section>/)[0];
assert.equal((faq.match(/<details>/g) || []).length, 4);
assert.equal((faq.match(/<summary>/g) || []).length, 4);
assert(faq.includes('excludes taxes'));
assert(faq.includes('No account or signup is required'));
for (const capability of ['Today', 'Contacts', 'Deals', 'Follow-up Plans']) assert(html.includes(`<dt>${capability}</dt>`));
const theme = read('assets/theme.css');
assert(theme.includes("--font-body:'Inter'"));
assert(theme.includes("--font-display:'Source Serif 4'"));
assert(theme.includes('font-weight:500'));
console.log('PASS: homepage registry/static fallback alignment, draft exclusion, empty state, honest product overview, clean configurable footer, preserved links/anchor, script order, responsive safeguards and touch-target sizing.');
console.log('CSS checks are structural; desktop/tablet/Android browser rendering and reference matching still require visual review.');
