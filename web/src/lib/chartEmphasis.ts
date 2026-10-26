/** Stroke width of a focused mark. Same bolding the line chart uses on hover. */
export const FOCUS_WIDTH = 3.5;

/** Opacity of marks outside the focused lead or series. */
export const DIM_OPACITY = 0.25;

export type MarkPaint = { opacity: number; width: number };

/** Hover wins over pin. A null focus leaves every mark at full strength. Index 0 is a real focus. */
export function markPaint(active: boolean, focus: string | number | null, base: number): MarkPaint {
  if (focus == null) return { opacity: 1, width: base };
  if (active) return { opacity: 1, width: FOCUS_WIDTH };
  return { opacity: DIM_OPACITY, width: base };
}

/** Line chart: focus is one series id across the whole line. */
export function seriesEmphasis(
  id: string,
  hoverId: string | null,
  pinId: string | null,
  base: number,
): MarkPaint {
  const focus = hoverId ?? pinId;
  return markPaint(focus === id, focus, base);
}

/**
 * Grouped MAE bars: focus is the lead column (D+n), not the model.
 * Every bar in that column is bold; bars in other leads dim.
 * Which model is under the pointer is not a paint input.
 */
export function barLeadEmphasis(
  leadIndex: number,
  hoverLead: number | null,
  pinLead: number | null,
  base = 2,
): MarkPaint {
  const focus = hoverLead ?? pinLead;
  return markPaint(focus === leadIndex, focus, base);
}
