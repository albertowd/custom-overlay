import {
  type AlignEdge,
  fieldShown,
  findGroup,
  framePosition,
  getWidgetType,
  groupMembers,
  isTimingValueId,
  type Layer,
  layers,
  placeAnchor,
  resizeAroundAnchor,
  resolveWidgetProps,
  type ShowWhen,
  shownPosition,
  type Widget,
  type WidgetAnchor,
  type WidgetGroup,
  widgetInputs,
  widgetTypes,
} from '@custom-overlay/core';
import { type MouseEvent, useState } from 'react';
import { formatTime, formatValue } from '../format';
import { coreText, useT } from '../i18n';
import { ALIGN_TARGETS, selectionIds, useStore, useTimeline } from '../store';
import { snapshotValue } from '../values';
import { Segmented } from './common';
import { DataRangeEditor } from './DataRangeEditor';
import { FieldInput, VALUE_IDS_LIST } from './FieldInput';
import { Icon, type IconName } from './Icon';
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

const ALIGN_EDGES: readonly [AlignEdge, IconName][] = [
  ['left', 'align-left'],
  ['center', 'align-center'],
  ['right', 'align-right'],
  ['top', 'align-top'],
  ['middle', 'align-middle'],
  ['bottom', 'align-bottom'],
];

/** Align buttons for the selection, what they align to, and spreading (three widgets or more). */
function AlignTools({ count }: { count: number }) {
  const alignTo = useStore((s) => s.alignTo);
  const setAlignTo = useStore((s) => s.setAlignTo);
  const align = useStore((s) => s.alignSelection);
  const distribute = useStore((s) => s.distributeSelection);
  const t = useT();
  return (
    <div className="align-tools">
      <div className="align-tools-head">
        <span>{t('template.align.title')}</span>
        <Segmented
          label={t('template.align.to')}
          value={alignTo}
          options={ALIGN_TARGETS.map((target) => [target, t(`template.align.targets.${target}`)] as const)}
          onChange={setAlignTo}
          className="small"
        />
      </div>
      <div className="icon-row">
        {ALIGN_EDGES.map(([edge, icon]) => (
          <button
            type="button"
            key={edge}
            className="icon"
            title={t(`template.align.edges.${edge}`)}
            aria-label={t(`template.align.edges.${edge}`)}
            onClick={() => align(edge)}
          >
            <Icon name={icon} />
          </button>
        ))}
        <span className="icon-row-gap" />
        {(['horizontal', 'vertical'] as const).map((axis) => (
          <button
            type="button"
            key={axis}
            className="icon"
            disabled={count < 3}
            title={t(`template.align.distribute.${axis}`)}
            aria-label={t(`template.align.distribute.${axis}`)}
            onClick={() => distribute(axis)}
          >
            <Icon name={`distribute-${axis}`} />
          </button>
        ))}
      </div>
      <small className="muted field-hint">{t(`template.align.hints.${alignTo}`)}</small>
    </div>
  );
}

/** The group a widget belongs to, and whether it moves with it. */
function WidgetGroupFields({ widget }: { widget: Widget }) {
  const groups = useStore((s) => s.project.template.groups);
  const setGroup = useStore((s) => s.setWidgetGroup);
  const update = useStore((s) => s.updateWidget);
  const t = useT();
  if (groups.length === 0) return null;
  return (
    <div className="fields two">
      <label className="field">
        {t('template.groups.group')}
        <select value={widget.groupId ?? ''} onChange={(e) => setGroup(widget.id, e.target.value || null)}>
          <option value="">{t('template.groups.none')}</option>
          {groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </select>
      </label>
      {widget.groupId && (
        <div className="field">
          <span>{t('template.groups.position')}</span>
          <Segmented
            label={t('template.groups.position')}
            value={widget.groupPosition}
            options={[
              ['relative', t('template.groups.relative')],
              ['absolute', t('template.groups.absolute')],
            ]}
            onChange={(groupPosition) => update(widget.id, { groupPosition })}
          />
          <small className="muted field-hint">{t(`template.groups.${widget.groupPosition}Hint`)}</small>
        </div>
      )}
    </div>
  );
}

function Inspector({ widget }: { widget: Widget }) {
  const update = useStore((s) => s.updateWidget);
  const setProps = useStore((s) => s.setWidgetProps);
  const remove = useStore((s) => s.removeWidget);
  const duplicate = useStore((s) => s.duplicateWidget);
  const template = useStore((s) => s.project.template);
  const t = useT();
  const type = getWidgetType(widget.type);
  if (!type) return <p className="error-text">{t('template.widgets.unknownType', { type: widget.type })}</p>;
  const props = resolveWidgetProps(widget, type);
  const patch = (p: Partial<Widget>) => update(widget.id, p);
  const readsTiming = widgetInputs({ ...widget, timing: null }).some(isTimingValueId);
  // A relative group member shows where it sits from its group origin.
  const anchor = shownPosition(template, widget);
  const relative = widget.groupPosition === 'relative' && findGroup(template, widget.groupId) !== undefined;
  const moveTo = (shown: { x: number; y: number }) =>
    patch(placeAnchor(widget, framePosition(template, widget, shown)));

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
            label={relative ? t('template.groups.relativeX') : t('template.widgets.x')}
            value={anchor.x}
            onChange={(x) => moveTo({ ...anchor, x })}
          />
          <PercentField
            label={relative ? t('template.groups.relativeY') : t('template.widgets.y')}
            value={anchor.y}
            onChange={(y) => moveTo({ ...anchor, y })}
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
      <WidgetGroupFields widget={widget} />
      <AlignTools count={1} />
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
      {type.fields
        .filter((field) => fieldShown(field, type.fields, props))
        .map((field) => (
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

/** Ctrl / Cmd / Shift click adds to the selection (or takes out of it). */
const adds = (event: MouseEvent) => event.ctrlKey || event.metaKey || event.shiftKey;

/** The template's widgets as layers, front first: groups with their members, and the sample data switch. */
export function WidgetList() {
  const template = useStore((s) => s.project.template);
  const selectedId = useStore((s) => s.selectedWidgetId);
  const selectedIds = useStore((s) => s.selectedWidgetIds);
  const selectedGroupId = useStore((s) => s.selectedGroupId);
  const snapshot = useStore((s) => s.values);
  const sampleData = useStore((s) => s.sampleData);
  const select = useStore((s) => s.selectWidget);
  const selectGroup = useStore((s) => s.selectGroup);
  const update = useStore((s) => s.updateWidget);
  const updateGroup = useStore((s) => s.updateGroup);
  const move = useStore((s) => s.moveWidget);
  const moveGroup = useStore((s) => s.moveGroupLayer);
  const groupSelection = useStore((s) => s.groupSelection);
  const setSampleData = useStore((s) => s.setSampleData);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const t = useT();
  const hasData = (snapshot?.grid.count ?? 0) > 0;
  const { widgets } = template;
  const known = selectedIds.filter((id) => widgets.some((w) => w.id === id));
  const canGroup = selectedGroupId === null && known.length >= 2;
  const getWidgetTypeName = (type: string) => {
    const definition = getWidgetType(type);
    return definition ? coreText.widgetName(t, definition) : type;
  };
  const toggleCollapsed = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const layerButtons = (visible: boolean, onToggle: () => void, onMove: (direction: 1 | -1) => void) => (
    <>
      <button
        type="button"
        className="icon small"
        title={visible ? t('template.widgets.hide') : t('template.widgets.show')}
        onClick={onToggle}
      >
        <Icon name={visible ? 'eye' : 'eye-off'} />
      </button>
      <button
        type="button"
        className="icon small"
        title={t('template.widgets.bringForward')}
        onClick={() => onMove(1)}
      >
        <Icon name="up" />
      </button>
      <button
        type="button"
        className="icon small"
        title={t('template.widgets.sendBackward')}
        onClick={() => onMove(-1)}
      >
        <Icon name="down" />
      </button>
    </>
  );

  const widgetRow = (widget: Widget, member: boolean) => {
    const active = selectedGroupId === null && (widget.id === selectedId || known.includes(widget.id));
    return (
      <li key={widget.id} className={[active ? 'active' : '', member ? 'member' : ''].join(' ').trim()}>
        <button
          type="button"
          className="widget-name"
          onClick={(e) => select(widget.id, adds(e) ? 'toggle' : 'replace')}
        >
          {widget.name || widget.type}
          <small className="muted">
            {getWidgetTypeName(widget.type)}
            {widget.visibleRange ? ` · ${t('template.widgets.ownRangeShort')}` : ''}
            {widget.dataRange ? ` · ${t('template.widgets.ownDataShort')}` : ''}
            {member && widget.groupPosition === 'absolute' ? ` · ${t('template.groups.absoluteShort')}` : ''}
          </small>
        </button>
        {layerButtons(
          widget.visible,
          () => update(widget.id, { visible: !widget.visible }),
          (direction) => move(widget.id, direction),
        )}
      </li>
    );
  };

  const groupRow = (layer: Extract<Layer, { kind: 'group' }>) => {
    const { group } = layer;
    const open = !collapsed.has(group.id);
    return [
      <li key={group.id} className={`group-row ${selectedGroupId === group.id ? 'active' : ''}`.trim()}>
        <button
          type="button"
          className={`icon small disclosure ${open ? 'open' : ''}`}
          aria-expanded={open}
          title={open ? t('template.groups.collapse') : t('template.groups.expand')}
          onClick={() => toggleCollapsed(group.id)}
        >
          <Icon name="chevron" />
        </button>
        <button type="button" className="widget-name" onClick={() => selectGroup(group.id)}>
          <span className="group-name">
            <Icon name="group" size={14} /> {group.name}
          </span>
          <small className="muted">{t('template.groups.count', { count: layer.widgets.length })}</small>
        </button>
        {layerButtons(
          group.visible,
          () => updateGroup(group.id, { visible: !group.visible }),
          (direction) => moveGroup(group.id, direction),
        )}
      </li>,
      ...(open ? [...layer.widgets].reverse().map((widget) => widgetRow(widget, true)) : []),
    ];
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
        <span className="spacer" />
        <button
          type="button"
          className="small"
          disabled={!canGroup}
          title={t('template.groups.groupHint')}
          onClick={groupSelection}
        >
          <Icon name="group" size={14} /> {t('template.groups.groupAction')}
        </button>
      </div>
      {widgets.length === 0 && <p className="muted small">{t('template.widgets.empty')}</p>}
      {widgets.length > 0 && (
        <ul className="widget-list">
          {[...layers(template)]
            .reverse()
            .flatMap((layer) =>
              layer.kind === 'widget' ? [widgetRow(layer.widget, false)] : groupRow(layer),
            )}
        </ul>
      )}
      {widgets.length > 1 && <p className="muted small">{t('template.groups.multiSelectHint')}</p>}
    </div>
  );
}

/** Settings of the selected group. */
function GroupInspector({ group }: { group: WidgetGroup }) {
  const template = useStore((s) => s.project.template);
  const members = groupMembers(template, group.id);
  const updateGroup = useStore((s) => s.updateGroup);
  const moveGroupBy = useStore((s) => s.moveGroupBy);
  const ungroup = useStore((s) => s.ungroup);
  const duplicate = useStore((s) => s.duplicateGroup);
  const remove = useStore((s) => s.removeGroup);
  const t = useT();
  const absolute = members.filter((w) => w.groupPosition === 'absolute').length;
  return (
    <div className="inspector">
      <div className="panel-title">
        <h3>{t('template.groups.title')}</h3>
        <div className="actions">
          <button type="button" className="small" onClick={() => duplicate(group.id)}>
            {t('common.duplicate')}
          </button>
          <button type="button" className="small" onClick={() => ungroup(group.id)}>
            {t('template.groups.ungroup')}
          </button>
          <button type="button" className="small danger" onClick={() => remove(group.id)}>
            {t('common.delete')}
          </button>
        </div>
      </div>
      <label className="field">
        {t('common.name')}
        <input
          type="text"
          value={group.name}
          onChange={(e) => updateGroup(group.id, { name: e.target.value })}
        />
      </label>
      <label className="toggle">
        <input
          type="checkbox"
          checked={group.visible}
          onChange={(e) => updateGroup(group.id, { visible: e.target.checked })}
        />
        {t('template.groups.visible')}
      </label>
      <div className="fields two">
        <PercentField
          label={t('template.groups.originX')}
          value={group.x}
          onChange={(x) => moveGroupBy(group.id, x - group.x, 0)}
        />
        <PercentField
          label={t('template.groups.originY')}
          value={group.y}
          onChange={(y) => moveGroupBy(group.id, 0, y - group.y)}
        />
      </div>
      <small className="muted field-hint">
        {t('template.groups.originHint')}
        {absolute > 0 ? ` ${t('template.groups.absoluteCount', { count: absolute })}` : ''}
      </small>
      <AlignTools count={members.length} />
    </div>
  );
}

/** Several widgets selected: group, align or delete them together. */
function SelectionInspector({ count }: { count: number }) {
  const groupSelection = useStore((s) => s.groupSelection);
  const removeSelection = useStore((s) => s.removeSelection);
  const t = useT();
  return (
    <div className="inspector">
      <div className="panel-title">
        <h3>{t('template.groups.selected', { count })}</h3>
        <div className="actions">
          <button type="button" className="small primary" onClick={groupSelection}>
            {t('template.groups.groupAction')}
          </button>
          <button type="button" className="small danger" onClick={removeSelection}>
            {t('common.delete')}
          </button>
        </div>
      </div>
      <AlignTools count={count} />
    </div>
  );
}

/** Settings of the selection: a group, several widgets or one widget. */
export function WidgetInspector() {
  const project = useStore((s) => s.project);
  const selectedId = useStore((s) => s.selectedWidgetId);
  const selectedWidgetIds = useStore((s) => s.selectedWidgetIds);
  const selectedGroupId = useStore((s) => s.selectedGroupId);
  const { widgets, groups } = project.template;
  const selection = selectionIds({ project, selectedWidgetIds, selectedGroupId });
  const snapshot = useStore((s) => s.values);
  const add = useStore((s) => s.addWidget);
  const importWidgets = useStore((s) => s.importWidgets);
  const exportWidget = useStore((s) => s.exportWidget);
  // The picker belongs to the selection it was opened on: selecting another widget closes it.
  const [pickingFor, setPickingFor] = useState<string | null | undefined>(undefined);
  const picking = pickingFor !== undefined && pickingFor === (selectedId ?? null);
  const group = selectedGroupId ? groups.find((g) => g.id === selectedGroupId) : undefined;
  const selected = group || selection.length > 1 ? undefined : widgets.find((w) => w.id === selectedId);
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
      {!picking && group && <GroupInspector group={group} />}
      {!picking && !group && selection.length > 1 && <SelectionInspector count={selection.length} />}
      {!picking && selected && <Inspector widget={selected} />}
      {!picking && !group && !selected && selection.length <= 1 && (
        <p className="muted small">{t('template.widgets.selectHint')}</p>
      )}
    </div>
  );
}
