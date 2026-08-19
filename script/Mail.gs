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
function fmtUsd(n) { return '$' + Number(n).toFixed(2); }

/** How an entry reads on one line, whichever kind it is. */
function fmtQty(entry) {
  return entryKind(entry) === 'expense'
    ? fmtUsd(entry.amount)
    : fmtHrs(entry.hours) + ' hrs (' + Math.round(entry.hours * 60) + ' min)';
}

function fmtDateUS(iso) {
  var d = toSheetDate(iso);
  return (d instanceof Date) ? Utilities.formatDate(d, Session.getScriptTimeZone(), 'MM/dd/yyyy') : String(iso);
}

/** One message per flush, not per entry: an offline batch of eight would otherwise
 *  arrive as eight emails, and per-entry mail is the part that risks the daily quota. */
function sendEntryMail(entries) {
  var to = recipients('NOTIFY_ENTRY');
  if (!to) return;

  var times = entries.filter(function (e) { return entryKind(e) !== 'expense'; });
  var costs = entries.filter(function (e) { return entryKind(e) === 'expense'; });
  var hours = times.reduce(function (s, e) { return s + Number(e.hours); }, 0);
  var money = costs.reduce(function (s, e) { return s + Number(e.amount); }, 0);
  var one = entries.length === 1;

  // The totals both matter, so the subject carries whichever kinds are actually present.
  var totals = [];
  if (times.length) totals.push(fmtHrs(hours) + ' hrs');
  if (costs.length) totals.push(fmtUsd(money));

  var subject = one
    ? (entryKind(entries[0]) === 'expense' ? 'Expense: ' : 'Time: ') +
      fmtQty(entries[0]).replace(/ \(.*\)$/, '') + ' — ' + entries[0].client
    : 'Greco Time: ' + entries.length + ' entries, ' + totals.join(' + ');

  var lines = entries.map(function (e) {
    return [
      fmtDateUS(e.date),
      entryKind(e) === 'expense' ? 'EXPENSE' : 'time',
      e.client,
      e.matterType,
      fmtQty(e),
      e.timekeeper,
      e.description || '(no description)',
    ].join('  ·  ');
  });

  var tabs = [];
  if (times.length) tabs.push('"' + TABS.entries + '"');
  if (costs.length) tabs.push('"' + TABS.expenses + '"');

  var body = lines.join('\n') +
    (one ? '' : '\n\nTotal: ' + totals.join(' + ')) +
    '\n\nLogged from Greco Time. Entries are on the ' + tabs.join(' and ') + ' tab' +
    (tabs.length > 1 ? 's' : '') + '.';

  MailApp.sendEmail({ to: to, subject: subject, body: body });
}

/**
 * End-of-day summary. Wire to a daily time-based trigger (see installDigestTrigger).
 * Returns the number of entries reported, so the menu item can say nothing happened.
 */
/** Today's rows off one data tab, grouped by timekeeper. Shared by both kinds. */
function digestRows(spec, tz, today) {
  var sheet = tab(spec.source, spec.sourceHeaders);
  var last = sheet.getLastRow();
  if (last < 2) return { byPerson: {}, count: 0, grand: 0, flagged: [] };

  var iDate = specCol(spec, 'date'), iClient = specCol(spec, 'client');
  var iUser = specCol(spec, 'timekeeper'), iDesc = specCol(spec, 'description');
  var iMatter = specCol(spec, 'matterType'), iTest = specCol(spec, 'isTest');
  var iQty = specCol(spec, spec.amountKey);

  var isExpense = spec.kind === 'expense';
  var ceiling = isExpense ? SUSPICIOUS_AMOUNT : SUSPICIOUS_HOURS;
  var fmt = isExpense ? fmtUsd : fmtHrs;

  var byPerson = {}, count = 0, grand = 0, flagged = [];

  sheet.getRange(2, 1, last - 1, spec.sourceHeaders.length).getValues().forEach(function (row) {
    if (String(row[iTest]).toUpperCase() === 'TRUE') return;
    var d = row[iDate];
    var iso = (d instanceof Date) ? Utilities.formatDate(d, tz, 'yyyy-MM-dd') : String(d);
    if (iso !== today) return;

    var who = String(row[iUser] || 'Unassigned');
    var qty = Number(row[iQty]) || 0;
    (byPerson[who] = byPerson[who] || []).push({
      client: row[iClient], qty: qty, matter: row[iMatter], desc: row[iDesc],
    });
    count++;
    grand += qty;
    if (qty > ceiling) flagged.push(who + ' — ' + row[iClient] + ': ' + fmt(qty));
  });

  return { byPerson: byPerson, count: count, grand: grand, flagged: flagged, fmt: fmt };
}

function digestSection(title, part) {
  var out = [title];
  Object.keys(part.byPerson).sort().forEach(function (who) {
    var rows = part.byPerson[who];
    var sub = rows.reduce(function (s, r) { return s + r.qty; }, 0);
    out.push('  ' + who + ' — ' + part.fmt(sub));
    rows.forEach(function (r) {
      out.push('      ' + part.fmt(r.qty) + '  ' + r.client +
        (r.matter ? '  [' + r.matter + ']' : '') +
        (r.desc ? '  — ' + r.desc : ''));
    });
  });
  out.push('');
  return out;
}

function sendDailyDigest() {
  var to = recipients('NOTIFY_DIGEST');
  var tz = Session.getScriptTimeZone();
  var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');

  var time = digestRows(exportSpec('time'), tz, today);
  var costs = digestRows(exportSpec('expense'), tz, today);
  var count = time.count + costs.count;

  if (!count || !to) return 0;

  var out = [];
  if (time.count) digestSection('TIME', time).forEach(function (l) { out.push(l); });
  if (costs.count) digestSection('EXPENSES', costs).forEach(function (l) { out.push(l); });

  if (time.flagged.length) {
    out.push('Worth a second look (over ' + SUSPICIOUS_HOURS + ' hrs on one entry):');
    time.flagged.forEach(function (f) { out.push('    ' + f); });
    out.push('');
  }
  if (costs.flagged.length) {
    out.push('Worth a second look (over ' + fmtUsd(SUSPICIOUS_AMOUNT) + ' on one expense):');
    costs.flagged.forEach(function (f) { out.push('    ' + f); });
    out.push('');
  }

  var totals = [];
  if (time.count) totals.push(fmtHrs(time.grand) + ' hrs');
  if (costs.count) totals.push(fmtUsd(costs.grand));

  out.push('Total for ' + Utilities.formatDate(new Date(), tz, 'EEEE, MMMM d') + ': ' + totals.join(' + '));
  out.push('');
  out.push('To push these into MyCase: open the sheet, then Greco Time → Time → MyCase → ' +
    'Prepare export…' + (costs.count ? ' (and the same under Expenses → MyCase).' : '.'));

  MailApp.sendEmail({
    to: to,
    subject: 'Greco Time — ' + totals.join(' + ') + ' logged ' +
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
