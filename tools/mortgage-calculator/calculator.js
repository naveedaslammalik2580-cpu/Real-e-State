// Mortgage calculator — scoped to #mortgage-form only.
// Uses only document.querySelector, querySelectorAll and getElementById so the
// repo's DOM-stub tests can execute it. No shared-script logic lives here.
(function () {
  var form = document.querySelector('#mortgage-form');
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

  var OUTPUTS = ['monthly-payment', 'loan-amount', 'total-interest', 'total-paid',
    'monthly-tax', 'monthly-insurance', 'monthly-hoa', 'monthly-pmi',
    'monthly-total', 'total-cost'];

  function run() {
    var price = num('home-price'), down = num('down-payment'), rate = num('interest-rate'),
      years = num('loan-years'), tax = num('property-tax'), ins = num('home-insurance'),
      hoa = num('hoa-fee'), pmiRate = num('pmi-rate');

    var ok = valid(price, 0, 1e12) && valid(down, 0, price) && valid(rate, 0, 100) &&
      valid(years, 1, 50) && valid(tax, 0, 1e12) && valid(ins, 0, 1e12) &&
      valid(hoa, 0, 1e12) && valid(pmiRate, 0, 100);

    if (!ok) {
      OUTPUTS.forEach(function (id) { set(id, '—'); });
      set('down-percent', '');
      set('mortgage-pmi-note', '');
      set('mortgage-error', 'Check the highlighted values: down payment cannot exceed the price, rate must be 0–100%, and term must be 1–50 years.');
      setWidth('bd-pi', 0); setWidth('bd-tax', 0); setWidth('bd-ins', 0);
      setWidth('bd-hoa', 0); setWidth('bd-pmi', 0);
      setHtml('mortgage-schedule-body', '');
      return;
    }
    set('mortgage-error', '');

    var principal = price - down;
    var months = years * 12;
    var r = rate / 1200;
    var pi = r === 0 ? principal / months
      : principal * r * Math.pow(1 + r, months) / (Math.pow(1 + r, months) - 1);
    if (!Number.isFinite(pi)) pi = 0;

    var taxM = tax / 12, insM = ins / 12, hoaM = hoa;
    var downPct = price > 0 ? (down / price) * 100 : 0;
    var pmiM = downPct < 20 ? principal * pmiRate / 100 / 12 : 0;

    // Yearly amortization + PMI duration (PMI runs only while balance > 80% of price).
    var bal = principal, rows = '', pmiMonths = 0;
    for (var y = 1; y <= years; y++) {
      var intY = 0, prinY = 0;
      for (var m = 0; m < 12; m++) {
        if (bal <= 0) break;
        if (pmiM > 0 && bal > price * 0.8) pmiMonths++;
        var interest = bal * r;
        var prin = pi - interest;
        if (prin > bal) prin = bal;
        intY += interest; prinY += prin; bal -= prin;
        if (bal < 0.005) bal = 0;
      }
      rows += '<tr><td>' + y + '</td><td>' + usd(intY) + '</td><td>' + usd(prinY) + '</td><td>' + usd(bal) + '</td></tr>';
    }

    var total = pi + taxM + insM + hoaM + pmiM;
    var totalCost = pi * months + tax * years + ins * years + hoa * months + pmiM * pmiMonths;

    set('monthly-payment', usd(pi));
    set('loan-amount', usd(principal));
    set('total-interest', usd(pi * months - principal));
    set('total-paid', usd(pi * months));
    set('monthly-tax', usd(taxM));
    set('monthly-insurance', usd(insM));
    set('monthly-hoa', usd(hoaM));
    set('monthly-pmi', usd(pmiM));
    set('monthly-total', usd(total));
    set('total-cost', usd(totalCost));
    set('down-percent', price > 0 ? downPct.toFixed(1) + '% of price' : '');
    set('mortgage-pmi-note', pmiM > 0
      ? 'PMI applies for about ' + pmiMonths + ' months, until the balance drops to 80% of the price.'
      : 'No PMI — the down payment is 20% or more of the price.');

    if (total > 0) {
      setWidth('bd-pi', (pi / total) * 100);
      setWidth('bd-tax', (taxM / total) * 100);
      setWidth('bd-ins', (insM / total) * 100);
      setWidth('bd-hoa', (hoaM / total) * 100);
      setWidth('bd-pmi', (pmiM / total) * 100);
    } else {
      setWidth('bd-pi', 0); setWidth('bd-tax', 0); setWidth('bd-ins', 0);
      setWidth('bd-hoa', 0); setWidth('bd-pmi', 0);
    }
    setHtml('mortgage-schedule-body', rows);
  }

  document.querySelectorAll('#mortgage-form input').forEach(function (input) {
    input.addEventListener('input', run);
  });
  run();
})();
