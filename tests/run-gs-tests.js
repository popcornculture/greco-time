/* Server-side checks for the Apps Script project.
 *
 * The Google services cannot be exercised outside Apps Script, but loading all four
 * .gs files catches syntax errors before a clasp push, and the parts that actually
 * decide whether money is billed correctly — column addressing, date construction,
 * entry validation — are pure and worth testing here.
 *
 *   /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc \
 *     script/Config.gs script/Code.gs script/Sheet.gs script/Mail.gs \
 *     tests/run-gs-tests.js
 */

/* Minimal stand-in for the one Google service the tested paths touch. Rate, Rate Type
 * and Activity read Script Properties so they can be configured without a code change,
 * which means row building needs this present. An empty store also exercises the
 * defaults, which is the configuration that will actually ship. */
var PROPS = {};
var PropertiesService = {
  getScriptProperties: function () {
    return {
      getProperty: function (k) { return Object.prototype.hasOwnProperty.call(PROPS, k) ? PROPS[k] : null; },
      setProperty: function (k, v) { PROPS[k] = v; },
    };
  },
};

var pass = 0, fail = 0, failures = [];

function eq(actual, expected, label) {
  var a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) pass++;
  else { fail++; failures.push(label + '\n      expected ' + b + '\n      actual   ' + a); }
}
function throws(fn, label) {
  try { fn(); fail++; failures.push(label + '\n      expected a throw, got none'); }
  catch (e) { pass++; }
}
function group(name) { print('\n' + name); }

/* ─────────────────────── loading (a syntax check in itself) ─────────────────────── */
group('project loads');
eq(typeof doPost, 'function', 'doPost is defined');
eq(typeof saveEntries, 'function', 'saveEntries is defined');
eq(typeof rebuildExport, 'function', 'rebuildExport is defined');
eq(typeof markExported, 'function', 'markExported is defined');
eq(typeof sendDailyDigest, 'function', 'sendDailyDigest is defined');
eq(typeof onOpen, 'function', 'onOpen is defined');
eq(typeof rebuildExportFor, 'function', 'rebuildExportFor is defined');
eq(typeof markExportedFor, 'function', 'markExportedFor is defined');
eq(typeof undoExportMark, 'function', 'undoExportMark is defined');
eq(typeof exportCsv, 'function', 'exportCsv is defined');
eq(typeof calendarSuggestions, 'function', 'calendarSuggestions is defined');

/* Every menu item names a zero-argument function by string, so a typo or a rename is
 * invisible until someone clicks it and gets "Script function not found". */
['menuPrepareTime', 'menuPrepareExpense', 'menuTestTime', 'menuTestExpense',
 'menuMarkTime', 'menuMarkExpense', 'menuUndoTime', 'menuUndoExpense',
 'menuSetPin', 'menuSetupLink', 'menuEmailSetupLink', 'menuSendDigest'].forEach(function (fn) {
  eq(typeof this[fn], 'function', 'menu handler ' + fn + ' exists');
}, this);

/* ─────────────────────────── column addressing ─────────────────────────── */
group('column addressing');

/* The MyCase block must come first and unbroken, because rebuildExport() slices the
 * left-hand columns off each row. */
eq(ENTRY_HEADERS.length, MYCASE_FIELDS.length + INTERNAL_FIELDS.length, 'headers cover both blocks');
eq(ENTRY_HEADERS.slice(0, MYCASE_FIELDS.length),
   MYCASE_FIELDS.map(function (f) { return f.header; }), 'MyCase columns come first, in order');

/* The export must reproduce MyCase's template headers and order exactly. Taken from the
 * real time_entry_import.csv, verified 2026-08-13. MyCase says do not edit the headers,
 * so this asserts the whole row literally. */
eq(MYCASE_FIELDS.map(function (f) { return f.header; }),
   ['Case Name', 'User', 'Activity', 'Note', 'Date', 'Rate', 'Rate Type', 'Hours', 'Nonbillable'],
   'headers match the MyCase template character for character, in order');

['date', 'client', 'timekeeper', 'description', 'hours'].forEach(function (k) {
  eq(col(k) < MYCASE_FIELDS.length, true, 'key "' + k + '" lives in the MyCase block');
});
['uuid', 'isTest', 'exported', 'matterType', 'deviceId'].forEach(function (k) {
  eq(col(k) >= MYCASE_FIELDS.length, true, 'key "' + k + '" lives in the internal block');
});
throws(function () { col('nonsense'); }, 'an unknown key throws rather than returning -1');

/* A duplicate key would make col() silently address the wrong column. */
var keys = ALL_FIELDS.map(function (f) { return f.key; });
eq(keys.length, keys.filter(function (k, i) { return keys.indexOf(k) === i; }).length, 'no duplicate keys');
var heads = ALL_FIELDS.map(function (f) { return f.header; });
eq(heads.length, heads.filter(function (h, i) { return heads.indexOf(h) === i; }).length, 'no duplicate headers');

/* ─────────────────────────── date construction ─────────────────────────── */
group('toSheetDate  (must not slide a day)');

var d = toSheetDate('2026-08-13');
eq([d.getFullYear(), d.getMonth(), d.getDate()], [2026, 7, 13], 'builds local midnight, not UTC midnight');
eq(toSheetDate('2026-01-01').getDate(), 1, 'new year holds');
eq(toSheetDate('2026-12-31').getMonth(), 11, 'december holds');
eq(toSheetDate('not-a-date'), 'not-a-date', 'garbage passes through untouched');

/* new Date('2026-08-13') is UTC midnight, i.e. 12 Aug in California. This asserts the
 * bug being avoided is real, so the guard is never "simplified" away. */
eq(new Date('2026-08-13').getUTCDate(), 13, 'string parsing is UTC-based (the hazard)');

/* ────────────────────────────── row building ────────────────────────────── */
group('row building');

var entry = {
  uuid: 'u-1', date: '2026-08-13', client: 'Maria Ramirez', timekeeper: 'Paul Greco',
  hours: 1.5, description: 'Phone call w/ DA', matterType: 'Criminal',
  isTest: false, deviceId: 'dev-1',
};
var row = ALL_FIELDS.map(function (f) { return f.value(entry); });

eq(row.length, ENTRY_HEADERS.length, 'row width matches the header row');
eq(row[col('client')], 'Maria Ramirez', 'client lands in Case Name');
eq(row[col('timekeeper')], 'Paul Greco', 'timekeeper lands in User');
eq(row[col('hours')], 1.5, 'hours land as a number, not a string');
eq(row[col('description')], 'Phone call w/ DA', 'description lands in Note');

/* The single most expensive possible bug: Nonbillable is inverted, so billable time
 * must be FALSE. TRUE here would import every entry as non-billable. */
eq(row[col('nonbillable')], 'FALSE', 'billable time is Nonbillable=FALSE, not TRUE');
eq(row[col('rateType')], 'Hourly', 'rate type defaults to Hourly, not Flat Fee');
eq(row[col('matterType')], 'Criminal', 'matter type lands in the internal block');
eq(row[col('isTest')], 'FALSE', 'test flag written as a sheet-readable FALSE');
eq(row[col('exported')], 'FALSE', 'new rows start un-exported');
eq(row[col('date')] instanceof Date, true, 'date lands as a real Date');

eq(ALL_FIELDS.map(function (f) { return f.value({ uuid: 'u', date: '2026-08-13', client: 'X',
  timekeeper: 'Y', hours: 0.1, isTest: true }); })[col('isTest')], 'TRUE', 'test entries flagged TRUE');

/* Rate is deliberately blank so MyCase falls back to the rate on the case, but it has to
 * stay overridable without touching code. */
eq(row[col('rate')], '', 'rate is blank by default');
PROPS.DEFAULT_RATE = '350';
PROPS.RATE_TYPE = 'Flat Fee';
var row2 = ALL_FIELDS.map(function (f) { return f.value(entry); });
eq(row2[col('rate')], '350', 'DEFAULT_RATE overrides the blank');
eq(row2[col('rateType')], 'Flat Fee', 'RATE_TYPE is overridable');
delete PROPS.DEFAULT_RATE; delete PROPS.RATE_TYPE;

/* ─────────────────────────── entry validation ─────────────────────────── */
group('validateEntry');

var roster = { 'Paul Greco': { name: 'Paul Greco', isTest: false },
               'Staff': { name: 'Staff', isTest: false } };
function v(over) {
  var e = { uuid: 'u', date: '2026-08-13', client: 'Maria Ramirez',
            timekeeper: 'Paul Greco', hours: 1.5 };
  for (var k in over) e[k] = over[k];
  return validateEntry(e, roster);
}

eq(v({}), null, 'a good entry passes');
eq(v({ uuid: '' }) !== null, true, 'missing id refused');
eq(v({ date: '08/13/2026' }) !== null, true, 'US-format date refused (ISO expected on the wire)');
eq(v({ date: '' }) !== null, true, 'missing date refused');
eq(v({ client: '   ' }) !== null, true, 'blank client refused');
eq(v({ hours: 0 }) !== null, true, 'zero hours refused');
eq(v({ hours: -2 }) !== null, true, 'negative hours refused');
eq(v({ hours: 'abc' }) !== null, true, 'non-numeric hours refused');
eq(v({ hours: 25 }) !== null, true, 'more than a day refused');
eq(v({ hours: 24 }), null, 'exactly 24 hours allowed');
eq(v({ description: undefined }), null, 'description is optional');

/* The timekeeper string is what MyCase matches on, so an unrecognised one has to be
 * refused rather than guessed at or quietly reassigned. */
eq(v({ timekeeper: 'Someone Else' }) !== null, true, 'unknown timekeeper refused');
eq(v({ timekeeper: 'paul greco' }) !== null, true, 'timekeeper match is case-sensitive');
eq(v({ timekeeper: '' }) !== null, true, 'missing timekeeper refused');
eq(v({ timekeeper: 'Staff' }), null, 'a second rostered timekeeper passes');

/* ─────────────────────── expense column addressing ─────────────────────── */
group('expense columns');

eq(EXPENSE_HEADERS[0], 'Case Name', 'the expense export also starts at Case Name');
eq(EXPENSE_HEADERS.slice(0, MYCASE_EXPENSE_FIELDS.length).indexOf('UUID'), -1,
   'no bookkeeping column sits inside the MyCase block');
eq(ecol('uuid') >= MYCASE_EXPENSE_FIELDS.length, true,
   'bookkeeping columns are to the right of the MyCase block, so the export slices cleanly');
throws(function () { ecol('nope'); }, 'an unknown expense key throws rather than returning 0');

/* specCol must agree with the per-tab helpers, or the export reads the wrong columns. */
eq(specCol(exportSpec('time'), 'hours'), col('hours'), 'specCol matches col() for time');
eq(specCol(exportSpec('expense'), 'amount'), ecol('amount'), 'specCol matches ecol() for expenses');
eq(exportSpec('time').source !== exportSpec('expense').source, true,
   'the two kinds write to different tabs');
eq(exportSpec('time').batchTab !== exportSpec('expense').batchTab, true,
   'and track their export batches separately, so marking one cannot mark the other');
throws(function () { exportSpec('nope'); }, 'an unknown export kind throws');

/* ─────────────────────── expense row building ─────────────────────── */
group('expense row building');

var exp = { uuid: 'x1', date: '2026-08-19', client: 'Maria Ramirez', timekeeper: 'Paul Greco',
            amount: 435.5, description: 'Filing fee — petition', matterType: 'Conservatorship',
            isTest: false, deviceId: 'd1', nonbillable: false };
var erow = ALL_EXPENSE_FIELDS.map(function (f) { return f.value(exp); });

eq(erow[ecol('client')], 'Maria Ramirez', 'case name lands in column A');
eq(erow[ecol('amount')], 435.5, 'the whole amount goes in Cost');
eq(erow[ecol('quantity')], 1, 'quantity is 1, so Cost is never a unit price to be multiplied');
eq(erow[ecol('description')], 'Filing fee — petition', 'the note says what the money was for');

/* Same inversion trap as the time template: FALSE means "bill this". */
eq(erow[ecol('nonbillable')], 'FALSE', 'a billable expense is Nonbillable=FALSE');
eq(ALL_EXPENSE_FIELDS.map(function (f) { return f.value(
   { uuid: 'x', amount: 1, nonbillable: true }); })[ecol('nonbillable')], 'TRUE',
   'ticking "do not bill" is the only thing that writes TRUE');

eq(erow[ecol('date')] instanceof Date, true, 'the date is a real Date, not a string');
eq(erow[ecol('date')].getDate(), 19, 'and it has not slid a day');

/* ─────────────────────── expense validation ─────────────────────── */
group('validateEntry  (expenses)');

function ve(over) {
  var e = { uuid: 'u', kind: 'expense', date: '2026-08-19', client: 'Maria Ramirez',
            timekeeper: 'Paul Greco', amount: 435, description: 'Filing fee' };
  for (var k in over) e[k] = over[k];
  return validateEntry(e, roster);
}

eq(ve({}), null, 'a good expense passes');
eq(ve({ amount: 0 }) !== null, true, 'zero refused');
eq(ve({ amount: -5 }) !== null, true, 'negative refused');
eq(ve({ amount: 'abc' }) !== null, true, 'non-numeric refused');
eq(ve({ amount: undefined }) !== null, true, 'missing amount refused');
eq(ve({ amount: MAX_AMOUNT_PER_EXPENSE + 1 }) !== null, true, 'above the ceiling refused');
eq(ve({ amount: MAX_AMOUNT_PER_EXPENSE }), null, 'exactly at the ceiling allowed');
eq(ve({ amount: 0.01 }), null, 'one cent is a real expense');

/* Unlike time, the note is mandatory: it is the line item on the client's bill. */
eq(ve({ description: '' }) !== null, true, 'an expense with no description is refused');
eq(ve({ description: '   ' }) !== null, true, 'whitespace is not a description');

/* An expense must not be validated as if it were time, or vice versa. */
eq(ve({ hours: 99 }), null, 'a stray hours value is ignored on an expense');
eq(validateEntry({ uuid: 'u', kind: 'expense', date: '2026-08-19', client: 'c',
                   timekeeper: 'Paul Greco', hours: 1.5, description: 'x' }, roster) !== null, true,
   'an expense carrying only hours is refused — there is no amount to bill');

group('entryKind');
eq(entryKind({ kind: 'expense' }), 'expense', 'explicit expense');
eq(entryKind({ kind: 'time' }), 'time', 'explicit time');
/* Older builds send no kind at all, and every row written before expenses existed has
 * none either. Both must keep behaving as hourly time. */
eq(entryKind({}), 'time', 'a missing kind is time');
eq(entryKind({ kind: '' }), 'time', 'an empty kind is time');
eq(entryKind(null), 'time', 'a null entry is time');
eq(entryKind({ kind: 'EXPENSE' }), 'time', 'the match is exact, so nothing unexpected bills as money');

/* ─────────────────────── normalisation ─────────────────────── */
group('normaliseEntry');

var nt = normaliseEntry(exportSpec('time'),
  { uuid: 'u', date: '2026-08-19', client: '  Maria   Ramirez ', timekeeper: 'Paul Greco',
    hours: 1.24, description: ' call ' });
eq(nt.hours, 1.2, 'hours snap to the tenth');
eq(nt.client, 'Maria Ramirez', 'the client name is collapsed and trimmed');
eq(nt.description, 'call', 'the description is trimmed');

var ne = normaliseEntry(exportSpec('expense'),
  { uuid: 'u', date: '2026-08-19', client: 'Maria Ramirez', timekeeper: 'Paul Greco',
    amount: 12.349, description: 'copies', nonbillable: true });
eq(ne.amount, 12.35, 'money rounds to the cent, not the tenth');
eq(ne.nonbillable, true, 'the do-not-bill flag survives');
eq(ne.hours, undefined, 'an expense carries no hours');
eq(normaliseEntry(exportSpec('time'), { uuid: 'u', client: 'c', hours: 1 }).amount, undefined,
   'a time entry carries no amount');

/* ─────────────────────── CSV quoting ─────────────────────── */
group('csvCell  (a stray comma shifts every later column)');

eq(csvCell('Maria Ramirez'), 'Maria Ramirez', 'a plain value is not quoted');
eq(csvCell(''), '', 'empty stays empty');
eq(csvCell(0), '0', 'zero is not treated as empty');
eq(csvCell(null), '', 'null becomes empty');
eq(csvCell(undefined), '', 'undefined becomes empty');

/* Real case names contain commas — "Estate of Ruiz, Deceased". Unquoted, the note ends up
 * parsed as the date and the row silently imports wrong. */
eq(csvCell('Estate of Ruiz, Deceased'), '"Estate of Ruiz, Deceased"', 'a comma forces quoting');
eq(csvCell('He said "no"'), '"He said ""no"""', 'quotes are doubled and the cell quoted');
eq(csvCell('line1\nline2'), '"line1\nline2"', 'a newline forces quoting');
eq(csvCell(' padded '), '" padded "', 'edge whitespace is preserved by quoting');

eq(toCsv([['a', 'b'], ['c', 'd']]), 'a,b\r\nc,d\r\n', 'CRLF line endings, trailing newline');
eq(toCsv([['Case Name', 'Hours'], ['Ruiz, Ana', 1.5]]),
   'Case Name,Hours\r\n"Ruiz, Ana",1.5\r\n', 'a real row round-trips');

/* ─────────────────────── calendar helpers ─────────────────────── */
group('calendar filtering');

eq(shouldIgnoreEvent('Lunch with Dave', CALENDAR_IGNORE_DEFAULT), true, 'lunch is not billable');
eq(shouldIgnoreEvent('OOO', CALENDAR_IGNORE_DEFAULT), true, 'out of office is skipped');
eq(shouldIgnoreEvent('Hearing re Ramirez', CALENDAR_IGNORE_DEFAULT), false, 'a hearing is kept');
eq(shouldIgnoreEvent('', CALENDAR_IGNORE_DEFAULT), true, 'an untitled event is skipped');
eq(shouldIgnoreEvent('HOLIDAY', CALENDAR_IGNORE_DEFAULT), true, 'the match is case-insensitive');

PROPS.CALENDAR_IDS = '{"Paul Greco":"paul@grecolawgroup.com"}';
eq(calendarIdFor('Paul Greco'), 'paul@grecolawgroup.com', 'a mapped timekeeper gets their calendar');
eq(calendarIdFor('Staff'), 'primary', 'anyone unmapped falls back to primary');
PROPS.DEFAULT_CALENDAR_ID = 'shared@grecolawgroup.com';
eq(calendarIdFor('Staff'), 'shared@grecolawgroup.com', 'DEFAULT_CALENDAR_ID overrides the fallback');
PROPS.CALENDAR_IDS = 'not json at all';
eq(calendarIdFor('Paul Greco'), 'shared@grecolawgroup.com',
   'a malformed CALENDAR_IDS falls back rather than throwing');
delete PROPS.CALENDAR_IDS; delete PROPS.DEFAULT_CALENDAR_ID;

eq(calendarIgnoreList(), CALENDAR_IGNORE_DEFAULT, 'the default ignore list applies when unset');
PROPS.CALENDAR_IGNORE = 'lunch, Gym ,,';
eq(calendarIgnoreList(), ['lunch', 'gym'], 'CALENDAR_IGNORE replaces the list, trimmed and lowercased');
delete PROPS.CALENDAR_IGNORE;

/* ─────────────────────── expense header override ─────────────────────── */
group('expenseHeader  (correctable without a code change)');

eq(expenseHeader({ key: 'amount', header: 'Cost' }), 'Cost', 'the built-in header by default');
PROPS.MYCASE_EXPENSE_HEADERS = '{"amount":"Amount","category":"Type"}';
eq(expenseHeader({ key: 'amount', header: 'Cost' }), 'Amount', 'the property overrides it');
eq(expenseHeader({ key: 'client', header: 'Case Name' }), 'Case Name', 'unlisted keys are untouched');
PROPS.MYCASE_EXPENSE_HEADERS = '{"amount":""}';
eq(expenseHeader({ key: 'amount', header: 'Cost' }), 'Cost', 'a blank override is ignored');
PROPS.MYCASE_EXPENSE_HEADERS = 'broken';
eq(expenseHeader({ key: 'amount', header: 'Cost' }), 'Cost', 'malformed JSON falls back');
delete PROPS.MYCASE_EXPENSE_HEADERS;

/* The guard that stops a guessed template being imported silently. */
eq(exportSpec('time').verified, true, 'the time template is verified against the real file');
eq(exportSpec('expense').verified, false,
   'the expense template is NOT — flip VERIFIED_EXPENSE_TEMPLATE once it has been checked');

/* ─────────────────────────────── summary ─────────────────────────────── */

print('\n' + '─'.repeat(60));
if (fail) {
  print(fail + ' FAILED, ' + pass + ' passed\n');
  failures.forEach(function (f) { print('  ✗ ' + f); });
} else {
  print('All ' + pass + ' assertions passed.');
}
print('');
