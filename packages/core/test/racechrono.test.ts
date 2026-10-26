import { describe, expect, it } from 'vitest';
import { getChannel, sampleAt } from '../src/model/telemetry.js';
import { isRaceChronoCsv, parseRaceChronoCsv, RaceChronoParseError } from '../src/sources/racechrono.js';

const V3 = [
  'This file is created using RaceChrono v8.1.2 ( http://www.racechrono.com/ ).',
  'Format,3',
  'Session title,"Track day, morning"',
  'Session type,Lap timing',
  'Track name,"Interlagos"',
  'Created,01/05/2024,10:00',
  '',
  'Timestamp,Fragment ID,Lap #,Elapsed time,Distance traveled,Latitude,Longitude,Speed,Lateral acc,Speed,Device update rate',
  'unix time,,,s,m,deg,deg,m/s,G,km/h,Hz',
  ',,,,,100: gps,100: gps,100: gps,calc,200: obd,100: gps',
  '1714557600.000,0,1,0.000,0.0,-23.70,-46.69,10.0,0.10,36,25',
  '1714557600.040,0,1,0.040,0.4,,,,,,',
  '1714557600.100,0,1,0.100,1.0,-23.71,-46.70,12.0,0.20,43.2,25',
  '1714557600.200,0,2,0.200,2.2,-23.72,-46.71,14.0,0.30,50.4,25',
].join('\r\n');

describe('RaceChrono CSV', () => {
  const series = parseRaceChronoCsv(V3, 'file.csv');

  it('reads metadata and absolute start time', () => {
    expect(series.kind).toBe('racechrono');
    expect(series.name).toBe('Track day, morning');
    expect(series.metadata['Track name']).toBe('Interlagos');
    expect(series.startEpochMs).toBe(Date.UTC(2024, 4, 1, 10));
  });

  it('maps columns to standard channels', () => {
    const keys = series.channels.map((c) => c.key);
    expect(keys).toEqual([
      'lap',
      'elapsedTime',
      'distance',
      'latitude',
      'longitude',
      'speed',
      'accelLateral',
      'speed_obd',
    ]);
    expect(getChannel(series, 'accelLateral')?.unit).toBe('g');
  });

  it('drops empty cells per channel and keeps full channels on the shared time axis', () => {
    const speed = getChannel(series, 'speed');
    expect(Array.from(speed?.time ?? [])).toEqual([0, expect.closeTo(0.1, 6), expect.closeTo(0.2, 6)]);
    expect(getChannel(series, 'distance')?.time).toHaveLength(4);
  });

  it('converts km/h speeds to m/s', () => {
    const obd = getChannel(series, 'speed_obd');
    expect(obd?.unit).toBe('m/s');
    expect(obd?.values[0]).toBeCloseTo(10, 6);
  });

  it('interpolates values', () => {
    expect(sampleAt(getChannel(series, 'speed')!, 0.05)).toBeCloseTo(11, 6);
  });

  it('supports relative time exports with units in the header', () => {
    const csv = 'Time (s),Speed (km/h),Latitude (deg)\n0,36,1\n1,72,2\n';
    const relative = parseRaceChronoCsv(csv, 'old.csv');
    expect(relative.startEpochMs).toBeNull();
    expect(relative.name).toBe('old.csv');
    expect(getChannel(relative, 'speed')?.values[1]).toBeCloseTo(20, 6);
  });

  it('detects and rejects files', () => {
    expect(isRaceChronoCsv(V3)).toBe(true);
    expect(isRaceChronoCsv('a,b\n1,2')).toBe(false);
    expect(() => parseRaceChronoCsv('a,b\n1,2')).toThrow(RaceChronoParseError);
    expect(() => parseRaceChronoCsv('Timestamp,Speed,Lat\nunix time,m/s,deg\n')).toThrow(/no data rows/);
  });
});
