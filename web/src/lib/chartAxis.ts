/** Clock-time axis for one release. A lead day is the UTC calendar day, 00:00 through the next 00:00. */

export type AxisTick = {
  iso: string;
  ms: number;
  clock: string;
  /** Calendar days after the snapshot's UTC date. 0 is that release's D+0 day. */
  lead: number;
  /** Midnight that opens a day inside the window. The closing 00:00 is not a day start. */
  dayStart: boolean;
  terminal: boolean;
};

export function utcMidnight(iso: string): number {
  const date = new Date(iso);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export function clockLabel(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

export function dayStamp(ms: number): string {
  const date = new Date(ms);
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${date.getUTCFullYear()}`;
}

function hourAxis(startMs: number, endMs: number, origin: number): AxisTick[] {
  const ticks: AxisTick[] = [];
  for (let ms = startMs; ms <= endMs; ms += 3_600_000) {
    const midnight = utcMidnight(new Date(ms).toISOString());
    ticks.push({
      iso: new Date(ms).toISOString(),
      ms,
      clock: clockLabel(ms),
      lead: Math.round((midnight - origin) / 86_400_000),
      dayStart: ms !== endMs && new Date(ms).getUTCHours() === 0 && new Date(ms).getUTCMinutes() === 0,
      terminal: ms === endMs,
    });
  }
  return ticks;
}

/** One verifying day: snapshot UTC date + `lead` days, from 00:00 inclusive to the next 00:00. */
export function leadDayAxis(snapshotIso: string, lead: number): AxisTick[] {
  const origin = utcMidnight(snapshotIso);
  const start = origin + lead * 86_400_000;
  return hourAxis(start, start + 86_400_000, origin);
}

/** Every UTC day the release touches, from 00:00 on the snapshot's date through the 00:00 after the last hour. */
export function fullAxis(snapshotIso: string, lastValidIso: string): AxisTick[] {
  const origin = utcMidnight(snapshotIso);
  const last = Date.parse(lastValidIso);
  const lastMidnight = utcMidnight(lastValidIso);
  const end = last === lastMidnight ? lastMidnight : lastMidnight + 86_400_000;
  return hourAxis(origin, Math.max(end, origin + 86_400_000), origin);
}

/** Dates that contain a drawn hour, as DD.MM.YYYY. The closing midnight is not its own day. */
export function forecastDates(ticks: AxisTick[]): string[] {
  const seen: string[] = [];
  for (const tick of ticks) {
    if (tick.terminal) continue;
    const stamp = dayStamp(tick.ms);
    if (!seen.includes(stamp)) seen.push(stamp);
  }
  return seen;
}

/** Bottom ticks are 24h clock times. A long Full window keeps 00:00 and 12:00 so the labels still fit. */
export function showClockTick(tick: AxisTick, spanHours: number): boolean {
  const hour = new Date(tick.ms).getUTCHours();
  if (tick.terminal) return hour === 0;
  if (spanHours > 72) return hour === 0 || hour === 12;
  return hour % 6 === 0;
}
