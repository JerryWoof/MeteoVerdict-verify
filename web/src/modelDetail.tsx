import { fmt, seriesName } from "./lib/format";
import { leadWindow } from "./lib/leads";
import { stationDetail } from "./lib/modelDetail";
import { unweighted } from "./lib/score";
import type { Catalog, LeadPick, LeadScore, VariableScore } from "./types";

function joinNumbers(values: string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}

function signed(value: number): string {
  const text = fmt(value);
  return value > 0 ? `+${text}` : text;
}

function placeLabel(place: number): string {
  const mod100 = place % 100;
  const mod10 = place % 10;
  if (mod100 >= 11 && mod100 <= 13) return `${place}th`;
  if (mod10 === 1) return `${place}st`;
  if (mod10 === 2) return `${place}nd`;
  if (mod10 === 3) return `${place}rd`;
  return `${place}th`;
}

export function ModelDetail({
  catalog,
  active,
  variable,
  lead,
  modelId,
  ranked,
  onClose,
}: {
  catalog: Catalog;
  active: VariableScore;
  variable: string;
  lead: LeadPick;
  modelId: string;
  ranked: { series: string[]; mae: number[]; leads_for?: Record<string, number[]> };
  onClose: () => void;
}) {
  const names = catalog.names;
  const unit = catalog.units[variable] ?? "";
  const label = catalog.variable_labels[variable] ?? variable;
  const index = ranked.series.indexOf(modelId);
  const network = index < 0 ? null : ranked.mae[index];
  const leads = lead === "all" ? (ranked.leads_for?.[modelId] ?? []) : [lead];
  const stations = stationDetail(
    catalog.stations.map((station) => station.id),
    active.by_station,
    leads,
    modelId,
    ranked.series,
  );
  const byId = new Map(catalog.stations.map((station) => [station.id, station]));
  const closest = stations[0];
  const widest = stations.length > 1 ? stations[stations.length - 1] : undefined;
  const neighbor = index === 0 ? ranked.series[1] : index > 0 ? ranked.series[index - 1] : undefined;
  const neighborMae = neighbor ? ranked.mae[ranked.series.indexOf(neighbor)] : undefined;
  const block: LeadScore | undefined = lead === "all" ? undefined : active.leads[String(lead)];
  const pieces = leads.flatMap((item) => {
    const doc = active.leads[String(item)];
    if (!doc) return [];
    const at = doc.series.indexOf(modelId);
    if (at < 0) return [];
    return [{ lead: item, mae: doc.mae[at], n: doc.n }];
  });
  const anchor = seriesName(names, "ai");

  return (
    <section className="detail" id="model-detail" aria-labelledby="model-detail-title" data-testid="model-detail">
      <div className="detail-head">
        <p className="eyebrow">{label} · {lead === "all" ? "Full" : `D+${lead}`}</p>
        <h2 id="model-detail-title">{seriesName(names, modelId)}</h2>
        <button type="button" className="text-btn" onClick={onClose}>Close</button>
      </div>
      {network != null && (
        <p className="detail-mae">
          MAE {fmt(network)} {unit}
          <span>Row {index + 1} of {ranked.series.length} on this sample</span>
        </p>
      )}
      <h3>How this number was calculated</h3>
      <p>
        Truth is the ČHMÚ observation at that station and hour. MAE is the mean of |forecast − observation|.
        A lower MAE is a closer forecast on this set of hours. The order is not a prize.
      </p>
      <p>
        A station-hour counts only when every series in this ranking has a forecast and the observation exists.
        A missing hour is left missing. Nothing is filled from an older release.
      </p>
      {lead !== "all" && block && network != null && (
        <p>
          D+{lead} is valid time minus snapshot time in [{leadWindow(lead).start}, {leadWindow(lead).start + 24}) hours
          ({leadWindow(lead).label}). This MAE uses {block.n.toLocaleString("en-GB")} common station-hours
          from {block.snaps} releases and {block.stations} stations.
          {block.ai_pairs !== block.n
            ? ` ${block.ai_pairs.toLocaleString("en-GB")} hours have both ${anchor} and an observation; ${block.n.toLocaleString("en-GB")} of them also have every ranked series.`
            : ""}
        </p>
      )}
      {lead === "all" && network != null && pieces.length > 0 && (
        <p>
          Full is the unweighted mean of this series’ rounded lead scores. Each lead keeps its own common hours.
          {pieces.map((piece) => ` D+${piece.lead} is ${fmt(piece.mae)} ${unit} on ${piece.n.toLocaleString("en-GB")} station-hours.`).join("")}
          {" "}
          {unweighted(pieces.map((piece) => piece.mae)) === network
            ? `The mean of ${joinNumbers(pieces.map((piece) => fmt(piece.mae)))} is ${fmt(network)} ${unit}.`
            : `Those lead scores are averaged with equal weight. The published Full MAE is ${fmt(network)} ${unit}.`}
        </p>
      )}
      {neighbor && neighborMae != null && network != null && (
        <p>
          On this same sample, {fmt(network)} {unit} is{" "}
          {network === neighborMae
            ? `the same MAE as ${seriesName(names, neighbor)}`
            : `${fmt(Math.abs(network - neighborMae))} ${unit} ${network < neighborMae ? "lower" : "higher"} than ${seriesName(names, neighbor)}`}
          {index === 0 ? ", the next row." : ", the row above."}
        </p>
      )}
      <h3>Where the error is smaller or larger</h3>
      {stations.length === 0 ? (
        <p>This series has no per-station scores in the current window.</p>
      ) : (
        <>
          <p>
            Same common hours as the ranking. Place 1 is the lowest MAE among the ranked series at that station.
            Versus network is the station MAE minus this series’ {fmt(network)} {unit}.
          </p>
          <div className="extremes">
            {closest && (
              <p>
                <span className="tag">Closest station</span>
                <strong>{byId.get(closest.id)?.name ?? closest.id}</strong>
                {fmt(closest.mae)} {unit} on {closest.n.toLocaleString("en-GB")} hours, {placeLabel(closest.place)} of {closest.compared}.
                {" "}{signed(closest.mae - (network ?? closest.mae))} {unit} versus the network MAE.
              </p>
            )}
            {widest && (
              <p>
                <span className="tag">Largest error</span>
                <strong>{byId.get(widest.id)?.name ?? widest.id}</strong>
                {fmt(widest.mae)} {unit} on {widest.n.toLocaleString("en-GB")} hours, {placeLabel(widest.place)} of {widest.compared}.
                {" "}{signed(widest.mae - (network ?? widest.mae))} {unit} versus the network MAE.
              </p>
            )}
          </div>
          <div className="table-wrap">
            <table className="stations">
              <caption>Stations ordered by this series’ MAE. The ranking above is unchanged.</caption>
              <thead>
                <tr>
                  <th scope="col">Station</th>
                  <th scope="col">Pairs</th>
                  <th scope="col">MAE ({unit})</th>
                  <th scope="col">Place</th>
                  <th scope="col">Versus network</th>
                </tr>
              </thead>
              <tbody>
                {stations.map((row, rowIndex) => {
                  const mark = rowIndex === 0 ? "closest" : rowIndex === stations.length - 1 ? "widest" : undefined;
                  return (
                    <tr key={row.id} className={mark}>
                      <th scope="row">
                        {byId.get(row.id)?.name ?? row.id}
                        {mark === "closest" && <span className="elev">Closest</span>}
                        {mark === "widest" && <span className="elev">Largest error</span>}
                      </th>
                      <td className="num">{row.n.toLocaleString("en-GB")}</td>
                      <td className="num">{fmt(row.mae)}</td>
                      <td className="num">{row.place} of {row.compared}</td>
                      <td className="num">{signed(row.mae - (network ?? row.mae))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
