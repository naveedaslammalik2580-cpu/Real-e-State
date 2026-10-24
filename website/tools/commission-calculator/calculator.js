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
  function role() {
    var el = document.getElementById('agent-role');
    var v = el && el.value ? el.value : 'both';
    return v === 'listing' || v === 'buyer' ? v : 'both';
  }

  var OUTPUTS = ['commission-total', 'referral-amount', 'franchise-amount',
    'listing-side', 'buyer-side', 'your-side-gross', 'broker-share',
    'commission-agent', 'commission-fees', 'commission-net',
    'selling-cost', 'seller-net'];

  function run() {
    var price = num('sale-price'), rate = num('commission-rate'),
      listingShare = num('listing-share'), split = num('agent-split'),
      referralPct = num('referral-fee'), franchisePct = num('franchise-fee'),
      fee = num('transaction-fee'), otherPct = num('other-closing-costs'),
      payoff = num('mortgage-payoff');

    var ok = valid(price, 0, 1e12) && valid(rate, 0, 100) &&
      valid(listingShare, 0, 100) && valid(split, 0, 100) &&
      valid(referralPct, 0, 100) && valid(franchisePct, 0, 100) &&
      valid(fee, 0, 1e12) && valid(otherPct, 0, 100) && valid(payoff, 0, 1e12);

    if (!ok) {
      set('commission-total', 'Check inputs');
      OUTPUTS.slice(1).forEach(function (id) { set(id, '—'); });
      set('your-side-label', 'Your side');
      setWidth('bd-referral', 0); setWidth('bd-franchise', 0);
      setWidth('bd-yours', 0); setWidth('bd-broker', 0);
      return;
    }

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
    set('referral-amount', usd(referral));
    set('franchise-amount', usd(franchise));
    set('listing-side', usd(listingSide));
    set('buyer-side', usd(buyerSide));
    set('your-side-gross', usd(yourSide));
    set('broker-share', usd(brokerShare));
    set('commission-agent', usd(yourShare));
    set('commission-fees', usd(fee));
    set('commission-net', usd(net));
    set('selling-cost', usd(sellingCost));
    set('seller-net', usd(sellerNet));
    set('your-side-label', r === 'listing' ? 'Your side (listing side)'
      : r === 'buyer' ? 'Your side (buyer side)' : 'Your side (both sides)');

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
  run();
})();
