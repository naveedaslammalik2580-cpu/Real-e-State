/* Property Investment Calculator: monthly cash flow, cash-on-cash return,
   cap rate, DSCR and break-even rent for a rental property. NOI excludes the
   mortgage; the mortgage is counted separately as debt service. Cash-on-cash
   divides by all cash invested (down payment + closing costs). DOM-stub-safe:
   only querySelector, querySelectorAll and getElementById, guarded style and
   setAttribute, one delegated listener on the form. */
(function () {
  var form = document.querySelector('#property-investment-form');
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
  function negUsd(n) {
    return n < 0 ? '−' + usd(-n) : usd(n);
  }
  function pct(n) {
    return (n < 0 ? '−' : '') + Math.abs(n).toFixed(2) + '%';
  }
  function valid(v, min, max) {
    return Number.isFinite(v) && v >= min && v <= max;
  }
  var OUTPUTS = ['monthly-cash-flow', 'annual-cash-flow', 'tile-coc', 'tile-cap',
    'tile-dscr', 'tile-noi', 'tile-breakeven', 'tile-invested', 'row-rent',
    'row-vacancy-loss', 'row-other-income', 'row-effective', 'row-pi', 'row-tax',
    'row-insurance', 'row-hoa-out', 'row-maintenance', 'row-capex', 'row-management',
    'row-cash-flow', 'lg-vacancy', 'lg-pi', 'lg-opex', 'lg-cf', 'row-gross-yield',
    'row-rent-ratio'];
  var LABELS = { 'property-price': 'Purchase price', 'down-payment': 'Down payment (USD)',
    'down-percent-input': 'Down payment (%)', 'interest-rate': 'Mortgage rate',
    'loan-years': 'Loan term', 'monthly-rent': 'Monthly rent', 'vacancy-rate': 'Vacancy rate',
    'other-income': 'Other income', 'property-tax': 'Property tax', 'home-insurance': 'Insurance',
    'hoa-fee': 'HOA dues', 'maintenance-rate': 'Maintenance', 'capex-rate': 'CapEx reserve',
    'management-rate': 'Management fee', 'closing-costs': 'Closing costs' };
  // Fill an empty down payment from the other down-payment field, so clearing
  // one value to retype it never blocks the whole result. Never overwrites a
  // value the user typed, and never refills the field they are typing in.
  function deriveDown() {
    var priceEl = document.getElementById('property-price');
    var downEl = document.getElementById('down-payment');
    var pctEl = document.getElementById('down-percent-input');
    if (!priceEl || !downEl || !pctEl) return;
    var price = Number(String(priceEl.value).replace(/,/g, ''));
    if (!Number.isFinite(price) || price <= 0) return;
    var active = (typeof document !== 'undefined') ? document.activeElement : null;
    if (downEl.value === '' && pctEl.value !== '' && active !== downEl) {
      var pct = Number(String(pctEl.value).replace(/,/g, ''));
      if (Number.isFinite(pct)) downEl.value = String(Math.round(pct / 100 * price));
    } else if (pctEl.value === '' && downEl.value !== '' && active !== pctEl) {
      var down = Number(String(downEl.value).replace(/,/g, ''));
      if (Number.isFinite(down)) pctEl.value = (down / price * 100).toFixed(1);
    }
  }
  function run() {
    deriveDown();
    var price = num('property-price');
    var down = num('down-payment');
    var rate = num('interest-rate');
    var years = num('loan-years');
    var rent = num('monthly-rent');
    var vacancy = num('vacancy-rate');
    var other = num('other-income');
    var tax = num('property-tax');
    var ins = num('home-insurance');
    var hoa = num('hoa-fee');
    var maintPct = num('maintenance-rate');
    var capexPct = num('capex-rate');
    var mgmtPct = num('management-rate');
    var closing = num('closing-costs');
    var ok = valid(price, 0, 1e12) && price > 0 && valid(down, 0, price) &&
      valid(rate, 0, 100) && valid(years, 1, 50) && valid(rent, 0, 1e12) &&
      valid(vacancy, 0, 100) && valid(other, 0, 1e12) && valid(tax, 0, 1e12) &&
      valid(ins, 0, 1e12) && valid(hoa, 0, 1e12) && valid(maintPct, 0, 100) &&
      valid(capexPct, 0, 100) && valid(mgmtPct, 0, 100) && valid(closing, 0, 1e12);
    // Empty fields are invalid, not zero.
    var required = ['property-price', 'down-payment', 'down-percent-input', 'interest-rate',
      'loan-years', 'monthly-rent', 'vacancy-rate', 'other-income', 'property-tax',
      'home-insurance', 'hoa-fee', 'maintenance-rate', 'capex-rate', 'management-rate',
      'closing-costs'];
    for (var ri = 0; ri < required.length; ri++) {
      var rel = document.getElementById(required[ri]);
      if (!rel || rel.value === '') { ok = false; break; }
    }
    if (!ok) {
      set('monthly-cash-flow', 'Check inputs');
      OUTPUTS.forEach(function (id) { if (id !== 'monthly-cash-flow') set(id, '—'); });
      // Name exactly what is wrong, so the panel itself explains the refusal
      // instead of leaving the reason below the form.
      var problems = [];
      var checks = [
        ['property-price', price], ['down-payment', down],
        ['down-percent-input', num('down-percent-input')], ['interest-rate', rate],
        ['loan-years', years], ['monthly-rent', rent], ['vacancy-rate', vacancy],
        ['other-income', other], ['property-tax', tax], ['home-insurance', ins],
        ['hoa-fee', hoa], ['maintenance-rate', maintPct], ['capex-rate', capexPct],
        ['management-rate', mgmtPct], ['closing-costs', closing]
      ];
      checks.forEach(function (c) {
        var el = document.getElementById(c[0]);
        if (!el || el.value === '') { problems.push(LABELS[c[0]] + ' is empty.'); return; }
        if (c[0] === 'property-price' && !(c[1] > 0 && c[1] <= 1e12)) { problems.push('Purchase price must be above $0.'); return; }
        if (c[0] === 'down-payment') {
          if (price > 0 && c[1] > price) problems.push('Down payment (USD) exceeds the purchase price.');
          else if (price > 0 && c[1] < 0) problems.push('Down payment (USD) is out of range.');
          return;
        }
        var lo = (c[0] === 'loan-years') ? 1 : 0;
        var hi = (c[0] === 'interest-rate' || c[0] === 'vacancy-rate' || c[0] === 'maintenance-rate' || c[0] === 'capex-rate' || c[0] === 'management-rate' || c[0] === 'down-percent-input') ? 100 : (c[0] === 'loan-years' ? 50 : 1e12);
        if (!(c[1] >= lo && c[1] <= hi)) problems.push(LABELS[c[0]] + ' is out of range.');
      });
      var message = problems.length ? problems.join(' ') : 'Check the values: price above $0, down payment within the price, rates 0–100%, term 1–50 years, amounts 0 or more, and no field left empty.';
      set('validation-note', message);
      set('inv-validation', message);
      set('sticky-value', '—');
      set('hidden-rows-note', '');
      hideRow('result-body', true); hideRow('result-empty', false);
      setWidth('bar-vacancy', 0); setWidth('bar-pi', 0); setWidth('bar-opex', 0); setWidth('bar-cf', 0);
      return;
    }
    set('validation-note', '');
    set('inv-validation', '');
    hideRow('result-body', false); hideRow('result-empty', true);
    var loan = price - down;
    var r = rate / 100 / 12;
    var n = years * 12;
    var pi = r === 0 ? loan / n : loan * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
    var vacancyLoss = rent * vacancy / 100;
    var effective = rent - vacancyLoss + other;
    var taxM = tax / 12;
    var insM = ins / 12;
    var maint = rent * maintPct / 100;
    var capex = rent * capexPct / 100;
    var mgmt = effective * mgmtPct / 100;
    var opex = taxM + insM + hoa + maint + capex + mgmt;
    var cf = effective - pi - opex;
    var noi = (effective - opex) * 12;
    var debtService = pi * 12;
    var invested = down + closing;
    var cap = noi / price * 100;
    var coc = invested > 0 ? cf * 12 / invested * 100 : null;
    var dscr = debtService > 0 ? noi / debtService : null;
    // Break-even rent: the rent R where cash flow is zero, solving
    // R*(1-vac) + other - fixed - R*(maint%+capex%) - mgmt%*(R*(1-vac)+other) = 0.
    var a = 1 - vacancy / 100;
    var k = (maintPct + capexPct) / 100;
    var m = mgmtPct / 100;
    var fixed = pi + taxM + insM + hoa;
    var denom = a - k - m * a;
    var breakeven = denom > 0 ? (fixed - other * (1 - m)) / denom : null;
    if (breakeven !== null && breakeven <= 0) breakeven = null;
    set('monthly-cash-flow', negUsd(cf));
    set('annual-cash-flow', negUsd(cf * 12));
    set('tile-coc', coc === null ? '—' : pct(coc));
    set('tile-cap', pct(cap));
    set('tile-dscr', dscr === null ? '—' : dscr.toFixed(2) + 'x');
    set('tile-noi', usd(noi));
    set('tile-breakeven', breakeven === null ? '—' : usd(breakeven));
    set('tile-invested', usd(invested));
    set('row-rent', usd(rent));
    set('row-vacancy-loss', vacancyLoss === 0 ? usd(0) : '−' + usd(vacancyLoss));
    set('row-other-income', usd(other));
    set('row-effective', usd(effective));
    set('row-pi', usd(pi));
    set('row-tax', usd(taxM));
    set('row-insurance', usd(insM));
    set('row-hoa-out', usd(hoa));
    set('row-maintenance', usd(maint));
    set('row-capex', usd(capex));
    set('row-management', usd(mgmt));
    set('row-cash-flow', negUsd(cf));
    set('row-gross-yield', pct(rent * 12 / price * 100));
    set('row-rent-ratio', pct(rent / price * 100));
    set('lg-vacancy', usd(vacancyLoss));
    set('lg-pi', usd(pi));
    set('lg-opex', usd(opex));
    set('lg-cf', negUsd(cf));
    var share = function (v) {
      if (rent <= 0) return 0;
      return Math.max(0, Math.min(100, v / rent * 100));
    };
    setWidth('bar-vacancy', share(vacancyLoss));
    setWidth('bar-pi', share(pi));
    setWidth('bar-opex', share(opex));
    setWidth('bar-cf', share(cf));
    set('sticky-value', negUsd(cf));
    // Hide $0 rows; everything else stays visible.
    hideRow('row-vacancy', vacancyLoss === 0);
    hideRow('row-other', other === 0);
    hideRow('row-hoa', hoa === 0);
    var hidden = [];
    if (vacancyLoss === 0) hidden.push('Vacancy loss');
    if (other === 0) hidden.push('Other income');
    if (hoa === 0) hidden.push('HOA dues');
    set('hidden-rows-note', hidden.length ? 'Not shown because $0: ' + hidden.join(', ') + '.' : '');
    syncDownPct();
  }
  document.querySelectorAll('#property-investment-form input').forEach(function (input) {
    input.addEventListener('input', run);
  });
  // Down payment $ and % stay in sync; the % field never overwrites itself
  // while the user is typing in it.
  function syncDownPct() {
    var pctEl = document.getElementById('down-percent-input');
    if (!pctEl) return;
    if (typeof document !== 'undefined' && document.activeElement === pctEl) return;
    var priceEl = document.getElementById('property-price');
    var downEl = document.getElementById('down-payment');
    if (!priceEl || !downEl) return;
    var price = Number(String(priceEl.value).replace(/,/g, ''));
    var down = Number(String(downEl.value).replace(/,/g, ''));
    if (Number.isFinite(price) && price > 0 && Number.isFinite(down)) {
      pctEl.value = (down / price * 100).toFixed(1);
    }
  }
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
  form.addEventListener('change', function (e) {
    var t = e && e.target;
    if (t && t.id === 'down-percent-input') {
      var priceEl = document.getElementById('property-price');
      var downEl = document.getElementById('down-payment');
      if (priceEl && downEl) {
        var price = Number(String(priceEl.value).replace(/,/g, ''));
        var pct = Number(String(t.value).replace(/,/g, ''));
        if (Number.isFinite(price) && price > 0 && Number.isFinite(pct)) {
          downEl.value = String(Math.round(pct / 100 * price));
        }
      }
      run();
    }
  });
  // Segmented loan term: buttons set the hidden loan-years value.
  document.querySelectorAll('.seg-control button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var yearsEl = document.getElementById('loan-years');
      if (yearsEl) yearsEl.value = btn.getAttribute ? btn.getAttribute('data-years') : '';
      document.querySelectorAll('.seg-control button').forEach(function (b) {
        setAttr(b, 'aria-pressed', b === btn ? 'true' : 'false');
      });
      run();
    });
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
    copyResults([['Monthly cash flow', 'monthly-cash-flow'], ['Annual cash flow', 'annual-cash-flow'],
      ['Cash-on-cash return', 'tile-coc'], ['Cap rate', 'tile-cap'],
      ['Annual NOI', 'tile-noi'], ['DSCR', 'tile-dscr'], ['Break-even rent', 'tile-breakeven']],
      'Property Investment Calculator');
  });
  var printBtn = document.getElementById('print-results');
  if (printBtn) printBtn.addEventListener('click', function () {
    if (typeof window !== 'undefined' && window.print) window.print();
  });
  run();
})();
