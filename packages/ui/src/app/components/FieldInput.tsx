import { type FieldSpec, isPaletteKey, PALETTE_KEYS } from '@custom-overlay/core';
import { useState } from 'react';
import { coreText, useT } from '../i18n';
import { TimeInput } from './TimeInput';

/** Max size of an embedded image: templates carry their images, keep them reasonable. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const VALUE_IDS_LIST = 'value-ids';

interface FieldInputProps {
  /** Widget type the field belongs to, for its translated label. */
  widgetType: string;
  field: FieldSpec;
  value: unknown;
  onChange(value: unknown): void;
}

function ColorInput({ value, onChange }: { value: string; onChange(value: string): void }) {
  const t = useT();
  const custom = !isPaletteKey(value);
  return (
    <div className="color-input">
      <select
        value={custom ? 'custom' : value}
        onChange={(e) => onChange(e.target.value === 'custom' ? '#ffffff' : e.target.value)}
      >
        {PALETTE_KEYS.map((key) => (
          <option key={key} value={key}>
            {t('template.field.paletteColor', { name: t(`template.palette.${key}`) })}
          </option>
        ))}
        <option value="custom">{t('template.field.customColor')}</option>
      </select>
      {custom && <input type="color" value={value.slice(0, 7)} onChange={(e) => onChange(e.target.value)} />}
    </div>
  );
}

function ImageInput({ value, onChange }: { value: string; onChange(value: string): void }) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="image-input">
      {value && <img src={value} alt="" />}
      <label className="button small">
        {value ? t('template.field.replaceImage') : t('template.field.chooseImage')}
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            if (file.size > MAX_IMAGE_BYTES) {
              setError(t('template.field.imageTooLarge'));
              return;
            }
            const reader = new FileReader();
            reader.onload = () => {
              setError(null);
              onChange(String(reader.result));
            };
            reader.readAsDataURL(file);
          }}
        />
      </label>
      {value && (
        <button type="button" className="small" onClick={() => onChange('')}>
          {t('common.remove')}
        </button>
      )}
      {error && <p className="error-text small">{error}</p>}
    </div>
  );
}

/** Editor for one widget property, from its field spec. */
export function FieldInput({ widgetType, field, value, onChange }: FieldInputProps) {
  const t = useT();
  const label = coreText.fieldLabel(t, widgetType, field);
  const hint = coreText.fieldHint(t, widgetType, field);
  let input: React.ReactNode;
  switch (field.kind) {
    case 'number':
      input = (
        <input
          type="number"
          value={typeof value === 'number' ? value : ''}
          min={field.min}
          max={field.max}
          step={field.step ?? 1}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (e.target.value !== '' && Number.isFinite(n)) onChange(n);
          }}
        />
      );
      break;
    case 'time':
      input = (
        <TimeInput
          value={typeof value === 'number' ? value : 0}
          onCommit={(time) => {
            if (time !== null) onChange(time);
            return true;
          }}
        />
      );
      break;
    case 'text':
      input = <input type="text" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'textarea':
      input = <textarea rows={3} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'boolean':
      return (
        <label className="toggle">
          <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
          {label}
        </label>
      );
    case 'select':
      input = (
        <select value={String(value)} onChange={(e) => onChange(e.target.value)}>
          {field.options.map((option) => (
            <option key={option[0]} value={option[0]}>
              {coreText.fieldOption(t, widgetType, field.key, option)}
            </option>
          ))}
        </select>
      );
      break;
    case 'color':
      input = <ColorInput value={String(value ?? 'text')} onChange={onChange} />;
      break;
    case 'value':
      input = (
        <input
          type="text"
          className="mono"
          list={VALUE_IDS_LIST}
          placeholder={t('template.field.valueId')}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value.trim())}
        />
      );
      break;
    case 'image':
      input = <ImageInput value={String(value ?? '')} onChange={onChange} />;
      break;
  }
  return (
    <div className="field" title={hint}>
      <span>{label}</span>
      {input}
      {hint && <small className="muted field-hint">{hint}</small>}
    </div>
  );
}
