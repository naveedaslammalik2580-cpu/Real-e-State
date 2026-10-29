/* ============================================================
   store.js — thin async facade over App.data (the real Supabase
   boundary). Every method name/shape below matches the previous
   store API exactly, so every existing page's
   S().<entity>.<method>() call keeps working once `await` is added
   at the call site — no renames.

   Pure helpers (emptyState/defaultSettings/normalize/migrations) are
   unchanged from before: they still do the exact same schema-version
   upgrade work, now used by the legacy migration and backup import
   paths instead of browser-local persistence.
   ============================================================ */
window.App = window.App || {};

App.store = (function () {
  "use strict";
  const D = () => App.data;
  const uid = App.util.uid;
  const nowISO = App.util.nowISO;

  const SCHEMA_VERSION = 3;

  // ---------- DEFAULT SETTINGS / STATE SHAPE (pure — unchanged) ----------
  function defaultCustomization() {
    return {
      enabledModules: {
        daily: true, buyer: true, seller: true, referrals: true,
        activities: true, tasks: true, calendar: true,
        "team-dir": true, scheduler: true,
        finances: true, goals: true, reports: true,
        content: true, scripts: true, prompts: true, automation: true
      },
      dashboardWidgets: {
        statOverview:     { visible: true, order: 1 },
        pipelineSnapshot: { visible: true, order: 2 },
        needsAttention:   { visible: true, order: 3 },
        upcomingClosings: { visible: true, order: 4 },
        goalsProgress:    { visible: true, order: 5 },
        recentActivity:   { visible: true, order: 6 },
        activeDealsWidget: { visible: false, order: 7 },
        newLeadsWidget:    { visible: false, order: 8 },
        monthlyCommission: { visible: false, order: 9 },
        propertiesWidget:  { visible: false, order: 10 },
        conversionRate:    { visible: false, order: 11 },
        teamPerformance:   { visible: false, order: 12 },
        revenueWidget:     { visible: false, order: 13 }
      },
      branding: {},
      // Team mode is opt-in. While it is off, nothing team-related appears
      // anywhere in the app - no Team page, no assignment controls on leads -
      // so a single-agent workspace is untouched by this phase.
      teamMode: false
    };
  }
  function defaultBusinessProfile() {
    return { businessType: null, logoDataUri: null, dateFormat: "MM/DD/YYYY" };
  }
  function defaultSettings() {
    return {
      currency: "USD",
      locale: "en-US",
      pipelineStages: [
        { id: "new",       name: "New",            probability: 10, color: "#94A3B8", order: 1 },
        { id: "qualified", name: "Qualified",      probability: 25, color: "#60A5FA", order: 2 },
        { id: "showing",   name: "Showing",        probability: 40, color: "#818CF8", order: 3 },
        { id: "offer",     name: "Offer",          probability: 60, color: "#A78BFA", order: 4 },
        { id: "uc",        name: "Under Contract", probability: 85, color: "#F59E0B", order: 5 },
        { id: "closed",    name: "Closed",         probability: 100, color: "#10B981", order: 6, terminal: "won" },
        { id: "lost",      name: "Lost",           probability: 0,   color: "#EF4444", order: 7, terminal: "lost" }
      ],
      contactStages: ["New Lead", "Qualified", "Nurturing", "Client", "Past Client", "Lost"],
      leadSources: ["Referral", "Website", "Social Media", "Open House", "Past Client", "Cold Outreach", "Zillow / Portal", "Other"],
      activityTypes: ["Call", "Text", "Email", "Meeting", "Note"],
      taskPriorities: ["High", "Medium", "Low"],
      commissionDefaults: { commissionRate: 2.5, teamSplit: 0, brokerageFee: 20, referralFee: 0, taxReserve: 25 },
      followUpDefaults: { overdueGraceDays: 0, upcomingWindowDays: 7 },
      fiscalYearStartMonth: 1,
      agencyName: "", agentName: "", agentEmail: "", agentPhone: "",
      ui: { theme: "light", onboardingStatus: null },
      customization: defaultCustomization(),
      defaultStageId: "new",
      currentTeamMemberId: null,
      businessProfile: defaultBusinessProfile(),
      customFields: { definitions: [] }
    };
  }
  function emptyState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      metadata: { createdAt: nowISO(), updatedAt: nowISO(), lastBackupAt: null, agentName: "", agencyName: "" },
      settings: defaultSettings(),
      contacts: [], properties: [], deals: [], activities: [], tasks: [], showings: [],
      milestones: [], referrals: [], goals: [], scripts: [], aiPrompts: [], income: [], expenses: [],
      scheduledItems: [], teamMembers: [], customFieldValues: []
    };
  }
  function migrateV1toV2(raw) {
    const out = Object.assign({}, raw);
    out.settings = Object.assign({}, raw.settings);
    out.settings.customFields = (raw.settings && raw.settings.customFields && typeof raw.settings.customFields === "object" && Array.isArray(raw.settings.customFields.definitions)) ? raw.settings.customFields : { definitions: [] };
    out.settings.businessProfile = (raw.settings && raw.settings.businessProfile && typeof raw.settings.businessProfile === "object") ? Object.assign(defaultBusinessProfile(), raw.settings.businessProfile) : defaultBusinessProfile();
    out.settings.currentTeamMemberId = (raw.settings && typeof raw.settings.currentTeamMemberId === "string") ? raw.settings.currentTeamMemberId : null;
    if (raw.settings && typeof raw.settings.defaultStageId === "string") {
      out.settings.defaultStageId = raw.settings.defaultStageId;
    } else {
      const stages = (raw.settings && Array.isArray(raw.settings.pipelineStages)) ? raw.settings.pipelineStages.slice() : [];
      stages.sort((a, b) => (a.order || 0) - (b.order || 0));
      out.settings.defaultStageId = stages.length ? stages[0].id : "new";
    }
    out.teamMembers = Array.isArray(raw.teamMembers) ? raw.teamMembers : [];
    out.customFieldValues = Array.isArray(raw.customFieldValues) ? raw.customFieldValues : [];
    out.schemaVersion = 2;
    return out;
  }
  function migrateV2toV3(raw) {
    const out = Object.assign({}, raw);
    out.scheduledItems = Array.isArray(raw.scheduledItems) ? raw.scheduledItems : [];
    out.schemaVersion = 3;
    return out;
  }
  const MIGRATIONS = { 2: migrateV1toV2, 3: migrateV2toV3 };
  function runMigrations(raw) {
    if (!raw || typeof raw !== "object") return raw;
    let cur = raw;
    let version = (typeof cur.schemaVersion === "number" && cur.schemaVersion > 0) ? cur.schemaVersion : 1;
    Object.keys(MIGRATIONS).map(Number).sort((a, b) => a - b).forEach(targetVersion => {
      if (version < targetVersion) { cur = MIGRATIONS[targetVersion](cur); version = targetVersion; }
    });
    return cur;
  }
  function normalize(s) {
    const fresh = emptyState();
    if (!s || typeof s !== "object") return fresh;
    const out = Object.assign({}, fresh, s);
    out.settings = Object.assign({}, fresh.settings, s.settings || {});
    if (s.settings) {
      out.settings.commissionDefaults = Object.assign({}, fresh.settings.commissionDefaults, s.settings.commissionDefaults || {});
      out.settings.followUpDefaults = Object.assign({}, fresh.settings.followUpDefaults, s.settings.followUpDefaults || {});
      out.settings.ui = Object.assign({}, fresh.settings.ui, s.settings.ui || {});
    }
    (function backfillCustomization() {
      const dc = defaultCustomization();
      const src = (s.settings && s.settings.customization && typeof s.settings.customization === "object") ? s.settings.customization : {};
      const em = (src.enabledModules && typeof src.enabledModules === "object") ? src.enabledModules : {};
      const mergedModules = {};
      Object.keys(dc.enabledModules).forEach(k => { mergedModules[k] = (typeof em[k] === "boolean") ? em[k] : dc.enabledModules[k]; });
      const dw = (src.dashboardWidgets && typeof src.dashboardWidgets === "object") ? src.dashboardWidgets : {};
      const mergedWidgets = {};
      Object.keys(dc.dashboardWidgets).forEach(k => {
        const def = dc.dashboardWidgets[k];
        const cur = (dw[k] && typeof dw[k] === "object") ? dw[k] : {};
        mergedWidgets[k] = { visible: (typeof cur.visible === "boolean") ? cur.visible : def.visible, order: (typeof cur.order === "number" && isFinite(cur.order)) ? cur.order : def.order };
      });
      out.settings.customization = { enabledModules: mergedModules, dashboardWidgets: mergedWidgets, branding: (src.branding && typeof src.branding === "object") ? src.branding : {} };
    })();
    ["contacts","properties","deals","activities","tasks","showings","milestones","referrals","goals","scripts","aiPrompts","income","expenses","scheduledItems","teamMembers","customFieldValues"].forEach(k => {
      if (!Array.isArray(out[k])) out[k] = [];
    });
    out.settings.businessProfile = (s.settings && s.settings.businessProfile && typeof s.settings.businessProfile === "object") ? Object.assign(defaultBusinessProfile(), s.settings.businessProfile) : defaultBusinessProfile();
    out.settings.customFields = (s.settings && s.settings.customFields && Array.isArray(s.settings.customFields.definitions)) ? s.settings.customFields : { definitions: [] };
    out.settings.currentTeamMemberId = (s.settings && typeof s.settings.currentTeamMemberId === "string") ? s.settings.currentTeamMemberId : null;
    out.settings.defaultStageId = (s.settings && typeof s.settings.defaultStageId === "string") ? s.settings.defaultStageId : fresh.settings.defaultStageId;
    out.metadata = Object.assign({}, fresh.metadata, s.metadata || {});
    out.schemaVersion = SCHEMA_VERSION;
    return out;
  }
  const DEFAULT_MILESTONES = [
    { name: "Offer Submitted", order: 1, offsetDays: 0 },
    { name: "Offer Accepted",  order: 2, offsetDays: 3 },
    { name: "Inspection",      order: 3, offsetDays: 7 },
    { name: "Appraisal",       order: 4, offsetDays: 14 },
    { name: "Financing",       order: 5, offsetDays: 21 },
    { name: "Documents",       order: 6, offsetDays: 25 },
    { name: "Closing",         order: 7, offsetDays: null }
  ];

  // ---------- SYNC STATE passthrough ----------
  function getSyncState() { return D().getSyncState(); }
  function onSyncStateChange(fn) { return D().onSyncStateChange(fn); }

  // ---------- SYNCHRONOUS STATE SNAPSHOT (render-compatible) ----------
  // Reflects whatever is currently cached. Callers must await the relevant
  // list()/loadSettings() calls for the entities their page needs before
  // reading this — see the page->entity map in app.js's route().
  function getState() {
    return {
      schemaVersion: SCHEMA_VERSION,
      metadata: D().getMetadataSync() || {},
      settings: D().getSettingsSync() || defaultSettings(),
      contacts: D().getCached("contacts"),
      properties: D().getCached("properties"),
      deals: D().getCached("deals"),
      activities: D().getCached("activities"),
      tasks: D().getCached("tasks"),
      showings: D().getCached("showings"),
      milestones: D().getCached("milestones"),
      referrals: D().getCached("referrals"),
      goals: D().getCached("goals"),
      scripts: D().getCached("scripts"),
      aiPrompts: D().getCached("aiPrompts"),
      income: D().getCached("income"),
      expenses: D().getCached("expenses"),
      scheduledItems: D().getCached("scheduledItems"),
      teamMembers: D().getCached("teamMembers"),
      customFieldValues: D().getCached("customFieldValues")
    };
  }

  // Awaits every entity a page needs, then returns the fresh snapshot.
  // "settings" is a valid key too (loads workspace_settings).
  async function ensureLoaded(keys) {
    await Promise.all((keys || []).map(k => (k === "settings" ? D().loadSettings() : D().list(k))));
    return getState();
  }

  // ---------- GENERIC ENTITY FACADE ----------
  function makeEntity(key) {
    return {
      list: (opts) => D().list(key, opts),
      get: (id) => D().get(key, id),
      create: (data) => D().create(key, data),
      update: (id, patch) => D().update(key, id, patch),
      delete: (id) => D().remove(key, id)
    };
  }

  async function countRelated(key, field, id) { return (await D().list(key)).filter(r => r[field] === id).length; }

  // ---- contacts (cascade preview now reads live related counts; the DB's
  // own ON DELETE SET NULL constraints do the actual unlinking) ----
  const contactsBase = makeEntity("contacts");
  const contacts = Object.assign({}, contactsBase, {
    findByStage: async (stage) => (await D().list("contacts")).filter(c => c.stage === stage),
    findByTemp: async (temp) => (await D().list("contacts")).filter(c => c.temperature === temp),
    delete: async (id, opts) => {
      const impact = {
        properties: await countRelated("properties", "contactId", id),
        deals: await countRelated("deals", "contactId", id),
        activities: await countRelated("activities", "contactId", id),
        tasks: await countRelated("tasks", "contactId", id),
        showings: await countRelated("showings", "contactId", id),
        referrals: (await D().list("referrals")).filter(r => r.referrerId === id || r.referredContactId === id).length,
        income: await countRelated("income", "contactId", id),
        expenses: await countRelated("expenses", "contactId", id)
      };
      if (!opts || !opts.force) return { deleted: false, needsConfirmation: true, impact };
      const ok = await D().remove("contacts", id);
      return { deleted: !!ok, impact };
    }
  });

  const propertiesBase = makeEntity("properties");
  const properties = Object.assign({}, propertiesBase, {
    delete: async (id, opts) => {
      const impact = {
        deals: await countRelated("deals", "propertyId", id),
        showings: await countRelated("showings", "propertyId", id),
        activities: await countRelated("activities", "propertyId", id),
        tasks: await countRelated("tasks", "propertyId", id)
      };
      if (!opts || !opts.force) return { deleted: false, needsConfirmation: true, impact };
      const ok = await D().remove("properties", id);
      return { deleted: !!ok, impact };
    }
  });

  const activities = makeEntity("activities");
  const showings = makeEntity("showings");
  // referrals.referrer_name is a required DB column derived from the
  // referrer's contact record — pages only ever set referrerId (the UI
  // field name is unchanged), so it's resolved here rather than asking
  // every call site to know about a DB-only denormalized column.
  const referralsBase = makeEntity("referrals");
  const referrals = Object.assign({}, referralsBase, {
    create: async (data) => {
      const patch = Object.assign({}, data);
      if ("referrerId" in patch && !("referrerName" in patch)) {
        const c = patch.referrerId ? D().getCached("contacts").find(x => x.id === patch.referrerId) : null;
        patch.referrerName = c ? c.name : "";
      }
      return D().create("referrals", patch);
    },
    update: async (id, patch) => {
      if (patch && "referrerId" in patch && !("referrerName" in patch)) {
        const c = patch.referrerId ? D().getCached("contacts").find(x => x.id === patch.referrerId) : null;
        patch = Object.assign({}, patch, { referrerName: c ? c.name : "" });
      }
      return D().update("referrals", id, patch);
    }
  });
  const goals = makeEntity("goals");
  const scripts = makeEntity("scripts");
  const aiPrompts = makeEntity("aiPrompts");
  const income = makeEntity("income");
  const expenses = makeEntity("expenses");
  const scheduledItems = makeEntity("scheduledItems");

  const tasksBase = makeEntity("tasks");
  const tasks = Object.assign({}, tasksBase, {
    update: async (id, patch) => {
      const existing = await D().get("tasks", id);
      if (existing) {
        const wasCompleted = existing.status === "Completed";
        const becoming = patch && patch.status === "Completed";
        if (becoming && !wasCompleted) patch = Object.assign({}, patch, { completedAt: nowISO() });
        if (patch && patch.status && patch.status !== "Completed" && wasCompleted) patch = Object.assign({}, patch, { completedAt: null });
      }
      return D().update("tasks", id, patch);
    },
    delete: async (id) => {
      const values = (await D().list("customFieldValues")).filter(v => v.entity === "task" && v.recordId === id);
      await Promise.all(values.map(v => D().remove("customFieldValues", v.id)));
      return D().remove("tasks", id);
    },
    complete: (id) => tasks.update(id, { status: "Completed" })
  });

  const milestonesBase = makeEntity("milestones");
  const milestones = Object.assign({}, milestonesBase, {
    listForDeal: async (dealId) => (await D().list("milestones")).filter(m => m.dealId === dealId).sort((a, b) => a.order - b.order),
    update: async (id, patch) => {
      const existing = await D().get("milestones", id);
      if (existing) {
        const wasComplete = existing.status === "Complete";
        const becoming = patch && patch.status === "Complete";
        if (becoming && !wasComplete) patch = Object.assign({}, patch, { completedAt: nowISO() });
        if (patch && patch.status && patch.status !== "Complete" && wasComplete) patch = Object.assign({}, patch, { completedAt: null });
      }
      return D().update("milestones", id, patch);
    },
    complete: (id) => milestones.update(id, { status: "Complete" })
  });

  function resolveDealStatusHint(stageObj) {
    return stageObj && stageObj.terminal === "won" ? "won" : (stageObj && stageObj.terminal === "lost" ? "lost" : "active");
  }

  const dealsBase = makeEntity("deals");
  const deals = Object.assign({}, dealsBase, {
    create: async (data) => {
      const st = D().getSettingsSync() || defaultSettings();
      const defaultsCd = st.commissionDefaults || {};
      const defaultStage = deals.getResolvedDefaultStage();
      const payload = Object.assign({
        name: "", contactId: null, propertyId: null, assignedToId: null, side: "Buyer",
        stage: defaultStage ? defaultStage.name : "New",
        probability: defaultStage ? defaultStage.probability : 10,
        offerDate: null, contractDate: null, closeDate: null, salePrice: 0,
        commissionRate: defaultsCd.commissionRate, teamSplit: defaultsCd.teamSplit,
        brokerageFee: defaultsCd.brokerageFee, referralFee: defaultsCd.referralFee,
        taxReserve: defaultsCd.taxReserve, notes: "", lostReason: ""
      }, data);
      payload.dealStatusHint = resolveDealStatusHint(defaultStage);
      const dealId = payload.id || uid("dl");
      // Same due-date math as the original seedMilestonesForDeal(), unchanged.
      const milestoneModels = DEFAULT_MILESTONES.map(tpl => {
        let due = null;
        if (tpl.offsetDays !== null && payload.contractDate) due = App.util.addDaysISO(payload.contractDate, tpl.offsetDays);
        else if (tpl.name === "Closing" && payload.closeDate) due = payload.closeDate;
        return { id: uid("ms"), dealId, name: tpl.name, order: tpl.order, dueDate: due, status: "Pending", completedAt: null, notes: "" };
      });
      const result = await D().createDealWithMilestones(Object.assign({}, payload, { id: dealId }), milestoneModels);
      return result.deal;
    },
    update: async (id, patch) => {
      if (patch && "stage" in patch) {
        const st = D().getSettingsSync() || {};
        const stageObj = (st.pipelineStages || []).find(x => x.name === patch.stage);
        patch = Object.assign({}, patch, { dealStatusHint: resolveDealStatusHint(stageObj) });
      }
      return D().update("deals", id, patch);
    },
    delete: async (id, opts) => {
      const impact = {
        milestones: await countRelated("milestones", "dealId", id),
        activities: await countRelated("activities", "dealId", id),
        tasks: await countRelated("tasks", "dealId", id),
        showings: await countRelated("showings", "dealId", id),
        referrals: await countRelated("referrals", "dealId", id),
        properties: await countRelated("properties", "dealId", id),
        income: await countRelated("income", "dealId", id),
        expenses: await countRelated("expenses", "dealId", id)
      };
      if (!opts || !opts.force) return { deleted: false, needsConfirmation: true, impact };
      const ok = await D().remove("deals", id);
      return { deleted: !!ok, impact };
    },
    moveToStage: async (id, stageId) => {
      const st = D().getSettingsSync() || {};
      const deal = D().getCached("deals").find(d => d.id === id) || await D().get("deals", id);
      const stage = (st.pipelineStages || []).find(x => x.id === stageId);
      if (!deal || !stage) return null;
      const oldStageObj = (st.pipelineStages || []).find(x => x.name === deal.stage);
      const userOverride = oldStageObj && Number(deal.probability) !== Number(oldStageObj.probability);
      const patch = { stage: stage.name, dealStatusHint: resolveDealStatusHint(stage) };
      if (stage.terminal === "lost") patch.probability = 0;
      else if (stage.terminal === "won") { patch.probability = 100; if (!deal.closeDate) patch.closeDate = App.util.todayISO(); }
      else if (!userOverride) patch.probability = stage.probability;
      return D().update("deals", id, patch);
    },
    getResolvedDefaultStage: () => {
      const st = D().getSettingsSync() || defaultSettings();
      const stages = (st.pipelineStages || []).slice().sort((a, b) => a.order - b.order);
      if (!stages.length) return null;
      const byId = stages.find(s => s.id === st.defaultStageId);
      return byId || stages[0];
    }
  });

  // ---------- TEAM MEMBERS ----------
  const teamMembersBase = makeEntity("teamMembers");
  const teamMembers = Object.assign({}, teamMembersBase, {
    setActive: (id, active) => teamMembers.update(id, { active: !!active }),
    delete: async (id) => {
      const ok = await D().remove("teamMembers", id);
      if (ok) {
        const st = D().getSettingsSync();
        if (st && st.currentTeamMemberId === id) await settings.update({ currentTeamMemberId: null });
      }
      return ok;
    }
  });

  // ---------- CUSTOM FIELDS ----------
  const CUSTOM_FIELD_ENTITIES = ["contact", "property", "deal", "task"];
  const CUSTOM_FIELD_TYPES = ["text", "longtext", "number", "currency", "percentage", "date", "boolean", "select", "multiselect"];
  function coerceCustomFieldValue(type, raw) {
    if (type === "number" || type === "currency" || type === "percentage") return App.util.num(raw);
    if (type === "boolean") return !!raw;
    if (type === "multiselect") return Array.isArray(raw) ? raw.slice() : [];
    if (type === "select") return (typeof raw === "string" && raw) ? raw : null;
    return (raw === null || raw === undefined) ? "" : String(raw);
  }
  function cfDefs() { const s = D().getSettingsSync(); return (s && s.customFields && s.customFields.definitions) || []; }

  const customFields = {
    ENTITIES: CUSTOM_FIELD_ENTITIES,
    TYPES: CUSTOM_FIELD_TYPES,
    definitionsFor: (entity) => cfDefs().filter(f => f.entity === entity).sort((a, b) => (a.order || 0) - (b.order || 0)),
    activeDefinitionsFor: (entity) => customFields.definitionsFor(entity).filter(f => f.active !== false),
    getDefinition: (fieldId) => cfDefs().find(f => f.id === fieldId) || null,
    define: async (entity, opts) => {
      if (CUSTOM_FIELD_ENTITIES.indexOf(entity) === -1) return null;
      const label = String((opts && opts.label) || "").trim();
      if (!label) return null;
      const type = opts && opts.type;
      if (CUSTOM_FIELD_TYPES.indexOf(type) === -1) return null;
      if (cfDefs().some(f => f.entity === entity && f.active !== false && f.label.toLowerCase() === label.toLowerCase())) return null;
      const maxOrder = cfDefs().filter(f => f.entity === entity).reduce((m, f) => Math.max(m, f.order || 0), 0);
      const options = (type === "select" || type === "multiselect") ? (Array.isArray(opts.options) ? opts.options.map(o => ({ id: uid("opt"), label: String(o).trim() })).filter(o => o.label) : []) : [];
      const field = { id: uid("cf"), entity, label, helpText: (opts && opts.helpText) || "", type, required: !!(opts && opts.required), defaultValue: coerceCustomFieldValue(type, opts && opts.defaultValue), options, order: maxOrder + 1, active: true };
      const s = await D().updateSettings({ customFields: { definitions: cfDefs().concat([field]) } });
      return s ? field : null;
    },
    update: async (fieldId, patch) => {
      const f = customFields.getDefinition(fieldId);
      if (!f) return null;
      const next = Object.assign({}, f);
      if (patch && typeof patch.label === "string") {
        const label = patch.label.trim();
        if (!label) return null;
        if (cfDefs().some(x => x.id !== fieldId && x.entity === f.entity && x.active !== false && x.label.toLowerCase() === label.toLowerCase())) return null;
        next.label = label;
      }
      if (patch && typeof patch.helpText === "string") next.helpText = patch.helpText;
      if (patch && typeof patch.required === "boolean") next.required = patch.required;
      if (patch && patch.defaultValue !== undefined) next.defaultValue = coerceCustomFieldValue(f.type, patch.defaultValue);
      const s = await D().updateSettings({ customFields: { definitions: cfDefs().map(x => x.id === fieldId ? next : x) } });
      return s ? next : null;
    },
    setActive: async (fieldId, active) => {
      const f = customFields.getDefinition(fieldId);
      if (!f) return null;
      const s = await D().updateSettings({ customFields: { definitions: cfDefs().map(x => x.id === fieldId ? Object.assign({}, x, { active: !!active }) : x) } });
      return s ? Object.assign({}, f, { active: !!active }) : null;
    },
    countValues: async (fieldId) => (await D().list("customFieldValues")).filter(v => v.fieldId === fieldId).length,
    reorder: async (entity, orderedIds) => {
      if (!Array.isArray(orderedIds)) return null;
      const ids = cfDefs().filter(f => f.entity === entity).map(f => f.id);
      const known = new Set(ids);
      if (orderedIds.some(id => !known.has(id))) return null;
      const missing = ids.filter(id => orderedIds.indexOf(id) === -1);
      const order = orderedIds.concat(missing);
      const nextDefs = cfDefs().map(f => { const idx = order.indexOf(f.id); return idx === -1 ? f : Object.assign({}, f, { order: idx + 1 }); });
      const s = await D().updateSettings({ customFields: { definitions: nextDefs } });
      return s ? customFields.definitionsFor(entity) : null;
    },
    deleteDefinition: async (fieldId, opts) => {
      const f = customFields.getDefinition(fieldId);
      if (!f) return null;
      const usage = await customFields.countValues(fieldId);
      if (usage > 0 && !(opts && opts.force)) return null;
      const s = await D().updateSettings({ customFields: { definitions: cfDefs().filter(x => x.id !== fieldId) } });
      if (!s) return null;
      const values = (await D().list("customFieldValues")).filter(v => v.fieldId === fieldId);
      await Promise.all(values.map(v => D().remove("customFieldValues", v.id)));
      return true;
    },
    addOption: async (fieldId, label) => {
      const f = customFields.getDefinition(fieldId);
      const trimmed = String(label || "").trim();
      if (!f || !trimmed || (f.type !== "select" && f.type !== "multiselect")) return null;
      if (f.options.some(o => o.label.toLowerCase() === trimmed.toLowerCase())) return null;
      const opt = { id: uid("opt"), label: trimmed };
      const s = await D().updateSettings({ customFields: { definitions: cfDefs().map(x => x.id === fieldId ? Object.assign({}, x, { options: x.options.concat([opt]) }) : x) } });
      return s ? opt : null;
    },
    renameOption: async (fieldId, optionId, label) => {
      const f = customFields.getDefinition(fieldId);
      const trimmed = String(label || "").trim();
      if (!f || !trimmed) return null;
      const opt = f.options.find(o => o.id === optionId);
      if (!opt) return null;
      if (f.options.some(o => o.id !== optionId && o.label.toLowerCase() === trimmed.toLowerCase())) return null;
      const s = await D().updateSettings({ customFields: { definitions: cfDefs().map(x => x.id === fieldId ? Object.assign({}, x, { options: x.options.map(o => o.id === optionId ? Object.assign({}, o, { label: trimmed }) : o) }) : x) } });
      return s ? Object.assign({}, opt, { label: trimmed }) : null;
    },
    countOptionUsage: async (fieldId, optionId) => (await D().list("customFieldValues")).filter(v => v.fieldId === fieldId && (Array.isArray(v.value) ? v.value.indexOf(optionId) !== -1 : v.value === optionId)).length,
    deleteOption: async (fieldId, optionId) => {
      const f = customFields.getDefinition(fieldId);
      if (!f) return null;
      const usage = await customFields.countOptionUsage(fieldId, optionId);
      if (usage > 0) return null;
      const s = await D().updateSettings({ customFields: { definitions: cfDefs().map(x => x.id === fieldId ? Object.assign({}, x, { options: x.options.filter(o => o.id !== optionId) }) : x) } });
      return !!s;
    },
    valuesFor: async (entity, recordId) => (await D().list("customFieldValues")).filter(v => v.entity === entity && v.recordId === recordId),
    getValue: async (entity, recordId, fieldId) => {
      const row = (await D().list("customFieldValues")).find(v => v.entity === entity && v.recordId === recordId && v.fieldId === fieldId);
      return row ? row.value : undefined;
    },
    setValues: async (entity, recordId, valuesByFieldId) => {
      const existing = await D().list("customFieldValues");
      const keys = Object.keys(valuesByFieldId || {});
      for (const fieldId of keys) {
        const f = customFields.getDefinition(fieldId);
        if (!f || f.entity !== entity) continue;
        const value = coerceCustomFieldValue(f.type, valuesByFieldId[fieldId]);
        const row = existing.find(v => v.entity === entity && v.recordId === recordId && v.fieldId === fieldId);
        if (row) await D().update("customFieldValues", row.id, { value });
        else await D().create("customFieldValues", { entity, recordId, fieldId, value });
      }
      return true;
    },
    setValue: async (entity, recordId, fieldId, rawValue) => {
      const patch = {}; patch[fieldId] = rawValue;
      const ok = await customFields.setValues(entity, recordId, patch);
      return ok ? customFields.getValue(entity, recordId, fieldId) : null;
    }
  };

  // ---------- SETTINGS ----------
  const settings = {
    get: () => D().getSettingsSync() || defaultSettings(),
    // Phase 2D. The server's own zone list, for the settings screen.
    listTimezones: () => D().listTimezones(),
    update: async (patch) => {
      const next = await D().updateSettings(patch);
      if (patch && (Object.prototype.hasOwnProperty.call(patch, "agentName") || Object.prototype.hasOwnProperty.call(patch, "agencyName"))) {
        const metaPatch = {};
        if ("agentName" in patch) metaPatch.agentName = patch.agentName || "";
        if ("agencyName" in patch) metaPatch.agencyName = patch.agencyName || "";
        await D().updateMetadata(metaPatch);
      }
      return next;
    },
    updateCommissionDefaults: async (patch) => {
      const cur = (D().getSettingsSync() || {}).commissionDefaults || {};
      const next = await D().updateSettings({ commissionDefaults: Object.assign({}, cur, patch) });
      return next ? next.commissionDefaults : null;
    },
    LOGO_MAX_BYTES: 220000,
    updateBusinessProfile: async (patch) => {
      const cur = (D().getSettingsSync() || {}).businessProfile || defaultBusinessProfile();
      const next = Object.assign({}, cur, patch || {});
      if (typeof next.logoDataUri === "string" && next.logoDataUri && next.logoDataUri.length > settings.LOGO_MAX_BYTES) {
        return { ok: false, error: "Logo is too large. Choose an image under ~150 KB." };
      }
      if (next.businessType !== null && ["independent", "broker", "agency", "team"].indexOf(next.businessType) === -1) next.businessType = cur.businessType;
      const s = await D().updateSettings({ businessProfile: next });
      return s ? { ok: true, businessProfile: next } : { ok: false, error: "Could not save. Please try again." };
    },
    getCustomization: () => (D().getSettingsSync() || {}).customization,
    updateEnabledModules: async (patch) => {
      const cur = (D().getSettingsSync() || {}).customization || defaultCustomization();
      const dc = defaultCustomization().enabledModules;
      const merged = Object.assign({}, cur.enabledModules, patch || {});
      const clean = {}; Object.keys(dc).forEach(k => { clean[k] = (typeof merged[k] === "boolean") ? merged[k] : dc[k]; });
      const s = await D().updateSettings({ customization: Object.assign({}, cur, { enabledModules: clean }) });
      return s ? s.customization : null;
    },
    updateDashboardWidgets: async (patch) => {
      const cur = (D().getSettingsSync() || {}).customization || defaultCustomization();
      const dc = defaultCustomization().dashboardWidgets;
      const merged = {};
      Object.keys(dc).forEach(k => {
        const incoming = (patch && patch[k]) || cur.dashboardWidgets[k] || dc[k];
        merged[k] = { visible: (typeof incoming.visible === "boolean") ? incoming.visible : dc[k].visible, order: (typeof incoming.order === "number" && isFinite(incoming.order)) ? incoming.order : dc[k].order };
      });
      const s = await D().updateSettings({ customization: Object.assign({}, cur, { dashboardWidgets: merged }) });
      return s ? s.customization : null;
    },
    // Team mode lives with the other customization flags, so it travels with
    // the workspace rather than with one browser.
    setTeamMode: async (on) => {
      const cur = (D().getSettingsSync() || {}).customization || defaultCustomization();
      const s = await D().updateSettings({ customization: Object.assign({}, cur, { teamMode: !!on }) });
      return s ? s.customization : null;
    },
    resetCustomization: async () => { const s = await D().updateSettings({ customization: defaultCustomization() }); return s ? s.customization : null; },
    resetEnabledModules: async () => {
      const cur = (D().getSettingsSync() || {}).customization || defaultCustomization();
      const s = await D().updateSettings({ customization: Object.assign({}, cur, { enabledModules: defaultCustomization().enabledModules }) });
      return s ? s.customization : null;
    },
    resetDashboardWidgets: async () => {
      const cur = (D().getSettingsSync() || {}).customization || defaultCustomization();
      const s = await D().updateSettings({ customization: Object.assign({}, cur, { dashboardWidgets: defaultCustomization().dashboardWidgets }) });
      return s ? s.customization : null;
    },
    renamePipelineStage: async (stageId, newName) => {
      const trimmed = String(newName || "").trim();
      if (!trimmed) return null;
      const stages = (D().getSettingsSync() || {}).pipelineStages || [];
      const stage = stages.find(s => s.id === stageId);
      if (!stage) return null;
      if (stages.some(s => s.id !== stageId && s.name.toLowerCase() === trimmed.toLowerCase())) return null;
      const oldName = stage.name;
      const nextStages = stages.map(s => s.id === stageId ? Object.assign({}, s, { name: trimmed }) : s);
      if (oldName !== trimmed) {
        const affected = (await D().list("deals")).filter(d => d.stage === oldName);
        for (const d of affected) await D().update("deals", d.id, { stage: trimmed });
      }
      const s = await D().updateSettings({ pipelineStages: nextStages });
      return s ? s.pipelineStages : null;
    },
    reorderPipelineStages: async (orderedIds) => {
      if (!Array.isArray(orderedIds)) return null;
      const stages = (D().getSettingsSync() || {}).pipelineStages || [];
      const knownIds = new Set(stages.map(s => s.id));
      if (orderedIds.some(id => !knownIds.has(id))) return null;
      const missing = stages.map(s => s.id).filter(id => orderedIds.indexOf(id) === -1);
      const finalOrder = orderedIds.concat(missing);
      const nextStages = stages.map(s => Object.assign({}, s, { order: finalOrder.indexOf(s.id) + 1 }));
      const s = await D().updateSettings({ pipelineStages: nextStages });
      return s ? s.pipelineStages : null;
    },
    countDealsInStage: async (stageId) => {
      const stages = (D().getSettingsSync() || {}).pipelineStages || [];
      const st = stages.find(s => s.id === stageId);
      if (!st) return 0;
      return (await D().list("deals")).filter(d => d.stage === st.name).length;
    },
    addPipelineStage: async (opts) => {
      const name = String((opts && opts.name) || "").trim();
      if (!name) return null;
      const stages = (D().getSettingsSync() || {}).pipelineStages || [];
      if (stages.some(s => s.name.toLowerCase() === name.toLowerCase())) return null;
      const maxOrder = stages.reduce((m, s) => Math.max(m, s.order || 0), 0);
      const rawProbability = (opts && opts.probability !== undefined && opts.probability !== null && opts.probability !== "") ? opts.probability : 10;
      const stage = { id: uid("stg"), name, probability: App.util.clamp(rawProbability, 0, 100), color: (opts && opts.color) || "#94A3B8", order: maxOrder + 1, terminal: (opts && (opts.terminal === "won" || opts.terminal === "lost")) ? opts.terminal : null };
      let nextStages = stages.concat([stage]);
      if (stage.terminal === "won") nextStages = nextStages.map(s => s.id === stage.id ? s : (s.terminal === "won" ? Object.assign({}, s, { terminal: null }) : s));
      const s = await D().updateSettings({ pipelineStages: nextStages });
      return s ? stage : null;
    },
    setStageTerminal: async (stageId, terminal) => {
      if (terminal !== "won" && terminal !== "lost" && terminal !== null) return null;
      const stages = (D().getSettingsSync() || {}).pipelineStages || [];
      if (!stages.some(s => s.id === stageId)) return null;
      let nextStages = stages.map(s => s.id === stageId ? Object.assign({}, s, { terminal }) : s);
      if (terminal === "won") nextStages = nextStages.map(s => (s.id !== stageId && s.terminal === "won") ? Object.assign({}, s, { terminal: null }) : s);
      const s = await D().updateSettings({ pipelineStages: nextStages });
      return s ? s.pipelineStages : null;
    },
    getDefaultStage: () => deals.getResolvedDefaultStage(),
    setDefaultStage: async (stageId) => {
      const stages = (D().getSettingsSync() || {}).pipelineStages || [];
      if (!stages.some(s => s.id === stageId)) return null;
      const s = await D().updateSettings({ defaultStageId: stageId });
      return s ? stageId : null;
    },
    reassignDealsFromStage: async (fromStageId, toStageId) => {
      if (fromStageId === toStageId) return null;
      const stages = (D().getSettingsSync() || {}).pipelineStages || [];
      const from = stages.find(s => s.id === fromStageId), to = stages.find(s => s.id === toStageId);
      if (!from || !to) return null;
      const affected = (await D().list("deals")).filter(d => d.stage === from.name);
      for (const d of affected) await deals.moveToStage(d.id, toStageId);
      return affected.length;
    },
    deletePipelineStage: async (stageId) => {
      const stages = (D().getSettingsSync() || {}).pipelineStages || [];
      const stage = stages.find(s => s.id === stageId);
      if (!stage) return null;
      if (stages.length <= 1) return null;
      const usage = (await D().list("deals")).filter(d => d.stage === stage.name).length;
      if (usage > 0) return null;
      const nextStages = stages.filter(s => s.id !== stageId).sort((a, b) => a.order - b.order).map((s, i) => Object.assign({}, s, { order: i + 1 }));
      const patch = { pipelineStages: nextStages };
      if ((D().getSettingsSync() || {}).defaultStageId === stageId) patch.defaultStageId = nextStages.length ? nextStages[0].id : null;
      const s = await D().updateSettings(patch);
      return s ? s.pipelineStages : null;
    }
  };

  // ---------- HOUSEKEEPING ----------
  async function resetWorkspace() {
    try { await D().resetWorkspace(); return true; }
    catch (e) { return false; }
  }

  // Daily View / quick-add follow-up logging: creates the Activity and
  // advances the contact's lastContact/nextFollowUp as one atomic operation
  // via the realtoros_complete_followup RPC (see App.data.completeFollowUp),
  // replacing the old client-side App.store.runBatch() pairing.
  async function completeFollowUp(activityPatch, contactId, lastContact, nextFollowUp) {
    return D().completeFollowUp(activityPatch, contactId, lastContact, nextFollowUp);
  }

  // ---------- GOOGLE SHEETS CONNECTIONS (Phase 3B) ----------
  // Thin pass-through to App.data — no caching here. In particular, the
  // one-time connector token returned by createOrRotate is never cached or
  // stored by this facade; the caller (the Settings page) is responsible
  // for showing it exactly once and discarding it.
  const sheetConnections = {
    list: () => D().listSheetConnections(),
    createOrRotate: (payload) => D().createOrRotateSheetConnection(payload)
  };

  // ---------- GOOGLE SHEETS IMPORT HISTORY (Phase 3C) ----------
  // Thin, read-only pass-through — no caching, no writes. Nothing here is
  // ever stored in workspace settings, metadata, or browser storage.
  const sheetImportHistory = {
    listBatches: (opts) => D().listImportBatches(opts),
    listRows: (batchId, opts) => D().listImportRows(batchId, opts)
  };

  // ---------- LEAD FILE IMPORT (Phase 4E.4) ----------
  // submit() is the only write, and it goes through the import-lead-file
  // Edge Function. Rows are passed straight through, never cached.
  const leadFileImport = {
    submit: (payload) => D().importLeadFile(payload),
    quota: () => D().getLeadFileImportQuota(),
    refreshContacts: () => D().list("contacts", { force: true })
  };

  // ---------- NOTIFICATIONS (Phase 4H) ----------
  // Read + mark read only; notifications are created by the database.
  const notifications = {
    list: (opts) => D().listNotifications(opts),
    unreadCount: () => D().countUnreadNotifications(),
    markRead: (id) => D().markNotificationRead(id),
    markAllRead: () => D().markAllNotificationsRead()
  };

  // ---------- PUSH (Phase 3B) ----------
  // Devices and preferences. Registering and removing go through the
  // database functions, never a direct write.
  const push = {
    devices: () => D().listPushDevices(),
    register: (subscription, label) => D().registerPushDevice(subscription, label),
    remove: (endpoint) => D().removePushDevice(endpoint),
    preferences: () => D().getNotificationPreferences(),
    savePreferences: (prefs) => D().saveNotificationPreferences(prefs)
  };

  // ---------- EMAIL TEMPLATES (Phase 4B) ----------
  // Thin pass-through, no caching — configuration CRUD only. Saving a
  // template never sends anything; there is no send/provider call
  // anywhere behind this facade.
  const messageTemplates = {
    list: (opts) => D().listMessageTemplates(opts),
    create: (model) => D().createMessageTemplate(model),
    update: (id, patch) => D().updateMessageTemplate(id, patch),
    // Activating always re-validates the stored template server-side
    // (name/subject/body) via the dedicated activateMessageTemplate;
    // deactivating has no such requirement and stays a plain update.
    activate: (id) => D().activateMessageTemplate(id),
    setActive: (id, isActive) => isActive ? D().activateMessageTemplate(id) : D().updateMessageTemplate(id, { isActive: false }),
    delete: (id) => D().deleteMessageTemplate(id)
  };

  // ---------- LEGACY SCRIPT IMPORT (Phase 4B) ----------
  // User-triggered only. The original Script rows are never modified or
  // deleted by anything reachable from this facade.
  const legacyScriptImport = {
    listEligible: () => D().listEligibleLegacyScriptImports(),
    importByIds: (scriptIds) => D().importLegacyScriptsAsTemplates(scriptIds)
  };

  // ---------- DRAFT AUTOMATION SEQUENCES (Phase 4B) ----------
  // Configuration CRUD only — no enrollment, job, or run is ever created
  // from this facade, and there is no "activate" method: new rules are
  // always created as drafts, and updates can never change status.
  const automationRules = {
    list: () => D().listAutomationRules(),
    create: (model) => D().createAutomationRule(model),
    update: (id, patch) => D().updateAutomationRule(id, patch),
    delete: (id) => D().deleteAutomationRule(id)
  };
  const automationSteps = {
    list: (ruleId) => D().listAutomationSteps(ruleId),
    create: (ruleId, model) => D().createAutomationStep(ruleId, model),
    update: (id, model) => D().updateAutomationStep(id, model),
    delete: (id) => D().deleteAutomationStep(id)
  };

  // ---------- AUTOMATION RUNTIME (Phase 4D) ----------
  // Thin pass-through, no caching. Every mutating call here goes through
  // the authenticated manage-automation Edge Function (see data-service.js)
  // — this facade never writes to a runtime table directly. The list
  // methods are read-only, owner-scoped, explicit-safe-column reads.
  const automationRuntime = {
    activate: (ruleId) => D().activateAutomationRule(ruleId),
    pause: (ruleId) => D().pauseAutomationRule(ruleId),
    resume: (ruleId) => D().resumeAutomationRule(ruleId),
    archive: (ruleId) => D().archiveAutomationRule(ruleId),
    manualEnroll: (ruleId, contactId) => D().manualEnrollContact(ruleId, contactId),
    retryJob: (jobId) => D().retryAutomationJob(jobId),
    listEnrollments: (ruleId, opts) => D().listAutomationEnrollments(ruleId, opts),
    listJobs: (enrollmentId, opts) => D().listAutomationJobs(enrollmentId, opts),
    listRuns: (jobId, opts) => D().listAutomationRuns(jobId, opts),
    listFailures: (ruleId, opts) => D().listAutomationFailuresForRule(ruleId, opts),
    // Phase 4E, read-only. There is deliberately no stop/cancel facade
    // method: every automatic lifecycle stop is applied server-side by the
    // resend-webhook, email-unsubscribe or process-automation Edge
    // Functions, and pages can only ever read the result.
    stopSummary: (ruleId, opts) => D().getAutomationStopSummary(ruleId, opts),
    contactLifecycle: (contactId) => D().getContactLifecycleStatus(contactId),
    contactEmailStatus: (contactId) => D().getContactEmailStatus(contactId),
    // Phase 4E.2: the owner's manual fallbacks. Both go through the
    // authenticated manage-automation Edge Function (owner-verified from
    // the JWT) — never a browser write to contacts, consents or
    // suppressions.
    markReplied: (contactId) => D().markContactReplied(contactId),
    markUnsubscribed: (contactId) => D().markContactUnsubscribed(contactId)
  };

  // ---------- EMAIL SENDER PROFILE + TEST SEND (Phase 4C) ----------
  // Thin pass-through, no caching. sendTestEmail is this app's only path
  // to an IMMEDIATE, single test send, and it never talks to Resend
  // directly — it only invokes the authenticated send-test-email Supabase
  // Edge Function. It is not the only way a real send can ever happen,
  // though: automationRuntime.activate (above) can also lead to a real
  // send, but only later and only from the server-only process-automation
  // worker — never directly from this browser code.
  const emailSenderProfile = {
    get: () => D().getEmailSenderProfile(),
    save: (model) => D().saveEmailSenderProfile(model)
  };
  const testEmail = {
    send: (payload) => D().sendTestEmail(payload),
    listRecent: (opts) => D().listRecentTestOutboundMessages(opts)
  };

  // ---------- TEAM ----------
  // Membership, invitations and permissions. Pages never reach past this to
  // Supabase, exactly as with every entity above. Each method answers with
  // the server's own { outcome } object; the screens turn those into words.
  const team = {
    listMembers: () => D().listMembers(),
    listInvitations: () => D().listInvitations(),
    invite: (email, role) => D().inviteMember(email, role),
    revokeInvitation: (invitationId) => D().revokeInvitation(invitationId),
    acceptInvitation: (token) => D().acceptTeamInvitation(token),
    remove: (memberId) => D().removeMember(memberId),
    changeRole: (memberId, role) => D().changeMemberRole(memberId, role),
    transferOwnership: (memberId) => D().transferTeamOwnership(memberId),
    leave: () => D().leaveTeam(),
    deleteTeam: (confirmName) => D().deleteTeam(confirmName),
    rolePermissions: () => D().listRolePermissions(),
    setRolePermissions: (role, permissions) => D().setRolePermissions(role, permissions),
    setMemberPermissions: (memberId, overrides) => D().setMemberPermissions(memberId, overrides),
    resetMemberPermissions: (memberId) => D().resetMemberPermissions(memberId)
  };

  return {
    SCHEMA_VERSION,
    getState, ensureLoaded,
    getSyncState, onSyncStateChange,
    migrateData: (raw) => normalize(runMigrations(raw)),
    contacts, properties, deals, milestones,
    activities, tasks, showings, referrals, goals,
    scripts, aiPrompts, income, expenses, scheduledItems, teamMembers,
    settings, customFields,
    resetWorkspace, completeFollowUp,
    sheetConnections, sheetImportHistory, leadFileImport, notifications, push,
    messageTemplates, legacyScriptImport, automationRules, automationSteps, automationRuntime,
    emailSenderProfile, testEmail, team,
    resetAllCaches: () => D().resetAllCaches(),
    _emptyState: emptyState,
    _normalize: normalize,
    _defaultCustomization: defaultCustomization
  };
})();

