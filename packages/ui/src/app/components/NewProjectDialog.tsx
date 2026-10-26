import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { useStore } from '../store';

/**
 * Asks for the name of a new project (also the suggested file name when saving). At startup it
 * can't be dismissed, but the user can open an existing project instead.
 */
export function NewProjectDialog() {
  const t = useT();
  const naming = useStore((s) => s.naming);
  const newProject = useStore((s) => s.newProject);
  const cancel = useStore((s) => s.cancelNewProject);
  const openProject = useStore((s) => s.openProject);
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState('');

  useEffect(() => {
    if (!naming) return;
    setName('');
    ref.current?.showModal();
    return () => ref.current?.close();
  }, [naming]);

  if (!naming) return null;
  const trimmed = name.trim();
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby="new-project-title"
      onCancel={(e) => {
        e.preventDefault();
        if (naming === 'new') cancel();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed) newProject(trimmed);
        }}
      >
        <h2 id="new-project-title">{t('app.newProject.title')}</h2>
        <p className="muted">{t('app.newProject.hint')}</p>
        <input
          type="text"
          autoFocus
          value={name}
          maxLength={120}
          placeholder={t('app.newProject.placeholder')}
          aria-label={t('common.name')}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="modal-actions">
          {naming === 'startup' ? (
            <button type="button" onClick={() => void openProject()}>
              {t('app.newProject.openInstead')}
            </button>
          ) : (
            <button type="button" onClick={cancel}>
              {t('common.cancel')}
            </button>
          )}
          <button type="submit" className="primary" disabled={!trimmed}>
            {t('app.newProject.create')}
          </button>
        </div>
      </form>
    </dialog>
  );
}
