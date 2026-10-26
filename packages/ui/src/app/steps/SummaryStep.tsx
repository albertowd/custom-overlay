import { ENCODE_PRESETS, referenceItem, STEP_DEFINITIONS, summarizeSeries } from '@custom-overlay/core';
import type { ReactNode } from 'react';
import type { Translate } from '../../shared/i18n';
import { Badge, KeyValues, SOURCE_KIND_LABELS, StepHeader } from '../components/common';
import { formatColor, formatDateTime, formatFormat, formatOffset, formatTime } from '../format';
import { coreText, useT } from '../i18n';
import { useStore, useTimeline, useWorkflow } from '../store';

function status(
  t: Translate,
  enabled: boolean,
  error: string | undefined,
  synced: boolean,
  isReference: boolean,
): ReactNode {
  if (!enabled) return <Badge>{t('summary.status.disabled')}</Badge>;
  if (error) return <Badge tone="error">{t('summary.status.error')}</Badge>;
  if (isReference) return <Badge tone="accent">{t('summary.status.reference')}</Badge>;
  return synced ? (
    <Badge tone="ok">{t('summary.status.synced')}</Badge>
  ) : (
    <Badge tone="warn">{t('summary.status.notSynced')}</Badge>
  );
}

export function SummaryStep() {
  const t = useT();
  const project = useStore((s) => s.project);
  const videos = useStore((s) => s.videos);
  const series = useStore((s) => s.series);
  const errors = useStore((s) => s.errors);
  const goTo = useStore((s) => s.goTo);
  const timeline = useTimeline();
  const workflow = useWorkflow();
  const title = coreText.stepTitle(t, STEP_DEFINITIONS.summary);
  const description = coreText.stepDescription(t, STEP_DEFINITIONS.summary);
  const preset = ENCODE_PRESETS.find((p) => p.id === project.export.encoder.preset);
  const presetName = preset ? coreText.presetLabel(t, preset) : t('export.encoding.custom');
  const issues = workflow.flatMap((s) => s.issues.map((i) => ({ step: s, issue: i })));
  const reference = referenceItem(project);
  const { output } = project;

  return (
    <div className="step">
      <StepHeader title={title} description={description} />
      <div className="grid">
        <section className="panel">
          <div className="panel-title">
            <h3>{t('summary.output.title')}</h3>
            <button type="button" className="link" onClick={() => goTo('export')}>
              {t('common.edit')}
            </button>
          </div>
          <KeyValues
            rows={[
              [t('summary.output.format'), formatFormat(output.width, output.height, output.frameRate)],
              [t('summary.output.color'), formatColor(output.color)],
              [
                t('summary.output.mode'),
                project.export.mode === 'video'
                  ? t('summary.output.finalVideo')
                  : t('summary.output.imageSequence'),
              ],
              [
                t('summary.output.encoder'),
                `${project.export.encoder.codec.toUpperCase()} ${project.export.encoder.bitrateMbps} Mbps (${presetName})`,
              ],
            ]}
          />
        </section>

        <section className="panel">
          <div className="panel-title">
            <h3>{t('summary.timeline.title')}</h3>
            <button type="button" className="link" onClick={() => goTo('sync')}>
              {t('common.edit')}
            </button>
          </div>
          <KeyValues
            rows={[
              [t('summary.timeline.timeZero'), t(`summary.timeline.basis.${timeline.basis}`)],
              [t('summary.timeline.span'), `${formatTime(timeline.start)} → ${formatTime(timeline.end)}`],
              [t('summary.timeline.length'), formatTime(timeline.durationSeconds)],
              [t('summary.timeline.timeZeroAt'), formatDateTime(timeline.startEpochMs)],
            ]}
          />
        </section>

        <section className="panel wide">
          <div className="panel-title">
            <h3>{t('summary.items.title')}</h3>
            <div className="actions">
              <button type="button" className="link" onClick={() => goTo('videos')}>
                {t('summary.items.videos')}
              </button>
              <button type="button" className="link" onClick={() => goTo('sources')}>
                {t('summary.items.sources')}
              </button>
            </div>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>{t('summary.items.item')}</th>
                <th>{t('summary.items.type')}</th>
                <th>{t('common.duration')}</th>
                <th>{t('summary.items.position')}</th>
                <th>{t('summary.items.status')}</th>
              </tr>
            </thead>
            <tbody>
              {project.videos.map((video) => (
                <tr key={video.id} className={video.enabled ? '' : 'disabled'}>
                  <td>🎬 {video.label}</td>
                  <td>{t('summary.items.video')}</td>
                  <td>{videos[video.id] ? formatTime(videos[video.id]?.durationSeconds ?? 0) : '—'}</td>
                  <td className="mono">{formatOffset(video.offsetSeconds)}</td>
                  <td>
                    {status(t, video.enabled, errors[video.id], video.synced, video.id === reference?.id)}
                  </td>
                </tr>
              ))}
              {project.sources.map((source) => {
                const data = series[source.id];
                const summary = data ? summarizeSeries(data) : null;
                const embedded = source.videoId !== null;
                return (
                  <tr key={source.id} className={source.enabled ? '' : 'disabled'}>
                    <td>📈 {source.label}</td>
                    <td>
                      {SOURCE_KIND_LABELS[source.kind]}
                      {embedded ? ` (${t('summary.items.embedded')})` : ''} ·{' '}
                      {t('summary.items.channels', { count: summary?.channels.length ?? 0 })}
                    </td>
                    <td>{summary ? formatTime(summary.durationSeconds) : '—'}</td>
                    <td className="mono">
                      {embedded ? t('summary.items.followsVideo') : formatOffset(source.offsetSeconds)}
                    </td>
                    <td>
                      {status(
                        t,
                        source.enabled,
                        errors[source.id],
                        embedded || source.synced,
                        source.id === reference?.id,
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        <section className="panel">
          <div className="panel-title">
            <h3>{t('summary.template.title')}</h3>
            <button type="button" className="link" onClick={() => goTo('template')}>
              {t('common.edit')}
            </button>
          </div>
          <KeyValues
            rows={[
              [t('common.name'), project.template.name],
              [t('summary.template.widgets'), String(project.template.widgets.length)],
              [
                t('summary.template.antialias'),
                project.template.antialias ? t('summary.template.on') : t('summary.template.off'),
              ],
              [t('summary.template.file'), project.templatePath ?? t('summary.template.embedded')],
            ]}
          />
        </section>

        <section className="panel">
          <div className="panel-title">
            <h3>{t('summary.checks.title')}</h3>
          </div>
          {issues.length === 0 ? (
            <p className="ok-text">{t('summary.checks.ready')}</p>
          ) : (
            <ul className="issues">
              {issues.map(({ step, issue }) => (
                <li key={`${step.id}-${issue.message}`} className={issue.severity}>
                  <button type="button" className="link" onClick={() => goTo(step.id)}>
                    {coreText.stepTitle(t, step)}
                  </button>
                  : {coreText.issue(t, issue)}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
