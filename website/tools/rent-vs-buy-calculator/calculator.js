// Rent vs buy calculator — scoped to #rent-vs-buy-form only.
// Uses only document.querySelector, querySelectorAll and getElementById so the
// repo's DOM-stub tests can execute it. No shared-script logic lives here.
//
// Method (the standard year-by-year comparison): for every year up to 30, the
// net cost of buying is the upfront cash (down payment + closing costs) plus
// all ownership payments so far (mortgage, tax, insurance, HOA, PMI,
// maintenance) minus what selling that year would pocket (home value minus
// the remaining loan balance minus selling costs). The net cost of renting is
// all rent paid so far minus the investment growth on the down payment and
// closing costs the renter never spent. The breakeven year is the first year
// buying's net cost drops to or below renting's; if that never happens in 30
// years, buying never breaks even. Tax, insurance and maintenance are charged
// on the original price, PMI on the original loan while the balance is above
// 80% of the original price, and rent grows once a year. All of this is stated
// on the page, so the result is an honest estimate, not a verdict.
(function () {
  var form = document.querySelector('#rent-vs-buy-form');
  if (!form) return;

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
  function setAttr(el, key, value) {
    if (el && el.setAttribute) el.setAttribute(key, value);
  }
  function fmt(n) {
    return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '';
  }
  function valid(n, a, b) {
    return Number.isFinite(n) && n >= a && n <= b;
  }
  function factor(r, n) {
    return r === 0 ? 1 / n : r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
  }

  var OUTPUTS = ['buy-monthly', 'rent-now', 'breakeven-year', 'total-rent',
    'net-buy-cost', 'net-rent-cost', 'savings-label', 'savings-amount'];

  function run() {
    var rent = num('monthly-rent'), price = num('home-price'),
      down = num('down-payment'), rate = num('interest-rate'),
      years = num('loan-years'), stay = num('years-stay'),
      growth = num('rent-growth'), appr = num('home-appreciation'),
      taxRate = num('property-tax-rate'), ins = num('home-insurance'),
      hoa = num('hoa-fee'), pmiRate = num('pmi-rate'),
      maintRate = num('maintenance-rate'), closing = num('closing-costs'),
      selling = num('selling-costs'), invReturn = num('investment-return');

    var ok = valid(rent, 0, 1e12) && valid(price, 0, 1e12) &&
      valid(down, 0, price) && valid(rate, 0, 100) && valid(years, 1, 50) &&
      valid(stay, 1, 30) && valid(growth, 0, 100) && valid(appr, 0, 100) &&
      valid(taxRate, 0, 100) && valid(ins, 0, 1e12) && valid(hoa, 0, 1e12) &&
      valid(pmiRate, 0, 100) && valid(maintRate, 0, 100) &&
      valid(closing, 0, 100) && valid(selling, 0, 100) &&
      valid(invReturn, 0, 100);
    // Empty fields are invalid, not zero.
    var required = ['monthly-rent', 'home-price', 'down-payment', 'interest-rate',
      'loan-years', 'years-stay', 'rent-growth', 'home-appreciation', 'property-tax-rate',
      'home-insurance', 'hoa-fee', 'pmi-rate', 'maintenance-rate', 'closing-costs',
      'selling-costs', 'investment-return'];
    for (var ri = 0; ri < required.length; ri++) {
      var rel = document.getElementById(required[ri]);
      if (!rel || rel.value === '') { ok = false; break; }
    }

    if (!ok) {
      set('rent-verdict', 'Check inputs');
      set('rent-verdict-detail', '');
      OUTPUTS.forEach(function (id) { set(id, '—'); });
      set('validation-note', 'Check the values: amounts 0 or more, rates 0–100%, stay 1–30 years, term 1–50 years, and no field left empty.');
      set('sticky-value', '—');
      setHtml('breakeven-chart', '');
      set('chart-rent-end', '—'); set('chart-buy-end', '—'); set('chart-breakeven-label', '');
      setWidth('bar-rent', 0); setWidth('bar-buy', 0);
      return;
    }
    set('validation-note', '');

    var r = rate / 1200;
    var loan = price - down;
    var pi = loan * factor(r, years * 12);
    var taxM = price * taxRate / 1200;
    var insM = ins / 12;
    var maintM = price * maintRate / 1200;
    var pmiM = loan * pmiRate / 1200;
    var upfront = down + price * closing / 100;

    // Year-by-year simulation to 30 years.
    var bal = loan, sumBuy = 0, sumRent = 0;
    var netBuy = [], netRent = [], grossRent = [];
    var buyMonthly1 = 0;
    for (var y = 1; y <= 30; y++) {
      for (var m = 0; m < 12; m++) {
        var monthIndex = (y - 1) * 12 + m;
        var due = (monthIndex < years * 12 && bal > 0) ? pi : 0;
        var interest = bal * r;
        var principal = due - interest;
        if (principal > bal) principal = bal;
        bal = bal - principal;
        var pmi = (bal > 0.8 * price && bal > 0) ? pmiM : 0;
        // PMI is checked on the balance after this month's payment, matching
        // the standard rule that it drops once the balance hits 80%.
        var pay = due + taxM + insM + hoa + pmi + maintM;
        if (y === 1 && m === 0) buyMonthly1 = pay;
        sumBuy += pay;
      }
      sumRent += rent * Math.pow(1 + growth / 100, y - 1) * 12;
      var value = price * Math.pow(1 + appr / 100, y);
      var proceeds = value - bal - selling / 100 * value;
      netBuy[y] = upfront + sumBuy - proceeds;
      var invested = upfront * Math.pow(1 + invReturn / 100, y);
      netRent[y] = sumRent - (invested - upfront);
      grossRent[y] = sumRent;
    }

    var breakeven = 0;
    for (var k = 1; k <= 30; k++) {
      if (netBuy[k] <= netRent[k]) { breakeven = k; break; }
    }

    var buyWins = netBuy[stay] <= netRent[stay];
    var diff = Math.abs(netRent[stay] - netBuy[stay]);
    if (breakeven && breakeven <= stay) {
      set('rent-verdict', 'Buying wins — breakeven in year ' + breakeven);
      set('rent-verdict-detail', 'Over your ' + stay + '-year stay, buying saves ' + usd(diff) + ' vs renting.');
    } else if (breakeven) {
      set('rent-verdict', 'Renting wins for your ' + stay + '-year stay');
      set('rent-verdict-detail', 'Buying would win from year ' + breakeven + '. Over your stay, renting saves ' + usd(diff) + ' vs buying.');
    } else {
      set('rent-verdict', 'Renting wins — no breakeven within 30 years');
      set('rent-verdict-detail', 'Over your ' + stay + '-year stay, renting saves ' + usd(diff) + ' vs buying.');
    }

    set('buy-monthly', usd(buyMonthly1));
    set('rent-now', usd(rent));
    set('breakeven-year', breakeven ? 'Year ' + breakeven : 'Over 30 years');
    set('total-rent', usd(grossRent[stay]));
    set('net-buy-cost', usd(netBuy[stay]));
    set('net-rent-cost', usd(netRent[stay]));
    set('savings-label', buyWins ? 'Buying saves' : 'Renting saves');
    set('savings-amount', usd(diff));

    // Shared restyle behaviors: sticky value, down % sync, breakeven chart.
    set('sticky-value', breakeven ? 'Year ' + breakeven : 'Over 30 years');
    syncDownPct();
    var minVal = 0, maxVal = 0;
    for (var ci = 1; ci <= 30; ci++) {
      if (netBuy[ci] < minVal) minVal = netBuy[ci];
      if (netRent[ci] < minVal) minVal = netRent[ci];
      if (netBuy[ci] > maxVal) maxVal = netBuy[ci];
      if (netRent[ci] > maxVal) maxVal = netRent[ci];
    }
    var span = (maxVal - minVal) || 1;
    var rentPts = '', buyPts = '';
    for (var cy = 1; cy <= 30; cy++) {
      var x = 20 + (cy / 30) * 560;
      rentPts += (rentPts ? ' ' : '') + x.toFixed(1) + ',' + (230 - ((netRent[cy] - minVal) / span) * 200).toFixed(1);
      buyPts += (buyPts ? ' ' : '') + x.toFixed(1) + ',' + (230 - ((netBuy[cy] - minVal) / span) * 200).toFixed(1);
    }
    var marker = '';
    if (breakeven) {
      var mx = 20 + (breakeven / 30) * 560;
      marker = '<line x1="' + mx.toFixed(1) + '" y1="20" x2="' + mx.toFixed(1) + '" y2="230" stroke="#F2C14E" stroke-width="1.5" stroke-dasharray="5 4"/>';
    }
    setHtml('breakeven-chart', '<line x1="20" y1="230" x2="580" y2="230" stroke="#D9DEDB" stroke-width="1"/>'
      + '<polyline points="' + rentPts + '" class="chart-line-rent"/>'
      + '<polyline points="' + buyPts + '" class="chart-line-buy"/>' + marker);
    set('chart-rent-end', usd(netRent[stay]));
    set('chart-buy-end', usd(netBuy[stay]));
    set('chart-breakeven-label', breakeven ? 'Breakeven: Year ' + breakeven : 'No breakeven within 30 years');

    var max = Math.max(netBuy[stay], netRent[stay], 0);
    if (max > 0) {
      setWidth('bar-rent', (netRent[stay] / max) * 100);
      setWidth('bar-buy', (netBuy[stay] / max) * 100);
    } else {
      setWidth('bar-rent', 0); setWidth('bar-buy', 0);
    }
  }

  document.querySelectorAll('#rent-vs-buy-form input').forEach(function (input) {
    input.addEventListener('input', run);
  });
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
  // Thousand separators on blur only, so the cursor stays stable while typing.
  document.querySelectorAll('#rent-vs-buy-form input[type="number"]').forEach(function (input) {
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
    copyResults([['Verdict', 'rent-verdict'], ['Breakeven year', 'breakeven-year'],
      ['Monthly cost of owning', 'buy-monthly'], ['Net cost of buying', 'net-buy-cost'],
      ['Net cost of renting', 'net-rent-cost']],
      'Rent vs Buy Calculator');
  });
  var printBtn = document.getElementById('print-results');
  if (printBtn) printBtn.addEventListener('click', function () {
    if (typeof window !== 'undefined' && window.print) window.print();
  });
  run();
})();
