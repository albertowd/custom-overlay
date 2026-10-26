import type { Gate, GeoPoint, Track } from '@custom-overlay/core';
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  type WheelEvent,
} from 'react';
import { useT } from '../i18n';

/** Which line a drag or a drawing applies to: the start/finish line or a sector line index. */
export type LineTarget = 'start' | number;

interface TrackMapProps {
  latitude: Float64Array;
  longitude: Float64Array;
  track: Track;
  /** Frame of the playhead, -1 for none. */
  position: number;
  /** Line being drawn: the next two clicks place it. */
  drawing: LineTarget | null;
  onDraw(target: LineTarget, gate: Gate): void;
  onMove(target: LineTarget, gate: Gate): void;
  /** Satellite imagery behind the path (needs internet). */
  satellite: boolean;
}

interface Point {
  x: number;
  y: number;
}

const K = (Math.PI / 180) * 6_371_000;
const HANDLE_RADIUS = 7;
const COLORS = {
  path: '#8b93a1',
  start: '#ffffff',
  sector: '#4cc9f0',
  marker: '#ff5a36',
  outline: '#0f1114',
};

// --- Satellite tiles (Esri World Imagery, Web Mercator) ---------------------------------------

const TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile';
const ATTRIBUTION = 'Powered by Esri · Imagery © Esri, Maxar, Earthstar Geographics';
const MAX_TILE_ZOOM = 19;
const MAX_TILES = 120;
/** Meters per tile pixel at zoom 0 on the equator. */
const TILE_METERS_ZOOM_0 = 156_543.033_92;

interface Tile {
  image: HTMLImageElement;
  state: 'loading' | 'ready' | 'failed';
}

/** Loaded tiles by `z/x/y`, kept for the whole session. */
const tiles = new Map<string, Tile>();
/** Maps to redraw when a tile arrives. */
const tileListeners = new Set<() => void>();
const tileArrived = () => {
  for (const listener of tileListeners) listener();
};

const tileLon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const tileLat = (y: number, z: number) =>
  (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;
const tileX = (lon: number, z: number) => Math.floor(((lon + 180) / 360) * 2 ** z);
const tileY = (lat: number, z: number) => {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z);
};

/** A tile, requested on first use. */
function tile(z: number, x: number, y: number): Tile {
  const key = `${z}/${x}/${y}`;
  const cached = tiles.get(key);
  if (cached) return cached;
  const image = new Image();
  const entry: Tile = { image, state: 'loading' };
  image.onload = () => {
    entry.state = 'ready';
    tileArrived();
  };
  image.onerror = () => {
    entry.state = 'failed';
    tileArrived();
  };
  image.src = `${TILE_URL}/${z}/${y}/${x}`;
  tiles.set(key, entry);
  return entry;
}

/** Local meters around the path center (x east, y down the screen) and back. */
function useProjection(latitude: Float64Array, longitude: Float64Array) {
  return useMemo(() => {
    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLon = Infinity;
    let maxLon = -Infinity;
    for (let i = 0; i < latitude.length; i++) {
      const lat = latitude[i] as number;
      const lon = longitude[i] as number;
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) continue;
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
      minLon = Math.min(minLon, lon);
      maxLon = Math.max(maxLon, lon);
    }
    if (!Number.isFinite(minLat)) return null;
    const lat0 = (minLat + maxLat) / 2;
    const lon0 = (minLon + maxLon) / 2;
    const cos0 = Math.cos((lat0 * Math.PI) / 180);
    const toLocal = (p: GeoPoint): Point => ({
      x: (p.longitude - lon0) * K * cos0,
      y: -(p.latitude - lat0) * K,
    });
    const toGeo = (p: Point): GeoPoint => ({ latitude: lat0 - p.y / K, longitude: lon0 + p.x / (K * cos0) });
    const width = (maxLon - minLon) * K * cos0;
    const height = (maxLat - minLat) * K;
    return { toLocal, toGeo, lat0, width: Math.max(width, 10), height: Math.max(height, 10) };
  }, [latitude, longitude]);
}

export function TrackMap({
  latitude,
  longitude,
  track,
  position,
  drawing,
  onDraw,
  onMove,
  satellite,
}: TrackMapProps) {
  const t = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const projection = useProjection(latitude, longitude);
  const [size, setSize] = useState({ width: 0, height: 0 });
  /** Pixels per meter and the map point (meters) at the canvas center. */
  const [view, setView] = useState({ scale: 1, cx: 0, cy: 0 });
  const [pending, setPending] = useState<Point | null>(null);
  const [hover, setHover] = useState<Point | null>(null);
  /** Bumped when a tile arrives, to redraw. */
  const [, setTilesLoaded] = useState(0);
  const drag = useRef<
    | { kind: 'pan'; from: Point; view: typeof view }
    | { kind: 'end'; target: LineTarget; end: 'a' | 'b' }
    | null
  >(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const redraw = () => setTilesLoaded((n) => n + 1);
    tileListeners.add(redraw);
    return () => {
      tileListeners.delete(redraw);
    };
  }, []);

  // Fit the whole path when the data or the size changes.
  useEffect(() => {
    if (!projection || size.width === 0) return;
    const scale = Math.min(size.width / projection.width, size.height / projection.height) * 0.9;
    setView({ scale, cx: 0, cy: 0 });
  }, [projection, size.width, size.height]);

  // Drawing ends when the mode changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on mode change only
  useEffect(() => setPending(null), [drawing]);

  const toScreen = (p: Point): Point => ({
    x: size.width / 2 + (p.x - view.cx) * view.scale,
    y: size.height / 2 + (p.y - view.cy) * view.scale,
  });
  const toMap = (p: Point): Point => ({
    x: view.cx + (p.x - size.width / 2) / view.scale,
    y: view.cy + (p.y - size.height / 2) / view.scale,
  });

  const lines: { target: LineTarget; gate: Gate; label: string; color: string }[] = [
    ...(track.startFinish
      ? [
          {
            target: 'start' as const,
            gate: track.startFinish,
            label: t('track.map.startFinishShort'),
            color: COLORS.start,
          },
        ]
      : []),
    ...track.sectors.map((gate, j) => ({
      target: j,
      gate,
      label: t('track.map.split', { number: j + 1 }),
      color: COLORS.sector,
    })),
  ];

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !projection) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(size.width * ratio);
    canvas.height = Math.round(size.height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, size.width, size.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    let imageryFailed = false;
    if (satellite) {
      // Zoom with tile pixels at least as fine as screen pixels.
      const metersPerTilePixel = TILE_METERS_ZOOM_0 * Math.cos((projection.lat0 * Math.PI) / 180);
      let z = Math.min(
        MAX_TILE_ZOOM,
        Math.max(1, Math.ceil(Math.log2(metersPerTilePixel * view.scale * ratio))),
      );
      const topLeft = projection.toGeo(toMap({ x: 0, y: 0 }));
      const bottomRight = projection.toGeo(toMap({ x: size.width, y: size.height }));
      const range = (zoom: number) => ({
        x0: tileX(topLeft.longitude, zoom),
        x1: tileX(bottomRight.longitude, zoom),
        y0: tileY(topLeft.latitude, zoom),
        y1: tileY(bottomRight.latitude, zoom),
      });
      let r = range(z);
      while (z > 1 && (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1) > MAX_TILES) r = range(--z);
      const drawTile = (zoom: number, x: number, y: number, image: HTMLImageElement) => {
        const nw = toScreen(projection.toLocal({ latitude: tileLat(y, zoom), longitude: tileLon(x, zoom) }));
        const se = toScreen(
          projection.toLocal({ latitude: tileLat(y + 1, zoom), longitude: tileLon(x + 1, zoom) }),
        );
        // Half a pixel of overlap hides seams between tiles.
        ctx.drawImage(image, nw.x - 0.5, nw.y - 0.5, se.x - nw.x + 1, se.y - nw.y + 1);
      };
      let ready = 0;
      for (let x = r.x0; x <= r.x1; x++) {
        for (let y = r.y0; y <= r.y1; y++) {
          const wanted = tile(z, x, y);
          if (wanted.state === 'ready') {
            drawTile(z, x, y, wanted.image);
            ready++;
            continue;
          }
          if (wanted.state === 'failed') imageryFailed = true;
          // Meanwhile, the closest coarser tile already loaded.
          for (let up = 1; up <= 4 && z - up >= 0; up++) {
            const px = x >> up;
            const py = y >> up;
            const parent = tiles.get(`${z - up}/${px}/${py}`);
            if (parent?.state === 'ready') {
              drawTile(z - up, px, py, parent.image);
              break;
            }
          }
        }
      }
      if (ready > 0) imageryFailed = false;
      // Darken the imagery so the path and the lines stand out.
      ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
      ctx.fillRect(0, 0, size.width, size.height);
    }

    // Path, one point per pixel at most.
    ctx.beginPath();
    let pen = false;
    let last: Point | null = null;
    for (let i = 0; i < latitude.length; i++) {
      const lat = latitude[i] as number;
      const lon = longitude[i] as number;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        pen = false;
        continue;
      }
      const p = toScreen(projection.toLocal({ latitude: lat, longitude: lon }));
      if (pen && last && Math.abs(p.x - last.x) < 1 && Math.abs(p.y - last.y) < 1) continue;
      if (pen) ctx.lineTo(p.x, p.y);
      else ctx.moveTo(p.x, p.y);
      pen = true;
      last = p;
    }
    if (satellite) {
      // Soft outline: laps side by side must not turn into stripes.
      ctx.strokeStyle = 'rgba(15, 17, 20, 0.45)';
      ctx.lineWidth = 3.5;
      ctx.stroke();
    }
    ctx.strokeStyle = satellite ? 'rgba(230, 232, 235, 0.9)' : COLORS.path;
    ctx.lineWidth = satellite ? 1.5 : 2;
    ctx.stroke();

    const segment = (a: Point, b: Point, color: string, width: number, dashed = false) => {
      ctx.setLineDash(dashed ? [6, 5] : []);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = COLORS.outline;
      ctx.lineWidth = width + 3;
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.stroke();
      ctx.setLineDash([]);
    };
    const handle = (p: Point, color: string) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, HANDLE_RADIUS - 2, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = COLORS.outline;
      ctx.lineWidth = 2;
      ctx.stroke();
    };

    ctx.font = '600 12px Inter, "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';
    for (const line of lines) {
      const a = toScreen(projection.toLocal(line.gate.a));
      const b = toScreen(projection.toLocal(line.gate.b));
      segment(a, b, line.color, 4);
      handle(a, line.color);
      handle(b, line.color);
      ctx.fillStyle = line.color;
      ctx.textAlign = b.x >= a.x ? 'left' : 'right';
      ctx.fillText(line.label, b.x + (b.x >= a.x ? 10 : -10), b.y);
    }

    if (pending && hover && drawing !== null) {
      segment(
        toScreen(pending),
        toScreen(hover),
        drawing === 'start' ? COLORS.start : COLORS.sector,
        3,
        true,
      );
    }

    const lat = latitude[position];
    const lon = longitude[position];
    if (
      position >= 0 &&
      lat !== undefined &&
      lon !== undefined &&
      Number.isFinite(lat) &&
      Number.isFinite(lon)
    ) {
      const p = toScreen(projection.toLocal({ latitude: lat, longitude: lon }));
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.marker;
      ctx.fill();
      ctx.strokeStyle = COLORS.outline;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    if (satellite) {
      const text = imageryFailed ? t('track.map.imageryUnavailable') : ATTRIBUTION;
      ctx.font = '11px Inter, "Segoe UI", sans-serif';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      const width = ctx.measureText(text).width;
      ctx.fillStyle = 'rgba(15, 17, 20, 0.7)';
      ctx.fillRect(size.width - width - 12, size.height - 20, width + 12, 20);
      ctx.fillStyle = imageryFailed ? '#f5b84b' : '#c7ccd4';
      ctx.fillText(text, size.width - 6, size.height - 5);
    }
  });

  if (!projection) return <p className="muted">{t('track.map.noGps')}</p>;

  const pointer = (e: ReactPointerEvent | WheelEvent): Point => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const hitHandle = (screen: Point): { target: LineTarget; end: 'a' | 'b' } | null => {
    for (const line of [...lines].reverse()) {
      for (const end of ['a', 'b'] as const) {
        const p = toScreen(projection.toLocal(line.gate[end]));
        if (Math.hypot(p.x - screen.x, p.y - screen.y) <= HANDLE_RADIUS + 2)
          return { target: line.target, end };
      }
    }
    return null;
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const screen = pointer(e);
    if (drawing !== null) {
      const point = toMap(screen);
      if (!pending) {
        setPending(point);
      } else {
        onDraw(drawing, { a: projection.toGeo(pending), b: projection.toGeo(point) });
        setPending(null);
      }
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    const hit = hitHandle(screen);
    drag.current = hit ? { kind: 'end', ...hit } : { kind: 'pan', from: screen, view };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const screen = pointer(e);
    if (drawing !== null) setHover(toMap(screen));
    const current = drag.current;
    if (!current) {
      e.currentTarget.style.cursor = drawing !== null ? 'crosshair' : hitHandle(screen) ? 'move' : 'grab';
      return;
    }
    if (current.kind === 'pan') {
      setView({
        ...current.view,
        cx: current.view.cx - (screen.x - current.from.x) / view.scale,
        cy: current.view.cy - (screen.y - current.from.y) / view.scale,
      });
      return;
    }
    const line = lines.find((l) => l.target === current.target);
    if (line) onMove(current.target, { ...line.gate, [current.end]: projection.toGeo(toMap(screen)) });
  };

  const onPointerUp = () => {
    drag.current = null;
  };

  const onWheel = (e: WheelEvent<HTMLCanvasElement>) => {
    const screen = pointer(e);
    const before = toMap(screen);
    const scale = Math.min(Math.max(view.scale * (e.deltaY < 0 ? 1.25 : 0.8), 0.01), 200);
    // Keep the point under the cursor in place.
    setView({
      scale,
      cx: before.x - (screen.x - size.width / 2) / scale,
      cy: before.y - (screen.y - size.height / 2) / scale,
    });
  };

  return (
    <div ref={containerRef} className="track-map">
      <canvas
        ref={canvasRef}
        style={{ width: size.width, height: size.height }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHover(null)}
        onWheel={onWheel}
      />
    </div>
  );
}
