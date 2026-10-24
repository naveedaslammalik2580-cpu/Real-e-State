// NOI Calculator — net operating income for a rental property: effective
// income minus operating expenses, before mortgage, depreciation and income
// tax. The mortgage never appears in NOI. DOM-stub-safe: only
// document.querySelector, querySelectorAll and getElementById, guarded style,
// one delegated listener on the form. No thousand-separator rewriting: these
// are type="number" fields and a browser erases comma-formatted values.
(function () {
  var form = document.querySelector('#noi-form');
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
  function hideRow(id, hide) {
    var el = document.getElementById(id);
    if (el) el.hidden = hide;
  }
  function usd(n) {
    return Number.isFinite(n)
      ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(n)
      : '—';
  }
  function negUsd(n) {
    return n < 0 ? '−' + usd(-n) : usd(n);
  }
  function pct(n) {
    return (n < 0 ? '−' : '') + Math.abs(n).toFixed(2) + '%';
  }
  function valid(n, a, b) {
    return Number.isFinite(n) && n >= a && n <= b;
  }
  var OUTPUTS = ['noi-monthly', 'tile-monthly', 'tile-effective', 'tile-expenses',
    'tile-ratio', 'row-gross-rent', 'row-vacancy-loss', 'row-other-income',
    'row-effective', 'row-tax', 'row-insurance', 'row-maintenance',
    'row-management', 'row-hoa', 'row-total-expenses', 'row-noi',
    'lg-tax', 'lg-ins', 'lg-maintenance', 'lg-management', 'lg-hoa'];
  function run() {
    var rent = num('monthly-rent'), vacancy = num('vacancy-rate'),
      other = num('other-income'), tax = num('property-tax'),
      ins = num('home-insurance'), maint = num('maintenance-cost'),
      mgmtPct = num('management-rate'), hoa = num('hoa-other');
    // Named validation: the verdict shows the first problem, the validation
    // boxes list them all. Empty fields are invalid, not zero.
    var problems = [];
    function checkField(id, name, lo, hi, rangeText) {
      var el = document.getElementById(id);
      if (!el || el.value === '') { problems.push(name + ' is empty.'); return; }
      if (!valid(num(id), lo, hi)) problems.push(name + ' ' + rangeText);
    }
    checkField('monthly-rent', 'Monthly rent', 0, 1e12, 'must be 0 or more.');
    checkField('vacancy-rate', 'Vacancy rate', 0, 100, 'must be between 0% and 100%.');
    checkField('other-income', 'Other income', 0, 1e12, 'must be 0 or more.');
    checkField('property-tax', 'Property tax', 0, 1e12, 'must be 0 or more.');
    checkField('home-insurance', 'Home insurance', 0, 1e12, 'must be 0 or more.');
    checkField('maintenance-cost', 'Maintenance & repairs', 0, 1e12, 'must be 0 or more.');
    checkField('management-rate', 'Management fee', 0, 100, 'must be between 0% and 100%.');
    checkField('hoa-other', 'HOA & other costs', 0, 1e12, 'must be 0 or more.');
    if (problems.length) {
      set('noi-annual', problems[0]);
      OUTPUTS.forEach(function (id) { set(id, '—'); });
      set('validation-note', problems.join(' '));
      set('noi-validation', problems.join(' '));
      set('sticky-value', '—');
      hideRow('result-body', true); hideRow('result-empty', false);
      setWidth('bar-tax', 0); setWidth('bar-ins', 0); setWidth('bar-maintenance', 0);
      setWidth('bar-management', 0); setWidth('bar-hoa', 0);
      return;
    }
    set('validation-note', '');
    set('noi-validation', '');
    hideRow('result-body', false); hideRow('result-empty', true);
    var gross = rent * 12;
    var vacancyLoss = gross * vacancy / 100;
    var effective = gross - vacancyLoss + other;
    var mgmt = effective * mgmtPct / 100;
    var totalExp = tax + ins + maint + mgmt + hoa;
    var noi = effective - totalExp;
    var monthly = noi / 12;
    var ratio = effective > 0 ? totalExp / effective * 100 : null;
    set('noi-annual', negUsd(noi));
    set('noi-monthly', negUsd(monthly));
    set('tile-monthly', negUsd(monthly));
    set('tile-effective', usd(effective));
    set('tile-expenses', usd(totalExp));
    set('tile-ratio', ratio === null ? '—' : pct(ratio));
    set('row-gross-rent', usd(gross));
    set('row-vacancy-loss', vacancyLoss === 0 ? usd(0) : '−' + usd(vacancyLoss));
    set('row-other-income', usd(other));
    set('row-effective', usd(effective));
    set('row-tax', usd(tax));
    set('row-insurance', usd(ins));
    set('row-maintenance', usd(maint));
    set('row-management', usd(mgmt));
    set('row-hoa', usd(hoa));
    set('row-total-expenses', usd(totalExp));
    set('row-noi', negUsd(noi));
    set('lg-tax', usd(tax));
    set('lg-ins', usd(ins));
    set('lg-maintenance', usd(maint));
    set('lg-management', usd(mgmt));
    set('lg-hoa', usd(hoa));
    var share = function (v) {
      if (totalExp <= 0) return 0;
      return Math.max(0, Math.min(100, v / totalExp * 100));
    };
    setWidth('bar-tax', share(tax));
    setWidth('bar-ins', share(ins));
    setWidth('bar-maintenance', share(maint));
    setWidth('bar-management', share(mgmt));
    setWidth('bar-hoa', share(hoa));
    set('sticky-value', negUsd(noi));
  }
  document.querySelectorAll('#noi-form input').forEach(function (input) {
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
    copyResults([['Annual NOI', 'noi-annual'], ['Monthly NOI', 'noi-monthly'],
      ['Effective income', 'tile-effective'], ['Total expenses', 'tile-expenses'],
      ['Expense ratio', 'tile-ratio']], 'NOI Calculator');
  });
  var printBtn = document.getElementById('print-results');
  if (printBtn) printBtn.addEventListener('click', function () {
    if (typeof window !== 'undefined' && window.print) window.print();
  });
  run();
})();
