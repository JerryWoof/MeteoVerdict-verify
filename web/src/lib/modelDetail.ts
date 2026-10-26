import { unweighted } from "./score";
import type { StationBlock } from "../types";

export type LeadPiece = { lead: number; mae: number; n: number };

export type StationDetail = {
  id: string;
  mae: number;
  n: number;
  /** 1 is the lowest MAE among the ranked series at this station. */
  place: number;
  compared: number;
};

function atStation(
  doc: StationBlock | undefined,
  seriesId: string,
  stationId: string,
): { mae: number; n: number } | null {
  if (!doc) return null;
  const at = doc.ids.indexOf(stationId);
  if (at < 0 || doc.n[at] <= 0) return null;
  const seriesIndex = doc.series.indexOf(seriesId);
  if (seriesIndex < 0) return null;
  const mae = doc.mae[seriesIndex]?.[at];
  if (mae == null) return null;
  return { mae, n: doc.n[at] };
}

function leadSamples(
  byStation: Record<string, StationBlock>,
  leads: number[],
  seriesId: string,
  stationId: string,
): { mae: number; n: number }[] {
  const samples: { mae: number; n: number }[] = [];
  for (const lead of leads) {
    const hit = atStation(byStation[String(lead)], seriesId, stationId);
    if (hit) samples.push(hit);
  }
  return samples;
}

/**
 * Per-station MAE for one series on the leads behind the open score.
 * A single lead uses that lead’s common-set MAE. Full uses the same unweighted
 * mean of rounded lead scores as the station table. Ranking order is not touched.
 */
export function stationDetail(
  stationIds: string[],
  byStation: Record<string, StationBlock>,
  leads: number[],
  modelId: string,
  rankedSeries: string[],
): StationDetail[] {
  const rows: StationDetail[] = [];
  for (const stationId of stationIds) {
    const mine = leadSamples(byStation, leads, modelId, stationId);
    const mae = unweighted(mine.map((item) => item.mae));
    if (mae == null) continue;
    const scored = rankedSeries.flatMap((id) => {
      const value = unweighted(leadSamples(byStation, leads, id, stationId).map((item) => item.mae));
      return value == null ? [] : [{ id, mae: value }];
    });
    scored.sort((a, b) => a.mae - b.mae || a.id.localeCompare(b.id));
    rows.push({
      id: stationId,
      mae,
      n: mine.reduce((sum, item) => sum + item.n, 0),
      place: scored.findIndex((item) => item.id === modelId) + 1,
      compared: scored.length,
    });
  }
  rows.sort((a, b) => a.mae - b.mae || a.id.localeCompare(b.id));
  return rows;
}
