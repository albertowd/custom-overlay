import type { ValueSeries } from './types.js';

/**
 * Synthetic session used to preview widgets without data: a two minute lap of a figure-of-eight
 * circuit with matching speed, G-forces, altitude, distance and clock.
 */
export function createSampleSeries(durationSeconds = 120, frameRate = 30): ValueSeries {
  const n = Math.max(2, Math.round(durationSeconds * frameRate) + 1);
  const times = new Float64Array(n).map((_, i) => i / frameRate);
  const lapSeconds = 60;
  const values: Record<string, Float64Array> = {};
  const series = (fn: (t: number, i: number) => number) => times.map((t, i) => fn(t, i));

  const phase = (t: number) => ((t % lapSeconds) / lapSeconds) * Math.PI * 2;
  values.latitude = series((t) => 42.43 + 0.004 * Math.sin(phase(t)));
  values.longitude = series((t) => -8.65 + 0.006 * Math.sin(phase(t) * 2));
  values.speed = series((t) => 30 + 12 * Math.cos(phase(t) * 3) + 4 * Math.sin(phase(t) * 7));
  values['speed.kmh'] = values.speed.map((v) => v * 3.6);
  values['speed.mph'] = values.speed.map((v) => v * 2.236936);
  let top = 0;
  values['speed.top.kmh'] = values['speed.kmh'].map((v) => {
    top = Math.max(top, v);
    return top;
  });
  values['speed.top.mph'] = values['speed.top.kmh'].map((v) => (v / 3.6) * 2.236936);
  values.accelLateral = series((t) => 1.1 * Math.sin(phase(t) * 2));
  values.accelLongitudinal = series((t) => -0.9 * Math.sin(phase(t) * 3 + 0.4));
  values['accel.lateral'] = values.accelLateral;
  values['accel.longitudinal'] = values.accelLongitudinal;
  values['accel.combined'] = values.accelLateral.map((v, i) =>
    Math.hypot(v, values.accelLongitudinal?.[i] ?? 0),
  );
  values.altitude = series((t) => 120 + 25 * Math.sin(phase(t)) + 6 * Math.sin(phase(t) * 5));
  let distance = 0;
  values['distance.traveled'] = series((_, i) => {
    if (i > 0) distance += ((values.speed?.[i] ?? 0) + (values.speed?.[i - 1] ?? 0)) / 2 / frameRate;
    return distance;
  });
  values.distance = values['distance.traveled'];
  const clockStart = Date.UTC(2024, 4, 1, 13, 37, 0);
  values['time.clock'] = series((t) => clockStart + t * 1000);
  values['time.timeline'] = times;
  values['time.frame'] = series((_, i) => i);
  values['session.elapsed'] = times;
  values['session.remaining'] = series((t) => durationSeconds - t);
  values['lap.number'] = series((t) => Math.floor(t / lapSeconds) + 1);
  values.lap = values['lap.number'];
  values['lap.time'] = series((t) => t % lapSeconds);
  values['lap.last'] = series((t) => (t >= lapSeconds ? lapSeconds - 0.512 : Number.NaN));
  values['lap.best'] = values['lap.last'];
  values['lap.count'] = series(() => Math.ceil(durationSeconds / lapSeconds));
  values['lap.remaining'] = series(
    (t) => Math.ceil(durationSeconds / lapSeconds) - Math.floor(t / lapSeconds) - 1,
  );
  // Three sectors of 20 s.
  const sectorSeconds = lapSeconds / 3;
  values['sector.number'] = series((t) => Math.floor((t % lapSeconds) / sectorSeconds) + 1);
  values['sector.time'] = series((t) => t % sectorSeconds);
  values['sector.last'] = series((t) => (t >= sectorSeconds ? sectorSeconds - 0.17 : Number.NaN));
  for (const n of [1, 2, 3]) {
    const done = (t: number) => t >= (n - 1) * sectorSeconds + sectorSeconds;
    values[`sector.${n}.last`] = series((t) => (done(t) ? sectorSeconds - 0.17 : Number.NaN));
    values[`sector.${n}.best`] = values[`sector.${n}.last`] as Float64Array;
  }
  values['lap.theoretical'] = series((t) => (t >= lapSeconds ? lapSeconds - 0.51 : Number.NaN));
  // Both timing families show the same sample laps.
  for (const id of Object.keys(values).filter((key) => /^(lap|sector)\./.test(key))) {
    values[`imported.${id}`] = values[id] as Float64Array;
    values[`lines.${id}`] = values[id] as Float64Array;
  }

  return { times, get: (id) => values[id] };
}
