import { type Palette, STEP_DEFINITIONS } from '@custom-overlay/core';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { CanvasSettings } from '../components/CanvasSettings';
import { StepHeader } from '../components/common';
import { OverlayEditor } from '../components/OverlayEditor';
import { Preview } from '../components/Preview';
import { RangeEditor } from '../components/RangeEditor';
import { ValuesPanel } from '../components/ValuesPanel';
import { WidgetInspector, WidgetList } from '../components/WidgetsPanel';
import { coreText, useT } from '../i18n';
import { errorMessage, useStore, useTimeline, useValuesRefresh } from '../store';

const PALETTE_KEYS: readonly (keyof Palette)[] = [
  'primary',
  'secondary',
  'accent',
  'text',
  'textMuted',
  'background',
  'positive',
  'negative',
  'warning',
];

const HEX = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i;

type Tab = 'widget' | 'values' | 'style';

const TABS: readonly Tab[] = ['widget', 'values', 'style'];

function ColorField({
  name,
  value,
  onChange,
}: {
  name: string;
  value: string;
  onChange(value: string): void;
}) {
  const t = useT();
  const [text, setText] = useState(value);
  const rgb = value.slice(0, 7);
  const alpha = value.slice(7);
  return (
    <label className="color-field">
      <input
        type="color"
        value={rgb}
        aria-label={t('template.style.colorOf', { name })}
        onChange={(e) => {
          onChange(`${e.target.value}${alpha}`);
          setText(`${e.target.value}${alpha}`);
        }}
      />
      <span>{name}</span>
      <input
        type="text"
        className="mono"
        value={text}
        aria-label={t('template.style.hexOf', { name })}
        onChange={(e) => {
          setText(e.target.value);
          if (HEX.test(e.target.value)) onChange(e.target.value);
        }}
        onBlur={() => setText(value)}
      />
    </label>
  );
}

/** Snap and guide toggles under the editor stage. */
function EditorToolbar() {
  const t = useT();
  const snap = useStore((s) => s.snap);
  const showGuides = useStore((s) => s.showGuides);
  const setSnap = useStore((s) => s.setSnap);
  const setShowGuides = useStore((s) => s.setShowGuides);
  return (
    <div className="row editor-toolbar">
      <label className="toggle">
        <input type="checkbox" checked={snap} onChange={(e) => setSnap(e.target.checked)} />
        {t('template.editor.snap')}
      </label>
      <label className="toggle">
        <input type="checkbox" checked={showGuides} onChange={(e) => setShowGuides(e.target.checked)} />
        {t('template.editor.showGuides')}
      </label>
      <span className="muted small">{t('template.editor.hint')}</span>
    </div>
  );
}

/** Percentages typed as `33, 66.5`; invalid entries are ignored. */
function parsePercentList(text: string): number[] {
  return text
    .split(/[,;\s]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0 && n <= 100);
}

/** A list of line positions edited as text, applied when leaving the field. */
function LineList({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number[];
  onChange(lines: number[]): void;
}) {
  const t = useT();
  const [text, setText] = useState<string | null>(null);
  return (
    <label className="field">
      {label}
      <input
        type="text"
        placeholder={t('template.guides.linesPlaceholder')}
        value={text ?? value.join(', ')}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text !== null) onChange(parsePercentList(text));
          setText(null);
        }}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
    </label>
  );
}

/** Snap lines of the template: divisions, safe margin and extra lines. */
function GuidesSettings() {
  const guides = useStore((s) => s.project.template.guides);
  const setGuides = useStore((s) => s.setGuides);
  const t = useT();
  const count = (text: string, max: number) => Math.min(max, Math.max(0, Math.round(Number(text) || 0)));
  return (
    <>
      <h3>{t('template.guides.title')}</h3>
      <p className="muted small">{t('template.guides.description')}</p>
      <div className="fields">
        <label className="field">
          {t('template.guides.columns')}
          <input
            type="number"
            min={0}
            max={24}
            value={guides.columns}
            onChange={(e) => setGuides({ columns: count(e.target.value, 24) })}
          />
        </label>
        <label className="field">
          {t('template.guides.rows')}
          <input
            type="number"
            min={0}
            max={24}
            value={guides.rows}
            onChange={(e) => setGuides({ rows: count(e.target.value, 24) })}
          />
        </label>
        <label className="field">
          {t('template.guides.margin')}
          <input
            type="number"
            min={0}
            max={49}
            step={0.5}
            value={guides.margin}
            onChange={(e) => setGuides({ margin: Math.min(49, Math.max(0, Number(e.target.value) || 0)) })}
          />
        </label>
      </div>
      <div className="fields">
        <LineList
          label={t('template.guides.vertical')}
          value={guides.vertical}
          onChange={(vertical) => setGuides({ vertical })}
        />
        <LineList
          label={t('template.guides.horizontal')}
          value={guides.horizontal}
          onChange={(horizontal) => setGuides({ horizontal })}
        />
      </div>
      <div className="row wrap">
        <button type="button" className="small" onClick={() => setGuides({ columns: 2, rows: 2 })}>
          {t('template.guides.center')}
        </button>
        <button type="button" className="small" onClick={() => setGuides({ columns: 3, rows: 3 })}>
          {t('template.guides.thirds')}
        </button>
        <button type="button" className="small" onClick={() => setGuides({ margin: 5 })}>
          {t('template.guides.safeArea')}
        </button>
        <button
          type="button"
          className="small"
          onClick={() => setGuides({ columns: 0, rows: 0, margin: 0, vertical: [], horizontal: [] })}
        >
          {t('template.guides.clear')}
        </button>
      </div>
    </>
  );
}

function StylePanel() {
  const project = useStore((s) => s.project);
  const setTemplate = useStore((s) => s.setTemplate);
  const setPalette = useStore((s) => s.setPalette);
  const t = useT();
  const { template } = project;
  return (
    <div className="style-panel">
      <label className="field">
        {t('template.style.templateName')}
        <input
          type="text"
          value={template.name}
          onChange={(e) => setTemplate({ ...template, name: e.target.value })}
        />
      </label>
      {project.templatePath && (
        <p className="muted small path" title={project.templatePath}>
          {t('template.style.linkedFile', { path: project.templatePath })}
        </p>
      )}
      <label className="field">
        {t('template.style.font')}
        <input
          type="text"
          value={template.font}
          onChange={(e) => setTemplate({ ...template, font: e.target.value })}
        />
        <small className="muted">{t('template.style.fontHint')}</small>
      </label>
      <label className="toggle">
        <input
          type="checkbox"
          checked={template.antialias}
          onChange={(e) => setTemplate({ ...template, antialias: e.target.checked })}
        />
        {t('template.style.antialias')}
      </label>
      <h3>{t('template.style.palette')}</h3>
      <p className="muted small">{t('template.style.paletteHint')}</p>
      <div className="palette">
        {PALETTE_KEYS.map((key) => (
          <ColorField
            key={key}
            name={t(`template.palette.${key}`)}
            value={project.palette[key]}
            onChange={(value) => setPalette({ [key]: value })}
          />
        ))}
      </div>
      <GuidesSettings />
    </div>
  );
}

export function TemplateStep() {
  const template = useStore((s) => s.project.template);
  const setTemplate = useStore((s) => s.setTemplate);
  const notify = useStore((s) => s.notify);
  const t = useT();
  const [tab, setTab] = useState<Tab>('widget');
  const selectedId = useStore((s) => s.selectedWidgetId);
  const frameRate = useStore((s) => s.project.output.frameRate);
  const timeline = useTimeline();
  // Selecting a widget (list or video) opens its settings.
  useEffect(() => {
    if (selectedId) setTab('widget');
  }, [selectedId]);
  const step = STEP_DEFINITIONS.template;
  useValuesRefresh();

  const load = async () => {
    try {
      const loaded = await api().openTemplate();
      if (loaded) setTemplate(loaded.template, loaded.path);
    } catch (error) {
      notify('error', t('template.loadFailed', { error: errorMessage(error) }));
    }
  };

  const saveAs = async () => {
    try {
      const path = await api().saveTemplate(template);
      if (path) setTemplate(template, path);
    } catch (error) {
      notify('error', t('template.saveFailed', { error: errorMessage(error) }));
    }
  };

  return (
    <div className="step">
      <StepHeader
        title={coreText.stepTitle(t, step)}
        description={coreText.stepDescription(t, step)}
        actions={
          <>
            <button type="button" onClick={() => void load()}>
              {t('template.load')}
            </button>
            <button type="button" onClick={() => void saveAs()}>
              {t('template.saveAs')}
            </button>
          </>
        }
      />
      <div className="split editor">
        <div className="stack editor-stage">
          <Preview overlay={<OverlayEditor />} />
          <EditorToolbar />
          <section className="panel">
            <div className="panel-title">
              <h3>{t('template.canvas.title')}</h3>
              <span className="muted small">{t('template.canvas.hint')}</span>
            </div>
            <CanvasSettings />
          </section>
          <section className="panel">
            <div className="panel-title">
              <h3>{t('template.visible.title')}</h3>
              <span className="muted small">{t('template.visible.hint')}</span>
            </div>
            <RangeEditor
              range={template.visibleRange}
              min={timeline.start}
              max={timeline.end}
              frameRate={frameRate}
              onChange={(visibleRange) => setTemplate({ ...template, visibleRange })}
            />
          </section>
          <section className="panel">
            <h3>{t('template.widgetsTitle')}</h3>
            <WidgetList />
          </section>
        </div>
        <aside className="panel">
          <div className="tabs compact">
            {TABS.map((id) => (
              <button
                type="button"
                key={id}
                className={tab === id ? 'active' : ''}
                onClick={() => setTab(id)}
              >
                {t(`template.tabs.${id}`)}
              </button>
            ))}
          </div>
          {tab === 'widget' && <WidgetInspector />}
          {tab === 'values' && <ValuesPanel />}
          {tab === 'style' && <StylePanel />}
        </aside>
      </div>
    </div>
  );
}
