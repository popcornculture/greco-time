/* Greco Time — pure helpers: name parsing, client search, time parsing.
 *
 * Deliberately free of DOM and network access so it can be unit-tested headlessly
 * (see tests/run-tests.js, driven by the system JavaScriptCore). Loaded as a plain
 * script before app.js; everything here is a global by design.
 */
'use strict';

var MAX_SUGGESTIONS = 3;
var MIN_QUERY = 2;

/* Generational and honorific suffixes, so "John Smith Jr." yields last name Smith
 * rather than Jr. */
var NAME_SUFFIXES = ['jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv', 'esq', 'esq.'];

/* Markers that make a client an organisation rather than a person. These are never
 * inverted: "LLC, Artesia Holdings" is not a thing, and a law firm's client list is
 * full of companies, estates and trusts. */
var ENTITY_MARKERS = ['llc', 'l.l.c.', 'inc', 'inc.', 'incorporated', 'corp', 'corp.',
  'corporation', 'co', 'co.', 'company', 'lp', 'l.p.', 'llp', 'ltd', 'ltd.', 'pc', 'p.c.',
  'trust', 'estate', 'partnership', 'foundation', 'association', 'university', 'city',
  'county', 'district', 'department'];

function isSuffix(token) {
  return NAME_SUFFIXES.indexOf(String(token).toLowerCase()) !== -1;
}

/* Case captions — "People v. Ramirez", "Smith vs Jones". MyCase matches time entries on
 * the Case Name, and cases are frequently named this way, so these must not be inverted
 * into nonsense like "Ramirez, People v.".
 *
 * The check is deliberately case-SENSITIVE: a lowercase "v." is the legal separator,
 * whereas an uppercase "V." is someone's middle initial ("John V. Smith"). */
function looksLikeCaseCaption(raw) {
  return /\s(v\.?|vs\.?)\s/.test(String(raw));
}

/* Real MyCase case names frequently tack a filing title onto a person's name:
 *   "Ashford, Daniel PETITION FOR APPOINTMENT OF PROBATE CONSERVATOR"
 * Inverting that yields "Daniel PETITION FOR … Ashford", which is nonsense. An
 * all-caps run of 4+ letters is a reliable marker of a filing title rather than a name. */
function hasFilingTitle(raw) {
  return /\b[A-Z]{4,}\b/.test(String(raw));
}

function looksLikeEntity(raw) {
  if (looksLikeCaseCaption(raw)) return true;
  if (hasFilingTitle(raw)) return true;
  var tokens = String(raw).toLowerCase().replace(/,/g, ' ').split(/\s+/);
  for (var i = 0; i < tokens.length; i++) {
    if (ENTITY_MARKERS.indexOf(tokens[i]) !== -1) return true;
  }
  return false;
}

/* Only flip a name around when it genuinely looks like a person: one surname, at most
 * two given names. Anything longer is shown exactly as MyCase stores it. Median case
 * name at the firm is 33 characters and the longest is 150, so this matters. */
function isInvertible(first, last) {
  if (!first || !last) return false;
  return last.split(' ').length === 1 && first.split(' ').length <= 2;
}

/**
 * Splits a canonical client name into the parts the picker needs.
 *
 * Handles names already stored surname-first ("Ramirez, Maria"), single-token or
 * entity names ("Artesia Holdings LLC" — left exactly as it is, because inverting a
 * business name is nonsense), and generational suffixes.
 */
function parseName(canonical) {
  var raw = String(canonical == null ? '' : canonical).trim().replace(/\s+/g, ' ');
  var first = '', last = '', suffix = '';

  // Organisations are treated as one indivisible name. Setting `last` to the whole
  // string also means typing the leading word ("artesia") is a top-rank surname hit.
  if (looksLikeEntity(raw)) {
    return {
      canonical: raw, first: '', last: raw, suffix: '', isEntity: true,
      surnameFirst: raw, givenFirst: raw,
      tokens: raw.replace(/,/g, ' ').split(' ').filter(function (t) { return t; }),
    };
  }

  if (raw.indexOf(',') !== -1) {
    var halves = raw.split(',');
    last = halves[0].trim();
    first = (halves[1] || '').trim();
    // "Smith Jr., John" — pull the suffix off the surname half.
    var lastParts = last.split(' ');
    if (lastParts.length > 1 && isSuffix(lastParts[lastParts.length - 1])) {
      suffix = lastParts.pop();
      last = lastParts.join(' ');
    }
  } else {
    var parts = raw.split(' ');
    if (parts.length > 2 && isSuffix(parts[parts.length - 1])) {
      suffix = parts.pop();
    }
    if (parts.length <= 1) {
      last = parts[0] || '';
    } else {
      last = parts.pop();
      first = parts.join(' ');
    }
  }

  var tail = suffix ? ' ' + suffix : '';
  var flip = isInvertible(first, last);
  return {
    canonical: raw,
    first: first,
    last: last,
    suffix: suffix,
    isEntity: false,
    invertible: flip,
    surnameFirst: flip ? last + ', ' + first + tail : raw,
    givenFirst: flip ? first + ' ' + last + tail : raw,
    tokens: raw.replace(/,/g, ' ').split(' ').filter(function (t) { return t; }),
  };
}

/**
 * Ranks the client list against what has been typed.
 *
 *   score 0 — surname prefix         → offered as "Ramirez, Maria"
 *   score 1 — given-name prefix      → offered as "Maria Ramirez"
 *   score 2 — any other token prefix → offered canonically (middle names, entities)
 *   score 3 — substring anywhere     → offered canonically
 *
 * Returns at most MAX_SUGGESTIONS hits, each { client, parsed, score, display }.
 */
function searchClients(clients, query) {
  var q = String(query == null ? '' : query).trim().toLowerCase().replace(/\s+/g, ' ');
  if (q.length < MIN_QUERY) return [];

  // A query containing a comma or space is tested as a whole-string prefix against
  // both display forms, so "ramirez, m" and "maria r" both keep narrowing.
  var compound = /[,\s]/.test(q);
  var hits = [];

  for (var i = 0; i < clients.length; i++) {
    var c = clients[i];
    var p = c._parsed || (c._parsed = parseName(c.name));
    var lLast = p.last.toLowerCase();
    var lFirst = p.first.toLowerCase();
    var lCanon = p.canonical.toLowerCase();
    var score = -1;
    var display = p.canonical;

    if (compound) {
      if (p.surnameFirst.toLowerCase().indexOf(q) === 0) { score = 0; display = p.surnameFirst; }
      else if (p.givenFirst.toLowerCase().indexOf(q) === 0) { score = 1; display = p.givenFirst; }
      else if (lCanon.indexOf(q) !== -1) { score = 3; }
    } else {
      if (lLast.indexOf(q) === 0) { score = 0; display = p.surnameFirst; }
      else if (lFirst.indexOf(q) === 0) { score = 1; display = p.givenFirst; }
      else if (p.tokens.some(function (t) { return t.toLowerCase().indexOf(q) === 0; })) { score = 2; }
      else if (lCanon.indexOf(q) !== -1) { score = 3; }
    }

    if (score >= 0) hits.push({ client: c, parsed: p, score: score, display: display });
  }

  hits.sort(function (a, b) {
    return a.score - b.score
      || a.parsed.last.localeCompare(b.parsed.last)
      || a.parsed.first.localeCompare(b.parsed.first);
  });

  return hits.slice(0, MAX_SUGGESTIONS);
}

/**
 * Maps free text back to a known client, so someone who types a full name from memory
 * instead of tapping a suggestion still files under the canonical spelling.
 */
function resolveExact(clients, typed) {
  var t = String(typed == null ? '' : typed).trim().toLowerCase().replace(/\s+/g, ' ');
  if (!t) return null;
  for (var i = 0; i < clients.length; i++) {
    var c = clients[i];
    var p = c._parsed || (c._parsed = parseName(c.name));
    if (t === p.canonical.toLowerCase()
      || t === p.surnameFirst.toLowerCase()
      || t === p.givenFirst.toLowerCase()) return c;
  }
  return null;
}

/**
 * Parses the time box as decimal hours and snaps to the nearest tenth, i.e. the
 * nearest 6 minutes. "1.5" is 1.5 hours = 90 minutes. Returns null if unusable.
 */
function parseHoursInput(raw) {
  var cleaned = String(raw == null ? '' : raw).trim().replace(',', '.');
  if (!cleaned) return null;
  if (!/^\d*\.?\d*$/.test(cleaned)) return null;
  var n = Number(cleaned);
  if (!isFinite(n) || n <= 0) return null;
  return Math.round(n * 10) / 10;
}

function hoursToMinutes(h) { return Math.round(h * 60); }

function fmtHours(h) { return Number(h).toFixed(1); }

/**
 * Parses the amount box as dollars, to the cent. Returns null if unusable.
 *
 * Tolerates what people actually type on a phone: a leading $, thousands separators, a
 * trailing period. Rounded to two decimals and never to the tenth — an expense is a real
 * figure off a receipt, not a billing increment, and $12.35 must stay $12.35.
 */
function parseAmountInput(raw) {
  var cleaned = String(raw == null ? '' : raw).trim().replace(/^\$/, '').replace(/,/g, '');
  if (!cleaned) return null;
  if (!/^\d*\.?\d*$/.test(cleaned)) return null;
  var n = Number(cleaned);
  if (!isFinite(n) || n <= 0) return null;
  return Math.round(n * 100) / 100;
}

function fmtAmount(n) { return Number(n).toFixed(2); }
function fmtUsd(n) { return '$' + fmtAmount(n); }

/* ══════════════════════════════ calendar matching ══════════════════════════════ */

/* Words that carry no identifying information, so a title made only of them ("Call re
 * hearing") never matches a client by accident. */
var CALENDAR_STOPWORDS = ['call', 'phone', 'meeting', 'meet', 'hearing', 'court', 're',
  'with', 'w', 'and', 'the', 'for', 'at', 'on', 'in', 'to', 'of', 'prep', 'review',
  'conference', 'appt', 'appointment', 'zoom', 'trial', 'motion', 'client', 'consult',
  'consultation', 'follow', 'up', 'discuss', 'draft', 'file', 'filing'];

/** Shortest token allowed to carry a match on its own. "Li" or "Ng" is a real surname,
 *  but a two-letter match inside a sentence is noise far more often than signal. */
var CALENDAR_MIN_TOKEN = 3;

/** Shortest token for the last-resort tier, which searches inside long case names and so
 *  needs to be stricter than the surname tier. */
var CALENDAR_MIN_INNER_TOKEN = 4;

/** Whole-word containment. `hay` is already lowercased; the name is escaped because real
 *  ones contain dots and hyphens, which would otherwise act as regex operators. */
function containsWord(hay, word) {
  var esc = String(word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^a-z0-9])' + esc + '($|[^a-z0-9])').test(hay);
}

/**
 * The tokens of a case name that could identify it in an event title.
 *
 * Most real MyCase case names carry a filing title — "Ashford, Daniel PETITION FOR
 * APPOINTMENT OF PROBATE CONSERVATOR" — and the calendar entry for it says "Ashford".
 * So the name has to be searchable token by token. What must NOT be searchable is the
 * filing title itself: an event called "probate hearing" matching every conservatorship
 * on the list would be worse than no match, so the ALL-CAPS run is dropped, along with
 * entity markers and ordinary words.
 */
function clientMatchTokens(parsed) {
  var raw = String(parsed.canonical || '');
  var out = [];
  raw.split(/[^A-Za-z0-9'’-]+/).forEach(function (tok) {
    if (!tok) return;
    // The all-caps run is the filing title, not part of anyone's name.
    if (/^[A-Z]{4,}$/.test(tok)) return;
    var t = tok.toLowerCase().replace(/^['’-]+|['’-]+$/g, '');
    if (t.length < CALENDAR_MIN_INNER_TOKEN) return;
    if (/^\d+$/.test(t)) return;
    if (ENTITY_MARKERS.indexOf(t) !== -1) return;
    if (CALENDAR_STOPWORDS.indexOf(t) !== -1) return;
    if (isSuffix(t)) return;
    if (out.indexOf(t) === -1) out.push(t);
  });
  return out;
}

/**
 * Finds the client an event title is about.
 *
 * Deliberately conservative — a wrong guess here files billable time against the wrong
 * client's case, which is worse than no guess at all, so this only ever matches a name
 * that appears in the text more or less intact:
 *
 *   • the canonical name, or either display form, as a substring
 *     ("Hearing — People vs Aaron" → People vs Aaron)
 *   • otherwise a surname token, but only if it is long enough, is not a common word,
 *     and matches exactly one client in the list
 *
 * Longest match wins, so "Richards" beats "Rich" when both are clients. Returns the
 * client object, or null.
 */
function matchClientInText(clients, text) {
  var hay = ' ' + String(text == null ? '' : text).toLowerCase().replace(/\s+/g, ' ') + ' ';
  if (hay.trim().length < CALENDAR_MIN_TOKEN) return null;

  var best = null, bestLen = 0;

  for (var i = 0; i < clients.length; i++) {
    var c = clients[i];
    var p = c._parsed || (c._parsed = parseName(c.name));
    var forms = [p.canonical, p.surnameFirst, p.givenFirst];
    for (var f = 0; f < forms.length; f++) {
      var form = String(forms[f] || '').toLowerCase();
      if (form.length < CALENDAR_MIN_TOKEN) continue;
      if (hay.indexOf(form) !== -1 && form.length > bestLen) {
        best = c;
        bestLen = form.length;
      }
    }
  }
  if (best) return best;

  // No whole name in the text. Fall back to a surname, but only if exactly one client
  // matches: two clients called Ramirez, or a title naming both Ramirez and Mendez, means
  // the text does not say which case this is, and a coin flip would bill the wrong one.
  var bySurname = [];

  for (var j = 0; j < clients.length; j++) {
    var cl = clients[j];
    var pp = cl._parsed || (cl._parsed = parseName(cl.name));
    var last = String(pp.last || '').toLowerCase();
    if (last.length < CALENDAR_MIN_TOKEN) continue;
    if (CALENDAR_STOPWORDS.indexOf(last) !== -1) continue;
    // Word-boundary, so "maya" does not hit inside "maybe".
    if (!containsWord(hay, last)) continue;

    bySurname.push(cl);
    if (bySurname.length > 1) return null;
  }
  if (bySurname.length === 1) return bySurname[0];

  // Last resort, and the one that carries most of the real list: a distinctive token from
  // inside a long case name. "Ashford conservatorship review" has to find "Ashford,
  // Daniel PETITION FOR APPOINTMENT OF PROBATE CONSERVATOR", whose surname, as parsed,
  // is the entire 60-character string. Still all-or-nothing on ambiguity.
  var byToken = [];

  for (var k = 0; k < clients.length; k++) {
    var c2 = clients[k];
    var p2 = c2._parsed || (c2._parsed = parseName(c2.name));
    var toks = c2._mtok || (c2._mtok = clientMatchTokens(p2));
    for (var t = 0; t < toks.length; t++) {
      if (containsWord(hay, toks[t])) { byToken.push(c2); break; }
    }
    if (byToken.length > 1) return null;
  }

  return byToken.length === 1 ? byToken[0] : null;
}

/**
 * Turns a calendar event into the form fields it suggests.
 *
 * The title becomes the description as-is — it is what the person wrote at the time and
 * therefore the best contemporaneous note available. Hours come from the event's real
 * duration, already rounded to a tenth server-side.
 */
function suggestFromEvent(clients, event) {
  var ev = event || {};
  var client = matchClientInText(clients, [ev.title, ev.location].filter(Boolean).join(' '));
  return {
    id: ev.id || '',
    client: client || null,
    hours: parseHoursInput(String(ev.hours)) || null,
    description: String(ev.title || '').trim(),
    matterType: (client && client.matterType) || '',
  };
}

/* Local calendar date. NOT toISOString(), which converts to UTC and would file a 5pm
 * entry in Santa Maria under tomorrow's date. */
function todayLocal(now) {
  var d = now || new Date();
  var p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/* Node/JSC test harness hook; ignored in the browser. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parseName: parseName, searchClients: searchClients,
    resolveExact: resolveExact, parseHoursInput: parseHoursInput,
    hoursToMinutes: hoursToMinutes, fmtHours: fmtHours, todayLocal: todayLocal,
    parseAmountInput: parseAmountInput, fmtAmount: fmtAmount, fmtUsd: fmtUsd,
    matchClientInText: matchClientInText, suggestFromEvent: suggestFromEvent };
}
