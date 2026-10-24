/* ROI Calculator: total profit over a hold period = cash flow collected +
   net sale proceeds - cash invested, where net sale proceeds = value at sale
   - remaining loan balance - selling costs. Total ROI = profit / cash
   invested; annualized ROI is the geometric yearly rate over the hold.
   Appreciation, rent and expenses compound yearly; the mortgage payment
   stays fixed. DOM-stub-safe: only querySelector, querySelectorAll and
   getElementById, guarded style and setAttribute, one delegated listener on
   the form. The year table is built as one innerHTML string, never with
   created nodes. */
(function () {
  var form = document.querySelector('#roi-form');
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
  var LABELS = { 'purchase-price': 'Purchase price', 'down-payment': 'Down payment (USD)',
    'down-percent-input': 'Down payment (%)', 'interest-rate': 'Mortgage rate',
    'loan-years': 'Loan term', 'monthly-rent': 'Monthly rent', 'vacancy-rate': 'Vacancy rate',
    'monthly-expenses': 'Monthly operating expenses', 'appreciation-rate': 'Appreciation',
    'hold-years': 'Hold period', 'selling-rate': 'Selling costs', 'closing-costs': 'Closing costs',
    'rent-growth': 'Rent growth', 'expense-growth': 'Expense growth' };
  var OUTPUTS = ['total-roi', 'hero-profit', 'hero-annual', 'tile-profit',
    'tile-invested', 'tile-cf', 'tile-appreciation', 'tile-paydown', 'tile-equity',
    'row-purchase', 'row-value', 'row-balance', 'row-equity', 'row-selling-out',
    'row-net', 'row-down', 'row-closing-out', 'row-invested', 'row-cf-out',
    'row-appreciation-out', 'row-paydown-out', 'row-profit', 'row-roi', 'row-annual',
    'lg-cf', 'lg-appreciation', 'lg-paydown'];
  // Fill an empty down payment from the other down-payment field, so clearing
  // one value to retype it never blocks the whole result. Never overwrites a
  // value the user typed, and never refills the field they are typing in.
  function deriveDown() {
    var priceEl = document.getElementById('purchase-price');
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
    var price = num('purchase-price');
    var down = num('down-payment');
    var rate = num('interest-rate');
    var years = num('loan-years');
    var rent = num('monthly-rent');
    var vacancy = num('vacancy-rate');
    var expenses = num('monthly-expenses');
    var appr = num('appreciation-rate');
    var hold = num('hold-years');
    var sellPct = num('selling-rate');
    var closing = num('closing-costs');
    var rentGrowth = num('rent-growth');
    var expGrowth = num('expense-growth');
    var ok = valid(price, 0, 1e12) && price > 0 && valid(down, 0, price) &&
      valid(rate, 0, 100) && valid(years, 1, 50) && valid(rent, 0, 1e12) &&
      valid(vacancy, 0, 100) && valid(expenses, 0, 1e12) &&
      valid(appr, -50, 100) && valid(hold, 1, 30) && valid(sellPct, 0, 100) &&
      valid(closing, 0, 1e12) && valid(rentGrowth, -50, 100) && valid(expGrowth, -50, 100);
    // Empty fields are invalid, not zero.
    var required = ['purchase-price', 'down-payment', 'down-percent-input', 'interest-rate',
      'loan-years', 'monthly-rent', 'vacancy-rate', 'monthly-expenses', 'appreciation-rate',
      'hold-years', 'selling-rate', 'closing-costs', 'rent-growth', 'expense-growth'];
    for (var ri = 0; ri < required.length; ri++) {
      var rel = document.getElementById(required[ri]);
      if (!rel || rel.value === '') { ok = false; break; }
    }
    if (!ok) {
      set('total-roi', 'Check inputs');
      OUTPUTS.forEach(function (id) { if (id !== 'total-roi') set(id, '—'); });
      var problems = [];
      var checks = [
        ['purchase-price', price], ['down-payment', down],
        ['down-percent-input', num('down-percent-input')], ['interest-rate', rate],
        ['loan-years', years], ['monthly-rent', rent], ['vacancy-rate', vacancy],
        ['monthly-expenses', expenses], ['appreciation-rate', appr], ['hold-years', hold],
        ['selling-rate', sellPct], ['closing-costs', closing],
        ['rent-growth', rentGrowth], ['expense-growth', expGrowth]
      ];
      checks.forEach(function (c) {
        var el = document.getElementById(c[0]);
        if (!el || el.value === '') { problems.push(LABELS[c[0]] + ' is empty.'); return; }
        if (c[0] === 'purchase-price' && !(c[1] > 0 && c[1] <= 1e12)) { problems.push('Purchase price must be above $0.'); return; }
        if (c[0] === 'down-payment') {
          if (price > 0 && c[1] > price) problems.push('Down payment (USD) exceeds the purchase price.');
          else if (price > 0 && c[1] < 0) problems.push('Down payment (USD) is out of range.');
          return;
        }
        var lo = (c[0] === 'loan-years' || c[0] === 'hold-years') ? 1 : (c[0] === 'appreciation-rate' || c[0] === 'rent-growth' || c[0] === 'expense-growth') ? -50 : 0;
        var hi = (c[0] === 'interest-rate' || c[0] === 'vacancy-rate' || c[0] === 'selling-rate' || c[0] === 'down-percent-input') ? 100 : (c[0] === 'loan-years' ? 50 : (c[0] === 'hold-years' ? 30 : 1e12));
        if (c[0] === 'appreciation-rate' || c[0] === 'rent-growth' || c[0] === 'expense-growth') hi = 100;
        if (!(c[1] >= lo && c[1] <= hi)) problems.push(LABELS[c[0]] + ' is out of range.');
      });
      var message = problems.length ? problems.join(' ') : 'Check the values: price above $0, down payment within the price, rates 0–100%, hold 1–30 years, amounts 0 or more, and no field left empty.';
      set('validation-note', message);
      set('roi-validation', message);
      set('sticky-value', '—');
      set('hidden-rows-note', '');
      hideRow('result-body', true); hideRow('result-empty', false);
      var tableEl = document.getElementById('year-table-body');
      if (tableEl) tableEl.innerHTML = '';
      setWidth('bar-cf', 0); setWidth('bar-appreciation', 0); setWidth('bar-paydown', 0);
      return;
    }
    set('validation-note', '');
    set('roi-validation', '');
    hideRow('result-body', false); hideRow('result-empty', true);
    var loan = price - down;
    var r = rate / 100 / 12;
    var n = years * 12;
    var pi = r === 0 ? loan / n : loan * r * Math.pow(1 + r, n) / (Math.pow(1 + r, n) - 1);
    var balanceAfter = function (m) {
      if (r === 0) return loan - pi * m;
      return loan * Math.pow(1 + r, m) - pi * (Math.pow(1 + r, m) - 1) / r;
    };
    var totalCf = 0;
    var rowsHtml = '';
    var wholeYears = Math.floor(hold);
    for (var y = 1; y <= wholeYears; y++) {
      var rentY = rent * Math.pow(1 + rentGrowth / 100, y - 1);
      var expY = expenses * Math.pow(1 + expGrowth / 100, y - 1);
      var cfY = 12 * (rentY * (1 - vacancy / 100) - pi - expY);
      totalCf += cfY;
      var valueY = price * Math.pow(1 + appr / 100, y);
      var balY = balanceAfter(12 * y);
      rowsHtml += '<tr><td>' + y + '</td><td>' + usd(valueY) + '</td><td>' + usd(balY) + '</td><td>' + usd(valueY - balY) + '</td><td>' + negUsd(cfY) + '</td></tr>';
    }
    // A fractional final year still counts its cash flow in the totals.
    if (hold > wholeYears) {
      var frac = hold - wholeYears;
      var rentF = rent * Math.pow(1 + rentGrowth / 100, wholeYears);
      var expF = expenses * Math.pow(1 + expGrowth / 100, wholeYears);
      totalCf += 12 * frac * (rentF * (1 - vacancy / 100) - pi - expF);
    }
    var value = price * Math.pow(1 + appr / 100, hold);
    var balance = balanceAfter(12 * hold);
    var equity = value - balance;
    var selling = value * sellPct / 100;
    var net = value - balance - selling;
    var invested = down + closing;
    var apprGain = value - price;
    var paydown = loan - balance;
    var profit = totalCf + net - invested;
    var roi = invested > 0 ? profit / invested * 100 : null;
    var annual = (invested > 0 && (1 + profit / invested) > 0)
      ? (Math.pow(1 + profit / invested, 1 / hold) - 1) * 100 : null;
    set('total-roi', roi === null ? '—' : pct(roi));
    set('hero-profit', negUsd(profit));
    set('hero-annual', annual === null ? '—' : pct(annual));
    set('tile-profit', negUsd(profit));
    set('tile-invested', usd(invested));
    set('tile-cf', negUsd(totalCf));
    set('tile-appreciation', negUsd(apprGain));
    set('tile-paydown', negUsd(paydown));
    set('tile-equity', usd(equity));
    set('row-purchase', usd(price));
    set('row-value', usd(value));
    set('row-balance', usd(balance));
    set('row-equity', usd(equity));
    set('row-selling-out', selling === 0 ? usd(0) : usd(selling));
    set('row-net', usd(net));
    set('row-down', usd(down));
    set('row-closing-out', usd(closing));
    set('row-invested', usd(invested));
    set('row-cf-out', negUsd(totalCf));
    set('row-appreciation-out', negUsd(apprGain));
    set('row-paydown-out', negUsd(paydown));
    set('row-profit', negUsd(profit));
    set('row-roi', roi === null ? '—' : pct(roi));
    set('row-annual', annual === null ? '—' : pct(annual));
    set('lg-cf', negUsd(totalCf));
    set('lg-appreciation', negUsd(apprGain));
    set('lg-paydown', negUsd(paydown));
    var share = function (v) {
      if (profit <= 0) return 0;
      return Math.max(0, Math.min(100, v / profit * 100));
    };
    setWidth('bar-cf', share(totalCf));
    setWidth('bar-appreciation', share(apprGain));
    setWidth('bar-paydown', share(paydown));
    set('sticky-value', roi === null ? '—' : pct(roi));
    var table = document.getElementById('year-table-body');
    if (table) table.innerHTML = rowsHtml;
    // Hide $0 rows; everything else stays visible.
    hideRow('row-selling', selling === 0);
    hideRow('row-closing', closing === 0);
    hideRow('row-cf', totalCf === 0);
    hideRow('row-appreciation', apprGain === 0);
    hideRow('row-paydown', paydown === 0);
    var hidden = [];
    if (selling === 0) hidden.push('Selling costs');
    if (closing === 0) hidden.push('Closing costs');
    if (totalCf === 0) hidden.push('Total cash flow');
    if (apprGain === 0) hidden.push('Appreciation gain');
    if (paydown === 0) hidden.push('Loan paydown');
    set('hidden-rows-note', hidden.length ? 'Not shown because $0: ' + hidden.join(', ') + '.' : '');
    syncDownPct();
  }
  document.querySelectorAll('#roi-form input').forEach(function (input) {
    input.addEventListener('input', run);
  });
  // Down payment $ and % stay in sync; the % field never overwrites itself
  // while the user is typing in it.
  function syncDownPct() {
    var pctEl = document.getElementById('down-percent-input');
    if (!pctEl) return;
    if (typeof document !== 'undefined' && document.activeElement === pctEl) return;
    var priceEl = document.getElementById('purchase-price');
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
      var priceEl = document.getElementById('purchase-price');
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
    copyResults([['Total profit', 'tile-profit'], ['Total ROI', 'total-roi'],
      ['Annualized ROI', 'row-annual'], ['Total cash flow', 'tile-cf'],
      ['Equity at sale', 'tile-equity'], ['Net sale proceeds', 'row-net']],
      'ROI Calculator');
  });
  var printBtn = document.getElementById('print-results');
  if (printBtn) printBtn.addEventListener('click', function () {
    if (typeof window !== 'undefined' && window.print) window.print();
  });
  run();
})();
