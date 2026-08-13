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

function formatEntrySheet(sheet) {
  var rows = sheet.getLastRow() - 1;
  if (rows < 1) return;
  // MyCase's importer expects US dates; hours to one decimal so 1.5 never renders as 2.
  sheet.getRange(2, col('date') + 1, rows, 1).setNumberFormat(MYCASE_DATE_FORMAT);
  sheet.getRange(2, col('hours') + 1, rows, 1).setNumberFormat('0.0');
}

/** Run once from the editor after setting Script Properties. */
function setupSheet() {
  tab(TABS.entries, ENTRY_HEADERS);
  tab(TABS.clients, CLIENT_HEADERS);
  tab(TABS.devices, DEVICE_HEADERS);
  tab(TABS.export, MYCASE_FIELDS.map(function (f) { return f.header; }));
  tab(TABS.batch, ['UUID']);
  Logger.log('Tabs ready. Remaining: set PIN_HASH, TIMEKEEPERS, NOTIFY_* in Script Properties.');
}

/* ══════════════════════════════ MyCase export ══════════════════════════════ */

/**
 * Rebuilds the MyCaseExport tab: real (non-test) entries that have not been exported
 * yet, in the template's exact column order and nothing else, so the tab can go
 * straight out via File → Download → CSV.
 *
 * The UUIDs that went into the batch are recorded on the hidden _ExportBatch tab, so
 * "Mark exported" stamps precisely the rows that were downloaded — importing the same
 * rows twice would double-bill a client.
 */
function rebuildExport() {
  var src = tab(TABS.entries, ENTRY_HEADERS);
  var headers = MYCASE_FIELDS.map(function (f) { return f.header; });
  var out = tab(TABS.export, headers);
  var batch = tab(TABS.batch, ['UUID']);

  var last = src.getLastRow();
  var rows = [], uuids = [];

  if (last > 1) {
    var values = src.getRange(2, 1, last - 1, ENTRY_HEADERS.length).getValues();
    var iTest = col('isTest'), iExp = col('exported'), iUuid = col('uuid');

    values.forEach(function (row) {
      if (String(row[iTest]).toUpperCase() === 'TRUE') return;
      if (String(row[iExp]).toUpperCase() === 'TRUE') return;
      rows.push(row.slice(0, headers.length));
      uuids.push([row[iUuid]]);
    });
  }

  // Clear previous contents but keep the header row.
  if (out.getLastRow() > 1) out.getRange(2, 1, out.getLastRow() - 1, out.getLastColumn()).clearContent();
  if (batch.getLastRow() > 1) batch.getRange(2, 1, batch.getLastRow() - 1, 1).clearContent();

  if (rows.length) {
    out.getRange(2, 1, rows.length, headers.length).setValues(rows);
    // Same logical columns, but positions within the MyCase-only block.
    out.getRange(2, col('date') + 1, rows.length, 1).setNumberFormat(MYCASE_DATE_FORMAT);
    out.getRange(2, col('hours') + 1, rows.length, 1).setNumberFormat('0.0');
    batch.getRange(2, 1, uuids.length, 1).setValues(uuids);
  }

  return rows.length;
}

/** Stamps Exported=TRUE on exactly the rows the last rebuild put in the export tab. */
function markExported() {
  var batch = tab(TABS.batch, ['UUID']);
  if (batch.getLastRow() < 2) return 0;

  var wanted = {};
  batch.getRange(2, 1, batch.getLastRow() - 1, 1).getValues().forEach(function (r) {
    if (r[0]) wanted[String(r[0])] = true;
  });

  var src = tab(TABS.entries, ENTRY_HEADERS);
  var last = src.getLastRow();
  if (last < 2) return 0;

  var iUuid = ENTRY_HEADERS.indexOf('UUID');
  var expCol = ENTRY_HEADERS.indexOf('Exported') + 1;
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
  batch.getRange(2, 1, batch.getLastRow() - 1, 1).clearContent();
  return n;
}

/* ══════════════════════════════ Sheet menu ══════════════════════════════ */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Greco Time')
    .addItem('Rebuild MyCase export', 'menuRebuildExport')
    .addItem('Mark exported rows as done', 'menuMarkExported')
    .addSeparator()
    .addItem('Set PIN…', 'menuSetPin')
    .addItem('Show phone setup link', 'menuSetupLink')
    .addItem('Email phone setup link…', 'menuEmailSetupLink')
    .addItem('Send today\'s digest now', 'menuSendDigest')
    .addToUi();
}

function menuRebuildExport() {
  var n = rebuildExport();
  SpreadsheetApp.getUi().alert(n
    ? n + ' entr' + (n === 1 ? 'y' : 'ies') + ' ready on "' + TABS.export + '".\n\n' +
      'Download it with File → Download → Comma-separated values, upload it in MyCase ' +
      '(Billing → Time Entries → Import Time Entries), then run "Mark exported rows as done".'
    : 'Nothing to export — every real entry is already marked exported.');
}

function menuMarkExported() {
  var n = markExported();
  SpreadsheetApp.getUi().alert(n
    ? n + ' row' + (n === 1 ? '' : 's') + ' marked as exported. They will not appear in the next export.'
    : 'No pending export batch found. Run "Rebuild MyCase export" first.');
}

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
 * https://script.google.com/a/macros/<domain>/s/<id>/exec. Both that and the plain
 * /macros/s/<id>/exec form work anonymously, but the plain one is shorter and has one
 * less moving part, so links are built from it.
 */
function normaliseExec(u) {
  var m = /^https:\/\/script\.google\.com\/(?:a\/macros\/[^\/]+|macros)\/s\/([^\/]+)\/exec$/.exec(u || '');
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
