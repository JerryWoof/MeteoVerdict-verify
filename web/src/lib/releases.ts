/** The visible Ledger list is oldest at the top. The default selection is that first row. */
export function pickDefaultRelease<T extends { id: string }>(snaps: T[]): string {
  return snaps[0]?.id ?? "";
}
