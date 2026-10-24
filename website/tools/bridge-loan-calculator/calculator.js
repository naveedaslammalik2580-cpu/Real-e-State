/* Bridge Loan Calculator: maximum bridge = current value x loan limit -
   existing mortgage. Payments are interest-only; the principal is repaid in
   full when the current home sells. DOM-stub-safe: only querySelector,
   querySelectorAll and getElementById, guarded style/setAttribute/classList,
   one delegated listener on the form. */
(function () {
  var form = document.querySelector('#bridge-loan-form');
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
  function hideRow(id, hide) {
    var el = document.getElementById(id);
    if (el) el.hidden = hide;
  }
  function fmt(n) {
    return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '';
  }
  function usd(n) {
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function valid(v, min, max) {
    return Number.isFinite(v) && v >= min && v <= max;
  }
  var OUTPUTS = ['bridge-amount', 'bridge-monthly', 'available-equity', 'total-interest',
    'origination-fee', 'other-closing-out', 'total-bridge-cost', 'lg-interest', 'lg-fees',
    'down-needed', 'covered-by-bridge', 'cash-needed', 'sale-price', 'mortgage-repaid',
    'bridge-repaid', 'selling-costs', 'cash-after-sale'];
  function run() {
    var value = num('current-value');
    var mortgage = num('current-mortgage');
    var newPrice = num('new-price');
    var downPct = num('down-percent');
    var ltv = num('bridge-ltv');
    var rate = num('bridge-rate');
    var months = num('months-to-sale');
    var origPct = num('origination-rate');
    var closing = num('other-closing');
    var sellPct = num('selling-rate');
    var inputsOk = valid(value, 0, 1e12) && value > 0 && valid(mortgage, 0, 1e12) &&
      valid(newPrice, 0, 1e12) && newPrice > 0 && valid(downPct, 0, 100) &&
      valid(ltv, 0, 100) && valid(rate, 0, 100) && valid(months, 1, 24) &&
      valid(origPct, 0, 100) && valid(closing, 0, 1e12) && valid(sellPct, 0, 100);
    // Empty fields are invalid, not zero.
    var required = ['current-value', 'current-mortgage', 'new-price', 'down-percent',
      'bridge-ltv', 'bridge-rate', 'months-to-sale', 'origination-rate',
      'other-closing', 'selling-rate'];
    for (var ri = 0; ri < required.length; ri++) {
      var rel = document.getElementById(required[ri]);
      if (!rel || rel.value === '') { inputsOk = false; break; }
    }
    var bridge = value * ltv / 100 - mortgage;
    var ok = inputsOk && bridge > 0;
    if (!ok) {
      set('bridge-amount', 'Check inputs');
      OUTPUTS.forEach(function (id) { if (id !== 'bridge-amount') set(id, '—'); });
      set('validation-note', inputsOk
        ? 'No bridge loan is available at these values: your current mortgage already meets or exceeds the maximum loan balance at this loan limit. Raise the limit or lower the mortgage balance to see an amount.'
        : 'Check the values: home values above $0, rates 0–100%, term 1–24 months, amounts 0 or more, and no field left empty.');
      set('sticky-value', '—');
      set('hidden-rows-note', '');
      hideRow('result-body', true); hideRow('result-empty', false);
      setWidth('bar-interest', 0); setWidth('bar-fees', 0);
      return;
    }
    set('validation-note', '');
    hideRow('result-body', false); hideRow('result-empty', true);
    var equity = value - mortgage;
    var monthly = bridge * rate / 100 / 12;
    var interest = monthly * months;
    var origination = bridge * origPct / 100;
    var totalCost = interest + origination + closing;
    var downNeeded = newPrice * downPct / 100;
    var covered = Math.min(downNeeded, bridge);
    var cashNeeded = Math.max(0, downNeeded - bridge);
    var selling = value * sellPct / 100;
    var cashAfter = value - mortgage - bridge - selling;
    set('bridge-amount', usd(bridge));
    set('bridge-monthly', usd(monthly));
    set('available-equity', usd(equity));
    set('total-interest', usd(interest));
    set('origination-fee', usd(origination));
    set('other-closing-out', usd(closing));
    set('total-bridge-cost', usd(totalCost));
    set('lg-interest', usd(interest));
    set('lg-fees', usd(origination + closing));
    var intShare = totalCost > 0 ? interest / totalCost * 100 : 0;
    setWidth('bar-interest', intShare);
    setWidth('bar-fees', totalCost > 0 ? 100 - intShare : 0);
    set('down-needed', usd(downNeeded));
    set('covered-by-bridge', usd(covered));
    set('cash-needed', usd(cashNeeded));
    set('sale-price', usd(value));
    set('mortgage-repaid', usd(mortgage));
    set('bridge-repaid', usd(bridge));
    set('selling-costs', usd(selling));
    set('cash-after-sale', usd(cashAfter));
    set('sticky-value', usd(bridge));
    // Hide $0 rows; everything else stays visible.
    hideRow('row-total-interest', interest === 0);
    hideRow('row-origination-fee', origination === 0);
    hideRow('row-other-closing', closing === 0);
    hideRow('row-cash-needed', cashNeeded === 0);
    hideRow('row-selling-costs', selling === 0);
    var hidden = [];
    if (interest === 0) hidden.push('Total interest');
    if (origination === 0) hidden.push('Origination fee');
    if (closing === 0) hidden.push('Other closing costs');
    if (cashNeeded === 0) hidden.push('Cash still needed');
    if (selling === 0) hidden.push('Selling costs');
    set('hidden-rows-note', hidden.length ? 'Not shown because $0: ' + hidden.join(', ') + '.' : '');
  }
  document.querySelectorAll('#bridge-loan-form input').forEach(function (input) {
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
  // Thousand separators on blur only, so the cursor stays stable while typing.
  document.querySelectorAll('#bridge-loan-form input[type="number"]').forEach(function (input) {
    input.addEventListener('blur', function () {
      var v = Number(String(input.value).replace(/,/g, '').trim());
      if (Number.isFinite(v)) input.value = fmt(v);
    });
    var initial = Number(String(input.value).replace(/,/g, '').trim());
    if (input.value !== '' && Number.isFinite(initial)) input.value = fmt(initial);
  });
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
    copyResults([['Maximum bridge loan', 'bridge-amount'], ['Monthly interest-only payment', 'bridge-monthly'],
      ['Total bridge cost', 'total-bridge-cost'], ['Down payment needed', 'down-needed'],
      ['Cash still needed', 'cash-needed'], ['Cash left after sale', 'cash-after-sale']],
      'Bridge Loan Calculator');
  });
  var printBtn = document.getElementById('print-results');
  if (printBtn) printBtn.addEventListener('click', function () {
    if (typeof window !== 'undefined' && window.print) window.print();
  });
  run();
})();
