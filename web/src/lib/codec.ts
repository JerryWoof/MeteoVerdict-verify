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

/** Fixed series colors. ECMWF variants share one brown. Unknown ids use the spare pastel. */
const SERIES_COLOR: Record<string, string> = {
  ai: "#1F5FBF",
  blend: "#E8731A",
  combined: "#E8731A",
  dwd_icon_d2: "#0E9C8A",
  chmi_aladin_cz_1km: "#D6286F",
  chmi_aladin_central_europe_2km: "#8B1E1E",
  ecmwf_ifs: "#8C5A2B",
  ecmwf_ifs025: "#8C5A2B",
  ecmwf_aifs025_single: "#8C5A2B",
  cma_grapes_global: "#5FA82E",
  dmi_harmonie_arome_europe: "#C9A400",
  dwd_icon: "#6A3FB5",
  dwd_icon_eu: "#00A6D6",
  gem_global: "#B04AC4",
  geosphere_arome_austria: "#5A5A5A",
  jma_gsm: "#9EC5F0",
  knmi_harmonie_arome_europe: "#F7B07A",
  meteofrance_arpege_europe: "#86D6C3",
  meteofrance_arpege_world: "#F2A0C0",
  ncep_aigfs025: "#C3B1E8",
  ncep_gfs_global: "#B9DC8C",
  ukmo_global_deterministic_10km: "#E8D27A",
};

export const SERIES_FALLBACK = "#B5A27A";

export function seriesColor(id: string): string {
  return SERIES_COLOR[id] ?? SERIES_FALLBACK;
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
