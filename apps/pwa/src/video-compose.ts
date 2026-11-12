import {
  BLUR_DOWNSCALE,
  backgroundPlacement,
  type ExportSegment,
  isSideways,
  type Size,
  unrotatedBox,
  type VideoFit,
  type VideoRotation,
  videoPlacement,
} from '@custom-overlay/core';

/**
 * Frame composition of the browser's video export, matching the desktop export (ffmpeg): pieces
 * of videos and gaps one after the other, each video placed on the canvas by the fit settings.
 */

/** The output frames of one piece of the export, and the video times they show. */
export interface PieceFrames {
  segment: ExportSegment;
  /** First output frame of the piece. */
  first: number;
  /** Frames in the piece. */
  count: number;
  /** Video time of each frame (videos only; empty for a gap). */
  times: number[];
}

/**
 * Which pieces the frames come from. Frame n is the timeline instant n / rate after the start; it
 * belongs to the piece covering that instant and shows the video frame on screen at that time.
 */
export function pieceFrames(
  segments: readonly ExportSegment[],
  frames: number,
  frameRate: number,
): PieceFrames[] {
  const pieces: PieceFrames[] = [];
  let pieceStart = 0;
  let n = 0;
  for (const [k, segment] of segments.entries()) {
    const pieceEnd = pieceStart + segment.duration;
    const last = k === segments.length - 1;
    const first = n;
    const times: number[] = [];
    // Half a microsecond of tolerance: frame times are sums of rounded durations.
    while (n < frames && (last || n / frameRate < pieceEnd - 5e-7)) {
      if (segment.kind === 'video') times.push(segment.from + (n / frameRate - pieceStart));
      n++;
    }
    if (n > first) pieces.push({ segment, first, count: n - first, times });
    pieceStart = pieceEnd;
  }
  return pieces;
}

/**
 * Where to draw a decoded frame: its centre, the turn to apply around it (the fit's rotation plus
 * the video's own rotation metadata) and the size to draw the frame as decoded.
 */
export interface FramePlacement {
  cx: number;
  cy: number;
  /** Clockwise degrees. */
  rotation: number;
  width: number;
  height: number;
}

/** Size of a video as it plays: its decoded size turned by its rotation metadata. */
export function displaySize(coded: Size, metadataRotation: VideoRotation): Size {
  return isSideways(metadataRotation) ? { width: coded.height, height: coded.width } : coded;
}

function placementOf(
  placed: { x: number; y: number; width: number; height: number },
  fitRotation: VideoRotation,
  metadataRotation: VideoRotation,
): FramePlacement {
  // The box as the video plays (before the fit's turn), then as decoded (before its own turn).
  const box = unrotatedBox(placed, fitRotation);
  const decoded = displaySize({ width: box.width, height: box.height }, metadataRotation);
  return {
    cx: placed.x + placed.width / 2,
    cy: placed.y + placed.height / 2,
    rotation: (fitRotation + metadataRotation) % 360,
    width: decoded.width,
    height: decoded.height,
  };
}

/** The video on the canvas, like `videoPlacement` (contain, cover, stretch, zoom, position). */
export function framePlacement(
  coded: Size,
  metadataRotation: VideoRotation,
  canvas: Size,
  fit: VideoFit,
): FramePlacement {
  const display = displaySize(coded, metadataRotation);
  return placementOf(videoPlacement(display, canvas, fit), fit.rotation, metadataRotation);
}

/** The blurred copy behind the video (`blur` fit), on a canvas `BLUR_DOWNSCALE` times smaller. */
export function backdropPlacement(
  coded: Size,
  metadataRotation: VideoRotation,
  small: Size,
  fit: VideoFit,
): FramePlacement {
  const display = displaySize(coded, metadataRotation);
  return placementOf(backgroundPlacement(display, small, fit.rotation), fit.rotation, metadataRotation);
}

/** Size of the small canvas the blurred background is drawn on. */
export function backdropSize(canvas: Size): Size {
  return {
    width: Math.max(2, Math.round(canvas.width / BLUR_DOWNSCALE)),
    height: Math.max(2, Math.round(canvas.height / BLUR_DOWNSCALE)),
  };
}

/**
 * Blur of the small background, as a canvas `blur()` deviation: the desktop export's box blur
 * (radius a twelfth of the short side, two passes) has about this spread.
 */
export function backdropBlur(small: Size): number {
  const radius = Math.max(1, Math.floor(Math.min(small.width, small.height) / 12));
  return Math.sqrt((2 * radius * (radius + 1)) / 3);
}

/** Draw an image placed by `placement` (turned around its centre). */
export function drawPlaced(
  ctx: OffscreenCanvasRenderingContext2D,
  image: CanvasImageSource,
  placement: FramePlacement,
): void {
  ctx.save();
  ctx.translate(placement.cx, placement.cy);
  if (placement.rotation) ctx.rotate((placement.rotation * Math.PI) / 180);
  ctx.drawImage(image, -placement.width / 2, -placement.height / 2, placement.width, placement.height);
  ctx.restore();
}

/** WebCodecs names of the project's codecs. */
export const BROWSER_CODECS = { h264: 'avc', hevc: 'hevc', av1: 'av1' } as const;
