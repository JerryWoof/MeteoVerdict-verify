export type Station = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  elev: number;
};

export type CatalogSnap = {
  id: string;
  tag: string;
  time: string;
  issue_time: string | null;
  model_version: string;
  sha256: string;
  file: string;
  file_sha256: string;
  file_bytes: number;
  raw_bytes: number;
  chart_hours: number;
};

export type VersionMeta = {
  model_version: string;
  snapshots: number;
  first: string | null;
  last: string | null;
  key: "not_enough_data" | "preliminary" | "recorded_60";
  days: number;
  text: string;
};

export type ObsDay = { day: string; quality: "final" | "provisional"; source: string };

export type Catalog = {
  version: number;
  kind: string;
  generated: string;
  product: string;
  host: string;
  variables: string[];
  variable_labels: Record<string, string>;
  chart_variables: string[];
  primary: string[];
  units: Record<string, string>;
  names: Record<string, string>;
  leads: number[];
  thresholds: { min_pairs: number; keep_fraction: number; scale: number; enc: string };
  stations: Station[];
  versions: VersionMeta[];
  snapshots: CatalogSnap[];
  obs_days: ObsDay[];
  withdrawn_skipped: string[];
  provenance: {
    rules: string;
    thresholds: { note: string; min_pairs: number; keep_fraction: number };
    obs: { rule: string; files?: string[] };
    ledger?: {
      chain_head?: string;
      ok_scored?: number;
      missing?: number;
      withdrawn?: number;
      first?: string;
      last?: string;
      rows?: number;
    };
    chart?: { note: string };
  };
};

export type Excluded = {
  k: string;
  name?: string;
  pairs: number;
  coverage: number;
  reason: string;
  intersection?: number;
};

export type LeadScore = {
  n: number;
  ai_pairs: number;
  floor: number;
  snaps: number;
  stations: number;
  series: string[];
  mae: number[];
  bias: number[];
  rmse: number[];
  excluded: Excluded[];
  dropped_run_unavailable: Record<string, number>;
  short: boolean;
};

export type OverallScore = {
  leads_used: number[];
  series: string[];
  mae: number[];
  bias: number[];
  rmse: number[];
  n_by_lead: Record<string, number>;
  leads_for: Record<string, number[]>;
};

export type DayBlock = { series: string[]; n: number[]; mae: (number | null)[][] };
export type StationBlock = { series: string[]; ids: string[]; n: number[]; mae: (number | null)[][] };

export type VariableScore = {
  leads: Record<string, LeadScore>;
  overall: OverallScore;
  by_day: { days: string[]; leads: Record<string, DayBlock> };
  by_station: Record<string, StationBlock>;
};

export type Scores = {
  version: number;
  generated: string;
  by_version: Record<string, Record<string, VariableScore>>;
};

export type SnapFile = {
  id: string;
  snapshot_time: string;
  issue_time: string | null;
  model_version: string;
  sha256: string;
  lead0: number;
  hours: number;
  scale: number;
  enc: string;
  stations: string[];
  series: string[];
  v: Record<string, { obs: string; s: string[] }>;
};

export type LeadPick = number | "all";
