import type { LeadPick, VariableScore } from "../types";

/** Common pairs for one lead. A missing block, or a block with no series, counts as zero. */
export function leadPairCount(active: VariableScore | null | undefined, lead: number): number {
  const doc = active?.leads[String(lead)];
  if (!doc || doc.n <= 0 || doc.series.length === 0) return 0;
  return doc.n;
}

/** First D+k that has pairs. Falls back to the all-leads view when every lead is empty. */
export function firstScoredLead(leads: number[], active: VariableScore | null | undefined): LeadPick {
  for (const lead of leads) {
    if (leadPairCount(active, lead) > 0) return lead;
  }
  return "all";
}

export function leadWindow(lead: number): { start: number; endHour: number; label: string } {
  const start = lead * 24;
  const endHour = start + 23;
  return { start, endHour, label: `${start}–${endHour} h after the snapshot` };
}

/**
 * Why a lead can be empty: its window opens at `24k` hours after the earliest snapshot.
 * If that instant is after the latest observation hour, no station-hour in the window can be scored yet.
 */
export function leadOpensAfterObservations(
  lead: number,
  earliestSnapshot: string | null | undefined,
  lastObsDay: string | null | undefined,
): { opensAt: string | null; afterObservations: boolean } {
  if (!earliestSnapshot || !lastObsDay) return { opensAt: null, afterObservations: false };
  const opensAtMs = Date.parse(earliestSnapshot) + lead * 24 * 3_600_000;
  const lastObsMs = Date.parse(`${lastObsDay}T23:00:00Z`);
  if (Number.isNaN(opensAtMs) || Number.isNaN(lastObsMs)) return { opensAt: null, afterObservations: false };
  return { opensAt: new Date(opensAtMs).toISOString(), afterObservations: opensAtMs > lastObsMs };
}
