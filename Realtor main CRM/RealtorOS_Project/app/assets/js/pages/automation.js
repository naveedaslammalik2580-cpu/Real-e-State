/* ============================================================
   automation.js — Automation (draft sequences + Phase 4D runtime +
   Phase 4E stop visibility).
   Configuration-only draft-automation builder over public.automation_rules
   and public.automation_steps, using public.message_templates for Send
   Email steps — plus, as of Phase 4D, the management controls
   (activate/pause/resume/archive/manual-enroll/retry) and a read-only
   runtime view (enrollments/jobs/runs/failures).

   Phase 4E adds READ-ONLY stop visibility: why a sequence stopped for a
   contact (replied / unsubscribed / bounced / suppressed), which jobs were
   cancelled rather than failed, and per-rule stop counts. This module has
   no code path that can stop an enrollment, cancel a job, or set a contact
   lifecycle marker — every stop is applied server-side by resend-webhook
   or process-automation, and those columns have no browser write path.

   This module never writes to automation_enrollments, automation_jobs,
   automation_runs, or outbound_messages directly, and never calls an
   email provider. Every rule-status transition and every enrollment/job
   action goes through the authenticated manage-automation Edge Function
   (App.store.automationRuntime) — there is no code path here capable of
   activating a rule, enrolling a contact, or retrying a job on its own.
   createAutomationRule always forces status:'draft', and
   updateAutomationRule never accepts a "status" patch key, so editing a
   rule can never activate it either.

   IMPORTANT: activating a sequence here only prepares it to run once this
   environment is fully deployed and configured (sender profile, Resend,
   and a scheduled worker) — see the callout in the rule list. A rule
   whose status is not 'draft' is shown with its steps read-only (no
   edit/delete of steps), so this page can't silently change an already-
   active sequence's configuration.

   Depends on: app.js, store.js (App.store.automationRules,
   App.store.automationSteps, App.store.automationRuntime,
   App.store.messageTemplates), util.js
   ============================================================ */

window.App = window.App || {};
App.pages = App.pages || {};

App.pages.automation = (function () {
  "use strict";

  const U = () => App.util;
  const S = () => App.store;

  const TRIGGER_LABELS = {
    new_lead: "New Lead",
    contact_created: "Contact Created",
    contact_status_changed: "Contact Status Changed",
    manual: "Manual",
    // Phase 2A. Worded as what the agent is choosing, not as the column
    // value behind it.
    follow_up_due: "Follow-up date arrives",
    no_contact: "No contact for X days",
    status_stale: "Stuck in a status for X days",
    deal_stage_changed: "Deal moves to a stage",
    // Phase 2D
    birthday: "Birthday",
    home_anniversary: "Home purchase anniversary"
  };
  // The trigger types that need their own settings, and the deal values
  // the deal trigger can filter on. Deal stages come from the workspace's
  // own pipeline settings, so they are read at render time rather than
  // hardcoded here.
  const TRIGGER_CONFIG_TYPES = [
    "follow_up_due", "no_contact", "status_stale", "deal_stage_changed",
    "birthday", "home_anniversary"
  ];
  // The two that recur every year. They have no "include contacts who
  // already match" choice, because a greeting for a date that has passed is
  // not something anybody wants sent late.
  const YEARLY_TRIGGER_TYPES = ["birthday", "home_anniversary"];
  const DEAL_SIDES = ["Buyer", "Seller"];
  const ACTION_LABELS = { send_email: "Send Email", wait: "Wait", create_task: "Create Task" };
  const TASK_PRIORITIES = ["High", "Medium", "Low"];
  // The only contact statuses this app supports (matches store.js's own
  // contactStages, data-service.js's allowlist, and the server-side
  // activation/runtime allowlists exactly) — a Contact Status Changed
  // sequence may only ever match one of these.
  const CONTACT_STATUS_OPTIONS = ["New Lead", "Qualified", "Nurturing", "Client", "Past Client", "Lost"];
  // Phase 2F. What the Add Contact form offers, which is what a workspace
  // has unless it has been customised - the lists below are merged with
  // whatever the workspace's own contacts actually say, so a renamed or
  // imported value is offered too rather than being invisible here.
  const CONTACT_TYPE_OPTIONS = ["Buyer", "Seller", "Investor", "Referral Partner"];
  const TEMPERATURE_OPTIONS = ["Hot", "Warm", "Cold"];
  const RULE_STATUS_META = {
    draft: { label: "Draft", cls: "badge-neutral" },
    active: { label: "Active", cls: "badge-success" },
    paused: { label: "Paused", cls: "badge-warning" },
    archived: { label: "Archived", cls: "badge-neutral" }
  };
  const ENROLLMENT_STATUS_META = {
    active: { label: "Active", cls: "badge-success" },
    paused: { label: "Paused", cls: "badge-warning" },
    completed: { label: "Completed", cls: "badge-neutral" },
    stopped: { label: "Stopped", cls: "badge-neutral" },
    failed: { label: "Failed", cls: "badge-danger" }
  };
  // Phase 4E. A stop is a normal, expected outcome — never an error — so
  // every one of these is a neutral tone, deliberately distinct from the
  // red used for genuine failures.
  const STOP_REASON_META = {
    reply: { label: "Contact replied", cls: "badge-neutral" },
    unsubscribe: { label: "Contact unsubscribed", cls: "badge-neutral" },
    complaint: { label: "Contact reported spam", cls: "badge-neutral" },
    bounce: { label: "Email bounced", cls: "badge-neutral" },
    suppression: { label: "Email blocked", cls: "badge-neutral" },
    rule_archived: { label: "Automation archived", cls: "badge-neutral" },
    contact_opted_out: { label: "Contact opted out", cls: "badge-neutral" },
    contact_suppressed: { label: "Email blocked", cls: "badge-neutral" },
    enrollment_inactive: { label: "Follow-up already stopped", cls: "badge-neutral" },
    contact_not_found: { label: "Contact deleted", cls: "badge-neutral" },
    contact_ineligible: { label: "Contact not eligible", cls: "badge-neutral" }
  };
  // Phase 4E.2: why an email step was skipped while the rest of the
  // automation carried on.
  const SKIP_REASON_META = {
    contact_unsubscribed: "Emails paused — contact unsubscribed",
    consent_revoked: "Emails paused — contact opted out of email",
    suppressed: "Email blocked for this address"
  };
  // Step types shown as words, never as internal identifiers.
  const STEP_TYPE_LABELS = { send_email: "Email", create_task: "Task", advance_enrollment: "Wait" };
  function stepTypeLabel(type) {
    return safeLookup(STEP_TYPE_LABELS, type) || "Step";
  }
  function shortDate(value) {
    const d = value ? new Date(value) : null;
    if (!d || isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  // "Stopped — contact replied on Sep 28"
  function stoppedSentence(e) {
    const when = shortDate(e.reply_detected_at && e.stop_reason === "reply" ? e.reply_detected_at
      : (e.unsubscribe_detected_at && (e.stop_reason === "unsubscribe" || e.stop_reason === "complaint") ? e.unsubscribe_detected_at : e.stopped_at));
    const phrase = {
      reply: "contact replied",
      unsubscribe: "contact unsubscribed",
      complaint: "contact reported spam",
      bounce: "email bounced",
      suppression: "email blocked",
      rule_archived: "automation archived"
    };
    const what = safeLookup(phrase, e.stop_reason) || stopReasonLabel(e.stop_reason).toLowerCase();
    return "Stopped — " + what + (when ? " on " + when : "");
  }
  function stopReasonLabel(reason) {
    const meta = safeLookup(STOP_REASON_META, reason);
    if (meta) return meta.label;
    return reason ? String(reason) : "Stopped";
  }

  const JOB_STATUS_META = {
    pending: { label: "Pending", cls: "badge-neutral" },
    processing: { label: "Processing", cls: "badge-warning" },
    completed: { label: "Completed", cls: "badge-success" },
    failed: { label: "Failed", cls: "badge-danger" },
    cancelled: { label: "Cancelled", cls: "badge-neutral" }
  };

  // Never displays a real address anywhere in this module — first
  // character plus a masked remainder either side of the "@".
  function maskEmail(email) {
    if (typeof email !== "string" || !email || email.indexOf("@") === -1) return "—";
    const [localPart, domain] = email.split("@");
    const maskedLocal = localPart.length <= 1 ? localPart + "•••" : localPart.slice(0, 1) + "•••";
    const domainDot = domain.indexOf(".");
    const maskedDomain = domainDot > 0 ? "•••" + domain.slice(domainDot) : "•••";
    return maskedLocal + "@" + maskedDomain;
  }
  function formatDateTime(value) {
    if (!value) return "—";
    const d = new Date(value);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleString();
  }

  function safeLookup(map, key) {
    if (typeof key !== "string") return null;
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
  }

  /* ============================================================
   * RENDER ENTRY POINT
   * ========================================================== */

  async function render(pane, activityOnly = false) {
    if (!pane) return;
    App.app.setBreadcrumbs([{ label: "Automation" }]);
    App.app.setTopActions("");

    const state = {
      activityOnly,
      rules: [],
      templates: [], // ALL templates (active + inactive), for name lookups on existing steps
      loaded: false,
      error: null,
      expandedRuleId: null,
      stepsByRule: {}, // ruleId -> { steps, token, loading }
      expandedActivityRuleId: null,
      activityByRule: {}, // ruleId -> { enrollments, jobsByEnrollment, failures, token, loading, error }
      contacts: [] // owner-scoped cache snapshot, for the manual-enroll picker only
    };

    pane.innerHTML = App.app.loadingHtml ? App.app.loadingHtml("automation sequences") : "";
    renderShell(pane, state);
    await loadRules(pane, state);
  }

  /* ============================================================
   * STARTER PACKS (Phase 2E)
   *
   * The packs themselves live in core/starter-packs.js, because the
   * onboarding wizard offers the same ones and two copies of that copy
   * would drift. This is only the screen: pick which, install, say what
   * happened.
   * ========================================================== */

  function openStarterPackModal(pane, state) {
    const packs = (App.starterPacks && App.starterPacks.all()) || [];
    if (!packs.length) { App.app.toast("No starter packs are available.", "danger"); return; }

    const h = App.app.openModal({
      title: "Add starter sequences",
      wide: true,
      body: `
        <div class="release-callout release-callout-warning" style="margin-bottom:12px">
          <strong>Everything here is added as a draft.</strong>
          <p style="margin:6px 0 0">Nothing sends until you read it, make it sound like you, and activate it yourself.</p>
        </div>
        <div class="form-grid">
          ${packs.map((pack) => `
            <label class="field full" style="flex-direction:row;align-items:flex-start;gap:10px">
              <input type="checkbox" class="pack-pick" value="${U().esc(pack.id)}" checked style="margin-top:4px">
              <span style="font-weight:400">
                <strong>${U().esc(pack.name)}</strong>
                <div class="form-help" style="margin:2px 0 0">${U().esc(pack.blurb)}</div>
                ${pack.note ? `<div class="form-help" style="margin:2px 0 0"><em>${U().esc(pack.note)}</em></div>` : ""}
              </span>
            </label>`).join("")}
        </div>`,
      footer: `<button class="btn" data-role="cancel">Cancel</button>
               <button class="btn btn-primary" data-role="add">Add as drafts</button>`,
      onOpen: (m) => {
        m.querySelector('[data-role="cancel"]').onclick = () => h.close();
        const addBtn = m.querySelector('[data-role="add"]');
        addBtn.onclick = async () => {
          if (addBtn.disabled) return;
          const ids = Array.from(m.querySelectorAll(".pack-pick:checked")).map((c) => c.value);
          if (!ids.length) { App.app.toast("Tick at least one, or cancel.", "danger"); return; }
          addBtn.disabled = true;
          let result;
          try {
            const settings = (S().getState() && S().getState().settings) || {};
            result = await App.starterPacks.install(ids, { timezone: settings.timezone || "UTC" });
          } catch (err) {
            addBtn.disabled = false;
            App.app.toast("Could not add: " + ((err && err.message) || "Unknown error"), "danger");
            return;
          }
          h.close();
          App.app.toast(App.starterPacks.summarize(result), result.failed.length ? "danger" : "success");
          if (result.created.length) {
            App.app.toast("They are all drafts - read them, then activate.", "info");
          }
          await loadRules(pane, state);
        };
      }
    });
    return h;
  }

  function renderShell(pane, state) {
    if (state.activityOnly) {
      App.app.setBreadcrumbs([{ label: "Follow-up Plans", route: "/automation" }, { label: "Activity" }]);
      pane.innerHTML = `<div class="page-header"><div><div class="page-title">Activity</div><div class="page-desc">View enrollments, delivery history and failures for your follow-up plans.</div></div></div><p id="autoLiveStatus" aria-live="polite" role="status"></p><div id="autoRuleList"></div>`;
      return;
    }
    pane.innerHTML = `
      <div class="page-header">
        <div>
          <div class="page-title">Automation</div>
          <div class="page-desc">Prepare draft follow-up sequences using your Email Templates.</div>
        </div>
        <div class="page-actions">
          <button type="button" class="btn btn-primary" id="autoCreateBtn">${App.app.icon("plus")} Create Draft Sequence</button>
          <button type="button" class="btn" id="autoStarterPackBtn">${App.app.icon("plus")} Add starter sequences</button>
        </div>
      </div>

      <div class="release-callout release-callout-warning" style="margin-bottom:16px">
        <strong>Activation only takes effect once email delivery is configured.</strong>
        <p style="margin:6px 0 0">You can build and activate sequences here, but nothing will actually be enrolled or sent until your sender profile and email delivery are set up for this workspace. Editing a draft never sends anything.</p>
      </div>

      <p id="autoLiveStatus" class="profile-edit-message" aria-live="polite" role="status"></p>
      <div id="autoRuleList"></div>
    `;
    pane.querySelector("#autoCreateBtn").addEventListener("click", () => openRuleModal(pane, state, null));
    const packBtn = pane.querySelector("#autoStarterPackBtn");
    if (packBtn) packBtn.addEventListener("click", () => openStarterPackModal(pane, state));
  }

  function setLive(pane, text, kind) {
    const el = pane.querySelector("#autoLiveStatus");
    if (!el) return;
    el.textContent = text || "";
    el.className = "profile-edit-message" + (kind ? " " + kind : "");
  }

  /* ============================================================
   * RULE LIST
   * ========================================================== */

  async function loadRules(pane, state) {
    // The rules list itself is being refreshed — collapse any expanded
    // steps panel first (same rationale as staling a pending row request
    // before a batch-list refresh elsewhere in this app: a stale expanded
    // panel must never survive a full data refresh).
    Object.keys(state.stepsByRule).forEach((id) => {
      state.stepsByRule[id].token = (state.stepsByRule[id].token || 0) + 1;
    });
    state.stepsByRule = {};
    state.expandedRuleId = null;
    Object.keys(state.activityByRule).forEach((id) => {
      state.activityByRule[id].token = (state.activityByRule[id].token || 0) + 1;
    });
    state.activityByRule = {};
    state.expandedActivityRuleId = null;

    setLive(pane, "Loading sequences…");
    try {
      const [rules, templates] = await Promise.all([
        S().automationRules.list(),
        S().messageTemplates.list({ orderBy: "name" })
      ]);
      state.rules = rules;
      state.templates = templates;
      state.loaded = true;
      state.error = null;
      renderRuleList(pane, state);
      setLive(pane, rules.length ? ("Loaded " + rules.length + " sequence" + (rules.length === 1 ? "" : "s") + ".") : "No draft sequences yet.");
    } catch (err) {
      state.error = (err && err.message) ? err.message : "Unknown error";
      renderRuleList(pane, state);
      setLive(pane, "Could not load automation sequences.", "error");
    }
  }

  function renderRuleList(pane, state) {
    const el = pane.querySelector("#autoRuleList");
    if (!el) return;

    if (state.error) {
      el.innerHTML = `
        <div class="empty-state" role="alert">
          <div class="empty-title">Could not load automation sequences</div>
          <div class="empty-desc">${U().esc(state.error)}</div>
          <button type="button" class="btn btn-primary" id="autoRetry">Retry</button>
        </div>`;
      const retryBtn = el.querySelector("#autoRetry");
      if (retryBtn) retryBtn.addEventListener("click", () => loadRules(pane, state));
      return;
    }

    const visibleRules = state.activityOnly ? state.rules.filter(rule => rule.status !== "draft") : state.rules;
    if (state.activityOnly && !visibleRules.length) {
      el.innerHTML = `<div class="empty-state"><div class="empty-title">No plan activity yet</div><div class="empty-desc">Activity is available after a plan leaves draft status.</div></div>`;
      return;
    }
    if (!state.rules.length) {
      el.innerHTML = `
        <div class="empty-state">
          <div class="empty-title">No draft sequences yet</div>
          <div class="empty-desc">Build your first sequence: choose a trigger, add email and task steps, then activate it when you're ready. Editing a draft never sends anything.</div>
        </div>`;
      return;
    }

    el.innerHTML = visibleRules.map(r => renderRuleCard(state, r)).join("");

    const byId = {};
    state.rules.forEach(r => { byId[r.id] = r; });
    el.querySelectorAll("[data-view-steps]").forEach(btn => {
      const rule = byId[btn.getAttribute("data-view-steps")];
      if (rule) btn.addEventListener("click", () => toggleStepsPanel(pane, state, rule));
    });
    el.querySelectorAll("[data-edit-rule]").forEach(btn => {
      const rule = byId[btn.getAttribute("data-edit-rule")];
      if (rule) btn.addEventListener("click", () => openRuleModal(pane, state, rule));
    });
    el.querySelectorAll("[data-delete-rule]").forEach(btn => {
      const rule = byId[btn.getAttribute("data-delete-rule")];
      if (rule) btn.addEventListener("click", () => confirmDeleteRule(pane, state, rule));
    });
    el.querySelectorAll("[data-activate-rule]").forEach(btn => {
      const rule = byId[btn.getAttribute("data-activate-rule")];
      if (rule) btn.addEventListener("click", () => confirmActivateRule(pane, state, rule));
    });
    el.querySelectorAll("[data-pause-rule]").forEach(btn => {
      const rule = byId[btn.getAttribute("data-pause-rule")];
      if (rule) btn.addEventListener("click", () => confirmPauseRule(pane, state, rule));
    });
    el.querySelectorAll("[data-resume-rule]").forEach(btn => {
      const rule = byId[btn.getAttribute("data-resume-rule")];
      if (rule) btn.addEventListener("click", () => runResumeRule(pane, state, rule, btn));
    });
    el.querySelectorAll("[data-archive-rule]").forEach(btn => {
      const rule = byId[btn.getAttribute("data-archive-rule")];
      if (rule) btn.addEventListener("click", () => confirmArchiveRule(pane, state, rule));
    });
    el.querySelectorAll("[data-manual-enroll-rule]").forEach(btn => {
      const rule = byId[btn.getAttribute("data-manual-enroll-rule")];
      if (rule) btn.addEventListener("click", () => openManualEnrollModal(pane, state, rule));
    });
    el.querySelectorAll("[data-view-activity]").forEach(btn => {
      const rule = byId[btn.getAttribute("data-view-activity")];
      if (rule) btn.addEventListener("click", () => toggleActivityPanel(pane, state, rule));
    });

    // This full-list re-render can also happen after a step-level change
    // (add/edit/delete a step doesn't refetch the rules themselves) — if a
    // panel was left expanded with already-loaded step data, restore it
    // from the cache rather than leaving a freshly rebuilt, empty shell.
    if (state.expandedRuleId && byId[state.expandedRuleId]) {
      const bucket = state.stepsByRule[state.expandedRuleId];
      if (bucket && !bucket.loading) renderStepsPanel(pane, state, byId[state.expandedRuleId], bucket.steps);
    }
    if (state.expandedActivityRuleId && byId[state.expandedActivityRuleId]) {
      const bucket = state.activityByRule[state.expandedActivityRuleId];
      if (bucket && !bucket.loading) renderActivityPanel(pane, state, byId[state.expandedActivityRuleId], bucket);
    }
  }

  function ruleStatusBadge(status) {
    const meta = safeLookup(RULE_STATUS_META, status);
    const label = meta ? meta.label : "Unknown";
    const cls = meta ? meta.cls : "badge-neutral";
    return `<span class="badge ${cls}"><span class="dot"></span>${U().esc(label)}</span>`;
  }

  function renderRuleCard(state, rule) {
    const isDraft = rule.status === "draft";
    const expanded = state.expandedRuleId === rule.id;
    const activityExpanded = state.expandedActivityRuleId === rule.id;
    const readOnlyNote = {
      active: "This sequence is active: its steps are locked so an already-running sequence can't silently change. Pause or archive it to stop it.",
      paused: "This sequence is paused: no new contacts are being enrolled and no further steps run until you resume it. Its steps stay locked while paused.",
      archived: "This sequence is archived: it can never run again. Its history stays visible below."
    }[rule.status];
    return `
      <div class="gsih-batch-card" data-rule-id="${U().esc(rule.id)}">
        <div class="gsih-batch-head">
          <div>
            <div class="gsih-batch-conn">${U().esc(rule.name)}</div>
            <div class="form-help">Trigger: ${U().esc(safeLookup(TRIGGER_LABELS, rule.trigger_type) || "Unknown")} · Timezone: ${U().esc(rule.timezone)}</div>
            <div class="form-help">${U().esc(triggerSummaryText_(rule.trigger_type, rule.trigger_config, rule.timezone, rule.audience_filter))}</div>
          </div>
          ${ruleStatusBadge(rule.status)}
        </div>
        <div class="settings-status-grid">
          <div class="settings-status-card"><div class="k">Daily limit</div><div class="v">${U().esc(rule.daily_enrollment_limit)}</div></div>
          <div class="settings-status-card">
            <div class="k">Stop on reply</div>
            <div class="v">${isDraft ? (rule.stop_on_reply ? "Yes" : "No")
              : `<span class="badge ${rule.stop_on_reply ? "badge-success" : "badge-neutral"}"><span class="dot"></span>${rule.stop_on_reply ? "On" : "Off"}</span>`}</div>
          </div>
          <div class="settings-status-card">
            <div class="k">Stop on unsubscribe</div>
            <div class="v">${isDraft ? (rule.stop_on_unsubscribe ? "Yes" : "No")
              : `<span class="badge ${rule.stop_on_unsubscribe ? "badge-success" : "badge-neutral"}"><span class="dot"></span>${rule.stop_on_unsubscribe ? "On" : "Off"}</span>`}</div>
          </div>
        </div>
        ${readOnlyNote ? `
        <div class="release-callout release-callout-warning" style="margin-top:10px">
          <p style="margin:0">${U().esc(readOnlyNote)}</p>
        </div>` : ""}
        <div class="gsih-batch-actions">
          <button type="button" class="btn btn-sm" data-view-steps="${U().esc(rule.id)}">${expanded ? "Hide Steps" : "View Steps"}</button>
          ${!isDraft ? `<button type="button" class="btn btn-sm" data-view-activity="${U().esc(rule.id)}">${activityExpanded ? "Hide Activity" : "View Activity"}</button>` : ""}
          ${isDraft ? `<button type="button" class="btn btn-sm" data-edit-rule="${U().esc(rule.id)}">Edit</button>` : ""}
          ${isDraft ? `<button type="button" class="btn btn-sm btn-danger" data-delete-rule="${U().esc(rule.id)}">Delete</button>` : ""}
          ${isDraft ? `<button type="button" class="btn btn-sm btn-primary" data-activate-rule="${U().esc(rule.id)}">Activate</button>` : ""}
          ${rule.status === "active" ? `<button type="button" class="btn btn-sm" data-pause-rule="${U().esc(rule.id)}">Pause</button>` : ""}
          ${rule.status === "active" && rule.trigger_type === "manual" ? `<button type="button" class="btn btn-sm" data-manual-enroll-rule="${U().esc(rule.id)}">Manually Enroll…</button>` : ""}
          ${rule.status === "paused" ? `<button type="button" class="btn btn-sm btn-primary" data-resume-rule="${U().esc(rule.id)}">Resume</button>` : ""}
          ${(rule.status === "active" || rule.status === "paused") ? `<button type="button" class="btn btn-sm btn-danger" data-archive-rule="${U().esc(rule.id)}">Archive</button>` : ""}
        </div>
        <div class="gsih-row-panel" data-step-panel-for="${U().esc(rule.id)}" ${expanded ? "" : "hidden"}></div>
        <div class="gsih-row-panel" data-activity-panel-for="${U().esc(rule.id)}" ${activityExpanded ? "" : "hidden"}></div>
      </div>`;
  }

  function confirmDeleteRule(pane, state, rule) {
    App.app.confirmDialog({
      title: "Delete draft sequence?",
      message: `Delete &ldquo;${U().esc(rule.name)}&rdquo;? This also deletes its steps. This cannot be undone, and nothing was ever sent from it.`,
      okLabel: "Delete",
      danger: true
    }, async () => {
      try {
        await S().automationRules.delete(rule.id);
        App.app.toast("Deleted.", "success");
        await loadRules(pane, state);
      } catch (err) {
        App.app.toast("Could not delete: " + ((err && err.message) || "Unknown error"), "danger");
      }
    });
  }

  /* ============================================================
   * RULE STATUS ACTIONS (Phase 4D)
   * ========================================================== */

  function confirmActivateRule(pane, state, rule) {
    App.app.confirmDialog({
      title: "Activate this sequence?",
      message: `Activate &ldquo;${U().esc(rule.name)}&rdquo;? Once email delivery is configured, RealtorOS will begin automatically enrolling new matching contacts and running this sequence's steps — including sending real emails and creating real tasks. Its steps and settings will be locked: you can still pause, resume, or archive it, but you can't edit a non-draft sequence's configuration. Continue?`,
      okLabel: "Activate"
    }, async () => {
      try {
        await S().automationRuntime.activate(rule.id);
        App.app.toast("Sequence activated.", "success");
        await loadRules(pane, state);
      } catch (err) {
        App.app.toast(activationErrorMessage_(err), "danger");
      }
    });
  }

  // Surfaces the specific preflight failure the Edge Function reported,
  // rather than a generic message, so the user knows exactly what to fix.
  function activationErrorMessage_(err) {
    const code = err && err.code;
    const known = {
      invalid_timezone: "Timezone must be a valid IANA timezone.",
      invalid_audience_filter: "Audience filter is invalid for this trigger type.",
      no_active_steps: "This sequence needs at least one active step.",
      invalid_step_template: "A Send Email step's template is missing, inactive, or not an email template.",
      invalid_step_subject: "A Send Email step's subject is invalid or too long.",
      invalid_step_body: "A Send Email step's template body is empty or too long.",
      unsupported_merge_tag: "A Send Email step uses a merge tag that isn't supported. Only {{first_name}}, {{full_name}}, {{email}}, and {{agent_name}} are allowed.",
      invalid_step_task_title: "A Create Task step's title is missing or invalid.",
      invalid_step_task_priority: "A Create Task step's priority must be High, Medium, or Low.",
      sender_profile_unavailable: "A valid, enabled sender profile is required before activating (see Email Sending Settings).",
      provider_not_configured: "Email delivery isn't fully configured for this workspace yet.",
      invalid_transition: "This sequence can no longer be activated from its current status.",
      invalid_trigger_config: "This sequence's trigger settings are incomplete or out of range — reopen it and check them.",
      request_ambiguous: "The request may or may not have completed — check this sequence's status before retrying."
    };
    return safeLookup(known, code) || ((err && err.message) || "Could not activate this sequence.");
  }

  function confirmPauseRule(pane, state, rule) {
    App.app.confirmDialog({
      title: "Pause this sequence?",
      message: `Pause &ldquo;${U().esc(rule.name)}&rdquo;? No new contacts will be enrolled and no further steps will run for contacts already in this sequence until you resume it. Nothing already sent is undone. Continue?`,
      okLabel: "Pause"
    }, async () => {
      try {
        await S().automationRuntime.pause(rule.id);
        App.app.toast("Sequence paused.", "success");
        await loadRules(pane, state);
      } catch (err) {
        App.app.toast("Could not pause: " + ((err && err.message) || "Unknown error"), "danger");
      }
    });
  }

  async function runResumeRule(pane, state, rule, btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      await S().automationRuntime.resume(rule.id);
      App.app.toast("Sequence resumed.", "success");
      await loadRules(pane, state);
    } catch (err) {
      App.app.toast("Could not resume: " + ((err && err.message) || "Unknown error"), "danger");
      btn.disabled = false;
    }
  }

  function confirmArchiveRule(pane, state, rule) {
    App.app.confirmDialog({
      title: "Archive this sequence?",
      message: `Archive &ldquo;${U().esc(rule.name)}&rdquo;? Every contact currently active or paused in this sequence will be stopped, and their next scheduled step will be cancelled. This sequence can never be reactivated afterward. Its history (past enrollments, sends, and errors) is preserved and stays visible. This cannot be undone. Continue?`,
      okLabel: "Archive",
      danger: true
    }, async () => {
      try {
        await S().automationRuntime.archive(rule.id);
        App.app.toast("Sequence archived.", "success");
        await loadRules(pane, state);
      } catch (err) {
        App.app.toast("Could not archive: " + ((err && err.message) || "Unknown error"), "danger");
      }
    });
  }

  /* ============================================================
   * MANUAL ENROLLMENT (Phase 4D — manual-trigger rules only)
   * ========================================================== */

  function openManualEnrollModal(pane, state, rule) {
    const allContacts = (App.store.getState().contacts || []).slice()
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    let selectedContactId = null;
    let searchTerm = "";

    const h = App.app.openModal({
      title: "Manually Enroll a Contact",
      wide: true,
      body: `
        <p class="form-help">Enroll one contact into &ldquo;${U().esc(rule.name)}&rdquo;. Only contacts you own are shown, and their email is masked here for privacy.</p>
        <label class="field full"><span>Search contacts</span><input id="autoEnrollSearch" placeholder="Search by name or email…" autocomplete="off"></label>
        <div id="autoEnrollList" class="release-maintenance-list" style="max-height:280px;overflow-y:auto;margin-top:8px"></div>
        <div data-enroll-lifecycle role="status" aria-live="polite"></div>
      `,
      footer: `<button class="btn" data-role="cancel">Cancel</button><button class="btn btn-primary" data-role="save" disabled>Enroll Contact</button>`,
      onOpen: (m) => {
        m.querySelector('[data-role="cancel"]').onclick = () => h.close();
        const saveBtn = m.querySelector('[data-role="save"]');
        const listEl = m.querySelector("#autoEnrollList");
        const searchEl = m.querySelector("#autoEnrollSearch");

        function renderList() {
          const term = searchTerm.trim().toLowerCase();
          const filtered = !term ? allContacts : allContacts.filter((c) => {
            const name = (c.name || "").toLowerCase();
            const email = (c.email || "").toLowerCase();
            return name.indexOf(term) !== -1 || email.indexOf(term) !== -1;
          }).slice(0, 50);
          if (!filtered.length) {
            listEl.innerHTML = '<p class="form-help">No matching contacts.</p>';
            return;
          }
          listEl.innerHTML = filtered.map((c) => `
            <label style="display:flex;align-items:center;gap:10px;padding:6px 4px;cursor:pointer">
              <input type="radio" name="autoEnrollContact" value="${U().esc(c.id)}" ${selectedContactId === c.id ? "checked" : ""}>
              <span>${U().esc(c.name || "Unnamed contact")} &middot; ${U().esc(maskEmail(c.email))}</span>
            </label>
          `).join("");
          listEl.querySelectorAll('input[name="autoEnrollContact"]').forEach((input) => {
            input.addEventListener("change", () => {
              showLifecycleWarning(m, rule, input.value);
              selectedContactId = input.value;
              saveBtn.disabled = false;
            });
          });
        }
        searchEl.addEventListener("input", () => { searchTerm = searchEl.value; renderList(); });
        renderList();

        saveBtn.onclick = async () => {
          if (saveBtn.disabled || !selectedContactId) return;
          saveBtn.disabled = true;
          try {
            await S().automationRuntime.manualEnroll(rule.id, selectedContactId);
            App.app.toast("Contact added to this automation.", "success");
            h.close();
            if (state.expandedActivityRuleId === rule.id) await loadActivity(pane, state, rule);
          } catch (err) {
            const code = err && err.code;
            const known = {
              duplicate_enrollment: "This contact is already in this automation.",
              contact_opted_out: "This contact has opted out of email, so they can't be added.",
              contact_suppressed: "Email to this contact is blocked, so they can't be added.",
              contact_unsubscribed: "This contact unsubscribed, so they can't be added to this automation.",
              contact_replied: "This contact already replied, and this automation stops when a contact replies, so they can't be added.",
              contact_not_found: "This contact no longer exists.",
              rate_limited: "This automation's daily limit has been reached. Try again later.",
              rule_not_eligible: "This automation can't take contacts manually right now.",
              invalid_contact_email: "This contact has no valid email address."
            };
            App.app.toast(safeLookup(known, code) || "The contact couldn't be added. Please try again.", "danger");
            saveBtn.disabled = false;
          }
        };
      }
    });
  }

  /* ============================================================
   * ACTIVITY (enrollments / jobs / runs / failures — Phase 4D, read-only)
   * ========================================================== */

  // Phase 4E: explain up-front why a contact may not be enrollable,
  // rather than letting the server reject the attempt with no context.
  // Purely informational — the server remains the only authority, and this
  // never enables or disables the Enroll button on its own.
  async function showLifecycleWarning(modal, rule, contactId) {
    const target = modal.querySelector("[data-enroll-lifecycle]");
    if (!target) return;
    target.innerHTML = "";
    if (!contactId) return;
    let lifecycle = null;
    try {
      lifecycle = await S().automationRuntime.contactLifecycle(contactId);
    } catch (e) {
      return; // non-essential; never block the dialog on this read
    }
    if (!lifecycle) return;
    const notes = [];
    if (lifecycle.unsubscribeDetectedAt) {
      notes.push("This contact unsubscribed on " + formatDateTime(lifecycle.unsubscribeDetectedAt) +
        ". Email consent was revoked, so no automated email can be sent to them"
        + (rule.stop_on_unsubscribe ? ", and this sequence stops on unsubscribe." : "."));
    }
    if (lifecycle.replyDetectedAt) {
      notes.push("This contact replied on " + formatDateTime(lifecycle.replyDetectedAt) + "."
        + (rule.stop_on_reply ? " This sequence stops on reply, so they will not be enrolled." : ""));
    }
    if (!notes.length) return;
    target.innerHTML = `
      <div class="release-callout release-callout-warning" style="margin-top:8px">
        ${notes.map((n) => `<p style="margin:0">${U().esc(n)}</p>`).join("")}
      </div>`;
  }

  function findActivityPanel(pane, ruleId) {
    const panels = pane.querySelectorAll("[data-activity-panel-for]");
    for (let i = 0; i < panels.length; i++) {
      if (panels[i].getAttribute("data-activity-panel-for") === ruleId) return panels[i];
    }
    return null;
  }

  async function toggleActivityPanel(pane, state, rule) {
    const wasExpanded = state.expandedActivityRuleId === rule.id;
    state.expandedActivityRuleId = wasExpanded ? null : rule.id;
    renderRuleList(pane, state);
    if (!wasExpanded) await loadActivity(pane, state, rule);
  }

  async function loadActivity(pane, state, rule) {
    const bucket = state.activityByRule[rule.id] || (state.activityByRule[rule.id] = { enrollments: [], jobsByEnrollment: {}, failures: [], stops: null, token: 0, loading: false, error: null });
    if (bucket.loading) return;
    const myToken = ++bucket.token;
    bucket.loading = true;
    bucket.error = null;
    const panel = findActivityPanel(pane, rule.id);
    if (panel) panel.innerHTML = App.app.loadingHtml ? App.app.loadingHtml("activity") : "";
    try {
      const [enrollments, failures, stops] = await Promise.all([
        S().automationRuntime.listEnrollments(rule.id, { limit: 20 }),
        S().automationRuntime.listFailures(rule.id, { limit: 20 }),
        // Read-only, and non-essential: if the stop summary can't be
        // loaded the rest of the activity view must still render.
        S().automationRuntime.stopSummary(rule.id, { limit: 20 }).catch(() => null)
      ]);
      if (myToken !== bucket.token) return;
      const jobsByEnrollment = {};
      for (const enrollment of enrollments.slice(0, 8)) {
        try {
          jobsByEnrollment[enrollment.id] = await S().automationRuntime.listJobs(enrollment.id, { limit: 5 });
        } catch (e) {
          jobsByEnrollment[enrollment.id] = null;
        }
      }
      if (myToken !== bucket.token) return;
      bucket.enrollments = enrollments;
      bucket.failures = failures;
      bucket.stops = stops;
      bucket.jobsByEnrollment = jobsByEnrollment;
      bucket.loading = false;
      renderActivityPanel(pane, state, rule, bucket);
    } catch (err) {
      if (myToken !== bucket.token) return;
      bucket.loading = false;
      bucket.error = (err && err.message) ? err.message : "Unknown error";
      renderActivityPanel(pane, state, rule, bucket);
    }
  }

  function renderActivityPanel(pane, state, rule, bucket) {
    const panel = findActivityPanel(pane, rule.id);
    if (!panel) return;

    if (bucket.error) {
      panel.innerHTML = `
        <div class="empty-state" role="alert">
          <div class="empty-title">Could not load activity</div>
          <div class="empty-desc">${U().esc(bucket.error)}</div>
          <button type="button" class="btn btn-primary" data-activity-retry>Retry</button>
        </div>`;
      const retryBtn = panel.querySelector("[data-activity-retry]");
      if (retryBtn) retryBtn.addEventListener("click", () => loadActivity(pane, state, rule));
      return;
    }

    const contactsById = {};
    (App.store.getState().contacts || []).forEach((c) => { contactsById[c.id] = c; });

    // ---- Phase 4E: per-rule stop counts + recent cancellations ----
    const stops = bucket.stops;
    const stopCounts = (stops && stops.stoppedCounts) ? stops.stoppedCounts : {};
    const stopCountKeys = Object.keys(stopCounts).filter((k) => Number(stopCounts[k]) > 0);
    const stopCountsHtml = stopCountKeys.length ? `
      <div style="margin-bottom:12px">
        <strong>Stopped follow-ups</strong>
        <div class="settings-status-grid" style="margin-top:6px">
          ${stopCountKeys.map((reason) => `
            <div class="settings-status-card">
              <div class="k">${U().esc(stopReasonLabel(reason))}</div>
              <div class="v">${U().esc(stopCounts[reason])}</div>
            </div>`).join("")}
        </div>
      </div>` : "";

    const cancelledJobs = (stops && stops.cancelledJobs) ? stops.cancelledJobs : [];
    const cancelledHtml = cancelledJobs.length ? `
      <div style="margin-bottom:12px">
        <strong>Cancelled steps</strong>
        <p class="form-help" style="margin:2px 0 6px">These steps were deliberately cancelled because the automation stopped for that contact. They are not failures and need no action.</p>
        ${cancelledJobs.map((j) => `
          <div class="form-help">
            ${U().esc(stepTypeLabel(j.job_type))}
            &middot; <span class="badge badge-neutral">${U().esc(stopReasonLabel(j.cancelled_reason))}</span>
            &middot; ${U().esc(formatDateTime(j.cancelled_at))}
          </div>`).join("")}
      </div>` : "";

    const skippedJobs = (stops && stops.skippedJobs) ? stops.skippedJobs : [];
    const skippedHtml = skippedJobs.length ? `
      <div style="margin-bottom:12px">
        <strong>Skipped emails</strong>
        <p class="form-help" style="margin:2px 0 6px">No email was sent for these steps. The rest of the automation carried on for that contact.</p>
        ${skippedJobs.map((j) => {
          const c = contactsById[j.contact_id];
          return `
          <div class="form-help">
            ${U().esc(c ? (c.name || "Unnamed contact") : "Contact")}
            &middot; <span class="badge badge-neutral">${U().esc(safeLookup(SKIP_REASON_META, j.skipped_reason) || "Email skipped")}</span>
            ${j.completed_at ? "&middot; " + U().esc(formatDateTime(j.completed_at)) : ""}
          </div>`;
        }).join("")}
      </div>` : "";

    const failuresHtml = bucket.failures.length ? `
      <div style="margin-bottom:12px">
        <strong>Unresolved failures</strong>
        ${bucket.failures.map((f) => `
          <div class="release-maintenance" style="align-items:center">
            <div style="flex:1;min-width:0">
              <div>${U().esc(f.category)} &middot; ${U().esc(f.error_code || "—")}</div>
              <div class="form-help">${U().esc(f.error_message || "")} &middot; ${U().esc(formatDateTime(f.created_at))}</div>
            </div>
            ${f.retriable ? `<button type="button" class="btn btn-sm" data-retry-job="${U().esc(f.job_id)}">Retry</button>` : '<span class="form-help">Not retriable</span>'}
          </div>
        `).join("")}
      </div>` : "";

    if (!bucket.enrollments.length) {
      panel.innerHTML = `${stopCountsHtml}${cancelledHtml}${skippedHtml}${failuresHtml}<p class="form-help">No contacts in this automation yet.</p>`;
    } else {
      panel.innerHTML = `
        ${stopCountsHtml}
        ${cancelledHtml}
        ${skippedHtml}
        ${failuresHtml}
        <strong>Recent contacts</strong>
        ${bucket.enrollments.map((e) => {
          const contact = contactsById[e.contact_id];
          const contactLabel = contact ? U().esc(contact.name || "Unnamed contact") : U().esc(e.contact_id);
          const meta = safeLookup(ENROLLMENT_STATUS_META, e.status);
          const jobs = bucket.jobsByEnrollment[e.id];
          return `
            <div class="release-maintenance" style="flex-direction:column;align-items:stretch;gap:6px">
              <div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap">
                <div>
                  <strong>${contactLabel}</strong>
                  <div class="form-help">Step ${U().esc(e.current_step_order)} &middot; Started ${U().esc(formatDateTime(e.started_at))}</div>
                </div>
                <span class="badge ${meta ? meta.cls : "badge-neutral"}"><span class="dot"></span>${U().esc(meta ? meta.label : e.status)}</span>
              </div>
              <div class="form-help">
                ${e.status === "active" || e.status === "paused" ? "Next action: " + U().esc(formatDateTime(e.next_action_at)) : ""}
                ${e.status === "completed" ? "Completed: " + U().esc(formatDateTime(e.completed_at)) : ""}
                ${e.status === "stopped" ? U().esc(stoppedSentence(e)) : ""}
                ${e.status === "failed" ? "Failed: " + U().esc(formatDateTime(e.stopped_at)) + (e.stop_reason ? " (" + U().esc(e.stop_reason) + ")" : "") + " — see the failure below, or use Retry on the eligible job." : ""}
              </div>
              ${jobs === null ? '<p class="form-help">Could not load recent steps.</p>' : (jobs && jobs.length ? `
                <div style="display:flex;flex-direction:column;gap:4px">
                  ${jobs.map((j) => {
                    const jm = safeLookup(JOB_STATUS_META, j.status);
                    // A cancelled step reads as a deliberate stop, never
                    // as a failure: its reason replaces the error text.
                    const cancelled = j.status === "cancelled";
                    const skipped = j.status === "completed" && j.skipped_reason;
                    const detail = cancelled
                      ? (j.cancelled_reason ? " &middot; " + U().esc(stopReasonLabel(j.cancelled_reason)) : "")
                        + (j.cancelled_at ? " &middot; " + U().esc(formatDateTime(j.cancelled_at)) : "")
                      : skipped
                        ? " &middot; " + U().esc(safeLookup(SKIP_REASON_META, j.skipped_reason) || "Email skipped")
                        : (j.last_error ? " &middot; " + U().esc(j.last_error) : "");
                    const label = skipped ? "Skipped" : (jm ? jm.label : j.status);
                    return `<div class="form-help">${U().esc(stepTypeLabel(j.job_type))}: <span class="badge ${jm ? jm.cls : "badge-neutral"}">${U().esc(label)}</span> &middot; attempt ${U().esc(j.attempts)}/${U().esc(j.max_attempts)}${detail}</div>`;
                  }).join("")}
                </div>` : '<p class="form-help">No steps yet.</p>')}
            </div>`;
        }).join("")}
      `;
    }

    panel.querySelectorAll("[data-retry-job]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (btn.disabled) return;
        btn.disabled = true;
        try {
          await S().automationRuntime.retryJob(btn.getAttribute("data-retry-job"));
          App.app.toast("Step will be tried again.", "success");
          await loadActivity(pane, state, rule);
        } catch (err) {
          const code = err && err.code;
          App.app.toast(code === "job_not_eligible" ? "This step can no longer be tried again." : "That couldn't be retried. Please try again.", "danger");
          btn.disabled = false;
        }
      });
    });
  }

  /* ============================================================
   * STEPS (per rule, lazy-loaded, accordion-style)
   * ========================================================== */

  function findStepPanel(pane, ruleId) {
    const panels = pane.querySelectorAll("[data-step-panel-for]");
    for (let i = 0; i < panels.length; i++) {
      if (panels[i].getAttribute("data-step-panel-for") === ruleId) return panels[i];
    }
    return null;
  }

  async function toggleStepsPanel(pane, state, rule) {
    const wasExpanded = state.expandedRuleId === rule.id;
    state.expandedRuleId = wasExpanded ? null : rule.id;
    renderRuleList(pane, state);
    if (!wasExpanded) await loadSteps(pane, state, rule);
  }

  async function loadSteps(pane, state, rule) {
    const bucket = state.stepsByRule[rule.id] || (state.stepsByRule[rule.id] = { steps: [], token: 0, loading: false });
    if (bucket.loading) return;
    const myToken = ++bucket.token;
    bucket.loading = true;
    const panel = findStepPanel(pane, rule.id);
    if (panel) panel.innerHTML = App.app.loadingHtml ? App.app.loadingHtml("steps") : "";
    try {
      const steps = await S().automationSteps.list(rule.id);
      if (myToken !== bucket.token) return; // superseded
      bucket.steps = steps;
      bucket.loading = false;
      renderStepsPanel(pane, state, rule, steps);
    } catch (err) {
      if (myToken !== bucket.token) return;
      bucket.loading = false;
      const p = findStepPanel(pane, rule.id);
      if (p) p.innerHTML = `<div class="empty-state" role="alert"><div class="empty-title">Could not load steps</div><div class="empty-desc">${U().esc((err && err.message) || "Unknown error")}</div></div>`;
    }
  }

  function renderStepsPanel(pane, state, rule, steps) {
    const panel = findStepPanel(pane, rule.id);
    if (!panel) return;
    const isDraft = rule.status === "draft";
    const sorted = steps.slice().sort((a, b) => a.step_order - b.step_order);
    panel.innerHTML = `
      <p class="form-help">Steps run in the order shown, using each step's own delay. Reordering isn't available yet — delete and re-add steps in the order you want.</p>
      ${sorted.length ? sorted.map(step => renderStepRow(state, step, isDraft)).join("") : '<p class="form-help">No steps yet.</p>'}
      ${isDraft ? `<button type="button" class="btn btn-sm" data-add-step style="margin-top:8px">Add Step</button>` : ""}
    `;
    if (isDraft) {
      const addBtn = panel.querySelector("[data-add-step]");
      if (addBtn) addBtn.addEventListener("click", () => openStepModal(pane, state, rule, null, sorted));
      panel.querySelectorAll("[data-edit-step]").forEach(btn => {
        const step = sorted.find(s => s.id === btn.getAttribute("data-edit-step"));
        if (step) btn.addEventListener("click", () => openStepModal(pane, state, rule, step, sorted));
      });
      panel.querySelectorAll("[data-delete-step]").forEach(btn => {
        const step = sorted.find(s => s.id === btn.getAttribute("data-delete-step"));
        if (step) btn.addEventListener("click", () => confirmDeleteStep(pane, state, rule, step));
      });
    }
  }

  function renderStepRow(state, step, isDraft) {
    const templateName = step.template_id ? ((state.templates.find(t => t.id === step.template_id) || {}).name || "Unknown template") : null;
    const actionLabel = safeLookup(ACTION_LABELS, step.action_type) || "Unknown";
    let detail = "";
    if (step.action_type === "send_email") {
      detail = "Template: " + U().esc(templateName || "—") + (step.subject_override ? " · Subject override: " + U().esc(step.subject_override) : "");
    } else if (step.action_type === "create_task") {
      const title = (step.config && step.config.title) || "—";
      const priority = (step.config && step.config.priority) || "Medium";
      detail = "Task: " + U().esc(title) + " · Priority: " + U().esc(priority);
    } else {
      detail = "No template or task needed.";
    }
    // Non-draft rules are read-only end to end: Edit/Delete are omitted
    // entirely here (not just left unwired), so there is never a visible
    // but non-functional control for a step whose owning rule isn't draft.
    const actions = isDraft
      ? `<span style="display:inline-flex;gap:6px;flex-wrap:wrap">
          <button type="button" class="btn btn-sm" data-edit-step="${U().esc(step.id)}">Edit</button>
          <button type="button" class="btn btn-sm btn-danger" data-delete-step="${U().esc(step.id)}">Delete</button>
        </span>`
      : "";
    return `
      <div class="release-maintenance" style="align-items:center" data-step-row="${U().esc(step.id)}">
        <div style="flex:1;min-width:0">
          <strong>#${U().esc(step.step_order)} — ${U().esc(actionLabel)}</strong>
          <div class="form-help">${detail} · ${step.delay_minutes ? "Delay: " + U().esc(step.delay_minutes) + " min" : "No delay"}</div>
        </div>
        ${actions}
      </div>`;
  }

  function confirmDeleteStep(pane, state, rule, step) {
    App.app.confirmDialog({
      title: "Delete step?",
      message: `Delete step #${U().esc(step.step_order)} (${U().esc(safeLookup(ACTION_LABELS, step.action_type) || "Unknown")})? This cannot be undone.`,
      okLabel: "Delete",
      danger: true
    }, async () => {
      try {
        await S().automationSteps.delete(step.id);
        App.app.toast("Step deleted.", "success");
        await loadSteps(pane, state, rule);
      } catch (err) {
        App.app.toast("Could not delete: " + ((err && err.message) || "Unknown error"), "danger");
      }
    });
  }

  function nextStepOrder(existingSteps) {
    if (!existingSteps || !existingSteps.length) return 1;
    return Math.max.apply(null, existingSteps.map(s => s.step_order)) + 1;
  }

  /* ============================================================
   * TRIGGER SETTINGS (Phase 2A)
   *
   * Two helpers used by the rule form and by the read-only view of a
   * non-draft rule: one reads the form into the shape the data layer
   * expects, the other turns that shape into a sentence.
   * ========================================================== */

  // Only ever returns the keys the chosen trigger actually accepts, so
  // switching the trigger in the form cannot carry the previous one's
  // settings through to the save.
  function collectTriggerConfig_(m, triggerType) {
    if (TRIGGER_CONFIG_TYPES.indexOf(triggerType) === -1) return {};

    // The yearly pair carry only these two, matching the database
    // validator, which drops anything else for them.
    if (YEARLY_TRIGGER_TYPES.indexOf(triggerType) >= 0) {
      const beforeEl = m.querySelector(
        triggerType === "birthday" ? "#autoCfgDaysBeforeBd" : "#autoCfgDaysBeforeHa");
      const hourElY = m.querySelector("#autoCfgHour");
      return {
        days_before: beforeEl ? Number(beforeEl.value) : 0,
        fire_hour: hourElY ? Number(hourElY.value) : 9
      };
    }

    const includeEl = m.querySelector("#autoCfgIncludeExisting");
    const out = { include_existing: !!(includeEl && includeEl.checked) };

    if (triggerType === "deal_stage_changed") {
      const stage = (m.querySelector("#autoCfgToStage") || {}).value || "";
      const side = (m.querySelector("#autoCfgSide") || {}).value || "";
      if (stage) out.to_stage = stage;
      if (side) out.side = side;
      return out;
    }

    const hourEl = m.querySelector("#autoCfgHour");
    out.fire_hour = hourEl ? Number(hourEl.value) : 8;

    if (triggerType === "no_contact" || triggerType === "status_stale") {
      const daysEl = m.querySelector(triggerType === "no_contact" ? "#autoCfgDaysNoContact" : "#autoCfgDaysStale");
      out.days = daysEl ? Number(daysEl.value) : NaN;
    }
    if (triggerType === "status_stale") {
      const picked = Array.from(m.querySelectorAll(".auto-cfg-status:checked")).map((c) => c.value);
      // All unticked means "any status", which is the absence of the key
      // rather than an empty list — the validator rejects an empty list.
      if (picked.length) out.statuses = picked.slice().sort();
    }
    return out;
  }

  function hourText_(hr) {
    const h = Number.isInteger(hr) ? hr : 8;
    const suffix = h < 12 ? "AM" : "PM";
    const twelve = h % 12 === 0 ? 12 : h % 12;
    return twelve + ":00 " + suffix;
  }

  // One plain sentence describing when the sequence starts. No jargon: the
  // person reading this is an estate agent, not the person who wrote the
  // worker.
  function triggerSummaryText_(triggerType, config, timezone, audience) {
    const cfg = config || {};
    const tz = timezone || "UTC";
    const daily = " checked daily at " + hourText_(cfg.fire_hour) + " (" + tz + ").";
    let sentence;
    if (triggerType === "follow_up_due") {
      sentence = "Starts when a contact's follow-up date arrives," + daily;
    } else if (triggerType === "no_contact") {
      const d = Number.isInteger(cfg.days) ? cfg.days : null;
      sentence = d
        ? "Starts when a contact hasn't been contacted for " + d + (d === 1 ? " day," : " days,") + daily
        : "Enter how many days of silence should start this sequence.";
    } else if (triggerType === "status_stale") {
      const d = Number.isInteger(cfg.days) ? cfg.days : null;
      if (!d) {
        sentence = "Enter how many days in the same status should start this sequence.";
      } else {
        const which = Array.isArray(cfg.statuses) && cfg.statuses.length
          ? " in " + cfg.statuses.join(" or ")
          : "";
        sentence = "Starts when a contact has stayed" + which + " for " + d + (d === 1 ? " day," : " days,") + daily;
      }
    } else if (triggerType === "birthday" || triggerType === "home_anniversary") {
      const before = Number.isInteger(cfg.days_before) ? cfg.days_before : 0;
      const what = triggerType === "birthday"
        ? "a contact's birthday"
        : "the anniversary of a contact buying their home";
      const when = before === 0
        ? "on the day"
        : (before === 1 ? "1 day before" : before + " days before");
      sentence = "Sends " + when + " " + what + ", at " + hourText_(cfg.fire_hour) + " (" + tz + ")."
        + (triggerType === "home_anniversary" ? " The purchase year itself is skipped." : "");
    } else if (triggerType === "deal_stage_changed") {
      const stage = cfg.to_stage ? "to " + cfg.to_stage : "to any stage";
      const side = cfg.side ? " on a " + cfg.side.toLowerCase() + " deal" : "";
      sentence = "Starts when a deal linked to a contact moves " + stage + side + ".";
    } else if (triggerType === "manual") {
      sentence = "Starts only when you add someone to it yourself.";
    } else if (triggerType === "new_lead") {
      sentence = "Starts when a new contact is added with the status New Lead.";
    } else if (triggerType === "contact_created") {
      sentence = "Starts when a contact is added.";
    } else if (triggerType === "contact_status_changed") {
      sentence = "Starts when a contact's status changes to the status you picked.";
    } else {
      sentence = "";
    }
    if (cfg.include_existing === true && TRIGGER_CONFIG_TYPES.indexOf(triggerType) >= 0) {
      sentence += " Contacts who already match will be included, up to your daily limit.";
    }
    if (audience && Array.isArray(audience.tags_any) && audience.tags_any.length) {
      sentence += " Only contacts tagged " + audience.tags_any.join(" or ") + ".";
    }
    // Phase 2F. Said separately, because they narrow separately: "Only
    // Buyers. Only contacts marked Cold." is two conditions, and reading
    // it as one list would suggest either would do.
    if (audience && Array.isArray(audience.type_in) && audience.type_in.length) {
      sentence += " Only " + audience.type_in.join(" or ") + " contacts.";
    }
    if (audience && Array.isArray(audience.temperature_in) && audience.temperature_in.length) {
      sentence += " Only contacts marked " + audience.temperature_in.join(" or ") + ".";
    }
    return sentence;
  }

  // The three audience lists as the form currently has them. An empty
  // list is left out entirely: "none ticked" is no filter, never "match
  // nobody", and the database stores it the same way.
  function readAudienceLists_(m) {
    const out = {};
    [["tags_any", ".auto-cfg-tag"], ["type_in", ".auto-cfg-type"],
     ["temperature_in", ".auto-cfg-temp"]].forEach((pair) => {
      const picked = Array.from(m.querySelectorAll(pair[1] + ":checked")).map((c) => c.value);
      if (picked.length) out[pair[0]] = picked;
    });
    return out;
  }

  /* ============================================================
   * RULE FORM (create/edit — always draft; status is never editable here)
   * ========================================================== */

  function openRuleModal(pane, state, existing) {
    const isEdit = !!existing;
    const stopReplyChecked = existing ? existing.stop_on_reply !== false : true;
    const stopUnsubChecked = existing ? existing.stop_on_unsubscribe !== false : true;
    const dailyLimitValue = existing ? existing.daily_enrollment_limit : 100;
    const existingStatusEquals = (existing && existing.audience_filter && typeof existing.audience_filter.status_equals === "string")
      ? existing.audience_filter.status_equals : "";
    // Phase 2A. The trigger's own settings, with the same defaults the
    // database applies, so a brand-new draft and a saved one look the same.
    const cfg = (existing && existing.trigger_config && typeof existing.trigger_config === "object")
      ? existing.trigger_config : {};
    const cfgDays = Number.isInteger(cfg.days) ? cfg.days : 30;
    const cfgHour = Number.isInteger(cfg.fire_hour) ? cfg.fire_hour : 8;
    const cfgStatuses = Array.isArray(cfg.statuses) ? cfg.statuses : [];
    const cfgToStage = typeof cfg.to_stage === "string" ? cfg.to_stage : "";
    const cfgSide = typeof cfg.side === "string" ? cfg.side : "";
    const cfgIncludeExisting = cfg.include_existing === true;
    const cfgDaysBefore = Number.isInteger(cfg.days_before) ? cfg.days_before : 0;
    // Phase 2E, widened in 2F. The values actually in use, so the agent
    // picks from what exists rather than retyping one and wondering why
    // nothing matches. A value the rule already targets is offered even if
    // no contact carries it now, so editing a rule never silently drops
    // its audience.
    const contactsNow = (S().getState() && S().getState().contacts) || [];
    const audienceList = (key) => (existing && existing.audience_filter
      && Array.isArray(existing.audience_filter[key]))
      ? existing.audience_filter[key].slice() : [];
    // Seeded first so the standard spellings lead, then whatever the
    // workspace's own contacts say, then anything only this rule knows
    // about. De-duplicated without regard to case, like the matcher.
    const offer = (seed, fromContacts, selected) => {
      const seen = Object.create(null);
      const out = [];
      seed.concat(fromContacts).concat(selected).forEach((raw) => {
        const value = String(raw == null ? "" : raw).trim();
        if (!value) return;
        const key = value.toLowerCase();
        if (seen[key]) return;
        seen[key] = true;
        out.push(value);
      });
      return out;
    };
    const cfgTags = audienceList("tags_any");
    const cfgTypes = audienceList("type_in");
    const cfgTemps = audienceList("temperature_in");
    const tagsInUse = [];
    contactsNow.forEach((c) => {
      (Array.isArray(c.tags) ? c.tags : []).forEach((t) => tagsInUse.push(t));
    });
    tagsInUse.sort((a, b) => String(a).localeCompare(String(b)));
    const knownTags = offer([], tagsInUse, cfgTags);
    const knownTypes = offer(CONTACT_TYPE_OPTIONS, contactsNow.map((c) => c.role), cfgTypes);
    const knownTemps = offer(TEMPERATURE_OPTIONS, contactsNow.map((c) => c.temperature), cfgTemps);
    // One shape for all three lists: ticked boxes, like the status list
    // above, because an agent picking two of four values should be able to
    // see all four without opening anything.
    const ticked = (selected, value) =>
      selected.some((v) => String(v).toLowerCase() === value.toLowerCase());
    const pickList = (cls, values, selected) => values.map((v) =>
      '<label style="display:flex;align-items:center;gap:6px;font-weight:400"'
      + '><input type="checkbox" class="' + cls + '" value="' + U().esc(v) + '" '
      + (ticked(selected, v) ? "checked" : "") + ">" + U().esc(v) + "</label>").join("");
    // The workspace's own pipeline, so the stage list matches the board the
    // agent actually sees. Falls back to whatever stages the existing deals
    // use if settings have not loaded.
    const settings = (S().getState() && S().getState().settings) || {};
    const stageNames = (Array.isArray(settings.pipelineStages) ? settings.pipelineStages : [])
      .map((st) => (st && typeof st === "object") ? st.name : st)
      .filter((n) => typeof n === "string" && n.trim());
    const hourOptions = Array.from({ length: 24 }, (_, i) => i);
    const hourLabel = (hr) => {
      const suffix = hr < 12 ? "AM" : "PM";
      const twelve = hr % 12 === 0 ? 12 : hr % 12;
      return twelve + ":00 " + suffix;
    };

    const h = App.app.openModal({
      title: isEdit ? "Edit Draft Sequence" : "Create Draft Sequence",
      wide: true,
      body: `
        <div class="release-callout release-callout-warning" style="margin-bottom:12px">
          <strong>${isEdit ? "This sequence stays a draft." : "New sequences are always saved as drafts."}</strong>
          <p style="margin:6px 0 0">Saving here never sends an email or enrolls a contact — a sequence only starts running after you activate it.</p>
        </div>
        <div class="form-grid">
          <label class="field full"><span>Sequence name</span><input id="autoName" maxlength="100" value="${U().esc(existing ? existing.name : "")}" required></label>
          <label class="field"><span>Trigger</span><select id="autoTrigger">
            ${Object.keys(TRIGGER_LABELS).map(k => `<option value="${U().esc(k)}" ${existing && existing.trigger_type === k ? "selected" : ""}>${U().esc(TRIGGER_LABELS[k])}</option>`).join("")}
          </select></label>
          <label class="field"><span>Timezone</span><input id="autoTimezone" value="${U().esc(existing ? existing.timezone : "UTC")}" placeholder="e.g. America/New_York or UTC" required></label>
          <label class="field"><span>Daily enrollment limit</span><input id="autoLimit" type="number" min="1" max="10000" value="${U().esc(dailyLimitValue)}"></label>
          <div data-audience-group="contact_status_changed" class="full" style="display:none">
            <label class="field"><span>New status equals</span><select id="autoStatusEquals">
              <option value="">Select a status…</option>
              ${CONTACT_STATUS_OPTIONS.map(s => `<option value="${U().esc(s)}" ${existingStatusEquals === s ? "selected" : ""}>${U().esc(s)}</option>`).join("")}
            </select></label>
            <p class="form-help">This sequence only matches when a contact's status changes to exactly this value.</p>
          </div>
          <div data-audience-group="no_contact" class="full" style="display:none">
            <label class="field"><span>Days without contact</span><input id="autoCfgDaysNoContact" type="number" min="1" max="365" value="${U().esc(cfgDays)}"></label>
            <p class="form-help">Counts from the last contact date on the contact, or from when it was added if there is none.</p>
          </div>
          <div data-audience-group="status_stale" class="full" style="display:none">
            <label class="field"><span>Days in the same status</span><input id="autoCfgDaysStale" type="number" min="1" max="365" value="${U().esc(cfgDays)}"></label>
            <fieldset class="field" style="border:0;padding:0;margin:0">
              <legend style="font:inherit;padding:0">Only these statuses (optional)</legend>
              <div id="autoCfgStatuses" style="display:flex;flex-wrap:wrap;gap:10px">
                ${CONTACT_STATUS_OPTIONS.map(st => `<label style="display:flex;align-items:center;gap:6px;font-weight:400"><input type="checkbox" class="auto-cfg-status" value="${U().esc(st)}" ${cfgStatuses.indexOf(st) >= 0 ? "checked" : ""}>${U().esc(st)}</label>`).join("")}
              </div>
              <p class="form-help">Leave all unticked to watch every status.</p>
            </fieldset>
          </div>
          <div data-audience-group="deal_stage_changed" class="full" style="display:none">
            <label class="field"><span>Deal stage</span><select id="autoCfgToStage">
              <option value="">Any stage</option>
              ${stageNames.map(st => `<option value="${U().esc(st)}" ${cfgToStage === st ? "selected" : ""}>${U().esc(st)}</option>`).join("")}
              ${(cfgToStage && stageNames.indexOf(cfgToStage) === -1) ? `<option value="${U().esc(cfgToStage)}" selected>${U().esc(cfgToStage)}</option>` : ""}
            </select></label>
            <label class="field"><span>Deal side</span><select id="autoCfgSide">
              <option value="">Buyer or seller</option>
              ${DEAL_SIDES.map(sd => `<option value="${U().esc(sd)}" ${cfgSide === sd ? "selected" : ""}>${U().esc(sd)}</option>`).join("")}
            </select></label>
            <p class="form-help">Starts when a deal linked to a contact moves to this stage. A deal with no contact attached starts nothing.</p>
          </div>
          <div data-audience-group="birthday" class="full" style="display:none">
            <label class="field"><span>Send how many days before?</span><input id="autoCfgDaysBeforeBd" type="number" min="0" max="30" value="${U().esc(cfgDaysBefore)}"></label>
            <p class="form-help">0 sends on the day itself. Needs a birthday on the contact; only the day and month are used.</p>
          </div>
          <div data-audience-group="home_anniversary" class="full" style="display:none">
            <label class="field"><span>Send how many days before?</span><input id="autoCfgDaysBeforeHa" type="number" min="0" max="30" value="${U().esc(cfgDaysBefore)}"></label>
            <p class="form-help">0 sends on the day itself. Starts from the first anniversary, never the purchase year.</p>
          </div>
          <div data-trigger-hour-group class="full" style="display:none">
            <label class="field"><span id="autoCfgHourLabel">Check each day at</span><select id="autoCfgHour" aria-labelledby="autoCfgHourLabel">
              ${hourOptions.map(hr => `<option value="${hr}" ${cfgHour === hr ? "selected" : ""}>${U().esc(hourLabel(hr))}</option>`).join("")}
            </select></label>
          </div>
          <div data-trigger-config-group class="full" style="display:none">
            <label class="field" style="flex-direction:row;align-items:flex-start;gap:10px">
              <input type="checkbox" id="autoCfgIncludeExisting" ${cfgIncludeExisting ? "checked" : ""} style="margin-top:4px">
              <span style="font-weight:400">Also include contacts who already match today</span>
            </label>
            <p class="form-help"><strong>Careful.</strong> Normally this sequence only starts for someone who newly matches after you turn it on. Tick this and everyone who already matches can be added at once — your daily limit above is what caps how many per day.</p>
          </div>
          <fieldset class="field full" style="border:0;padding:0;margin:0">
            <legend style="font:inherit;padding:0">Only contacts tagged (optional)</legend>
            <div id="autoCfgTags" style="display:flex;flex-wrap:wrap;gap:10px">
              ${knownTags.length
                ? pickList("auto-cfg-tag", knownTags, cfgTags)
                : `<p class="form-help" style="margin:0">No tags on your contacts yet. Add tags to a contact and they will appear here.</p>`}
            </div>
            <p class="form-help">Leave all unticked to include everybody this sequence can reach. Tags are matched whatever the capitalisation.</p>
          </fieldset>
          <fieldset class="field full" style="border:0;padding:0;margin:0">
            <legend style="font:inherit;padding:0">Only these contact types (optional)</legend>
            <div id="autoCfgTypes" style="display:flex;flex-wrap:wrap;gap:10px">
              ${pickList("auto-cfg-type", knownTypes, cfgTypes)}
            </div>
            <p class="form-help">The type on the contact itself — the one you pick on the Add Contact form. Leave all unticked for every type.</p>
          </fieldset>
          <fieldset class="field full" style="border:0;padding:0;margin:0">
            <legend style="font:inherit;padding:0">Only these temperatures (optional)</legend>
            <div id="autoCfgTemps" style="display:flex;flex-wrap:wrap;gap:10px">
              ${pickList("auto-cfg-temp", knownTemps, cfgTemps)}
            </div>
            <p class="form-help">Leave all unticked for every temperature.</p>
          </fieldset>
          <p class="form-help full" id="autoTriggerSummary" aria-live="polite"></p>
          <label class="field" style="flex-direction:row;align-items:center;gap:10px">
            <span>Stop on reply</span>
            <span class="toggle-switch"><input type="checkbox" id="autoStopReply" ${stopReplyChecked ? "checked" : ""}><span class="toggle-track"></span></span>
          </label>
          <label class="field" style="flex-direction:row;align-items:center;gap:10px">
            <span>Stop on unsubscribe</span>
            <span class="toggle-switch"><input type="checkbox" id="autoStopUnsub" ${stopUnsubChecked ? "checked" : ""}><span class="toggle-track"></span></span>
          </label>
        </div>
      `,
      footer: `<button class="btn" data-role="cancel">Cancel</button><button class="btn btn-primary" data-role="save">${isEdit ? "Save Changes" : "Create Draft"}</button>`,
      onOpen: (m) => {
        m.querySelector('[data-role="cancel"]').onclick = () => h.close();
        const triggerSelect = m.querySelector("#autoTrigger");
        const timezoneInput = m.querySelector("#autoTimezone");
        const readConfigFromForm = () => collectTriggerConfig_(m, triggerSelect.value);
        const syncAudienceGroup = () => {
          const t = triggerSelect.value;
          m.querySelectorAll("[data-audience-group]").forEach((g) => {
            g.style.display = g.getAttribute("data-audience-group") === t ? "flex" : "none";
          });
          // The daily hour applies to the three date-based triggers; the
          // deal trigger reacts to a real change and has no schedule.
          const yearly = YEARLY_TRIGGER_TYPES.indexOf(t) >= 0;
          const hourGroup = m.querySelector("[data-trigger-hour-group]");
          if (hourGroup) {
            hourGroup.style.display =
              (t === "follow_up_due" || t === "no_contact" || t === "status_stale" || yearly) ? "flex" : "none";
          }
          const hourLabel = m.querySelector("#autoCfgHourLabel");
          if (hourLabel) {
            // A greeting is sent, a chase is checked for. Same field, and
            // the word that makes it obvious which one this is.
            hourLabel.textContent = yearly ? "Send at" : "Check each day at";
          }
          const cfgGroup = m.querySelector("[data-trigger-config-group]");
          if (cfgGroup) {
            // The "include people who already match" choice is meaningless
            // for a yearly date, so it is hidden rather than offered and
            // then ignored.
            cfgGroup.style.display =
              (TRIGGER_CONFIG_TYPES.indexOf(t) >= 0 && !yearly) ? "flex" : "none";
          }
          const summary = m.querySelector("#autoTriggerSummary");
          if (summary) {
            // Plain text, set as text rather than markup: it is built from
            // values the user typed.
            summary.textContent = triggerSummaryText_(t, readConfigFromForm(),
              timezoneInput.value.trim(), readAudienceLists_(m));
          }
        };
        triggerSelect.addEventListener("change", syncAudienceGroup);
        // Every field that feeds the sentence keeps it up to date.
        m.querySelectorAll("#autoCfgDaysNoContact, #autoCfgDaysStale, #autoCfgDaysBeforeBd, #autoCfgDaysBeforeHa, #autoCfgHour, #autoCfgToStage, #autoCfgSide, #autoCfgIncludeExisting, #autoTimezone, .auto-cfg-status, .auto-cfg-tag, .auto-cfg-type, .auto-cfg-temp")
          .forEach((el) => {
            el.addEventListener("change", syncAudienceGroup);
            el.addEventListener("input", syncAudienceGroup);
          });
        syncAudienceGroup();

        const saveBtn = m.querySelector('[data-role="save"]');
        saveBtn.onclick = async () => {
          if (saveBtn.disabled) return;
          const name = m.querySelector("#autoName").value.trim();
          const triggerType = m.querySelector("#autoTrigger").value;
          const timezone = m.querySelector("#autoTimezone").value.trim();
          const dailyLimit = Number(m.querySelector("#autoLimit").value);
          const stopOnReply = m.querySelector("#autoStopReply").checked;
          const stopOnUnsubscribe = m.querySelector("#autoStopUnsub").checked;

          if (!name || name.length > 100) { App.app.toast("Sequence name must be 1-100 characters.", "danger"); return; }
          if (!timezone) { App.app.toast("Timezone is required.", "danger"); return; }
          if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 10000) { App.app.toast("Daily limit must be an integer between 1 and 10,000.", "danger"); return; }

          let audienceFilter = {};
          if (triggerType === "contact_status_changed") {
            const statusEquals = m.querySelector("#autoStatusEquals").value;
            if (CONTACT_STATUS_OPTIONS.indexOf(statusEquals) === -1) { App.app.toast("Select the status this sequence should match.", "danger"); return; }
            audienceFilter.status_equals = statusEquals;
          }
          // Phase 2E/2F: the tag, type and temperature audiences, for
          // every trigger type. Nothing ticked in a list means no filter on
          // it rather than an empty list.
          Object.assign(audienceFilter, readAudienceLists_(m));

          const triggerConfig = collectTriggerConfig_(m, triggerType);
          if (triggerType === "no_contact" || triggerType === "status_stale") {
            if (!Number.isInteger(triggerConfig.days) || triggerConfig.days < 1 || triggerConfig.days > 365) {
              App.app.toast("Days must be a whole number between 1 and 365.", "danger"); return;
            }
          }
          if (YEARLY_TRIGGER_TYPES.indexOf(triggerType) >= 0) {
            if (!Number.isInteger(triggerConfig.days_before)
                || triggerConfig.days_before < 0 || triggerConfig.days_before > 30) {
              App.app.toast("Days before must be a whole number between 0 and 30.", "danger"); return;
            }
          }

          saveBtn.disabled = true;
          const payload = { name, triggerType, timezone, dailyEnrollmentLimit: dailyLimit, stopOnReply, stopOnUnsubscribe, audienceFilter, triggerConfig };
          try {
            if (isEdit) {
              await S().automationRules.update(existing.id, payload);
              App.app.toast("Sequence saved.", "success");
            } else {
              await S().automationRules.create(payload);
              App.app.toast("Draft sequence created.", "success");
            }
            h.close();
            await loadRules(pane, state);
          } catch (err) {
            App.app.toast("Could not save: " + ((err && err.message) || "Unknown error"), "danger");
            saveBtn.disabled = false;
          }
        };
      }
    });
  }

  /* ============================================================
   * STEP FORM (create/edit)
   * ========================================================== */

  function openStepModal(pane, state, rule, existingStep, currentSteps) {
    const isEdit = !!existingStep;
    const actionType = existingStep ? existingStep.action_type : "send_email";
    // Always offer active templates; also include the step's currently
    // assigned template even if it has since been deactivated, so editing
    // an existing step never silently drops or swaps its reference.
    const templateOptions = state.templates.filter(t => t.is_active || (existingStep && t.id === existingStep.template_id));
    const existingTitle = (existingStep && existingStep.config && existingStep.config.title) || "";
    const existingPriority = (existingStep && existingStep.config && existingStep.config.priority) || "Medium";

    const h = App.app.openModal({
      title: isEdit ? "Edit Step" : "Add Step",
      wide: true,
      body: `
        <div class="form-grid">
          <label class="field"><span>Step type</span><select id="stepType">
            <option value="send_email" ${actionType === "send_email" ? "selected" : ""}>Send Email</option>
            <option value="wait" ${actionType === "wait" ? "selected" : ""}>Wait</option>
            <option value="create_task" ${actionType === "create_task" ? "selected" : ""}>Create Task</option>
          </select></label>
          <label class="field"><span>Delay (minutes)</span><input id="stepDelay" type="number" min="0" max="525600" value="${existingStep ? U().esc(existingStep.delay_minutes) : 0}"></label>

          <div data-step-group="send_email" class="full" style="display:${actionType === "send_email" ? "flex" : "none"};flex-direction:column;gap:14px">
            <label class="field"><span>Email template</span><select id="stepTemplate">
              <option value="">Select a template…</option>
              ${templateOptions.map(t => `<option value="${U().esc(t.id)}" ${existingStep && existingStep.template_id === t.id ? "selected" : ""}>${U().esc(t.name)}${t.is_active ? "" : " (inactive)"}</option>`).join("")}
            </select></label>
            ${!templateOptions.length ? '<p class="form-help">No active email templates yet — create one on the Email Templates page first.</p>' : ""}
            <label class="field"><span>Subject override (optional)</span><input id="stepSubjectOverride" maxlength="200" value="${U().esc(existingStep && existingStep.subject_override || "")}"></label>
          </div>

          <div data-step-group="create_task" class="full" style="display:${actionType === "create_task" ? "flex" : "none"};flex-direction:column;gap:14px">
            <label class="field"><span>Task title</span><input id="stepTaskTitle" maxlength="200" value="${U().esc(existingTitle)}"></label>
            <label class="field"><span>Priority</span><select id="stepTaskPriority">
              ${TASK_PRIORITIES.map(p => `<option value="${U().esc(p)}" ${existingPriority === p ? "selected" : ""}>${U().esc(p)}</option>`).join("")}
            </select></label>
          </div>

          <div data-step-group="wait" class="full" style="display:${actionType === "wait" ? "flex" : "none"};flex-direction:column;gap:14px">
            <p class="form-help">Wait steps only use the delay above — no template or task details are needed.</p>
          </div>
        </div>
      `,
      footer: `<button class="btn" data-role="cancel">Cancel</button><button class="btn btn-primary" data-role="save">${isEdit ? "Save Changes" : "Add Step"}</button>`,
      onOpen: (m) => {
        m.querySelector('[data-role="cancel"]').onclick = () => h.close();

        const typeSelect = m.querySelector("#stepType");
        const syncGroups = () => {
          const t = typeSelect.value;
          m.querySelectorAll("[data-step-group]").forEach(g => {
            g.style.display = g.getAttribute("data-step-group") === t ? "flex" : "none";
          });
        };
        typeSelect.addEventListener("change", syncGroups);

        const saveBtn = m.querySelector('[data-role="save"]');
        saveBtn.onclick = async () => {
          if (saveBtn.disabled) return;
          const type = typeSelect.value;
          const delayMinutes = Number(m.querySelector("#stepDelay").value);
          if (!Number.isInteger(delayMinutes) || delayMinutes < 0 || delayMinutes > 525600) {
            App.app.toast("Delay must be an integer between 0 and 525,600 minutes.", "danger");
            return;
          }

          const payload = { actionType: type, delayMinutes };
          if (type === "send_email") {
            const templateId = m.querySelector("#stepTemplate").value;
            if (!templateId) { App.app.toast("Select an active email template.", "danger"); return; }
            payload.templateId = templateId;
            const subjectOverride = m.querySelector("#stepSubjectOverride").value.trim();
            if (subjectOverride) payload.subjectOverride = subjectOverride;
          } else if (type === "create_task") {
            const title = m.querySelector("#stepTaskTitle").value.trim();
            if (!title) { App.app.toast("Task title is required.", "danger"); return; }
            payload.config = { title, priority: m.querySelector("#stepTaskPriority").value };
          }

          saveBtn.disabled = true;
          try {
            if (isEdit) {
              await S().automationSteps.update(existingStep.id, payload);
              App.app.toast("Step saved.", "success");
            } else {
              payload.stepOrder = nextStepOrder(currentSteps);
              await S().automationSteps.create(rule.id, payload);
              App.app.toast("Step added.", "success");
            }
            h.close();
            await loadSteps(pane, state, rule);
          } catch (err) {
            App.app.toast("Could not save: " + ((err && err.message) || "Unknown error"), "danger");
            saveBtn.disabled = false;
          }
        };
      }
    });
  }

  return { render, renderActivity: pane => render(pane, true) };
})();
