// Mortgage calculator v2 — scoped to #mortgage-form only.
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
  function setPressed(id, on) {
    var el = document.getElementById(id);
    if (el && el.setAttribute) el.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  function valid(n, a, b) {
    return Number.isFinite(n) && n >= a && n <= b;
  }
  function fmtMonthYear(d) {
    var months = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
      'August', 'September', 'October', 'November', 'December'];
    return months[d.getMonth()] + ' ' + d.getFullYear();
  }
  function payoffDate(months) {
    var d = new Date();
    d.setMonth(d.getMonth() + months);
    return fmtMonthYear(d);
  }
  function timeSavedText(diff) {
    if (diff <= 0) return 'No time saved';
    var y = Math.floor(diff / 12), m = diff % 12, parts = [];
    if (y) parts.push(y + (y === 1 ? ' year' : ' years'));
    if (m) parts.push(m + (m === 1 ? ' month' : ' months'));
    return parts.join(' ') + ' sooner';
  }

  var OUTPUTS = ['monthly-payment', 'loan-amount', 'total-interest', 'total-paid',
    'monthly-tax', 'monthly-insurance', 'monthly-hoa', 'monthly-pmi',
    'monthly-total', 'total-cost', 'payoff-date', 'interest-with-extras',
    'interest-saved', 'time-saved'];

  var view = 'yearly';
  var monthlyData = [];
  var yearlyRows = '';

  function amortize(principal, r, pi, extra, lump, price, pmiM) {
    var bal = principal, months = 0, totalInterest = 0, pmiMonths = 0;
    var yearly = [], monthly = [];
    var intY = 0, prinY = 0, year = 1;
    while (bal > 0 && months < 1200) {
      if (pmiM > 0 && bal > price * 0.8) pmiMonths++;
      var interest = bal * r;
      var prin = pi + extra - interest;
      if (months === 0) prin += lump;
      if (prin > bal) prin = bal;
      if (prin < 0) prin = 0;
      intY += interest; prinY += prin; bal -= prin;
      if (bal < 0.005) bal = 0;
      totalInterest += interest;
      months++;
      monthly.push([months, interest, prin, bal]);
      if (months % 12 === 0 || bal === 0) {
        yearly.push([year, intY, prinY, bal]);
        year++; intY = 0; prinY = 0;
      }
    }
    return { months: months, totalInterest: totalInterest, pmiMonths: pmiMonths,
      yearly: yearly, monthly: monthly };
  }

  function renderSchedule() {
    if (view === 'monthly') {
      var rows = '';
      for (var i = 0; i < monthlyData.length; i++) {
        var m = monthlyData[i];
        rows += '<tr><td>' + m[0] + '</td><td>' + usd(m[1]) + '</td><td>' + usd(m[2]) + '</td><td>' + usd(m[3]) + '</td></tr>';
      }
      setHtml('mortgage-schedule-body', rows);
    } else {
      setHtml('mortgage-schedule-body', yearlyRows);
    }
    setPressed('schedule-yearly-btn', view === 'yearly');
    setPressed('schedule-monthly-btn', view === 'monthly');
  }

  function run() {
    var price = num('home-price'), down = num('down-payment'), rate = num('interest-rate'),
      years = num('loan-years'), tax = num('property-tax'), ins = num('home-insurance'),
      hoa = num('hoa-fee'), pmiRate = num('pmi-rate'),
      extra = num('extra-payment'), lump = num('lump-sum');

    var ok = valid(price, 0, 1e12) && valid(down, 0, price) && valid(rate, 0, 100) &&
      valid(years, 1, 50) && valid(tax, 0, 1e12) && valid(ins, 0, 1e12) &&
      valid(hoa, 0, 1e12) && valid(pmiRate, 0, 100) &&
      valid(extra, 0, 1e12) && valid(lump, 0, 1e12);

    if (!ok) {
      OUTPUTS.forEach(function (id) { set(id, '—'); });
      set('down-percent', '');
      set('mortgage-pmi-note', '');
      set('schedule-note', '');
      set('mortgage-error', 'Check the highlighted values: down payment cannot exceed the price, rate must be 0–100%, and term must be 1–50 years.');
      setWidth('bd-pi', 0); setWidth('bd-tax', 0); setWidth('bd-ins', 0);
      setWidth('bd-hoa', 0); setWidth('bd-pmi', 0);
      setHtml('mortgage-schedule-body', '');
      setHtml('term-compare-body', '');
      return;
    }
    set('mortgage-error', '');

    var principal = price - down;
    var baseMonths = years * 12;
    var r = rate / 1200;
    var pi = r === 0 ? principal / baseMonths
      : principal * r * Math.pow(1 + r, baseMonths) / (Math.pow(1 + r, baseMonths) - 1);
    if (!Number.isFinite(pi)) pi = 0;

    var taxM = tax / 12, insM = ins / 12, hoaM = hoa;
    var downPct = price > 0 ? (down / price) * 100 : 0;
    var pmiM = downPct < 20 ? principal * pmiRate / 100 / 12 : 0;

    // Effective scenario: base plan, or accelerated when extra payments exist.
    var plan = amortize(principal, r, pi, extra, lump, price, pmiM);
    var baseInterest = pi * baseMonths - principal;
    if (r === 0) baseInterest = 0;

    yearlyRows = '';
    for (var i = 0; i < plan.yearly.length; i++) {
      var y = plan.yearly[i];
      yearlyRows += '<tr><td>' + y[0] + '</td><td>' + usd(y[1]) + '</td><td>' + usd(y[2]) + '</td><td>' + usd(y[3]) + '</td></tr>';
    }
    monthlyData = plan.monthly;
    renderSchedule();

    var total = pi + taxM + insM + hoaM + pmiM;
    var totalCost = pi * baseMonths + tax * years + ins * years + hoa * baseMonths + pmiM * plan.pmiMonths;

    set('monthly-payment', usd(pi));
    set('loan-amount', usd(principal));
    set('total-interest', usd(baseInterest));
    set('total-paid', usd(pi * baseMonths));
    set('monthly-tax', usd(taxM));
    set('monthly-insurance', usd(insM));
    set('monthly-hoa', usd(hoaM));
    set('monthly-pmi', usd(pmiM));
    set('monthly-total', usd(total));
    set('total-cost', usd(totalCost));
    set('down-percent', price > 0 ? downPct.toFixed(1) + '% of price' : '');
    set('mortgage-pmi-note', pmiM > 0
      ? 'PMI applies for about ' + plan.pmiMonths + ' months, until the balance drops to 80% of the price.'
      : 'No PMI — the down payment is 20% or more of the price.');
    set('payoff-date', payoffDate(plan.months));
    set('interest-with-extras', usd(plan.totalInterest));
    set('interest-saved', usd(Math.max(0, baseInterest - plan.totalInterest)));
    set('time-saved', timeSavedText(baseMonths - plan.months));
    set('schedule-note', (extra > 0 || lump > 0)
      ? 'Schedule includes your extra payments.'
      : 'Schedule shows the standard plan without extra payments.');

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

    // Side-by-side term comparison at the same price, down payment and rate.
    var termsHtml = '';
    [15, 20, 30].forEach(function (t) {
      var n = t * 12;
      var p = r === 0 ? principal / n
        : principal * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
      if (!Number.isFinite(p)) p = 0;
      var cls = t === years ? ' class="mortgage-current-term"' : '';
      termsHtml += '<tr' + cls + '><td>' + t + ' years</td><td>' + usd(p) + '</td><td>' + usd(p * n - principal) + '</td><td>' + usd(p * n) + '</td></tr>';
    });
    setHtml('term-compare-body', termsHtml);
  }

  function downloadCsv() {
    if (typeof Blob === 'undefined') return;
    var csv = 'Month,Interest,Principal,Remaining balance\n';
    for (var i = 0; i < monthlyData.length; i++) {
      var m = monthlyData[i];
      csv += m[0] + ',' + m[1].toFixed(2) + ',' + m[2].toFixed(2) + ',' + m[3].toFixed(2) + '\n';
    }
    var url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    var a = document.createElement('a');
    a.href = url; a.download = 'mortgage-schedule.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  document.querySelectorAll('#mortgage-form input').forEach(function (input) {
    input.addEventListener('input', run);
  });
  var yearlyBtn = document.getElementById('schedule-yearly-btn');
  if (yearlyBtn) yearlyBtn.addEventListener('click', function () { view = 'yearly'; renderSchedule(); });
  var monthlyBtn = document.getElementById('schedule-monthly-btn');
  if (monthlyBtn) monthlyBtn.addEventListener('click', function () { view = 'monthly'; renderSchedule(); });
  var dlBtn = document.getElementById('download-schedule-btn');
  if (dlBtn) dlBtn.addEventListener('click', downloadCsv);
  run();
})();
