/* ============================================================
   commission.js — pure, deterministic commission math.
   All deductions are % of Gross GCI (per Phase 2 architecture §6).
   No side effects. No storage access.
   ============================================================ */

window.App = window.App || {};

App.commission = (function () {
  "use strict";

  const num  = App.util.num;
  const clamp = App.util.clamp;

  // Gross GCI = salePrice × commissionRate / 100.
  // Returns 0 if either input is missing or non-positive.
  function grossGCI(deal) {
    if (!deal) return 0;
    const price = num(deal.salePrice);
    const rate  = num(deal.commissionRate);
    if (price <= 0 || rate <= 0) return 0;
    return price * (rate / 100);
  }

  // Individual deduction (in dollars).
  function teamCut(deal)     { return grossGCI(deal) * (num(deal && deal.teamSplit)    / 100); }
  function brokerageCut(deal){ return grossGCI(deal) * (num(deal && deal.brokerageFee) / 100); }
  function referralCut(deal) { return grossGCI(deal) * (num(deal && deal.referralFee)  / 100); }
  function taxCut(deal)      { return grossGCI(deal) * (num(deal && deal.taxReserve)   / 100); }

  // Net GCI = Gross - all deductions, floored at 0 (never negative).
  function netGCI(deal) {
    const gross = grossGCI(deal);
    if (gross <= 0) return 0;
    const total = teamCut(deal) + brokerageCut(deal) + referralCut(deal) + taxCut(deal);
    return Math.max(0, gross - total);
  }

  // Weighted GCI = Gross × probability / 100.
  function weightedGCI(deal) {
    if (!deal) return 0;
    const prob = clamp(num(deal.probability), 0, 100);
    return grossGCI(deal) * (prob / 100);
  }

  // Detailed breakdown for the deal detail view.
  function breakdown(deal) {
    const gross = grossGCI(deal);
    const team = teamCut(deal);
    const broker = brokerageCut(deal);
    const referral = referralCut(deal);
    const tax = taxCut(deal);
    const net = Math.max(0, gross - team - broker - referral - tax);
    return {
      salePrice:      num(deal && deal.salePrice),
      commissionRate: num(deal && deal.commissionRate),
      gross:          gross,
      deductions: {
        teamSplitPct:    num(deal && deal.teamSplit),
        teamSplitAmt:    team,
        brokerageFeePct: num(deal && deal.brokerageFee),
        brokerageFeeAmt: broker,
        referralFeePct:  num(deal && deal.referralFee),
        referralFeeAmt:  referral,
        taxReservePct:   num(deal && deal.taxReserve),
        taxReserveAmt:   tax,
        totalPct:        num(deal && deal.teamSplit) + num(deal && deal.brokerageFee)
                       + num(deal && deal.referralFee) + num(deal && deal.taxReserve),
        totalAmt:        team + broker + referral + tax
      },
      net:      net,
      weighted: weightedGCI(deal),
      probability: clamp(num(deal && deal.probability), 0, 100)
    };
  }

  return {
    grossGCI,
    netGCI,
    weightedGCI,
    teamCut, brokerageCut, referralCut, taxCut,
    breakdown
  };
})();

