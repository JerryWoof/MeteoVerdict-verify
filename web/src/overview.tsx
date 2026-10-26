import { useEffect, useMemo, useState } from "react";
import { BarChart, LineChart } from "./charts";
import { preselect, seriesColor } from "./lib/codec";
import { fmt, fmtDay, fmtTime, seriesName } from "./lib/format";
import { emptyLeadTitle, scoredLeadVisual } from "./lib/coverage";
import { firstScoredLead, leadOpensAfterObservations, leadPairCount, leadWindow } from "./lib/leads";
import { unweighted } from "./lib/score";
import type { Catalog, LeadPick, VariableScore } from "./types";
import { ExcludedList, ObsNote, ScoreTable, Segmented, SeriesToggles } from "./widgets";

function LeadGap({
  catalog,
  variableLabel,
  lead,
  counts,
}: {
  catalog: Catalog;
  variableLabel: string;
  lead: number;
  counts: { lead: number; n: number }[];
}) {
  const band = leadWindow(lead);
  const lastObs = catalog.obs_days[catalog.obs_days.length - 1];
  const earliest = catalog.snapshots[0]?.time;
  const opened = leadOpensAfterObservations(lead, earliest, lastObs?.day);
  return (
    <div className="lead-empty" role="status" data-testid="lead-empty">
      <h2>D+{lead} has no scored station-hours</h2>
      <p>
        {variableLabel} at D+{lead} has <strong>n = 0</strong>. There is no MAE series, so the charts and the station
        table are not drawn. An empty axis here would look like a broken chart.
      </p>
      <p>
        D+{lead} is valid time minus snapshot time in [{band.start}, {band.start + 24}) hours ({band.label}).
        A station-hour counts only when the forecast and a ČHMÚ observation both exist. Nothing is filled from an
        older run.
      </p>
      {opened.afterObservations && opened.opensAt && earliest && lastObs ? (
        <p>
          The earliest snapshot in this catalog is {fmtTime(earliest)}. Its D+{lead} window opens at{" "}
          {fmtTime(opened.opensAt)}, which is after the latest observation hour we have ({lastObs.day} 23:00 UTC,{" "}
          {lastObs.quality}). That is why this lead is empty: the observations have not reached it yet.
        </p>
      ) : (
        <p>
          This window overlaps the observations on record
          {lastObs ? ` (latest ${lastObs.day}, ${lastObs.quality})` : ""}, but this variable still has no common
          pairs in it. The AI and an observation have to land on the same station-hour, and the sample has to clear
          the scoring floor, before a number appears.
        </p>
      )}
      <p>
        Pair counts for {variableLabel}: {counts.map((item) => `D+${item.lead} ${item.n.toLocaleString("en-GB")}`).join(", ")}.
      </p>
    </div>
  );
}

function valueAt(series: string[], values: number[], id: string): number | null {
  const index = series.indexOf(id);
  return index < 0 ? null : values[index];
}

export function Overview({
  catalog,
  byVariable,
  modelVersion,
}: {
  catalog: Catalog;
  byVariable: Record<string, VariableScore> | null;
  modelVersion: string;
}) {
  const initialVariable = catalog.primary[0] ?? catalog.variables[0];
  const [variable, setVariable] = useState(initialVariable);
  const [lead, setLead] = useState<LeadPick>(() => firstScoredLead(catalog.leads, byVariable?.[initialVariable]));
  const [selected, setSelected] = useState<string[]>([]);
  const [stationSort, setStationSort] = useState<string>("name");
  const [allStationColumns, setAllStationColumns] = useState(false);

  const active = byVariable?.[variable] ?? null;
  const counts = catalog.leads.map((item) => {
    const doc = active?.leads[String(item)];
    return { lead: item, n: leadPairCount(active, item), visual: scoredLeadVisual(doc), doc };
  });
  const leadEmpty = lead !== "all" && counts.find((item) => item.lead === lead)?.visual === "empty";

  useEffect(() => {
    if (lead === "all") return;
    if (scoredLeadVisual(active?.leads[String(lead)]) === "empty") setLead(firstScoredLead(catalog.leads, active));
  }, [lead, active, catalog.leads]);
  const leadKey = lead === "all" ? null : String(lead);
  const block = leadKey ? active?.leads[leadKey] : null;
  const overall = active?.overall;
  const ranked = lead === "all" ? overall : block;
  const preset = ranked && ranked.series.length ? preselect(ranked.series, ranked.mae).join("|") : "";

  useEffect(() => {
    if (!ranked || ranked.series.length === 0) {
      setSelected([]);
      return;
    }
    setSelected(preselect(ranked.series, ranked.mae));
  }, [variable, lead, modelVersion, preset]);

  const unit = catalog.units[variable] ?? "";
  const names = catalog.names;

  const dayChart = useMemo(() => {
    if (!active) return null;
    const days = active.by_day.days;
    const lines = selected.map((id) => {
      const values = days.map((_, dayIndex) => {
        if (lead === "all") {
          const samples: number[] = [];
          for (const doc of Object.values(active.by_day.leads)) {
            if (doc.n[dayIndex] <= 0) continue;
            const seriesIndex = doc.series.indexOf(id);
            const value = seriesIndex < 0 ? null : doc.mae[seriesIndex][dayIndex];
            if (value != null) samples.push(value);
          }
          return unweighted(samples);
        }
        const doc = active.by_day.leads[String(lead)];
        if (!doc || doc.n[dayIndex] <= 0) return null;
        const seriesIndex = doc.series.indexOf(id);
        return seriesIndex < 0 ? null : doc.mae[seriesIndex][dayIndex];
      });
      return { id, name: seriesName(names, id), color: seriesColor(id), values };
    });
    return { labels: days.map(fmtDay), series: lines };
  }, [active, selected, lead, names]);

  const leadBars = useMemo(() => {
    if (!active) return null;
    const labels = catalog.leads.map((item) => `D+${item}`);
    const lines = selected.map((id) => ({
      id,
      name: seriesName(names, id),
      color: seriesColor(id),
      values: catalog.leads.map((item) => {
        const doc = active.leads[String(item)];
        return doc ? valueAt(doc.series, doc.mae, id) : null;
      }),
    }));
    return { labels, series: lines };
  }, [active, selected, catalog.leads, names]);

  const stationRows = useMemo(() => {
    if (!active) return [];
    const columns = allStationColumns ? (ranked?.series ?? selected) : selected;
    return catalog.stations
      .map((station) => {
        const maes: Record<string, number | null> = {};
        let pairs = 0;
        if (lead === "all") {
          const counts: number[] = [];
          for (const item of catalog.leads) {
            const doc = active.by_station[String(item)];
            if (!doc) continue;
            const at = doc.ids.indexOf(station.id);
            if (at < 0 || doc.n[at] <= 0) continue;
            counts.push(doc.n[at]);
          }
          pairs = counts.reduce((sum, value) => sum + value, 0);
          for (const id of columns) {
            const samples: number[] = [];
            for (const item of catalog.leads) {
              const doc = active.by_station[String(item)];
              if (!doc) continue;
              const at = doc.ids.indexOf(station.id);
              if (at < 0 || doc.n[at] <= 0) continue;
              const seriesIndex = doc.series.indexOf(id);
              const value = seriesIndex < 0 ? null : doc.mae[seriesIndex][at];
              if (value != null) samples.push(value);
            }
            maes[id] = unweighted(samples);
          }
        } else {
          const doc = active.by_station[String(lead)];
          const at = doc ? doc.ids.indexOf(station.id) : -1;
          pairs = doc && at >= 0 ? doc.n[at] : 0;
          for (const id of columns) {
            if (!doc || at < 0 || pairs === 0) {
              maes[id] = null;
              continue;
            }
            const seriesIndex = doc.series.indexOf(id);
            maes[id] = seriesIndex < 0 ? null : doc.mae[seriesIndex][at];
          }
        }
        return { station, pairs, maes, columns };
      })
      .sort((a, b) => {
        if (stationSort === "name") return a.station.name.localeCompare(b.station.name, "cs");
        const av = a.maes[stationSort];
        const bv = b.maes[stationSort];
        if (av == null && bv == null) return a.station.name.localeCompare(b.station.name, "cs");
        if (av == null) return 1;
        if (bv == null) return -1;
        return av - bv;
      });
  }, [active, allStationColumns, ranked, selected, catalog, lead, stationSort]);

  const columnIds = stationRows[0]?.columns ?? selected;

  return (
    <section className="view">
      <div className="controls">
        <Segmented
          label="Variable"
          value={variable}
          options={catalog.variables.map((id) => ({ value: id, label: catalog.variable_labels[id] ?? id }))}
          onChange={setVariable}
        />
        <Segmented
          label="Lead"
          value={lead}
          options={[
            {
              value: "all" as LeadPick,
              label: "All",
              title: "Unweighted mean of the D+0…D+5 scores that have pairs",
            },
            ...counts.map((item) => ({
              value: item.lead as LeadPick,
              label: `D+${item.lead}`,
              dim: item.visual === "thin",
              disabled: item.visual === "empty",
              title:
                item.visual === "empty"
                  ? emptyLeadTitle(item.lead)
                  : item.visual === "thin" && item.doc?.obs_window
                    ? `${leadWindow(item.lead).label} · ČHMÚ covers ${item.doc.obs_slots} of ${item.doc.obs_window} hours in this lead`
                    : `${leadWindow(item.lead).label} · ${item.n.toLocaleString("en-GB")} common pairs${item.lead >= 4 ? " · secondary lead (rule R2)" : ""}`,
            })),
          ]}
          onChange={setLead}
        />
      </div>
      <p className="hint lead-counts" data-testid="lead-counts">
        Common pairs for {catalog.variable_labels[variable] ?? variable}:{" "}
        {counts.map((item) => `D+${item.lead} ${item.n.toLocaleString("en-GB")}`).join(" · ")}. A dimmed lead has
        ČHMÚ data for under half of its 24-hour range and can still be opened. A lead with no scored station-hours
        is disabled.
      </p>

      {lead !== "all" && leadEmpty ? (
        <LeadGap catalog={catalog} variableLabel={catalog.variable_labels[variable] ?? variable} lead={lead} counts={counts} />
      ) : !active || !ranked || ranked.series.length === 0 ? (
        <p className="banner">
          No scored pairs for {catalog.variable_labels[variable] ?? variable}
          {lead === "all" ? " yet" : ` at D+${lead} yet`}. Forecasts are stored from the first public-v2 snapshot.
          A lead can be scored only after the valid hours have observations. Withdrawn releases are not included.
        </p>
      ) : (
        <>
          <p className="fair">
            {lead === "all" ? (
              <>
                All-leads MAE, bias and RMSE are the unweighted mean of the rounded D+ scores
                {overall && overall.leads_used.length ? ` (D+${overall.leads_used.join(", D+")})` : ""}. Leads with no
                pairs are left out of that mean. A series missing from a lead is left out of that lead, not filled in.
              </>
            ) : (
              <>
                D+{lead} uses {block?.n.toLocaleString("en-GB")} common station-hours
                {block ? ` out of ${block.ai_pairs.toLocaleString("en-GB")} hours where the AI and an observation both exist` : ""},
                from {block?.snaps ?? 0} snapshots and {block?.stations ?? 0} stations.
                {block?.short ? " This sample is still below the usual minimum of 24 pairs." : ""}
              </>
            )}{" "}
            Every series in the table is scored on those same hours.
          </p>

          <SeriesToggles ids={ranked.series} names={names} selected={selected} onChange={setSelected} />
          <p className="hint">
            The chart starts with MeteoVerdict AI and the two other series with the lowest MAE for this selection.
            Untick or add any series. The table keeps the true MAE order, including when the AI is not among the first three.
          </p>

          <div className="matrix-wrap">
            <table className="matrix">
              <caption>MAE ({unit}) for the chart series, overall and by lead</caption>
              <thead>
                <tr>
                  <th scope="col">Series</th>
                  <th scope="col" className={lead === "all" ? "here" : ""}>All</th>
                  {catalog.leads.map((item) => (
                    <th key={item} scope="col" className={lead === item ? "here" : ""}>
                      D+{item}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {selected.map((id) => (
                  <tr key={id} className={id === "ai" ? "is-ai" : undefined}>
                    <th scope="row">{seriesName(names, id)}</th>
                    <td className="num">{fmt(overall ? valueAt(overall.series, overall.mae, id) : null)}</td>
                    {catalog.leads.map((item) => {
                      const doc = active.leads[String(item)];
                      return (
                        <td key={item} className="num">
                          {fmt(doc ? valueAt(doc.series, doc.mae, id) : null)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="chart-grid">
            <figure>
              <figcaption>
                MAE by lead
                {counts.some((item) => item.n === 0)
                  ? ` · no bar where n = 0 (${counts
                      .filter((item) => item.n === 0)
                      .map((item) => `D+${item.lead}`)
                      .join(", ")})`
                  : ""}
              </figcaption>
              {leadBars && <BarChart {...leadBars} ariaLabel={`MAE by lead for ${selected.length} series`} yLabel={unit} zero />}
            </figure>
            <figure>
              <figcaption>MAE by snapshot day{lead === "all" ? " (mean of the leads scored that day)" : ""}</figcaption>
              {dayChart && dayChart.labels.length > 0 && (
                <LineChart {...dayChart} ariaLabel="MAE by snapshot day" yLabel={unit} zero />
              )}
            </figure>
          </div>

          <ScoreTable
            names={names}
            unit={unit}
            series={ranked.series}
            mae={ranked.mae}
            bias={ranked.bias}
            rmse={ranked.rmse}
            leadsFor={lead === "all" ? overall?.leads_for : undefined}
          />
          {block && <ExcludedList items={block.excluded} names={names} />}
          {block && Object.keys(block.dropped_run_unavailable).length > 0 && (
            <p className="hint">
              Runs not available at the snapshot (rule R1), dropped and not replaced:{" "}
              {Object.entries(block.dropped_run_unavailable)
                .map(([id, count]) => `${seriesName(names, id)} ${count}`)
                .join(", ")}
              .
            </p>
          )}

          <div className="station-head">
            <h2>By station</h2>
            <button type="button" className="text-btn" onClick={() => setAllStationColumns((value) => !value)}>
              {allStationColumns ? "Show chart series only" : "Show every ranked series"}
            </button>
          </div>
          <p className="hint">
            Same series as the table. A station-hour counts only when each of those series has a value there.
            {lead === "all" ? " The all-leads cell is the unweighted mean of the leads that have pairs at that station." : ""}
          </p>
          <div className="table-wrap">
            <table className="stations">
              <thead>
                <tr>
                  <th scope="col">
                    <button type="button" onClick={() => setStationSort("name")}>Station</button>
                  </th>
                  <th scope="col">Pairs</th>
                  {columnIds.map((id) => (
                    <th key={id} scope="col">
                      <button type="button" onClick={() => setStationSort(id)}>{seriesName(names, id)}</button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stationRows.map((row) => (
                  <tr key={row.station.id}>
                    <th scope="row">
                      {row.station.name}
                      <span className="elev">{Math.round(row.station.elev)} m</span>
                    </th>
                    <td className="num">{row.pairs || "—"}</td>
                    {columnIds.map((id) => (
                      <td key={id} className="num">{fmt(row.maes[id])}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <ObsNote days={catalog.obs_days} />
    </section>
  );
}
