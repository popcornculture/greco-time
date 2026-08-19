# Greco Time — design notes

Living spec. If this file and a memory or summary disagree, this file wins.

Fast time entry for Paul Greco Law from an iPhone: matter type, date, client, decimal
hours, optional description → a Google Sheet shaped like MyCase's time-entry import
template, plus email confirmations.

## Decisions (2026-08-13)

| Question | Decision |
|---|---|
| Native iOS or web? | **Installable web app (PWA).** No Xcode/npm on the dev machine and native needs a $99/yr Apple Developer account. Revisit after seeing this in use. |
| What does `1.5` mean? | **1.5 hours = 90 minutes.** Standard legal decimal hours: 0.1 = 6 min. |
| Description field? | **Present, optional.** Never blocks a save. |
| Who logs time? | **Paul and the paralegal** are the real timekeepers. Alex's entries are test entries and are flagged so they never reach MyCase. |
| Email? | **Both** — a confirmation per flush, plus an end-of-day digest. |
| Backend security? | **One-time PIN per device.** |
| Hosting? | **GitHub Pages** from `docs/` on `popcornculture/greco-time`. Pages only serves from the repo root or `/docs`, which is why the app folder is named `docs/` and not `web/`. |
| Whose Google account? | Built in **`Staff@grecolawgroup.com`** (confirmed 2026-08-13 to be a Workspace account on the firm's domain, so Paul is admin and can recover it), to be **handed to Paul later**. Script is **container-bound** to the Sheet so ownership transfer moves both as one object. |

## Decisions (2026-08-19)

Paul's second round of asks, and what each turned into.

| Ask | Decision |
|---|---|
| "Finalize exporting to MyCase… a few tests of it going all the way" | Menu reworked around a **`Prepare export…` dialog** that runs a preflight, selects the export tab for you, and previews the actual CSV. Plus a **1-row test batch** and an **undo** for a mark. The MyCase upload itself is still a human step — see "What only Paul or Alex can do". |
| Google Calendar suggestions | Server reads the day's events (`CALENDAR_IDS` per timekeeper); phone matches a case out of the title with `names.js` and **prefills the form**. Never files anything by itself. |
| "separate expense entry section" | Not a separate section — **a second kind of bill on the same form** (see below), per Alex's clarification: one bill by the hour, one by expense, description says what it was for. |
| Dark and light mode | **Auto / Light / Dark** switch in the footer, and the dark palette finished. It was previously auto-only, and half the colours were hardcoded light. |

### Expenses are a second bill kind, not a second app

Paul asked for a checkbox; this is a **two-button Time/Expense toggle** instead, for one
reason: it **resets to Time after every save**. A checkbox that stays ticked is how an
hour of work gets filed as $1.00, and that error is invisible until the client's bill goes
out. The toggle also makes the current mode legible at a glance, which a pre-ticked
checkbox does not.

What differs from a time entry:

- **Amount in dollars, rounded to the cent** — `parseAmountInput`, deliberately *not*
  `parseHoursInput`. Snapping to a tenth would turn a $12.35 filing fee into $12.40 and
  the ledger would never reconcile against the receipt.
- **Description is required.** It is the line item the client reads. An expense reading
  only "$450" is unbillable in practice, so it is refused on the phone and on the server.
- **A "do not bill this to the client" checkbox**, which writes `Nonbillable=TRUE`. This is
  the part of Paul's "expenses that aren't just for billing people" that is not a bill.
- **Own tab, own export, own batch** (`Expenses`, `MyCaseExpenseExport`, `_ExpenseBatch`),
  because MyCase imports time and expenses through two different screens.

An entry with **no `kind` at all is time**. Every row written before this change has none,
and so does every entry from a phone still on build 11.

## Architecture

```
iPhone home-screen PWA  ──POST JSON──►  Apps Script Web App  ──►  Google Sheet
(GitHub Pages, static)   (text/plain)    (doPost, PIN-gated)       ├─ TimeEntries
   IndexedDB queue                             │                   ├─ Expenses
   cached client list                          ├──► MailApp        ├─ Clients
   cached calendar day                         │                   ├─ Devices
                                               └──◄ CalendarApp    ├─ MyCaseExport
                                                    (read-only)    ├─ MyCaseExpenseExport
                                                                   ├─ _ExportBatch (hidden)
                                                                   └─ _ExpenseBatch (hidden)
```

```
docs/         index.html app.css names.js app.js sw.js manifest.webmanifest icons/
script/       Config.gs Code.gs Sheet.gs Mail.gs Calendar.gs appsscript.json
tests/        run-tests.js run-gs-tests.js
tools/devrig/ devserver.py harness.html      (the local rig; see Tests)
```

`names.js` holds the pure logic (name parsing, client search, hours parsing) precisely
so it can be tested without a browser. `app.js` holds everything that touches the DOM,
IndexedDB or the network.

## The three things that must not break

1. **Nothing is lost.** A save writes to IndexedDB *before* any network call. Safari has
   **no Background Sync API**, so a queued entry reaches the Sheet only when the app is
   next opened with signal — hence the permanent "N waiting to send" badge. Never let a
   queued entry look filed.
2. **Nothing is double-billed.** Every entry carries a device-minted UUID; the server
   skips UUIDs already present but still reports them accepted, so a retried flush is a
   no-op. Separately, `Exported` + the hidden `_ExportBatch` tab stop the same rows being
   imported into MyCase twice.
3. **The client name written to the Sheet is always the canonical one** from the
   `Clients` tab. The picker may show `Ramirez, Maria`, but `Maria Ramirez` is what gets
   stored, because MyCase matches on its own spelling.

## Why the endpoint is deployed "Anyone"

The app is served from GitHub Pages, a different origin from `script.google.com`. A
Google-auth-gated deployment cannot be called cross-origin, so access control is the
PIN, checked on every request; nothing is returned without it. Bad PINs are counted per
device in `CacheService` and lock out after 10 within the hour. Only the PIN's SHA-256
hash is stored.

Related constraint: Apps Script never answers a CORS preflight `OPTIONS`. Every request
is therefore a **CORS "simple request"** — `Content-Type: text/plain;charset=utf-8`, no
custom headers, JSON in the body, `JSON.parse`d server-side. **Do not add headers to
`api()` in `app.js`**; it would trigger a preflight and every call would start failing.

GitHub Pages on a free account only serves **public** repos, so no secrets are committed.
The endpoint URL and PIN are entered on the device at setup. `docs/dev-config.json`
(gitignored) supplies them during local development.

## The MyCase export

`MYCASE_FIELDS` in `Config.gs` is the single source of truth for the export's columns
and their order.

**Verified against the real template, 2026-08-13:**

```
Case Name,User,Activity,Note,Date,Rate,Rate Type,Hours,Nonbillable
Example Court Case 1,John Doe,Filing Fees,Description about the time entry.,5/6/21,30,Hourly,6,FALSE
```

Two traps in that row:

- **`Nonbillable` is inverted.** Billable time is `FALSE`. Writing `TRUE` imports
  everything as non-billable and Paul bills nothing. A test asserts this literally.
- **`Case Name` matches the MyCase *case*, not the contact.** The `Clients` tab therefore
  holds case names (column A is `CaseName`), and must be seeded from a real MyCase case
  list rather than typed from memory — the strings have to match verbatim.

`Rate` and `Rate Type` are configurable via Script Properties, blank / `Hourly` by
default so MyCase applies the rate already on the case. Dates export as `M/d/yy` to match
the template; Sheets writes the *displayed* value into a CSV, so the number format is the
wire format.

### Case naming is inconsistent (confirmed 2026-08-13)

All three of these shapes coexist in Paul's MyCase, so the matcher handles the mixture:

| Stored in MyCase | Type `aar` / `may` / `peo` and it shows | Files as |
|---|---|---|
| `People vs Aaron` | `People vs Aaron` | verbatim |
| `Richards, Aaron` | `Aaron Richards` | `Richards, Aaron` |
| `abel maya` | `maya, abel` | `abel maya` |

Captions are detected by a **lowercase** ` v. ` / ` vs ` separator and never inverted; an
uppercase `V.` is treated as a middle initial (`John V. Smith` → `Smith, John V.`).
Lowercase names are kept lowercase — the stored string must survive untouched. The display
form may be one MyCase does not literally contain (`Aaron Richards`); the green
"✓ Filing under …" hint always shows the string that will actually be written.

### The export workflow (reworked 2026-08-19)

`Greco Time → Time → MyCase →` (and the same submenu for `Expenses`):

| Item | Does |
|---|---|
| `Prepare export…` | Rebuilds the export tab, **selects it**, and shows a dialog: row count, total, a preflight list, and a preview of the real CSV lines |
| `Prepare a 1-row test import…` | The same, capped at one row — for proving MyCase accepts the template |
| `Mark exported rows as done` | Stamps `Exported=TRUE` on exactly the batch that was prepared |
| `Undo the last “mark exported”` | Puts that batch back to `FALSE` |

Test rows and already-exported rows are excluded from the export.

Three things this fixed, all of them about the one step that is not automatic — a human
downloading a file and uploading it somewhere else:

- **`File → Download` exports whichever sheet is *active*.** Downloading the `Clients` tab
  and feeding it to MyCase produces an error that explains nothing. `Prepare export…` now
  selects the right tab for you.
- **Preflight, before the upload rather than after.** Blank case name, a case name absent
  from the `Clients` tab, a user not in `TIMEKEEPERS`, a non-positive amount, a date that
  is not a real date or is in the future. It **never drops a row** — a row missing from an
  export is a bill that never goes out, which is worse than a visible import error.
- **`Mark exported` is now reversible.** Previously it cleared the batch, so if MyCase
  rejected the file *after* marking, those rows were invisible to every future export and
  simply never got billed. Marking now stamps `MarkedAt` on the batch tab instead of
  erasing it; the next `Prepare export…` clears it, so exactly one batch is ever undoable.

The 1-row test batch deliberately runs on the **normal rails** rather than writing a
throwaway sample tab: the batch tab records that single UUID, so `Mark exported` marks
precisely it and the other pending rows stay pending. A sample built any other way risks a
row that was imported but never marked — which the next export would import again.

### ⚠ The expense template is not verified

The time template was downloaded from MyCase and checked character by character. **The
expense one has not been.** `MYCASE_EXPENSE_FIELDS` in `Config.gs` is the expected shape,
not a confirmed one, and `VERIFIED_EXPENSE_TEMPLATE = false` makes the prepare dialog say
so on screen every time.

To close this: MyCase → `Billing → Expenses → Import Expenses` → download the CSV
template, compare its header row with the dialog's preview.

- Wording differs only → set the `MYCASE_EXPENSE_HEADERS` script property, e.g.
  `{"amount":"Amount","category":"Expense Category"}`. No code change.
- Columns missing, extra, or reordered → edit `MYCASE_EXPENSE_FIELDS`.

Then flip `VERIFIED_EXPENSE_TEMPLATE` to `true` and update the test that asserts it is
false.

## Calendar suggestions

`Calendar.gs` reads one day of events for the current timekeeper and returns them; the
phone does the case matching, because `names.js` already holds tested name logic and
duplicating it server-side would let the two drift.

**Suggestions only.** Tapping one fills the form and stops. A calendar block is evidence
that something was *scheduled* — not that it happened, ran to its booked length, or is
billable to that case. Everything still goes in through the same Save, validation and queue.

Filtered out server-side: all-day events (no duration), anything under 6 minutes, events
the account declined, and titles matching `CALENDAR_IGNORE` (lunch, OOO, PTO, dentist…).

### Whose calendar

Apps Script runs as the account that **deployed** the web app, so it can only read
calendars that account can see. `CALENDAR_IDS` maps a timekeeper to a calendar id and
`DEFAULT_CALENDAR_ID` covers everyone else (`primary` by default). Any other calendar has
to be shared with the executing account at **"See all event details"** — freebusy-only
sharing returns events with no title, which is useless here. A calendar that cannot be
opened comes back as a *note to display*, not an error, so a missing share reads as
"not shared yet" on the phone instead of looking like a broken app.

### Matching a case out of a title

`matchClientInText` is deliberately conservative, in three tiers, and returns **nothing
rather than a guess** — filing time against the wrong client's case bills a stranger *and*
hides the real entry, which is worse than leaving the field empty.

1. A whole name — canonical, `Last, First`, or `First Last` — appearing in the text.
   Longest match wins, so `Richards` beats `Rich`.
2. Failing that, a surname, but only if **exactly one** client matches. Two clients called
   Ramirez means the title does not say which.
3. Failing that, a distinctive token from inside a long case name — this is the tier that
   carries most of the real list, since `Ashford, Daniel PETITION FOR APPOINTMENT OF
   PROBATE CONSERVATOR` parses as one indivisible 60-character surname but its calendar
   entry just says "Ashford". **The ALL-CAPS filing-title words are excluded**, or an event
   called "probate hearing" would match every conservatorship on the books.

Used and dismissed event ids are remembered per date on the device for a week, so a
suggestion acted on does not come back.

## Themes

Three states, and the CSS has to handle all three — including the one the old code could
not do at all, forcing light on a dark phone:

| `data-theme` | Result |
|---|---|
| absent | follow the phone (`prefers-color-scheme`) |
| `light` | force light |
| `dark` | force dark |

Every colour is a token defined once on bare `:root` in its light value; the dark palette
is declared once as `--d-*` and aliased in twice — inside the media query (guarded with
`:not([data-theme="light"])`) and again for `[data-theme="dark"]`. The alias list is
duplicated because CSS cannot combine a media query with a selector; the palette is not,
which is what keeps them in step. **Never give a colour its only definition inside a media
query or a `[data-theme]` block.**

Details worth not undoing:

- The attribute is set by an **inline script in `<head>`**, not from `app.js`. Read it any
  later and a dark-forced phone flashes a full white screen on every launch.
- Stored under its own key, `gt.theme`, so **"Reset this device" does not undo it**.
- `color-scheme` is set alongside, so the browser paints its own furniture — controls,
  scrollbars, the keyboard — to match. A token swap alone cannot do that.
- `<meta name="theme-color">` is updated in JS, because the iOS status bar is painted from
  it and a stale value leaves a navy bar above a dark page.
- Toasts have their own `--toast-*-bg/fg` pair. Reusing `--err-ink` as a background
  inverted the pill in dark mode into pale pink, which reads as a highlight, not a problem.

`MatterType` (Criminal/Civil/Family/**Conservatorship**) lives in the internal block only — it may
or may not map to a MyCase column once the real template is known.

## The form

```
FROM YOUR CALENDAR                                  [Hide]
 9:00 AM · 1.3  Hearing re Maria Ramirez               ×
                Maria Ramirez
11:00 AM · 0.5  Call w/ DA                             ×
                no case matched — pick one
What are you billing
┌──────────────────┬──────────────────┐
│       Time       │     Expense      │
└──────────────────┴──────────────────┘
Matter                                    Date  [ 8/19/2026 ]
┌──────────────────┬──────────────────┐
│     Criminal     │      Civil       │
├──────────────────┼──────────────────┤
│      Family      │ Conservatorship  │
└──────────────────┴──────────────────┘
Client/Case                              ☐ new client
[                                                        ]
Time                          1.5 hrs · 90 min · 15×6min
[                      1.5                               ]
[0.1] [0.2] [0.3] [0.5] [1.0]
Description — optional
[                                                        ]
[                    Save entry                          ]
Today                              2.4 hrs · $435.50
[Auto][Light][Dark]              Reset this device
```

In **Expense** mode the Time block is replaced, and cleared, by:

```
Amount                                            $435.50
[  $                  435.50                             ]
☐ do not bill this to the client
Description — what it was for
[                                                        ]
[                   Save expense                         ]
```

Decisions behind it, so they don't get "tidied" away:

- **Conservatorship is a fourth button** — 71 of 260 open cases, the largest single
  practice area, and it fits none of the other three. Four buttons across a row shared with
  the date field would give each ~52px on a 390px phone, nowhere near enough for a
  15-character label, so they sit in a **2×2 grid** and Date moved up beside the label to
  keep it at the top of the form as specified. Verified to fit down to 320px.
- **The field is labelled "Client/Case"**, because the value must be MyCase's Case Name,
  which is sometimes a person and sometimes a caption.
- **No match highlighting** in the suggestion list — removed at Alex's request.
- **Suggestions are clamped to two lines** with the full name as the tooltip. 93 of 260 real
  case names exceed 40 characters and the longest is 150, because MyCase names embed filing
  titles; unclamped, three suggestions would push Save off screen.
- **Over 8 hours on one entry needs a second tap** ("Tap again to confirm 15.0 hrs"), since
  typing `15` for `1.5` is the likeliest data-entry error. Deliberately not a `confirm()`
  dialog. The same guard applies **over $1,000** on an expense, for a missing decimal point.
- **The unused amount/hours field is cleared, not just hidden**, when the kind changes.
  Carrying a stale `1.5` into an expense save is the exact confusion the toggle exists to
  prevent.
- **`setMatter` is scoped to `.seg[data-matter]`.** The Time/Expense buttons share the
  `.seg` look, and an unscoped `.seg` there silently unchecked them every time a matter
  type was picked.
- **Today's list with a running total** sits under the form, so a bad entry is obvious
  immediately rather than at 6pm when the digest lands.

## Autocomplete rules

- Fires at 2 characters, at most 3 suggestions.
- Surname prefix → offered as `Ramirez, Maria`. Given-name prefix → `Maria Ramirez`.
  Other token, or a substring, → offered canonically. Surnames rank above given names.
- Compound queries (`ramirez, m`, `maria r`) are prefix-tested against both forms.
- Organisations (`LLC`, `Inc`, `Trust`, `Estate`, `County of…`, etc.) are never inverted.
- Generational suffixes are kept off the surname: `John Smith Jr.` → `Smith, John Jr.`
- Free text that exactly matches a known client (in either form) resolves to canonical.
  Anything else is refused unless **new client** is ticked — a name MyCase does not
  recognise fails the import.
- **new client** ticked → free text accepted and appended to the `Clients` tab, so the
  list grows itself without re-exporting from MyCase.
- A client with a `DefaultMatterType` pre-selects the matter type.

## Mail quota

`MailApp` allows 1,500 recipients/day on Google Workspace but only 100/day on a consumer
Gmail account. Per-save mail is collapsed to one message per flush batch, and test entries
never generate mail.

**Resolved 2026-08-13:** `grecolawgroup.com` is Google Workspace, so the 1,500/day ceiling
applies and per-save mail stays enabled (`SEND_PER_ENTRY` unset). At ~20 entries/day × 2
recipients this uses well under 5% of the quota.

Note that Apps Script sends *as the account that deployed the web app*. During the staff
phase, confirmations originate from `Staff@grecolawgroup.com` and count against that
account's quota, not Paul's.

## Script Properties

| Key | Purpose |
|---|---|
| `PIN_HASH` | SHA-256 of the device PIN. Set via *Greco Time → Set PIN…*, not by hand. |
| `SHEET_ID` | Target spreadsheet. Optional if the script is container-bound. |
| `TIMEKEEPERS` | JSON: `[{"name":"Paul Greco","isTest":false},{"name":"Staff","isTest":false},{"name":"Alex (testing)","isTest":true}]` — names must match MyCase exactly. |
| `NOTIFY_ENTRY` | Recipients for per-save confirmations. |
| `NOTIFY_DIGEST` | Recipients for the end-of-day digest. |
| `SEND_PER_ENTRY` | `false` disables per-save mail. |
| `PWA_URL` | Where the app is hosted; only used to print the setup link. |
| `EXEC_URL` | The deployed `/exec` URL, used verbatim for the setup link. Required — see `SETUP.md`. |
| `CALENDAR_IDS` | JSON: `{"Paul Greco":"paul@grecolawgroup.com"}`. Unlisted names fall back to `DEFAULT_CALENDAR_ID`. |
| `DEFAULT_CALENDAR_ID` | Calendar for anyone unlisted. `primary` (the executing account) by default. |
| `CALENDAR_IGNORE` | Comma-separated substrings never suggested. **Replaces** the built-in list. |
| `MYCASE_EXPENSE_HEADERS` | JSON per-key header override for the expense export, e.g. `{"amount":"Cost"}`. |
| `DEFAULT_EXPENSE_TYPE` | Optional MyCase expense-picklist value; blank by default. |

## Deploy

Step-by-step instructions live in **`SETUP.md`**. Summary of the approach and why:

- **No `clasp`.** It needs npm, which is absent on this machine. The four `script/` files
  are pasted into the Apps Script editor in the browser instead.
- **Container-bound, not standalone.** Created via *Extensions → Apps Script* from inside
  the Sheet. This is what makes the `Greco Time` menu possible (`onOpen` only fires for
  bound scripts) and means transferring the Sheet carries the script with it.
- `setupSheet()` once to create the tabs; `installDigestTrigger()` once for the 6pm digest.
- Deploy → Web app, **Execute as** the owning account, **Who has access: Anyone**
  (see "Why the endpoint is deployed Anyone" above).
- Per phone: *Greco Time → Show phone setup link* → Safari → type PIN → pick timekeeper →
  **Share → Add to Home Screen**.

Bump `CACHE` in `sw.js` whenever the shell changes, or phones will keep serving the old
version from cache.

### Handing over to Paul later

Transfers with the Sheet automatically: the data, the bound script, and all Script
Properties (PIN hash, roster, recipients).

Paul must redo, once: **authorize** the script, **redeploy** the web app (deployments are
bound to the deploying account, and the script executes as that account), and re-run
**`installDigestTrigger()`** — triggers are per-user and do not transfer.

If his redeploy yields a new `/exec` URL, every phone needs the setup link again; the menu
prints the current one.

## Tests

No npm, so tests run under macOS's built-in JavaScriptCore:

```sh
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc
$JSC docs/names.js tests/run-tests.js                                    # 144 assertions
$JSC script/*.gs tests/run-gs-tests.js                                   # 145 assertions
```

Local rig (mock backend on a *different port*, so the cross-origin path is genuinely
exercised rather than hidden by same-origin). **Now committed** as `tools/devrig/` — the
previous copy lived in a scratch directory and was lost:

```sh
python3 tools/devrig/devserver.py
#   http://localhost:8765/              the app
#   http://localhost:8765/harness.html  side-by-side 390px / 320px iframes
#   http://localhost:8766/exec          mock endpoint, PIN 1234
#   http://localhost:8766/_fail?on      make the network fail, to test the queue
#   http://localhost:8766/_dump         what the "sheet" received
#   http://localhost:8766/_reset        empty the "sheet"
```

Point `docs/dev-config.json` (gitignored) at it:
`{"endpoint": "http://{host}:8766/exec", "pin": "1234"}`

Two traps when using the rig:

- **Unregister the service worker first**, or you will spend an hour debugging a revision
  of `app.js` you already fixed. `sw.js` is stale-while-revalidate, so a reload serves the
  *previous* copy and fetches the current one for next time. This cost real time on
  2026-08-19.
- Chrome on this machine will not resize below ~600px, hence the iframe harness; set
  `scrollBehavior='auto'` per frame or `scrollTo` silently no-ops in a backgrounded tab.
  Both frames share one `localStorage`, so the theme buttons fight over `gt.theme`; the
  rendering is still per-frame and correct.

`isDevEndpoint()` in `app.js` exists for this rig. The production check demands an
`https://script.google.com/…/exec` URL, which `http://localhost:8766/exec` can never
satisfy, so **setup itself was untestable locally**. The exception is narrow — loopback and
the private ranges only — so a mistyped or hostile public address still gets refused.

### Verified in the rig, 2026-08-19

Driven through Chrome against `tools/devrig/`, at 390px and 320px:

- First run on a virgin device: setup link → connect → timekeeper → app, `TEST` tag for
  Alex, Auto theme selected, empty Today.
- Calendar suggestions render and match: full name, a case named only in the *location*,
  a filing-title name via the token tier, and "Call w/ DA" correctly matching **nothing**.
- Applying a suggestion prefills client/hours/description/matter and removes the row; it
  does not come back after a reload.
- Expense mode: `$` inside the field, amount readout, do-not-bill box, description
  required, two-tap guard over $1,000, guard clears on edit, resets to Time after save.
- Mixed Today total renders as `1.8 hrs · $435.50`; money shown in green.
- **Queue**: network down → 3 entries (2 time, 1 expense) queued with the badge → network
  up → flush → **flushed twice** and the sheet still holds exactly 3 rows.
- Wire shape confirmed: `kind`, `amount`, `nonbillable` on expenses; `hours` on time; the
  two land in separate buckets.
- Themes: forced light on a dark browser and forced dark both correct, including the error
  box, pending badge, all three toasts, the select chevron and `color-scheme`. No
  horizontal overflow at 320px; the footer wraps cleanly.

### Still to verify — needs a real device or real MyCase

Nothing in the rig can stand in for these:

- Install to home screen; confirm it launches fullscreen with no browser chrome.
- Airplane mode on an actual iPhone → log 3 → reopen with signal → all 3 land **once**.
  Force-quit mid-flush and reopen → still once.
- **A real MyCase import.** Use `Prepare a 1-row test import…` for time. Nothing else
  proves the template match, and the *expense* template is still unverified (see above).
- Calendar sharing: confirm Paul's calendar is shared with the executing account at "See
  all event details", and that `CALENDAR_IDS` names it.
