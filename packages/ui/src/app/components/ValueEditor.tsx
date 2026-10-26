import type { ValueScript } from '@custom-overlay/core';
import { type KeyboardEvent, useState } from 'react';
import { formatValue } from '../format';
import { useT } from '../i18n';
import { useStore } from '../store';
import { snapshotValue } from '../values';

interface ValueEditorProps {
  /** Id of the script being edited, null for a new one. */
  previousId: string | null;
  initial: ValueScript;
  onClose(): void;
}

/** Insert two spaces on Tab instead of leaving the code editor. */
function handleTab(event: KeyboardEvent<HTMLTextAreaElement>, setCode: (code: string) => void): void {
  if (event.key !== 'Tab') return;
  event.preventDefault();
  const area = event.currentTarget;
  const { selectionStart, selectionEnd, value } = area;
  setCode(`${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`);
  requestAnimationFrame(() => area.setSelectionRange(selectionStart + 2, selectionStart + 2));
}

export function ValueEditor({ previousId, initial, onClose }: ValueEditorProps) {
  const save = useStore((s) => s.saveValueScript);
  const remove = useStore((s) => s.deleteValueScript);
  const snapshot = useStore((s) => s.values);
  const currentTime = useStore((s) => s.currentTime);
  const [draft, setDraft] = useState<ValueScript>(initial);
  const [initialText, setInitialText] = useState(initial.initial === null ? '' : String(initial.initial));
  const [problem, setProblem] = useState<string | null>(null);
  const [savedId, setSavedId] = useState(previousId);
  const t = useT();

  const update = (patch: Partial<ValueScript>) => setDraft((d) => ({ ...d, ...patch }));

  /** Save into the project; the values panel re-evaluates and reports script errors below. */
  const apply = () => {
    const initialValue = initialText.trim() === '' ? null : Number(initialText);
    if (initialValue !== null && !Number.isFinite(initialValue)) {
      setProblem(t('values.editor.initialInvalid'));
      return false;
    }
    const error = save(savedId, { ...draft, initial: initialValue });
    setProblem(error);
    if (!error) setSavedId(draft.id);
    return !error;
  };

  const evaluationError = savedId ? snapshot?.errors[savedId] : undefined;
  const preview = savedId && snapshot ? snapshotValue(snapshot, savedId, currentTime) : Number.NaN;

  return (
    <div className="value-editor">
      <div className="fields two">
        <label className="field">
          {t('values.editor.id')}
          <input
            type="text"
            className="mono"
            value={draft.id}
            onChange={(e) => update({ id: e.target.value })}
          />
        </label>
        <label className="field">
          {t('common.name')}
          <input type="text" value={draft.name} onChange={(e) => update({ name: e.target.value })} />
        </label>
        <label className="field">
          {t('common.unit')}
          <input type="text" value={draft.unit} onChange={(e) => update({ unit: e.target.value })} />
        </label>
        <label className="field">
          {t('values.editor.initial')}
          <input
            type="text"
            inputMode="decimal"
            placeholder={t('values.editor.initialPlaceholder')}
            value={initialText}
            onChange={(e) => setInitialText(e.target.value)}
          />
        </label>
      </div>
      <label className="field">
        {t('common.description')}
        <input
          type="text"
          value={draft.description}
          onChange={(e) => update({ description: e.target.value })}
        />
      </label>
      <label className="field">
        <span>
          {t('values.editor.scriptBefore')} <code>function (ctx)</code> {t('values.editor.scriptAfter')}
        </span>
        <textarea
          className="code"
          spellCheck={false}
          rows={14}
          value={draft.code}
          onChange={(e) => update({ code: e.target.value })}
          onKeyDown={(e) => handleTab(e, (code) => update({ code }))}
        />
      </label>
      {problem && <p className="error-text small">{problem}</p>}
      {evaluationError && (
        <p className="error-text small">{t('values.editor.scriptError', { error: evaluationError })}</p>
      )}
      {savedId && !evaluationError && (
        <p className="muted small">
          {t('values.editor.atPlayhead')} <span className="mono">{formatValue(preview, draft.unit)}</span>
        </p>
      )}
      <div className="row">
        <button type="button" className="primary" onClick={apply}>
          {savedId ? t('common.apply') : t('common.add')}
        </button>
        <button type="button" onClick={() => (apply() ? onClose() : undefined)}>
          {t('values.editor.saveClose')}
        </button>
        <button type="button" onClick={onClose}>
          {t('values.editor.back')}
        </button>
        {savedId && (
          <button
            type="button"
            className="danger"
            onClick={() => {
              remove(savedId);
              onClose();
            }}
          >
            {t('common.delete')}
          </button>
        )}
      </div>
    </div>
  );
}
