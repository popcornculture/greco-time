#!/usr/bin/env python3
"""Turn a MyCase Cases export into paste-ready rows for the Sheet's `Clients` tab.

Run this whenever the case list has drifted — monthly is plenty. Cases added on the phone
via the "new client" checkbox append themselves, so this is only for bulk refreshes.

    Settings -> Import/Export -> export Cases   (gives you a folder containing cases.csv)
    python3 tools/cases-to-clients.py ~/Downloads/mycase-cases-*/cases.csv

Writes a two-column TSV next to the input. Paste it into the `Clients` tab at cell A2.
Column A is the case name exactly as MyCase spells it — that string is what the time-entry
import matches on, so it must not be edited. Column B pre-selects the matter button.

Nothing here is client data, so this file is safe in the public repo. Its OUTPUT is not:
keep that out of the repo.
"""
import argparse
import collections
import csv
import glob
import os
import sys

# Practice Area -> matter button. Decided with Alex 2026-08-13 against the firm's real
# 260 open cases. Anything not listed pre-fills nothing, so whoever logs the time picks
# the button — which is the right behaviour for a practice area we have not classified.
PRACTICE_AREA_TO_MATTER = {
    # Criminal — includes the public-defender contracts and DV, which the firm treats
    # as criminal even when it looks like family law.
    'Criminal Defense': 'Criminal',
    'SLO Defender': 'Criminal',
    'MH Slo Defender': 'Criminal',
    'PD': 'Criminal',
    'DUI/DWI': 'Criminal',
    'DV': 'Criminal',
    # Civil — Immigration folded in here per Alex, only 2 cases.
    'Civil': 'Civil',
    'Bankruptcy': 'Civil',
    'Intellectual Property': 'Civil',
    'Immigration': 'Civil',
    # Family
    'Family': 'Family',
    'Divorce/Separation': 'Family',
    'CWS': 'Family',
    # Conservatorship earned its own button: 71 of 260 cases, the largest single area.
    'Conservatorship SLO': 'Conservatorship',
}

NAME_COL = 'Case/Matter Name'
AREA_COL = 'Practice Area'
CLOSED_COL = 'Case Closed'


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('cases_csv', nargs='?', help='path to cases.csv from a MyCase export')
    ap.add_argument('-o', '--out', help='output path (default: alongside the input)')
    ap.add_argument('--include-closed', action='store_true',
                    help='also include closed cases (default: open cases only)')
    args = ap.parse_args()

    path = args.cases_csv
    if not path:
        found = sorted(glob.glob(os.path.expanduser('~/Downloads/mycase-cases-*/cases.csv')))
        if not found:
            ap.error('no cases.csv given and none found in ~/Downloads/mycase-cases-*/')
        path = found[-1]
        print(f'using {path}')

    # utf-8-sig: MyCase may or may not prepend a BOM, and a BOM would corrupt the first
    # header name and break the lookup.
    with open(path, newline='', encoding='utf-8-sig') as fh:
        rows = list(csv.DictReader(fh))

    if not rows or NAME_COL not in rows[0]:
        sys.exit(f'error: no "{NAME_COL}" column found. Is this the Cases export?\n'
                 f'       columns present: {list(rows[0]) if rows else "none"}')

    out_rows, seen, skipped_closed = [], set(), 0
    unmapped = collections.Counter()

    for r in rows:
        name = (r.get(NAME_COL) or '').strip()
        if not name or name in seen:
            continue
        if not args.include_closed and (r.get(CLOSED_COL) or '').strip().lower() == 'true':
            skipped_closed += 1
            continue
        seen.add(name)
        area = (r.get(AREA_COL) or '').strip()
        matter = PRACTICE_AREA_TO_MATTER.get(area, '')
        if not matter:
            unmapped[area or '(blank)'] += 1
        out_rows.append((name, matter))

    out_rows.sort(key=lambda t: t[0].lower())

    out = args.out or os.path.join(os.path.dirname(os.path.abspath(path)), 'clients-tab.tsv')
    with open(out, 'w', encoding='utf-8') as fh:
        for name, matter in out_rows:
            # Tab-separated so a paste into Sheets lands in columns A and B. Case names
            # contain commas, which is exactly why this is not CSV.
            fh.write(f'{name}\t{matter}\n')

    dist = collections.Counter(m or '(none — tap it)' for _, m in out_rows)
    print(f'\n{len(out_rows)} cases -> {out}')
    if skipped_closed:
        print(f'  ({skipped_closed} closed cases skipped; --include-closed to keep them)')
    print('\nmatter button pre-fill:')
    for k, v in dist.most_common():
        print(f'  {v:5}  {k}')
    if unmapped:
        print('\npractice areas with no mapping (these pre-fill nothing):')
        for k, v in unmapped.most_common():
            print(f'  {v:5}  {k}')
        print('  -> add them to PRACTICE_AREA_TO_MATTER above if that is wrong')
    print(f'\nNext: open the Clients tab, click A2, paste. Do not edit column A —'
          f'\nthose strings must match MyCase exactly or the time import stops matching.')


if __name__ == '__main__':
    main()
