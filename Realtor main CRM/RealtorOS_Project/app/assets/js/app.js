/* ============================================================
   app.js — application shell, router, modal, toast, confirm.
   Depends on: util.js, store.js
   Depends on later Phase 4 pages: contacts.js, properties.js,
   buyer.js, seller.js  (each attaches to App.pages.<name>)
   ============================================================ */

window.App = window.App || {};
App.pages = App.pages || {};

App.app = (function () {
  "use strict";

  // Legacy menu metadata retained for compatibility. Routing and the Settings
  // module catalog read ROUTES; the sidebar presentation reads HUBS.
  const NAV = [
    { id: "workspace", group: "Workspace", groupIcon: "grid", static: true, items: [
      { id: "dashboard", label: "Dashboard",       icon: "grid",  route: "/dashboard", phase: "here" },
      { id: "daily",     label: "Today",           icon: "sun",   route: "/daily",     phase: "here" }
    ]},
    { id: "crm", group: "CRM", groupIcon: "users", items: [
      { id: "contacts", label: "Contacts",        icon: "users", route: "/contacts",  phase: "here" },
      { id: "buyer",    label: "Buyer Workspace", icon: "home",  route: "/buyer",     phase: "here" },
      { id: "seller",   label: "Seller Workspace",icon: "tag",   route: "/seller",    phase: "here" },
      { id: "referrals",label: "Referrals",       icon: "share", route: "/referrals", phase: "here", area: "finance" }
    ]},
    { id: "transactions", group: "Transactions", groupIcon: "map", items: [
      { id: "properties", label: "Properties",     icon: "map",     route: "/properties",   phase: "here" },
      { id: "pipeline",   label: "Deals Pipeline", icon: "columns", route: "/pipeline",     phase: "here" },
      { id: "commission", label: "Commission",     icon: "dollar",  route: "/commission",   phase: "here", area: "finance" }
    ]},
    // Automation group: every outbound/content workflow in one place. The
    // group id "automation" deliberately matches the item id "automation";
    // they live in separate namespaces (group ids reach nothing in the
    // DOM now that the rail is gone, item ids only reach the module
    // system), so there is no collision.
    { id: "automation", group: "Automation", groupIcon: "zap", items: [
      { id: "automation", label: "Automation",       icon: "zap",    route: "/automation",      phase: "here" },
      // id stays "scripts" (unchanged) so existing per-workspace module
      // toggle state keeps applying to this item — only its label/route
      // moved to the new Email Templates page. /scripts itself still
      // works as a compatibility redirect (see route() below).
      { id: "scripts",    label: "Email Templates", icon: "quote",  route: "/email-templates", phase: "here" },
      { id: "scheduler",  label: "Scheduler",       icon: "clock",  route: "/scheduler",       phase: "here" },
      { id: "content",    label: "Content Library", icon: "book",   route: "/content",         phase: "here" },
      { id: "prompts",    label: "AI Prompts",      icon: "spark",  route: "/prompts",         phase: "here" }
    ]},
    { id: "operations", group: "Operations", groupIcon: "check", items: [
      { id: "activities", label: "Activities",      icon: "activity", route: "/activities", phase: "here" },
      { id: "tasks",      label: "Tasks",           icon: "check",    route: "/tasks",      phase: "here" },
      { id: "calendar",   label: "Calendar",        icon: "cal",      route: "/calendar",   phase: "here" }
    ]},
    { id: "business", group: "Business", groupIcon: "wallet", items: [
      { id: "finances", label: "Income & Expenses", icon: "wallet", route: "/finances", phase: "here", area: "finance" },
      { id: "goals",    label: "Goals",             icon: "target", route: "/goals",    phase: "here", area: "goals" },
      { id: "reports",  label: "Reports",           icon: "chart",  route: "/reports",  phase: "here" }
    ]},
    { id: "system", group: "System", groupIcon: "cog", static: true, items: [
      // No needsSettings gate. It had one from 24e9417, and
      // canViewSettings() is false whenever the permissions bag has no
      // `settings` key - so the item, and the /settings route with it,
      // vanished for everybody in a workspace whose permissions came
      // back in any other shape. Nothing inside the Settings screen was
      // ever gated by that permission either, so the gate hid the whole
      // screen (including the theme, which is personal) and protected
      // nothing that RLS does not already protect on the write.
      { id: "settings", label: "Settings",       icon: "cog",      route: "/settings", phase: "here" },
      { id: "team", label: "Team", icon: "users", route: "/team", phase: "here", needsTeam: true, needsTeamManage: true }
    ]}
  ];

  // Route contracts are independent of the visual NAV. Handlers are resolved
  // lazily because page scripts load after this shell. Hub/tab are metadata
  // only in U1a; they do not change URLs, rendering or the default landing page.
  const ROUTES = [
    { path: "/dashboard", handler: "release.renderDashboard", moduleId: "dashboard", permission: null, hub: "reports", tab: "overview",
      moduleInfo: { label: "Dashboard", icon: "grid", group: "Workspace" } },
    { path: "/daily", handler: "release.renderDaily", moduleId: "daily", permission: null, hub: "today", tab: "today",
      moduleInfo: { label: "Today", icon: "sun", group: "Workspace" } },
    { path: "/contacts", handler: "contacts.renderList", moduleId: "contacts", permission: null, hub: "contacts", tab: "all",
      moduleInfo: { label: "Contacts", icon: "users", group: "CRM" } },
    { path: "/past-clients", handler: "contacts.renderPastClients", moduleId: "contacts", permission: null, hub: "contacts", tab: "past-clients" },
    { path: "/buyer", handler: "buyer.render", moduleId: "buyer", permission: null, hub: "contacts", tab: "buyers",
      moduleInfo: { label: "Buyer Workspace", icon: "home", group: "CRM" } },
    { path: "/seller", handler: "seller.render", moduleId: "seller", permission: null, hub: "contacts", tab: "sellers",
      moduleInfo: { label: "Seller Workspace", icon: "tag", group: "CRM" } },
    { path: "/referrals", handler: "referrals.render", moduleId: "referrals", permission: "finance.view", hub: "reports", tab: "referrals",
      moduleInfo: { label: "Referrals", icon: "share", group: "CRM" } },
    { path: "/properties", handler: "properties.renderList", moduleId: "properties", permission: null, hub: "deals", tab: "properties",
      moduleInfo: { label: "Properties", icon: "map", group: "Transactions" } },
    { path: "/pipeline", handler: "deals.renderPipeline", moduleId: "pipeline", permission: null, hub: "deals", tab: "pipeline",
      moduleInfo: { label: "Deals Pipeline", icon: "columns", group: "Transactions" } },
    { path: "/commission", handler: "commission.render", moduleId: "commission", permission: "finance.view", hub: "deals", tab: "commission",
      moduleInfo: { label: "Commission", icon: "dollar", group: "Transactions" } },
    { path: "/automation/activity", handler: "automation.renderActivity", moduleId: "automation", permission: null, hub: "plans", tab: "activity" },
    { path: "/automation", handler: "automation.render", moduleId: "automation", permission: null, hub: "plans", tab: "plans",
      moduleInfo: { label: "Automation", icon: "zap", group: "Automation" } },
    { path: "/email-templates", handler: "emailTemplates.render", moduleId: "scripts", permission: null, hub: "plans", tab: "templates",
      moduleInfo: { label: "Email Templates", icon: "quote", group: "Automation" } },
    { path: "/scheduler", handler: "scheduler.render", moduleId: "scheduler", permission: null, hub: "calendar", tab: "scheduled",
      moduleInfo: { label: "Scheduler", icon: "clock", group: "Automation" } },
    { path: "/content", handler: "release.renderContent", moduleId: "content", permission: null, hub: "plans", tab: "templates",
      moduleInfo: { label: "Content Library", icon: "book", group: "Automation" } },
    { path: "/prompts", handler: "release.renderPrompts", moduleId: "prompts", permission: null, hub: "plans", tab: "prompts",
      moduleInfo: { label: "AI Prompts", icon: "spark", group: "Automation" } },
    { path: "/activities", handler: "activities.render", moduleId: "activities", permission: null, hub: "reports", tab: "activity-log",
      moduleInfo: { label: "Activities", icon: "activity", group: "Operations" } },
    { path: "/tasks", handler: "tasks.render", moduleId: "tasks", permission: null, hub: "calendar", tab: "tasks",
      moduleInfo: { label: "Tasks", icon: "check", group: "Operations" } },
    { path: "/calendar", handler: "calendar.render", moduleId: "calendar", permission: null, hub: "calendar", tab: "agenda",
      moduleInfo: { label: "Calendar", icon: "cal", group: "Operations" } },
    { path: "/finances", handler: "finances.render", moduleId: "finances", permission: "finance.view", hub: "reports", tab: "income-expenses",
      moduleInfo: { label: "Income & Expenses", icon: "wallet", group: "Business" } },
    { path: "/goals", handler: "goals.render", moduleId: "goals", permission: "goals.view", hub: "reports", tab: "goals",
      moduleInfo: { label: "Goals", icon: "target", group: "Business" } },
    { path: "/reports", handler: "reports.render", moduleId: "reports", permission: null, hub: "reports", tab: "pipeline",
      moduleInfo: { label: "Reports", icon: "chart", group: "Business" } },
    { path: "/settings", handler: "release.renderSettings", moduleId: "settings", permission: null, hub: "settings", tab: "overview",
      moduleInfo: { label: "Settings", icon: "cog", group: "System" } },
    { path: "/team", handler: "teamDashboard.render", moduleId: "team", permission: "teamMode + team_manage", hub: "team", tab: "overview",
      moduleInfo: { label: "Team", icon: "users", group: "System" } },
    { pattern: /^\/contacts\/([^/]+)$/, handler: "contacts.renderDetail", moduleId: "contacts", permission: null, hub: "contacts", tab: "all" },
    { pattern: /^\/properties\/([^/]+)$/, handler: "properties.renderDetail", moduleId: "properties", permission: null, hub: "deals", tab: "properties" },
    { pattern: /^\/pipeline\/([^/]+)$/, handler: "deals.renderDealDetail", moduleId: "pipeline", permission: null, hub: "deals", tab: "pipeline" },
    { pattern: /^\/settings\/([^/]+)$/, handler: "release.renderSettings", moduleId: "settings", permission: null, hub: "settings", tab: ":category" },
    { path: "/notifications", handler: "notifications.render", moduleId: null, permission: null, hub: null, tab: null },
    { path: "/scripts", handler: "redirect", redirectTo: "/email-templates", moduleId: "scripts", permission: null, hub: "plans", tab: "templates" },
    { pattern: /^\/join(?:\?[\s\S]*)?$/, handler: "teamJoin.render", params: path => [App.pages.teamJoin.tokenFromPath(path)], moduleId: null, permission: null, hub: null, tab: null },
    { path: "/", handler: "redirect", redirectTo: defaultHome, moduleId: null, permission: null, hub: "reports", tab: "overview" },
    { pattern: /^[\s\S]*$/, handler: "comingSoon", params: path => [path], moduleId: null, permission: null, hub: null, tab: null }
  ];

  /* ============================================================
     HUBS — the one-level sidebar, and the tab bar under it.

     Seven destinations, each a HUB. A hub is not a new kind of page:
     it is a name for a group of pages that already exist, and it links
     to the first of them the person is allowed to see. The pages below
     it become tabs. Two levels of menu became one level plus a tab bar,
     which is the same two clicks it always was, with the second one
     visible.

     TABS ARE KEYED BY PATH, not by ROUTES.tab. Two plans routes share
     the tab id "templates" (/email-templates and /content) and two
     reports routes would collide the same way, and those ids are
     pinned by tests/frontend/route-contract.test.mjs from U1a, which
     must stay green. A path is unique by construction, so the tab bar
     keys on it and takes everything else - which hub a route belongs
     to, which module switches it off, which permission gates it -
     from ROUTES, where it already lives.

     WHAT IS NOT HERE. Settings, which is pinned to the bottom of the
     sidebar on its own and has its own in-page navigation, and
     /notifications, which is reached from the bell.
     ============================================================ */
  const HUBS = [
    { id: "today",    label: "Today",           icon: "sun",     tabs: ["/daily"] },
    { id: "contacts", label: "Contacts",        icon: "users",
      tabs: ["/contacts", "/buyer", "/seller", "/past-clients"] },
    { id: "deals",    label: "Deals",           icon: "columns",
      tabs: ["/pipeline", "/properties", "/commission"] },
    { id: "calendar", label: "Calendar",        icon: "cal",
      tabs: ["/calendar", "/tasks", "/scheduler"] },
    { id: "plans",    label: "Follow-up Plans", icon: "zap",
      tabs: ["/automation", "/email-templates", "/content", "/prompts", "/automation/activity"] },
    { id: "reports",  label: "Reports",         icon: "chart",
      tabs: ["/dashboard", "/reports", "/finances", "/goals", "/referrals", "/activities"] },
    { id: "team",     label: "Team",            icon: "users",   tabs: ["/team"] }
  ];

  // The tab's own name. Short, because it sits next to five others -
  // "Deals Pipeline" under a hub already called Deals is one word of
  // repetition in a space that has none to spare.
  const TAB_LABELS = {
    "/daily": "Today",
    "/contacts": "All", "/buyer": "Buyers", "/seller": "Sellers", "/past-clients": "Past Clients",
    "/pipeline": "Pipeline", "/properties": "Properties", "/commission": "Commission",
    "/calendar": "Agenda", "/tasks": "Tasks", "/scheduler": "Scheduled",
    "/automation/activity": "Activity", "/automation": "Plans", "/email-templates": "Templates",
    "/content": "Library", "/prompts": "Prompts",
    "/dashboard": "Overview", "/reports": "Performance",
    "/finances": "Income & expenses", "/goals": "Goals",
    "/referrals": "Referrals", "/activities": "Activity log",
    "/team": "Team"
  };

  const hubById = (id) => HUBS.find(h => h.id === id) || null;

  /**
   * Can this person see this page at all? The module switch in
   * Settings, then the permission gate on the route. Both already
   * exist; this is the one place that asks them together on behalf of
   * the menu.
   */
  function pathVisible(path) {
    const cust = App.customization;
    if (cust && !cust.isRouteEnabled(path)) return false;
    return routeAllowed(path);
  }

  /** A hub's tabs, in order, filtered to the ones this person has. */
  const TEMPLATE_PATHS = ["/email-templates", "/content", "/prompts"];
  function templateSections() {
    const labels = ["Email Templates", "Content Library", "AI Prompts"];
    return TEMPLATE_PATHS.map((path, i) => ({ path, label: labels[i] })).filter(tab => pathVisible(tab.path));
  }

  function hubTabs(hubId) {
    const hub = hubById(hubId);
    if (!hub) return [];
    if (hubId === "plans") {
      const sections = templateSections();
      return [
        ...(pathVisible("/automation") ? [{ path: "/automation", label: "Plans" }] : []),
        ...(sections.length ? [{ path: sections[0].path, label: "Templates" }] : []),
        ...(pathVisible("/automation/activity") ? [{ path: "/automation/activity", label: "Activity" }] : [])
      ];
    }
    return hub.tabs
      .filter(pathVisible)
      .map(path => ({ path: path, label: TAB_LABELS[path] || path }));
  }

  /**
   * The sidebar: every hub with at least one page behind it. A hub
   * whose tabs are all switched off or all denied is not shown at all,
   * rather than shown and leading nowhere.
   */
  function visibleHubs() {
    return HUBS
      .map(hub => ({ hub: hub, tabs: hubTabs(hub.id) }))
      .filter(entry => entry.tabs.length > 0);
  }

  /** Which hub a path belongs to, detail routes included. */
  function hubForPath(path) {
    const entry = resolveRoute(path).entry;
    return entry && entry.hub ? entry.hub : null;
  }

  /**
   * Is this a hub LIST page - one of the tabs themselves - rather than
   * a detail page under it? A detail page gets no tab bar: it is one
   * record, not one of several views of a list.
   */
  function isHubListPath(path) {
    const entry = resolveRoute(path).entry;
    return !!(entry && entry.path === path && entry.hub && entry.hub !== "settings");
  }

  function resolveRoute(path) {
    for (const entry of ROUTES) {
      const match = entry.pattern && path.match(entry.pattern);
      if (entry.path === path || match) {
        // Captures stay raw. Settings owns its member query; Join owns token
        // decoding. Do not decode a detail ID a second time here.
        return { entry, path, params: match ? match.slice(1) : [] };
      }
    }
  }

  function routeModuleId(path) {
    if (!path) return null;
    const entry = resolveRoute(path).entry;
    if (entry.moduleId) return entry.moduleId;
    // Preserve the old base-module guard even on an unknown nested URL.
    // Alias-only /scripts was never a base route in the old menu registry.
    const base = "/" + path.split("/").filter(Boolean)[0];
    const parent = ROUTES.find(r => r.path === base && r.moduleInfo);
    return parent ? parent.moduleId : null;
  }

  function moduleCatalog() {
    return ROUTES.filter(r => r.moduleInfo).map(r => ({ id: r.moduleId, ...r.moduleInfo }));
  }

  async function dispatchRoute(page, resolved) {
    const { entry, path } = resolved;
    if (entry.handler === "redirect") { navigate(typeof entry.redirectTo === "function" ? entry.redirectTo() : entry.redirectTo); return false; }
    const params = entry.params ? entry.params(path) : resolved.params;
    if (entry.handler === "comingSoon") renderComingSoon(page, ...params);
    else {
      const [module, method] = entry.handler.split(".");
      // The base Settings route historically receives null explicitly.
      await App.pages[module][method](page, ...(entry.path === "/settings" ? [null] : params));
    }
    return true;
  }


  // ---------- INLINE SVG ICONS ----------
  const ICONS = {
    grid:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>',
    sun:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>',
    users:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    home:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
    tag:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>',
    share:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>',
    map:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>',
    columns: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><path d="M12 3h7a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-7m0-18H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7m0-18v18"/></svg>',
    dollar:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
    activity:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
    check:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><polyline points="20 6 9 17 4 12"/></svg>',
    cal:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
    wallet:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><path d="M20 12V8H6a2 2 0 0 1-2-2c0-1.1.9-2 2-2h12v4"/><path d="M4 6v12c0 1.1.9 2 2 2h14v-4"/><path d="M18 12a2 2 0 0 0-2 2c0 1.1.9 2 2 2h4v-4h-4z"/></svg>',
    target:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>',
    chart:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
    book:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
    quote:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/></svg>',
    spark:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><path d="M12 3v18M3 12h18M18.36 5.64l-12.72 12.72M5.64 5.64l12.72 12.72"/></svg>',
    cog:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    save:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>',
    info:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
    search:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" class="search-icon"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
    plus:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    close:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    back:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>',
    trash:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>',
    edit:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
    // Three icons added so no two sidebar items share a glyph: Automation
    // used to reuse `activity` (Activities), Scheduler reused `cal`
    // (Calendar), and Team Directory reused `users` (Contacts).
    // Automation — lightning bolt (fires by itself)
    zap:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
    // Scheduler — clock face
    clock:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    lock:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    // Phase 3B: Settings → Notifications. The bell in the header has its
    // own copy in pages/notifications.js, which is sized for the header;
    // this one is a nav icon like everything else in this map.
    bell:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
    // Team Directory — clipboard (a roster, distinct from Contacts' people)
    clipboard:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="nav-icon"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>'
  };

  function icon(name) { return ICONS[name] || ""; }

  // Shared back link for detail pages (contact, property, deal). Detail pages
  // are reached from a list, and the breadcrumb trail is hidden below 900px,
  // so without this a phone user has no in-page way back. `label` and `route`
  // are escaped here for the same reason setBreadcrumbs escapes: callers pass
  // through page names directly.
  function backLink(route, label) {
    if (!route) return "";
    const arrow = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>';
    return `<a class="back-link" href="#${escapeHtml(route)}">${arrow}<span>Back to ${escapeHtml(label || "list")}</span></a>`;
  }

  // ---------- SHELL RENDER ----------

  function renderShell() {
    const shell = `
<div id="app-shell">
  <aside id="sidebar" aria-label="Primary navigation">
    <div class="brand" id="brandBlock"></div>
    <nav id="sidebarNav" aria-label="Main navigation">
      ${renderNav()}
    </nav>
    <div class="sidebar-footer">
      <!-- Settings, always. The System group's NAV item used to carry a
           needsSettings gate that hid it whenever the permissions bag
           came back without a settings level - which is how commit
           24e9417 (T2d: the frontend becomes workspace-aware) left a
           workspace with no way to reach its own settings at all. That
           gate is gone; this button is the belt to its braces.

           This gear is not permission-gated, for the same reason the
           sign-out button is not: every member has settings of their
           own (the theme, for one), the Settings screen gates each
           section by itself, and RLS is what actually protects the
           workspace-wide ones. A door somebody is allowed to open and
           cannot find is a worse failure than a door that opens onto a
           mostly-empty room.

           In the sidebar footer so it is in the drawer the mobile
           "More" tab opens, as well as on the desktop rail. -->
      <button type="button" class="sidebar-settings" id="sidebarSettingsBtn"
              data-nav="/settings" aria-label="Settings">
        ${icon("cog")}<span>Settings</span>
      </button>
      <div class="agent-name" id="sidebarAgent">Your Agency</div>
      <div class="sync-status" id="syncStatus" role="status" aria-live="polite"></div>
    </div>
  </aside>

  <div class="sidebar-scrim" id="sidebarScrim" aria-hidden="true"></div>

  <div id="main">
    <div id="storageWarning"></div>
    <header id="topbar" role="banner">
      <button id="mobileMenuToggle" aria-label="Open menu" aria-controls="sidebar" aria-expanded="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg></button>
      <div class="topbar-brand" aria-label="Realtor Pipeline & Commission OS">
        <span class="topbar-brand-name">RealtorOS</span>
        <span class="topbar-brand-sep" aria-hidden="true">·</span>
        <nav class="breadcrumbs" id="breadcrumbs" aria-label="Breadcrumbs"></nav>
      </div>
      <button id="themeToggle" type="button" aria-label="Toggle light and dark theme" title="Toggle light / dark theme"></button>
      <div class="topbar-actions" id="topActions"></div>
      <div class="notif-control" id="notifControl"></div>
      <div class="profile-control" id="profileControl">
        <button type="button" class="profile-trigger" id="profileTrigger" aria-haspopup="true" aria-expanded="false" aria-controls="profileMenu" aria-label="Open profile menu" title="Profile">
          <span class="profile-avatar" id="profileAvatar" aria-hidden="true"></span>
        </button>
        <div class="profile-menu" id="profileMenu" role="menu" aria-label="Account menu" hidden>
          <div class="profile-menu-header">
            <span class="profile-avatar profile-avatar-lg" id="profileMenuAvatar" aria-hidden="true"></span>
            <div class="profile-menu-id">
              <!-- This is the Supabase Auth account, NOT the workspace's agent
                   identity (Settings > Business Profile > Agent Name). The two
                   are separate stores and are allowed to differ — one is who
                   signed in, the other is the name that goes on the business.
                   Labelling them is what stops that difference reading as a
                   bug. -->
              <div class="profile-menu-eyebrow">Signed in as</div>
              <div class="profile-menu-name" id="profileMenuName"></div>
              <div class="profile-menu-email" id="profileMenuEmail"></div>
              <div class="profile-menu-phone" id="profileMenuPhone" hidden></div>
            </div>
          </div>
          <button type="button" class="profile-menu-item" id="profileEditBtn" role="menuitem">Edit account</button>
          <button type="button" class="profile-menu-item" id="profileSettingsBtn" role="menuitem">Settings</button>
          <button type="button" class="profile-menu-item" id="profileBizBtn" role="menuitem">Business profile</button>
          <button type="button" class="profile-menu-item profile-menu-item-danger" id="profileSignOutBtn" role="menuitem">Sign out</button>
        </div>
      </div>
    </header>
    <div id="hubTabs" hidden></div>
    <main id="page" role="main" tabindex="-1"></main>
  </div>
</div>

<div id="modalRoot" aria-live="polite"></div>
<div id="toastRoot" aria-live="polite" aria-atomic="true"></div>
`;
    document.getElementById("root").innerHTML = shell;

    // Phase 2F. The "+" belongs to the shell, not to a page: adding a
    // contact is the one thing an agent does from wherever they happen to
    // be. setTopActions() replaces #topActions on every route, so this
    // sits beside it rather than inside it.
    if (App.quickAdd) App.quickAdd.mount(document);
    if (App.headerActions) App.headerActions.mount();

    // Phase 3A. The bottom tab bar and the offline line, both of which
    // live outside #page so a route change never takes them with it.
    // Mounted after the shell's own markup so #mobileMenuToggle exists
    // for the More tab to click.
    if (App.mobileNav) App.mobileNav.init(document, window);
    if (App.pwa) App.pwa.init(document, window);

    // The footer gear sits outside #sidebarNav, so it gets its own
    // listener rather than relying on that element's delegation.
    const sidebarSettings = document.getElementById("sidebarSettingsBtn");
    if (sidebarSettings) {
      sidebarSettings.addEventListener("click", () => { navigate("/settings"); closeSidebar(); });
    }

    // Wire up mobile menu
    document.getElementById("mobileMenuToggle").addEventListener("click", toggleSidebar);
    document.getElementById("sidebarScrim").addEventListener("click", closeSidebar);

    // Wire the theme toggle. The toggle sits in the persistent topbar so it is
    // reachable from every page (including the Dashboard) without duplicating
    // controls on individual pages. Applied theme is persisted in
    // settings.ui.theme via the existing settings API.
    applyThemeFromSettings();
    renderThemeToggleIcon();
    document.getElementById("themeToggle").addEventListener("click", async () => {
      const cur = (App.store.getState().settings.ui && App.store.getState().settings.ui.theme) || "light";
      const next = cur === "dark" ? "light" : "dark";
      await setTheme(next);
    });

    // One level, so one job: follow the link. (The icon-rail group
    // selection this used to carry went with the rail.)
    document.getElementById("sidebarNav").addEventListener("click", (e) => {
      const a = e.target.closest("[data-nav]");
      if (!a || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigate(a.getAttribute("data-nav"));
      closeSidebar();
    });

    // The tab bar is links, so a plain click would work on its own -
    // but going through navigate() keeps one code path for every
    // in-app move, including the scroll reset and the stale-render
    // guard.
    const hubTabsHost = document.getElementById("hubTabs");
    if (hubTabsHost) {
      hubTabsHost.addEventListener("click", (e) => {
        const a = e.target.closest("[data-hub-tab]");
        if (!a || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(a.getAttribute("data-hub-tab"));
      });
    }

    // Escape closes the mobile off-canvas drawer (a no-op on desktop, where
    // toggling .open has no visual effect).
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && document.getElementById("sidebar").classList.contains("open")) {
        closeSidebar();
      }
    });

    updateStorageWarning();
    updateSidebarAgent();
    initProfileControl();
    // Phase 4H: the notification bell (pages/notifications.js).
    if (App.notificationsUI) App.notificationsUI.mount(document.getElementById("notifControl"));
  }

  // Does this member's workspace permission allow them to see this nav
  // item at all? Two filters apply, and they answer different questions:
  // the module toggle is "does this workspace use this feature", the
  // permission is "may this person use it".
  //
  // Only items whose whole purpose is an area a member can be denied carry
  // an `area` or `needsSettings`. Everything else stays visible and simply
  // shows whatever RLS returns, which for a narrower scope is less.
  //
  // Hiding is a courtesy, not a control: RLS and the service-role RPCs
  // refuse the data regardless, so a member who un-hides a page in the
  // console sees an empty one.
  // Is this ROUTE one the member's permissions allow? Same answer as
  // navItemAllowed, looked up by path, so typing a URL for a page that is
  // hidden from the sidebar lands on the Dashboard instead of rendering an
  // empty page the member was not meant to reach.
  function routeAllowed(path) {
    const gate = resolveRoute(path).entry.permission;
    if (gate === "teamMode + team_manage" && !(App.customization && App.customization.isTeamMode())) return false;
    const ws = App.workspace;
    if (!ws) return true;
    if (gate === "teamMode + team_manage") return ws.can("team_manage");
    if (gate === "finance.view") return ws.canView("finance");
    if (gate === "goals.view") return ws.canView("goals");
    return true;
  }

  function navItemAllowed(it) {
    const ws = App.workspace;
    if (it.needsTeam && !(App.customization && App.customization.isTeamMode())) return false;
    if (!ws) return true;
    if (it.needsTeamManage && !ws.can("team_manage")) return false;
    if (it.area) return ws.canView(it.area);
    return true;
  }

  // Groups that survive module filtering AND permission filtering, in
  // NAV order. Kept for the Settings module catalog and for anything
  // still reading the old shape; the sidebar itself is HUBS now.
  function visibleNavGroups() {
    const cust = App.customization;
    return NAV.map(group => {
      const items = group.items.filter(it =>
        (!cust || cust.isModuleEnabled(it.id)) && navItemAllowed(it));
      return items.length ? { group: group, items: items } : null;
    }).filter(Boolean);
  }

  // One level. Seven items at most, each going straight to a page.
  //
  // The two-rail version that was here put every destination two clicks
  // away and hid which section you were in behind a selected rail
  // button. A flat list costs one click to anywhere in the sidebar and
  // one more to a sibling tab, and the active item is simply the one
  // highlighted.
  function renderNav() {
    const hubs = visibleHubs();
    if (!hubs.length) return "";
    return hubs.map(({ hub, tabs }) => `
      <a class="nav-item" data-nav="${tabs[0].path}" data-hub="${hub.id}"
         href="#${tabs[0].path}" title="${escapeHtml(hub.label)}">
        ${icon(hub.icon)}
        <span class="nav-item-label">${escapeHtml(hub.label)}</span>
      </a>`).join("");
  }

  // Re-render the sidebar navigation after customization changes. The fresh
  // markup carries no .active item, so the current route has to be re-applied
  // or the sidebar would show nothing highlighted until the next navigation.
  function refreshNav() {
    const el = document.getElementById("sidebarNav");
    if (!el) return;
    el.innerHTML = renderNav();
    const path = currentRoutePath();
    markActive(path);
    renderHubTabs(path);
    if (App.headerActions) App.headerActions.refresh();
  }

  // The route the shell currently considers active, normalized the same way
  // route() does.
  function currentRoutePath() {
    const raw = (location.hash || "").replace(/^#/, "");
    return raw.startsWith("/") ? raw : defaultHome();
  }

  // The sidebar highlights a HUB, which is why a contact's own page
  // keeps Contacts lit and a deal's keeps Deals: both routes carry
  // their hub in ROUTES, so there is no prefix matching to get wrong.
  function markActive(route) {
    const activeHub = hubForPath(route);
    const settings = document.getElementById("sidebarSettingsBtn");
    if (settings) {
      const active = activeHub === "settings";
      settings.classList.toggle("active", active);
      if (active) settings.setAttribute("aria-current", "page");
      else settings.removeAttribute("aria-current");
    }
    document.querySelectorAll("#sidebarNav .nav-item").forEach(el => {
      const isMatch = el.getAttribute("data-hub") === activeHub;
      el.classList.toggle("active", isMatch);
      if (isMatch) el.setAttribute("aria-current", "page");
      else el.removeAttribute("aria-current");
    });
  }

  /* ---------- THE HUB TAB BAR ----------
   *
   * Above the page, on hub list pages only. Links, not buttons: a tab
   * IS a URL here, so it can be opened in a new tab, bookmarked and
   * read by anything that reads links.
   *
   * A hub with one visible tab gets no bar - a row of one is just a
   * heading that looks clickable.
   */
  function renderHubTabs(path) {
    const host = document.getElementById("hubTabs");
    if (!host) return;
    const hubId = isHubListPath(path) ? hubForPath(path) : null;
    const tabs = hubId ? hubTabs(hubId) : [];
    const sections = hubId === "plans" && TEMPLATE_PATHS.includes(path) ? templateSections() : [];
    const activePath = sections.length ? sections[0].path : path;
    if (tabs.length < 2 && !sections.length) {
      host.innerHTML = "";
      host.hidden = true;
      return;
    }
    host.hidden = false;
    const hub = hubById(hubId);
    const links = tabs.map(tab => {
      const current = tab.path === activePath;
      return `<a class="hub-tab${current ? " active" : ""}" href="#${tab.path}"
         data-hub-tab="${tab.path}"${current ? ' aria-current="page"' : ""}>${escapeHtml(tab.label)}</a>`;
    }).join("");
    // Below 640px the row becomes a select: six tabs do not fit on a
    // phone, and a horizontal scroller people have to discover is worse
    // than a control they already know. Both are rendered; CSS shows
    // one. The select is labelled, because on its own it is a dropdown
    // with no visible name.
    const options = tabs.map(tab =>
      `<option value="${tab.path}"${tab.path === activePath ? " selected" : ""}>${escapeHtml(tab.label)}</option>`).join("");
    host.innerHTML = `
      <nav class="hub-tabs" aria-label="${escapeHtml(hub.label)} sections">${links}</nav>
      <label class="hub-tabs-select">
        <span class="sr-only">${escapeHtml(hub.label)} section</span>
        <select id="hubTabSelect">${options}</select>
      </label>`;
    if (sections.length) {
      host.insertAdjacentHTML("beforeend", `<nav class="hub-tabs" aria-label="Template sections">${sections.map(tab => `<a class="hub-tab${tab.path === path ? " active" : ""}" data-hub-tab="${tab.path}" href="#${tab.path}"${tab.path === path ? ' aria-current="page"' : ""}>${tab.label}</a>`).join("")}</nav>
        <label class="hub-tabs-select"><span class="sr-only">Template section</span><select id="templateSectionSelect">${sections.map(tab => `<option value="${tab.path}"${tab.path === path ? " selected" : ""}>${tab.label}</option>`).join("")}</select></label>`);
      host.querySelector("#templateSectionSelect").addEventListener("change", e => navigate(e.target.value));
    }
    const select = host.querySelector("#hubTabSelect");
    if (select) select.addEventListener("change", () => navigate(select.value));
  }

  let sidebarOpener = null;
  function sidebarExpanded(open) {
    document.querySelectorAll('#mobileMenuToggle, [data-tab-action="menu"]').forEach(el => el.setAttribute("aria-expanded", String(open)));
  }
  function toggleSidebar() {
    const sb = document.getElementById("sidebar");
    const sc = document.getElementById("sidebarScrim");
    if (sb.classList.contains("open")) { closeSidebar(); return; }
    sidebarOpener = document.activeElement;
    sb.classList.add("open");
    sc.classList.add("open");
    sidebarExpanded(true);
    const first = sb.querySelector("#sidebarNav a, #sidebarSettingsBtn");
    if (first) first.focus();
  }
  function closeSidebar() {
    const wasOpen = document.getElementById("sidebar").classList.contains("open");
    sidebarExpanded(false);
    if (wasOpen && sidebarOpener && sidebarOpener.isConnected) sidebarOpener.focus();
    document.getElementById("sidebar").classList.remove("open");
    document.getElementById("sidebarScrim").classList.remove("open");
  }

  // ---------- THEME (LIGHT / DARK) ----------

  // Inline SVG icons for the topbar theme toggle. Keeping them inline avoids
  // any network/asset dependency — the app must remain a single-file build.
  const THEME_ICONS = {
    moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>',
    sun:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>'
  };

  function applyThemeFromSettings() {
    const ui = App.store.getState().settings.ui || {};
    const theme = ui.theme === "dark" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", theme);
  }

  function renderThemeToggleIcon() {
    const btn = document.getElementById("themeToggle");
    if (!btn) return;
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    // Show the icon of the theme the user would switch TO, so the affordance
    // is legible: sun icon in dark mode, moon icon in light mode.
    btn.innerHTML = isDark ? THEME_ICONS.sun : THEME_ICONS.moon;
    btn.setAttribute("aria-pressed", isDark ? "true" : "false");
    btn.setAttribute("title", isDark ? "Switch to light theme" : "Switch to dark theme");
  }

  async function setTheme(theme) {
    const t = theme === "dark" ? "dark" : "light";
    // Merge into settings.ui so we don't clobber other ui keys the schema may hold.
    const curUi = App.store.getState().settings.ui || {};
    const merged = Object.assign({}, curUi, { theme: t });
    // Apply immediately for a snappy toggle; settings.update is remote-first and
    // may take a moment, but the theme itself is a local rendering concern.
    document.documentElement.setAttribute("data-theme", t);
    renderThemeToggleIcon();
    try {
      await App.store.settings.update({ ui: merged });
    } catch (err) {
      toast("Could not save theme preference: " + err.message, "danger");
    }
  }

  // ---------- SYNC STATUS ----------
  // Business data is never stored locally — every mutation is a direct,
  // awaited Supabase call. This section reflects App.data's live sync state
  // (in-flight / synced / failed / offline) rather than any browser-storage
  // capacity concern, which no longer applies to business data.

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  function renderSyncStatus(state) {
    const el = document.getElementById("syncStatus");
    if (!el) return;
    state = state || (App.data && App.data.getSyncState ? App.data.getSyncState() : { status: "idle", message: "" });
    el.setAttribute("data-status", state.status);
    if (state.status === "saving") {
      el.innerHTML = `<span class="dot"></span><span>Saving…</span>`;
    } else if (state.status === "synced") {
      el.innerHTML = `<span class="dot"></span><span>Synced</span>`;
    } else if (state.status === "offline") {
      el.innerHTML = `<span class="dot"></span><span>Offline</span>`;
    } else if (state.status === "error") {
      el.innerHTML = `<span class="dot"></span><span>Sync failed — </span><button type="button" id="syncStatusRetry">Retry</button>`;
      const btn = document.getElementById("syncStatusRetry");
      if (btn) btn.addEventListener("click", () => { if (typeof state.retry === "function") state.retry(); });
    } else {
      el.innerHTML = "";
    }
    updateStorageWarning(state);
  }

  // Repurposed top-of-shell banner slot: surfaces a save failure prominently
  // (with its own Retry action) in addition to the persistent sidebar
  // indicator above, since a failed save can happen while attention is on
  // the page, not the sidebar.
  function updateStorageWarning(state) {
    const el = document.getElementById("storageWarning");
    if (!el) return;
    state = state || (App.data && App.data.getSyncState ? App.data.getSyncState() : { status: "idle" });
    if (state.status === "error") {
      el.innerHTML = `<div class="storage-warning" role="alert"><strong>A change could not be saved.</strong><span>${escapeHtml(state.message || "Sync failed.")}</span> <button type="button" class="btn btn-sm" id="storageWarningRetry">Retry</button></div>`;
      const btn = document.getElementById("storageWarningRetry");
      if (btn) btn.addEventListener("click", () => { if (typeof state.retry === "function") state.retry(); });
    } else {
      el.innerHTML = "";
    }
  }

  function updateSidebarAgent() {
    const s = App.store.getState();
    const agent = (s.settings.agentName || s.metadata.agentName || "").trim();
    const agency = (s.settings.agencyName || s.metadata.agencyName || "").trim();
    const el = document.getElementById("sidebarAgent");
    if (el) el.textContent = agency || agent || "Your Agency";

    // Optional logo (v2) — purely cosmetic swap of the sidebar brand title.
    // No logo set (the default for every existing workspace) leaves the
    // brand block exactly as it renders today.
    const brandEl = document.getElementById("brandBlock");
    if (brandEl) {
      const logo = s.settings.businessProfile && s.settings.businessProfile.logoDataUri;
      let img = document.getElementById("brandLogo");
      if (logo) {
        if (!img) {
          img = document.createElement("img");
          img.id = "brandLogo";
          img.alt = agency || "Business logo";
          img.style.cssText = "max-height:36px;max-width:100%;object-fit:contain;margin-bottom:4px;display:block";
          brandEl.insertBefore(img, brandEl.firstChild);
        }
        img.src = logo;
      } else if (img) {
        img.remove();
      }
    }
  }

  // ---------- PROFILE CONTROL (topbar, far right) ----------
  // Reads the authenticated user from App.cloud (the sole Supabase boundary);
  // never touches workspace_state or app business data.

  function initialsFromName(name) {
    const n = (name || "").trim();
    if (!n) return "?";
    const parts = n.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  // Fallback order requested for every provider (email/password, Google,
  // Facebook): full_name -> name -> display_name -> email username -> "User".
  function resolveDisplayName(user) {
    if (!user) return "User";
    const meta = user.user_metadata || {};
    const name = (meta.full_name || meta.name || meta.display_name || "").trim();
    if (name) return name;
    const local = (user.email || "").split("@")[0];
    return local || "User";
  }

  function paintAvatarEl(el, name, url) {
    if (!el) return;
    el.innerHTML = "";
    if (url) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = "";
      // Never show a broken-image icon — fall back to initials instead.
      img.addEventListener("error", () => paintAvatarEl(el, name, null));
      el.appendChild(img);
    } else {
      el.textContent = initialsFromName(name);
    }
  }

  // Repaints the header avatar (and the dropdown's name/email/phone, if
  // present) from the current App.cloud user — called on shell render and
  // again right after a profile save, so edits show up without a page
  // reload. The closed header only ever shows the avatar; the name/email/
  // phone are dropdown-only.
  function refreshProfileControl() {
    const user = App.cloud.getUser && App.cloud.getUser();
    const avatarEl = document.getElementById("profileAvatar");
    if (!user || !avatarEl) return;
    const menuAvatarEl = document.getElementById("profileMenuAvatar");
    const menuNameEl = document.getElementById("profileMenuName");
    const menuEmailEl = document.getElementById("profileMenuEmail");
    const menuPhoneEl = document.getElementById("profileMenuPhone");
    const displayName = resolveDisplayName(user);
    const phone = (user.user_metadata && user.user_metadata.phone || "").trim();

    if (menuNameEl) menuNameEl.textContent = displayName;
    if (menuEmailEl) menuEmailEl.textContent = user.email || "";
    if (menuPhoneEl) { menuPhoneEl.textContent = phone; menuPhoneEl.hidden = !phone; }
    paintAvatarEl(avatarEl, displayName, null);
    paintAvatarEl(menuAvatarEl, displayName, null);

    const avatarPath = user.user_metadata && user.user_metadata.avatar_path;
    if (avatarPath && App.cloud.getAvatarSignedUrl) {
      App.cloud.getAvatarSignedUrl(avatarPath).then(url => {
        if (!url) return;
        paintAvatarEl(avatarEl, displayName, url);
        paintAvatarEl(menuAvatarEl, displayName, url);
      });
    }
  }

  function initProfileControl() {
    const control = document.getElementById("profileControl");
    const trigger = document.getElementById("profileTrigger");
    const menu = document.getElementById("profileMenu");
    if (!control || !trigger || !menu) return;
    const editBtn = document.getElementById("profileEditBtn");
    const settingsBtn = document.getElementById("profileSettingsBtn");
    const bizBtn = document.getElementById("profileBizBtn");
    const signOutBtn = document.getElementById("profileSignOutBtn");

    function closeMenu() {
      menu.hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      document.removeEventListener("click", onDocClick, true);
      document.removeEventListener("keydown", onDocKey, true);
    }
    function openMenu() {
      menu.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      document.addEventListener("click", onDocClick, true);
      document.addEventListener("keydown", onDocKey, true);
    }
    function onDocClick(e) { if (!control.contains(e.target)) closeMenu(); }
    function onDocKey(e) { if (e.key === "Escape") { closeMenu(); trigger.focus(); } }

    trigger.addEventListener("click", () => { if (menu.hidden) openMenu(); else closeMenu(); });
    editBtn.addEventListener("click", () => { closeMenu(); openEditProfileModal(); });
    if (settingsBtn) settingsBtn.addEventListener("click", () => { closeMenu(); navigate("/settings"); });
    if (bizBtn) bizBtn.addEventListener("click", () => { closeMenu(); navigate("/settings/business-profile"); });
    signOutBtn.addEventListener("click", () => {
      closeMenu();
      if (App.notificationsUI) App.notificationsUI.stop();
      App.data.unsubscribeRealtime();
      App.workspace.reset();
      App.cloud.signOutUser();
    });

    refreshProfileControl();
  }

  function openEditProfileModal() {
    const user = App.cloud.getUser && App.cloud.getUser();
    if (!user) return;
    const meta = user.user_metadata || {};
    const currentAvatarPath = meta.avatar_path || null;
    let pendingFile = null;
    let pendingRemove = false;
    let previewUrl = null;

    const body = `
      <form id="profileEditForm">
        <div class="profile-photo-row">
          <span class="profile-avatar profile-avatar-xl" id="profileEditAvatarPreview" aria-hidden="true"></span>
          <div>
            <input type="file" id="profileAvatarInput" accept="image/jpeg,image/png,image/webp" hidden>
            <div class="profile-photo-buttons">
              <button type="button" class="btn" id="profileAvatarUploadBtn">Upload photo</button>
              <button type="button" class="btn btn-ghost" id="profileAvatarRemoveBtn">Remove photo</button>
            </div>
            <div class="hint">JPG, PNG, or WebP. Max 2MB.</div>
            <div class="err" id="profileAvatarError" style="display:none"></div>
          </div>
        </div>
        <div class="form-field" id="profileNameField">
          <label for="profileNameInput">Full name</label>
          <input type="text" id="profileNameInput" autocomplete="name" value="${App.util.esc(meta.full_name || "")}">
          <div class="hint">Your sign-in name and photo. The name shown on your deals, reports and branding is Agent Name, under Settings &rsaquo; Business Profile.</div>
          <div class="err">Please enter at least 2 characters.</div>
        </div>
        <div class="form-field">
          <label for="profileEmailInput">Email</label>
          <input type="email" id="profileEmailInput" value="${App.util.esc(user.email || "")}" readonly>
          <div class="hint">To change your sign-in email, contact support.</div>
        </div>
        <div class="form-field" id="profilePhoneField">
          <label for="profilePhoneInput">Phone (optional)</label>
          <input type="tel" id="profilePhoneInput" autocomplete="tel" placeholder="+92 300 1234567" value="${App.util.esc(meta.phone || "")}">
          <div class="err">Enter a valid phone number.</div>
        </div>
        <p id="profileEditMessage" class="profile-edit-message" aria-live="polite"></p>
      </form>
    `;

    const handle = openModal({
      title: "Edit account",
      body,
      footer: `
        <button class="btn" data-role="cancel">Cancel</button>
        <button class="btn btn-primary" data-role="save" id="profileSaveBtn">Save changes</button>
      `,
      onOpen: (modal) => {
        const avatarPreview = modal.querySelector("#profileEditAvatarPreview");
        const fileInput = modal.querySelector("#profileAvatarInput");
        const avatarErr = modal.querySelector("#profileAvatarError");
        const nameField = modal.querySelector("#profileNameField");
        const nameInput = modal.querySelector("#profileNameInput");
        const phoneField = modal.querySelector("#profilePhoneField");
        const phoneInput = modal.querySelector("#profilePhoneInput");
        const saveBtn = modal.querySelector("#profileSaveBtn");
        const msgEl = modal.querySelector("#profileEditMessage");
        const fallbackName = meta.full_name || user.email;

        paintAvatarEl(avatarPreview, fallbackName, null);
        if (currentAvatarPath && App.cloud.getAvatarSignedUrl) {
          App.cloud.getAvatarSignedUrl(currentAvatarPath).then(url => { if (url) paintAvatarEl(avatarPreview, fallbackName, url); });
        }

        modal.querySelector("#profileAvatarUploadBtn").addEventListener("click", () => fileInput.click());
        fileInput.addEventListener("change", () => {
          avatarErr.style.display = "none";
          const file = fileInput.files && fileInput.files[0];
          if (!file) return;
          if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
            avatarErr.textContent = "Please choose a JPG, PNG, or WebP image.";
            avatarErr.style.display = "block";
            fileInput.value = "";
            return;
          }
          if (file.size > 2 * 1024 * 1024) {
            avatarErr.textContent = "That image is larger than 2MB. Choose a smaller file.";
            avatarErr.style.display = "block";
            fileInput.value = "";
            return;
          }
          pendingFile = file;
          pendingRemove = false;
          if (previewUrl) URL.revokeObjectURL(previewUrl);
          previewUrl = URL.createObjectURL(file);
          paintAvatarEl(avatarPreview, fallbackName, previewUrl);
        });
        modal.querySelector("#profileAvatarRemoveBtn").addEventListener("click", () => {
          pendingFile = null;
          pendingRemove = true;
          avatarErr.style.display = "none";
          fileInput.value = "";
          if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
          paintAvatarEl(avatarPreview, fallbackName, null);
        });

        modal.querySelector('[data-role="cancel"]').addEventListener("click", () => handle.close());

        let saving = false;
        modal.querySelector('[data-role="save"]').addEventListener("click", async () => {
          if (saving) return;
          nameField.classList.remove("has-error");
          phoneField.classList.remove("has-error");
          msgEl.textContent = "";
          msgEl.className = "profile-edit-message";

          const fullName = nameInput.value.trim();
          const phone = phoneInput.value.trim();
          let valid = true;
          if (fullName.length < 2) { nameField.classList.add("has-error"); valid = false; }
          if (phone && !/^[+0-9()\-.\s]{7,20}$/.test(phone)) { phoneField.classList.add("has-error"); valid = false; }
          if (!valid) return;

          saving = true;
          saveBtn.disabled = true;
          const originalLabel = saveBtn.textContent;
          saveBtn.textContent = "Saving…";
          try {
            let avatarPath = currentAvatarPath;
            if (pendingFile) {
              avatarPath = await App.cloud.uploadAvatar(pendingFile);
            } else if (pendingRemove) {
              await App.cloud.removeAvatarFile(currentAvatarPath);
              avatarPath = null;
            }
            const result = await App.cloud.updateProfile({ full_name: fullName, phone: phone, avatar_path: avatarPath });
            if (result.error) throw result.error;
            msgEl.textContent = "Profile updated.";
            msgEl.classList.add("success");
            refreshProfileControl();
            setTimeout(() => handle.close(), 900);
          } catch (err) {
            msgEl.textContent = (err && err.message) || "Could not save your profile. Please try again.";
            msgEl.classList.add("error");
            saving = false;
            saveBtn.disabled = false;
            saveBtn.textContent = originalLabel;
          }
        });
      },
      onClose: () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }
    });
  }

  // ---------- BREADCRUMBS ----------
  // Every route calls App.app.setBreadcrumbs([...]) on render; the topbar
  // now carries a #breadcrumbs element again, so this actually renders.
  //
  // ESCAPING IS REQUIRED HERE. Detail routes pass user-controlled strings
  // straight through — contacts.js passes `contact.name`, deals.js passes
  // `d.name`, properties.js passes `p.address` — none of which is escaped by
  // the caller. While the topbar had no #breadcrumbs element this function
  // returned early and the interpolation below was dead code; re-adding the
  // element makes it a live innerHTML sink, so a contact saved with a name
  // like `<img src=x onerror=...>` would otherwise execute on every visit to
  // its detail page. Both the label (text) and the route (href attribute)
  // are escaped; escapeHtml covers & < > " ' so it is safe in both contexts.
  // Escaping here rather than in each caller keeps it at the single choke
  // point and leaves every page file untouched.

  // The trail as the page last set it, so route() can rename its first
  // crumb without the page having to know about hubs.
  let lastBreadcrumbs = [];

  function setBreadcrumbs(items) {
    lastBreadcrumbs = Array.isArray(items) ? items.slice() : [];
    const el = document.getElementById("breadcrumbs");
    if (!el) return;

    // A single-item trail is a top-level page (Contacts, Tasks, Dashboard…),
    // whose name the page's own .page-title already states — rendering it here
    // too just repeats it in the topbar. Only a real trail (Contacts › John
    // Smith, Settings › Pipeline) earns the space. The separator dot is hidden
    // with it so "RealtorOS ·" never dangles.
    const sep = document.querySelector(".topbar-brand-sep");
    const hasTrail = !!items && items.length > 1;
    if (sep) sep.hidden = !hasTrail;
    if (!hasTrail) {
      el.innerHTML = "";
      return;
    }

    el.innerHTML = items.map((it, i) => {
      const isLast = i === items.length - 1;
      const cls = isLast ? "crumb-current" : "crumb";
      const label = escapeHtml(it.label);
      const inner = it.route && !isLast
        ? `<a href="#${escapeHtml(it.route)}" class="link">${label}</a>`
        : `<span class="${cls}">${label}</span>`;
      return (i > 0 ? '<span class="crumb-sep">›</span>' : '') + inner;
    }).join("");
  }

  function setTopActions(html) {
    document.getElementById("topActions").innerHTML = html || "";
  }

  // ---------- ROUTER ----------

  async function navigate(path) {
    if (typeof path !== "string") return;
    if (!path.startsWith("/")) path = "/" + path;
    // Guard synchronously so buttons pointing at disabled routes always land on
    // the Dashboard regardless of whether the browser fires hashchange sync.
    if (path !== "/dashboard"
        && ((App.customization && !App.customization.isRouteEnabled(path))
            || !routeAllowed(path))) {
      path = "/dashboard";
    }
    if (App.headerActions) App.headerActions.refresh();
    if (location.hash === "#" + path) {
      await route();
    } else {
      // Setting the hash alone is enough — the hashchange listener invokes
      // route(). (Previously this also called route() synchronously right
      // here as a same-tick fallback, which was harmless when rendering was
      // synchronous; now that every render is an async Supabase round trip,
      // that would fire the same page's data fetch twice concurrently.)
      location.hash = path;
    }
  }

  // Settings are loaded before the first signed-in route. Explicit URLs
  // and denied-route fallbacks keep their existing behavior.
  function defaultHome() {
    return pathVisible("/daily") ? "/daily" : "/dashboard";
  }

  function parseHash() {
    let hash = location.hash || "#" + defaultHome();
    if (hash.startsWith("#")) hash = hash.slice(1);
    if (!hash.startsWith("/")) hash = "/" + hash;
    return hash;
  }

  // Every branch below is now `await`ed: each page's render() fetches its
  // own entities from Supabase (see the page->entity map in each module)
  // before building its template. A route-level try/catch shows a single
  // retryable error state rather than leaving an unhandled rejection if a
  // page's initial load fails (network blip, RLS issue, etc.).
  let routeToken = 0;
  async function route() {
    const path = parseHash();
    const myToken = ++routeToken; // stale-response guard for rapid navigation

    if (path !== "/dashboard"
        && ((App.customization && !App.customization.isRouteEnabled(path))
            || !routeAllowed(path))) {
      navigate("/dashboard");
      return;
    }

    markActive(path);
    renderHubTabs(path);
    setTopActions("");
    const page = document.getElementById("page");
    if (!page) return;
    page.innerHTML = loadingHtml();

    const resolved = resolveRoute(path);
    try {
      if (!await dispatchRoute(page, resolved)) return;
    } catch (err) {
      console.error("Route render failed for " + path + ":", err);
      if (myToken !== routeToken) return; // user already navigated elsewhere
      page.innerHTML = errorHtml(err && err.message);
      const retryBtn = page.querySelector('[data-role="route-retry"]');
      if (retryBtn) retryBtn.addEventListener("click", () => route());
      return;
    }
    if (myToken !== routeToken) return; // a newer navigation already won

    // The first crumb is the HUB. Pages set their own trail while they
    // render - "Deals Pipeline", "Buyer Workspace" - which was the
    // right name when each was its own menu entry and is a repetition
    // now that the tab bar above already says which tab you are on.
    //
    // Only the FIRST crumb is renamed, and only on a hub list page: a
    // trail the page built deeper than that is its own business, and a
    // detail page keeps everything ("Contacts > Sarah Khan" is exactly
    // right already).
    //
    // On most list pages this is invisible, because setBreadcrumbs
    // deliberately renders nothing for a single-crumb trail - the
    // page's own title says it. It matters for any list page that
    // carries a real trail, and it means the name is decided in one
    // place either way.
    if (isHubListPath(path)) {
      const hub = hubById(hubForPath(path));
      if (hub && lastBreadcrumbs.length) {
        const trail = lastBreadcrumbs.slice();
        trail[0] = Object.assign({}, trail[0], { label: hub.label });
        setBreadcrumbs(trail);
      } else if (hub) {
        setBreadcrumbs([{ label: hub.label }]);
      }
    }

    // The sidebar agent/agency name only reflects whatever entities are
    // currently cached (lazy per-page loading), so re-check it after every
    // successful render as more entities load in.
    updateSidebarAgent();

    // Reset scroll to top on route change
    window.scrollTo(0, 0);
    if (page.focus) try { page.focus({ preventScroll: true }); } catch (e) {}

    // Retrofit keyboard access onto every "row acts as a link" element this
    // page just rendered (see enhanceClickableRows below) — one pass here
    // covers every page's markup instead of hand-adding tabindex/role to
    // each individual click handler across the app.
    enhanceClickableRows(page);
  }

  // ---------- KEYBOARD ACCESS FOR "ROW AS LINK" ELEMENTS ----------
  // Many pages render informational rows/cards that navigate or act on click
  // (`.item-row.clickable`, `tr.clickable`) via an inline onclick attribute
  // or a delegated click listener the page wires up itself. None of those
  // markup patterns carry native button/link semantics, so — without
  // touching any of the dozens of individual click handlers already wired
  // per page — this makes each one reachable by Tab and activatable with
  // Enter/Space.
  function enhanceClickableRows(root) {
    root.querySelectorAll(".item-row.clickable, tr.clickable").forEach(el => {
      if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "0");
      if (!el.hasAttribute("role")) el.setAttribute("role", "button");
    });
  }

  // One delegated listener, registered once against the persistent #page
  // element (not per render), activates the focused row on Enter/Space by
  // calling .click() on it — which fires the same click event its existing
  // inline onclick or addEventListener handler already responds to, so this
  // never duplicates or replaces a page's own click logic. Guarded to only
  // fire when the row itself (not a nested link/button, which already has
  // native Enter/Space support) is the focused element.
  function wireRowKeyboardActivation() {
    const page = document.getElementById("page");
    if (!page) return;
    page.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const el = e.target.closest(".item-row.clickable, tr.clickable");
      if (!el || e.target !== el) return;
      e.preventDefault();
      el.click();
    });
  }

  // ---------- COMING SOON PAGES ----------

  function renderComingSoon(page, path) {
    setBreadcrumbs([{ label: "Page Not Found" }]);
    page.innerHTML = `
      <div class="coming-soon-hero">
        <div class="icon">${icon("info").replace('class="nav-icon"', 'width="28" height="28"')}</div>
        <h1>Page not found</h1>
        <p>That section is not available at this address. Use the sidebar to continue working in Realtor Pipeline & Commission OS.</p>
        <button class="btn btn-primary" id="notFoundDashboard" style="margin-top:16px">Go to Dashboard</button>
      </div>
    `;
    const btn = document.getElementById("notFoundDashboard");
    if (btn) btn.addEventListener("click", () => navigate("/dashboard"));
  }

  // ---------- SECTION-LEVEL LOADING / ERROR STATES ----------
  // Every page render is now async (it awaits its own entities from
  // Supabase), so every page needs a loading placeholder and a retryable
  // error state — neither existed before because nothing used to wait on
  // anything. Both reuse the existing .empty-state/.empty-title/.empty-desc
  // classes already used by emptyMessage() elsewhere, so no new visual
  // language is introduced.
  function loadingHtml(label) {
    return `<div class="empty-state" role="status" aria-live="polite"><div class="empty-title"><span class="loading-spinner" aria-hidden="true"></span>Loading${label ? " " + App.util.esc(label) : ""}…</div></div>`;
  }
  function errorHtml(message) {
    return `<div class="empty-state" role="alert"><div class="empty-title">${App.util.esc(message || "This page could not load.")}</div><div class="empty-desc">Check your connection, then try again.</div><button type="button" class="btn btn-primary" data-role="route-retry">Retry</button></div>`;
  }

  // ---------- MODAL SYSTEM ----------
  // openModal({ title, body, footer, onClose, wide }) -> { close }

  const modalStack = [];

  function openModal(opts) {
    const opener = document.activeElement;
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const modal = document.createElement("div");
    modal.className = "modal" + (opts.wide ? " wide" : "") + (opts.extraClass ? " " + opts.extraClass : "");
    modal.setAttribute("role", opts.extraClass === "confirm" ? "alertdialog" : "dialog");
    modal.setAttribute("aria-modal", "true");
    const titleId = "modal-title-" + Date.now().toString(36) + Math.random().toString(36).slice(2,6);
    modal.setAttribute("aria-labelledby", titleId);
    modal.innerHTML = `
      <div class="modal-header">
        <div class="modal-title" id="${titleId}">${App.util.esc(opts.title || "")}</div>
        <button class="modal-close" aria-label="Close">${icon("close")}</button>
      </div>
      <div class="modal-body">${opts.body || ""}</div>
      ${opts.footer ? `<div class="modal-footer">${opts.footer}</div>` : ""}
    `;
    overlay.appendChild(modal);
    document.getElementById("modalRoot").appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("open"));

    let closed = false;
    let handle;
    const onKey = (e) => {
      if (e.key === "Escape") { wrappedClose(); return; }
      if (e.key !== "Tab") return;
      const focusables = Array.from(modal.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')).filter(x => x.offsetParent !== null || x === document.activeElement);
      if (!focusables.length) { e.preventDefault(); modal.focus(); return; }
      const first = focusables[0], last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    const wrappedClose = () => {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onKey);
      overlay.classList.remove("open");
      setTimeout(() => {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        if (opts.onClose) opts.onClose();
        const i = modalStack.indexOf(handle);
        if (i >= 0) modalStack.splice(i, 1);
        try { if (opener && typeof opener.focus === "function") opener.focus(); } catch (e) {}
      }, 180);
    };

    modal.querySelector(".modal-close").addEventListener("click", wrappedClose);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) wrappedClose(); });
    document.addEventListener("keydown", onKey);
    handle = { close: wrappedClose, modal, overlay };
    modalStack.push(handle);
    if (opts.onOpen) opts.onOpen(modal);
    setTimeout(() => { const first = modal.querySelector('input, select, textarea, button, a[href], [tabindex]:not([tabindex="-1"])'); if (first) try { first.focus(); } catch(e){} }, 0);
    return handle;
  }

  function closeAllModals() {
    modalStack.slice().forEach(h => h.close());
  }

  // ---------- CONFIRM DIALOG ----------

  function confirmDialog(opts, onOk) {
    const impact = opts.impact ? `
      <div class="impact">
        <strong>Impact:</strong>
        <ul>
          ${Object.keys(opts.impact).filter(k => opts.impact[k] > 0).map(k =>
            `<li>${opts.impact[k]} ${App.util.esc(k)} will be ${k === "milestones" ? "deleted" : "unlinked"}</li>`
          ).join("")}
        </ul>
      </div>
    ` : "";

    const h = openModal({
      title: opts.title || "Confirm",
      extraClass: "confirm",
      body: `<p>${opts.message || ""}</p>${impact}`,
      footer: `
        <button class="btn" data-role="cancel">${App.util.esc(opts.cancelLabel || "Cancel")}</button>
        <button class="btn ${opts.danger ? "btn-danger" : "btn-primary"}" data-role="ok">${App.util.esc(opts.okLabel || "Confirm")}</button>
      `,
      onOpen: (modal) => {
        modal.querySelector('[data-role="cancel"]').addEventListener("click", () => h.close());
        modal.querySelector('[data-role="ok"]').addEventListener("click", () => {
          h.close();
          try { onOk && onOk(); } catch (e) { console.error(e); }
        });
      }
    });
    return h;
  }

  // ---------- TOAST ----------

  // opts.actions — [{ label, onClick }] — turns the toast into the place
  // the next step is offered, which is the whole point of it for Quick Add
  // ("Added Sarah Khan." / Open / Log a call). A toast with actions stays
  // up longer, because an action nobody can reach in time is a lie, and
  // clicking one dismisses it.
  //
  // The two-argument form is unchanged, and every existing caller is one.
  function toast(message, kind, opts) {
    const root = document.getElementById("toastRoot");
    if (!root) return;
    const actions = (opts && Array.isArray(opts.actions)) ? opts.actions.filter(Boolean) : [];
    const el = document.createElement("div");
    el.className = "toast" + (kind ? " " + kind : "") + (actions.length ? " toast-actions" : "");
    const text = document.createElement("span");
    text.className = "toast-text";
    text.textContent = message;
    el.appendChild(text);

    let dismiss;
    actions.forEach((action) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-sm toast-action";
      // textContent, not markup: a label may carry a contact's name.
      btn.textContent = action.label || "";
      btn.addEventListener("click", () => {
        dismiss();
        try { if (action.onClick) action.onClick(); } catch (e) { console.error(e); }
      });
      el.appendChild(btn);
    });
    root.appendChild(el);

    let gone = false;
    dismiss = () => {
      if (gone) return;
      gone = true;
      el.style.transition = "opacity 0.2s";
      el.style.opacity = "0";
      setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 220);
    };
    setTimeout(dismiss, actions.length ? 8000 : 2800);
  }

  // ---------- INIT ----------

  async function runMigrationStep() {
    const page = document.getElementById("page");
    if (page) page.innerHTML = loadingHtml("your workspace");
    try {
      return await App.data.migrateLegacyIfNeeded();
    } catch (err) {
      console.error("Legacy migration failed:", err);
      if (page) {
        page.innerHTML = errorHtml("We could not finish preparing your workspace: " + (err && err.message ? err.message : "Unknown error") + ". Nothing has been lost — your existing data is untouched, and it's safe to try again.");
        const retryBtn = page.querySelector('[data-role="route-retry"]');
        if (retryBtn) retryBtn.addEventListener("click", async () => {
          const result = await runMigrationStep();
          if (result) await finishBoot(result);
        });
      }
      return null;
    }
  }

  async function finishBoot(migrationResult) {
    App.data.subscribeRealtime();
    // Who am I inside this workspace? One RPC, cached for the session.
    // Loaded BEFORE the first render so no page briefly shows an action
    // the member is not allowed to take. A failure here is not fatal: the
    // accessors all answer "no access", so the UI hides rather than
    // reveals, and RLS is the real enforcement either way.
    try {
      await App.workspace.load();
    } catch (err) {
      console.error("Could not load workspace permissions:", err);
    }
    await App.store.ensureLoaded(["settings"]);
    updateSidebarAgent();

    await route();

    // The Phase 2E setup guide, when this workspace has not been through
    // it. It is the only first-run flow now: the older empty-workspace
    // welcome (settings.ui.onboardingStatus) was removed in cleanup
    // round B, because two wizards competing for a first sign-in is one
    // too many and 2E's asks for everything the old one did and more.
    //
    // Nothing reads ui.onboardingStatus any more. Workspaces that still
    // carry "pending" or "complete" in their settings bag are simply
    // ignored - the value is harmless, so it is left where it is rather
    // than migrated away.
    if (App.pages.onboarding && App.pages.onboarding.maybeOpen) {
      App.pages.onboarding.maybeOpen();
    }
  }

  async function init() {
    const user = await App.cloud.checkSession();
    if (!user) return; // no session: checkSession already shows the sign-in gate

    renderShell();
    wireRowKeyboardActivation();
    window.addEventListener("hashchange", route);
    window.addEventListener("online", () => renderSyncStatus());
    window.addEventListener("offline", () => renderSyncStatus());
    App.data.onSyncStateChange(renderSyncStatus);
    renderSyncStatus();

    // Realtime notifications: the cache is already patched in place by
    // App.data before this fires. An open modal is never reroute or
    // replaced — a change arriving while a form is open only surfaces once
    // the user navigates away from it. Our own writes are excluded since the
    // calling code path already re-renders itself on success.
    App.data.onEntityChanged((entityKey, info) => {
      if (entityKey === "__settings__") { updateSidebarAgent(); return; }
      if (info && info.self) return;
      if (modalStack.length) return;
      toast("Updated from another device", "info");
      route();
    });

    const migrationResult = await runMigrationStep();
    if (!migrationResult) return; // error state shown; retry button re-enters the boot sequence

    await finishBoot(migrationResult);
  }

  return {
    init, navigate, route, defaultHome,
    openModal, closeAllModals,
    confirmDialog,
    toast,
    setBreadcrumbs, setTopActions, backLink,
    icon,
    NAV, ROUTES, resolveRoute, routeModuleId, moduleCatalog,
    HUBS, visibleHubs, hubTabs, templateSections, hubForPath, isHubListPath,
    // Exported beside refreshNav, which is the same category: the two
    // ways the shell is (re)built. renderShell is what a test drives to
    // assert on the real chrome - the rail, the avatar menu, the footer
    // - rather than on a copy of its markup.
    renderShell,
    refreshNav,
    loadingHtml, errorHtml
  };
})();

