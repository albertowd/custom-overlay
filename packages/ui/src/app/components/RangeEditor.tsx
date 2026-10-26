import { type PointerEvent as ReactPointerEvent, useEffect, useRef } from 'react';
import { formatTime } from '../format';
import { useT } from '../i18n';
import { useStore } from '../store';
import { TimeInput } from './TimeInput';

export interface TimeRange {
  /** Timeline seconds; null follows the timeline start / end. */
  start: number | null;
  end: number | null;
}

interface RangeEditorProps {
  range: TimeRange;
  /** Timeline bounds. */
  min: number;
  max: number;
  frameRate: number;
  onChange(range: TimeRange): void;
  /**
   * Where null bounds go, the timeline bounds by default. When it is narrower (the Track data
   * range), one button goes back to it and another selects the whole timeline.
   */
  defaults?: { start: number; end: number; label: string; emptyHint: string };
  /** I / O set the start / end at the playhead (one editor per screen). */
  shortcuts?: boolean;
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/** A labelled time field of the range; empty follows `fallback`. */
function TimeField({
  label,
  value,
  fallback,
  emptyHint,
  onChange,
}: {
  label: string;
  value: number | null;
  fallback: number;
  emptyHint?: string;
  onChange(value: number | null): boolean;
}) {
  const t = useT();
  return (
    <TimeInput
      label={label}
      value={value}
      placeholder={fallback}
      emptyHint={emptyHint}
      onCommit={onChange}
      rejectMessage={t('track.range.rejected')}
    />
  );
}

/** The timeline with the export range, its two handles and the playhead. Click to seek. */
function TrimBar({
  min,
  max,
  start,
  end,
  time,
  snap,
  onStart,
  onEnd,
  onSeek,
}: {
  min: number;
  max: number;
  start: number;
  end: number;
  time: number;
  snap(time: number): number;
  onStart(time: number): void;
  onEnd(time: number): void;
  onSeek(time: number): void;
}) {
  const t = useT();
  const barRef = useRef<HTMLDivElement>(null);
  const dragging = useRef<'start' | 'end' | 'seek' | null>(null);
  const span = Math.max(max - min, 1e-9);
  const percent = (t: number) => `${((Math.min(Math.max(t, min), max) - min) / span) * 100}%`;

  const timeAt = (clientX: number) => {
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return min;
    return snap(min + Math.min(Math.max((clientX - rect.left) / rect.width, 0), 1) * span);
  };

  const apply = (clientX: number) => {
    const t = timeAt(clientX);
    if (dragging.current === 'start') onStart(t);
    else if (dragging.current === 'end') onEnd(t);
    else if (dragging.current === 'seek') onSeek(t);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const handle = (e.target as HTMLElement).dataset.handle;
    dragging.current = handle === 'start' || handle === 'end' ? handle : 'seek';
    e.currentTarget.setPointerCapture(e.pointerId);
    apply(e.clientX);
  };

  return (
    <div
      ref={barRef}
      className="trim-bar"
      onPointerDown={onPointerDown}
      onPointerMove={(e) => dragging.current && apply(e.clientX)}
      onPointerUp={() => {
        dragging.current = null;
      }}
    >
      <div
        className="trim-selection"
        style={{ left: percent(start), width: `calc(${percent(end)} - ${percent(start)})` }}
      />
      <div className="trim-playhead" style={{ left: percent(time) }} />
      <div
        className="trim-handle"
        data-handle="start"
        style={{ left: percent(start) }}
        title={t('track.range.dragStart')}
      />
      <div
        className="trim-handle"
        data-handle="end"
        style={{ left: percent(end) }}
        title={t('track.range.dragEnd')}
      />
    </div>
  );
}

/** A time range: typed start / end times, a trim bar under the player and playhead shortcuts. */
export function RangeEditor({
  range,
  min,
  max,
  frameRate,
  onChange,
  defaults,
  shortcuts = true,
}: RangeEditorProps) {
  const t = useT();
  const currentTime = useStore((s) => s.currentTime);
  const seek = useStore((s) => s.seek);
  const frame = 1 / (frameRate || 30);
  const fallback = defaults ?? { start: min, end: max };
  const narrower = fallback.start !== min || fallback.end !== max;
  const emptyHint = defaults && narrower ? defaults.emptyHint : undefined;
  const start = range.start ?? fallback.start;
  const end = range.end ?? fallback.end;
  const snap = (t: number) => Math.round(t / frame) * frame;

  const setStart = (t: number | null) => {
    if (t !== null && (t < min || t >= end)) return false;
    onChange({ ...range, start: t });
    return true;
  };
  const setEnd = (t: number | null) => {
    if (t !== null && (t > max || t <= start)) return false;
    onChange({ ...range, end: t });
    return true;
  };

  // I / O set the start / end at the playhead, like video editors.
  const latest = useRef({ setStart, setEnd });
  latest.current = { setStart, setEnd };
  useEffect(() => {
    if (!shortcuts) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (isTyping(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
      const time = snap(useStore.getState().currentTime);
      if (event.key === 'i' || event.key === 'I') latest.current.setStart(time);
      if (event.key === 'o' || event.key === 'O') latest.current.setEnd(time);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const duration = Math.max(0, end - start);
  const playhead = snap(currentTime);

  return (
    <div className="range-editor">
      <TrimBar
        min={min}
        max={max}
        start={start}
        end={end}
        time={currentTime}
        snap={snap}
        onStart={(t) => setStart(Math.min(Math.max(t, min), end - frame))}
        onEnd={(t) => setEnd(Math.max(Math.min(t, max), start + frame))}
        onSeek={seek}
      />
      <div className="range-fields">
        <TimeField
          label={t('common.start')}
          value={range.start}
          fallback={fallback.start}
          emptyHint={emptyHint}
          onChange={setStart}
        />
        <TimeField
          label={t('common.end')}
          value={range.end}
          fallback={fallback.end}
          emptyHint={emptyHint}
          onChange={setEnd}
        />
        <div className="range-summary">
          <span className="timecode">
            {formatTime(start)} – {formatTime(end)}
          </span>
          <span className="muted small">
            {formatTime(duration)} · {t('track.range.frames', { count: Math.round(duration * frameRate) })}
          </span>
        </div>
      </div>
      <div className="row wrap">
        <button
          type="button"
          onClick={() => setStart(playhead)}
          title={t('track.range.shortcut', { key: 'I' })}
        >
          {t('track.range.startAtPlayhead')}
        </button>
        <button
          type="button"
          onClick={() => setEnd(playhead)}
          title={t('track.range.shortcut', { key: 'O' })}
        >
          {t('track.range.endAtPlayhead')}
        </button>
        <button type="button" onClick={() => seek(start)}>
          {t('track.range.goToStart')}
        </button>
        <button type="button" onClick={() => seek(end)}>
          {t('track.range.goToEnd')}
        </button>
        {defaults && narrower && (
          <button
            type="button"
            onClick={() => onChange({ start: null, end: null })}
            disabled={range.start === null && range.end === null}
          >
            {defaults.label}
          </button>
        )}
        <button
          type="button"
          onClick={() => onChange(narrower ? { start: min, end: max } : { start: null, end: null })}
          disabled={narrower ? start === min && end === max : range.start === null && range.end === null}
        >
          {t('track.range.wholeTimeline')}
        </button>
      </div>
    </div>
  );
}
