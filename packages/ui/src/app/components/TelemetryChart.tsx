import { type Channel, findSampleIndex } from '@custom-overlay/core';
import { useEffect, useRef, useState } from 'react';
import { formatTime } from '../format';

export interface ChartTrace {
  label: string;
  channel: Channel;
  /** Seconds added to channel time to get timeline time. */
  offset: number;
  color: string;
  /** Multiplier applied to values (unit conversion). */
  scale?: number;
}

interface TelemetryChartProps {
  traces: ChartTrace[];
  /** Visible window, timeline seconds. */
  start: number;
  end: number;
  currentTime: number;
  onSeek(time: number): void;
  unit: string;
  height?: number;
}

const PADDING = { left: 44, right: 12, top: 10, bottom: 22 };

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Visible samples of a trace, decimated to about two points per pixel. */
function visiblePoints(trace: ChartTrace, start: number, end: number, width: number): [number, number][] {
  const { time, values } = trace.channel;
  const scale = trace.scale ?? 1;
  const first = Math.max(0, findSampleIndex(time, start - trace.offset));
  const last = Math.min(time.length - 1, findSampleIndex(time, end - trace.offset) + 1);
  const stride = Math.max(1, Math.floor((last - first) / (width * 2)));
  const points: [number, number][] = [];
  for (let i = first; i <= last; i += stride) {
    points.push([(time[i] as number) + trace.offset, (values[i] as number) * scale]);
  }
  return points;
}

function niceStep(range: number): number {
  const raw = range / 5;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const nice = normalized < 1.5 ? 1 : normalized < 3 ? 2 : normalized < 7 ? 5 : 10;
  return nice * magnitude;
}

export function TelemetryChart({
  traces,
  start,
  end,
  currentTime,
  onSeek,
  unit,
  height = 180,
}: TelemetryChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(600);
  const dragging = useRef(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(200, Math.floor(entry.contentRect.width)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || end <= start) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const plotW = width - PADDING.left - PADDING.right;
    const plotH = height - PADDING.top - PADDING.bottom;
    const series = traces.map((t) => ({ trace: t, points: visiblePoints(t, start, end, plotW) }));
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const { points } of series) {
      for (const [, v] of points) {
        if (Number.isNaN(v)) continue;
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
    }
    if (!Number.isFinite(min)) {
      min = 0;
      max = 1;
    }
    if (max - min < 1e-6) max = min + 1;
    const x = (t: number) => PADDING.left + ((t - start) / (end - start)) * plotW;
    const y = (v: number) => PADDING.top + (1 - (v - min) / (max - min)) * plotH;

    const grid = cssVar('--chart-grid');
    const text = cssVar('--text-muted');
    ctx.font = '11px system-ui, sans-serif';
    ctx.strokeStyle = grid;
    ctx.fillStyle = text;
    ctx.lineWidth = 1;
    const vStep = niceStep(max - min);
    for (let v = Math.ceil(min / vStep) * vStep; v <= max; v += vStep) {
      ctx.beginPath();
      ctx.moveTo(PADDING.left, y(v));
      ctx.lineTo(width - PADDING.right, y(v));
      ctx.stroke();
      ctx.fillText(v.toFixed(vStep < 1 ? 1 : 0), 4, y(v) + 4);
    }
    const tStep = niceStep(end - start);
    for (let t = Math.ceil(start / tStep) * tStep; t <= end; t += tStep) {
      ctx.fillText(formatTime(t, tStep < 1), x(t) - 16, height - 6);
    }
    ctx.fillText(unit, 4, PADDING.top + 2);

    for (const { trace, points } of series) {
      ctx.strokeStyle = trace.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let pen = false;
      for (const [t, v] of points) {
        if (Number.isNaN(v)) {
          pen = false;
          continue;
        }
        if (pen) ctx.lineTo(x(t), y(v));
        else ctx.moveTo(x(t), y(v));
        pen = true;
      }
      ctx.stroke();
    }

    if (currentTime >= start && currentTime <= end) {
      ctx.strokeStyle = cssVar('--accent');
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x(currentTime), PADDING.top);
      ctx.lineTo(x(currentTime), PADDING.top + plotH);
      ctx.stroke();
    }
  }, [traces, start, end, currentTime, width, height, unit]);

  const timeAt = (clientX: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return start;
    const ratio = (clientX - rect.left - PADDING.left) / (rect.width - PADDING.left - PADDING.right);
    return Math.min(end, Math.max(start, start + ratio * (end - start)));
  };

  return (
    <div className="chart" ref={containerRef}>
      <canvas
        ref={canvasRef}
        style={{ width, height }}
        onPointerDown={(e) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          onSeek(timeAt(e.clientX));
        }}
        onPointerMove={(e) => dragging.current && onSeek(timeAt(e.clientX))}
        onPointerUp={() => {
          dragging.current = false;
        }}
      />
      <div className="chart-legend">
        {traces.map((t) => (
          <span key={t.label}>
            <i style={{ background: t.color }} />
            {t.label}
          </span>
        ))}
      </div>
    </div>
  );
}
