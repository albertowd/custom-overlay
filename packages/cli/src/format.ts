import {
  AUTO_SYNC_MIN_CONFIDENCE,
  type ColorSettings,
  describeCodec,
  type ItemSyncOutcome,
  type OutputSettings,
  type SeriesSummary,
  type StepStatus,
  type SyncResult,
  type VideoInfo,
} from '@custom-overlay/core';

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '-';
  const sign = seconds < 0 ? '-' : '';
  const abs = Math.abs(seconds);
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const s = abs % 60;
  const ss = s.toFixed(3).padStart(6, '0');
  return h > 0 ? `${sign}${h}:${String(m).padStart(2, '0')}:${ss}` : `${sign}${m}:${ss}`;
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatNumber(value: number): string {
  if (Number.isNaN(value)) return '-';
  return Math.abs(value) >= 1000 ? value.toFixed(0) : String(Number(value.toPrecision(4)));
}

/** Render rows as an aligned text table. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

const COLOR_SPACES: Record<ColorSettings['space'], string> = {
  rec709: 'Rec.709',
  rec2020: 'Rec.2020',
  'rec2020-hlg': 'Rec.2020 HLG',
  'rec2020-pq': 'Rec.2020 PQ',
};

export function formatColor(color: ColorSettings): string {
  return `${COLOR_SPACES[color.space]}, ${color.range} range, ${color.bitDepth}-bit`;
}

export function formatOutput(output: OutputSettings): string {
  return `${output.width}x${output.height} @ ${output.frameRate} fps, ${formatColor(output.color)}`;
}

export function formatVideo(info: VideoInfo): string {
  return [
    `File:        ${info.path}`,
    `Size:        ${formatBytes(info.sizeBytes)}`,
    `Duration:    ${formatDuration(info.durationSeconds)}`,
    `Resolution:  ${info.width}x${info.height} @ ${info.frameRate} fps (${info.frameCount} frames)`,
    `Color:       ${formatColor(info.color)}`,
    `Codec:       ${describeCodec(info.codec)}`,
    `Clock:       ${info.clock.map((c) => `${c.source} ${new Date(c.epochMs).toISOString().replace('.000Z', '')}`).join(', ') || '-'} (camera, no timezone)`,
    `Camera:      ${[info.camera.model, info.camera.firmware && `firmware ${info.camera.firmware}`].filter(Boolean).join(', ') || '-'}`,
    `Telemetry:   ${info.hasGpmf ? 'GoPro GPMF track' : 'none'}`,
  ].join('\n');
}

export function formatSeries(summary: SeriesSummary): string {
  const rows = summary.channels.map((c) => [
    c.key,
    c.label,
    c.unit,
    String(c.samples),
    c.rateHz.toFixed(1),
    formatNumber(c.min),
    formatNumber(c.max),
  ]);
  return [
    `Source:      ${summary.name} (${summary.kind})`,
    `Start:       ${summary.startTime ?? 'unknown (relative times only)'}`,
    `Duration:    ${formatDuration(summary.durationSeconds)}`,
    '',
    table(['key', 'label', 'unit', 'samples', 'Hz', 'min', 'max'], rows),
  ].join('\n');
}

export function formatSyncOutcome(outcome: ItemSyncOutcome): string {
  if (!outcome.result) return `${outcome.label}: could not be synced automatically`;
  const review = outcome.result.confidence >= AUTO_SYNC_MIN_CONFIDENCE ? '' : ' (review in the app)';
  return `${outcome.label}: ${formatSyncResult(outcome.result)}${review}`;
}

export function formatSyncResult(result: SyncResult): string {
  return `${result.method.padEnd(12)} offset ${result.offsetSeconds.toFixed(3)} s  confidence ${(result.confidence * 100).toFixed(0)}%  - ${result.message}`;
}

const STATE_ICONS: Record<StepStatus['state'], string> = {
  complete: '[x]',
  incomplete: '[ ]',
  skipped: '[-]',
  'not-applicable': '[-]',
};

export function formatWorkflow(statuses: readonly StepStatus[]): string {
  return statuses
    .flatMap((s) => [
      `${STATE_ICONS[s.state]} ${s.title} (${s.state})`,
      ...s.issues.map((i) => `      ${i.severity === 'error' ? 'error' : 'warn '}: ${i.message}`),
    ])
    .join('\n');
}

/** A value with its unit; durations in seconds shown as m:ss.mmm. */
export function formatValue(value: number, unit: string): string {
  if (Number.isNaN(value)) return '-';
  if (unit === 's' && Math.abs(value) >= 60) return formatDuration(value);
  if (unit === 'ms' && value > 1e11) return new Date(value).toISOString();
  return `${formatNumber(value)}${unit ? ` ${unit}` : ''}`;
}
