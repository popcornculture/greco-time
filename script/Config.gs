/**
 * Greco Time — configuration.
 *
 * Everything environment-specific lives in Script Properties (Project Settings →
 * Script Properties), never in this file, because the companion repo is public.
 *
 *   PIN_HASH        SHA-256 hex of the device PIN. Set it via the Sheet's
 *                   "Greco Time → Set PIN…" menu rather than by hand.
 *   SHEET_ID        Spreadsheet to write to. Optional if the script is bound to it.
 *   TIMEKEEPERS     JSON array, e.g.
 *                     [{"name":"Paul Greco","isTest":false},
 *                      {"name":"Staff","isTest":false},
 *                      {"name":"Alex (testing)","isTest":true}]
 *                   Names must match MyCase's spelling exactly — the import matches
 *                   on this string.
 *   NOTIFY_ENTRY    Comma-separated recipients for per-save confirmations.
 *   NOTIFY_DIGEST   Comma-separated recipients for the end-of-day digest.
 *   SEND_PER_ENTRY  "false" turns off per-save email (see the quota note below).
 *   PWA_URL         Where the web app is hosted, e.g.
 *                   https://<user>.github.io/greco-time/ — used only to print
 *                   the setup link from the Sheet menu.
 *
 * Mail quota: MailApp allows 1,500 recipients/day on Google Workspace but only 100/day
 * on a consumer Gmail account. Per-save email is collapsed to one message per flush
 * batch, and test entries never generate mail, which keeps normal use well inside
 * Workspace limits. On a consumer account, set SEND_PER_ENTRY=false.
 */

var TABS = {
  entries: 'TimeEntries',
  clients: 'Clients',
  devices: 'Devices',
  export: 'MyCaseExport',
  batch: '_ExportBatch',   // hidden; remembers which rows the last export contained
};

/**
 * ─── UNVERIFIED: replace with the real MyCase template headers ────────────────
 *
 * MyCase's importer says "do not edit the column headers", so these must match its
 * downloaded template character for character. Get the real file from
 * Billing → Time Entries → Import Time Entries → Download CSV template, then edit the
 * `header` strings — and only those — below. Reorder the array if the template's column
 * order differs; the export follows this array.
 *
 * The rest of the code addresses columns by `key`, never by header text or position, so
 * renaming or reordering headers here cannot break the digest or the export.
 */
var MYCASE_FIELDS = [
  { key: 'date',        header: 'Date',        value: function (e) { return toSheetDate(e.date); } },
  { key: 'client',      header: 'Case',        value: function (e) { return e.client; } },
  { key: 'timekeeper',  header: 'User',        value: function (e) { return e.timekeeper; } },
  { key: 'activity',    header: 'Activity',    value: function (e) { return ''; } },
  { key: 'description', header: 'Description', value: function (e) { return e.description || ''; } },
  { key: 'hours',       header: 'Hours',       value: function (e) { return e.hours; } },
  { key: 'rate',        header: 'Rate',        value: function (e) { return ''; } },
  { key: 'billable',    header: 'Billable',    value: function (e) { return 'Yes'; } },
];

/** Bookkeeping columns, kept to the right of the MyCase block so the export can slice
 *  cleanly off the left. */
var INTERNAL_FIELDS = [
  { key: 'uuid',        header: 'UUID',        value: function (e) { return e.uuid; } },
  { key: 'submittedAt', header: 'SubmittedAt', value: function (e) { return new Date(); } },
  { key: 'deviceId',    header: 'DeviceId',    value: function (e) { return e.deviceId || ''; } },
  { key: 'matterType',  header: 'MatterType',  value: function (e) { return e.matterType || ''; } },
  { key: 'isTest',      header: 'IsTest',      value: function (e) { return e.isTest ? 'TRUE' : 'FALSE'; } },
  { key: 'exported',    header: 'Exported',    value: function (e) { return 'FALSE'; } },
];

var ALL_FIELDS = MYCASE_FIELDS.concat(INTERNAL_FIELDS);
var ENTRY_HEADERS = ALL_FIELDS.map(function (f) { return f.header; });

/** Zero-based column index of a logical field on the TimeEntries tab. */
function col(key) {
  for (var i = 0; i < ALL_FIELDS.length; i++) if (ALL_FIELDS[i].key === key) return i;
  throw new Error('Unknown column key: ' + key);
}

var CLIENT_HEADERS = ['ClientName', 'DefaultMatterType', 'AddedAt', 'AddedBy'];
var DEVICE_HEADERS = ['DeviceId', 'Timekeeper', 'IsTest', 'FirstSeen', 'LastSeen'];

var MAX_HOURS_PER_ENTRY = 24;
var MAX_FAILED_PINS = 10;          // per device, per hour
var SUSPICIOUS_HOURS = 8;          // flagged in the digest, not blocked

function prop(key, fallback) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  return (v === null || v === '') ? (fallback === undefined ? '' : fallback) : v;
}

function book() {
  var id = prop('SHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function timekeepers() {
  try {
    var list = JSON.parse(prop('TIMEKEEPERS', '[]'));
    return list.map(function (t) {
      return typeof t === 'string'
        ? { name: t, isTest: false }
        : { name: String(t.name), isTest: Boolean(t.isTest) };
    }).filter(function (t) { return t.name; });
  } catch (err) {
    return [];
  }
}

/**
 * 'YYYY-MM-DD' → a Date at local midnight.
 *
 * new Date('2026-08-13') parses as UTC midnight, which renders as 12 August in
 * California — an off-by-one-day bug on every single entry. Building from explicit
 * parts avoids it, and appsscript.json pins the timezone.
 */
function toSheetDate(iso) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso));
  if (!m) return iso;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}
