// A workspace in memory, for the core CRM page tests.
//
// WHY ONE FIXTURE. Eleven pages all want the same thing: some rows, a
// store that reads and writes them, and a record of what was written.
// Writing that eleven times would mean eleven slightly different stores
// and eleven places for a test to pass because its own fake was wrong.
//
// WHAT IT IS NOT. It is not a database. Writes mutate the arrays and are
// recorded; they are not validated, because validation lives in
// data-service.js and the database, both of which have their own tests.
// What these tests prove is what the PAGE does: what it renders, what it
// asks the store for, and what it refuses to do.
import { browser, settle, SKIP_DOM } from "../helpers/browser.mjs";

export { settle, SKIP_DOM };

/** Every entity the pages read, with the names store.js uses. */
const COLLECTIONS = [
  "contacts", "properties", "deals", "milestones", "tasks", "activities",
  "showings", "referrals", "goals", "income", "expenses", "scheduledItems",
  "teamMembers", "customFieldValues", "scripts", "aiPrompts",
];

export const DEFAULT_SETTINGS = {
  currency: "USD",
  locale: "en-US",
  agentName: "Dana Reed",
  agencyName: "Reed & Co",
  pipelineStages: [
    { id: "new", name: "New", probability: 10, color: "#94A3B8", order: 1 },
    { id: "showing", name: "Showing", probability: 40, color: "#818CF8", order: 2 },
    { id: "uc", name: "Under Contract", probability: 85, color: "#F59E0B", order: 3 },
    { id: "closed", name: "Closed", probability: 100, color: "#10B981", order: 4, terminal: "won" },
    { id: "lost", name: "Lost", probability: 0, color: "#EF4444", order: 5, terminal: "lost" },
  ],
  contactStages: ["New Lead", "Qualified", "Nurturing", "Client", "Past Client", "Lost"],
  leadSources: ["Referral", "Website", "Open House", "Other"],
  activityTypes: ["Call", "Text", "Email", "Meeting", "Note"],
  taskPriorities: ["High", "Medium", "Low"],
  commissionDefaults: {
    commissionRate: 3, teamSplit: 0, brokerageFee: 20, referralFee: 0, taxReserve: 25,
  },
  followUpDefaults: { overdueGraceDays: 0, upcomingWindowDays: 7 },
  fiscalYearStartMonth: 1,
  defaultStageId: "new",
  currentTeamMemberId: null,
  customFields: { definitions: [] },
  customization: { teamMode: false, enabledModules: {}, dashboardWidgets: {} },
};

let nextId = 0;
const mkId = (prefix) => prefix + "_" + (++nextId);

/**
 * A store fake over plain arrays.
 *
 * `writes` records every mutation as [method, ...args] in order, which is
 * what most assertions are actually about: a page that renders beautifully
 * and saves the wrong thing is the bug worth catching.
 */
export function workspace(seed = {}) {
  const state = {};
  COLLECTIONS.forEach((name) => { state[name] = (seed[name] || []).slice(); });
  state.settings = Object.assign({}, DEFAULT_SETTINGS, seed.settings || {});
  state.metadata = { createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };

  const writes = [];
  const record = (what, ...args) => { writes.push([what].concat(args)); };

  /** The CRUD shape store.js exposes for a plain entity. */
  function crud(name, prefix) {
    const list = () => state[name];
    return {
      list: async () => list().slice(),
      get: async (id) => list().find((r) => r.id === id) || null,
      create: async (model) => {
        record(name + ".create", model);
        const row = Object.assign({ id: mkId(prefix) }, model);
        list().push(row);
        return row;
      },
      update: async (id, patch) => {
        record(name + ".update", id, patch);
        const row = list().find((r) => r.id === id);
        if (row) Object.assign(row, patch);
        return row;
      },
      delete: async (id) => {
        record(name + ".delete", id);
        const at = list().findIndex((r) => r.id === id);
        if (at >= 0) list().splice(at, 1);
        return true;
      },
    };
  }

  const store = {
    ensureLoaded: async () => {},
    getState: () => state,
    _state: state,
    writes,

    contacts: crud("contacts", "ct"),
    properties: crud("properties", "pr"),
    deals: Object.assign(crud("deals", "dl"), {
      moveToStage: async (id, stageId) => {
        record("deals.moveToStage", id, stageId);
        const row = state.deals.find((d) => d.id === id);
        if (row) row.stageId = stageId;
        return row;
      },
      createWithMilestones: async (deal, milestones) => {
        record("deals.createWithMilestones", deal, milestones);
        const row = Object.assign({ id: mkId("dl") }, deal);
        state.deals.push(row);
        return row;
      },
    }),
    milestones: Object.assign(crud("milestones", "ms"), {
      listForDeal: async (dealId) => state.milestones
        .filter((m) => m.dealId === dealId)
        .sort((a, b) => (a.order || 0) - (b.order || 0)),
      complete: async (id) => {
        record("milestones.complete", id);
        const row = state.milestones.find((m) => m.id === id);
        if (row) row.status = "Complete";
        return row;
      },
    }),
    // The two status words are the app's own: store.js writes
    // "Completed" for a task and "Complete" for a milestone, and a
    // fixture that invented its own vocabulary would let a page drift
    // from the data layer unnoticed.
    tasks: Object.assign(crud("tasks", "tk"), {
      complete: async (id) => {
        record("tasks.complete", id);
        const row = state.tasks.find((t) => t.id === id);
        if (row) row.status = "Completed";
        return row;
      },
    }),
    activities: crud("activities", "ac"),
    showings: crud("showings", "sh"),
    referrals: crud("referrals", "rf"),
    goals: crud("goals", "gl"),
    income: crud("income", "in"),
    expenses: crud("expenses", "ex"),
    scheduledItems: crud("scheduledItems", "si"),
    teamMembers: crud("teamMembers", "tm"),

    customFields: {
      // The three the custom-fields UI reaches for on every form it
      // renders. definitionsFor is ordered the way the real facade
      // orders it, because a form that renders its fields in a
      // different order is a different form.
      ENTITIES: ["contact", "deal", "property", "task"],
      TYPES: ["text", "number", "date", "select", "multiselect", "checkbox"],
      definitionsFor: (entity) => state.settings.customFields.definitions
        .filter((f) => f.entity === entity)
        .sort((a, b) => (a.order || 0) - (b.order || 0)),
      activeDefinitionsFor: (entity) => store.customFields.definitionsFor(entity)
        .filter((f) => f.active !== false),
      getDefinition: (id) => state.settings.customFields.definitions
        .find((f) => f.id === id) || null,
      definitions: () => state.settings.customFields.definitions,
      list: async () => state.settings.customFields.definitions.slice(),
      valuesFor: (entity, id) => state.customFieldValues
        .filter((v) => v.entityType === entity && v.entityId === id),
      getValues: async (entity, id) => store.customFields.valuesFor(entity, id),
      setValues: async (entity, id, values) => {
        record("customFields.setValues", entity, id, values);
        return true;
      },
      // The settings screen's own vocabulary: define/setActive/reorder/
      // deleteDefinition and the option editors, all named as store.js
      // names them.
      define: async (entity, opts) => {
        record("customFields.define", entity, opts);
        const label = String((opts && opts.label) || "").trim();
        if (!label) return null;
        if (state.settings.customFields.definitions.some(
          (f) => f.entity === entity && f.active !== false
            && f.label.toLowerCase() === label.toLowerCase())) return null;
        const row = Object.assign({
          id: mkId("cf"), entity, active: true, required: false,
          order: state.settings.customFields.definitions.length + 1, options: [],
        }, opts, { label });
        state.settings.customFields.definitions.push(row);
        return row;
      },
      setActive: async (id, active) => {
        record("customFields.setActive", id, active);
        const row = state.settings.customFields.definitions.find((d) => d.id === id);
        if (row) row.active = !!active;
        return row;
      },
      reorder: async (entity, orderedIds) => {
        record("customFields.reorder", entity, orderedIds);
        orderedIds.forEach((id, i) => {
          const row = state.settings.customFields.definitions.find((d) => d.id === id);
          if (row) row.order = i + 1;
        });
        return true;
      },
      deleteDefinition: async (id) => {
        record("customFields.deleteDefinition", id);
        const at = state.settings.customFields.definitions.findIndex((d) => d.id === id);
        if (at >= 0) state.settings.customFields.definitions.splice(at, 1);
        return true;
      },
      countValues: async (id) => state.customFieldValues.filter((v) => v.fieldId === id).length,
      addOption: async (id, label) => {
        record("customFields.addOption", id, label);
        const row = state.settings.customFields.definitions.find((d) => d.id === id);
        if (row) (row.options = row.options || []).push({ id: mkId("op"), label });
        return row;
      },
      renameOption: async (id, optionId, label) => {
        record("customFields.renameOption", id, optionId, label);
        return true;
      },
      countOptionUsage: async () => 0,
      deleteOption: async (id, optionId) => {
        record("customFields.deleteOption", id, optionId);
        const row = state.settings.customFields.definitions.find((d) => d.id === id);
        if (row && row.options) {
          const at = row.options.findIndex((o) => o.id === optionId);
          if (at >= 0) row.options.splice(at, 1);
        }
        return true;
      },
      create: async (def) => {
        record("customFields.create", def);
        const row = Object.assign({ id: mkId("cf") }, def);
        state.settings.customFields.definitions.push(row);
        return row;
      },
      update: async (id, patch) => {
        record("customFields.update", id, patch);
        const row = state.settings.customFields.definitions.find((d) => d.id === id);
        if (row) Object.assign(row, patch);
        return row;
      },
      delete: async (id) => {
        record("customFields.delete", id);
        const at = state.settings.customFields.definitions.findIndex((d) => d.id === id);
        if (at >= 0) state.settings.customFields.definitions.splice(at, 1);
        return true;
      },
    },

    messageTemplates: {
      list: async () => state.messageTemplates ? state.messageTemplates.slice() : (seed.messageTemplates || []).slice(),
      create: async (m) => { record("messageTemplates.create", m); return Object.assign({ id: mkId("mt") }, m); },
      update: async (id, p) => { record("messageTemplates.update", id, p); return p; },
      activate: async (id) => { record("messageTemplates.activate", id); return { id, is_active: true }; },
      setActive: async (id, on) => { record("messageTemplates.setActive", id, on); return { id, is_active: on }; },
      delete: async (id) => { record("messageTemplates.delete", id); return true; },
    },
    legacyScriptImport: {
      listEligible: async () => [],
      importByIds: async (ids) => { record("legacyScriptImport.importByIds", ids); return { imported: ids.length }; },
    },

    settings: {
      get: () => state.settings,
      getDefaultStage: () => state.settings.pipelineStages
        .find((s) => s.id === state.settings.defaultStageId) || state.settings.pipelineStages[0],
      update: async (patch) => {
        record("settings.update", patch);
        Object.assign(state.settings, patch);
        return state.settings;
      },
      updateCommissionDefaults: async (patch) => {
        record("settings.updateCommissionDefaults", patch);
        Object.assign(state.settings.commissionDefaults, patch);
        return state.settings.commissionDefaults;
      },
      updateEnabledModules: async (patch) => {
        record("settings.updateEnabledModules", patch);
        return patch;
      },
      updateBusinessProfile: async (patch) => {
        record("settings.updateBusinessProfile", patch);
        return patch;
      },
    },
  };
  return store;
}

const open = [];

export function closeAll() {
  while (open.length) {
    const b = open.pop();
    try { b.close(); } catch (e) { /* already gone */ }
  }
}

/**
 * Loads the real page scripts over a workspace, and hands back the pane
 * to render into plus everything a test asserts on.
 *
 * `derived` is the real core/derived.js unless a test overrides it -
 * these pages lean on it for every number they show, and a stubbed
 * derived would mean testing the stub.
 */
export async function page(scripts, seed = {}, opts = {}) {
  const store = seed.store || workspace(seed);
  const b = await browser(scripts, { store });
  if (!b) return null;
  open.push(b);

  const navigated = [];
  b.window.App.app.navigate = (path) => { navigated.push(path); };
  if (opts.workspace) b.window.App.workspace = opts.workspace;
  if (b.window.App.util && seed.today) b.window.App.util.todayISO = () => seed.today;

  const pane = b.document.createElement("div");
  b.document.body.appendChild(pane);
  return Object.assign({}, b, {
    pane, store, navigated,
    writes: store.writes,
    state: store._state,
    /** The last modal opened, which is where every form lives. */
    modal: () => {
      const all = b.document.querySelectorAll(".modal");
      return all.length ? all[all.length - 1] : null;
    },
    text: () => pane.textContent.replace(/\s+/g, " ").trim(),
    html: () => pane.innerHTML,
  });
}

/** Skips the whole file cleanly when jsdom is not installed. */
export function domTest(test, scripts, name, fn) {
  test(name, async (t) => {
    const probe = await browser(scripts, { store: workspace() });
    if (!probe) return t.skip(SKIP_DOM);
    try { probe.close(); } catch (e) {}
    try { await fn(); } finally { closeAll(); }
  });
}

/** Fills a form field and fires the events a page listens for. */
export function setField(root, selector, value) {
  const el = root.querySelector(selector);
  if (!el) throw new Error("no such field: " + selector);
  const win = el.ownerDocument.defaultView;
  if (el.type === "checkbox") el.checked = !!value;
  else el.value = value;
  el.dispatchEvent(new win.Event("input", { bubbles: true }));
  el.dispatchEvent(new win.Event("change", { bubbles: true }));
  return el;
}

/** The writes of one kind, in order. */
export const writesOf = (p, what) => p.writes.filter((w) => w[0] === what);

/** Cross-realm safe deep compare of a jsdom-side object. */
export const plain = (v) => JSON.parse(JSON.stringify(v));
