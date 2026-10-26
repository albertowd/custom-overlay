/** Text formatting used by text widgets: numbers, durations, clock times and value templates. */

/** Fixed decimals; NaN gives the fallback. */
export function formatNumber(value: number, decimals = 0, fallback = '—'): string {
  if (!Number.isFinite(value)) return fallback;
  return value.toFixed(decimals);
}

/** Seconds as `m:ss.mmm` (or `h:mm:ss.mmm`), with `decimals` digits after the seconds. */
export function formatDuration(seconds: number, decimals = 3, fallback = '—:——'): string {
  if (!Number.isFinite(seconds)) return fallback;
  const sign = seconds < 0 ? '-' : '';
  const scale = 10 ** decimals;
  const total = Math.round(Math.abs(seconds) * scale) / scale;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const sText = s.toFixed(decimals).padStart(decimals > 0 ? decimals + 3 : 2, '0');
  return h > 0 ? `${sign}${h}:${String(m).padStart(2, '0')}:${sText}` : `${sign}${m}:${sText}`;
}

const pad = (n: number, size = 2) => String(n).padStart(size, '0');

/**
 * Parse a time typed by a person, filled from right to left like a video editor timecode:
 * - digits only fill milliseconds, then seconds, minutes and hours: `530` = 0.530 s,
 *   `2530` = 2.530 s, `10112530` = 1:01:12.530;
 * - with a dot, the part before it is seconds: `2.530` = 2.530 s, `150.5` = 2:30.500;
 * - with colons, fields are `[[h:]m:]s[.mmm]` from the right and empty fields are zero:
 *   `2:30` = 2:30.000, `5:23:` = 5:23:00.000.
 * Fields may overflow (`1:90` = 2:30). A leading `-` makes it negative. NaN when not a time.
 */
export function parseTimeInput(text: string): number {
  const [, minus, body = ''] = /^(-)?\s*([\d:.]+)$/.exec(text.trim()) ?? [];
  if (!/\d/.test(body)) return Number.NaN;
  let seconds: number;
  if (body.includes(':')) {
    const fields = body.split(':');
    if (fields.length > 3) return Number.NaN;
    const last = fields.pop() ?? '';
    if (!/^(\d+(\.\d*)?|\.\d+)?$/.test(last) || fields.some((f) => !/^\d*$/.test(f))) return Number.NaN;
    const [minutes = '', hours = ''] = [...fields].reverse();
    seconds = Number(hours || 0) * 3600 + Number(minutes || 0) * 60 + Number(last || 0);
  } else if (body.includes('.')) {
    if (!/^(\d+\.\d*|\.\d+)$/.test(body)) return Number.NaN;
    seconds = Number(body);
  } else {
    const digits = body.padStart(7, '0');
    const n = digits.length;
    // Whole milliseconds, so 2530 is exactly 2.53.
    const ms =
      Number(digits.slice(0, n - 7)) * 3_600_000 +
      Number(digits.slice(n - 7, n - 5)) * 60_000 +
      Number(digits.slice(n - 5, n - 3)) * 1000 +
      Number(digits.slice(n - 3));
    seconds = ms / 1000;
  }
  return minus ? -seconds : seconds;
}

/** Seconds as `HH:MM:SS.mmm` (e.g. `00:02:30.000`), the form time inputs show. */
export function formatTimecode(seconds: number, fallback = '--:--:--.---'): string {
  if (!Number.isFinite(seconds)) return fallback;
  const sign = seconds < 0 ? '-' : '';
  const ms = Math.round(Math.abs(seconds) * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${sign}${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms % 1000, 3)}`;
}

/**
 * Epoch milliseconds as text in a timezone. Tokens: YYYY MM DD HH mm ss SSS (anything else is
 * copied), e.g. `DD/MM/YYYY HH:mm:ss`.
 */
export function formatClock(
  epochMs: number,
  pattern: string,
  utcOffsetMinutes: number,
  fallback = '—',
): string {
  if (!Number.isFinite(epochMs)) return fallback;
  const d = new Date(epochMs + utcOffsetMinutes * 60_000);
  const tokens: Record<string, string> = {
    YYYY: String(d.getUTCFullYear()),
    MM: pad(d.getUTCMonth() + 1),
    DD: pad(d.getUTCDate()),
    HH: pad(d.getUTCHours()),
    mm: pad(d.getUTCMinutes()),
    ss: pad(d.getUTCSeconds()),
    SSS: pad(d.getUTCMilliseconds(), 3),
  };
  return pattern.replace(/YYYY|MM|DD|HH|mm|ss|SSS/g, (token) => tokens[token] ?? token);
}

/**
 * Parse a wall clock date/time `YYYY-MM-DD HH:mm[:ss[.SSS]]` in a timezone into epoch
 * milliseconds; NaN when the text is not a date/time.
 */
export function parseClock(text: string, utcOffsetMinutes: number): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(text.trim());
  if (!match) return Number.NaN;
  const [, y, mo, d, h, mi, s = '0', ms = '0'] = match;
  const utc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
    Number(ms.padEnd(3, '0')),
  );
  return utc - utcOffsetMinutes * 60_000;
}

/** UTC offset of this machine, in minutes east of UTC. */
export function localUtcOffsetMinutes(): number {
  return -new Date().getTimezoneOffset();
}

/**
 * One value with a format:
 * - `0`, `0.0`, `0.00`... fixed decimals
 * - `duration` / `duration.0`: m:ss.mmm (or one decimal)
 * - `clock:HH:mm:ss`: epoch milliseconds as a clock time (pattern after the colon)
 * - empty: up to 2 decimals
 */
export function formatWithPattern(
  value: number,
  pattern: string,
  utcOffsetMinutes: number,
  fallback: string,
): string {
  if (!Number.isFinite(value)) return fallback;
  if (pattern.startsWith('clock')) {
    return formatClock(value, pattern.slice(6) || 'HH:mm:ss', utcOffsetMinutes, fallback);
  }
  if (pattern.startsWith('duration')) {
    const decimals = pattern.includes('.') ? pattern.length - pattern.indexOf('.') - 1 : 3;
    return formatDuration(value, decimals, fallback);
  }
  if (/^0(\.0+)?$/.test(pattern)) return formatNumber(value, pattern.includes('.') ? pattern.length - 2 : 0);
  return String(Math.round(value * 100) / 100);
}

/**
 * Replace `{valueId}` / `{valueId|format}` placeholders, e.g.
 * `Lap {lap.number} — {lap.time|duration}` or `{speed.kmh|0} km/h`. Use `{{` for a literal brace.
 */
export function formatTemplate(
  template: string,
  value: (id: string) => number,
  utcOffsetMinutes: number,
  fallback = '—',
): string {
  return template.replace(/\{\{|\{([^{}|]+)(?:\|([^{}]*))?\}/g, (match, id?: string, pattern?: string) => {
    if (match === '{{') return '{';
    return formatWithPattern(value((id ?? '').trim()), (pattern ?? '').trim(), utcOffsetMinutes, fallback);
  });
}

/** Value ids referenced by a text template. */
export function templateValueIds(template: string): string[] {
  const ids = new Set<string>();
  for (const match of template.matchAll(/\{\{|\{([^{}|]+)(?:\|[^{}]*)?\}/g)) {
    const id = match[1]?.trim();
    if (id) ids.add(id);
  }
  return [...ids];
}
