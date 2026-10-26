import type { Project } from '../model/project.js';
import { type Channel, type SourceKind, StandardChannel, sampleAt } from '../model/telemetry.js';
import { enabledSources, type ProjectMedia } from '../workflow/timeline.js';
import type { RawSamples, ValueInfo } from './types.js';

const KIND_LABELS: Record<SourceKind, string> = {
  gopro: 'GoPro telemetry',
  racechrono: 'RaceChrono',
  dji: 'DJI telemetry',
};

/** Kinds in priority order for "best available" values: dedicated loggers beat the camera GPS. */
const KIND_PRIORITY: readonly SourceKind[] = ['racechrono', 'dji', 'gopro'];

/** Channels holding counters or states: sampled as-is, never interpolated. */
const DISCRETE_CHANNELS = new Set<string>([
  StandardChannel.lap,
  StandardChannel.satellites,
  StandardChannel.gpsFix,
]);

const STANDARD_KEYS = new Set<string>(Object.values(StandardChannel));

interface PlacedChannel {
  channel: Channel;
  offset: number;
}

/** A value read from source channels, first source with data wins at each frame. */
export interface SourceBinding {
  info: ValueInfo;
  channels: PlacedChannel[];
  discrete: boolean;
}

function sanitizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_]/g, '_');
}

function bindingsFor(
  entries: { kind: SourceKind; channel: Channel; offset: number }[],
  id: string,
  description: string,
): SourceBinding | null {
  const [first] = entries;
  if (!first) return null;
  return {
    info: {
      id,
      name: first.channel.label,
      description,
      unit: first.channel.unit,
      initial: null,
      origin: 'source',
    },
    channels: entries.map((e) => ({ channel: e.channel, offset: e.offset })),
    discrete: DISCRETE_CHANNELS.has(first.channel.key),
  };
}

/**
 * Values provided by the loaded sources:
 * - `<kind>.<channel>` (e.g. `gopro.speed`): every source of that kind merged on the timeline,
 *   so GoPro chapters form one continuous value;
 * - `<standard channel>` (e.g. `speed`, `lap`): best available source at each frame.
 */
export function sourceBindings(project: Project, media: ProjectMedia): SourceBinding[] {
  const entries: { kind: SourceKind; channel: Channel; offset: number }[] = [];
  for (const source of enabledSources(project)) {
    const series = media.series[source.id];
    if (!series) continue;
    for (const channel of series.channels) {
      entries.push({ kind: series.kind, channel, offset: source.offsetSeconds });
    }
  }

  const bindings: SourceBinding[] = [];
  for (const kind of KIND_PRIORITY) {
    const ofKind = entries.filter((e) => e.kind === kind);
    const keys = [...new Set(ofKind.map((e) => e.channel.key))];
    for (const key of keys) {
      const binding = bindingsFor(
        ofKind.filter((e) => e.channel.key === key),
        `${kind}.${sanitizeKey(key)}`,
        `${ofKind.find((e) => e.channel.key === key)?.channel.label} from ${KIND_LABELS[kind]}`,
      );
      if (binding) bindings.push(binding);
    }
  }

  const standardKeys = [...new Set(entries.map((e) => e.channel.key))].filter((k) => STANDARD_KEYS.has(k));
  for (const key of standardKeys) {
    const ordered = KIND_PRIORITY.flatMap((kind) =>
      entries.filter((e) => e.kind === kind && e.channel.key === key),
    );
    const kinds = [...new Set(ordered.map((e) => KIND_LABELS[e.kind]))].join(', then ');
    const binding = bindingsFor(
      ordered,
      key,
      `${ordered[0]?.channel.label}, best available source (${kinds})`,
    );
    if (binding) bindings.push(binding);
  }
  return bindings;
}

/** Value of a binding at each timeline time. */
export function sampleBinding(binding: SourceBinding, times: Float64Array): Float64Array {
  const out = new Float64Array(times.length);
  const interpolate = !binding.discrete;
  for (let i = 0; i < times.length; i++) {
    let value = Number.NaN;
    for (const { channel, offset } of binding.channels) {
      value = sampleAt(channel, (times[i] as number) - offset, { interpolate });
      if (!Number.isNaN(value)) break;
    }
    out[i] = value;
  }
  return out;
}

/** Every sample of a binding in timeline time, sorted (for precise, frame independent maths). */
export function rawBinding(binding: SourceBinding): RawSamples {
  const samples: [number, number][] = [];
  for (const { channel, offset } of binding.channels) {
    for (let i = 0; i < channel.time.length; i++) {
      samples.push([(channel.time[i] as number) + offset, channel.values[i] as number]);
    }
  }
  samples.sort((a, b) => a[0] - b[0]);
  return {
    time: Float64Array.from(samples, (s) => s[0]),
    values: Float64Array.from(samples, (s) => s[1]),
  };
}
