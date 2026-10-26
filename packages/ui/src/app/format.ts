import type { ColorSettings } from '@custom-overlay/core';
import { t } from './i18n';

export function formatTime(seconds: number, withMillis = true): string {
  if (!Number.isFinite(seconds)) return '--:--';
  const sign = seconds < 0 ? '-' : '';
  const abs = Math.abs(seconds);
  const h = Math.floor(abs / 3600);
  const m = Math.floor((abs % 3600) / 60);
  const s = abs % 60;
  const sText = withMillis ? s.toFixed(3).padStart(6, '0') : String(Math.floor(s)).padStart(2, '0');
  const mText = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${sign}${h > 0 ? `${h}:` : ''}${mText}:${sText}`;
}

export function formatOffset(seconds: number): string {
  return `${seconds >= 0 ? '+' : '-'}${Math.abs(seconds).toFixed(3)} s`;
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

export function formatValue(value: number, unit: string): string {
  if (Number.isNaN(value)) return '—';
  if (unit === 'm/s') return `${(value * 3.6).toFixed(1)} km/h`;
  if (unit === 'deg') return `${value.toFixed(6)}°`;
  if (unit === 's') return Math.abs(value) >= 60 ? formatTime(value) : `${value.toFixed(3)} s`;
  if (unit === 'ms' && value > 1e11) return `${new Date(value).toISOString().slice(11, 23)} UTC`;
  if (Number.isInteger(value)) return `${value}${unit ? ` ${unit}` : ''}`;
  const digits = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2;
  return `${value.toFixed(digits)}${unit ? ` ${unit}` : ''}`;
}

export function formatDateTime(epochMs: number | null): string {
  if (epochMs === null) return t('common.unknown');
  return new Date(epochMs).toISOString().replace('T', ' ').replace('Z', ' UTC');
}

const COLOR_SPACES: Record<ColorSettings['space'], string> = {
  rec709: 'Rec.709',
  rec2020: 'Rec.2020',
  'rec2020-hlg': 'Rec.2020 HLG',
  'rec2020-pq': 'Rec.2020 PQ',
};

export function formatColor(color: ColorSettings): string {
  return `${COLOR_SPACES[color.space]} · ${color.range} · ${color.bitDepth}-bit`;
}

export function formatFormat(width: number, height: number, frameRate: number): string {
  return `${width} × ${height} @ ${Number(frameRate.toFixed(3))} fps`;
}
