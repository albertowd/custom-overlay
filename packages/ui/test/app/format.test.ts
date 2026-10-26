import { beforeEach, describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatColor,
  formatDateTime,
  formatFormat,
  formatOffset,
  formatTime,
  formatValue,
} from '../../src/app/format';
import { useLanguage } from '../../src/app/i18n';
import { resetStores } from './helpers/project';

beforeEach(resetStores);

describe('formatTime', () => {
  it('shows minutes and seconds with milliseconds', () => {
    expect(formatTime(0)).toBe('0:00.000');
    expect(formatTime(83.5)).toBe('1:23.500');
  });

  it('adds hours and pads the minutes past an hour', () => {
    expect(formatTime(3723.25)).toBe('1:02:03.250');
  });

  it('drops the milliseconds on request', () => {
    expect(formatTime(83.9, false)).toBe('1:23');
    expect(formatTime(3605, false)).toBe('1:00:05');
  });

  it('signs negative times and dashes non finite ones', () => {
    expect(formatTime(-5.5)).toBe('-0:05.500');
    expect(formatTime(Number.NaN)).toBe('--:--');
    expect(formatTime(Number.POSITIVE_INFINITY)).toBe('--:--');
  });
});

describe('formatOffset', () => {
  it('always shows the sign', () => {
    expect(formatOffset(1.5)).toBe('+1.500 s');
    expect(formatOffset(0)).toBe('+0.000 s');
    expect(formatOffset(-0.25)).toBe('-0.250 s');
  });
});

describe('formatBytes', () => {
  it('picks the largest unit below 1024', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(150 * 1024 * 1024)).toBe('150.0 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
  });

  it('stops at terabytes', () => {
    expect(formatBytes(2048 * 1024 ** 4)).toBe('2048.0 TB');
  });
});

describe('formatValue', () => {
  it('dashes NaN', () => {
    expect(formatValue(Number.NaN, 'm/s')).toBe('—');
  });

  it('converts speeds to km/h and shows degrees with 6 decimals', () => {
    expect(formatValue(10, 'm/s')).toBe('36.0 km/h');
    expect(formatValue(-28.84378512, 'deg')).toBe('-28.843785°');
  });

  it('shows seconds as a time past a minute', () => {
    expect(formatValue(12.3456, 's')).toBe('12.346 s');
    expect(formatValue(83.5, 's')).toBe('1:23.500');
  });

  it('shows epoch milliseconds as a UTC clock time', () => {
    expect(formatValue(Date.UTC(2026, 9, 26, 14, 3, 33, 264), 'ms')).toBe('14:03:33.264 UTC');
    expect(formatValue(250, 'ms')).toBe('250 ms');
  });

  it('keeps integers and rounds by magnitude', () => {
    expect(formatValue(7, '')).toBe('7');
    expect(formatValue(7, 'rpm')).toBe('7 rpm');
    expect(formatValue(1.23456, 'g')).toBe('1.23 g');
    expect(formatValue(12.345, 'bar')).toBe('12.3 bar');
    expect(formatValue(-123.45, '')).toBe('-123');
  });
});

describe('formatDateTime', () => {
  it('shows an ISO date in UTC', () => {
    expect(formatDateTime(Date.UTC(2026, 0, 2, 3, 4, 5, 6))).toBe('2026-01-02 03:04:05.006 UTC');
  });

  it('says unknown in the current language without a date', () => {
    expect(formatDateTime(null)).toBe('unknown');
    useLanguage.setState({ language: 'pt-BR' });
    expect(formatDateTime(null)).not.toBe('unknown');
  });
});

describe('formatColor and formatFormat', () => {
  it('names the colour space, range and depth', () => {
    expect(formatColor({ space: 'rec2020-hlg', range: 'full', bitDepth: 10 })).toBe(
      'Rec.2020 HLG · full · 10-bit',
    );
    expect(formatColor({ space: 'rec709', range: 'limited', bitDepth: 8 })).toBe('Rec.709 · limited · 8-bit');
  });

  it('shows the size and a rounded frame rate', () => {
    expect(formatFormat(3840, 2160, 59.94005994)).toBe('3840 × 2160 @ 59.94 fps');
    expect(formatFormat(1920, 1080, 60)).toBe('1920 × 1080 @ 60 fps');
  });
});
