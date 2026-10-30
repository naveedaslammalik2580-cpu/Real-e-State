// Commission calculator — scoped to #commission-form only.
// Uses only document.querySelector, querySelectorAll and getElementById so the
// repo's DOM-stub tests can execute it. No shared-script logic lives here.
//
// Order of operations (shown on the page): referral and franchise fees come
// off the TOTAL commission first, each calculated on that total. The remainder
// is split between the listing side and the buyer side; your side depends on
// your role, then your agent split and the transaction fee apply to your side.
(function () {
  var form = document.querySelector('#commission-form');
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
  function hideRow(id, hide) {
    var el = document.getElementById(id);
    if (el) el.hidden = hide;
  }
  function setVisible(id, showIt) {
    var el = document.getElementById(id);
    if (el) el.hidden = !showIt;
  }
  function neg(n) {
    return '\u2212' + usd(n);
  }
  function valid(n, a, b) {
    return Number.isFinite(n) && n >= a && n <= b;
  }
  function role() {
    var el = document.getElementById('agent-role');
    var v = el && el.value ? el.value : 'both';
    return v === 'listing' || v === 'buyer' ? v : 'both';
  }

  var OUTPUTS = ['commission-total',
    'listing-side', 'buyer-side', 'your-side-gross',
    'commission-agent', 'breakdown-broker', 'breakdown-fee',
    'breakdown-net', 'commission-net',
    'selling-cost', 'seller-net', 'seller-payoff', 'breakdown-deductions'];

  function run() {
    var price = num('sale-price'), rate = num('commission-rate'),
      listingShare = num('listing-share'), split = num('agent-split'),
      referralPct = num('referral-fee'), franchisePct = num('franchise-fee'),
      fee = num('transaction-fee'), otherPct = num('other-closing-costs'),
      payoff = num('mortgage-payoff');

    // Named validation: every problem is reported by field name in the panel.
    // Empty fields are invalid, not zero. Labels omit units so the message
    // reads exactly like the example: "Property sale price is empty."
    var FIELDS = [
      { id: 'sale-price', label: 'Property sale price', value: price, max: 1e12 },
      { id: 'commission-rate', label: 'Total commission rate', value: rate, max: 100 },
      { id: 'listing-share', label: 'Listing side share', value: listingShare, max: 100 },
      { id: 'agent-split', label: 'Your commission split', value: split, max: 100 },
      { id: 'referral-fee', label: 'Referral fee', value: referralPct, max: 100 },
      { id: 'franchise-fee', label: 'Franchise / royalty fee', value: franchisePct, max: 100 },
      { id: 'transaction-fee', label: 'Transaction fee', value: fee, max: 1e12 },
      { id: 'other-closing-costs', label: 'Other seller closing costs', value: otherPct, max: 100 },
      { id: 'mortgage-payoff', label: 'Mortgage payoff', value: payoff, max: 1e12 }
    ];
    var problems = [];
    for (var fi = 0; fi < FIELDS.length; fi++) {
      var f = FIELDS[fi];
      var fel = document.getElementById(f.id);
      if (!fel || fel.value === '') problems.push(f.label + ' is empty.');
      else if (!valid(f.value, 0, f.max)) problems.push(f.label + (f.max === 100 ? ' must be 0–100%.' : ' must be 0 or more.'));
    }
    var ok = problems.length === 0;

    if (!ok) {
      set('commission-total', problems[0]);
      set('result-empty', problems.join(' '));
      OUTPUTS.slice(1).forEach(function (id) { set(id, '—'); });
      set('validation-note', 'Check the values: rates and shares must be 0–100%, amounts 0 or more, and no field left empty.');
      set('lg-referral', '—'); set('lg-franchise', '—'); set('lg-broker', '—');
      set('sticky-value', '—');
      hideRow('result-body', true); hideRow('result-empty', false);
      setWidth('bd-referral', 0); setWidth('bd-franchise', 0);
      setWidth('bd-yours', 0); setWidth('bd-broker', 0);
      return;
    }
    set('validation-note', '');
    hideRow('result-body', false); hideRow('result-empty', true);

    var total = price * rate / 100;
    var referral = total * referralPct / 100;
    var franchise = total * franchisePct / 100;
    var splittable = total - referral - franchise;
    var listingSide = splittable * listingShare / 100;
    var buyerSide = splittable - listingSide;
    var r = role();
    var yourSide = r === 'listing' ? listingSide : r === 'buyer' ? buyerSide : splittable;
    var yourShare = yourSide * split / 100;
    var brokerShare = yourSide - yourShare;
    var net = yourShare - fee;
    var otherCosts = price * otherPct / 100;
    var sellingCost = total + otherCosts;
    var sellerNet = price - total - otherCosts - payoff;

    set('commission-total', usd(total));
    set('listing-side', usd(listingSide));
    set('buyer-side', usd(buyerSide));
    set('your-side-gross', usd(yourSide));
    set('commission-agent', usd(yourShare));
    set('breakdown-broker', neg(brokerShare));
    set('breakdown-fee', neg(fee));
    set('breakdown-net', usd(net));
    set('seller-payoff', usd(payoff));
    set('commission-net', usd(net));
    set('selling-cost', usd(sellingCost));
    set('seller-net', usd(sellerNet));

    // Legend shows only segments above $0; the breakdown hides its
    // referral/franchise row when both are $0. The sticky bar shows Your net.
    set('lg-referral', usd(referral)); set('lg-franchise', usd(franchise));
    set('lg-broker', usd(brokerShare));
    setVisible('lg-item-referral', referral > 0);
    setVisible('lg-item-franchise', franchise > 0);
    setVisible('lg-item-yours', yourShare > 0);
    setVisible('lg-item-broker', brokerShare > 0);
    var deductions = referral + franchise;
    setVisible('breakdown-deductions-row', deductions > 0);
    if (deductions > 0) set('breakdown-deductions', neg(deductions));
    var showSeller = otherCosts > 0 || payoff > 0;
    var sellerViewEl = document.getElementById('seller-view');
    if (sellerViewEl && sellerViewEl.hidden && showSeller) {
      hideRow('seller-details', true);
      var tg = document.getElementById('seller-toggle');
      if (tg && tg.setAttribute) tg.setAttribute('aria-expanded', 'false');
    }
    hideRow('seller-helper', showSeller);
    hideRow('seller-view', !showSeller);
    hideRow('seller-payoff-row', payoff <= 0);
    set('sticky-value', usd(net));

    if (total > 0) {
      setWidth('bd-referral', (referral / total) * 100);
      setWidth('bd-franchise', (franchise / total) * 100);
      setWidth('bd-yours', (yourShare / total) * 100);
      setWidth('bd-broker', (brokerShare / total) * 100);
    } else {
      setWidth('bd-referral', 0); setWidth('bd-franchise', 0);
      setWidth('bd-yours', 0); setWidth('bd-broker', 0);
    }
  }

  document.querySelectorAll('#commission-form input').forEach(function (input) {
    input.addEventListener('input', run);
  });
  var roleEl = document.getElementById('agent-role');
  if (roleEl) roleEl.addEventListener('change', run);
  // Slider sync by delegation on the form (keeps the per-input listeners above intact).
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
  // NOTE: no thousand-separator rewriting here, on load or on blur. These
  // are type="number" fields, and a browser erases a comma-formatted value
  // ("450,000" is not a valid floating-point number), which used to empty
  // the sale price on first load and on blur. Typed values are left alone;
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
    copyResults([['Total commission', 'commission-total'], ['Your net', 'commission-net'],
      ['Your share', 'commission-agent'], ['Net to seller', 'seller-net']],
      'Real Estate Commission Calculator');
  });
  var sellerToggle = document.getElementById('seller-toggle');
  if (sellerToggle) sellerToggle.addEventListener('click', function () {
    var details = document.getElementById('seller-details');
    if (!details) return;
    var open = details.hidden;
    details.hidden = !open;
    sellerToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  var printBtn = document.getElementById('print-results');
  if (printBtn) printBtn.addEventListener('click', function () {
    if (typeof window !== 'undefined' && window.print) window.print();
  });
  run();
})();
