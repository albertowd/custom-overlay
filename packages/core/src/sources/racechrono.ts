import { type Channel, StandardChannel, type TelemetrySeries } from '../model/telemetry.js';
import { parseNumber, splitCsvLine, splitLines } from './csv.js';

/**
 * Parser for RaceChrono CSV exports (v2 and v3 formats).
 *
 * Layout of a v3 export:
 *   - a preamble of "key,value" lines (format, session title, track name...)
 *   - a header row with channel names, starting with "Timestamp"
 *   - optional rows with units ("unix time", "m/s"...) and sensor sources ("100: gps", "calc"...)
 *   - data rows; sensors updating at different rates leave empty cells
 */

export class RaceChronoParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RaceChronoParseError';
  }
}

const KEY_BY_NAME: Record<string, string> = {
  lap: StandardChannel.lap,
  'lap number': StandardChannel.lap,
  'elapsed time': StandardChannel.elapsedTime,
  'distance traveled': StandardChannel.distance,
  distance: StandardChannel.distance,
  accuracy: StandardChannel.gpsAccuracy,
  altitude: StandardChannel.altitude,
  bearing: StandardChannel.heading,
  'fix type': StandardChannel.gpsFix,
  latitude: StandardChannel.latitude,
  longitude: StandardChannel.longitude,
  satellites: StandardChannel.satellites,
  speed: StandardChannel.speed,
  'combined acc': StandardChannel.accelCombined,
  'lateral acc': StandardChannel.accelLateral,
  'longitudinal acc': StandardChannel.accelLongitudinal,
  'lean angle': StandardChannel.leanAngle,
  'x acceleration': StandardChannel.accelX,
  'y acceleration': StandardChannel.accelY,
  'z acceleration': StandardChannel.accelZ,
  'x rate of rotation': StandardChannel.gyroX,
  'y rate of rotation': StandardChannel.gyroY,
  'z rate of rotation': StandardChannel.gyroZ,
};

/** Columns that carry no useful numeric telemetry. */
const IGNORED_COLUMNS = new Set(['device update rate', 'trap name', 'fragment id']);

const SPEED_UNIT_TO_MS: Record<string, number> = { 'km/h': 1 / 3.6, kph: 1 / 3.6, mph: 0.44704 };

interface ColumnInfo {
  index: number;
  name: string;
  unit: string;
  source: string;
}

/** "1714557600.125" -> { whole: 1714557600, fraction: 0.125 } */
function splitTimestamp(cell: string | undefined): { whole: number; fraction: number } {
  const value = parseNumber(cell);
  if (Number.isNaN(value)) return { whole: Number.NaN, fraction: 0 };
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(cell ?? '');
  if (!match) return { whole: value, fraction: 0 };
  const sign = match[1] ? -1 : 1;
  return { whole: sign * Number(match[2]), fraction: match[3] ? sign * Number(`0.${match[3]}`) : 0 };
}

function isNumericRow(cells: string[]): boolean {
  return cells.length > 0 && cells[0] !== '' && Number.isFinite(Number(cells[0]));
}

function isHeaderRow(cells: string[]): boolean {
  return cells.length >= 2 && /^(timestamp|time)\b/i.test(cells[0] ?? '');
}

/** "Speed (m/s)" -> { name: "Speed", unit: "m/s" } */
function splitNameAndUnit(header: string): { name: string; unit: string } {
  const text = header.trim();
  const open = text.lastIndexOf('(');
  if (!text.endsWith(')') || open < 0) return { name: header, unit: '' };
  return { name: text.slice(0, open).trim(), unit: text.slice(open + 1, -1).trim() };
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/#/g, 'number')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function camelCase(text: string): string {
  const words = normalizeName(text).split(' ').filter(Boolean);
  return words.map((w, i) => (i === 0 ? w : `${w.charAt(0).toUpperCase()}${w.slice(1)}`)).join('');
}

function looksLikeSourceRow(cells: string[]): boolean {
  return cells.some((c) => /^\d+\s*:/.test(c) || c === 'calc');
}

function parsePreamble(lines: string[]): Record<string, string> {
  const metadata: Record<string, string> = {};
  for (const line of lines) {
    const cells = splitCsvLine(line);
    const key = cells[0];
    if (!key || cells.length < 2) continue;
    const value = cells.slice(1).filter(Boolean).join(' ');
    if (value) metadata[key] = value;
  }
  return metadata;
}

function resolveColumns(header: string[], metaRows: string[][]): ColumnInfo[] {
  const sourceRow = metaRows.find(looksLikeSourceRow);
  const unitRow = metaRows.find((r) => r !== sourceRow);
  return header.map((cell, index) => {
    const parsed = splitNameAndUnit(cell);
    return {
      index,
      name: parsed.name,
      unit: parsed.unit || unitRow?.[index] || '',
      source: sourceRow?.[index] ?? '',
    };
  });
}

function channelKey(column: ColumnInfo, used: Set<string>): string {
  const normalized = normalizeName(column.name);
  const base = KEY_BY_NAME[normalized] ?? (camelCase(column.name) || `column${column.index}`);
  let key = base;
  if (used.has(key) && column.source) {
    const suffix = camelCase(column.source.replace(/^\d+\s*:\s*/, ''));
    if (suffix) key = `${base}_${suffix}`;
  }
  let n = 2;
  while (used.has(key)) key = `${base}_${n++}`;
  used.add(key);
  return key;
}

/** Build a channel keeping only rows where the column has a value. */
function buildChannel(
  key: string,
  column: ColumnInfo,
  rows: string[][],
  times: Float64Array,
): Channel | null {
  const values = new Float64Array(rows.length);
  let valid = 0;
  for (let r = 0; r < rows.length; r++) {
    const v = parseNumber(rows[r]?.[column.index]);
    values[r] = v;
    if (!Number.isNaN(v)) valid++;
  }
  if (valid === 0) return null;

  let unit = column.unit === 'G' ? 'g' : column.unit;
  const speedFactor = SPEED_UNIT_TO_MS[unit.toLowerCase()];
  if (speedFactor !== undefined) {
    for (let i = 0; i < values.length; i++) values[i] = (values[i] as number) * speedFactor;
    unit = 'm/s';
  }

  const label = column.source ? `${column.name} (${column.source})` : column.name;
  if (valid === rows.length) return { key, label, unit, time: times, values };

  const time = new Float64Array(valid);
  const compact = new Float64Array(valid);
  let j = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i] as number;
    if (Number.isNaN(v)) continue;
    time[j] = times[i] as number;
    compact[j] = v;
    j++;
  }
  return { key, label, unit, time, values: compact };
}

export function parseRaceChronoCsv(text: string, name = 'RaceChrono'): TelemetrySeries {
  const lines = splitLines(text);
  const headerIndex = lines.findIndex((l) => isHeaderRow(splitCsvLine(l)));
  if (headerIndex < 0) {
    throw new RaceChronoParseError('Could not find the RaceChrono header row (starting with "Timestamp")');
  }
  const header = splitCsvLine(lines[headerIndex] ?? '');
  const metaRows: string[][] = [];
  const rows: string[][] = [];
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    const cells = splitCsvLine(line);
    if (isNumericRow(cells)) rows.push(cells);
    else if (rows.length === 0) metaRows.push(cells);
  }
  if (rows.length === 0) throw new RaceChronoParseError('The file contains no data rows');

  const columns = resolveColumns(header, metaRows);
  const timeColumn = columns[0] as ColumnInfo;

  // Absolute unix timestamps (seconds) or relative seconds.
  const rawTimes = rows.map((r) => splitTimestamp(r[0]));
  const first = rawTimes.find((t) => !Number.isNaN(t.whole)) ?? { whole: 0, fraction: 0 };
  const absolute = /unix/i.test(timeColumn.unit) || first.whole > 1e9;
  // Subtract integer and fractional parts separately: unix seconds as doubles lose sub-ms precision.
  const times = new Float64Array(rawTimes.map((t) => t.whole - first.whole + (t.fraction - first.fraction)));

  const used = new Set<string>();
  const channels: Channel[] = [];
  for (const column of columns.slice(1)) {
    if (IGNORED_COLUMNS.has(normalizeName(column.name)) || column.name === '') continue;
    const channel = buildChannel(channelKey(column, used), column, rows, times);
    if (channel) channels.push(channel);
  }

  const metadata = parsePreamble(lines.slice(0, headerIndex));
  return {
    kind: 'racechrono',
    name: metadata['Session title'] ?? name,
    startEpochMs: absolute ? first.whole * 1000 + Math.round(first.fraction * 1000) : null,
    channels,
    metadata,
  };
}

/** Quick check used to detect RaceChrono files without parsing them fully. */
export function isRaceChronoCsv(text: string): boolean {
  const head = splitLines(text.slice(0, 8192));
  return head.some((l) => /racechrono/i.test(l)) || head.some((l) => isHeaderRow(splitCsvLine(l)));
}
