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

/* ─────────────────────────────── summary ─────────────────────────────── */

print('\n' + '─'.repeat(60));
if (fail) {
  print(fail + ' FAILED, ' + pass + ' passed\n');
  failures.forEach(function (f) { print('  ✗ ' + f); });
} else {
  print('All ' + pass + ' assertions passed.');
}
print('');
