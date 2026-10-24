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

  function usd(n) {
    return Number.isFinite(n)
      ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(n)
      : '—';
  }
  function num(id) {
    var el = document.getElementById(id);
    return el ? Number(el.value) : 0;
  }
  function set(id, s) {
    var el = document.getElementById(id);
    if (el) el.textContent = s;
  }
  function setWidth(id, pct) {
    var el = document.getElementById(id);
    if (el && el.style) el.style.width = pct + '%';
  }
  function valid(n, a, b) {
    return Number.isFinite(n) && n >= a && n <= b;
  }
  function factor(r, n) {
    return r === 0 ? 1 / n : r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
  }

  var OUTPUTS = ['afford-loan', 'afford-monthly', 'afford-pi', 'afford-tax',
    'afford-insurance', 'afford-hoa', 'afford-pmi', 'cash-to-close'];

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

    var ok = valid(budget, 0, 1e12) && valid(down, 0, 1e12) &&
      valid(rate, 0, 100) && valid(years, 1, 50) &&
      valid(taxRate, 0, 100) && valid(ins, 0, 1e12) && valid(hoa, 0, 1e12) &&
      valid(pmiRate, 0, 100) && valid(closing, 0, 100);

    if (!ok) {
      set('afford-price', 'Check inputs');
      OUTPUTS.forEach(function (id) { set(id, '—'); });
      set('down-percent', '');
      setWidth('bd-pi', 0); setWidth('bd-tax', 0); setWidth('bd-ins', 0);
      setWidth('bd-hoa', 0); setWidth('bd-pmi', 0);
      return;
    }

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
    set('afford-pi', usd(pi));
    set('afford-tax', usd(taxM));
    set('afford-insurance', usd(p.insM));
    set('afford-hoa', usd(hoa));
    set('afford-pmi', usd(pmiM));
    set('cash-to-close', usd(down + price * closing / 100));
    set('down-percent', price > 0 ? (down / price * 100).toFixed(1) + '% of max price' : '');

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
  run();
})();
