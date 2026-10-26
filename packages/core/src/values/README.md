# Values

Values are the data widgets display: speed, lap time, laps left, G-force... Every value has an
**id**, a **name**, a **description**, a **unit** and an **initial value**, and holds **one number
per frame** of the timeline. The project lists every available value, so you can see what widgets
can use.

There are three kinds of values:

| Origin    | Where it comes from                                     | Examples                                                 |
| --------- | ------------------------------------------------------- | -------------------------------------------------------- |
| `source`  | Channels of the loaded videos and data sources          | `speed`, `gopro.speed`, `racechrono.lateralAcc`          |
| `builtin` | Computed by the engine                                  | `lap.time`, `lap.best`, `session.remaining`, `speed.kmh` |
| `script`  | Your own JavaScript, saved in the project or a template | `lap.delta`, `speed.avg5s`, `fuel.left`                  |

## Ids

Ids are dotted names: letters, digits and `_`, separated by `.` (`lap.time`, `speed_avg`).

- **`<kind>.<channel>`** — a channel of every source of that kind, merged on the timeline.
  `gopro.speed` is continuous across GoPro chapters; `racechrono.speed_obd` is the second
  "Speed" column of a RaceChrono export. Run `custom-overlay source <file>` to list channel keys.
- **`<channel>`** for standard channels (`speed`, `latitude`, `longitude`, `altitude`, `heading`,
  `distance`, `lap`, `accelLateral`, `accelLongitudinal`, ...) — the **best available** source at
  each frame: RaceChrono first, then the camera's own telemetry (DJI subtitles, then GoPro
  GPMF). If the logger stops, the value continues from the camera.
- Your scripts choose their own ids. A script with the id of a builtin or source value
  **replaces** it (the value list shows what it overrides). Project scripts replace template
  scripts with the same id.

Counters (`lap`, `satellites`, `gpsFix`) are held between samples; everything else is
interpolated linearly. Gaps longer than one second are empty.

## Built-in values

| Id                                | Unit       | Description                                                      |
| --------------------------------- | ---------- | ---------------------------------------------------------------- |
| `time.timeline`                   | s          | Timeline time of the frame                                       |
| `time.frame`                      |            | Frame index                                                      |
| `time.clock`                      | ms         | UTC epoch milliseconds (GPS / logger clock), empty when unknown  |
| `session.elapsed`                 | s          | Seconds since the start of the timeline                          |
| `session.remaining`               | s          | Seconds until the end of the timeline                            |
| `speed.kmh` / `speed.mph`         | km/h / mph | Best available speed converted                                   |
| `speed.top.kmh` / `speed.top.mph` | km/h / mph | Highest speed so far, ignoring GPS spikes (changes above 5 g)    |
| `accel.lateral`                   | g          | Logged lateral G, else from the GPS track (+ = turning right)    |
| `accel.longitudinal`              | g          | Logged longitudinal G, else from the GPS speed (+ = speeding up) |
| `accel.combined`                  | g          | Logged combined G, or `hypot(lateral, longitudinal)`             |
| `lap.number`                      |            | Current lap                                                      |
| `lap.time`                        | s          | Time since the current lap started (empty on the out lap)        |
| `lap.last`                        | s          | Last completed lap                                               |
| `lap.best`                        | s          | Best completed lap so far                                        |
| `lap.count`                       |            | Highest lap number of the session                                |
| `lap.remaining`                   |            | `lap.count − lap.number`                                         |
| `sector.number`                   |            | Current sector (track lines with sector lines only)              |
| `sector.time`                     | s          | Time since the current sector started                            |
| `sector.last`                     | s          | Last completed sector, any sector                                |
| `sector.N.last`                   | s          | Latest time of sector N (`sector.1.last`, `sector.2.last`…)      |
| `sector.N.best`                   | s          | Best time of sector N so far                                     |
| `lap.theoretical`                 | s          | Sum of the best sectors so far                                   |

Cameras have no lateral/longitudinal G: GoPro logs its accelerometer in camera axes (`accelX`,
`accelY`, `accelZ`: gravity, vibration and the mount angle included), DJI subtitles have no
accelerometer at all. Without a logger that records them, `accel.lateral`
and `accel.longitudinal` then come from the GPS track (speed change, and speed × turn rate, over
±0.4 s), which works whatever the mount. Values above 5 g are dropped as GPS glitches.

### Lap timing: logger or track lines

Every `lap.*` and `sector.*` value exists in two families:

- `imported.lap.time`, `imported.lap.number`… from the logger's own lap data. They use the exact
  lap changes of the source samples (the midpoint between the two samples around the change), not
  frame-rounded times, and need a `lap` channel (RaceChrono exports one). The logger has no sectors.
- `lines.lap.time`, `lines.sector.2.best`… from the **Track** step: a start/finish line and
  optional sector lines drawn on the GPS path. A lap or split happens where the path crosses a line,
  interpolated between GPS samples. Only crossings in the main driving direction count, and
  crossings closer than the track's minimum lap time to the previous one are ignored (GPS jitter).

The plain ids (`lap.time`, `sector.number`) follow the project setting _Lap values come from_:
automatic (the lines once a start/finish line is set, else the logger), the logger, or the lines. A
widget can override it with its _Lap timing_ setting, which makes it read `imported.*` or
`lines.*` for every lap and sector id it uses (including value-text placeholders and its show/hide
condition). Scripts can read either family directly.

Track lines can be exported as `*.track.json` and imported in another project (a project file works
too), so the lines of a circuit are drawn once.

### Data range

The project can keep only part of the session (Track step, _Data range_): from a time or the start
of a lap, to a time, the end of a lap, or leaving out the last laps. Lap bounds follow the project's
lap timing. Outside the range every value is empty (except `time.*`); inside it the session starts
over: `distance.traveled` from 0, laps numbered from 1 with `lap.count`, `lap.best` and the sector
values of the kept laps only, `session.elapsed` / `session.remaining` within the range. A widget can
use its own data range instead. Scripts read the range as `ctx.range`.

## Writing a value script

A script is the **body of a function** receiving `ctx`. It runs **once for the whole timeline**
and returns an array with one number per frame, or a single number for a constant. Return
`null`/`NaN` for "no value at this frame". `true`/`false` become `1`/`0`, which is useful for
show/hide values.

```js
// speed.kmh: best available speed in km/h
const speed = ctx.get('speed');
return speed.map((v) => v * 3.6);
```

### `ctx`

| Member             | Description                                                                                                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.frameCount`   | Number of frames                                                                                                                                                                 |
| `ctx.frameRate`    | Frames per second (the output frame rate, lower in some previews)                                                                                                                |
| `ctx.start`        | Timeline time of frame 0, in seconds (can be negative)                                                                                                                           |
| `ctx.times`        | `Float64Array` with the timeline time of each frame                                                                                                                              |
| `ctx.startEpochMs` | UTC epoch milliseconds of timeline time 0, or `null`                                                                                                                             |
| `ctx.range`        | The data range in timeline seconds, `{ start, end }` (`-Infinity` / `Infinity` when open). Values are empty outside it                                                           |
| `ctx.get(id)`      | `Float64Array` of another value, one number per frame. It's a copy you can modify. Throws for unknown ids.                                                                       |
| `ctx.has(id)`      | Whether a value exists (e.g. the session has a `lap` channel)                                                                                                                    |
| `ctx.info(id)`     | `{ id, name, description, unit, initial, origin }` of a value                                                                                                                    |
| `ctx.raw(id)`      | `{ time, values }`: original samples of a **source** value on the timeline (not resampled), `null` for computed values. Use it for maths that must not depend on the frame rate. |

Values can depend on each other in any order; each one is computed at most once. Circular
dependencies are reported as errors on every value involved.

### Examples

**Moving average over 5 seconds**

```js
const speed = ctx.get('speed.kmh');
const window = Math.max(1, Math.round(5 * ctx.frameRate));
const out = new Float64Array(ctx.frameCount);
let sum = 0;
let count = 0;
for (let i = 0; i < ctx.frameCount; i++) {
  if (!Number.isNaN(speed[i])) { sum += speed[i]; count++; }
  const old = i - window;
  if (old >= 0 && !Number.isNaN(speed[old])) { sum -= speed[old]; count--; }
  out[i] = count > 0 ? sum / count : NaN;
}
return out;
```

**Gap to the best lap at the same lap time** (simple time based delta)

```js
const lapTime = ctx.get('lap.time');
const best = ctx.get('lap.best');
const last = ctx.get('lap.last');
// Positive when the previous lap was slower than the best one.
return Array.from(lapTime, (_, i) => last[i] - best[i]);
```

**Race laps left with a known race length** (show/hide friendly)

```js
const RACE_LAPS = 20;
const lap = ctx.get('lap.number');
return Array.from(lap, (n) => (Number.isNaN(n) ? null : Math.max(0, RACE_LAPS - n)));
```

**Maximum speed so far**

```js
const speed = ctx.get('speed.kmh');
let max = NaN;
return speed.map((v) => {
  if (!Number.isNaN(v) && (Number.isNaN(max) || v > max)) max = v;
  return max;
});
```

**Show a widget only while braking hard**

```js
const longitudinal = ctx.get('accelLongitudinal');
return longitudinal.map((g) => g < -0.6);
```

### Pitfalls

- `ctx.get()` and `ctx.times` are `Float64Array`s, and `Float64Array.map` converts `null` to `0`.
  To return "no value", use `NaN`, or build a plain array with `Array.from(ctx.times, fn)`.
- Don't assume a frame rate: use `ctx.frameRate` for windows ("5 seconds" is
  `5 * ctx.frameRate` frames).
- Frames outside a source's coverage are `NaN`. Guard with `Number.isNaN` before accumulating.

## Initial value

`initial` fills every frame that has no value. With `null` the frames stay empty, so a widget can
hide itself or show a placeholder. The widget editor (next version) will also use it to preview
widgets without data.

## Files

Value scripts live in the project (`values`) or in a template (`template.values`, so a widget
template ships the values it needs). They can also be exported and imported as collections:

```json
// laps.values.json
{
  "version": 1,
  "name": "Race values",
  "values": [
    {
      "id": "race.lapsLeft",
      "name": "Race laps left",
      "description": "Laps until the end of a 20 lap race",
      "unit": "",
      "initial": null,
      "code": "const lap = ctx.get('lap.number');\nreturn Array.from(lap, (n) => Math.max(0, 20 - n));"
    }
  ]
}
```

## Trust

Scripts run as **regular JavaScript with the same permissions as the application** (in the
desktop app's main process and in the CLI). Only import collections and templates from people
you trust.

## API (TypeScript)

```ts
import { createValueEngine } from '@custom-overlay/core';
import { loadProjectMedia, readProjectFile } from '@custom-overlay/core/node';

const project = await readProjectFile('day.overlay.json');
const media = await loadProjectMedia(project);
const engine = createValueEngine(project, media); // frameRate defaults to the output frame rate
engine.list(); // ValueInfo[]
const lapTime = engine.get('lap.time'); // Float64Array, one entry per frame
const { data, errors } = engine.evaluate(); // everything
lapTime[engine.frameAt(42.5)]; // value shown at timeline time 42.5 s
```
