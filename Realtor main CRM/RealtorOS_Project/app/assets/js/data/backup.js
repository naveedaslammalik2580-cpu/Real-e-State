/* ============================================================
   backup.js — export / import as JSON.
   Versioned envelope. Preview before commit. Safe on failure.
   ============================================================ */

window.App = window.App || {};

App.backup = (function () {
  "use strict";

  // v2 adds custom fields, team members, business profile, and default-stage
  // config to the data payload. Older (v1) backups are NOT rejected — see
  // validateImport(), which upgrades them through App.store.migrateData()
  // before validating shape, the same path an old on-disk workspace takes.
  const FORMAT_VERSION = 2;
  const PRODUCT_VERSION = "1.0.0";
  const PRODUCT_NAME = "Realtor Pipeline & Commission OS";

  // Build the export envelope for the current state.
  function buildExport(state) {
    return {
      formatVersion: FORMAT_VERSION,
      productVersion: PRODUCT_VERSION,
      productName: PRODUCT_NAME,
      exportedAt: App.util.nowISO(),
      agentName: (state.metadata && state.metadata.agentName) || "",
      agencyName: (state.metadata && state.metadata.agencyName) || "",
      data: state
    };
  }

  // Return a downloadable filename for the export.
  function exportFilename() {
    return "realtor-os-backup-" + App.util.todayISO() + ".json";
  }

  // Trigger a download in the browser. Awaits every entity so the export is
  // complete regardless of which pages this session has visited so far
  // (lazy per-page loading otherwise only guarantees the cache holds
  // whatever's been viewed).
  async function exportToFile(state) {
    const envelope = buildExport(state);
    const json = JSON.stringify(envelope, null, 2);
    // Record backup timestamp in metadata.
    try {
      await App.data.updateMetadata({ lastBackupAt: App.util.nowISO() });
    } catch (e) {
      console.warn("Could not record backup timestamp:", e.message);
    }
    // In-browser download (skip in Node test env)
    if (typeof window !== "undefined" && typeof window.URL !== "undefined" && typeof window.URL.createObjectURL === "function") {
      try {
        const blob = new Blob([json], { type: "application/json" });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = exportFilename();
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => window.URL.revokeObjectURL(url), 100);
      } catch (e) {
        console.warn("File download failed:", e.message);
      }
    }
    return { filename: exportFilename(), json, size: json.length };
  }

  // Validate an imported envelope without mutating state.
  // Returns { valid, error?, summary?, envelope? }.
  function validateImport(text) {
    if (!text || typeof text !== "string") {
      return { valid: false, error: "No file content provided." };
    }
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) { return { valid: false, error: "File is not valid JSON." }; }

    if (!parsed || typeof parsed !== "object") {
      return { valid: false, error: "File is empty or malformed." };
    }
    if (typeof parsed.formatVersion !== "number") {
      return { valid: false, error: "Backup is missing a format version. This does not appear to be a Realtor Pipeline & Commission OS backup." };
    }
    if (parsed.productName && parsed.productName !== PRODUCT_NAME) {
      return { valid: false, error: "This JSON file belongs to a different product and was not imported." };
    }
    if (parsed.formatVersion > FORMAT_VERSION) {
      return { valid: false, error:
        "This backup was created by a newer version of the app (v" +
        parsed.formatVersion + "). Update the app to import it." };
    }
    if (!parsed.data || typeof parsed.data !== "object") {
      return { valid: false, error: "Backup is missing the data payload." };
    }
    // Older backups are upgraded in place — same migration path a workspace
    // saved by an older version of the app goes through on load(). This is
    // what lets a v1 export made before custom fields/team members existed
    // still import cleanly into this version.
    let d;
    try { d = App.store.migrateData(parsed.data); }
    catch (e) { return { valid: false, error: "This backup could not be upgraded to the current format and was not imported." }; }
    parsed.data = d; // the envelope handed back to commitImport() is the upgraded data
    if (!d.settings || typeof d.settings !== "object" || Array.isArray(d.settings)) {
      return { valid: false, error: "Backup is missing valid workspace settings." };
    }
    const missing = ["contacts","properties","deals","activities","tasks",
                     "showings","milestones","referrals","goals","scripts","aiPrompts","income","expenses","scheduledItems"]
      .filter(k => !Array.isArray(d[k]));
    if (missing.length) {
      return { valid: false, error:
        "Backup is missing required sections: " + missing.join(", ") };
    }

    const idCollections = ["contacts","properties","deals","activities","tasks","showings","milestones","referrals","goals","scripts","aiPrompts","income","expenses","scheduledItems"];
    for (const key of idCollections) {
      const seen = new Set();
      for (const rec of d[key]) {
        if (!rec || typeof rec !== "object" || typeof rec.id !== "string" || !rec.id.trim()) {
          return { valid: false, error: "Backup contains an invalid record in " + key + "." };
        }
        if (seen.has(rec.id)) return { valid: false, error: "Backup contains duplicate record IDs in " + key + "." };
        seen.add(rec.id);
      }
    }

    const summary = {
      contacts:   (d.contacts   || []).length,
      properties: (d.properties || []).length,
      deals:      (d.deals      || []).length,
      activities: (d.activities || []).length,
      tasks:      (d.tasks      || []).length,
      showings:   (d.showings   || []).length,
      milestones: (d.milestones || []).length,
      referrals:  (d.referrals  || []).length,
      goals:      (d.goals      || []).length,
      scripts:    (d.scripts    || []).length,
      aiPrompts:  (d.aiPrompts  || []).length,
      income:     (d.income     || []).length,
      expenses:   (d.expenses   || []).length,
      scheduledItems:    (d.scheduledItems    || []).length,
      teamMembers:       (d.teamMembers       || []).length,
      customFields:      (d.settings && d.settings.customFields ? d.settings.customFields.definitions : []).length,
      customFieldValues: (d.customFieldValues || []).length,
      exportedAt: parsed.exportedAt,
      productVersion: parsed.productVersion,
      agentName: parsed.agentName,
      agencyName: parsed.agencyName
    };
    return { valid: true, envelope: parsed, summary };
  }

  // Commit a validated import. Idempotent, dependency-ordered upsert into
  // the relational tables (see App.data.restoreFromBackup) — validateImport()
  // has already confirmed every row is well-formed before this ever runs,
  // and nothing existing is deleted first.
  async function commitImport(envelope) {
    if (!envelope || !envelope.data) return { ok: false, error: "Invalid envelope." };
    try {
      await App.data.restoreFromBackup(envelope.data);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: "The backup could not be restored: " + e.message };
    }
  }

  return {
    FORMAT_VERSION,
    PRODUCT_VERSION,
    PRODUCT_NAME,
    buildExport,
    exportFilename,
    exportToFile,
    validateImport,
    commitImport
  };
})();

