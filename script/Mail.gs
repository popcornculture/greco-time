/**
 * Greco Time — email.
 *
 * Two kinds of message:
 *   • a confirmation per flush batch, so there is a contemporaneous record of each
 *     entry outside the spreadsheet;
 *   • an end-of-day digest grouped by timekeeper, which is what actually catches a
 *     mistyped 15 that should have been 1.5.
 *
 * Test entries generate neither.
 */

function recipients(key) {
  return prop(key).split(',').map(function (s) { return s.trim(); })
    .filter(function (s) { return s; }).join(',');
}

function fmtHrs(h) { return Number(h).toFixed(1); }

function fmtDateUS(iso) {
  var d = toSheetDate(iso);
  return (d instanceof Date) ? Utilities.formatDate(d, Session.getScriptTimeZone(), 'MM/dd/yyyy') : String(iso);
}

/** One message per flush, not per entry: an offline batch of eight would otherwise
 *  arrive as eight emails, and per-entry mail is the part that risks the daily quota. */
function sendEntryMail(entries) {
  var to = recipients('NOTIFY_ENTRY');
  if (!to) return;

  var total = entries.reduce(function (s, e) { return s + Number(e.hours); }, 0);
  var one = entries.length === 1;
  var subject = one
    ? 'Time: ' + fmtHrs(entries[0].hours) + ' hrs — ' + entries[0].client
    : 'Time: ' + entries.length + ' entries, ' + fmtHrs(total) + ' hrs';

  var lines = entries.map(function (e) {
    return [
      fmtDateUS(e.date),
      e.client,
      e.matterType,
      fmtHrs(e.hours) + ' hrs (' + Math.round(e.hours * 60) + ' min)',
      e.timekeeper,
      e.description || '(no description)',
    ].join('  ·  ');
  });

  var body = lines.join('\n') +
    (one ? '' : '\n\nTotal: ' + fmtHrs(total) + ' hrs') +
    '\n\nLogged from Greco Time. Entries are on the "' + TABS.entries + '" tab.';

  MailApp.sendEmail({ to: to, subject: subject, body: body });
}

/**
 * End-of-day summary. Wire to a daily time-based trigger (see installDigestTrigger).
 * Returns the number of entries reported, so the menu item can say nothing happened.
 */
function sendDailyDigest() {
  var to = recipients('NOTIFY_DIGEST');
  var sheet = tab(TABS.entries, ENTRY_HEADERS);
  var last = sheet.getLastRow();
  if (last < 2) return 0;

  var tz = Session.getScriptTimeZone();
  var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');

  var iDate = col('date'), iClient = col('client'), iUser = col('timekeeper');
  var iDesc = col('description'), iHours = col('hours');
  var iMatter = col('matterType'), iTest = col('isTest');

  var byPerson = {};
  var count = 0, grand = 0, flagged = [];

  sheet.getRange(2, 1, last - 1, ENTRY_HEADERS.length).getValues().forEach(function (row) {
    if (String(row[iTest]).toUpperCase() === 'TRUE') return;
    var d = row[iDate];
    var iso = (d instanceof Date) ? Utilities.formatDate(d, tz, 'yyyy-MM-dd') : String(d);
    if (iso !== today) return;

    var who = String(row[iUser] || 'Unassigned');
    var hours = Number(row[iHours]) || 0;
    (byPerson[who] = byPerson[who] || []).push({
      client: row[iClient], hours: hours,
      matter: row[iMatter], desc: row[iDesc],
    });
    count++;
    grand += hours;
    if (hours > SUSPICIOUS_HOURS) flagged.push(who + ' — ' + row[iClient] + ': ' + fmtHrs(hours) + ' hrs');
  });

  if (!count || !to) return 0;

  var out = [];
  Object.keys(byPerson).sort().forEach(function (who) {
    var rows = byPerson[who];
    var sub = rows.reduce(function (s, r) { return s + r.hours; }, 0);
    out.push(who + ' — ' + fmtHrs(sub) + ' hrs');
    rows.forEach(function (r) {
      out.push('    ' + fmtHrs(r.hours) + '  ' + r.client +
        (r.matter ? '  [' + r.matter + ']' : '') +
        (r.desc ? '  — ' + r.desc : ''));
    });
    out.push('');
  });

  if (flagged.length) {
    out.push('Worth a second look (over ' + SUSPICIOUS_HOURS + ' hrs on one entry):');
    flagged.forEach(function (f) { out.push('    ' + f); });
    out.push('');
  }

  out.push('Total for ' + Utilities.formatDate(new Date(), tz, 'EEEE, MMMM d') + ': ' + fmtHrs(grand) + ' hrs');
  out.push('');
  out.push('To push these into MyCase: open the sheet, Greco Time → Rebuild MyCase export.');

  MailApp.sendEmail({
    to: to,
    subject: 'Greco Time — ' + fmtHrs(grand) + ' hrs logged ' +
             Utilities.formatDate(new Date(), tz, 'MM/dd'),
    body: out.join('\n'),
  });
  return count;
}

/** Run once from the editor. Idempotent: clears any digest trigger it already made. */
function installDigestTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendDailyDigest') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendDailyDigest').timeBased().atHour(18).everyDays(1).create();
  Logger.log('Digest trigger installed for ~6pm ' + Session.getScriptTimeZone() + '.');
}
