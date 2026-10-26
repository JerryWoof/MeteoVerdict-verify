/** ČHMÚ time coverage of a 24-hour lead window. The denominator is the window length, not station-hours. */

export const LEAD_COUNT = 6;
export const LEAD_HOURS = 24;
/** Gray when observed hours / window hours is strictly below this. 12/24 stays active. */
export const COVERAGE_MIN = 0.5;

export type LeadFact = { hasSeries: boolean; obsHours: number };
export type LeadVisual = "ok" | "thin" | "empty";

export function emptyLeadTitle(lead: number): string {
  return `D+${lead} has no scored station-hours`;
}

/**
 * Calendar days after the snapshot's UTC date. D+0 is that date from 00:00 to the next 00:00,
 * which is the window the snapshot chart draws for a lead.
 */
export function calendarDayFacts(snapshotIso: string, lead0: number, hourHasObs: boolean[], hourHasModel: boolean[]): LeadFact[] {
  const snap = new Date(snapshotIso);
  const origin = Date.UTC(snap.getUTCFullYear(), snap.getUTCMonth(), snap.getUTCDate());
  const facts: LeadFact[] = Array.from({ length: LEAD_COUNT }, () => ({ hasSeries: false, obsHours: 0 }));
  const snapMs = Date.parse(snapshotIso);
  const n = Math.max(hourHasObs.length, hourHasModel.length);
  for (let hour = 0; hour < n; hour += 1) {
    const day = Math.floor((snapMs + (lead0 + hour) * 3_600_000 - origin) / 86_400_000);
    if (day < 0 || day >= LEAD_COUNT) continue;
    if (hourHasModel[hour]) facts[day].hasSeries = true;
    if (hourHasObs[hour]) facts[day].obsHours += 1;
  }
  return facts;
}

/** One snapshot file: which hour-leads contain a model value, and how many hours have an observation. */
export function factsFromHours(lead0: number, hourHasObs: boolean[], hourHasModel: boolean[]): LeadFact[] {
  const facts: LeadFact[] = Array.from({ length: LEAD_COUNT }, () => ({ hasSeries: false, obsHours: 0 }));
  const n = Math.max(hourHasObs.length, hourHasModel.length);
  for (let hour = 0; hour < n; hour += 1) {
    const leadHours = lead0 + hour;
    if (leadHours < 0) continue;
    const lead = Math.floor(leadHours / LEAD_HOURS);
    if (lead < 0 || lead >= LEAD_COUNT) continue;
    if (hourHasModel[hour]) facts[lead].hasSeries = true;
    if (hourHasObs[hour]) facts[lead].obsHours += 1;
  }
  return facts;
}

/** Across ticked releases. Only a release that actually forecasts the lead contributes its 24 hours. */
export function combineLeadFacts(parts: LeadFact[]): { hasSeries: boolean; obsHours: number; windowHours: number } {
  let obsHours = 0;
  let windows = 0;
  for (const part of parts) {
    if (!part.hasSeries) continue;
    windows += 1;
    obsHours += part.obsHours;
  }
  return { hasSeries: windows > 0, obsHours, windowHours: windows * LEAD_HOURS };
}

export function leadState(hasSeries: boolean, obsHours: number, windowHours: number): LeadVisual {
  if (!hasSeries || windowHours <= 0) return "empty";
  if (obsHours / windowHours < COVERAGE_MIN) return "thin";
  return "ok";
}

/** Overview: no scored series disables the pill. A scored lead with obs_slots / obs_window under 50% is dimmed. */
export function scoredLeadVisual(
  doc: { n: number; series: string[]; obs_slots?: number; obs_window?: number } | null | undefined,
): LeadVisual {
  if (!doc || doc.n <= 0 || doc.series.length === 0) return "empty";
  if (doc.obs_slots == null || doc.obs_window == null) return "ok";
  return leadState(true, doc.obs_slots, doc.obs_window);
}

/** Release picker. Missing field means the catalog predates the count, so the row stays active. */
export function releaseCoverageThin(obsHours: number | null | undefined, windowHours = LEAD_HOURS): boolean {
  if (obsHours == null || windowHours <= 0) return false;
  return obsHours / windowHours < COVERAGE_MIN;
}
