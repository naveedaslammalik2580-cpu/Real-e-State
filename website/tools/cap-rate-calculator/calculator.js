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
  var OUTPUTS = ['cap-rate', 'noi-annual', 'gross-rent', 'vacancy-loss', 'other-income-out',
    'effective-income', 'tax-out', 'insurance-out', 'maintenance-out', 'management-out',
    'hoa-other-out', 'total-expenses', 'noi-monthly', 'grm', 'expense-ratio',
    'cap-low', 'cap-base', 'cap-high', 'value-at-target', 'lg-noi', 'lg-expenses'];
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
      set('cap-rate', 'Check inputs');
      OUTPUTS.forEach(function (id) { if (id !== 'cap-rate') set(id, '—'); });
      set('validation-note', 'Check the values: price above $0, rates 0–100%, target cap rate above 0%, amounts 0 or more, and no field left empty.');
      set('sticky-value', '—');
      set('hidden-rows-note', '');
      hideRow('result-body', true); hideRow('result-empty', false);
      setWidth('bar-noi', 0); setWidth('bar-expenses', 0);
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
    set('gross-rent', usd(gross));
    set('vacancy-loss', usd(vacancyLoss));
    set('other-income-out', usd(other));
    set('effective-income', usd(effective));
    set('tax-out', usd(tax));
    set('insurance-out', usd(ins));
    set('maintenance-out', usd(maint));
    set('management-out', usd(mgmt));
    set('hoa-other-out', usd(hoa));
    set('total-expenses', usd(expenses));
    set('noi-monthly', usd(noi / 12));
    set('grm', gross > 0 ? (price / gross).toFixed(2) + 'x' : '—');
    set('expense-ratio', effective > 0 ? pct(expenses / effective * 100) : '—');
    set('cap-low', pct(noi / (price * 0.9) * 100));
    set('cap-base', pct(cap));
    set('cap-high', pct(noi / (price * 1.1) * 100));
    set('value-at-target', noi > 0 ? usd(noi / (target / 100)) : '—');
    set('lg-noi', usd(noi));
    set('lg-expenses', usd(expenses));
    var noiShare = effective > 0 ? Math.max(0, Math.min(100, noi / effective * 100)) : 0;
    setWidth('bar-noi', noiShare);
    setWidth('bar-expenses', effective > 0 ? 100 - noiShare : 0);
    set('sticky-value', pct(cap));
    // Hide $0 rows; everything else stays visible.
    hideRow('row-other-income', other === 0);
    hideRow('row-hoa-other', hoa === 0);
    var hidden = [];
    if (other === 0) hidden.push('Other income');
    if (hoa === 0) hidden.push('HOA & other costs');
    set('hidden-rows-note', hidden.length ? 'Not shown because $0: ' + hidden.join(', ') + '.' : '');
  }
  document.querySelectorAll('#cap-rate-form input').forEach(function (input) {
    input.addEventListener('input', run);
  });
  // Slider sync by delegation on the form (keeps per-input listeners intact).
  form.addEventListener('input', function (e) {
    var t = e && e.target;
    if (!t || !t.id) return;
    if (t.type === 'range') {
      var numEl = document.getElementById(t.id.replace(/-slider$/, ''));
      if (numEl) numEl.value = t.value;
      run();
    } else if (t.type === 'number') {
      var slider = document.getElementById(t.id + '-slider');
      if (slider) {
        var v = Number(String(t.value).replace(/,/g, ''));
        if (Number.isFinite(v)) {
          var mn = Number(slider.min), mx = Number(slider.max);
          if (Number.isFinite(mn) && v < mn) v = mn;
          if (Number.isFinite(mx) && v > mx) v = mx;
          slider.value = String(v);
        }
      }
    }
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
      set('copy-note', ok ? 'Results copied.' : 'Copy is not available in this browser — use Print instead.');
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
