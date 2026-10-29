/* ============================================================
   customFieldsUI.js — shared "Custom Fields" section renderer used by every
   record form (contacts/properties/deals/tasks). One implementation of
   field-type rendering, form-value collection, and required-field checking
   so each form integrates in a few lines instead of reimplementing this.
   Depends on: util.js, store.js.
   ============================================================ */
window.App = window.App || {};
App.customFieldsUI = (function () {
  "use strict";
  const U = () => App.util;
  const CF = () => App.store.customFields;

  // One <label class="field">…</label> block per active definition, matching
  // the visual language every other form field in this app already uses.
  function fieldInputHtml(def, currentValue) {
    const val = (currentValue === undefined || currentValue === null) ? def.defaultValue : currentValue;
    const name = `data-cf-input="${U().esc(def.id)}"`;
    // Inline-styled rather than relying on the ".form-field label .req" rule,
    // since this section is embedded inside both ".field"-style Settings
    // forms and ".form-field"-style record modals and must look right in both.
    const reqMark = def.required ? ' <span style="color:var(--danger);margin-left:2px">*</span>' : "";
    const help = def.helpText ? `<div class="form-help">${U().esc(def.helpText)}</div>` : "";
    let inputHtml;
    switch (def.type) {
      case "longtext":
        inputHtml = `<textarea ${name} rows="3">${U().esc(val || "")}</textarea>`;
        break;
      case "number":
        inputHtml = `<input type="number" step="any" ${name} value="${U().esc(val === "" || val === undefined ? "" : val)}">`;
        break;
      case "currency":
        inputHtml = `<input type="number" step="0.01" min="0" ${name} value="${U().esc(val === "" || val === undefined ? "" : val)}">`;
        break;
      case "percentage":
        inputHtml = `<input type="number" step="0.1" min="0" max="100" ${name} value="${U().esc(val === "" || val === undefined ? "" : val)}">`;
        break;
      case "date":
        inputHtml = `<input type="date" ${name} value="${U().esc(val || "")}">`;
        break;
      case "boolean":
        inputHtml = `<label style="display:flex;align-items:center;gap:8px;font-weight:400"><input type="checkbox" ${name} ${val ? "checked" : ""}> <span class="form-help" style="margin:0">${val ? "Yes" : "No"}</span></label>`;
        break;
      case "select":
        inputHtml = `<select ${name}><option value="">—</option>${(def.options || []).map(o =>
          `<option value="${U().esc(o.id)}" ${val === o.id ? "selected" : ""}>${U().esc(o.label)}</option>`).join("")}</select>`;
        break;
      case "multiselect": {
        const chosen = Array.isArray(val) ? val : [];
        inputHtml = `<div ${name} class="cf-multiselect" style="display:flex;flex-wrap:wrap;gap:10px">${(def.options || []).map(o =>
          `<label style="display:flex;align-items:center;gap:5px;font-weight:400"><input type="checkbox" value="${U().esc(o.id)}" ${chosen.indexOf(o.id) !== -1 ? "checked" : ""}> ${U().esc(o.label)}</label>`).join("") || '<span class="form-help">No options defined yet.</span>'}</div>`;
        break;
      }
      default: // text
        inputHtml = `<input type="text" ${name} value="${U().esc(val || "")}">`;
    }
    return `<label class="field"><span>${U().esc(def.label)}${reqMark}</span>${inputHtml}${help}</label>`;
  }

  // Renders the whole "Custom Fields" fieldset for one entity + (optional,
  // for edit forms) an existing record id. Returns "" when the entity has no
  // active custom fields yet, so forms never show an empty section.
  function renderSection(entity, recordId) {
    const defs = CF().activeDefinitionsFor(entity);
    if (!defs.length) return "";
    const rows = defs.map(def => {
      const cur = recordId ? CF().getValue(entity, recordId, def.id) : undefined;
      return fieldInputHtml(def, cur);
    }).join("");
    return `<div class="form-section-title" style="margin-top:18px">Custom Fields</div><div class="form-grid" data-cf-section="${U().esc(entity)}">${rows}</div>`;
  }

  // Reads every data-cf-input value currently in the DOM under `root` for
  // this entity's active definitions. Returns { fieldId: rawValue }.
  function collectValues(root, entity) {
    const out = {};
    CF().activeDefinitionsFor(entity).forEach(def => {
      if (def.type === "multiselect") {
        const wrap = root.querySelector(`[data-cf-input="${cssEscape(def.id)}"]`);
        if (!wrap) return;
        out[def.id] = Array.from(wrap.querySelectorAll('input[type="checkbox"]:checked')).map(cb => cb.value);
        return;
      }
      const el = root.querySelector(`[data-cf-input="${cssEscape(def.id)}"]`);
      if (!el) return;
      out[def.id] = def.type === "boolean" ? el.checked : el.value;
    });
    return out;
  }

  // Required-field check, mirroring how every other required field in this
  // app blocks submit (a toast naming what's missing), not a store-level block.
  function findMissingRequired(root, entity) {
    const values = collectValues(root, entity);
    return CF().activeDefinitionsFor(entity)
      .filter(def => def.required)
      .filter(def => {
        const v = values[def.id];
        if (def.type === "boolean") return false; // a checkbox is never "empty"
        if (def.type === "multiselect") return !Array.isArray(v) || v.length === 0;
        return v === undefined || v === null || String(v).trim() === "";
      })
      .map(def => def.label);
  }

  // Minimal CSS.escape polyfill — field ids are our own uid() output
  // (alphanumerics/underscores only) so this only needs to be defensive,
  // not exhaustive.
  function cssEscape(s) {
    return String(s).replace(/[^a-zA-Z0-9_\-]/g, ch => "\\" + ch);
  }

  return { renderSection, collectValues, findMissingRequired };
})();
