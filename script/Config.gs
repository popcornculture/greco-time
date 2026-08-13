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
 *   DEFAULT_RATE      Optional. Blank (the default) makes MyCase use the rate already
 *                     set on the case/user, which is usually what you want.
 *   RATE_TYPE         Defaults to "Hourly". The template's other value is "Flat Fee".
 *   DEFAULT_ACTIVITY  Optional MyCase activity-picklist value; blank by default.
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
 * ─── Verified against MyCase's own template, 2026-08-13 ───────────────────────
 *
 * Taken from the real `time_entry_import.csv` downloaded from
 * Billing → Time Entries → Import Time Entries → Download CSV template:
 *
 *   Case Name,User,Activity,Note,Date,Rate,Rate Type,Hours,Nonbillable
 *   Example Court Case 1,John Doe,Filing Fees,Description about the time entry.,5/6/21,30,Hourly,6,FALSE
 *
 * MyCase says "do not edit the column headers", so these strings and this order are
 * fixed. The rest of the code addresses columns by `key`, never by header text or
 * position.
 *
 * Two of these are traps:
 *
 *   Nonbillable — INVERTED. Billable time is FALSE, not TRUE. Writing TRUE here would
 *                 import every entry as non-billable and Paul would bill nothing.
 *   Case Name   — MyCase matches on the *case* name, not the client/contact name. The
 *                 Clients tab therefore has to hold case names as MyCase spells them.
 */
var MYCASE_FIELDS = [
  { key: 'client',      header: 'Case Name',   value: function (e) { return e.client; } },
  { key: 'timekeeper',  header: 'User',        value: function (e) { return e.timekeeper; } },
  // Activity is a MyCase picklist we do not collect; blank lets MyCase apply its default.
  { key: 'activity',    header: 'Activity',    value: function (e) { return prop('DEFAULT_ACTIVITY', ''); } },
  { key: 'description', header: 'Note',        value: function (e) { return e.description || ''; } },
  { key: 'date',        header: 'Date',        value: function (e) { return toSheetDate(e.date); } },
  // Blank by default so MyCase falls back to the rate already on the case/user.
  { key: 'rate',        header: 'Rate',        value: function (e) { return prop('DEFAULT_RATE', ''); } },
  { key: 'rateType',    header: 'Rate Type',   value: function (e) { return prop('RATE_TYPE', 'Hourly'); } },
  { key: 'hours',       header: 'Hours',       value: function (e) { return e.hours; } },
  // FALSE = billable. See the warning above.
  { key: 'nonbillable', header: 'Nonbillable', value: function (e) { return 'FALSE'; } },
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

/* Column A must hold the MyCase **Case Name**, because that is what the import matches
 * on. The app labels it "Client" because that is how the office talks about it. */
var CLIENT_HEADERS = ['CaseName', 'DefaultMatterType', 'AddedAt', 'AddedBy'];
var DEVICE_HEADERS = ['DeviceId', 'Timekeeper', 'IsTest', 'FirstSeen', 'LastSeen'];

/* MyCase's own template writes dates as 5/6/21, so the export matches that exactly —
 * Sheets writes the *displayed* value into a CSV, which makes this the wire format.
 * A guessed MM/dd/yyyy might well be accepted too, but this form is known-good. */
var MYCASE_DATE_FORMAT = 'M/d/yy';

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
