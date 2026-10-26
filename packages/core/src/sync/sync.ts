import { type Channel, resampleUniform } from '../model/telemetry.js';

/**
 * Offsets convert item time to timeline time: `timelineTime = itemTime + offsetSeconds`.
 * The reference item (first video, or first data source without videos) sits at offset 0.
 */
export function toTimelineTime(itemTime: number, offsetSeconds: number): number {
  return itemTime + offsetSeconds;
}

export function toItemTime(timelineTime: number, offsetSeconds: number): number {
  return timelineTime - offsetSeconds;
}

export type SyncMethod = 'timestamp' | 'camera-clock' | 'chapter' | 'correlation';

/** Stable id of a sync result message, so apps can show it in another language. */
export type SyncMessageCode =
  | 'gpsTime'
  | 'cameraClocks'
  | 'placedClockAsZone'
  | 'clockAsZone'
  | 'speedMatch'
  | 'chapterContinues'
  | 'chapterEndsBefore';

/** Remarks added to a sync result message. */
export type SyncNote = 'farFromTimeline' | 'ambiguous';

export interface SyncResult {
  method: SyncMethod;
  offsetSeconds: number;
  /** 0..1. Results at or above AUTO_SYNC_MIN_CONFIDENCE are applied without review. */
  confidence: number;
  /** Seconds the item overlaps what is already on the timeline with this offset. */
  overlapSeconds: number;
  code: SyncMessageCode;
  /** Values inserted in the message (item labels, chapter number...). */
  params: Record<string, string | number>;
  notes: SyncNote[];
  /** English message. */
  message: string;
}

/** Results at or above this confidence are applied and marked as synced without review. */
export const AUTO_SYNC_MIN_CONFIDENCE = 0.8;

/** A camera clock reading of an item's time 0 (see VideoInfo.clock). */
export interface ClockAnchor {
  source: string;
  /** As stored by the camera: GoPro writes local time as if it were UTC. */
  epochMs: number;
}

/** What the sync strategies know about a video or data source. */
export interface SyncSubject {
  label: string;
  /** UTC instant of the subject's time 0, from GPS or a logger clock. */
  startEpochMs: number | null;
  /** Camera clock readings of the subject's time 0 (videos). */
  clock?: readonly ClockAnchor[];
  /** Subject time range covered by its media. */
  range: { start: number; end: number };
  /** Speed signal (m/s) used for correlation. */
  speed?: Channel;
}

/** A subject already on the timeline. */
export interface PlacedSubject extends SyncSubject {
  offsetSeconds: number;
}

type Range = { start: number; end: number };

function shifted(range: Range, offset: number): Range {
  return { start: range.start + offset, end: range.end + offset };
}

function overlapSeconds(a: Range, b: Range): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

function gapSeconds(a: Range, b: Range): number {
  return Math.max(0, a.start - b.end, b.start - a.end);
}

/** Timeline span covered by the placed subjects. */
function coverage(placed: readonly PlacedSubject[]): Range {
  return {
    start: Math.min(...placed.map((p) => p.range.start + p.offsetSeconds)),
    end: Math.max(...placed.map((p) => p.range.end + p.offsetSeconds)),
  };
}

/** Items further than this from everything placed were most likely recorded at another time. */
const MAX_PLAUSIBLE_GAP_SECONDS = 600;

function formatUtcOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

interface Candidate {
  method: SyncMethod;
  offsetSeconds: number;
  confidence: number;
  code: SyncMessageCode;
  params: Record<string, string | number>;
  notes?: SyncNote[];
  message: string;
}

/** Score a candidate offset against what is already placed. */
function finalize(candidate: Candidate, placed: readonly PlacedSubject[], target: SyncSubject): SyncResult {
  const placedRange = coverage(placed);
  const targetRange = shifted(target.range, candidate.offsetSeconds);
  const overlap = overlapSeconds(placedRange, targetRange);
  const tooFar = gapSeconds(placedRange, targetRange) > MAX_PLAUSIBLE_GAP_SECONDS;
  return {
    ...candidate,
    offsetSeconds: Math.round(candidate.offsetSeconds * 1000) / 1000,
    confidence: tooFar ? Math.min(candidate.confidence, 0.1) : candidate.confidence,
    overlapSeconds: overlap,
    notes: [...(candidate.notes ?? []), ...(tooFar ? (['farFromTimeline'] as const) : [])],
    message: tooFar
      ? `${candidate.message} — far from the timeline, recorded at another time?`
      : candidate.message,
  };
}

/**
 * Absolute time strategies. GPS/logger clocks are UTC; camera clocks are local time, so they are
 * compared with each other directly (same camera timezone assumed) or converted with a guessed
 * timezone when compared with a UTC clock.
 */
function absoluteCandidates(
  placed: readonly PlacedSubject[],
  target: SyncSubject,
  timezoneOffsetMinutes: number,
): Candidate[] {
  const candidates: Candidate[] = [];
  const withEpoch = placed.find((p) => p.startEpochMs !== null);
  const withClock = placed.find((p) => p.clock?.[0]);
  const targetClock = target.clock?.[0];

  if (withEpoch?.startEpochMs != null && target.startEpochMs !== null) {
    candidates.push({
      method: 'timestamp',
      offsetSeconds: (target.startEpochMs - withEpoch.startEpochMs) / 1000 + withEpoch.offsetSeconds,
      confidence: 0.9,
      code: 'gpsTime',
      params: { label: withEpoch.label },
      message: `GPS / logger time compared with '${withEpoch.label}'`,
    });
    return candidates;
  }

  const placedClock = withClock?.clock?.[0];
  if (withClock && placedClock && targetClock) {
    candidates.push({
      method: 'camera-clock',
      offsetSeconds: (targetClock.epochMs - placedClock.epochMs) / 1000 + withClock.offsetSeconds,
      confidence: 0.6,
      code: 'cameraClocks',
      params: { label: withClock.label },
      message: `Camera clocks compared with '${withClock.label}' (same timezone assumed)`,
    });
  }

  // One side is UTC, the other a camera clock: try the local timezone, then UTC.
  const zones = timezoneOffsetMinutes === 0 ? [0] : [timezoneOffsetMinutes, 0];
  for (const [index, zone] of zones.entries()) {
    const confidence = 0.5 - index * 0.1;
    if (withClock && placedClock && target.startEpochMs !== null) {
      const placedUtc = placedClock.epochMs - zone * 60_000;
      candidates.push({
        method: 'camera-clock',
        offsetSeconds: (target.startEpochMs - placedUtc) / 1000 + withClock.offsetSeconds,
        confidence,
        code: 'placedClockAsZone',
        params: { label: withClock.label, clock: placedClock.source, zone: formatUtcOffset(zone) },
        message: `Camera clock of '${withClock.label}' (${placedClock.source}) read as ${formatUtcOffset(zone)}`,
      });
    }
    if (withEpoch?.startEpochMs != null && targetClock) {
      const targetUtc = targetClock.epochMs - zone * 60_000;
      candidates.push({
        method: 'camera-clock',
        offsetSeconds: (targetUtc - withEpoch.startEpochMs) / 1000 + withEpoch.offsetSeconds,
        confidence,
        code: 'clockAsZone',
        params: { clock: targetClock.source, zone: formatUtcOffset(zone) },
        message: `Camera clock (${targetClock.source}) read as ${formatUtcOffset(zone)}`,
      });
    }
  }
  return candidates;
}

/** Pearson correlation of a[i] vs b[i + shift] over the indices where both are defined. */
function correlationAtShift(a: Float64Array, b: Float64Array, shift: number): { r: number; n: number } {
  const start = Math.max(0, -shift);
  const end = Math.min(a.length, b.length - shift);
  let n = 0;
  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  for (let i = start; i < end; i++) {
    const x = a[i] as number;
    const y = b[i + shift] as number;
    if (Number.isNaN(x) || Number.isNaN(y)) continue;
    n++;
    sa += x;
    sb += y;
    saa += x * x;
    sbb += y * y;
    sab += x * y;
  }
  if (n < 3) return { r: Number.NaN, n };
  const cov = sab - (sa * sb) / n;
  const va = saa - (sa * sa) / n;
  const vb = sbb - (sb * sb) / n;
  if (va <= 1e-12 || vb <= 1e-12) return { r: Number.NaN, n };
  return { r: cov / Math.sqrt(va * vb), n };
}

interface ScanPoint {
  offset: number;
  r: number;
  overlap: number;
}

/**
 * Correlate on a uniform grid at `rate` Hz. Offsets are reference times of target time 0;
 * returns every evaluated offset.
 */
function scanOffsets(
  reference: Channel,
  target: Channel,
  rate: number,
  minOffset: number,
  maxOffset: number,
  minOverlap: number,
): ScanPoint[] {
  const refStart = reference.time[0] as number;
  const refEnd = reference.time[reference.time.length - 1] as number;
  const tgtStart = target.time[0] as number;
  const tgtEnd = target.time[target.time.length - 1] as number;
  const a = resampleUniform(reference, refStart, refEnd, rate);
  const b = resampleUniform(target, tgtStart, tgtEnd, rate);
  // reference index i <-> refStart + i/rate ; target index j = i + shift <-> tgtStart + j/rate
  // offset = refTime - tgtTime = refStart - tgtStart - shift/rate
  const base = refStart - tgtStart;
  const minShift = Math.ceil((base - maxOffset) * rate);
  const maxShift = Math.floor((base - minOffset) * rate);
  const points: ScanPoint[] = [];
  for (let shift = minShift; shift <= maxShift; shift++) {
    const { r, n } = correlationAtShift(a, b, shift);
    const overlap = n / rate;
    if (!Number.isNaN(r) && overlap >= minOverlap) points.push({ offset: base - shift / rate, r, overlap });
  }
  return points;
}

function best(points: readonly ScanPoint[]): ScanPoint | null {
  let top: ScanPoint | null = null;
  for (const p of points) if (!top || p.r > top.r) top = p;
  return top;
}

/** Local maxima of a scan (points ordered by offset), i.e. distinct candidate alignments. */
function peaks(points: readonly ScanPoint[]): ScanPoint[] {
  return points.filter((p, i) => {
    const before = points[i - 1];
    const after = points[i + 1];
    return (!before || p.r >= before.r) && (!after || p.r >= after.r);
  });
}

export interface CorrelationOptions {
  /** Restrict the search to offsets in [minOffset, maxOffset] (reference seconds). */
  minOffset?: number;
  maxOffset?: number;
  /** Minimum overlap, in seconds, for an offset to be considered. Default 10s. */
  minOverlapSeconds?: number;
}

export interface CorrelationMatch {
  /** Reference time of target time 0. */
  offset: number;
  r: number;
  overlap: number;
  /** Another, distant offset matches almost as well (e.g. repeating laps). */
  ambiguous: boolean;
}

/** Distance beyond which a second correlation peak counts as a different alignment. */
const AMBIGUITY_DISTANCE_SECONDS = 5;
const AMBIGUITY_MARGIN = 0.02;

/**
 * Best alignment of two signals by normalized cross-correlation: a coarse pass over the
 * allowed range, then a fine 20 Hz pass around the best match.
 */
export function correlateChannels(
  reference: Channel,
  target: Channel,
  options: CorrelationOptions = {},
): CorrelationMatch | null {
  if (reference.time.length < 3 || target.time.length < 3) return null;
  const refStart = reference.time[0] as number;
  const refEnd = reference.time[reference.time.length - 1] as number;
  const tgtStart = target.time[0] as number;
  const tgtEnd = target.time[target.time.length - 1] as number;
  const shorter = Math.min(refEnd - refStart, tgtEnd - tgtStart);
  const minOverlap = Math.min(options.minOverlapSeconds ?? 10, shorter * 0.8);
  const minOffset = options.minOffset ?? refStart - tgtEnd;
  const maxOffset = options.maxOffset ?? refEnd - tgtStart;

  const coarsePoints = scanOffsets(reference, target, 2, minOffset, maxOffset, minOverlap);
  const coarse = best(coarsePoints);
  if (!coarse) return null;
  const runnerUp = best(
    peaks(coarsePoints).filter((p) => Math.abs(p.offset - coarse.offset) > AMBIGUITY_DISTANCE_SECONDS),
  );
  const fine =
    best(
      scanOffsets(
        reference,
        target,
        20,
        Math.max(minOffset, coarse.offset - 1.5),
        Math.min(maxOffset, coarse.offset + 1.5),
        minOverlap,
      ),
    ) ?? coarse;
  return {
    offset: fine.offset,
    r: fine.r,
    overlap: fine.overlap,
    ambiguous: runnerUp !== null && coarse.r - runnerUp.r < AMBIGUITY_MARGIN,
  };
}

/** Correlate the target speed with every placed subject's speed; keep the best match. */
function correlationCandidate(
  placed: readonly PlacedSubject[],
  target: SyncSubject,
  anchor: Candidate | undefined,
): Candidate | null {
  if (!target.speed) return null;
  const window = anchor?.method === 'timestamp' ? 30 : 120;
  let top: { subject: PlacedSubject; match: CorrelationMatch } | null = null;
  for (const subject of placed) {
    if (!subject.speed) continue;
    const options: CorrelationOptions = anchor
      ? {
          minOffset: anchor.offsetSeconds - subject.offsetSeconds - window,
          maxOffset: anchor.offsetSeconds - subject.offsetSeconds + window,
        }
      : {};
    const match = correlateChannels(subject.speed, target.speed, options);
    if (match && (!top || match.r > top.match.r)) top = { subject, match };
  }
  if (!top) return null;
  const { subject, match } = top;
  const r = Math.max(0, match.r);
  return {
    method: 'correlation',
    offsetSeconds: match.offset + subject.offsetSeconds,
    // A repeating pattern (laps) is never trusted without review.
    confidence: match.ambiguous ? Math.min(r, AUTO_SYNC_MIN_CONFIDENCE - 0.1) : r,
    code: 'speedMatch',
    params: { label: subject.label, r: match.r.toFixed(3), overlap: Math.round(match.overlap) },
    notes: match.ambiguous ? ['ambiguous'] : [],
    message: `Speed matched with '${subject.label}' (r = ${match.r.toFixed(3)}, ${match.overlap.toFixed(0)} s compared)${
      match.ambiguous ? ' — ambiguous, repeating pattern' : ''
    }`,
  };
}

export interface AutoSyncInput {
  /** Subjects already on the timeline, reference first. */
  placed: readonly PlacedSubject[];
  target: SyncSubject;
  /** Timezone camera clocks are assumed to be set to. Defaults to this machine's. */
  timezoneOffsetMinutes?: number;
  /** Extra candidates computed by the caller (e.g. GoPro chapter continuation). */
  extra?: readonly Candidate[];
}

export type SyncCandidate = Candidate;

/** Run every applicable strategy; results are sorted best first. */
export function autoSync(input: AutoSyncInput): SyncResult[] {
  const { placed, target } = input;
  if (placed.length === 0) return [];
  const timezone = input.timezoneOffsetMinutes ?? -new Date().getTimezoneOffset();
  const candidates = [...(input.extra ?? []), ...absoluteCandidates(placed, target, timezone)];
  const scored = candidates.map((c) => finalize(c, placed, target));
  // Refine around the most trusted plausible absolute estimate; otherwise search everything.
  let anchorIndex = -1;
  for (const [i, result] of scored.entries()) {
    const current = scored[anchorIndex]?.confidence ?? 0;
    if (result.confidence > 0.1 && result.confidence > current) anchorIndex = i;
  }
  const correlation = correlationCandidate(placed, target, candidates[anchorIndex]);
  if (correlation) scored.push(finalize(correlation, placed, target));
  return scored.sort((a, b) => b.confidence - a.confidence);
}
