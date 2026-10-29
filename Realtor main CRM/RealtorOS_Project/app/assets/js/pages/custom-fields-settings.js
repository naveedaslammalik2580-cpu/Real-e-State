/* ============================================================
   customFieldsSettings.js — Settings → Custom Fields management.
   One tab per supported entity (Contacts/Properties/Deals/Tasks).
   Writes through App.store.customFields.* exclusively.
   ============================================================ */
window.App = window.App || {};
App.pages = App.pages || {};
App.pages.customFieldsSettings = (function () {
  "use strict";
  const S = () => App.store;
  const U = () => App.util;

  const ENTITY_LABELS = { contact: "Contacts", property: "Properties", deal: "Deals", task: "Tasks" };
  const TYPE_LABELS = {
    text: "Short Text", longtext: "Long Text", number: "Number", currency: "Currency",
    percentage: "Percentage", date: "Date", boolean: "Yes / No", select: "Dropdown", multiselect: "Multi-Select"
  };
  let activeEntity = "contact";

  // Local, synchronous count helpers reading the already-loaded
  // customFieldValues cache (see render()'s ensureLoaded call) instead of
  // App.store.customFields.countValues/countOptionUsage, which each await a
  // fresh D().list() — unnecessary here since render() just loaded it.
  function countValuesSync(fieldId) {
    return S().getState().customFieldValues.filter(v => v.fieldId === fieldId).length;
  }
  function countOptionUsageSync(fieldId, optionId) {
    return S().getState().customFieldValues.filter(v => v.fieldId === fieldId && (Array.isArray(v.value) ? v.value.indexOf(optionId) !== -1 : v.value === optionId)).length;
  }

  async function render(root) {
    if (!root) return;
    root.innerHTML = App.app.loadingHtml ? App.app.loadingHtml() : "";
    await S().ensureLoaded(["customFieldValues"]);
    const entities = S().customFields.ENTITIES;
    const defs = S().customFields.definitionsFor(activeEntity);

    const tabsHtml = entities.map(e => `<button type="button" class="btn btn-sm ${e===activeEntity?"btn-primary":""}" data-cf-tab="${e}">${U().esc(ENTITY_LABELS[e])}</button>`).join("");

    const rowsHtml = defs.length ? defs.map((f, i) => {
      const usage = countValuesSync(f.id);
      const optionsHtml = (f.type === "select" || f.type === "multiselect") ? `
        <div class="cf-options" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">
          ${f.options.map(o => `<span class="badge badge-neutral" style="display:inline-flex;align-items:center;gap:5px">${U().esc(o.label)}<button type="button" class="btn-icon" data-cf-opt-del="${U().esc(f.id)}::${U().esc(o.id)}" title="Delete option" style="border:none;background:none;cursor:pointer;color:var(--muted-text)">✕</button></span>`).join("")}
          <span style="display:inline-flex;gap:4px">
            <input type="text" data-cf-opt-new="${U().esc(f.id)}" placeholder="Add option…" style="width:120px;padding:3px 6px;font-size: var(--font-size-xs)">
            <button type="button" class="btn btn-sm" data-cf-opt-add="${U().esc(f.id)}">+</button>
          </span>
        </div>` : "";
      return `
        <div class="release-maintenance" data-cf-row="${U().esc(f.id)}" style="align-items:flex-start;flex-wrap:wrap">
          <div style="flex:1;min-width:220px">
            <strong>${U().esc(f.label)}</strong> <button type="button" class="btn-icon" data-cf-rename="${U().esc(f.id)}" title="Rename field" style="border:none;background:none;cursor:pointer;color:var(--text-muted);padding:2px">${App.app.icon("edit")}</button>
            <span class="badge badge-neutral">${U().esc(TYPE_LABELS[f.type] || f.type)}</span>
            ${f.required ? '<span class="badge badge-neutral">Required</span>' : ""}
            ${f.active === false ? '<span class="badge badge-neutral">Inactive</span>' : ""}
            <div class="form-help" style="margin:2px 0 0">Appears on: ${U().esc(ENTITY_LABELS[activeEntity])}${f.helpText ? " · " + U().esc(f.helpText) : ""} · ${usage} record${usage===1?"":"s"} using this field</div>
            ${optionsHtml}
          </div>
          <span style="display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap">
            <button class="btn btn-sm" data-cf-up="${U().esc(f.id)}" ${i===0?"disabled":""} aria-label="Move up">↑</button>
            <button class="btn btn-sm" data-cf-down="${U().esc(f.id)}" ${i===defs.length-1?"disabled":""} aria-label="Move down">↓</button>
            <button class="btn btn-sm" data-cf-toggle="${U().esc(f.id)}">${f.active === false ? "Reactivate" : "Deactivate"}</button>
            <button class="btn btn-sm btn-danger" data-cf-del="${U().esc(f.id)}">Delete</button>
          </span>
        </div>`;
    }).join("") : `<p class="form-help">No custom fields on ${U().esc(ENTITY_LABELS[activeEntity])} yet. Add one below.</p>`;

    root.innerHTML = `
      <section class="card"><div class="card-header"><div class="card-title">Custom Fields</div></div>
        <div class="card-body">
          <p class="form-help" style="margin-top:0">Add your own fields to Contacts, Properties, Deals, or Tasks — things like Referral Fee, Property Type, or Lead Source. They show up on that record's form automatically. Deactivating a field hides it without losing any data already entered; deleting it permanently removes its recorded values too.</p>
          <div style="display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap">${tabsHtml}</div>
          <div id="cfRows">${rowsHtml}</div>
          <hr style="border:none;border-top:1px solid var(--border);margin:16px 0">
          <div class="form-grid">
            <label class="field"><span>Field Name</span><input id="cfNewLabel" placeholder="e.g. Referral Fee"></label>
            <label class="field"><span>Type</span><select id="cfNewType">${S().customFields.TYPES.map(t => `<option value="${t}">${U().esc(TYPE_LABELS[t])}</option>`).join("")}</select></label>
            <label class="field"><span>Required?</span><select id="cfNewRequired"><option value="">Optional</option><option value="1">Required</option></select></label>
          </div>
          <div class="form-grid" id="cfNewOptionsWrap" style="display:none">
            <label class="field full"><span>Options (one per line)</span><textarea id="cfNewOptions" rows="3" placeholder="e.g.\nCondo\nSingle Family\nTownhouse"></textarea></label>
          </div>
          <label class="field"><span>Help text (optional)</span><input id="cfNewHelp" placeholder="Shown under the field on the form"></label>
          <button class="btn btn-primary" id="cfAddBtn" style="margin-top:8px">+ Add Field to ${U().esc(ENTITY_LABELS[activeEntity])}</button>
        </div>
      </section>`;

    root.querySelectorAll("[data-cf-tab]").forEach(b => b.addEventListener("click", () => { activeEntity = b.getAttribute("data-cf-tab"); render(root); }));

    const typeSel = root.querySelector("#cfNewType");
    const optWrap = root.querySelector("#cfNewOptionsWrap");
    const syncOptWrap = () => { optWrap.style.display = (typeSel.value === "select" || typeSel.value === "multiselect") ? "" : "none"; };
    typeSel.addEventListener("change", syncOptWrap);
    syncOptWrap();

    root.querySelector("#cfAddBtn").onclick = async () => {
      const label = root.querySelector("#cfNewLabel").value.trim();
      if (!label) { App.app.toast("Enter a name for the field.", "danger"); return; }
      const btn = root.querySelector("#cfAddBtn"); btn.disabled = true;
      const type = typeSel.value;
      const options = root.querySelector("#cfNewOptions").value.split("\n").map(s => s.trim()).filter(Boolean);
      try {
        const field = await S().customFields.define(activeEntity, {
          label, type,
          required: root.querySelector("#cfNewRequired").value === "1",
          helpText: root.querySelector("#cfNewHelp").value.trim(),
          options
        });
        if (!field) { App.app.toast("Could not add field — that name may already be in use, or options are missing for a dropdown type.", "danger"); btn.disabled = false; return; }
        App.app.toast(`Added "${field.label}" to ${ENTITY_LABELS[activeEntity]}.`, "success");
        await render(root);
      } catch (err) {
        App.app.toast("Could not add field: " + err.message, "danger");
        btn.disabled = false;
      }
    };

    root.querySelectorAll("[data-cf-toggle]").forEach(b => b.addEventListener("click", async () => {
      const id = b.getAttribute("data-cf-toggle");
      const f = S().customFields.getDefinition(id);
      b.disabled = true;
      try {
        const ok = await S().customFields.setActive(id, f.active === false);
        if (!ok) { App.app.toast("Could not update field.", "danger"); b.disabled = false; return; }
        await render(root);
      } catch (err) {
        App.app.toast("Could not update field: " + err.message, "danger");
        b.disabled = false;
      }
    }));

    root.querySelectorAll("[data-cf-up]").forEach(b => b.addEventListener("click", () => moveField(root, b.getAttribute("data-cf-up"), -1)));
    root.querySelectorAll("[data-cf-down]").forEach(b => b.addEventListener("click", () => moveField(root, b.getAttribute("data-cf-down"), 1)));

    root.querySelectorAll("[data-cf-del]").forEach(b => b.addEventListener("click", () => {
      const id = b.getAttribute("data-cf-del");
      const f = S().customFields.getDefinition(id);
      const usage = countValuesSync(id);
      App.app.confirmDialog({
        title: "Delete this custom field?",
        message: usage > 0
          ? `"${U().esc(f.label)}" has data recorded on ${usage} record${usage===1?"":"s"}. Deleting it permanently removes that field and all ${usage} value${usage===1?"":"s"}. This cannot be undone.`
          : `"${U().esc(f.label)}" has no recorded data yet. This cannot be undone.`,
        okLabel: "Delete field",
        danger: true
      }, async () => {
        try {
          const ok = await S().customFields.deleteDefinition(id, { force: true });
          if (!ok) { App.app.toast("Could not delete field.", "danger"); return; }
          App.app.toast("Field deleted.", "success");
          await render(root);
        } catch (err) {
          App.app.toast("Could not delete field: " + err.message, "danger");
        }
      });
    }));

    root.querySelectorAll("[data-cf-opt-add]").forEach(b => b.addEventListener("click", async () => {
      const fieldId = b.getAttribute("data-cf-opt-add");
      const input = root.querySelector(`[data-cf-opt-new="${cssAttr(fieldId)}"]`);
      const label = input.value.trim();
      if (!label) return;
      b.disabled = true;
      try {
        const ok = await S().customFields.addOption(fieldId, label);
        if (!ok) { App.app.toast("Could not add option — it may already exist.", "danger"); b.disabled = false; return; }
        await render(root);
      } catch (err) {
        App.app.toast("Could not add option: " + err.message, "danger");
        b.disabled = false;
      }
    }));

    root.querySelectorAll("[data-cf-opt-del]").forEach(b => b.addEventListener("click", async () => {
      const [fieldId, optionId] = b.getAttribute("data-cf-opt-del").split("::");
      const usage = countOptionUsageSync(fieldId, optionId);
      if (usage > 0) { App.app.toast(`Cannot delete: ${usage} record(s) still use this option.`, "danger"); return; }
      b.disabled = true;
      try {
        const ok = await S().customFields.deleteOption(fieldId, optionId);
        if (!ok) { App.app.toast("Could not delete option.", "danger"); b.disabled = false; return; }
        await render(root);
      } catch (err) {
        App.app.toast("Could not delete option: " + err.message, "danger");
        b.disabled = false;
      }
    }));

    // Inline rename field
    root.querySelectorAll("[data-cf-rename]").forEach(b => b.addEventListener("click", () => {
      const fieldId = b.getAttribute("data-cf-rename");
      const f = S().customFields.getDefinition(fieldId);
      if (!f) return;
      const strong = b.previousElementSibling || b.closest("[data-cf-row]").querySelector("strong");
      const oldLabel = f.label;
      const inp = document.createElement("input");
      inp.value = oldLabel;
      inp.style.cssText = "font-size: var(--font-size-sm);font-weight:600;padding:3px 6px;border:1px solid var(--accent);border-radius: var(--radius-xs);width:180px";
      strong.replaceWith(inp);
      b.style.display = "none";
      inp.focus();
      inp.select();
      const save = async () => {
        const newLabel = inp.value.trim();
        if (newLabel && newLabel !== oldLabel) {
          try {
            const ok = await S().customFields.update(fieldId, { label: newLabel });
            if (ok) App.app.toast("Field renamed.", "success");
            else App.app.toast("Could not rename field.", "danger");
          } catch (err) {
            App.app.toast("Could not rename field: " + err.message, "danger");
          }
        }
        await render(root);
      };
      inp.addEventListener("blur", save);
      inp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); save(); } });
    }));
  }

  async function moveField(root, id, dir) {
    const defs = S().customFields.definitionsFor(activeEntity).map(f => f.id);
    const i = defs.indexOf(id), j = i + dir;
    if (i < 0 || j < 0 || j >= defs.length) return;
    const tmp = defs[i]; defs[i] = defs[j]; defs[j] = tmp;
    try {
      const ok = await S().customFields.reorder(activeEntity, defs);
      if (!ok) { App.app.toast("Could not reorder fields.", "danger"); return; }
      await render(root);
    } catch (err) {
      App.app.toast("Could not reorder fields: " + err.message, "danger");
    }
  }

  // CSS.escape isn't universally available in every target browser this
  // product supports; field ids are our own uid() output so a light manual
  // escape is enough (defensive, not exhaustive).
  function cssAttr(s) { return String(s).replace(/"/g, '\\"'); }

  return { render };
})();
