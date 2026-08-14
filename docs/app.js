/* Greco Time — client logic.
 *
 * Three things in here matter more than the rest, so they are worth reading first:
 *
 *  1. Nothing is ever lost. A save writes to IndexedDB before anything touches the
 *     network. Safari has no Background Sync API, so a queued entry only reaches the
 *     Sheet when the app is next opened with signal — the pending badge exists so
 *     nobody can mistake "queued" for "filed".
 *  2. Nothing is ever double-billed. Every entry carries a UUID minted on the device,
 *     and the server ignores UUIDs it has already written. A retried flush is a no-op.
 *  3. The name written to the Sheet is always the canonical one from the Clients tab,
 *     never the "Last, First" form shown in the picker. MyCase matches on its own
 *     spelling, so the display form must never leak into the data.
 */
'use strict';

/* Name parsing, client search and time parsing live in names.js — kept separate
 * because they are pure and therefore unit-testable without a browser. */

/* ══════════════════════════════ constants ══════════════════════════════ */

const CFG_KEY = 'gt.config';
const CONFIRM_HOURS_OVER = 8;     // a second tap is required above this

/* ══════════════════════════════ tiny helpers ══════════════════════════════ */

const $ = (id) => document.getElementById(id);

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  // randomUUID is secure-context-only, so this fallback is what runs on Safari < 15.4
  // AND on any plain-http origin — including the LAN dev preview. getRandomValues is
  // not gated, so entry ids stay collision-safe either way.
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

let toastTimer = null;
function toast(msg, kind) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, kind === 'bad' ? 5000 : 2200);
}

/* ══════════════════════════════ config (localStorage) ══════════════════════════════ */

const cfg = {
  endpoint: '', pin: '', timekeeper: '', isTest: false, deviceId: '',

  load() {
    try { Object.assign(this, JSON.parse(localStorage.getItem(CFG_KEY) || '{}')); }
    catch (_) { /* corrupt config just falls back to setup */ }
    if (!this.deviceId) { this.deviceId = uuid(); this.save(); }
  },
  save() {
    localStorage.setItem(CFG_KEY, JSON.stringify({
      endpoint: this.endpoint, pin: this.pin, timekeeper: this.timekeeper,
      isTest: this.isTest, deviceId: this.deviceId,
    }));
  },
  get ready() { return Boolean(this.endpoint && this.pin && this.timekeeper); },
};

/* ══════════════════════════════ IndexedDB ══════════════════════════════
 * localStorage would be simpler, but losing a courthouse morning of billable
 * entries to storage eviction is the worst thing this app could do.
 *
 *   queue  — entries not yet confirmed by the server (keyed by uuid)
 *   recent — entries the server has confirmed, kept for the Today list
 *   meta   — key/value scratch (the cached client list)
 */

let _db = null;
function db() {
  if (_db) return _db;
  _db = new Promise((resolve, reject) => {
    const req = indexedDB.open('greco-time', 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('queue'))  d.createObjectStore('queue',  { keyPath: 'uuid' });
      if (!d.objectStoreNames.contains('recent')) d.createObjectStore('recent', { keyPath: 'uuid' });
      if (!d.objectStoreNames.contains('meta'))   d.createObjectStore('meta',   { keyPath: 'k' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _db;
}

function tx(store, mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    const r = fn(s);
    if (r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const store = {
  put:    (name, val) => tx(name, 'readwrite', (s) => s.put(val)),
  del:    (name, key) => tx(name, 'readwrite', (s) => s.delete(key)),
  all:    (name)      => tx(name, 'readonly',  (s) => s.getAll()),
  get:    (name, key) => tx(name, 'readonly',  (s) => s.get(key)),
};

const meta = {
  get: (k) => store.get('meta', k).then((r) => (r ? r.v : null)),
  set: (k, v) => store.put('meta', { k, v }),
};

/* ══════════════════════════════ server ══════════════════════════════ */

/* Apps Script never answers a CORS preflight, so every request has to qualify as a
 * "simple" request: text/plain body, no custom headers. The server JSON.parses it. */
async function api(action, payload, override) {
  const endpoint = (override && override.endpoint) || cfg.endpoint;
  const pin      = (override && override.pin)      || cfg.pin;
  if (!endpoint) throw new Error('Not set up yet.');

  // Safari reports every network-layer failure as a bare "Load failed", which tells the
  // user nothing. Catch it and say what was being contacted and what to check.
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, pin, deviceId: cfg.deviceId, payload: payload || {} }),
      redirect: 'follow',
    });
  } catch (err) {
    let host = endpoint;
    try { host = new URL(endpoint).host; } catch (_) { /* not even a valid URL */ }

    // Safari reports both "the request never left" and "it came back but CORS blocked
    // reading it" as an identical bare "Load failed". A no-cors retry tells them apart:
    // it is sent and resolves opaquely whenever the network path works, regardless of
    // CORS headers. Whether it resolves is the whole diagnosis.
    let reached = false;
    try {
      await fetch(endpoint, {
        method: 'POST', mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action: 'verify', pin: '', deviceId: cfg.deviceId, payload: {} }),
      });
      reached = true;
    } catch (_) { /* genuinely unreachable */ }

    throw new Error(
      (reached
        ? `Reached ${host}, but the browser refused to read the reply (CORS). ` +
          'The deployment is probably not set to "Anyone" access — redeploy it, or check ' +
          'EXEC_URL points at the deployment you published.'
        : `Could not reach ${host} at all — the request never got through. ` +
          'Check for a content blocker, a VPN, or iCloud Private Relay on this phone.') +
      ` [online:${navigator.onLine} err:${err.message || err}]`);
  }
  if (!res.ok) throw new Error(`Server returned ${res.status}`);

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch (_) {
    // Almost always the Google sign-in page, i.e. the deployment is not set to
    // "Anyone" access — a very common misconfiguration worth naming explicitly.
    throw new Error('Unexpected reply from the server. Check the Web App is deployed with access set to "Anyone".');
  }
  if (!data.ok) throw new Error(data.error || 'Request refused.');
  return data;
}

/* ══════════════════════════════ app state ══════════════════════════════ */

const state = {
  clients: [],
  matter: '',
  picked: null,        // canonical client object, once resolved
  activeIdx: -1,       // keyboard highlight in the suggestion list
  confirmingBigHours: false,
  flushing: false,
  rawHash: '',        // kept for diagnostics when a setup link arrives malformed
};

/* ══════════════════════════════ client list ══════════════════════════════ */

async function loadClients() {
  state.clients = (await meta.get('clients')) || [];
  if (!navigator.onLine) return;
  try {
    const data = await api('clients');
    const list = (data.clients || []).map((c) =>
      (typeof c === 'string' ? { name: c, matterType: '' } : { name: c.name, matterType: c.matterType || '' }));
    if (list.length) {
      state.clients = list;
      await meta.set('clients', list);
    }
  } catch (err) {
    // A stale cached list is far better than a dead autocomplete.
    console.warn('[gt] client list refresh failed:', err.message);
  }
}

/* ══════════════════════════════ suggestions UI ══════════════════════════════ */

/* Uses textContent rather than innerHTML: case names come out of a spreadsheet, and a
 * name containing markup must render as text, not as HTML. */
function suggestionRow(hit) {
  const li = document.createElement('li');
  li.setAttribute('role', 'option');
  li.setAttribute('aria-selected', 'false');

  // Wrapped in a span so the CSS line-clamp applies: real case names reach 150 chars.
  const label = document.createElement('span');
  label.textContent = hit.display;

  // The full name is the accessible name and the tooltip, even when visually clamped.
  li.title = hit.display;
  li.append(label);
  return li;
}

function renderSuggestions(hits) {
  const ul = $('suggestions');
  ul.textContent = '';
  state.activeIdx = -1;

  if (!hits.length) { ul.hidden = true; return; }

  hits.forEach((hit, i) => {
    const li = suggestionRow(hit);
    // pointerdown, not click: the input's blur would otherwise close the list first.
    li.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      pickClient(hit);
    });
    li.dataset.i = String(i);
    ul.append(li);
  });
  ul._hits = hits;
  ul.hidden = false;
}

function highlight(delta) {
  const ul = $('suggestions');
  if (ul.hidden || !ul.children.length) return;
  const n = ul.children.length;
  state.activeIdx = (state.activeIdx + delta + n) % n;
  [...ul.children].forEach((li, i) =>
    li.setAttribute('aria-selected', i === state.activeIdx ? 'true' : 'false'));
}

function pickClient(hit) {
  state.picked = hit.client;
  $('client').value = hit.display;
  $('suggestions').hidden = true;
  state.activeIdx = -1;

  // A client whose matter type is known in the Clients tab pre-selects it — one
  // fewer tap on the overwhelming majority of entries.
  if (hit.client.matterType && !state.matter) setMatter(hit.client.matterType);

  showClientState();
  $('hours').focus();
}

function showClientState() {
  const el = $('client-state');
  const isNew = $('new-client').checked;
  const typed = $('client').value.trim();

  if (isNew) {
    el.hidden = !typed;
    el.className = 'hint';
    el.textContent = typed ? `Will be added to the client list as “${typed}”.` : '';
    return;
  }
  if (state.picked) {
    el.hidden = false;
    el.className = 'hint matched';
    el.textContent = `✓ Filing under “${state.picked.name}”`;
    return;
  }
  el.hidden = true;
  el.textContent = '';
}

/* ══════════════════════════════ form wiring ══════════════════════════════ */

function setMatter(value) {
  state.matter = value;
  document.querySelectorAll('.seg').forEach((b) =>
    b.setAttribute('aria-checked', b.dataset.matter === value ? 'true' : 'false'));
}

function updateTimeReadout() {
  const el = $('time-readout');
  const h = parseHoursInput($('hours').value);
  if (h === null) { el.textContent = '—'; return; }
  const mins = hoursToMinutes(h);
  const units = Math.round(h * 10);
  el.textContent = `${fmtHours(h)} hrs · ${mins} min · ${units}×6min`;
}

function resetForm() {
  $('entry-form').reset();
  $('date').value = todayLocal();
  setMatter('');
  state.picked = null;
  state.confirmingBigHours = false;
  $('save').textContent = 'Save entry';
  $('suggestions').hidden = true;
  $('form-error').hidden = true;
  updateTimeReadout();
  showClientState();
}

function formError(msg) {
  const el = $('form-error');
  if (!msg) { el.hidden = true; return; }
  el.textContent = msg;
  el.hidden = false;
}

async function onSubmit(e) {
  e.preventDefault();
  formError('');

  if (!state.matter) return formError('Pick a matter type.');

  const date = $('date').value;
  if (!date) return formError('Pick a date.');

  const isNew = $('new-client').checked;
  const typed = $('client').value.trim().replace(/\s+/g, ' ');
  if (!typed) return formError('Enter a client name.');

  let clientName = typed;
  if (!isNew) {
    // Free text that happens to match a known client is fine; anything else is
    // refused, because a name MyCase does not recognise fails the import.
    if (!state.picked) {
      const exact = resolveExact(state.clients, typed);
      if (exact) state.picked = exact;
    }
    if (!state.picked) {
      return formError('That name isn’t in the client list. Pick a suggestion, or tick “new client”.');
    }
    clientName = state.picked.name;   // canonical spelling, always
  }

  const hours = parseHoursInput($('hours').value);
  if (hours === null) return formError('Enter time as hours, e.g. 1.5 for 90 minutes.');

  // Two-tap guard instead of a confirm() dialog: 15 typed when 1.5 was meant is the
  // single most likely data-entry error, and a modal here would be worse UX.
  if (hours > CONFIRM_HOURS_OVER && !state.confirmingBigHours) {
    state.confirmingBigHours = true;
    $('save').textContent = `Tap again to confirm ${fmtHours(hours)} hrs`;
    return;
  }

  const entry = {
    uuid: uuid(),
    date,
    matterType: state.matter,
    client: clientName,
    clientIsNew: isNew,
    hours,
    description: $('description').value.trim(),
    timekeeper: cfg.timekeeper,
    isTest: Boolean(cfg.isTest),
    deviceId: cfg.deviceId,
    createdAt: new Date().toISOString(),
    attempts: 0,
  };

  // Durable first, network second. If the tab dies right here the entry survives.
  await store.put('queue', entry);

  // Optimistically fold a brand-new client into the local list so a second entry
  // for them autocompletes straight away, without waiting for a server round-trip.
  if (isNew && !resolveExact(state.clients, clientName)) {
    state.clients = state.clients.concat([{ name: clientName, matterType: state.matter }]);
    await meta.set('clients', state.clients.map((c) => ({ name: c.name, matterType: c.matterType })));
  }

  resetForm();
  await renderToday();
  toast(`Saved ${fmtHours(hours)} hrs`);
  flush();
}

/* ══════════════════════════════ flush ══════════════════════════════ */

async function flush() {
  if (state.flushing || !cfg.ready) return;
  const queued = await store.all('queue');
  const sendable = queued.filter((q) => !q.error);
  if (!sendable.length) { renderPending(); return; }
  if (!navigator.onLine) { renderPending(); return; }

  state.flushing = true;
  try {
    const data = await api('entries', {
      entries: sendable.map(({ attempts, error, ...e }) => e),
    });

    const accepted = new Set(data.accepted || []);
    for (const e of sendable) {
      if (accepted.has(e.uuid)) {
        await store.del('queue', e.uuid);
        await store.put('recent', { ...e, queued: false, error: null });
      }
    }

    // Explicit server-side rejections are terminal — retrying forever would just
    // hide the problem. Flag them and leave them visible instead.
    for (const r of (data.rejected || [])) {
      const e = sendable.find((x) => x.uuid === r.uuid);
      if (e) await store.put('queue', { ...e, error: r.error || 'Rejected by server' });
    }

    if (accepted.size) {
      // A new client the server had not seen is now in the Clients tab; pick it up.
      loadClients();
      toast(accepted.size === 1 ? 'Filed to the sheet' : `Filed ${accepted.size} entries`);
    }
    if ((data.rejected || []).length) {
      toast(`${data.rejected.length} entr${data.rejected.length === 1 ? 'y' : 'ies'} refused — tap the badge`, 'bad');
    }
  } catch (err) {
    for (const e of sendable) await store.put('queue', { ...e, attempts: (e.attempts || 0) + 1 });
    console.warn('[gt] flush failed:', err.message);
  } finally {
    state.flushing = false;
    await renderPending();
    await renderToday();
  }
}

async function renderPending() {
  const queued = await store.all('queue');
  const btn = $('pending');
  if (!queued.length) { btn.hidden = true; return; }

  const bad = queued.filter((q) => q.error);
  btn.hidden = false;
  btn.textContent = bad.length
    ? `${bad.length} refused · ${queued.length} not filed`
    : `${queued.length} waiting to send`;
  btn.title = bad.length ? bad.map((b) => `${b.client}: ${b.error}`).join('\n') : '';
}

/* ══════════════════════════════ today list ══════════════════════════════ */

async function renderToday() {
  const today = todayLocal();
  const [queued, recent] = await Promise.all([store.all('queue'), store.all('recent')]);
  const rows = [
    ...queued.map((e) => ({ ...e, queued: true })),
    ...recent.map((e) => ({ ...e, queued: false })),
  ].filter((e) => e.date === today)
   .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

  const ul = $('today-list');
  ul.textContent = '';
  $('today-empty').hidden = rows.length > 0;

  for (const e of rows) {
    const li = document.createElement('li');

    const client = document.createElement('span');
    client.className = 't-client';
    client.textContent = e.client;

    const matter = document.createElement('span');
    matter.className = 't-matter';
    matter.textContent = (e.matterType || '').slice(0, 4);

    const hours = document.createElement('span');
    hours.className = 't-hours';
    hours.textContent = fmtHours(Number(e.hours));

    li.append(client, matter);
    if (e.queued) {
      const q = document.createElement('span');
      q.className = 't-queued';
      q.textContent = e.error ? 'refused' : 'queued';
      li.append(q);
    }
    li.append(hours);
    ul.append(li);
  }

  const total = rows.reduce((s, e) => s + Number(e.hours || 0), 0);
  $('today-total').textContent = `${fmtHours(total)} hrs`;
}

/* Keeps the Today list and the recent store from growing without bound. */
async function pruneRecent() {
  const cutoff = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  for (const e of await store.all('recent')) {
    if (String(e.date) < cutoff) await store.del('recent', e.uuid);
  }
}

/* ══════════════════════════════ setup screen ══════════════════════════════ */

function setupError(msg) {
  const el = $('setup-error');
  if (!msg) { el.hidden = true; return; }
  el.textContent = msg;
  el.hidden = false;
}

async function onConnect() {
  setupError('');
  const endpoint = $('setup-endpoint').value.trim();
  const pin = $('setup-pin').value.trim();
  if (!endpoint) return setupError('Paste the server address, or open the setup link you were sent.');
  if (!pin) return setupError('Enter the PIN.');

  // Caught here rather than at the network layer, where it surfaces as "Load failed".
  //
  // Two legitimate shapes. A Google Workspace account reports its web app under a
  // domain-scoped path, with the domain BEFORE "macros" (confirmed against the firm's
  // live deployment — an earlier guess had the segments the other way round):
  //   https://script.google.com/macros/s/<id>/exec
  //   https://script.google.com/a/<domain>/macros/s/<id>/exec
  if (!/^https:\/\/script\.google\.com\/(?:a\/[^/]+\/)?macros\/s\/[^/]+\/exec$/.test(endpoint)) {
    return setupError('That address does not look right. It should end in /exec, like:\n' +
      'https://script.google.com/macros/s/…/exec\n\n' +
      'Got (' + endpoint.length + ' chars): ' + endpoint +
      (state.rawHash ? '\n\nRaw link data: ' + state.rawHash.slice(0, 400) : ''));
  }

  const btn = $('setup-connect');
  btn.disabled = true;
  btn.textContent = 'Connecting…';
  try {
    const data = await api('verify', {}, { endpoint, pin });
    const sel = $('setup-timekeeper');
    sel.textContent = '';
    for (const tk of (data.timekeepers || [])) {
      const name = typeof tk === 'string' ? tk : tk.name;
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = (typeof tk !== 'string' && tk.isTest) ? `${name} (test)` : name;
      opt.dataset.test = String(Boolean(typeof tk !== 'string' && tk.isTest));
      sel.append(opt);
    }
    if (!sel.children.length) return setupError('The server returned no timekeepers. Set the roster in Script Properties.');

    $('setup-connect').hidden = true;
    $('setup-save').hidden = false;
    // Held in memory only until the person confirms who they are.
    cfg.endpoint = endpoint;
    cfg.pin = pin;
  } catch (err) {
    setupError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect';
  }
}

async function onSetupSave() {
  const sel = $('setup-timekeeper');
  const opt = sel.selectedOptions[0];
  if (!opt) return setupError('Choose who is using this phone.');
  cfg.timekeeper = opt.value;
  cfg.isTest = opt.dataset.test === 'true';
  cfg.save();
  // The setup hash is deliberately left in the URL for good. iOS saves whatever address
  // is showing when "Add to Home Screen" is tapped, and gives the installed app its own
  // storage — so clearing it would mean an icon added *after* setup opens to an empty
  // form with no server address, and a 114-character endpoint to retype on a phone.
  // Keeping it makes the install work whenever it happens. The hash is never sent to any
  // server, and it carries no PIN.
  await startApp();
}

/* ══════════════════════════════ boot ══════════════════════════════ */

async function startApp() {
  $('setup').hidden = true;
  $('app').hidden = false;
  $('who-name').textContent = cfg.timekeeper;
  $('who-test').hidden = !cfg.isTest;

  resetForm();
  await pruneRecent();
  await renderToday();
  await renderPending();
  await loadClients();
  flush();
}

function showSetup() {
  $('app').hidden = true;
  $('setup').hidden = false;
}

function wireEvents() {
  // Matter type
  document.querySelectorAll('.seg').forEach((b) =>
    b.addEventListener('click', () => setMatter(b.dataset.matter)));

  // Client autocomplete
  const client = $('client');
  client.addEventListener('input', () => {
    state.picked = null;
    if ($('new-client').checked) { $('suggestions').hidden = true; showClientState(); return; }
    renderSuggestions(searchClients(state.clients, client.value));
    showClientState();
  });
  client.addEventListener('keydown', (e) => {
    const ul = $('suggestions');
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(-1); }
    else if (e.key === 'Enter') {
      if (!ul.hidden && state.activeIdx >= 0 && ul._hits) {
        e.preventDefault();
        pickClient(ul._hits[state.activeIdx]);
      }
    } else if (e.key === 'Escape') { ul.hidden = true; }
  });
  client.addEventListener('blur', () => {
    // Delay so a tap on a suggestion still lands.
    setTimeout(() => { $('suggestions').hidden = true; }, 120);
    if (!$('new-client').checked && !state.picked) {
      const exact = resolveExact(state.clients, client.value);
      if (exact) { state.picked = exact; client.value = exact.name; }
    }
    showClientState();
  });

  $('new-client').addEventListener('change', () => {
    state.picked = null;
    $('suggestions').hidden = true;
    showClientState();
    $('client').focus();
  });

  // Time
  $('hours').addEventListener('input', () => {
    state.confirmingBigHours = false;
    $('save').textContent = 'Save entry';
    updateTimeReadout();
  });
  document.querySelectorAll('.chip').forEach((c) =>
    c.addEventListener('click', () => {
      $('hours').value = c.dataset.hours;
      state.confirmingBigHours = false;
      $('save').textContent = 'Save entry';
      updateTimeReadout();
    }));

  $('entry-form').addEventListener('submit', onSubmit);
  $('pending').addEventListener('click', () => { toast('Sending…'); flush(); });

  // Reset device — two taps, no modal dialog.
  let armed = false;
  $('reset-device').addEventListener('click', async () => {
    const q = await store.all('queue');
    if (!armed) {
      armed = true;
      $('reset-device').textContent = q.length
        ? `Tap again — ${q.length} entr${q.length === 1 ? 'y' : 'ies'} still unsent!`
        : 'Tap again to reset';
      setTimeout(() => { armed = false; $('reset-device').textContent = 'Reset this device'; }, 5000);
      return;
    }
    localStorage.removeItem(CFG_KEY);
    location.reload();
  });

  // Setup
  $('setup-paste').addEventListener('click', async () => {
    // Reading the clipboard needs a user gesture on iOS and shows a confirmation
    // prompt; if it is refused, fall back to telling the user to paste by hand.
    try {
      const t = (await navigator.clipboard.readText()).trim();
      if (!t) return setupError('Clipboard is empty.');
      $('setup-endpoint').value = t;
      setupError('');
    } catch (_) {
      setupError('Could not read the clipboard. Tap and hold the box above, then Paste.');
    }
  });
  $('setup-connect').addEventListener('click', onConnect);
  $('setup-save').addEventListener('click', onSetupSave);

  // Flush triggers. visibilitychange is the important one on iOS: a home-screen app
  // is resumed rather than reloaded, so 'load' may not fire again for days.
  window.addEventListener('online', flush);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && cfg.ready) { flush(); loadClients(); renderToday(); }
  });
}

async function boot() {
  cfg.load();

  // A setup link carries the endpoint in the hash, which browsers never send to a
  // server — so the URL can be texted around without exposing it in server logs.
  //
  // Decoded repeatedly: mail clients and link-wrappers re-encode URLs, so the hash can
  // arrive double- or triple-encoded (https%253A%252F%252F...). One pass would leave
  // percent-escapes in the middle of the address and it would fail validation.
  state.rawHash = location.hash || '';
  const m = location.hash.match(/setup=([^&]+)/);
  if (m) {
    let v = m[1];
    for (let i = 0; i < 4 && /%[0-9A-Fa-f]{2}/.test(v); i++) {
      let next;
      try { next = decodeURIComponent(v); } catch (_) { break; }
      if (next === v) break;
      v = next;
    }
    $('setup-endpoint').value = v.trim();
    // The hash is deliberately NOT stripped yet. iOS saves whatever URL is showing when
    // "Add to Home Screen" is tapped, and a home-screen app gets its own storage jar — so
    // stripping it here would leave the installed icon pointing at a bare URL with no
    // server address. It is cleared once setup succeeds instead.
  }

  // Local development convenience; the file is gitignored and absent in production.
  // {host} is substituted so the same config works on the dev machine and on a phone
  // reaching the dev server over Wi-Fi, where "localhost" would mean the phone itself.
  if (!cfg.endpoint) {
    try {
      const r = await fetch('dev-config.json', { cache: 'no-store' });
      if (r.ok) {
        const dev = await r.json();
        if (dev.endpoint) $('setup-endpoint').value = dev.endpoint.replace('{host}', location.hostname);
        if (dev.pin) $('setup-pin').value = dev.pin;
      }
    } catch (_) { /* expected in production */ }
  }

  // Already configured, but the address carries no setup hash — either an older build
  // stripped it, or the plain URL was opened. Put it back, so that adding to the home
  // screen at any later moment captures the server address with it.
  if (cfg.endpoint && !/setup=/.test(location.hash)) {
    history.replaceState(null, '', location.pathname + location.search +
      '#setup=' + encodeURIComponent(cfg.endpoint));
  }

  wireEvents();
  $('date').value = todayLocal();

  if (cfg.ready) await startApp();
  else showSetup();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('[gt] sw:', e.message));
  }
}

boot();
