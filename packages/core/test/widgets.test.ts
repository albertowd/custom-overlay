import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PALETTE, resolveColor } from '../src/model/palette.js';
import { createTemplate, type Template } from '../src/model/project.js';
import { WidgetSchema } from '../src/model/widget.js';
import { headings, projectPath } from '../src/widgets/builtin/gps-path.js';
import { fitRect, niceCeil, niceStep, withAlpha } from '../src/widgets/draw.js';
import {
  formatClock,
  formatDuration,
  formatNumber,
  formatTemplate,
  formatTimecode,
  formatWithPattern,
  parseClock,
  parseTimeInput,
  templateValueIds,
} from '../src/widgets/format.js';
import { bestLapTime, formatDelta, lapIndexAt, lapsFromSeries } from '../src/widgets/laps.js';
import {
  BUILTIN_WIDGET_TYPES,
  createWidget,
  getWidgetType,
  resolveWidgetProps,
  widgetInputs,
} from '../src/widgets/registry.js';
import {
  createPreparedCache,
  type RenderOverlayOptions,
  renderOverlay,
  showWhenHolds,
} from '../src/widgets/render.js';
import { createSampleSeries } from '../src/widgets/samples.js';
import type { ValueSeries } from '../src/widgets/types.js';
import { recordingContext } from './helpers/canvas.js';

const series = createSampleSeries(120, 30);

function options(template: Template, overrides: Partial<RenderOverlayOptions> = {}): RenderOverlayOptions {
  return {
    width: 1920,
    height: 1080,
    template,
    palette: DEFAULT_PALETTE,
    frame: { series, frameIndex: 900, time: 30 },
    utcOffsetMinutes: 0,
    ...overrides,
  };
}

describe('format', () => {
  it('formats numbers, durations and clocks', () => {
    expect(formatNumber(12.345, 1)).toBe('12.3');
    expect(formatNumber(Number.NaN)).toBe('—');
    expect(formatDuration(83.4567)).toBe('1:23.457');
    expect(formatDuration(5.2, 1)).toBe('0:05.2');
    expect(formatDuration(3725, 0)).toBe('1:02:05');
    expect(formatDuration(Number.NaN)).toBe('—:——');
    const t = Date.UTC(2024, 4, 1, 13, 7, 9, 45);
    expect(formatClock(t, 'DD/MM/YYYY HH:mm:ss.SSS', 0)).toBe('01/05/2024 13:07:09.045');
    expect(formatClock(t, 'HH:mm', -180)).toBe('10:07');
  });

  it('reads typed times from right to left', () => {
    expect(parseTimeInput('530')).toBe(0.53);
    expect(parseTimeInput('2530')).toBe(2.53);
    expect(parseTimeInput('1012530')).toBe(612.53);
    expect(parseTimeInput('10112530')).toBe(3672.53);
    expect(parseTimeInput('2.530')).toBe(2.53);
    expect(parseTimeInput('150.5')).toBe(150.5);
    expect(parseTimeInput('.5')).toBe(0.5);
    expect(parseTimeInput('2:30')).toBe(150);
    expect(parseTimeInput('2:30.250')).toBe(150.25);
    expect(parseTimeInput('5:23:')).toBe(5 * 3600 + 23 * 60);
    expect(parseTimeInput('00:00:00.530')).toBe(0.53);
    expect(parseTimeInput('1:90')).toBe(150);
    expect(parseTimeInput(' -1:02.5 ')).toBe(-62.5);
    for (const bad of ['', ':', 'abc', '1:2:3:4', '1.2.3', '1:2.3:4', '1:a'])
      expect(parseTimeInput(bad)).toBeNaN();
  });

  it('formats timecodes', () => {
    expect(formatTimecode(0.53)).toBe('00:00:00.530');
    expect(formatTimecode(5 * 3600 + 23 * 60)).toBe('05:23:00.000');
    expect(formatTimecode(-62.5)).toBe('-00:01:02.500');
    expect(formatTimecode(59.9996)).toBe('00:01:00.000');
    expect(formatTimecode(Number.NaN)).toBe('--:--:--.---');
  });

  it('fills value templates', () => {
    const values: Record<string, number> = {
      'speed.kmh': 123.456,
      'lap.time': 75.5,
      'time.clock': Date.UTC(2024, 0, 1, 8),
    };
    const value = (id: string) => values[id] ?? Number.NaN;
    expect(formatTemplate('{speed.kmh|0} km/h', value, 0)).toBe('123 km/h');
    expect(formatTemplate('Lap {lap.time|duration.0} ({speed.kmh|0.00})', value, 0)).toBe(
      'Lap 1:15.5 (123.46)',
    );
    expect(formatTemplate('{time.clock|clock:HH:mm} {nope} {{x}', value, 60, 'n/a')).toBe('09:00 n/a {x}');
    expect(formatTemplate('{speed.kmh}', value, 0)).toBe('123.46');
    expect(templateValueIds('{a.b|0} {c} {{d} {a.b}')).toEqual(['a.b', 'c']);
    expect(formatWithPattern(Number.NaN, '0', 0, '?')).toBe('?');
  });
});

describe('drawing helpers', () => {
  it('computes nice scales, fits and colors', () => {
    expect(niceCeil(187)).toBe(200);
    expect(niceCeil(0)).toBe(1);
    expect(niceStep(7.3, 5)).toBe(1);
    expect(niceStep(240, 6)).toBe(50);
    expect(fitRect(200, 100, 100, 100, 'contain')).toEqual({ x: 0, y: 25, width: 100, height: 50 });
    expect(fitRect(200, 100, 100, 100, 'cover')).toEqual({ x: -50, y: 0, width: 200, height: 100 });
    expect(fitRect(200, 100, 100, 100, 'stretch')).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(withAlpha('#ff0000', 0.5)).toBe('#ff000080');
    expect(withAlpha('#ff000080', 0.5)).toBe('#ff000040');
    expect(withAlpha('red', 0.5)).toBe('red');
    expect(resolveColor('primary', DEFAULT_PALETTE)).toBe(DEFAULT_PALETTE.primary);
    expect(resolveColor('#123456', DEFAULT_PALETTE)).toBe('#123456');
    expect(resolveColor('nope', DEFAULT_PALETTE)).toBe(DEFAULT_PALETTE.text);
  });

  it('projects GPS paths to local meters', () => {
    const lat = Float64Array.from([42, 42.001, Number.NaN, 0]);
    const lon = Float64Array.from([-8, -8, -8, 0]);
    const path = projectPath(lat, lon);
    expect(path.bounds?.maxY ?? 0 - (path.bounds?.minY ?? 0)).toBeGreaterThan(0);
    expect((path.ys[0] as number) - (path.ys[1] as number)).toBeCloseTo(111.2, 0);
    expect(path.xs[2]).toBeNaN();
    expect(path.xs[3]).toBeNaN();
    expect(projectPath(undefined, undefined).bounds).toBeNull();
  });
});

describe('widget model', () => {
  it('fills widget defaults and keeps type props', () => {
    const widget = WidgetSchema.parse({ id: 'w1', type: 'text', props: { text: 'Hi', future: 1 } });
    expect(widget).toMatchObject({
      x: 0.05,
      opacity: 1,
      visible: true,
      showWhen: null,
      antialias: null,
      colors: {},
    });
    expect(widget.props).toEqual({ text: 'Hi', future: 1 });
    expect(createTemplate().antialias).toBe(true);
  });

  it('creates widgets with defaults and resolves props with fallbacks', () => {
    const gauge = createWidget('speed-gauge');
    expect(gauge.props).toMatchObject({ valueId: 'speed.kmh', max: 0 });
    expect(gauge.x + gauge.width / 2).toBeCloseTo(0.5, 6);
    const type = getWidgetType('speed-gauge');
    if (!type) throw new Error('missing type');
    const props = resolveWidgetProps({ ...gauge, props: { valueId: 'rpm', sweep: 'wide' } }, type);
    expect(props).toMatchObject({ valueId: 'rpm', sweep: 270 });
    expect(() => createWidget('nope')).toThrow(/Unknown widget type/);
    expect(
      widgetInputs({
        ...createWidget('value-text', { props: { template: '{a} {b|0}' } }),
        showWhen: { valueId: 'c', condition: 'has-value' },
      }),
    ).toEqual(['a', 'b', 'c']);
  });

  it('evaluates show conditions', () => {
    expect(showWhenHolds({ valueId: 'x', condition: 'has-value' }, Number.NaN)).toBe(false);
    expect(showWhenHolds({ valueId: 'x', condition: 'non-zero' }, 0)).toBe(false);
    expect(showWhenHolds({ valueId: 'x', condition: 'zero' }, 0)).toBe(true);
    expect(showWhenHolds({ valueId: 'x', condition: 'positive' }, 2)).toBe(true);
    expect(showWhenHolds({ valueId: 'x', condition: 'negative' }, 2)).toBe(false);
  });
});

describe('rendering', () => {
  it.each(BUILTIN_WIDGET_TYPES.map((t) => t.type))('renders %s with sample data', (typeId) => {
    const { ctx, calls } = recordingContext();
    const template = createTemplate({ widgets: [createWidget(typeId)] });
    const report = renderOverlay(ctx, options(template, { editing: true }));
    expect(report).toEqual({});
    expect(calls.length).toBeGreaterThan(0);
  });

  it('renders without data', () => {
    const { ctx } = recordingContext();
    const template = createTemplate({ widgets: BUILTIN_WIDGET_TYPES.map((t) => createWidget(t.type)) });
    const empty = { times: new Float64Array(0), get: () => undefined };
    expect(
      renderOverlay(ctx, options(template, { frame: { series: empty, frameIndex: -1, time: 0 } })),
    ).toEqual({});
  });

  it('writes values into text widgets', () => {
    const rec = recordingContext();
    const widgets = [
      createWidget('value-text', { props: { template: 'Lap {lap.number}' } }),
      createWidget('date-time'),
      createWidget('text', { props: { text: 'Hello', uppercase: true } }),
    ];
    renderOverlay(rec.ctx, options(createTemplate({ widgets })));
    expect(rec.texts()).toEqual(expect.arrayContaining(['Lap 1', '13:37:30', '01/05/2024', 'HELLO']));
  });

  it('uses test values before real values', () => {
    const rec = recordingContext();
    const widget = createWidget('value-text', { props: { template: '{speed.kmh|0}' } });
    renderOverlay(
      rec.ctx,
      options(createTemplate({ widgets: [widget] }), { testValues: { 'speed.kmh': 321 } }),
    );
    expect(rec.texts()).toContain('321');
  });

  it('skips hidden widgets and reports unknown types', () => {
    const rec = recordingContext();
    const widgets = [
      createWidget('text', { visible: false }),
      createWidget('text', { showWhen: { valueId: 'lap.last', condition: 'has-value' } }),
      { ...createWidget('text'), type: 'nope' },
    ];
    const report = renderOverlay(rec.ctx, options(createTemplate({ widgets })));
    expect(rec.calls).toHaveLength(0);
    expect(Object.values(report)).toEqual(["unknown widget type 'nope'"]);
    const shown = recordingContext();
    renderOverlay(shown.ctx, options(createTemplate({ widgets }), { ignoreShowWhen: true }));
    expect(shown.texts()).toEqual(['Text']);
  });

  it('draws images, and a placeholder only while editing', () => {
    const src = 'data:image/png;base64,AAAA';
    const widget = createWidget('image', { props: { src, cornerRadius: 10 } });
    const template = createTemplate({ widgets: [widget] });
    const loaded = recordingContext();
    renderOverlay(
      loaded.ctx,
      options(template, { image: () => ({ width: 200, height: 100 }) as CanvasImageSource }),
    );
    expect(loaded.count('drawImage')).toBe(1);
    expect(loaded.count('clip')).toBe(1);

    const editing = recordingContext();
    renderOverlay(editing.ctx, options(template, { editing: true }));
    expect(editing.count('strokeRect')).toBe(1);
    const exporting = recordingContext();
    renderOverlay(exporting.ctx, options(template));
    expect(exporting.count('strokeRect') + exporting.count('drawImage')).toBe(0);
  });

  it('anti-aliases by supersampling into a scratch canvas', () => {
    const target = recordingContext();
    const scratch = recordingContext();
    const createCanvas = vi.fn(() => ({ canvas: {} as CanvasImageSource, ctx: scratch.ctx }));
    const widget = createWidget('text', { x: 0, y: 0, width: 0.1, height: 0.1 });
    renderOverlay(target.ctx, options(createTemplate({ widgets: [widget] }), { createCanvas }));
    expect(createCanvas).toHaveBeenCalledWith(384, 216);
    expect(target.calls.find((c) => c.method === 'drawImage')?.args.slice(1)).toEqual([0, 0, 192, 108]);
    expect(scratch.texts()).toEqual(['Text']);

    const direct = recordingContext();
    renderOverlay(
      direct.ctx,
      options(createTemplate({ widgets: [{ ...widget, antialias: false }] }), { createCanvas }),
    );
    expect(direct.texts()).toEqual(['Text']);
  });

  it('prepares once per data and props', () => {
    const type = getWidgetType('gps-path');
    if (!type?.prepare) throw new Error('missing prepare');
    const spy = vi.spyOn(type, 'prepare');
    const cache = createPreparedCache();
    const widget = createWidget('gps-path');
    const template = createTemplate({ widgets: [widget] });
    for (let i = 0; i < 3; i++) renderOverlay(recordingContext().ctx, options(template, { cache }));
    expect(spy).toHaveBeenCalledTimes(1);
    renderOverlay(
      recordingContext().ctx,
      options(createTemplate({ widgets: [{ ...widget, props: { ...widget.props, lineWidth: 3 } }] }), {
        cache,
      }),
    );
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});

describe('timespan, dynamic image and live map', () => {
  const render = (widget: ReturnType<typeof createWidget>, overrides: Partial<RenderOverlayOptions> = {}) => {
    const rec = recordingContext();
    const report = renderOverlay(rec.ctx, options(createTemplate({ widgets: [widget] }), overrides));
    expect(report).toEqual({});
    return rec;
  };

  it('parses wall clock date/times in a timezone', () => {
    expect(parseClock('2024-05-01 13:37:00', 0)).toBe(Date.UTC(2024, 4, 1, 13, 37));
    expect(parseClock('2024-05-01T10:37:00.5', -180)).toBe(Date.UTC(2024, 4, 1, 13, 37, 0, 500));
    expect(parseClock('soon', 0)).toBeNaN();
  });

  it('counts down to the start, then up', () => {
    // Sample clock starts 13:37:00; frame 900 at 30 fps is 13:37:30.
    const clock = { reference: 'clock', startClock: '2024-05-01 13:37:40', timezone: 'utc' };
    expect(render(createWidget('timespan', { props: clock })).texts()).toEqual(['-0:10.0']);
    expect(render(createWidget('timespan', { props: { ...clock, beforeStart: 'zero' } })).texts()).toEqual([
      '0:00.0',
    ]);
    const hidden = render(createWidget('timespan', { props: { ...clock, beforeStart: 'hide' } }));
    expect(hidden.texts()).toEqual([]);
    expect(hidden.count('fill')).toBe(0);
    const timeline = createWidget('timespan', { props: { startTimeline: 12.5, label: 'Race', decimals: 2 } });
    expect(render(timeline).texts()).toEqual(['RACE', '0:17.50']);
  });

  it('moves, rotates and scales images by values', () => {
    const widget = createWidget('dynamic-image', {
      props: {
        src: 'data:x',
        rotateId: 'steer',
        rotateScale: 2,
        translateXId: 'dx',
        scaleId: 'zoom',
        scaleFactor: 0.5,
      },
    });
    const image = () => ({ width: 10, height: 10 }) as CanvasImageSource;
    const rec = render(widget, { image, testValues: { steer: 45, dx: 10, zoom: 2 } });
    expect(rec.calls.find((c) => c.method === 'rotate')?.args[0]).toBeCloseTo(Math.PI / 2, 6);
    expect(rec.calls.find((c) => c.method === 'scale')?.args).toEqual([2, 2]);
    expect(rec.count('drawImage')).toBe(1);
    expect(render(createWidget('dynamic-image'), { editing: true }).count('strokeRect')).toBe(1);
  });

  it('computes headings from the path when there is no heading value', () => {
    // Moving east (x+) then north (y-).
    const xs = Float64Array.from([0, 10, 20, 20, 20]);
    const ys = Float64Array.from([0, 0, 0, -10, -20]);
    const computed = headings(xs, ys, undefined, 2);
    expect(computed[0]).toBeCloseTo(90, 6);
    expect(computed[4]).toBeCloseTo(0, 6);
    expect(headings(xs, ys, Float64Array.from([1, 2, 3, 4, 5]), 2)[2]).toBe(3);
  });

  it('rotates the live map or its marker with the heading', () => {
    const headingUp = render(createWidget('live-map'));
    const northUp = render(
      createWidget('live-map', { props: { orientation: 'north-up', markerSrc: 'data:x' } }),
      {
        image: () => ({ width: 10, height: 20 }) as CanvasImageSource,
      },
    );
    expect(headingUp.count('rotate')).toBe(2);
    expect(northUp.count('drawImage')).toBe(1);
    expect(northUp.texts()).toContain('N');
  });
});

describe('distance bar and speed gauge', () => {
  const render = (widget: ReturnType<typeof createWidget>, overrides: Partial<RenderOverlayOptions> = {}) => {
    const rec = recordingContext();
    expect(renderOverlay(rec.ctx, options(createTemplate({ widgets: [widget] }), overrides))).toEqual({});
    return rec;
  };

  it('shows the distance total without a slash', () => {
    const texts = render(createWidget('distance-bar', { props: { total: 3.7 } })).texts();
    expect(texts).toContain('3.70 km');
    expect(texts.some((t) => t.includes('/'))).toBe(false);
  });

  it('draws the needle as a line with its hub, an image, or nothing', () => {
    // Without the background and the readout, the only discs are the hub.
    const base = { background: false, showDigital: false, showLabels: false };
    const line = render(createWidget('speed-gauge', { props: base }));
    expect(line.count('arc')).toBe(3); // track, value, hub
    const none = render(createWidget('speed-gauge', { props: { ...base, needle: 'none' } }));
    expect(none.count('arc')).toBe(2);
    expect(none.count('stroke')).toBe(line.count('stroke') - 1);

    const image = () => ({ width: 20, height: 100 }) as CanvasImageSource;
    const needle = render(
      createWidget('speed-gauge', {
        props: { ...base, needle: 'image', needleSrc: 'data:x', needlePivot: 20 },
      }),
      { image },
    );
    expect(needle.count('drawImage')).toBe(1);
    expect(needle.count('arc')).toBe(2);
    // Pivot 20 % from the bottom: 80 % of the image is above the centre.
    const [, x, y, w, h] = (needle.calls.find((c) => c.method === 'drawImage')?.args ?? []) as number[];
    expect(y).toBeCloseTo(-(h as number) * 0.8, 6);
    expect(x).toBeCloseTo(-(w as number) / 2, 6);
    expect((w as number) / (h as number)).toBeCloseTo(0.2, 6);
    // Without the image yet (loading): nothing in the middle, no error.
    const loading = render(
      createWidget('speed-gauge', { props: { ...base, needle: 'image', needleSrc: 'data:x' } }),
    );
    expect(loading.count('drawImage')).toBe(0);
  });
});

describe('visible ranges', () => {
  // Frame at time 30 (see options()).
  const texts = (template: Template) => {
    const rec = recordingContext();
    renderOverlay(rec.ctx, options(template));
    return rec.texts();
  };
  const text = (name: string, overrides: Partial<ReturnType<typeof createWidget>> = {}) =>
    createWidget('text', { props: { text: name }, ...overrides });

  it('draws the widgets only inside the template range', () => {
    expect(texts(createTemplate({ widgets: [text('A')] }))).toEqual(['A']);
    expect(texts(createTemplate({ widgets: [text('A')], visibleRange: { start: 10, end: 40 } }))).toEqual([
      'A',
    ]);
    expect(texts(createTemplate({ widgets: [text('A')], visibleRange: { start: 31, end: null } }))).toEqual(
      [],
    );
    expect(texts(createTemplate({ widgets: [text('A')], visibleRange: { start: null, end: 30 } }))).toEqual(
      [],
    );
  });

  it('lets a widget use its own range', () => {
    const template = createTemplate({
      visibleRange: { start: 100, end: null },
      widgets: [text('template'), text('own', { visibleRange: { start: 0, end: 60 } })],
    });
    expect(texts(template)).toEqual(['own']);
    const rec = recordingContext();
    renderOverlay(rec.ctx, options(template, { ignoreShowWhen: true }));
    expect(rec.texts()).toEqual(['template', 'own']);
  });
});

describe('shape', () => {
  it.each(['rectangle', 'rounded', 'ellipse', 'parallelogram', 'triangle', 'diamond', 'hexagon'])(
    'draws a %s',
    (kind) => {
      const rec = recordingContext();
      const widget = createWidget('shape', { props: { shape: kind, borderWidth: 2 } });
      expect(renderOverlay(rec.ctx, options(createTemplate({ widgets: [widget] })))).toEqual({});
      expect(rec.count('fill')).toBe(1);
      expect(rec.count('stroke')).toBe(1);
    },
  );

  it('keeps a border inside the box and can draw the border only', () => {
    const rec = recordingContext();
    // 1920 × 1080 frame, default 0.25 × 0.1 box: 480 × 108 px, unit 1.08 px.
    const widget = createWidget('shape', { props: { shape: 'rectangle', borderWidth: 10, fill: false } });
    renderOverlay(rec.ctx, options(createTemplate({ widgets: [widget] })));
    expect(rec.count('fill')).toBe(0);
    const rect = rec.calls.find((c) => c.method === 'rect')?.args as number[];
    expect(rect[0]).toBeCloseTo(5.4, 6);
    expect(rect[2]).toBeCloseTo(480 - 10.8, 6);
  });

  it('slants parallelograms both ways', () => {
    const corners = (slant: number) => {
      const rec = recordingContext();
      const widget = createWidget('shape', { props: { shape: 'parallelogram', slant } });
      renderOverlay(rec.ctx, options(createTemplate({ widgets: [widget] })));
      return rec.calls.filter((c) => c.method === 'moveTo' || c.method === 'lineTo').map((c) => c.args);
    };
    // Height 108 px, slant 50 % = 54 px.
    expect(corners(50)).toEqual([
      [54, 0],
      [480, 0],
      [426, 108],
      [0, 108],
    ]);
    expect(corners(-50)).toEqual([
      [0, 0],
      [426, 0],
      [480, 108],
      [54, 108],
    ]);
  });
});

describe('g-force', () => {
  it('reads accel.* values, also for widgets saved with the raw channel ids', () => {
    const legacy = createWidget('g-force', {
      props: { lateralId: 'accelLateral', longitudinalId: 'accelLongitudinal' },
    });
    expect(widgetInputs(legacy)).toEqual(['accel.lateral', 'accel.longitudinal']);
    expect(widgetInputs(createWidget('g-force'))).toEqual(['accel.lateral', 'accel.longitudinal']);
    const custom = createWidget('g-force', { props: { lateralId: 'my.lat' } });
    expect(widgetInputs(custom)).toEqual(['my.lat', 'accel.longitudinal']);
  });
});

describe('maps and distance bar', () => {
  const render = (widget: ReturnType<typeof createWidget>, overrides: Partial<RenderOverlayOptions> = {}) => {
    const rec = recordingContext();
    const report = renderOverlay(rec.ctx, options(createTemplate({ widgets: [widget] }), overrides));
    expect(report).toEqual({});
    return rec;
  };
  const image = () => ({ width: 10, height: 20 }) as CanvasImageSource;

  it('shows the whole track on the live map, north up with a rotating marker', () => {
    const whole = render(createWidget('live-map', { props: { view: 'whole', markerSrc: 'data:x' } }), {
      image,
    });
    // The map is not rotated; the marker image is.
    const rotations = whole.calls.filter((c) => c.method === 'rotate').map((c) => c.args[0]);
    expect(rotations[0]).toBe(0);
    expect(rotations[1]).not.toBe(0);
    expect(whole.count('drawImage')).toBe(1);
  });

  it('draws a marker image on the GPS path, a dot without one', () => {
    expect(
      render(createWidget('gps-path', { props: { markerSrc: 'data:x' } }), { image }).count('drawImage'),
    ).toBe(1);
    expect(render(createWidget('gps-path')).count('arc')).toBe(2);
  });

  it('draws the end tick of the distance bar when the total is not a multiple of the step', () => {
    const rec = render(createWidget('distance-bar', { props: { total: 3.7, tickStep: 1, minorTicks: 0 } }));
    // 0, 1, 2, 3 and the end; the 3 label would overlap the end label.
    expect(rec.count('stroke')).toBe(5);
    expect(rec.texts()).toEqual(expect.arrayContaining(['0', '1', '2', '3.7']));
    expect(rec.texts()).not.toContain('3');
    const exact = render(createWidget('distance-bar', { props: { total: 4, tickStep: 1, minorTicks: 0 } }));
    expect(exact.count('stroke')).toBe(5);
    expect(exact.texts()).toEqual(expect.arrayContaining(['0', '1', '2', '3', '4']));
  });
});

describe('lap widgets', () => {
  // 10 fps; out lap until 5 s, laps of 60 s, 58 s and 61 s, then an unfinished lap from 184 s.
  const starts = [5, 65, 123, 184];
  const laps: ValueSeries = (() => {
    const times = new Float64Array(2001).map((_, i) => i / 10);
    const lapTime = times.map((t) => {
      const start = [...starts].reverse().find((s) => s <= t + 1e-9);
      return start === undefined ? Number.NaN : t - start;
    });
    const lapNumber = times.map((t) => starts.filter((s) => s <= t + 1e-9).length || Number.NaN);
    const values: Record<string, Float64Array> = { 'lap.time': lapTime, 'lap.number': lapNumber };
    return { times, get: (id) => values[id] };
  })();
  const at = (time: number) => ({ series: laps, frameIndex: Math.round(time * 10), time });
  const render = (widget: ReturnType<typeof createWidget>, time: number) => {
    const rec = recordingContext();
    const report = renderOverlay(
      rec.ctx,
      options(createTemplate({ widgets: [widget] }), { frame: at(time) }),
    );
    expect(report).toEqual({});
    return rec;
  };

  it('finds laps from the lap time', () => {
    const found = lapsFromSeries(laps, 'lap.time', 'lap.number');
    expect(found.map((l) => l.number)).toEqual([1, 2, 3, 4]);
    expect(found[0]?.start).toBeCloseTo(5, 6);
    expect(found.map((l) => l.duration).slice(0, 3)).toEqual([
      expect.closeTo(60, 6),
      expect.closeTo(58, 6),
      expect.closeTo(61, 6),
    ]);
    expect(found[3]?.duration).toBeNaN();
    expect(lapIndexAt(found, 2)).toBe(-1);
    expect(lapIndexAt(found, 130)).toBe(2);
    expect(bestLapTime(found, 100)).toBeCloseTo(60, 6);
    expect(bestLapTime(found)).toBeCloseTo(58, 6);
    expect(lapsFromSeries(laps, 'nope', 'lap.number')).toEqual([]);
    expect(formatDelta(-1.0504, 3)).toBe('-1.050');
    expect(formatDelta(0.0001, 3)).toBe('+0.000');
    expect(formatDelta(Number.NaN)).toBe('');
  });

  it('runs the lap timer and holds a finished lap with its gap', () => {
    const timer = createWidget('lap-timer');
    expect(render(timer, 30).texts()).toEqual(['LAP 1', '0:25.000']);
    // Lap 2 (58 s) finished at 123 s: held for 5 s, a new best, 2 s faster.
    expect(render(timer, 125).texts()).toEqual(['LAP 2', '-2.000', '0:58.000']);
    expect(render(timer, 129).texts()).toEqual(['LAP 3', '0:06.000']);
    const previous = createWidget('lap-timer', { props: { delta: 'previous', holdSeconds: 2 } });
    expect(render(previous, 185).texts()).toEqual(['LAP 3', '+3.000', '1:01.000']);
    expect(render(createWidget('lap-timer', { props: { holdSeconds: 0 } }), 125).texts()).toEqual([
      'LAP 3',
      '0:02.000',
    ]);
    expect(render(timer, 2).texts()).toEqual(['-:--']);
    const hidden = render(createWidget('lap-timer', { props: { beforeFirstLap: 'hide' } }), 2);
    expect(hidden.texts()).toEqual([]);
    expect(hidden.count('fill')).toBe(0);
  });

  /** The lap series plus 4 laps in total and 20 m/s of distance (4 km at 200 s). */
  const race: ValueSeries = {
    times: laps.times,
    get: (id) => {
      if (id === 'lap.count') return laps.times.map(() => 4);
      if (id === 'distance.traveled') return laps.times.map((t) => t * 20);
      return laps.get(id);
    },
  };
  const renderRace = (widget: ReturnType<typeof createWidget>, time: number) => {
    const rec = recordingContext();
    const frame = { series: race, frameIndex: Math.round(time * 10), time };
    expect(renderOverlay(rec.ctx, options(createTemplate({ widgets: [widget] }), { frame }))).toEqual({});
    return rec;
  };

  it('counts the current lap out of the total', () => {
    const count = createWidget('lap-count');
    expect(renderRace(count, 130).texts()).toEqual(['LAP', '3', ' / 4']);
    expect(renderRace(count, 2).texts()).toEqual(['LAP', '-', ' / 4']);
    const hidden = renderRace(createWidget('lap-count', { props: { beforeFirstLap: 'hide' } }), 2);
    expect(hidden.texts()).toEqual([]);
    expect(hidden.count('fill')).toBe(0);
    const bare = createWidget('lap-count', { props: { label: '', showTotal: false } });
    expect(renderRace(bare, 130).texts()).toEqual(['3']);
  });

  it('puts the distance bar major ticks at the lap starts', () => {
    const bar = createWidget('distance-bar', { props: { ticks: 'laps', showValue: false } });
    const rec = renderRace(bar, 30);
    // Laps start at 0.1, 1.3, 2.46 and 3.68 km: a major and a minor tick each, then the end.
    expect(rec.count('stroke')).toBe(9);
    // The lap 4 label would overlap the end label.
    expect(rec.texts()).toEqual(['1', '2', '3', '4.0']);
    expect(widgetInputs(bar)).toEqual(['distance.traveled', 'lap.time', 'lap.number']);
    expect(widgetInputs(createWidget('distance-bar'))).toEqual(['distance.traveled']);
  });

  it('lists the laps done so far with the current one running', () => {
    const table = createWidget('lap-table', { props: { decimals: 1 } });
    expect(render(table, 130).texts()).toEqual([
      'LAP',
      'TIME',
      'GAP',
      '1',
      '1:00.0',
      '+2.0',
      '2',
      '0:58.0',
      '3',
      '0:07.0',
    ]);
    const newest = createWidget('lap-table', {
      props: { decimals: 1, order: 'newest-first', showHeader: false },
    });
    expect(render(newest, 130).texts().slice(0, 2)).toEqual(['3', '0:07.0']);
  });

  it('shows the whole session with the progress of the current lap', () => {
    const table = createWidget('lap-table', { props: { mode: 'session', decimals: 0, showHeader: false } });
    const rec = render(table, 95);
    // Lap 2 is half done: highlight plus a progress fill of half the width.
    expect(rec.texts()).toEqual(['1', '1:00', '+2', '2', '0:30', '3', '1:01', '+3', '4', '-:--']);
    expect(rec.count('fill')).toBe(3);
  });

  it('scrolls to keep the current lap in view', () => {
    const table = createWidget('lap-table', { props: { mode: 'session', rows: 2, showHeader: false } });
    expect(
      render(table, 190)
        .texts()
        .filter((_, i) => i % 3 === 0),
    ).toEqual(['3', '4']);
    expect(render(table, 10).texts()[0]).toBe('1');
  });
});
