import { useEffect, useMemo, useState } from "react";
import { LineChart } from "./charts";
import { decodeStations, loadJson, preselect, seriesColor } from "./lib/codec";
import { fmtTime, seriesName } from "./lib/format";
import { combineLeadFacts, emptyLeadTitle, factsFromHours, leadState, releaseCoverageThin, type LeadFact } from "./lib/coverage";
import { leadWindow } from "./lib/leads";
import { inLead, leadOf, scoreRows, type Row } from "./lib/score";
import { buildSnapshotChart, type StationGrid } from "./lib/snapshotChart";
import type { Catalog, CatalogSnap, LeadPick, SnapFile } from "./types";
import { ExcludedList, ScoreTable, Segmented, SeriesToggles } from "./widgets";

const BASE = import.meta.env.BASE_URL;

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

/**
 * Latest release whose lead-0 hours can still meet an observation.
 * The newest snapshot on the last obs day often starts after the hours that file actually contains,
 * so the chart would be forecasts only. Twelve hours of margin keeps a dotted observation on screen.
 */
function defaultSnap(catalog: Catalog): string[] {
  const last = catalog.obs_days[catalog.obs_days.length - 1]?.day;
  if (!last || catalog.snapshots.length === 0) {
    const newest = catalog.snapshots[catalog.snapshots.length - 1];
    return newest ? [newest.id] : [];
  }
  const horizon = Date.parse(`${last}T23:00:00Z`) - 12 * 3_600_000;
  const usable = catalog.snapshots.filter((snap) => Date.parse(snap.time) <= horizon);
  const pick = usable[usable.length - 1] ?? catalog.snapshots[catalog.snapshots.length - 1];
  return pick ? [pick.id] : [];
}

function fileLeadFacts(file: SnapFile, variable: string): LeadFact[] {
  const grid = gridOf(file, variable);
  if (!grid) return factsFromHours(file.lead0, [], []);
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
  return factsFromHours(file.lead0, hourHasObs, hourHasModel);
}

export function Snapshots({ catalog }: { catalog: Catalog }) {
  const [picked, setPicked] = useState<string[]>(() => defaultSnap(catalog));
  const [files, setFiles] = useState<Record<string, SnapFile>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [stationId, setStationId] = useState(() => {
    const praha = catalog.stations.find((station) => station.name.includes("Praha"));
    const sorted = [...catalog.stations].sort((a, b) => a.name.localeCompare(b.name, "cs"));
    return (praha ?? sorted[0])?.id ?? "";
  });
  const [variable, setVariable] = useState(catalog.chart_variables[0] ?? "temperature_2m");
  const [lead, setLead] = useState<LeadPick>("all");
  const [scope, setScope] = useState<"network" | "station">("network");
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    let cancel = false;
    for (const id of picked) {
      if (files[id] || errors[id]) continue;
      const meta = catalog.snapshots.find((snap) => snap.id === id);
      if (!meta) continue;
      loadJson(`${BASE}data/${meta.file}`)
        .then((doc) => {
          if (!cancel) setFiles((prev) => ({ ...prev, [id]: doc as SnapFile }));
        })
        .catch((error: unknown) => {
          if (!cancel) setErrors((prev) => ({ ...prev, [id]: error instanceof Error ? error.message : String(error) }));
        });
    }
    return () => {
      cancel = true;
    };
    // files/errors are read only to skip ids already stored; listing them would cancel in-flight loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, catalog.snapshots]);

  const loaded = useMemo(
    () =>
      picked.flatMap((id) => {
        const meta = catalog.snapshots.find((snap) => snap.id === id);
        const file = files[id];
        return meta && file ? [{ meta, file }] : [];
      }),
    [picked, files, catalog.snapshots],
  );

  const scored = useMemo(() => {
    const rows: Row[] = [];
    for (const { file } of loaded) {
      const grid = gridOf(file, variable);
      if (!grid) continue;
      file.stations.forEach((sid, stationIndex) => {
        if (scope === "station" && sid !== stationId) return;
        for (let hour = 0; hour < file.hours; hour += 1) {
          const valid = hourIso(file.snapshot_time, file.lead0, hour);
          const leadHours = leadOf(valid, file.snapshot_time);
          if (!inLead(leadHours, lead)) continue;
          const obs = grid.obs[stationIndex][hour];
          if (obs == null) continue;
          const values: Record<string, number | null> = {};
          file.series.forEach((name, seriesIndex) => {
            values[name] = grid.series[seriesIndex][stationIndex][hour];
          });
          rows.push({ obs, values });
        }
      });
    }
    const minPairs = scope === "station" ? 6 : catalog.thresholds.min_pairs;
    return scoreRows(rows, minPairs, catalog.thresholds.keep_fraction);
  }, [loaded, variable, lead, scope, stationId, catalog.thresholds]);

  const fileSeries = loaded.map((item) => `${item.file.id}:${item.file.series.join(",")}`).join("|");
  const preset = scored
    ? `score|${scored.series.join()}|${scored.mae.join()}|${picked.join()}|${variable}|${lead}|${scope}|${stationId}`
    : `forecast|${fileSeries}|${variable}|${lead}|${stationId}`;
  useEffect(() => {
    if (scored && scored.series.length > 0) {
      setSelected(preselect(scored.series, scored.mae));
      return;
    }
    const present = [...new Set(loaded.flatMap((item) => item.file.series))];
    const others = present.filter((id) => id !== "ai").slice(0, 2);
    setSelected(present.includes("ai") ? ["ai", ...others] : others);
  }, [preset]);

  const leadFacts = useMemo(
    () => loaded.map(({ file }) => fileLeadFacts(file, variable)),
    [loaded, variable],
  );

  useEffect(() => {
    if (lead === "all" || loaded.length === 0) return;
    if (lead < 0 || lead >= leadFacts[0]?.length) return;
    const combined = combineLeadFacts(leadFacts.map((facts) => facts[lead] ?? { hasSeries: false, obsHours: 0 }));
    if (leadState(combined.hasSeries, combined.obsHours, combined.windowHours) === "empty") setLead("all");
  }, [lead, loaded.length, leadFacts]);

  const chart = useMemo(() => {
    const grids: StationGrid[] = [];
    for (const { file } of loaded) {
      const grid = gridOf(file, variable);
      const stationIndex = file.stations.indexOf(stationId);
      if (!grid || stationIndex < 0) continue;
      grids.push({
        id: file.id,
        snapshotTime: file.snapshot_time,
        lead0: file.lead0,
        hours: file.hours,
        seriesIds: file.series,
        obs: grid.obs[stationIndex],
        values: grid.series.map((rows) => rows[stationIndex]),
      });
    }
    const built = buildSnapshotChart({
      grids,
      selected,
      lead,
      names: catalog.names,
      color: seriesColor,
      snapLabel: (iso) => fmtTime(iso),
    });
    return {
      labels: built.times.map((iso) => fmtTime(iso).replace(" UTC", "")),
      series: built.series,
      obsPoints: built.obsPoints,
    };
  }, [loaded, stationId, variable, lead, selected, catalog.names]);

  const station = catalog.stations.find((item) => item.id === stationId);
  const unit = catalog.units[variable] ?? "";
  const waiting = picked.some((id) => !files[id] && !errors[id]);

  function toggle(id: string) {
    setPicked((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }

  const newestFirst = [...catalog.snapshots].reverse();

  return (
    <section className="view">
      <div className="snap-layout">
        <div className="picker">
          <div className="picker-head">
            <h2>Releases</h2>
            <button
              type="button"
              className="text-btn"
              onClick={() => {
                const latest = catalog.snapshots[catalog.snapshots.length - 1];
                setPicked(latest ? [latest.id] : []);
              }}
            >
              Latest only
            </button>
          </div>
          <ul>
            {newestFirst.map((snap: CatalogSnap) => {
              const thin = releaseCoverageThin(snap.d0_obs_hours, snap.d0_window_hours ?? 24);
              const obsNote =
                snap.d0_obs_hours == null
                  ? ""
                  : ` · D+0 obs ${snap.d0_obs_hours}/${snap.d0_window_hours ?? 24}`;
              return (
                <li key={snap.id} className={thin ? "thin" : undefined}>
                  <label
                    title={
                      thin
                        ? `ČHMÚ covers ${snap.d0_obs_hours} of ${snap.d0_window_hours ?? 24} hours in this release's D+0 window`
                        : undefined
                    }
                  >
                    <input type="checkbox" checked={picked.includes(snap.id)} onChange={() => toggle(snap.id)} />
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
                { value: "all" as LeadPick, label: "D+0–D+5", title: "Every hour stored in the snapshot file, from lead 0" },
                ...catalog.leads.map((item) => {
                  const combined =
                    loaded.length === 0
                      ? null
                      : combineLeadFacts(leadFacts.map((facts) => facts[item] ?? { hasSeries: false, obsHours: 0 }));
                  const state = combined ? leadState(combined.hasSeries, combined.obsHours, combined.windowHours) : "ok";
                  return {
                    value: item as LeadPick,
                    label: `D+${item}`,
                    dim: state === "thin",
                    disabled: state === "empty",
                    title:
                      state === "empty"
                        ? emptyLeadTitle(item)
                        : combined
                          ? `${leadWindow(item).label} · ČHMÚ covers ${combined.obsHours} of ${combined.windowHours} hours`
                          : leadWindow(item).label,
                  };
                }),
              ]}
              onChange={setLead}
            />
            <Segmented
              label="MAE sample"
              value={scope}
              options={[
                {
                  value: "network",
                  label: "All 40 stations",
                  title: "The table scores every station. The chart stays the station selected above.",
                },
                {
                  value: "station",
                  label: "This station",
                  title: "The table scores only the station selected above. The chart is that same station.",
                },
              ]}
              onChange={setScope}
            />
          </div>
          <p className="hint" data-testid="mae-scope">
            {scope === "network" ? (
              <>
                MAE sample: all {catalog.stations.length} stations
                {scored ? `, ${scored.n.toLocaleString("en-GB")} common pairs` : ""}. The chart is only{" "}
                {station?.name ?? "the selected station"}.
              </>
            ) : (
              <>
                MAE sample: {station?.name ?? "this station"} only
                {scored ? `, ${scored.n.toLocaleString("en-GB")} common pairs` : ""}. Same station as the chart.
              </>
            )}
          </p>
          <p className="hint">
            Chart values are rounded to 0.1 {unit}. Each selected model is its own solid line. The dotted line is the
            ČHMÚ observation for this station, drawn only on the same hours as those model lines. A dimmed release or
            lead has observations for under half of its 24-hour window. A lead with no model series is disabled.
            The numbers below use the MAE sample chosen above, on the common pairs of the releases you tick.
            {scope === "station" ? " One station uses a floor of 6 pairs; all 40 stations use the catalog floor." : ""}
          </p>
          {waiting && <p className="banner">Loading {picked.length} snapshot {picked.length === 1 ? "file" : "files"}…</p>}
          {!waiting && picked.length > 0 && chart.series.length === 0 && (
            <div className="lead-empty" role="status" data-testid="snap-lead-empty">
              <h2>{lead === "all" ? "No hours to draw" : `D+${lead} has no hours in these releases`}</h2>
              <p>
                {lead === "all"
                  ? "The ticked snapshot files have no chart hours for this station and variable."
                  : `D+${lead} is ${leadWindow(lead).label} (valid time − snapshot time in [${lead * 24}, ${lead * 24 + 24}) hours). None of the ticked releases store an hour in that window, so there is no line to draw.`}
                {" "}A later lead stays empty until the forecast reaches it and, for a score, until an observation exists there.
              </p>
            </div>
          )}
          {station && chart.series.length > 0 && (
            <figure>
              <figcaption>
                {station.name} · {catalog.variable_labels[variable] ?? variable} ({unit})
                {chart.obsPoints > 0
                  ? ` · ${chart.obsPoints} observation hours`
                  : " · no observation in this window"}
              </figcaption>
              <LineChart labels={chart.labels} series={chart.series} ariaLabel={`Forecast and observation at ${station.name}`} yLabel={unit} />
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
          {!waiting && chart.series.length > 0 && chart.obsPoints === 0 && (
            <p className="banner">
              No ČHMÚ observation for {station?.name ?? "this station"} in the selected window. The dotted line appears
              when the snapshot file has a value at that station-hour. The solid lines are the forecasts that were issued.
            </p>
          )}
          {!waiting && picked.length > 0 && chart.obsPoints > 0 && (!scored || scored.series.length === 0) && (
            <p className="banner">
              These releases have observations in the chart, but not enough common pairs to score the selected window yet.
            </p>
          )}
          {scored && scored.series.length > 0 && (
            <>
              <SeriesToggles ids={scored.series} names={catalog.names} selected={selected} onChange={setSelected} />
              <p className="fair">
                {scope === "network" ? `All ${catalog.stations.length} stations` : station?.name ?? "This station"}:{" "}
                {scored.n.toLocaleString("en-GB")} common pairs
                {scored.aiPairs !== scored.n ? ` (${scored.aiPairs.toLocaleString("en-GB")} with an AI value and an observation)` : ""}.
                {scored.short ? " Short sample." : ""} Same hours for every series in the table.
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
