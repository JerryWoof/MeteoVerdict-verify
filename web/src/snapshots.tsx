import { useEffect, useMemo, useRef, useState } from "react";
import { LineChart } from "./charts";
import { forecastDates, fullAxis, leadDayAxis, showClockTick, utcMidnight, type AxisTick } from "./lib/chartAxis";
import { decodeStations, loadJson, preselect, seriesColor } from "./lib/codec";
import { calendarDayFacts, emptyLeadTitle, leadState, releaseCoverageThin, type LeadFact } from "./lib/coverage";
import { fmtTime, seriesName } from "./lib/format";
import { scoreRows, type Row } from "./lib/score";
import { loadSelection, saveSelection } from "./lib/selectionMemory";
import { buildSnapshotChart, type StationGrid } from "./lib/snapshotChart";
import type { Catalog, CatalogSnap, LeadPick, SnapFile } from "./types";
import { ExcludedList, ScoreTable, Segmented, SeriesToggles } from "./widgets";

const BASE = import.meta.env.BASE_URL;
const STATION_FLOOR = 6;

function hourIso(snapshotIso: string, lead0: number, hour: number): string {
  return new Date(Date.parse(snapshotIso) + (lead0 + hour) * 3_600_000).toISOString();
}

function gridOf(file: SnapFile, variable: string): { obs: (number | null)[][]; series: (number | null)[][][] } | null {
  const block = file.v[variable];
  if (!block || file.hours === 0) return null;
  return {
    obs: decodeStations(block.obs, file.stations.length, file.hours, file.scale),
    series: block.s.map((row) => decodeStations(row, file.stations.length, file.hours, file.scale)),
  };
}

function latestPerDay(snaps: CatalogSnap[]): CatalogSnap[] {
  const byDay = new Map<string, CatalogSnap>();
  for (const snap of snaps) {
    const day = snap.time.slice(0, 10);
    const prev = byDay.get(day);
    if (!prev || snap.time > prev.time) byDay.set(day, snap);
  }
  return [...byDay.values()].sort((a, b) => a.time.localeCompare(b.time));
}

function pickDefault(snaps: CatalogSnap[]): string {
  return snaps[snaps.length - 1]?.id ?? "";
}

function inCalendarDay(validIso: string, snapshotIso: string, lead: LeadPick): boolean {
  const ms = Date.parse(validIso);
  const origin = utcMidnight(snapshotIso);
  if (lead === "all") return ms >= origin;
  const start = origin + lead * 86_400_000;
  return ms >= start && ms < start + 86_400_000;
}

function fileCalendarFacts(file: SnapFile, variable: string): LeadFact[] {
  const grid = gridOf(file, variable);
  if (!grid) return calendarDayFacts(file.snapshot_time, file.lead0, [], []);
  const hourHasObs = Array.from({ length: file.hours }, () => false);
  const hourHasModel = Array.from({ length: file.hours }, () => false);
  for (let station = 0; station < file.stations.length; station += 1) {
    for (let hour = 0; hour < file.hours; hour += 1) {
      if (grid.obs[station]?.[hour] != null) hourHasObs[hour] = true;
      if (hourHasModel[hour]) continue;
      for (const rows of grid.series) {
        if (rows[station]?.[hour] != null) {
          hourHasModel[hour] = true;
          break;
        }
      }
    }
  }
  return calendarDayFacts(file.snapshot_time, file.lead0, hourHasObs, hourHasModel);
}

export function Snapshots({ catalog }: { catalog: Catalog }) {
  const [listMode, setListMode] = useState<"latest" | "all">("latest");
  const [releaseId, setReleaseId] = useState(() => pickDefault(latestPerDay(catalog.snapshots)));
  const [files, setFiles] = useState<Record<string, SnapFile>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [stationId, setStationId] = useState(() => {
    const praha = catalog.stations.find((station) => station.name.includes("Praha"));
    const sorted = [...catalog.stations].sort((a, b) => a.name.localeCompare(b.name, "cs"));
    return (praha ?? sorted[0])?.id ?? "";
  });
  const [variable, setVariable] = useState(catalog.chart_variables[0] ?? "temperature_2m");
  const [lead, setLead] = useState<LeadPick>("all");
  const [selected, setSelected] = useState<string[]>([]);
  const custom = useRef(loadSelection("snapshots") != null);

  const visible = useMemo(() => {
    const chronological = [...catalog.snapshots].sort((a, b) => a.time.localeCompare(b.time));
    return listMode === "latest" ? latestPerDay(chronological) : chronological;
  }, [catalog.snapshots, listMode]);

  useEffect(() => {
    if (visible.some((snap) => snap.id === releaseId)) return;
    setReleaseId(pickDefault(visible));
  }, [visible, releaseId]);

  useEffect(() => {
    if (!releaseId || files[releaseId] || errors[releaseId]) return;
    let cancel = false;
    const meta = catalog.snapshots.find((snap) => snap.id === releaseId);
    if (!meta) return;
    loadJson(`${BASE}data/${meta.file}`)
      .then((doc) => {
        if (!cancel) setFiles((prev) => ({ ...prev, [releaseId]: doc as SnapFile }));
      })
      .catch((error: unknown) => {
        if (!cancel) setErrors((prev) => ({ ...prev, [releaseId]: error instanceof Error ? error.message : String(error) }));
      });
    return () => {
      cancel = true;
    };
  }, [releaseId, files, errors, catalog.snapshots]);

  const file = releaseId ? files[releaseId] : undefined;

  const scored = useMemo(() => {
    if (!file) return null;
    const grid = gridOf(file, variable);
    if (!grid) return null;
    const rows: Row[] = [];
    file.stations.forEach((sid, stationIndex) => {
      if (sid !== stationId) return;
      for (let hour = 0; hour < file.hours; hour += 1) {
        const valid = hourIso(file.snapshot_time, file.lead0, hour);
        if (!inCalendarDay(valid, file.snapshot_time, lead)) continue;
        const obs = grid.obs[stationIndex][hour];
        if (obs == null) continue;
        const values: Record<string, number | null> = {};
        file.series.forEach((name, seriesIndex) => {
          values[name] = grid.series[seriesIndex][stationIndex][hour];
        });
        rows.push({ obs, values });
      }
    });
    return scoreRows(rows, STATION_FLOOR, catalog.thresholds.keep_fraction);
  }, [file, variable, lead, stationId, catalog.thresholds.keep_fraction]);

  const preset = scored
    ? `score|${scored.series.join()}|${scored.mae.join()}|${releaseId}|${variable}|${lead}|${stationId}`
    : `forecast|${file?.series.join(",") ?? ""}|${releaseId}|${variable}|${lead}|${stationId}`;
  useEffect(() => {
    const available = scored && scored.series.length > 0 ? scored.series : (file?.series ?? []);
    if (available.length === 0) {
      if (!custom.current) setSelected([]);
      return;
    }
    if (custom.current) {
      setSelected((loadSelection("snapshots") ?? []).filter((id) => available.includes(id)));
      return;
    }
    setSelected(preselect(available, scored && scored.series.length > 0 ? scored.mae : []));
  }, [preset]);

  const leadFacts = useMemo(() => (file ? fileCalendarFacts(file, variable) : []), [file, variable]);

  useEffect(() => {
    if (lead === "all" || !file) return;
    const fact = leadFacts[lead];
    if (!fact) return;
    const state = leadState(fact.hasSeries, fact.obsHours, fact.hasSeries ? 24 : 0);
    if (state === "empty") setLead("all");
  }, [lead, file, leadFacts]);

  const chart = useMemo(() => {
    if (!file) return null;
    const grid = gridOf(file, variable);
    const stationIndex = file.stations.indexOf(stationId);
    if (!grid || stationIndex < 0 || file.hours <= 0) return null;
    const stationGrid: StationGrid = {
      id: file.id,
      snapshotTime: file.snapshot_time,
      lead0: file.lead0,
      hours: file.hours,
      seriesIds: file.series,
      obs: grid.obs[stationIndex],
      values: grid.series.map((rows) => rows[stationIndex]),
    };
    const lastIso = hourIso(file.snapshot_time, file.lead0, file.hours - 1);
    const ticks: AxisTick[] = lead === "all" ? fullAxis(file.snapshot_time, lastIso) : leadDayAxis(file.snapshot_time, lead);
    const spanHours = Math.max(ticks.length - 1, 1);
    const built = buildSnapshotChart({
      grids: [stationGrid],
      selected,
      lead: "all",
      names: catalog.names,
      color: seriesColor,
      plainNames: true,
      axis: { times: ticks.map((tick) => tick.iso), endExclusiveMs: ticks[ticks.length - 1]?.ms ?? 0 },
    });
    return {
      labels: ticks.map((tick) => tick.clock),
      hover: ticks.map((tick) => (tick.terminal ? tick.clock : `D+${tick.lead} · ${tick.clock}`)),
      tickAt: ticks.map((tick) => showClockTick(tick, spanHours)),
      marks: ticks.flatMap((tick, index) => (tick.dayStart ? [{ index, text: `D+${tick.lead}` }] : [])),
      dates: forecastDates(ticks),
      series: built.series,
      obsPoints: built.obsPoints,
    };
  }, [file, stationId, variable, lead, selected, catalog.names]);

  const station = catalog.stations.find((item) => item.id === stationId);
  const unit = catalog.units[variable] ?? "";
  const waiting = Boolean(releaseId && !file && !errors[releaseId]);
  const toggleIds = scored && scored.series.length > 0 ? scored.series : (file?.series ?? []);

  function changeSeries(ids: string[]) {
    custom.current = true;
    saveSelection("snapshots", ids);
    setSelected(ids);
  }

  return (
    <section className="view">
      <div className="snap-layout">
        <div className="picker">
          <div className="picker-head">
            <h2>Releases</h2>
          </div>
          <div className="picker-filter" role="radiogroup" aria-label="Release list">
            <button type="button" className={listMode === "all" ? "active" : ""} onClick={() => setListMode("all")}>
              All
            </button>
            <button type="button" className={listMode === "latest" ? "active" : ""} onClick={() => setListMode("latest")}>
              Latest from each day
            </button>
          </div>
          <ul>
            {visible.map((snap: CatalogSnap) => {
              const thin = releaseCoverageThin(snap.d0_obs_hours, snap.d0_window_hours ?? 24);
              const obsNote = snap.d0_obs_hours == null ? "" : ` · D+0 obs ${snap.d0_obs_hours}/${snap.d0_window_hours ?? 24}`;
              return (
                <li key={snap.id} className={thin ? "thin" : undefined}>
                  <label
                    title={
                      thin
                        ? `ČHMÚ covers ${snap.d0_obs_hours} of ${snap.d0_window_hours ?? 24} hours in this release's D+0 window`
                        : undefined
                    }
                  >
                    <input
                      type="radio"
                      name="release"
                      checked={releaseId === snap.id}
                      onChange={() => setReleaseId(snap.id)}
                    />
                    <span>
                      <strong>{fmtTime(snap.time)}</strong>
                      <small>
                        {snap.model_version}
                        {obsNote}
                        {errors[snap.id] ? ` — ${errors[snap.id]}` : ""}
                      </small>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
        <div>
          <div className="controls">
            <label className="station-pick">
              Station
              <select value={stationId} onChange={(event) => setStationId(event.target.value)}>
                {[...catalog.stations]
                  .sort((a, b) => a.name.localeCompare(b.name, "cs"))
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
              </select>
            </label>
            <Segmented
              label="Variable"
              value={variable}
              options={catalog.chart_variables.map((id) => ({ value: id, label: catalog.variable_labels[id] ?? id }))}
              onChange={setVariable}
            />
            <Segmented
              label="Lead"
              value={lead}
              options={[
                { value: "all" as LeadPick, label: "Full", title: "Every day stored in this release, from 00:00 on the snapshot date" },
                ...catalog.leads.map((item) => {
                  const fact = file ? (leadFacts[item] ?? { hasSeries: false, obsHours: 0 }) : null;
                  const state = fact ? leadState(fact.hasSeries, fact.obsHours, fact.hasSeries ? 24 : 0) : "ok";
                  const stamp = file ? forecastDates(leadDayAxis(file.snapshot_time, item))[0] : "";
                  return {
                    value: item as LeadPick,
                    label: `D+${item}`,
                    dim: state === "thin",
                    disabled: state === "empty",
                    title:
                      state === "empty"
                        ? emptyLeadTitle(item)
                        : fact
                          ? `${stamp} 00:00–00:00 · ČHMÚ covers ${fact.obsHours} of 24 hours`
                          : `D+${item}`,
                  };
                }),
              ]}
              onChange={setLead}
            />
          </div>
          <p className="hint">
            One release, one station. The dotted line is the ČHMÚ observation on the same hours as the selected models.
          </p>
          {waiting && <p className="banner">Loading the release…</p>}
          {!waiting && releaseId && (!chart || chart.series.length === 0) && (
            <div className="lead-empty" role="status" data-testid="snap-lead-empty">
              <h2>{lead === "all" ? "No hours to draw" : `D+${lead} has no hours in this release`}</h2>
              <p>
                {lead === "all"
                  ? "This release has no chart hours for this station and variable."
                  : `D+${lead} is the UTC day ${file ? forecastDates(leadDayAxis(file.snapshot_time, lead))[0] : ""}, 00:00 to the next 00:00. This release has no model value on that day.`}
              </p>
            </div>
          )}
          {station && chart && chart.series.length > 0 && (
            <figure>
              <figcaption>
                {station.name} · {catalog.variable_labels[variable] ?? variable}
                {chart.obsPoints > 0 ? ` · ${chart.obsPoints} observation hours` : " · no observation in this window"}
              </figcaption>
              <p className="forecast-for">Forecasts for: {chart.dates.join(", ")}</p>
              <LineChart
                labels={chart.labels}
                hoverText={chart.hover}
                tickAt={chart.tickAt}
                marks={chart.marks}
                series={chart.series}
                ariaLabel={`Forecast and observation at ${station.name}`}
                yLabel={unit}
              />
              <ul className="legend">
                {chart.series.map((line) => (
                  <li key={line.id}>
                    <i className={line.dash ? "dotted" : ""} style={{ borderTopColor: line.color }} />
                    {line.name}
                  </li>
                ))}
              </ul>
            </figure>
          )}
          {!waiting && chart && chart.series.length > 0 && chart.obsPoints === 0 && (
            <p className="banner">
              No ČHMÚ observation for {station?.name ?? "this station"} inside the model hours of this window. The dotted
              line appears where the release has a measurement on the same hours as the selected models.
            </p>
          )}
          {toggleIds.length > 0 && <SeriesToggles ids={toggleIds} names={catalog.names} selected={selected} onChange={changeSeries} />}
          {scored && scored.series.length > 0 && (
            <>
              <p className="fair">
                {station?.name ?? "This station"}: {scored.n.toLocaleString("en-GB")} common pairs
                {scored.aiPairs !== scored.n ? ` (${scored.aiPairs.toLocaleString("en-GB")} with an AI value and an observation)` : ""}.
                {scored.short ? " Short sample." : ""} Same hours for every series in the table. One station uses a floor of {STATION_FLOOR} pairs.
              </p>
              <ScoreTable names={catalog.names} unit={unit} series={scored.series} mae={scored.mae} bias={scored.bias} rmse={scored.rmse} />
              <ExcludedList
                items={scored.excluded.map((item) => ({ ...item, name: seriesName(catalog.names, item.k) }))}
                names={catalog.names}
              />
            </>
          )}
          <p className="hint">
            Cloud cover, sunshine and part-of-day gusts are in the whole-period scores. The snapshot chart carries
            temperature, wind speed and precipitation, which is what fits the size budget.
          </p>
        </div>
      </div>
    </section>
  );
}
