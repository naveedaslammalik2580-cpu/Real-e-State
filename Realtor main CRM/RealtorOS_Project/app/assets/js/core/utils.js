/* ============================================================
   Realtor Pipeline & Commission OS
   util.js — shared helpers (dates, numbers, currency, IDs)
   Vanilla JS, browser + jsdom compatible.
   ============================================================ */

window.App = window.App || {};

App.util = (function () {
  "use strict";

  // ---------- IDS ----------

  function uid(prefix) {
    const time = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 6);
    return (prefix || "id") + "_" + time + "_" + rand;
  }

  // ---------- NUMBERS ----------

  // Safe non-negative number parse. Blank/NaN/negative -> 0.
  function num(x) {
    if (x === null || x === undefined || x === "") return 0;
    const n = parseFloat(x);
    if (!isFinite(n) || n < 0) return 0;
    return n;
  }

  // Number that CAN be negative (rare — for balances, deltas).
  function numSigned(x) {
    if (x === null || x === undefined || x === "") return 0;
    const n = parseFloat(x);
    return isFinite(n) ? n : 0;
  }

  function clamp(x, lo, hi) {
    x = numSigned(x);
    if (x < lo) return lo;
    if (x > hi) return hi;
    return x;
  }

  function sum(arr) {
    if (!Array.isArray(arr)) return 0;
    let t = 0;
    for (const v of arr) t += num(v);
    return t;
  }

  // ---------- DATES ----------
  // All dates are stored as "YYYY-MM-DD" (date) or ISO 8601 (datetime).
  // Lexical string comparison works correctly for both formats.

  function todayISO() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  function nowISO() {
    return new Date().toISOString();
  }

  // Parse "YYYY-MM-DD" to a local Date at midnight (avoids timezone drift).
  function parseISODate(iso) {
    if (!iso || typeof iso !== "string") return null;
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  function dateToISO(d) {
    if (!(d instanceof Date) || isNaN(d)) return null;
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  function addDaysISO(iso, n) {
    const d = parseISODate(iso);
    if (!d) return null;
    d.setDate(d.getDate() + n);
    return dateToISO(d);
  }

  function daysBetween(a, b) {
    const da = parseISODate(a);
    const db = parseISODate(b);
    if (!da || !db) return 0;
    const MS_PER_DAY = 86400000;
    return Math.round((db - da) / MS_PER_DAY);
  }

  function dateYear(iso) {
    if (!iso) return null;
    return Number(String(iso).slice(0, 4));
  }

  function inCurrentMonth(iso) {
    if (!iso) return false;
    return String(iso).slice(0, 7) === todayISO().slice(0, 7);
  }

  function inCurrentYear(iso) {
    if (!iso) return false;
    return dateYear(iso) === dateYear(todayISO());
  }

  function formatDate(iso, style) {
    const d = parseISODate(iso);
    if (!d) return "";
    // style: "short" | "medium" | "long" | "iso"
    if (style === "iso") return iso;
    const opts =
      style === "long"
        ? { year: "numeric", month: "long", day: "numeric" }
        : style === "short"
        ? { month: "short", day: "numeric" }
        : { year: "numeric", month: "short", day: "numeric" };
    try {
      return d.toLocaleDateString("en-US", opts);
    } catch (e) {
      return iso;
    }
  }

  // Human relative label: "Today", "Tomorrow", "In 3 days", "2 days ago"
  function relativeDayLabel(iso) {
    if (!iso) return "";
    const diff = daysBetween(todayISO(), iso);
    if (diff === 0) return "Today";
    if (diff === 1) return "Tomorrow";
    if (diff === -1) return "Yesterday";
    if (diff > 1 && diff <= 7) return "In " + diff + " days";
    if (diff < -1 && diff >= -7) return Math.abs(diff) + " days ago";
    return formatDate(iso);
  }

  // ---------- CURRENCY ----------

  const CURRENCY_META = {
    USD: { symbol: "$",  locale: "en-US" },
    EUR: { symbol: "€",  locale: "en-IE" },
    GBP: { symbol: "£",  locale: "en-GB" },
    CAD: { symbol: "C$", locale: "en-CA" },
    AUD: { symbol: "A$", locale: "en-AU" }
  };

  function formatCurrency(amount, currencyCode) {
    const code = currencyCode || "USD";
    const meta = CURRENCY_META[code] || CURRENCY_META.USD;
    const n = numSigned(amount);
    try {
      return new Intl.NumberFormat(meta.locale, {
        style: "currency",
        currency: code,
        maximumFractionDigits: 0
      }).format(n);
    } catch (e) {
      return meta.symbol + Math.round(n).toLocaleString();
    }
  }

  // Compact: $1.2K, $3.4M
  function formatCompact(amount, currencyCode) {
    const code = currencyCode || "USD";
    const meta = CURRENCY_META[code] || CURRENCY_META.USD;
    const n = numSigned(amount);
    const abs = Math.abs(n);
    let val, suffix;
    if (abs >= 1e9)      { val = n / 1e9; suffix = "B"; }
    else if (abs >= 1e6) { val = n / 1e6; suffix = "M"; }
    else if (abs >= 1e3) { val = n / 1e3; suffix = "K"; }
    else                 { val = n;       suffix = "";  }
    const rounded = suffix ? val.toFixed(val < 10 ? 2 : 1).replace(/\.?0+$/, "") : Math.round(val).toString();
    return meta.symbol + rounded + suffix;
  }

  function formatPercent(x, digits) {
    const n = numSigned(x);
    return n.toFixed(digits == null ? 0 : digits) + "%";
  }

  // Currency symbol lookup for display in inputs, etc.
  function currencySymbol(code) {
    return (CURRENCY_META[code] || CURRENCY_META.USD).symbol;
  }

  // ---------- STRINGS ----------

  function esc(s) {
    if (s === null || s === undefined) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function truncate(s, n) {
    if (!s) return "";
    s = String(s);
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  // ---------- ARRAYS ----------

  function groupBy(arr, keyFn) {
    const fn = typeof keyFn === "function" ? keyFn : (item) => item[keyFn];
    const out = {};
    for (const item of arr || []) {
      const k = fn(item);
      if (k === undefined || k === null || k === "") continue;
      (out[k] = out[k] || []).push(item);
    }
    return out;
  }

  function sortBy(arr, keyFn, desc) {
    const fn = typeof keyFn === "function" ? keyFn : (item) => item[keyFn];
    const copy = (arr || []).slice();
    copy.sort((a, b) => {
      const va = fn(a);
      const vb = fn(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (va < vb) return desc ? 1 : -1;
      if (va > vb) return desc ? -1 : 1;
      return 0;
    });
    return copy;
  }

  // ---------- PUBLIC API ----------

  return {
    uid,
    num, numSigned, clamp, sum,
    todayISO, nowISO, parseISODate, dateToISO, addDaysISO, daysBetween,
    dateYear, inCurrentMonth, inCurrentYear,
    formatDate, relativeDayLabel,
    formatCurrency, formatCompact, formatPercent, currencySymbol,
    esc, truncate,
    groupBy, sortBy,
    CURRENCY_META
  };
})();

