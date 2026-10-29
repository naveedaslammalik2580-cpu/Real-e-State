/**
 * RealtorOS — Google Sheets connector
 * ------------------------------------------------------------------------
 * Reads leads pasted into a "Raw Leads" tab, normalizes them into a
 * script-managed "Ready" tab, and pushes the Ready rows to the RealtorOS
 * ingest-sheet-leads Edge Function.
 *
 * WORKFLOW
 * The connection owner pastes/replaces leads in Raw Leads. Manual Sync Now
 * and the scheduled trigger both rebuild Ready from Raw Leads themselves,
 * every time, before sending anything — Ready is never hand-edited and any
 * such edit would just be overwritten on the next run. All corrections,
 * including corrections to rows the backend rejects, belong in Raw Leads.
 *
 * SECURITY NOTES
 * - The full connector token is stored only in
 *   PropertiesService.getUserProperties() — scoped to the individual Google
 *   account that ran Setup Connection, not shared with other editors of
 *   this spreadsheet, and never written to a sheet cell or logged.
 * - PropertiesService is ordinary per-project storage, not a vault or a
 *   guaranteed secret store — see the README's security section for what
 *   that does and doesn't mean in practice.
 * - Only a short, non-secret prefix of the token is ever displayed, always
 *   read from the current user's own token so one editor is never shown
 *   another editor's token status.
 * - Installable triggers run as their creator. The RealtorOS connection
 *   owner must be the one who both configures the token and installs the
 *   trigger; other editors must not install additional RealtorOS triggers.
 * - This script never scrapes, enriches, or invents lead data. It only
 *   reformats what the realtor already pasted into Raw Leads.
 */

/* ============================================================
 * CONFIGURATION
 * ========================================================== */

// Document Properties: shared, non-secret, apply to this spreadsheet
// regardless of which editor is looking.
var DOC_PROP_KEYS = {
  INGEST_URL: 'REALTOROS_INGEST_URL',
  RAW_TAB: 'REALTOROS_RAW_TAB',
  READY_TAB: 'REALTOROS_READY_TAB'
};
var DOC_STATUS_KEYS = {
  LAST_SYNC_AT: 'REALTOROS_LAST_SYNC_AT',
  LAST_SYNC_STATUS: 'REALTOROS_LAST_SYNC_STATUS',
  LAST_SYNC_SUMMARY: 'REALTOROS_LAST_SYNC_SUMMARY'
};

// User Properties: per-Google-account. The secret token, and the
// synced-revision bookkeeping that must never be shared across accounts
// (each account syncs under its own token and its own installable trigger).
var USER_PROP_KEYS = {
  CONNECTOR_TOKEN: 'REALTOROS_CONNECTOR_TOKEN',
  LAST_SUCCESSFUL_REVISION: 'REALTOROS_LAST_SUCCESSFUL_REVISION'
};

var DEFAULT_RAW_TAB = 'Raw Leads';
var DEFAULT_READY_TAB = 'Ready';

var READY_COLUMNS = [
  'lead_id', 'full_name', 'email', 'phone', 'type', 'status',
  'source', 'temperature', 'budget', 'preferred_area', 'notes'
];

var FIELD_DEFAULTS = {
  type: 'Buyer',
  status: 'New Lead',
  source: 'Google Sheets',
  temperature: 'Warm'
};

var FIELD_MAX_LENGTHS = {
  lead_id: 200,
  full_name: 200,
  email: 320,
  phone: 100,
  type: 100,
  status: 100,
  source: 100,
  temperature: 100,
  budget: 100,
  preferred_area: 300,
  notes: 10000
};

// Header aliases used to recognize columns pasted by the realtor.
// Matching is case-insensitive against a trimmed, whitespace-collapsed
// version of the header cell.
var HEADER_ALIASES = {
  lead_id: ['lead id', 'id', 'lead_id'],
  full_name: ['full name', 'name', 'full_name', 'lead name', 'contact name'],
  email: ['email', 'email address', 'e-mail', 'e mail'],
  phone: ['phone', 'mobile', 'phone number', 'mobile number', 'cell', 'cell phone'],
  type: ['type', 'lead type'],
  status: ['status', 'lead status'],
  source: ['source', 'lead source'],
  temperature: ['temperature', 'lead temperature', 'temp'],
  budget: ['budget', 'budget range', 'price range'],
  preferred_area: ['preferred area', 'area', 'location', 'preferred location'],
  notes: ['notes', 'note', 'comments', 'comment']
};

// The one and only accepted ingest endpoint. Matched exactly (see
// normalizeIngestUrl_) — never a startsWith()/prefix check.
var CANONICAL_INGEST_URL = 'https://yanasorwmaybnabfuepn.supabase.co/functions/v1/ingest-sheet-leads';
var INGEST_URL_PATTERN = /^https:\/\/yanasorwmaybnabfuepn\.supabase\.co\/functions\/v1\/ingest-sheet-leads\/?$/;

// Exact backend connector-token shape (matches the Edge Function's own
// validation in ingest-sheet-leads/index.ts).
var TOKEN_PATTERN = /^ros_[A-Za-z0-9_-]{40,100}$/;

var SYNC_TRIGGER_HANDLER = 'realtorosTriggeredSync';
var SYNC_INTERVAL_MINUTES = 15;
var MAX_ROWS_PER_BATCH = 500; // backend hard limit: 1-500 rows per request
var MAX_BODY_BYTES = 900000; // conservative ceiling under the backend's 1,000,000-byte hard limit
var MAX_SYNC_ATTEMPTS = 3;
var LOCK_WAIT_MS = 8000;

/* ============================================================
 * MENU
 * ========================================================== */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('RealtorOS')
    .addItem('Setup Connection', 'menuSetupConnection')
    .addItem('Prepare Ready Leads (preview)', 'menuPrepareReadyLeads')
    .addItem('Sync Now', 'menuSyncNow')
    .addSeparator()
    .addItem('Install 15-Minute Trigger', 'menuInstallTrigger')
    .addItem('Remove Sync Trigger', 'menuRemoveTrigger')
    .addSeparator()
    .addItem('Connection Status', 'menuConnectionStatus')
    .addToUi();
}

/* ============================================================
 * MENU HANDLERS
 * ========================================================== */

function menuSetupConnection() {
  var ui = SpreadsheetApp.getUi();
  var docProps = PropertiesService.getDocumentProperties();
  var userProps = PropertiesService.getUserProperties();

  var urlResponse = ui.prompt(
    'Setup Connection (1/4)',
    'Paste the RealtorOS ingest URL exactly as shown by RealtorOS (Settings → Sheets Connection). ' +
      'Only this exact endpoint is accepted (a single trailing slash is fine):\n\n' + CANONICAL_INGEST_URL,
    ui.ButtonSet.OK_CANCEL
  );
  if (urlResponse.getSelectedButton() !== ui.Button.OK) return;
  var canonicalUrl = normalizeIngestUrl_(urlResponse.getResponseText());
  if (!canonicalUrl) {
    ui.alert(
      'Setup cancelled',
      'That is not the exact RealtorOS ingest endpoint, so nothing was saved. Only this URL is ' +
        'accepted — no other host, path, port, query string, fragment, or embedded credentials:\n\n' +
        CANONICAL_INGEST_URL,
      ui.ButtonSet.OK
    );
    return;
  }

  var tokenResponse = ui.prompt(
    'Setup Connection (2/4)',
    'Paste the connector token shown once by RealtorOS. It must be "ros_" followed by 40-100 ' +
      'letters, digits, "_" or "-". It will be saved only to your own Google account\'s per-user ' +
      'script properties for this file — never to a cell, never to another editor\'s account.',
    ui.ButtonSet.OK_CANCEL
  );
  if (tokenResponse.getSelectedButton() !== ui.Button.OK) return;
  var connectorToken = tokenResponse.getResponseText().trim();
  if (!TOKEN_PATTERN.test(connectorToken)) {
    ui.alert(
      'Setup cancelled',
      'That does not match a valid RealtorOS connector token (expected "ros_" followed by 40-100 ' +
        'letters, digits, "_" or "-"). Nothing was saved. Copy the token again from RealtorOS, ' +
        'exactly, and retry.',
      ui.ButtonSet.OK
    );
    return;
  }

  var rawTabResponse = ui.prompt(
    'Setup Connection (3/4)',
    'Name of the tab where you paste raw leads (default "' + DEFAULT_RAW_TAB + '"):',
    ui.ButtonSet.OK_CANCEL
  );
  if (rawTabResponse.getSelectedButton() !== ui.Button.OK) return;
  var rawTab = rawTabResponse.getResponseText().trim() || DEFAULT_RAW_TAB;

  var readyTabResponse = ui.prompt(
    'Setup Connection (4/4)',
    'Name of the tab this script fully manages for sync-ready rows (default "' + DEFAULT_READY_TAB +
      '"). Every sync rebuilds this tab from "' + rawTab + '" — never edit it by hand; make ' +
      'corrections in "' + rawTab + '" instead.',
    ui.ButtonSet.OK_CANCEL
  );
  if (readyTabResponse.getSelectedButton() !== ui.Button.OK) return;
  var readyTab = readyTabResponse.getResponseText().trim() || DEFAULT_READY_TAB;

  docProps.setProperty(DOC_PROP_KEYS.INGEST_URL, canonicalUrl);
  docProps.setProperty(DOC_PROP_KEYS.RAW_TAB, rawTab);
  docProps.setProperty(DOC_PROP_KEYS.READY_TAB, readyTab);
  userProps.setProperty(USER_PROP_KEYS.CONNECTOR_TOKEN, connectorToken);
  // A token rotation, connection change, or tab rename can change what
  // "unchanged" means for this account, so any previously remembered
  // synced revision is no longer trustworthy — clear it so the very next
  // sync is never incorrectly skipped as "unchanged".
  userProps.deleteProperty(USER_PROP_KEYS.LAST_SUCCESSFUL_REVISION);

  ui.alert(
    'Connection saved',
    'Ingest URL and tab names were saved for this spreadsheet. Your connector token was saved to ' +
      'your own Google account\'s script properties for this file (not shared with other editors, ' +
      'not written to a cell, not a guaranteed secret vault — see the README).\n\n' +
      'Raw tab: ' + rawTab + '\nReady tab: ' + readyTab,
    ui.ButtonSet.OK
  );
}

function menuPrepareReadyLeads() {
  var ui = SpreadsheetApp.getUi();
  try {
    var config = getConfig_();
    var result = prepareReadyLeads_(config);
    ui.alert(
      'Ready leads prepared (preview)',
      'Valid rows written to "' + config.readyTab + '": ' + result.validCount + '\n' +
        'Raw rows skipped as invalid: ' + result.invalidCount +
        (result.invalidCount > 0
          ? '\n  • missing name (no derivable email prefix): ' + result.reasons.missing_full_name +
            '\n  • missing email and phone: ' + result.reasons.missing_contact_channel
          : '') +
        '\n\nThis is a preview only — Sync Now and the scheduled trigger always rebuild "' +
        config.readyTab + '" from "' + config.rawTab + '" themselves first, so running this ' +
        'separately is optional. Correct any skipped or rejected rows in "' + config.rawTab +
        '", never in "' + config.readyTab + '".',
      ui.ButtonSet.OK
    );
  } catch (err) {
    ui.alert('Could not prepare Ready leads', friendlyError_(err), ui.ButtonSet.OK);
  }
}

function menuSyncNow() {
  var ui = SpreadsheetApp.getUi();
  var result = runSync_(true);
  if (result.blocked) {
    ui.alert('Sync not started', result.message, ui.ButtonSet.OK);
    return;
  }
  ui.alert(result.title, result.message, ui.ButtonSet.OK);
}

function menuInstallTrigger() {
  var ui = SpreadsheetApp.getUi();
  try {
    getConfig_(); // fail fast if this Google account hasn't run Setup Connection yet
    var removed = removeRealtorosTriggers_();
    ScriptApp.newTrigger(SYNC_TRIGGER_HANDLER)
      .timeBased()
      .everyMinutes(SYNC_INTERVAL_MINUTES)
      .create();
    ui.alert(
      'Trigger installed',
      'This will sync automatically about every ' + SYNC_INTERVAL_MINUTES + ' minutes, running as ' +
        'your Google account' +
        (removed > 0
          ? ' (replacing ' + removed + ' earlier trigger your account had installed).'
          : ' (no earlier trigger from your account was found).') +
        '\n\nOnly the RealtorOS connection owner should install this trigger. This menu can only ' +
        'see and remove triggers your own Google account created — if another editor of this ' +
        'spreadsheet installs a separate trigger under their own account, it is invisible to you ' +
        'here and both would run. Other editors must not install additional RealtorOS triggers.',
      ui.ButtonSet.OK
    );
  } catch (err) {
    ui.alert('Could not install trigger', friendlyError_(err), ui.ButtonSet.OK);
  }
}

function menuRemoveTrigger() {
  var ui = SpreadsheetApp.getUi();
  var removed = removeRealtorosTriggers_();
  ui.alert(
    removed > 0 ? 'Trigger removed' : 'No trigger found',
    (removed > 0
      ? 'Removed ' + removed + ' RealtorOS sync trigger your Google account had installed. Manual ' +
        'Sync Now still works.'
      : 'Your Google account has no RealtorOS sync trigger installed.') +
      '\n\nThis only ever affects triggers your own account can see. If another editor installed a ' +
      'separate trigger under their own account, it is unaffected and invisible to you here.',
    ui.ButtonSet.OK
  );
}

function menuConnectionStatus() {
  var ui = SpreadsheetApp.getUi();
  var docProps = PropertiesService.getDocumentProperties();
  var userProps = PropertiesService.getUserProperties();
  var ingestUrl = docProps.getProperty(DOC_PROP_KEYS.INGEST_URL);
  var connectorToken = userProps.getProperty(USER_PROP_KEYS.CONNECTOR_TOKEN);
  var tokenPrefix = connectorToken ? connectorToken.substring(0, 12) : '';
  var rawTab = docProps.getProperty(DOC_PROP_KEYS.RAW_TAB) || DEFAULT_RAW_TAB;
  var readyTab = docProps.getProperty(DOC_PROP_KEYS.READY_TAB) || DEFAULT_READY_TAB;
  var lastSyncAt = docProps.getProperty(DOC_STATUS_KEYS.LAST_SYNC_AT);
  var lastSyncStatus = docProps.getProperty(DOC_STATUS_KEYS.LAST_SYNC_STATUS);
  var lastSyncSummary = docProps.getProperty(DOC_STATUS_KEYS.LAST_SYNC_SUMMARY);
  var lastRevision = userProps.getProperty(USER_PROP_KEYS.LAST_SUCCESSFUL_REVISION);
  var triggerCount = countRealtorosTriggers_();

  var lines = [];
  lines.push('Ingest URL: ' + (ingestUrl || '(not configured)'));
  lines.push('Connector token (your Google account): ' +
    (tokenPrefix ? tokenPrefix + '… (saved)' : '(not configured for your account)'));
  lines.push('Raw tab: ' + rawTab + (sheetExists_(rawTab) ? '' : '  [tab not found]'));
  lines.push('Ready tab: ' + readyTab + (sheetExists_(readyTab) ? '' : '  [tab not found]'));
  lines.push('Last successfully synced revision (your account): ' +
    (lastRevision ? lastRevision.substring(0, 12) + '…' : '(none yet)'));
  lines.push('Sync trigger visible to your account: ' +
    (triggerCount > 0 ? 'installed (every ' + SYNC_INTERVAL_MINUTES + ' min)' : 'not installed') +
    ' — another editor may have their own trigger you cannot see here.');
  lines.push('Last sync (this spreadsheet): ' + (lastSyncAt ? lastSyncAt + ' — ' + lastSyncStatus : '(never)'));
  if (lastSyncSummary) lines.push('Last sync summary: ' + lastSyncSummary);

  ui.alert('RealtorOS connection status', lines.join('\n'), ui.ButtonSet.OK);
}

/* ============================================================
 * CONFIG HELPERS
 * ========================================================== */

/**
 * Accepts only the exact canonical endpoint (an optional single trailing
 * slash tolerated), returning the canonical, normalized form. Anchored at
 * both ends, so any other host, scheme, port, path, query string,
 * fragment, or embedded userinfo/credentials fails to match and is
 * rejected — this is a full-string match, never a startsWith() check.
 */
function normalizeIngestUrl_(raw) {
  var trimmed = String(raw == null ? '' : raw).trim();
  if (!INGEST_URL_PATTERN.test(trimmed)) return null;
  return CANONICAL_INGEST_URL;
}

function getConfig_() {
  var docProps = PropertiesService.getDocumentProperties();
  var userProps = PropertiesService.getUserProperties();
  var ingestUrl = docProps.getProperty(DOC_PROP_KEYS.INGEST_URL);
  var connectorToken = userProps.getProperty(USER_PROP_KEYS.CONNECTOR_TOKEN);
  var rawTab = docProps.getProperty(DOC_PROP_KEYS.RAW_TAB) || DEFAULT_RAW_TAB;
  var readyTab = docProps.getProperty(DOC_PROP_KEYS.READY_TAB) || DEFAULT_READY_TAB;

  if (!ingestUrl || !connectorToken) {
    throw new Error(
      'RealtorOS connection is not configured for your Google account. Use RealtorOS → Setup ' +
        'Connection first — each editor who wants to sync must run it with their own connector token.'
    );
  }
  return {
    ingestUrl: ingestUrl,
    connectorToken: connectorToken,
    rawTab: rawTab,
    readyTab: readyTab
  };
}

function sheetExists_(name) {
  return !!SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
}

/* ============================================================
 * NORMALIZATION / READY-TAB PREPARATION
 * ========================================================== */

function normalizeHeaderText_(header) {
  return String(header || '')
    .replace(/[_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function buildHeaderMap_(headerRow) {
  var map = {}; // columnIndex -> field name
  for (var col = 0; col < headerRow.length; col++) {
    var normalized = normalizeHeaderText_(headerRow[col]);
    if (!normalized) continue;
    for (var field in HEADER_ALIASES) {
      if (HEADER_ALIASES[field].indexOf(normalized) !== -1) {
        map[col] = field;
        break;
      }
    }
  }
  return map;
}

function truncate_(value, maxLength) {
  var text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.substring(0, maxLength) : text;
}

function normalizeEmail_(value) {
  return truncate_(value, FIELD_MAX_LENGTHS.email).toLowerCase();
}

function normalizePhoneDigits_(value) {
  var digits = String(value == null ? '' : value).replace(/[^0-9]/g, '');
  return digits;
}

function derivedNameFromEmail_(email) {
  var atIndex = email.indexOf('@');
  var prefix = atIndex > 0 ? email.substring(0, atIndex) : '';
  if (!prefix) return '';
  var words = prefix
    .split(/[._+\-]+/)
    .filter(function (w) { return w.length > 0; });
  if (words.length === 0) return '';
  var titled = words.map(function (w) {
    return w.charAt(0).toUpperCase() + w.substring(1);
  });
  return truncate_(titled.join(' '), FIELD_MAX_LENGTHS.full_name);
}

function bytesToHex_(bytes) {
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i];
    if (b < 0) b += 256;
    var h = b.toString(16);
    hex += h.length === 1 ? '0' + h : h;
  }
  return hex;
}

function sha256Hex_(text) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytesToHex_(bytes);
}

/**
 * Builds a stable lead_id. If the realtor's raw sheet already provides one
 * (a "Lead ID"/"ID" column), it is preserved verbatim. Otherwise a
 * deterministic id is derived from the normalized email, then phone, then
 * name, so rebuilding Ready on unchanged data yields the same id every
 * time (no local storage of a mapping table is needed).
 */
function deriveLeadId_(rawLeadId, emailNorm, phoneDigits, fullName) {
  if (rawLeadId) return truncate_(rawLeadId, FIELD_MAX_LENGTHS.lead_id);
  var seed = emailNorm
    ? 'email:' + emailNorm
    : phoneDigits
    ? 'phone:' + phoneDigits
    : 'name:' + fullName.toLowerCase();
  return 'gs_' + sha256Hex_(seed).substring(0, 24);
}

/**
 * Reads the Raw Leads tab, normalizes each row, and rewrites the Ready tab
 * with only the rows that pass basic validity. Raw source values are never
 * modified. Ready is fully script-managed: this always rewrites Ready from
 * scratch, so any hand-edit made directly to Ready (including an attempt to
 * "fix" a rejected row there) is simply overwritten on the very next run —
 * every correction belongs in Raw Leads. Returns counts for the
 * confirmation dialog.
 */
function prepareReadyLeads_(config) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var rawSheet = ss.getSheetByName(config.rawTab);
  if (!rawSheet) {
    throw new Error('Raw tab "' + config.rawTab + '" was not found.');
  }

  var values = rawSheet.getDataRange().getDisplayValues();
  if (values.length < 2) {
    // Header only (or empty) — still (re)write an empty Ready tab.
    writeReadySheet_(config.readyTab, []);
    return { validCount: 0, invalidCount: 0, reasons: { missing_full_name: 0, missing_contact_channel: 0 } };
  }

  var headerMap = buildHeaderMap_(values[0]);
  var readyRows = [];
  var reasons = { missing_full_name: 0, missing_contact_channel: 0 };
  var invalidCount = 0;

  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var isBlank = row.every(function (cell) { return String(cell || '').trim() === ''; });
    if (isBlank) continue;

    var fields = { lead_id: '', full_name: '', email: '', phone: '', type: '', status: '',
      source: '', temperature: '', budget: '', preferred_area: '', notes: '' };
    for (var col in headerMap) {
      var field = headerMap[col];
      fields[field] = row[col] != null ? row[col] : '';
    }

    var rawLeadId = truncate_(fields.lead_id, FIELD_MAX_LENGTHS.lead_id);
    var fullName = truncate_(fields.full_name, FIELD_MAX_LENGTHS.full_name);
    var emailNorm = normalizeEmail_(fields.email);
    var phoneDigits = normalizePhoneDigits_(fields.phone);
    var phoneDisplay = truncate_(fields.phone, FIELD_MAX_LENGTHS.phone);

    if (!fullName && emailNorm) {
      fullName = derivedNameFromEmail_(emailNorm);
    }
    if (!fullName) {
      reasons.missing_full_name++;
      invalidCount++;
      continue;
    }
    if (!emailNorm && !phoneDigits) {
      reasons.missing_contact_channel++;
      invalidCount++;
      continue;
    }

    var leadId = deriveLeadId_(rawLeadId, emailNorm, phoneDigits, fullName);

    readyRows.push({
      lead_id: leadId,
      full_name: fullName,
      email: emailNorm,
      phone: phoneDisplay,
      type: truncate_(fields.type, FIELD_MAX_LENGTHS.type) || FIELD_DEFAULTS.type,
      status: truncate_(fields.status, FIELD_MAX_LENGTHS.status) || FIELD_DEFAULTS.status,
      source: truncate_(fields.source, FIELD_MAX_LENGTHS.source) || FIELD_DEFAULTS.source,
      temperature: truncate_(fields.temperature, FIELD_MAX_LENGTHS.temperature) || FIELD_DEFAULTS.temperature,
      budget: truncate_(fields.budget, FIELD_MAX_LENGTHS.budget),
      preferred_area: truncate_(fields.preferred_area, FIELD_MAX_LENGTHS.preferred_area),
      notes: truncate_(fields.notes, FIELD_MAX_LENGTHS.notes)
    });
  }

  writeReadySheet_(config.readyTab, readyRows);
  return { validCount: readyRows.length, invalidCount: invalidCount, reasons: reasons };
}

function writeReadySheet_(readyTabName, rows) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(readyTabName);
  if (!sheet) {
    sheet = ss.insertSheet(readyTabName);
  }
  sheet.clearContents();
  sheet.getRange(1, 1, 1, READY_COLUMNS.length).setValues([READY_COLUMNS]);

  if (rows.length === 0) return;

  var out = rows.map(function (row) {
    return READY_COLUMNS.map(function (col) { return row[col]; });
  });
  sheet.getRange(2, 1, out.length, READY_COLUMNS.length).setValues(out);
}

/* ============================================================
 * READY-TAB READING FOR SYNC
 * ========================================================== */

function readReadyRows_(readyTabName) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(readyTabName);
  if (!sheet) {
    throw new Error(
      'Ready tab "' + readyTabName + '" was not found. Run RealtorOS → Sync Now (it rebuilds Ready ' +
        'automatically), or Prepare Ready Leads, to create it.'
    );
  }

  var values = sheet.getDataRange().getDisplayValues();
  if (values.length === 0) return [];

  var header = values[0].map(function (h) { return normalizeHeaderText_(h); });
  var expected = READY_COLUMNS.map(function (h) { return normalizeHeaderText_(h); });
  var headerOk = expected.every(function (col, i) { return header[i] === col; });
  if (!headerOk) {
    throw new Error(
      'Ready tab "' + readyTabName + '" has an unexpected header row. Ready is fully script-managed ' +
        '— running Sync Now (or Prepare Ready Leads) rebuilds it automatically.'
    );
  }

  var rows = [];
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var isBlank = row.every(function (cell) { return String(cell || '').trim() === ''; });
    if (isBlank) continue;

    var obj = {};
    for (var c = 0; c < READY_COLUMNS.length; c++) {
      obj[READY_COLUMNS[c]] = truncate_(row[c], FIELD_MAX_LENGTHS[READY_COLUMNS[c]]);
    }
    rows.push(obj);
  }
  return rows;
}

function computeSheetRevision_(rows) {
  return sha256Hex_(JSON.stringify(rows));
}

/* ============================================================
 * BATCH PACKING (row-count + exact UTF-8 byte-size limits)
 * ========================================================== */

// Exactly the shape/length of every real deterministic source_event_id
// (36 ASCII characters), used only to size candidate batches before the
// real per-batch-index id is computed. Because every id this script
// generates is always exactly 36 ASCII characters, sizing against this
// placeholder is byte-for-byte identical to sizing against the real id.
var SOURCE_EVENT_ID_SIZING_PLACEHOLDER = '00000000-0000-5000-8000-000000000000';

function utf8ByteLength_(str) {
  // Deliberately not `str.length` (UTF-16 code units) — a multibyte
  // character can take more UTF-8 bytes than JS string length would
  // suggest, and the backend's 1,000,000-byte limit is a byte limit.
  return Utilities.newBlob(str).getBytes().length;
}

function envelopeByteSize_(sourceEventId, sheetRevision, rows) {
  var payload = JSON.stringify({
    source_event_id: sourceEventId,
    sheet_revision: sheetRevision,
    rows: rows
  });
  return utf8ByteLength_(payload);
}

/**
 * Splits Ready rows into batches honoring both backend limits: at most 500
 * rows per request, and a conservative 900,000-byte ceiling on the
 * complete UTF-8 JSON request body (the backend allows up to 1,000,000
 * bytes; 900,000 leaves headroom). Throws — before any HTTP call is made
 * for this revision — with a clear, actionable message if a single row
 * cannot fit under the byte ceiling even entirely on its own.
 */
function packBatches_(rows, sheetRevision) {
  var batches = [];
  var current = [];

  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var candidate = current.concat([row]);
    var fits =
      candidate.length <= MAX_ROWS_PER_BATCH &&
      envelopeByteSize_(SOURCE_EVENT_ID_SIZING_PLACEHOLDER, sheetRevision, candidate) <= MAX_BODY_BYTES;

    if (fits) {
      current = candidate;
      continue;
    }

    if (current.length > 0) {
      batches.push(current);
      current = [];
    }

    var aloneFits =
      envelopeByteSize_(SOURCE_EVENT_ID_SIZING_PLACEHOLDER, sheetRevision, [row]) <= MAX_BODY_BYTES;
    if (!aloneFits) {
      throw new Error(
        'The Ready row for lead_id "' + (row.lead_id || '(unknown)') + '" is too large to submit on ' +
          'its own — it would exceed the ' + MAX_BODY_BYTES + '-byte local safety ceiling even alone ' +
          '(the backend\'s own hard limit is 1,000,000 bytes for the whole request). No sync request ' +
          'was sent for this revision. Shorten this row\'s values in Raw Leads — Notes is the usual ' +
          'culprit — then run Sync Now again.'
      );
    }
    current = [row];
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

/* ============================================================
 * DETERMINISTIC source_event_id
 * ========================================================== */

/**
 * Deterministically derives a backend-valid UUID
 * (^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$)
 * from a stable seed: the same seed always produces the same id. Used so
 * the same spreadsheet revision and batch index reproduce the identical
 * source_event_id across separate manual/scheduled executions — required
 * so a later re-run of an unsent revision safely replays on the backend
 * rather than double-importing. Deliberately not Utilities.getUuid(),
 * which is random and would break that property.
 */
function uuidFromSeed_(seed) {
  var hex = sha256Hex_(seed).substring(0, 32); // 32 lowercase hex chars = the 8-4-4-4-12 layout below
  var chars = hex.split('');
  chars[12] = '5'; // version nibble (13th hex digit) — forced to a valid value (1-5)
  var variantSource = parseInt(chars[16], 16);
  chars[16] = ((variantSource & 0x3) | 0x8).toString(16); // variant nibble — forced into {8,9,a,b}
  var joined = chars.join('');
  return (
    joined.substring(0, 8) + '-' +
    joined.substring(8, 12) + '-' +
    joined.substring(12, 16) + '-' +
    joined.substring(16, 20) + '-' +
    joined.substring(20, 32)
  );
}

function computeSourceEventId_(spreadsheetId, sheetRevision, batchIndex) {
  var seed = 'realtoros-sheets-batch|' + spreadsheetId + '|' + sheetRevision + '|' + batchIndex;
  return uuidFromSeed_(seed);
}

/* ============================================================
 * RESPONSE VALIDATION
 * ========================================================== */

var TERMINAL_BATCH_STATUSES = { completed: true, partial: true, failed: true };
var BACKEND_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isBackendUuid_(value) {
  return typeof value === 'string' && BACKEND_UUID_PATTERN.test(value);
}

function isNonNegativeInteger_(value) {
  return typeof value === 'number' && isFinite(value) && Math.floor(value) === value && value >= 0;
}

/**
 * Validates a parsed 2xx JSON response against the full expected backend
 * shape (see supabase/functions/ingest-sheet-leads/index.ts and
 * realtoros_ingest_lead_batch()). An HTTP 2xx status alone is never
 * treated as success — the body must match this shape exactly, including
 * internal consistency between the count fields. "processing" is
 * deliberately not a recognized terminal status.
 */
function validateIngestResponse_(parsed, submittedRowCount) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'response_not_an_object' };
  }
  if (!isBackendUuid_(parsed.batch_id)) {
    return { ok: false, reason: 'invalid_batch_id' };
  }
  if (typeof parsed.status !== 'string' || !TERMINAL_BATCH_STATUSES.hasOwnProperty(parsed.status)) {
    return { ok: false, reason: 'status_not_terminal' };
  }
  var countFields = ['source_row_count', 'accepted_count', 'duplicate_count', 'rejected_count', 'imported_count'];
  for (var i = 0; i < countFields.length; i++) {
    if (!isNonNegativeInteger_(parsed[countFields[i]])) {
      return { ok: false, reason: 'invalid_' + countFields[i] };
    }
  }
  if (parsed.source_row_count !== submittedRowCount) {
    return { ok: false, reason: 'source_row_count_mismatch' };
  }
  if (parsed.accepted_count + parsed.duplicate_count + parsed.rejected_count !== parsed.source_row_count) {
    return { ok: false, reason: 'aggregate_count_mismatch' };
  }
  // The backend increments imported_count in lockstep with accepted_count
  // for every newly created contact (see realtoros_ingest_lead_batch()) —
  // they are never independent counters, so they must always be equal.
  if (parsed.imported_count !== parsed.accepted_count) {
    return { ok: false, reason: 'imported_count_inconsistent' };
  }
  if (typeof parsed.replayed !== 'boolean') {
    return { ok: false, reason: 'invalid_replayed' };
  }
  return { ok: true };
}

/* ============================================================
 * SYNC (manual + triggered)
 * ========================================================== */

function realtorosTriggeredSync() {
  runSync_(false);
}

/**
 * Core sync routine shared by "Sync Now" and the installable trigger. Both
 * paths: take the same overlap lock, load this Google account's
 * connection config, rebuild Ready from Raw Leads, read the freshly
 * rebuilt Ready content, compute its revision, and sync only when that
 * revision differs from this account's last successfully synced one.
 * @param {boolean} interactive - whether this call originates from the
 *   interactive Sync Now menu item (true) or the installable trigger
 *   (false). Both currently behave the same; kept for callers to document
 *   intent and for any future divergence.
 */
function runSync_(interactive) {
  var lock = LockService.getScriptLock();
  var haveLock = false;
  try {
    haveLock = lock.tryLock(LOCK_WAIT_MS);
  } catch (e) {
    haveLock = false;
  }
  if (!haveLock) {
    var busyMessage = 'Another RealtorOS sync is already running. Please try again shortly.';
    recordSyncStatus_('blocked', busyMessage);
    return { blocked: true, title: 'Sync busy', message: busyMessage };
  }

  try {
    var config;
    try {
      config = getConfig_();
    } catch (err) {
      var configErr = friendlyError_(err);
      recordSyncStatus_('not_configured', configErr);
      return { blocked: true, title: 'Sync not configured', message: configErr };
    }

    // Ready is fully script-managed: every sync rebuilds it from Raw Leads
    // first, so a stale or hand-edited Ready tab is never sent. All
    // corrections — including corrections to previously rejected rows —
    // belong in Raw Leads only.
    try {
      prepareReadyLeads_(config);
    } catch (err) {
      var prepErr = friendlyError_(err);
      recordSyncStatus_('failed', prepErr);
      return { blocked: true, title: 'Sync failed', message: prepErr };
    }

    var rows;
    try {
      rows = readReadyRows_(config.readyTab);
    } catch (err) {
      var readErr = friendlyError_(err);
      recordSyncStatus_('failed', readErr);
      return { blocked: true, title: 'Sync failed', message: readErr };
    }

    var sheetRevision = computeSheetRevision_(rows);
    var userProps = PropertiesService.getUserProperties();
    var lastRevision = userProps.getProperty(USER_PROP_KEYS.LAST_SUCCESSFUL_REVISION);

    if (sheetRevision === lastRevision) {
      // Unchanged since this account's last fully successful sync — zero
      // HTTP calls, no new batches.
      var unchangedMsg = rows.length === 0
        ? 'Raw Leads has no valid leads, and this empty state was already synced — 0 HTTP requests made.'
        : 'No changes since the last successful sync (' + rows.length + ' row(s), revision unchanged) — 0 HTTP requests made.';
      recordSyncStatus_('unchanged', unchangedMsg);
      return { blocked: false, title: 'Nothing to sync', message: unchangedMsg };
    }

    if (rows.length === 0) {
      // A freshly rebuilt, genuinely empty Ready tab (e.g. Raw Leads is
      // empty, or every row was invalid) is a valid, trivially successful
      // outcome, handled without any HTTP call. We record this empty
      // revision as successfully handled so a later run on a still-empty
      // sheet also skips cleanly via the branch above — this is a
      // deliberate, documented choice (see the README).
      userProps.setProperty(USER_PROP_KEYS.LAST_SUCCESSFUL_REVISION, sheetRevision);
      var emptyMsg = 'Raw Leads produced no valid leads to sync (0 rows) — 0 HTTP requests made.';
      recordSyncStatus_('empty', emptyMsg);
      return { blocked: false, title: 'Nothing to sync', message: emptyMsg };
    }

    var spreadsheetId = SpreadsheetApp.getActiveSpreadsheet().getId();
    var batches;
    try {
      batches = packBatches_(rows, sheetRevision);
    } catch (err) {
      var packErr = friendlyError_(err);
      recordSyncStatus_('failed', packErr);
      return { blocked: true, title: 'Sync not started', message: packErr };
    }

    var totals = { imported: 0, duplicate: 0, rejected: 0, accepted: 0 };
    var failedBatches = [];

    for (var b = 0; b < batches.length; b++) {
      var sourceEventId = computeSourceEventId_(spreadsheetId, sheetRevision, b);
      var outcome = sendBatchWithRetry_(config, batches[b], sheetRevision, sourceEventId);
      if (outcome.ok) {
        totals.imported += outcome.data.imported_count;
        totals.duplicate += outcome.data.duplicate_count;
        totals.rejected += outcome.data.rejected_count;
        totals.accepted += outcome.data.accepted_count;
      } else {
        failedBatches.push({ batchIndex: b + 1, rowCount: batches[b].length, error: outcome.error });
      }
    }

    var allOk = failedBatches.length === 0;
    var summaryParts = [
      'Imported: ' + totals.imported,
      'Duplicate: ' + totals.duplicate,
      'Rejected (correct these in Raw Leads): ' + totals.rejected
    ];
    if (!allOk) {
      summaryParts.push(failedBatches.length + ' of ' + batches.length + ' batch(es) could not be submitted.');
    }
    var summaryText = summaryParts.join(' | ');

    if (allOk) {
      // Only advance once every batch of this exact revision has a fully
      // validated successful response — never on a partial run.
      userProps.setProperty(USER_PROP_KEYS.LAST_SUCCESSFUL_REVISION, sheetRevision);
      recordSyncStatus_('completed', summaryText);
      return {
        blocked: false,
        title: 'Sync completed',
        message: summaryText + '\n\nRejected rows are not a Ready-tab problem — correct the ' +
          'underlying values in "' + config.rawTab + '". The next sync rebuilds "' + config.readyTab +
          '" from Raw Leads and resends the changed revision.'
      };
    }

    recordSyncStatus_('completed_with_errors', summaryText);
    var errorDetail = failedBatches.map(function (f) {
      return 'Batch ' + f.batchIndex + ' (' + f.rowCount + ' rows): ' + f.error;
    }).join('\n');
    return {
      blocked: false,
      title: 'Sync completed with errors',
      message: summaryText + '\n\n' + errorDetail +
        '\n\nNo failed or malformed batch was reported as a success, and this revision was not marked ' +
        'as synced — the next sync will rebuild Ready and resend this same revision in full.'
    };
  } finally {
    if (haveLock) lock.releaseLock();
  }
}

function recordSyncStatus_(status, summary) {
  var props = PropertiesService.getDocumentProperties();
  props.setProperty(DOC_STATUS_KEYS.LAST_SYNC_AT, new Date().toISOString());
  props.setProperty(DOC_STATUS_KEYS.LAST_SYNC_STATUS, status);
  props.setProperty(DOC_STATUS_KEYS.LAST_SYNC_SUMMARY, summary);
}

/**
 * Sends one batch, retrying only on HTTP 429/5xx and on requests that
 * never receive any HTTP response at all (transport failure). A malformed
 * or internally inconsistent 2xx response is a terminal failure for this
 * attempt — it is never retried as if it were a 429/5xx, and never
 * advances the caller's synced-revision bookkeeping. The same
 * deterministic source_event_id (passed in, stable across every attempt
 * and across separate executions of the same batch) is reused on every
 * attempt of this batch; a fresh nonce and timestamp are generated for
 * every individual HTTP attempt. Redirects are never followed — a
 * redirect must not resend the connector token elsewhere, and is never
 * treated as success.
 */
function sendBatchWithRetry_(config, rows, sheetRevision, sourceEventId) {
  var lastError = 'unknown_error';

  for (var attempt = 1; attempt <= MAX_SYNC_ATTEMPTS; attempt++) {
    var timestampSeconds = Math.floor(Date.now() / 1000);
    var nonce = Utilities.getUuid();
    var payload = JSON.stringify({
      source_event_id: sourceEventId,
      sheet_revision: sheetRevision,
      rows: rows
    });

    // Defensive final check: packBatches_ already guarantees this given
    // the fixed-length placeholder invariant, but never send a request we
    // haven't confirmed is within the backend's own hard limit.
    if (utf8ByteLength_(payload) > MAX_BODY_BYTES) {
      return { ok: false, error: 'local_payload_exceeds_safety_ceiling' };
    }

    var options = {
      method: 'post',
      contentType: 'application/json',
      payload: payload,
      headers: {
        Authorization: 'Bearer ' + config.connectorToken,
        'X-RealtorOS-Timestamp': String(timestampSeconds),
        'X-RealtorOS-Nonce': nonce
      },
      muteHttpExceptions: true,
      // Never follow a redirect: the connector token must never be resent
      // to a different destination, and a redirect must never be treated
      // as a successful sync.
      followRedirects: false
    };

    var response;
    var transportFailed = false;
    try {
      response = UrlFetchApp.fetch(config.ingestUrl, options);
    } catch (err) {
      transportFailed = true;
      lastError = 'network_error';
    }

    if (!transportFailed) {
      var code = response.getResponseCode();

      if (code >= 200 && code < 300) {
        var parsed = null;
        try {
          parsed = JSON.parse(response.getContentText());
        } catch (e) {
          parsed = null;
        }
        if (parsed === null) {
          return { ok: false, error: 'malformed_response:not_json (HTTP ' + code + ')' };
        }
        var validation = validateIngestResponse_(parsed, rows.length);
        if (validation.ok) {
          return { ok: true, data: parsed };
        }
        // A malformed/inconsistent 2xx body is a terminal failure for
        // this attempt — never retried the way a 429/5xx would be.
        return { ok: false, error: 'malformed_response:' + validation.reason + ' (HTTP ' + code + ')' };
      }

      var errorCode = 'http_' + code;
      try {
        var errParsed = JSON.parse(response.getContentText());
        if (errParsed && typeof errParsed.error === 'string') errorCode = errParsed.error;
      } catch (e) { /* non-JSON error body — keep the http_<code> fallback */ }
      lastError = errorCode;

      var retryable = code === 429 || (code >= 500 && code < 600);
      if (!retryable) {
        return { ok: false, error: errorCode + ' (HTTP ' + code + ')' };
      }
    }

    if (attempt < MAX_SYNC_ATTEMPTS) {
      Utilities.sleep(Math.pow(2, attempt) * 1000); // 2s, 4s, ...
    }
  }

  return { ok: false, error: lastError + ' (retries exhausted)' };
}

/* ============================================================
 * TRIGGER HELPERS
 * ========================================================== */

// ScriptApp.getProjectTriggers() only ever returns triggers the CURRENT
// Google user created for this script project — it cannot see, and
// deleteTrigger() cannot remove, a trigger a different editor installed
// under their own account. Enumeration/removal here is therefore always
// scoped to "this Google account's own triggers," never "every trigger
// anyone has ever installed on this spreadsheet."

function removeRealtorosTriggers_() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === SYNC_TRIGGER_HANDLER) {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  return removed;
}

function countRealtorosTriggers_() {
  var triggers = ScriptApp.getProjectTriggers();
  var count = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === SYNC_TRIGGER_HANDLER) count++;
  }
  return count;
}

/* ============================================================
 * MISC HELPERS
 * ========================================================== */

function friendlyError_(err) {
  return err && err.message ? err.message : String(err);
}
