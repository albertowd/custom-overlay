# Widgets

Widgets are the visual elements of the overlay: gauges, maps, text, images. A **template** is a
collection of widgets (plus the [value scripts](../values/README.md) they need) that you can reuse
across sessions: "my car overlay", "my plane overlay". The same template renders in the desktop
editor, in exports, and from the CLI.

- [Concepts](#concepts)
- [Built-in widgets](#built-in-widgets)
- [Files: import and export](#files-import-and-export)
- [Writing a widget type](#writing-a-widget-type)
- [Rendering API](#rendering-api)

## Concepts

**Placement.** `x`, `y`, `width` and `height` are fractions of the output frame (0 to 1), so a
template made for 1080p works unchanged in 4K. The output frame is the canvas set in the Template
step (16:9, 9:16 for TikTok / Reels, 4:5...), with the videos fitted into it. Widgets with a fixed
shape (`aspectRatio`: gauges, G-force, live map) keep their pixel aspect when resized in the editor
and when the canvas changes shape. `defaultSize` is for a 16:9 frame: on other shapes a new widget
gets the same size relative to the frame's short side.

**Anchor.** Each widget has an anchor: a corner, an edge middle or the centre (`anchor`, default
`top-left`). The editor's X / Y show where the anchor sits, and resizing (fields or handle) keeps
the anchor in place: anchor _centre_ at X 50 %, Y 50 % centres a widget, anchor _right_ at X 98 %
pins its right edge. `x` / `y` are stored as the top-left corner whatever the anchor.

**Guides.** A template can define snap lines (`guides`): the frame split into columns and rows,
a safe-area margin, and extra lines in %. While dragging or resizing, widget edges and centres
snap to them and to the frame edges (toggle _Snap to guides_; hold Alt to flip it for one drag).
Guides are only shown in the editor, never rendered.

**Order.** Widgets are drawn in template order: the first one is at the back.

**Values.** Widgets read [values](../values/README.md) by id (`speed.kmh`, `lap.time`,
`racechrono.lateralAcc`…), one number per frame. Every value input of a widget is a setting, so a
gauge can show RPM, a text can show your own script value, and so on.

**Data range.** The project's data range (only part of the session: from lap 2, without the last
laps...) applies to every widget, unless a widget sets its own (`dataRange`; null follows the
project). See [the values guide](../values/README.md#data-range).

**Visible range.** The template has a time range (`visibleRange`, timeline seconds, open bounds
allowed) outside which no widget is drawn, e.g. to start the overlay when the race starts. A widget
can set its own range instead (`visibleRange` on the widget; null follows the template).

**Show / hide.** Each widget can be shown only while a value _has a value_, _is not zero_,
_is zero_, _is positive_ or _is negative_. For example, a "PIT" text shown while a `pit` value is
1, or a lap timer hidden on the out lap.

**Colors.** Color settings take either a **palette key** (`primary`, `secondary`, `accent`, `text`,
`textMuted`, `background`, `positive`, `negative`, `warning`), which follows the project palette,
or an explicit hex color (`#ff0000`), which overrides it for that widget only. Restyle a whole
overlay by changing the palette.

**Transparent background.** Widgets draw on a transparent canvas. Most have an optional
background panel in the palette's `background` color.

**Lap timing.** A widget that reads lap or sector values (`lap.*`, `sector.*`) follows the
project's timing source (Track step) unless its _Lap timing_ is set to the logger or the track
lines: it then reads `imported.*` or `lines.*` instead, e.g. two lap timers side by side comparing
both. See [the values guide](../values/README.md#lap-timing-logger-or-track-lines).

**Anti-aliasing.** When enabled (template default, or per widget), a widget is drawn at 2× size
and scaled down, which smooths edges and thin lines. Disable it for pixel-art or very large
overlays.

**Editing without data.** The editor previews widgets with a synthetic two-minute session (speed,
G-forces, a figure-of-eight GPS track, altitude, laps, clock) when the project has no data, or when
_Sample data_ is ticked. Typed **test values** replace any value to check extreme cases (a 300 km/h
gauge, a 2.5 g corner).

## Built-in widgets

| Type id         | Name          | Reads                                 | Highlights                                                                                                                                                                                                                               |
| --------------- | ------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `speed-gauge`   | Speed gauge   | `speed.kmh`                           | Needle (a line, your own image turned around a pivot, or none for a clean centre), arc, major/minor ticks, digital readout. Maximum and tick step automatic from the session. Works for any value (RPM, G…).                             |
| `g-force`       | G-force       | `accel.lateral`, `accel.longitudinal` | Friction circle with rings, fading trail of the last seconds, combined G readout; axes can be inverted.                                                                                                                                  |
| `gps-path`      | GPS path      | `latitude`, `longitude`, `heading`    | Whole session path (north up), progress so far highlighted, current position as a dot or your own marker image (car, kart…) turned by the heading.                                                                                       |
| `live-map`      | Live map      | `latitude`, `longitude`, `heading`    | Map following the current position within a radius, or the whole track. Heading-up (map rotates) or north-up (marker rotates). Marker can be your own image. Heading is computed from the path when there is no heading value.           |
| `distance-bar`  | Distance bar  | `distance.traveled`                   | Progress bar of the distance covered with tick marks and labels, in km, m or mi. Major ticks every tick step, or at each lap start labelled with the lap number (`lap.time`, `lap.number`).                                              |
| `elevation`     | Elevation     | `altitude`                            | Current altitude with the elevation profile of the session and a position marker, in m or ft.                                                                                                                                            |
| `lap-timer`     | Lap timer     | `lap.time`, `lap.number`              | Running time of the current lap. A finished lap stays on screen for a few seconds (5 by default) with its gap to the best or previous lap, in the best-lap color when it is a new best.                                                  |
| `lap-count`     | Lap count     | `lap.number`, `lap.count`             | Current lap and total laps (`LAP 3 / 12`), the total smaller in its own color; optional label, dashes or hidden before the first lap.                                                                                                    |
| `lap-table`     | Lap times     | `lap.time`, `lap.number`              | Lap times with the gap to the best lap: the laps done so far or the whole session (future laps dimmed). The current lap is highlighted with its running time and, when its length is known, a progress fill. Scrolls to keep it in view. |
| `date-time`     | Date and time | `time.clock`                          | Clock time of the frame and optional date, with custom formats and timezone.                                                                                                                                                             |
| `timespan`      | Timespan      | `time.clock` or `time.timeline`       | Time since a start (a date/time or a timeline position). Before the start: count down, show zero, or hide.                                                                                                                               |
| `value-text`    | Value text    | any                                   | Text with placeholders: `{speed.kmh\|0} km/h`, `Lap {lap.number}  {lap.time\|duration}`.                                                                                                                                                 |
| `text`          | Text          | —                                     | Static text.                                                                                                                                                                                                                             |
| `image`         | Image         | —                                     | Static PNG, JPEG, WebP, GIF or SVG; contain/cover/stretch, rounded corners.                                                                                                                                                              |
| `dynamic-image` | Dynamic image | any                                   | An image rotated, moved and scaled by values: a steering wheel turned by the steering angle, a needle, a car icon…                                                                                                                       |
| `shape`         | Shape         | —                                     | Solid colour background without an image: rectangle, rounded rectangle, ellipse, slanted parallelogram, triangle, diamond or hexagon; optional border, or border only.                                                                   |

### Text formats

`value-text` placeholders are `{value.id}` or `{value.id|format}`. Use `{{` for a literal `{`.

| Format                    | Example                        | Output                                       |
| ------------------------- | ------------------------------ | -------------------------------------------- |
| _(none)_                  | `{speed.kmh}`                  | up to 2 decimals: `123.46`                   |
| `0`, `0.0`, `0.00`…       | `{speed.kmh\|0}`               | fixed decimals: `123`                        |
| `duration`, `duration.0`… | `{lap.time\|duration}`         | `1:23.456` (or `1:23.5`)                     |
| `clock:pattern`           | `{time.clock\|clock:HH:mm:ss}` | clock time, tokens `YYYY MM DD HH mm ss SSS` |

When a value is missing the placeholder shows the widget's _Without value_ text (`—`).

### Images

Images are embedded in the template as data URLs (up to 5 MB each), so a template file carries
everything it needs and can be shared as a single file.

## Files: import and export

| File              | Content                                                               | How                                                                                  |
| ----------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `*.template.json` | A collection of widgets + value scripts + style (font, anti-aliasing) | Template step: _Save template as…_ / _Load template…_; CLI `custom-overlay template` |
| `*.widget.json`   | One widget                                                            | Widget inspector: _Export…_; widget list: _Import…_                                  |

_Import…_ in the widget list accepts a single widget **or a whole template**: its widgets are added
to the current template (with new ids), so collections can be merged.

```json
// speed.widget.json
{
  "version": 1,
  "widget": {
    "id": "w-lx3k2a1",
    "type": "speed-gauge",
    "name": "Speed",
    "x": 0.02, "y": 0.62, "width": 0.16, "height": 0.284,
    "opacity": 1,
    "visible": true,
    "showWhen": null,
    "antialias": null,
    "timing": null,
    "colors": {},
    "props": { "valueId": "speed.kmh", "label": "km/h", "max": 0, "color": "primary" }
  }
}
```

Unknown or invalid `props` fall back to the type defaults one by one, so templates keep working
when a widget type gains new settings.

## Writing a widget type

A widget type declares its settings as a [zod](https://zod.dev) schema (with defaults), the editor
fields, the values it reads, and a `render` function drawing **one frame** on a
[Canvas 2D context](https://developer.mozilla.org/docs/Web/API/CanvasRenderingContext2D).

```ts
import { defineWidget, drawPanel, registerWidgetType } from '@custom-overlay/core';
import { z } from 'zod';

/** Shift lights: LEDs light up as RPM approaches the limit. */
export const shiftLights = defineWidget({
  type: 'shift-lights',
  name: 'Shift lights',
  description: 'A row of LEDs lighting up with RPM.',
  category: 'data',
  defaultSize: { width: 0.3, height: 0.05 },
  schema: z.object({
    valueId: z.string().default('rpm'),
    from: z.number().default(6000),
    to: z.number().default(8000),
    leds: z.number().int().min(2).max(20).default(10),
  }),
  fields: [
    { key: 'valueId', label: 'RPM value', kind: 'value' },
    { key: 'from', label: 'First LED at', kind: 'number' },
    { key: 'to', label: 'Last LED at', kind: 'number' },
    { key: 'leds', label: 'LEDs', kind: 'number', min: 2, max: 20 },
  ],
  inputs: (props) => [props.valueId],
  render(ctx, frame) {
    const { props } = frame;
    drawPanel(ctx, frame);
    const rpm = frame.value(props.valueId);
    const lit = Math.round(((rpm - props.from) / (props.to - props.from)) * props.leds);
    const gap = frame.width / props.leds;
    for (let i = 0; i < props.leds; i++) {
      const color = i < props.leds * 0.6 ? 'positive' : i < props.leds * 0.85 ? 'warning' : 'negative';
      ctx.beginPath();
      ctx.arc(gap * (i + 0.5), frame.height / 2, Math.min(gap, frame.height) * 0.35, 0, Math.PI * 2);
      ctx.fillStyle = i < lit ? frame.color(color) : frame.color('textMuted');
      ctx.globalAlpha = i < lit ? 1 : 0.25;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  },
});

registerWidgetType(shiftLights);
```

Rules of thumb:

- Draw inside `(0, 0, frame.width, frame.height)`; the background is transparent.
- Size everything relative to the box: `frame.unit` is 1% of the smaller side.
- Read colors through `frame.color(ref)` so palette keys and overrides work.
- Missing values are `NaN`: render a placeholder (`—`) or nothing, never throw.
- Heavy work (paths, profiles, totals) goes in `prepare`. It receives every frame's values once
  and its result is cached until the data or the settings change.
- `frame.editing` is true in the editor only: use it for placeholders that must not be exported.

### Field kinds

| `kind`             | Editor                                                                                                   | Value    |
| ------------------ | -------------------------------------------------------------------------------------------------------- | -------- |
| `number`           | number input (`min`, `max`, `step`)                                                                      | number   |
| `time`             | timeline position as `HH:MM:SS.mmm`, typed right to left (`530` = 0.530 s, `2:30`, `5:23:` = 5 h 23 min) | seconds  |
| `text`, `textarea` | text input                                                                                               | string   |
| `boolean`          | checkbox                                                                                                 | boolean  |
| `select`           | drop-down (`options: [value, label][]`)                                                                  | string   |
| `color`            | palette key or custom color                                                                              | string   |
| `value`            | value id with suggestions                                                                                | string   |
| `image`            | file picker                                                                                              | data URL |

## Rendering API

| `frame` member       | Description                                                        |
| -------------------- | ------------------------------------------------------------------ |
| `props`              | Settings, validated, defaults applied                              |
| `width`, `height`    | Box size in pixels (2× when anti-aliased)                          |
| `unit`               | 1% of the smaller side, in pixels                                  |
| `palette`            | Project palette with the widget's overrides                        |
| `color(ref)`         | CSS color of a palette key or hex color                            |
| `font(size, weight)` | CSS font with the template font family                             |
| `value(id)`          | Value at the current frame (`NaN` when missing; test values first) |
| `time`, `frameIndex` | Timeline time and frame index of the frame                         |
| `prepared`           | Result of `prepare`                                                |
| `image(src)`         | Decoded image of a data URL, `undefined` while loading             |
| `utcOffsetMinutes`   | Timezone to show clock values in (this computer's by default)      |
| `editing`            | `true` in the editor                                               |

Drawing helpers: `drawPanel`, `drawDisc`, `drawTextBox`, `fitText`, `roundRectPath`, `fitRect`,
`withAlpha`, `niceStep`, `niceCeil`, `minOf`, `maxOf`. Formatting: `formatNumber`,
`formatDuration`, `formatClock`, `formatTemplate`, `parseClock`.

`renderOverlay(ctx, options)` draws a whole template for one frame. The desktop preview and the
exporter both use it; errors are reported per widget and never stop the others.

## Roadmap

- Scripted widgets: render code written in the editor and stored in the template, like
  value scripts.
- 3D widgets (WebGL), and more built-ins (lap list, delta bar, RPM / shift lights, steering).
