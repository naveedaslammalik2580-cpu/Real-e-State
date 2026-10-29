/* ============================================================
   mobile-nav.js — the bottom bar on a phone, and the offline line.

   WHY A BOTTOM BAR. On a phone the sidebar is behind a hamburger, which
   means every single move is two taps: open the menu, pick the thing.
   The four or five things an agent does all day deserve one tap, and on
   a phone they belong at the bottom, where a thumb is.

   WHAT IS IN IT, and why these five. Today is where the day starts.
   Contacts is the list everything else hangs off. "+ New" reuses the
   permission-filtered header actions. Deals opens the pipeline hub.
   More opens the existing sidebar for the remaining destinations.

   DESKTOP IS UNTOUCHED. The bar is in the DOM at every width and CSS
   shows it under 768px. No resize handler, no width read in JavaScript,
   nothing that can disagree with the stylesheet.
   ============================================================ */
window.App = window.App || {};

App.mobileNav = (function () {
  "use strict";

  const BAR_ID = "mobileTabBar";
  const OFFLINE_ID = "offlineBanner";

  // Small, flat, single-stroke: these are 22px on a phone.
  const ICONS = {
    today: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"/></svg>',
    contacts: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/></svg>',
    add: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    pipeline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="11" rx="1"/><rect x="17" y="4" width="4" height="7" rx="1"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>'
  };

  // route is what makes a tab current; action is what it does instead of
  // navigating. module is the Settings → Modules id, so a tab for a page
  // somebody turned off does not sit there leading nowhere.
  const TABS = [
    { id: "today",    label: "Today",    icon: "today",    route: "/daily",     module: "daily" },
    { id: "contacts", label: "Contacts", icon: "contacts", route: "/contacts",  module: "contacts" },
    { id: "add",      label: "+ New",      icon: "add",      action: "quickAdd",  primary: true },
    { id: "pipeline", label: "Deals", icon: "pipeline", route: "/pipeline",  module: "pipeline" },
    { id: "more",     label: "More",     icon: "more",     action: "menu" }
  ];

  function enabledTabs() {
    return TABS.filter((t) => {
      if (!t.module) return true;
      if (!App.customization || !App.customization.isModuleEnabled) return true;
      return App.customization.isModuleEnabled(t.module);
    });
  }

  function currentPath(win) {
    const raw = String(((win || window).location.hash) || "").replace(/^#/, "");
    return raw.startsWith("/") ? raw : (App.app && App.app.defaultHome ? App.app.defaultHome() : "/dashboard");
  }

  /** Marks the tab whose section the current route belongs to. */
  function syncActive(doc, win) {
    const d = doc || document;
    const bar = d.getElementById(BAR_ID);
    if (!bar) return;
    const path = currentPath(win);
    const hub = App.app && App.app.hubForPath ? App.app.hubForPath(path) : null;
    bar.querySelectorAll("[data-tab-route]").forEach((btn) => {
      const route = btn.getAttribute("data-tab-route");
      // Prefix match, so /contacts/ct_123 keeps Contacts lit.
      const on = path === route || path.indexOf(route + "/") === 0 ||
        (route === "/contacts" && (path === "/past-clients" || hub === "contacts")) ||
        (route === "/pipeline" && hub === "deals");
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-current", on ? "page" : "false");
    });
  }

  function mount(doc, win) {
    const d = doc || document;
    const w = win || window;
    const existing = d.getElementById(BAR_ID);
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

    const nav = d.createElement("nav");
    nav.id = BAR_ID;
    nav.className = "mobile-tabs";
    nav.setAttribute("aria-label", "Main");
    nav.innerHTML = enabledTabs().map((t) => {
      const attr = t.route
        ? `data-tab-route="${t.route}"`
        : `data-tab-action="${t.action}"`;
      return `<button type="button" class="mobile-tab${t.primary ? " mobile-tab-primary" : ""}"
        ${attr} ${t.id === "more" ? 'aria-controls="sidebar" aria-expanded="false"' : ""} ${t.id === "add" ? 'aria-haspopup="menu" aria-controls="globalNewMenu" aria-expanded="false"' : ""} aria-label="${t.id === "add" ? "Create new" : t.label}">
        <span class="mobile-tab-icon" aria-hidden="true">${ICONS[t.icon]}</span>
        <span class="mobile-tab-label">${t.label}</span>
      </button>`;
    }).join("");

    nav.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-tab-route], [data-tab-action]");
      if (!btn) return;
      const route = btn.getAttribute("data-tab-route");
      if (route) { App.app.navigate(route); return; }
      const action = btn.getAttribute("data-tab-action");
      if (action === "quickAdd") {
        // The shared New menu; retain Quick Add for isolated legacy hosts.
        if (App.headerActions && App.headerActions.openNew) App.headerActions.openNew(btn);
        else if (App.quickAdd) App.quickAdd.open();
        return;
      }
      if (action === "menu") {
        // The sidebar is the menu. Opening it through its own toggle
        // means the scrim, the focus and the close-on-navigate all keep
        // working without this file knowing how any of it is done.
        const toggle = d.getElementById("mobileMenuToggle");
        if (toggle) { btn.focus(); toggle.click(); }
      }
    });

    d.body.appendChild(nav);
    syncActive(d, w);
    if (!w.__realtorosTabsWired) {
      w.__realtorosTabsWired = true;
      w.addEventListener("hashchange", () => syncActive(d, w));
    }
    return nav;
  }

  /* ---------- OFFLINE ----------
   * Said once, plainly, and only while it is true. The app does not
   * pretend to queue anything: every write goes to Supabase, so with no
   * connection a save will fail, and knowing that before typing a long
   * note is the whole value of this line.
   */

  function setOffline(doc, offline) {
    const d = doc || document;
    const bar = d.getElementById(OFFLINE_ID);
    if (!bar) return;
    bar.hidden = !offline;
    bar.classList.toggle("open", !!offline);
  }

  function mountOfflineBanner(doc, win) {
    const d = doc || document;
    const w = win || window;
    let bar = d.getElementById(OFFLINE_ID);
    if (!bar) {
      bar = d.createElement("div");
      bar.id = OFFLINE_ID;
      bar.className = "offline-banner";
      bar.setAttribute("role", "status");
      bar.setAttribute("aria-live", "polite");
      bar.textContent = "You're offline — changes need a connection.";
      d.body.appendChild(bar);
    }
    // navigator.onLine is only ever trustworthy when it says false, which
    // is exactly the direction this banner cares about.
    const offlineNow = w.navigator && w.navigator.onLine === false;
    setOffline(d, offlineNow);
    if (!w.__realtorosOfflineWired) {
      w.__realtorosOfflineWired = true;
      w.addEventListener("offline", () => setOffline(d, true));
      w.addEventListener("online", () => setOffline(d, false));
    }
    return bar;
  }

  function init(doc, win) {
    mount(doc, win);
    mountOfflineBanner(doc, win);
  }

  return { init, mount, mountOfflineBanner, setOffline, syncActive, TABS, enabledTabs };
})();
