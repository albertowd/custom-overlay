import {
  type DataBound,
  type DataRange,
  type DataRangeProblem,
  type Lap,
  lapsFromSeries,
  resolveDataRange,
} from '@custom-overlay/core';
import { useMemo } from 'react';
import { formatTime } from '../format';
import { useT } from '../i18n';
import { useStore } from '../store';
import { fullSeries } from '../values';
import { TimeInput } from './TimeInput';

type StartChoice = 'whole' | 'time' | 'lap';
type EndChoice = 'whole' | 'time' | 'lap' | 'leaveOut';

/** Laps of the whole session (the project's lap timing), for lap bounds. */
export function useSessionLaps(): Lap[] {
  const snapshot = useStore((s) => s.values);
  return useMemo(
    () => (snapshot ? lapsFromSeries(fullSeries(snapshot), 'lap.time', 'lap.number') : []),
    [snapshot],
  );
}

function startChoice(bound: DataBound | null): StartChoice {
  return bound ? bound.kind : 'whole';
}

function endChoice(bound: DataBound | null): EndChoice {
  if (!bound) return 'whole';
  if (bound.kind === 'lap' && bound.fromEnd) return 'leaveOut';
  return bound.kind;
}

/** Laps fully inside a range. */
function keptLaps(laps: readonly Lap[], start: number, end: number): number {
  return laps.filter(
    (lap) =>
      Number.isFinite(lap.duration) && lap.start >= start - 1e-6 && lap.start + lap.duration <= end + 1e-6,
  ).length;
}

/**
 * A lap number field. `offset` shifts what is shown: leaving out N laps is stored as the
 * (N + 1)th completed lap from the end.
 */
function LapField({
  label,
  lap,
  offset = 0,
  onChange,
}: {
  label: string;
  lap: number;
  offset?: number;
  onChange(lap: number): void;
}) {
  return (
    <label className="field">
      {label}
      <input
        type="number"
        min={1 + offset}
        step={1}
        value={lap + offset}
        onChange={(e) => {
          const n = Math.round(Number(e.target.value));
          if (Number.isFinite(n) && n - offset >= 1) onChange(n - offset);
        }}
      />
    </label>
  );
}

/**
 * Start and end of a data range: the whole session, a time, or a lap (from the start, or leaving
 * out the last laps), with the resulting times and kept laps.
 */
export function DataRangeEditor({ value, onChange }: { value: DataRange; onChange(range: DataRange): void }) {
  const t = useT();
  const laps = useSessionLaps();
  const resolved = useMemo(() => resolveDataRange(value, laps), [value, laps]);
  const lapCount = laps.length;

  const setStart = (choice: StartChoice) => {
    const start: DataBound | null =
      choice === 'whole'
        ? null
        : choice === 'time'
          ? { kind: 'time', time: laps[1]?.start ?? 0 }
          : { kind: 'lap', lap: Math.min(2, Math.max(1, lapCount)), fromEnd: false };
    onChange({ ...value, start });
  };
  const setEnd = (choice: EndChoice) => {
    const end: DataBound | null =
      choice === 'whole'
        ? null
        : choice === 'time'
          ? { kind: 'time', time: laps[laps.length - 1]?.start ?? 0 }
          : choice === 'lap'
            ? { kind: 'lap', lap: Math.max(1, lapCount - 1), fromEnd: false }
            : // Leave out the last N laps: end at the end of the (N + 1)th completed lap from the end.
              { kind: 'lap', lap: 2, fromEnd: true };
    onChange({ ...value, end });
  };

  const describeProblem = (problem: DataRangeProblem) => {
    if (problem.code === 'empty') return t('track.dataRange.problems.empty');
    return problem.fromEnd
      ? t('track.dataRange.problems.notEnoughLaps', { count: problem.lap - 1 })
      : t('track.dataRange.problems.lapMissing', { lap: problem.lap });
  };

  const { start, end } = resolved.range;
  const trimmed = start > Number.NEGATIVE_INFINITY || end < Number.POSITIVE_INFINITY;

  return (
    <div className="data-range">
      <div className="data-range-row">
        <label className="field">
          {t('track.dataRange.start')}
          <select value={startChoice(value.start)} onChange={(e) => setStart(e.target.value as StartChoice)}>
            <option value="whole">{t('track.dataRange.whole')}</option>
            <option value="time">{t('track.dataRange.atTime')}</option>
            <option value="lap" disabled={lapCount === 0}>
              {t('track.dataRange.lapStart')}
            </option>
          </select>
        </label>
        {value.start?.kind === 'time' && (
          <TimeInput
            label={t('track.dataRange.time')}
            value={value.start.time}
            onCommit={(time) => {
              if (time === null) return false;
              onChange({ ...value, start: { kind: 'time', time } });
              return true;
            }}
          />
        )}
        {value.start?.kind === 'lap' && (
          <LapField
            label={t('track.dataRange.lap')}
            lap={value.start.lap}
            onChange={(lap) => onChange({ ...value, start: { kind: 'lap', lap, fromEnd: false } })}
          />
        )}
      </div>
      <div className="data-range-row">
        <label className="field">
          {t('track.dataRange.end')}
          <select value={endChoice(value.end)} onChange={(e) => setEnd(e.target.value as EndChoice)}>
            <option value="whole">{t('track.dataRange.whole')}</option>
            <option value="time">{t('track.dataRange.atTime')}</option>
            <option value="lap" disabled={lapCount === 0}>
              {t('track.dataRange.lapEnd')}
            </option>
            <option value="leaveOut" disabled={lapCount === 0}>
              {t('track.dataRange.leaveOut')}
            </option>
          </select>
        </label>
        {value.end?.kind === 'time' && (
          <TimeInput
            label={t('track.dataRange.time')}
            value={value.end.time}
            onCommit={(time) => {
              if (time === null) return false;
              onChange({ ...value, end: { kind: 'time', time } });
              return true;
            }}
          />
        )}
        {value.end?.kind === 'lap' && !value.end.fromEnd && (
          <LapField
            label={t('track.dataRange.lap')}
            lap={value.end.lap}
            onChange={(lap) => onChange({ ...value, end: { kind: 'lap', lap, fromEnd: false } })}
          />
        )}
        {value.end?.kind === 'lap' && value.end.fromEnd && (
          <LapField
            label={t('track.dataRange.lapsLeftOut')}
            lap={value.end.lap}
            offset={-1}
            onChange={(lap) => onChange({ ...value, end: { kind: 'lap', lap, fromEnd: true } })}
          />
        )}
      </div>
      <p className="muted small">
        {trimmed
          ? t('track.dataRange.summary', {
              start: start > Number.NEGATIVE_INFINITY ? formatTime(start) : t('track.dataRange.sessionStart'),
              end: end < Number.POSITIVE_INFINITY ? formatTime(end) : t('track.dataRange.sessionEnd'),
            })
          : t('track.dataRange.untrimmed')}
        {lapCount > 0 &&
          ` · ${t('track.dataRange.keptLaps', { count: keptLaps(laps, start, end), total: lapCount })}`}
      </p>
      {resolved.problems.map((problem) => (
        <p key={JSON.stringify(problem)} className="error-text small">
          {describeProblem(problem)}
        </p>
      ))}
      {lapCount === 0 && <p className="muted small">{t('track.dataRange.noLaps')}</p>}
    </div>
  );
}
