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
- **`runtimeVersion: V8`** — the code assumes the modern runtime.

**B5.** Create the tabs. In the toolbar function dropdown pick **`setupSheet`** → **Run**.

Google will interrupt with an authorization prompt — this is the one-time click that cannot
be automated. **Review permissions → choose the Staff account → Advanced → Go to Greco Time
(unsafe) → Allow.** "Unsafe" here only means the script is not Google-verified; it is your
own code.

Check the Sheet: it should now have `TimeEntries`, `Clients`, `Devices`, `MyCaseExport` tabs.

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
`Hourly`), `DEFAULT_ACTIVITY` (blank).

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
3. **Greco Time → Send today's digest now** to check the digest formatting.
4. **The MyCase import, which nothing else can prove.** **Greco Time → Rebuild MyCase
   export** → open the `MyCaseExport` tab → **File → Download → Comma-separated values** →
   in MyCase, **Billing → Time Entries → Import Time Entries** and upload it.

> The headers now match MyCase's real template exactly (verified 2026-08-13):
> `Case Name,User,Activity,Note,Date,Rate,Rate Type,Hours,Nonbillable`
>
> Still do this first with a **single** entry and delete it in MyCase afterwards. Three
> things only a real import can settle: whether a blank `Rate` is accepted, whether a blank
> `Activity` is accepted, and whether your **Case Name** values match MyCase's cases.

5. After a real import, run **Greco Time → Mark exported rows as done** so those rows never
   go out twice. Skipping this double-bills clients on the next export.

---

## Day-to-day

- Log time on the phone. That is the whole job.
- New client? Tick **new client** and type the name; it joins the list for next time.
- Push to MyCase: **Rebuild MyCase export** → download CSV → import → **Mark exported**.
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
