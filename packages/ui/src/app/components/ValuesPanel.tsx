import type { ValueInfo, ValueOrigin, ValueScript } from '@custom-overlay/core';
import { useMemo, useState } from 'react';
import { formatValue } from '../format';
import { coreText, useT } from '../i18n';
import { useStore } from '../store';
import { snapshotValue } from '../values';
import { ValueEditor } from './ValueEditor';

const GROUPS: readonly ValueOrigin[] = ['script', 'builtin', 'source'];

const NEW_SCRIPT: ValueScript = {
  id: 'my.value',
  name: 'My value',
  description: '',
  unit: '',
  initial: null,
  code: "// One number per frame. See the values README for the ctx API.\nconst speed = ctx.get('speed');\nreturn speed.map((v) => v * 3.6);\n",
};

function ValueRow({
  info,
  value,
  error,
  onEdit,
}: {
  info: ValueInfo;
  value: number;
  error?: string;
  onEdit?(): void;
}) {
  const t = useT();
  const name = coreText.valueName(t, info);
  const title = [
    name,
    coreText.valueDescription(t, info),
    info.overrides && t('values.panel.replaces', { origin: t(`values.origins.${info.overrides}`) }),
    error,
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <tr className={error ? 'has-error' : ''} title={title}>
      <th>
        {onEdit ? (
          <button type="button" className="link mono" onClick={onEdit}>
            {info.id}
          </button>
        ) : (
          <span className="mono">{info.id}</span>
        )}
        <small>{name}</small>
      </th>
      <td>
        {error ? (
          <span className="error-text">{t('values.panel.error')}</span>
        ) : (
          formatValue(value, info.unit)
        )}
      </td>
    </tr>
  );
}

export function ValuesPanel() {
  const snapshot = useStore((s) => s.values);
  const failure = useStore((s) => s.valuesError);
  const scripts = useStore((s) => s.project.values);
  const currentTime = useStore((s) => s.currentTime);
  const importValues = useStore((s) => s.importValues);
  const exportValues = useStore((s) => s.exportValues);
  const [filter, setFilter] = useState('');
  const t = useT();
  const [editing, setEditing] = useState<{ previousId: string | null; script: ValueScript } | null>(null);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const all = snapshot?.values ?? [];
    return needle
      ? all.filter((v) =>
          `${v.id} ${coreText.valueName(t, v)} ${coreText.valueDescription(t, v)}`
            .toLowerCase()
            .includes(needle),
        )
      : all;
  }, [snapshot, filter, t]);

  if (editing) {
    return (
      <ValueEditor
        previousId={editing.previousId}
        initial={editing.script}
        onClose={() => setEditing(null)}
      />
    );
  }

  const errorCount = Object.keys(snapshot?.errors ?? {}).length;
  return (
    <div className="values-panel">
      <div className="row">
        <button
          type="button"
          className="primary small"
          onClick={() =>
            setEditing({ previousId: null, script: { ...NEW_SCRIPT, name: t('values.panel.newScriptName') } })
          }
        >
          {t('values.panel.new')}
        </button>
        <button type="button" className="small" onClick={() => void importValues()}>
          {t('common.import')}
        </button>
        <button
          type="button"
          className="small"
          onClick={() => void exportValues()}
          disabled={scripts.length === 0}
        >
          {t('common.export')}
        </button>
      </div>
      <input
        type="text"
        placeholder={t('values.panel.filter')}
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      {failure && <p className="error-text small">{failure}</p>}
      {errorCount > 0 && (
        <p className="error-text small">{t('values.panel.failed', { count: errorCount })}</p>
      )}
      {!snapshot && !failure && <p className="muted small">{t('values.panel.evaluating')}</p>}
      {snapshot &&
        GROUPS.map((origin) => {
          const group = visible.filter((v) => v.origin === origin);
          if (group.length === 0) return null;
          return (
            <details key={origin} open={origin !== 'source'}>
              <summary>
                {t(`values.groups.${origin}`)} ({group.length})
              </summary>
              <table className="live-values values-table">
                <tbody>
                  {group.map((info) => {
                    const script = scripts.find((s) => s.id === info.id);
                    return (
                      <ValueRow
                        key={info.id}
                        info={info}
                        value={snapshotValue(snapshot, info.id, currentTime)}
                        error={snapshot.errors[info.id]}
                        onEdit={script ? () => setEditing({ previousId: script.id, script }) : undefined}
                      />
                    );
                  })}
                </tbody>
              </table>
            </details>
          );
        })}
      <p className="muted small">{t('values.panel.trust')}</p>
    </div>
  );
}
