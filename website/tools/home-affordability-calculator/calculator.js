// Home affordability calculator — scoped to #home-affordability-form only.
// Uses only document.querySelector, querySelectorAll and getElementById so the
// repo's DOM-stub tests can execute it. No shared-script logic lives here.
//
// Method (the 28/36 rule lenders start from): the front-end cap limits monthly
// housing costs to front% of gross monthly income; the back-end cap limits
// housing plus other debts to back%. The lower cap binds. Because property tax
// (a % of price) and PMI (a % of the loan while down < 20%) both scale with the
// price, the maximum price is solved directly, not guessed:
//   no-PMI case (price <= 5 x down): price = (cap - ins - hoa + f*down) / (f + t)
//   PMI case    (price >  5 x down): price = (cap - ins - hoa + (f+p)*down) / (f + t + p)
// where f is the monthly payment factor, t the monthly tax rate and p the
// monthly PMI rate.
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
  function setHtml(id, html) {
    var el = document.getElementById(id);
    if (el) el.innerHTML = html;
  }
  function valid(n, a, b) {
    return Number.isFinite(n) && n >= a && n <= b;
  }
  function factor(r, n) {
    return r === 0 ? 1 / n : r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
  }

  var OUTPUTS = ['afford-loan', 'afford-monthly', 'afford-pi', 'afford-tax',
    'afford-insurance', 'afford-hoa', 'afford-pmi', 'front-cap', 'back-cap',
    'binding-cap', 'afford-ltv', 'cash-to-close'];

  // Solve the maximum price for one monthly housing budget.
  function solvePrice(cap, p) {
    var f = p.f, t = p.t, pm = p.pm, insM = p.insM, hoa = p.hoa, down = p.down;
    var priceA = (cap - insM - hoa + f * down) / (f + t);
    if (down > 0 && priceA <= 5 * down && priceA >= down) return priceA;
    var priceB = (cap - insM - hoa + (f + pm) * down) / (f + t + pm);
    if (!Number.isFinite(priceB) || priceB < down) return down;
    return priceB;
  }

  function run() {
    var income = num('annual-income'), debts = num('monthly-debts'),
      down = num('down-payment'), rate = num('interest-rate'),
      years = num('loan-years'), taxRate = num('property-tax-rate'),
      ins = num('home-insurance'), hoa = num('hoa-fee'),
      pmiRate = num('pmi-rate'), front = num('front-dti'),
      back = num('back-dti'), closing = num('closing-costs');

    var ok = valid(income, 0, 1e12) && valid(debts, 0, 1e12) &&
      valid(down, 0, 1e12) && valid(rate, 0, 100) && valid(years, 1, 50) &&
      valid(taxRate, 0, 100) && valid(ins, 0, 1e12) && valid(hoa, 0, 1e12) &&
      valid(pmiRate, 0, 100) && valid(front, 0, 100) && valid(back, 0, 100) &&
      valid(closing, 0, 100);

    if (!ok) {
      set('afford-price', 'Check inputs');
      OUTPUTS.forEach(function (id) { set(id, '—'); });
      set('down-percent', '');
      setHtml('scenario-body', '');
      setWidth('bd-pi', 0); setWidth('bd-tax', 0); setWidth('bd-ins', 0);
      setWidth('bd-hoa', 0); setWidth('bd-pmi', 0);
      return;
    }

    var monthly = income / 12;
    var frontCap = monthly * front / 100;
    var backCap = monthly * back / 100 - debts;
    var allowed = Math.min(frontCap, backCap);
    var bindingFront = frontCap <= backCap;
    var p = { f: factor(rate / 1200, years * 12), t: taxRate / 1200,
      pm: pmiRate / 1200, insM: ins / 12, hoa: hoa, down: down };

    var price = solvePrice(allowed, p);
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
    set('front-cap', usd(frontCap));
    set('back-cap', usd(backCap));
    set('binding-cap', bindingFront
      ? 'Front-end cap binds (' + front + '% of income)'
      : 'Back-end cap binds (' + back + '% of income minus debts)');
    set('afford-ltv', price > 0 ? (loan / price * 100).toFixed(1) + '%' : '—');
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

    // Side-by-side DTI scenarios at the same income, debts and loan terms.
    var presets = [
      ['Conservative', 28, 36],
      ['Moderate', 31, 43],
      ['Aggressive', 36, 50]
    ];
    var rows = '';
    presets.forEach(function (preset) {
      var cap = Math.min(monthly * preset[1] / 100, monthly * preset[2] / 100 - debts);
      var scenarioPrice = solvePrice(cap, p);
      var cls = (preset[1] === front && preset[2] === back) ? ' class="afford-current-scenario"' : '';
      rows += '<tr' + cls + '><td>' + preset[0] + '</td><td>' + preset[1] + '% / ' + preset[2] + '%</td><td>' + usd(scenarioPrice) + '</td></tr>';
    });
    setHtml('scenario-body', rows);
  }

  function makePreset(front, back) {
    return function () {
      var fEl = document.getElementById('front-dti');
      var bEl = document.getElementById('back-dti');
      if (fEl) fEl.value = String(front);
      if (bEl) bEl.value = String(back);
      run();
    };
  }

  document.querySelectorAll('#home-affordability-form input').forEach(function (input) {
    input.addEventListener('input', run);
  });
  var presets = [
    ['preset-conservative', 28, 36],
    ['preset-moderate', 31, 43],
    ['preset-aggressive', 36, 50]
  ];
  presets.forEach(function (item) {
    var btn = document.getElementById(item[0]);
    if (btn) btn.addEventListener('click', makePreset(item[1], item[2]));
  });
  run();
})();
