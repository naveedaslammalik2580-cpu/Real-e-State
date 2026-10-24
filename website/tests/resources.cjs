const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('resources/index.html');
for (const name of ['commission', 'mortgage']) {
  const page = read(`tools/${name}-calculator/index.html`), nodes = {};
  for (const match of page.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    nodes[match[1]] = { value: match[0].match(/\bvalue="([^"]*)"/)?.[1] || '', textContent: '', addEventListener() {} };
  }
  const inputs = [...page.matchAll(/<input[^>]+\bid="([^"]+)"/g)].map(m => nodes[m[1]]);
  const script = name === 'mortgage' ? read('tools/mortgage-calculator/calculator.js') : read('tools/commission-calculator/calculator.js');
  vm.runInNewContext(script, { Intl, document: {
    querySelector: selector => selector === `#${name}-form` ? nodes[`${name}-form`] : null,
    querySelectorAll: selector => selector === `#${name}-form input` ? inputs : [],
    getElementById: id => nodes[id]
  } });
  const keys = name === 'commission' ? ['commission-total','commission-agent','commission-net'] : ['loan-amount','monthly-payment'];
  for (const key of keys) {
    const displayed = html.match(new RegExp(`data-example="${key}">([^<]+)`))?.[1];
    assert.equal(displayed, nodes[key].textContent, `Example differs from calculator: ${key}`);
  }
}
assert(html.includes('Understand real estate numbers with confidence.'));
assert(html.includes('Resources &amp; Learning'));
assert(html.includes('At 0% interest'));
assert(html.includes('HOA fees'));
assert(html.includes('taxes, referral payments'));
assert(!/No standalone guides|Before launch|Working name|Static demonstration/.test(html));
for (const slug of ['commission-calculator', 'mortgage-calculator']) assert(html.includes(`href="../tools/${slug}/"`));
const footer = html.match(/<footer[\s\S]*?<\/footer>/)[0];
assert(footer.includes('data-brand-name'));
assert(footer.includes('href="../about/"'));
assert(html.includes('<summary>See the payment formula</summary>'));
assert(read('resources/resources.css').includes('font-family:var(--font-display)'));
console.log('PASS: five worked-example outputs match actual calculator execution; educational limitations, native formula disclosure, font tokens, branding and calculator links checked.');
console.log('Visual rendering and overflow require browser review; these are script/static checks.');
