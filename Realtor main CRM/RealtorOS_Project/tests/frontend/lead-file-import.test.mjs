// Phase 4E.4 frontend: parsing (CSV / multi-sheet XLSX), column matching,
// validation, preview, the import dialog, and Import History with both
// sources. Real page scripts in jsdom; parsers from tests/node_modules
// (byte-identical to the pinned CDN files — checked below).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { browser, settle, SKIP_DOM } from "../helpers/browser.mjs";
import { reportSkipReason } from "../helpers/skip-reason.mjs";

const require = createRequire(import.meta.url);
let XLSX_NODE = null;
let XLSX_SRC = null;
let PAPA_SRC = null;
try {
  XLSX_NODE = require("xlsx");
  XLSX_SRC = fs.readFileSync(require.resolve("xlsx/dist/xlsx.full.min.js"), "utf8");
  PAPA_SRC = fs.readFileSync(require.resolve("papaparse/papaparse.min.js"), "utf8");
} catch (err) {
  // The exact condition behind every SKIP_LIBS skip, printed once.
  reportSkipReason("xlsx / papaparse", err);
}
const SKIP_LIBS = "xlsx / papaparse not installed — run `npm install` in tests/";
// Values created inside the jsdom window live in another realm; compare
// plain JSON copies.
const plain = (v) => JSON.parse(JSON.stringify(v));
const deq = (actual, expected, message) => assert.deepEqual(plain(actual), plain(expected), message);

const BASE_SCRIPTS = ["assets/js/core/utils.js", "assets/js/app.js", "assets/js/core/lead-file.js"];

async function page(scripts = BASE_SCRIPTS, store = {}) {
  const b = await browser(scripts, { store });
  if (!b) return null;
  if (XLSX_SRC) { b.window.eval(XLSX_SRC); b.window.eval(PAPA_SRC); }
  return b;
}

function workbook(sheets) {
  const wb = XLSX_NODE.utils.book_new();
  for (const [name, aoa] of sheets) XLSX_NODE.utils.book_append_sheet(wb, XLSX_NODE.utils.aoa_to_sheet(aoa), name);
  return new Uint8Array(XLSX_NODE.write(wb, { type: "array", bookType: "xlsx" }));
}

// ---------------------------------------------------------------- libraries

test("pinned parser versions: integrity hashes match the exact library files", async (t) => {
  if (!XLSX_SRC) return t.skip(SKIP_LIBS);
  const b = await page();
  if (!b) return t.skip(SKIP_DOM);
  const libs = b.window.App.leadFile.LIBRARIES;
  const sri = (src) => "sha384-" + createHash("sha384").update(src, "utf8").digest("base64");
  assert.equal(libs.xlsx.integrity, sri(XLSX_SRC));
  assert.equal(libs.papaparse.integrity, sri(PAPA_SRC));
  assert.match(libs.xlsx.src, /^https:\/\/cdn\.sheetjs\.com\/xlsx-0\.20\.3\//);
  assert.match(libs.papaparse.src, /^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/PapaParse\/5\.5\.3\//);
  b.close();
});

test("parsers load lazily with integrity + crossorigin, and only once", async (t) => {
  const b = await browser(BASE_SCRIPTS);
  if (!b) return t.skip(SKIP_DOM);
  const LF = b.window.App.leadFile;
  assert.equal(b.document.querySelectorAll("script[src]").length, 0, "nothing loaded until an import starts");
  LF.loadLibrary("papaparse").catch(() => {});
  LF.loadLibrary("papaparse").catch(() => {});
  const scripts = [...b.document.querySelectorAll("script[src]")];
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].getAttribute("integrity"), LF.LIBRARIES.papaparse.integrity);
  assert.equal(scripts[0].getAttribute("crossorigin"), "anonymous");
  b.close();
});

// ---------------------------------------------------------------- parsing

test("CSV: BOM, quoted commas, line breaks in a cell, blank rows", async (t) => {
  if (!XLSX_SRC) return t.skip(SKIP_LIBS);
  const b = await page();
  if (!b) return t.skip(SKIP_DOM);
  const LF = b.window.App.leadFile;
  const csv = '﻿Name,Email,Notes\r\n"Lee, Ann",ann@example.com,"line1\nline2"\r\n,,\r\nBob,bob@example.com,\r\n';
  const [sheet] = LF.parseCsvText(csv, b.window.Papa);
  const split = LF.splitSheet(sheet.rows);
  deq(split.headers, ["Name", "Email", "Notes"]);
  assert.equal(split.dataRows.length, 2);
  deq(split.dataRows[0], ["Lee, Ann", "ann@example.com", "line1\nline2"]);
  b.close();
});

test("XLSX: a multi-sheet workbook lists every sheet; readFile works on a real File", async (t) => {
  if (!XLSX_SRC) return t.skip(SKIP_LIBS);
  const b = await page();
  if (!b) return t.skip(SKIP_DOM);
  const LF = b.window.App.leadFile;
  const bytes = workbook([
    ["Notes", [["just a note"]]],
    ["Leads", [["Full Name", "E-mail", "Mobile"], ["Pat Lee", "pat@example.com", 5551234567], ["Sam Roe", "", "(555) 222-3333"]]],
  ]);
  const sheets = LF.parseWorkbook(bytes, b.window.XLSX);
  deq(sheets.map((s) => s.name), ["Notes", "Leads"]);
  deq(sheets[1].rows[1], ["Pat Lee", "pat@example.com", "5551234567"]);
  const file = new b.window.File([bytes], "leads.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const read = await LF.readFile(file);
  assert.equal(read.length, 2);
  deq(LF.autoMap(LF.splitSheet(read[1].rows).headers), ["full_name", "email", "phone"]);
  b.close();
});

// ---------------------------------------------------------------- mapping + validation

test("header auto-matching handles common variations; one column per field", async (t) => {
  const b = await browser(BASE_SCRIPTS);
  if (!b) return t.skip(SKIP_DOM);
  const LF = b.window.App.leadFile;
  deq(LF.autoMap(["Full Name", "E-mail", "Phone Number", "Lead Source", "Comments", "Tags", "Budget", "Neighborhood"]),
    ["full_name", "email", "phone", "source", "notes", "tags", "budget", "preferred_area"]);
  deq(LF.autoMap(["First Name", "Surname", "Email Address", "Mobile", "Cell"]),
    ["first_name", "last_name", "email", "phone", ""], "the second phone-like column is not used twice");
  deq(LF.autoMap(["name", "EMAIL", "Tel", "Area", "Favorite colour"]),
    ["full_name", "email", "phone", "preferred_area", ""]);
  b.close();
});

test("each row needs an email or a phone; bad values explained in plain words", async (t) => {
  const b = await browser(BASE_SCRIPTS);
  if (!b) return t.skip(SKIP_DOM);
  const LF = b.window.App.leadFile;
  const mapping = ["first_name", "last_name", "email", "phone", "tags"];
  const a = LF.analyze([
    ["Ann", "Lee", "ANN@example.com", "", "buyer; hot"],
    ["Bob", "", "", "555-111-2222", ""],
    ["No", "Contact", "", "", ""],
    ["Bad", "Email", "nope@", "", ""],
    ["Bad", "Phone", "", "12", ""],
  ], mapping, []);
  assert.equal(a.validCount, 2);
  assert.equal(a.invalidCount, 3);
  // Phase 2E added `status` to the payload: blank when no column is mapped
  // to it, which the server reads as its own default rather than as a blank
  // status.
  deq(a.rows[0].data, { full_name: "Ann Lee", email: "ann@example.com", phone: "", source: "", notes: "", tags: ["buyer", "hot"], budget: "", preferred_area: "", status: "" });
  deq(a.rows.filter((r) => !r.valid).map((r) => [r.rowNumber, r.reason]), [
    [3, "Needs an email address or a phone number."],
    [4, "The email address doesn't look right."],
    [5, "The phone number doesn't look right."],
  ]);
  assert.equal(LF.hasContactColumn(["full_name", "notes"]), false);
  assert.equal(LF.hasContactColumn(["full_name", "phone"]), true);
  b.close();
});

test("duplicates: repeated within the file, and already in your contacts", async (t) => {
  const b = await browser(BASE_SCRIPTS);
  if (!b) return t.skip(SKIP_DOM);
  const LF = b.window.App.leadFile;
  const a = LF.analyze([
    ["Ann", "ann@example.com", ""],
    ["Ann again", "Ann@Example.com ", ""],
    ["Known", "", "(555) 999-0000"],
    ["New", "new@example.com", ""],
  ], ["full_name", "email", "phone"], [{ email: "someone@example.com", phone: "555.999.0000" }]);
  deq(a.rows.map((r) => r.duplicate), [null, "file", "existing", null]);
  assert.equal(a.rows[1].duplicateOf, 1);
  assert.equal(a.duplicateCount, 2);
  b.close();
});

test("limits: 500 rows per file, 5 MB per file, Excel/CSV only", async (t) => {
  const b = await browser(BASE_SCRIPTS);
  if (!b) return t.skip(SKIP_DOM);
  const LF = b.window.App.leadFile;
  const rows = Array.from({ length: 501 }, (_, i) => [`p${i}@example.com`]);
  assert.throws(() => LF.analyze(rows, ["email"], []), (e) => e.userMessage === "Files can have up to 500 rows. Split larger lists into several files.");
  assert.equal(LF.analyze(rows.slice(0, 500), ["email"], []).validCount, 500);
  const mk = (name, size) => ({ name, size });
  assert.equal(LF.checkFile(mk("big.csv", 5 * 1024 * 1024 + 1)).ok, false);
  assert.match(LF.checkFile(mk("big.csv", 5 * 1024 * 1024 + 1)).reason, /larger than 5 MB/);
  assert.equal(LF.checkFile(mk("ok.csv", 5 * 1024 * 1024)).ok, true);
  assert.match(LF.checkFile(mk("leads.pdf", 10)).reason, /Excel \(.xlsx, .xls\) or CSV/);
  assert.match(LF.checkFile(mk("leads.numbers", 10)).reason, /Excel/);
  assert.match(LF.checkFile(mk("empty.xlsx", 0)).reason, /empty/);
  assert.equal(LF.checkFile(mk("OLD.XLS", 10)).ok, true);
  assert.equal(LF.templateCsv(), "Full name,Email,Phone,Lead source,Notes,Tags,Budget,Preferred area\r\n");
  b.close();
});

// ---------------------------------------------------------------- the dialog

async function importDialog(t, { submit, contacts = [], quota } = {}) {
  if (!XLSX_SRC) { t.skip(SKIP_LIBS); return null; }
  const calls = [];
  const store = {
    getState: () => ({ contacts }),
    leadFileImport: {
      submit: submit ?? (async (payload) => { calls.push(payload); return { replayed: false, batchId: "b1", total: payload.rows.length, imported: 1, updated: 0, skipped: 1, rejected: 1, rejectedRows: [{ rowNumber: 3, reason: "Needs an email address or a phone number." }], skippedRows: [] }; }),
      refreshContacts: async () => {},
      ...(quota !== undefined ? { quota: async () => quota } : {}),
    },
  };
  const b = await page([...BASE_SCRIPTS, "assets/js/pages/lead-file-import.js"], store);
  if (!b) { t.skip(SKIP_DOM); return null; }
  b.window.App.app.navigate = (route) => calls.push({ navigate: route });
  // jsdom has no blob URLs; the template link only needs some URL.
  b.window.URL.createObjectURL = () => "blob:template";
  b.window.URL.revokeObjectURL = () => {};
  const opener = b.document.createElement("button");
  b.document.body.appendChild(opener);
  opener.focus();
  const handle = b.window.App.pages.leadFileImport.open();
  await settle(b.window);
  const modal = handle.modal;
  const $ = (sel) => modal.querySelector(sel);
  async function chooseFile(name, content, type = "text/csv") {
    const input = $('[data-role="lfi-file"]');
    const file = new b.window.File([content], name, { type });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new b.window.Event("change"));
    for (let i = 0; i < 20 && modal.querySelector('[data-role="lfi-file"]'); i++) await settle(b.window, 5);
  }
  return { ...b, calls, modal, $, chooseFile, opener, handle };
}

const HOSTILE_CSV = [
  "Full Name,E-mail,Phone Number,Notes",
  '"<script>alert(1)</script>",x@example.com,,"<img src=x onerror=alert(2)>"',
  "Sam Roe,,(555) 222-3333,",
  "No Channel,,,",
].join("\n");

test("dialog: file -> match columns -> review -> import; hostile cells render as text", async (t) => {
  const d = await importDialog(t);
  if (!d) return;
  assert.equal(d.document.activeElement.textContent, "Choose a file", "focus on the step heading");
  assert.match(d.$('a[download]').getAttribute("download"), /template\.csv$/);
  await d.chooseFile("leads.csv", HOSTILE_CSV);

  assert.equal(d.document.activeElement.textContent, "Match your columns");
  const selects = [...d.modal.querySelectorAll("select[data-col]")];
  deq(selects.map((s) => s.value), ["full_name", "email", "phone", "notes"]);
  assert.ok(selects.every((s) => s.getAttribute("aria-labelledby")), "each select is labelled by its column");
  assert.equal(d.modal.querySelector("script"), null);
  assert.equal(d.modal.querySelector("img"), null);
  d.$('[data-role="lfi-next"]').click();
  await settle(d.window);

  assert.equal(d.document.activeElement.textContent, "Review before importing");
  const text = d.modal.textContent.replace(/\s+/g, " ");
  assert.match(text, /Ready to import\s*2/);
  assert.match(text, /Need attention\s*1/);
  assert.match(text, /Row 3: Needs an email address or a phone number\./);
  assert.ok(d.modal.textContent.includes("<script>alert(1)</script>"), "shown as text");
  assert.equal(d.modal.querySelector("script"), null);
  assert.equal(d.modal.querySelector("img"), null);
  const auto = d.$('[data-role="lfi-automation"]');
  assert.equal(auto.checked, false, "automated follow-up is off by default");
  assert.match(auto.closest("label").textContent, /Only include people who agreed to receive emails from you\./);

  d.$('[data-role="lfi-import"]').click();
  await settle(d.window, 5);
  const payload = d.calls[0];
  assert.match(payload.importId, /^[0-9a-f-]{36}$/);
  assert.equal(payload.fileName, "leads.csv");
  assert.equal(payload.startAutomation, false);
  assert.equal(payload.rows.length, 3, "every row is sent so rejected ones are recorded too");
  assert.equal(payload.rows[0].full_name, "<script>alert(1)</script>");

  assert.equal(d.document.activeElement.textContent, "Import complete");
  assert.match(d.modal.textContent.replace(/\s+/g, " "), /New contacts\s*1.*Couldn't import\s*1/);
  d.$('[data-role="lfi-history"]').click();
  await settle(d.window, 60);
  deq(d.calls.at(-1), { navigate: "/settings/sheet-imports" });
  for (const store of [d.window.localStorage, d.window.sessionStorage]) assert.equal(store.length, 0, "nothing stored in the browser");
  assert.doesNotMatch(d.window.location.href, /example\.com|script/);
  d.close();
});

test("dialog: automation checkbox on is passed through", async (t) => {
  const d = await importDialog(t);
  if (!d) return;
  await d.chooseFile("leads.csv", "Email\na@example.com\n");
  d.$('[data-role="lfi-next"]').click();
  await settle(d.window);
  const box = d.$('[data-role="lfi-automation"]');
  box.checked = true;
  box.dispatchEvent(new d.window.Event("change"));
  d.$('[data-role="lfi-import"]').click();
  await settle(d.window, 5);
  assert.equal(d.calls[0].startAutomation, true);
  d.close();
});

test("dialog: a server hiccup says 'try again' and the retry reuses the same import id", async (t) => {
  let n = 0;
  const seen = [];
  const d = await importDialog(t, {
    submit: async (p) => {
      seen.push(p.importId);
      if (++n === 1) throw Object.assign(new Error("try_again"), { code: "try_again" });
      return { replayed: false, imported: 1, updated: 0, skipped: 0, rejected: 0, rejectedRows: [], skippedRows: [] };
    },
  });
  if (!d) return;
  await d.chooseFile("leads.csv", "Email\na@example.com\n");
  d.$('[data-role="lfi-next"]').click();
  await settle(d.window);
  d.$('[data-role="lfi-import"]').click();
  await settle(d.window, 5);
  assert.match(d.$('[data-role="lfi-error"]').textContent, /Something went wrong\. Please try again — nothing will be imported twice\./);
  assert.equal(d.$('[data-role="lfi-import"]').textContent.trim(), "Try again");
  d.$('[data-role="lfi-import"]').click();
  await settle(d.window, 5);
  assert.equal(seen.length, 2);
  assert.equal(seen[0], seen[1]);
  assert.match(d.modal.textContent, /Import complete/);
  d.close();
});

test("dialog: wrong file type and a too-large file are refused before reading", async (t) => {
  const d = await importDialog(t);
  if (!d) return;
  await d.chooseFile("leads.pdf", "%PDF", "application/pdf");
  assert.match(d.$('[data-role="lfi-error"]').textContent, /Excel \(.xlsx, .xls\) or CSV/);
  const input = d.$('[data-role="lfi-file"]');
  const big = { name: "big.csv", size: 6 * 1024 * 1024, text: () => { throw new Error("must not read"); } };
  Object.defineProperty(input, "files", { value: [big], configurable: true });
  input.dispatchEvent(new d.window.Event("change"));
  await settle(d.window);
  assert.match(d.$('[data-role="lfi-error"]').textContent, /larger than 5 MB/);
  d.close();
});

test("dialog: a workbook with several sheets asks which one; no email/phone column is caught", async (t) => {
  const d = await importDialog(t);
  if (!d) return;
  const bytes = workbook([["Summary", [["total", 2]]], ["Leads", [["Name", "Notes"], ["Pat", "hi"]]]]);
  const input = d.$('[data-role="lfi-file"]');
  Object.defineProperty(input, "files", { value: [new d.window.File([bytes], "book.xlsx")], configurable: true });
  input.dispatchEvent(new d.window.Event("change"));
  for (let i = 0; i < 20 && !d.$('[data-role="lfi-sheet"]'); i++) await settle(d.window, 5);
  const sheet = d.$('[data-role="lfi-sheet"]');
  deq([...sheet.options].map((o) => o.textContent), ["Summary (0 rows)", "Leads (1 row)"]);
  sheet.value = "1";
  d.$('[data-role="lfi-next"]').click();
  await settle(d.window);
  d.$('[data-role="lfi-next"]').click();
  await settle(d.window);
  assert.match(d.$('[data-role="lfi-error"]').textContent, /email address or the phone number/);
  d.close();
});

test("dialog: Escape closes it and focus returns to the button that opened it", async (t) => {
  const d = await importDialog(t);
  if (!d) return;
  d.document.dispatchEvent(new d.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await new Promise((r) => d.window.setTimeout(r, 250));
  assert.equal(d.document.querySelector("#modalRoot .modal"), null);
  assert.equal(d.document.activeElement, d.opener);
  d.close();
});

// ---------------------------------------------------------------- Import History

test("Import History: both sources, file name shown and escaped, source filter, daily-limit rows with the plain reason", async (t) => {
  const listCalls = [];
  const batch = (over) => ({ id: crypto.randomUUID(), connection_id: null, source_type: "google_sheet", file_name: null,
    status: "completed", created_at: "2026-09-29T10:00:00Z", started_at: "2026-09-29T10:00:00Z", completed_at: "2026-09-29T10:00:05Z",
    source_row_count: 3, accepted_count: 1, duplicate_count: 1, rejected_count: 1, imported_count: 1, error_summary: null, ...over });
  const conn = "55555555-5555-4555-8555-555555555555";
  const b = await browser(["assets/js/core/utils.js", "assets/js/app.js", "assets/js/pages/google-sheets-import-history.js"], {
    store: {
      sheetConnections: { list: async () => [{ id: conn, name: "Website leads" }] },
      sheetImportHistory: {
        listBatches: async (opts) => {
          listCalls.push(opts);
          return { rows: [batch({ source_type: "file_upload", file_name: "<b>Open house</b>.xlsx" }), batch({ connection_id: conn })], total: 2, offset: 0 };
        },
        listRows: async () => ({ rows: [{
          id: "r1", batch_id: "b", source_type: "file_upload", source_row_number: 201, source_row_key: "file:b:201",
          status: "rejected", error_code: "daily_limit_reached", contact_id: null, last_seen_at: "2026-09-29T10:00:05Z",
          error_message: "Not imported — daily limit of 200 new contacts reached. Upload this file again 24 hours after this import to add the rest.",
        }], total: 1, offset: 0 }),
      },
    },
  });
  if (!b) return t.skip(SKIP_DOM);
  const pane = b.document.createElement("div");
  b.document.body.appendChild(pane);
  await b.window.App.pages.googleSheetsImportHistory.render(pane);
  await settle(b.window);
  const text = pane.textContent.replace(/\s+/g, " ");
  assert.match(text, /File upload · <b>Open house<\/b>\.xlsx/);
  assert.match(text, /Google Sheet · Website leads/);
  assert.equal(pane.querySelector(".gsih-batch-conn b"), null, "file name escaped");
  pane.querySelector("[data-view-rows]").click();
  await settle(b.window);
  const rowText = pane.querySelector(".gsih-row-item").textContent.replace(/\s+/g, " ");
  assert.match(rowText, /Row #201/);
  assert.match(rowText, /Not imported — daily limit of 200 new contacts reached\. Upload this file again 24 hours after this import to add the rest\./);
  assert.doesNotMatch(rowText, /Fix this row/, "nothing is wrong with the row itself");
  const filter = pane.querySelector("#gsihSourceFilter");
  deq([...filter.options].map((o) => o.textContent), ["All sources", "Google Sheet", "File upload"]);
  filter.value = "file_upload";
  filter.dispatchEvent(new b.window.Event("change"));
  await settle(b.window);
  assert.equal(listCalls.at(-1).sourceType, "file_upload");
  b.close();
});

// ---------------------------------------------------------------- daily limit of new contacts from files

test("likely-new count and reset-time wording", async (t) => {
  const b = await browser(BASE_SCRIPTS);
  if (!b) return t.skip(SKIP_DOM);
  const LF = b.window.App.leadFile;
  const a = LF.analyze([["new1@example.com"], ["old@example.com"], ["new1@example.com"], ["bad"], ["new2@example.com"]], ["email"],
    [{ email: "old@example.com" }]);
  assert.equal(a.newCount, 2, "not the existing contact, the repeat, or the invalid row");
  const now = new b.window.Date(2026, 8, 29, 14, 0, 0);
  const at = (h, m, s = 0, d = 29) => new b.window.Date(2026, 8, d, h, m, s).toISOString();
  assert.match(LF.resetTimeText(at(15, 42, 10), now), /^3:43\s?PM today$/, "rounded up to the next minute");
  assert.match(LF.resetTimeText(at(9, 5, 0, 30), now), /^9:05\s?AM tomorrow$/);
  assert.match(LF.resetTimeText(at(9, 5, 0, 2 + 30), now), /^9:05\s?AM on /);
  assert.match(LF.resetTimeText(null, now), /tomorrow$/, "nothing counted yet: 24 hours from now");
  b.close();
});

const FIVE_NEW = "Email\nn1@example.com\nn2@example.com\nn3@example.com\nn4@example.com\nn5@example.com\n";
const Q = (remaining, resetsAt = null) => ({ limit: 200, used: 200 - remaining, remaining, resetsAt });

async function toReview(d, csv = FIVE_NEW) {
  await d.chooseFile("leads.csv", csv);
  d.$('[data-role="lfi-next"]').click();
  await settle(d.window);
}

test("dialog: shows how many more contacts can be added today", async (t) => {
  const d = await importDialog(t, { quota: Q(150) });
  if (!d) return;
  await settle(d.window);
  assert.equal(d.$('[data-role="lfi-quota"]').textContent, "You can add 150 more contacts from files today.");
  await toReview(d);
  assert.equal(d.$('[data-role="lfi-quota"]').textContent, "You can add 150 more contacts from files today.");
  assert.equal(d.$('[data-role="lfi-quota-warning"]').hidden, true);
  assert.equal(d.$('[data-role="lfi-import"]').disabled, false);
  d.close();
});

test("dialog: at 0 remaining the import button is disabled and says when more can be added", async (t) => {
  const resetsAt = new Date(Date.now() + 3 * 3600e3).toISOString();
  const d = await importDialog(t, { quota: Q(0, resetsAt) });
  if (!d) return;
  await toReview(d);
  const msg = d.$('[data-role="lfi-quota"]').textContent;
  assert.match(msg, /^You've reached today's limit of 200 new contacts from files\. You can add more after \d{1,2}:\d{2}\s?[AP]M (today|tomorrow)\.$/);
  assert.equal(d.$('[data-role="lfi-import"]').disabled, true);
  d.$('[data-role="lfi-import"]').click();
  await settle(d.window, 5);
  assert.equal(d.calls.length, 0, "nothing sent");
  d.close();
});

test("dialog: warns when the file has more likely-new rows than are left today", async (t) => {
  const d = await importDialog(t, { quota: Q(2, new Date(Date.now() + 5 * 3600e3).toISOString()) });
  if (!d) return;
  await toReview(d);
  const warn = d.$('[data-role="lfi-quota-warning"]');
  assert.equal(warn.hidden, false);
  assert.match(warn.textContent, /^Only the first 2 new contacts will be added today\. The rest can be added by uploading the same file again after \d{1,2}:\d{2}\s?[AP]M (today|tomorrow)\.$/);
  assert.equal(d.$('[data-role="lfi-import"]').disabled, false, "still allowed: the first 2 are added");
  d.close();
});

test("dialog: a file over 500 rows is refused before matching columns or uploading", async (t) => {
  const d = await importDialog(t, { quota: Q(200) });
  if (!d) return;
  const csv = "Email\n" + Array.from({ length: 501 }, (_, i) => `p${i}@example.com`).join("\n") + "\n";
  const input = d.$('[data-role="lfi-file"]');
  const file = new d.window.File([csv], "big.csv", { type: "text/csv" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new d.window.Event("change"));
  for (let i = 0; i < 20 && !d.$('[data-role="lfi-error"]').textContent; i++) await settle(d.window, 5);
  assert.equal(d.$('[data-role="lfi-error"]').textContent, "Files can have up to 500 rows. Split larger lists into several files.");
  assert.equal(d.modal.querySelector("select[data-col]"), null, "never reached column matching");
  assert.equal(d.$('[data-role="lfi-file"]').disabled, false, "another file can be chosen");
  assert.equal(d.calls.length, 0);
  d.close();
});

test("dialog: the result shows how many were not added because of the daily limit", async (t) => {
  const d = await importDialog(t, {
    quota: Q(3),
    submit: async () => ({
      replayed: false, imported: 3, updated: 0, skipped: 0, rejected: 0, dailyLimitSkipped: 2,
      rejectedRows: [], skippedRows: [], limitedRows: [4, 5],
      quota: Q(0, new Date(Date.now() + 20 * 3600e3).toISOString()),
    }),
  });
  if (!d) return;
  await toReview(d);
  assert.equal(d.$('[data-role="lfi-status"]').textContent, "");
  d.$('[data-role="lfi-import"]').click();
  await settle(d.window, 5);
  const text = d.modal.textContent.replace(/\s+/g, " ");
  assert.match(text, /Import complete/);
  assert.match(text, /Not added — daily limit\s*2/);
  assert.match(text, /2 new contacts weren't added because of the daily limit of 200 new contacts from files\. Upload the same file again after \d{1,2}:\d{2}\s?[AP]M (today|tomorrow) to add the rest/);
  d.close();
});

// The real data service with a fake Supabase client.
async function dataService(t, answer) {
  const b = await browser(["assets/js/core/utils.js", "assets/js/data/data-service.js"]);
  if (!b) { t.skip(SKIP_DOM); return null; }
  const calls = [];
  b.window.App.cloud = {
    getUser: () => ({ id: "44444444-4444-4444-8444-444444444444" }),
    getClient: () => ({ functions: { invoke: async (name, { body }) => { calls.push({ name, body: plain(body) }); return answer(body); } } }),
  };
  return { ...b, calls, data: b.window.App.data };
}

test("data service: one call per import; daily-limit count, rows and quota are passed through; quota read", async (t) => {
  const QUOTA = { limit: 200, used: 200, remaining: 0, resets_at: "2026-09-30T10:00:00+00:00" };
  const d = await dataService(t, (body) => body.action === "quota"
    ? { data: { ok: true, quota: { limit: 200, used: 12, remaining: 188, resets_at: null } }, error: null }
    : { data: { ok: true, replayed: false, batch_id: "b1", total: 3, imported: 1, updated: 0, skipped: 0, rejected: 0,
        daily_limit_skipped: 2, rejected_rows: [], skipped_rows: [], limited_rows: [2, 3], quota: QUOTA }, error: null });
  if (!d) return;
  const r = await d.data.importLeadFile({ importId: "0b0e3f0a-8f5e-4c43-9d7a-2a4b8c1d2e3f", fileName: "x.csv", rows: [{}, {}, {}] });
  assert.equal(d.calls.length, 1);
  deq(Object.keys(d.calls[0].body).sort(), ["file_name", "import_id", "rows", "start_automation"]);
  assert.equal(r.dailyLimitSkipped, 2);
  deq(r.limitedRows, [2, 3]);
  deq(r.quota, { limit: 200, used: 200, remaining: 0, resetsAt: "2026-09-30T10:00:00+00:00" });
  deq(await d.data.getLeadFileImportQuota(), { limit: 200, used: 12, remaining: 188, resetsAt: null });
  deq(d.calls[1], { name: "import-lead-file", body: { action: "quota" } });
  d.close();
  const failing = await dataService(t, () => ({ data: null, error: { context: { json: async () => ({ error: "try_again" }) } } }));
  assert.equal(await failing.data.getLeadFileImportQuota(), null, "unknown quota does not block the dialog");
  failing.close();
});
