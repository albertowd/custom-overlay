import {
  CANVAS_FORMATS,
  canvasFormatOf,
  canvasSizeFor,
  type VideoFit,
  type VideoFitMode,
  type VideoRotation,
} from '@custom-overlay/core';
import { useT } from '../i18n';
import { useStore } from '../store';

const FIT_MODES = ['contain', 'cover', 'blur', 'stretch'] as const satisfies readonly VideoFitMode[];

const ROTATIONS = [0, 90, 270, 180] as const satisfies readonly VideoRotation[];

/** Size of the first enabled video, if loaded. */
function useFirstVideoSize(): { width: number; height: number } | undefined {
  const info = useStore((s) => {
    const first = s.project.videos.find((v) => v.enabled);
    return first ? s.videos[first.id] : undefined;
  });
  return info ? { width: info.width, height: info.height } : undefined;
}

function sameSize(a?: { width: number; height: number }, b?: { width: number; height: number }) {
  return a?.width === b?.width && a?.height === b?.height;
}

/** A 0–100 % slider of a fraction. */
function PercentSlider({
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
      <span>
        {label} <span className="muted">{Math.round(value * 100)}%</span>
      </span>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={Math.round(value * 100)}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
      />
    </label>
  );
}

/** How the videos are placed on the canvas: fit mode, rotation (before fitting), zoom and alignment. */
export function VideoFitFields() {
  const t = useT();
  const fit = useStore((s) => s.project.output.fit);
  const setOutput = useStore((s) => s.setOutput);
  const set = (patch: Partial<VideoFit>) => setOutput({ fit: { ...fit, ...patch } });
  return (
    <>
      <div className="fields">
        <label className="field">
          {t('template.canvas.fit')}
          <select
            value={fit.mode}
            onChange={(e) => {
              const mode = FIT_MODES.find((m) => m === e.target.value);
              if (mode) set({ mode });
            }}
          >
            {FIT_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {t(`template.canvas.fitModes.${mode}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {t('template.canvas.rotation')}
          <select
            value={fit.rotation}
            onChange={(e) => {
              const rotation = ROTATIONS.find((r) => String(r) === e.target.value);
              if (rotation !== undefined) set({ rotation });
            }}
          >
            {ROTATIONS.map((rotation) => (
              <option key={rotation} value={rotation}>
                {t(`template.canvas.rotations.${rotation}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {t('template.canvas.zoom')}
          <input
            type="number"
            min={1}
            max={4}
            step={0.05}
            value={fit.zoom}
            onChange={(e) => {
              const zoom = Number(e.target.value);
              if (Number.isFinite(zoom) && zoom >= 1 && zoom <= 4) set({ zoom });
            }}
          />
        </label>
      </div>
      <div className="fields">
        <PercentSlider label={t('template.canvas.horizontal')} value={fit.x} onChange={(x) => set({ x })} />
        <PercentSlider label={t('template.canvas.vertical')} value={fit.y} onChange={(y) => set({ y })} />
      </div>
      {fit.rotation !== 0 && (
        <label className="toggle">
          <input
            type="checkbox"
            checked={fit.rotateWidgets}
            onChange={(e) => set({ rotateWidgets: e.target.checked })}
          />
          {t('template.canvas.rotateWidgets')}
        </label>
      )}
      <p className="muted small">
        {t(`template.canvas.fitHelp.${fit.mode}`)}
        {fit.rotation !== 0 && ` ${t('template.canvas.rotationHelp')}`}
        {fit.rotation !== 0 &&
          ` ${t(fit.rotateWidgets ? 'template.canvas.rotateWidgetsOn' : 'template.canvas.rotateWidgetsOff')}`}
      </p>
    </>
  );
}

/**
 * The output canvas widgets are placed on: its shape (16:9, 9:16 for TikTok / Reels...), size,
 * and how the videos fit in it. The export uses the same canvas.
 */
export function CanvasSettings() {
  const t = useT();
  const output = useStore((s) => s.project.output);
  const setOutput = useStore((s) => s.setOutput);
  const video = useFirstVideoSize();
  const current = canvasFormatOf(output);
  const matchesVideo = video !== undefined && sameSize(video, output);
  const value = current?.id ?? (matchesVideo ? 'video' : 'custom');
  const size = (n: string) => Math.round(Number(n));
  return (
    <div className="canvas-settings">
      <div className="fields">
        <label className="field">
          {t('template.canvas.format')}
          <select
            value={value}
            onChange={(e) => {
              if (e.target.value === 'video' && video) return setOutput(video);
              const format = CANVAS_FORMATS.find((f) => f.id === e.target.value);
              if (format) setOutput(canvasSizeFor(format, output));
            }}
          >
            {CANVAS_FORMATS.map((format) => (
              <option key={format.id} value={format.id}>
                {t(`template.canvas.formats.${format.id}`)}
              </option>
            ))}
            {video && (
              <option value="video">
                {t('template.canvas.matchVideo', {
                  width: String(video.width),
                  height: String(video.height),
                })}
              </option>
            )}
            {value === 'custom' && (
              <option value="custom">
                {t('template.canvas.custom', { width: String(output.width), height: String(output.height) })}
              </option>
            )}
          </select>
        </label>
        <label className="field">
          {t('template.canvas.width')}
          <input
            type="number"
            min={16}
            step={2}
            value={output.width}
            onChange={(e) => size(e.target.value) >= 16 && setOutput({ width: size(e.target.value) })}
          />
        </label>
        <label className="field">
          {t('template.canvas.height')}
          <input
            type="number"
            min={16}
            step={2}
            value={output.height}
            onChange={(e) => size(e.target.value) >= 16 && setOutput({ height: size(e.target.value) })}
          />
        </label>
      </div>
      {video ? <VideoFitFields /> : <p className="muted small">{t('template.canvas.noVideo')}</p>}
    </div>
  );
}
