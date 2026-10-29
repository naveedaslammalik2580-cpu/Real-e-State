/* ============================================================
   data.js — the sole per-entity Supabase business-data boundary.
   Every entity CRUD call goes directly to its own relational table
   (see ENTITY_REGISTRY, built from the live schema of the "Realtor OS"
   Supabase project, verified via the connected tooling before writing
   this file — column names/types below are not guessed).

   App.store (rewritten alongside this file) is now a thin async facade
   over this module, so every existing page's S().<entity>.<method>()
   call sites keep the exact same method names/shapes — only `await` and
   error/loading handling were added at each call site.

   Cache here is a read-model only, kept for render compatibility across
   a session. Supabase is always the source of truth: every mutation
   awaits Supabase first and only updates the cache with what Supabase
   actually returned. No optimistic mutation.
   ============================================================ */
window.App = window.App || {};
App.data = (function () {
  "use strict";
  const U = () => App.util;

  function client() { return App.cloud.getClient(); }
  function requireUser() {
    const u = App.cloud.getUser();
    if (!u) throw new Error("Not signed in.");
    return u;
  }

  function n(v) { return (v === null || v === undefined || v === "") ? null : v; }
  function num(v) { return App.util.num(v); }

  // ---------- ENTITY REGISTRY ----------
  const REGISTRY = {
    contacts: {
      table: "contacts", idPrefix: "ct",
      toRow(m) {
        const row = {};
        if ("name" in m) row.full_name = m.name || "";
        if ("role" in m) row.type = m.role || "Buyer";
        if ("email" in m) row.email = m.email || "";
        if ("phone" in m) row.phone = m.phone || "";
        if ("stage" in m) row.status = m.stage || "New Lead";
        if ("source" in m) row.source = m.source || "Other";
        if ("temperature" in m) row.temperature = m.temperature || "Warm";
        if ("lastContact" in m) row.last_contact = n(m.lastContact);
        if ("nextFollowUp" in m) row.next_follow_up = n(m.nextFollowUp);
        // Phase 2D. Ordinary editable dates, unlike the lifecycle columns
        // below: the agent types these in, so they travel both ways.
        if ("birthday" in m) row.birthday = n(m.birthday);
        if ("homePurchaseDate" in m) row.home_purchase_date = n(m.homePurchaseDate);
        if ("budget" in m) row.budget = num(m.budget);
        if ("preferredArea" in m) row.preferred_area = m.preferredArea || "";
        if ("assignedAgent" in m) row.assigned_agent = m.assignedAgent || "Self";
        // Who the lead belongs to, as a team_members id. Distinct from the
        // legacy free-text assignedAgent, which stays exactly as it was:
        // this one is the column the workspace policies and the
        // contacts_enforce_assignment trigger actually read.
        if ("assignedToId" in m) row.assigned_to_id = n(m.assignedToId);
        if ("notes" in m) row.notes = m.notes || "";
        return row;
      },
      fromRow(r) {
        return {
          id: r.id, name: r.full_name, role: r.type, email: r.email, phone: r.phone,
          stage: r.status, source: r.source, temperature: r.temperature,
          lastContact: r.last_contact, nextFollowUp: r.next_follow_up,
          birthday: r.birthday, homePurchaseDate: r.home_purchase_date,
          budget: Number(r.budget) || 0, preferredArea: r.preferred_area,
          assignedAgent: r.assigned_agent, assignedToId: r.assigned_to_id, notes: r.notes,
          // Read-only here, and deliberately not in toRow: the lifecycle
          // columns are maintained by the server and the database refuses a
          // browser write to them. Phase 2B's Today screen reads replies;
          // Phase 2C's response-time figures read the first touch.
          replyDetectedAt: r.reply_detected_at,
          firstTouchedAt: r.first_touched_at,
          createdAt: r.created_at, updatedAt: r.updated_at
        };
      }
    },
    properties: {
      table: "properties", idPrefix: "pr",
      toRow(m) {
        const row = {};
        if ("address" in m) row.address = m.address || "";
        if ("mls" in m) row.mls = m.mls || "";
        if ("url" in m) row.url = m.url || "";
        if ("status" in m) row.status = m.status || "Active";
        if ("listPrice" in m) row.price = num(m.listPrice);
        if ("offerPrice" in m) row.offer_price = num(m.offerPrice);
        if ("beds" in m) row.bedrooms = num(m.beds);
        if ("baths" in m) row.bathrooms = num(m.baths);
        if ("sqft" in m) row.sqft = num(m.sqft);
        if ("listingDate" in m) row.listing_date = n(m.listingDate);
        if ("targetClose" in m) row.target_close = n(m.targetClose);
        if ("contactId" in m) row.contact_id = n(m.contactId);
        if ("dealId" in m) row.deal_id = n(m.dealId);
        if ("notes" in m) row.notes = m.notes || "";
        return row;
      },
      fromRow(r) {
        return {
          id: r.id, address: r.address, mls: r.mls, url: r.url, status: r.status,
          listPrice: Number(r.price) || 0, offerPrice: Number(r.offer_price) || 0,
          beds: r.bedrooms || 0, baths: Number(r.bathrooms) || 0, sqft: r.sqft || 0,
          listingDate: r.listing_date, targetClose: r.target_close,
          contactId: r.contact_id, dealId: r.deal_id, notes: r.notes,
          createdAt: r.created_at, updatedAt: r.updated_at
        };
      }
    },
    deals: {
      table: "deals", idPrefix: "dl",
      toRow(m) {
        const row = {};
        if ("name" in m) row.title = m.name || "";
        if ("contactId" in m) row.contact_id = n(m.contactId);
        if ("propertyId" in m) row.property_id = n(m.propertyId);
        if ("assignedToId" in m) row.assigned_to_id = n(m.assignedToId);
        if ("side" in m) row.side = m.side || "Buyer";
        if ("stage" in m) row.stage = m.stage || "New";
        if ("probability" in m) row.probability = num(m.probability);
        if ("offerDate" in m) row.offer_date = n(m.offerDate);
        if ("contractDate" in m) row.contract_date = n(m.contractDate);
        if ("closeDate" in m) row.expected_close = n(m.closeDate);
        if ("salePrice" in m) row.value = num(m.salePrice);
        if ("commissionRate" in m) row.commission_rate = num(m.commissionRate);
        if ("teamSplit" in m) row.team_split = num(m.teamSplit);
        if ("brokerageFee" in m) row.brokerage_fee = num(m.brokerageFee);
        if ("referralFee" in m) row.referral_fee = num(m.referralFee);
        if ("taxReserve" in m) row.tax_reserve = num(m.taxReserve);
        if ("notes" in m) row.notes = m.notes || "";
        if ("lostReason" in m) row.lost_reason = m.lostReason || "";
        // Never a new user-facing field: a derived hint the deals entity
        // wrapper sets from the already-existing stage.terminal concept so
        // the DB's NOT NULL `status` column tracks won/lost/active without
        // introducing any new business calculation.
        if ("dealStatusHint" in m) row.status = m.dealStatusHint;
        return row;
      },
      fromRow(r) {
        return {
          id: r.id, name: r.title, contactId: r.contact_id, propertyId: r.property_id,
          assignedToId: r.assigned_to_id, side: r.side, stage: r.stage,
          probability: Number(r.probability) || 0, offerDate: r.offer_date,
          contractDate: r.contract_date, closeDate: r.expected_close,
          salePrice: Number(r.value) || 0, commissionRate: Number(r.commission_rate) || 0,
          teamSplit: Number(r.team_split) || 0, brokerageFee: Number(r.brokerage_fee) || 0,
          referralFee: Number(r.referral_fee) || 0, taxReserve: Number(r.tax_reserve) || 0,
          notes: r.notes, lostReason: r.lost_reason,
          createdAt: r.created_at, updatedAt: r.updated_at
        };
      }
    },
    milestones: {
      table: "milestones", idPrefix: "ms",
      toRow(m) {
        const row = {};
        if ("dealId" in m) row.deal_id = m.dealId;
        if ("name" in m) row.title = m.name || "";
        if ("order" in m) row.order_index = num(m.order) || 99;
        if ("dueDate" in m) row.due_date = n(m.dueDate);
        if ("status" in m) { row.status = m.status; row.completed = m.status === "Complete"; }
        if ("completedAt" in m) row.completed_at = n(m.completedAt);
        if ("notes" in m) row.notes = m.notes || "";
        return row;
      },
      fromRow(r) {
        return {
          id: r.id, dealId: r.deal_id, name: r.title, order: r.order_index,
          dueDate: r.due_date, status: r.status, completedAt: r.completed_at,
          notes: r.notes, createdAt: r.created_at, updatedAt: r.updated_at
        };
      }
    },
    activities: {
      table: "activities", idPrefix: "ac",
      toRow(m) {
        const row = {};
        if ("type" in m) row.type = m.type || "Note";
        if ("date" in m) row.date = m.date || new Date().toISOString();
        if ("contactId" in m) row.contact_id = n(m.contactId);
        if ("propertyId" in m) row.property_id = n(m.propertyId);
        if ("dealId" in m) row.deal_id = n(m.dealId);
        if ("taskId" in m) row.task_id = n(m.taskId);
        if ("subject" in m) row.subject = m.subject || "";
        if ("notes" in m) row.notes = m.notes || "";
        if ("outcome" in m) row.outcome = m.outcome || "";
        return row;
      },
      fromRow(r) {
        return {
          id: r.id, type: r.type, date: r.date, contactId: r.contact_id,
          propertyId: r.property_id, dealId: r.deal_id, taskId: r.task_id,
          subject: r.subject, notes: r.notes, outcome: r.outcome,
          createdAt: r.created_at, updatedAt: r.updated_at
        };
      }
    },
    tasks: {
      table: "tasks", idPrefix: "tk",
      toRow(m) {
        const row = {};
        if ("title" in m) row.title = m.title || "";
        if ("dueDate" in m) row.due_date = n(m.dueDate);
        if ("priority" in m) row.priority = m.priority || "Medium";
        if ("status" in m) { row.status = m.status; row.completed = m.status === "Completed"; }
        if ("contactId" in m) row.contact_id = n(m.contactId);
        if ("propertyId" in m) row.property_id = n(m.propertyId);
        if ("dealId" in m) row.deal_id = n(m.dealId);
        if ("assignedToId" in m) row.assigned_to_id = n(m.assignedToId);
        if ("notes" in m) row.notes = m.notes || "";
        if ("completedAt" in m) row.completed_at = n(m.completedAt);
        return row;
      },
      fromRow(r) {
        return {
          id: r.id, title: r.title, dueDate: r.due_date, priority: r.priority,
          status: r.status, contactId: r.contact_id, propertyId: r.property_id,
          dealId: r.deal_id, assignedToId: r.assigned_to_id, notes: r.notes,
          completedAt: r.completed_at,
          createdAt: r.created_at, updatedAt: r.updated_at
        };
      }
    },
    showings: {
      table: "showings", idPrefix: "sh",
      toRow(m) {
        const row = {};
        if ("date" in m) row.date = n(m.date);
        if ("startTime" in m) row.start_time = m.startTime || "10:00";
        if ("endTime" in m) row.end_time = m.endTime || "";
        if ("contactId" in m) row.contact_id = n(m.contactId);
        if ("propertyId" in m) row.property_id = n(m.propertyId);
        if ("dealId" in m) row.deal_id = n(m.dealId);
        if ("status" in m) row.status = m.status || "Scheduled";
        if ("notes" in m) row.notes = m.notes || "";
        return row;
      },
      fromRow(r) {
        return {
          id: r.id, date: r.date, startTime: r.start_time, endTime: r.end_time,
          contactId: r.contact_id, propertyId: r.property_id, dealId: r.deal_id,
          status: r.status, notes: r.notes,
          createdAt: r.created_at, updatedAt: r.updated_at
        };
      }
    },
    referrals: {
      table: "referrals", idPrefix: "rf",
      toRow(m, ctx) {
        const row = {};
        if ("referrerId" in m) {
          row.referrer_contact_id = n(m.referrerId);
          const c = ctx && ctx.contactsById ? ctx.contactsById[m.referrerId] : null;
          row.referrer_name = c ? c.name : (m.referrerName || "");
        }
        if ("referredContactId" in m) row.referred_contact_id = n(m.referredContactId);
        if ("dealId" in m) row.deal_id = n(m.dealId);
        if ("date" in m) row.date = m.date || App.util.todayISO();
        if ("status" in m) row.status = m.status || "New";
        if ("thankYouSent" in m) row.thank_you_sent = !!m.thankYouSent;
        if ("thankYouExpense" in m) row.thank_you_expense = num(m.thankYouExpense);
        if ("notes" in m) row.notes = m.notes || "";
        return row;
      },
      fromRow(r) {
        return {
          id: r.id, referrerId: r.referrer_contact_id, referredContactId: r.referred_contact_id,
          date: r.date, status: r.status, dealId: r.deal_id, notes: r.notes,
          thankYouSent: !!r.thank_you_sent, thankYouExpense: Number(r.thank_you_expense) || 0,
          createdAt: r.created_at, updatedAt: r.updated_at
        };
      }
    },
    goals: {
      table: "goals", idPrefix: "gl",
      toRow(m) {
        const row = {};
        if ("type" in m) { row.type = m.type || "GCI"; row.title = m.type || "GCI"; }
        if ("year" in m) row.year = num(m.year);
        if ("target" in m) row.target_value = num(m.target);
        if ("notes" in m) row.notes = m.notes || "";
        return row;
      },
      fromRow(r) {
        return {
          id: r.id, type: r.type, year: r.year, target: Number(r.target_value) || 0,
          notes: r.notes, createdAt: r.created_at, updatedAt: r.updated_at
        };
      }
    },
    income: {
      table: "finance_records", idPrefix: "in", financeType: "income",
      toRow(m) {
        const row = { type: "income" };
        if ("description" in m) row.description = m.description || "";
        if ("amount" in m) row.amount = num(m.amount);
        if ("date" in m) row.date = m.date || App.util.todayISO();
        if ("category" in m) row.category = m.category || "Commission";
        if ("contactId" in m) row.contact_id = n(m.contactId);
        if ("dealId" in m) row.deal_id = n(m.dealId);
        if ("notes" in m) row.notes = m.notes || "";
        return row;
      },
      fromRow(r) {
        return {
          id: r.id, description: r.description, amount: Number(r.amount) || 0, date: r.date,
          category: r.category, contactId: r.contact_id, dealId: r.deal_id, notes: r.notes,
          createdAt: r.created_at, updatedAt: r.updated_at
        };
      }
    },
    expenses: {
      table: "finance_records", idPrefix: "ex", financeType: "expense",
      toRow(m) {
        const row = { type: "expense" };
        if ("description" in m) row.description = m.description || "";
        if ("amount" in m) row.amount = num(m.amount);
        if ("date" in m) row.date = m.date || App.util.todayISO();
        if ("category" in m) row.category = m.category || "Marketing";
        if ("contactId" in m) row.contact_id = n(m.contactId);
        if ("dealId" in m) row.deal_id = n(m.dealId);
        if ("notes" in m) row.notes = m.notes || "";
        return row;
      },
      fromRow(r) {
        return {
          id: r.id, description: r.description, amount: Number(r.amount) || 0, date: r.date,
          category: r.category, contactId: r.contact_id, dealId: r.deal_id, notes: r.notes,
          createdAt: r.created_at, updatedAt: r.updated_at
        };
      }
    },
    scripts: {
      table: "scripts", idPrefix: "sc",
      toRow(m) {
        const row = {};
        if ("category" in m) row.category = m.category || "Follow-up";
        if ("title" in m) row.title = m.title || "";
        if ("body" in m) row.content = m.body || "";
        return row;
      },
      fromRow(r) {
        return {
          id: r.id, category: r.category, title: r.title, body: r.content,
          createdAt: r.created_at, updatedAt: r.updated_at
        };
      }
    },
    aiPrompts: {
      table: "ai_prompts", idPrefix: "ai",
      toRow(m) {
        const row = {};
        if ("category" in m) row.category = m.category || "Follow-up";
        if ("title" in m) row.title = m.title || "";
        if ("body" in m) row.prompt_text = m.body || "";
        return row;
      },
      fromRow(r) {
        return {
          id: r.id, category: r.category, title: r.title, body: r.prompt_text,
          createdAt: r.created_at, updatedAt: r.updated_at
        };
      }
    },
    teamMembers: {
      table: "team_members", idPrefix: "tm",
      toRow(m) {
        const row = {};
        if ("name" in m) row.name = m.name || "";
        if ("role" in m) row.role = m.role || "Agent";
        if ("email" in m) row.email = m.email || "";
        if ("phone" in m) row.phone = m.phone || "";
        if ("active" in m) row.active = m.active !== false;
        return row;
      },
      fromRow(r) {
        return {
          id: r.id, name: r.name, role: r.role, email: r.email, phone: r.phone,
          active: r.active !== false, createdAt: r.created_at, updatedAt: r.updated_at
        };
      }
    },
    scheduledItems: {
      table: "scheduled_items", idPrefix: "sch",
      // `type` is explicit-only now (Phase 4B) so a partial update (e.g. the
      // scheduler's "Mark done" quick action, which only patches
      // `completed`) never resets an existing row's type back to "script".
      // Every create call site is expected to always pass `type` explicitly
      // ("script" or "email") going forward.
      toRow(m) {
        const row = {};
        if ("type" in m) row.type = m.type || "script";
        if ("scriptId" in m) row.script_id = n(m.scriptId);
        if ("scriptTitle" in m) row.script_title = m.scriptTitle || "";
        if ("title" in m) row.title = m.title || "";
        if ("dateTime" in m) row.date_time = m.dateTime || null;
        if ("assignedTo" in m) row.assigned_to = n(m.assignedTo);
        if ("assignedToName" in m) row.assigned_to_name = m.assignedToName || "";
        if ("notes" in m) row.notes = m.notes || "";
        if ("completed" in m) row.completed = !!m.completed;
        return row;
      },
      fromRow(r) {
        return {
          id: r.id, type: r.type || "script", scriptId: r.script_id, scriptTitle: r.script_title,
          title: r.title, dateTime: r.date_time,
          assignedTo: r.assigned_to, assignedToName: r.assigned_to_name, notes: r.notes,
          completed: !!r.completed,
          createdAt: r.created_at, updatedAt: r.updated_at
        };
      }
    },
    customFieldValues: {
      table: "custom_field_values", idPrefix: "cfv",
      toRow(m) {
        const row = {};
        if ("entity" in m) row.entity_type = m.entity;
        if ("recordId" in m) row.record_id = m.recordId;
        if ("fieldId" in m) row.field_key = m.fieldId;
        if ("value" in m) row.field_value = m.value === undefined ? null : m.value;
        return row;
      },
      fromRow(r) {
        return { id: r.id, entity: r.entity_type, recordId: r.record_id, fieldId: r.field_key, value: r.field_value };
      }
    }
  };

  // Parent -> [{ child entityKey, field on child's UI model }] for every
  // nullable FK, taken directly from the live schema's ON DELETE SET NULL
  // constraints (queried, not assumed) — used only to keep the in-session
  // cache visually consistent immediately after a delete; Realtime will
  // also correct these shortly after via the real SET NULL updates.
  const NULLIFY_ON_DELETE = {
    contacts: [
      ["properties","contactId"], ["deals","contactId"], ["tasks","contactId"],
      ["activities","contactId"], ["showings","contactId"], ["income","contactId"],
      ["expenses","contactId"], ["scheduledItems","contactId"],
      ["referrals","referrerId"], ["referrals","referredContactId"]
    ],
    properties: [["deals","propertyId"], ["tasks","propertyId"], ["activities","propertyId"], ["showings","propertyId"], ["scheduledItems","propertyId"]],
    deals: [["properties","dealId"], ["tasks","dealId"], ["activities","dealId"], ["showings","dealId"], ["referrals","dealId"], ["income","dealId"], ["expenses","dealId"], ["scheduledItems","dealId"]],
    teamMembers: [["deals","assignedToId"], ["tasks","assignedToId"], ["scheduledItems","assignedTo"]],
    tasks: [["activities","taskId"]],
    scripts: [["scheduledItems","scriptId"]]
  };
  // Parent -> [child entityKey] for every hard CASCADE (only deals->milestones).
  const CASCADE_ON_DELETE = { deals: ["milestones"] };
  const CASCADE_FIELD = { milestones: "dealId" };

  function patchCacheAfterDelete(entityKey, id) {
    (NULLIFY_ON_DELETE[entityKey] || []).forEach(([childKey, field]) => {
      if (!cache[childKey]) return;
      cache[childKey].forEach(rec => { if (rec[field] === id) rec[field] = null; });
    });
    (CASCADE_ON_DELETE[entityKey] || []).forEach(childKey => {
      if (!cache[childKey]) return;
      const field = CASCADE_FIELD[childKey];
      cache[childKey] = cache[childKey].filter(rec => rec[field] !== id);
    });
  }

  // ---------- CACHE ----------
  const cache = {};
  Object.keys(REGISTRY).forEach(k => { cache[k] = null; });
  let settingsCache = null;
  let metadataCache = null;

  // ---------- SYNC STATUS ----------
  // status: 'idle' | 'saving' | 'synced' | 'error' | 'offline'
  let syncState = { status: (typeof navigator !== "undefined" && navigator.onLine === false) ? "offline" : "idle", message: "", retry: null };
  const syncListeners = [];
  function setSyncState(next) {
    syncState = Object.assign({}, syncState, next);
    syncListeners.forEach(fn => { try { fn(syncState); } catch (e) {} });
  }
  function onSyncStateChange(fn) { syncListeners.push(fn); return () => { const i = syncListeners.indexOf(fn); if (i >= 0) syncListeners.splice(i, 1); }; }
  function getSyncState() { return syncState; }

  if (typeof window !== "undefined") {
    window.addEventListener("online", () => { if (syncState.status === "offline") setSyncState({ status: "idle", message: "" }); retryFailedOp(); });
    window.addEventListener("offline", () => setSyncState({ status: "offline", message: "Offline" }));
    setInterval(() => { if (syncState.status === "error" || syncState.status === "offline") retryFailedOp(); }, 30000);
  }
  function retryFailedOp() {
    const fn = syncState.retry;
    if (typeof fn === "function") fn();
  }

  // Monotonic op counter per record — a retry never overwrites a newer edit.
  let opCounter = 0;
  const lastOpByRecord = {};
  const selfWrites = new Set();
  function markSelf(entityKey, id) {
    const key = entityKey + ":" + id;
    // Self-writes are recognized by the realtime handler for ~4s so it can
    // skip the "Updated from another device" toast for our own operation.
    selfWrites.add(key);
    setTimeout(() => selfWrites.delete(key), 4000);
  }

  // ---------- GENERIC CRUD ----------
  async function list(entityKey, opts) {
    opts = opts || {};
    const def = REGISTRY[entityKey];
    if (!def) throw new Error("Unknown entity: " + entityKey);
    if (opts.cache !== false && cache[entityKey] && !opts.force) return cache[entityKey];
    const user = requireUser();
    let q = client().from(def.table).select("*");
    if (def.financeType) q = q.eq("type", def.financeType);
    const { data, error } = await q;
    if (error) throw error;
    const rows = (data || []).map(def.fromRow);
    // Transient reads must not repopulate a later workspace's cache when
    // an earlier authenticated request finishes after a workspace switch.
    if (opts.cache !== false) cache[entityKey] = rows;
    return rows;
  }

  async function get(entityKey, id) {
    const def = REGISTRY[entityKey];
    if (!def) throw new Error("Unknown entity: " + entityKey);
    if (!id) return null;
    const cached = cache[entityKey] && cache[entityKey].find(r => r.id === id);
    if (cached) return cached;
    const user = requireUser();
    let q = client().from(def.table).select("*").eq("id", id);
    if (def.financeType) q = q.eq("type", def.financeType);
    const { data, error } = await q.maybeSingle();
    if (error) throw error;
    return data ? def.fromRow(data) : null;
  }

  async function create(entityKey, model, ctx) {
    const def = REGISTRY[entityKey];
    if (!def) throw new Error("Unknown entity: " + entityKey);
    const user = requireUser();
    const id = model.id || U().uid(def.idPrefix);
    const row = Object.assign({ id, user_id: user.id }, def.toRow(Object.assign({}, model, { id }), ctx));
    setSyncState({ status: "saving", message: "Saving…" });
    try {
      const { data, error } = await client().from(def.table).insert(row).select().single();
      if (error) throw error;
      const rec = def.fromRow(data);
      if (!cache[entityKey]) cache[entityKey] = [];
      cache[entityKey].push(rec);
      markSelf(entityKey, rec.id);
      setSyncState({ status: "synced", message: "Synced", retry: null });
      return rec;
    } catch (err) {
      setSyncState({ status: "error", message: "Sync failed — Retry", retry: () => create(entityKey, model, ctx) });
      throw err;
    }
  }

  async function update(entityKey, id, patch, ctx) {
    const def = REGISTRY[entityKey];
    if (!def) throw new Error("Unknown entity: " + entityKey);
    const user = requireUser();
    const row = def.toRow(patch, ctx);
    const opId = ++opCounter;
    lastOpByRecord[entityKey + ":" + id] = opId;
    setSyncState({ status: "saving", message: "Saving…" });
    try {
      let q = client().from(def.table).update(row).eq("id", id);
      if (def.financeType) q = q.eq("type", def.financeType);
      const { data, error } = await q.select().single();
      if (error) throw error;
      const rec = def.fromRow(data);
      // A newer write to the same record started after this one — don't let
      // this (now-stale) response overwrite it in the cache.
      if (lastOpByRecord[entityKey + ":" + id] === opId && cache[entityKey]) {
        const idx = cache[entityKey].findIndex(r => r.id === id);
        if (idx >= 0) cache[entityKey][idx] = rec; else cache[entityKey].push(rec);
      }
      markSelf(entityKey, id);
      setSyncState({ status: "synced", message: "Synced", retry: null });
      return rec;
    } catch (err) {
      setSyncState({ status: "error", message: "Sync failed — Retry", retry: () => update(entityKey, id, patch, ctx) });
      throw err;
    }
  }

  async function remove(entityKey, id) {
    const def = REGISTRY[entityKey];
    if (!def) throw new Error("Unknown entity: " + entityKey);
    const user = requireUser();
    setSyncState({ status: "saving", message: "Saving…" });
    try {
      let q = client().from(def.table).delete().eq("id", id);
      if (def.financeType) q = q.eq("type", def.financeType);
      const { error } = await q;
      if (error) throw error;
      if (cache[entityKey]) cache[entityKey] = cache[entityKey].filter(r => r.id !== id);
      patchCacheAfterDelete(entityKey, id);
      markSelf(entityKey, id);
      setSyncState({ status: "synced", message: "Synced", retry: null });
      return true;
    } catch (err) {
      setSyncState({ status: "error", message: "Sync failed — Retry", retry: () => remove(entityKey, id) });
      throw err;
    }
  }

  function getCached(entityKey) { return cache[entityKey] || []; }

  // ---------- WORKSPACE SETTINGS (one shared row per WORKSPACE) ----------
  const SETTINGS_TOP_KEYS = ["pipelineStages", "commissionDefaults", "customFields", "customization", "businessProfile", "ui"];

  function settingsToRow(settings, metadata) {
    settings = settings || {};
    const bag = {};
    Object.keys(settings).forEach(k => { if (SETTINGS_TOP_KEYS.indexOf(k) === -1) bag[k] = settings[k]; });
    bag.dashboardWidgets = settings.customization && settings.customization.dashboardWidgets;
    bag.branding = settings.customization && settings.customization.branding;
    // Team mode has no column of its own; it rides in the bag like the two
    // above. The database watches settings_data -> 'teamMode' and refuses to
    // let it go false while other people are still members.
    bag.teamMode = !!(settings.customization && settings.customization.teamMode);
    return {
      pipeline_stages: settings.pipelineStages || [],
      commission_defaults: settings.commissionDefaults || {},
      custom_field_definitions: (settings.customFields && settings.customFields.definitions) || [],
      module_toggles: (settings.customization && settings.customization.enabledModules) || {},
      business_profile: settings.businessProfile || {},
      ui_preferences: settings.ui || {},
      settings_data: bag,
      metadata: metadata || {}
    };
  }

  function rowToSettings(row) {
    const defaults = App.store && App.store._defaultCustomization ? App.store._defaultCustomization() : { enabledModules: {}, dashboardWidgets: {}, branding: {} };
    const bag = row.settings_data || {};
    const settings = Object.assign({}, bag, {
      pipelineStages: row.pipeline_stages || [],
      commissionDefaults: row.commission_defaults || {},
      customFields: { definitions: row.custom_field_definitions || [] },
      businessProfile: row.business_profile || {},
      ui: row.ui_preferences || {},
      customization: Object.assign({}, defaults, {
        enabledModules: row.module_toggles || {},
        dashboardWidgets: bag.dashboardWidgets || defaults.dashboardWidgets,
        branding: bag.branding || {},
        teamMode: bag.teamMode === true
      })
    });
    delete settings.dashboardWidgets;
    delete settings.branding;
    delete settings.teamMode;
    return { settings, metadata: row.metadata || {} };
  }

  /* ---------- THE WORKSPACE FILTER ----------
   *
   * workspace_settings is ONE ROW PER WORKSPACE (T2d), and every write
   * to it has to say which one. PostgREST refuses an UPDATE or DELETE
   * with no filter outright - "UPDATE requires a WHERE clause", HTTP
   * 400 - so an unfiltered write is not a write that touches too much,
   * it is a write that never happens at all.
   *
   * That is exactly what shipped: commit 24e9417 ("T2d: the frontend
   * becomes workspace-aware") replaced the per-user filter on four
   * workspace_settings writes, and the per-workspace filter that was
   * meant to take its place was never added. Every settings save since
   * has failed, and the 30-second retry has been re-sending them for
   * ever.
   *
   * So: one helper, used by every write to the table, which refuses to
   * build a request it knows the server will reject.
   */
  async function requireWorkspaceId_() {
    let id = App.workspace && App.workspace.id ? App.workspace.id() : null;
    if (!id && App.workspace && typeof App.workspace.load === "function") {
      // The permissions call is cached and shared, so this is at most
      // one round trip per session, and usually none.
      try { await App.workspace.load(); } catch (e) { /* answered below */ }
      id = App.workspace.id ? App.workspace.id() : null;
    }
    if (!id) {
      // Never fall back to an unfiltered write. A save that waits for
      // the next attempt is recoverable; one the server rejects 70
      // times in a morning is not.
      const err = new Error("Your workspace is still loading. Try that again in a moment.");
      err.code = "workspace_not_loaded";
      err.transient = true;
      throw err;
    }
    return id;
  }

  /* ---------- WHEN TO STOP RETRYING ----------
   *
   * The sync queue re-runs syncState.retry every 30 seconds for as long
   * as one is set. That is right for a dropped connection and wrong for
   * a request the server will never accept: a 400 is not going to
   * become a 200 on the ninth attempt, and retrying it only buries the
   * one message that would have told somebody what was wrong.
   */
  const SETTINGS_MAX_ATTEMPTS = 3;

  function isPermanentWriteError_(err) {
    if (!err) return false;
    const status = Number(err.status || err.statusCode || 0);
    // 408 (timeout), 429 (rate limited) and 5xx are worth another go.
    // Everything else in the 4xx range is the request itself being
    // wrong, and it will be wrong again.
    if (status >= 400 && status < 500 && status !== 408 && status !== 429) return true;
    // PostgREST's own codes: PGRST1xx is a malformed request.
    if (/^PGRST/i.test(String(err.code || ""))) return true;
    // The one this guard exists for, in case a future client reports it
    // with no status at all.
    if (/requires a WHERE clause/i.test(String(err.message || ""))) return true;
    return false;
  }

  async function loadSettings(force) {
    if (settingsCache && !force) return { settings: settingsCache, metadata: metadataCache };
    const user = requireUser();
    const { data, error } = await client().from("workspace_settings").select("*").maybeSingle();
    if (error) throw error;
    if (!data) {
      const fresh = App.store && App.store._emptyState ? App.store._emptyState() : { settings: {}, metadata: {} };
      const row = Object.assign({ id: U().uid("ws"), user_id: user.id }, settingsToRow(fresh.settings, fresh.metadata));
      // Upsert, not insert: workspace_settings is one shared row per
      // workspace (T2d), and every member calls loadSettings(). Two
      // members opening a fresh workspace at the same moment both reach
      // here; the unique index on workspace_id makes the loser a conflict
      // to absorb rather than an error to show. workspace_id itself is
      // filled by T2a's compat trigger from user_id.
      const { data: created, error: insErr } = await client().from("workspace_settings")
        .upsert(row, { onConflict: "workspace_id" }).select().single();
      if (insErr) throw insErr;
      const mapped = rowToSettings(created);
      settingsCache = mapped.settings; metadataCache = mapped.metadata;
      return { settings: settingsCache, metadata: metadataCache };
    }
    const mapped = rowToSettings(data);
    settingsCache = mapped.settings; metadataCache = mapped.metadata;
    return { settings: settingsCache, metadata: metadataCache };
  }

  async function updateSettings(patch, opts) {
    const user = requireUser();
    if (!settingsCache) await loadSettings();
    const attempt = (opts && opts.attempt) || 1;
    const merged = Object.assign({}, settingsCache, patch);
    const row = settingsToRow(merged, metadataCache);
    setSyncState({ status: "saving", message: "Saving…" });
    try {
      // The filter FIRST: if the workspace is not known yet this throws
      // before any request is built, which is the whole point.
      const workspaceId = await requireWorkspaceId_();
      const { data, error } = await client().from("workspace_settings").update(row)
        .eq("workspace_id", workspaceId).select().single();
      if (error) throw error;
      const mapped = rowToSettings(data);
      settingsCache = mapped.settings; metadataCache = mapped.metadata;
      setSyncState({ status: "synced", message: "Synced", retry: null });
      return settingsCache;
    } catch (err) {
      const giveUp = isPermanentWriteError_(err) || attempt >= SETTINGS_MAX_ATTEMPTS;
      setSyncState(giveUp
        // One message, and no retry: the queue stops here rather than
        // re-sending a request the server has already refused.
        ? { status: "error", message: "Could not save your settings. Reload the page and try again.", retry: null }
        : { status: "error", message: "Sync failed — Retry",
            retry: () => updateSettings(patch, { attempt: attempt + 1 }) });
      throw err;
    }
  }

  async function updateMetadata(patch) {
    const user = requireUser();
    const workspaceId = await requireWorkspaceId_();
    metadataCache = Object.assign({}, metadataCache, patch);
    const { error } = await client().from("workspace_settings").update({ metadata: metadataCache })
      .eq("workspace_id", workspaceId);
    if (error) throw error;
    return metadataCache;
  }

  function getSettingsSync() { return settingsCache; }
  function getMetadataSync() { return metadataCache; }

  // ---------- GOOGLE SHEETS CONNECTIONS (Phase 3B) ----------
  // Reads only the columns the Settings UI needs — connector_token_hash is
  // never selected. Owner-scoped RLS on lead_source_connections is the
  // real enforcement; the explicit user_id filter matches this file's
  // existing convention for every other table.
  const SHEET_CONNECTION_COLUMNS = [
    "id", "name", "provider", "spreadsheet_id", "spreadsheet_url",
    "raw_tab_name", "ready_tab_name", "status", "sync_mode",
    "sync_interval_minutes", "connector_token_prefix", "token_rotated_at",
    "last_synced_at", "next_sync_at", "last_error", "created_at", "updated_at"
  ].join(",");

  async function listSheetConnections() {
    const user = requireUser();
    const { data, error } = await client()
      .from("lead_source_connections")
      .select(SHEET_CONNECTION_COLUMNS)

      .order("created_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }

  // Creation and rotation both go through the existing create-sheet-connection
  // Edge Function — this file never inserts a connector row directly, and
  // never sees the connector-token hash. The Edge Function's own response
  // is the only place the one-time plaintext token ever appears; nothing
  // here caches it. Errors are normalized to a small, consistent shape
  // (code/httpStatus/retryAfterSeconds) so the page module can map them to
  // a friendly message without depending on one exact supabase-js error
  // shape.
  async function createOrRotateSheetConnection(payload) {
    requireUser();
    const { data, error } = await client().functions.invoke("create-sheet-connection", { body: payload });
    if (error) {
      let code = null;
      let retryAfterSeconds = null;
      const httpStatus = (error && error.context && typeof error.context.status === "number")
        ? error.context.status
        : null;
      try {
        if (error && error.context && typeof error.context.json === "function") {
          const body = await error.context.json();
          if (body && typeof body.error === "string") code = body.error;
          if (body && typeof body.retry_after_seconds === "number") retryAfterSeconds = body.retry_after_seconds;
        }
      } catch (parseErr) {
        // Response body already consumed, not JSON, or context shape
        // differs from what this supabase-js version normally provides —
        // fall back to whatever message the SDK itself attached.
      }
      const normalized = new Error(code || (error && error.message) || "create_sheet_connection_failed");
      normalized.code = code;
      normalized.httpStatus = httpStatus;
      normalized.retryAfterSeconds = retryAfterSeconds;
      throw normalized;
    }
    return data;
  }

  // ---------- GOOGLE SHEETS IMPORT HISTORY (Phase 3C, read-only) ----------
  // Direct SELECT-only reads against lead_import_batches/lead_import_rows.
  // Owner-scoped RLS is the real enforcement; the explicit user_id filter
  // matches this file's existing convention for every other table. Never
  // selects connector_token_hash, row_fingerprint, error_context, metadata,
  // sheet_revision, or source_event_id — there is no insert/update/upsert/
  // delete against either table anywhere in this module.

  const IMPORT_BATCH_COLUMNS = [
    "id", "connection_id", "source_type", "file_name", "created_at", "updated_at", "status",
    "source_row_count", "accepted_count", "duplicate_count", "rejected_count", "imported_count",
    "started_at", "completed_at", "error_summary"
  ].join(",");
  const IMPORT_BATCH_STATUSES = ["received", "processing", "completed", "partial", "failed"];
  const IMPORT_SOURCE_TYPES = ["google_sheet", "file_upload"];
  const MAX_BATCH_PAGE_SIZE = 20;

  const IMPORT_ROW_COLUMNS = [
    "id", "batch_id", "connection_id", "source_type", "contact_id", "created_at", "updated_at",
    "source_row_key", "source_row_number", "status", "error_code", "error_message",
    "first_seen_at", "last_seen_at"
  ].join(",");
  const IMPORT_ROW_STATUSES = ["accepted", "imported", "duplicate", "rejected", "failed"];
  const MAX_ROW_PAGE_SIZE = 50;

  const IMPORT_BATCH_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function clampInt_(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n) || Math.floor(n) !== n) return fallback;
    if (n < min) return min;
    if (n > max) return max;
    return n;
  }

  // A present-but-invalid connection_id/status filter is rejected (thrown)
  // rather than silently dropped — silently dropping a bad filter would
  // broaden the query to rows the caller did not ask for. Absent values
  // (undefined/null/"") continue to mean "no filter on this field".
  function isBlankFilter_(value) {
    return value === undefined || value === null || value === "";
  }

  // opts: { connectionId?, sourceType?, status?, limit?, offset? }
  async function listImportBatches(opts) {
    opts = opts || {};
    const user = requireUser();
    const limit = clampInt_(opts.limit, 1, MAX_BATCH_PAGE_SIZE, MAX_BATCH_PAGE_SIZE);
    // Clamp offset's ceiling so offset + limit - 1 can never leave the safe
    // integer range, however large a caller-supplied offset might be.
    const offset = clampInt_(opts.offset, 0, Number.MAX_SAFE_INTEGER - limit, 0);

    let q = client()
      .from("lead_import_batches")
      .select(IMPORT_BATCH_COLUMNS, { count: "exact" });

    if (!isBlankFilter_(opts.connectionId)) {
      if (typeof opts.connectionId !== "string" || !IMPORT_BATCH_ID_PATTERN.test(opts.connectionId)) {
        throw new Error("A valid connection id is required to filter by connection.");
      }
      q = q.eq("connection_id", opts.connectionId);
    }
    if (!isBlankFilter_(opts.sourceType)) {
      if (typeof opts.sourceType !== "string" || IMPORT_SOURCE_TYPES.indexOf(opts.sourceType) === -1) {
        throw new Error("Invalid import source filter.");
      }
      q = q.eq("source_type", opts.sourceType);
    }
    if (!isBlankFilter_(opts.status)) {
      if (typeof opts.status !== "string" || IMPORT_BATCH_STATUSES.indexOf(opts.status) === -1) {
        throw new Error("Invalid batch status filter.");
      }
      q = q.eq("status", opts.status);
    }

    q = q.order("created_at", { ascending: false }).range(offset, offset + limit - 1);

    const { data, error, count } = await q;
    if (error) throw error;
    return { rows: data || [], total: count || 0, limit: limit, offset: offset };
  }

  // opts: { status?, limit?, offset? }
  async function listImportRows(batchId, opts) {
    if (typeof batchId !== "string" || !IMPORT_BATCH_ID_PATTERN.test(batchId)) {
      throw new Error("A valid batch id is required.");
    }
    opts = opts || {};
    const user = requireUser();
    const limit = clampInt_(opts.limit, 1, MAX_ROW_PAGE_SIZE, MAX_ROW_PAGE_SIZE);
    const offset = clampInt_(opts.offset, 0, Number.MAX_SAFE_INTEGER - limit, 0);

    let q = client()
      .from("lead_import_rows")
      .select(IMPORT_ROW_COLUMNS, { count: "exact" })

      .eq("batch_id", batchId);

    if (!isBlankFilter_(opts.status)) {
      if (typeof opts.status !== "string" || IMPORT_ROW_STATUSES.indexOf(opts.status) === -1) {
        throw new Error("Invalid row status filter.");
      }
      q = q.eq("status", opts.status);
    }

    q = q
      .order("source_row_number", { ascending: true, nullsFirst: false })
      .order("id", { ascending: true })
      .range(offset, offset + limit - 1);

    const { data, error, count } = await q;
    if (error) throw error;
    return { rows: data || [], total: count || 0, limit: limit, offset: offset };
  }

  // ---------- NOTIFICATIONS (Phase 4H) ----------
  // Read-only except read_at: the database lets the browser read its own
  // notifications and set read_at on them, nothing else (column-level
  // grant + owner RLS). Rows are created only by database triggers.
  const NOTIFICATION_COLUMNS = "id,type,title,body,contact_id,link_route,metadata,created_at,read_at";
  const MAX_NOTIFICATION_PAGE_SIZE = 50;
  // Filter name -> the types it shows (null = every type). "unread" is a
  // read-state filter, not a type filter.
  const NOTIFICATION_FILTERS = {
    all: null,
    unread: null,
    replies: ["lead_replied", "hot_reply"],
    hot: ["hot_reply"],
    imports: ["import_finished"],
    problems: ["unsubscribed", "spam_report", "email_bounced", "followup_failed"]
  };

  // opts: { filter?: all|unread|replies|hot|imports|problems, limit?, offset? }
  async function listNotifications(opts) {
    opts = opts || {};
    const user = requireUser();
    const filter = isBlankFilter_(opts.filter) ? "all" : opts.filter;
    if (!Object.prototype.hasOwnProperty.call(NOTIFICATION_FILTERS, filter)) {
      throw new Error("Invalid notification filter.");
    }
    const limit = clampInt_(opts.limit, 1, MAX_NOTIFICATION_PAGE_SIZE, 20);
    const offset = clampInt_(opts.offset, 0, Number.MAX_SAFE_INTEGER - limit, 0);
    // Phase T2d (24e9417) dropped the owner filter from all four of
    // these when it made the frontend workspace-aware. Notifications
    // are the one thing here that stayed PERSONAL - the table has no
    // workspace-wide read - so the filter is restored rather than
    // replaced. RLS is the enforcement; this is the request saying what
    // it means.
    let q = client()
      .from("notifications")
      .select(NOTIFICATION_COLUMNS, { count: "exact" })
      .eq("user_id", user.id);
    if (filter === "unread") q = q.is("read_at", null);
    else if (NOTIFICATION_FILTERS[filter]) q = q.in("type", NOTIFICATION_FILTERS[filter]);
    q = q.order("created_at", { ascending: false }).order("id", { ascending: false }).range(offset, offset + limit - 1);
    const { data, error, count } = await q;
    if (error) throw error;
    return { rows: data || [], total: count || 0, limit: limit, offset: offset };
  }

  async function countUnreadNotifications() {
    const user = requireUser();
    const { error, count } = await client()
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .is("read_at", null);
    if (error) throw error;
    return count || 0;
  }

  async function markNotificationRead(id) {
    if (typeof id !== "string" || !UUID_PATTERN_.test(id)) throw new Error("A valid notification id is required.");
    const user = requireUser();
    const { error } = await client()
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("user_id", user.id)
      .eq("id", id)
      .is("read_at", null);
    if (error) throw error;
    return true;
  }

  async function markAllNotificationsRead() {
    const user = requireUser();
    const { error } = await client()
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      // "All" means all of MINE. Without this the request says "every
      // unread notification there is" and leaves it to the row policy
      // to disagree - which it does, but a write should not need
      // rescuing to be correct.
      .eq("user_id", user.id)
      .is("read_at", null);
    if (error) throw error;
    return true;
  }

  // ---------- PUSH DEVICES AND PREFERENCES (Phase 3B) ----------
  //
  // Reads are plain selects, because row level security already limits
  // them to the caller's own rows. Every WRITE is an RPC, because the
  // owner and the workspace on a device row are not the browser's to
  // choose - the function takes them from the session. There is no
  // INSERT or UPDATE grant on either table for this reason.
  async function listPushDevices() {
    requireUser();
    const { data, error } = await client()
      .from("push_subscriptions")
      .select("id, endpoint, device_label, created_at, last_success_at, failure_count")
      .order("created_at", { ascending: true });
    if (error) throw error;
    return data || [];
  }

  async function registerPushDevice(subscription, label) {
    requireUser();
    const sub = subscription || {};
    if (typeof sub.endpoint !== "string" || !sub.endpoint.startsWith("https://")) {
      throw new Error("That browser did not give a usable push address.");
    }
    const { data, error } = await client().rpc("realtoros_register_push_subscription", {
      p_endpoint: sub.endpoint,
      p_p256dh: sub.p256dh,
      p_auth: sub.auth,
      p_label: typeof label === "string" ? label.slice(0, 60) : "",
    });
    if (error) throw error;
    return data;
  }

  async function removePushDevice(endpoint) {
    requireUser();
    const { data, error } = await client().rpc("realtoros_remove_push_subscription", {
      p_endpoint: endpoint,
    });
    if (error) throw error;
    return data;
  }

  async function getNotificationPreferences() {
    requireUser();
    const { data, error } = await client().rpc("realtoros_notification_preferences");
    if (error) throw error;
    return data;
  }

  async function saveNotificationPreferences(prefs) {
    requireUser();
    const p = prefs || {};
    const { data, error } = await client().rpc("realtoros_set_notification_preferences", {
      p_push_enabled: p.pushEnabled !== false,
      p_push_types: Array.isArray(p.pushTypes) ? p.pushTypes : null,
      // Both or neither, the same rule the database enforces - sending
      // one half would be a validation error rather than a saved
      // setting.
      p_quiet_start: (p.quietStart && p.quietEnd) ? p.quietStart : null,
      p_quiet_end: (p.quietStart && p.quietEnd) ? p.quietEnd : null,
    });
    if (error) throw error;
    return data;
  }

  // ---------- EMAIL TEMPLATES (Phase 4B, message_templates) ----------
  // Configuration-only. No email is ever sent from this module, no
  // automation-runtime table is ever touched here, and channel is pinned
  // to 'email' — SMS is never read, written, or exposed even though the
  // table itself supports it. Explicit narrow column lists throughout;
  // never selects connector_token_hash or any other unrelated field.
  const UUID_PATTERN_ = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const TEMPLATE_COLUMNS = "id,name,channel,subject,body_text,is_active,metadata,created_at,updated_at";
  const TEMPLATE_NAME_MAX = 100;
  const TEMPLATE_SUBJECT_MAX = 200;
  const TEMPLATE_BODY_MAX = 50000;

  function isPlainObject_(v) { return !!v && typeof v === "object" && !Array.isArray(v); }
  function validateJsonObjectField_(value, label) {
    if (value === undefined || value === null) return {};
    if (!isPlainObject_(value)) throw new Error((label || "This field") + " must be a plain object.");
    return value;
  }
  // Absent (undefined) -> defaultValue. Present -> must be an actual
  // boolean; a string, number, null, or object is rejected rather than
  // silently coerced (e.g. "false", 0, or {} must never be read as false).
  function validateOptionalBoolean_(value, defaultValue, message) {
    if (value === undefined) return defaultValue;
    if (typeof value !== "boolean") throw new Error(message);
    return value;
  }
  function validateTemplateName_(name) {
    if (typeof name !== "string") throw new Error("Template name is required.");
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > TEMPLATE_NAME_MAX) throw new Error("Template name must be 1-100 characters.");
    return trimmed;
  }
  function validateTemplateSubject_(subject) {
    if (typeof subject !== "string") throw new Error("Subject is required.");
    const trimmed = subject.trim();
    if (!trimmed || trimmed.length > TEMPLATE_SUBJECT_MAX) throw new Error("Subject must be 1-200 characters.");
    return trimmed;
  }
  function validateTemplateBody_(body) {
    if (typeof body !== "string") throw new Error("Email body is required.");
    const trimmed = body.trim();
    if (!trimmed || trimmed.length > TEMPLATE_BODY_MAX) throw new Error("Email body must be non-empty and at most 50,000 characters.");
    return trimmed;
  }
  function friendlyTemplateConstraintError_(error) {
    if (error && error.code === "23505") return new Error("A template with this name already exists.");
    if (error && error.code === "23503") return new Error("This template is used by an automation step and can't be deleted until that step is removed or changed.");
    return error;
  }
  // An active template must have a real name/subject/body — never
  // evaluated or executed, only length/emptiness/channel checked. Called
  // against the EFFECTIVE final row (current stored values merged with
  // whatever the same call is also changing) before is_active may become
  // true, so a subjectless or empty-body template can never be activated
  // via updateMessageTemplate OR the dedicated activateMessageTemplate.
  function assertTemplateActivatable_(row) {
    const name = typeof row.name === "string" ? row.name.trim() : "";
    const subject = typeof row.subject === "string" ? row.subject.trim() : "";
    const body = typeof row.body_text === "string" ? row.body_text.trim() : "";
    if (!name || name.length > TEMPLATE_NAME_MAX) throw new Error("This template needs a name (1-100 characters) before it can be activated.");
    if (!subject || subject.length > TEMPLATE_SUBJECT_MAX) throw new Error("This template needs a subject (1-200 characters) before it can be activated.");
    if (!body || body.length > TEMPLATE_BODY_MAX) throw new Error("This template needs a body (1-50,000 characters) before it can be activated.");
    if (row.channel !== "email") throw new Error("Only email templates can be activated in this phase.");
  }

  // opts: { activeOnly?, orderBy? } — orderBy "name" or (default) "created_at" desc
  async function listMessageTemplates(opts) {
    opts = opts || {};
    const user = requireUser();
    let q = client().from("message_templates").select(TEMPLATE_COLUMNS)
      .eq("channel", "email");
    if (opts.activeOnly) q = q.eq("is_active", true);
    if (opts.orderBy === "name") q = q.order("name", { ascending: true });
    else q = q.order("created_at", { ascending: false });
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }

  async function createMessageTemplate(model) {
    model = model || {};
    const user = requireUser();
    const row = {
      user_id: user.id,
      name: validateTemplateName_(model.name),
      channel: "email",
      subject: validateTemplateSubject_(model.subject),
      body_text: validateTemplateBody_(model.bodyText),
      is_active: validateOptionalBoolean_(model.isActive, true, "is_active must be true or false."),
      metadata: validateJsonObjectField_(model.metadata, "Template metadata")
    };
    const { data, error } = await client().from("message_templates").insert(row).select(TEMPLATE_COLUMNS).single();
    if (error) throw friendlyTemplateConstraintError_(error);
    return data;
  }

  // Activating (is_active -> true) — whether via this generic update or
  // the dedicated activateMessageTemplate below — first re-reads the
  // owner-scoped stored row and validates the EFFECTIVE final name/
  // subject/body/channel (this same patch's own changes merged with
  // whatever is already stored for any field it leaves untouched), so a
  // subjectless or empty-body template can never become active this way.
  // Deactivating is always allowed with no such check.
  async function updateMessageTemplate(id, patch) {
    if (typeof id !== "string" || !UUID_PATTERN_.test(id)) throw new Error("A valid template id is required.");
    const user = requireUser();
    patch = patch || {};
    const row = {};
    if ("name" in patch) row.name = validateTemplateName_(patch.name);
    if ("subject" in patch) row.subject = validateTemplateSubject_(patch.subject);
    if ("bodyText" in patch) row.body_text = validateTemplateBody_(patch.bodyText);
    if ("isActive" in patch) {
      if (typeof patch.isActive !== "boolean") throw new Error("is_active must be true or false.");
      row.is_active = patch.isActive;
    }
    if ("metadata" in patch) row.metadata = validateJsonObjectField_(patch.metadata, "Template metadata");
    if (Object.keys(row).length === 0) throw new Error("Nothing to update.");

    if (row.is_active === true) {
      const { data: current, error: fetchErr } = await client().from("message_templates")
        .select("name,subject,body_text,channel").eq("id", id).maybeSingle();
      if (fetchErr) throw fetchErr;
      if (!current) throw new Error("Template not found.");
      assertTemplateActivatable_({
        name: "name" in row ? row.name : current.name,
        subject: "subject" in row ? row.subject : current.subject,
        body_text: "body_text" in row ? row.body_text : current.body_text,
        channel: current.channel
      });
    }

    const { data, error } = await client().from("message_templates").update(row)
      .eq("id", id).select(TEMPLATE_COLUMNS).single();
    if (error) throw friendlyTemplateConstraintError_(error);
    return data;
  }

  // Narrowly-scoped activation entry point: re-validates the owner-scoped
  // stored template (never trusts a caller-supplied name/subject/body)
  // before flipping is_active to true.
  async function activateMessageTemplate(id) {
    if (typeof id !== "string" || !UUID_PATTERN_.test(id)) throw new Error("A valid template id is required.");
    const user = requireUser();
    const { data: current, error: fetchErr } = await client().from("message_templates")
      .select("name,subject,body_text,channel").eq("id", id).maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!current) throw new Error("Template not found.");
    assertTemplateActivatable_(current);
    const { data, error } = await client().from("message_templates").update({ is_active: true })
      .eq("id", id).select(TEMPLATE_COLUMNS).single();
    if (error) throw friendlyTemplateConstraintError_(error);
    return data;
  }

  async function deleteMessageTemplate(id) {
    if (typeof id !== "string" || !UUID_PATTERN_.test(id)) throw new Error("A valid template id is required.");
    const user = requireUser();
    const { error } = await client().from("message_templates").delete().eq("id", id);
    if (error) throw friendlyTemplateConstraintError_(error);
    return true;
  }

  // ---------- LEGACY SCRIPT -> EMAIL TEMPLATE IMPORT (Phase 4B) ----------
  // User-triggered only — never runs on page load. Copies (never moves or
  // deletes) rows from the legacy `scripts` table into `message_templates`.
  // Idempotent: metadata.legacy_script_id is the sole source of truth for
  // "already imported", checked fresh against the current message_templates
  // table on every call (including inside the actual import), so re-running
  // this — even concurrently — can never create a duplicate template for
  // the same legacy Script.
  const LEGACY_SCRIPT_COLUMNS = "id,title,category,content,tags";

  async function listEligibleLegacyScriptImports() {
    const user = requireUser();
    const [scriptsRes, templatesRes] = await Promise.all([
      client().from("scripts").select(LEGACY_SCRIPT_COLUMNS),
      client().from("message_templates").select("metadata").eq("channel", "email")
    ]);
    if (scriptsRes.error) throw scriptsRes.error;
    if (templatesRes.error) throw templatesRes.error;
    const importedIds = new Set(
      (templatesRes.data || [])
        .map(r => (r.metadata && typeof r.metadata.legacy_script_id === "string") ? r.metadata.legacy_script_id : null)
        .filter(Boolean)
    );
    const allScripts = scriptsRes.data || [];
    const eligible = allScripts.filter(s => !importedIds.has(s.id));
    return {
      totalScripts: allScripts.length,
      alreadyImportedCount: allScripts.length - eligible.length,
      eligible: eligible.map(s => ({ id: s.id, title: s.title, category: s.category }))
    };
  }

  // scriptIds: explicit array the caller confirmed importing — this
  // function never discovers or imports anything beyond that list.
  async function importLegacyScriptsAsTemplates(scriptIds) {
    if (!Array.isArray(scriptIds) || scriptIds.length === 0) {
      return { imported: 0, skipped: 0, failed: 0, details: [] };
    }
    const user = requireUser();
    const [scriptsRes, templatesRes] = await Promise.all([
      client().from("scripts").select(LEGACY_SCRIPT_COLUMNS).in("id", scriptIds),
      client().from("message_templates").select("name,metadata").eq("channel", "email")
    ]);
    if (scriptsRes.error) throw scriptsRes.error;
    if (templatesRes.error) throw templatesRes.error;

    const existingNames = new Set((templatesRes.data || []).map(r => r.name));
    const importedScriptIds = new Set(
      (templatesRes.data || [])
        .map(r => (r.metadata && typeof r.metadata.legacy_script_id === "string") ? r.metadata.legacy_script_id : null)
        .filter(Boolean)
    );
    const byId = {};
    (scriptsRes.data || []).forEach(s => { byId[s.id] = s; });

    const results = { imported: 0, skipped: 0, failed: 0, details: [] };
    for (const scriptId of scriptIds) {
      const script = byId[scriptId];
      if (!script) {
        results.failed++;
        results.details.push({ scriptId, outcome: "failed", reason: "Script not found." });
        continue;
      }
      if (importedScriptIds.has(script.id)) {
        results.skipped++;
        results.details.push({ scriptId, title: script.title, outcome: "skipped", reason: "Already imported." });
        continue;
      }
      let name = (script.title || "").toString().trim().slice(0, TEMPLATE_NAME_MAX) || "Untitled Script";
      if (existingNames.has(name)) {
        let n = 2;
        let candidate = (name + " (" + n + ")").slice(0, TEMPLATE_NAME_MAX);
        while (existingNames.has(candidate) && n < 1000) { n++; candidate = (name + " (" + n + ")").slice(0, TEMPLATE_NAME_MAX); }
        if (existingNames.has(candidate)) {
          results.skipped++;
          results.details.push({ scriptId, title: script.title, outcome: "skipped", reason: "A template with this name already exists." });
          continue;
        }
        name = candidate;
      }
      // Legacy Scripts never had an email subject, so an imported template
      // is always created inactive with an empty subject and a clear
      // "needs review" marker — it cannot appear as an active Automation
      // step or Scheduler choice (both only offer active templates) until
      // a person adds a subject, reviews the body, and activates it
      // (which itself re-validates name/subject/body — see
      // assertTemplateActivatable_).
      const row = {
        user_id: user.id,
        name,
        channel: "email",
        subject: "",
        body_text: (script.content || "").toString().slice(0, TEMPLATE_BODY_MAX),
        is_active: false,
        metadata: {
          legacy_script_id: script.id,
          legacy_category: script.category || null,
          legacy_tags: Array.isArray(script.tags) ? script.tags : [],
          legacy_needs_review: true
        }
      };
      try {
        const { data, error } = await client().from("message_templates").insert(row).select("id,name").single();
        if (error) throw error;
        existingNames.add(data.name);
        importedScriptIds.add(script.id);
        results.imported++;
        results.details.push({ scriptId, title: script.title, outcome: "imported", newName: data.name });
      } catch (err) {
        results.failed++;
        results.details.push({ scriptId, title: script.title, outcome: "failed", reason: (err && err.message) ? err.message : "Unknown error" });
      }
    }
    return results;
  }

  // ---------- DRAFT AUTOMATION SEQUENCES (Phase 4B, configuration only) ----------
  // This section only ever performs CRUD against automation_rules and
  // automation_steps. It never inserts into automation_enrollments,
  // automation_jobs, automation_runs, outbound_messages, or
  // webhook_events, and never calls an email provider — there is no code
  // path here capable of doing so. New rules are always forced to
  // status:'draft' on create, and updateAutomationRule never accepts (or
  // even looks at) a "status" patch key, so this module has no way to
  // activate a rule.
  const RULE_COLUMNS = "id,name,trigger_type,status,timezone,audience_filter,trigger_config,stop_on_reply,stop_on_unsubscribe,daily_enrollment_limit,metadata,created_at,updated_at";
  const RULE_TRIGGER_TYPES = [
    "new_lead", "contact_created", "contact_status_changed", "manual",
    // Phase 2A
    "follow_up_due", "no_contact", "status_stale", "deal_stage_changed",
    // Phase 2D
    "birthday", "home_anniversary"
  ];
  // Phase 2A. The trigger types that carry settings, and which settings
  // each one accepts. This mirrors
  // automation_internal.validate_trigger_config exactly; the DATABASE is
  // the authority (a trigger validates every draft write, and activation
  // re-validates through realtoros_validate_trigger_config), so this copy
  // exists to give a useful message before the round trip, never to be the
  // only check.
  const RULE_TRIGGER_CONFIG_KEYS_ = {
    follow_up_due: ["fire_hour", "include_existing"],
    no_contact: ["days", "fire_hour", "include_existing"],
    status_stale: ["days", "statuses", "fire_hour", "include_existing"],
    deal_stage_changed: ["to_stage", "side", "include_existing"],
    // Phase 2D. include_existing is accepted and then dropped: a yearly
    // occurrence that passed before the rule was switched on stays passed,
    // because a late birthday greeting is worse than none.
    birthday: ["days_before", "fire_hour", "include_existing"],
    home_anniversary: ["days_before", "fire_hour", "include_existing"]
  };
  const RULE_DEAL_SIDES_ = ["Buyer", "Seller"];
  const RULE_NAME_MAX = 100;
  // The only contact statuses this app supports (matches store.js's own
  // contactStages exactly) — also enforced server-side at activation
  // preflight and again, defensively, in the worker's own runtime
  // matching, so an invalid value can never reach any of the three
  // layers undetected.
  const RULE_STATUS_EQUALS_VALUES_ = ["New Lead", "Qualified", "Nurturing", "Client", "Past Client", "Lost"];

  function validateRuleName_(name) {
    if (typeof name !== "string") throw new Error("Rule name is required.");
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > RULE_NAME_MAX) throw new Error("Rule name must be 1-100 characters.");
    return trimmed;
  }
  function validateTriggerType_(t) {
    if (RULE_TRIGGER_TYPES.indexOf(t) === -1) throw new Error("Invalid trigger type.");
    return t;
  }
  // Controlled, non-executable shape check — this never evaluates or
  // interprets the timezone string, it only bounds its charset/length so
  // an arbitrary/oversized value can't be written.
  function validateTimezone_(tz) {
    if (typeof tz !== "string") throw new Error("Timezone is required.");
    const trimmed = tz.trim();
    if (!trimmed || trimmed.length > 64 || !/^[A-Za-z0-9_+\-\/]+$/.test(trimmed)) {
      throw new Error("Timezone must be a valid IANA-style value (e.g. America/New_York or UTC).");
    }
    return trimmed;
  }
  function validateDailyLimit_(n) {
    const num = Number(n);
    if (!Number.isInteger(num) || num < 1 || num > 10000) throw new Error("Daily enrollment limit must be an integer between 1 and 10,000.");
    return num;
  }
  function friendlyRuleConstraintError_(error) {
    if (error && error.code === "23505") return new Error("A rule with this name already exists.");
    return error;
  }
  // Validates the audience_filter shape for a given trigger type — the
  // SAME narrow rule enforced server-side by manage-automation's
  // activation preflight: an empty object for every trigger type except
  // contact_status_changed, which requires exactly one key
  // (status_equals) whose value is one of this app's actual contact
  // statuses. Never accepts an arbitrary free-text status or any other
  // operator/key.
  // Phase 2E. Mirrors automation_internal.validate_audience_filter, which
  // is the authority: a trigger normalizes every write and activation
  // re-checks. This copy exists to give a useful message before the round
  // trip, and to normalize the same way so the two never disagree about
  // what was stored.
  //
  // status_equals is still REQUIRED for a status-change rule - that is the
  // one trigger type that cannot work without it - and tags_any is now
  // allowed for every type.
  // Phase 2F. The three audience lists ask the same question and are
  // normalized the same way, so they are normalized in one place - exactly
  // as automation_internal.normalize_audience_list does it in the
  // database, which is the authority. This copy exists to give a useful
  // message before the round trip, never to be the only check.
  const AUDIENCE_LISTS_ = {
    tags_any: { noun: "Tags", one: "A tag" },
    type_in: { noun: "Contact types", one: "A contact type" },
    temperature_in: { noun: "Temperatures", one: "A temperature" }
  };

  function normalizeAudienceList_(values, words) {
    if (!Array.isArray(values)) throw new Error(words.noun + " must be a list.");
    if (values.length > 20) throw new Error("Pick at most 20 of " + words.noun.toLowerCase() + ".");
    const seen = {};
    const out = [];
    values.forEach((raw) => {
      const value = String(raw == null ? "" : raw).trim();
      if (!value) return;
      if (value.length > 50) throw new Error(words.one + " may be at most 50 characters.");
      const key = value.toLowerCase();
      // First spelling wins, case-insensitively - same rule as the
      // database, so the stored value is identical either way.
      if (Object.prototype.hasOwnProperty.call(seen, key)) return;
      seen[key] = true;
      out.push(value);
    });
    return out.slice().sort();
  }

  function validateAudienceFilterShape_(triggerType, filter) {
    filter = validateJsonObjectField_(filter, "Audience filter");
    Object.keys(filter).forEach((k) => {
      if (k !== "status_equals" && !Object.prototype.hasOwnProperty.call(AUDIENCE_LISTS_, k)) {
        throw new Error("Unknown audience setting: " + k + ".");
      }
    });
    const out = {};

    if ("status_equals" in filter) {
      if (RULE_STATUS_EQUALS_VALUES_.indexOf(filter.status_equals) === -1) {
        throw new Error("The status to match must be one of: " + RULE_STATUS_EQUALS_VALUES_.join(", ") + ".");
      }
      out.status_equals = filter.status_equals;
    } else if (triggerType === "contact_status_changed") {
      throw new Error("Select the status this sequence should match.");
    }

    // Always in this order, so the object a draft is saved with matches the
    // one the database stores whatever order the keys arrived in.
    ["tags_any", "type_in", "temperature_in"].forEach((key) => {
      if (!(key in filter)) return;
      const values = normalizeAudienceList_(filter[key], AUDIENCE_LISTS_[key]);
      // An empty result is no filter at all rather than an empty list, so
      // "none ticked" has one representation and never means "match
      // nobody".
      if (values.length) out[key] = values;
    });
    return out;
  }
  // Phase 2A. The trigger's own settings, kept separate from the audience
  // filter. Same rules as the database validator, including rejecting an
  // unknown key rather than ignoring it: a misspelled "day" that silently
  // became the default would be a sequence running on the wrong schedule
  // with nothing on screen to explain why.
  function validateTriggerConfigShape_(triggerType, config) {
    config = validateJsonObjectField_(config, "Trigger settings");
    const allowed = RULE_TRIGGER_CONFIG_KEYS_[triggerType];
    if (!allowed) {
      // The pre-2A types carry no settings.
      if (Object.keys(config).length !== 0) {
        throw new Error("This trigger type does not take any settings.");
      }
      return {};
    }
    Object.keys(config).forEach((k) => {
      if (allowed.indexOf(k) === -1) throw new Error("Unknown trigger setting: " + k + ".");
    });
    if ("include_existing" in config && typeof config.include_existing !== "boolean") {
      throw new Error("\"Also include contacts who already match\" must be true or false.");
    }
    const out = { include_existing: "include_existing" in config ? config.include_existing : false };

    if (triggerType === "deal_stage_changed") {
      if ("to_stage" in config) {
        if (typeof config.to_stage !== "string" || !config.to_stage.trim() || config.to_stage.trim().length > 100) {
          throw new Error("Pick a deal stage, or leave it blank for any stage.");
        }
        out.to_stage = config.to_stage.trim();
      }
      if ("side" in config) {
        if (RULE_DEAL_SIDES_.indexOf(config.side) === -1) {
          throw new Error("Deal side must be " + RULE_DEAL_SIDES_.join(" or ") + ".");
        }
        out.side = config.side;
      }
      return out;
    }

    const yearly = triggerType === "birthday" || triggerType === "home_anniversary";
    const hour = "fire_hour" in config ? config.fire_hour : (yearly ? 9 : 8);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      throw new Error("The send hour must be a whole number between 0 and 23.");
    }
    out.fire_hour = hour;

    if (yearly) {
      const before = "days_before" in config ? config.days_before : 0;
      if (!Number.isInteger(before) || before < 0 || before > 30) {
        throw new Error("Days before must be a whole number between 0 and 30.");
      }
      // Mirrors the database validator, which stores neither
      // include_existing nor anything else for these two.
      return { days_before: before, fire_hour: hour };
    }

    if (triggerType === "no_contact" || triggerType === "status_stale") {
      if (!("days" in config)) throw new Error("Enter the number of days.");
      if (!Number.isInteger(config.days) || config.days < 1 || config.days > 365) {
        throw new Error("Days must be a whole number between 1 and 365.");
      }
      out.days = config.days;
    }
    if (triggerType === "status_stale" && "statuses" in config) {
      if (!Array.isArray(config.statuses) || config.statuses.length === 0) {
        throw new Error("Pick at least one status, or leave it blank for any status.");
      }
      config.statuses.forEach((s) => {
        if (RULE_STATUS_EQUALS_VALUES_.indexOf(s) === -1) throw new Error("Unknown contact status: " + s + ".");
      });
      // Sorted and de-duplicated, so two configs meaning the same thing
      // are stored as the same value — matching the database validator.
      out.statuses = config.statuses.filter((s, i, a) => a.indexOf(s) === i).slice().sort();
    }
    return out;
  }
  // Phase 2D. The IANA zone names the settings screen offers. Read-only,
  // and the same list the server will accept, so the two cannot disagree.
  async function listTimezones() {
    requireUser();
    const { data, error } = await client().rpc("realtoros_timezone_names");
    if (error) throw error;
    // The RPC returns a set of text; PostgREST hands that back as an array
    // of scalars or of single-key objects depending on version.
    return (data || []).map((row) => (typeof row === "string" ? row : (row && row.realtoros_timezone_names)))
      .filter((name) => typeof name === "string" && name);
  }

  // Owner-scoped: only ever looks at a rule belonging to the current
  // user. Used to reject any rule/step mutation whose owning rule is not
  // (or is no longer) a draft — a non-draft rule may be shown, but never
  // changed, by this module. Also returns trigger_type/audience_filter so
  // callers can re-validate the EFFECTIVE (patched-or-current) audience
  // filter shape even when only one of the two is being patched.
  async function requireDraftRule_(user, ruleId) {
    const { data, error } = await client().from("automation_rules").select("id,status,trigger_type,audience_filter,trigger_config")
      .eq("id", ruleId).maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("Sequence not found.");
    if (data.status !== "draft") throw new Error("This sequence is not a draft, so it can't be changed here.");
    return data;
  }
  // Resolves a step id to its owning rule (owner-scoped) and requires
  // that rule to be a draft.
  async function requireDraftRuleForStep_(user, stepId) {
    const { data: step, error } = await client().from("automation_steps").select("id,rule_id")
      .eq("id", stepId).maybeSingle();
    if (error) throw error;
    if (!step) throw new Error("Step not found.");
    await requireDraftRule_(user, step.rule_id);
    return step;
  }

  async function listAutomationRules() {
    const user = requireUser();
    const { data, error } = await client().from("automation_rules").select(RULE_COLUMNS)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async function createAutomationRule(model) {
    model = model || {};
    const user = requireUser();
    const triggerType = validateTriggerType_(model.triggerType);
    const row = {
      user_id: user.id,
      name: validateRuleName_(model.name),
      trigger_type: triggerType,
      status: "draft", // hard-forced — this phase never activates a rule
      timezone: validateTimezone_(model.timezone),
      audience_filter: validateAudienceFilterShape_(triggerType, model.audienceFilter),
      trigger_config: validateTriggerConfigShape_(triggerType, model.triggerConfig),
      stop_on_reply: validateOptionalBoolean_(model.stopOnReply, true, "stop_on_reply must be true or false."),
      stop_on_unsubscribe: validateOptionalBoolean_(model.stopOnUnsubscribe, true, "stop_on_unsubscribe must be true or false."),
      daily_enrollment_limit: validateDailyLimit_(model.dailyEnrollmentLimit != null ? model.dailyEnrollmentLimit : 100),
      metadata: validateJsonObjectField_(model.metadata, "Rule metadata")
    };
    const { data, error } = await client().from("automation_rules").insert(row).select(RULE_COLUMNS).single();
    if (error) throw friendlyRuleConstraintError_(error);
    return data;
  }

  // patch never accepts a "status" key by design — activation/pausing is
  // out of scope for this phase at the data layer, not just the UI.
  // Also rejects the update outright if the rule is not (or is no longer)
  // a draft, so a non-draft rule can never be edited through this path
  // even if a caller bypasses the page's own read-only rendering.
  async function updateAutomationRule(id, patch) {
    if (typeof id !== "string" || !UUID_PATTERN_.test(id)) throw new Error("A valid rule id is required.");
    const user = requireUser();
    const draftRule = await requireDraftRule_(user, id);
    patch = patch || {};
    const row = {};
    if ("name" in patch) row.name = validateRuleName_(patch.name);
    if ("triggerType" in patch) row.trigger_type = validateTriggerType_(patch.triggerType);
    if ("timezone" in patch) row.timezone = validateTimezone_(patch.timezone);
    if ("dailyEnrollmentLimit" in patch) row.daily_enrollment_limit = validateDailyLimit_(patch.dailyEnrollmentLimit);
    if ("stopOnReply" in patch) {
      if (typeof patch.stopOnReply !== "boolean") throw new Error("stop_on_reply must be true or false.");
      row.stop_on_reply = patch.stopOnReply;
    }
    if ("stopOnUnsubscribe" in patch) {
      if (typeof patch.stopOnUnsubscribe !== "boolean") throw new Error("stop_on_unsubscribe must be true or false.");
      row.stop_on_unsubscribe = patch.stopOnUnsubscribe;
    }
    if ("audienceFilter" in patch) row.audience_filter = validateJsonObjectField_(patch.audienceFilter, "Audience filter");
    if ("triggerConfig" in patch) row.trigger_config = validateJsonObjectField_(patch.triggerConfig, "Trigger settings");
    if ("metadata" in patch) row.metadata = validateJsonObjectField_(patch.metadata, "Rule metadata");
    if (Object.keys(row).length === 0) throw new Error("Nothing to update.");
    // Re-validate the EFFECTIVE trigger_type + audience_filter combination
    // (whichever of the two is actually changing, against whichever
    // stays as-is) so a trigger-type change can never leave a
    // now-nonsensical filter behind, and so a filter can never be saved
    // with a status_equals value outside this app's actual statuses.
    const effectiveTriggerType = "triggerType" in patch ? row.trigger_type : draftRule.trigger_type;
    const effectiveAudienceFilter = "audienceFilter" in patch ? row.audience_filter : draftRule.audience_filter;
    row.audience_filter = validateAudienceFilterShape_(effectiveTriggerType, effectiveAudienceFilter);
    // Phase 2A: the same reasoning for the trigger's own settings. Changing
    // the trigger type must not leave the previous type's settings behind,
    // so the effective pair is always re-validated together.
    const effectiveTriggerConfig = "triggerConfig" in patch ? row.trigger_config : draftRule.trigger_config;
    row.trigger_config = validateTriggerConfigShape_(effectiveTriggerType, effectiveTriggerConfig);
    const { data, error } = await client().from("automation_rules").update(row)
      .eq("id", id).select(RULE_COLUMNS).single();
    if (error) throw friendlyRuleConstraintError_(error);
    return data;
  }

  async function deleteAutomationRule(id) {
    if (typeof id !== "string" || !UUID_PATTERN_.test(id)) throw new Error("A valid rule id is required.");
    const user = requireUser();
    await requireDraftRule_(user, id);
    const { error } = await client().from("automation_rules").delete().eq("id", id);
    if (error) throw error; // automation_steps for this rule cascade-delete at the database level
    return true;
  }

  const STEP_COLUMNS = "id,rule_id,template_id,step_order,action_type,delay_minutes,subject_override,config,is_active,created_at,updated_at";
  const STEP_ACTION_TYPES = ["send_email", "create_task", "wait"];
  const STEP_DELAY_MAX_MINUTES = 525600;
  const TASK_PRIORITIES_ = ["High", "Medium", "Low"]; // matches this app's existing Tasks module convention

  function validateActionType_(t) {
    if (STEP_ACTION_TYPES.indexOf(t) === -1) throw new Error("Invalid step type.");
    return t;
  }
  function validateStepOrder_(n) {
    const num = Number(n);
    if (!Number.isInteger(num) || num <= 0) throw new Error("Step order must be a positive integer.");
    return num;
  }
  function validateDelayMinutes_(n) {
    const num = Number(n);
    if (!Number.isInteger(num) || num < 0 || num > STEP_DELAY_MAX_MINUTES) throw new Error("Delay must be an integer between 0 and 525600 minutes.");
    return num;
  }
  function validateSubjectOverride_(s) {
    if (s === undefined || s === null || s === "") return null;
    if (typeof s !== "string") throw new Error("Subject override must be text.");
    const trimmed = s.trim();
    if (trimmed.length > TEMPLATE_SUBJECT_MAX) throw new Error("Subject override must be at most 200 characters.");
    return trimmed || null;
  }
  function validateTaskConfig_(cfg) {
    cfg = validateJsonObjectField_(cfg, "Task configuration");
    const title = typeof cfg.title === "string" ? cfg.title.trim().slice(0, 200) : "";
    if (!title) throw new Error("Create Task steps require a task title.");
    const priority = TASK_PRIORITIES_.indexOf(cfg.priority) !== -1 ? cfg.priority : "Medium";
    return { title, priority };
  }
  function friendlyStepConstraintError_(error) {
    if (error && error.code === "23505") return new Error("A step already uses this order for this rule. Choose a different order.");
    return error;
  }
  // Shared by create/update — every mutable field is required from the
  // caller every time (no sparse patching), so the send_email/template_id
  // pairing enforced by the database CHECK constraint is always validated
  // against a complete, internally-consistent step shape client-side too.
  function buildStepRow_(model) {
    model = model || {};
    const actionType = validateActionType_(model.actionType);
    let templateId = null;
    let subjectOverride = null;
    let config = {};
    if (actionType === "send_email") {
      if (typeof model.templateId !== "string" || !UUID_PATTERN_.test(model.templateId)) {
        throw new Error("Send Email steps require an active email template.");
      }
      templateId = model.templateId;
      subjectOverride = validateSubjectOverride_(model.subjectOverride);
    } else if (model.templateId) {
      throw new Error("Only Send Email steps may reference an email template.");
    }
    if (actionType === "create_task") config = validateTaskConfig_(model.config);
    return {
      template_id: templateId,
      action_type: actionType,
      delay_minutes: validateDelayMinutes_(model.delayMinutes != null ? model.delayMinutes : 0),
      subject_override: subjectOverride,
      config: config,
      is_active: validateOptionalBoolean_(model.isActive, true, "is_active must be true or false.")
    };
  }

  async function listAutomationSteps(ruleId) {
    if (typeof ruleId !== "string" || !UUID_PATTERN_.test(ruleId)) throw new Error("A valid rule id is required.");
    const user = requireUser();
    const { data, error } = await client().from("automation_steps").select(STEP_COLUMNS)
      .eq("rule_id", ruleId).order("step_order", { ascending: true });
    if (error) throw error;
    return data || [];
  }

  // stepOrder is set once at creation (append-only) and is never exposed
  // as an editable field afterward — see updateAutomationStep. Reordering
  // by swapping two steps' step_order would need two separate PostgREST
  // requests with no shared transaction, which could transiently collide
  // against the (user_id, rule_id, step_order) unique constraint, so it is
  // deliberately not implemented; delete and re-add in the desired order
  // instead.
  async function createAutomationStep(ruleId, model) {
    if (typeof ruleId !== "string" || !UUID_PATTERN_.test(ruleId)) throw new Error("A valid rule id is required.");
    const user = requireUser();
    await requireDraftRule_(user, ruleId);
    const row = Object.assign(
      { user_id: user.id, rule_id: ruleId, step_order: validateStepOrder_(model && model.stepOrder) },
      buildStepRow_(model)
    );
    const { data, error } = await client().from("automation_steps").insert(row).select(STEP_COLUMNS).single();
    if (error) throw friendlyStepConstraintError_(error);
    return data;
  }

  async function updateAutomationStep(id, model) {
    if (typeof id !== "string" || !UUID_PATTERN_.test(id)) throw new Error("A valid step id is required.");
    const user = requireUser();
    await requireDraftRuleForStep_(user, id);
    const row = buildStepRow_(model); // step_order is intentionally not settable here
    const { data, error } = await client().from("automation_steps").update(row)
      .eq("id", id).select(STEP_COLUMNS).single();
    if (error) throw friendlyStepConstraintError_(error);
    return data;
  }

  async function deleteAutomationStep(id) {
    if (typeof id !== "string" || !UUID_PATTERN_.test(id)) throw new Error("A valid step id is required.");
    const user = requireUser();
    await requireDraftRuleForStep_(user, id);
    const { error } = await client().from("automation_steps").delete().eq("id", id);
    if (error) throw error;
    return true;
  }

  // ---------- AUTOMATION RUNTIME (Phase 4D) ----------
  // The ONLY code in this module that can move a rule out of 'draft', or
  // enroll a contact, or retry a failed job — and even this never touches
  // automation_rules/enrollments/jobs directly for those actions. Every
  // one of those six actions is a single authenticated call to the
  // manage-automation Edge Function, which owns the actual privileged
  // writes with its own service-role client. This module never calls
  // process-automation, never reads a lock token, provider secret, or
  // body/subject snapshot, and every list function below selects an
  // explicit, narrow, safe column list — no runtime_snapshot, no
  // outbound_messages body_snapshot, no worker payload.
  const MANAGE_AUTOMATION_KNOWN_ERROR_CODES_ = [
    "authentication_required", "method_not_allowed", "invalid_json", "request_too_large", "unknown_action",
    "invalid_request", "rule_not_found", "invalid_transition", "invalid_timezone", "invalid_audience_filter",
    "no_active_steps", "invalid_step_order", "invalid_step_template", "invalid_step_subject", "invalid_step_body",
    "unsupported_merge_tag", "invalid_step_task_title", "invalid_step_task_priority", "unsupported_step_action",
    "sender_profile_unavailable", "provider_not_configured", "internal_error", "rule_not_eligible",
    "contact_not_found", "invalid_contact_email", "contact_opted_out", "contact_suppressed",
    "duplicate_enrollment", "rate_limited", "job_not_found", "job_not_eligible",
    // Phase 4E.2
    "contact_replied", "contact_unsubscribed", "try_again",
    // Phase 2A
    "invalid_trigger_config"
  ];

  // Same ambiguity discipline as sendTestEmail: a thrown/relay/unparseable
  // failure, or an unrecognized code, is never assumed to mean the action
  // didn't happen — it throws request_ambiguous (retryable) rather than a
  // false definitive failure. A recognized, allowlisted rejection is
  // never reclassified as ambiguous.
  async function invokeManageAutomation_(body) {
    let data, error;
    try {
      ({ data, error } = await client().functions.invoke("manage-automation", { body }));
    } catch (invokeErr) {
      throwRequestAmbiguous_(null);
    }
    if (error) {
      const { code, retryAfterSeconds } = await readAllowlistedFunctionErrorBody_(error);
      if (code && MANAGE_AUTOMATION_KNOWN_ERROR_CODES_.indexOf(code) !== -1) {
        const normalized = new Error(code);
        normalized.code = code;
        normalized.retryAfterSeconds = retryAfterSeconds;
        normalized.retryable = code === "rate_limited" || code === "try_again";
        throw normalized;
      }
      throwRequestAmbiguous_(retryAfterSeconds);
    }
    if (!data || typeof data !== "object") throwRequestAmbiguous_(null);
    if (data.error) {
      if (typeof data.error === "string" && MANAGE_AUTOMATION_KNOWN_ERROR_CODES_.indexOf(data.error) !== -1) {
        const normalized = new Error(data.error);
        normalized.code = data.error;
        normalized.retryAfterSeconds = (typeof data.retry_after_seconds === "number" && isFinite(data.retry_after_seconds)) ? data.retry_after_seconds : null;
        normalized.retryable = data.error === "rate_limited" || data.error === "try_again";
        throw normalized;
      }
      throwRequestAmbiguous_(typeof data.retry_after_seconds === "number" ? data.retry_after_seconds : null);
    }
    if (data.ok !== true) throwRequestAmbiguous_(null);
    return data;
  }

  function requireRuleId_(ruleId) {
    if (typeof ruleId !== "string" || !UUID_PATTERN_.test(ruleId)) throw new Error("A valid sequence id is required.");
    return ruleId;
  }

  async function activateAutomationRule(ruleId) {
    requireUser();
    const data = await invokeManageAutomation_({ action: "activate_rule", rule_id: requireRuleId_(ruleId) });
    return data.rule;
  }
  async function pauseAutomationRule(ruleId) {
    requireUser();
    const data = await invokeManageAutomation_({ action: "pause_rule", rule_id: requireRuleId_(ruleId) });
    return data.rule;
  }
  async function resumeAutomationRule(ruleId) {
    requireUser();
    const data = await invokeManageAutomation_({ action: "resume_rule", rule_id: requireRuleId_(ruleId) });
    return data.rule;
  }
  async function archiveAutomationRule(ruleId) {
    requireUser();
    const data = await invokeManageAutomation_({ action: "archive_rule", rule_id: requireRuleId_(ruleId) });
    return data.rule;
  }
  // contactId is never validated against a UUID/text shape beyond "looks
  // like a non-empty id" here — the Edge Function itself re-verifies the
  // contact belongs to the caller, so this can never enroll a contact
  // outside the caller's own owner-scoped list no matter what the UI
  // passes.
  async function manualEnrollContact(ruleId, contactId) {
    requireUser();
    if (typeof contactId !== "string" || !contactId.trim() || contactId.length > 100) {
      throw new Error("A valid contact is required.");
    }
    const data = await invokeManageAutomation_({ action: "manual_enroll", rule_id: requireRuleId_(ruleId), contact_id: contactId });
    return data.enrollment_id;
  }
  async function retryAutomationJob(jobId) {
    requireUser();
    if (typeof jobId !== "string" || !UUID_PATTERN_.test(jobId)) throw new Error("A valid job id is required.");
    await invokeManageAutomation_({ action: "retry_job", job_id: jobId });
    return true;
  }

  // Phase 4E adds the two per-enrollment lifecycle markers so the UI can
  // say WHEN a reply/unsubscribe was detected, not just that it stopped.
  const ENROLLMENT_COLUMNS =
    "id,rule_id,contact_id,status,current_step_order,next_action_at,started_at,completed_at,stopped_at,stop_reason,reply_detected_at,unsubscribe_detected_at,created_at,updated_at";
  const MAX_ENROLLMENTS = 50;
  async function listAutomationEnrollments(ruleId, opts) {
    if (typeof ruleId !== "string" || !UUID_PATTERN_.test(ruleId)) throw new Error("A valid sequence id is required.");
    const user = requireUser();
    opts = opts || {};
    const limit = clampInt_(opts.limit, 1, MAX_ENROLLMENTS, 20);
    const { data, error } = await client().from("automation_enrollments").select(ENROLLMENT_COLUMNS)
      .eq("rule_id", ruleId).order("started_at", { ascending: false }).range(0, limit - 1);
    if (error) throw error;
    return data || [];
  }

  // Phase 4E adds cancelled_at/cancelled_reason so a deliberately
  // cancelled job reads differently from a failed one.
  const JOB_COLUMNS =
    "id,enrollment_id,job_type,status,scheduled_at,started_at,completed_at,attempts,max_attempts,last_error,failure_category,retriable,cancelled_at,cancelled_reason,skipped_reason,created_at";
  const MAX_JOBS = 50;
  async function listAutomationJobs(enrollmentId, opts) {
    if (typeof enrollmentId !== "string" || !UUID_PATTERN_.test(enrollmentId)) throw new Error("A valid enrollment id is required.");
    const user = requireUser();
    opts = opts || {};
    const limit = clampInt_(opts.limit, 1, MAX_JOBS, 20);
    const { data, error } = await client().from("automation_jobs").select(JOB_COLUMNS)
      .eq("enrollment_id", enrollmentId).order("scheduled_at", { ascending: false }).range(0, limit - 1);
    if (error) throw error;
    return data || [];
  }

  // Never selects provider_response — only a safe status/error summary.
  const RUN_COLUMNS = "id,job_id,attempt_number,status,started_at,finished_at,error_code,error_message";
  const MAX_RUNS = 20;
  async function listAutomationRuns(jobId, opts) {
    if (typeof jobId !== "string" || !UUID_PATTERN_.test(jobId)) throw new Error("A valid job id is required.");
    const user = requireUser();
    opts = opts || {};
    const limit = clampInt_(opts.limit, 1, MAX_RUNS, 10);
    const { data, error } = await client().from("automation_runs").select(RUN_COLUMNS)
      .eq("job_id", jobId).order("attempt_number", { ascending: false }).range(0, limit - 1);
    if (error) throw error;
    return data || [];
  }

  const FAILURE_COLUMNS = "id,job_id,category,error_code,error_message,retriable,resolved,created_at";
  const MAX_FAILURES = 50;
  // automation_failures has no rule_id column of its own, so unresolved
  // failures for a rule are found via that rule's own job ids — still a
  // fully owner-scoped, two-step read, never a cross-user query.
  // ---------- PHASE 4E: READ-ONLY STOP / LIFECYCLE INFORMATION ----------
  // Both of these are strictly reads. Nothing in this file can stop an
  // enrollment, cancel a job, or set a contact lifecycle marker — those
  // columns have no browser write path at all (the automation tables grant
  // no such column to authenticated, and public.contacts is protected by a
  // BEFORE trigger that discards browser writes to the two new columns).
  async function getAutomationStopSummary(ruleId, opts) {
    if (typeof ruleId !== "string" || !UUID_PATTERN_.test(ruleId)) throw new Error("A valid sequence id is required.");
    opts = opts || {};
    const limit = clampInt_(opts.limit, 1, 100, 20);
    const data = await invokeManageAutomation_({ action: "stop_summary", rule_id: ruleId, limit: limit });
    return {
      stoppedCounts: (data && typeof data.stopped_counts === "object" && data.stopped_counts) ? data.stopped_counts : {},
      stoppedEnrollments: Array.isArray(data && data.stopped_enrollments) ? data.stopped_enrollments : [],
      cancelledJobs: Array.isArray(data && data.cancelled_jobs) ? data.cancelled_jobs : [],
      skippedJobs: Array.isArray(data && data.skipped_jobs) ? data.skipped_jobs : []
    };
  }

  const CONTACT_LIFECYCLE_COLUMNS = "id,reply_detected_at,unsubscribe_detected_at";
  async function getContactLifecycleStatus(contactId) {
    if (typeof contactId !== "string" || !contactId.trim()) throw new Error("A valid contact id is required.");
    const user = requireUser();
    const { data, error } = await client().from("contacts").select(CONTACT_LIFECYCLE_COLUMNS)
      .eq("id", contactId).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
      id: data.id,
      replyDetectedAt: data.reply_detected_at || null,
      unsubscribeDetectedAt: data.unsubscribe_detected_at || null
    };
  }

  // Phase 4E.2, read-only. Everything the contact page needs to say
  // whether follow-up emails can reach this contact. Owner-scoped SELECTs
  // under RLS; never returns the stored address itself.
  async function getContactEmailStatus(contactId) {
    if (typeof contactId !== "string" || !contactId.trim()) throw new Error("A valid contact id is required.");
    const user = requireUser();
    const { data: contact, error: contactError } = await client().from("contacts")
      .select("id,email,reply_detected_at,unsubscribe_detected_at")
      .eq("id", contactId).maybeSingle();
    if (contactError) throw contactError;
    if (!contact) return null;
    const { data: consent, error: consentError } = await client().from("communication_consents")
      .select("status,source").eq("contact_id", contactId).eq("channel", "email").maybeSingle();
    if (consentError) throw consentError;
    const normalized = typeof contact.email === "string" ? contact.email.trim().toLowerCase() : "";
    let blockedReason = null;
    if (normalized) {
      const { data: blocks, error: blockError } = await client().from("email_suppressions")
        .select("reason").eq("normalized_email", normalized).eq("is_active", true).limit(1);
      if (blockError) throw blockError;
      if (blocks && blocks.length) blockedReason = typeof blocks[0].reason === "string" ? blocks[0].reason : "manual";
    }
    return {
      replyDetectedAt: contact.reply_detected_at || null,
      unsubscribeDetectedAt: contact.unsubscribe_detected_at || null,
      emailOptedOut: !!(consent && consent.status === "opted_out"),
      // How the opt-out happened (unsubscribe_link | inbound_email |
      // owner_manual | provider_webhook), so the page can say it plainly.
      optOutSource: consent && consent.status === "opted_out" && typeof consent.source === "string" ? consent.source : null,
      emailBlocked: blockedReason !== null,
      blockedReason: blockedReason
    };
  }

  function requireContactId_(contactId) {
    if (typeof contactId !== "string" || !contactId.trim() || contactId.length > 100) throw new Error("A valid contact is required.");
    return contactId;
  }
  // Phase 4E.2 manual fallbacks — server-side only, owner-verified.
  async function markContactReplied(contactId) {
    requireUser();
    return await invokeManageAutomation_({ action: "mark_replied", contact_id: requireContactId_(contactId) });
  }
  async function markContactUnsubscribed(contactId) {
    requireUser();
    return await invokeManageAutomation_({ action: "mark_unsubscribed", contact_id: requireContactId_(contactId) });
  }

  async function listAutomationFailuresForRule(ruleId, opts) {
    if (typeof ruleId !== "string" || !UUID_PATTERN_.test(ruleId)) throw new Error("A valid sequence id is required.");
    const user = requireUser();
    opts = opts || {};
    const limit = clampInt_(opts.limit, 1, MAX_FAILURES, 20);
    const { data: jobs, error: jobsError } = await client().from("automation_jobs").select("id")
      .eq("rule_id", ruleId).order("created_at", { ascending: false }).range(0, 199);
    if (jobsError) throw jobsError;
    const jobIds = (jobs || []).map((j) => j.id);
    if (!jobIds.length) return [];
    const { data, error } = await client().from("automation_failures").select(FAILURE_COLUMNS)
      .eq("resolved", false).in("job_id", jobIds)
      .order("created_at", { ascending: false }).range(0, limit - 1);
    if (error) throw error;
    return data || [];
  }

  // ---------- EMAIL SENDER PROFILE + TEST SEND (Phase 4C) ----------
  // Configuration + a single authenticated Edge Function call. This module
  // never talks to Resend directly and never inserts/updates/deletes an
  // outbound_messages row itself — every actual send goes through the
  // send-test-email Edge Function, which owns that write using its own
  // service-role client. No API key, webhook secret, or sending domain is
  // ever read, stored, or returned by anything here.
  const SENDER_PROFILE_COLUMNS = "user_id,display_name,reply_to_email,is_enabled,provider,created_at,updated_at";
  const SENDER_DISPLAY_NAME_MAX = 100;
  const SENDER_REPLY_TO_MAX = 254;
  const SENDER_CONTROL_CHARS_RE = /[\x00-\x1F\x7F]/;
  const SENDER_UNSAFE_HEADER_CHARS_RE = /[<>"\\,]/;
  const SENDER_EMAIL_SHAPE_RE =
    /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

  function validateSenderDisplayName_(name) {
    if (typeof name !== "string") throw new Error("Sender display name is required.");
    const trimmed = name.trim();
    if (!trimmed || trimmed.length > SENDER_DISPLAY_NAME_MAX) throw new Error("Sender display name must be 1-100 characters.");
    if (SENDER_CONTROL_CHARS_RE.test(trimmed) || SENDER_UNSAFE_HEADER_CHARS_RE.test(trimmed)) {
      throw new Error('Sender display name can\'t contain <, >, ", \\, a comma, or control characters.');
    }
    return trimmed;
  }
  function validateSenderReplyTo_(email) {
    if (typeof email !== "string") throw new Error("Reply-To email is required.");
    const trimmed = email.trim();
    if (!trimmed || trimmed.length > SENDER_REPLY_TO_MAX) throw new Error("Reply-To email must be 1-254 characters.");
    if (SENDER_CONTROL_CHARS_RE.test(trimmed) || trimmed.indexOf(",") !== -1) throw new Error("Reply-To must be exactly one email address.");
    if (!SENDER_EMAIL_SHAPE_RE.test(trimmed)) throw new Error("Reply-To must be a single valid email address.");
    return trimmed;
  }
  function validateIsEnabledStrict_(value) {
    if (typeof value !== "boolean") throw new Error("is_enabled must be true or false.");
    return value;
  }

  async function getEmailSenderProfile() {
    const user = requireUser();
    const { data, error } = await client().from("email_sender_profiles")
      .select(SENDER_PROFILE_COLUMNS).maybeSingle();
    if (error) throw error;
    return data || null;
  }

  // Never accepts user_id, provider, a From address, sender alias, or any
  // Resend configuration from the caller — those are hard-coded/derived
  // here or entirely server-side (Edge Function), never client input.
  async function saveEmailSenderProfile(model) {
    model = model || {};
    const user = requireUser();
    const row = {
      user_id: user.id,
      display_name: validateSenderDisplayName_(model.displayName),
      reply_to_email: validateSenderReplyTo_(model.replyToEmail),
      is_enabled: validateIsEnabledStrict_(model.isEnabled),
      provider: "resend"
    };
    const { data, error } = await client().from("email_sender_profiles")
      .upsert(row, { onConflict: "user_id" }).select(SENDER_PROFILE_COLUMNS).single();
    if (error) throw error;
    return data;
  }

  const TEST_MESSAGE_COLUMNS = [
    "id", "status", "message_kind", "channel", "provider", "recipient", "subject",
    "sender_display_name", "sender_address", "reply_to_email",
    "queued_at", "sent_at", "delivered_at", "delivery_delayed_at", "opened_at", "clicked_at",
    "bounced_at", "complained_at", "suppressed_at", "failed_at", "unsubscribed_at",
    "provider_message_id", "error_code", "error_message", "created_at"
  ].join(",");
  // Never selects body_snapshot — the UI must not display full body content.
  const MAX_TEST_HISTORY = 50;

  async function listRecentTestOutboundMessages(opts) {
    opts = opts || {};
    const user = requireUser();
    const limit = clampInt_(opts.limit, 1, MAX_TEST_HISTORY, 20);
    const { data, error } = await client().from("outbound_messages")
      .select(TEST_MESSAGE_COLUMNS)
      .eq("message_kind", "test")
      .order("created_at", { ascending: false })
      .range(0, limit - 1);
    if (error) throw error;
    return data || [];
  }

  // Invokes the authenticated send-test-email Edge Function — the ONLY
  // place in the browser codebase that can trigger a single, immediate,
  // configuration-only test send. (Activating an automation rule, via
  // activateAutomationRule below, is the OTHER way a real send can
  // eventually happen — asynchronously, later, from the server-only
  // process-automation worker, never from browser code.) Neither path
  // ever talks to Resend directly from here; both only ever call
  // Supabase's own functions.invoke, which carries the caller's own JWT.
  const TEST_SEND_STATUS_WHITELIST_ = [
    "queued", "sent", "delivered", "delivery_delayed", "opened", "clicked", "replied",
    "bounced", "complained", "suppressed", "failed", "unsubscribed"
  ];
  const TEST_SEND_EMAIL_SHAPE_ =
    /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
  const TEST_SEND_PROVIDER_ID_MAX_ = 128;
  const TEST_SEND_PROVIDER_ID_SHAPE_ = /^[A-Za-z0-9_.-]+$/;

  function isValidIsoTimestampOrNull_(value) {
    if (value === null || value === undefined) return true;
    if (typeof value !== "string") return false;
    const d = new Date(value);
    return !isNaN(d.getTime());
  }
  function isSafeShortTextOrNull_(value, max) {
    if (value === null || value === undefined) return true;
    return typeof value === "string" && value.length <= max;
  }
  // Never trusts a partial or malformed response as a real outcome — every
  // field is checked against an explicit shape/whitelist before this
  // module hands the message back to a page to render or act on.
  function validateTestSendMessage_(message) {
    const fail = () => { throw new Error("Unexpected response from the test-send service."); };
    if (!message || typeof message !== "object" || Array.isArray(message)) fail();
    if (typeof message.id !== "string" || !UUID_PATTERN_.test(message.id)) fail();
    if (typeof message.status !== "string" || TEST_SEND_STATUS_WHITELIST_.indexOf(message.status) === -1) fail();
    if (typeof message.recipient !== "string" || !TEST_SEND_EMAIL_SHAPE_.test(message.recipient)) fail();
    if (typeof message.subject !== "string" || message.subject.length > TEMPLATE_SUBJECT_MAX) fail();
    if (typeof message.sender_display_name !== "string" || !message.sender_display_name || message.sender_display_name.length > TEMPLATE_NAME_MAX) fail();
    if (typeof message.sender_address !== "string" || !TEST_SEND_EMAIL_SHAPE_.test(message.sender_address)) fail();
    if (
      !isValidIsoTimestampOrNull_(message.queued_at) || !isValidIsoTimestampOrNull_(message.sent_at) ||
      !isValidIsoTimestampOrNull_(message.delivered_at) || !isValidIsoTimestampOrNull_(message.failed_at)
    ) fail();
    if (message.provider_message_id !== null && message.provider_message_id !== undefined) {
      if (
        typeof message.provider_message_id !== "string" || !message.provider_message_id.trim() ||
        message.provider_message_id.length > TEST_SEND_PROVIDER_ID_MAX_ ||
        !TEST_SEND_PROVIDER_ID_SHAPE_.test(message.provider_message_id)
      ) fail();
    }
    if (!isSafeShortTextOrNull_(message.error_code, 100) || !isSafeShortTextOrNull_(message.error_message, 500)) fail();
    return message;
  }

  // Reads only an explicit allowlist of fields from a Functions HTTP error
  // response body — never headers, never an Authorization value, never a
  // raw provider diagnostic dump.
  async function readAllowlistedFunctionErrorBody_(error) {
    let code = null;
    let retryAfterSeconds = null;
    try {
      if (error.context && typeof error.context.json === "function") {
        const body = await error.context.json();
        if (body && typeof body.error === "string") code = body.error;
        if (body && typeof body.retry_after_seconds === "number" && isFinite(body.retry_after_seconds)) {
          retryAfterSeconds = body.retry_after_seconds;
        }
      }
    } catch (parseErr) {
      // Response body already consumed or not JSON — fall back to the
      // generic message below.
    }
    return { code, retryAfterSeconds };
  }

  // Every error code the Edge Function can legitimately, deliberately
  // return. Anything else — a fetch/relay-level failure, an HTTP error
  // whose body couldn't be parsed, a missing/unrecognized error code, or a
  // malformed/incomplete "successful" response — is a browser-to-Edge
  // transport ambiguity: the Edge Function may have already sent the
  // email even though this call never confirmed it, so it must never be
  // classified as a definitive failure.
  const SEND_TEST_KNOWN_ERROR_CODES_ = [
    "authentication_required", "method_not_allowed", "invalid_json", "request_too_large", "invalid_request",
    "sender_profile_incomplete", "sender_profile_disabled", "template_not_found", "template_inactive", "invalid_template",
    "suppressed_recipient", "provider_not_configured", "rate_limited", "send_in_progress", "provider_ambiguous",
    "message_update_failed", "internal_error", "provider_error", "provider_timeout"
  ];

  // ---------- LEAD FILE IMPORT (Phase 4E.4) ----------
  // The browser's only path to a file import: one authenticated call to the
  // import-lead-file Edge Function with rows already parsed in memory. No
  // insert/update against contacts or the import tables happens here; the
  // server owns every write, re-validates every row and takes the owner
  // from the JWT. The file itself is never sent or stored.
  const IMPORT_FILE_KNOWN_ERROR_CODES_ = [
    "authentication_required", "method_not_allowed", "invalid_json", "request_too_large", "invalid_request",
    "no_rows", "too_many_rows", "rate_limited", "try_again"
  ];
  async function importLeadFile(payload) {
    requireUser();
    payload = payload || {};
    if (typeof payload.importId !== "string" || !UUID_PATTERN_.test(payload.importId)) throw new Error("A valid import id is required.");
    if (typeof payload.fileName !== "string" || !payload.fileName.trim()) throw new Error("A file name is required.");
    if (!Array.isArray(payload.rows) || !payload.rows.length) throw new Error("There are no rows to import.");
    const body = {
      import_id: payload.importId,
      file_name: payload.fileName.slice(0, 255),
      rows: payload.rows,
      start_automation: payload.startAutomation === true
    };
    let data, error;
    try {
      ({ data, error } = await client().functions.invoke("import-lead-file", { body }));
    } catch (invokeErr) {
      // Never reached the function, or the answer was lost: a retry with
      // the same import id is safe.
      throwRequestAmbiguous_(null);
    }
    if (error) {
      const { code, retryAfterSeconds } = await readAllowlistedFunctionErrorBody_(error);
      if (code && IMPORT_FILE_KNOWN_ERROR_CODES_.indexOf(code) !== -1) {
        const normalized = new Error(code);
        normalized.code = code;
        normalized.retryAfterSeconds = retryAfterSeconds;
        normalized.retryable = code === "try_again" || code === "rate_limited";
        throw normalized;
      }
      throwRequestAmbiguous_(retryAfterSeconds);
    }
    if (!data || typeof data !== "object" || data.ok !== true) throwRequestAmbiguous_(null);
    const n = (v) => (typeof v === "number" && isFinite(v) ? v : 0);
    const list = (v) => (Array.isArray(v) ? v : []).map((r) => ({
      rowNumber: n(r && r.row_number),
      reason: r && typeof r.reason === "string" ? r.reason : "This row could not be imported."
    }));
    return {
      replayed: data.replayed === true,
      batchId: typeof data.batch_id === "string" ? data.batch_id : null,
      total: n(data.total),
      imported: n(data.imported),
      updated: n(data.updated),
      skipped: n(data.skipped),
      rejected: n(data.rejected),
      dailyLimitSkipped: n(data.daily_limit_skipped),
      rejectedRows: list(data.rejected_rows),
      skippedRows: list(data.skipped_rows),
      limitedRows: (Array.isArray(data.limited_rows) ? data.limited_rows : []).map(n),
      quota: normalizeFileImportQuota_(data.quota)
    };
  }

  // The daily allowance of new contacts from files, read through the same
  // Edge Function (owner from the JWT). null if it can't be read right now;
  // the server enforces the limit either way.
  async function getLeadFileImportQuota() {
    requireUser();
    try {
      const { data, error } = await client().functions.invoke("import-lead-file", { body: { action: "quota" } });
      if (error || !data || data.ok !== true) return null;
      return normalizeFileImportQuota_(data.quota);
    } catch (e) {
      return null;
    }
  }

  function normalizeFileImportQuota_(q) {
    if (!q || typeof q !== "object") return null;
    const n = (v) => (typeof v === "number" && isFinite(v) ? v : 0);
    return {
      limit: n(q.limit),
      used: n(q.used),
      remaining: n(q.remaining),
      resetsAt: typeof q.resets_at === "string" ? q.resets_at : null
    };
  }

  function throwRequestAmbiguous_(retryAfterSeconds) {
    const err = new Error("request_ambiguous");
    err.code = "request_ambiguous";
    err.retryable = true;
    err.retryAfterSeconds = (typeof retryAfterSeconds === "number" && isFinite(retryAfterSeconds)) ? retryAfterSeconds : null;
    throw err;
  }

  // Invokes the authenticated send-test-email Edge Function — this is the
  // browser's only path to an IMMEDIATE, single test send. It never talks
  // to Resend directly, only to Supabase's own functions.invoke (carrying
  // the caller's own JWT). It is not the only way a real send can ever
  // result from browser code, though: activating an automation rule (see
  // activateAutomationRule) can lead to a real send too, but only later,
  // asynchronously, from the server-only process-automation worker.
  //
  // A definitive outcome (an existing terminal message, or a fresh
  // send/failure) is returned as a strictly-validated message object.
  // Anything ambiguous — provider-side (.code === "provider_ambiguous") or
  // browser-transport-side (.code === "request_ambiguous") — throws with
  // .retryable === true so the caller can safely retry with the SAME
  // idempotency key rather than treat it as a definitive failure. A
  // structured, allowlisted rejection (e.g. template_inactive) is never
  // reclassified as ambiguous.
  async function sendTestEmail(payload) {
    payload = payload || {};
    const templateId = payload.templateId;
    const idempotencyKey = payload.idempotencyKey;
    if (typeof templateId !== "string" || !UUID_PATTERN_.test(templateId)) throw new Error("A valid template id is required.");
    if (typeof idempotencyKey !== "string" || !UUID_PATTERN_.test(idempotencyKey)) throw new Error("A valid idempotency key is required.");

    let data, error;
    try {
      ({ data, error } = await client().functions.invoke("send-test-email", {
        body: { template_id: templateId, idempotency_key: idempotencyKey }
      }));
    } catch (invokeErr) {
      // A thrown network/fetch/relay failure from functions.invoke itself
      // — the request may never have reached the Edge Function, or its
      // response may never have reached us. Either way, ambiguous.
      throwRequestAmbiguous_(null);
    }

    if (error) {
      const { code, retryAfterSeconds } = await readAllowlistedFunctionErrorBody_(error);
      if (code && SEND_TEST_KNOWN_ERROR_CODES_.indexOf(code) !== -1) {
        const normalized = new Error(code);
        normalized.code = code;
        normalized.retryAfterSeconds = retryAfterSeconds;
        normalized.retryable = code === "send_in_progress" || code === "rate_limited" || code === "provider_ambiguous";
        throw normalized;
      }
      // A relay error, a fetch error, an HTTP error body that couldn't be
      // parsed as JSON, or one with no recognized structured code.
      throwRequestAmbiguous_(retryAfterSeconds);
    }

    if (!data || typeof data !== "object") throwRequestAmbiguous_(null);

    if (data.error) {
      if (typeof data.error === "string" && SEND_TEST_KNOWN_ERROR_CODES_.indexOf(data.error) !== -1) {
        const normalized = new Error(data.error);
        normalized.code = data.error;
        normalized.retryAfterSeconds = (typeof data.retry_after_seconds === "number" && isFinite(data.retry_after_seconds)) ? data.retry_after_seconds : null;
        normalized.retryable = data.retryable === true || data.error === "send_in_progress" || data.error === "rate_limited" || data.error === "provider_ambiguous";
        throw normalized;
      }
      // An error field present but not a code this module recognizes —
      // treat conservatively as ambiguous rather than assuming we
      // understood a response we can't actually validate.
      throwRequestAmbiguous_(typeof data.retry_after_seconds === "number" ? data.retry_after_seconds : null);
    }

    if (data.ok !== true) throwRequestAmbiguous_(null);

    try {
      return validateTestSendMessage_(data.message);
    } catch (validationErr) {
      // The HTTP layer reported success, but the payload can't be
      // trusted — an "otherwise successful response" that fails strict
      // validation is ambiguous, not a generic unclassified error.
      throwRequestAmbiguous_(null);
    }
  }

  // ---------- TRANSACTIONAL RPCs ----------
  async function createDealWithMilestones(dealModel, milestoneModels) {
    requireUser();
    const dealId = dealModel.id || U().uid("dl");
    const dealRow = Object.assign({ id: dealId }, REGISTRY.deals.toRow(Object.assign({}, dealModel, { id: dealId })));
    const milestoneRows = (milestoneModels || []).map(m => Object.assign({ id: m.id || U().uid("ms") }, REGISTRY.milestones.toRow(m)));
    setSyncState({ status: "saving", message: "Saving…" });
    try {
      const { data, error } = await client().rpc("realtoros_create_deal_with_milestones", { p_deal: dealRow, p_milestones: milestoneRows });
      if (error) throw error;
      const deal = REGISTRY.deals.fromRow(data.deal);
      const milestones = (data.milestones || []).map(REGISTRY.milestones.fromRow);
      if (!cache.deals) cache.deals = [];
      cache.deals.push(deal);
      if (!cache.milestones) cache.milestones = [];
      cache.milestones.push.apply(cache.milestones, milestones);
      markSelf("deals", deal.id);
      setSyncState({ status: "synced", message: "Synced", retry: null });
      return { deal, milestones };
    } catch (err) {
      setSyncState({ status: "error", message: "Sync failed — Retry", retry: () => createDealWithMilestones(dealModel, milestoneModels) });
      throw err;
    }
  }

  async function completeFollowUp(activityModel, contactId, lastContact, nextFollowUp) {
    requireUser();
    const activityId = activityModel.id || U().uid("ac");
    const activityRow = Object.assign({ id: activityId }, REGISTRY.activities.toRow(Object.assign({}, activityModel, { id: activityId })));
    setSyncState({ status: "saving", message: "Saving…" });
    try {
      const { data, error } = await client().rpc("realtoros_complete_followup", {
        p_activity: activityRow, p_contact_id: contactId, p_last_contact: lastContact, p_next_follow_up: nextFollowUp
      });
      if (error) throw error;
      const activity = REGISTRY.activities.fromRow(data.activity);
      const contact = REGISTRY.contacts.fromRow(data.contact);
      if (!cache.activities) cache.activities = [];
      cache.activities.push(activity);
      if (cache.contacts) {
        const idx = cache.contacts.findIndex(c => c.id === contact.id);
        if (idx >= 0) cache.contacts[idx] = contact;
      }
      markSelf("contacts", contact.id);
      setSyncState({ status: "synced", message: "Synced", retry: null });
      return { activity, contact };
    } catch (err) {
      setSyncState({ status: "error", message: "Sync failed — Retry", retry: () => completeFollowUp(activityModel, contactId, lastContact, nextFollowUp) });
      throw err;
    }
  }

  async function resetWorkspace() {
    setSyncState({ status: "saving", message: "Saving…" });
    try {
      const { error } = await client().rpc("realtoros_reset_workspace");
      if (error) throw error;
      Object.keys(cache).forEach(k => { cache[k] = null; });
      settingsCache = null; metadataCache = null;
      await loadSettings(true);
      const resetUi = Object.assign({}, (settingsCache && settingsCache.ui) || {}, { onboardingStatus: "complete" });
      await updateSettings({ ui: resetUi });
      const user = requireUser();
      const { error: markerError } = await client().from("workspace_settings")
        .update({ migration_completed_at: new Date().toISOString() })
        .eq("workspace_id", await requireWorkspaceId_());
      if (markerError) throw markerError;
      setSyncState({ status: "synced", message: "Synced", retry: null });
      return true;
    } catch (err) {
      setSyncState({ status: "error", message: "Sync failed — Retry", retry: () => resetWorkspace() });
      throw err;
    }
  }

  // ---------- ONE-TIME LEGACY MIGRATION ----------
  // Shared dependency-ordered bulk upsert, used by both the one-time legacy
  // migration and backup restore. Idempotent: re-running with the same
  // record IDs updates in place rather than duplicating rows.
  async function upsertAll(entityKey, models, patchRow) {
    if (!models || !models.length) return 0;
    const def = REGISTRY[entityKey];
    const user = requireUser();
    const rows = models.map(m => {
      const base = Object.assign({ id: m.id, user_id: user.id }, def.toRow(m));
      return patchRow ? (patchRow(base, m) || base) : base;
    });
    const { error } = await client().from(def.table).upsert(rows, { onConflict: "id" });
    if (error) throw error;
    return rows.length;
  }

  // Restores a validated backup envelope's data into this user's relational
  // tables. Idempotent (upsert on id, dependency-ordered) so a retried or
  // re-imported backup never duplicates records — it only ever overwrites
  // records the backup itself named. Existing records not present in the
  // backup are left untouched (this mirrors the legacy migration's
  // "never delete before every row validates" rule: validateImport() already
  // ran and approved every row before this is ever called).
  async function restoreFromBackup(data) {
    const user = requireUser();
    const raw = App.store.migrateData(data);
    raw.settings.ui = Object.assign({}, raw.settings.ui || {}, { onboardingStatus: "complete" });

    await upsertAll("teamMembers", raw.teamMembers);
    await upsertAll("contacts", raw.contacts);
    await upsertAll("properties", raw.properties, (row) => { row.deal_id = null; return row; });
    await upsertAll("deals", raw.deals);
    for (const p of (raw.properties || [])) {
      if (p.dealId) {
        const { error } = await client().from("properties").update({ deal_id: p.dealId }).eq("id", p.id);
        if (error) throw error;
      }
    }
    await upsertAll("milestones", raw.milestones);
    await upsertAll("activities", raw.activities);
    await upsertAll("tasks", raw.tasks);
    await upsertAll("showings", raw.showings);
    await upsertAll("referrals", raw.referrals, (row, m) => {
      const c = (raw.contacts || []).find(x => x.id === m.referrerId);
      row.referrer_name = c ? c.name : "";
      return row;
    });
    await upsertAll("goals", raw.goals);
    await upsertAll("income", raw.income);
    await upsertAll("expenses", raw.expenses);
    await upsertAll("scripts", raw.scripts);
    await upsertAll("aiPrompts", raw.aiPrompts);
    await upsertAll("scheduledItems", raw.scheduledItems);
    await upsertAll("customFieldValues", raw.customFieldValues);

    const settingsRow = settingsToRow(raw.settings, raw.metadata);
    const { error: setErr } = await client().from("workspace_settings").update(settingsRow)
      .eq("workspace_id", await requireWorkspaceId_());
    if (setErr) throw setErr;

    resetAllCaches();
    return { ok: true };
  }

  async function migrateLegacyIfNeeded() {
    const user = requireUser();
    const { data: wsRow, error: wsErr } = await client().from("workspace_settings").select("user_id, migration_completed_at").maybeSingle();
    if (wsErr) throw wsErr;
    if (wsRow && wsRow.migration_completed_at) return { migrated: true, alreadyDone: true };

    const { data: legacyRow, error: legacyErr } = await client().from("workspace_state").select("state").maybeSingle();
    if (legacyErr) throw legacyErr;

    if (!legacyRow || !legacyRow.state || typeof legacyRow.state !== "object") {
      await loadSettings(true);
      const { error: markErr } = await client().from("workspace_settings")
        .update({ migration_completed_at: new Date().toISOString() })
        .eq("workspace_id", await requireWorkspaceId_());
      if (markErr) throw markErr;
      return { migrated: true, alreadyDone: false, empty: true };
    }

    // Run the existing schema-version migration/normalization logic,
    // completely unchanged, on this user's legacy blob only.
    const raw = App.store.migrateData(legacyRow.state);
    raw.settings.ui = Object.assign({}, raw.settings.ui || {}, { onboardingStatus: "complete" });

    // Dependency order: independents first, properties WITHOUT their deal
    // link (deals don't exist yet), deals, the deferred property->deal
    // link, every child table, finance, custom values, settings last.
    await upsertAll("teamMembers", raw.teamMembers);
    await upsertAll("contacts", raw.contacts);
    await upsertAll("properties", raw.properties, (row) => { row.deal_id = null; return row; });
    await upsertAll("deals", raw.deals);
    for (const p of (raw.properties || [])) {
      if (p.dealId) {
        const { error } = await client().from("properties").update({ deal_id: p.dealId }).eq("id", p.id);
        if (error) throw error;
      }
    }
    await upsertAll("milestones", raw.milestones);
    await upsertAll("activities", raw.activities);
    await upsertAll("tasks", raw.tasks);
    await upsertAll("showings", raw.showings);
    await upsertAll("referrals", raw.referrals, (row, m) => {
      const c = (raw.contacts || []).find(x => x.id === m.referrerId);
      row.referrer_name = c ? c.name : "";
      return row;
    });
    await upsertAll("goals", raw.goals);
    await upsertAll("income", raw.income);
    await upsertAll("expenses", raw.expenses);
    await upsertAll("scripts", raw.scripts);
    await upsertAll("aiPrompts", raw.aiPrompts);
    await upsertAll("scheduledItems", raw.scheduledItems);
    await upsertAll("customFieldValues", raw.customFieldValues);

    const expectedCounts = {
      teamMembers: (raw.teamMembers || []).length, contacts: (raw.contacts || []).length,
      properties: (raw.properties || []).length, deals: (raw.deals || []).length,
      milestones: (raw.milestones || []).length, activities: (raw.activities || []).length,
      tasks: (raw.tasks || []).length, showings: (raw.showings || []).length,
      referrals: (raw.referrals || []).length, goals: (raw.goals || []).length,
      income: (raw.income || []).length, expenses: (raw.expenses || []).length,
      scripts: (raw.scripts || []).length, aiPrompts: (raw.aiPrompts || []).length,
      scheduledItems: (raw.scheduledItems || []).length,
      customFieldValues: (raw.customFieldValues || []).length
    };
    const checks = [];
    for (const entityKey of Object.keys(expectedCounts)) {
      const def = REGISTRY[entityKey];
      let q = client().from(def.table).select("id", { count: "exact", head: true });
      if (def.financeType) q = q.eq("type", def.financeType);
      const { count, error } = await q;
      if (error) throw error;
      checks.push({ entityKey, expected: expectedCounts[entityKey], actual: count || 0 });
    }
    const mismatches = checks.filter(c => c.actual < c.expected);
    if (mismatches.length) {
      const err = new Error("Migration verification failed for: " + mismatches.map(m => m.entityKey + " (expected " + m.expected + ", found " + m.actual + ")").join(", "));
      err.mismatches = mismatches;
      throw err;
    }

    const settingsRow = Object.assign({ id: U().uid("ws"), user_id: user.id }, settingsToRow(raw.settings, raw.metadata), { migration_completed_at: new Date().toISOString() });
    const { error: setErr } = await client().from("workspace_settings").upsert(settingsRow, { onConflict: "workspace_id" });
    if (setErr) throw setErr;

    // Only this user's own legacy row, only after everything above verified.
    // The legacy blob is keyed by user_id, and a DELETE needs a filter
    // for the same reason an UPDATE does.
    const { error: delErr } = await client().from("workspace_state").delete()
      .eq("user_id", user.id);
    if (delErr) throw delErr; // blob is kept if the delete itself fails; retry is safe/idempotent (upsert)

    Object.keys(cache).forEach(k => { cache[k] = null; });
    settingsCache = null; metadataCache = null;
    return { migrated: true, alreadyDone: false, counts: checks };
  }

  // ---------- REALTIME ----------
  //
  // Rows are filtered by WORKSPACE, not by creator. Filtering on user_id
  // meant that in team mode a teammate's edit to a shared contact never
  // reached this browser: the row belongs to them, so the socket never
  // offered it. The workspace is the right grain, and it is the grain RLS
  // already uses.
  //
  // This does NOT widen what anybody can see. The filter only narrows what
  // this client ASKS for; the row policies still decide what the socket is
  // allowed to deliver, so an agent restricted to their own leads keeps
  // receiving only those.
  let channels = [];
  // The workspace the open channels are filtered to. Lets a real workspace
  // change (the permission context arriving, a join, a leave, an ownership
  // transfer) be told apart from a repeat call for the same workspace.
  let subscribedWorkspaceId = null;
  let workspaceWatch = null;
  const changeListeners = [];
  function onEntityChanged(fn) { changeListeners.push(fn); return () => { const i = changeListeners.indexOf(fn); if (i >= 0) changeListeners.splice(i, 1); }; }
  function notifyEntityChanged(entityKey, info) { changeListeners.forEach(fn => { try { fn(entityKey, info); } catch (e) {} }); }

  // null whenever the permission context has not loaded or the person is
  // not an active member of any workspace. Defensive about App.workspace
  // itself because the tests load this module without the whole app.
  function currentWorkspaceId() {
    const w = App.workspace;
    if (!w || typeof w.id !== "function") return null;
    try { return w.id() || null; } catch (e) { return null; }
  }

  // subscribeRealtime() runs from app.js finishBoot BEFORE the permission
  // context is loaded, so the first call usually has no workspace id yet.
  // One listener, registered once, rebuilds the channels as soon as the
  // workspace arrives and again whenever it changes.
  function watchWorkspace() {
    if (workspaceWatch) return;
    if (!App.workspace || typeof App.workspace.onChange !== "function") return;
    workspaceWatch = App.workspace.onChange(() => {
      if (currentWorkspaceId() !== subscribedWorkspaceId) subscribeRealtime();
    });
  }

  function subscribeRealtime() {
    unsubscribeRealtime();
    const user = App.cloud.getUser();
    if (!user) return;
    watchWorkspace();
    const workspaceId = currentWorkspaceId();
    // No workspace to filter on. Subscribing anyway would mean either an
    // unfiltered channel (asking for every workspace's rows) or a filter
    // on an empty string (matching nothing), so wait instead: the watcher
    // above re-runs this the moment the workspace is known.
    if (!workspaceId) return;
    const tableToEntities = {};
    Object.keys(REGISTRY).forEach(k => {
      const t = REGISTRY[k].table;
      tableToEntities[t] = tableToEntities[t] || [];
      tableToEntities[t].push(k);
    });
    const ch = client().channel("realtoros-data-" + user.id + "-" + workspaceId);
    Object.keys(tableToEntities).forEach(table => {
      ch.on("postgres_changes", { event: "*", schema: "public", table, filter: "workspace_id=eq." + workspaceId }, (payload) => {
        tableToEntities[table].forEach(entityKey => {
          const def = REGISTRY[entityKey];
          const row = (payload.new && Object.keys(payload.new).length) ? payload.new : payload.old;
          if (!row) return;
          if (def.financeType && row.type && row.type !== def.financeType) return;
          const id = row.id;
          const isSelf = id && selfWrites.has(entityKey + ":" + id);
          if (cache[entityKey]) {
            if (payload.eventType === "DELETE") {
              cache[entityKey] = cache[entityKey].filter(r => r.id !== id);
            } else {
              const rec = def.fromRow(payload.new);
              const idx = cache[entityKey].findIndex(r => r.id === id);
              if (idx >= 0) cache[entityKey][idx] = rec; else cache[entityKey].push(rec);
            }
          }
          notifyEntityChanged(entityKey, { self: isSelf, eventType: payload.eventType });
        });
      });
    });
    // T2d made settings one row per WORKSPACE, so a user_id filter here
    // missed every change made by another member - including the team mode
    // toggle and the module list.
    ch.on("postgres_changes", { event: "*", schema: "public", table: "workspace_settings", filter: "workspace_id=eq." + workspaceId }, () => {
      settingsCache = null; metadataCache = null;
      notifyEntityChanged("__settings__", { self: false });
    });
    ch.subscribe();
    channels.push(ch);
    subscribedWorkspaceId = workspaceId;
  }

  function unsubscribeRealtime() {
    channels.forEach(ch => { try { client().removeChannel(ch); } catch (e) {} });
    channels = [];
    subscribedWorkspaceId = null;
  }

  // ---------- TEAM: MEMBERSHIP, INVITATIONS, PERMISSIONS ----------
  //
  // Every one of these is a database function (an RPC), because each does
  // something the browser must not be trusted with: minting an invitation
  // token, reading a roster the row policies deliberately hide, or changing
  // what somebody may do. The pattern throughout: a real failure THROWS, and
  // an answer the user caused is RETURNED as an { outcome } object for the
  // screen to put into words. Nothing here is cached - a roster read right
  // after a change has to show what the server did, not what we hoped.
  async function callTeamRpc(fn, args) {
    requireUser();
    const { data, error } = await client().rpc(fn, args || {});
    if (error) throw error;
    return data;
  }

  // The workspace's stored role templates, straight off the table - the
  // browser may read these (every active member may), and only the RPCs
  // below may write them. A role with no stored row is still on its shipped
  // preset, which is why a missing row is normal rather than an error.
  async function listRolePermissions() {
    requireUser();
    const { data, error } = await client()
      .from("workspace_role_permissions")
      .select("role, permissions, updated_at");
    if (error) throw error;
    const byRole = {};
    (data || []).forEach(r => { byRole[r.role] = r.permissions; });
    return byRole;
  }

  const listMembers        = ()              => callTeamRpc("realtoros_list_members");
  const listInvitations    = ()              => callTeamRpc("realtoros_list_invitations");
  const inviteMember       = (email, role)   => callTeamRpc("realtoros_invite_member", { p_email: email, p_role: role });
  const revokeInvitation   = (invitationId)  => callTeamRpc("realtoros_revoke_invitation", { p_invitation_id: invitationId });
  const acceptInvitation   = (token)         => callTeamRpc("realtoros_accept_invitation", { p_token: token });
  const removeMember       = (memberId)      => callTeamRpc("realtoros_remove_member", { p_member_id: memberId });
  const changeMemberRole   = (memberId, role) => callTeamRpc("realtoros_change_member_role", { p_member_id: memberId, p_role: role });
  const transferOwnership  = (memberId)      => callTeamRpc("realtoros_transfer_ownership", { p_member_id: memberId });
  const setRolePermissions = (role, permissions) => callTeamRpc("realtoros_set_role_permissions", { p_role: role, p_permissions: permissions });
  const setMemberPermissions = (memberId, overrides) => callTeamRpc("realtoros_set_member_permissions", { p_member_id: memberId, p_overrides: overrides });
  const resetMemberPermissions = (memberId)  => callTeamRpc("realtoros_reset_member_permissions", { p_member_id: memberId });

  // The three that change the CALLER's own place in the world. Each ends with
  // the caller somewhere else, so every cached row from the old workspace is
  // dropped and the permission context is re-read before anything renders
  // again - otherwise the next screen would be drawn from another
  // workspace's data.
  async function leaveTeam() {
    const out = await callTeamRpc("realtoros_leave_workspace");
    if (out && out.outcome === "left") await afterOwnMembershipChanged();
    return out;
  }
  async function deleteTeam(confirmName) {
    const out = await callTeamRpc("realtoros_delete_workspace", { p_confirm_name: confirmName });
    if (out && out.outcome === "deleted") await afterOwnMembershipChanged();
    return out;
  }
  async function acceptTeamInvitation(token) {
    const out = await acceptInvitation(token);
    // Only a real acceptance carries the new membership; an already-used
    // invitation echoes the same word back with nothing attached.
    if (out && out.outcome === "accepted" && (out.member_id || out.workspace_id)) {
      await afterOwnMembershipChanged();
    }
    return out;
  }
  // Transferring ownership demotes the caller to admin, so their own
  // permissions change even though their workspace does not.
  async function transferTeamOwnership(memberId) {
    const out = await transferOwnership(memberId);
    if (out && out.outcome === "transferred" && App.workspace) {
      try { await App.workspace.load(true); } catch (e) { /* accessors fall back to no access */ }
    }
    return out;
  }
  async function afterOwnMembershipChanged() {
    resetAllCaches();
    if (App.workspace) {
      try { await App.workspace.load(true); } catch (e) { /* accessors fall back to no access */ }
    }
  }

  function resetAllCaches() {
    Object.keys(cache).forEach(k => { cache[k] = null; });
    settingsCache = null; metadataCache = null;
  }

  return {
    listTimezones,

    REGISTRY,
    list, get, create, update, remove, getCached,
    loadSettings, updateSettings, updateMetadata, getSettingsSync, getMetadataSync,
    createDealWithMilestones, completeFollowUp, resetWorkspace,
    listSheetConnections, createOrRotateSheetConnection,
    listImportBatches, listImportRows, importLeadFile, getLeadFileImportQuota,
    listNotifications, countUnreadNotifications, markNotificationRead, markAllNotificationsRead,
    listPushDevices, registerPushDevice, removePushDevice,
    getNotificationPreferences, saveNotificationPreferences,
    listMessageTemplates, createMessageTemplate, updateMessageTemplate, deleteMessageTemplate,
    activateMessageTemplate,
    listEligibleLegacyScriptImports, importLegacyScriptsAsTemplates,
    listAutomationRules, createAutomationRule, updateAutomationRule, deleteAutomationRule,
    listAutomationSteps, createAutomationStep, updateAutomationStep, deleteAutomationStep,
    activateAutomationRule, pauseAutomationRule, resumeAutomationRule, archiveAutomationRule,
    manualEnrollContact, retryAutomationJob,
    getContactEmailStatus, markContactReplied, markContactUnsubscribed,
    listAutomationEnrollments, listAutomationJobs, listAutomationRuns, listAutomationFailuresForRule,
    getAutomationStopSummary, getContactLifecycleStatus,
    getEmailSenderProfile, saveEmailSenderProfile, listRecentTestOutboundMessages, sendTestEmail,
    listMembers, listInvitations, inviteMember, revokeInvitation,
    acceptTeamInvitation, removeMember, changeMemberRole, transferTeamOwnership,
    leaveTeam, deleteTeam,
    listRolePermissions, setRolePermissions, setMemberPermissions, resetMemberPermissions,
    migrateLegacyIfNeeded, restoreFromBackup,
    subscribeRealtime, unsubscribeRealtime, onEntityChanged,
    getSyncState, onSyncStateChange,
    resetAllCaches
  };
})();
