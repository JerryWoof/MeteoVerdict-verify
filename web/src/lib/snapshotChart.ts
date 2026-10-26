import { seriesName } from "./format";
import { inLead, leadOf } from "./score";

/** ČHMÚ observation stroke. Models stay solid so this dotted line stays distinct. */
export const OBS_DASH = "2 4";
export const OBS_NAME = "Obs · naměřené";
export const OBS_COLOR = "#1e2430";

export type StationGrid = {
  id: string;
  snapshotTime: string;
  lead0: number;
  hours: number;
  seriesIds: string[];
  obs: (number | null)[];
  values: (number | null)[][];
};

export type BuiltLine = {
  id: string;
  name: string;
  color: string;
  values: (number | null)[];
  width?: number;
  dash?: string;
};

function hourIso(snapshotIso: string, lead0: number, hour: number): string {
  return new Date(Date.parse(snapshotIso) + (lead0 + hour) * 3_600_000).toISOString();
}

/**
 * One solid line per selected model that has a value in the lead, then the dotted observation.
 * The axis is that selection's range: from the earliest selected model value to the latest.
 * Observation is the underlay on the same interval, including gaps inside it. Hours outside
 * that range are dropped, so Obs is never longer than the model lines.
 */
export function buildSnapshotChart(args: {
  grids: StationGrid[];
  selected: string[];
  lead: number | "all";
  names: Record<string, string>;
  color: (id: string) => string;
  snapLabel?: (iso: string) => string;
  /** When set, the axis is these instants (the last one is the closing tick and holds no value). */
  axis?: { times: string[]; endExclusiveMs: number };
  plainNames?: boolean;
}): { times: string[]; series: BuiltLine[]; obsPoints: number } {
  const { grids, selected, lead, names, color, snapLabel = (iso) => iso, axis, plainNames = false } = args;
  const selectedSet = new Set(selected);
  let minMs = Number.POSITIVE_INFINITY;
  let maxMs = Number.NEGATIVE_INFINITY;
  const inWindow: { grid: StationGrid; hour: number; iso: string; ms: number }[] = [];

  for (const grid of grids) {
    const picked = grid.seriesIds.flatMap((id, index) => (selectedSet.has(id) ? [index] : []));
    for (let hour = 0; hour < grid.hours; hour += 1) {
      const iso = hourIso(grid.snapshotTime, grid.lead0, hour);
      const ms = Date.parse(iso);
      if (axis) {
        if (ms < Date.parse(axis.times[0] ?? iso) || ms >= axis.endExclusiveMs) continue;
      } else if (!inLead(leadOf(iso, grid.snapshotTime), lead)) {
        continue;
      }
      inWindow.push({ grid, hour, iso, ms });
      for (const seriesIndex of picked) {
        if ((grid.values[seriesIndex]?.[hour] ?? null) == null) continue;
        if (ms < minMs) minMs = ms;
        if (ms > maxMs) maxMs = ms;
      }
    }
  }
  if (!Number.isFinite(minMs)) {
    return axis ? { times: axis.times, series: [], obsPoints: 0 } : { times: [], series: [], obsPoints: 0 };
  }

  const labels = axis
    ? axis.times
    : [...new Set(inWindow.filter((slot) => slot.ms >= minMs && slot.ms <= maxMs).map((slot) => slot.iso))].sort();
  const at = new Map(labels.map((iso, index) => [iso, index]));
  const obsValues = labels.map(() => null as number | null);
  const series: BuiltLine[] = [];

  for (const grid of grids) {
    for (let hour = 0; hour < grid.hours; hour += 1) {
      const iso = hourIso(grid.snapshotTime, grid.lead0, hour);
      const index = at.get(iso);
      if (index == null) continue;
      const ms = Date.parse(iso);
      if (ms < minMs || ms > maxMs) continue;
      const obs = grid.obs[hour] ?? null;
      if (obs != null) obsValues[index] = obs;
    }
    for (const id of selected) {
      const seriesIndex = grid.seriesIds.indexOf(id);
      if (seriesIndex < 0) continue;
      const values = labels.map(() => null as number | null);
      let points = 0;
      const row = grid.values[seriesIndex] ?? [];
      for (let hour = 0; hour < grid.hours; hour += 1) {
        const iso = hourIso(grid.snapshotTime, grid.lead0, hour);
        const index = at.get(iso);
        if (index == null) continue;
        const value = row[hour] ?? null;
        values[index] = value;
        if (value != null) points += 1;
      }
      if (points === 0) continue;
      const label = seriesName(names, id);
      series.push({
        id: `${grid.id}:${id}`,
        name: plainNames ? label : `${label} · ${snapLabel(grid.snapshotTime)}`,
        color: color(id),
        values,
        width: id === "ai" ? 2.4 : 1.8,
      });
    }
  }

  const obsPoints = obsValues.filter((value) => value != null).length;
  if (obsPoints > 0) {
    series.push({
      id: "obs",
      name: OBS_NAME,
      color: OBS_COLOR,
      values: obsValues,
      width: 2.6,
      dash: OBS_DASH,
    });
  }
  return { times: labels, series, obsPoints };
}
