import { useEffect, useRef, useState } from 'react';
import type { UpdateInfo } from '../../shared/api';
import { api } from '../api';
import { useT } from '../i18n';
import { useStore } from '../store';

const SKIP_KEY = 'custom-overlay.update.skip';

function skippedVersion(): string | null {
  try {
    return localStorage.getItem(SKIP_KEY);
  } catch {
    return null;
  }
}

/** Checked once per app start. */
let checked = false;

/**
 * Tells about a newer release on GitHub at startup and offers to download its installer for
 * this system. Waits for the new project dialog, and stays quiet for a skipped version.
 */
export function UpdateDialog() {
  const t = useT();
  const naming = useStore((s) => s.naming);
  const ref = useRef<HTMLDialogElement>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (checked) return;
    checked = true;
    void api()
      .checkForUpdate()
      .then((found) => {
        if (found && found.latest !== skippedVersion()) setUpdate(found);
      })
      .catch(() => undefined);
  }, []);

  // One dialog at a time: after the startup project dialog.
  useEffect(() => {
    if (update && !naming) setOpen(true);
  }, [update, naming]);

  useEffect(() => {
    if (open) ref.current?.showModal();
    else ref.current?.close();
  }, [open]);

  if (!update || !open) return null;
  const close = () => setOpen(false);
  const skip = () => {
    try {
      localStorage.setItem(SKIP_KEY, update.latest);
    } catch {
      // Storage unavailable: it will be offered again next start.
    }
    close();
  };
  const go = (url: string) => {
    void api().openProjectUrl(url);
    close();
  };

  return (
    <dialog ref={ref} className="modal update-dialog" aria-labelledby="update-title" onClose={close}>
      <h2 id="update-title">
        {t('app.update.title')}{' '}
        <span className={`badge update-${update.change}`}>{t(`app.update.change.${update.change}`)}</span>
      </h2>
      <p>{t('app.update.message', { latest: update.latest, current: update.current })}</p>
      {update.notes && (
        <>
          <h3 className="update-notes-title">{t('app.update.notes')}</h3>
          <pre className="update-notes">{update.notes}</pre>
        </>
      )}
      {!update.downloadUrl && <p className="muted small">{t('app.update.noInstaller')}</p>}
      <div className="modal-actions wrap">
        <button type="button" className="link" onClick={skip}>
          {t('app.update.skip')}
        </button>
        <button type="button" onClick={close}>
          {t('app.update.later')}
        </button>
        <button
          type="button"
          className={update.downloadUrl ? '' : 'primary'}
          onClick={() => go(update.pageUrl)}
        >
          {t('app.update.page')}
        </button>
        {update.downloadUrl && (
          <button type="button" className="primary" onClick={() => go(update.downloadUrl as string)}>
            {t('app.update.download', { file: update.assetName ?? '' })}
          </button>
        )}
      </div>
    </dialog>
  );
}
