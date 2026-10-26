import {
  type SourceKind,
  type SourceRef,
  STEP_DEFINITIONS,
  summarizeSeries,
  type TelemetrySeries,
} from '@custom-overlay/core';
import { useMemo } from 'react';
import { api } from '../api';
import {
  Badge,
  ChannelChips,
  DropZone,
  SeriesFacts,
  SOURCE_KIND_LABELS,
  StepHeader,
} from '../components/common';
import { coreText, useT } from '../i18n';
import { useStore } from '../store';

function SourceCard({ source, series }: { source: SourceRef; series: TelemetrySeries | undefined }) {
  const t = useT();
  const error = useStore((s) => s.errors[source.id]);
  const loading = useStore((s) => s.loading[source.id] ?? false);
  const removeSource = useStore((s) => s.removeSource);
  const setEnabled = useStore((s) => s.setSourceEnabled);
  const summary = useMemo(() => (series ? summarizeSeries(series) : null), [series]);

  return (
    <article className={`card source-card ${source.enabled ? '' : 'disabled'}`}>
      <header className="card-header">
        <div>
          <h3>{source.label}</h3>
          <div className="badges">
            <Badge tone="accent">{SOURCE_KIND_LABELS[source.kind]}</Badge>
            {source.videoId !== null && <Badge>{t('sources.card.embedded')}</Badge>}
            {loading && <Badge>{t('sources.card.loading')}</Badge>}
            {error && <Badge tone="error">{t('sources.card.error')}</Badge>}
          </div>
          <p className="path muted" title={source.path}>
            {source.path}
          </p>
        </div>
        <div className="actions">
          <label className="toggle">
            <input
              type="checkbox"
              checked={source.enabled}
              onChange={(e) => setEnabled(source.id, e.target.checked)}
            />
            {t('sources.card.use')}
          </label>
          {source.videoId === null && (
            <button type="button" className="danger small" onClick={() => removeSource(source.id)}>
              {t('common.remove')}
            </button>
          )}
        </div>
      </header>
      {error && <p className="error-text">{error}</p>}
      {summary && (
        <>
          <SeriesFacts summary={summary} />
          <ChannelChips summary={summary} />
        </>
      )}
    </article>
  );
}

export function SourcesStep() {
  const t = useT();
  const sources = useStore((s) => s.project.sources);
  const series = useStore((s) => s.series);
  const addSources = useStore((s) => s.addSources);
  const notify = useStore((s) => s.notify);
  const title = coreText.stepTitle(t, STEP_DEFINITIONS.sources);
  const description = coreText.stepDescription(t, STEP_DEFINITIONS.sources);

  const onDrop = async (files: File[]) => {
    const accepted: { path: string; kind: SourceKind }[] = [];
    for (const file of files) {
      const path = api().getPathForFile(file);
      const kind = await api().detectSourceKind(path);
      if (kind) accepted.push({ path, kind });
      else notify('error', t('sources.unsupported', { name: file.name }));
    }
    if (accepted.length > 0) await addSources(accepted);
  };

  return (
    <div className="step">
      <StepHeader
        title={title}
        description={description}
        actions={
          <button type="button" className="primary" onClick={() => void addSources()}>
            {t('sources.add')}
          </button>
        }
      />
      <DropZone onFiles={(files) => void onDrop(files)} className="list-drop">
        {sources.length === 0 ? (
          <div className="empty">
            <p>{t('sources.empty.title')}</p>
            <p className="muted">{t('sources.empty.drop')}</p>
          </div>
        ) : (
          <div className="cards">
            {sources.map((source) => (
              <SourceCard key={source.id} source={source} series={series[source.id]} />
            ))}
          </div>
        )}
      </DropZone>
      <p className="muted hint">{t('sources.supported')}</p>
    </div>
  );
}
