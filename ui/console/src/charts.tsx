/** @jsxImportSource preact */
// Single-series charts for the stats page: a column chart over time and horizontal bar lists. One hue (--series-1,
// validated against both surfaces), thin marks with a 4px rounded data end on the baseline, hairline grid, a tooltip per
// column (also by keyboard), and a table view of the same numbers. Text always uses text colours, never the series hue.
import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";

export interface ColumnPoint { key: string; label: string; value: number; detail?: [string, string][] }

const MARGIN = { top: 12, right: 8, bottom: 26, left: 52 };
const MAX_BAR = 24;

/** A round step for about `count` gridlines up to `max`; integers only (counts and tokens). */
function ticks(max: number, count = 4): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / count, power = 10 ** Math.floor(Math.log10(raw)), unit = raw / power;
  const step = Math.max(1, (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10) * power);
  const out: number[] = [];
  for (let value = 0; value < max + step; value += step) out.push(value);
  return out;
}

/** Rounded at the data end (top), square on the baseline. */
function column(x: number, y: number, width: number, height: number): string {
  const r = Math.min(4, width / 2, height);
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}

function useWidth(fallback: number) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const measure = () => { if (element.clientWidth > 0) setWidth(element.clientWidth); };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { box, width };
}

export function ColumnChart({ points, name, format, axis, axisLabel, height = 240 }: {
  points: ColumnPoint[]; name: string; format: (value: number) => string; axis: (value: number) => string;
  /** The x-axis text of a point (shorter than its tooltip label). */
  axisLabel: (point: ColumnPoint) => string;
  height?: number;
}) {
  const { box, width } = useWidth(640);
  // The highlighted column belongs to the points it was chosen on: new data drops it without a reset effect racing a
  // hover that lands before the effect runs.
  const [chosen, setChosen] = useState<{ points: ColumnPoint[]; index: number } | null>(null);
  const active = chosen?.points === points ? chosen.index : null;
  const setActive = (index: number | null) => setChosen(index === null ? null : { points, index });

  const plotWidth = Math.max(10, width - MARGIN.left - MARGIN.right), plotHeight = height - MARGIN.top - MARGIN.bottom;
  const grid = ticks(Math.max(0, ...points.map(point => point.value)));
  const top = grid.at(-1)!;
  const band = plotWidth / Math.max(1, points.length);
  // A 2px surface gap between neighbours while there is room for it; very dense ranges drop the gap, never the data.
  const bar = band >= 4 ? Math.min(MAX_BAR, band - 2) : Math.max(0.5, band);
  const y = (value: number) => MARGIN.top + plotHeight - (value / top) * plotHeight;
  const every = Math.max(1, Math.ceil(points.length / Math.max(1, Math.floor(plotWidth / 72))));

  const onKeyDown = (event: KeyboardEvent) => {
    if (!points.length) return;
    const last = points.length - 1;
    const next = event.key === "ArrowRight" ? Math.min(last, (active ?? -1) + 1) : event.key === "ArrowLeft" ? Math.max(0, (active ?? points.length) - 1)
      : event.key === "Home" ? 0 : event.key === "End" ? last : event.key === "Escape" ? null : undefined;
    if (next === undefined) return;
    event.preventDefault();
    setActive(next);
  };

  const shown = active === null ? undefined : points[active];
  const tipLeft = active === null ? 0 : Math.min(Math.max(MARGIN.left + band * (active + 0.5), 80), width - 80);

  return (
    <div class="chart" ref={box}>
      <div class="chart-focus" tabIndex={0} role="group" aria-label={`${name}柱状图，共 ${points.length} 个时间段；左右方向键逐个查看`}
        onKeyDown={onKeyDown} onBlur={() => setActive(null)} onMouseLeave={() => setActive(null)}>
        <svg width={width} height={height} aria-hidden="true">
          {grid.map(value => (
            <g key={value}>
              <line class="chart-grid" x1={MARGIN.left} x2={width - MARGIN.right} y1={y(value)} y2={y(value)} />
              <text class="chart-axis" x={MARGIN.left - 8} y={y(value)} text-anchor="end" dominant-baseline="middle">{axis(value)}</text>
            </g>
          ))}
          {points.map((point, index) => {
            const x = MARGIN.left + band * index;
            const h = (point.value / top) * plotHeight;
            return (
              <g key={point.key}>
                {active === index && <rect class="chart-hover" x={x} y={MARGIN.top} width={band} height={plotHeight} />}
                {h > 0 && <path class="chart-bar" d={column(x + (band - bar) / 2, y(point.value), bar, h)} />}
                {index % every === 0 && (
                  <text class="chart-axis" x={x + band / 2} y={height - 8} text-anchor="middle">{axisLabel(point)}</text>
                )}
                {/* The hit target is the whole band, taller and wider than the mark. */}
                <rect class="chart-hit" x={x} y={MARGIN.top} width={band} height={plotHeight} onMouseEnter={() => setActive(index)} />
              </g>
            );
          })}
          <line class="chart-baseline" x1={MARGIN.left} x2={width - MARGIN.right} y1={y(0)} y2={y(0)} />
        </svg>
        {shown && (
          <div class="chart-tip" style={{ left: `${tipLeft}px`, top: `${MARGIN.top}px` }}>
            <div class="tip-value">{format(shown.value)}</div>
            <div class="tip-label">{shown.label}</div>
            {shown.detail?.map(([key, value]) => <div key={key} class="tip-row"><span>{key}</span><span>{value}</span></div>)}
          </div>
        )}
      </div>
      <div class="sr-only" aria-live="polite">{shown ? `${shown.label}：${name} ${format(shown.value)}` : ""}</div>
    </div>
  );
}

/** The same points as a table (the chart's accessible and exact view). */
export function ColumnTable({ points, columns }: { points: ColumnPoint[]; columns: string[] }) {
  return (
    <div class="table-wrap tall">
      <table class="data-table">
        <thead><tr><th>时间</th>{columns.map(column => <th key={column} class="num">{column}</th>)}</tr></thead>
        <tbody>
          {points.map(point => (
            <tr key={point.key}><td>{point.label}</td>{(point.detail ?? []).map(([key, value]) => <td key={key} class="num">{value}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface BarRow { key: string; label: ComponentChildren; value: number; text: string; title?: string; onClick?: () => void }

/** Ranked horizontal bars with the value written beside each (direct labels; the bars only carry the proportion). */
export function BarList({ rows, empty = "没有数据" }: { rows: BarRow[]; empty?: string }) {
  if (!rows.length) return <p class="muted bar-empty">{empty}</p>;
  const max = Math.max(...rows.map(row => row.value), 1);
  return (
    <ol class="bar-list">
      {rows.map(row => {
        const body = (
          <>
            <span class="bar-label">{row.label}</span>
            <span class="bar-value">{row.text}</span>
            <span class="bar-track"><span class="bar-fill" style={{ width: `${Math.max(row.value > 0 ? 1 : 0, (row.value / max) * 100)}%` }} /></span>
          </>
        );
        return (
          <li key={row.key} title={row.title}>
            {row.onClick ? <button type="button" class="bar-row" onClick={row.onClick}>{body}</button> : <div class="bar-row">{body}</div>}
          </li>
        );
      })}
    </ol>
  );
}
