const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const pages = ['index.html', 'resources/index.html', 'contact/index.html', 'about/index.html', 'realtoros/index.html', 'tools/index.html', 'tools/commission-calculator/index.html', 'tools/mortgage-calculator/index.html', 'tools/home-affordability-calculator/index.html', 'tools/rent-vs-buy-calculator/index.html', 'tools/cap-rate-calculator/index.html', 'tools/bridge-loan-calculator/index.html', 'tools/property-investment-calculator/index.html', 'tools/capital-gains-tax-calculator/index.html', 'tools/roi-calculator/index.html', 'tools/noi-calculator/index.html'];
for (const file of pages) {
  const html = read(file);
  assert.equal((html.match(/<h1\b/g) || []).length, 1, file);
  assert(html.includes('name="viewport"'), file);
  assert(html.includes('assets/site-config.js'), file);
  for (const tag of ['header', 'footer']) assert(new RegExp(`<${tag}[\\s\\S]*?href="[^"]*about/"[\\s\\S]*?</${tag}>`).test(html), file);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length, file);
  for (const ref of html.matchAll(/(?:aria-describedby|aria-labelledby|aria-controls|for)="([^"]+)"/g)) {
    for (const id of ref[1].split(' ')) assert(ids.includes(id), `${file}: ${id}`);
  }
}
const contact = read('contact/index.html');
assert(!contact.includes('onsubmit'));
assert(contact.includes('id="prepare-enquiry" type="button" disabled'));
assert(contact.includes('<noscript>'));
for (const control of contact.matchAll(/<(?:input|select|textarea)\b[^>]*id="([^"]+)"[^>]*>/g)) {
  assert(contact.includes(`for="${control[1]}"`), control[1]);
}
function element() { return { value: '', hidden: true, disabled: true, textContent: '', events: {},
  addEventListener(event, handler) { this.events[event] = handler; },
  focus() { this.focused = true; }, select() { this.selected = true; } }; }
const ids = Object.fromEntries(['enquiry-form', 'prepare-enquiry', 'enquiry-draft', 'draft-output', 'enquiry-status', 'enquiry-topic', 'enquiry-name', 'enquiry-email', 'enquiry-message'].map(id => [id, element()]));
let valid = true;
ids['enquiry-form'].reportValidity = () => valid;
// No fetch, storage or network globals: draft preparation must work without them.
vm.runInNewContext(read('assets/contact.js'), { document: { getElementById: id => ids[id] } });
assert.equal(ids['prepare-enquiry'].disabled, false);
let prevented = false;
ids['enquiry-form'].events.submit({ preventDefault() { prevented = true; } });
assert(prevented);
ids['enquiry-topic'].value = 'Tool question or issue';
ids['enquiry-message'].value = '   ';
ids['prepare-enquiry'].events.click();
assert(ids['enquiry-message'].focused); assert.equal(ids['draft-output'].hidden, true);
ids['enquiry-message'].value = 'Please explain the inputs. <script>not executable</script>';
valid = false; ids['prepare-enquiry'].events.click(); assert.equal(ids['draft-output'].hidden, true);
valid = true; ids['prepare-enquiry'].events.click();
assert.equal(ids['draft-output'].hidden, false);
assert(ids['enquiry-draft'].value.includes('<script>not executable</script>'));
assert(ids['enquiry-draft'].selected);
assert(ids['enquiry-status'].textContent.includes('Nothing has been sent'));
ids['enquiry-form'].events.input(); assert.equal(ids['enquiry-draft'].value, ''); assert.equal(ids['draft-output'].hidden, true);
ids['enquiry-name'].value = 'Example'; ids['enquiry-email'].value = 'example@example.invalid';
ids['prepare-enquiry'].events.click(); assert(ids['enquiry-draft'].value.includes('Reply email: example@example.invalid'));
const labels = [{}, {}], link = { setAttribute(k, v) { this[k] = v; } };
const document = { title: 'About | Real Estate Tools', querySelectorAll: selector => selector === '[data-brand-name]' ? labels : [link] };
const config = read('assets/site-config.js').replace("brandName: 'Real Estate Tools'", "brandName: 'Test label'");
vm.runInNewContext(config, { window: {}, document });
assert.equal(labels[0].textContent, 'Test label'); assert.equal(link['aria-label'], 'Test label, homepage'); assert.equal(document.title, 'About | Test label');
assert(read('resources/index.html').includes('Understanding Real Estate Commission'));
console.log('PASS: sixteen-page shared navigation, unique IDs, label references, viewport structure, form validation branches, submission prevention, draft-only behavior, stale-draft clearing and configurable brand.');
console.log('DOM stubs do not replace browser checks for responsive layout, native validation or keyboard interaction.');
