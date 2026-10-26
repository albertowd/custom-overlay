import {
  anchorPoint,
  getWidgetType,
  isTimingValueId,
  placeAnchor,
  resizeAroundAnchor,
  resolveWidgetProps,
  type ShowWhen,
  type Widget,
  type WidgetAnchor,
  widgetInputs,
  widgetTypes,
} from '@custom-overlay/core';
import { useState } from 'react';
import { formatTime, formatValue } from '../format';
import { coreText, useT } from '../i18n';
import { useStore, useTimeline } from '../store';
import { snapshotValue } from '../values';
import { DataRangeEditor } from './DataRangeEditor';
import { FieldInput, VALUE_IDS_LIST } from './FieldInput';
import { RangeEditor } from './RangeEditor';

const CATEGORIES = ['data', 'map', 'text', 'asset'] as const;
const CONDITIONS: readonly ShowWhen['condition'][] = [
  'has-value',
  'non-zero',
  'zero',
  'positive',
  'negative',
];

function TypePicker({ onPick }: { onPick(type: string): void }) {
  const t = useT();
  const types = widgetTypes();
  return (
    <div className="type-picker">
      {CATEGORIES.map((category) => (
        <div key={category}>
          <h4>{t(`template.widgets.categories.${category}`)}</h4>
          {types
            .filter((w) => w.category === category)
            .map((w) => (
              <button
                type="button"
                key={w.type}
                className="type-card"
                onClick={() => onPick(w.type)}
                title={coreText.widgetDescription(t, w)}
              >
                <strong>{coreText.widgetName(t, w)}</strong>
                <span className="muted small">{coreText.widgetDescription(t, w)}</span>
              </button>
            ))}
        </div>
      ))}
    </div>
  );
}

function PercentField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange(value: number): void;
}) {
  return (
    <label className="field">
      {label}
      <input
        type="number"
        step={0.5}
        value={Number((value * 100).toFixed(2))}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (e.target.value !== '' && Number.isFinite(n)) onChange(n / 100);
        }}
      />
    </label>
  );
}

const ANCHORS: readonly WidgetAnchor[] = [
  'top-left',
  'top',
  'top-right',
  'left',
  'center',
  'right',
  'bottom-left',
  'bottom',
  'bottom-right',
];

/** 3 x 3 grid choosing the point X / Y refer to and resizing keeps in place. */
function AnchorPicker({ value, onChange }: { value: WidgetAnchor; onChange(anchor: WidgetAnchor): void }) {
  const t = useT();
  return (
    <fieldset className="anchor-picker" aria-label={t('template.widgets.anchor')}>
      {ANCHORS.map((anchor) => (
        <button
          type="button"
          key={anchor}
          aria-pressed={anchor === value}
          className={`anchor-cell ${anchor === value ? 'active' : ''}`}
          title={t('template.widgets.anchorTitle', { anchor: t(`template.widgets.anchors.${anchor}`) })}
          onClick={() => onChange(anchor)}
        />
      ))}
    </fieldset>
  );
}

function TestValues({ widget }: { widget: Widget }) {
  const testValues = useStore((s) => s.testValues);
  const setTestValue = useStore((s) => s.setTestValue);
  const snapshot = useStore((s) => s.values);
  const currentTime = useStore((s) => s.currentTime);
  const t = useT();
  const ids = widgetInputs(widget);
  if (ids.length === 0) return null;
  return (
    <details>
      <summary>{t('template.widgets.testValues')}</summary>
      <p className="muted small">{t('template.widgets.testValuesHint')}</p>
      {ids.map((id) => {
        const info = snapshot?.values.find((v) => v.id === id);
        const current = snapshot ? snapshotValue(snapshot, id, currentTime) : Number.NaN;
        return (
          <label key={id} className="field">
            <span className="mono">{id}</span>
            <input
              type="number"
              placeholder={info ? formatValue(current, info.unit) : t('template.widgets.noSuchValue')}
              value={testValues[id] ?? ''}
              onChange={(e) => setTestValue(id, e.target.value === '' ? null : Number(e.target.value))}
            />
          </label>
        );
      })}
    </details>
  );
}

/** When the widget is drawn: the template's time range, or its own. */
function WidgetVisibility({ widget }: { widget: Widget }) {
  const update = useStore((s) => s.updateWidget);
  const templateRange = useStore((s) => s.project.template.visibleRange);
  const frameRate = useStore((s) => s.project.output.frameRate);
  const timeline = useTimeline();
  const t = useT();
  const own = widget.visibleRange !== null;
  const describe = (range: { start: number | null; end: number | null }) =>
    range.start === null && range.end === null
      ? t('template.widgets.wholeVideo')
      : `${range.start === null ? t('template.widgets.rangeStart') : formatTime(range.start)} – ${range.end === null ? t('template.widgets.rangeEnd') : formatTime(range.end)}`;
  return (
    <div className="widget-visibility">
      <label className="field">
        {t('template.widgets.visible')}
        <select
          value={own ? 'own' : 'template'}
          onChange={(e) =>
            update(widget.id, {
              visibleRange: e.target.value === 'own' ? { ...templateRange } : null,
            })
          }
        >
          <option value="template">
            {t('template.widgets.likeTemplate', { range: describe(templateRange) })}
          </option>
          <option value="own">{t('template.widgets.ownRange')}</option>
        </select>
      </label>
      {widget.visibleRange && (
        <RangeEditor
          range={widget.visibleRange}
          min={timeline.start}
          max={timeline.end}
          frameRate={frameRate}
          shortcuts={false}
          onChange={(visibleRange) => update(widget.id, { visibleRange })}
        />
      )}
    </div>
  );
}

/** Where the widget's values come from: the project's data range, or its own. */
function WidgetData({ widget }: { widget: Widget }) {
  const update = useStore((s) => s.updateWidget);
  const projectRange = useStore((s) => s.project.dataRange);
  const resolved = useStore((s) => s.values?.dataRange ?? null);
  const t = useT();
  const own = widget.dataRange !== null;
  const project = resolved
    ? t('track.dataRange.summary', {
        start:
          resolved.start > Number.NEGATIVE_INFINITY
            ? formatTime(resolved.start)
            : t('track.dataRange.sessionStart'),
        end:
          resolved.end < Number.POSITIVE_INFINITY
            ? formatTime(resolved.end)
            : t('track.dataRange.sessionEnd'),
      })
    : t('track.dataRange.untrimmed');
  return (
    <div className="widget-visibility">
      <label className="field">
        {t('template.widgets.data')}
        <select
          value={own ? 'own' : 'project'}
          onChange={(e) =>
            update(widget.id, { dataRange: e.target.value === 'own' ? { ...projectRange } : null })
          }
        >
          <option value="project">{t('template.widgets.likeProject', { range: project })}</option>
          <option value="own">{t('template.widgets.ownData')}</option>
        </select>
      </label>
      {widget.dataRange && (
        <DataRangeEditor
          value={widget.dataRange}
          onChange={(dataRange) => update(widget.id, { dataRange })}
        />
      )}
    </div>
  );
}

function Inspector({ widget }: { widget: Widget }) {
  const update = useStore((s) => s.updateWidget);
  const setProps = useStore((s) => s.setWidgetProps);
  const remove = useStore((s) => s.removeWidget);
  const duplicate = useStore((s) => s.duplicateWidget);
  const t = useT();
  const type = getWidgetType(widget.type);
  if (!type) return <p className="error-text">{t('template.widgets.unknownType', { type: widget.type })}</p>;
  const props = resolveWidgetProps(widget, type);
  const patch = (p: Partial<Widget>) => update(widget.id, p);
  const readsTiming = widgetInputs({ ...widget, timing: null }).some(isTimingValueId);
  const anchor = anchorPoint(widget);

  return (
    <div className="inspector">
      <div className="panel-title">
        <h3>{coreText.widgetName(t, type)}</h3>
        <div className="actions">
          <button type="button" className="small" onClick={() => duplicate(widget.id)}>
            {t('common.duplicate')}
          </button>
          <button type="button" className="small danger" onClick={() => remove(widget.id)}>
            {t('common.delete')}
          </button>
        </div>
      </div>
      <label className="field">
        {t('common.name')}
        <input type="text" value={widget.name} onChange={(e) => patch({ name: e.target.value })} />
      </label>
      <div className="position-row">
        <AnchorPicker value={widget.anchor} onChange={(anchor) => patch({ anchor })} />
        <div className="fields four">
          <PercentField
            label={t('template.widgets.x')}
            value={anchor.x}
            onChange={(x) => patch(placeAnchor(widget, { ...anchor, x }))}
          />
          <PercentField
            label={t('template.widgets.y')}
            value={anchor.y}
            onChange={(y) => patch(placeAnchor(widget, { ...anchor, y }))}
          />
          <PercentField
            label={t('template.widgets.width')}
            value={widget.width}
            onChange={(width) => patch(resizeAroundAnchor(widget, Math.max(0.001, width), widget.height))}
          />
          <PercentField
            label={t('template.widgets.height')}
            value={widget.height}
            onChange={(height) => patch(resizeAroundAnchor(widget, widget.width, Math.max(0.001, height)))}
          />
        </div>
      </div>
      <div className="fields two">
        <label className="field">
          {t('template.widgets.opacity')}
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={widget.opacity}
            onChange={(e) => patch({ opacity: Number(e.target.value) })}
          />
        </label>
        <label className="field">
          {t('template.widgets.antialias')}
          <select
            value={widget.antialias === null ? 'template' : String(widget.antialias)}
            onChange={(e) =>
              patch({ antialias: e.target.value === 'template' ? null : e.target.value === 'true' })
            }
          >
            <option value="template">{t('template.widgets.templateDefault')}</option>
            <option value="true">{t('template.widgets.on')}</option>
            <option value="false">{t('template.widgets.off')}</option>
          </select>
        </label>
      </div>
      {readsTiming && (
        <label className="field">
          {t('template.widgets.lapTiming')}
          <select
            value={widget.timing ?? 'project'}
            onChange={(e) =>
              patch({
                timing: e.target.value === 'project' ? null : (e.target.value as 'imported' | 'lines'),
              })
            }
          >
            <option value="project">{t('template.widgets.timingProject')}</option>
            <option value="imported">{t('template.widgets.timingImported')}</option>
            <option value="lines">{t('template.widgets.timingLines')}</option>
          </select>
        </label>
      )}
      <WidgetVisibility widget={widget} />
      <WidgetData widget={widget} />
      <div className="fields two">
        <label className="field">
          {t('template.widgets.showWhen')}
          <input
            type="text"
            className="mono"
            list={VALUE_IDS_LIST}
            placeholder={t('template.widgets.alwaysShown')}
            value={widget.showWhen?.valueId ?? ''}
            onChange={(e) => {
              const valueId = e.target.value.trim();
              patch({
                showWhen: valueId ? { valueId, condition: widget.showWhen?.condition ?? 'has-value' } : null,
              });
            }}
          />
        </label>
        <label className="field">
          {t('template.widgets.condition')}
          <select
            disabled={!widget.showWhen}
            value={widget.showWhen?.condition ?? 'has-value'}
            onChange={(e) =>
              widget.showWhen &&
              patch({ showWhen: { ...widget.showWhen, condition: e.target.value as ShowWhen['condition'] } })
            }
          >
            {CONDITIONS.map((condition) => (
              <option key={condition} value={condition}>
                {t(`template.widgets.conditions.${condition}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <h3>{t('template.widgets.settings')}</h3>
      {type.fields.map((field) => (
        <FieldInput
          key={field.key}
          widgetType={widget.type}
          field={field}
          value={props[field.key]}
          onChange={(value) => setProps(widget.id, { [field.key]: value })}
        />
      ))}
      <TestValues widget={widget} />
    </div>
  );
}

/** The template's widgets, front first, with add / import and the sample data switch. */
export function WidgetList() {
  const widgets = useStore((s) => s.project.template.widgets);
  const selectedId = useStore((s) => s.selectedWidgetId);
  const snapshot = useStore((s) => s.values);
  const sampleData = useStore((s) => s.sampleData);
  const select = useStore((s) => s.selectWidget);
  const update = useStore((s) => s.updateWidget);
  const move = useStore((s) => s.moveWidget);
  const setSampleData = useStore((s) => s.setSampleData);
  const t = useT();
  const hasData = (snapshot?.grid.count ?? 0) > 0;
  const getWidgetTypeName = (type: string) => {
    const definition = getWidgetType(type);
    return definition ? coreText.widgetName(t, definition) : type;
  };

  return (
    <div className="widgets-panel">
      <div className="row">
        <label className="toggle small" title={t('template.widgets.sampleDataHint')}>
          <input
            type="checkbox"
            checked={sampleData || !hasData}
            disabled={!hasData}
            onChange={(e) => setSampleData(e.target.checked)}
          />
          {t('template.widgets.sampleData')}
        </label>
      </div>
      {widgets.length === 0 && <p className="muted small">{t('template.widgets.empty')}</p>}
      {widgets.length > 0 && (
        <ul className="widget-list">
          {[...widgets].reverse().map((widget) => (
            <li key={widget.id} className={widget.id === selectedId ? 'active' : ''}>
              <button type="button" className="widget-name" onClick={() => select(widget.id)}>
                {widget.name || widget.type}
                <small className="muted">
                  {getWidgetTypeName(widget.type)}
                  {widget.visibleRange ? ` · ${t('template.widgets.ownRangeShort')}` : ''}
                  {widget.dataRange ? ` · ${t('template.widgets.ownDataShort')}` : ''}
                </small>
              </button>
              <button
                type="button"
                className="icon small"
                title={widget.visible ? t('template.widgets.hide') : t('template.widgets.show')}
                onClick={() => update(widget.id, { visible: !widget.visible })}
              >
                {widget.visible ? '👁' : '—'}
              </button>
              <button
                type="button"
                className="icon small"
                title={t('template.widgets.bringForward')}
                onClick={() => move(widget.id, 1)}
              >
                ▲
              </button>
              <button
                type="button"
                className="icon small"
                title={t('template.widgets.sendBackward')}
                onClick={() => move(widget.id, -1)}
              >
                ▼
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Settings of the selected widget. */
export function WidgetInspector() {
  const widgets = useStore((s) => s.project.template.widgets);
  const selectedId = useStore((s) => s.selectedWidgetId);
  const snapshot = useStore((s) => s.values);
  const add = useStore((s) => s.addWidget);
  const importWidgets = useStore((s) => s.importWidgets);
  const exportWidget = useStore((s) => s.exportWidget);
  // The picker belongs to the selection it was opened on: selecting another widget closes it.
  const [pickingFor, setPickingFor] = useState<string | null | undefined>(undefined);
  const picking = pickingFor !== undefined && pickingFor === (selectedId ?? null);
  const selected = widgets.find((w) => w.id === selectedId);
  const t = useT();
  return (
    <div className="widgets-panel">
      <div className="row">
        <button
          type="button"
          className="primary small"
          onClick={() => setPickingFor(picking ? undefined : (selectedId ?? null))}
        >
          {picking ? t('common.cancel') : t('template.widgets.add')}
        </button>
        <button type="button" className="small" onClick={() => void importWidgets()}>
          {t('common.import')}
        </button>
        <button
          type="button"
          className="small"
          disabled={!selected}
          title={selected ? undefined : t('template.widgets.selectHint')}
          onClick={() => selected && void exportWidget(selected.id)}
        >
          {t('common.export')}
        </button>
      </div>
      <datalist id={VALUE_IDS_LIST}>
        {snapshot?.values.map((v) => (
          <option key={v.id} value={v.id}>
            {coreText.valueName(t, v)}
          </option>
        ))}
      </datalist>
      {picking && (
        <TypePicker
          onPick={(type) => {
            add(type);
            setPickingFor(undefined);
          }}
        />
      )}
      {!picking && selected && <Inspector widget={selected} />}
      {!picking && !selected && <p className="muted small">{t('template.widgets.selectHint')}</p>}
    </div>
  );
}
