/**
 * Greco Time — web app entry point.
 *
 * Deploy as: Execute as = the Sheet owner, Who has access = Anyone.
 *
 * "Anyone" is required, not sloppiness: the phone app is served from a different
 * origin (GitHub Pages), and a Google-auth-gated deployment cannot be called
 * cross-origin. Access control is therefore the PIN, checked on every single request.
 * Nothing — not the client list, not a timekeeper roster — is returned without it.
 */

/** Called only when a human opens the /exec URL in a browser. Deliberately says
 *  nothing about the firm or its clients. */
function doGet() {
  return ContentService
    .createTextOutput('Greco Time API. This endpoint accepts POST requests only.')
    .setMimeType(ContentService.MimeType.TEXT);
}

function doPost(e) {
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var deviceId = String(body.deviceId || '').slice(0, 64);

    if (!checkPin(body.pin, deviceId)) {
      // Same message for a wrong PIN, a missing PIN, and a locked-out device, so the
      // response cannot be used to probe which condition applies.
      return json({ ok: false, error: 'Wrong PIN.' });
    }

    switch (body.action) {
      case 'verify':  return json({ ok: true, timekeepers: timekeepers() });
      case 'clients': return json({ ok: true, clients: readClients() });
      case 'entries': return json(saveEntries(body.payload || {}, deviceId));
      case 'calendar': return json(calendarSuggestions(body.payload || {}));
      default:        return json({ ok: false, error: 'Unknown action.' });
    }
  } catch (err) {
    // Logged server-side; the caller gets a message but never a stack trace.
    console.error('doPost failed: ' + (err && err.stack ? err.stack : err));
    return json({ ok: false, error: 'Server error: ' + (err && err.message ? err.message : err) });
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ══════════════════════════════ auth ══════════════════════════════ */

function sha256Hex(text) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8);
  return bytes.map(function (b) {
    return ((b < 0 ? b + 256 : b)).toString(16).padStart(2, '0');
  }).join('');
}

/** Length-independent comparison, so timing cannot leak the hash. */
function slowEquals(a, b) {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verifies the PIN and rate-limits by device.
 *
 * The lockout counter lives in CacheService rather than Script Properties: property
 * writes are slow and would make every request pay for the rare bad one, and a
 * one-hour window is exactly what a cache TTL gives for free.
 */
function checkPin(pin, deviceId) {
  var expected = prop('PIN_HASH');
  if (!expected) {
    console.error('PIN_HASH is not set — refusing every request. Use "Greco Time → Set PIN…".');
    return false;
  }
  if (!pin) return false;

  var cache = CacheService.getScriptCache();
  var key = 'pinfail_' + (deviceId || 'unknown');
  var fails = Number(cache.get(key) || 0);
  if (fails >= MAX_FAILED_PINS) return false;

  if (slowEquals(sha256Hex(String(pin)), expected)) {
    if (fails) cache.remove(key);
    return true;
  }
  cache.put(key, String(fails + 1), 3600);
  return false;
}

/* ══════════════════════════════ writes ══════════════════════════════ */

/**
 * Appends a batch of entries — hourly time, flat expenses, or a mixture of both.
 *
 * Idempotent by UUID: an entry whose UUID is already in the sheet is reported as
 * accepted but written once. This is what makes it safe for the phone to retry a
 * flush it never saw the response to — the alternative is double-billing a client.
 *
 * Returns { ok, accepted: [uuid], rejected: [{uuid, error}] }.
 */
function saveEntries(payload, deviceId) {
  var incoming = payload.entries || [];
  if (!incoming.length) return { ok: true, accepted: [], rejected: [] };

  var roster = {};
  timekeepers().forEach(function (t) { roster[t.name] = t; });

  var accepted = [], rejected = [], valid = [];

  incoming.forEach(function (entry) {
    var problem = validateEntry(entry, roster);
    if (problem) rejected.push({ uuid: entry.uuid, error: problem });
    else valid.push(entry);
  });

  if (valid.length) {
    // Serialised: two phones flushing at once would otherwise interleave their
    // appends and could both pass the duplicate check for the same UUID.
    var lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      // One tab per kind, so a mixed flush is two appends rather than one.
      ['time', 'expense'].forEach(function (kind) {
        var forKind = valid.filter(function (v) { return entryKind(v) === kind; });
        if (!forKind.length) return;
        var written = appendEntries(exportSpec(kind), forKind);
        written.accepted.forEach(function (u) { accepted.push(u); });
        written.rejected.forEach(function (r) { rejected.push(r); });
      });
      touchDevice(deviceId, valid[0].timekeeper, valid[0].isTest);
    } finally {
      lock.releaseLock();
    }
  }

  // Mail after the lock is released — sending is slow and must not block other phones.
  if (accepted.length && prop('SEND_PER_ENTRY', 'true') !== 'false') {
    var mailable = valid.filter(function (v) {
      return accepted.indexOf(v.uuid) !== -1 && !v.isTest;
    });
    if (mailable.length) {
      try { sendEntryMail(mailable); }
      catch (err) { console.error('per-entry mail failed: ' + err); }
    }
  }

  return { ok: true, accepted: accepted, rejected: rejected };
}

/** An entry with no `kind` is hourly time — that is every entry written before expenses
 *  existed, and every entry from a phone still running an older build. */
function entryKind(entry) {
  return (entry && String(entry.kind || '')) === 'expense' ? 'expense' : 'time';
}

function validateEntry(entry, roster) {
  if (!entry || !entry.uuid) return 'Missing id.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(entry.date || ''))) return 'Bad date.';
  if (!String(entry.client || '').trim()) return 'Missing client.';
  if (!roster[entry.timekeeper]) {
    // Refused rather than guessed: a timekeeper MyCase does not know fails the import,
    // and silently reassigning the entry to someone else would be worse.
    return 'Unknown timekeeper "' + entry.timekeeper + '".';
  }

  if (entryKind(entry) === 'expense') {
    var a = Number(entry.amount);
    if (!isFinite(a) || a <= 0) return 'Bad amount.';
    if (a > MAX_AMOUNT_PER_EXPENSE) return 'Amount above ' + MAX_AMOUNT_PER_EXPENSE + '.';
    // The note is the line item the client reads on the bill. An expense that just says
    // "$450" is unbillable in practice, so unlike time this one is required.
    if (!String(entry.description || '').trim()) return 'An expense needs a description.';
    return null;
  }

  var h = Number(entry.hours);
  if (!isFinite(h) || h <= 0) return 'Bad hours.';
  if (h > MAX_HOURS_PER_ENTRY) return 'Hours above ' + MAX_HOURS_PER_ENTRY + '.';
  return null;
}

/** Money is rounded to the cent, never to the tenth. */
function normaliseEntry(spec, entry) {
  var out = {
    uuid: entry.uuid,
    date: entry.date,
    client: String(entry.client).trim().replace(/\s+/g, ' '),
    timekeeper: entry.timekeeper,
    description: String(entry.description || '').trim(),
    matterType: entry.matterType || '',
    isTest: Boolean(entry.isTest),
    deviceId: entry.deviceId || '',
  };
  if (spec.kind === 'expense') {
    out.amount = Math.round(Number(entry.amount) * 100) / 100;
    out.nonbillable = Boolean(entry.nonbillable);
  } else {
    out.hours = Math.round(Number(entry.hours) * 10) / 10;
  }
  return out;
}

function appendEntries(spec, entries) {
  var sheet = tab(spec.source, spec.sourceHeaders);
  var uuidCol = specCol(spec, 'uuid') + 1;

  var seen = {};
  var last = sheet.getLastRow();
  if (last > 1) {
    sheet.getRange(2, uuidCol, last - 1, 1).getValues().forEach(function (r) {
      if (r[0]) seen[String(r[0])] = true;
    });
  }

  var rows = [], accepted = [], newClients = [];
  entries.forEach(function (entry) {
    accepted.push(entry.uuid);              // already-present UUIDs count as accepted
    if (seen[entry.uuid]) return;
    seen[entry.uuid] = true;

    var normalised = normaliseEntry(spec, entry);
    rows.push(spec.allFields.map(function (f) { return f.value(normalised); }));
    newClients.push(normalised);
  });

  if (rows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, spec.sourceHeaders.length).setValues(rows);
    formatEntrySheet(spec, sheet);
    ensureClients(newClients);
  }

  return { accepted: accepted, rejected: [] };
}

/** Adds any client the sheet has not seen. Runs for every entry, not just ones the
 *  phone flagged "new", so a name can never end up in a time entry without also
 *  existing in the list the autocomplete reads from. */
function ensureClients(entries) {
  var sheet = tab(TABS.clients, CLIENT_HEADERS);
  var known = {};
  var last = sheet.getLastRow();
  if (last > 1) {
    sheet.getRange(2, 1, last - 1, 1).getValues().forEach(function (r) {
      if (r[0]) known[String(r[0]).trim().toLowerCase()] = true;
    });
  }

  var add = [];
  entries.forEach(function (e) {
    var key = e.client.toLowerCase();
    if (known[key]) return;
    known[key] = true;
    add.push([e.client, e.matterType || '', new Date(), e.timekeeper]);
  });

  if (add.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, add.length, CLIENT_HEADERS.length).setValues(add);
    // Keep the tab alphabetical so it stays reviewable by hand.
    var rows = sheet.getLastRow() - 1;
    if (rows > 1) sheet.getRange(2, 1, rows, CLIENT_HEADERS.length).sort({ column: 1, ascending: true });
  }
}

function readClients() {
  var sheet = tab(TABS.clients, CLIENT_HEADERS);
  var last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, 2).getValues()
    .filter(function (r) { return String(r[0]).trim(); })
    .map(function (r) {
      return { name: String(r[0]).trim(), matterType: String(r[1] || '').trim() };
    });
}

/** Audit trail of which phone produced which entries. */
function touchDevice(deviceId, timekeeper, isTest) {
  if (!deviceId) return;
  var sheet = tab(TABS.devices, DEVICE_HEADERS);
  var last = sheet.getLastRow();
  var rows = last > 1 ? sheet.getRange(2, 1, last - 1, 1).getValues() : [];
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]) === deviceId) {
      sheet.getRange(i + 2, 2, 1, 4).setValues([[timekeeper, isTest ? 'TRUE' : 'FALSE',
        sheet.getRange(i + 2, 4).getValue() || new Date(), new Date()]]);
      return;
    }
  }
  sheet.appendRow([deviceId, timekeeper, isTest ? 'TRUE' : 'FALSE', new Date(), new Date()]);
}
