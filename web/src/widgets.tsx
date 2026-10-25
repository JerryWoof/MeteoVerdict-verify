import type { Catalog, Excluded, ObsDay } from "./types";
import { seriesColor } from "./lib/codec";
import { fmt, reasonText, seriesName } from "./lib/format";

export function ScoreTable({
  names,
  unit,
  series,
  mae,
  bias,
  rmse,
  leadsFor,
}: {
  names: Record<string, string>;
  unit: string;
  series: string[];
  mae: number[];
  bias: number[];
  rmse: number[];
  leadsFor?: Record<string, number[]>;
}) {
  return (
    <div className="table-wrap">
      <table className="scores">
        <caption>Ordered by MAE on the common pairs. A lower MAE is a closer forecast. This order is not a prize.</caption>
        <thead>
          <tr>
            <th scope="col">Order</th>
            <th scope="col">Series</th>
            <th scope="col">MAE ({unit})</th>
            <th scope="col">Bias ({unit})</th>
            <th scope="col">RMSE ({unit})</th>
            {leadsFor && <th scope="col">Leads in the mean</th>}
          </tr>
        </thead>
        <tbody>
          {series.map((id, index) => (
            <tr key={id} className={id === "ai" ? "is-ai" : undefined}>
              <td className="num">{index + 1}</td>
              <td>
                <span className="swatch" style={{ background: seriesColor(id) }} />
                {seriesName(names, id)}
              </td>
              <td className="num">{fmt(mae[index])}</td>
              <td className="num">{fmt(bias[index])}</td>
              <td className="num">{fmt(rmse[index])}</td>
              {leadsFor && (
                <td className="num">{(leadsFor[id] ?? []).map((lead) => `D+${lead}`).join(", ") || "—"}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SeriesToggles({
  ids,
  names,
  selected,
  onChange,
}: {
  ids: string[];
  names: Record<string, string>;
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <fieldset className="series">
      <legend>Chart series</legend>
      <div className="series-row">
        {ids.map((id) => {
          const on = selected.includes(id);
          return (
            <label key={id} className={on ? "on" : ""}>
              <input
                type="checkbox"
                checked={on}
                onChange={() => onChange(on ? selected.filter((item) => item !== id) : [...selected, id])}
              />
              <span className="swatch" style={{ background: seriesColor(id) }} />
              {seriesName(names, id)}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export function ExcludedList({ items, names }: { items: Excluded[]; names: Record<string, string> }) {
  if (items.length === 0) return null;
  return (
    <details className="excluded">
      <summary>{items.length} series not in this table</summary>
      <ul>
        {items.map((item) => (
          <li key={item.k}>
            <strong>{item.name ?? seriesName(names, item.k)}</strong>
            {" — "}
            {reasonText(item.reason)}
            {` (${item.pairs} AI-paired hours, coverage ${(item.coverage * 100).toFixed(0)}%`}
            {item.intersection != null ? `, common hours if added: ${item.intersection}` : ""}
            ).
          </li>
        ))}
      </ul>
    </details>
  );
}

export function ObsNote({ days }: { days: ObsDay[] }) {
  const finals = days.filter((day) => day.quality === "final").length;
  const provisional = days.length - finals;
  return (
    <details className="obs">
      <summary>
        Observations: {finals} final {finals === 1 ? "day" : "days"}, {provisional} provisional
      </summary>
      <p>
        For each UTC day the newest <code>obs-YYYYMMDD.final.csv</code> (or <code>.final2</code> and so on) is used.
        Until that checked file exists, the day stays provisional: the frozen <code>obs-YYYYMMDD.csv</code> from ČHMÚ{" "}
        <code>now/</code>. Hours that are not in the repository yet are taken from the newest snapshot{" "}
        <code>obs-public</code>, cleaned the same way, and are also provisional. A final file is not overwritten by a
        snapshot. Scores change when a provisional day is replaced.
      </p>
      <ul>
        {days.map((day) => (
          <li key={day.day}>
            <span className={day.quality}>{day.quality}</span> {day.day} — {day.source}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      <span className="seg-label">{label}</span>
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          title={option.title}
          className={option.value === value ? "active" : ""}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <section className="empty">
      <h2>No derived scores on this deploy yet</h2>
      <p>{message}</p>
      <ol>
        <li>GitHub → Settings → Pages → Build and deployment → Source: GitHub Actions.</li>
        <li>Run the <code>pages-data</code> workflow (it also runs when this branch reaches main).</li>
        <li>The <code>pages</code> workflow then publishes the site. The custom domain file is <code>verify.meteoverdict.cz</code>.</li>
        <li>DNS: a CNAME record named <code>verify</code> pointing at <code>jerrywoof.github.io</code>. Leave the apex <code>meteoverdict.cz</code> as it is.</li>
      </ol>
    </section>
  );
}

export function variableOptions(catalog: Catalog, onlyChart: boolean) {
  const ids = onlyChart ? catalog.chart_variables : catalog.variables;
  return ids.map((id) => ({ value: id, label: catalog.variable_labels[id] ?? id }));
}
