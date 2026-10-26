import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { type BusyTask, useBusyTask } from '../store';
import { ExportProgressView } from './ExportRunner';

/** Short tasks finish before the mask would show: no flicker while dragging a line end. */
const SHOW_AFTER_MS = 300;
/** Files named in the mask; the others are counted. */
const MAX_FILES = 4;

/** `active`, but only once it has stayed true for `delayMs`; false again as soon as it is false. */
function useDelayed(active: boolean, delayMs: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    if (delayMs === 0) {
      setShown(true);
      return;
    }
    const timer = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(timer);
  }, [active, delayMs]);
  return shown;
}

function TaskContent({ task }: { task: BusyTask }) {
  const t = useT();
  if (task.kind === 'export') {
    return (
      <>
        <h2 id="busy-title">{t('app.busy.export.title')}</h2>
        <p className="muted small">{t('app.busy.export.detail')}</p>
        <ExportProgressView progress={task.progress} />
      </>
    );
  }
  const files = task.kind === 'media' ? task.files : [];
  return (
    <>
      <div className="busy-spinner" aria-hidden="true" />
      <h2 id="busy-title">{t(`app.busy.${task.kind}.title`)}</h2>
      <p className="muted small">{t(`app.busy.${task.kind}.detail`)}</p>
      {files.length > 0 && (
        <ul className="busy-files">
          {files.slice(0, MAX_FILES).map((file) => (
            <li key={file}>{file}</li>
          ))}
          {files.length > MAX_FILES && (
            <li>{t('app.busy.media.more', { count: files.length - MAX_FILES })}</li>
          )}
        </ul>
      )}
    </>
  );
}

/**
 * Blocks the app while a heavy task runs (export, media loading, value recalculation): a modal
 * dialog makes everything behind it inert, so settings cannot change under the task. An export
 * shows at once with its progress and cancel button; other tasks only when they take a while.
 */
export function BusyMask() {
  const task = useBusyTask();
  const visible = useDelayed(task !== null, task?.kind === 'export' ? 0 : SHOW_AFTER_MS);
  const ref = useRef<HTMLDialogElement>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (visible && !dialog.open) dialog.showModal();
    else if (!visible && dialog.open) dialog.close();
  }, [visible]);

  return (
    <dialog
      ref={ref}
      className="modal busy-mask"
      aria-labelledby="busy-title"
      aria-busy="true"
      // Escape must not hide the mask; Chromium may still close it on a repeated Escape: reopen.
      onCancel={(e) => e.preventDefault()}
      onClose={() => {
        if (visibleRef.current) ref.current?.showModal();
      }}
    >
      {visible && task && <TaskContent task={task} />}
    </dialog>
  );
}
