import {
  AUTO_SYNC_MIN_CONFIDENCE,
  embeddedSourceId,
  getChannel,
  itemsRequiringSync,
  type Project,
  referenceItem,
  type SourceRef,
  STEP_DEFINITIONS,
  StandardChannel,
  type StepStatus,
  type SyncResult,
  sampleAt,
  type TelemetrySeries,
  type VideoRef,
} from '@custom-overlay/core';
import { useMemo, useState } from 'react';
import { Badge, StepHeader } from '../components/common';
import { Preview } from '../components/Preview';
import { type ChartTrace, TelemetryChart } from '../components/TelemetryChart';
import { TimeInput } from '../components/TimeInput';
import { formatDateTime, formatOffset, formatTime, formatValue } from '../format';
import { coreText, useT } from '../i18n';
import { useStore, useTimeline } from '../store';

type Item = VideoRef | SourceRef;

const ZOOM_SECONDS = 15;
const PLACED_COLORS = ['#4cc9f0', '#7bd389', '#c77dff', '#90e0ef', '#ffd166'];
const TARGET_COLOR = '#f9a03f';

/** Telemetry of a video (embedded) or a source. */
function telemetryOf(item: Item, series: Record<string, TelemetrySeries>): TelemetrySeries | undefined {
  return series['kind' in item ? item.id : embeddedSourceId(item.id)];
}

function speedTrace(item: Item, series: Record<string, TelemetrySeries>, color: string): ChartTrace[] {
  const telemetry = telemetryOf(item, series);
  const channel = telemetry ? getChannel(telemetry, StandardChannel.speed) : undefined;
  return channel ? [{ label: item.label, channel, offset: item.offsetSeconds, color, scale: 3.6 }] : [];
}

/** Items already on the timeline other than `exclude`: the reference and synced items. */
function placedItems(project: Project, exclude: string): Item[] {
  const reference = referenceItem(project);
  const items: Item[] = [
    ...project.videos.filter((v) => v.enabled),
    ...project.sources.filter((s) => s.enabled && s.videoId === null),
  ];
  return items.filter((i) => i.id !== exclude && (i.synced || i.id === reference?.id));
}

function valueAt(series: TelemetrySeries | undefined, key: string, time: number): number {
  const channel = series ? getChannel(series, key) : undefined;
  return channel ? sampleAt(channel, time) : Number.NaN;
}

function OffsetEditor({ item, frame }: { item: Item; frame: number }) {
  const t = useT();
  const setOffset = useStore((s) => s.setOffset);
  const nudge = (delta: number) => setOffset(item.id, item.offsetSeconds + delta);

  return (
    <div className="offset-editor">
      <TimeInput
        label={t('sync.offset.label')}
        value={item.offsetSeconds}
        onCommit={(value) => {
          if (value !== null) setOffset(item.id, value);
          return true;
        }}
      />
      <div className="nudges">
        <button type="button" onClick={() => nudge(-1)}>
          −1 s
        </button>
        <button type="button" onClick={() => nudge(-0.1)}>
          −0.1 s
        </button>
        <button type="button" onClick={() => nudge(-frame)}>
          {t('sync.offset.minusFrame')}
        </button>
        <button type="button" onClick={() => nudge(frame)}>
          {t('sync.offset.plusFrame')}
        </button>
        <button type="button" onClick={() => nudge(0.1)}>
          +0.1 s
        </button>
        <button type="button" onClick={() => nudge(1)}>
          +1 s
        </button>
      </div>
    </div>
  );
}

function SyncResults({ results, onApply }: { results: SyncResult[]; onApply(result: SyncResult): void }) {
  const t = useT();
  if (results.length === 0) return <p className="muted">{t('sync.results.none')}</p>;
  const messageOf = (r: SyncResult) =>
    [
      t(`sync.messages.${r.code}`, r.params, r.message),
      ...r.notes.map((note) => t(`sync.notes.${note}`)),
    ].join(' — ');
  return (
    <ul className="sync-results">
      {results.map((r) => (
        <li key={`${r.method}-${r.offsetSeconds}-${r.message}`}>
          <div>
            <strong>{t(`sync.methods.${r.method}`)}</strong>{' '}
            <span className="mono">{formatOffset(r.offsetSeconds)}</span>{' '}
            <Badge tone={r.confidence >= AUTO_SYNC_MIN_CONFIDENCE ? 'ok' : 'warn'}>
              {(r.confidence * 100).toFixed(0)}%
            </Badge>
            <p className="muted small">{messageOf(r)}</p>
          </div>
          <button type="button" className="small" onClick={() => onApply(r)}>
            {t('common.apply')}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function SyncStep() {
  const t = useT();
  const project = useStore((s) => s.project);
  const series = useStore((s) => s.series);
  const currentTime = useStore((s) => s.currentTime);
  const results = useStore((s) => s.syncResults);
  const seek = useStore((s) => s.seek);
  const setOffset = useStore((s) => s.setOffset);
  const setSynced = useStore((s) => s.setSynced);
  const autoSync = useStore((s) => s.autoSync);
  const goTo = useStore((s) => s.goTo);
  const timeline = useTimeline();
  const pending = useMemo(() => itemsRequiringSync(project), [project]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [zoom, setZoom] = useState(false);
  const step: Pick<StepStatus, 'id' | 'title' | 'description'> = STEP_DEFINITIONS.sync;
  const title = coreText.stepTitle(t, step);
  const description = coreText.stepDescription(t, step);

  const item = pending.find((i) => i.id === selectedId) ?? pending[0];
  const target = item ? telemetryOf(item, series) : undefined;
  const placed = useMemo(() => (item ? placedItems(project, item.id) : []), [project, item]);

  const traces = useMemo(
    () => [
      ...placed.flatMap((p, i) =>
        speedTrace(p, series, PLACED_COLORS[i % PLACED_COLORS.length] ?? '#4cc9f0'),
      ),
      ...(item ? speedTrace(item, series, TARGET_COLOR) : []),
    ],
    [placed, item, series],
  );

  if (!item) {
    return (
      <div className="step">
        <StepHeader title={title} description={description} />
        <div className="empty">
          <p>{t('sync.empty.title')}</p>
          <p className="muted">{t('sync.empty.description')}</p>
          <button type="button" className="primary" onClick={() => goTo('template')}>
            {t('sync.empty.continue')}
          </button>
        </div>
      </div>
    );
  }

  const runAutoSync = () => {
    setBusy(true);
    // Let React paint the busy state before the (synchronous) correlation runs.
    setTimeout(() => {
      autoSync(item.id);
      setBusy(false);
    }, 20);
  };

  const windowStart = zoom ? Math.max(timeline.start, currentTime - ZOOM_SECONDS) : timeline.start;
  const windowEnd = zoom ? Math.min(timeline.end, currentTime + ZOOM_SECONDS) : timeline.end;
  const itemTime = currentTime - item.offsetSeconds;
  const referenceSpeed =
    traces[0] && placed.length > 0 ? sampleAt(traces[0].channel, currentTime - traces[0].offset) : Number.NaN;
  const targetSpeed = valueAt(target, StandardChannel.speed, itemTime);

  return (
    <div className="step">
      <StepHeader title={title} description={description} />
      {pending.length > 1 && (
        <div className="tabs">
          {pending.map((i) => (
            <button
              type="button"
              key={i.id}
              className={i.id === item.id ? 'active' : ''}
              onClick={() => setSelectedId(i.id)}
            >
              {'kind' in i ? '📈' : '🎬'} {i.label} {i.synced ? '✓' : ''}
            </button>
          ))}
        </div>
      )}
      <div className="split">
        <div className="stack">
          <Preview />
          {traces.length > 0 ? (
            <div className="panel">
              <div className="panel-title">
                <h3>{t('sync.chart.title')}</h3>
                <label className="toggle">
                  <input type="checkbox" checked={zoom} onChange={(e) => setZoom(e.target.checked)} />
                  {t('sync.chart.zoom', { seconds: ZOOM_SECONDS })}
                </label>
              </div>
              <TelemetryChart
                traces={traces}
                start={windowStart}
                end={windowEnd}
                currentTime={currentTime}
                onSeek={seek}
                unit="km/h"
              />
            </div>
          ) : (
            <p className="muted">{t('sync.chart.noSpeed')}</p>
          )}
        </div>
        <aside className="panel">
          <h2>{item.label}</h2>
          <p className="muted small">{t('sync.offset.formula')}</p>
          <OffsetEditor item={item} frame={1 / (timeline.frameRate || 30)} />
          <div className="row">
            <button type="button" className="primary" onClick={runAutoSync} disabled={busy}>
              {busy ? t('sync.auto.busy') : t('sync.auto.run')}
            </button>
            <label className="toggle">
              <input
                type="checkbox"
                checked={item.synced}
                onChange={(e) => setSynced(item.id, e.target.checked)}
              />
              {t('sync.synced')}
            </label>
          </div>
          {results[item.id] && (
            <SyncResults
              results={results[item.id] ?? []}
              onApply={(r) => setOffset(item.id, r.offsetSeconds, true)}
            />
          )}
          <h3>{t('sync.live.title')}</h3>
          <table className="live-values">
            <tbody>
              <tr>
                <th>{t('sync.live.timeline')}</th>
                <td>{formatTime(currentTime)}</td>
              </tr>
              <tr>
                <th>{t('sync.live.itemTime')}</th>
                <td>{formatTime(itemTime)}</td>
              </tr>
              {target?.startEpochMs != null && (
                <tr>
                  <th>{t('sync.live.itemClock')}</th>
                  <td>{formatDateTime(target.startEpochMs + itemTime * 1000)}</td>
                </tr>
              )}
              <tr>
                <th style={{ color: PLACED_COLORS[0] }}>{t('sync.live.referenceSpeed')}</th>
                <td>{formatValue(referenceSpeed, 'm/s')}</td>
              </tr>
              <tr>
                <th style={{ color: TARGET_COLOR }}>{t('sync.live.itemSpeed')}</th>
                <td>{formatValue(targetSpeed, 'm/s')}</td>
              </tr>
              {'kind' in item && (
                <tr>
                  <th>{t('sync.live.lap')}</th>
                  <td>{formatValue(valueAt(target, StandardChannel.lap, itemTime), '')}</td>
                </tr>
              )}
            </tbody>
          </table>
        </aside>
      </div>
    </div>
  );
}
