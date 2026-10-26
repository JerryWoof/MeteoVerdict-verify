const TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  day: "2-digit",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const DAY = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  day: "2-digit",
  month: "short",
  year: "numeric",
});

export function fmt(value: number | null | undefined, digits = 2): string {
  if (value == null || Number.isNaN(value)) return "—";
  const text = value.toFixed(digits);
  return text === "-0.00" ? "0.00" : text;
}

export function fmtTime(iso: string): string {
  return `${TIME.format(new Date(iso))} UTC`;
}

export function fmtDay(isoDay: string): string {
  return DAY.format(new Date(`${isoDay}T00:00:00Z`));
}

export function seriesName(names: Record<string, string>, id: string): string {
  if (id === "blend" || id === "combined") return "MeteoVerdict";
  return names[id] ?? id;
}

export function reasonText(reason: string): string {
  if (reason === "too_few_pairs") return "fewer than the minimum number of pairs";
  if (reason === "would_shrink_common_set") return "adding it would drop the common hours below the floor";
  return reason;
}
