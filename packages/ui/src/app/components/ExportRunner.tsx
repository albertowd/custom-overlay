import type { StepIssue } from '@custom-overlay/core';
import type { ExportProgress } from '@custom-overlay/core/node';
import { api } from '../api';
import { formatTime } from '../format';
import { coreText, useT } from '../i18n';
import { useStore } from '../store';

function duration(seconds: number): string {
  return Number.isFinite(seconds) ? formatTime(Math.max(0, seconds), false) : '—';
}

/** Progress bar of a running export with its speed, time left and a cancel button. */
export function ExportProgressView({ progress }: { progress: ExportProgress | null }) {
  const t = useT();
  const cancel = useStore((s) => s.cancelExport);
  const percent = progress ? (progress.frame / progress.frames) * 100 : 0;
  return (
    <>
      <div
        className="export-progress"
        role="progressbar"
        aria-valuenow={Math.round(percent)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="export-progress-fill" style={{ width: `${percent}%` }} />
      </div>
      <div className="row">
        <span className="timecode">
          {progress
            ? t('export.run.progress', {
                percent: percent.toFixed(1),
                frame: progress.frame,
                frames: progress.frames,
              })
            : t('export.run.preparing')}
        </span>
        {progress && (
          <span className="muted small">
            {t('export.run.speed', {
              fps: progress.fps.toFixed(1),
              elapsed: duration(progress.elapsedSeconds),
              left: duration(progress.etaSeconds),
            })}
          </span>
        )}
        <button type="button" className="danger" onClick={cancel}>
          {t('common.cancel')}
        </button>
      </div>
    </>
  );
}

/** Export button, live progress with cancel, and the outcome of the last export. */
export function ExportRunner({ issues }: { issues: StepIssue[] }) {
  const t = useT();
  const state = useStore((s) => s.exportState);
  const start = useStore((s) => s.startExport);
  const dismiss = useStore((s) => s.dismissExport);
  const save = useStore((s) => s.saveProject);
  const mode = useStore((s) => s.project.export.mode);
  const blocked = issues.some((i) => i.severity === 'error');
  const { videoExport, revealFiles, sequenceAsZip } = api().capabilities;
  // The web app leaves the final video to the desktop app or the CLI (see the issue above).
  const elsewhere = mode === 'video' && !videoExport;
  // What a cancelled export leaves: no video, the frames written so far, or no download.
  let cancelled = 'export.run.cancelled';
  if (mode === 'image-sequence')
    cancelled = sequenceAsZip ? 'export.run.cancelledZip' : 'export.run.cancelledSequence';

  return (
    <div className="export-runner">
      {issues.length > 0 && (
        <ul className="issues">
          {issues.map((i) => (
            <li key={i.message} className={i.severity}>
              {coreText.issue(t, i)}
            </li>
          ))}
        </ul>
      )}

      {elsewhere && (
        <div className="row">
          <button type="button" className="primary" onClick={() => void save()}>
            {t('common.save')}
          </button>
        </div>
      )}
      {elsewhere ? null : state.status === 'running' ? (
        <ExportProgressView progress={state.progress} />
      ) : (
        <div className="row">
          <button type="button" className="primary" disabled={blocked} onClick={() => void start()}>
            {t('export.run.start')}
          </button>
          <span className="muted small">
            {t(mode === 'video' ? 'export.run.help' : 'export.run.helpSequence')}
          </span>
        </div>
      )}

      {state.status === 'done' && (
        <div className="export-outcome ok">
          <strong>{t('export.run.done', { count: state.result.frames })}</strong>{' '}
          {state.result.encoder
            ? t('export.run.doneTimeEncoder', {
                time: duration(state.result.seconds),
                encoder: state.result.encoder,
              })
            : t('export.run.doneTime', { time: duration(state.result.seconds) })}
          <div className="row">
            {revealFiles && (
              <button type="button" onClick={() => void api().revealPath(state.result.outputPath)}>
                {t('export.run.showInFolder')}
              </button>
            )}
            <button type="button" className="link" onClick={dismiss}>
              {t('export.run.dismiss')}
            </button>
          </div>
          {state.result.warnings.length > 0 && (
            <ul className="issues">
              {state.result.warnings.map((w) => (
                <li key={w} className="warning">
                  {w}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {state.status === 'failed' && (
        <div className="export-outcome error">
          <strong>{t('export.run.failed')}</strong>
          <pre>{state.message}</pre>
          <button type="button" className="link" onClick={dismiss}>
            {t('export.run.dismiss')}
          </button>
        </div>
      )}
      {state.status === 'cancelled' && (
        <div className="export-outcome">
          {t(cancelled)}{' '}
          <button type="button" className="link" onClick={dismiss}>
            {t('export.run.dismiss')}
          </button>
        </div>
      )}
    </div>
  );
}
