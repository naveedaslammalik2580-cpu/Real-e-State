/* ============================================================
   onboarding.js — the first-run wizard, the getting-started checklist,
   and the time zone nudge.

   Three first-run things, together because they answer the same question:
   what does somebody who just signed in need to do next?

   EVERY STEP IS SKIPPABLE and the whole thing is resumable - the step
   number is stored, so closing the browser mid-way picks up where it left
   off rather than starting again or never showing again. It can also be
   reopened from Settings, because the one thing worse than a wizard is a
   wizard you cannot get back.

   NOTHING HERE SENDS ANYTHING. Step 4 collects a sender name and reply-to
   address and says plainly that sending starts later, because it does:
   process-automation is not deployed and no provider is configured.
   ============================================================ */
window.App = window.App || {};
App.pages = App.pages || {};

App.pages.onboarding = (function () {
  "use strict";

  const U = () => App.util;
  const S = () => App.store;

  const LAST_STEP = 5;

  const settings = () => (S().getState() && S().getState().settings) || {};
  const isDone = () => settings().onboardingDone === true;
  const storedStep = () => {
    const n = Number(settings().onboardingStep);
    return Number.isInteger(n) && n >= 1 && n <= LAST_STEP ? n : 1;
  };

  /** The browser's own zone, or null if it will not say. */
  function browserZone() {
    try {
      const guess = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return guess || null;
    } catch (e) { return null; }
  }

  /* ============================================================
   * THE TIME ZONE NUDGE (Phase 2E)
   *
   * Phase 2D's backfill wrote UTC for every workspace that had no zone, so
   * an agency in Dubai is silently on UTC and its daily summary lands four
   * hours early. This asks once, and records that it asked either way -
   * somebody who genuinely wants UTC should not be nagged about it.
   * ========================================================== */
  function timezoneNudgeHtml() {
    const s = settings();
    if (s.timezoneConfirmed === true) return "";
    if ((s.timezone || "UTC") !== "UTC") return "";
    const zone = browserZone();
    if (!zone || zone === "UTC") return "";
    return `
      <section class="card" id="tzNudge" data-zone="${U().esc(zone)}">
        <div class="card-body">
          <div class="split-row">
            <div class="split-row-main"><div class="split-row-label">
              <strong>Your time zone is UTC. Use ${U().esc(zone)}?</strong>
              <div class="form-help">This decides what counts as "today" in your reminders, and when birthday messages go out.</div>
            </div></div>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button type="button" class="btn btn-primary btn-sm" id="tzNudgeUse">Use it</button>
              <button type="button" class="btn btn-sm" id="tzNudgeKeep">Keep UTC</button>
            </div>
          </div>
        </div>
      </section>`;
  }

  function wireTimezoneNudge(container, onDone) {
    const card = container.querySelector("#tzNudge");
    if (!card) return;
    const zone = card.getAttribute("data-zone");
    const settle = async (tz) => {
      card.querySelectorAll("button").forEach((b) => { b.disabled = true; });
      try {
        // Either answer records that we asked, so this never comes back.
        await S().settings.update(tz ? { timezone: tz, timezoneConfirmed: true }
                                    : { timezoneConfirmed: true });
        App.app.toast(tz ? "Time zone set to " + tz + "." : "Staying on UTC.", "success");
        card.remove();
        if (typeof onDone === "function") onDone();
      } catch (err) {
        card.querySelectorAll("button").forEach((b) => { b.disabled = false; });
        App.app.toast("Could not save: " + ((err && err.message) || "Unknown error"), "danger");
      }
    };
    const use = card.querySelector("#tzNudgeUse");
    const keep = card.querySelector("#tzNudgeKeep");
    if (use) use.addEventListener("click", () => settle(zone));
    if (keep) keep.addEventListener("click", () => settle(null));
  }

  /* ============================================================
   * THE GETTING-STARTED CHECKLIST
   *
   * Five things, each derived from real data rather than from a flag, so it
   * cannot claim you did something you did not. It disappears when every
   * item is done, or when dismissed - a checklist that stays forever
   * becomes furniture.
   * ========================================================== */
  function checklist(state) {
    const s = (state && state.settings) || {};
    const contacts = (state && state.contacts) || [];
    const activities = (state && state.activities) || [];
    const rules = (state && state.onboardingRules) || [];
    return [
      { id: "profile", label: "Add your name and time zone",
        done: !!(String(s.agentName || "").trim()) && s.timezoneConfirmed === true,
        route: "/settings/business-profile" },
      { id: "contacts", label: "Bring in your contacts",
        done: contacts.length > 0, route: "/contacts" },
      { id: "pack", label: "Add a starter sequence",
        done: rules.length > 0, route: "/automation" },
      { id: "review", label: "Read one sequence and make it sound like you",
        // "Reviewed" is not a thing we can observe, so this counts the one
        // observable proxy: a rule that is no longer a untouched draft.
        done: rules.some((r) => r.status && r.status !== "draft"), route: "/automation" },
      { id: "logged", label: "Log your first follow-up",
        done: activities.length > 0, route: "/daily" }
    ];
  }

  function checklistHtml(state) {
    const s = (state && state.settings) || {};
    if (s.gettingStartedDismissed === true) return "";
    const items = checklist(state);
    const doneCount = items.filter((i) => i.done).length;
    if (doneCount === items.length) return "";
    return `
      <section class="card" id="gettingStarted">
        <div class="card-header">
          <div class="card-title">Getting started
            <span class="today-count">${doneCount} of ${items.length}</span>
          </div>
          <button type="button" class="btn btn-sm" id="gsDismiss">Hide this</button>
        </div>
        <div class="card-body zero">
          ${items.map((i) => `
            <div class="today-row">
              <div class="today-row-main">
                <div class="today-row-name">${i.done ? "\\u2713 " : ""}${U().esc(i.label)}</div>
              </div>
              ${i.done ? "" : `<div class="fu-bar"><button type="button" class="btn btn-sm" data-gs-go="${U().esc(i.route)}">Do it</button></div>`}
            </div>`).join("")}
          <div class="today-more">
            <button type="button" class="btn btn-sm" id="gsReopen">Open the setup guide</button>
          </div>
        </div>
      </section>`;
  }

  function wireChecklist(container, onChanged) {
    const card = container.querySelector("#gettingStarted");
    if (!card) return;
    card.addEventListener("click", async (e) => {
      const go = e.target.closest("[data-gs-go]");
      if (go) { App.app.navigate(go.getAttribute("data-gs-go")); return; }
      if (e.target.closest("#gsReopen")) { open(1); return; }
      if (e.target.closest("#gsDismiss")) {
        try {
          await S().settings.update({ gettingStartedDismissed: true });
          card.remove();
          if (typeof onChanged === "function") onChanged();
        } catch (err) {
          App.app.toast("Could not save: " + ((err && err.message) || "Unknown error"), "danger");
        }
      }
    });
  }

  /* ============================================================
   * THE WIZARD
   * ========================================================== */

  // Remembered as we go, so Back does not lose what was typed and a
  // reopened wizard starts from the stored step.
  let draft = null;

  async function saveStep(step) {
    try { await S().settings.update({ onboardingStep: step }); }
    catch (err) { /* losing the place is not worth an error message */ }
  }

  async function finish(skipped) {
    try {
      await S().settings.update({ onboardingDone: true, onboardingStep: LAST_STEP });
    } catch (err) {
      App.app.toast("Could not save: " + ((err && err.message) || "Unknown error"), "danger");
      return false;
    }
    if (!skipped) App.app.toast("You are set up. This is your day.", "success");
    App.app.navigate("/daily");
    return true;
  }

  function stepBody(step) {
    const s = settings();
    const zone = draft.timezone || s.timezone || browserZone() || "UTC";

    if (step === 1) {
      return {
        title: "Your business",
        body: `
          <p class="form-help">Three things, then we are out of your way.</p>
          <div class="form-grid">
            <label class="field full"><span>Your name</span>
              <input id="obName" maxlength="120" value="${U().esc(draft.agentName != null ? draft.agentName : (s.agentName || ""))}">
              <span class="form-help">Used to sign the emails you send.</span>
            </label>
            <label class="field"><span>Default country code</span>
              <input id="obCountry" maxlength="5" inputmode="tel" placeholder="e.g. +971" value="${U().esc(draft.defaultCountryCode != null ? draft.defaultCountryCode : (s.defaultCountryCode || ""))}">
              <span class="form-help">So Call and WhatsApp reach numbers stored without one.</span>
            </label>
            <label class="field"><span>Time zone</span>
              <input id="obZone" list="obZoneList" maxlength="64" value="${U().esc(zone)}">
              <datalist id="obZoneList"></datalist>
              <span class="form-help">Decides what counts as "today".</span>
            </label>
          </div>
          <span class="field-error" id="obStep1Error" role="alert" style="display:none;color:var(--danger)"></span>`
      };
    }

    if (step === 2) {
      return {
        title: "Bring in your contacts",
        body: `
          <p class="form-help">However you have them now. You can do this later, or more than once.</p>
          <div class="form-grid">
            <button type="button" class="btn btn-block" data-ob-action="file">Import a spreadsheet or CSV</button>
            <button type="button" class="btn btn-block" data-ob-action="sheets">Connect a Google Sheet</button>
            <button type="button" class="btn btn-block" data-ob-action="manual">Add one by hand</button>
          </div>
          <p class="form-help">Each of these opens the normal screen for it. Your place is saved. Reopen the Setup Guide in Settings when you are ready to continue.</p>`
      };
    }

    if (step === 3) {
      const packs = (App.starterPacks && App.starterPacks.all()) || [];
      return {
        title: "Follow-ups to start from",
        body: `
          <p class="form-help">Added as <strong>drafts</strong>. Nothing sends until you read it and switch it on.</p>
          <div class="form-grid">
            ${packs.map((pack) => `
              <label class="field full" style="flex-direction:row;align-items:flex-start;gap:10px">
                <input type="checkbox" class="ob-pack" value="${U().esc(pack.id)}"
                  ${(draft.packs || []).indexOf(pack.id) >= 0 ? "checked" : ""} style="margin-top:4px">
                <span style="font-weight:400">
                  <strong>${U().esc(pack.name)}</strong>
                  <div class="form-help" style="margin:2px 0 0">${U().esc(pack.blurb)}</div>
                </span>
              </label>`).join("")}
            ${packs.length ? "" : `<p class="form-help">No starter sequences are available.</p>`}
          </div>`
      };
    }

    if (step === 4) {
      return {
        title: "Who your emails come from",
        body: `
          <div class="release-callout release-callout-warning" style="margin-bottom:12px">
            <strong>This does not start sending.</strong>
            <p style="margin:6px 0 0">Email delivery is set up separately, later. This just records the name and address your follow-ups will use when it is.</p>
          </div>
          <div class="form-grid">
            <label class="field full"><span>From name</span>
              <input id="obSenderName" maxlength="120" value="${U().esc(draft.senderName != null ? draft.senderName : (draft.agentName || s.agentName || ""))}">
            </label>
            <label class="field full"><span>Reply-to address</span>
              <input id="obSenderReply" type="email" maxlength="254" value="${U().esc(draft.senderReply != null ? draft.senderReply : (s.agentEmail || ""))}">
              <span class="form-help">Where replies go. Your own address is fine.</span>
            </label>
          </div>
          <span class="field-error" id="obStep4Error" role="alert" style="display:none;color:var(--danger)"></span>`
      };
    }

    return {
      title: "That is it",
      body: `
        <p>You are set up. Next stop is <strong>Today</strong> - who to contact, and what is due.</p>
        <p class="form-help">Anything you skipped is in Settings, and you can reopen this guide from Settings. Follow-up plans and email setup are optional and available there later.</p>`
    };
  }

  const COUNTRY_CODE = /^\+?[0-9]{1,4}$/;

  function open(startStep) {
    let step = Number.isInteger(startStep) ? startStep : storedStep();
    const solo = !(App.customization ? App.customization.isTeamMode() : settings().customization && settings().customization.teamMode);
    let optional = !solo || step === 3 || step === 4;
    const nextStep = () => solo && !optional && step === 2 ? LAST_STEP : step + 1;
    if (draft === null) draft = { packs: [] };

    let handle = null;

    const render = () => {
      if (handle) handle.close();
      const content = stepBody(step);
      handle = App.app.openModal({
        title: content.title + "  (" + (solo && !optional ? (step === LAST_STEP ? 3 : step) : step) + " of " + (solo && !optional ? 3 : LAST_STEP) + ")",
        wide: true,
        body: content.body,
        footer: `
          ${solo && step === 2 ? '<button class="btn" data-role="optional">Optional follow-up setup</button>' : ""}
          ${step > 1 ? `<button class="btn" data-role="back">Back</button>` : ""}
          <button class="btn" data-role="skip">${step === LAST_STEP ? "Close" : "Skip for now"}</button>
          <button class="btn btn-primary" data-role="next">${step === LAST_STEP ? "Go to Today" : "Continue"}</button>`,
        onOpen: (m) => {
          if (step === 1 && S().settings.listTimezones) {
            // Best effort: the field is a plain text input until it loads,
            // and the server validates whatever is typed.
            S().settings.listTimezones().then((names) => {
              const list = m.querySelector("#obZoneList");
              if (!list) return;
              const frag = m.ownerDocument.createDocumentFragment();
              (names || []).forEach((n) => {
                const o = m.ownerDocument.createElement("option");
                o.value = n;
                frag.appendChild(o);
              });
              list.appendChild(frag);
            }).catch(() => {});
          }

          if (step === 2) {
            m.querySelectorAll("[data-ob-action]").forEach((btn) => {
              btn.addEventListener("click", async () => {
                const what = btn.getAttribute("data-ob-action");
                // The place is saved first, so whichever screen this opens
                // can be left without losing the wizard.
                await saveStep(2);
                handle.close();
                if (what === "file" && App.pages.leadFileImport) App.pages.leadFileImport.open();
                else if (what === "sheets") App.app.navigate("/settings/google-sheets");
                else if (what === "manual" && App.quickAdd && (!App.workspace || App.workspace.canCreate("contacts"))) App.quickAdd.open();
                else App.app.navigate("/contacts");
              });
            });
          }

          const extra = m.querySelector('[data-role="optional"]');
          if (extra) extra.addEventListener("click", async () => { optional = true; step = 3; await saveStep(step); render(); });
          const back = m.querySelector('[data-role="back"]');
          if (back) back.addEventListener("click", () => { step = solo && !optional && step === LAST_STEP ? 2 : step - 1; render(); });

          m.querySelector('[data-role="skip"]').addEventListener("click", async () => {
            if (step === LAST_STEP) { if (await finish(true)) handle.close(); return; }
            await saveStep(nextStep());
            step = nextStep();
            render();
          });

          const next = m.querySelector('[data-role="next"]');
          next.addEventListener("click", async () => {
            if (next.disabled) return;
            next.disabled = true;
            const ok = await commitStep(step, m);
            if (!ok) { next.disabled = false; return; }
            if (step === LAST_STEP) { if (await finish(false)) handle.close(); else next.disabled = false; return; }
            step = nextStep();
            await saveStep(step);
            render();
          });
        }
      });
    };

    render();
    return { close: () => handle && handle.close() };
  }

  /** Saves whatever this step collected. Returns false to stay put. */
  async function commitStep(step, m) {
    const fail = (id, message) => {
      const el = m.querySelector(id);
      if (el) { el.textContent = message; el.style.display = "block"; }
      return false;
    };

    try {
      if (step === 1) {
        const name = m.querySelector("#obName").value.trim();
        const code = m.querySelector("#obCountry").value.trim();
        const zone = m.querySelector("#obZone").value.trim();
        if (code && !COUNTRY_CODE.test(code)) {
          return fail("#obStep1Error", "A country code is an optional + and 1 to 4 digits, like +971.");
        }
        draft.agentName = name;
        draft.defaultCountryCode = code;
        draft.timezone = zone;
        const patch = { onboardingStep: 2 };
        if (name) patch.agentName = name;
        if (code) patch.defaultCountryCode = code.charAt(0) === "+" ? code : "+" + code;
        if (zone) { patch.timezone = zone; patch.timezoneConfirmed = true; }
        await S().settings.update(patch);
        return true;
      }

      if (step === 3) {
        draft.packs = Array.from(m.querySelectorAll(".ob-pack:checked")).map((c) => c.value);
        if (!draft.packs.length) return true;
        const result = await App.starterPacks.install(draft.packs, {
          timezone: draft.timezone || settings().timezone || "UTC"
        });
        App.app.toast(App.starterPacks.summarize(result), result.failed.length ? "danger" : "success");
        return true;
      }

      if (step === 4) {
        const name = m.querySelector("#obSenderName").value.trim();
        const reply = m.querySelector("#obSenderReply").value.trim();
        draft.senderName = name;
        draft.senderReply = reply;
        // Both or neither: a profile with one half is not usable, and
        // leaving it empty is a legitimate "later".
        if (!name && !reply) return true;
        if (!name || !reply) {
          return fail("#obStep4Error", "Fill in both, or leave both blank to do this later.");
        }
        await S().emailSenderProfile.save({
          displayName: name, replyToEmail: reply,
          // Deliberately not enabled: nothing should be able to send until
          // the agent has set up delivery and turned it on themselves.
          isEnabled: false
        });
        return true;
      }

      return true;
    } catch (err) {
      const message = (err && err.message) || "Unknown error";
      if (step === 1) return fail("#obStep1Error", message);
      if (step === 4) return fail("#obStep4Error", message);
      App.app.toast("Could not save: " + message, "danger");
      return false;
    }
  }

  /** Called from finishBoot. Returns true if it took over the screen. */
  function maybeOpen() {
    if (isDone()) return false;
    // Invitations own their entry flow; members without settings-edit access
    // must not be asked to configure their shared workspace.
    if (/^#\/join(?:\?|$)/.test(window.location.hash || "")) return false;
    if (App.workspace && !App.workspace.canEditSettings()) return false;
    open(storedStep());
    return true;
  }

  return {
    maybeOpen, open, isDone,
    timezoneNudgeHtml, wireTimezoneNudge,
    checklist, checklistHtml, wireChecklist,
    browserZone
  };
})();
