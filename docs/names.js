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

function looksLikeEntity(raw) {
  var tokens = String(raw).toLowerCase().replace(/,/g, ' ').split(/\s+/);
  for (var i = 0; i < tokens.length; i++) {
    if (ENTITY_MARKERS.indexOf(tokens[i]) !== -1) return true;
  }
  return false;
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
  return {
    canonical: raw,
    first: first,
    last: last,
    suffix: suffix,
    isEntity: false,
    surnameFirst: first ? last + ', ' + first + tail : raw,
    givenFirst: first ? first + ' ' + last + tail : raw,
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
    hoursToMinutes: hoursToMinutes, fmtHours: fmtHours, todayLocal: todayLocal };
}
