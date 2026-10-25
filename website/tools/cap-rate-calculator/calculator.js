/* Cap Rate Calculator: cap rate = NOI / price. NOI = effective gross income
   (gross rent minus vacancy, plus other income) minus operating expenses.
   Financing is deliberately excluded. DOM-stub-safe: only querySelector,
   querySelectorAll and getElementById, guarded style/setAttribute/classList,
   one delegated listener on the form. */
(function () {
  var form = document.querySelector('#cap-rate-form');
  if (!form) return;
  function num(id) {
    var el = document.getElementById(id);
    return el ? Number(String(el.value).replace(/,/g, '').trim()) : 0;
  }
  function set(id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value;
  }
  function setWidth(id, pct) {
    var el = document.getElementById(id);
    if (el && el.style) el.style.width = pct + '%';
  }
  function setAttr(el, key, value) {
    if (el && el.setAttribute) el.setAttribute(key, value);
  }
  function hideRow(id, hide) {
    var el = document.getElementById(id);
    if (el) el.hidden = hide;
  }
  function usd(n) {
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function pct(n) {
    return n.toFixed(2) + '%';
  }
  function valid(v, min, max) {
    return Number.isFinite(v) && v >= min && v <= max;
  }
  var OUTPUTS = ['cap-rate', 'noi-annual', 'effective-income', 'total-expenses',
    'noi-monthly', 'grm', 'expense-ratio', 'cap-low', 'cap-high', 'value-at-target', 'row-noi', 'bottom-cap'];
  function run() {
    var price = num('property-price');
    var rent = num('monthly-rent');
    var vacancy = num('vacancy-rate');
    var tax = num('property-tax');
    var ins = num('home-insurance');
    var maint = num('maintenance-cost');
    var mgmtRate = num('management-rate');
    var other = num('other-income');
    var hoa = num('hoa-other');
    var target = num('target-cap-rate');
    var ok = valid(price, 0, 1e12) && price > 0 && valid(rent, 0, 1e12) &&
      valid(vacancy, 0, 100) && valid(tax, 0, 1e12) && valid(ins, 0, 1e12) &&
      valid(maint, 0, 1e12) && valid(mgmtRate, 0, 100) && valid(other, 0, 1e12) &&
      valid(hoa, 0, 1e12) && valid(target, 0, 100) && target > 0;
    // Empty fields are invalid, not zero.
    var required = ['property-price', 'monthly-rent', 'vacancy-rate', 'property-tax',
      'home-insurance', 'maintenance-cost', 'management-rate', 'other-income',
      'hoa-other', 'target-cap-rate'];
    for (var ri = 0; ri < required.length; ri++) {
      var rel = document.getElementById(required[ri]);
      if (!rel || rel.value === '') { ok = false; break; }
    }
    if (!ok) {
      // Display only: a price of 0 (or empty) gets a specific neutral
      // message instead of the generic one; validation itself is unchanged.
      set('cap-rate', price === 0 ? 'Enter a price above $0' : 'Check inputs');
      var capNoteBad = document.getElementById('cap-note');
      if (capNoteBad) capNoteBad.hidden = true;
      OUTPUTS.forEach(function (id) { if (id !== 'cap-rate') set(id, '—'); });
      set('validation-note', 'Check the values: price above $0, rates 0–100%, target cap rate above 0%, amounts 0 or more, and no field left empty.');
      set('sticky-value', '—');
      hideRow('result-body', true); hideRow('result-empty', false);
      return;
    }
    set('validation-note', '');
    hideRow('result-body', false); hideRow('result-empty', true);
    var gross = rent * 12;
    var vacancyLoss = gross * vacancy / 100;
    var effective = gross - vacancyLoss + other;
    var mgmt = effective * mgmtRate / 100;
    var expenses = tax + ins + maint + mgmt + hoa;
    var noi = effective - expenses;
    var cap = noi / price * 100;
    set('cap-rate', pct(cap));
    set('noi-annual', usd(noi));
    set('effective-income', usd(effective));
    set('total-expenses', usd(expenses));
    set('noi-monthly', usd(noi / 12));
    set('grm', gross > 0 ? (price / gross).toFixed(2) + 'x' : '—');
    set('expense-ratio', effective > 0 ? pct(expenses / effective * 100) : '—');
    set('cap-low', pct(noi / (price * 0.9) * 100));
    set('cap-high', pct(noi / (price * 1.1) * 100));
    set('value-at-target', noi > 0 ? usd(noi / (target / 100)) : '—');
    set('row-noi', usd(noi));
    set('bottom-cap', pct(cap));
    var capNote = document.getElementById('cap-note');
    if (capNote) capNote.hidden = !(noi < 0);
    set('sticky-value', pct(cap));
  }
  document.querySelectorAll('#cap-rate-form input').forEach(function (input) {
    input.addEventListener('input', run);
  });
  // NOTE: no thousand-separator rewriting here, on load or on blur. These
  // are type="number" fields, and a browser erases a comma-formatted value
  // ("450,000" is not a valid floating-point number), which used to empty
  // large defaults on first load and on blur. Typed values are left alone;
  // num() already strips commas when reading, so pasted values still work.
  function copyResults(pairs, title) {
    var lines = [title];
    pairs.forEach(function (pair) {
      var el = document.getElementById(pair[1]);
      if (el) lines.push(pair[0] + ': ' + el.textContent);
    });
    var text = lines.join('\n');
    var done = function (ok) {
      set('copy-note', ok ? 'Results copied.' : 'Copy is not available in this browser.');
    };
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        var p = navigator.clipboard.writeText(text);
        if (p && p.then) p.then(function () { done(true); }, function () { done(false); });
        else done(true);
      } else done(false);
    } catch (err) { done(false); }
  }
  var copyBtn = document.getElementById('copy-results');
  if (copyBtn) copyBtn.addEventListener('click', function () {
    copyResults([['Cap rate', 'cap-rate'], ['Net operating income (annual)', 'noi-annual'],
      ['Net operating income (monthly)', 'noi-monthly'], ['Effective gross income', 'effective-income'],
      ['Total operating expenses', 'total-expenses'], ['Value at target cap rate', 'value-at-target']],
      'Cap Rate Calculator');
  });
  var printBtn = document.getElementById('print-results');
  if (printBtn) printBtn.addEventListener('click', function () {
    if (typeof window !== 'undefined' && window.print) window.print();
  });
  run();
})();
