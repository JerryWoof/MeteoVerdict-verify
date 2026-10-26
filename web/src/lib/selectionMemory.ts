/** Per-page chart series ticks. A saved list means the user has customized that page. */

export type SeriesPage = "overview" | "snapshots";

function key(page: SeriesPage): string {
  return `mv-verify-series:${page}`;
}

export function loadSelection(page: SeriesPage, storage: Pick<Storage, "getItem"> | null = defaultStorage()): string[] | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key(page));
    if (raw == null) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return null;
  }
}

export function saveSelection(page: SeriesPage, ids: string[], storage: Pick<Storage, "setItem"> | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(key(page), JSON.stringify(ids));
  } catch {
    // Private mode can reject the write. The ticks still apply for this visit.
  }
}

function defaultStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
