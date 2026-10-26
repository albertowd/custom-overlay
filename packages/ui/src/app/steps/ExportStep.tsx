import {
  type ColorSettings,
  defaultExportRange,
  defaultOutputPath,
  ENCODE_PRESETS,
  type EncoderSettings,
  estimateExportBytes,
  outputFromVideo,
  presetNotes,
  type Scaling,
  SOCIAL_FAMILIES,
  STEP_DEFINITIONS,
  YOUTUBE_FAMILIES,
} from '@custom-overlay/core';
import type { ReactNode } from 'react';
import type { Translate } from '../../shared/i18n';
import { api } from '../api';
import { VideoFitFields } from '../components/CanvasSettings';
import { StepHeader } from '../components/common';
import { ExportRunner } from '../components/ExportRunner';
import { OverlayCanvas } from '../components/OverlayEditor';
import { Preview } from '../components/Preview';
import { RangeEditor } from '../components/RangeEditor';
import { formatBytes, formatTime } from '../format';
import { coreText, useT } from '../i18n';
import { errorMessage, useStore, useTimeline, useValuesRefresh, useWorkflow } from '../store';

function NumberField({
  label,
  value,
  onChange,
  min = 0,
  step = 1,
  placeholder,
}: {
  label: string;
  value: number | null;
  onChange(value: number | null): void;
  min?: number;
  step?: number;
  placeholder?: string;
}) {
  return (
    <label className="field">
      {label}
      <input
        type="number"
        value={value ?? ''}
        min={min}
        step={step}
        placeholder={placeholder}
        onChange={(e) => {
          if (e.target.value === '') return onChange(null);
          const n = Number(e.target.value);
          if (Number.isFinite(n) && n >= min) onChange(n);
        }}
      />
    </label>
  );
}

function SelectField<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange(value: T): void;
}) {
  return (
    <label className="field">
      {label}
      <select
        value={String(value)}
        onChange={(e) => {
          const option = options.find(([v]) => String(v) === e.target.value);
          if (option) onChange(option[0]);
        }}
      >
        {options.map(([v, text]) => (
          <option key={String(v)} value={String(v)}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Encode presets grouped by YouTube codec family, then by social format, then the other presets
 * and "Custom".
 */
function PresetField({ value, onChange }: { value: string; onChange(id: string): void }) {
  const t = useT();
  const others = ENCODE_PRESETS.filter((p) => !p.youtube && !p.social);
  return (
    <label className="field">
      {t('export.encoding.preset')}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {YOUTUBE_FAMILIES.map((family) => (
          <optgroup key={family.id} label={coreText.presetFamily(t, family)}>
            {ENCODE_PRESETS.filter((p) => p.youtube?.family.id === family.id).map((p) => (
              <option key={p.id} value={p.id}>
                {coreText.presetOption(t, p)}
              </option>
            ))}
          </optgroup>
        ))}
        {SOCIAL_FAMILIES.map((family) => (
          <optgroup key={family.id} label={coreText.presetFamily(t, family)}>
            {ENCODE_PRESETS.filter((p) => p.social?.family.id === family.id).map((p) => (
              <option key={p.id} value={p.id}>
                {coreText.presetOption(t, p)}
              </option>
            ))}
          </optgroup>
        ))}
        <optgroup label={t('export.encoding.otherPresets')}>
          {others.map((p) => (
            <option key={p.id} value={p.id}>
              {coreText.presetOption(t, p)}
            </option>
          ))}
          <option value="custom">{t('export.encoding.custom')}</option>
        </optgroup>
      </select>
    </label>
  );
}

const COLOR_SPACES = [
  ['rec709', 'Rec.709 (SDR)'],
  ['rec2020', 'Rec.2020 (SDR)'],
  ['rec2020-hlg', 'Rec.2020 HLG (HDR)'],
  ['rec2020-pq', 'Rec.2020 PQ (HDR)'],
] as const satisfies readonly (readonly [ColorSettings['space'], string])[];

const RESOLUTIONS = [
  ['1280x720', '720p'],
  ['1920x1080', '1080p'],
  ['2560x1440', '1440p'],
  ['2704x1520', '2.7K (GoPro)'],
  ['3840x2160', '4K UHD'],
  ['1080x1920', '1080 × 1920 (9:16)'],
  ['1080x1350', '1080 × 1350 (4:5)'],
  ['1080x1080', '1080 × 1080 (1:1)'],
] as const;

const SCALERS = ['bilinear', 'bicubic', 'lanczos', 'fsr1'] as const satisfies readonly Scaling[];

const CODECS = [
  ['h264', 'H.264 / AVC'],
  ['hevc', 'H.265 / HEVC'],
  ['av1', 'AV1'],
] as const satisfies readonly (readonly [EncoderSettings['codec'], string])[];

const ACCELERATION = ['auto', 'software'] as const satisfies readonly EncoderSettings['acceleration'][];

const AUDIO = ['aac', 'copy', 'none'] as const satisfies readonly EncoderSettings['audio'][];

/** Options labelled by the messages `<prefix>.<value>`. */
function translated<T extends string>(t: Translate, prefix: string, values: readonly T[]) {
  return values.map((v) => [v, t(`${prefix}.${v}`)] as const);
}

function Section({ title, children, wide = false }: { title: string; children: ReactNode; wide?: boolean }) {
  return (
    <section className={`panel ${wide ? 'wide' : ''}`}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

export function ExportStep() {
  const t = useT();
  const project = useStore((s) => s.project);
  const firstVideo = useStore((s) => {
    const first = s.project.videos.find((v) => v.enabled);
    return first ? s.videos[first.id] : undefined;
  });
  const setExport = useStore((s) => s.setExport);
  const setOutput = useStore((s) => s.setOutput);
  const setEncoder = useStore((s) => s.setEncoder);
  const notify = useStore((s) => s.notify);
  const dataRange = useStore((s) => s.values?.dataRange ?? null);
  const timeline = useTimeline();
  const workflow = useWorkflow();
  const step = STEP_DEFINITIONS.export;
  // The preview draws the widgets with the project values.
  useValuesRefresh();
  const { output } = project;
  const settings = project.export;
  const { encoder } = settings;
  const hasVideo = project.videos.some((v) => v.enabled);
  const exportIssues = workflow.find((s) => s.id === 'export')?.issues ?? [];
  const preset = ENCODE_PRESETS.find((p) => p.id === encoder.preset);
  const notes = presetNotes(encoder.preset, output);
  // Open range bounds follow the data range of the Track step.
  const defaults = defaultExportRange(timeline, dataRange);
  const followsData = defaults.start !== timeline.start || defaults.end !== timeline.end;
  const rangeStart = settings.range.start ?? defaults.start;
  const duration = Math.max(0, (settings.range.end ?? defaults.end) - rangeStart);
  const resolution = `${output.width}x${output.height}`;
  // Without a choice the export goes next to the videos (or the data).
  const defaultOutput = defaultOutputPath(project);
  const { videoExport, sequenceAsZip } = api().capabilities;
  // A video export made elsewhere (web app) chooses its output there.
  const choosesOutput = videoExport || settings.mode === 'image-sequence';

  const chooseOutput = async () => {
    try {
      const path = await api().selectOutput(settings.mode, settings.outputPath ?? defaultOutput);
      if (path) setExport({ outputPath: path });
    } catch (error) {
      notify('error', errorMessage(error));
    }
  };

  return (
    <div className="step">
      <StepHeader title={coreText.stepTitle(t, step)} description={coreText.stepDescription(t, step)} />
      <div className="grid">
        <Section title={t('export.range.title')} wide>
          <p className="muted small">{t('export.range.help')}</p>
          {followsData && (
            <p className="muted small">
              {t('export.range.followsData', {
                start: formatTime(defaults.start),
                end: formatTime(defaults.end),
              })}
            </p>
          )}
          <div className="export-range">
            <Preview overlay={<OverlayCanvas editing={false} final />} />
            <RangeEditor
              range={settings.range}
              min={timeline.start}
              max={timeline.end}
              frameRate={output.frameRate}
              defaults={{
                ...defaults,
                label: t('export.range.dataRange'),
                emptyHint: t('export.range.followsDataField'),
              }}
              onChange={(range) => setExport({ range })}
            />
          </div>
        </Section>

        <Section title={t('export.output.title')}>
          <div className="radio-group">
            <label className={hasVideo ? '' : 'disabled'}>
              <input
                type="radio"
                name="mode"
                checked={settings.mode === 'video'}
                disabled={!hasVideo}
                onChange={() => setExport({ mode: 'video', outputPath: null })}
              />
              <strong>{t('export.output.video')}</strong>
              <span className="muted small">{t('export.output.videoHelp')}</span>
            </label>
            <label>
              <input
                type="radio"
                name="mode"
                checked={settings.mode === 'image-sequence'}
                onChange={() => setExport({ mode: 'image-sequence', outputPath: null })}
              />
              <strong>{t('export.output.sequence')}</strong>
              <span className="muted small">{t('export.output.sequenceHelp')}</span>
            </label>
          </div>
          {choosesOutput && (
            <div className="row">
              <input
                type="text"
                readOnly
                value={settings.outputPath ?? defaultOutput ?? ''}
                placeholder={t('export.output.none')}
                title={settings.outputPath ?? defaultOutput ?? undefined}
              />
              <button type="button" onClick={() => void chooseOutput()}>
                {t('export.output.choose')}
              </button>
            </div>
          )}
          {choosesOutput && !settings.outputPath && defaultOutput && (
            <p className="muted small">{t('export.output.defaultHint')}</p>
          )}
          {choosesOutput && settings.outputPath && defaultOutput && (
            <button type="button" className="link" onClick={() => setExport({ outputPath: null })}>
              {t('export.output.useDefault')}
            </button>
          )}
          {sequenceAsZip && settings.mode === 'image-sequence' && (
            <p className="muted small">{t('export.output.zipHint')}</p>
          )}
        </Section>

        <Section title={t('export.format.title')}>
          <div className="fields">
            <SelectField
              label={t('export.format.resolution')}
              value={RESOLUTIONS.some(([r]) => r === resolution) ? resolution : 'custom'}
              options={[
                ...RESOLUTIONS,
                [
                  'custom',
                  t('export.format.customResolution', {
                    width: String(output.width),
                    height: String(output.height),
                  }),
                ],
              ]}
              onChange={(value) => {
                const [width, height] = value.split('x').map(Number);
                if (width && height) setOutput({ width, height });
              }}
            />
            <NumberField
              label={t('export.format.width')}
              value={output.width}
              min={16}
              onChange={(width) => width && setOutput({ width })}
            />
            <NumberField
              label={t('export.format.height')}
              value={output.height}
              min={16}
              onChange={(height) => height && setOutput({ height })}
            />
            <NumberField
              label={t('export.format.frameRate')}
              value={output.frameRate}
              min={1}
              step={0.001}
              onChange={(frameRate) => frameRate && setOutput({ frameRate })}
            />
            <SelectField
              label={t('export.format.colorSpace')}
              value={output.color.space}
              options={COLOR_SPACES}
              onChange={(space) => setOutput({ color: { ...output.color, space } })}
            />
            <SelectField
              label={t('export.format.rangeDepth')}
              value={`${output.color.range}-${output.color.bitDepth}`}
              options={[
                ['limited-8', t('export.format.limited', { bits: 8 })],
                ['limited-10', t('export.format.limited', { bits: 10 })],
                ['full-8', t('export.format.full', { bits: 8 })],
                ['full-10', t('export.format.full', { bits: 10 })],
              ]}
              onChange={(value) => {
                const [range, depth] = value.split('-');
                setOutput({
                  color: {
                    ...output.color,
                    range: range === 'full' ? 'full' : 'limited',
                    bitDepth: depth === '10' ? 10 : 8,
                  },
                });
              }}
            />
          </div>
          {firstVideo && (
            <button type="button" className="link" onClick={() => setOutput(outputFromVideo(firstVideo))}>
              {t('export.format.matchVideo')}
            </button>
          )}
          <p className="muted small">{t('export.format.canvasHelp')}</p>
          {hasVideo && <VideoFitFields />}
        </Section>

        {settings.mode === 'video' && (
          <Section title={t('export.encoding.title')}>
            <div className="fields">
              <PresetField value={encoder.preset} onChange={(id) => setEncoder({ preset: id })} />
              <SelectField
                label={t('export.encoding.codec')}
                value={encoder.codec}
                options={CODECS}
                onChange={(codec) => setEncoder({ codec })}
              />
              <NumberField
                label={t('export.encoding.bitrate')}
                value={encoder.bitrateMbps}
                min={0.1}
                step={0.5}
                onChange={(bitrateMbps) => bitrateMbps && setEncoder({ bitrateMbps })}
              />
              <NumberField
                label={t('export.encoding.keyframe')}
                value={encoder.keyframeIntervalSeconds}
                min={0.05}
                step={0.05}
                onChange={(keyframeIntervalSeconds) =>
                  keyframeIntervalSeconds && setEncoder({ keyframeIntervalSeconds })
                }
              />
              <NumberField
                label={t('export.encoding.bFrames')}
                value={encoder.bFrames}
                onChange={(bFrames) => bFrames !== null && setEncoder({ bFrames: Math.round(bFrames) })}
              />
              <SelectField
                label={t('export.encoding.audio')}
                value={encoder.audio}
                options={translated(t, 'export.encoding.audioOptions', AUDIO)}
                onChange={(audio) => setEncoder({ audio })}
              />
              <SelectField
                label={t('export.encoding.acceleration')}
                value={encoder.acceleration}
                options={translated(t, 'export.encoding.accelerationOptions', ACCELERATION)}
                onChange={(acceleration) => setEncoder({ acceleration })}
              />
            </div>
            <p className="muted small">
              {preset ? coreText.presetDescription(t, preset) : t('export.encoding.customHelp')}
            </p>
            {notes.map((note) => (
              <p key={note} className="warning small">
                {t(`export.encoding.notes.${note}`)}
              </p>
            ))}
            <p className="small">
              {t('export.encoding.estimatedSize', {
                size: formatBytes(estimateExportBytes(encoder, duration)),
                duration: formatTime(duration, false),
              })}
            </p>
            <p className="muted small">{t('export.encoding.estimatedSizeHelp')}</p>
            <SelectField
              label={t('export.encoding.scaling')}
              value={settings.scaling}
              options={translated(t, 'export.encoding.scalers', SCALERS)}
              onChange={(scaling) => setExport({ scaling })}
            />
            <p className="muted small">{t('export.encoding.scalingHelp')}</p>
          </Section>
        )}

        <Section title={t('export.run.title')} wide>
          <ExportRunner issues={exportIssues} />
        </Section>
      </div>
    </div>
  );
}
