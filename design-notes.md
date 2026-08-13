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

## Architecture

```
iPhone home-screen PWA  ──POST JSON──►  Apps Script Web App  ──►  Google Sheet
(GitHub Pages, static)   (text/plain)    (doPost, PIN-gated)       ├─ TimeEntries
   IndexedDB queue                             │                   ├─ Clients
   cached client list                          └──► MailApp        ├─ Devices
                                                                   ├─ MyCaseExport
                                                                   └─ _ExportBatch (hidden)
```

```
docs/      index.html app.css names.js app.js sw.js manifest.webmanifest icons/
script/    Config.gs Code.gs Sheet.gs Mail.gs appsscript.json     (clasp project)
tests/     run-tests.js run-gs-tests.js
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

Workflow: `Greco Time → Rebuild MyCase export` → `File → Download → CSV` → upload in
MyCase → `Greco Time → Mark exported rows as done`. Test rows and already-exported rows
are excluded from the export.

`MatterType` (Criminal/Civil/Family/**Conservatorship**) lives in the internal block only — it may
or may not map to a MyCase column once the real template is known.

## The form

```
Matter                                    Date  [ 8/13/2026 ]
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
Today                                            2.4 hrs
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
  dialog.
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
$JSC docs/names.js tests/run-tests.js                                    # 66 assertions
$JSC script/*.gs tests/run-gs-tests.js                                  # 51 assertions
```

Local rig (mock backend on a *different port*, so the cross-origin path is genuinely
exercised rather than hidden by same-origin):

```sh
python3 <scratchpad>/devserver.py
#   http://localhost:8765/            the app
#   http://localhost:8765/harness.html  side-by-side 390px / 320px iframes
#   http://localhost:8766/exec        mock endpoint, PIN 1234
#   http://localhost:8766/_fail?on    make the network fail, to test the queue
#   http://localhost:8766/_dump       what the "sheet" received
```

Chrome on this machine will not resize below ~600px, hence the iframe harness; set
`scrollBehavior='auto'` per frame or `scrollTo` silently no-ops in a backgrounded tab.

### Still to verify on a real device

Not yet done — needs an iPhone (or a connected Chrome extension):

- Install to home screen; confirm it launches fullscreen with no browser chrome.
- Airplane mode → log 3 entries → confirm the app still launches and the badge reads 3.
- Restore signal, reopen → all 3 land **once**. Force-quit mid-flush and reopen → still once.
- A real MyCase import of one test entry, to prove the column headers are accepted.
  Nothing else proves the template match.
