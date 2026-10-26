import { useId, useState } from "react";
import { fmt } from "./lib/format";

const FOCUS_WIDTH = 3.5;
const DIM = 0.25;

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

function emphasisPaint(id: string, hoverId: string | null, pinId: string | null, base: number): { opacity: number; width: number } {
  const focus = hoverId ?? pinId;
  if (!focus) return { opacity: 1, width: base };
  if (focus === id) return { opacity: 1, width: FOCUS_WIDTH };
  return { opacity: DIM, width: base };
}

function ChartTip({ title, series, index }: { title: string; series: ChartSeries[]; index: number }) {
  return (
    <div className="tooltip">
      <strong>{title}</strong>
      {series.map((line) => (
        <span key={line.id}>
          <i style={{ background: line.color }} />
          {line.name}: {fmt(line.values[index] ?? null)}
        </span>
      ))}
    </div>
  );
}

export function LineChart({
  labels,
  series,
  ariaLabel,
  yLabel,
  zero = false,
  hoverText,
  tickAt,
  marks,
}: Frame & {
  hoverText?: string[];
  tickAt?: boolean[];
  marks?: { index: number; text: string }[];
}) {
  const [hover, setHover] = useState<number | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [pinId, setPinId] = useState<string | null>(null);
  const labelId = useId();
  const pad = { l: 56, r: 18, t: 22, b: marks && marks.length > 0 ? 48 : 36 };
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
        onMouseLeave={() => {
          setHover(null);
          setHoverId(null);
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) setPinId(null);
        }}
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
        {series.map((line) => {
          const paint = emphasisPaint(line.id, hoverId, pinId, line.width ?? 2);
          const d = path(line.values);
          return (
            <path
              key={line.id}
              d={d}
              fill="none"
              stroke={line.color}
              strokeWidth={paint.width}
              strokeOpacity={paint.opacity}
              strokeDasharray={line.dash}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          );
        })}
        {series.map((line) => (
          <path
            key={`${line.id}-hit`}
            d={path(line.values)}
            className="hit"
            stroke="transparent"
            strokeWidth={14}
            tabIndex={0}
            onMouseEnter={() => setHoverId(line.id)}
            onMouseLeave={() => setHoverId((current) => (current === line.id ? null : current))}
            onFocus={() => setHoverId(line.id)}
            onBlur={() => setHoverId((current) => (current === line.id ? null : current))}
            onClick={(event) => {
              event.stopPropagation();
              setPinId(line.id);
            }}
          >
            <title>{line.name}</title>
          </path>
        ))}
        {hover != null && labels[hover] != null && (
          <line x1={xAt(hover)} x2={xAt(hover)} y1={pad.t} y2={pad.t + innerH} className="hover-line" />
        )}
        {labels.map((label, index) =>
          (tickAt ? tickAt[index] : index % labelStep === 0) ? (
            <text key={label + index} x={xAt(index)} y={H - 14} className="tick" textAnchor="middle">
              {label}
            </text>
          ) : null,
        )}
        {marks?.map((mark) => (
          <text key={mark.text + mark.index} x={xAt(mark.index)} y={H - 30} className="day-mark" textAnchor="middle">
            {mark.text}
          </text>
        ))}
        {yLabel && (
          <text x={pad.l - 8} y={14} className="y-unit" textAnchor="end">
            {yLabel}
          </text>
        )}
      </svg>
      {hover != null && <ChartTip title={hoverText?.[hover] ?? labels[hover]} series={series} index={hover} />}
    </div>
  );
}

export function BarChart({
  labels,
  series,
  ariaLabel,
  yLabel,
  onSeries,
}: Frame & { onSeries?: (id: string) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [pinId, setPinId] = useState<string | null>(null);
  const labelId = useId();
  const pad = { l: 56, r: 12, t: 22, b: 36 };
  const innerW = W - pad.l - pad.r;
  const innerH = H - pad.t - pad.b;
  const [min, max] = extent(series, true);
  const group = innerW / Math.max(labels.length, 1);
  const bar = Math.min(18, (group * 0.8) / Math.max(series.length, 1));
  const yAt = (value: number) => pad.t + ((max - value) / (max - min || 1)) * innerH;
  const y0 = yAt(0);

  return (
    <div className="chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-labelledby={labelId}
        onMouseLeave={() => {
          setHover(null);
          setHoverId(null);
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) setPinId(null);
        }}
      >
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
                const paint = emphasisPaint(line.id, hoverId, pinId, 2);
                return (
                  <rect
                    key={line.id}
                    x={left + seriesIndex * bar}
                    y={top}
                    width={Math.max(bar - 2, 1)}
                    height={height}
                    fill={line.color}
                    fillOpacity={paint.opacity}
                    stroke={paint.width > 2 ? line.color : "none"}
                    strokeWidth={paint.width > 2 ? 1.5 : 0}
                    rx={1}
                    className="hit"
                    tabIndex={0}
                    role={onSeries ? "button" : undefined}
                    aria-label={onSeries ? `${line.name}. Open how this MAE was calculated.` : line.name}
                    onMouseEnter={() => {
                      setHover(index);
                      setHoverId(line.id);
                    }}
                    onFocus={() => {
                      setHover(index);
                      setHoverId(line.id);
                    }}
                    onBlur={() => {
                      setHoverId((current) => (current === line.id ? null : current));
                      setHover((current) => (current === index ? null : current));
                    }}
                    onClick={
                      onSeries
                        ? (event) => {
                            event.stopPropagation();
                            setPinId(line.id);
                            onSeries(line.id);
                          }
                        : (event) => {
                            event.stopPropagation();
                            setPinId(line.id);
                          }
                    }
                    onKeyDown={
                      onSeries
                        ? (event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              setPinId(line.id);
                              onSeries(line.id);
                            }
                          }
                        : undefined
                    }
                  >
                    <title>{onSeries ? `${line.name}. Open how this MAE was calculated.` : line.name}</title>
                  </rect>
                );
              })}
              <text x={pad.l + index * group + group / 2} y={H - 14} className="tick" textAnchor="middle">
                {label}
              </text>
            </g>
          );
        })}
        {yLabel && (
          <text x={pad.l - 8} y={14} className="y-unit" textAnchor="end">
            {yLabel}
          </text>
        )}
      </svg>
      {hover != null && <ChartTip title={labels[hover] ?? ""} series={series} index={hover} />}
    </div>
  );
}
