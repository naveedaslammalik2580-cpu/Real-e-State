/* ============================================================
   customization.js — single source of truth for optional modules
   and dashboard widgets. Keeps NAV filtering, route protection, and
   dashboard rendering in sync using the same definitions.
   ============================================================ */
window.App = window.App || {};
App.customization = (function () {
  "use strict";

  // Modules that are structurally required and cannot be disabled.
  // (Dashboard/Contacts/Properties/Pipeline/Commission/Settings
  // are the app's operating spine — hiding them would create dead links and
  // break commission/pipeline calculations that other pages depend on.)
  const LOCKED_MODULES = new Set([
    "dashboard","contacts","properties","pipeline","commission",
    "settings"
  ]);

  // Optional modules. Every id here corresponds to a NAV item.id.
  // "daily" was inspected: renderDaily only reads state and links to
  // /contacts, /tasks, /calendar, /pipeline, /properties. It never writes
  // data and its links are filtered by the route guard below, so it is
  // safe to make optional.
  const OPTIONAL_MODULES = [
    { id: "daily",      label: "Daily View",         group: "Workspace" },
    { id: "buyer",      label: "Buyer Workspace",    group: "CRM" },
    { id: "seller",     label: "Seller Workspace",   group: "CRM" },
    { id: "referrals",  label: "Referrals",          group: "CRM" },
    { id: "activities", label: "Activities",         group: "Operations" },
    { id: "tasks",      label: "Tasks",              group: "Operations" },
    { id: "scheduler", label: "Scheduler",          group: "Automation" },
    { id: "calendar",   label: "Calendar",           group: "Operations" },
    { id: "finances",   label: "Income & Expenses",  group: "Business" },
    { id: "goals",      label: "Goals",              group: "Business" },
    { id: "reports",    label: "Reports",            group: "Business" },
    { id: "content",    label: "Content Library",    group: "Marketing" },
    // id stays "scripts" so existing saved module-toggle state keeps
    // applying — only the user-facing label changed (Phase 4B).
    { id: "scripts",    label: "Email Templates",    group: "Marketing" },
    { id: "prompts",    label: "AI Prompts",         group: "Marketing" },
    { id: "automation", label: "Automation",         group: "Marketing" }
  ];
  const OPTIONAL_IDS = new Set(OPTIONAL_MODULES.map(m => m.id));

  // Dashboard widgets. requiresModule = optional-module id the widget depends on
  // (null when the widget only relies on locked/core modules).
  // Every widget id used here must match a case in renderDashboard's widget map.
  const WIDGETS = [
    { id: "statOverview",     label: "Business At a Glance", requiresModule: null,
      description: "Top summary tiles: pipeline value, expected commission, YTD net, attention count." },
    { id: "pipelineSnapshot", label: "Pipeline Snapshot",    requiresModule: null,
      description: "Deal counts, values, and expected net by pipeline stage." },
    { id: "needsAttention",   label: "Needs Attention",      requiresModule: null,
      description: "Overdue follow-ups, tasks, showings, and deadlines that need action." },
    { id: "upcomingClosings", label: "Upcoming Closings",    requiresModule: null,
      description: "Active deals closing in the next 30 days." },
    { id: "goalsProgress",    label: "Goals Progress",       requiresModule: "goals",
      description: "Progress bars for your active business goals." },
    { id: "recentActivity",   label: "Recent Activity",      requiresModule: "activities",
      description: "Latest logged calls, texts, emails, meetings, and notes." },
    // v2 widgets — hidden by default (see defaultCustomization in store.js)
    // so every existing workspace's dashboard looks exactly the same after
    // upgrading; a customer opts in from Settings → Customize Dashboard.
    { id: "activeDealsWidget", label: "Active Deals",        requiresModule: null,
      description: "Count and total value of every deal still in progress." },
    { id: "newLeadsWidget",    label: "New Leads",           requiresModule: null,
      description: "Contacts currently sitting in your first pipeline stage." },
    { id: "monthlyCommission", label: "Monthly Commission",  requiresModule: null,
      description: "Net commission from deals that closed this calendar month." },
    { id: "propertiesWidget",  label: "Properties",          requiresModule: null,
      description: "Property count broken down by listing status." },
    { id: "conversionRate",    label: "Conversion Rate",     requiresModule: null,
      description: "Won deals as a share of every deal that's reached Won or Lost." },
    { id: "teamPerformance",   label: "Team Performance",    requiresModule: null,
      description: "Deal count and net commission by assigned team member." },
    { id: "revenueWidget",     label: "Revenue",             requiresModule: "finances",
      description: "Net income vs. expenses this month and year-to-date." }
  ];
  const WIDGETS_BY_ID = {};
  WIDGETS.forEach(w => { WIDGETS_BY_ID[w.id] = w; });

  function getConfig() {
    const s = App.store.getState();
    return (s.settings && s.settings.customization) || App.store._defaultCustomization();
  }

  // Is this workspace being run as a team? Off unless somebody turned it on
  // in Settings - Team & Access. Everything team-shaped in the app asks this
  // first, so a workspace that never opts in never changes.
  function isTeamMode() {
    const cfg = getConfig();
    return cfg.teamMode === true;
  }

  function isModuleLocked(moduleId) { return LOCKED_MODULES.has(moduleId); }
  function isOptionalModule(moduleId) { return OPTIONAL_IDS.has(moduleId); }

  function isModuleEnabled(moduleId) {
    if (LOCKED_MODULES.has(moduleId)) return true;
    if (!OPTIONAL_IDS.has(moduleId)) return true; // unknown ids default to visible so we never hide new pages
    const cfg = getConfig();
    return cfg.enabledModules[moduleId] !== false;
  }

  // Routing metadata comes from ROUTES, never from the menu layout.
  function buildRouteMap() {
    const map = {};
    const routes = (App.app && App.app.ROUTES) || [];
    routes.forEach(r => { if (r.path && r.moduleId) map[r.path] = r.moduleId; });
    return map;
  }

  function isRouteEnabled(path) {
    if (!path || !App.app || !App.app.routeModuleId) return true;
    return isModuleEnabled(App.app.routeModuleId(path));
  }

  // Ordered list of visible widget ids, honoring order + visibility + module deps.
  function visibleWidgetsInOrder() {
    const cfg = getConfig();
    return WIDGETS
      .map(w => {
        const setting = cfg.dashboardWidgets[w.id] || { visible: true, order: 999 };
        return { widget: w, visible: setting.visible !== false, order: Number(setting.order) || 999 };
      })
      .filter(x => x.visible)
      .filter(x => !x.widget.requiresModule || isModuleEnabled(x.widget.requiresModule))
      .sort((a, b) => a.order - b.order)
      .map(x => x.widget.id);
  }

  return {
    LOCKED_MODULES, OPTIONAL_MODULES, OPTIONAL_IDS, WIDGETS, WIDGETS_BY_ID,
    getConfig, isTeamMode, isModuleLocked, isOptionalModule, isModuleEnabled,
    isRouteEnabled, buildRouteMap, visibleWidgetsInOrder
  };
})();
