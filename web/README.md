# Verification page (`verify.meteoverdict.cz`)

Static site for the **40 main ČHMÚ stations** (`register/stations40.json`). **Scores** is the home screen: network MAE against ČHMÚ for the whole recorded period. **Ledger** opens one release at one station.

The apex `meteoverdict.cz` is a different site. This repository only publishes the subdomain, via the `CNAME` file `verify.meteoverdict.cz`. Do not point the apex at this Pages site.

The browser never sees a snapshot tar and there is no proxy or Worker. It loads JSON that GitHub Actions derives from the public releases, the ledger and `obs/`.

## How the data is derived

`python3 scripts/derive_pages.py` (needs `polars`, see `requirements-score.txt`):

1. Checks the ledger hash chain (`scripts/verify_public.py`).
2. Keeps rows with `status: ok` whose release is **not** listed in `ledger/withdrawn.json`. Withdrawn tars are not downloaded and not scored.
3. Downloads each `snap-*.tar` (or reads `--snap-dir`) and requires `sha256` to equal `asset.sha256` in the ledger. The tar is only read.
4. Reduces the public station files the same way as `scripts/score_stations.py` (AI, blend, public models; rule R1 drops a model run that was not available at the snapshot; nothing is filled from an older run).
5. Builds observations for each UTC day in this order:
   - newest `obs/obs-YYYYMMDD.final*.csv` (checked ČHMÚ `recent/`) if one exists;
   - otherwise `obs/obs-YYYYMMDD.csv` (provisional, ČHMÚ `now/`);
   - otherwise, for a day that has **no** file in `obs/` yet, the newest snapshot `obs-public`, cleaned with the same quality codes and limits as `scripts/fetch_obs.py`.
   A final day is not gap-filled from a snapshot. A provisional day stays provisional until a final file is published. The catalog lists the quality and the source of every day.
6. Scores each `model_version` on its own (rule R11). Lead D+k is `valid_time − snapshot_time` in `[24k, 24k+24)` hours, k = 0..5. D+0 is the first 24 hours after the snapshot. The preregistration’s main bands are still D+1 to D+3 (rule R2); D+4 and D+5 stay secondary. `scripts/score_stations.py` is unchanged and still scores k = 1..5. This page passes `min_lead=0` when it reduces a snapshot.
7. Writes `catalog.json`, `scores.json` and `snaps/<id>.json.gz`.

Anyone can rerun it. The catalog records the script sha256, the chain head, the asset hashes and the observation-file hashes.

### Fairness

Aligned with `preregistration/v1.md` where this page can be (R1–R5, R7, R11). It does not run the block bootstrap (R8) and it does not say that a model works.

For each variable and lead, non-AI series are added from the fullest coverage to the sparsest **while the common station-hours stay at least half of the hours where the AI and an observation both exist, and at least 24 pairs**. MAE, bias and RMSE in that table all use that one set. A series that would shrink the set further is listed under “not in this table”, with the reason. It is not given a second MAE on a different set of hours.

The **all-leads** number is the unweighted mean of those rounded per-lead scores, including D+0 when that lead has pairs. A lead with no pairs is left out of the mean. A series that is missing from a lead is skipped for that lead, not imputed.

**Scores** opens on **Full**, the unweighted mean of the lead scores that have pairs. A lead with no pairs stays out of that mean. The page falls back to the first lead that has pairs only when the selected lead becomes empty. A lead with no scored station-hours is disabled, with the tooltip `D+2 has no scored station-hours`. A lead that is scored, but whose ČHMÚ hours cover under half of `24 × releases that forecast it`, stays clickable and is drawn dashed. The same 50% rule dims a release in the picker when temperature observations cover under half of that release’s D+0 window (`d0_obs_hours / 24`).

**Ledger** shows **one release** (a radio) and **one station**. The list shows the latest release of each UTC day, oldest at the top, and opens on that oldest row. An **All** switch lists every run. A lead day on that chart is the UTC calendar day from 00:00 to the next 00:00. The x-axis is a 24-hour clock. Day boundaries are marked D+0, D+1, …. The dotted ČHMÚ line (`Obs · naměřené`) stays inside the hours where the selected models have values.

The ranking table is that MAE order. Nothing is pinned to the top. The charts open on MeteoVerdict (the blend), MeteoVerdict AI, ICON-D2, ALADIN 1 km, and the lowest-MAE series that is not already one of those. Ticks are stored per page in the browser and override that default after the user changes them.

Rule R7 is shown as a label (`not enough data` / `preliminary` / 60 days recorded). Sixty days still do not, by themselves, mean a model works.

### Schema

`catalog.json`

- `stations`, `names`, `units`, `variable_labels`, `leads`, `thresholds`
- `versions[]`: `model_version`, snapshot count, first/last time, R7 `key`, `days`, `text`
- `snapshots[]`: id (`20261025T0000Z`), time, issue time, model version, asset sha256, chart file name, gzip sha256 and size, `d0_obs_hours` (temperature hours in that release’s D+0 window) and `d0_window_hours` (24)
- `obs_days[]`: `day`, `quality` (`final` or `provisional`), `source`
- `withdrawn_skipped`, `provenance`

`scores.json` → `by_version[model_version][variable]`

- `leads["0".."5"]` when that lead has pairs (`"0"` is D+0). A lead with no pairs is omitted, which the page shows as n = 0 and disables. Each present lead has `series` in MAE order, parallel `mae` / `bias` / `rmse`, `n` (common pairs), `ai_pairs`, `excluded`, `dropped_run_unavailable`, `short`, plus `obs_slots`, `obs_window` and `obs_coverage`. `obs_slots` is the number of distinct hours with an observation, summed over releases that have a model value in the lead. `obs_window` is that release count times 24. Coverage under 0.5 dims the lead.
- `overall`: unweighted mean of the rounded lead scores; `leads_for[series]` lists which leads entered the mean
- `by_day`: one MAE per snapshot UTC day, for the same series as that lead
- `by_station`: the same series, restricted to each station’s hours

`snaps/<id>.json.gz` (gzip of JSON, `enc: "delta-tenths-v1"`)

- `lead0` is 0. Hour 0 of the grid is the snapshot time. `hours` runs through the last forecast hour in D+0..D+5. Each entry of `s` is one model. Observations are stored on those same forecast hours, not on the rest of the UTC day. The chart clips them again to the earliest and latest hour where a selected model has a value.
- `v[variable].obs` and `v[variable].s[i]`: one row per station, joined by `;`. Each row is comma-separated integers. The first present value is `round(x * 10)`; later present values are deltas from the previous present value; an empty token is a missing hour. Trailing gaps are omitted.
- Variables in the chart file: `temperature_2m`, `wind_speed_10m`, `precipitation`. Cloud, sunshine and part-of-day gusts are in `scores.json` only.
- The overview uses full-precision errors. The snapshot screen recomputes MAE in the browser from these tenths (at most 0.05 off each value).

## Size budget

Target: about **100 MB/year** of published bytes, which is about **50–100 KB gzip per snapshot** at four snapshots a day.

The chart file is the bulky part: three variables, 40 stations, every series, leads from 0 h out to the end of the release (the first 24 hours plus the later bands), delta-encoded tenths, then gzip level 9.

Measured on the eight public-v2 releases of 24–25 Oct 2026 (21 series, hours from lead 0): **raw JSON about 470 KB per snapshot, gzip 75–112 KB** (mean about 100 KB). Each model keeps its own row, so the file no longer collapses to one repeated series. At four snapshots a day that is about `4 × 365 × 100 KB ≈ 146 MB/year`, over the 100 MB planning figure. `catalog.json` and `scores.json` stay small beside that. The published files are the gzip payloads, so the `pages-data` branch tracks the transfer size rather than the raw JSON.

Those files are **not** committed to `main`. The workflow `pages-data` force-pushes a single commit to the branch `pages-data` (the same pattern as the `derived` branch: history does not accumulate). CI’s temp parquet of joined pairs is deleted at the end of the job; the reduced-snapshot cache stays in Actions cache, keyed by the tar sha256.

## Enable GitHub Pages

1. Merge this to `main`. That runs `pages-data` (the workflow file and `scripts/derive_pages.py` are on the path filter) and `pages`.
2. In the repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
   Do not also set the source to the `pages-data` or `gh-pages` branch. `pages-data` is only the JSON. The site is the Actions artifact from `pages.yml`, which copies that JSON in at build time.
3. After the first successful `pages` run, Settings → Pages should show the custom domain `verify.meteoverdict.cz` because `web/public/CNAME` is copied into the artifact. If it does not, set the custom domain to exactly `verify.meteoverdict.cz`. Do **not** enter `meteoverdict.cz`.
4. When the certificate exists, enforce HTTPS.

`workflow_run` redeploys the site after each successful `pages-data` run, so new snapshots show up without a change under `web/`.

## DNS

At the DNS host for `meteoverdict.cz`, add only:

| Name | Type | Target |
|---|---|---|
| `verify` | CNAME | `jerrywoof.github.io` |

Leave the apex records (`@`, and `www` if it exists) as they are. They serve the other site. GitHub’s target is the account host `jerrywoof.github.io`, not a path with the repository name. A trailing dot (`jerrywoof.github.io.`) is also fine if the DNS host wants it.

Check, after Pages is enabled: `dig CNAME verify.meteoverdict.cz` should show `jerrywoof.github.io`. The first certificate can take a while after DNS is visible.

## Locally

```bash
pip install -r requirements-score.txt
python3 scripts/derive_pages.py --cache /tmp/mv-pages-cache --out web/public/data
cd web && npm ci && npm test && npm run dev
```

`web/public/data/` is gitignored apart from `.gitkeep`. `npm run build` writes `web/dist`, including `CNAME`.

## What this does not do

- It does not modify, re-upload or rewrite `snap-*` release assets.
- It does not change DNS or Pages settings for the apex.
- It does not score withdrawn releases, missing snapshots, or the forecasts issued between the four daily snapshots.
