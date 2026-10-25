/** Common-pair scores for an arbitrary subset of snapshots. Same rule as scripts/derive_pages.choose_series. */

export type Row = { obs: number; values: Record<string, number | null | undefined> };

export type ExcludedRow = {
  k: string;
  pairs: number;
  coverage: number;
  reason: "too_few_pairs" | "would_shrink_common_set";
  intersection?: number;
};

export type ScoreResult = {
  series: string[];
  mae: number[];
  bias: number[];
  rmse: number[];
  n: number;
  aiPairs: number;
  floor: number;
  short: boolean;
  excluded: ExcludedRow[];
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function metric(errors: number[]): { mae: number; bias: number; rmse: number } {
  const n = errors.length;
  let abs = 0;
  let sum = 0;
  let sq = 0;
  for (const error of errors) {
    abs += Math.abs(error);
    sum += error;
    sq += error * error;
  }
  return { mae: round2(abs / n), bias: round2(sum / n), rmse: round2(Math.sqrt(sq / n)) };
}

export function scoreRows(rows: Row[], minPairs: number, keepFraction: number): ScoreResult | null {
  const aiRows = rows.filter((row) => row.values.ai != null && row.obs != null);
  const aiN = aiRows.length;
  if (aiN === 0) return null;
  const floor = Math.max(minPairs, Math.ceil(keepFraction * aiN - 1e-9));
  const counts = new Map<string, number>();
  for (const row of aiRows) {
    for (const [name, value] of Object.entries(row.values)) {
      if (name === "ai" || value == null) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const chosen: string[] = [];
  const excluded: ExcludedRow[] = [];
  const intersectionOf = (names: string[]) =>
    aiRows.filter((row) => names.every((name) => row.values[name] != null)).length;
  for (const [name, count] of ordered) {
    const coverage = Math.round((count / aiN) * 1000) / 1000;
    if (count < minPairs) {
      excluded.push({ k: name, pairs: count, coverage, reason: "too_few_pairs" });
      continue;
    }
    const intersection = intersectionOf([...chosen, name]);
    if (intersection >= floor && intersection >= minPairs) chosen.push(name);
    else excluded.push({ k: name, pairs: count, coverage, reason: "would_shrink_common_set", intersection });
  }
  const common = chosen.length ? aiRows.filter((row) => chosen.every((name) => row.values[name] != null)) : aiRows;
  const names = ["ai", ...chosen];
  const metrics = new Map(names.map((name) => [name, metric(common.map((row) => (row.values[name] as number) - row.obs))]));
  names.sort((a, b) => metrics.get(a)!.mae - metrics.get(b)!.mae || a.localeCompare(b));
  excluded.sort((a, b) => a.k.localeCompare(b.k));
  return {
    series: names,
    mae: names.map((name) => metrics.get(name)!.mae),
    bias: names.map((name) => metrics.get(name)!.bias),
    rmse: names.map((name) => metrics.get(name)!.rmse),
    n: common.length,
    aiPairs: aiN,
    floor,
    short: common.length < minPairs,
    excluded,
  };
}

export function unweighted(values: number[]): number | null {
  if (values.length === 0) return null;
  return round2(values.reduce((sum, value) => sum + value, 0) / values.length);
}

/** D+k is valid_time − snapshot_time in [24k, 24k+24) hours. */
export function leadOf(validIso: string, snapshotIso: string): number {
  return Math.round((Date.parse(validIso) - Date.parse(snapshotIso)) / 3_600_000);
}

export function inLead(leadHours: number, lead: number | "all"): boolean {
  if (lead === "all") return leadHours >= 24 && leadHours < 144;
  return leadHours >= 24 * lead && leadHours < 24 * lead + 24;
}
