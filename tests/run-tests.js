/* Unit tests for docs/names.js — the parts where a bug is silent and expensive:
 * a client filed under the wrong canonical name, or "1.5" read as anything but
 * 90 minutes.
 *
 * Run with macOS's built-in JavaScriptCore (no npm on this machine):
 *
 *   /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc \
 *     docs/names.js tests/run-tests.js
 */

var pass = 0, fail = 0, failures = [];

function eq(actual, expected, label) {
  var a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) { pass++; }
  else { fail++; failures.push(label + '\n      expected ' + b + '\n      actual   ' + a); }
}

function group(name) { print('\n' + name); }

/* Stand-in for the Clients tab. Chosen so several entries collide on "cl" and "ram",
 * which is where a naive prefix search goes wrong. */
function clients() {
  return [
    { name: 'Claude Artificial', matterType: 'Civil' },
    { name: 'Maria Ramirez', matterType: 'Criminal' },
    { name: 'Robert Ramsey', matterType: 'Family' },
    { name: 'Arturo Mendez', matterType: 'Criminal' },
    { name: 'Clara Benson', matterType: 'Family' },
    { name: 'Clayton Ruiz', matterType: 'Civil' },
    { name: 'Artesia Holdings LLC', matterType: 'Civil' },
    { name: 'John Smith Jr.', matterType: 'Criminal' },
    { name: 'Nguyen Van Minh', matterType: 'Family' },
    { name: 'Ramirez, Jose', matterType: 'Civil' },
  ];
}

function displays(hits) { return hits.map(function (h) { return h.display; }); }
function canon(hits) { return hits.map(function (h) { return h.client.name; }); }

/* ─────────────────────────────── parseName ─────────────────────────────── */
group('parseName');

var p = parseName('Claude Artificial');
eq([p.first, p.last], ['Claude', 'Artificial'], 'splits first/last');
eq(p.surnameFirst, 'Artificial, Claude', 'surname-first form');
eq(p.givenFirst, 'Claude Artificial', 'given-first form');

p = parseName('Ramirez, Jose');
eq([p.first, p.last], ['Jose', 'Ramirez'], 'parses an already-inverted name');
eq(p.givenFirst, 'Jose Ramirez', 'un-inverts for display');

p = parseName('John Smith Jr.');
eq([p.first, p.last, p.suffix], ['John', 'Smith', 'Jr.'], 'suffix does not become the surname');
eq(p.surnameFirst, 'Smith, John Jr.', 'suffix trails the surname-first form');

/* Organisations must never be inverted — "LLC, Artesia Holdings" is not a name. */
p = parseName('Artesia Holdings LLC');
eq(p.isEntity, true, 'LLC marks an entity');
eq(p.surnameFirst, 'Artesia Holdings LLC', 'entity is not inverted');
eq(p.givenFirst, 'Artesia Holdings LLC', 'entity has no given-first form');
eq(parseName('Estate of Harold Vance').isEntity, true, 'estates are entities');
eq(parseName('The Benson Family Trust').surnameFirst, 'The Benson Family Trust', 'trusts are not inverted');
eq(parseName('County of Santa Barbara').isEntity, true, 'public bodies are entities');
eq(parseName('Maria Ramirez').isEntity, false, 'a person is not an entity');

/* Case captions. MyCase matches on Case Name, and cases are often named this way, so
 * "People v. Ramirez" must not become "Ramirez, People v.". */
eq(parseName('People v. Ramirez').isEntity, true, '"v." marks a case caption');
eq(parseName('People v. Ramirez').surnameFirst, 'People v. Ramirez', 'captions are not inverted');
eq(parseName('Smith vs Jones').isEntity, true, '"vs" also marks a caption');
eq(parseName('Ramirez v. State of California').givenFirst, 'Ramirez v. State of California', 'caption left intact');
/* But an uppercase middle initial is not a caption. */
eq(parseName('John V. Smith').isEntity, false, 'an uppercase V. is a middle initial, not a caption');
eq(parseName('John V. Smith').surnameFirst, 'Smith, John V.', 'middle-initial name still inverts normally');
/* And a caption is still findable by the name inside it. */
eq(displays(searchClients([{ name: 'People v. Ramirez' }], 'ram')), ['People v. Ramirez'],
   'a caption is findable by the surname inside it, shown as stored');

p = parseName('Cher');
eq([p.first, p.last, p.surnameFirst], ['', 'Cher', 'Cher'], 'single-token name is left alone');

p = parseName('  Maria   Ramirez  ');
eq(p.canonical, 'Maria Ramirez', 'collapses stray whitespace');

p = parseName('Nguyen Van Minh');
eq([p.first, p.last], ['Nguyen Van', 'Minh'], 'three-part name keeps the middle with the first');

/* ────────────────────────────── searchClients ────────────────────────────── */
group('searchClients');

eq(searchClients(clients(), 'c'), [], 'one character yields nothing (min is 2)');
eq(searchClients(clients(), ' '), [], 'whitespace yields nothing');

/* The user's own example: typing C-L must offer Claude Artificial, given-first. */
var cl = searchClients(clients(), 'cl');
eq(cl.length, 3, 'caps at 3 suggestions');
eq(displays(cl).indexOf('Claude Artificial') !== -1, true, 'CL offers "Claude Artificial"');

/* And typing the surname must invert the display. "art" legitimately ties three ways
 * here (surname Artificial, entity Artesia, given name Arturo), so this asserts on the
 * right hit rather than on its position. */
var art = searchClients(clients(), 'art');
var claude = art.filter(function (h) { return h.client.name === 'Claude Artificial'; })[0];
eq(claude.display, 'Artificial, Claude', 'surname prefix inverts to "Artificial, Claude"');
eq(claude.client.name, 'Claude Artificial', 'canonical name is preserved behind the display form');
eq(claude.score, 0, 'a surname prefix is a rank-0 match');
/* Arturo matches on his given name, so he must not be inverted. */
eq(art.filter(function (h) { return h.client.name === 'Arturo Mendez'; })[0].display,
   'Arturo Mendez', 'given-name match in a mixed result set stays given-first');

/* Surname matches must outrank given-name matches. "Ram" hits two surnames
 * (Ramirez, Ramsey) — neither should be pushed out by a first-name match. */
var ram = searchClients(clients(), 'ram');
eq(displays(ram), ['Ramirez, Jose', 'Ramirez, Maria', 'Ramsey, Robert'], 'surnames rank first, alphabetically');

/* A given-name prefix that is nobody's surname. */
var mar = searchClients(clients(), 'mar');
eq(displays(mar), ['Maria Ramirez'], 'given-name prefix stays given-first');

/* Compound queries keep narrowing in either direction. */
eq(displays(searchClients(clients(), 'ramirez, m')), ['Ramirez, Maria'], 'surname, given narrows to one');
eq(displays(searchClients(clients(), 'maria r')), ['Maria Ramirez'], 'given surname narrows to one');
eq(displays(searchClients(clients(), 'artificial, cl')), ['Artificial, Claude'], "the user's own example, inverted");

/* Middle-token and substring fallbacks. */
eq(displays(searchClients(clients(), 'van')), ['Nguyen Van Minh'], 'middle token matches canonically');
eq(displays(searchClients(clients(), 'holdings')), ['Artesia Holdings LLC'], 'entity middle token matches');

/* Entities are offered exactly as stored, never inverted. */
eq(displays(searchClients(clients(), 'artesia')), ['Artesia Holdings LLC'], 'entity leading word ranks and stays upright');
eq(displays(searchClients(clients(), 'artesia h')), ['Artesia Holdings LLC'], 'compound query on an entity');

eq(searchClients(clients(), 'zz'), [], 'no match yields nothing');
eq(displays(searchClients(clients(), 'CLAUDE')), ['Claude Artificial'], 'matching is case-insensitive');

/* ─────────────────────────────── resolveExact ─────────────────────────────── */
group('resolveExact');

eq(resolveExact(clients(), 'Claude Artificial').name, 'Claude Artificial', 'exact canonical resolves');
eq(resolveExact(clients(), 'Artificial, Claude').name, 'Claude Artificial', 'inverted form resolves to canonical');
eq(resolveExact(clients(), 'claude   artificial').name, 'Claude Artificial', 'case and spacing tolerant');
eq(resolveExact(clients(), 'Jose Ramirez').name, 'Ramirez, Jose', 'un-inverted form resolves to stored form');
eq(resolveExact(clients(), 'Nobody Here'), null, 'unknown name does not resolve');
eq(resolveExact(clients(), ''), null, 'empty does not resolve');

/* ────────────────────────────── parseHoursInput ────────────────────────────── */
group('parseHoursInput  (0.1 = 6 minutes, so 1.5 = 90 minutes)');

eq(parseHoursInput('1.5'), 1.5, '1.5 stays 1.5 hours');
eq(hoursToMinutes(parseHoursInput('1.5')), 90, '1.5 hours is 90 minutes');
eq(hoursToMinutes(parseHoursInput('0.1')), 6, '0.1 hours is 6 minutes');
eq(hoursToMinutes(parseHoursInput('0.3')), 18, '0.3 hours is 18 minutes');
eq(parseHoursInput('2'), 2, 'whole numbers work');
eq(parseHoursInput('.5'), 0.5, 'leading dot works');
eq(parseHoursInput('1,5'), 1.5, 'comma decimal separator accepted');
eq(parseHoursInput('  0.7  '), 0.7, 'whitespace trimmed');

/* Snapping: billing is in tenths, so anything finer must round to a tenth. */
eq(parseHoursInput('0.16'), 0.2, 'rounds up to the nearest tenth');
eq(parseHoursInput('0.14'), 0.1, 'rounds down to the nearest tenth');
eq(parseHoursInput('1.25'), 1.3, 'half-tenth rounds up');

eq(parseHoursInput('0'), null, 'zero is refused');
eq(parseHoursInput('-1'), null, 'negative is refused');
eq(parseHoursInput('abc'), null, 'text is refused');
eq(parseHoursInput('1.5.2'), null, 'malformed decimal is refused');
eq(parseHoursInput(''), null, 'empty is refused');
eq(parseHoursInput('1e3'), null, 'exponent notation is refused');
eq(parseHoursInput('.'), null, 'a lone decimal point is refused');
eq(parseHoursInput('1 5'), null, 'a space inside the number is refused');

eq(fmtHours(1.5), '1.5', 'formats to one decimal');
eq(fmtHours(2), '2.0', 'whole hours keep the decimal');

/* ─────────────────────────────── todayLocal ─────────────────────────────── */
group('todayLocal  (local calendar date, never UTC)');

/* 13 Aug 2026, 17:30 local. toISOString() on this instant in California would say
 * the 14th — the bug this function exists to avoid. */
eq(todayLocal(new Date(2026, 7, 13, 17, 30, 0)), '2026-08-13', 'evening local time stays on the same day');
eq(todayLocal(new Date(2026, 0, 5, 0, 5, 0)), '2026-01-05', 'pads month and day');
eq(todayLocal(new Date(2026, 11, 31, 23, 59, 0)), '2026-12-31', 'new year eve stays in the old year');

/* ─────────────────────────────── summary ─────────────────────────────── */

print('\n' + '─'.repeat(60));
if (fail) {
  print(fail + ' FAILED, ' + pass + ' passed\n');
  failures.forEach(function (f) { print('  ✗ ' + f); });
} else {
  print('All ' + pass + ' assertions passed.');
}
print('');
