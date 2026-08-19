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

/* ─────────── filing titles embedded in case names (real MyCase data) ───────────
 * 93 of the firm's 260 case names exceed 40 characters, and the longest is 150, because
 * MyCase names frequently carry the filing title. Inverting those produces nonsense. */
group('filing titles');

var petition = 'Ashford, Daniel PETITION FOR APPOINTMENT OF PROBATE CONSERVATOR';
eq(parseName(petition).isEntity, true, 'an ALL-CAPS run marks a filing title');
eq(parseName(petition).surnameFirst, petition, 'filing-title names are shown verbatim');
eq(parseName(petition).givenFirst, petition, 'and are never re-ordered');
eq(displays(searchClients([{ name: petition }], 'ashf')), [petition], 'still findable by surname');
eq(displays(searchClients([{ name: petition }], 'daniel')), [petition], 'and by given name');

/* The inversion guard on its own: only simple person names flip. */
eq(parseName('Ramirez, Maria').invertible, true, 'one surname + one given name flips');
eq(parseName('Ramirez, Maria Elena').invertible, true, 'two given names still flips');
eq(parseName('Ramirez, Maria Elena Sofia Consuelo').invertible, false, 'four given names does not flip');
eq(parseName('Ramirez, Maria Elena Sofia Consuelo').surnameFirst,
   'Ramirez, Maria Elena Sofia Consuelo', 'long names shown as stored');

/* ───────────────── real MyCase case-name shapes (Paul Greco Law) ─────────────────
 * Case naming in MyCase is inconsistent — confirmed 2026-08-13, all three of these
 * coexist. The matcher must cope with the mixture, and whatever is displayed, the
 * canonical string is what gets filed. */
group('real MyCase case-name shapes');

function realCases() {
  return [{ name: 'People vs Aaron' }, { name: 'Richards, Aaron' }, { name: 'abel maya' }];
}
function filedAs(hits) { return hits.map(function (h) { return h.client.name; }); }

/* Caption form. "vs" without a full stop must still be recognised. */
eq(parseName('People vs Aaron').isEntity, true, '"vs" without a period is still a caption');
eq(displays(searchClients(realCases(), 'peo')), ['People vs Aaron'], 'caption found by its first word');
eq(displays(searchClients(realCases(), 'aaron')).indexOf('People vs Aaron') !== -1, true,
   'caption also found by the name inside it');

/* Surname-first form. */
eq(displays(searchClients(realCases(), 'ric')), ['Richards, Aaron'], 'surname-first form found by surname');
eq(filedAs(searchClients(realCases(), 'aar')).indexOf('Richards, Aaron') !== -1, true,
   'surname-first form also found by given name');

/* Lowercase, given-first form. Kept verbatim — the stored string has to survive
 * untouched or the MyCase import stops matching. */
eq(displays(searchClients(realCases(), 'ab')), ['abel maya'], 'lowercase name found by first word');
eq(displays(searchClients(realCases(), 'may')), ['maya, abel'], 'lowercase inverts on surname match');
eq(filedAs(searchClients(realCases(), 'may')), ['abel maya'], 'but files under the stored lowercase form');

/* The critical invariant across all shapes: display may differ from what is stored,
 * but what is stored is always MyCase's exact string. */
['peo', 'aar', 'ric', 'ab', 'may'].forEach(function (q) {
  var hits = searchClients(realCases(), q);
  var allCanonical = hits.every(function (h) {
    return ['People vs Aaron', 'Richards, Aaron', 'abel maya'].indexOf(h.client.name) !== -1;
  });
  eq(allCanonical, true, '"' + q + '" only ever files a verbatim MyCase case name');
});

/* Typing the exact case name, in any of the three shapes, resolves. */
eq(resolveExact(realCases(), 'People vs Aaron').name, 'People vs Aaron', 'caption resolves exactly');
eq(resolveExact(realCases(), 'ABEL MAYA').name, 'abel maya', 'casing does not matter when resolving');
eq(resolveExact(realCases(), 'Aaron Richards').name, 'Richards, Aaron', 'un-inverted input resolves to stored form');

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

/* ─────────────────────────────── parseAmountInput ─────────────────────────────── */
group('parseAmountInput  (money keeps its cents, unlike hours)');

eq(parseAmountInput('435'), 435, 'whole dollars');
eq(parseAmountInput('12.35'), 12.35, 'cents survive');
eq(parseAmountInput('$450'), 450, 'a typed dollar sign is tolerated');
eq(parseAmountInput('1,234.56'), 1234.56, 'thousands separators are tolerated');
eq(parseAmountInput('  99.99 '), 99.99, 'whitespace trimmed');
eq(parseAmountInput('0.05'), 0.05, 'five cents is a real amount');

/* The whole reason this is not parseHoursInput: snapping to a tenth would turn a $12.35
 * filing fee into $12.40 and the ledger would never balance against the receipt. */
eq(parseAmountInput('12.35') !== 12.4, true, 'does NOT snap to the nearest tenth');
eq(parseAmountInput('1.234'), 1.23, 'rounds to the cent, down');
eq(parseAmountInput('1.235'), 1.24, 'rounds to the cent, up');

eq(parseAmountInput('0'), null, 'zero is refused');
eq(parseAmountInput('-5'), null, 'negative is refused');
eq(parseAmountInput('abc'), null, 'text is refused');
eq(parseAmountInput(''), null, 'empty is refused');
eq(parseAmountInput('12.3.4'), null, 'malformed decimal is refused');
eq(parseAmountInput('1e3'), null, 'exponent notation is refused');

eq(fmtUsd(435), '$435.00', 'formats with cents');
eq(fmtUsd(12.5), '$12.50', 'pads a single decimal');

/* ─────────────────────────── matchClientInText ─────────────────────────── */
group('matchClientInText  (calendar titles → a case, or nothing)');

var cal = clients();

/* A whole name in the title is the reliable case. */
eq(matchClientInText(cal, 'Hearing re Maria Ramirez').name, 'Maria Ramirez', 'full name in a title');
eq(matchClientInText(cal, 'Call w/ Ramirez, Maria').name, 'Maria Ramirez', 'surname-first form');
eq(matchClientInText(cal, 'MENDEZ prep').name, 'Arturo Mendez', 'a surname alone, unambiguously');
eq(matchClientInText(cal, 'meeting: clayton ruiz at 3').name, 'Clayton Ruiz', 'lowercased title');

/* Nothing rather than a guess. Filing time against the wrong client's case is worse
 * than filing none, because it bills a stranger and hides the real entry. */
eq(matchClientInText(cal, 'Team meeting'), null, 'no name, no match');
eq(matchClientInText(cal, 'Call re hearing prep'), null, 'only stopwords, no match');
eq(matchClientInText(cal, ''), null, 'empty title');
eq(matchClientInText(cal, 'Lunch'), null, 'unrelated word');

/* Two clients share a surname → the title does not say which, so neither is used. */
var twins = [{ name: 'Maria Ramirez' }, { name: 'Jose Ramirez' }];
eq(matchClientInText(twins, 'Hearing — Ramirez'), null, 'an ambiguous surname matches nothing');
eq(matchClientInText(twins, 'Hearing — Jose Ramirez').name, 'Jose Ramirez',
   'a full name resolves the ambiguity');

/* Longest match wins, so a client whose name contains another does not shadow it. */
var nested = [{ name: 'Rich Co' }, { name: 'Aaron Richards' }];
eq(matchClientInText(nested, 'call with Aaron Richards').name, 'Aaron Richards',
   'longest whole-name match wins');

/* Substring safety: a surname must sit on a word boundary. */
eq(matchClientInText([{ name: 'Abel Maya' }], 'maybe reschedule'), null,
   '"maya" does not match inside "maybe"');

/* Case names with a filing title baked in — 93 of the firm's 260. The calendar entry for
 * one of these says "Ashford", never the whole 60-character caption, and parseName treats
 * the caption as one indivisible surname, so a token tier is the only thing that finds it. */
var LONG = 'Ashford, Daniel PETITION FOR APPOINTMENT OF PROBATE CONSERVATOR';
var withLong = cal.concat([{ name: LONG, matterType: 'Conservatorship' }]);
eq(matchClientInText(withLong, 'Ashford conservatorship review').name, LONG,
   'a surname inside a filing-title case name is found');
eq(matchClientInText(withLong, 'call re Daniel').name, LONG, 'the given name works too');

/* But the filing title itself must never match, or every conservatorship on the list
 * would answer to "probate hearing". */
eq(matchClientInText(withLong, 'probate hearing'), null, 'ALL-CAPS filing words are not searchable');
eq(matchClientInText(withLong, 'PETITION prep'), null, 'nor is "petition"');
eq(matchClientInText(withLong, 'appointment at 3'), null, 'nor "appointment"');

/* Two long captions sharing a name stay ambiguous. */
eq(matchClientInText([{ name: 'Ashford, Daniel PETITION FOR CONSERVATOR' },
                      { name: 'Ashford, Marie PETITION FOR GUARDIAN' }], 'Ashford hearing'), null,
   'a token shared by two case names matches neither');

/* Entity markers are not identifying: "LLC" or "Trust" appears across many clients. */
eq(matchClientInText([{ name: 'Artesia Holdings LLC' }, { name: 'Bayside LLC' }], 'llc meeting'),
   null, '"llc" alone matches nothing');
eq(matchClientInText(cal, 'Artesia paperwork').name, 'Artesia Holdings LLC',
   'the distinctive part of an entity name still matches');

/* Short tokens are excluded from the inner tier — "Van" in "Nguyen Van Minh" must not
 * match a title about a van. */
eq(matchClientInText(cal, 'pick up the van'), null, 'a three-letter inner token is ignored');

/* ─────────────────────────── suggestFromEvent ─────────────────────────── */
group('suggestFromEvent');

var ev = { id: 'e1', title: 'Hearing re Maria Ramirez', hours: 1.3, location: '' };
var s = suggestFromEvent(cal, ev);
eq(s.client.name, 'Maria Ramirez', 'matched client comes back canonical');
eq(s.hours, 1.3, 'duration is carried through');
eq(s.description, 'Hearing re Maria Ramirez', 'the title becomes the description verbatim');
eq(s.matterType, 'Criminal', 'the client\'s default matter type comes along');

var blank = suggestFromEvent(cal, { id: 'e2', title: 'Team standup', hours: 0.5 });
eq(blank.client, null, 'no match leaves the client empty rather than guessing');
eq(blank.hours, 0.5, 'hours still suggested without a client');
eq(blank.description, 'Team standup', 'description still suggested');

/* The location is searched too — "Dept 5" hearings often name the case only there. */
eq(suggestFromEvent(cal, { id: 'e3', title: 'Hearing', hours: 1,
   location: 'Dept 5 — Clara Benson' }).client.name, 'Clara Benson',
   'a case named only in the location is found');

/* ─────────────────────────────── summary ─────────────────────────────── */

print('\n' + '─'.repeat(60));
if (fail) {
  print(fail + ' FAILED, ' + pass + ' passed\n');
  failures.forEach(function (f) { print('  ✗ ' + f); });
} else {
  print('All ' + pass + ' assertions passed.');
}
print('');
