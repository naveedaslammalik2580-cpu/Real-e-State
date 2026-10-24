// Run from any directory: node path/to/website/tests/w2.cjs
// Built-in Node modules only; all filesystem checks stay under website/.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const registryContext = { window: {} };
vm.runInNewContext(read('assets/tool-registry.js'), registryContext);
const registry = registryContext.window.realEstateTools;
assert(Array.isArray(registry));
const slugs = new Set();
for (const tool of registry) {
  for (const key of ['slug', 'title', 'category', 'description', 'status', 'publicUrl']) {
    assert.equal(typeof tool[key], 'string'); assert(tool[key].trim());
  }
  assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tool.slug));
  assert(!slugs.has(tool.slug)); slugs.add(tool.slug);
  assert(['draft', 'published'].includes(tool.status));
  assert.equal(tool.publicUrl, `${tool.slug}/`);
  if (tool.status === 'published') assert(fs.existsSync(path.join(root, 'tools', tool.publicUrl, 'index.html')));
}
class Element {
  constructor() {
    this.children = []; this.attributes = {}; this.listeners = {}; this.style = {};
    this.value = ''; this.textContent = ''; this.hidden = false;
    this.classList = { toggle: (name, force) => {
      const names = new Set((this.className || '').split(' ').filter(Boolean));
      const on = force === undefined ? !names.has(name) : force;
      if (on) names.add(name); else names.delete(name);
      this.className = [...names].join(' '); return on;
    }, remove: name => this.classList.toggle(name, false) };
  }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  fire(name, event = {}) { this.listeners[name](event); }
}
function directory(data) {
  const ids = Object.fromEntries(['tool-grid', 'tool-search', 'tool-filters', 'no-results', 'tool-count'].map(id => [id, new Element()]));
  vm.runInNewContext(read('assets/tool-directory.js'), {
    window: { realEstateTools: data },
    document: { getElementById: id => ids[id], createElement: () => new Element() }
  });
  return {
    ids, visible: () => ids['tool-grid'].children.filter(card => !card.hidden),
    search(value) { ids['tool-search'].value = value; ids['tool-search'].fire('input'); },
    filter(label) { ids['tool-filters'].children.find(b => b.textContent === label).fire('click'); }
  };
}
let d = directory(registry);
assert.equal(d.visible().length, 6);
assert.deepEqual(d.visible().map(c => c.href), ['commission-calculator/', 'mortgage-calculator/', 'home-affordability-calculator/', 'rent-vs-buy-calculator/', 'cap-rate-calculator/', 'bridge-loan-calculator/']);
d.search('  MORTGAGE  '); assert.equal(d.visible().length, 1);
d.search('transaction fees'); assert.equal(d.visible()[0].href, 'commission-calculator/');
d.search('not-a-tool'); assert.equal(d.visible().length, 0); assert.equal(d.ids['no-results'].style.display, 'block');
d.search(''); assert.equal(d.visible().length, 6);
// Synthetic records exist only in memory, never as fake published pages.
d = directory([...registry, { slug: 'test', title: 'Test', category: 'Planning', description: 'Schedule', status: 'published', publicUrl: 'test/' },
  { slug: 'draft', title: 'Secret draft', category: 'Draft category', description: '', status: 'draft', publicUrl: 'draft/' }]);
assert.equal(d.visible().length, 7); assert.equal(d.ids['tool-filters'].children.length, 3);
d.filter('Planning'); assert.equal(d.visible().length, 1);
assert.equal(d.ids['tool-filters'].children.find(b => b.textContent === 'Planning').attributes['aria-pressed'], 'true');
d.search('mortgage'); assert.equal(d.visible().length, 0);
d.filter('All tools'); assert.equal(d.visible().length, 1);
d.search('draft'); assert.equal(d.visible().length, 0);
assert.equal(directory([]).ids['no-results'].textContent, 'No tools are published yet.');
assert.equal(directory(undefined).ids['tool-search'].disabled, true);
const shared = read('assets/site.js');
function calculator(name) {
  const html = read(`tools/${name}-calculator/index.html`), elements = {};
  for (const tag of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    const el = new Element(); el.value = tag[0].match(/\bvalue="([^"]*)"/)?.[1] || ''; elements[tag[1]] = el;
  }
  const form = `${name}-form`;
  const inputs = [...html.matchAll(/<input[^>]*\bid="([^"]+)"[^>]*>/g)].map(m => elements[m[1]]);
  // Each tool runs its own scoped script; the shared script keeps only the menu.
  const script = name === 'mortgage' ? read('tools/mortgage-calculator/calculator.js') : name === 'commission' ? read('tools/commission-calculator/calculator.js') : name === 'home-affordability' ? read('tools/home-affordability-calculator/calculator.js') : name === 'rent-vs-buy' ? read('tools/rent-vs-buy-calculator/calculator.js') : name === 'cap-rate' ? read('tools/cap-rate-calculator/calculator.js') : name === 'bridge-loan' ? read('tools/bridge-loan-calculator/calculator.js') : shared;
  vm.runInNewContext(script, { Intl, document: {
    querySelector: s => s === '#' + form ? elements[form] : null,
    querySelectorAll: s => s === '#' + form + ' input' ? inputs : [], getElementById: id => elements[id]
  } });
  return { get: id => elements[id].textContent, html: id => elements[id].innerHTML, fire(id, event) { elements[id].fire(event); }, put(id, value) { elements[id].value = String(value); }, val: id => elements[id].value, set(id, value) { elements[id].value = String(value); elements[id].fire('input'); } };
}
const c = calculator('commission');
assert.equal(c.get('commission-total'), '$13,500.00'); assert.equal(c.get('commission-agent'), '$9,450.00');
assert.equal(c.get('commission-net'), '$9,155.00');
c.set('agent-split', 100); assert.equal(c.get('commission-net'), '$13,205.00');
c.set('commission-rate', 0); assert.equal(c.get('commission-total'), '$0.00');
c.set('commission-rate', 101); assert.equal(c.get('commission-total'), 'Check inputs');
c.set('commission-rate', 3); c.set('agent-split', 70);
assert.equal(c.get('listing-side'), '$6,750.00'); assert.equal(c.get('buyer-side'), '$6,750.00');
assert.equal(c.get('seller-net'), '$436,500.00'); assert.equal(c.get('your-side-label'), 'Your side (both sides)');
c.put('agent-role', 'listing'); c.fire('agent-role', 'change');
assert.equal(c.get('commission-agent'), '$4,725.00'); assert.equal(c.get('commission-net'), '$4,430.00');
assert.equal(c.get('your-side-label'), 'Your side (listing side)');
c.set('referral-fee', 10); c.set('franchise-fee', 6);
assert.equal(c.get('referral-amount'), '$1,350.00'); assert.equal(c.get('franchise-amount'), '$810.00');
assert.equal(c.get('commission-agent'), '$3,969.00'); assert.equal(c.get('commission-net'), '$3,674.00');
c.set('other-closing-costs', 1.5); c.set('mortgage-payoff', 200000);
assert.equal(c.get('selling-cost'), '$20,250.00'); assert.equal(c.get('seller-net'), '$229,750.00');
const m = calculator('mortgage');
assert.equal(m.get('monthly-payment'), '$2,022.62'); assert.equal(m.get('loan-amount'), '$320,000.00');
m.set('interest-rate', 0); assert.equal(m.get('monthly-payment'), '$888.89'); assert.equal(m.get('total-interest'), '$0.00');
m.set('down-payment', 400000); assert.equal(m.get('monthly-payment'), '$0.00');
m.set('down-payment', 400001); assert.equal(m.get('monthly-payment'), '\u2014');
m.set('down-payment', 80000); m.set('loan-years', 0); assert.equal(m.get('monthly-payment'), '\u2014');
m.set('loan-years', 30); m.set('interest-rate', 6.5);
assert.equal(m.get('interest-saved'), '$0.00'); assert.equal(m.get('time-saved'), 'No time saved');
assert(m.html('term-compare-body').includes('$2,787.54')); assert(m.html('term-compare-body').includes('mortgage-current-term'));
m.set('extra-payment', 200); assert.equal(m.get('interest-saved'), '$105,428.67'); assert.equal(m.get('time-saved'), '6 years 7 months sooner');
m.fire('schedule-monthly-btn', 'click'); assert.equal((m.html('mortgage-schedule-body').match(/<tr>/g) || []).length, 281);
const a = calculator('home-affordability');
assert.equal(a.get('afford-price'), '$330,118.43'); assert.equal(a.get('afford-loan'), '$270,118.43');
assert.equal(a.get('afford-monthly'), '$2,300.00'); assert.equal(a.get('afford-pi'), '$1,707.33');
assert.equal(a.get('afford-tax'), '$330.12'); assert.equal(a.get('afford-pmi'), '$112.55');
assert.equal(a.get('cash-to-close'), '$69,903.55');
a.fire('guide-budget-btn', 'click'); assert.equal(a.val('monthly-budget'), '2333.33');
assert.equal(a.get('afford-price'), '$334,426.11');
a.set('monthly-budget', -1); assert.equal(a.get('afford-price'), 'Check inputs');
const r = calculator('rent-vs-buy');
assert.equal(r.get('rent-verdict'), 'Renting wins for your 7-year stay');
assert.equal(r.get('breakeven-year'), 'Year 9');
assert.equal(r.get('buy-monthly'), '$2,561.46'); assert.equal(r.get('rent-now'), '$1,800.00');
assert.equal(r.get('total-rent'), '$165,509.18');
assert.equal(r.get('net-buy-cost'), '$144,199.38'); assert.equal(r.get('net-rent-cost'), '$132,737.60');
assert.equal(r.get('savings-label'), 'Renting saves'); assert.equal(r.get('savings-amount'), '$11,461.78');
r.set('years-stay', 10);
assert.equal(r.get('rent-verdict'), 'Buying wins — breakeven in year 9');
assert.equal(r.get('savings-amount'), '$13,894.25');
r.set('monthly-rent', -1); assert.equal(r.get('rent-verdict'), 'Check inputs');
const k = calculator('cap-rate');
assert.equal(k.get('cap-rate'), '4.45%'); assert.equal(k.get('noi-annual'), '$15,573.60');
assert.equal(k.get('effective-income'), '$25,080.00'); assert.equal(k.get('total-expenses'), '$9,506.40');
assert.equal(k.get('noi-monthly'), '$1,297.80'); assert.equal(k.get('grm'), '13.26x');
assert.equal(k.get('expense-ratio'), '37.90%'); assert.equal(k.get('cap-low'), '4.94%');
assert.equal(k.get('cap-high'), '4.05%'); assert.equal(k.get('value-at-target'), '$194,670.00');
k.set('vacancy-rate', 0); assert.equal(k.get('cap-rate'), '4.80%');
k.set('property-price', -1); assert.equal(k.get('cap-rate'), 'Check inputs');
const b = calculator('bridge-loan');
assert.equal(b.get('bridge-amount'), '$160,000.00'); assert.equal(b.get('bridge-monthly'), '$1,200.00');
assert.equal(b.get('total-bridge-cost'), '$11,800.00'); assert.equal(b.get('down-needed'), '$120,000.00');
assert.equal(b.get('cash-after-sale'), '$63,000.00'); assert.equal(b.get('available-equity'), '$250,000.00');
assert.equal(b.get('total-interest'), '$7,200.00'); assert.equal(b.get('origination-fee'), '$1,600.00');
b.set('months-to-sale', 12); assert.equal(b.get('total-bridge-cost'), '$19,000.00');
b.set('down-percent', 30); assert.equal(b.get('cash-needed'), '$20,000.00');
b.set('bridge-rate', 0); assert.equal(b.get('bridge-monthly'), '$0.00');
b.set('current-mortgage', 400000); assert.equal(b.get('bridge-amount'), 'Check inputs');
const toggle = new Element(), nav = new Element(), events = {};
nav.contains = () => true;
toggle.focus = () => { toggle.focused = true; };
vm.runInNewContext(shared, { document: {
  querySelector: s => s === '.menu-toggle' ? toggle : s === '.nav' ? nav : null,
  addEventListener: (name, fn) => events[name] = fn
} });
toggle.fire('click'); assert.equal(toggle.attributes['aria-expanded'], 'true'); assert(nav.className.includes('is-open'));
events.keydown({ key: 'Escape' }); assert.equal(toggle.attributes['aria-expanded'], 'false'); assert(!nav.className.includes('is-open'));
assert.equal(toggle.focused, true, 'Escape returns focus from the hidden menu to its toggle');
function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]); }
let references = 0, pages = 0;
for (const file of walk(root).filter(f => /\.(html|css|js)$/.test(f))) {
  const content = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.js')) { new vm.Script(content); continue; }
  if (file.endsWith('.html')) pages++;
  const refs = [...content.matchAll(/(?:href|src)\s*=\s*["']([^"']*)["']/g)].map(m => m[1]);
  if (file.endsWith('.css')) refs.push(...[...content.matchAll(/url\(\s*["']?([^\s"')]+)["']?\s*\)/g)].map(m => m[1]));
  for (const ref of refs) {
    if (/^(?:[a-z]+:|\/\/)/i.test(ref)) continue;
    const url = new URL(ref, 'https://local.test/' + path.relative(root, file).split(path.sep).join('/'));
    let target = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    assert(target === root || target.startsWith(root + path.sep), 'Outside website');
    assert(fs.existsSync(target), `Missing ${ref} in ${file}`);
    if (fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
    assert(fs.existsSync(target), `Missing index: ${ref}`);
    if (url.hash) assert([...fs.readFileSync(target, 'utf8').matchAll(/\bid="([^"]+)"/g)].some(m => m[1] === decodeURIComponent(url.hash.slice(1))), `Missing anchor: ${ref}`);
    references++;
  }
}
const directoryHtml = read('tools/index.html');
assert(directoryHtml.indexOf('tool-registry.js') < directoryHtml.indexOf('tool-directory.js'));
assert(read('assets/theme.css').includes('#tool-grid .tool-card[hidden] {display:none;}'));
console.log(`PASS: registry, published-only rendering, search/category combinations, empty/error states, navigation, 78 calculator assertions, JS syntax, ${references} internal references across ${pages} pages.`);
console.log('DOM behavior uses stubs; browser responsive/visual verification remains manual.');
