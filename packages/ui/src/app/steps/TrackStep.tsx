import {
  bestTrackMatch,
  type CatalogTrack,
  distanceKm,
  formatDelta,
  formatDuration,
  type Gate,
  getCatalogTrack,
  type Lap,
  lapsFromSeries,
  lineLapSplits,
  resolveTimingFamily,
  STEP_DEFINITIONS,
  type StepStatus,
  sameLines,
  suggestStartFinish,
  type TimingSource,
  trackCentre,
} from '@custom-overlay/core';
import { useEffect, useMemo, useState } from 'react';
import { LANGUAGES } from '../../shared/i18n';
import { api } from '../api';
import { StepHeader } from '../components/common';
import { DataRangeEditor } from '../components/DataRangeEditor';
import { Preview } from '../components/Preview';
import { type LineTarget, TrackMap } from '../components/TrackMap';
import { formatTime } from '../format';
import { coreText, useLanguage, useT } from '../i18n';
import { useSessionCentre, useStore, useTrackMatches, useValuesRefresh } from '../store';
import { fullSeries } from '../values';

const TIMING_OPTIONS: TimingSource[] = ['auto', 'imported', 'lines'];

const SATELLITE_KEY = 'custom-overlay.track.satellite';

/** Where users ask for new tracks and corrections to the list (the "Add or fix a track" form). */
const TRACK_ISSUE_FORM = 'https://github.com/albertowd/custom-overlay/issues/new?template=track.yml';

/** Satellite view preference of this computer (on by default). */
function readSatellitePreference(): boolean {
  try {
    return localStorage.getItem(SATELLITE_KEY) !== '0';
  } catch {
    return true;
  }
}

/** Logger lap starting closest to a time, within half the minimum lap time. */
function closestLap(laps: Lap[], start: number, tolerance: number): Lap | undefined {
  let best: Lap | undefined;
  for (const lap of laps) {
    const gap = Math.abs(lap.start - start);
    if (gap <= tolerance && (!best || gap < Math.abs(best.start - start))) best = lap;
  }
  return best;
}

const byName = (a: CatalogTrack, b: CatalogTrack) => a.track.name.localeCompare(b.track.name);

/** Tracks this close to the session are listed first. */
const NEARBY_KM = 100;

/** Lower case without accents, so "guapore" finds "Guaporé". */
const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

interface ListItem {
  entry: CatalogTrack;
  /** Kilometres from the session, NaN without GPS. */
  distance: number;
}

interface ListGroup {
  key: string;
  label: string;
  items: ListItem[];
}

const byDistance = (a: ListItem, b: ListItem) =>
  (Number.isNaN(a.distance) ? Number.POSITIVE_INFINITY : a.distance) -
    (Number.isNaN(b.distance) ? Number.POSITIVE_INFINITY : b.distance) || byName(a.entry, b.entry);

/**
 * Known tracks (bundled, updated from GitHub): the one detected in the session, the nearby ones,
 * and a search by name, city or country for any other, with or without GPS.
 */
function TrackList() {
  const t = useT();
  const language = useLanguage((s) => s.language);
  const track = useStore((s) => s.project.track);
  const catalog = useStore((s) => s.trackCatalog);
  const source = useStore((s) => s.trackCatalogSource);
  const loadCatalogTrack = useStore((s) => s.loadCatalogTrack);
  const matches = useTrackMatches();
  const centre = useSessionCentre();
  const [query, setQuery] = useState('');
  const best = bestTrackMatch(matches);
  const current = catalog.find((entry) => sameLines(track, entry.track));

  const groups = useMemo((): ListGroup[] => {
    const countries = new Intl.DisplayNames([language], { type: 'region' });
    const countryName = (code: string) => countries.of(code) ?? code;
    // Countries are found by their name in any language of the app ("Brasil" as well as "Brazil").
    const allNames = LANGUAGES.map((l) => new Intl.DisplayNames([l.code], { type: 'region' }));
    const searchable = (code: string) => allNames.map((names) => names.of(code) ?? '').join(' ');
    const item = (entry: CatalogTrack): ListItem => {
      const at = trackCentre(entry.track);
      return { entry, distance: centre && at ? distanceKm(centre, at) : Number.NaN };
    };
    const words = fold(query).split(/\s+/).filter(Boolean);
    const found = catalog
      .filter((entry) => {
        const text = fold(
          `${entry.track.name} ${entry.location} ${entry.country} ${searchable(entry.country)}`,
        );
        return words.every((word) => text.includes(word));
      })
      .map(item);
    if (words.length > 0) {
      return [
        {
          key: 'results',
          label: t('track.list.resultsGroup', { count: found.length }),
          items: found.sort(byDistance),
        },
      ];
    }
    const listed = new Set(matches.map((m) => m.entry.id));
    const result: ListGroup[] = [];
    if (matches.length > 0) {
      result.push({
        key: 'detected',
        label: t('track.list.detectedGroup'),
        items: matches.map((m) => item(m.entry)),
      });
    }
    const nearby = found.filter((i) => !listed.has(i.entry.id) && i.distance <= NEARBY_KM).sort(byDistance);
    if (nearby.length > 0) {
      result.push({ key: 'nearby', label: t('track.list.nearbyGroup', { km: NEARBY_KM }), items: nearby });
    }
    for (const i of nearby) listed.add(i.entry.id);
    const byCountry = new Map<string, ListItem[]>();
    for (const i of found) {
      if (!listed.has(i.entry.id))
        byCountry.set(i.entry.country, [...(byCountry.get(i.entry.country) ?? []), i]);
    }
    const countryGroups = [...byCountry]
      .map(([code, items]) => ({ key: code, label: countryName(code), items: items.sort(byDistance) }))
      .sort((a, b) => a.label.localeCompare(b.label, language));
    return [...result, ...countryGroups];
  }, [catalog, centre, language, matches, query, t]);

  const load = (id: string) => {
    const entry = getCatalogTrack(id, catalog);
    if (!entry) return;
    // Lines drawn by the user (not from the list) are lost: ask first.
    if (
      track.startFinish &&
      !current &&
      !window.confirm(t('track.list.confirmReplace', { name: entry.track.name }))
    )
      return;
    loadCatalogTrack(entry);
  };

  let status = t('track.list.none');
  if (current) status = t('track.list.inUse', { name: current.track.name });
  else if (best) status = t('track.list.detected', { name: best.entry.track.name });
  else if (matches.length > 1) status = t('track.list.several');

  const kilometres = new Intl.NumberFormat(language, { maximumFractionDigits: 1 });
  const option = ({ entry, distance }: ListItem) => (
    <option key={entry.id} value={entry.id}>
      {entry.track.name} — {entry.location}
      {Number.isFinite(distance)
        ? ` · ${t('track.list.km', { distance: kilometres.format(distance < 10 ? distance : Math.round(distance)) })}`
        : ''}
    </option>
  );
  const shown = groups.some((g) => g.items.some((i) => i.entry.id === current?.id));

  return (
    <div className="track-control-group">
      <h3>{t('track.list.title')}</h3>
      <p className="muted small">{status}</p>
      {best && !current && (
        <button type="button" className="primary" onClick={() => load(best.entry.id)}>
          {t('track.list.use')}
        </button>
      )}
      <label className="field">
        {t('track.list.load')}
        <input
          type="search"
          value={query}
          placeholder={t('track.list.search')}
          aria-label={t('track.list.search')}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select value={shown ? current?.id : ''} onChange={(e) => load(e.target.value)}>
          <option value="" disabled>
            {groups.some((g) => g.items.length > 0) ? t('track.list.choose') : t('track.list.noResults')}
          </option>
          {groups.map((group) => (
            <optgroup key={group.key} label={group.label}>
              {group.items.map(option)}
            </optgroup>
          ))}
        </select>
        <span className="field-hint">{t(`track.list.source.${source}`, { count: catalog.length })}</span>
      </label>
      <p className="muted small">
        {t('track.list.share')}{' '}
        <button type="button" className="link" onClick={() => void api().openProjectUrl(TRACK_ISSUE_FORM)}>
          {t('track.list.shareLink')}
        </button>
      </p>
    </div>
  );
}

function LapsTable({
  splits,
  imported,
  onSeek,
}: {
  splits: number[][];
  imported: Lap[];
  onSeek(time: number): void;
}) {
  const t = useT();
  const minLap = useStore((s) => s.project.track.minLapSeconds);
  const sectorCount = (splits[0]?.length ?? 2) - 1;
  /** Sector numbers shown as columns (none with a single sector). */
  const sectors = sectorCount > 1 ? Array.from({ length: sectorCount }, (_, j) => j + 1) : [];
  if (splits.length === 0 && imported.length === 0) return <p className="muted">{t('track.laps.none')}</p>;
  if (splits.length === 0) {
    return (
      <table className="laps-table">
        <thead>
          <tr>
            <th>{t('track.laps.lap')}</th>
            <th>{t('track.laps.logger')}</th>
          </tr>
        </thead>
        <tbody>
          {imported.map((lap) => (
            <tr key={lap.start} onClick={() => onSeek(lap.start)}>
              <td>{lap.number}</td>
              <td>{formatDuration(lap.duration, 3, '—')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <table className="laps-table">
      <thead>
        <tr>
          <th>{t('track.laps.lap')}</th>
          {sectors.map((n) => (
            <th key={n}>{t('track.laps.sectorShort', { number: n })}</th>
          ))}
          <th>{t('track.laps.lines')}</th>
          <th>{t('track.laps.logger')}</th>
          <th>{t('track.laps.diff')}</th>
        </tr>
      </thead>
      <tbody>
        {splits.map((lapSplits, k) => {
          const start = lapSplits[0] as number;
          const duration = (lapSplits[sectorCount] as number) - start;
          const logger = closestLap(imported, start, minLap / 2);
          return (
            <tr
              key={start}
              onClick={() => onSeek(start)}
              title={t('track.laps.startsAt', { time: formatTime(start) })}
            >
              <td>{k + 1}</td>
              {sectors.map((n) => (
                <td key={n}>
                  {formatDuration((lapSplits[n] as number) - (lapSplits[n - 1] as number), 3, '—')}
                </td>
              ))}
              <td>{formatDuration(duration, 3, '—')}</td>
              <td>{logger ? formatDuration(logger.duration, 3, '—') : '—'}</td>
              <td>{logger ? formatDelta(duration - logger.duration, 3, '—') : '—'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function TrackStep() {
  useValuesRefresh();
  const t = useT();
  const track = useStore((s) => s.project.track);
  const dataRange = useStore((s) => s.project.dataRange);
  const setDataRange = useStore((s) => s.setDataRange);
  const setTrack = useStore((s) => s.setTrack);
  const importTrack = useStore((s) => s.importTrack);
  const exportTrack = useStore((s) => s.exportTrack);
  const notify = useStore((s) => s.notify);
  const snapshot = useStore((s) => s.values);
  const valuesError = useStore((s) => s.valuesError);
  const currentTime = useStore((s) => s.currentTime);
  const seek = useStore((s) => s.seek);
  const [drawing, setDrawing] = useState<LineTarget | null>(null);
  const [satellite, setSatellite] = useState(readSatellitePreference);
  const showSatellite = (show: boolean) => {
    setSatellite(show);
    try {
      localStorage.setItem(SATELLITE_KEY, show ? '1' : '0');
    } catch {
      // Storage unavailable: the choice lasts for this session only.
    }
  };
  const step: Pick<StepStatus, 'id' | 'title' | 'description'> = STEP_DEFINITIONS.track;
  const title = coreText.stepTitle(t, step);
  const description = coreText.stepDescription(t, step);

  useEffect(() => {
    const cancel = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawing(null);
    };
    window.addEventListener('keydown', cancel);
    return () => window.removeEventListener('keydown', cancel);
  }, []);

  // The whole session, whatever the data range: lines are placed on the full path.
  const series = useMemo(() => (snapshot ? fullSeries(snapshot) : null), [snapshot]);
  const latitude = snapshot?.full.latitude;
  const longitude = snapshot?.full.longitude;
  const loggerLaps = snapshot?.full['imported.lap.number'];
  const hasLoggerLaps = loggerLaps?.some(Number.isFinite) ?? false;

  const imported = useMemo(
    () => (series ? lapsFromSeries(series, 'imported.lap.time', 'imported.lap.number') : []),
    [series],
  );
  const splits = useMemo(() => {
    if (!series || !latitude || !longitude) return [];
    const { times } = series;
    return lineLapSplits({ time: times, values: latitude }, { time: times, values: longitude }, track);
  }, [series, latitude, longitude, track]);

  const position = snapshot
    ? Math.min(
        Math.max(Math.round((currentTime - snapshot.grid.start) * snapshot.grid.frameRate), 0),
        snapshot.grid.count - 1,
      )
    : -1;

  const setLine = (target: LineTarget, gate: Gate) => {
    if (target === 'start') setTrack({ startFinish: gate });
    else setTrack({ sectors: track.sectors.map((g, j) => (j === target ? gate : g)) });
  };

  const draw = (target: LineTarget, gate: Gate) => {
    if (target === 'start') setTrack({ startFinish: gate });
    else setTrack({ sectors: [...track.sectors, gate] });
    setDrawing(null);
  };

  const suggest = () => {
    if (!latitude || !longitude || !loggerLaps) return;
    const gate = suggestStartFinish(latitude, longitude, loggerLaps);
    if (gate) setTrack({ startFinish: gate });
    else notify('error', t('track.startFinish.noLapChange'));
  };

  const removeSector = (index: number) => setTrack({ sectors: track.sectors.filter((_, j) => j !== index) });
  const moveSector = (index: number, direction: -1 | 1) => {
    const next = [...track.sectors];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target] as Gate, next[index] as Gate];
    setTrack({ sectors: next });
  };

  const family = resolveTimingFamily(track);
  const hasVideo = useStore((s) => s.project.videos.some((v) => v.enabled));
  const hasGps = Boolean(latitude?.some(Number.isFinite));

  const controls = (
    <>
      <TrackList />
      <div className="track-control-group">
        <label className="field">
          {t('track.timing.label')}
          <select value={track.timing} onChange={(e) => setTrack({ timing: e.target.value as TimingSource })}>
            {TIMING_OPTIONS.map((value) => (
              <option key={value} value={value}>
                {t(`track.timing.options.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <p className="muted small">
          {family === 'lines' ? t('track.timing.nowLines') : t('track.timing.nowLogger')}
        </p>
      </div>
      <div className="track-control-group">
        <h3>{t('track.startFinish.title')}</h3>
        <p className="muted small">
          {track.startFinish ? t('track.startFinish.set') : t('track.startFinish.notSet')}
        </p>
        <div className="row wrap">
          <button
            type="button"
            className={drawing === 'start' ? 'primary' : ''}
            disabled={!hasGps}
            onClick={() => setDrawing(drawing === 'start' ? null : 'start')}
          >
            {track.startFinish ? t('track.startFinish.redraw') : t('track.startFinish.draw')}
          </button>
          <button
            type="button"
            disabled={!hasLoggerLaps}
            title={t('track.startFinish.fromLoggerHint')}
            onClick={suggest}
          >
            {t('track.startFinish.fromLogger')}
          </button>
          {track.startFinish && (
            <button type="button" className="danger" onClick={() => setTrack({ startFinish: null })}>
              {t('common.remove')}
            </button>
          )}
        </div>
      </div>
      <div className="track-control-group">
        <h3>{t('track.sectors.title')}</h3>
        <p className="muted small">{t('track.sectors.hint')}</p>
        <ul className="sector-lines">
          {track.sectors.map((_, j) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: lines have no id, the order is their identity
            <li key={j}>
              <span>{t('track.map.split', { number: j + 1 })}</span>
              <span className="actions">
                <button type="button" className="small" disabled={j === 0} onClick={() => moveSector(j, -1)}>
                  ↑
                </button>
                <button
                  type="button"
                  className="small"
                  disabled={j === track.sectors.length - 1}
                  onClick={() => moveSector(j, 1)}
                >
                  ↓
                </button>
                <button type="button" className="small danger" onClick={() => removeSector(j)}>
                  {t('common.remove')}
                </button>
              </span>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className={typeof drawing === 'number' ? 'primary' : ''}
          disabled={!hasGps || !track.startFinish}
          onClick={() => setDrawing(typeof drawing === 'number' ? null : track.sectors.length)}
        >
          {t('track.sectors.add')}
        </button>
      </div>
      <div className="track-control-group">
        <h3>{t('track.settings.title')}</h3>
        <label className="field">
          {t('track.settings.name')}
          <input type="text" value={track.name} onChange={(e) => setTrack({ name: e.target.value })} />
        </label>
        <label className="field">
          {t('track.settings.minLap')}
          <input
            type="number"
            min={0}
            step={1}
            value={track.minLapSeconds}
            onChange={(e) => setTrack({ minLapSeconds: Math.max(0, Number(e.target.value) || 0) })}
          />
          <span className="field-hint">{t('track.settings.minLapHint')}</span>
        </label>
      </div>
    </>
  );

  const mapPanel = (
    <div className="panel">
      {!snapshot && !valuesError && <p className="muted">{t('track.map.loading')}</p>}
      {valuesError && <p className="error-text">{valuesError}</p>}
      {snapshot && latitude && longitude && hasGps ? (
        <>
          <TrackMap
            latitude={latitude}
            longitude={longitude}
            track={track}
            position={position}
            drawing={drawing}
            onDraw={draw}
            onMove={setLine}
            satellite={satellite}
          />
          {!hasVideo && (
            <input
              type="range"
              className="track-scrubber"
              aria-label={t('track.map.scrubber')}
              min={snapshot.grid.start}
              max={snapshot.grid.start + (snapshot.grid.count - 1) / snapshot.grid.frameRate}
              step={1 / snapshot.grid.frameRate}
              value={currentTime}
              onChange={(e) => seek(Number(e.target.value))}
            />
          )}
          <div className="row track-map-footer">
            <label className="toggle">
              <input type="checkbox" checked={satellite} onChange={(e) => showSatellite(e.target.checked)} />
              {t('track.map.satellite')}
            </label>
            <span className="muted small">
              {drawing !== null ? t('track.map.drawHint') : t('track.map.dragHint')}
            </span>
          </div>
        </>
      ) : (
        snapshot && <p className="muted">{t('track.map.noGpsPath')}</p>
      )}
    </div>
  );

  const dataRangePanel = (
    <div className="panel">
      <div className="panel-title">
        <h3>{t('track.dataRange.title')}</h3>
      </div>
      <p className="muted small">{t('track.dataRange.hint')}</p>
      <DataRangeEditor value={dataRange} onChange={setDataRange} />
    </div>
  );

  const lapsPanel = (
    <div className="panel">
      <div className="panel-title">
        <h3>{t('track.laps.title')}</h3>
        <span className="muted small">{t('track.laps.hint')}</span>
      </div>
      <LapsTable splits={splits} imported={imported} onSeek={seek} />
    </div>
  );

  return (
    <div className="step">
      <StepHeader
        title={title}
        description={description}
        actions={
          <>
            <button type="button" onClick={() => void importTrack()}>
              {t('track.importLines')}
            </button>
            <button type="button" onClick={() => void exportTrack()} disabled={!track.startFinish}>
              {t('track.exportLines')}
            </button>
          </>
        }
      />
      {hasVideo ? (
        <div className="stack">
          <div className="track-media">
            <div className="panel">
              <Preview />
            </div>
            {mapPanel}
          </div>
          <div className="panel track-controls">{controls}</div>
          {lapsPanel}
          {dataRangePanel}
        </div>
      ) : (
        <div className="split">
          <div className="stack">
            {mapPanel}
            {lapsPanel}
            {dataRangePanel}
          </div>
          <aside className="panel track-panel">{controls}</aside>
        </div>
      )}
    </div>
  );
}
