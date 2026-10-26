#!/usr/bin/env python3
"""Derived JSON for the verify.meteoverdict.cz station page.

Reads public material only. Snapshot tars are downloaded in CI (or taken from ``--snap-dir``),
checked against the ledger sha256, and never modified. Withdrawn releases (``ledger/withdrawn.json``)
are not downloaded and not scored.

What is written (see ``web/README.md`` for the full schema):

* ``catalog.json`` — stations, snapshot index, observation-day quality, names, thresholds, provenance.
* ``scores.json`` — MAE, bias and RMSE for the whole recorded period, per model version (rule R11).
* ``snaps/<id>.json.gz`` — slim forecast-versus-observation grids for the station charts.

Fairness (preregistration R1–R5, R7, R11):

* Lead D+k is ``valid_time − snapshot_time`` in ``[24k, 24k+24)`` hours, k = 0..5.
  D+0 is the first day after the snapshot. ``scripts/score_stations.py`` still scores k = 1..5.
* A public-model value counts only when its run was available at the snapshot (R1, same predicate
  as ``scripts/score_stations.py``). Nothing is filled from an older run (R3).
* One table per variable and lead. Series other than the AI are added from the fullest coverage to
  the sparsest, and only while the common station-hours stay at least half of the AI's observed
  pairs and at least ``MIN_PAIRS``. Everyone in the table is scored on that same set of pairs.
  A series that would shrink the set further is listed under ``excluded``, not given a separate MAE.
* The all-leads number is the unweighted mean of the rounded per-lead scores.
* The ranking is that MAE order. Nothing in this file pins the AI to the top.
* Observations: a day's ``obs-YYYYMMDD.final*.csv`` (newest suffix) wins; otherwise the provisional
  ``obs-YYYYMMDD.csv``; hours the repo does not have yet are filled from the newest snapshot
  ``obs-public``, cleaned the same way as ``scripts/fetch_obs.py``. Final days are not gap-filled.
  Provisional stays provisional until a final file exists (R5).

Chart files store temperature, wind speed and precipitation as delta-encoded tenths
(``enc = delta-tenths-v1``), gzip-compressed. A year of four snapshots a day is on the order of
100 MB of ``.json.gz`` (about 60–80 KB gzip each). Scores use the full-precision values, not the
rounded chart values.

    python3 scripts/derive_pages.py --out /tmp/verify-data
    python3 scripts/derive_pages.py --snap-dir DIR --cache DIR --out web/public/data
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import math
import shutil
import sys
import tarfile
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import polars as pl

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fetch_obs  # noqa: E402
import score_stations as ss  # noqa: E402
import verify_public as vp  # noqa: E402

VERSION = "2"
ENC = "delta-tenths-v1"
UTC = timezone.utc
# A series needs this many AI-paired hours, and the common set must keep at least this many.
MIN_PAIRS = 24
# Do not throw away more than half of the AI's observed hours to admit a sparser series.
KEEP_FRACTION = 0.5
SCALE = 10
CHART_VARS = ("temperature_2m", "wind_speed_10m", "precipitation")
# D+0..D+5. Same band formula as score_stations (D+k = [24k, 24k+24)), which itself keeps k = 1..5.
LEADS = (0, 1, 2, 3, 4, 5)
LEAD0 = 0
LEAD_END = 24 * (LEADS[-1] + 1)  # 144
META = {"snap_id", "snap_day", "station_id", "valid_time", "obs"}
VAR_LABELS = {
    "temperature_2m": "Temperature",
    "wind_speed_10m": "Wind speed",
    "precipitation": "Precipitation",
    "cloud_cover": "Cloud cover",
    "sunshine_duration": "Sunshine",
    ss.PART_GUST: "Gusts (part of day)",
}
NAMES = {**ss.NAMES, "blend": "Blend", "combined": "Blend"}
OBS_SCHEMA = {
    "station_id": pl.String,
    "valid_time": pl.Datetime("us", "UTC"),
    "variable": pl.String,
    "obs": pl.Float64,
    "rank": pl.Int8,
    "src_time": pl.Datetime("us", "UTC"),
    "src": pl.String,
}


@dataclass
class LoadedSnap:
    """One ledger row plus the reduced public forecast frame (and optional raw ``obs-public``)."""

    row: dict
    frame: pl.DataFrame
    obs_public: pl.DataFrame | None = None


@dataclass
class Choice:
    """The common-pair comparison for one variable and one lead."""

    series: list[str]
    metrics: dict[str, dict]
    n: int
    ai_pairs: int
    excluded: list[dict]
    short: bool
    common: pl.DataFrame
    floor: int


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def snap_id_of(row: dict) -> str:
    tag = row["asset"]["tag"]
    return tag[5:] if tag.startswith("snap-") else tag


def r7(n_days: int) -> dict:
    """The preregistration's data-volume label. This never says that a model works."""
    if n_days < 30:
        text = (
            f"{n_days} live snapshot days — not enough data. "
            "Rule R7 asks for 30 days before a preliminary reading and 60 before any stronger statement."
        )
        key = "not_enough_data"
    elif n_days < 60:
        text = f"{n_days} live snapshot days — preliminary (rule R7). Not a claim that a model works."
        key = "preliminary"
    else:
        text = (
            f"{n_days} live snapshot days are on record. Rule R7 still requires a confidence interval "
            "against the blend and stability across months before saying a model works. This page does not say that."
        )
        key = "recorded_60"
    return {"key": key, "days": n_days, "text": text}


def late_expr() -> pl.Expr:
    """Same availability predicate as ``score_stations.r1_filter`` (rule R1)."""
    delay = pl.col("series").replace_strict(ss.DELAY_H, default=ss.DEFAULT_DELAY_H, return_dtype=pl.Int64)
    available = pl.coalesce(pl.col("avail"), pl.col("run") + pl.duration(hours=delay))
    return ~pl.col("series").is_in(list(ss.PRODUCTS)) & available.is_not_null() & (available > pl.col("snap"))


def split_r1(frame: pl.DataFrame) -> tuple[pl.DataFrame, pl.DataFrame]:
    if frame.is_empty():
        return frame, frame.clear()
    late = late_expr()
    return frame.filter(~late), frame.filter(late)


# ---- delta-tenths ---------------------------------------------------------------------------


def encode_row(values: list[float | None], scale: int = SCALE) -> str:
    """Integers of ``round(value * scale)``. The first present value is absolute; later ones are
    deltas from the previous present value. An empty token is a missing hour. Trailing gaps are omitted."""
    parts: list[str] = []
    prev = 0
    started = False
    for value in values:
        if value is None:
            parts.append("")
            continue
        quantized = int(round(float(value) * scale))
        parts.append(str(quantized if not started else quantized - prev))
        prev = quantized
        started = True
    while parts and parts[-1] == "":
        parts.pop()
    return ",".join(parts)


def decode_row(text: str, hours: int, scale: int = SCALE) -> list[float | None]:
    """Inverse of ``encode_row``. Shorter rows are padded with missing hours."""
    parts = [] if text == "" else text.split(",")
    out: list[float | None] = []
    prev = 0
    started = False
    for part in parts:
        if part == "":
            out.append(None)
            continue
        delta = int(part)
        quantized = delta if not started else prev + delta
        started = True
        prev = quantized
        out.append(quantized / scale)
    if len(out) > hours:
        raise ValueError(f"encoded row has {len(out)} hours, expected at most {hours}")
    out.extend([None] * (hours - len(out)))
    return out


def encode_stations(rows: list[list[float | None]], scale: int = SCALE) -> str:
    """One row per station, joined by ``;`` (station order is the file's ``stations`` array)."""
    return ";".join(encode_row(row, scale) for row in rows)


def round_metric(numerator: float, n: int) -> float:
    return round(numerator / n, 2)


def metric_from_errors(errors: pl.Series) -> dict:
    n = errors.len()
    return {
        "n": n,
        "mae": round(float(errors.abs().mean()), 2),
        "bias": round(float(errors.mean()), 2),
        "rmse": round(float((errors**2).mean() ** 0.5), 2),
    }


def choose_series(wide: pl.DataFrame, min_pairs: int = MIN_PAIRS, keep_fraction: float = KEEP_FRACTION) -> Choice | None:
    """Pick the common set and score it.

    ``wide`` has one row per (snapshot, station, hour) and a column per series, plus ``obs``.
    The AI is the anchor: hours without an AI value are not part of the comparison (R3).
    """
    if wide.is_empty() or "ai" not in wide.columns or "obs" not in wide.columns:
        return None
    ai = wide.drop_nulls(["ai", "obs"])
    ai_n = ai.height
    if ai_n == 0:
        return None
    floor = max(min_pairs, math.ceil(keep_fraction * ai_n - 1e-9))
    others = [c for c in ai.columns if c not in META and c != "ai"]
    counts = sorted(((ai.drop_nulls(m).height, m) for m in others), key=lambda item: (-item[0], item[1]))
    chosen: list[str] = []
    excluded: list[dict] = []
    for count, name in counts:
        coverage = round(count / ai_n, 3)
        if count < min_pairs:
            excluded.append({"k": name, "pairs": count, "coverage": coverage, "reason": "too_few_pairs"})
            continue
        trial = [*chosen, name]
        intersection = ai.drop_nulls(trial).height
        if intersection >= floor and intersection >= min_pairs:
            chosen.append(name)
            continue
        excluded.append({
            "k": name, "pairs": count, "coverage": coverage, "intersection": intersection,
            "reason": "would_shrink_common_set",
        })
    common = ai.drop_nulls(chosen) if chosen else ai
    order = ["ai", *chosen]
    metrics = {name: metric_from_errors(common[name] - common["obs"]) for name in order}
    order.sort(key=lambda name: (metrics[name]["mae"], name))
    return Choice(
        series=order,
        metrics=metrics,
        n=common.height,
        ai_pairs=ai_n,
        excluded=sorted(excluded, key=lambda item: item["k"]),
        short=common.height < min_pairs,
        common=common,
        floor=floor,
    )


# ---- observations ----------------------------------------------------------------------------


def empty_obs() -> pl.DataFrame:
    return pl.DataFrame(schema=OBS_SCHEMA)


def _as_utc(frame: pl.DataFrame) -> pl.DataFrame:
    return frame.with_columns(pl.col("valid_time").dt.cast_time_unit("us").dt.replace_time_zone("UTC"))


def csvs_to_long(files: list[Path], quality: dict[str, str]) -> pl.DataFrame:
    """Repo files chosen by ``score_stations.obs_files`` (newest final, else provisional)."""
    frames = []
    for path in files:
        day = path.name[4:12]
        header = path.read_text(encoding="utf-8").split("\n", 1)[0]
        overrides = {column: pl.Float64 for column in ss.OBS_COLUMNS if column in header}
        table = pl.read_csv(path, schema_overrides=overrides)
        if table.is_empty():
            continue
        rank = 2 if quality.get(day) == "final" else 1
        src_time = datetime.strptime(day, "%Y%m%d").replace(tzinfo=UTC)
        long = (
            table.unpivot(index=["station_id", "time"], variable_name="variable", value_name="obs")
            .drop_nulls("obs")
            .select(
                "station_id",
                pl.col("time").str.to_datetime("%Y-%m-%dT%H:%M:%SZ", time_zone="UTC").alias("valid_time"),
                "variable",
                pl.col("obs").cast(pl.Float64),
                pl.lit(rank, dtype=pl.Int8).alias("rank"),
                pl.lit(src_time).cast(pl.Datetime("us", "UTC")).alias("src_time"),
                pl.lit(f"obs/{path.name}").alias("src"),
            )
        )
        frames.append(_as_utc(long))
    if not frames:
        return empty_obs()
    return pl.concat(frames, how="diagonal_relaxed").cast(OBS_SCHEMA)


def obs_public_to_long(table: pl.DataFrame, days_skip: set[str], src: str, src_time: datetime) -> pl.DataFrame:
    """Cleaned hourly observations from one snapshot's ``obs-public`` (same rules as ``fetch_obs``).

    Days in ``days_skip`` (``YYYYMMDD``) already have a repo file and are not emitted. Final days
    are therefore never overwritten; provisional repo days are not overwritten either. Hour 00 of a
    gap day still sees the previous day's 10-minute slots, which is what the precip sum needs.
    """
    if table is None or table.is_empty():
        return empty_obs()
    elements = [*fetch_obs.ELEMENTS.keys(), "N", "SSV1H"]
    sub = table.filter(
        pl.col("element").is_in(elements),
        pl.col("value").is_not_null(),
        pl.col("quality").is_in(list(fetch_obs.KEEP_QUALITY)),
    )
    records: list[tuple] = []
    for station in sub["station_id"].unique().to_list():
        rows_10: list[list] = []
        rows_1h: list[list] = []
        piece = sub.filter(pl.col("station_id") == station)
        for step, element, when, value, flag, quality in piece.select(
            "step", "element", "time", "value", "flag", "quality"
        ).iter_rows():
            row = [station, element, when.strftime("%Y-%m-%dT%H:%M:%SZ"), value, "" if flag is None else flag, int(quality)]
            if step == "10min" and element in fetch_obs.ELEMENTS:
                rows_10.append(row)
            elif step == "1h" and element in ("N", "SSV1H"):
                rows_1h.append(row)
        stamps = [row[2][:10] for row in rows_10] + [row[2][:10] for row in rows_1h]
        if not stamps:
            continue
        parsed = [date.fromisoformat(stamp) for stamp in stamps]
        day = min(parsed)
        last = max(parsed)
        while day <= last:
            key = f"{day:%Y%m%d}"
            cells = fetch_obs.hourly(rows_10, day) if rows_10 else {}
            if rows_1h:
                for when, extra in fetch_obs.hourly_sky(rows_1h, day).items():
                    cells.setdefault(when, {}).update(extra)
            if key not in days_skip:
                for when, cell in cells.items():
                    for variable, value in cell.items():
                        records.append((station, when, variable, float(value), 0, src_time, src))
            day += timedelta(days=1)
    if not records:
        return empty_obs()
    out = pl.DataFrame(
        records,
        schema=["station_id", "valid_time", "variable", "obs", "rank", "src_time", "src"],
        orient="row",
    )
    return _as_utc(out).cast(OBS_SCHEMA)


def merge_obs(parts: list[pl.DataFrame]) -> pl.DataFrame:
    """Highest rank wins (final, then provisional repo, then snapshot). Newest ``src_time`` breaks ties."""
    parts = [part for part in parts if part is not None and not part.is_empty()]
    if not parts:
        return empty_obs()
    stacked = pl.concat(parts, how="diagonal_relaxed").cast(OBS_SCHEMA)
    stacked = stacked.sort(["rank", "src_time"], descending=[True, True])
    return stacked.unique(["station_id", "valid_time", "variable"], keep="first")


def add_gust_parts(hourly: pl.DataFrame) -> pl.DataFrame:
    """Replace hourly gusts with the part-of-day gust used by the scores (Prague parts, as in ``score_stations``)."""
    keep = ("temperature_2m", "wind_speed_10m", "precipitation", "cloud_cover", "sunshine_duration")
    base = hourly.filter(pl.col("variable").is_in(keep))
    gust_rows = hourly.filter(pl.col("variable") == "wind_gusts_10m")
    if gust_rows.is_empty():
        return base
    parts = ss.hourly_gust_parts(
        gust_rows.select("station_id", "valid_time", pl.col("obs").alias("value")),
        ["station_id"],
        ss.MIN_PART_OBS,
    )
    if parts.is_empty():
        return base
    extra = parts.select(
        "station_id",
        "valid_time",
        pl.lit(ss.PART_GUST).alias("variable"),
        pl.col("value").cast(pl.Float64).alias("obs"),
    )
    # Carry the source columns through so day quality still resolves. Parts are derived from the
    # winning hourly rows; mark them provisional-or-better by joining back is unnecessary for scores.
    # Day quality is computed from the hourly table, before this replacement.
    return pl.concat([base.drop("rank", "src_time", "src"), extra], how="diagonal_relaxed")


def day_quality(hourly: pl.DataFrame) -> list[dict]:
    """One record per UTC day present in the merged hourly observations."""
    if hourly.is_empty():
        return []
    labeled = hourly.with_columns(pl.col("valid_time").dt.strftime("%Y-%m-%d").alias("day"))
    out = []
    for key, group in labeled.partition_by("day", as_dict=True).items():
        day = key[0] if isinstance(key, tuple) else key
        rank = int(group["rank"].max())
        top = group.filter(pl.col("rank") == rank).sort("src_time", descending=True)
        out.append({
            "day": day,
            "quality": "final" if rank >= 2 else "provisional",
            "source": top["src"][0],
        })
    out.sort(key=lambda item: item["day"])
    return out


def scoring_obs(hourly: pl.DataFrame) -> pl.DataFrame:
    """Columns the scorer joins on: station, time, variable, obs. Gusts are parts of the day."""
    scored = add_gust_parts(hourly)
    if scored.is_empty():
        return pl.DataFrame(schema={"station_id": pl.String, "valid_time": pl.Datetime("us", "UTC"),
                                    "variable": pl.String, "obs": pl.Float64})
    return scored.select("station_id", "valid_time", "variable", pl.col("obs").cast(pl.Float64))


# ---- charts and pair files -------------------------------------------------------------------


def series_order(names: set[str]) -> list[str]:
    head = [name for name in ("ai", "blend") if name in names]
    return head + sorted(names - set(head))


def write_gz(path: Path, doc: dict) -> tuple[int, int, str]:
    raw = json.dumps(doc, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()
    blob = gzip.compress(raw, compresslevel=9, mtime=0)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(blob)
    return len(blob), len(raw), sha256_bytes(blob)


def chart_span(when: datetime, max_lead: int) -> tuple[int, int]:
    """Forecast hours only. ``lead0`` is 0: hour 0 is the snapshot instant.

    The grid runs through the last forecast hour in D+0..D+5. Observations are stored on those
    same hours. The chart then clips them to the selected models' time range, so a full UTC day
    is not drawn when the forecast starts later than 00:00.
    """
    del when
    last = max(int(max_lead), LEAD0)
    return LEAD0, last - LEAD0 + 1


def lead_coverage(kept: pl.DataFrame, obs: pl.DataFrame, when: datetime) -> dict[str, list[dict]]:
    """Per variable and lead: whether any model value falls in the 24 h window, and how many
    distinct hours in that window have a ČHMÚ observation at any station.

    The denominator used later is ``model_snaps * 24`` (the lead window length), not the count
    of hours a model happened to emit and not station-hours.
    """
    result = {
        variable: [{"model": False, "obs_hours": 0} for _ in LEADS]
        for variable in ss.VARIABLES
    }
    if not kept.is_empty():
        band = kept.filter(
            (pl.col("lead_h") >= LEAD0) & (pl.col("lead_h") < LEAD_END) & pl.col("value").is_not_null()
        )
        if not band.is_empty():
            present = band.select("variable", (pl.col("lead_h") // 24).alias("lead")).unique()
            for variable, lead in present.iter_rows():
                lead_i = int(lead)
                if variable in result and 0 <= lead_i < len(LEADS):
                    result[variable][lead_i]["model"] = True
    if not obs.is_empty():
        for lead in LEADS:
            t0 = when + timedelta(hours=24 * lead)
            t1 = t0 + timedelta(hours=24)
            window = obs.filter(
                (pl.col("valid_time") >= t0) & (pl.col("valid_time") < t1) & pl.col("obs").is_not_null()
            )
            if window.is_empty():
                continue
            counts = window.group_by("variable").agg(pl.col("valid_time").n_unique().alias("n"))
            for variable, count in counts.iter_rows():
                if variable in result:
                    result[variable][lead]["obs_hours"] = int(count)
    return result


def chart_document(snap: LoadedSnap, kept: pl.DataFrame, obs: pl.DataFrame, station_ids: list[str]) -> dict:
    """Forecasts (after R1) and the observations that fall on those same forecast hours.

    Each series is stored on its own. Hours before the snapshot, and hours after the last
    forecast hour, are not in the file. The page still clips Obs to the models drawn for the
    current lead.
    """
    row = snap.row
    when = vp.parse_time(row["snapshot_time"])
    names: set[str] = set()
    hours = 0
    lead0 = LEAD0
    window = kept
    if not kept.is_empty():
        window = kept.filter(
            pl.col("variable").is_in(CHART_VARS),
            pl.col("lead_h") >= LEAD0,
            pl.col("lead_h") < LEAD_END,
        )
        if not window.is_empty():
            lead0, hours = chart_span(when, int(window["lead_h"].max()))
            names = set(window["series"].unique().to_list())
    order = series_order(names)
    grids: dict[str, dict] = {}
    if hours > 0:
        t0 = when + timedelta(hours=lead0)
        t1 = t0 + timedelta(hours=hours)
        obs_win = obs.filter(
            pl.col("variable").is_in(CHART_VARS),
            pl.col("valid_time") >= t0,
            pl.col("valid_time") < t1,
        )
        obs_idx = {
            (sid, variable, when_): float(value)
            for sid, variable, when_, value in obs_win.select("station_id", "variable", "valid_time", "obs").iter_rows()
        }
        for variable in CHART_VARS:
            sub = window.filter(pl.col("variable") == variable)
            idx: dict[tuple[str, str, int], float] = {}
            for sid, series, lead, value in sub.select("station_id", "series", "lead_h", "value").iter_rows():
                if value is None:
                    continue
                idx[(series, sid, int(lead))] = float(value)
            series_rows = []
            for name in order:
                rows = []
                for sid in station_ids:
                    rows.append([idx.get((name, sid, lead0 + hour)) for hour in range(hours)])
                series_rows.append(encode_stations(rows))
            obs_rows = []
            for sid in station_ids:
                obs_rows.append([
                    obs_idx.get((sid, variable, t0 + timedelta(hours=hour)))
                    for hour in range(hours)
                ])
            grids[variable] = {"obs": encode_stations(obs_rows), "s": series_rows}
    return {
        "id": snap_id_of(row),
        "snapshot_time": row["snapshot_time"],
        "issue_time": row.get("issue_time"),
        "model_version": row.get("model_version"),
        "sha256": row["asset"]["sha256"],
        "lead0": lead0,
        "hours": hours,
        "scale": SCALE,
        "enc": ENC,
        "stations": station_ids,
        "series": order,
        "v": grids,
    }


def pairs_frame(kept: pl.DataFrame, obs: pl.DataFrame, snap_id: str, snap_day: str) -> pl.DataFrame:
    """Long pairs that have an observation, leads D+0..D+5, after R1. One row per series value."""
    if kept.is_empty() or obs.is_empty():
        return pl.DataFrame()
    joined = kept.join(obs, on=["station_id", "valid_time", "variable"], how="inner")
    if joined.is_empty():
        return pl.DataFrame()
    joined = joined.with_columns((pl.col("lead_h") // 24).cast(pl.Int8).alias("lead"))
    joined = joined.filter(pl.col("lead").is_in(list(LEADS)))
    if joined.is_empty():
        return pl.DataFrame()
    return joined.select(
        pl.lit(snap_id).alias("snap_id"),
        pl.lit(snap_day).alias("snap_day"),
        "station_id",
        "valid_time",
        "variable",
        "lead",
        "series",
        pl.col("value").cast(pl.Float64),
        pl.col("obs").cast(pl.Float64),
    )


def dropped_by_lead(late: pl.DataFrame) -> dict[tuple[str, int], dict[str, int]]:
    if late.is_empty():
        return {}
    band = late.with_columns((pl.col("lead_h") // 24).cast(pl.Int8).alias("lead"))
    band = band.filter(pl.col("lead").is_in(list(LEADS)), pl.col("variable").is_in(list(ss.VARIABLES)))
    if band.is_empty():
        return {}
    grouped = band.group_by("variable", "lead", "series").len()
    out: dict[tuple[str, int], dict[str, int]] = {}
    for variable, lead, series, count in grouped.iter_rows():
        out.setdefault((variable, int(lead)), {})[series] = int(count)
    return out


# ---- scoring ---------------------------------------------------------------------------------


def _nulls(n: int) -> list[None]:
    return [None] * n


def score_variable(
    files: list[Path],
    variable: str,
    station_ids: list[str],
    days: list[str],
    dropped: dict[tuple[str, int], dict[str, int]],
    coverage: dict[int, dict] | None = None,
) -> dict:
    """Per-lead common-pair scores, plus the day and station breakdowns of that same series set."""
    leads_out: dict[str, dict] = {}
    by_day_leads: dict[str, dict] = {}
    by_station: dict[str, dict] = {}
    for lead in LEADS:
        frames = []
        for path in files:
            scan = pl.scan_parquet(path).filter(pl.col("variable") == variable, pl.col("lead") == lead).collect()
            if not scan.is_empty():
                frames.append(scan)
        if not frames:
            continue
        long = pl.concat(frames, how="vertical")
        wide = long.pivot(
            on="series",
            index=["snap_id", "snap_day", "station_id", "valid_time", "obs"],
            values="value",
            aggregate_function="first",
        )
        choice = choose_series(wide)
        if choice is None:
            continue
        key = str(lead)
        leads_out[key] = {
            "n": choice.n,
            "ai_pairs": choice.ai_pairs,
            "floor": choice.floor,
            "snaps": int(choice.common["snap_id"].n_unique()),
            "stations": int(choice.common["station_id"].n_unique()),
            "series": choice.series,
            "mae": [choice.metrics[name]["mae"] for name in choice.series],
            "bias": [choice.metrics[name]["bias"] for name in choice.series],
            "rmse": [choice.metrics[name]["rmse"] for name in choice.series],
            "excluded": [{**item, "name": NAMES.get(item["k"], item["k"])} for item in choice.excluded],
            "dropped_run_unavailable": dropped.get((variable, lead), {}),
            "short": choice.short,
        }
        stats = (coverage or {}).get(lead)
        if stats and stats.get("model_snaps"):
            slots = int(stats["obs_slots"])
            window = int(stats["model_snaps"]) * 24
            leads_out[key]["obs_slots"] = slots
            leads_out[key]["obs_window"] = window
            leads_out[key]["obs_coverage"] = round(slots / window, 4) if window else 0.0
        # Day and station breakdowns use the same series, so a station-hour counts only when all of them have a value.
        common = choice.common
        day_n = {day: 0 for day in days}
        day_err: dict[str, dict[str, list[float]]] = {name: {day: [] for day in days} for name in choice.series}
        for snap_day, group in common.partition_by("snap_day", as_dict=True).items():
            day = snap_day[0] if isinstance(snap_day, tuple) else snap_day
            if day not in day_n:
                continue
            day_n[day] = group.height
            for name in choice.series:
                errors = group[name] - group["obs"]
                day_err[name][day] = [round(float(errors.abs().mean()), 2)]
        by_day_leads[key] = {
            "series": choice.series,
            "n": [day_n[day] for day in days],
            "mae": [[(day_err[name][day][0] if day_n[day] else None) for day in days] for name in choice.series],
        }
        st_n = {sid: 0 for sid in station_ids}
        st_mae: dict[str, dict[str, float | None]] = {name: {sid: None for sid in station_ids} for name in choice.series}
        for key_sid, group in common.partition_by("station_id", as_dict=True).items():
            sid = key_sid[0] if isinstance(key_sid, tuple) else key_sid
            if sid not in st_n:
                continue
            st_n[sid] = group.height
            for name in choice.series:
                st_mae[name][sid] = round(float((group[name] - group["obs"]).abs().mean()), 2)
        by_station[key] = {
            "series": choice.series,
            "ids": station_ids,
            "n": [st_n[sid] for sid in station_ids],
            "mae": [[st_mae[name][sid] for sid in station_ids] for name in choice.series],
        }
    overall = overall_from_leads(leads_out)
    return {"leads": leads_out, "overall": overall, "by_day": {"days": days, "leads": by_day_leads}, "by_station": by_station}


def overall_from_leads(leads_out: dict[str, dict]) -> dict:
    """Unweighted mean of the rounded per-lead scores. A series absent from a lead is skipped, not filled."""
    bucket: dict[str, list[tuple[float, float, float, str]]] = {}
    n_by_lead = {}
    for lead, doc in leads_out.items():
        n_by_lead[lead] = doc["n"]
        for index, name in enumerate(doc["series"]):
            bucket.setdefault(name, []).append((doc["mae"][index], doc["bias"][index], doc["rmse"][index], lead))
    series = sorted(bucket, key=lambda name: (sum(item[0] for item in bucket[name]) / len(bucket[name]), name))
    def mean(name: str, slot: int) -> float:
        values = [item[slot] for item in bucket[name]]
        return round(sum(values) / len(values), 2)
    return {
        "leads_used": sorted((int(lead) for lead in leads_out), key=int),
        "series": series,
        "mae": [mean(name, 0) for name in series],
        "bias": [mean(name, 1) for name in series],
        "rmse": [mean(name, 2) for name in series],
        "n_by_lead": n_by_lead,
        "leads_for": {name: [int(item[3]) for item in bucket[name]] for name in series},
    }


def score_version(
    files: list[Path],
    station_ids: list[str],
    days: list[str],
    dropped: dict,
    coverage: dict[str, dict[int, dict]] | None = None,
) -> dict:
    coverage = coverage or {}
    return {
        variable: score_variable(files, variable, station_ids, days, dropped, coverage.get(variable))
        for variable in ss.VARIABLES
    }


# ---- dataset ---------------------------------------------------------------------------------


def build_dataset(
    snaps: list[LoadedSnap],
    obs_dir: Path,
    stations: list[dict],
    out: Path,
    *,
    withdrawn: list[str] | None = None,
    ledger_meta: dict | None = None,
) -> dict:
    """Write ``catalog.json``, ``scores.json`` and ``snaps/*.json.gz`` under ``out`` and return the catalog."""
    snaps = sorted(snaps, key=lambda item: item.row["snapshot_time"])
    station_ids = [station["id"] for station in stations]
    files, quality = ss.obs_files(obs_dir) if obs_dir.exists() else ([], {})
    repo = csvs_to_long(files, quality)
    repo_days = set(quality)
    obs_parts = [repo]
    prepared: list[tuple[LoadedSnap, pl.DataFrame, pl.DataFrame]] = []
    for snap in sorted(snaps, key=lambda item: item.row["snapshot_time"]):
        frame = snap.frame if snap.frame is not None else pl.DataFrame(schema=ss.SCHEMA)
        if not frame.is_empty() and "lead_h" not in frame.columns:
            frame = frame.with_columns(((pl.col("valid_time") - pl.col("snap")).dt.total_hours()).alias("lead_h"))
        kept, late = split_r1(frame) if not frame.is_empty() else (frame, frame)
        prepared.append((snap, kept, late))
        if snap.obs_public is not None:
            when = vp.parse_time(snap.row["snapshot_time"])
            obs_parts.append(obs_public_to_long(
                snap.obs_public, repo_days, f"{snap.row['asset']['tag']} obs-public", when,
            ))
    hourly = merge_obs(obs_parts)
    days_meta = day_quality(hourly)
    obs = scoring_obs(hourly)

    if out.exists():
        shutil.rmtree(out)
    snap_dir = out / "snaps"
    snap_dir.mkdir(parents=True, exist_ok=True)
    work = out / ".pairs"
    work.mkdir(parents=True, exist_ok=True)

    catalog_snaps = []
    pair_files: dict[str, list[Path]] = {}
    dropped: dict[str, dict[tuple[str, int], dict[str, int]]] = {}
    # version → variable → lead → obs hours summed over releases that forecast that lead, and how many such releases.
    coverage_acc: dict[str, dict[str, dict[int, dict]]] = {}
    for snap, kept, late in prepared:
        row = snap.row
        version = row.get("model_version") or "unknown"
        sid = snap_id_of(row)
        day = row["snapshot_time"][:10]
        when = vp.parse_time(row["snapshot_time"])
        doc = chart_document(snap, kept, obs, station_ids)
        cov = lead_coverage(kept, obs, when)
        version_cov = coverage_acc.setdefault(version, {})
        for variable, leads in cov.items():
            dest = version_cov.setdefault(variable, {})
            for lead, item in enumerate(leads):
                slot = dest.setdefault(lead, {"obs_slots": 0, "model_snaps": 0})
                if item["model"]:
                    slot["model_snaps"] += 1
                    slot["obs_slots"] += int(item["obs_hours"])
        gz_bytes, raw_bytes, digest = write_gz(snap_dir / f"{sid}.json.gz", doc)
        catalog_snaps.append({
            "id": sid,
            "tag": row["asset"]["tag"],
            "time": row["snapshot_time"],
            "issue_time": row.get("issue_time"),
            "model_version": version,
            "sha256": row["asset"]["sha256"],
            "file": f"snaps/{sid}.json.gz",
            "file_sha256": digest,
            "file_bytes": gz_bytes,
            "raw_bytes": raw_bytes,
            "chart_hours": doc["hours"],
            # Hours in this release's D+0 window [0, 24) with a temperature observation at any station.
            # The picker grays the release when this is under half of 24.
            "d0_obs_hours": int(cov["temperature_2m"][0]["obs_hours"]),
            "d0_window_hours": 24,
        })
        pairs = pairs_frame(kept, obs, sid, day)
        if not pairs.is_empty():
            path = work / f"{sid}.parquet"
            pairs.write_parquet(path, compression="zstd")
            pair_files.setdefault(version, []).append(path)
        for key, counts in dropped_by_lead(late).items():
            bucket = dropped.setdefault(version, {}).setdefault(key, {})
            for series, count in counts.items():
                bucket[series] = bucket.get(series, 0) + count

    by_version_scores: dict[str, dict] = {}
    version_meta = []
    versions = sorted({snap.row.get("model_version") or "unknown" for snap in snaps}) if snaps else []
    for version in versions:
        group = [snap for snap in snaps if (snap.row.get("model_version") or "unknown") == version]
        days = sorted({snap.row["snapshot_time"][:10] for snap in group})
        files_v = pair_files.get(version, [])
        by_version_scores[version] = score_version(
            files_v, station_ids, days, dropped.get(version, {}), coverage_acc.get(version)
        ) if files_v else {
            variable: {"leads": {}, "overall": overall_from_leads({}), "by_day": {"days": days, "leads": {}}, "by_station": {}}
            for variable in ss.VARIABLES
        }
        version_meta.append({
            "model_version": version,
            "snapshots": len(group),
            "first": group[0].row["snapshot_time"] if group else None,
            "last": group[-1].row["snapshot_time"] if group else None,
            **r7(len(days)),
        })

    script = Path(__file__)
    obs_sums = [f"{sha256_file(path)}  {path.name}" for path in files]
    provenance = {
        "script": {"file": "scripts/derive_pages.py", "version": VERSION, "sha256": sha256_file(script) if script.exists() else None,
                   "polars": pl.__version__},
        "rules": "preregistration/v1.md R1–R5, R7, R11. Leads D+k = [24k, 24k+24) h for k = 0..5 (D+0 is the first 24 h; the preregistration's main bands remain D+1..D+3). Common pairs. No filling. Withdrawn snaps excluded.",
        "thresholds": {
            "min_pairs": MIN_PAIRS,
            "keep_fraction": KEEP_FRACTION,
            "note": (
                "For each variable and lead, non-AI series are added from fullest coverage to sparsest while "
                "the common station-hours stay at least half of the AI's observed pairs and at least min_pairs. "
                "MAE, bias and RMSE in a table all use that one set. The all-leads value is the unweighted mean "
                "of the rounded per-lead values."
            ),
        },
        "obs": {
            "files": [f"obs/{path.name}" for path in files],
            "sums_sha256": vp.sha256("\n".join(obs_sums).encode()) if obs_sums else None,
            "rule": (
                "Per UTC day, the newest obs-YYYYMMDD.final*.csv wins. Otherwise obs-YYYYMMDD.csv (provisional). "
                "Hours with no repo file are taken from the newest snapshot obs-public, cleaned as scripts/fetch_obs.py "
                "(quality 0/3/5, plausible limits). A final day is not gap-filled from a snapshot. "
                "Provisional stays provisional until a final file is published."
            ),
        },
        "stations": {"file": "register/stations40.json", "n": len(stations)},
        "chart": {
            "enc": ENC,
            "scale": SCALE,
            "variables": list(CHART_VARS),
            "note": (
                "Chart values are rounded to 0.1. The grid starts at the snapshot (lead0 = 0) and stops at the "
                "last forecast hour. Observations are stored on those hours; the page draws them only inside "
                "the selected models' time range. Overview scores use full precision. Subset scores in the "
                "browser use the rounded chart values. d0_obs_hours counts distinct D+0 hours with a "
                "temperature observation at any station; a lead's obs_coverage is that same hour count "
                "divided by 24 times the releases that forecast the lead."
            ),
        },
    }
    if ledger_meta:
        provenance["ledger"] = ledger_meta
    catalog = {
        "version": 1,
        "kind": "verify-pages",
        "generated": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "product": "MeteoVerdict Verify",
        "host": "verify.meteoverdict.cz",
        "variables": list(ss.VARIABLES),
        "variable_labels": VAR_LABELS,
        "chart_variables": list(CHART_VARS),
        "primary": list(ss.PRIMARY),
        "units": ss.UNITS,
        "names": NAMES,
        "leads": list(LEADS),
        "thresholds": {"min_pairs": MIN_PAIRS, "keep_fraction": KEEP_FRACTION, "scale": SCALE, "enc": ENC},
        "stations": [{key: station[key] for key in ("id", "name", "lat", "lon", "elev") if key in station} for station in stations],
        "versions": version_meta,
        "snapshots": catalog_snaps,
        "obs_days": days_meta,
        "withdrawn_skipped": list(withdrawn or []),
        "provenance": provenance,
    }
    scores = {"version": 1, "generated": catalog["generated"], "by_version": by_version_scores}
    _write_json(out / "catalog.json", catalog)
    _write_json(out / "scores.json", scores)
    (out / "README.md").write_text(
        "Generated by scripts/derive_pages.py from the public ledger, snapshot releases and obs/.\n"
        "Do not edit by hand. Schema and the Pages/DNS steps: web/README.md in the main branch.\n"
        f"Generated: {catalog['generated']}\n",
        encoding="utf-8",
    )
    shutil.rmtree(work, ignore_errors=True)
    return catalog


def _write_json(path: Path, doc: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":"), sort_keys=True), encoding="utf-8")


# ---- loading snapshots -----------------------------------------------------------------------


def _member(data: bytes, name: str) -> bytes | None:
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        try:
            handle = tar.extractfile(name)
        except KeyError:
            return None
        return None if handle is None else handle.read()


def load_snap_bytes(row: dict, data: bytes, stations: list[str]) -> LoadedSnap:
    if vp.sha256(data) != row["asset"]["sha256"]:
        raise SystemExit(f"FAIL {row['snapshot_time']}: {row['asset']['name']} does not match the ledger sha256")
    frame = ss.reduce_snapshot(data, vp.parse_time(row["snapshot_time"]), stations, min_lead=LEAD0)
    raw = _member(data, "obs-public.parquet")
    obs_public = pl.read_parquet(io.BytesIO(raw)) if raw else None
    return LoadedSnap(row=row, frame=frame, obs_public=obs_public)


def cached_frame(cache: Path | None, digest: str) -> pl.DataFrame | None:
    if cache is None:
        return None
    path = cache / f"pages-v{VERSION}-{digest}.parquet"
    return pl.read_parquet(path) if path.exists() else None


def store_frame(cache: Path | None, digest: str, frame: pl.DataFrame) -> None:
    if cache is None:
        return
    cache.mkdir(parents=True, exist_ok=True)
    frame.write_parquet(cache / f"pages-v{VERSION}-{digest}.parquet", compression="zstd")


def _empty_obs_public() -> pl.DataFrame:
    return pl.DataFrame(schema={
        "station_id": pl.String, "time": pl.Datetime("us", "UTC"), "step": pl.String,
        "element": pl.String, "value": pl.Float32, "flag": pl.String, "quality": pl.Int8,
    })


def cached_obs(cache: Path | None, digest: str) -> pl.DataFrame | None:
    if cache is None:
        return None
    path = cache / f"pages-obs-v{VERSION}-{digest}.parquet"
    return pl.read_parquet(path) if path.exists() else None


def store_obs(cache: Path | None, digest: str, table: pl.DataFrame | None) -> None:
    if cache is None or table is None:
        return
    cache.mkdir(parents=True, exist_ok=True)
    table.write_parquet(cache / f"pages-obs-v{VERSION}-{digest}.parquet", compression="zstd")


def needs_obs_public(row: dict, repo_days: set[str]) -> bool:
    """A snapshot can fill only recent days that the repo has not frozen yet."""
    when = vp.parse_time(row["snapshot_time"]).date()
    return any(f"{(when - timedelta(days=delta)):%Y%m%d}" not in repo_days for delta in range(0, 6))


def load_snaps(rows: list[dict], stations: list[str], snap_dir: Path | None, cache: Path | None, repo: str, repo_days: set[str]) -> list[LoadedSnap]:
    loaded = []
    for row in rows:
        asset = row["asset"]
        digest = asset["sha256"]
        frame = cached_frame(cache, digest)
        obs_public = cached_obs(cache, digest) if needs_obs_public(row, repo_days) else None
        have_obs = (not needs_obs_public(row, repo_days)) or obs_public is not None
        if frame is None or not have_obs:
            if snap_dir and (snap_dir / asset["name"]).exists():
                data = (snap_dir / asset["name"]).read_bytes()
            else:
                data = vp.fetch(f"https://github.com/{repo}/releases/download/{asset['tag']}/{asset['name']}")
            fresh = load_snap_bytes(row, data, stations)
            frame = fresh.frame
            obs_public = fresh.obs_public if needs_obs_public(row, repo_days) else None
            store_frame(cache, digest, frame)
            if needs_obs_public(row, repo_days):
                store_obs(cache, digest, obs_public if obs_public is not None else _empty_obs_public())
        loaded.append(LoadedSnap(row=row, frame=frame, obs_public=obs_public if obs_public is not None and not obs_public.is_empty() else None))
    return loaded


def ok_rows(ledger_dir: Path, days: int) -> tuple[list[dict], list[dict], list[str]]:
    """Chain-checked ledger, the scorable rows, and the withdrawn tags."""
    ledger = vp.read_ledger(ledger_dir)
    problems = vp.check_chain(ledger)
    if problems:
        raise SystemExit("\n".join(f"FAIL {problem}" for problem in problems))
    withdrawn = vp.read_withdrawn(ledger_dir)
    ok = [row for row in ledger if row.get("status") == "ok" and row.get("asset") and row["asset"]["tag"] not in withdrawn]
    if days and ledger:
        since = vp.parse_time(ledger[-1]["snapshot_time"]) - timedelta(days=days)
        ok = [row for row in ok if vp.parse_time(row["snapshot_time"]) > since]
    return ledger, ok, sorted(withdrawn)


def report(catalog: dict, out: Path) -> None:
    snaps = catalog["snapshots"]
    gz = sum(item["file_bytes"] for item in snaps)
    raw = sum(item["raw_bytes"] for item in snaps)
    mean = gz / len(snaps) if snaps else 0
    scores_bytes = (out / "scores.json").stat().st_size
    catalog_bytes = (out / "catalog.json").stat().st_size
    print(f"{out}: {len(snaps)} snapshots, catalog {catalog_bytes/1e3:.1f} kB, scores {scores_bytes/1e3:.1f} kB")
    print(f"snap files: raw {raw/1e3:.0f} kB, gzip {gz/1e3:.0f} kB, mean gzip {mean/1e3:.1f} kB")
    for version in catalog["versions"]:
        print(f"  {version['model_version']}: {version['snapshots']} snaps, {version['days']} days, {version['key']}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--ledger", type=Path, default=Path("ledger"))
    parser.add_argument("--obs", type=Path, default=Path("obs"))
    parser.add_argument("--stations", type=Path, default=Path("register/stations40.json"))
    parser.add_argument("--out", type=Path, default=Path("web/public/data"))
    parser.add_argument("--snap-dir", type=Path, help="folder of snap-*.tar already downloaded (otherwise: GitHub releases)")
    parser.add_argument("--cache", type=Path, help="reduced-snapshot cache, keyed by the tar sha256")
    parser.add_argument("--days", type=int, default=0, help="only snapshots of the last N days (0: all scorable rows)")
    parser.add_argument("--repo", default=vp.REPO)
    args = parser.parse_args()

    ledger, ok, withdrawn = ok_rows(args.ledger, args.days)
    register = json.loads(args.stations.read_text(encoding="utf-8"))
    stations = register["stations"]
    _, quality = ss.obs_files(args.obs) if args.obs.exists() else ([], {})
    if not ok:
        print("no snapshot with a published asset; writing an empty catalog")
        catalog = build_dataset([], args.obs, stations, args.out, withdrawn=withdrawn, ledger_meta={
            "rows": len(ledger), "chain_head": ledger[-1]["chain_hash"] if ledger else None,
        })
        report(catalog, args.out)
        return 0
    loaded = load_snaps(ok, [station["id"] for station in stations], args.snap_dir, args.cache, args.repo, set(quality))
    meta = {
        "rows": len(ledger),
        "ok_scored": len(ok),
        "missing": sum(row.get("status") != "ok" for row in ledger),
        "withdrawn": len(withdrawn),
        "first": ok[0]["snapshot_time"],
        "last": ok[-1]["snapshot_time"],
        "chain_head": ledger[-1]["chain_hash"],
        "assets_sha256": vp.sha256("\n".join(f"{row['asset']['name']} {row['asset']['sha256']}" for row in ok).encode()),
    }
    catalog = build_dataset(loaded, args.obs, stations, args.out, withdrawn=withdrawn, ledger_meta=meta)
    report(catalog, args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
