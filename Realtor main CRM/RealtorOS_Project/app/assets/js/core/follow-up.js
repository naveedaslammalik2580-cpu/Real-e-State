/* ============================================================
   follow-up.js — one-tap call / text / WhatsApp / email, and the
   quick log that records what happened.

   NOTHING HERE SENDS ANYTHING. Every button is a link that hands the
   conversation to an app the agent already has on their phone: the
   dialler, their SMS app, WhatsApp, their mail client. RealtorOS does not
   deliver the message, does not see it, and does not know whether it was
   read. That is the whole point of this phase — no SMS or WhatsApp
   account, no per-message cost, no new provider to configure.

   The only thing RealtorOS records is what the agent tells it afterwards
   through the quick log: an activity, the contact's last-contact date, and
   when to come back. All three go through App.store like every other
   write in the app.

   Used by the Today screen (pages/release.js renderDaily) and by the
   contact detail page (pages/contacts.js renderDetail).
   ============================================================ */
window.App = window.App || {};

App.followUp = (function () {
  "use strict";

  const U = () => App.util;
  const S = () => App.store;

  // What the agent is telling us happened. `channel` decides the activity
  // type, so a logged call reads as a call in the timeline.
  const OUTCOMES = [
    { id: "reached",   label: "Reached",         type: "Call",  outcome: "Reached" },
    { id: "voicemail", label: "Left voicemail",  type: "Call",  outcome: "Left voicemail" },
    { id: "no_answer", label: "No answer",       type: "Call",  outcome: "No answer" },
    { id: "messaged",  label: "Sent message",    type: "Note",  outcome: "Sent message" },
    { id: "emailed",   label: "Sent email",      type: "Email", outcome: "Sent email" }
  ];

  // Which outcome a button suggests, so the log opens on the likely answer
  // rather than making the agent pick twice.
  const CHANNEL_DEFAULT_OUTCOME = {
    call: "reached", sms: "messaged", whatsapp: "messaged", email: "emailed"
  };

  const NEXT_CHOICES = [
    { id: "tomorrow", label: "Tomorrow",   days: 1 },
    { id: "d3",       label: "In 3 days",  days: 3 },
    { id: "w1",       label: "In 1 week",  days: 7 },
    { id: "w2",       label: "In 2 weeks", days: 14 },
    { id: "pick",     label: "Pick date",  days: null },
    { id: "none",     label: "None",       days: null }
  ];

  const byId = (list, id) => {
    // Own-property lookup only: never reach a prototype key like
    // "constructor" through an id that came from the DOM.
    for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  };

  /* ---------- PHONE NUMBERS ----------
   *
   * A contact's phone is free text, so it may be "(555) 123-4567",
   * "+971 50 123 4567" or "00971501234567". Three facts come out of it:
   *
   *   digits  the full international number, digits only, no plus. This is
   *           what wa.me needs.
   *   dial    what a dialler should receive, with a leading + when the
   *           country is known.
   *   known   whether a country code was actually established, either from
   *           the number itself or from the workspace default.
   *
   * If the number carries no country code and the workspace has not set a
   * default, the number is used exactly as typed — a local number dialled
   * from the agent's own phone usually just works, and inventing a country
   * code would be worse than leaving it alone.
   */
  function parsePhone(raw, defaultCountryCode) {
    const text = String(raw == null ? "" : raw).trim();
    if (!text) return { digits: "", dial: "", known: false, valid: false };

    const onlyDigits = (s) => String(s).replace(/[^0-9]/g, "");
    const cc = onlyDigits(defaultCountryCode);

    let digits;
    let known;
    if (/^\+/.test(text)) {
      digits = onlyDigits(text);
      known = true;
    } else if (/^00/.test(text)) {
      // 00 is the other way of writing +.
      digits = onlyDigits(text).replace(/^00/, "");
      known = true;
    } else {
      const local = onlyDigits(text);
      if (cc) {
        // A local number often starts with a trunk 0 ("050 123 4567");
        // that 0 is not part of the international form.
        digits = cc + local.replace(/^0+/, "");
        known = true;
      } else {
        digits = local;
        known = false;
      }
    }
    return {
      digits,
      dial: known && digits ? "+" + digits : digits,
      known,
      // Short enough to be a typo rather than a number worth offering.
      valid: digits.length >= 5
    };
  }

  const countryCode = () => {
    const s = (S().getState() && S().getState().settings) || {};
    return typeof s.defaultCountryCode === "string" ? s.defaultCountryCode : "";
  };

  const agentName = () => {
    const s = (S().getState() && S().getState().settings) || {};
    return (typeof s.agentName === "string" && s.agentName.trim()) ? s.agentName.trim() : "";
  };

  /* ---------- LINKS ----------
   * encodeURIComponent on every interpolated value: a message containing
   * "&body=" or a newline must travel as text, not as more URL.
   */
  function telUrl(contact, cc) {
    const p = parsePhone(contact && contact.phone, cc === undefined ? countryCode() : cc);
    return p.valid ? "tel:" + p.dial : "";
  }
  function smsUrl(contact, message, cc) {
    const p = parsePhone(contact && contact.phone, cc === undefined ? countryCode() : cc);
    if (!p.valid) return "";
    const body = String(message == null ? "" : message);
    // "?&body=" rather than "?body=". iOS historically wants the body as a
    // second-looking parameter and drops a plain "?body="; Android accepts
    // either. The empty first parameter is what makes one link work on both.
    return "sms:" + p.dial + (body ? "?&body=" + encodeURIComponent(body) : "");
  }
  function whatsappUrl(contact, message, cc) {
    const p = parsePhone(contact && contact.phone, cc === undefined ? countryCode() : cc);
    // wa.me takes digits only and will not accept a plus or spaces.
    if (!p.valid) return "";
    const body = String(message == null ? "" : message);
    return "https://wa.me/" + p.digits + (body ? "?text=" + encodeURIComponent(body) : "");
  }
  function mailtoUrl(contact, subject, body) {
    const email = String((contact && contact.email) || "").trim();
    if (!email) return "";
    const params = [];
    if (subject) params.push("subject=" + encodeURIComponent(String(subject)));
    if (body) params.push("body=" + encodeURIComponent(String(body)));
    // The address is encoded, then @ and + are put back: both are legal in
    // an address, both are what a mail client expects to see there, and
    // "pat+crm@example.com" turning into "pat%2Bcrm%40example.com" is the
    // kind of thing that makes a user think the link is broken. Everything
    // genuinely unsafe (spaces, quotes, ?, &) stays encoded. The subject and
    // body are query parameters and are left fully encoded.
    const addr = encodeURIComponent(email).replace(/%40/g, "@").replace(/%2B/gi, "+");
    return "mailto:" + addr + (params.length ? "?" + params.join("&") : "");
  }

  /* ---------- MERGE FIELDS ----------
   * The same four tags the email templates and the automation worker
   * support, and no others: an unknown tag is left exactly as written so
   * the agent can see it was not filled rather than finding a silent blank.
   */
  function mergeValues(contact) {
    const full = String((contact && contact.name) || "").trim();
    return {
      first_name: full ? full.split(/\s+/)[0] : "",
      full_name: full,
      email: String((contact && contact.email) || "").trim(),
      agent_name: agentName()
    };
  }
  function renderMerge(text, contact) {
    const values = mergeValues(contact);
    return String(text == null ? "" : text).replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (whole, tag) => {
      return Object.prototype.hasOwnProperty.call(values, tag) ? values[tag] : whole;
    });
  }

  /* ---------- THE BAR ----------
   * Rendered as markup so a list of 50 rows is one innerHTML rather than
   * 50 × 5 elements built one at a time. Every button is a <button>, not an
   * <a>: the URL is built at click time from the message the agent may have
   * just edited, and a button is what a screen reader should announce for
   * something that opens a dialog.
   */
  function availableChannels(contact) {
    const phone = parsePhone(contact && contact.phone, countryCode());
    const hasEmail = !!String((contact && contact.email) || "").trim();
    return { call: phone.valid, sms: phone.valid, whatsapp: phone.valid, email: hasEmail };
  }

  const CHANNEL_LABELS = {
    call: "Call", sms: "Text", whatsapp: "WhatsApp", email: "Email"
  };

  function barHtml(contact, opts) {
    opts = opts || {};
    const id = String((contact && contact.id) || "");
    const can = availableChannels(contact);
    const name = String((contact && contact.name) || "this contact");
    const btn = (channel) => can[channel]
      ? `<button type="button" class="btn btn-sm fu-btn" data-fu-action="${channel}" data-fu-id="${U().esc(id)}"
           aria-label="${U().esc(CHANNEL_LABELS[channel] + " " + name)}">${U().esc(CHANNEL_LABELS[channel])}</button>`
      : "";
    return `<div class="fu-bar" role="group" aria-label="${U().esc("Contact " + name)}">
      ${btn("call")}${btn("sms")}${btn("whatsapp")}${btn("email")}
      <button type="button" class="btn btn-sm fu-btn fu-btn-log" data-fu-action="log" data-fu-id="${U().esc(id)}"
        aria-label="${U().esc("Log an outcome for " + name)}">Log</button>
    </div>`;
  }

  /**
   * One delegated listener per container, however many bars it holds.
   * `onLogged` is called after a successful quick log so the caller can
   * refresh the row it owns.
   */
  function wireBar(root, opts) {
    if (!root || root.__fuWired) return;
    root.__fuWired = true;
    opts = opts || {};
    root.addEventListener("click", async (e) => {
      const el = e.target.closest("[data-fu-action]");
      if (!el || !root.contains(el)) return;
      const action = el.getAttribute("data-fu-action");
      const id = el.getAttribute("data-fu-id");
      // Re-read the contact at click time: the list may have been rendered
      // minutes ago and the contact may be gone.
      let contact = null;
      try { contact = await S().contacts.get(id); }
      catch (err) { App.app.toast("Could not load this contact.", "danger"); return; }
      if (!contact) { App.app.toast("This contact no longer exists.", "danger"); return; }

      if (action === "log") { openQuickLog(contact, opts); return; }
      if (action === "call") {
        openLink(telUrl(contact));
        openQuickLog(contact, Object.assign({}, opts, { channel: "call" }));
        return;
      }
      openMessagePicker(contact, action, opts);
    });
  }

  // A real navigation on a phone, and a recorded no-op in jsdom (which has
  // no navigation and would otherwise print "Not implemented" over the test
  // output). The href is never injected into markup, so there is nothing to
  // escape here.
  function openLink(url) {
    if (!url) return;
    App.followUp.lastOpened = url;
    try {
      if (typeof window.open === "function") {
        const w = window.open(url, "_blank");
        if (w) return;
      }
      window.location.href = url;
    } catch (e) { /* a blocked popup is not an error worth showing */ }
  }

  /* ---------- MESSAGE PICKER ----------
   * Text, WhatsApp and Email open this first: pick a template or start
   * blank, then edit before the app opens. The agent sends it themselves,
   * so they get the last word on what it says.
   */
  function openMessagePicker(contact, channel, opts) {
    opts = opts || {};
    const isEmail = channel === "email";
    let templates = [];
    const h = App.app.openModal({
      title: (isEmail ? "Email " : (channel === "sms" ? "Text " : "WhatsApp ")) + (contact.name || "contact"),
      wide: true,
      body: `
        <p class="form-help">RealtorOS does not send this. Your own ${isEmail ? "mail app" : "messaging app"} opens with the message ready, and you send it.</p>
        <div class="form-grid">
          <label class="field full"><span>Start from a template</span>
            <select id="fuTemplate"><option value="">Blank message</option></select>
          </label>
          ${isEmail ? `<label class="field full"><span>Subject</span><input id="fuSubject" maxlength="200"></label>` : ""}
          <label class="field full"><span>Message</span>
            <textarea id="fuBody" rows="6" maxlength="2000"></textarea>
          </label>
        </div>`,
      footer: `<button class="btn" data-role="cancel">Cancel</button>
               <button class="btn btn-primary" data-role="open">Open ${isEmail ? "mail app" : "app"}</button>`,
      onOpen: async (m) => {
        const sel = m.querySelector("#fuTemplate");
        const bodyEl = m.querySelector("#fuBody");
        const subjEl = m.querySelector("#fuSubject");
        m.querySelector('[data-role="cancel"]').onclick = () => h.close();

        try { templates = await S().messageTemplates.list({ orderBy: "name" }); }
        catch (err) { templates = []; }
        (templates || []).filter(t => t.is_active).forEach((t) => {
          const o = document.createElement("option");
          o.value = t.id;
          // textContent, not innerHTML: a template name is user text.
          o.textContent = t.name || "Untitled";
          sel.appendChild(o);
        });

        sel.addEventListener("change", () => {
          const t = (templates || []).find(x => x.id === sel.value);
          if (!t) { bodyEl.value = ""; if (subjEl) subjEl.value = ""; return; }
          bodyEl.value = renderMerge(t.body_text || "", contact);
          if (subjEl) subjEl.value = renderMerge(t.subject || "", contact);
        });

        m.querySelector('[data-role="open"]').onclick = () => {
          const body = bodyEl.value;
          const url = isEmail
            ? mailtoUrl(contact, subjEl ? subjEl.value : "", body)
            : (channel === "sms" ? smsUrl(contact, body) : whatsappUrl(contact, body));
          h.close();
          openLink(url);
          openQuickLog(contact, Object.assign({}, opts, { channel }));
        };
      }
    });
    return h;
  }

  /* ---------- QUICK LOG ----------
   * Two taps: what happened, and when to come back. Cancel writes nothing.
   */
  function openQuickLog(contact, opts) {
    opts = opts || {};
    const suggested = CHANNEL_DEFAULT_OUTCOME[opts.channel] || "reached";
    let outcomeId = suggested;
    let nextId = "none";

    const chip = (group, item, selected) =>
      `<button type="button" class="btn btn-sm fu-chip${selected ? " fu-chip-on" : ""}"
         data-fu-${group}="${U().esc(item.id)}" aria-pressed="${selected ? "true" : "false"}">${U().esc(item.label)}</button>`;

    const h = App.app.openModal({
      title: "Log this follow-up",
      wide: true,
      body: `
        <div class="form-grid">
          <fieldset class="field full" style="border:0;padding:0;margin:0">
            <legend style="font:inherit;padding:0">What happened?</legend>
            <div class="fu-chips" id="fuOutcomes">${OUTCOMES.map(o => chip("outcome", o, o.id === outcomeId)).join("")}</div>
          </fieldset>
          <label class="field full"><span>Note (optional)</span>
            <textarea id="fuNote" rows="3" maxlength="2000" placeholder="Anything worth remembering"></textarea>
          </label>
          <fieldset class="field full" style="border:0;padding:0;margin:0">
            <legend style="font:inherit;padding:0">Follow up again</legend>
            <div class="fu-chips" id="fuNext">${NEXT_CHOICES.map(n => chip("next", n, n.id === nextId)).join("")}</div>
            <input type="date" id="fuNextDate" class="fu-next-date" style="display:none;margin-top:8px" aria-label="Pick the next follow-up date">
          </fieldset>
        </div>`,
      footer: `<button class="btn" data-role="cancel">Cancel</button>
               <button class="btn btn-primary" data-role="save">Save</button>`,
      onOpen: (m) => {
        const dateEl = m.querySelector("#fuNextDate");
        const press = (container, group, id) => {
          container.querySelectorAll("[data-fu-" + group + "]").forEach((b) => {
            const on = b.getAttribute("data-fu-" + group) === id;
            b.classList.toggle("fu-chip-on", on);
            b.setAttribute("aria-pressed", on ? "true" : "false");
          });
        };
        m.querySelector("#fuOutcomes").addEventListener("click", (e) => {
          const b = e.target.closest("[data-fu-outcome]");
          if (!b) return;
          outcomeId = b.getAttribute("data-fu-outcome");
          press(m.querySelector("#fuOutcomes"), "outcome", outcomeId);
        });
        m.querySelector("#fuNext").addEventListener("click", (e) => {
          const b = e.target.closest("[data-fu-next]");
          if (!b) return;
          nextId = b.getAttribute("data-fu-next");
          press(m.querySelector("#fuNext"), "next", nextId);
          dateEl.style.display = nextId === "pick" ? "block" : "none";
          if (nextId === "pick" && !dateEl.value) dateEl.value = U().addDaysISO(U().todayISO(), 7);
          if (nextId === "pick") dateEl.focus();
        });

        m.querySelector('[data-role="cancel"]').onclick = () => h.close();
        const saveBtn = m.querySelector('[data-role="save"]');
        saveBtn.onclick = async () => {
          if (saveBtn.disabled) return;
          const chosen = byId(OUTCOMES, outcomeId) || OUTCOMES[0];
          const note = m.querySelector("#fuNote").value.trim();
          const today = U().todayISO();

          let nextFollowUp;
          const nextChoice = byId(NEXT_CHOICES, nextId);
          if (nextId === "pick") {
            if (!dateEl.value) { App.app.toast("Pick a date, or choose None.", "danger"); return; }
            nextFollowUp = dateEl.value;
          } else if (nextChoice && nextChoice.days != null) {
            nextFollowUp = U().addDaysISO(today, nextChoice.days);
          } else {
            nextFollowUp = null; // "None" leaves whatever is already set
          }

          saveBtn.disabled = true;
          try {
            await S().activities.create({
              type: chosen.type,
              date: U().nowISO(),
              contactId: contact.id,
              subject: chosen.outcome,
              outcome: chosen.outcome,
              notes: note
            });
            const patch = { lastContact: today };
            if (nextFollowUp) patch.nextFollowUp = nextFollowUp;
            await S().contacts.update(contact.id, patch);
            h.close();
            App.app.toast("Logged. " + (nextFollowUp
              ? "Next follow-up " + U().formatDate(nextFollowUp) + "."
              : "No new follow-up date set."), "success");
            if (typeof opts.onLogged === "function") await opts.onLogged(contact.id);
          } catch (err) {
            App.app.toast("Could not save: " + ((err && err.message) || "Unknown error"), "danger");
            saveBtn.disabled = false;
          }
        };
      }
    });
    return h;
  }

  return {
    OUTCOMES, NEXT_CHOICES,
    parsePhone, telUrl, smsUrl, whatsappUrl, mailtoUrl,
    renderMerge, mergeValues, availableChannels,
    barHtml, wireBar, openMessagePicker, openQuickLog,
    lastOpened: null
  };
})();
