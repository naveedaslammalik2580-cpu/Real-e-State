/* ============================================================
   response-stats.js — how fast leads actually get worked.

   One definition of the four numbers an agency owner asks for, used by the
   Dashboard card (the signed-in agent) and by the Team page (per agent, and
   the team as a whole). Two copies of this arithmetic would eventually
   disagree, and a disagreement here looks like somebody is being accused of
   something.

   Everything is computed from contact rows the browser can already read -
   created_at, first_touched_at, assigned_to_id, next_follow_up - so there is
   no new query and no new permission. RLS has already decided which contacts
   are in the array; this only counts them.

   MEDIAN, not mean: one lead picked up three weeks late would drag a mean
   so far that the number stops describing a normal day.
   ============================================================ */
window.App = window.App || {};

App.responseStats = (function () {
  "use strict";

  const DAY_MS = 24 * 60 * 60 * 1000;
  const WINDOW_DAYS = 30;

  const ms = (value) => {
    if (!value) return null;
    const t = new Date(value).getTime();
    return Number.isFinite(t) ? t : null;
  };

  function median(values) {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  /**
   * The four numbers, over the last 30 days of NEW contacts.
   *
   * `todayIso` is passed in rather than read here so a caller (and a test)
   * decides what "today" means.
   */
  function compute(contacts, todayIso, nowMs) {
    const list = Array.isArray(contacts) ? contacts : [];
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const since = now - WINDOW_DAYS * DAY_MS;

    const recent = list.filter((c) => {
      const created = ms(c.createdAt);
      return created !== null && created >= since;
    });

    let touchedWithin24h = 0;
    const touchDurations = [];
    recent.forEach((c) => {
      const created = ms(c.createdAt);
      const touched = ms(c.firstTouchedAt);
      if (created === null || touched === null) return;
      // A stamp before creation can only be bad data (a backfill from a
      // last_contact date typed in by hand, for instance). Counting it as
      // "instant" would flatter the number, so it counts as zero and no
      // worse.
      const delta = Math.max(0, touched - created);
      touchDurations.push(delta);
      if (delta <= DAY_MS) touchedWithin24h += 1;
    });

    const overdue = list.filter((c) => {
      if (!c.nextFollowUp) return false;
      if (c.stage === "Lost" || c.stage === "Past Client") return false;
      return String(c.nextFollowUp) < String(todayIso);
    }).length;

    const medianMs = median(touchDurations);
    return {
      newContacts: recent.length,
      touchedWithin24h,
      // Null rather than 0 when there is nothing to divide: "no leads yet"
      // and "nobody was contacted" are different answers.
      touchedWithin24hPct: recent.length ? Math.round((touchedWithin24h / recent.length) * 100) : null,
      medianTouchMs: medianMs,
      untouched: recent.filter((c) => !c.firstTouchedAt).length,
      overdueNow: overdue
    };
  }

  /** "2h 15m", "3 days", "12m" — short enough for a stat card. */
  function formatDuration(msValue) {
    if (msValue == null) return "—";
    const minutes = Math.round(msValue / 60000);
    if (minutes < 1) return "under a minute";
    if (minutes < 60) return minutes + "m";
    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      const rem = minutes % 60;
      return rem ? hours + "h " + rem + "m" : hours + "h";
    }
    const days = Math.round(hours / 24);
    return days === 1 ? "1 day" : days + " days";
  }

  const formatPct = (pct) => (pct == null ? "—" : pct + "%");

  return { compute, formatDuration, formatPct, WINDOW_DAYS };
})();
