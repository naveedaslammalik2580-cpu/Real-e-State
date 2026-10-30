// Home affordability calculator — scoped to #home-affordability-form only.
// Uses only document.querySelector, querySelectorAll and getElementById so the
// repo's DOM-stub tests can execute it. No shared-script logic lives here.
//
// Model: the user states the monthly housing payment they can afford. The
// maximum price is solved directly from that budget — no DTI rule is part of
// the engine, so the same math works in any country. Because property tax (a %
// of price) and PMI (a % of the loan while down < 20%) both scale with the
// price, the solve is piecewise:
//   no-PMI case (price <= 5 x down): price = (budget - ins - hoa + f*down) / (f + t)
//   PMI case    (price >  5 x down): price = (budget - ins - hoa + (f+p)*down) / (f + t + p)
// where f is the monthly payment factor, t the monthly tax rate and p the
// monthly PMI rate.
//
// Optional guideline (the "guide-" fields, outside the main form): for users
// who don't know their budget, the familiar front/back DTI guideline converts
// income and debts into a suggested budget, which the button copies into the
// main budget input. The guideline is advisory only; the budget input rules.
(function () {
  var form = document.querySelector('#home-affordability-form');
  if (!form) return;
  form.addEventListener('submit', function (event) { event.preventDefault(); });

  function usd(n) {
    return Number.isFinite(n)
      ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(n)
      : '—';
  }
  function num(id) {
    var el = document.getElementById(id);
    return el ? Number(String(el.value).replace(/,/g, '').trim()) : 0;
  }
  function set(id, s) {
    var el = document.getElementById(id);
    if (el) el.textContent = s;
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
  function valid(n, a, b) {
    return Number.isFinite(n) && n >= a && n <= b;
  }
  function factor(r, n) {
    return r === 0 ? 1 / n : r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
  }

  var OUTPUTS = ['afford-loan', 'afford-monthly', 'cash-to-close'];

  // Solve the maximum price for one monthly housing budget.
  function solvePrice(budget, p) {
    var f = p.f, t = p.t, pm = p.pm, insM = p.insM, hoa = p.hoa, down = p.down;
    var priceA = (budget - insM - hoa + f * down) / (f + t);
    if (down > 0 && priceA <= 5 * down && priceA >= down) return priceA;
    var priceB = (budget - insM - hoa + (f + pm) * down) / (f + t + pm);
    if (!Number.isFinite(priceB) || priceB < down) return down;
    return priceB;
  }

  function run() {
    var budget = num('monthly-budget'), down = num('down-payment'),
      rate = num('interest-rate'), years = num('loan-years'),
      taxRate = num('property-tax-rate'), ins = num('home-insurance'),
      hoa = num('hoa-fee'), pmiRate = num('pmi-rate'),
      closing = num('closing-costs');

    // Named validation: every problem is named; the hero shows the first,
    // the note under the form lists them all. Empty fields are invalid, not zero.
    var problems = [];
    function checkField(id, name, lo, hi, rangeText) {
      var el = document.getElementById(id);
      if (!el || el.value === '') { problems.push(name + ' is empty.'); return; }
      if (!valid(num(id), lo, hi)) problems.push(name + ' ' + rangeText);
    }
    checkField('monthly-budget', 'Monthly housing payment you can afford', 0, 1e12, 'must be 0 or more.');
    checkField('down-payment', 'Down payment', 0, 1e12, 'must be 0 or more.');
    checkField('interest-rate', 'Annual interest rate', 0, 100, 'must be between 0% and 100%.');
    checkField('loan-years', 'Loan term', 1, 50, 'must be between 1 and 50 years.');
    checkField('property-tax-rate', 'Property tax rate', 0, 100, 'must be between 0% and 100%.');
    checkField('home-insurance', 'Home insurance', 0, 1e12, 'must be 0 or more.');
    checkField('hoa-fee', 'HOA dues', 0, 1e12, 'must be 0 or more.');
    checkField('pmi-rate', 'PMI rate', 0, 100, 'must be between 0% and 100%.');
    checkField('closing-costs', 'Closing costs', 0, 100, 'must be between 0% and 100%.');

    if (problems.length) {
      set('afford-price', problems[0]);
      OUTPUTS.forEach(function (id) { set(id, '—'); });
      set('down-percent', '');
      set('validation-note', problems.join(' '));
      set('lg-pi', '—'); set('lg-tax', '—'); set('lg-ins', '—'); set('lg-hoa', '—'); set('lg-pmi', '—');
      set('sticky-value', '—');
      hideRow('result-body', true); hideRow('result-empty', false);
      setWidth('bd-pi', 0); setWidth('bd-tax', 0); setWidth('bd-ins', 0);
      setWidth('bd-hoa', 0); setWidth('bd-pmi', 0);
      return;
    }
    set('validation-note', '');
    hideRow('result-body', false); hideRow('result-empty', true);

    var p = { f: factor(rate / 1200, years * 12), t: taxRate / 1200,
      pm: pmiRate / 1200, insM: ins / 12, hoa: hoa, down: down };

    var price = solvePrice(budget, p);
    var loan = price - down;
    var pi = loan * p.f;
    var taxM = price * p.t;
    var pmiM = (down < 0.2 * price && loan > 0) ? loan * p.pm : 0;
    var housing = pi + taxM + p.insM + hoa + pmiM;

    set('afford-price', usd(price));
    set('afford-loan', usd(loan));
    set('afford-monthly', usd(housing));
    set('cash-to-close', usd(down + price * closing / 100));
    set('down-percent', price > 0 ? (down / price * 100).toFixed(1) + '% of max price' : '');

    // Shared restyle behaviors: legend amounts, $0-row hiding, sticky value.
    set('lg-pi', usd(pi)); set('lg-tax', usd(taxM)); set('lg-ins', usd(p.insM));
    set('lg-hoa', usd(hoa)); set('lg-pmi', usd(pmiM));
    set('sticky-value', usd(price));
    syncDownPct();

    if (housing > 0) {
      setWidth('bd-pi', (pi / housing) * 100);
      setWidth('bd-tax', (taxM / housing) * 100);
      setWidth('bd-ins', (p.insM / housing) * 100);
      setWidth('bd-hoa', (hoa / housing) * 100);
      setWidth('bd-pmi', (pmiM / housing) * 100);
    } else {
      setWidth('bd-pi', 0); setWidth('bd-tax', 0); setWidth('bd-ins', 0);
      setWidth('bd-hoa', 0); setWidth('bd-pmi', 0);
    }
  }

  // Optional guideline: income + debts + two guideline percentages suggest a
  // budget. The button copies it into the main budget input; the input rules.
  function useGuideline() {
    var income = num('guide-income'), debts = num('guide-debts'),
      front = num('guide-front'), back = num('guide-back');
    if (!valid(income, 0, 1e12) || !valid(debts, 0, 1e12) ||
      !valid(front, 0, 100) || !valid(back, 0, 100)) {
      set('guide-note', 'Check the income, debts and guideline values.');
      return;
    }
    var monthly = income / 12;
    var frontCap = monthly * front / 100;
    var backCap = monthly * back / 100 - debts;
    var budget = Math.min(frontCap, backCap);
    if (!(budget > 0)) {
      set('guide-note', 'Your debts already exceed the back-end guideline — no guideline budget.');
      return;
    }
    var budgetEl = document.getElementById('monthly-budget');
    if (budgetEl) budgetEl.value = budget.toFixed(2);
    set('guide-note', 'Guideline budget ' + usd(budget) + ' — limited by ' +
      (frontCap <= backCap
        ? 'housing costs (' + front + '% of income)'
        : 'total debts (' + back + '% of income minus debts)') +
      '. Copied into your monthly budget above.');
    run();
  }

  document.querySelectorAll('#home-affordability-form input').forEach(function (input) {
    input.addEventListener('input', run);
  });
  var guideBtn = document.getElementById('guide-budget-btn');
  if (guideBtn) guideBtn.addEventListener('click', useGuideline);
  // Down payment $ and % stay in sync; the % field never overwrites itself
  // while the user is typing in it. Here the % is of the computed max price.
  function syncDownPct() {
    var pctEl = document.getElementById('down-percent-input');
    if (!pctEl) return;
    if (typeof document !== 'undefined' && document.activeElement === pctEl) return;
    var downEl = document.getElementById('down-payment');
    var priceEl = document.getElementById('afford-price');
    if (!downEl || !priceEl) return;
    var down = Number(String(downEl.value).replace(/,/g, ''));
    var price = Number(String(priceEl.textContent).replace(/[^0-9.]/g, ''));
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
      var downEl = document.getElementById('down-payment');
      var priceEl = document.getElementById('afford-price');
      if (downEl && priceEl) {
        var price = Number(String(priceEl.textContent).replace(/[^0-9.]/g, ''));
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
    copyResults([['Maximum price', 'afford-price'], ['Maximum loan', 'afford-loan'],
      ['Monthly payment', 'afford-monthly'], ['Cash to close', 'cash-to-close']],
      'Home Affordability Calculator');
  });
  var printBtn = document.getElementById('print-results');
  if (printBtn) printBtn.addEventListener('click', function () {
    if (typeof window !== 'undefined' && window.print) window.print();
  });
  run();
})();
