/**
 * Greco Time — spreadsheet plumbing, the export, and the Sheet menu.
 */

/** Returns a tab, creating it with headers if it does not exist yet. */
function tab(name, headers) {
  var ss = book();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers])
      .setFontWeight('bold').setBackground('#00376A').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    if (name === TABS.batch) sheet.hideSheet();
  }
  return sheet;
}

/**
 * Number formats on a data tab.
 *
 * Sheets writes the *displayed* value into a CSV, so these formats are the wire format
 * for the export, not decoration: hours must show one decimal or 1.5 renders as 2, and
 * money must show two or $12.30 renders as $12.3.
 */
function formatEntrySheet(spec, sheet) {
  var rows = sheet.getLastRow() - 1;
  if (rows < 1) return;
  sheet.getRange(2, specCol(spec, 'date') + 1, rows, 1).setNumberFormat(MYCASE_DATE_FORMAT);
  if (spec.kind === 'expense') {
    sheet.getRange(2, specCol(spec, 'amount') + 1, rows, 1).setNumberFormat('0.00');
  } else {
    sheet.getRange(2, specCol(spec, 'hours') + 1, rows, 1).setNumberFormat('0.0');
  }
}

/** Run once from the editor after setting Script Properties. */
function setupSheet() {
  tab(TABS.entries, ENTRY_HEADERS);
  tab(TABS.expenses, EXPENSE_HEADERS);
  tab(TABS.clients, CLIENT_HEADERS);
  tab(TABS.devices, DEVICE_HEADERS);
  var specs = exportSpecs();
  Object.keys(specs).forEach(function (k) {
    var spec = specs[k];
    tab(spec.exportTab, spec.fields.map(spec.headerFor));
    tab(spec.batchTab, BATCH_HEADERS);
  });
  Logger.log('Tabs ready. Remaining: set PIN_HASH, TIMEKEEPERS, NOTIFY_* in Script Properties.');
}

/* ══════════════════════════════ MyCase export ══════════════════════════════ */

/**
 * Reads the pending rows for an export: real (non-test) entries not yet exported.
 *
 * Returns the MyCase-block values, the UUIDs behind them, and a preflight list of
 * anything that would make MyCase reject or mis-file a row. The preflight is advisory —
 * it never silently drops a row, because a row missing from an export is a bill that
 * never goes out, which is worse than an import error you can see.
 */
function pendingExport(spec) {
  var src = tab(spec.source, spec.sourceHeaders);
  var width = spec.fields.length;
  var last = src.getLastRow();
  var rows = [], uuids = [], problems = [], total = 0;

  if (last > 1) {
    var values = src.getRange(2, 1, last - 1, spec.sourceHeaders.length).getValues();
    var iTest = specCol(spec, 'isTest'), iExp = specCol(spec, 'exported');
    var iUuid = specCol(spec, 'uuid'), iClient = specCol(spec, 'client');
    var iUser = specCol(spec, 'timekeeper'), iAmt = specCol(spec, spec.amountKey);
    var iDate = specCol(spec, 'date');

    var known = {};
    readClients().forEach(function (c) { known[c.name.trim().toLowerCase()] = true; });
    var roster = {};
    timekeepers().forEach(function (t) { roster[t.name] = true; });

    values.forEach(function (row, i) {
      if (String(row[iTest]).toUpperCase() === 'TRUE') return;
      if (String(row[iExp]).toUpperCase() === 'TRUE') return;

      var sheetRow = i + 2;
      var name = String(row[iClient] || '').trim();
      var amount = Number(row[iAmt]);

      if (!name) problems.push('Row ' + sheetRow + ': no case name — MyCase will reject it.');
      else if (!known[name.toLowerCase()]) {
        problems.push('Row ' + sheetRow + ': “' + name + '” is not on the ' + TABS.clients +
          ' tab. If MyCase does not spell it exactly this way, the import will fail.');
      }
      if (!roster[String(row[iUser] || '')]) {
        problems.push('Row ' + sheetRow + ': user “' + row[iUser] + '” is not in TIMEKEEPERS.');
      }
      if (!isFinite(amount) || amount <= 0) {
        problems.push('Row ' + sheetRow + ': ' + spec.amountLabel + ' is “' + row[iAmt] + '”.');
      }
      if (!(row[iDate] instanceof Date)) {
        problems.push('Row ' + sheetRow + ': the date is not a real date value.');
      } else if (row[iDate].getTime() > Date.now() + 864e5) {
        problems.push('Row ' + sheetRow + ': dated in the future.');
      }

      rows.push(row.slice(0, width));
      uuids.push(String(row[iUuid]));
      if (isFinite(amount)) total += amount;
    });
  }

  return { rows: rows, uuids: uuids, problems: problems, total: total };
}

/**
 * Rebuilds an export tab: the pending rows, in the template's exact column order and
 * nothing else, so the tab can go straight out via File → Download → CSV.
 *
 * The UUIDs that went into the batch are recorded on the hidden batch tab, so
 * "Mark exported" stamps precisely the rows that were downloaded — importing the same
 * rows twice would double-bill a client.
 */
/**
 * `limit` exists for the very first real import. Paul needs to prove MyCase accepts the
 * template before trusting a week of billing to it, and a one-row batch does that while
 * staying on the normal rails: the batch tab records that single UUID, so "mark exported"
 * marks exactly it and the other pending rows are untouched and still pending. Building
 * the sample any other way risks a row that was imported but never marked, which the next
 * export would import again.
 */
function rebuildExportFor(spec, limit) {
  var pending = pendingExport(spec);
  if (limit && pending.rows.length > limit) {
    var iAmt = specCol(spec, spec.amountKey);
    pending.pendingRows = pending.rows.length;
    pending.rows = pending.rows.slice(0, limit);
    pending.uuids = pending.uuids.slice(0, limit);
    pending.truncatedTo = limit;
    pending.total = pending.rows.reduce(function (s, r) {
      var v = Number(r[iAmt]);
      return s + (isFinite(v) ? v : 0);
    }, 0);
  }
  var headers = spec.fields.map(spec.headerFor);
  var out = tab(spec.exportTab, headers);
  var batch = tab(spec.batchTab, BATCH_HEADERS);

  // Headers are rewritten every time, so correcting MYCASE_EXPENSE_HEADERS takes effect
  // on the next rebuild rather than needing the tab deleted by hand.
  out.getRange(1, 1, 1, headers.length).setValues([headers]);

  // The export tab is always emptied, even when there is nothing pending: leaving the
  // last batch sitting there invites someone downloading and importing it a second time.
  if (out.getLastRow() > 1) out.getRange(2, 1, out.getLastRow() - 1, out.getLastColumn()).clearContent();

  if (pending.rows.length) {
    // The batch is only cleared when a new one replaces it, so that running "Prepare
    // export…" out of curiosity right after a mark does not silently destroy the undo.
    if (batch.getLastRow() > 1) {
      batch.getRange(2, 1, batch.getLastRow() - 1, BATCH_HEADERS.length).clearContent();
    }
    out.getRange(2, 1, pending.rows.length, headers.length).setValues(pending.rows);
    // Same logical columns, but positions within the MyCase-only block.
    out.getRange(2, specCol(spec, 'date') + 1, pending.rows.length, 1).setNumberFormat(MYCASE_DATE_FORMAT);
    out.getRange(2, specCol(spec, spec.amountKey) + 1, pending.rows.length, 1)
      .setNumberFormat(spec.kind === 'expense' ? '0.00' : '0.0');
    batch.getRange(2, 1, pending.uuids.length, BATCH_HEADERS.length).setValues(
      pending.uuids.map(function (u) { return [u, '']; }));
  }

  return pending;
}

/** Kept as the time-only entry point the older menu wiring and tests call. */
function rebuildExport() {
  return rebuildExportFor(exportSpec('time')).rows.length;
}

/**
 * Stamps Exported=TRUE on exactly the rows the last rebuild put in the export tab, and
 * records when, so undoExportMark can put them back.
 */
function markExportedFor(spec) {
  var batch = tab(spec.batchTab, BATCH_HEADERS);
  if (batch.getLastRow() < 2) return 0;

  var batchRows = batch.getRange(2, 1, batch.getLastRow() - 1, BATCH_HEADERS.length).getValues();
  var wanted = {};
  batchRows.forEach(function (r) { if (r[0]) wanted[String(r[0])] = true; });

  var src = tab(spec.source, spec.sourceHeaders);
  var last = src.getLastRow();
  if (last < 2) return 0;

  var iUuid = specCol(spec, 'uuid');
  var expCol = specCol(spec, 'exported') + 1;
  var uuids = src.getRange(2, iUuid + 1, last - 1, 1).getValues();
  var flags = src.getRange(2, expCol, last - 1, 1).getValues();

  var n = 0;
  for (var i = 0; i < uuids.length; i++) {
    if (wanted[String(uuids[i][0])] && String(flags[i][0]).toUpperCase() !== 'TRUE') {
      flags[i][0] = 'TRUE';
      n++;
    }
  }
  src.getRange(2, expCol, flags.length, 1).setValues(flags);

  // Stamped, not cleared — this is what keeps the mark reversible. The next rebuild
  // clears the tab, so only ever one batch is undoable, which is the one that matters.
  var now = new Date();
  batch.getRange(2, 2, batchRows.length, 1).setValues(batchRows.map(function (r) {
    return [r[0] ? now : ''];
  }));
  return n;
}

function markExported() {
  return markExportedFor(exportSpec('time'));
}

/**
 * Puts a marked batch back to Exported=FALSE.
 *
 * The failure this exists for: the CSV is downloaded, "mark exported" is run, and only
 * then does MyCase reject the file. Without an undo those rows are invisible to every
 * future export and simply never get billed.
 */
function undoExportMark(spec) {
  var batch = tab(spec.batchTab, BATCH_HEADERS);
  if (batch.getLastRow() < 2) return { n: 0, markedAt: null };

  var batchRows = batch.getRange(2, 1, batch.getLastRow() - 1, BATCH_HEADERS.length).getValues();
  var wanted = {}, markedAt = null;
  batchRows.forEach(function (r) {
    if (!r[0] || !r[1]) return;
    wanted[String(r[0])] = true;
    if (r[1] instanceof Date && (!markedAt || r[1] > markedAt)) markedAt = r[1];
  });
  if (!markedAt) return { n: 0, markedAt: null };

  var src = tab(spec.source, spec.sourceHeaders);
  var last = src.getLastRow();
  if (last < 2) return { n: 0, markedAt: null };

  var iUuid = specCol(spec, 'uuid');
  var expCol = specCol(spec, 'exported') + 1;
  var uuids = src.getRange(2, iUuid + 1, last - 1, 1).getValues();
  var flags = src.getRange(2, expCol, last - 1, 1).getValues();

  var n = 0;
  for (var i = 0; i < uuids.length; i++) {
    if (wanted[String(uuids[i][0])] && String(flags[i][0]).toUpperCase() === 'TRUE') {
      flags[i][0] = 'FALSE';
      n++;
    }
  }
  src.getRange(2, expCol, flags.length, 1).setValues(flags);
  batch.getRange(2, 2, batchRows.length, 1).clearContent();
  return { n: n, markedAt: markedAt };
}

/* ══════════════════════════════ CSV ══════════════════════════════ */

/**
 * RFC-4180 quoting. Quotes only when needed, doubling embedded quotes.
 *
 * A case name containing a comma — "Estate of Ruiz, Deceased" — is ordinary here, and
 * an unquoted one shifts every later column by one, which silently files the note as the
 * date. Anything with a comma, a quote, a newline, or edge whitespace gets quoted.
 */
function csvCell(v) {
  var s = (v === null || v === undefined) ? '' : String(v);
  if (/[",\n\r]/.test(s) || s !== s.trim()) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function toCsv(rows) {
  return rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n';
}

/**
 * The export as CSV text, built here rather than by downloading the tab.
 *
 * Why not File → Download → CSV: it exports whichever sheet happens to be active, so the
 * one manual step in the whole pipeline is also the easiest to get wrong — download the
 * Clients tab, upload it to MyCase, and the error you get back explains nothing. Building
 * the text here means the file can only ever contain the export.
 *
 * Values are read with getDisplayValues so the date and amount formats set on the tab are
 * exactly what lands in the file, which is the same thing Sheets' own CSV writer does.
 */
function exportCsv(spec, limit) {
  var headers = spec.fields.map(spec.headerFor);
  var out = tab(spec.exportTab, headers);
  var last = out.getLastRow();
  var rows = [headers];
  if (last > 1) {
    var n = limit ? Math.min(limit, last - 1) : last - 1;
    out.getRange(2, 1, n, headers.length).getDisplayValues().forEach(function (r) { rows.push(r); });
  }
  return toCsv(rows);
}

/* ══════════════════════════════ Sheet menu ══════════════════════════════ */

function onOpen() {
  var ui = SpreadsheetApp.getUi();
  ui.createMenu('Greco Time')
    .addSubMenu(ui.createMenu('Time → MyCase')
      .addItem('Prepare export…', 'menuPrepareTime')
      .addItem('Prepare a 1-row test import…', 'menuTestTime')
      .addItem('Mark exported rows as done', 'menuMarkTime')
      .addItem('Undo the last “mark exported”', 'menuUndoTime'))
    .addSubMenu(ui.createMenu('Expenses → MyCase')
      .addItem('Prepare export…', 'menuPrepareExpense')
      .addItem('Prepare a 1-row test import…', 'menuTestExpense')
      .addItem('Mark exported rows as done', 'menuMarkExpense')
      .addItem('Undo the last “mark exported”', 'menuUndoExpense'))
    .addSeparator()
    .addItem('Set PIN…', 'menuSetPin')
    .addItem('Show phone setup link', 'menuSetupLink')
    .addItem('Email phone setup link…', 'menuEmailSetupLink')
    .addItem('Send today\'s digest now', 'menuSendDigest')
    .addToUi();
}

/* Thin wrappers, because Apps Script menu items can only name a zero-argument function. */
function menuPrepareTime()    { menuPrepare('time'); }
function menuPrepareExpense() { menuPrepare('expense'); }
function menuTestTime()       { menuPrepare('time', 1); }
function menuTestExpense()    { menuPrepare('expense', 1); }
function menuMarkTime()       { menuMark('time'); }
function menuMarkExpense()    { menuMark('expense'); }
function menuUndoTime()       { menuUndo('time'); }
function menuUndoExpense()    { menuUndo('expense'); }

/** MyCase's own import screen, named per kind so the instructions are followable. */
function importPath(spec) {
  return spec.kind === 'expense'
    ? 'Billing → Expenses → Import Expenses'
    : 'Billing → Time Entries → Import Time Entries';
}

function fmtTotal(spec, n) {
  return spec.kind === 'expense'
    ? '$' + Number(n).toFixed(2)
    : Number(n).toFixed(1) + ' hrs';
}

/**
 * Rebuilds the export, then shows what is about to leave the building.
 *
 * The dialog exists because every previous step is automatic and this one is not: the
 * file has to be downloaded by hand and uploaded to MyCase by hand. So it selects the
 * export tab for you (File → Download exports whichever sheet is *active*, and picking
 * the wrong one produces a MyCase error that explains nothing), shows the exact rows,
 * previews the first lines of the CSV MyCase will parse, and lists anything that looks
 * likely to be rejected.
 */
function menuPrepare(kind, limit) {
  var ui = SpreadsheetApp.getUi();
  var spec = exportSpec(kind);
  var pending = rebuildExportFor(spec, limit);

  if (!pending.rows.length) {
    ui.alert('Nothing to export — every real ' + spec.label.replace(/s$/, '') +
      ' is already marked exported.');
    return;
  }

  // Select it, so "File → Download" cannot be pointed at the wrong sheet.
  var out = book().getSheetByName(spec.exportTab);
  if (out) { out.activate(); SpreadsheetApp.setActiveSheet(out); }

  var n = pending.rows.length;
  // The preview reads *displayed* values, and the number formats were only just applied —
  // without a flush the dates can still come back as serial numbers, which would show a
  // preview that does not match the file MyCase actually receives.
  SpreadsheetApp.flush();
  var lines = exportCsv(spec, 4).split('\r\n').filter(function (l) { return l; });

  var esc = function (s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };

  var html = '<style>body{font:13px -apple-system,Arial,sans-serif;margin:16px;line-height:1.5}' +
    'h3{margin:0 0 4px;font-size:15px}ol{padding-left:20px;margin:8px 0}' +
    'pre{background:#f4f6f8;border:1px solid #dfe3e8;border-radius:6px;padding:8px;' +
    'font-size:11px;overflow-x:auto;white-space:pre}' +
    '.warn{background:#fff6e0;border:1px solid #f0c36d;color:#7a4d00;padding:8px 10px;' +
    'border-radius:6px;margin:10px 0}' +
    '.bad{background:#fdecec;border:1px solid #f3c2c2;color:#8E0000;padding:8px 10px;' +
    'border-radius:6px;margin:10px 0}' +
    'ul.p{margin:6px 0 0;padding-left:18px}b.big{font-size:15px}</style>';

  html += '<h3>' + n + ' ' + (n === 1 ? spec.label.replace(/s$/, '') : spec.label) +
    ' ready · ' + esc(fmtTotal(spec, pending.total)) + '</h3>';

  if (pending.truncatedTo) {
    html += '<div class="warn"><b>Test batch.</b> Only the first ' + pending.truncatedTo +
      ' of ' + pending.pendingRows + ' pending row' + (pending.pendingRows === 1 ? '' : 's') +
      ' is in this export. The rest stay pending and will be in the next one.</div>';
  }

  if (!spec.verified) {
    html += '<div class="bad"><b>These column headers are not confirmed.</b> The time template ' +
      'was checked against MyCase\'s real file; this expense one has not been. Download ' +
      'MyCase\'s expense template (' + esc(importPath(spec)) + ' → download CSV template) and ' +
      'compare its header row with the first line below. If only the wording differs, fix it ' +
      'with the <code>MYCASE_EXPENSE_HEADERS</code> script property — no code change needed.</div>';
  }

  if (pending.problems.length) {
    html += '<div class="warn"><b>Worth checking first</b> — nothing has been dropped, but ' +
      'MyCase may refuse these:<ul class="p">' +
      pending.problems.slice(0, 12).map(function (p) { return '<li>' + esc(p) + '</li>'; }).join('') +
      (pending.problems.length > 12 ? '<li>… and ' + (pending.problems.length - 12) + ' more</li>' : '') +
      '</ul></div>';
  }

  html += '<p>The <b>' + esc(spec.exportTab) + '</b> tab is now selected. This is what MyCase ' +
    'will read:</p><pre>' + esc(lines.join('\n')) +
    (n > 3 ? '\n… ' + (n - 3) + ' more row' + (n - 3 === 1 ? '' : 's') : '') + '</pre>';

  html += '<ol>' +
    '<li><b>File → Download → Comma-separated values (.csv)</b></li>' +
    '<li>In MyCase: <b>' + esc(importPath(spec)) + '</b>, upload the file</li>' +
    '<li>Check the row count MyCase reports matches <b class="big">' + n + '</b></li>' +
    '<li>Back here: <b>Greco Time → ' + (kind === 'expense' ? 'Expenses' : 'Time') +
    ' → MyCase → Mark exported rows as done</b></li>' +
    '</ol>' +
    '<p>Only step 4 is destructive, and it is reversible — if MyCase rejects the file after ' +
    'you have already marked it, use <b>Undo the last “mark exported”</b>.</p>';

  ui.showModalDialog(HtmlService.createHtmlOutput(html).setWidth(600).setHeight(560),
    (pending.truncatedTo ? 'Test import — ' : '') + 'Ready for MyCase');
}

function menuMark(kind) {
  var spec = exportSpec(kind);
  var n = markExportedFor(spec);
  SpreadsheetApp.getUi().alert(n
    ? n + ' row' + (n === 1 ? '' : 's') + ' marked as exported. They will not appear in the ' +
      'next export.\n\nIf MyCase turns out to have rejected the file, undo this with ' +
      '"Undo the last “mark exported”" — until the next export is prepared, which clears it.'
    : 'No pending export batch found. Run "Prepare export…" first.');
}

function menuUndo(kind) {
  var spec = exportSpec(kind);
  var res = undoExportMark(spec);
  SpreadsheetApp.getUi().alert(res.n
    ? res.n + ' row' + (res.n === 1 ? '' : 's') + ' put back to not-exported. They will be in ' +
      'the next export again.\n\nOnly do this if MyCase did not actually accept the file — ' +
      'otherwise the same rows get imported twice and the client is billed twice.'
    : 'Nothing to undo. Only the most recent "mark exported" can be reversed, and preparing ' +
      'a new export clears it.');
}

/* Kept so an older bound trigger or a hand-run call still works. */
function menuRebuildExport() { menuPrepare('time'); }
function menuMarkExported()  { menuMark('time'); }

/** Hashes the PIN here so the plaintext is never typed into Script Properties, where
 *  it would sit readable to anyone with edit access to the project. */
function menuSetPin() {
  var ui = SpreadsheetApp.getUi();
  var res = ui.prompt('Set the device PIN', 'Everyone installing the app types this once.', ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  var pin = res.getResponseText().trim();
  if (pin.length < 4) { ui.alert('Use at least 4 characters.'); return; }
  PropertiesService.getScriptProperties().setProperty('PIN_HASH', sha256Hex(pin));
  ui.alert('PIN saved. Only its SHA-256 hash is stored.');
}

/**
 * The web app's /exec URL.
 *
 * ScriptApp.getService().getUrl() sometimes returns the /dev URL, which only works for
 * someone signed into the owning Google account — on a phone it fails with a bare
 * "Load failed". Set the EXEC_URL script property to the real /exec URL (copied from the
 * deployment dialog) and it is used verbatim.
 */
function execUrl() {
  var override = prop('EXEC_URL');
  if (override) return override.trim();
  try { return ScriptApp.getService().getUrl() || ''; } catch (err) { return ''; }
}

/**
 * Workspace accounts report their web app as
 * https://script.google.com/a/<domain>/macros/s/<id>/exec — note the domain comes before
 * "macros". Both that and the plain /macros/s/<id>/exec form work anonymously, but the
 * plain one is shorter and domain-independent, so links are built from it.
 */
function normaliseExec(u) {
  var m = /^https:\/\/script\.google\.com\/(?:a\/[^\/]+\/)?macros\/s\/([^\/]+)\/exec$/.exec(u || '');
  return m ? 'https://script.google.com/macros/s/' + m[1] + '/exec' : u;
}

function setupLink() {
  var exec = normaliseExec(execUrl());
  var pwa = prop('PWA_URL');
  if (!exec) throw new Error('No web app URL. Deploy it (Deploy → New deployment → Web app), then paste the /exec URL into the EXEC_URL script property.');
  if (!pwa) throw new Error('Set PWA_URL in Script Properties to where the app is hosted.');
  if (exec.slice(-4) === '/dev') {
    throw new Error('The script is reporting its /dev URL, which will not work from a phone.\n\n' +
      'Copy the /exec URL from Deploy → Manage deployments and paste it into the EXEC_URL script property, then try again.');
  }
  return pwa + (pwa.slice(-1) === '/' ? '' : '/') + '#setup=' + encodeURIComponent(exec);
}

/**
 * Shows the link in a selectable field with a copy button. A plain ui.alert() renders the
 * text unselectable, which makes a 200-character link impossible to get onto a phone.
 */
function menuSetupLink() {
  var ui = SpreadsheetApp.getUi();
  var link;
  try { link = setupLink(); } catch (err) { ui.alert(err.message); return; }

  // JSON.stringify escapes quotes/backslashes safely for embedding in the script below.
  var html = '<style>body{font:13px -apple-system,Arial,sans-serif;margin:16px}' +
    'input{width:100%;font-size:13px;padding:8px;box-sizing:border-box}' +
    'button{margin-top:10px;padding:8px 14px;font-size:13px;cursor:pointer}' +
    'p{color:#555;line-height:1.45}</style>' +
    '<p>Open this on the phone <b>in Safari</b>, type the PIN, pick the timekeeper, then ' +
    '<b>Share → Add to Home Screen</b>.</p>' +
    '<input id="u" readonly>' +
    '<button onclick="c()">Copy link</button> <span id="ok"></span>' +
    '<p>The PIN is <b>not</b> in this link, so it is safe to text or email.</p>' +
    '<script>' +
    'var L=' + JSON.stringify(link) + ';' +
    'var i=document.getElementById("u");i.value=L;i.focus();i.select();' +
    'function c(){i.select();i.setSelectionRange(0,99999);' +
    'try{document.execCommand("copy");document.getElementById("ok").textContent="copied";}' +
    'catch(e){document.getElementById("ok").textContent="press Cmd+C";}}' +
    '</scr' + 'ipt>';

  ui.showModalDialog(HtmlService.createHtmlOutput(html).setWidth(520).setHeight(260),
                     'Phone setup link');
}

/** Emails the link, which is usually the easiest way to get it onto a phone. */
function menuEmailSetupLink() {
  var ui = SpreadsheetApp.getUi();
  var link;
  try { link = setupLink(); } catch (err) { ui.alert(err.message); return; }

  var res = ui.prompt('Email the setup link',
    'Send it to which address?\n\n(Open it on the phone in Safari, then Share → Add to Home Screen.)',
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;

  var to = res.getResponseText().trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) { ui.alert('That does not look like an email address.'); return; }

  MailApp.sendEmail({
    to: to,
    subject: 'Greco Time — set up your phone',
    body: 'Open this link on your iPhone in Safari:\n\n' + link +
      '\n\nType the PIN you were given, choose your name, then tap Share → Add to Home Screen.\n' +
      '\nThe PIN is not part of this link.',
  });
  ui.alert('Sent to ' + to + '.');
}

function menuSendDigest() {
  var n = sendDailyDigest();
  SpreadsheetApp.getUi().alert(n
    ? 'Digest sent.'
    : 'Nothing logged today, so no digest was sent.');
}
