/**
 * Greco Time — calendar suggestions.
 *
 * The day's appointments are the best available record of where the time went, and they
 * are already typed. This reads them and hands them to the phone as *suggestions*; the
 * phone never files one automatically. Every suggestion is reviewed and saved by hand,
 * because a calendar block is evidence that something was scheduled, not evidence that
 * it happened, ran to length, or is billable to that case.
 *
 * ── Whose calendar ──────────────────────────────────────────────────────────────
 *
 * Apps Script runs as the account that deployed the web app (Staff@grecolawgroup.com
 * during the staff phase, Paul's account after the handover), so it can only read
 * calendars that account can see. Any other calendar must be shared with it, with at
 * least "See all event details" — freebusy-only sharing yields events with no title,
 * which is useless here.
 *
 *   CALENDAR_IDS         {"Paul Greco":"paul@grecolawgroup.com"} — per timekeeper.
 *   DEFAULT_CALENDAR_ID  used for anyone not listed; "primary" by default.
 *
 * A calendar that cannot be opened is reported as a plain message rather than an error,
 * so a sharing problem shows up on the phone as "calendar not shared yet" instead of a
 * failed save.
 */

/* Blocks that are never billable time. Substring match, case-insensitive. Overridable
 * with CALENDAR_IGNORE, which replaces this list rather than adding to it. */
var CALENDAR_IGNORE_DEFAULT = ['lunch', 'holiday', 'ooo', 'out of office', 'pto', 'vacation',
  'birthday', 'dentist', 'doctor', 'gym', 'personal', 'busy', 'do not schedule', 'block'];

/** Shortest event worth offering: one billing unit. */
var CALENDAR_MIN_MINUTES = 6;

function calendarIgnoreList() {
  var raw = prop('CALENDAR_IGNORE', '');
  if (!raw) return CALENDAR_IGNORE_DEFAULT;
  return raw.split(',').map(function (s) { return s.trim().toLowerCase(); })
    .filter(function (s) { return s; });
}

/** The calendar id to read for a given timekeeper. */
function calendarIdFor(timekeeper) {
  var map = {};
  try { map = JSON.parse(prop('CALENDAR_IDS', '{}')) || {}; } catch (err) { map = {}; }
  var id = map[String(timekeeper || '')];
  return String(id || prop('DEFAULT_CALENDAR_ID', 'primary')).trim();
}

function openCalendar(id) {
  if (!id || id === 'primary') return CalendarApp.getDefaultCalendar();
  return CalendarApp.getCalendarById(id);
}

function shouldIgnoreEvent(title, ignore) {
  var t = String(title || '').toLowerCase();
  if (!t) return true;
  for (var i = 0; i < ignore.length; i++) {
    if (t.indexOf(ignore[i]) !== -1) return true;
  }
  return false;
}

/**
 * Did the executing account decline this event? A declined meeting did not happen, so
 * offering it as billable time invites a bill for a hearing nobody attended.
 */
function isDeclined(event) {
  try {
    return event.getMyStatus() === CalendarApp.GuestStatus.NO;
  } catch (err) {
    // Events on a calendar the account merely reads have no "my status" at all.
    return false;
  }
}

/**
 * Suggestions for one day.
 *
 * Payload: { date: 'YYYY-MM-DD', timekeeper: 'Paul Greco' }
 * Returns { ok: true, events: [...] } or { ok: true, events: [], note: '…' }.
 *
 * The note path matters: a missing calendar share is a configuration problem the person
 * holding the phone can act on, so it comes back as text to display rather than as a
 * failure that looks like the app being broken.
 */
function calendarSuggestions(payload) {
  var iso = String(payload.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return { ok: true, events: [], note: 'Bad date.' };

  var id = calendarIdFor(payload.timekeeper);
  var cal;
  try {
    cal = openCalendar(id);
  } catch (err) {
    console.error('calendar open failed for "' + id + '": ' + err);
    return { ok: true, events: [], note: 'Could not open the calendar “' + id + '”.' };
  }
  if (!cal) {
    return { ok: true, events: [], note: 'The calendar “' + id + '” is not shared with this ' +
      'account yet, so there is nothing to read.' };
  }

  var day = toSheetDate(iso);                       // local midnight; see Config.gs
  var next = new Date(day.getTime() + 864e5);
  var ignore = calendarIgnoreList();
  var out = [];

  cal.getEvents(day, next).forEach(function (ev) {
    var title = ev.getTitle();
    if (ev.isAllDayEvent()) return;                 // no duration to bill
    if (shouldIgnoreEvent(title, ignore)) return;
    if (isDeclined(ev)) return;

    var mins = Math.round((ev.getEndTime().getTime() - ev.getStartTime().getTime()) / 60000);
    if (mins < CALENDAR_MIN_MINUTES) return;

    var tz = Session.getScriptTimeZone();
    out.push({
      id: ev.getId(),
      title: title,
      // Rounded to the tenth of an hour the office actually bills in.
      hours: Math.round((mins / 60) * 10) / 10,
      minutes: mins,
      start: Utilities.formatDate(ev.getStartTime(), tz, 'h:mm a'),
      end: Utilities.formatDate(ev.getEndTime(), tz, 'h:mm a'),
      // Sorted on separately: "10:00 AM" sorts before "9:00 AM" as a string.
      startMs: ev.getStartTime().getTime(),
      location: ev.getLocation() || '',
    });
  });

  out.sort(function (a, b) { return a.startMs - b.startMs; });
  return { ok: true, events: out, calendarId: id };
}
