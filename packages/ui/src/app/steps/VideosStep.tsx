import {
  describeCodec,
  embeddedSourceId,
  referenceItem,
  STEP_DEFINITIONS,
  summarizeSeries,
  type VideoRef,
} from '@custom-overlay/core';
import { useMemo } from 'react';
import { api } from '../api';
import { Badge, ChannelChips, DropZone, KeyValues, StepHeader } from '../components/common';
import { Preview } from '../components/Preview';
import { formatBytes, formatColor, formatFormat, formatOffset, formatTime } from '../format';
import { coreText, useT } from '../i18n';
import { useStore } from '../store';

const VIDEO_FILE = /\.(mp4|mov)$/i;

function VideoCard({ video, isReference }: { video: VideoRef; isReference: boolean }) {
  const t = useT();
  const info = useStore((s) => s.videos[video.id]);
  const error = useStore((s) => s.errors[video.id]);
  const loading = useStore((s) => s.loading[video.id] ?? false);
  const telemetry = useStore((s) => s.series[embeddedSourceId(video.id)]);
  const removeVideo = useStore((s) => s.removeVideo);
  const setEnabled = useStore((s) => s.setVideoEnabled);
  const summary = useMemo(() => (telemetry ? summarizeSeries(telemetry) : null), [telemetry]);

  return (
    <article className={`card ${video.enabled ? '' : 'disabled'}`}>
      <header className="card-header">
        <div>
          <h3>{video.label}</h3>
          <div className="badges">
            {isReference && <Badge tone="accent">{t('videos.card.reference')}</Badge>}
            {!isReference && video.enabled && (
              <Badge tone={video.synced ? 'ok' : 'warn'}>
                {video.synced
                  ? t('videos.card.at', { offset: formatOffset(video.offsetSeconds) })
                  : t('videos.card.notSynced')}
              </Badge>
            )}
            {summary && <Badge>{t('videos.card.gpmfTelemetry')}</Badge>}
            {loading && <Badge>{t('videos.card.loading')}</Badge>}
            {error && <Badge tone="error">{t('videos.card.error')}</Badge>}
          </div>
        </div>
        <div className="actions">
          <label className="toggle">
            <input
              type="checkbox"
              checked={video.enabled}
              onChange={(e) => setEnabled(video.id, e.target.checked)}
            />
            {t('videos.card.use')}
          </label>
          <button type="button" className="danger small" onClick={() => removeVideo(video.id)}>
            {t('common.remove')}
          </button>
        </div>
      </header>
      {error && <p className="error-text">{error}</p>}
      {info && (
        <KeyValues
          rows={[
            [t('common.duration'), formatTime(info.durationSeconds)],
            [t('videos.card.format'), formatFormat(info.width, info.height, info.frameRate)],
            [t('videos.card.codec'), `${describeCodec(info.codec)} · ${formatColor(info.color)}`],
            [
              t('videos.card.camera'),
              [info.camera.model, info.camera.firmware].filter(Boolean).join(' · ') || '—',
            ],
            [t('videos.card.size'), formatBytes(info.sizeBytes)],
          ]}
        />
      )}
      {summary && <ChannelChips summary={summary} />}
    </article>
  );
}

export function VideosStep() {
  const t = useT();
  const project = useStore((s) => s.project);
  const loading = useStore((s) => Object.keys(s.loading).some((k) => s.loading[k] && VIDEO_FILE.test(k)));
  const addVideos = useStore((s) => s.addVideos);
  const setExport = useStore((s) => s.setExport);
  const notify = useStore((s) => s.notify);
  const goTo = useStore((s) => s.goTo);
  const title = coreText.stepTitle(t, STEP_DEFINITIONS.videos);
  const description = coreText.stepDescription(t, STEP_DEFINITIONS.videos);
  const reference = referenceItem(project);

  const onDrop = (files: File[]) => {
    const paths = files.map((f) => api().getPathForFile(f));
    const videos = paths.filter((p) => VIDEO_FILE.test(p));
    if (videos.length < paths.length) notify('error', t('videos.onlyVideos'));
    if (videos.length > 0) void addVideos(videos);
  };

  const skip = () => {
    setExport({ mode: 'image-sequence' });
    goTo('sources');
  };

  const addButton = (
    <button type="button" className="primary" onClick={() => void addVideos()} disabled={loading}>
      {loading ? t('videos.reading') : t('videos.add')}
    </button>
  );

  if (project.videos.length === 0) {
    return (
      <div className="step">
        <StepHeader title={title} description={description} />
        <DropZone onFiles={onDrop} className="large">
          <div className="drop-content">
            <div className="drop-icon">🎬</div>
            <p>{loading ? t('videos.readingVideos') : t('videos.drop')}</p>
            {addButton}
          </div>
        </DropZone>
        <div className="skip-box">
          <div>
            <strong>{t('videos.noVideo.title')}</strong>
            <p className="muted">{t('videos.noVideo.text')}</p>
          </div>
          <button type="button" onClick={skip}>
            {t('videos.noVideo.continue')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="step">
      <StepHeader title={title} description={description} actions={addButton} />
      <div className="split">
        <Preview />
        <DropZone onFiles={onDrop} className="list-drop">
          <div className="cards">
            {project.videos.map((video) => (
              <VideoCard key={video.id} video={video} isReference={video.id === reference?.id} />
            ))}
          </div>
          <p className="muted small hint">{t('videos.hint')}</p>
        </DropZone>
      </div>
    </div>
  );
}
