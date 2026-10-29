/* ============================================================
   quick-add.js — the "+" that is always there, and the paste box
   that fills it in.

   WHY IT IS NOT ON THE CONTACTS PAGE. Adding a contact is the one thing
   an agent does from anywhere: on a viewing, on a call, halfway through
   looking at a deal. Making them navigate to Contacts first is three taps
   and a lost train of thought, which is how leads end up on the back of
   an envelope. So the button lives in the shell: in the header on a
   desktop, and as a floating button on a phone, where the header is too
   crowded to carry it.

   WHAT IT IS NOT. It is not the Add Contact form. Six fields, the ones
   you have when somebody has just given you their number; everything else
   is edited later on the contact itself. A short form that gets used
   beats a complete one that does not.

   PASTE TO FILL. No AI, no network, no service: a handful of rules over
   the text the agent pasted. It only ever FILLS THE FIELDS - the agent
   reads them and presses Save. Nothing here saves on its own, because a
   parser that is right most of the time and silent about the rest would
   fill a workspace with half-right contacts.

   The parsing is deliberately separate from the DOM (extractFromText,
   findDuplicate) so it can be tested on real portal emails rather than
   through a form.
   ============================================================ */
window.App = window.App || {};

App.quickAdd = (function () {
  "use strict";

  const U = () => App.util;
  const S = () => App.store;

  /* ---------- PASTE TO FILL ----------
   * Three things are worth pulling out of a portal email: the email
   * address, the phone number and the name. Everything else (the
   * property, the message) is prose the agent will read anyway.
   */

  const EMAIL_RE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

  // Addresses that belong to the portal rather than to the lead. A
  // Zillow or Rightmove email always carries at least one of these, and
  // it is usually the FIRST address in the text, so without this the
  // parser would reliably fill in the wrong one.
  const NOISE_LOCAL_RE = /^(?:no-?reply|do-?not-?reply|donotreply|notification|notifications|notify|mailer|mail|postmaster|bounce|bounces|alert|alerts|auto|automated|system|support|info|help|team|hello|contact|admin|enquiries|inquiries|lead|leads|customerservice)$/i;
  const PORTAL_DOMAINS = [
    "zillow.com", "trulia.com", "realtor.com", "redfin.com", "homes.com",
    "rightmove.co.uk", "rightmove.com", "zoopla.co.uk", "onthemarket.com",
    "propertyfinder.ae", "bayut.com", "dubizzle.com"
  ];

  function isPortalAddress(email) {
    const at = email.indexOf("@");
    if (at < 0) return false;
    const local = email.slice(0, at);
    const domain = email.slice(at + 1).toLowerCase();
    if (NOISE_LOCAL_RE.test(local)) return true;
    return PORTAL_DOMAINS.some((d) => domain === d || domain.endsWith("." + d));
  }

  function extractEmail(text) {
    const all = String(text || "").match(EMAIL_RE) || [];
    const real = all.filter((e) => !isPortalAddress(e));
    // The lead's own address if there is one; otherwise whatever was
    // there, because being wrong in a field the agent can see and change
    // is better than leaving it empty with no explanation.
    const picked = real.length ? real[0] : (all[0] || "");
    return picked.replace(/[.,;:]+$/, "");
  }

  // A number is 7 to 15 digits with an optional +, which covers an
  // international number and a local one, and excludes the house numbers,
  // prices and years that also live in these emails.
  const PHONE_RE = /\+?\(?\d[\d\s().-]{5,}\d/g;
  const PHONE_LABEL_RE = /\b(?:phone|mobile|telephone|tel|cell|contact\s*number|number|call(?:\s*back)?\s*on)\b/i;
  const DATE_LIKE_RE = /^\d{4}-\d{1,2}-\d{1,2}$|^\d{1,2}[-.]\d{1,2}[-.]\d{2,4}$/;
  const MONEY_BEFORE_RE = /[£$€₹¥]\s*$/;

  function phoneCandidates(line) {
    const out = [];
    let m;
    PHONE_RE.lastIndex = 0;
    while ((m = PHONE_RE.exec(line))) {
      const raw = m[0].trim();
      const digits = raw.replace(/\D/g, "");
      if (digits.length < 7 || digits.length > 15) continue;
      if (DATE_LIKE_RE.test(raw)) continue;
      if (MONEY_BEFORE_RE.test(line.slice(0, m.index))) continue;
      out.push(raw.replace(/\s+/g, " "));
    }
    return out;
  }

  function extractPhone(text) {
    const lines = String(text || "").split(/\r?\n/);
    let firstAnywhere = "";
    for (const line of lines) {
      const found = phoneCandidates(line);
      if (!found.length) continue;
      // A labelled number wins wherever it is: "Mobile: 07700 900123" is
      // the number, even if a reference number came first.
      if (PHONE_LABEL_RE.test(line)) return found[0];
      if (!firstAnywhere) firstAnywhere = found[0];
    }
    return firstAnywhere;
  }

  // Words that start a line far more often than a name does.
  const NOT_A_NAME_FIRST_WORD = new Set([
    "hi", "hello", "dear", "thanks", "thank", "regards", "kind", "best",
    "sent", "from", "to", "subject", "date", "phone", "mobile", "tel",
    "email", "e-mail", "property", "address", "enquiry", "inquiry",
    "message", "lead", "view", "viewing", "reply", "call", "new", "please",
    "your", "you", "the", "this", "a", "an", "it", "we", "i", "unsubscribe"
  ]);
  const BRAND_WORDS = new Set([
    "zillow", "trulia", "realtor", "redfin", "rightmove", "zoopla",
    "onthemarket", "propertyfinder", "bayut", "dubizzle", "homes"
  ]);
  const NAME_PARTICLES = new Set([
    "van", "von", "der", "den", "de", "del", "della", "di", "da", "dos",
    "la", "le", "bin", "ibn", "al", "mc", "mac", "st"
  ]);
  const NAME_WORD_RE = /^[A-Z][A-Za-z'’À-ɏ-]*\.?$/;

  function looksLikeName(value, minWords) {
    const s = String(value || "").trim().replace(/[,;:.]+$/, "");
    if (s.length < 2 || s.length > 60) return false;
    if (/[@\d<>|/\\]/.test(s)) return false;
    const words = s.split(/\s+/);
    if (words.length < (minWords || 1) || words.length > 4) return false;
    if (NOT_A_NAME_FIRST_WORD.has(words[0].toLowerCase())) return false;
    if (words.some((w) => BRAND_WORDS.has(w.toLowerCase().replace(/[^a-z]/g, "")))) return false;
    return words.every((w) => NAME_WORD_RE.test(w) || NAME_PARTICLES.has(w.toLowerCase()));
  }

  function cleanNameValue(value) {
    // "Sarah Khan <sarah@example.com>" and "Sarah Khan (Buyer)" both
    // arrive from somewhere; the name is the part before the bracket.
    return String(value || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\([^)]*\)/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[,;:.]+$/, "");
  }

  const SIGN_OFF_RE = /^(?:kind regards|warm regards|best regards|many thanks|regards|thanks|thank you|cheers|sincerely|yours|best)[,!.]*$/i;

  function extractName(text, email, phone) {
    const raw = String(text || "");
    const lines = raw.split(/\r?\n/);

    // 1. An explicit label is the strongest thing there is.
    const strong = raw.match(/^[ \t>*-]*(?:full\s+name|contact\s+name|lead\s+name|client\s+name|name|client)\s*[:\-–]\s*(.+)$/im);
    if (strong) {
      const value = cleanNameValue(strong[1]);
      if (looksLikeName(value, 1)) return value;
    }

    // 2. The same thing said in a sentence, which is how it arrives in a
    //    text message rather than a portal template.
    const said = raw.match(/\b(?:my\s+name\s+is|name\s+is|this\s+is)\s+([^\n,.!?]+)/i);
    if (said) {
      const value = cleanNameValue(said[1]);
      if (looksLikeName(value, 1)) return value;
    }

    // 3. The sentence a portal opens with.
    const phrase = raw.match(/\b(?:new\s+(?:lead|enquiry|inquiry|message|contact)\s+from|lead\s+from|enquiry\s+from|inquiry\s+from|message\s+from|request\s+from)\s+([^\n,.!?]+)/i);
    if (phrase) {
      const value = cleanNameValue(phrase[1]);
      if (looksLikeName(value, 1)) return value;
    }
    const interested = raw.match(/^[ \t>*-]*([^\n]{2,60}?)\s+(?:is\s+interested|has\s+requested|would\s+like|wants|is\s+enquiring|is\s+inquiring)\b/im);
    if (interested) {
      const value = cleanNameValue(interested[1]);
      if (looksLikeName(value, 1)) return value;
    }

    // 4. A From: line, which on a portal email is often the portal itself
    //    - hence the brand check inside looksLikeName.
    const from = raw.match(/^[ \t>*-]*(?:from|sender)\s*[:\-–]\s*(.+)$/im);
    if (from) {
      const value = cleanNameValue(from[1]);
      if (looksLikeName(value, 1)) return value;
    }

    // 5. The line after a sign-off: "Kind regards,\nSarah Khan".
    for (let i = 0; i < lines.length - 1; i++) {
      if (!SIGN_OFF_RE.test(lines[i].trim())) continue;
      for (let j = i + 1; j < lines.length; j++) {
        const value = cleanNameValue(lines[j]);
        if (!value) continue;
        if (looksLikeName(value, 1)) return value;
        break;
      }
    }

    // 6. The signature: the nearest name-shaped line above the phone or
    //    the email, which is where a person's name sits in a message they
    //    typed themselves.
    const anchor = lines.findIndex((l) =>
      (email && l.indexOf(email) >= 0) || (phone && l.replace(/\s+/g, " ").indexOf(phone) >= 0));
    if (anchor >= 0) {
      for (let i = anchor; i >= 0 && i >= anchor - 4; i--) {
        const line = lines[i];
        // The anchor line itself may be "Sarah Khan sarah@example.com".
        const stripped = cleanNameValue(
          line.replace(EMAIL_RE, " ").replace(PHONE_RE, " "));
        if (!stripped) continue;
        if (looksLikeName(stripped, 2)) return stripped;
      }
    }

    return "";
  }

  /**
   * Everything the paste box could work out, as plain data. Nothing here
   * touches the DOM or saves anything - the caller fills the form with it
   * and the agent confirms.
   */
  function extractFromText(text) {
    const email = extractEmail(text);
    const phone = extractPhone(text);
    return { name: extractName(text, email, phone), email, phone };
  }

  /* ---------- DUPLICATES ----------
   * Two contacts with the same number are the same person often enough
   * that it is worth one question. Matching is on the last nine digits,
   * so "+44 7700 900123" and "07700 900123" are the same number - which
   * they are.
   */

  function phoneKey(value) {
    const digits = String(value == null ? "" : value).replace(/\D/g, "");
    if (digits.length < 7) return "";
    return digits.slice(-9);
  }

  function emailKey(value) {
    return String(value == null ? "" : value).trim().toLowerCase();
  }

  /** The first existing contact that looks like this one, or null. */
  function findDuplicate(contacts, candidate) {
    const wantEmail = emailKey(candidate && candidate.email);
    const wantPhone = phoneKey(candidate && candidate.phone);
    if (!wantEmail && !wantPhone) return null;
    return (contacts || []).find((c) => {
      if (!c) return false;
      if (wantEmail && emailKey(c.email) === wantEmail) return true;
      if (wantPhone && phoneKey(c.phone) === wantPhone) return true;
      return false;
    }) || null;
  }

  /* ---------- THE BUTTONS ---------- */

  const HEADER_ID = "quickAddBtn";
  const FAB_ID = "quickAddFab";

  /**
   * Puts the "+" in the header and the floating one on the page. Both
   * exist at every width; CSS decides which one is visible, so there is
   * no resize handler and no width to get wrong in a test.
   *
   * Idempotent: the shell is re-rendered on some paths and two "+"
   * buttons would be worse than none.
   */
  function mount(doc) {
    const d = doc || document;
    if (!d.getElementById(HEADER_ID)) {
      const btn = d.createElement("button");
      btn.type = "button";
      btn.id = HEADER_ID;
      btn.className = "quick-add-btn";
      btn.setAttribute("aria-label", "Add a contact");
      btn.title = "Add a contact";
      btn.textContent = "+";
      btn.addEventListener("click", () => open());
      const slot = d.getElementById("topActions");
      if (slot && slot.parentNode) slot.parentNode.insertBefore(btn, slot);
      else (d.querySelector("header") || d.body).appendChild(btn);
    }
    if (!d.getElementById(FAB_ID)) {
      const fab = d.createElement("button");
      fab.type = "button";
      fab.id = FAB_ID;
      fab.className = "quick-add-fab";
      fab.setAttribute("aria-label", "Add a contact");
      fab.title = "Add a contact";
      fab.textContent = "+";
      fab.addEventListener("click", () => open());
      d.body.appendChild(fab);
    }
  }

  /* ---------- THE FORM ---------- */

  const TYPE_FALLBACK = ["Buyer", "Seller", "Investor", "Referral Partner"];
  const SOURCE_FALLBACK = ["Referral", "Website", "Social Media", "Open House",
    "Past Client", "Cold Outreach", "Zillow / Portal", "Other"];

  function settingsList(key, fallback) {
    const s = (S() && S().getState && S().getState()) || {};
    const list = (s.settings && s.settings[key]) || null;
    return (Array.isArray(list) && list.length) ? list : fallback;
  }

  function options(values, selected) {
    return values.map((v) =>
      '<option value="' + U().esc(v) + '"' + (v === selected ? " selected" : "") + ">"
      + U().esc(v) + "</option>").join("");
  }

  function open(prefill) {
    prefill = prefill || {};
    const types = TYPE_FALLBACK;
    const sources = settingsList("leadSources", SOURCE_FALLBACK);

    // `h` is assigned after openModal returns, but openModal calls
    // onOpen before that - so the form gets a handle that reads it
    // lazily rather than the value, which does not exist yet.
    let h;
    h = App.app.openModal({
      title: "Add a contact",
      body: ''
        + '<form id="quickAddForm" novalidate>'
        + '  <div class="form-grid">'
        + '    <label class="field full"><span>Name</span>'
        + '      <input id="qaName" maxlength="120" value="' + U().esc(prefill.name || "") + '" required></label>'
        + '    <label class="field"><span>Phone</span>'
        + '      <input id="qaPhone" type="tel" maxlength="40" value="' + U().esc(prefill.phone || "") + '"></label>'
        + '    <label class="field"><span>Email</span>'
        + '      <input id="qaEmail" type="email" maxlength="200" value="' + U().esc(prefill.email || "") + '"></label>'
        + '    <label class="field"><span>Type</span><select id="qaType">' + options(types, "Buyer") + '</select></label>'
        + '    <label class="field"><span>Source</span><select id="qaSource">' + options(sources, sources[0]) + '</select></label>'
        + '    <label class="field full"><span>Note</span>'
        + '      <textarea id="qaNote" rows="2" maxlength="2000"></textarea></label>'
        + '    <fieldset class="field full" style="border:0;padding:0;margin:0">'
        + '      <legend style="font:inherit;padding:0">Paste a message</legend>'
        + '      <textarea id="qaPaste" rows="3" maxlength="8000"'
        + '        placeholder="Paste the portal email or text message here and the fields above fill in."></textarea>'
        + '      <p class="form-help" id="qaPasteNote" aria-live="polite">Nothing is saved until you press Save — check what it filled in first.</p>'
        + '    </fieldset>'
        + '  </div>'
        + '  <div id="qaDuplicate" hidden></div>'
        + '</form>',
      footer: '<button class="btn" data-role="cancel">Cancel</button>'
        + '<button class="btn btn-primary" data-role="save">Save</button>',
      onOpen: (m) => wireForm(m, { close: () => h.close() })
    });
    return h;
  }

  function wireForm(m, h) {
    const $ = (sel) => m.querySelector(sel);
    const nameEl = $("#qaName");
    const phoneEl = $("#qaPhone");
    const emailEl = $("#qaEmail");
    const pasteEl = $("#qaPaste");
    const noteEl = $("#qaPasteNote");
    const dupEl = $("#qaDuplicate");
    const saveBtn = m.querySelector('[data-role="save"]');
    m.querySelector('[data-role="cancel"]').onclick = () => h.close();

    // A field the agent has typed in is theirs; the paste box never
    // overwrites it. Everything else it may fill and re-fill as they
    // paste again.
    const edited = Object.create(null);
    [["name", nameEl], ["phone", phoneEl], ["email", emailEl]].forEach(([key, el]) => {
      if (el.value.trim()) edited[key] = true;
      el.addEventListener("input", () => { edited[key] = true; });
    });

    const fillFromPaste = () => {
      const text = pasteEl.value;
      if (!text.trim()) return;
      const found = extractFromText(text);
      const filled = [];
      [["name", nameEl, "name"], ["phone", phoneEl, "phone"], ["email", emailEl, "email"]]
        .forEach(([key, el, label]) => {
          if (edited[key] || !found[key]) return;
          el.value = found[key];
          filled.push(label);
        });
      // Said plainly, including when it found nothing: a paste box that
      // silently does nothing reads as broken.
      noteEl.textContent = filled.length
        ? "Filled in the " + filled.join(", ") + " from your paste. Check it, then press Save."
        : "Could not find a name, phone or email in that. Type them in above.";
    };
    // Both, because a paste event fires before the value lands in some
    // browsers and a drop or a keyboard paste is still a paste.
    pasteEl.addEventListener("paste", () => setTimeout(fillFromPaste, 0));
    pasteEl.addEventListener("input", fillFromPaste);

    // Enter saves, from any single-line field. Not from the two
    // textareas, where a newline is what Enter is for.
    m.querySelector("#quickAddForm").addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.target.tagName === "TEXTAREA") return;
      e.preventDefault();
      save();
    });

    let duplicateAccepted = false;

    function showDuplicate(existing) {
      // "them", not "her" or "him": this is somebody's real name and the
      // app has never been told their pronouns.
      dupEl.hidden = false;
      dupEl.className = "release-callout release-callout-warning";
      dupEl.style.marginTop = "12px";
      dupEl.innerHTML = '<strong>Looks like ' + U().esc(existing.name || "this contact")
        + ' is already here — open them instead?</strong>'
        + '<p style="margin:6px 0 0">'
        + (existing.email ? U().esc(existing.email) + " " : "")
        + (existing.phone ? U().esc(existing.phone) : "") + '</p>'
        + '<div style="display:flex;gap:8px;margin-top:8px">'
        + '<button type="button" class="btn btn-sm" data-role="qa-open-dup">Open '
        + U().esc(existing.name || "contact") + '</button>'
        + '<button type="button" class="btn btn-sm" data-role="qa-save-anyway">Save anyway</button>'
        + '</div>';
      dupEl.querySelector('[data-role="qa-open-dup"]').onclick = () => {
        h.close();
        App.app.navigate("/contacts/" + existing.id);
      };
      dupEl.querySelector('[data-role="qa-save-anyway"]').onclick = () => {
        duplicateAccepted = true;
        dupEl.hidden = true;
        save();
      };
    }

    async function save() {
      if (saveBtn.disabled) return;
      const name = nameEl.value.trim();
      if (!name) { App.app.toast("A name is the one thing this needs.", "danger"); return; }
      const email = emailEl.value.trim();
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        App.app.toast("That email address does not look right.", "danger"); return;
      }
      const phone = phoneEl.value.trim();

      if (!duplicateAccepted) {
        // Checked against the workspace, not against what happens to be
        // on screen, and before anything is written.
        let existing = null;
        try {
          await S().ensureLoaded(["contacts"]);
          existing = findDuplicate((S().getState() || {}).contacts, { email, phone });
        } catch (err) { existing = null; }
        if (existing) { showDuplicate(existing); return; }
      }

      saveBtn.disabled = true;
      try {
        const contact = await S().contacts.create({
          name,
          role: $("#qaType").value,
          email,
          phone,
          source: $("#qaSource").value,
          notes: $("#qaNote").value.trim()
        });
        h.close();
        savedToast(contact);
      } catch (err) {
        App.app.toast("Could not save: " + ((err && err.message) || "Unknown error"), "danger");
        saveBtn.disabled = false;
      }
    }

    saveBtn.onclick = save;
  }

  /**
   * The two things an agent does next, offered rather than navigated to.
   * "Log a call" is the Phase 2B quick log, unchanged - this is the same
   * sheet the Today screen opens.
   */
  function savedToast(contact) {
    App.app.toast("Added " + (contact.name || "contact") + ".", "success", {
      actions: [
        { label: "Open", onClick: () => App.app.navigate("/contacts/" + contact.id) },
        {
          label: "Log a call",
          onClick: () => App.followUp.openQuickLog(contact, { channel: "call" })
        }
      ]
    });
  }

  return {
    mount, open, extractFromText, findDuplicate,
    // Exported for the tests and for anybody who needs the same rules.
    phoneKey, emailKey, looksLikeName
  };
})();
