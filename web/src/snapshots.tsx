import { useEffect, useMemo, useState } from "react";
import { LineChart, type ChartSeries } from "./charts";
import { decodeStations, loadJson, preselect, seriesColor } from "./lib/codec";
import { fmtTime, seriesName } from "./lib/format";
import { inLead, leadOf, scoreRows, type Row } from "./lib/score";
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

/** Latest release whose D+1 window already overlaps the observations we have. */
function defaultSnap(catalog: Catalog): string[] {
  const last = catalog.obs_days[catalog.obs_days.length - 1]?.day;
  if (!last || catalog.snapshots.length === 0) {
    const newest = catalog.snapshots[catalog.snapshots.length - 1];
    return newest ? [newest.id] : [];
  }
  const horizon = Date.parse(`${last}T23:00:00Z`) - 30 * 3_600_000;
  const usable = catalog.snapshots.filter((snap) => Date.parse(snap.time) <= horizon);
  const pick = usable[usable.length - 1] ?? catalog.snapshots[catalog.snapshots.length - 1];
  return pick ? [pick.id] : [];
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

  const chart = useMemo(() => {
    const stationIndexIn = (file: SnapFile) => file.stations.indexOf(stationId);
    const times = new Set<string>();
    for (const { file } of loaded) {
      if (stationIndexIn(file) < 0) continue;
      for (let hour = 0; hour < file.hours; hour += 1) {
        const valid = hourIso(file.snapshot_time, file.lead0, hour);
        if (inLead(leadOf(valid, file.snapshot_time), lead)) times.add(valid);
      }
    }
    const labels = [...times].sort();
    const at = new Map(labels.map((iso, index) => [iso, index]));
    const obsValues = labels.map(() => null as number | null);
    const lines: ChartSeries[] = [];
    loaded.forEach(({ file }, snapIndex) => {
      const grid = gridOf(file, variable);
      const stationIndex = stationIndexIn(file);
      if (!grid || stationIndex < 0) return;
      for (let hour = 0; hour < file.hours; hour += 1) {
        const valid = hourIso(file.snapshot_time, file.lead0, hour);
        const index = at.get(valid);
        if (index == null) continue;
        const obs = grid.obs[stationIndex][hour];
        if (obs != null) obsValues[index] = obs;
      }
      file.series.forEach((id, seriesIndex) => {
        if (!selected.includes(id)) return;
        const values = labels.map(() => null as number | null);
        for (let hour = 0; hour < file.hours; hour += 1) {
          const valid = hourIso(file.snapshot_time, file.lead0, hour);
          const index = at.get(valid);
          if (index == null) continue;
          values[index] = grid.series[seriesIndex][stationIndex][hour];
        }
        const dash = ["", "7 4", "2 3", "9 3 2 3"][snapIndex % 4];
        lines.push({
          id: `${file.id}:${id}`,
          name: `${seriesName(catalog.names, id)} · ${fmtTime(file.snapshot_time)}`,
          color: seriesColor(id),
          values,
          dash,
          width: id === "ai" ? 2.4 : 1.7,
        });
      });
    });
    const obsLine: ChartSeries = { id: "obs", name: "Observation", color: "#1e2430", values: obsValues, width: 2.6 };
    return {
      labels: labels.map((iso) => fmtTime(iso).replace(" UTC", "")),
      series: labels.length ? [obsLine, ...lines] : [],
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
            {newestFirst.map((snap: CatalogSnap) => (
              <li key={snap.id}>
                <label>
                  <input type="checkbox" checked={picked.includes(snap.id)} onChange={() => toggle(snap.id)} />
                  <span>
                    <strong>{fmtTime(snap.time)}</strong>
                    <small>
                      {snap.model_version}
                      {errors[snap.id] ? ` — ${errors[snap.id]}` : ""}
                    </small>
                  </span>
                </label>
              </li>
            ))}
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
                { value: "all" as LeadPick, label: "D+1–D+5" },
                ...catalog.leads.map((item) => ({ value: item as LeadPick, label: `D+${item}` })),
              ]}
              onChange={setLead}
            />
            <Segmented
              label="Score"
              value={scope}
              options={[
                { value: "network", label: "All 40 stations" },
                { value: "station", label: "This station" },
              ]}
              onChange={setScope}
            />
          </div>
          <p className="hint">
            Chart values are rounded to 0.1 {unit}. The numbers below are computed in the browser from those rounded
            values, on the common pairs of the releases you tick. The whole-period table uses full precision.
            {scope === "station" ? " One station uses a floor of 6 pairs; the 40-station score uses the catalog floor." : ""}
          </p>
          {waiting && <p className="banner">Loading {picked.length} snapshot {picked.length === 1 ? "file" : "files"}…</p>}
          {station && chart.series.length > 0 && (
            <figure>
              <figcaption>
                {station.name} · {catalog.variable_labels[variable] ?? variable} ({unit}) · observation in ink
              </figcaption>
              <LineChart labels={chart.labels} series={chart.series} ariaLabel={`Forecast and observation at ${station.name}`} yLabel={unit} />
            </figure>
          )}
          {!waiting && picked.length > 0 && (!scored || scored.series.length === 0) && (
            <p className="banner">
              These releases have no observed hours in the selected window yet. The chart still shows the forecast where
              it was issued.
            </p>
          )}
          {scored && scored.series.length > 0 && (
            <>
              <SeriesToggles ids={scored.series} names={catalog.names} selected={selected} onChange={setSelected} />
              <p className="fair">
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
