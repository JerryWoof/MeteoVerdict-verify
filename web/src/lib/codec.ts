/** delta-tenths-v1, the inverse of scripts/derive_pages.py encode_row / encode_stations. */

export function decodeRow(text: string, hours: number, scale = 10): (number | null)[] {
  const parts = text === "" ? [] : text.split(",");
  const out: (number | null)[] = [];
  let prev = 0;
  let started = false;
  for (const part of parts) {
    if (part === "") {
      out.push(null);
      continue;
    }
    const delta = Number(part);
    const quantized = started ? prev + delta : delta;
    started = true;
    prev = quantized;
    out.push(quantized / scale);
  }
  if (out.length > hours) {
    throw new Error(`encoded row has ${out.length} hours, expected at most ${hours}`);
  }
  while (out.length < hours) out.push(null);
  return out;
}

export function decodeStations(block: string, stations: number, hours: number, scale = 10): (number | null)[][] {
  if (stations === 0) return [];
  const rows = block.split(";");
  if (rows.length !== stations) {
    throw new Error(`expected ${stations} station rows, found ${rows.length}`);
  }
  return rows.map((row) => decodeRow(row, hours, scale));
}

/** Display order of the default chart lines. The fifth slot is filled from the MAE ranking. */
export const DEFAULT_SERIES = ["blend", "ai", "dwd_icon_d2", "chmi_aladin_cz_1km"] as const;

export function preselect(series: string[], mae: number[]): string[] {
  const present = new Set(series);
  const out: string[] = DEFAULT_SERIES.filter((id) => present.has(id));
  const ranked = series
    .map((k, index) => ({ k, mae: mae[index] }))
    .filter((row) => Number.isFinite(row.mae))
    .sort((a, b) => a.mae - b.mae || a.k.localeCompare(b.k));
  for (const row of ranked) {
    if (out.includes(row.k)) continue;
    out.push(row.k);
    break;
  }
  return out;
}

const PALETTE = ["#c2410c", "#1d4ed8", "#6d28d9", "#a16207", "#0369a1", "#be123c", "#3f6212", "#0f766e", "#7c3aed", "#44403c"];

export function seriesColor(id: string): string {
  if (id === "ai") return "#0f6b66";
  if (id === "blend") return "#9a3412";
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 33 + id.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

export async function loadJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return JSON.parse(await new Response(stream).text()) as unknown;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}
