// Mortgage calculator v2 — scoped to #mortgage-form only.
// Uses only document.querySelector, querySelectorAll and getElementById so the
// repo's DOM-stub tests can execute it. No shared-script logic lives here.
(function () {
  var form = document.querySelector('#mortgage-form');
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
  function setHtml(id, html) {
    var el = document.getElementById(id);
    if (el) el.innerHTML = html;
  }
  function setPressed(id, on) {
    var el = document.getElementById(id);
    if (el && el.setAttribute) el.setAttribute('aria-pressed', on ? 'true' : 'false');
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
    'monthly-total', 'total-cost', 'payoff-date', 'interest-with-extras',
    'interest-saved', 'time-saved'];

  var view = 'yearly';
  var monthlyData = [];
  var yearlyRows = '';

  // mipCapMonths: when a number is passed (FHA), the insurance-month counter
  // counts months while months < mipCapMonths instead of using the 80%-of-price
  // PMI rule — 132 for the 11-year MIP bands, Infinity for life-of-loan MIP.
  function amortize(principal, r, pi, extra, lump, price, pmiM, mipCapMonths) {
    var bal = principal, months = 0, totalInterest = 0, totalPaid = 0, pmiMonths = 0;
    var yearly = [], monthly = [];
    var intY = 0, prinY = 0, year = 1;
    while (bal > 0 && months < 1200) {
      if (typeof mipCapMonths === 'number') { if (months < mipCapMonths) pmiMonths++; }
      else if (pmiM > 0 && bal > price * 0.8) pmiMonths++;
      var interest = bal * r;
      var prin = pi + extra - interest;
      if (months === 0) prin += lump;
      if (prin > bal) prin = bal;
      if (prin < 0) prin = 0;
      intY += interest; prinY += prin; bal -= prin;
      if (bal < 0.005) bal = 0;
      totalInterest += interest;
      totalPaid += interest + prin;
      months++;
      monthly.push([months, interest, prin, bal]);
      if (months % 12 === 0 || bal === 0) {
        yearly.push([year, intY, prinY, bal]);
        year++; intY = 0; prinY = 0;
      }
    }
    return { months: months, totalInterest: totalInterest, totalPaid: totalPaid, pmiMonths: pmiMonths,
      yearly: yearly, monthly: monthly };
  }

  // ARM projection: the rate is fixed for fixedYears, then adjusts once a
  // year toward the assumed rate — at most 2% at the first adjustment, 1% at
  // later ones, never above the starting rate + 5% and never below 1%. The
  // payment is recalculated (recast) on the remaining balance and term at
  // each adjustment. firstAdjPi is the principal & interest right after the
  // first adjustment.
  function amortizeArm(principal, rate0, assumed, fixedYears, extra, lump, price, pmiM) {
    function paymentFor(b, annualRate, n) {
      if (n <= 0) return b;
      var rr = annualRate / 1200;
      if (rr === 0) return b / n;
      var f = Math.pow(1 + rr, n);
      return b * rr * f / (f - 1);
    }
    var bal = principal, months = 0, totalInterest = 0, totalPaid = 0, pmiMonths = 0;
    var yearly = [], monthly = [];
    var intY = 0, prinY = 0, year = 1;
    var totalMonths = 360;
    var rate = rate0;
    var pi = paymentFor(bal, rate, totalMonths);
    var firstAdjPi = null;
    var adjCount = 0;
    while (bal > 0 && months < 1200) {
      if (months >= fixedYears * 12 && (months - fixedYears * 12) % 12 === 0 && months < totalMonths) {
        adjCount++;
        var cap = adjCount === 1 ? 2 : 1;
        var next = rate;
        if (assumed > rate) next = Math.min(rate + cap, assumed);
        else if (assumed < rate) next = Math.max(rate - cap, assumed);
        if (next > rate0 + 5) next = rate0 + 5;
        if (next < 1) next = 1;
        rate = next;
        pi = paymentFor(bal, rate, totalMonths - months);
        if (firstAdjPi === null) firstAdjPi = pi;
      }
      if (pmiM > 0 && bal > price * 0.8) pmiMonths++;
      var interest = bal * (rate / 1200);
      var prin = pi + extra - interest;
      if (months === 0) prin += lump;
      if (prin > bal) prin = bal;
      if (prin < 0) prin = 0;
      intY += interest; prinY += prin; bal -= prin;
      if (bal < 0.005) bal = 0;
      totalInterest += interest;
      totalPaid += interest + prin;
      months++;
      monthly.push([months, interest, prin, bal]);
      if (months % 12 === 0 || bal === 0) {
        yearly.push([year, intY, prinY, bal]);
        year++; intY = 0; prinY = 0;
      }
    }
    if (firstAdjPi === null) firstAdjPi = pi;
    return { months: months, totalInterest: totalInterest, totalPaid: totalPaid, pmiMonths: pmiMonths,
      yearly: yearly, monthly: monthly, firstAdjPi: firstAdjPi };
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

    // Named validation: the panel names every problem instead of a generic
    // message with no reason. Rules are unchanged; only the presentation is.
    var problems = [];
    function isEmpty(id) {
      var el = document.getElementById(id);
      return !el || el.value === '';
    }
    if (isEmpty('home-price')) problems.push('Home price is empty.');
    else if (!valid(price, 0, 1e12)) problems.push('Home price must be 0 or more.');
    if (isEmpty('down-payment')) problems.push('Down payment is empty.');
    else if (down > price) problems.push('Down payment cannot exceed the home price.');
    else if (!valid(down, 0, 1e12)) problems.push('Down payment must be 0 or more.');
    if (isEmpty('interest-rate')) problems.push('Annual interest rate is empty.');
    else if (!valid(rate, 0, 100)) problems.push('Annual interest rate must be 0–100%.');
    if (isEmpty('loan-years')) problems.push('Loan term is empty.');
    else if (!valid(years, 1, 50)) problems.push('Loan term must be 1–50 years.');
    if (isEmpty('property-tax')) problems.push('Property tax is empty.');
    else if (!valid(tax, 0, 1e12)) problems.push('Property tax must be 0 or more.');
    if (isEmpty('home-insurance')) problems.push('Home insurance is empty.');
    else if (!valid(ins, 0, 1e12)) problems.push('Home insurance must be 0 or more.');
    if (isEmpty('hoa-fee')) problems.push('HOA dues is empty.');
    else if (!valid(hoa, 0, 1e12)) problems.push('HOA dues must be 0 or more.');
    if (isEmpty('pmi-rate')) problems.push('PMI rate is empty.');
    else if (!valid(pmiRate, 0, 100)) problems.push('PMI rate must be 0–100%.');
    if (isEmpty('extra-payment')) problems.push('Extra payment is empty.');
    else if (!valid(extra, 0, 1e12)) problems.push('Extra payment must be 0 or more.');
    if (isEmpty('lump-sum')) problems.push('One-time extra payment is empty.');
    else if (!valid(lump, 0, 1e12)) problems.push('One-time extra payment must be 0 or more.');
    var loanTypeCheck = currentLoanType();
    if (loanTypeCheck === 'arm5' || loanTypeCheck === 'arm7') {
      if (isEmpty('arm-assumed-rate')) problems.push('Assumed rate after the fixed period is empty.');
      else if (!valid(num('arm-assumed-rate'), 1, 100)) problems.push('Assumed rate after the fixed period must be 1–100%.');
    }
    var ok = problems.length === 0;

    if (!ok) {
      OUTPUTS.forEach(function (id) { set(id, '—'); });
      set('monthly-total', problems[0]);
      set('result-empty', problems.join(' '));
      set('down-percent', '');
      set('mortgage-pmi-note', '');
      set('schedule-note', '');
      set('mortgage-error', 'Check the highlighted values: down payment cannot exceed the price, rate must be 0–100%, and term must be 1–50 years.');
      set('lg-tax', '—'); set('lg-ins', '—'); set('lg-hoa', '—'); set('lg-pmi', '—');
      set('sticky-value', '—');
      set('cc-down', '—'); set('cc-costs', '—'); set('cc-total', '—');
      set('summary-total', '—'); set('summary-cash', '—');
      setHtml('balance-chart', '');
      set('chart-balance-end', '—'); set('chart-interest-end', '—');
      hideRow('result-body', true); hideRow('result-empty', false);
      hideRow('row-upfront-mip', true); hideRow('row-arm-projected', true);
      setWidth('bd-pi', 0); setWidth('bd-tax', 0); setWidth('bd-ins', 0);
      setWidth('bd-hoa', 0); setWidth('bd-pmi', 0);
      setHtml('mortgage-schedule-body', '');
      setHtml('term-compare-body', '');
      return;
    }
    set('mortgage-error', '');
    hideRow('result-body', false); hideRow('result-empty', true);

    var principal = price - down;
    var loanType = currentLoanType();
    var isFha = loanType === 'fha';
    var isArm = loanType === 'arm5' || loanType === 'arm7';
    if (isFha || isArm) years = 30;
    var baseMonths = years * 12;
    var r = rate / 1200;
    var taxM = tax / 12, insM = ins / 12, hoaM = hoa;
    var downPct = price > 0 ? (down / price) * 100 : 0;

    // FHA (HUD Mortgagee Letter 2023-05, 30-year term): the 1.75% upfront
    // MIP is financed into the loan; the annual MIP rate depends on the base
    // loan amount and LTV, and lasts 11 years at LTV ≤ 90% or the life of
    // the loan above that. Annual MIP is billed monthly on the base loan,
    // the same convention as the Down Payment Calculator.
    var loanAmt = principal;
    var ufmip = 0;
    var mipM = 0, mipCap = null, mipLife = false;
    if (isFha) {
      ufmip = principal * 0.0175;
      loanAmt = principal + ufmip;
      var ltv = price > 0 ? principal / price * 100 : 0;
      var mipRate;
      if (principal <= 726200) {
        if (ltv <= 90) { mipRate = 0.50; mipCap = 132; }
        else if (ltv <= 95) { mipRate = 0.50; mipLife = true; }
        else { mipRate = 0.55; mipLife = true; }
      } else {
        if (ltv <= 90) { mipRate = 0.70; mipCap = 132; }
        else if (ltv <= 95) { mipRate = 0.70; mipLife = true; }
        else { mipRate = 0.75; mipLife = true; }
      }
      mipM = principal * mipRate / 100 / 12;
    }
    var pi = r === 0 ? loanAmt / baseMonths
      : loanAmt * r * Math.pow(1 + r, baseMonths) / (Math.pow(1 + r, baseMonths) - 1);
    if (!Number.isFinite(pi)) pi = 0;

    var pmiM = (!isFha && downPct < 20) ? principal * pmiRate / 100 / 12 : 0;
    var insM2 = isFha ? mipM : pmiM;

    // Effective scenario: base plan, or accelerated when extra payments exist.
    var plan, baseInterest, basePlan = null;
    if (isArm) {
      var assumedRate = num('arm-assumed-rate');
      var fixedYears = loanType === 'arm5' ? 5 : 7;
      basePlan = amortizeArm(principal, rate, assumedRate, fixedYears, 0, 0, price, pmiM);
      plan = amortizeArm(principal, rate, assumedRate, fixedYears, extra, lump, price, pmiM);
      baseInterest = basePlan.totalInterest;
    } else if (isFha) {
      plan = amortize(loanAmt, r, pi, extra, lump, price, 0, mipLife ? Infinity : mipCap);
      baseInterest = pi * baseMonths - loanAmt;
      if (r === 0) baseInterest = 0;
    } else {
      plan = amortize(principal, r, pi, extra, lump, price, pmiM);
      baseInterest = pi * baseMonths - principal;
      if (r === 0) baseInterest = 0;
    }

    yearlyRows = '';
    for (var i = 0; i < plan.yearly.length; i++) {
      var y = plan.yearly[i];
      yearlyRows += '<tr><td>' + y[0] + '</td><td>' + usd(y[1]) + '</td><td>' + usd(y[2]) + '</td><td>' + usd(y[3]) + '</td></tr>';
    }
    monthlyData = plan.monthly;
    renderSchedule();

    var total = pi + taxM + insM + hoaM + insM2;
    var hasExtra = extra > 0 || lump > 0;
    var effectiveInterest, effectivePaid, totalCost;
    if (isArm) {
      effectiveInterest = plan.totalInterest;
      effectivePaid = plan.totalPaid;
      totalCost = plan.totalPaid + taxM * plan.months + insM * plan.months
        + hoaM * plan.months + insM2 * plan.pmiMonths;
    } else if (hasExtra) {
      effectiveInterest = plan.totalInterest;
      effectivePaid = plan.totalPaid;
      totalCost = effectivePaid + taxM * plan.months + insM * plan.months
        + hoaM * plan.months + insM2 * plan.pmiMonths;
    } else {
      effectiveInterest = baseInterest;
      effectivePaid = pi * baseMonths;
      totalCost = pi * baseMonths + tax * years + ins * years + hoa * baseMonths + insM2 * plan.pmiMonths;
    }

    set('monthly-payment', usd(pi));
    set('loan-amount', usd(loanAmt));
    set('total-interest', usd(effectiveInterest));
    set('total-paid', usd(effectivePaid));
    set('monthly-total', usd(total));
    set('total-cost', usd(totalCost));
    hideRow('row-upfront-mip', !isFha);
    if (isFha) set('upfront-mip', usd(ufmip));
    hideRow('row-arm-projected', !isArm);
    if (isArm) set('arm-projected-payment', usd(plan.firstAdjPi));
    set('pmi-label', isFha ? 'FHA MIP' : 'PMI');
    set('down-percent', price > 0 ? downPct.toFixed(1) + '% of price' : '');
    if (isFha) {
      set('mortgage-pmi-note', mipLife
        ? 'FHA MIP applies for the life of the loan at this loan-to-value ratio, plus a 1.75% upfront premium financed into the loan.'
        : 'FHA MIP applies for 11 years at this loan-to-value ratio, plus a 1.75% upfront premium financed into the loan.');
    } else if (isArm) {
      set('mortgage-pmi-note', (pmiM > 0
        ? 'PMI applies for about ' + plan.pmiMonths + ' months, until the balance drops to 80% of the price. '
        : 'No PMI — the down payment is 20% or more of the price. ')
        + 'ARM projection: the rate is fixed for ' + fixedYears + ' years, then adjusts once a year toward your assumed rate — a projection, not a prediction.');
    } else {
      set('mortgage-pmi-note', pmiM > 0
        ? 'PMI applies for about ' + plan.pmiMonths + ' months, until the balance drops to 80% of the price.'
        : 'No PMI — the down payment is 20% or more of the price.');
    }
    set('payoff-date', payoffDate(plan.months));
    set('interest-with-extras', usd(plan.totalInterest));
    set('interest-saved', usd(Math.max(0, baseInterest - effectiveInterest)));
    set('time-saved', timeSavedText((isArm ? basePlan.months : baseMonths) - plan.months));
    set('schedule-note', (extra > 0 || lump > 0)
      ? 'Schedule includes your extra payments.'
      : 'Schedule shows the standard plan without extra payments.');

    // Shared restyle behaviors: legend amounts and sticky value.
    // HOA, PMI, interest-saved and time-saved rows always show, even at $0,
    // so the panel never contradicts itself with a "not shown" note.
    set('lg-tax', usd(taxM)); set('lg-ins', usd(insM));
    set('lg-hoa', usd(hoaM)); set('lg-pmi', usd(insM2));
    set('sticky-value', usd(total));
    syncDownPct();

    // Balance-over-time chart from the yearly schedule rows.
    var maxYear = plan.yearly.length || 1;
    var maxVal = Math.max(loanAmt, plan.totalInterest, 1);
    var cumInt = 0, balPts = '', intPts = '';
    for (var ci = 0; ci < plan.yearly.length; ci++) {
      var yr = plan.yearly[ci];
      cumInt += yr[1];
      var x = 20 + (yr[0] / maxYear) * 560;
      balPts += (balPts ? ' ' : '') + x.toFixed(1) + ',' + (230 - (yr[3] / maxVal) * 200).toFixed(1);
      intPts += (intPts ? ' ' : '') + x.toFixed(1) + ',' + (230 - (cumInt / maxVal) * 200).toFixed(1);
    }
    setHtml('balance-chart', '<line x1="20" y1="230" x2="580" y2="230" stroke="#D9DEDB" stroke-width="1"/>'
      + '<polyline points="' + balPts + '" class="chart-line-balance"/>'
      + '<polyline points="' + intPts + '" class="chart-line-interest"/>');
    set('chart-balance-end', usd(plan.yearly.length ? plan.yearly[plan.yearly.length - 1][3] : 0));
    set('chart-interest-end', usd(plan.totalInterest));

    if (total > 0) {
      setWidth('bd-pi', (pi / total) * 100);
      setWidth('bd-tax', (taxM / total) * 100);
      setWidth('bd-ins', (insM / total) * 100);
      setWidth('bd-hoa', (hoaM / total) * 100);
      setWidth('bd-pmi', (insM2 / total) * 100);
    } else {
      setWidth('bd-pi', 0); setWidth('bd-tax', 0); setWidth('bd-ins', 0);
      setWidth('bd-hoa', 0); setWidth('bd-pmi', 0);
    }

    // Cash to close: down payment plus closing costs estimated at 3% of the
    // price (the Down Payment Calculator's default assumption, labelled in
    // the card). Also feeds the slim summary bar shown while scrolling.
    var cashCosts = price * 0.03;
    set('cc-down', usd(down));
    set('cc-costs', usd(cashCosts));
    set('cc-total', usd(down + cashCosts));
    set('summary-total', usd(total));
    set('summary-cash', usd(down + cashCosts));

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

  // Down payment $ and % stay in sync; the % field never overwrites itself
  // while the user is typing in it.
  function syncDownPct() {
    var pctEl = document.getElementById('down-percent-input');
    if (!pctEl) return;
    if (typeof document !== 'undefined' && document.activeElement === pctEl) return;
    var priceEl = document.getElementById('home-price');
    var downEl = document.getElementById('down-payment');
    if (!priceEl || !downEl) return;
    var price = Number(String(priceEl.value).replace(/,/g, ''));
    var down = Number(String(downEl.value).replace(/,/g, ''));
    if (Number.isFinite(price) && price > 0 && Number.isFinite(down)) {
      pctEl.value = (down / price * 100).toFixed(1);
    }
  }
  function syncSliders() {
    var priceEl = document.getElementById('home-price');
    var priceSlider = document.getElementById('home-price-slider');
    var downEl = document.getElementById('down-payment');
    var downSlider = document.getElementById('down-payment-slider');
    var rateEl = document.getElementById('interest-rate');
    var rateSlider = document.getElementById('interest-rate-slider');
    var pctEl = document.getElementById('down-percent-input');
    var price = priceEl ? Number(String(priceEl.value).replace(/,/g, '').trim()) : NaN;
    var down = downEl ? Number(String(downEl.value).replace(/,/g, '').trim()) : NaN;
    var rate = rateEl ? Number(String(rateEl.value).replace(/,/g, '').trim()) : NaN;
    if (priceSlider && Number.isFinite(price) && price > 0) {
      var currentMax = Number(priceSlider.max) || 10000000;
      if (price > currentMax) priceSlider.max = String(price);
      priceSlider.value = String(price);
    }
    if (downSlider) {
      if (Number.isFinite(price) && price >= 0) downSlider.max = String(price);
      if (Number.isFinite(down) && down >= 0) {
        var downMax = Number(downSlider.max);
        if (Number.isFinite(downMax) && down <= downMax) downSlider.value = String(down);
      }
    }
    if (rateSlider && Number.isFinite(rate) && rate >= 0) {
      if (rate > Number(rateSlider.max)) rateSlider.max = String(rate);
      rateSlider.value = String(rate);
    }
    if (pctEl && Number.isFinite(price) && price > 0 && Number.isFinite(down)) {
      pctEl.value = (down / price * 100).toFixed(1);
    }
  }
  function readUrlParameters() {
    var search = '';
    if (typeof window !== 'undefined' && window.location && typeof window.location.search === 'string') {
      search = window.location.search;
    } else if (typeof location !== 'undefined' && location && typeof location.search === 'string') {
      search = location.search;
    }
    if (!search || search === '?') return;
    var params = {};
    search.replace(/^\?/, '').split('&').forEach(function (part) {
      if (!part) return;
      var pair = part.split('=');
      var key = '';
      var value = '';
      try { key = decodeURIComponent(pair.shift().replace(/\+/g, ' ')); } catch (e) { return; }
      try { value = decodeURIComponent(pair.join('=').replace(/\+/g, ' ')); } catch (e) { value = ''; }
      if (key) params[key] = value;
    });
    var price = params.price;
    var down = params.down;
    var rate = params.rate;
    var term = params.term;
    var priceEl = document.getElementById('home-price');
    var downEl = document.getElementById('down-payment');
    var rateEl = document.getElementById('interest-rate');
    var termEl = document.getElementById('loan-years');
    if (priceEl && /^\s*-?\d+(\.\d+)?\s*$/.test(price || '') && valid(Number(price), 0, 1e12)) {
      priceEl.value = String(Number(price));
    }
    var finalPrice = priceEl ? Number(String(priceEl.value).replace(/,/g, '').trim()) : NaN;
    if (downEl && /^\s*-?\d+(\.\d+)?\s*$/.test(down || '') &&
        valid(Number(down), 0, 1e12) && Number(down) <= finalPrice) {
      downEl.value = String(Number(down));
    }
    if (rateEl && /^\s*-?\d+(\.\d+)?\s*$/.test(rate || '') && valid(Number(rate), 0, 100)) {
      rateEl.value = String(Number(rate));
    }
    if (termEl && /^\s*\d+(\.\d+)?\s*$/.test(term || '') && valid(Number(term), 1, 50)) {
      termEl.value = String(Number(term));
      document.querySelectorAll('.seg-control button').forEach(function (b) {
        if (b.getAttribute && b.getAttribute('data-years')) {
          setAttr(b, 'aria-pressed', b.getAttribute('data-years') === termEl.value ? 'true' : 'false');
        }
      });
    }
  }
  // Sliders and the % field are handled by delegation on the form, so the
  // per-input listeners above are never overwritten (the test stubs keep one
  // listener per event per element).
  form.addEventListener('input', function (e) {
    var t = e && e.target;
    if (!t || !t.id) return;
    if (t.type === 'number' && t.id === 'property-tax') taxAuto = false;
    if (t.type === 'range') {
      var numEl = document.getElementById(t.id.replace(/-slider$/, ''));
      if (numEl) numEl.value = t.value;
      run();
      if (t.id === 'home-price-slider' && taxAuto && taxState && STATE_DATA[taxState]) {
        var taxElR = document.getElementById('property-tax');
        if (taxElR) taxElR.value = String(Math.round(Number(t.value) * STATE_DATA[taxState].tax / 100));
        run();
      }
    } else if (t.type === 'number') {
      var slider = document.getElementById(t.id + '-slider');
      if (slider) {
        var v = Number(String(t.value).replace(/,/g, ''));
        if (Number.isFinite(v)) {
          if (t.id === 'home-price') {
            var oldMax = Number(slider.max) || 10000000;
            if (v > oldMax) slider.max = String(v);
            if (v >= 0) slider.value = String(v);
            var downSliderHome = document.getElementById('down-payment-slider');
            var downElHome = document.getElementById('down-payment');
            if (downSliderHome && v >= 0) downSliderHome.max = String(v);
            if (downElHome) {
              var downNow = Number(String(downElHome.value).replace(/,/g, ''));
              if (Number.isFinite(downNow) && downNow > v && v >= 0) {
                downElHome.value = String(v);
                if (downSliderHome) downSliderHome.value = String(v);
              }
            }
            syncDownPct();
            if (taxAuto && taxState && STATE_DATA[taxState]) {
              var taxElF = document.getElementById('property-tax');
              if (taxElF) taxElF.value = String(Math.round(v * STATE_DATA[taxState].tax / 100));
              run();
            }
          } else {
            var mn = Number(slider.min), mx = Number(slider.max);
            if (Number.isFinite(mn) && v < mn) v = mn;
            if (Number.isFinite(mx) && v > mx) v = mx;
            if (t.id === 'down-payment') {
              var priceEl = document.getElementById('home-price');
              var priceNow = priceEl ? Number(String(priceEl.value).replace(/,/g, '')) : NaN;
              if (Number.isFinite(priceNow) && v > priceNow) v = priceNow;
            }
            slider.value = String(v);
          }
        }
      }
      if (t.id === 'down-payment') {
        var downSlider = document.getElementById('down-payment-slider');
        var priceEl = document.getElementById('home-price');
        if (downSlider && priceEl) {
          var p = Number(String(priceEl.value).replace(/,/g, ''));
          if (Number.isFinite(p) && p > 0) downSlider.max = String(p);
        }
      }
    }
  });
  form.addEventListener('change', function (e) {
    var t = e && e.target;
    if (t && t.id === 'down-percent-input') {
      var priceEl = document.getElementById('home-price');
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
  // Segmented loan term: buttons set the hidden loan-years value. The
  // loan-type buttons share the .seg-control class but carry data-loan-type
  // instead of data-years — this handler must ignore them (and disabled
  // buttons), or clicking FHA/ARM would blank the term.
  document.querySelectorAll('.seg-control button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var yrs = btn.getAttribute ? btn.getAttribute('data-years') : null;
      if (!yrs || btn.disabled) return;
      var yearsEl = document.getElementById('loan-years');
      if (yearsEl) yearsEl.value = yrs;
      document.querySelectorAll('.seg-control button').forEach(function (b) {
        if (b.getAttribute && b.getAttribute('data-years')) {
          setAttr(b, 'aria-pressed', b === btn ? 'true' : 'false');
        }
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
    copyResults([['Total monthly payment', 'monthly-total'], ['Principal & interest', 'monthly-payment'],
      ['Loan amount', 'loan-amount'], ['Total interest', 'total-interest'], ['Payoff date', 'payoff-date']],
      'Mortgage Payment Calculator');
  });
  var printBtn = document.getElementById('print-results');
  if (printBtn) printBtn.addEventListener('click', function () {
    if (typeof window !== 'undefined' && window.print) window.print();
  });
  // --- Loan types -------------------------------------------------------
  function currentLoanType() {
    var el = document.getElementById('loan-type');
    return el ? String(el.value) : 'fixed';
  }
  // FHA and ARM are 30-year products here: selecting one forces the term
  // to 30 and disables the other term buttons. FHA also disables the PMI
  // rate field, because FHA loans charge MIP instead of PMI.
  function applyLoanType() {
    var type = currentLoanType();
    var restricted = type !== 'fixed';
    if (restricted) {
      var yearsEl = document.getElementById('loan-years');
      if (yearsEl) yearsEl.value = '30';
    }
    document.querySelectorAll('.seg-control button').forEach(function (b) {
      if (!b.getAttribute) return;
      var yrs = b.getAttribute('data-years');
      if (!yrs) return;
      if (restricted && yrs !== '30') { b.disabled = true; setAttr(b, 'aria-disabled', 'true'); }
      else { b.disabled = false; setAttr(b, 'aria-disabled', 'false'); }
      if (restricted) setAttr(b, 'aria-pressed', yrs === '30' ? 'true' : 'false');
    });
    var armBox = document.getElementById('arm-details');
    if (armBox) armBox.hidden = !(type === 'arm5' || type === 'arm7');
    var pmiEl = document.getElementById('pmi-rate');
    if (pmiEl) pmiEl.disabled = type === 'fha';
  }
  document.querySelectorAll('.seg-control button').forEach(function (btn) {
    if (!btn.getAttribute || !btn.getAttribute('data-loan-type')) return;
    btn.addEventListener('click', function () {
      var typeEl = document.getElementById('loan-type');
      if (typeEl) typeEl.value = btn.getAttribute('data-loan-type');
      document.querySelectorAll('.seg-control button').forEach(function (b) {
        if (b.getAttribute && b.getAttribute('data-loan-type')) {
          setAttr(b, 'aria-pressed', b === btn ? 'true' : 'false');
        }
      });
      applyLoanType();
      run();
    });
  });

  // --- State averages ---------------------------------------------------
  // Estimates only, never a quote. Sources, one per column:
  // rate: average 30-year fixed conventional rate (%), Mortech data via The
  //   Mortgage Reports, snapshot of Nov 12, 2026. Hawaii and DC had no
  //   state figure in that snapshot and use its national average, 7.20.
  // tax: effective property tax rate on owner-occupied homes (%), Tax
  //   Foundation, Facts & Figures 2026 (2024 American Community Survey).
  // ins: average annual HO-3 homeowners premium ($), NAIC Homeowners
  //   Insurance Report, data for 2023.
  var STATE_DATA = {
    AL: { rate: 7.33, tax: 0.37, ins: 1906 }, AK: { rate: 7.20, tax: 0.94, ins: 1216 },
    AZ: { rate: 7.45, tax: 0.48, ins: 1194 }, AR: { rate: 7.30, tax: 0.56, ins: 1870 },
    CA: { rate: 7.13, tax: 0.70, ins: 1655 }, CO: { rate: 7.34, tax: 0.50, ins: 2492 },
    CT: { rate: 7.14, tax: 1.54, ins: 2036 }, DE: { rate: 7.43, tax: 0.54, ins: 1196 },
    DC: { rate: 7.20, tax: 0.60, ins: 1545 }, FL: { rate: 7.00, tax: 0.78, ins: 2779 },
    GA: { rate: 7.13, tax: 0.79, ins: 1828 }, HI: { rate: 7.20, tax: 0.29, ins: 1549 },
    ID: { rate: 7.44, tax: 0.50, ins: 1135 }, IL: { rate: 7.27, tax: 1.88, ins: 1480 },
    IN: { rate: 7.35, tax: 0.76, ins: 1259 }, IA: { rate: 7.08, tax: 1.33, ins: 1342 },
    KS: { rate: 7.35, tax: 1.21, ins: 1733 }, KY: { rate: 7.40, tax: 0.74, ins: 1525 },
    LA: { rate: 7.41, tax: 0.55, ins: 3027 }, ME: { rate: 7.29, tax: 0.98, ins: 1150 },
    MD: { rate: 7.18, tax: 0.92, ins: 1578 }, MA: { rate: 7.20, tax: 1.00, ins: 2134 },
    MI: { rate: 7.16, tax: 1.19, ins: 1110 }, MN: { rate: 7.16, tax: 1.00, ins: 1988 },
    MS: { rate: 7.39, tax: 0.58, ins: 2029 }, MO: { rate: 7.34, tax: 0.89, ins: 1589 },
    MT: { rate: 7.50, tax: 0.61, ins: 1768 }, NE: { rate: 7.45, tax: 1.44, ins: 2142 },
    NV: { rate: 7.13, tax: 0.50, ins: 1013 }, NH: { rate: 7.31, tax: 1.50, ins: 1300 },
    NJ: { rate: 7.14, tax: 1.88, ins: 1551 }, NM: { rate: 7.35, tax: 0.63, ins: 1490 },
    NY: { rate: 7.09, tax: 1.30, ins: 1801 }, NC: { rate: 7.16, tax: 0.66, ins: 1852 },
    ND: { rate: 7.48, tax: 0.92, ins: 1414 }, OH: { rate: 7.40, tax: 1.36, ins: 1116 },
    OK: { rate: 7.33, tax: 0.79, ins: 2486 }, OR: { rate: 7.51, tax: 0.81, ins: 1003 },
    PA: { rate: 7.15, tax: 1.26, ins: 1217 }, RI: { rate: 7.25, tax: 1.12, ins: 2396 },
    SC: { rate: 7.32, tax: 0.49, ins: 1753 }, SD: { rate: 7.43, tax: 1.00, ins: 1614 },
    TN: { rate: 7.33, tax: 0.52, ins: 1649 }, TX: { rate: 7.32, tax: 1.40, ins: 2864 },
    UT: { rate: 7.46, tax: 0.48, ins: 1107 }, VT: { rate: 7.33, tax: 1.51, ins: 1215 },
    VA: { rate: 7.25, tax: 0.78, ins: 1537 }, WA: { rate: 7.43, tax: 0.75, ins: 1232 },
    WV: { rate: 7.40, tax: 0.51, ins: 1179 }, WI: { rate: 7.22, tax: 1.32, ins: 923 },
    WY: { rate: 7.39, tax: 0.53, ins: 1853 }
  };
  // While a state is selected, the tax field follows the home price (state
  // rate × price) until the user types their own tax figure.
  var taxAuto = false;
  var taxState = null;
  var locEl = document.getElementById('property-location');
  if (locEl && locEl.addEventListener) locEl.addEventListener('change', function () {
    var code = String(locEl.value || 'national');
    var rateElS = document.getElementById('interest-rate');
    var taxElS = document.getElementById('property-tax');
    var insElS = document.getElementById('home-insurance');
    if (code === 'national' || !STATE_DATA[code]) {
      taxState = null; taxAuto = false;
      if (rateElS) rateElS.value = '6.5';
      if (taxElS) taxElS.value = '4800';
      if (insElS) insElS.value = '1800';
    } else {
      var d = STATE_DATA[code];
      taxState = code; taxAuto = true;
      if (rateElS) rateElS.value = String(d.rate);
      if (taxElS) taxElS.value = String(Math.round(num('home-price') * d.tax / 100));
      if (insElS) insElS.value = String(d.ins);
    }
    syncSliders();
    run();
  });

  // Slim summary bar (desktop): once the calculator has scrolled out of
  // view, pin the monthly payment and cash-to-close under the site header
  // so the result stays visible through the form and the article. Guarded
  // for the w2 stub, which has no window or IntersectionObserver.
  if (typeof window !== 'undefined' && typeof document.querySelector === 'function') {
    var summaryBar = document.getElementById('calc-summary-bar');
    var calcLayout = document.querySelector('.mortgage-calc-layout');
    if (summaryBar && calcLayout) {
      var setBar = function (visible) {
        summaryBar.classList.toggle('visible', visible);
        summaryBar.setAttribute('aria-hidden', visible ? 'false' : 'true');
      };
      if (typeof IntersectionObserver === 'function') {
        new IntersectionObserver(function (entries) {
          setBar(!entries[0].isIntersecting);
        }, { rootMargin: '-90px 0px 0px 0px' }).observe(calcLayout);
      } else if (window.addEventListener) {
        window.addEventListener('scroll', function () {
          setBar(calcLayout.getBoundingClientRect().bottom < 90);
        }, { passive: true });
      }
    }
  }

  readUrlParameters();
  applyLoanType();
  syncSliders();
  run();
})();
