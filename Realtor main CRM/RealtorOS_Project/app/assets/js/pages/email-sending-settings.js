/* ============================================================
   email-sending-settings.js — Settings → Email Sending (Phase 4C).
   Configuration + a single controlled test send. This page never calls
   Resend directly — every send goes through the authenticated
   send-test-email Supabase Edge Function via App.store.testEmail.send(),
   and no browser code here ever inserts/updates/deletes an
   outbound_messages row. Saving settings never starts automation: a
   sequence only sends once it is activated AND the scheduled follow-up
   worker is deployed for this workspace.

   Depends on: app.js, store.js (App.store.emailSenderProfile,
   App.store.testEmail, App.store.messageTemplates), util.js
   ============================================================ */

window.App = window.App || {};
App.pages = App.pages || {};

App.pages.emailSendingSettings = (function () {
  "use strict";

  const U = () => App.util;
  const S = () => App.store;

  const DISPLAY_NAME_MAX = 100;
  const REPLY_TO_MAX = 254;
  const CONTROL_CHARS_RE = /[\x00-\x1F\x7F]/;
  const UNSAFE_HEADER_CHARS_RE = /[<>"\\,]/;
  const EMAIL_SHAPE_RE =
    /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

  const STATUS_META = {
    queued: { label: "Queued", cls: "badge-neutral" },
    sent: { label: "Sent", cls: "badge-info" },
    delivered: { label: "Delivered", cls: "badge-success" },
    delivery_delayed: { label: "Delayed", cls: "badge-warning" },
    opened: { label: "Opened", cls: "badge-success" },
    clicked: { label: "Clicked", cls: "badge-success" },
    replied: { label: "Replied", cls: "badge-success" },
    bounced: { label: "Bounced", cls: "badge-danger" },
    complained: { label: "Complaint", cls: "badge-danger" },
    suppressed: { label: "Suppressed", cls: "badge-danger" },
    failed: { label: "Failed", cls: "badge-danger" },
    unsubscribed: { label: "Unsubscribed", cls: "badge-neutral" }
  };

  function safeLookup(map, key) {
    if (typeof key !== "string") return null;
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
  }
  function statusBadge(status) {
    const meta = safeLookup(STATUS_META, status);
    const label = meta ? meta.label : "Unknown";
    const cls = meta ? meta.cls : "badge-neutral";
    // Text label carries the meaning — never color alone.
    return `<span class="badge ${cls}"><span class="dot"></span>${U().esc(label)}</span>`;
  }
  function maskEmail(email) {
    if (typeof email !== "string" || !email) return "";
    const at = email.indexOf("@");
    if (at <= 1) return U().esc(email);
    return U().esc(email.slice(0, 1) + "***" + email.slice(at));
  }
  function formatTimestamp(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleString();
  }
  function isValidDisplayName(value) {
    if (typeof value !== "string") return false;
    const trimmed = value.trim();
    return !!trimmed && trimmed.length <= DISPLAY_NAME_MAX &&
      !CONTROL_CHARS_RE.test(trimmed) && !UNSAFE_HEADER_CHARS_RE.test(trimmed);
  }
  function isValidReplyTo(value) {
    if (typeof value !== "string") return false;
    const trimmed = value.trim();
    return !!trimmed && trimmed.length <= REPLY_TO_MAX &&
      !CONTROL_CHARS_RE.test(trimmed) && trimmed.indexOf(",") === -1 && EMAIL_SHAPE_RE.test(trimmed);
  }

  /* ============================================================
   * RENDER ENTRY POINT
   * ========================================================== */

  async function render(pane) {
    if (!pane) return;

    const state = {
      profile: null,
      profileError: null,
      templates: [],
      templatesError: null,
      history: [],
      historyError: null,
      sending: false,
      // { templateId, idempotencyKey } for an attempt whose provider result
      // is still unconfirmed (timeout/network/malformed response/our own
      // status-update failure) — never persisted anywhere but this
      // in-memory page state; never localStorage/sessionStorage/URL/logs.
      activeAttempt: null
    };

    pane.innerHTML = App.app.loadingHtml ? App.app.loadingHtml("email sending settings") : "";
    renderShell(pane, state);
    await Promise.all([loadProfile(pane, state), loadTemplates(pane, state), loadHistory(pane, state)]);
  }

  function renderShell(pane, state) {
    pane.innerHTML = `
      <div class="settings-category-head">
        <div class="settings-category-title">Email Sending</div>
        <p class="form-help">Configure your RealtorOS sender identity and safely test email delivery.</p>
      </div>

      <div class="release-callout" style="margin-bottom:16px">
        <strong>How RealtorOS sends email</strong>
        <ul class="gs-explainer-list" style="margin-top:8px">
          <li>RealtorOS sends from its own verified email domain — you do not need to set up your own.</li>
          <li>You get your own sender email address, so your emails never appear to come from a shared address.</li>
          <li>Replies always go to your saved Reply-To email below, never to your RealtorOS sender address.</li>
          <li>Email delivery is still being set up for this workspace. Until it is ready, test sends will tell you so clearly instead of silently failing.</li>
          <li>Saving these settings alone never starts automation. A sequence only sends once you activate it and the automation system is running for this workspace.</li>
        </ul>
      </div>

      <section class="card" style="margin-bottom:16px">
        <div class="card-header"><div class="card-title">Sender Profile</div></div>
        <div class="card-body">
          <div id="epProfileBody">${App.app.loadingHtml ? App.app.loadingHtml("your sender profile") : ""}</div>
        </div>
      </section>

      <section class="card" style="margin-bottom:16px">
        <div class="card-header"><div class="card-title">Send a Test Email</div></div>
        <div class="card-body">
          <div id="epTestBody">${App.app.loadingHtml ? App.app.loadingHtml("templates") : ""}</div>
        </div>
      </section>

      <section class="card">
        <div class="card-header"><div class="card-title">Recent Test Sends</div></div>
        <div class="card-body">
          <div id="epHistoryBody">${App.app.loadingHtml ? App.app.loadingHtml("test history") : ""}</div>
        </div>
      </section>
    `;
  }

  /* ============================================================
   * SENDER PROFILE
   * ========================================================== */

  async function loadProfile(pane, state) {
    try {
      state.profile = await S().emailSenderProfile.get();
      state.profileError = null;
    } catch (err) {
      state.profileError = (err && err.message) ? err.message : "Unknown error";
    }
    renderProfile(pane, state);
    renderTestCard(pane, state); // depends on whether a profile exists
  }

  function renderProfile(pane, state) {
    const el = pane.querySelector("#epProfileBody");
    if (!el) return;

    if (state.profileError) {
      el.innerHTML = `
        <div class="empty-state" role="alert">
          <div class="empty-title">Could not load your sender profile</div>
          <div class="empty-desc">${U().esc(state.profileError)}</div>
          <button type="button" class="btn btn-primary" id="epProfileRetry">Retry</button>
        </div>`;
      el.querySelector("#epProfileRetry").addEventListener("click", () => loadProfile(pane, state));
      return;
    }

    const p = state.profile;
    el.innerHTML = `
      <div class="form-grid">
        <label class="field full"><span>Sender display name</span>
          <input id="epDisplayName" maxlength="${DISPLAY_NAME_MAX}" value="${U().esc(p ? p.display_name : "")}" placeholder="e.g. Jane Smith">
        </label>
        <label class="field full"><span>Reply-To email</span>
          <input id="epReplyTo" type="email" maxlength="${REPLY_TO_MAX}" value="${U().esc(p ? p.reply_to_email : "")}" placeholder="you@yourbrokerage.com">
        </label>
        <label class="field" style="flex-direction:row;align-items:center;gap:10px">
          <span>Enable test sending</span>
          <span class="toggle-switch"><input type="checkbox" id="epEnabled" ${p && p.is_enabled ? "checked" : ""}><span class="toggle-track"></span></span>
        </label>
        <label class="field full"><span>Sender preview</span>
          <div class="form-help" id="epSenderPreview" style="white-space:pre-wrap;word-break:break-word"></div>
        </label>
      </div>
      <p id="epProfileStatus" class="profile-edit-message" aria-live="polite" role="status" style="margin-top:10px"></p>
      <div style="margin-top:10px">
        <button type="button" class="btn btn-primary" id="epProfileSave">Save Sender Profile</button>
      </div>
    `;

    const nameInput = el.querySelector("#epDisplayName");
    const previewEl = el.querySelector("#epSenderPreview");
    const updatePreview = () => {
      const name = nameInput.value.trim() || "Your Name";
      previewEl.textContent = name + " via RealtorOS <Your unique RealtorOS sender address will be assigned when the sending domain is connected.>";
    };
    updatePreview();
    nameInput.addEventListener("input", updatePreview);

    const statusEl = el.querySelector("#epProfileStatus");
    const saveBtn = el.querySelector("#epProfileSave");
    saveBtn.addEventListener("click", async () => {
      if (saveBtn.disabled) return; // prevent duplicate submission
      const displayName = nameInput.value.trim();
      const replyToEmail = el.querySelector("#epReplyTo").value.trim();
      const isEnabled = el.querySelector("#epEnabled").checked;

      if (!isValidDisplayName(displayName)) {
        statusEl.textContent = "Sender display name must be 1-100 characters, with no <, >, \", \\, comma, or control characters.";
        statusEl.className = "profile-edit-message error";
        return;
      }
      if (!isValidReplyTo(replyToEmail)) {
        statusEl.textContent = "Reply-To must be exactly one valid email address (no comma-separated lists).";
        statusEl.className = "profile-edit-message error";
        return;
      }

      saveBtn.disabled = true;
      statusEl.textContent = "Saving…";
      statusEl.className = "profile-edit-message";
      try {
        state.profile = await S().emailSenderProfile.save({ displayName, replyToEmail, isEnabled });
        statusEl.textContent = "Sender profile saved.";
        statusEl.className = "profile-edit-message success";
        App.app.toast("Sender profile saved.", "success");
        renderTestCard(pane, state);
      } catch (err) {
        statusEl.textContent = "Could not save: " + ((err && err.message) || "Unknown error");
        statusEl.className = "profile-edit-message error";
        App.app.toast("Could not save sender profile.", "danger");
      } finally {
        saveBtn.disabled = false;
      }
    });
  }

  /* ============================================================
   * TEST SEND
   * ========================================================== */

  async function loadTemplates(pane, state) {
    try {
      state.templates = await S().messageTemplates.list({ activeOnly: true, orderBy: "name" });
      state.templatesError = null;
    } catch (err) {
      state.templatesError = (err && err.message) ? err.message : "Unknown error";
    }
    renderTestCard(pane, state);
  }

  function renderTestCard(pane, state) {
    const el = pane.querySelector("#epTestBody");
    if (!el) return;

    if (state.templatesError) {
      el.innerHTML = `
        <div class="empty-state" role="alert">
          <div class="empty-title">Could not load Email Templates</div>
          <div class="empty-desc">${U().esc(state.templatesError)}</div>
          <button type="button" class="btn btn-primary" id="epTemplatesRetry">Retry</button>
        </div>`;
      el.querySelector("#epTemplatesRetry").addEventListener("click", () => loadTemplates(pane, state));
      return;
    }

    const profile = state.profile;
    const canSend = !!(profile && profile.is_enabled && isValidReplyTo(profile.reply_to_email) && state.templates.length);

    if (!state.templates.length) {
      el.innerHTML = `<div class="empty-state"><div class="empty-title">No active Email Templates yet</div><div class="empty-desc">Create and activate a template on the Email Templates page first.</div></div>`;
      return;
    }
    if (!profile || !profile.is_enabled) {
      el.innerHTML = `<p class="form-help">Save and enable your sender profile above to send a test email.</p>`;
      return;
    }

    // A pending ambiguous attempt (ATT.templateId) keeps its idempotency
    // key alive across re-renders — the select defaults to that template
    // and the button switches into "retry the same request" mode, never
    // generating a new key for it.
    const pending = state.activeAttempt;
    el.innerHTML = `
      <div class="form-grid">
        <label class="field full"><span>Email Template</span><select id="epTestTemplate">
          ${state.templates.map(t => `<option value="${U().esc(t.id)}" ${pending && pending.templateId === t.id ? "selected" : ""}>${U().esc(t.name)}</option>`).join("")}
        </select></label>
        <label class="field full"><span>Destination</span>
          <div class="form-help">${maskEmail(profile.reply_to_email)} (your saved Reply-To address — not editable here)</div>
        </label>
      </div>
      <p id="epTestStatus" class="profile-edit-message${pending ? " error" : ""}" aria-live="polite" role="status" style="margin-top:10px">${pending ? "The delivery result could not be confirmed. Retry safely with the same request key." : ""}</p>
      <div style="margin-top:10px">
        <button type="button" class="btn btn-primary" id="epTestSend" ${canSend ? "" : "disabled"}>${pending ? "Retry Test Email (same request)" : "Send Test Email"}</button>
      </div>
    `;

    const templateSelect = el.querySelector("#epTestTemplate");
    // Changing the template abandons any unused prior key for a
    // different template — nothing meaningful to retry there anymore.
    templateSelect.addEventListener("change", () => {
      if (state.activeAttempt && state.activeAttempt.templateId !== templateSelect.value) {
        state.activeAttempt = null;
        renderTestCard(pane, state);
      }
    });

    const sendBtn = el.querySelector("#epTestSend");
    sendBtn.addEventListener("click", () => {
      if (sendBtn.disabled || state.sending) return;
      if (state.activeAttempt && state.activeAttempt.templateId === templateSelect.value) {
        // Retry of an unresolved ambiguous attempt: no re-confirmation,
        // and critically the SAME idempotency key.
        runTestSend(pane, state, el, sendBtn, state.activeAttempt.templateId, state.activeAttempt.idempotencyKey);
      } else {
        confirmAndSendTest(pane, state, el, sendBtn, templateSelect);
      }
    });
  }

  function confirmAndSendTest(pane, state, el, sendBtn, templateSelect) {
    if (sendBtn.disabled || state.sending) return;
    const templateId = templateSelect.value;
    const template = state.templates.find(t => t.id === templateId);
    if (!template) return;
    const recipient = state.profile.reply_to_email;

    App.app.confirmDialog({
      title: "Send test email?",
      message: `A real email may be delivered once email delivery is configured. It will be sent only to your saved Reply-To address (${U().esc(maskEmail(recipient))}). This does not enroll any contacts and does not activate an automation sequence.`,
      okLabel: "Send Test Email"
    }, () => {
      // Exactly one new UUID per user-confirmed attempt.
      const idempotencyKey = crypto.randomUUID();
      state.activeAttempt = { templateId, idempotencyKey };
      runTestSend(pane, state, el, sendBtn, templateId, idempotencyKey);
    });
  }

  // Statuses that must never be reported to the user as a plain success,
  // even though the request itself completed and returned a validated
  // message row.
  const NON_SUCCESS_STATUSES_ = ["failed", "bounced", "complained", "suppressed", "unsubscribed"];

  async function runTestSend(pane, state, el, sendBtn, templateId, idempotencyKey) {
    if (state.sending) return; // prevents duplicate clicks during an active request
    state.sending = true;
    sendBtn.disabled = true;
    const statusEl = el.querySelector("#epTestStatus");
    if (statusEl) { statusEl.textContent = "Sending test email…"; statusEl.className = "profile-edit-message"; }

    try {
      const message = await S().testEmail.send({ templateId, idempotencyKey });
      // A message row is always a DEFINITIVE, strictly-validated outcome
      // (data-service.js never returns a partial/malformed one) — the
      // attempt is resolved either way, so the preserved key is done.
      state.activeAttempt = null;
      if (NON_SUCCESS_STATUSES_.indexOf(message.status) !== -1) {
        if (statusEl) {
          statusEl.textContent = "Test email did not succeed — status: " + message.status +
            (message.error_message ? " (" + message.error_message + ")" : "") + ".";
          statusEl.className = "profile-edit-message error";
        }
        App.app.toast("Test email did not succeed.", "danger");
      } else {
        if (statusEl) {
          statusEl.textContent = "Test email request accepted — status: " + message.status + ".";
          statusEl.className = "profile-edit-message success";
        }
        App.app.toast("Test email request sent.", "success");
      }
      await loadHistory(pane, state);
    } catch (err) {
      const code = err && err.code;
      if (code === "provider_ambiguous" || code === "request_ambiguous") {
        // Preserve the SAME key — delivery may already have happened,
        // whether the ambiguity was on the provider side or was a
        // browser-to-Edge transport failure.
        state.activeAttempt = { templateId, idempotencyKey };
      } else if (code !== "send_in_progress" && code !== "rate_limited") {
        // A definitive rejection before any provider call (validation,
        // suppression, sender/template problems, provider not
        // configured, etc.) — nothing to retry with this same key.
        state.activeAttempt = null;
      }
      // send_in_progress/rate_limited: leave state.activeAttempt exactly
      // as it was — still safely retryable once the wait is over.
      const friendly = friendlyTestSendError(code, err);
      if (statusEl) { statusEl.textContent = friendly; statusEl.className = "profile-edit-message error"; }
      App.app.toast(friendly, "danger");
    } finally {
      state.sending = false;
      // Update just the button's enabled state/label to reflect the
      // (possibly changed) activeAttempt, WITHOUT rebuilding #epTestBody —
      // a full renderTestCard() would discard the status message just
      // shown above.
      const currentSelect = el.querySelector("#epTestTemplate");
      const stillPending = !!(state.activeAttempt && currentSelect && state.activeAttempt.templateId === currentSelect.value);
      sendBtn.disabled = false;
      sendBtn.textContent = stillPending ? "Retry Test Email (same request)" : "Send Test Email";
    }
  }

  function friendlyTestSendError(code, err) {
    const retrySuffix = (err && typeof err.retryAfterSeconds === "number" && err.retryAfterSeconds > 0)
      ? " (about " + Math.max(1, Math.ceil(err.retryAfterSeconds / 60)) + " minute(s))."
      : ".";
    const map = {
      authentication_required: "Please sign in again to send a test email.",
      sender_profile_incomplete: "Your sender profile is incomplete — save a valid display name and Reply-To email first.",
      sender_profile_disabled: "Enable test sending in your sender profile first.",
      template_not_found: "That template could not be found.",
      template_inactive: "That template is no longer active.",
      invalid_template: "This template's saved subject or body isn't valid for sending — review and fix it on the Email Templates page.",
      suppressed_recipient: "This address is currently suppressed (a previous bounce, complaint, or provider suppression) and cannot receive a test email.",
      provider_not_configured: "Email sending isn't fully connected yet — email delivery still needs to be set up for this workspace. This page is ready and will work once that's done.",
      rate_limited: "Too many test sends recently — please wait before trying again" + retrySuffix,
      send_in_progress: "A previous attempt for this template is still being confirmed — please wait a moment" + retrySuffix,
      provider_ambiguous: "The delivery result could not be confirmed. Retry safely with the same request key.",
      request_ambiguous: "The delivery result could not be confirmed. Retry safely with the same request key.",
      provider_timeout: "The email provider did not respond in time. Please try again.",
      provider_error: "The email provider returned an error. Please try again shortly.",
      invalid_request: "That request could not be validated."
    };
    if (code && Object.prototype.hasOwnProperty.call(map, code)) return map[code];
    return "Could not send the test email: " + ((err && err.message) || "Unknown error");
  }

  /* ============================================================
   * TEST HISTORY
   * ========================================================== */

  async function loadHistory(pane, state) {
    try {
      state.history = await S().testEmail.listRecent({ limit: 20 });
      state.historyError = null;
    } catch (err) {
      state.historyError = (err && err.message) ? err.message : "Unknown error";
    }
    renderHistory(pane, state);
  }

  function renderHistory(pane, state) {
    const el = pane.querySelector("#epHistoryBody");
    if (!el) return;

    if (state.historyError) {
      el.innerHTML = `
        <div class="empty-state" role="alert">
          <div class="empty-title">Could not load test history</div>
          <div class="empty-desc">${U().esc(state.historyError)}</div>
          <button type="button" class="btn btn-primary" id="epHistoryRetry">Retry</button>
        </div>`;
      el.querySelector("#epHistoryRetry").addEventListener("click", () => loadHistory(pane, state));
      return;
    }
    if (!state.history.length) {
      el.innerHTML = `<div class="empty-state"><div class="empty-title">No test sends yet</div><div class="empty-desc">Send a test email above to see its delivery status here.</div></div>`;
      return;
    }

    el.innerHTML = `<div style="overflow-x:auto"><div class="release-library-grid">${state.history.map(renderHistoryCard).join("")}</div></div>`;
  }

  function renderHistoryCard(m) {
    const detailParts = [];
    if (m.bounced_at) detailParts.push("Bounced " + U().esc(formatTimestamp(m.bounced_at)));
    if (m.complained_at) detailParts.push("Complaint " + U().esc(formatTimestamp(m.complained_at)));
    if (m.suppressed_at) detailParts.push("Suppressed " + U().esc(formatTimestamp(m.suppressed_at)));
    if (m.error_code || m.error_message) {
      detailParts.push("Error: " + U().esc(m.error_code || "") + (m.error_message ? " — " + U().esc(m.error_message) : ""));
    }
    return `
      <article class="card release-library-card">
        <div class="card-body">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:space-between">
            <h3 style="margin:0;word-break:break-word">${U().esc(m.subject || "(no subject)")}</h3>
            ${statusBadge(m.status)}
          </div>
          <div class="form-help" style="margin:6px 0 2px">To: ${maskEmail(m.recipient)}</div>
          <div class="form-help">From: ${U().esc(m.sender_display_name || "")} &lt;${U().esc(m.sender_address || "pending")}&gt;</div>
          <div class="form-help" style="margin-top:6px">Queued ${U().esc(formatTimestamp(m.queued_at))}${m.sent_at ? " · Sent " + U().esc(formatTimestamp(m.sent_at)) : ""}${m.delivered_at ? " · Delivered " + U().esc(formatTimestamp(m.delivered_at)) : ""}</div>
          ${detailParts.length ? `<div class="release-callout release-callout-warning" style="margin-top:8px"><p style="margin:0">${detailParts.join(" · ")}</p></div>` : ""}
          ${m.provider_message_id ? `<div class="form-help" style="margin-top:6px;word-break:break-all">Provider reference: ${U().esc(m.provider_message_id)}</div>` : ""}
        </div>
      </article>`;
  }

  return { render };
})();
