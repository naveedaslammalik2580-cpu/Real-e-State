/* ============================================================
   lead-file.js — Import leads from an Excel / CSV file (Phase 4E.4).
   Pure logic, no page rendering: file checks, loading the parsers,
   reading the file, matching columns, checking rows and building the
   preview. The page (pages/lead-file-import.js) renders it; the actual
   import is App.store.leadFileImport.submit -> the import-lead-file Edge
   Function, which re-checks everything server-side.

   File contents are treated as untrusted: they are only ever held in
   memory for the length of one import, never written to localStorage,
   sessionStorage, IndexedDB, the URL or any log, and every value shown
   on screen is escaped by the caller.
   ============================================================ */

window.App = window.App || {};

App.leadFile = (function () {
  "use strict";

  const MAX_FILE_BYTES = 5 * 1024 * 1024;
  const MAX_ROWS = 500;
  const ROW_LIMIT_MESSAGE = "Files can have up to 500 rows. Split larger lists into several files.";
  const PREVIEW_ROWS = 20;
  const EXTENSIONS = [".xlsx", ".xls", ".csv"];

  // Parsers are loaded only when someone actually imports a file, from a
  // pinned exact version with a subresource-integrity hash (the browser
  // refuses the file if a single byte differs).
  //  * SheetJS 0.20.3 comes from SheetJS's own CDN: cdnjs only carries
  //    0.18.5, which has known vulnerabilities when reading untrusted
  //    files (CVE-2023-30533, CVE-2024-22363), fixed in 0.19.3 / 0.20.2.
  //  * Papa Parse 5.5.3 comes from cdnjs.
  const LIBRARIES = {
    xlsx: {
      global: "XLSX",
      src: "https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js",
      integrity: "sha384-EnyY0/GSHQGSxSgMwaIPzSESbqoOLSexfnSMN2AP+39Ckmn92stwABZynq1JyzdT"
    },
    papaparse: {
      global: "Papa",
      src: "https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.5.3/papaparse.min.js",
      integrity: "sha384-Jd2/X5FXVKahwaY2nivvw4LfSTg9idSj8yNXWtT4qef0fHSYr6M7M8bJAfbFYoMc"
    }
  };

  // What a column can be imported as. "" means "Don't import".
  const FIELDS = [
    { key: "full_name", label: "Full name" },
    { key: "first_name", label: "First name" },
    { key: "last_name", label: "Last name" },
    { key: "email", label: "Email" },
    { key: "phone", label: "Phone" },
    { key: "source", label: "Lead source" },
    { key: "notes", label: "Notes" },
    { key: "tags", label: "Tags" },
    { key: "budget", label: "Budget" },
    { key: "preferred_area", label: "Preferred area" },
    // Phase 2E. The deployed importer already reads `status`, so a Stage
    // column from another CRM lands where the agent expects it.
    { key: "status", label: "Stage" }
  ];

  // Phase 2E. Columns we RECOGNISE but cannot import, so the preview can
  // name them instead of leaving the agent to wonder why their data went
  // nowhere. import-lead-file is deployed and reads a fixed set of keys
  // (full_name, email, phone, type, status, source, temperature, budget,
  // preferred_area, notes, tags) - anything else it silently ignores, and
  // offering a mapping that silently does nothing would be worse than
  // saying so.
  const UNSUPPORTED_FIELDS = {
    birthday: "Birthday"
  };

  // Header spellings recognised automatically (compared after lowercasing
  // and removing everything but letters and digits: "E-mail" -> "email").
  const HEADER_SYNONYMS = {
    full_name: ["name", "fullname", "contactname", "clientname", "leadname", "contact", "client"],
    first_name: ["firstname", "first", "givenname", "fname", "forename"],
    last_name: ["lastname", "last", "surname", "familyname", "lname"],
    email: ["email", "emailaddress", "mail", "emailid", "primaryemail"],
    phone: ["phone", "phonenumber", "mobile", "mobilephone", "mobilenumber", "cell", "cellphone",
      "cellnumber", "telephone", "tel", "contactnumber", "phoneno", "primaryphone"],
    source: ["source", "leadsource", "howdidyouhear", "referralsource", "origin", "channel"],
    notes: ["notes", "note", "comments", "comment", "message", "remarks"],
    tags: ["tags", "tag", "labels", "label", "categories", "category"],
    budget: ["budget", "pricerange", "maxprice", "pricemax", "maxbudget"],
    preferred_area: ["area", "preferredarea", "location", "neighborhood", "neighbourhood", "city",
      "region", "preferredlocation"],
    // Phase 2E. "Stage" is what Follow Up Boss calls it, "Status" and
    // "Category" what most others do.
    status: ["stage", "status", "leadstatus", "contactstatus", "pipelinestage", "leadstage"],
    birthday: ["birthday", "birthdate", "dateofbirth", "dob", "bday"]
  };

  // Phase 2E. The numbered and prefixed spellings the big CRMs export.
  // Appended rather than inlined above so the generic names keep winning
  // when a file has both ("Email" is preferred over "Email 2").
  const EXPORT_SYNONYMS = {
    // Follow Up Boss: "First Name", "Emails", "Phones", "Background".
    email: ["email1", "emailaddress1", "emails", "emailprimary", "homeemail", "workemail",
      "email2", "emailaddress2", "personalemail"],
    phone: ["phone1", "phonenumber1", "phones", "mobile1", "cell1", "homephone", "workphone",
      "phone2", "mobilephone1", "primaryphonenumber"],
    notes: ["background", "description", "details", "additionalnotes", "generalnotes"],
    // Wise Agent: "Categories", "Referred By".
    source: ["referredby", "referral", "leadtype", "howtheyfoundyou"],
    tags: ["categories", "groups", "group", "lists", "list"],
    preferred_area: ["mailingcity", "homecity", "town"],
    status: ["ranking", "rating"]
  };

  // The shapes we can name, purely so the preview can tell the agent we
  // recognised their file. Detection is a courtesy, not a dependency: an
  // unrecognised export still maps column by column.
  const EXPORT_FORMATS = [
    { id: "followupboss", label: "Follow Up Boss",
      // Distinctive because no other export pairs "Background" with "Stage".
      signals: [["background", "stage"], ["emails", "phones"]] },
    { id: "wiseagent", label: "Wise Agent",
      signals: [["categories", "referredby"], ["categories", "ranking"]] },
    { id: "generic", label: "spreadsheet", signals: [] }
  ];

  const EMAIL_SHAPE =
    /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

  const REASONS = {
    missing_contact_channel: "Needs an email address or a phone number.",
    invalid_email: "The email address doesn't look right.",
    invalid_phone: "The phone number doesn't look right."
  };

  function extensionOf(name) {
    const m = /\.[^.]+$/.exec(String(name || "").toLowerCase());
    return m ? m[0] : "";
  }

  // Checked BEFORE the file is read at all.
  function checkFile(file) {
    if (!file) return { ok: false, reason: "Choose a file to import." };
    if (EXTENSIONS.indexOf(extensionOf(file.name)) === -1) {
      return { ok: false, reason: "Please choose an Excel (.xlsx, .xls) or CSV (.csv) file." };
    }
    if (!file.size) return { ok: false, reason: "That file is empty." };
    if (file.size > MAX_FILE_BYTES) {
      return { ok: false, reason: "That file is larger than 5 MB. Split it into smaller files and import them one at a time." };
    }
    return { ok: true, kind: extensionOf(file.name) === ".csv" ? "csv" : "excel" };
  }

  const loading = {};
  function loadLibrary(name) {
    const lib = LIBRARIES[name];
    if (window[lib.global]) return Promise.resolve(window[lib.global]);
    if (loading[name]) return loading[name];
    loading[name] = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = lib.src;
      script.setAttribute("integrity", lib.integrity);
      script.setAttribute("crossorigin", "anonymous");
      script.setAttribute("referrerpolicy", "no-referrer");
      script.async = true;
      script.onload = () => (window[lib.global] ? resolve(window[lib.global]) : reject(new Error("load_failed")));
      script.onerror = () => { delete loading[name]; reject(new Error("load_failed")); };
      document.head.appendChild(script);
    });
    return loading[name];
  }

  function cellText(value) {
    if (value === null || value === undefined) return "";
    return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  }
  function tidyRows(rows) {
    return (rows || []).map((r) => (Array.isArray(r) ? r : []).map(cellText));
  }

  function parseCsvText(text, Papa) {
    const out = Papa.parse(String(text || "").replace(/^﻿/, ""), { skipEmptyLines: "greedy" });
    return [{ name: "Sheet 1", rows: tidyRows(out.data) }];
  }

  // Every sheet of a workbook as rows of text. Formulas are never
  // evaluated (SheetJS reads the stored values) and cell HTML is ignored.
  function parseWorkbook(data, XLSX) {
    const wb = XLSX.read(data, { type: "array", cellHTML: false, cellFormula: false, cellStyles: false, dense: true });
    return wb.SheetNames.map((name) => ({
      name: cellText(name) || "Sheet",
      rows: tidyRows(XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: "", blankrows: false }))
    }));
  }

  // Blob.text()/arrayBuffer() where available, FileReader otherwise.
  function readBlob(file, as) {
    if (as === "text" && typeof file.text === "function") return file.text();
    if (as === "buffer" && typeof file.arrayBuffer === "function") return file.arrayBuffer();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("read_failed"));
      if (as === "text") reader.readAsText(file);
      else reader.readAsArrayBuffer(file);
    });
  }

  async function readFile(file) {
    const check = checkFile(file);
    if (!check.ok) throw Object.assign(new Error(check.reason), { userMessage: check.reason });
    if (check.kind === "csv") {
      const Papa = await loadLibrary("papaparse");
      return parseCsvText(await readBlob(file, "text"), Papa);
    }
    const XLSX = await loadLibrary("xlsx");
    return parseWorkbook(new Uint8Array(await readBlob(file, "buffer")), XLSX);
  }

  // First non-empty row is the headings; the rest are data rows. Rows with
  // nothing in them are dropped. Row numbers count data rows only: row 1 is
  // the first row under the headings (the same numbering the import result
  // and Import History use).
  function splitSheet(rows) {
    const nonEmpty = (rows || []).filter((r) => r.some((c) => c !== ""));
    if (!nonEmpty.length) return { headers: [], dataRows: [] };
    const width = nonEmpty.reduce((w, r) => Math.max(w, r.length), 0);
    const headers = Array.from({ length: width }, (_, i) => nonEmpty[0][i] || "Column " + (i + 1));
    return { headers, dataRows: nonEmpty.slice(1) };
  }

  function normalizeHeader(h) {
    return String(h || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  }

  // One field per column at most, and each field used by one column at most
  // (the first column that matches).
  //
  // Phase 2E: two passes. The plain names win first, so a file with both
  // "Email" and "Email 2" maps "Email"; the export spellings are only
  // consulted for columns nothing claimed. Without that ordering, column
  // order would decide which email address got imported.
  function autoMap(headers) {
    const list = headers || [];
    const used = {};
    const mapping = list.map(() => "");

    // Only ever assigns a field the picker actually offers. HEADER_SYNONYMS
    // also carries the recognised-but-not-importable names (birthday), and
    // mapping a column to one of those would hand the agent a selection
    // that silently imports nothing.
    const importable = {};
    FIELDS.forEach((f) => { importable[f.key] = true; });

    const pass = (table) => {
      list.forEach((h, i) => {
        if (mapping[i]) return;
        const n = normalizeHeader(h);
        for (const key of Object.keys(table)) {
          if (!importable[key]) continue;
          if (!used[key] && table[key].indexOf(n) !== -1) {
            used[key] = true;
            mapping[i] = key;
            return;
          }
        }
      });
    };
    pass(HEADER_SYNONYMS);
    pass(EXPORT_SYNONYMS);
    return mapping;
  }

  /**
   * Columns we recognised but cannot import, as { index, header, label }.
   *
   * Reported separately from the mapping rather than mixed into it: these
   * are not choices the agent can make, so they do not belong in a picker.
   */
  function unsupportedColumns(headers, mapping) {
    const out = [];
    (headers || []).forEach((h, i) => {
      if (mapping && mapping[i]) return;
      const n = normalizeHeader(h);
      Object.keys(UNSUPPORTED_FIELDS).forEach((key) => {
        const names = HEADER_SYNONYMS[key] || [];
        if (names.indexOf(n) !== -1) {
          out.push({ index: i, header: String(h || ""), label: UNSUPPORTED_FIELDS[key] });
        }
      });
    });
    return out;
  }

  /** Which export this looks like, for one reassuring line in the preview. */
  function detectFormat(headers) {
    const seen = {};
    (headers || []).forEach((h) => { seen[normalizeHeader(h)] = true; });
    for (const fmt of EXPORT_FORMATS) {
      for (const signal of fmt.signals) {
        if (signal.every((name) => seen[name])) return fmt;
      }
    }
    return EXPORT_FORMATS[EXPORT_FORMATS.length - 1];
  }

  function hasContactColumn(mapping) {
    return mapping.indexOf("email") !== -1 || mapping.indexOf("phone") !== -1;
  }

  function buildRow(cells, mapping) {
    const pick = (key) => {
      const i = mapping.indexOf(key);
      return i === -1 ? "" : cellText(cells[i]);
    };
    const full = pick("full_name") || [pick("first_name"), pick("last_name")].filter(Boolean).join(" ");
    return {
      full_name: full,
      email: pick("email").toLowerCase(),
      phone: pick("phone"),
      source: pick("source"),
      notes: pick("notes"),
      tags: pick("tags").split(/[,;]/).map((t) => t.trim()).filter(Boolean),
      budget: pick("budget"),
      preferred_area: pick("preferred_area"),
      // Only sent when the agent mapped a column to it, so an unmapped
      // import keeps the server's own default ("New Lead") rather than
      // overwriting it with a blank.
      status: pick("status")
    };
  }

  // Same rules the server applies; here they only drive the preview.
  function checkRow(row) {
    const digits = row.phone.replace(/[^0-9]+/g, "");
    if (!row.email && !digits) return REASONS.missing_contact_channel;
    if (row.email && (row.email.length > 254 || !EMAIL_SHAPE.test(row.email))) return REASONS.invalid_email;
    if (digits && (digits.length < 7 || digits.length > 15)) return REASONS.invalid_phone;
    return null;
  }

  function contactKeys(contacts) {
    const emails = new Set();
    const phones = new Set();
    (contacts || []).forEach((c) => {
      const e = String(c.email || "").trim().toLowerCase();
      const p = String(c.phone || "").replace(/[^0-9]+/g, "");
      if (e) emails.add(e);
      if (p) phones.add(p);
    });
    return { emails, phones };
  }

  // Preview model: every data row checked, with likely duplicates flagged
  // (already in your contacts, or repeated earlier in this file).
  function analyze(dataRows, mapping, existingContacts) {
    if (dataRows.length > MAX_ROWS) {
      throw Object.assign(new Error(ROW_LIMIT_MESSAGE), { userMessage: ROW_LIMIT_MESSAGE });
    }
    const existing = contactKeys(existingContacts);
    const seenEmail = {};
    const seenPhone = {};
    const rows = dataRows.map((cells, i) => {
      const data = buildRow(cells, mapping);
      const reason = checkRow(data);
      const digits = data.phone.replace(/[^0-9]+/g, "");
      let duplicate = null;
      let duplicateOf = null;
      if (!reason) {
        const earlier = (data.email && seenEmail[data.email]) || (digits && seenPhone[digits]);
        if (earlier) { duplicate = "file"; duplicateOf = earlier; }
        else if ((data.email && existing.emails.has(data.email)) || (digits && existing.phones.has(digits))) duplicate = "existing";
        if (data.email && !seenEmail[data.email]) seenEmail[data.email] = i + 1;
        if (digits && !seenPhone[digits]) seenPhone[digits] = i + 1;
      }
      return { rowNumber: i + 1, data, valid: !reason, reason, duplicate, duplicateOf };
    });
    return {
      rows,
      total: rows.length,
      validCount: rows.filter((r) => r.valid).length,
      invalidCount: rows.filter((r) => !r.valid).length,
      duplicateCount: rows.filter((r) => r.duplicate).length,
      // Rows likely to create a new contact (what the daily limit counts).
      newCount: rows.filter((r) => r.valid && !r.duplicate).length,
      preview: rows.slice(0, PREVIEW_ROWS)
    };
  }

  // When the daily limit frees up, in plain words in the viewer's own time:
  // "3:43 PM today", "9:05 AM tomorrow", or "9:05 AM on Friday, Oct 2".
  // Rounded up to the next minute so "after" is always true.
  function resetTimeText(iso, now) {
    now = now || new Date();
    const t = iso ? new Date(iso) : new Date(now.getTime() + 24 * 3600 * 1000);
    if (isNaN(t.getTime())) return "tomorrow";
    const at = new Date(Math.ceil(t.getTime() / 60000) * 60000);
    const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const days = Math.round((day(at) - day(now)) / (24 * 3600 * 1000));
    if (days <= 0) return time + " today";
    if (days === 1) return time + " tomorrow";
    return time + " on " + at.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
  }

  // Everything is sent, invalid rows included, so Import History has a
  // record of every row and why it was not imported.
  function toSubmission(analysis) {
    return analysis.rows.map((r) => r.data);
  }

  function templateCsv() {
    return "Full name,Email,Phone,Lead source,Notes,Tags,Budget,Preferred area\r\n";
  }

  function newImportId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    const b = window.crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
  }

  return {
    MAX_FILE_BYTES, MAX_ROWS, ROW_LIMIT_MESSAGE, resetTimeText, PREVIEW_ROWS, EXTENSIONS, FIELDS, LIBRARIES, REASONS,
    checkFile, loadLibrary, readFile, parseCsvText, parseWorkbook, splitSheet,
    normalizeHeader, autoMap, hasContactColumn, buildRow, checkRow, analyze,
    unsupportedColumns, detectFormat, UNSUPPORTED_FIELDS, EXPORT_FORMATS,
    toSubmission, templateCsv, newImportId
  };
})();
