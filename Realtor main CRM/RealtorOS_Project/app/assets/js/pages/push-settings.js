/* ============================================================
   push-settings.js — Settings → Notifications.

   Three sections, in the order somebody needs them:

     1. This device. One button, and a sentence saying what the state
        actually is. The hard part of push is not the API, it is that
        there are six states and five of them need different words.
     2. My devices. Every browser that is subscribed, with Remove. A
        device somebody has lost, or a colleague's laptop they signed in
        on once, has to be removable from the phone in their hand.
     3. What and when. Plain names for the notification types, and quiet
        hours.

   EVERY TYPE NAME IS WRITTEN OUT HERE. The database's type strings
   ('contact_untouched') are not words anybody should be shown, and the
   list comes from the server so the two cannot drift: an unknown type
   is shown under its own id rather than hidden, because a notification
   nobody can switch off is worse than an ugly label.
   ============================================================ */
window.App = window.App || {};
App.pages = App.pages || {};

App.pages.pushSettings = (function () {
  "use strict";

  const U = () => App.util;
  const S = () => App.store;

  // The plain name for each type, and one line about when it happens.
  const TYPE_WORDS = {
    lead_replied:      ["A lead replies", "Somebody answers one of your emails."],
    hot_reply:         ["A reply looks hot", "A reply that reads like real interest."],
    unsubscribed:      ["Somebody unsubscribes", "A contact opts out of your emails."],
    spam_report:       ["An email is marked as spam", "Worth knowing quickly."],
    email_bounced:     ["An email bounces", "The address did not accept it."],
    import_finished:   ["An import finishes", "A Google Sheet or file import is done."],
    followup_failed:   ["A sequence step fails", "Something in an automation could not run."],
    contact_untouched: ["A new lead goes untouched", "Nobody has replied to them yet."],
    overdue_followups: ["Follow-ups are overdue", "Your daily summary of what is late."],
  };

  const STATE_WORDS = {
    not_configured: {
      line: "Phone notifications switch on when RealtorOS goes live.",
      help: "Everything else on this page is ready; the server just has no notification keys yet.",
    },
    ios_needs_install: {
      line: "On an iPhone or iPad, notifications work once RealtorOS is on your Home Screen.",
      help: "Tap Share, then Add to Home Screen, then open RealtorOS from the new icon and come back here. Needs iOS 16.4 or later.",
    },
    unsupported: {
      line: "This browser cannot show notifications.",
      help: "Chrome, Edge, Firefox and Safari all can. On iPhone, add RealtorOS to your Home Screen first.",
    },
    blocked: {
      line: "Notifications are blocked for RealtorOS in this browser.",
      help: "The browser will not ask again, so this one has to be changed in its own settings: open the padlock or the site settings next to the address and allow Notifications.",
    },
    on: {
      line: "Notifications are on for this device.",
      help: "You will get these even when RealtorOS is closed.",
    },
    off: {
      line: "Notifications are off for this device.",
      help: "Turn them on and your phone tells you when a lead replies, without RealtorOS being open.",
    },
  };

  function deviceRow(device) {
    const when = device.created_at ? U().formatDate(String(device.created_at).slice(0, 10)) : "";
    const failing = (device.failure_count || 0) >= 3;
    return `<li class="push-device">
      <div class="push-device-main">
        <strong>${U().esc(device.device_label || "A browser")}</strong>
        <span class="form-help">${U().esc(when ? "Added " + when : "")}${
          failing ? " · not accepting notifications lately" : ""}</span>
      </div>
      <button type="button" class="btn btn-sm" data-remove-device="${U().esc(device.id)}">Remove</button>
    </li>`;
  }

  function typeRow(type, checked) {
    const words = TYPE_WORDS[type] || [type, ""];
    return `<label class="push-type">
      <input type="checkbox" class="push-type-box" value="${U().esc(type)}" ${checked ? "checked" : ""}>
      <span><strong>${U().esc(words[0])}</strong>
      ${words[1] ? `<span class="form-help">${U().esc(words[1])}</span>` : ""}</span>
    </label>`;
  }

  async function render(pane) {
    if (!pane) return;
    pane.innerHTML = `
      <div class="settings-category-head">
        <div class="settings-category-title">Notifications</div>
        <p class="form-help">Get told when a lead replies, without having RealtorOS open.</p>
      </div>
      <div id="pushPanel">${App.app.loadingHtml ? App.app.loadingHtml("your notification settings") : ""}</div>`;
    await paint(pane);
  }

  async function paint(pane) {
    const panel = pane.querySelector("#pushPanel");
    if (!panel) return;

    const state = App.push ? await App.push.state(window) : "unsupported";
    const words = STATE_WORDS[state] || STATE_WORDS.unsupported;
    const live = state !== "not_configured";

    let devices = [];
    let prefs = null;
    if (live) {
      try { devices = await S().push.devices(); } catch (e) { devices = []; }
      try { prefs = await S().push.preferences(); } catch (e) { prefs = null; }
    }
    const allTypes = (prefs && prefs.all_types) || Object.keys(TYPE_WORDS);
    const chosen = (prefs && prefs.push_types) || allTypes;
    const pushEnabled = !prefs || prefs.push_enabled !== false;
    const quietStart = (prefs && prefs.quiet_start) ? String(prefs.quiet_start).slice(0, 5) : "";
    const quietEnd = (prefs && prefs.quiet_end) ? String(prefs.quiet_end).slice(0, 5) : "";

    panel.innerHTML = `
      <section class="card" id="pushDeviceCard">
        <div class="card-header"><div class="card-title">This device</div></div>
        <div class="card-body">
          <p id="pushStateLine"><strong>${U().esc(words.line)}</strong></p>
          <p class="form-help" id="pushStateHelp">${U().esc(words.help)}</p>
          ${state === "off" ? `<button type="button" class="btn btn-primary" id="pushEnableBtn">Turn on notifications on this device</button>` : ""}
          ${state === "on" ? `<button type="button" class="btn" id="pushDisableBtn">Turn off on this device</button>` : ""}
        </div>
      </section>

      ${live ? `
      <section class="card" id="pushDevicesCard">
        <div class="card-header"><div class="card-title">My devices</div></div>
        <div class="card-body">
          ${devices.length
            ? `<ul class="push-device-list" id="pushDeviceList">${devices.map(deviceRow).join("")}</ul>`
            : `<p class="form-help" id="pushNoDevices">No devices yet. Turn notifications on above and this one appears here.</p>`}
        </div>
      </section>

      <section class="card" id="pushPrefsCard">
        <div class="card-header"><div class="card-title">What and when</div></div>
        <div class="card-body">
          <label class="field" style="flex-direction:row;align-items:center;gap:10px">
            <span>Send notifications to my devices</span>
            <span class="toggle-switch"><input type="checkbox" id="pushEnabledToggle" ${pushEnabled ? "checked" : ""}><span class="toggle-track"></span></span>
          </label>
          <fieldset class="field" style="border:0;padding:0;margin:12px 0 0">
            <legend style="font:inherit;padding:0">Tell me when</legend>
            <div class="push-type-list" id="pushTypeList">
              ${allTypes.map((t) => typeRow(t, chosen.indexOf(t) >= 0)).join("")}
            </div>
          </fieldset>
          <fieldset class="field" style="border:0;padding:0;margin:12px 0 0">
            <legend style="font:inherit;padding:0">Quiet hours (optional)</legend>
            <p class="form-help">Nothing buzzes between these times. Anything that happens meanwhile arrives when they end — it is held, not dropped. Uses your workspace's time zone.</p>
            <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
              <label class="field" style="margin:0"><span>From</span>
                <input type="time" id="pushQuietStart" value="${U().esc(quietStart)}"></label>
              <label class="field" style="margin:0"><span>Until</span>
                <input type="time" id="pushQuietEnd" value="${U().esc(quietEnd)}"></label>
              <button type="button" class="btn btn-sm" id="pushQuietClear">Clear</button>
            </div>
          </fieldset>
          <div style="margin-top:14px">
            <button type="button" class="btn btn-primary" id="pushSavePrefs">Save</button>
          </div>
        </div>
      </section>` : ""}
    `;

    wire(pane, panel);
  }

  function wire(pane, panel) {
    const enable = panel.querySelector("#pushEnableBtn");
    if (enable) {
      enable.addEventListener("click", async () => {
        enable.disabled = true;
        const outcome = await App.push.enable(window);
        // Said in the words of what happened, because "failed" covers
        // four quite different things from the agent's side.
        if (outcome === "on") App.app.toast("Notifications are on for this device.", "success");
        else if (outcome === "blocked") App.app.toast("This browser has blocked notifications for RealtorOS. Allow them in its site settings and try again.", "danger");
        else if (outcome === "dismissed") App.app.toast("No change — the browser's permission box was closed.", "warning");
        else if (outcome === "not_configured") App.app.toast("Phone notifications switch on when RealtorOS goes live.", "warning");
        else App.app.toast("Could not turn notifications on for this device.", "danger");
        await paint(pane);
      });
    }

    const disable = panel.querySelector("#pushDisableBtn");
    if (disable) {
      disable.addEventListener("click", async () => {
        disable.disabled = true;
        const outcome = await App.push.disable(window);
        App.app.toast(outcome === "off"
          ? "Notifications are off for this device."
          : "Could not turn them off here — try again.", outcome === "off" ? "success" : "danger");
        await paint(pane);
      });
    }

    panel.querySelectorAll("[data-remove-device]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-remove-device");
        const devices = await S().push.devices().catch(() => []);
        const device = devices.find((d) => String(d.id) === id);
        if (!device) { await paint(pane); return; }
        btn.disabled = true;
        try {
          await S().push.remove(device.endpoint);
          // If it was this very browser, the browser's own subscription
          // has to go too, or it would re-appear on the next refresh.
          const mine = App.push ? await App.push.currentSubscription(window) : null;
          if (mine && mine.endpoint === device.endpoint) {
            try { await mine.unsubscribe(); } catch (e) { /* already gone */ }
          }
          App.app.toast("Device removed.", "success");
        } catch (e) {
          App.app.toast("Could not remove that device.", "danger");
        }
        await paint(pane);
      });
    });

    const clear = panel.querySelector("#pushQuietClear");
    if (clear) {
      clear.addEventListener("click", () => {
        panel.querySelector("#pushQuietStart").value = "";
        panel.querySelector("#pushQuietEnd").value = "";
      });
    }

    const save = panel.querySelector("#pushSavePrefs");
    if (save) {
      save.addEventListener("click", async () => {
        const start = panel.querySelector("#pushQuietStart").value;
        const end = panel.querySelector("#pushQuietEnd").value;
        if (!!start !== !!end) {
          App.app.toast("Quiet hours need both a start and an end.", "danger");
          return;
        }
        save.disabled = true;
        try {
          await S().push.savePreferences({
            pushEnabled: panel.querySelector("#pushEnabledToggle").checked,
            pushTypes: Array.from(panel.querySelectorAll(".push-type-box:checked")).map((c) => c.value),
            quietStart: start || null,
            quietEnd: end || null,
          });
          App.app.toast("Saved.", "success");
        } catch (e) {
          App.app.toast("Could not save: " + ((e && e.message) || "Unknown error"), "danger");
        }
        save.disabled = false;
      });
    }
  }

  return { render, TYPE_WORDS, STATE_WORDS };
})();
