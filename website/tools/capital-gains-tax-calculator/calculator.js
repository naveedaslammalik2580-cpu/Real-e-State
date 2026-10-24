/* Capital Gains Tax Calculator: gain = (sale - selling costs) - (purchase +
   improvements + buying costs - depreciation). The depreciation slice is
   never excludable: it is recaptured first at the ordinary rate capped at
   25%. The primary-residence exclusion ($250K single / $500K joint) applies
   only to the remaining gain, only for a primary residence meeting the
   2-of-5-year test (so never on a short-term sale). The rest is taxed at
   long-term rates, or at ordinary rates when held a year or less. NIIT
   (3.8%) and state tax apply to the taxable gain when selected. DOM-stub-safe:
   only querySelector, querySelectorAll and getElementById, guarded style and
   setAttribute, one delegated listener on the form. */
(function () {
  var form = document.querySelector('#capital-gains-tax-form');
  if (!form) return;
  function num(id) {
    var el = document.getElementById(id);
    return el ? Number(String(el.value).replace(/,/g, '').trim()) : 0;
  }
  function str(id) {
    var el = document.getElementById(id);
    return el ? String(el.value) : '';
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
  var LABELS = { 'sale-price': 'Sale price', 'purchase-price': 'Purchase price',
    'improvements': 'Capital improvements', 'selling-rate': 'Selling costs',
    'depreciation': 'Depreciation claimed', 'years-lived': 'Years lived in as main home',
    'buying-costs': 'Buying costs', 'ordinary-rate': 'Ordinary income tax rate',
    'state-rate': 'State tax rate' };
  var OUTPUTS = ['total-tax', 'net-proceeds', 'tile-gain', 'tile-exclusion',
    'tile-taxable', 'tile-federal', 'tile-effective', 'tile-net', 'row-sale',
    'row-selling', 'row-realized', 'row-purchase', 'row-improvements', 'row-buying',
    'row-depreciation-out', 'row-basis', 'row-gain', 'row-exclusion-out',
    'row-recapture-out', 'row-taxable', 'row-recapture-tax-out', 'row-gain-tax',
    'row-niit-out', 'row-state-out', 'row-total-tax', 'row-net', 'lg-excluded',
    'lg-kept', 'lg-tax'];
  function run() {
    var sale = num('sale-price');
    var purchase = num('purchase-price');
    var improv = num('improvements');
    var sellPct = num('selling-rate');
    var depr = num('depreciation');
    var years = num('years-lived');
    var buying = num('buying-costs');
    var ordinary = num('ordinary-rate');
    var state = num('state-rate');
    var use = str('property-use');
    var filing = str('filing-status');
    var holding = str('holding');
    var ltcg = num('ltcg-rate');
    var niitApplies = str('niit') === 'yes';
    var ok = valid(sale, 0, 1e12) && sale > 0 && valid(purchase, 0, 1e12) &&
      valid(improv, 0, 1e12) && valid(sellPct, 0, 100) && valid(depr, 0, 1e12) &&
      valid(years, 0, 50) && valid(buying, 0, 1e12) && valid(ordinary, 0, 100) &&
      valid(state, 0, 100) && (ltcg === 0 || ltcg === 15 || ltcg === 20);
    // Empty fields are invalid, not zero.
    var required = ['sale-price', 'purchase-price', 'improvements', 'selling-rate',
      'depreciation', 'years-lived', 'buying-costs', 'ordinary-rate', 'state-rate'];
    for (var ri = 0; ri < required.length; ri++) {
      var rel = document.getElementById(required[ri]);
      if (!rel || rel.value === '') { ok = false; break; }
    }
    if (!ok) {
      var problems = [];
      var checks = [
        ['sale-price', sale], ['purchase-price', purchase], ['improvements', improv],
        ['selling-rate', sellPct], ['depreciation', depr], ['years-lived', years],
        ['buying-costs', buying], ['ordinary-rate', ordinary], ['state-rate', state]
      ];
      checks.forEach(function (c) {
        var el = document.getElementById(c[0]);
        if (!el || el.value === '') { problems.push(LABELS[c[0]] + ' is empty.'); return; }
        if (c[0] === 'sale-price' && !(c[1] > 0 && c[1] <= 1e12)) { problems.push('Sale price must be above $0.'); return; }
        var lo = 0;
        var hi = (c[0] === 'selling-rate' || c[0] === 'ordinary-rate' || c[0] === 'state-rate') ? 100 : (c[0] === 'years-lived' ? 50 : 1e12);
        if (!(c[1] >= lo && c[1] <= hi)) problems.push(LABELS[c[0]] + ' is out of range.');
      });
      var message = problems.length ? problems.join(' ') : 'Check the values: sale price above $0, rates 0–100%, years 0–50, amounts 0 or more, and no field left empty.';
      set('total-tax', problems.length ? problems[0] : message);
      OUTPUTS.forEach(function (id) { if (id !== 'total-tax') set(id, '—'); });
      set('validation-note', message);
      set('cgt-validation', message);
      set('sticky-value', '—');
      set('cgt-note', '');
      hideRow('result-body', true); hideRow('result-empty', false);
      setWidth('bar-excluded', 0); setWidth('bar-kept', 0); setWidth('bar-tax', 0);
      return;
    }
    set('validation-note', '');
    set('cgt-validation', '');
    hideRow('result-body', false); hideRow('result-empty', true);
    var isLong = holding === 'long';
    var selling = sale * sellPct / 100;
    var realized = sale - selling;
    var basis = purchase + improv + buying - depr;
    var gain = realized - basis;
    var recap = gain > 0 ? Math.min(depr, gain) : 0;
    var cap = filing === 'mfj' ? 500000 : 250000;
    var exclusion = (use === 'primary' && isLong && years >= 2 && gain > 0)
      ? Math.min(cap, Math.max(gain - recap, 0)) : 0;
    var remaining = gain > 0 ? Math.max(gain - recap - exclusion, 0) : 0;
    var recapTax = (isLong && gain > 0) ? recap * Math.min(ordinary, 25) / 100 : 0;
    var gainTax = gain > 0 ? (isLong ? remaining * ltcg / 100 : (recap + remaining) * ordinary / 100) : 0;
    var taxableBase = gain > 0 ? recap + remaining : 0;
    var niit = (niitApplies && gain > 0) ? taxableBase * 3.8 / 100 : 0;
    var stateTax = gain > 0 ? taxableBase * state / 100 : 0;
    var federal = recapTax + gainTax;
    var total = federal + niit + stateTax;
    var net = realized - total;
    var kept = taxableBase - total;
    set('total-tax', usd(total));
    set('net-proceeds', usd(net));
    set('tile-gain', negUsd(gain));
    set('tile-exclusion', usd(exclusion));
    set('tile-taxable', usd(taxableBase));
    set('tile-federal', usd(federal));
    set('tile-effective', gain > 0 ? pct(total / gain * 100) : '—');
    set('tile-net', usd(net));
    set('row-sale', usd(sale));
    set('row-selling', selling === 0 ? usd(0) : '−' + usd(selling));
    set('row-realized', usd(realized));
    set('row-purchase', usd(purchase));
    set('row-improvements', usd(improv));
    set('row-buying', usd(buying));
    set('row-depreciation-out', depr === 0 ? usd(0) : '−' + usd(depr));
    set('row-basis', usd(basis));
    set('row-gain', negUsd(gain));
    set('row-exclusion-out', exclusion === 0 ? usd(0) : '−' + usd(exclusion));
    set('row-recapture-out', usd(recap));
    set('row-taxable', usd(taxableBase));
    set('row-recapture-tax-out', usd(recapTax));
    set('row-gain-tax-label', isLong ? 'Long-term capital gains tax' : 'Short-term gain (ordinary rates)');
    set('row-gain-tax', usd(gainTax));
    set('row-niit-out', usd(niit));
    set('row-state-out', usd(stateTax));
    set('row-total-tax', usd(total));
    set('row-net', usd(net));
    set('lg-excluded', usd(exclusion));
    set('lg-kept', negUsd(kept));
    set('lg-tax', usd(total));
    var share = function (v) {
      if (gain <= 0) return 0;
      return Math.max(0, Math.min(100, v / gain * 100));
    };
    setWidth('bar-excluded', share(exclusion));
    setWidth('bar-kept', share(kept));
    setWidth('bar-tax', share(total));
    set('sticky-value', usd(total));
    set('cgt-note', (use === 'primary' && !(isLong && years >= 2))
      ? 'No primary-residence exclusion: the 2-year ownership and use test is not met.'
      : '');
    // All breakdown rows always show, even at $0, so the panel never
    // contradicts itself with a "not shown" note.
  }
  document.querySelectorAll('#capital-gains-tax-form input').forEach(function (input) {
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
  // Segmented controls: each button sets its group's hidden value.
  document.querySelectorAll('.seg-control button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var target = btn.getAttribute ? btn.getAttribute('data-target') : '';
      var val = btn.getAttribute ? btn.getAttribute('data-value') : '';
      var hidden = target ? document.getElementById(target) : null;
      if (hidden) hidden.value = val;
      var group = btn.parentNode;
      if (group && group.querySelectorAll) {
        group.querySelectorAll('button').forEach(function (b) {
          setAttr(b, 'aria-pressed', b === btn ? 'true' : 'false');
        });
      }
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
    copyResults([['Total capital gain', 'tile-gain'], ['Exclusion applied', 'tile-exclusion'],
      ['Taxable gain', 'tile-taxable'], ['Federal tax', 'tile-federal'],
      ['Total tax', 'total-tax'], ['Net proceeds', 'net-proceeds']],
      'Capital Gains Tax Calculator');
  });
  var printBtn = document.getElementById('print-results');
  if (printBtn) printBtn.addEventListener('click', function () {
    if (typeof window !== 'undefined' && window.print) window.print();
  });
  run();
})();
