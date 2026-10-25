"""Tests for scripts/derive_pages.py: common-pair scores, observation precedence, chart codec.

Synthetic frames only — snapshot release assets are not read or rewritten here.
"""

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import polars as pl

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import derive_pages as dp  # noqa: E402
import score_stations as ss  # noqa: E402

UTC = timezone.utc
ST = "0-20000-0-11406"
ST2 = "0-20000-0-11723"
SNAP = datetime(2026, 10, 25, tzinfo=UTC)


def _row(when: datetime, version: str = "meteoverdict_ai-v2") -> dict:
    stamp = f"{when:%Y%m%dT%H%MZ}"
    return {
        "snapshot_time": f"{when:%Y-%m-%dT%H:%M:%SZ}",
        "issue_time": f"{(when - timedelta(hours=1)):%Y-%m-%dT%H:%M:%SZ}",
        "model_version": version,
        "status": "ok",
        "asset": {"name": f"snap-{stamp}.tar", "tag": f"snap-{stamp}", "sha256": "abc", "bytes": 1},
    }


def _frame(when: datetime, rows: list[tuple]) -> pl.DataFrame:
    """rows: (series, hour offset from `when`, value, run offset hours, variable)."""
    records = []
    for series, offset, value, run_h, variable in rows:
        valid = when + timedelta(hours=offset)
        run = when + timedelta(hours=run_h)
        records.append({
            "snap": when, "station_id": ST, "variable": variable, "valid_time": valid,
            "series": series, "value": value, "run": run, "avail": None,
        })
    frame = pl.DataFrame(records).with_columns(
        pl.col("snap").cast(pl.Datetime("us", "UTC")),
        pl.col("valid_time").cast(pl.Datetime("us", "UTC")),
        pl.col("run").cast(pl.Datetime("us", "UTC")),
        pl.col("value").cast(pl.Float32),
        pl.lit(None, dtype=pl.Datetime("us", "UTC")).alias("avail"),
    )
    # avail was set twice if the dict had None and lit overwrites. Keep the column once.
    if frame["avail"].dtype == pl.Null:
        frame = frame.with_columns(pl.lit(None, dtype=pl.Datetime("us", "UTC")).alias("avail"))
    return frame.select(list(ss.SCHEMA)).cast(ss.SCHEMA)


def _hours(when: datetime, start: int, count: int, series_values: dict[str, float], variable: str = "temperature_2m", station: str = ST):
    rows = []
    for series, value in series_values.items():
        for offset in range(start, start + count):
            rows.append({
                "snap": when, "station_id": station, "variable": variable,
                "valid_time": when + timedelta(hours=offset), "series": series,
                "value": value, "run": when - timedelta(hours=12), "avail": None,
            })
    return rows


def frame_from(rows: list[dict]) -> pl.DataFrame:
    frame = pl.DataFrame(rows).with_columns(
        pl.col("value").cast(pl.Float32),
        pl.col("snap").cast(pl.Datetime("us", "UTC")),
        pl.col("valid_time").cast(pl.Datetime("us", "UTC")),
        pl.col("run").cast(pl.Datetime("us", "UTC")),
        pl.lit(None, dtype=pl.Datetime("us", "UTC")).alias("avail"),
    )
    return frame.select(list(ss.SCHEMA)).cast(ss.SCHEMA)


def _obs_csv(path: Path, day: str, value: float, station: str = ST) -> None:
    hours = [f"{station},{day}T{hour:02d}:00:00Z,{value},,,,," for hour in range(24)]
    path.write_text(
        "station_id,time,temperature_2m,wind_speed_10m,precipitation,wind_gusts_10m,cloud_cover,sunshine_duration\n"
        + "\n".join(hours) + "\n",
        encoding="utf-8",
    )


def _stations():
    return [{"id": ST, "name": "Cheb", "lat": 50.0, "lon": 12.0, "elev": 483},
            {"id": ST2, "name": "Brno, Tuřany", "lat": 49.1, "lon": 16.6, "elev": 241}]


def test_delta_tenths_roundtrip():
    values = [10.04, None, 10.16, None, -1.24]
    text = dp.encode_row(values)
    assert text == "100,,2,,-114"  # -1.24 °C → -12 tenths, delta from the previous 102
    assert dp.decode_row(text, 5) == [10.0, None, 10.2, None, -1.2]
    assert dp.decode_row("", 3) == [None, None, None]
    grid = dp.encode_stations([[1.0, None], [None, 2.0]])
    assert grid.split(";")[0] == "10"
    again = [dp.decode_row(row, 2) for row in grid.split(";")]
    assert again == [[1.0, None], [None, 2.0]]


def test_choose_series_keeps_a_shared_set_and_ranks_by_mae():
    # 24 hours. AI error 1, model_a error 2, model_b error 3, model_c only 2 hours.
    when = [datetime(2026, 10, 26, hour, tzinfo=UTC) for hour in range(24)]
    rows = []
    for hour in when:
        rows.append({"valid_time": hour, "obs": 10.0, "ai": 11.0, "model_a": 12.0, "model_b": 7.0, "model_c": None})
    for hour in when[:2]:
        rows.append({"valid_time": hour, "obs": 10.0, "ai": 11.0, "model_a": 12.0, "model_b": 7.0, "model_c": 10.0})
    # The second append duplicates the first two hours. Build a clean frame instead.
    clean = []
    for index, hour in enumerate(when):
        clean.append({
            "snap_id": "s", "snap_day": "2026-10-25", "station_id": ST, "valid_time": hour, "obs": 10.0,
            "ai": 11.0, "model_a": 12.0, "model_b": 7.0, "model_c": 10.0 if index < 2 else None,
        })
    wide = pl.DataFrame(clean).with_columns(pl.col("valid_time").cast(pl.Datetime("us", "UTC")))
    choice = dp.choose_series(wide, min_pairs=6, keep_fraction=0.5)
    assert choice is not None
    assert choice.series == ["ai", "model_a", "model_b"]  # MAE 1, 2, 3 — true order, AI not pinned
    assert choice.n == 24 and choice.ai_pairs == 24
    assert choice.metrics["ai"]["mae"] == 1.0 and choice.metrics["ai"]["bias"] == 1.0
    assert choice.metrics["model_b"]["bias"] == -3.0
    assert choice.excluded[0]["k"] == "model_c" and choice.excluded[0]["reason"] == "too_few_pairs"


def test_sparse_model_does_not_shrink_the_common_hours():
    hours = [datetime(2026, 10, 26, hour, tzinfo=UTC) for hour in range(24)]
    clean = []
    for index, hour in enumerate(hours):
        clean.append({
            "snap_id": "s", "snap_day": "2026-10-25", "station_id": ST, "valid_time": hour, "obs": 10.0,
            "ai": 11.0, "dense": 12.0, "sparse": 9.0 if index < 8 else None,  # 8/24 = 33% < 50%
        })
    wide = pl.DataFrame(clean).with_columns(pl.col("valid_time").cast(pl.Datetime("us", "UTC")))
    choice = dp.choose_series(wide, min_pairs=6, keep_fraction=0.5)
    assert choice.series == ["ai", "dense"]
    assert choice.n == 24  # sparse model is excluded rather than cutting the sample to 8
    assert choice.excluded[0]["reason"] == "would_shrink_common_set"


def test_r1_matches_score_stations_and_drops_a_late_run():
    rows = _hours(SNAP, 24, 4, {"ai": 11.0, "ecmwf_ifs": 9.0})
    # ECMWF delay is 7 h and the run is 3 h before the snapshot, so it is not available yet.
    for row in rows:
        if row["series"] == "ecmwf_ifs":
            row["run"] = SNAP - timedelta(hours=3)
    frame = frame_from(rows)
    kept, late = dp.split_r1(frame)
    kept_ref, _ = ss.r1_filter(frame)
    assert kept.sort("series", "valid_time").equals(kept_ref.sort("series", "valid_time"))
    assert set(late["series"].unique().to_list()) == {"ecmwf_ifs"}
    assert set(kept["series"].unique().to_list()) == {"ai"}


def test_final_obs_beats_provisional_and_snapshot_and_gap_days_come_from_obs_public(tmp_path: Path):
    obs = tmp_path / "obs"
    obs.mkdir()
    _obs_csv(obs / "obs-20261026.csv", "2026-10-26", 99.0)
    _obs_csv(obs / "obs-20261026.final.csv", "2026-10-26", 10.0)
    # 27 Oct is not in the repo. The snapshot's obs-public supplies temperature 10 °C.
    public_rows = []
    for hour in range(24):
        public_rows.append({
            "station_id": ST, "time": datetime(2026, 10, 27, hour, tzinfo=UTC),
            "step": "10min", "element": "T", "value": 10.0, "flag": None, "quality": 0,
        })
    public = pl.DataFrame(public_rows).with_columns(
        pl.col("time").cast(pl.Datetime("us", "UTC")), pl.col("value").cast(pl.Float32), pl.col("quality").cast(pl.Int8),
    )
    # D+1 of 25 Oct 00:00 is 26 Oct; D+2 is 27 Oct. AI is +1 °C on both days. model_a is exact.
    records = []
    records += _hours(SNAP, 24, 24, {"ai": 11.0, "model_a": 10.0})
    records += _hours(SNAP, 48, 24, {"ai": 11.0, "model_a": 10.0})
    snap = dp.LoadedSnap(row=_row(SNAP), frame=frame_from(records), obs_public=public)
    out = tmp_path / "data"
    catalog = dp.build_dataset([snap], obs, _stations(), out, withdrawn=["snap-20261023T0000Z"])
    assert catalog["withdrawn_skipped"] == ["snap-20261023T0000Z"]
    by_day = {item["day"]: item for item in catalog["obs_days"]}
    assert by_day["2026-10-26"]["quality"] == "final"
    assert by_day["2026-10-26"]["source"] == "obs/obs-20261026.final.csv"
    assert by_day["2026-10-27"]["quality"] == "provisional"
    assert "obs-public" in by_day["2026-10-27"]["source"]

    scores = json.loads((out / "scores.json").read_text(encoding="utf-8"))
    lead1 = scores["by_version"]["meteoverdict_ai-v2"]["temperature_2m"]["leads"]["1"]
    # Final file (10 °C) is what D+1 is scored against, not the provisional 99 °C.
    assert lead1["series"] == ["model_a", "ai"]
    assert lead1["mae"] == [0.0, 1.0]
    assert lead1["n"] == 24
    lead2 = scores["by_version"]["meteoverdict_ai-v2"]["temperature_2m"]["leads"]["2"]
    assert lead2["mae"] == [0.0, 1.0]  # gap day from obs-public, same truth
    overall = scores["by_version"]["meteoverdict_ai-v2"]["temperature_2m"]["overall"]
    assert overall["series"][0] == "model_a"
    assert overall["mae"][overall["series"].index("ai")] == 1.0

    assert catalog["leads"] == [0, 1, 2, 3, 4, 5]
    blob = (out / "snaps" / "20261025T0000Z.json.gz").read_bytes()
    assert blob[:2] == b"\x1f\x8b"
    import gzip
    doc = json.loads(gzip.decompress(blob))
    assert doc["enc"] == "delta-tenths-v1"
    assert doc["lead0"] == 0
    assert doc["hours"] >= 48
    temps = doc["v"]["temperature_2m"]
    ai_row = dp.decode_row(temps["s"][doc["series"].index("ai")].split(";")[0], doc["hours"])
    model_row = dp.decode_row(temps["s"][doc["series"].index("model_a")].split(";")[0], doc["hours"])
    obs_row = dp.decode_row(temps["obs"].split(";")[0], doc["hours"])
    # Lead 0 of this fixture has no forecast and no observation. D+1 starts at hour 24.
    assert ai_row[0] is None and obs_row[0] is None
    assert ai_row[24] == 11.0 and model_row[24] == 10.0 and obs_row[24] == 10.0
    assert ai_row[24] != model_row[24]
    # The late-run guard is covered separately; ECMWF is not in this frame.
    assert "ecmwf_ifs" not in doc["series"]
    # Ranking payload does not invent a winner field.
    assert "winner" not in lead1


def test_d0_is_scored_and_each_model_keeps_its_own_chart_row(tmp_path: Path):
    obs = tmp_path / "obs"
    obs.mkdir()
    _obs_csv(obs / "obs-20261025.csv", "2026-10-25", 10.0)
    # First 24 h after the snapshot: AI is +1 °C, model_a is +2 °C. No later hours, so D+1..D+5 stay empty.
    snap = dp.LoadedSnap(row=_row(SNAP), frame=frame_from(_hours(SNAP, 0, 24, {"ai": 11.0, "model_a": 12.0})))
    out = tmp_path / "data"
    catalog = dp.build_dataset([snap], obs, _stations(), out)
    assert catalog["leads"] == [0, 1, 2, 3, 4, 5]
    scores = json.loads((out / "scores.json").read_text(encoding="utf-8"))
    block = scores["by_version"]["meteoverdict_ai-v2"]["temperature_2m"]
    assert set(block["leads"]) == {"0"}
    assert block["leads"]["0"]["n"] == 24
    assert block["leads"]["0"]["series"] == ["ai", "model_a"]
    assert block["leads"]["0"]["mae"] == [1.0, 2.0]
    assert block["overall"]["leads_used"] == [0]
    import gzip
    doc = json.loads(gzip.decompress((out / "snaps" / "20261025T0000Z.json.gz").read_bytes()))
    assert doc["lead0"] == 0
    temps = doc["v"]["temperature_2m"]
    ai_row = dp.decode_row(temps["s"][doc["series"].index("ai")].split(";")[0], doc["hours"])
    model_row = dp.decode_row(temps["s"][doc["series"].index("model_a")].split(";")[0], doc["hours"])
    obs_row = dp.decode_row(temps["obs"].split(";")[0], doc["hours"])
    assert ai_row[0] == 11.0 and model_row[0] == 12.0 and obs_row[0] == 10.0
    assert ai_row[:24] != model_row[:24]


def test_provisional_repo_file_beats_snapshot_obs(tmp_path: Path):
    obs = tmp_path / "obs"
    obs.mkdir()
    _obs_csv(obs / "obs-20261026.csv", "2026-10-26", 10.0)
    public = pl.DataFrame({
        "station_id": [ST], "time": [datetime(2026, 10, 26, tzinfo=UTC)],
        "step": ["10min"], "element": ["T"], "value": [50.0], "flag": [None], "quality": [0],
    }).with_columns(pl.col("time").cast(pl.Datetime("us", "UTC")), pl.col("value").cast(pl.Float32), pl.col("quality").cast(pl.Int8))
    records = _hours(SNAP, 24, 24, {"ai": 11.0})
    snap = dp.LoadedSnap(row=_row(SNAP), frame=frame_from(records), obs_public=public)
    out = tmp_path / "data"
    dp.build_dataset([snap], obs, _stations(), out)
    scores = json.loads((out / "scores.json").read_text(encoding="utf-8"))
    lead = scores["by_version"]["meteoverdict_ai-v2"]["temperature_2m"]["leads"]["1"]
    assert lead["mae"] == [1.0]  # 11 vs provisional 10, not vs the snapshot's 50
    days = {item["day"]: item for item in json.loads((out / "catalog.json").read_text())["obs_days"]}
    assert days["2026-10-26"]["quality"] == "provisional"
    assert days["2026-10-26"]["source"] == "obs/obs-20261026.csv"


def test_withdrawn_is_a_catalog_fact_and_two_versions_stay_apart(tmp_path: Path):
    obs = tmp_path / "obs"
    obs.mkdir()
    _obs_csv(obs / "obs-20261026.csv", "2026-10-26", 10.0)
    records = _hours(SNAP, 24, 24, {"ai": 12.0, "model_a": 10.5})
    later = SNAP + timedelta(days=40)
    # No obs for the second version's valid times: it is recorded, not scored.
    snaps = [
        dp.LoadedSnap(row=_row(SNAP, "meteoverdict_ai-v2"), frame=frame_from(records)),
        dp.LoadedSnap(row=_row(later, "meteoverdict_ai-v3"), frame=frame_from(_hours(later, 24, 4, {"ai": 1.0}))),
    ]
    out = tmp_path / "data"
    catalog = dp.build_dataset(snaps, obs, _stations(), out, withdrawn=["snap-20261023T0000Z"])
    versions = {item["model_version"]: item for item in catalog["versions"]}
    assert versions["meteoverdict_ai-v2"]["key"] == "not_enough_data"
    assert versions["meteoverdict_ai-v2"]["days"] == 1
    assert versions["meteoverdict_ai-v3"]["days"] == 1
    scores = json.loads((out / "scores.json").read_text(encoding="utf-8"))
    assert "1" in scores["by_version"]["meteoverdict_ai-v2"]["temperature_2m"]["leads"]
    assert scores["by_version"]["meteoverdict_ai-v3"]["temperature_2m"]["leads"] == {}


def test_station_breakdown_uses_the_same_series(tmp_path: Path):
    obs = tmp_path / "obs"
    obs.mkdir()
    # Both stations, AI +1 °C, model_a exact at Cheb and +3 at Brno, so Brno is worse for model_a... 
    # Keep it simple: one value pattern written for both stations.
    lines = ["station_id,time,temperature_2m,wind_speed_10m,precipitation,wind_gusts_10m,cloud_cover,sunshine_duration"]
    for station, truth in ((ST, 10.0), (ST2, 10.0)):
        for hour in range(24):
            lines.append(f"{station},2026-10-26T{hour:02d}:00:00Z,{truth},,,,,")
    (obs / "obs-20261026.csv").write_text("\n".join(lines) + "\n", encoding="utf-8")
    rows = _hours(SNAP, 24, 24, {"ai": 11.0, "model_a": 10.0}, station=ST)
    rows += _hours(SNAP, 24, 24, {"ai": 13.0, "model_a": 10.0}, station=ST2)
    snap = dp.LoadedSnap(row=_row(SNAP), frame=frame_from(rows))
    out = tmp_path / "data"
    dp.build_dataset([snap], obs, _stations(), out)
    scores = json.loads((out / "scores.json").read_text(encoding="utf-8"))
    block = scores["by_version"]["meteoverdict_ai-v2"]["temperature_2m"]
    assert block["leads"]["1"]["series"] == ["model_a", "ai"]
    assert block["leads"]["1"]["mae"] == [0.0, 2.0]  # mean of |1| and |3|
    station = block["by_station"]["1"]
    cheb = station["ids"].index(ST)
    brno = station["ids"].index(ST2)
    ai = station["series"].index("ai")
    model = station["series"].index("model_a")
    assert station["mae"][ai][cheb] == 1.0
    assert station["mae"][ai][brno] == 3.0
    assert station["mae"][model][cheb] == 0.0
    assert station["n"][cheb] == 24 and station["n"][brno] == 24
