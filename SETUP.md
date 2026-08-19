# Greco Time — setup

Do this once, signed in as **`Staff@grecolawgroup.com`**. Roughly 20 minutes.

Part A puts the app on the web. Part B builds the backend. Part C installs it on phones.
Do them in order — Part C needs a URL from A and a URL from B.

---

## Part A — Put the app online (GitHub Pages)

Free, permanent HTTPS. Needed for two things the LAN preview could not do: offline entry
and a proper fullscreen home-screen app.

**A1.** Go to <https://github.com/new> and create a repository:

- Name: **`greco-time`**
- **Public** — GitHub Pages only serves private repos on a paid plan.
- Do **not** add a README, .gitignore, or licence. The repo must start empty.

**A2.** Back in the terminal:

```sh
cd ~/projects/greco-time
git remote add origin https://github.com/popcornculture/greco-time.git
git branch -M main
git push -u origin main
```

Git will ask for credentials. **Your GitHub password will not work** — HTTPS pushes need a
personal access token. Create one at <https://github.com/settings/tokens> → *Generate new
token (classic)* → tick **`repo`** → copy it, and paste it as the *password* (username is
`popcornculture`).

**A3.** In the repo: **Settings → Pages**. Under *Build and deployment*, set
Source = **Deploy from a branch**, Branch = **`main`**, Folder = **`/docs`**, then **Save**.

Wait 1–2 minutes. Your URL is:

```
https://popcornculture.github.io/greco-time/
```

Open it. You should see the setup screen asking for a server address — that is correct, it
has no backend yet. Part B provides it.

---

## Part B — Build the backend (Sheet + Apps Script)

**B1.** At <https://sheets.new> create a spreadsheet and name it **`Greco Time`**.

**B2.** In that Sheet: **Extensions → Apps Script**.

> This *will* open `script.google.com` — that is the Apps Script editor and it is the right
> place. What matters is how you got there. Opening it via **Extensions → Apps Script from
> inside the Sheet** creates a script *bound* to that Sheet. Starting instead from
> script.google.com and clicking **New project** creates a standalone script, which cannot
> add the `Greco Time` menu and would have to be transferred to Paul separately.
>
> Quick check you did it right: the editor's **Overview** page shows the Sheet as the
> container, and back in the Sheet a `Greco Time` menu appears once you reload (step B7).

**B3.** Name the project **Greco Time**, then create the four files.

Apps Script has **no import and no drag-and-drop** — code has to be pasted as text. The
`.gs` files on your Mac also have no default app, so double-clicking them does nothing.
Easiest route is to copy each one straight to the clipboard:

```sh
pbcopy < ~/projects/greco-time/script/Code.gs      # then paste, then repeat per file
pbcopy < ~/projects/greco-time/script/Config.gs
pbcopy < ~/projects/greco-time/script/Sheet.gs
pbcopy < ~/projects/greco-time/script/Mail.gs
```

Or, if you'd rather not use the terminal, open the repo on GitHub and use the **copy raw
file** button on each:
<https://github.com/popcornculture/greco-time/tree/main/script>

In the editor:

1. `Code.gs` already exists holding a stub `myFunction()`. Click it, select all (⌘A),
   paste **Code.gs** over it.
2. For each of the other three: **+** next to *Files* → **Script** → name it `Config`,
   `Sheet`, `Mail` — **no `.gs` extension**, Apps Script adds that — then select all and
   paste the matching file.
3. Save (⌘S).

You should end with exactly four files: `Code.gs`, `Config.gs`, `Sheet.gs`, `Mail.gs`.
Order in the list doesn't matter; Apps Script loads them all.

**B4.** Replace the manifest. `appsscript.json` already exists but is **hidden by
default** — you are editing it, not adding it:

1. Click the **gear (Project Settings)** in the left sidebar.
2. Tick **"Show `appsscript.json` manifest file in editor"**.
3. Back in the **Editor**, `appsscript.json` now appears in the file list. Open it, select
   all, and replace with the contents of `script/appsscript.json`. Save.

Do not skip this. It carries three things that break in non-obvious ways if wrong:

- **`timeZone: America/Los_Angeles`** — without it the project may sit in UTC, which files
  late-afternoon entries under tomorrow's date and fires the 6pm digest at the wrong hour.
- **`oauthScopes`** — determines what the one-time authorization prompt grants. Notably it
  includes `script.container.ui`, which the `Greco Time` menu's dialogs need; miss it and
  **Set PIN…** fails. It deliberately does *not* request `script.external_request`, because
  the script makes no outbound calls and shouldn't ask for permission it doesn't use.
- **`oauthScopes` includes `calendar.readonly`** — new as of build 12, for the entry
  suggestions. If you are updating an existing project rather than building a fresh one,
  adding this scope means Google will prompt for authorization **again** on the next run;
  that is expected, and until you accept it the calendar panel simply stays hidden.
- **`runtimeVersion: V8`** — the code assumes the modern runtime.

**B5.** Create the tabs. In the toolbar function dropdown pick **`setupSheet`** → **Run**.

Google will interrupt with an authorization prompt — this is the one-time click that cannot
be automated. **Review permissions → choose the Staff account → Advanced → Go to Greco Time
(unsafe) → Allow.** "Unsafe" here only means the script is not Google-verified; it is your
own code.

Check the Sheet: it should now have `TimeEntries`, `Expenses`, `Clients`, `Devices`,
`MyCaseExport` and `MyCaseExpenseExport` tabs. Two more, `_ExportBatch` and
`_ExpenseBatch`, are created hidden — they track which rows went into the last export.

**B6.** Set the configuration. **Project Settings → Script Properties → Add script property**,
once per row:

| Property | Value |
|---|---|
| `TIMEKEEPERS` | `[{"name":"Paul Greco","isTest":false},{"name":"Paralegal Staff","isTest":false},{"name":"Alex (testing)","isTest":true}]` |
| `NOTIFY_ENTRY` | `Paul@grecolawgroup.com,Staff@grecolawgroup.com` |
| `NOTIFY_DIGEST` | `Paul@grecolawgroup.com` |
| `PWA_URL` | `https://popcornculture.github.io/greco-time/` |

The `TIMEKEEPERS` names above are MyCase's exact user names (`Paul Greco`,
`Paralegal Staff`, confirmed 2026-08-13) — the import matches on that literal string, so
do not tidy them up.

Leave these unset unless you have a reason: `SHEET_ID` (the bound script finds its own
Sheet), `SEND_PER_ENTRY` (defaults on, correct for Workspace), `DEFAULT_RATE` (blank makes
MyCase use the rate already on the case, which is what you want), `RATE_TYPE` (defaults to
`Hourly`), `DEFAULT_ACTIVITY` (blank), `DEFAULT_EXPENSE_TYPE` (blank),
`MYCASE_EXPENSE_HEADERS` (see B6b), `CALENDAR_IGNORE` (a sensible default list is built in).

### B6a — Calendar suggestions (optional, but this is the ask)

The app can offer the day's appointments as ready-made entries. Two things make it work.

**1. Share the calendar with the account running the script.** Apps Script executes as
whichever account deployed the web app — `Staff@grecolawgroup.com` during the staff phase —
so it can only read calendars that account can see. Paul's own calendar has to be shared
with it:

> In **Paul's** Google Calendar → hover his calendar in the left sidebar → ⋮ →
> **Settings and sharing** → *Share with specific people or groups* → **Add people** →
> `Staff@grecolawgroup.com` → permission **"See all event details"** → Send.
>
> "See only free/busy" is **not** enough. It returns events with no titles, and the title is
> the entire point — it is what the case name is matched from and what becomes the
> description.

**2. Point each timekeeper at their calendar** with one more script property:

| Property | Value |
|---|---|
| `CALENDAR_IDS` | `{"Paul Greco":"Paul@grecolawgroup.com"}` |

Anyone not listed falls back to `DEFAULT_CALENDAR_ID`, which defaults to `primary` — the
executing account's own calendar. So if the whole office works out of one shared calendar,
set `DEFAULT_CALENDAR_ID` to it and skip `CALENDAR_IDS` entirely.

Nothing breaks if you skip this step: an unreadable calendar makes the phone show a short
"not shared yet" note and nothing else. Time entry is unaffected.

### B6b — Before the first *expense* import

The time template was verified against MyCase's real file. **The expense one has not been**,
so do this once before trusting it:

1. In MyCase: **Billing → Expenses → Import Expenses → download the CSV template**.
2. In the Sheet: **Greco Time → Expenses → MyCase → Prepare export…**. The dialog shows the
   header row the export will produce.
3. Compare them.
   - Only the wording differs → add a script property `MYCASE_EXPENSE_HEADERS`, e.g.
     `{"amount":"Cost","category":"Expense Category"}`. No code change.
   - Columns missing, extra, or in a different order → edit `MYCASE_EXPENSE_FIELDS` in
     `Config.gs`.
4. Once it matches, set `VERIFIED_EXPENSE_TEMPLATE = true` in `Config.gs` and the warning in
   the dialog goes away.

**B7.** Set the PIN. Reload the **Sheet** tab — a **Greco Time** menu appears in the menu
bar. Choose **Greco Time → Set PIN…**, type a PIN of at least 4 characters, OK.

Pick something short — it gets typed once per phone. Only its SHA-256 hash is stored, so
write the PIN down somewhere; it cannot be read back out.

**B8.** Install the digest trigger. In the Apps Script editor, select
**`installDigestTrigger`** → **Run**. That schedules the 6pm summary.

**B9.** Deploy the web app. **Deploy → New deployment → gear → Web app**:

- Description: `v1`
- **Execute as: Me** (`Staff@grecolawgroup.com`)
- **Who has access: Anyone**

Then **Deploy** and **copy the Web app URL** — it ends in `/exec`.

**B9a. Paste that URL into an `EXEC_URL` script property. This is required, not optional.**

⚙ Project Settings → Script Properties → `EXEC_URL` → paste → **click "Save script
properties"** (the row looks filled in before you click; nothing is stored until you do).

`ScriptApp.getService().getUrl()` cannot be trusted: on this project it reported a
deployment that returns **404**, so every setup link pointed at a dead endpoint. A 404
carries no CORS header, so Safari reported it as a bare "Load failed" and the real cause
stayed hidden for an hour. `EXEC_URL` takes priority over that API entirely.

Sanity-check before sending anything to a phone: **Greco Time → Show phone setup link**
and confirm the deployment id in it matches the URL you just copied. You can read that on
a laptop; no phone required.

**If you ever redeploy, update `EXEC_URL`** — it now wins over everything else, so a stale
value sends every phone to a dead endpoint.

> **"Anyone" is required, not a mistake.** The phone app is served from
> `github.io`, a different origin, and a Google-login-gated deployment cannot be called
> cross-origin. The PIN is the access control; the endpoint returns nothing without it.
> Opening the `/exec` URL in a browser deliberately shows only "POST requests only".

---

## Part C — Install on the phones

**C1.** In the Sheet: **Greco Time → Show phone setup link**. It prints a link combining
the Pages URL with the `/exec` endpoint.

**C2.** Send that link to the phone (text or email). On the phone:

1. Open it **in Safari** (not Chrome — only Safari can add a real home-screen app on iOS).
2. Type the PIN → **Connect**.
3. Choose who is using this phone → **Start using Greco Time**.
4. **Share → Add to Home Screen → Add.**

Launch it from the home screen icon. No address bar means it installed correctly.

**C3.** Repeat for each phone, choosing the right person each time. Use **Alex (testing)**
on your own phone — those entries get flagged and are excluded from the MyCase export and
the digest.

---

## Verify it end to end

1. Log an entry on the phone. Within a few seconds it should appear as a row on
   `TimeEntries`, and a confirmation email should arrive.
2. **Offline test — the important one.** Turn on airplane mode. Log two entries. They save,
   and a **"2 waiting to send"** badge appears. Turn airplane mode off and reopen the app —
   both rows land, exactly once. Then force-quit the app mid-sync and reopen it, and confirm
   still no duplicates.
3. Log an **expense** too: tap **Expense**, enter an amount, describe what it was for. It
   should land on the `Expenses` tab, not `TimeEntries`.
4. **Greco Time → Send today's digest now** to check the digest formatting. With both kinds
   logged it should show a `TIME` block, an `EXPENSES` block, and a combined total.

### 5. The MyCase import, which nothing else can prove

Do this with **one row first**. The menu has a purpose-built item for it:

1. **Greco Time → Time → MyCase → Prepare a 1-row test import…**
2. The dialog opens, the `MyCaseExport` tab is already selected, and it shows you the exact
   CSV line MyCase will read. Read the preflight warnings if there are any.
3. **File → Download → Comma-separated values (.csv)**
4. In MyCase: **Billing → Time Entries → Import Time Entries**, upload it.
5. Confirm MyCase reports **1** row imported, and that the entry looks right on the case —
   right client, right hours, and **billable**.
6. Back in the Sheet: **Greco Time → Time → MyCase → Mark exported rows as done**.

> The headers match MyCase's real template exactly (verified 2026-08-13):
> `Case Name,User,Activity,Note,Date,Rate,Rate Type,Hours,Nonbillable`
>
> Three things only a real import can settle: whether a blank `Rate` is accepted, whether a
> blank `Activity` is accepted, and whether your **Case Name** values match MyCase's cases.

Then repeat the whole thing for **Expenses → MyCase** — and read **B6b** first, because
those headers are not confirmed yet.

**If MyCase rejects the file**, or you marked it exported and then discovered the import
failed: **Undo the last “mark exported”**. Without that the rows stay flagged as exported,
never appear in another export, and are never billed. Only the most recent batch can be
undone, and preparing a new export clears it.

**Never run "Mark exported" on a batch MyCase did not accept**, and never import the same
file twice — that is the one path to double-billing a client.

---

## Day-to-day

- Log time on the phone. That is the whole job.
- New client? Tick **new client** and type the name; it joins the list for next time.
- Push time to MyCase: **Greco Time → Time → MyCase → Prepare export…**, follow the four
  steps in the dialog. Expenses are the same, under **Expenses → MyCase**.
- Logging an expense instead of time: tap **Expense** on the phone, enter the dollar
  amount, and say in the description what it was for — that text goes on the client's bill.
### Seeding the case list (do this early)

Column A of the `Clients` tab must hold **MyCase case names, spelled exactly as MyCase
spells them** — that is what the import matches on. Case naming at the firm is
inconsistent (`People vs Aaron`, `Richards, Aaron`, `abel maya` all exist), which is fine;
the autocomplete copes with the mixture. What is *not* fine is retyping them from memory,
because a near-miss fails the import.

So export the case list and let the helper script format it:

```sh
# Settings -> Import/Export -> export Cases  (downloads a folder containing cases.csv)
python3 tools/cases-to-clients.py ~/Downloads/mycase-cases-*/cases.csv
```

It writes `clients-tab.tsv` next to the input: two tab-separated columns, sorted, closed
cases dropped, matter button pre-filled from each case's Practice Area. Open the `Clients`
tab, click **A2**, paste.

Keep that file out of the repo — it is the firm's live case list and the repo is public.

Re-run it monthly or so. Cases added on a phone via the **new client** checkbox append
themselves, so this is only for bulk refreshes.

**Practice Area → matter button** (decided against the real 260 open cases):

| Button | Practice areas | Cases |
|---|---|---|
| Criminal | Criminal Defense, SLO Defender, MH Slo Defender, PD, DUI/DWI, DV | 87 |
| Conservatorship | Conservatorship SLO | 71 |
| Civil | Civil, Bankruptcy, Intellectual Property, Immigration | 50 |
| Family | Family, Divorce/Separation, CWS | 39 |
| *(none — tap it)* | cases with no practice area set in MyCase | 13 |

The mapping lives in `PRACTICE_AREA_TO_MATTER` in that script. Add new practice areas
there as MyCase gains them; anything unmapped simply doesn't pre-fill a button, which is
the safe failure.

## If something breaks

| Symptom | Cause |
|---|---|
| **"Reached … but the browser refused to read the reply (CORS)"** | The endpoint returns something without CORS headers — usually a **404 from a dead deployment**. Compare the id in the setup link against *Deploy → Manage deployments* and fix `EXEC_URL`. This was the real failure during setup. |
| **"Could not reach … at all"** | The request never left the phone: content blocker, VPN, or iCloud Private Relay. |
| **"That address does not look right"** | The endpoint is not a `/exec` URL. Both `…/macros/s/<id>/exec` and the Workspace form `…/a/<domain>/macros/s/<id>/exec` are valid. |
| Phone shows an old build number | Cached. Delete the home-screen icon, then Settings → Safari → Advanced → Website Data → delete the site. The build stamp on the setup screen tells you what it is actually running. |
| Setup says "Check the Web App is deployed with access set to Anyone" | B9 was saved with a different access setting. Redeploy. |
| "Wrong PIN" on every phone | `PIN_HASH` unset, or the PIN was changed after the phones were set up. |
| An entry shows **refused** | Its timekeeper is not in `TIMEKEEPERS`. Fix the roster; tap the badge to retry. |
| Badge count never clears | The phone has no signal, or the `/exec` URL changed. |
| Phones show an old version after an update | Bump `CACHE` in `docs/sw.js` and push. |
| No emails | Check `NOTIFY_ENTRY` / `NOTIFY_DIGEST` spelling. |

## Handing over to Paul

Transfers automatically with the Sheet's ownership: the data, the bound script, and the
Script Properties.

Paul redoes once: **authorize** the script, **redeploy** the web app (deployments belong to
the account that made them), and re-run **`installDigestTrigger()`** — triggers are
per-user. If his redeploy produces a new `/exec` URL, resend the setup link to each phone.

Calendar suggestions also need one adjustment at handover: the script will then execute as
Paul's account, so his own calendar becomes `primary` and the share to
`Staff@grecolawgroup.com` is no longer what is being read. Either drop `CALENDAR_IDS`
entirely, or point it at whatever calendar Paul's account should read.
