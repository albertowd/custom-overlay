import {
  BLUR_DOWNSCALE,
  backgroundPlacement,
  type Size,
  unrotatedBox,
  type VideoRotation,
  videoAt,
  videoPlacement,
  widgetRotation,
} from '@custom-overlay/core';
import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { formatTime } from '../format';
import { useT } from '../i18n';
import { useMedia, useStore, useTimeline } from '../store';

interface PreviewProps {
  /** Content drawn over the video, in a layer with the output aspect ratio. */
  overlay?: ReactNode;
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/**
 * The blurred background of the `blur` fit: the video covering the canvas, drawn small every
 * frame (cheap, and blurred again when stretched), like the export does it.
 */
function BlurredBackdrop({
  videoRef,
  source,
  canvas,
  rotation,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  source: Size;
  canvas: Size;
  rotation: VideoRotation;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { width: sourceWidth, height: sourceHeight } = source;
  const { width, height } = canvas;
  useEffect(() => {
    const el = ref.current;
    const ctx = el?.getContext('2d');
    if (!el || !ctx) return;
    // About the export's background size, at most 240 px.
    const scale = Math.min(1 / BLUR_DOWNSCALE, 240 / Math.max(width, height));
    el.width = Math.max(2, Math.round(width * scale));
    el.height = Math.max(2, Math.round(height * scale));
    const placed = backgroundPlacement(
      { width: sourceWidth, height: sourceHeight },
      { width: el.width, height: el.height },
      rotation,
    );
    const box = unrotatedBox(placed, rotation);
    let handle = 0;
    const draw = () => {
      const video = videoRef.current;
      if (video && video.readyState >= 2) {
        // Turned around the centre of the placement, like the video element.
        ctx.save();
        ctx.translate(box.x + box.width / 2, box.y + box.height / 2);
        ctx.rotate((rotation * Math.PI) / 180);
        ctx.drawImage(video, -box.width / 2, -box.height / 2, box.width, box.height);
        ctx.restore();
      }
      handle = requestAnimationFrame(draw);
    };
    handle = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(handle);
  }, [videoRef, sourceWidth, sourceHeight, width, height, rotation]);
  return <canvas ref={ref} className="stage-backdrop" />;
}

/** Video covering the playhead, from the current store state. */
function activeVideoNow() {
  const { project, videos, series, currentTime } = useStore.getState();
  return videoAt(project, { videos, series }, currentTime);
}

/**
 * Timeline player: shows whichever video covers the playhead (or a transparent stage) with
 * transport controls. The store `currentTime` follows playback; `seek()` requests move it.
 */
export function Preview({ overlay }: PreviewProps) {
  const project = useStore((s) => s.project);
  const mediaUrls = useStore((s) => s.mediaUrls);
  const currentTime = useStore((s) => s.currentTime);
  const seekRequest = useStore((s) => s.seekRequest);
  const setTime = useStore((s) => s.setTime);
  const seek = useStore((s) => s.seek);
  const media = useMedia();
  const timeline = useTimeline();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [decodeError, setDecodeError] = useState(false);
  const [videoSize, setVideoSize] = useState<Size | null>(null);
  const t = useT();
  const { start, end } = timeline;
  const frame = 1 / (timeline.frameRate || 30);

  const active = videoAt(project, media, currentTime);
  const activeId = active?.video.id ?? null;
  const activeUrl = activeId ? mediaUrls[activeId] : undefined;

  // Another video may have another size: known again once it loads.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the video changes
  useEffect(() => setVideoSize(null), [activeUrl]);

  /** Move the video element to the playhead. */
  const syncElement = useCallback((tolerance: number) => {
    const el = videoRef.current;
    const now = activeVideoNow();
    if (el && now && Math.abs(el.currentTime - now.videoTime) > tolerance) el.currentTime = now.videoTime;
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on every seek request
  useEffect(() => syncElement(1e-3), [seekRequest, syncElement]);

  // Playback clock: the active video when there is one, the wall clock in gaps and without video.
  useEffect(() => {
    const el = videoRef.current;
    if (!playing) {
      el?.pause();
      return;
    }
    let handle = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const at = activeVideoNow();
      const video = videoRef.current;
      let next = useStore.getState().currentTime + dt;
      if (at && video && video.readyState >= 2) {
        if (video.paused) void video.play().catch(() => undefined);
        else next = video.currentTime + at.video.offsetSeconds;
      }
      if (next >= end) {
        setTime(end);
        setPlaying(false);
        return;
      }
      setTime(next);
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [playing, end, setTime]);

  const toggle = useCallback(() => {
    if (!playing && useStore.getState().currentTime >= end) seek(start);
    setPlaying((p) => !p);
  }, [playing, start, end, seek]);

  const step = useCallback(
    (frames: number) => {
      setPlaying(false);
      const t = useStore.getState().currentTime + frames * frame;
      seek(Math.min(Math.max(start, t), end));
    },
    [frame, start, end, seek],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event.target)) return;
      if (event.code === 'Space') {
        event.preventDefault();
        toggle();
      } else if (event.key === 'ArrowLeft') {
        step(event.shiftKey ? -10 : -1);
      } else if (event.key === 'ArrowRight') {
        step(event.shiftKey ? 10 : 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle, step]);

  const canvas = { width: timeline.width || 16, height: timeline.height || 9 };
  const hasVideos = project.videos.some((v) => v.enabled);
  const { fit } = project.output;
  // The size the element decodes (rotation applied), the probed one until it is known.
  const source = videoSize ?? (active ? { width: active.info.width, height: active.info.height } : null);
  // The element keeps the video's shape and is turned around its centre to cover the placement.
  const box = source ? unrotatedBox(videoPlacement(source, canvas, fit), fit.rotation) : null;
  const percent = (value: number, of: number) => `${(value / of) * 100}%`;
  // Widgets turning with the video are drawn (and edited) on the canvas turned back, turned.
  const turn = widgetRotation(project.output);
  const layer = unrotatedBox({ x: 0, y: 0, ...canvas }, turn);
  const layerStyle: CSSProperties | undefined = turn
    ? {
        left: percent(layer.x, canvas.width),
        top: percent(layer.y, canvas.height),
        width: percent(layer.width, canvas.width),
        height: percent(layer.height, canvas.height),
        transform: `rotate(${turn}deg)`,
      }
    : undefined;
  const stageStyle = {
    aspectRatio: `${canvas.width} / ${canvas.height}`,
    '--stage-aspect': canvas.width / canvas.height,
  } as CSSProperties;

  return (
    <div className="preview">
      <div className="stage-frame">
        <div className={`stage ${activeUrl ? '' : 'transparent'}`} style={stageStyle}>
          {activeUrl && (
            <div className="stage-video">
              {fit.mode === 'blur' && source && (
                <BlurredBackdrop
                  videoRef={videoRef}
                  source={source}
                  canvas={canvas}
                  rotation={fit.rotation}
                />
              )}
              <video
                ref={videoRef}
                src={activeUrl}
                preload="auto"
                muted
                style={
                  box
                    ? {
                        left: percent(box.x, canvas.width),
                        top: percent(box.y, canvas.height),
                        width: percent(box.width, canvas.width),
                        height: percent(box.height, canvas.height),
                        transform: fit.rotation ? `rotate(${fit.rotation}deg)` : undefined,
                      }
                    : undefined
                }
                onLoadedMetadata={() => {
                  setDecodeError(false);
                  const el = videoRef.current;
                  if (el?.videoWidth && el.videoHeight) {
                    setVideoSize({ width: el.videoWidth, height: el.videoHeight });
                  }
                  syncElement(1e-3);
                  if (playing) void el?.play().catch(() => undefined);
                }}
                onError={() => setDecodeError(true)}
              />
            </div>
          )}
          {!activeUrl && (
            <div className="stage-label">
              {hasVideos ? t('template.preview.noVideoNow') : t('template.preview.noVideo')}
            </div>
          )}
          {decodeError && <div className="stage-error">{t('template.preview.decodeError')}</div>}
          <div className="overlay-layer" style={layerStyle}>
            {overlay}
          </div>
        </div>
      </div>
      <div className="transport">
        <button
          type="button"
          className="icon"
          onClick={() => step(-1)}
          title={t('template.preview.previousFrame')}
        >
          ⏮
        </button>
        <button
          type="button"
          className="icon primary"
          onClick={toggle}
          title={t('template.preview.playPause')}
        >
          {playing ? '⏸' : '▶'}
        </button>
        <button
          type="button"
          className="icon"
          onClick={() => step(1)}
          title={t('template.preview.nextFrame')}
        >
          ⏭
        </button>
        <span className="timecode">{formatTime(currentTime)}</span>
        <input
          type="range"
          className="scrubber"
          min={start}
          max={end}
          step={frame}
          value={Math.min(Math.max(currentTime, start), end)}
          onChange={(e) => seek(Number(e.target.value))}
          disabled={end <= start}
        />
        <span className="timecode muted">{formatTime(end)}</span>
        {active && <span className="muted small active-video">{active.video.label}</span>}
      </div>
    </div>
  );
}
