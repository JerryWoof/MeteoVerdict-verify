import { useId, useState } from "react";
import { fmt } from "./lib/format";

export type ChartSeries = {
  id: string;
  name: string;
  color: string;
  values: (number | null)[];
  width?: number;
  dash?: string;
};

type Frame = { labels: string[]; series: ChartSeries[]; ariaLabel: string; yLabel?: string; zero?: boolean };

const W = 720;
const H = 280;

function extent(series: ChartSeries[], zero: boolean): [number, number] {
  let min = zero ? 0 : Infinity;
  let max = zero ? 0 : -Infinity;
  for (const line of series) {
    for (const value of line.values) {
      if (value == null) continue;
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) {
    const pad = Math.abs(min) > 0 ? Math.abs(min) * 0.2 : 1;
    return [zero ? 0 : min - pad, max + pad];
  }
  const pad = (max - min) * 0.08;
  return [zero ? Math.min(0, min) : min - pad, max + pad];
}

function ticks(min: number, max: number): number[] {
  const span = max - min || 1;
  const step = span / 4;
  return Array.from({ length: 5 }, (_, index) => min + step * index);
}

export function LineChart({ labels, series, ariaLabel, yLabel, zero = false }: Frame) {
  const [hover, setHover] = useState<number | null>(null);
  const labelId = useId();
  const pad = { l: 52, r: 16, t: 16, b: 42 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const [min, max] = extent(series, zero);
  const n = Math.max(labels.length, 1);
  const xAt = (index: number) => pad.l + (n === 1 ? innerW / 2 : (index / (n - 1)) * innerW);
  const yAt = (value: number) => pad.t + ((max - value) / (max - min || 1)) * innerH;

  function path(values: (number | null)[]) {
    let d = "";
    let pen = false;
    values.forEach((value, index) => {
      if (value == null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${xAt(index).toFixed(1)},${yAt(value).toFixed(1)}`;
      pen = true;
    });
    return d;
  }

  const labelStep = n > 12 ? Math.ceil(n / 8) : 1;

  return (
    <div className="chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-labelledby={labelId}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          const x = ((event.clientX - box.left) / box.width) * W;
          if (n === 1) {
            setHover(0);
            return;
          }
          const index = Math.round(((x - pad.l) / innerW) * (n - 1));
          setHover(Math.max(0, Math.min(n - 1, index)));
        }}
      >
        <title id={labelId}>{ariaLabel}</title>
        {ticks(min, max).map((tick) => (
          <g key={tick}>
            <line x1={pad.l} x2={W - pad.r} y1={yAt(tick)} y2={yAt(tick)} className="grid" />
            <text x={pad.l - 8} y={yAt(tick) + 4} className="tick" textAnchor="end">
              {fmt(tick, Math.abs(max - min) < 2 ? 2 : 1)}
            </text>
          </g>
        ))}
        {series.map((line) => (
          <path
            key={line.id}
            d={path(line.values)}
            fill="none"
            stroke={line.color}
            strokeWidth={line.width ?? 2}
            strokeDasharray={line.dash}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {hover != null && labels[hover] != null && (
          <line x1={xAt(hover)} x2={xAt(hover)} y1={pad.t} y2={pad.t + innerH} className="hover-line" />
        )}
        {labels.map((label, index) =>
          index % labelStep === 0 ? (
            <text key={label + index} x={xAt(index)} y={H - 16} className="tick" textAnchor="middle">
              {label}
            </text>
          ) : null,
        )}
        {yLabel && (
          <text x={16} y={18} className="y-label">
            {yLabel}
          </text>
        )}
      </svg>
      {hover != null && (
        <div className="tooltip">
          <strong>{labels[hover]}</strong>
          {series.map((line) => (
            <span key={line.id}>
              <i style={{ background: line.color }} />
              {line.name}: {fmt(line.values[hover] ?? null)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function BarChart({ labels, series, ariaLabel, yLabel }: Frame) {
  const labelId = useId();
  const pad = { l: 52, r: 12, t: 16, b: 36 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const [min, max] = extent(series, true);
  const group = innerW / Math.max(labels.length, 1);
  const bar = Math.min(18, (group * 0.8) / Math.max(series.length, 1));
  const yAt = (value: number) => pad.t + ((max - value) / (max - min || 1)) * innerH;
  const y0 = yAt(0);

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={labelId}>
        <title id={labelId}>{ariaLabel}</title>
        {ticks(min, max).map((tick) => (
          <g key={tick}>
            <line x1={pad.l} x2={W - pad.r} y1={yAt(tick)} y2={yAt(tick)} className="grid" />
            <text x={pad.l - 8} y={yAt(tick) + 4} className="tick" textAnchor="end">
              {fmt(tick, 1)}
            </text>
          </g>
        ))}
        {labels.map((label, index) => {
          const left = pad.l + index * group + (group - bar * series.length) / 2;
          return (
            <g key={label}>
              {series.map((line, seriesIndex) => {
                const value = line.values[index];
                if (value == null) return null;
                const y = yAt(value);
                const top = Math.min(y, y0);
                const height = Math.max(1, Math.abs(y0 - y));
                return <rect key={line.id} x={left + seriesIndex * bar} y={top} width={bar - 2} height={height} fill={line.color} rx={1} />;
              })}
              <text x={pad.l + index * group + group / 2} y={H - 14} className="tick" textAnchor="middle">
                {label}
              </text>
            </g>
          );
        })}
        {yLabel && (
          <text x={16} y={18} className="y-label">
            {yLabel}
          </text>
        )}
      </svg>
    </div>
  );
}
