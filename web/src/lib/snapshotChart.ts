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

function utcDay(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * One solid line per selected model that has a value in the lead window, then the dotted
 * observation line. Observation hours cover the whole UTC day of every day the lead touches,
 * including hours before the snapshot. Models stay on their forecast hours. Observation is last.
 */
export function buildSnapshotChart(args: {
  grids: StationGrid[];
  selected: string[];
  lead: number | "all";
  names: Record<string, string>;
  color: (id: string) => string;
  snapLabel?: (iso: string) => string;
}): { times: string[]; series: BuiltLine[]; obsPoints: number } {
  const { grids, selected, lead, names, color, snapLabel = (iso) => iso } = args;
  const forecast = new Set<string>();
  for (const grid of grids) {
    for (let hour = 0; hour < grid.hours; hour += 1) {
      const valid = hourIso(grid.snapshotTime, grid.lead0, hour);
      if (inLead(leadOf(valid, grid.snapshotTime), lead)) forecast.add(valid);
    }
  }
  const days = new Set([...forecast].map(utcDay));
  const times = new Set<string>(forecast);
  for (const grid of grids) {
    for (let hour = 0; hour < grid.hours; hour += 1) {
      const valid = hourIso(grid.snapshotTime, grid.lead0, hour);
      if (!days.has(utcDay(valid))) continue;
      if (grid.obs[hour] != null) times.add(valid);
    }
  }
  const labels = [...times].sort();
  const at = new Map(labels.map((iso, index) => [iso, index]));
  const obsValues = labels.map(() => null as number | null);
  const series: BuiltLine[] = [];

  for (const grid of grids) {
    for (let hour = 0; hour < grid.hours; hour += 1) {
      const valid = hourIso(grid.snapshotTime, grid.lead0, hour);
      const index = at.get(valid);
      if (index == null) continue;
      const obs = grid.obs[hour] ?? null;
      if (obs != null) obsValues[index] = obs;
    }
    grid.seriesIds.forEach((id, seriesIndex) => {
      if (!selected.includes(id)) return;
      const values = labels.map(() => null as number | null);
      let points = 0;
      const row = grid.values[seriesIndex] ?? [];
      for (let hour = 0; hour < grid.hours; hour += 1) {
        const valid = hourIso(grid.snapshotTime, grid.lead0, hour);
        if (!forecast.has(valid)) continue;
        const index = at.get(valid);
        if (index == null) continue;
        const value = row[hour] ?? null;
        values[index] = value;
        if (value != null) points += 1;
      }
      if (points === 0) return;
      series.push({
        id: `${grid.id}:${id}`,
        name: `${seriesName(names, id)} · ${snapLabel(grid.snapshotTime)}`,
        color: color(id),
        values,
        width: id === "ai" ? 2.4 : 1.8,
      });
    });
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
