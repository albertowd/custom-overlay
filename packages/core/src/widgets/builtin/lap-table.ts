import { z } from 'zod';
import { drawPanel, fitText, roundRectPath, withAlpha } from '../draw.js';
import { formatDuration } from '../format.js';
import { bestLapTime, formatDelta, type Lap, lapFinished, lapIndexAt, lapsFromSeries } from '../laps.js';
import { defineWidget } from '../types.js';

export const lapTable = defineWidget({
  type: 'lap-table',
  name: 'Lap times',
  description:
    'Table of lap times with the gap to the best lap: the laps done so far, or the whole session. The current lap is highlighted with its running time and progress.',
  category: 'data',
  defaultSize: { width: 0.2, height: 0.3 },
  schema: z.object({
    lapTimeId: z.string().default('lap.time'),
    lapNumberId: z.string().default('lap.number'),
    mode: z.enum(['so-far', 'session']).default('so-far'),
    /** Rows shown at once; the table scrolls to keep the current lap visible. */
    rows: z.number().int().min(1).max(30).default(6),
    order: z.enum(['oldest-first', 'newest-first']).default('oldest-first'),
    showCurrent: z.boolean().default(true),
    showDelta: z.boolean().default(true),
    showHeader: z.boolean().default(true),
    decimals: z.number().int().min(0).max(3).default(3),
    color: z.string().default('text'),
    currentColor: z.string().default('primary'),
    bestColor: z.string().default('accent'),
    background: z.boolean().default(true),
  }),
  fields: [
    { key: 'lapTimeId', label: 'Lap time value (s)', kind: 'value' },
    { key: 'lapNumberId', label: 'Lap number value', kind: 'value' },
    {
      key: 'mode',
      label: 'Laps',
      kind: 'select',
      options: [
        ['so-far', 'Done so far'],
        ['session', 'Whole session'],
      ],
      hint: 'Whole session: future laps are dimmed',
    },
    { key: 'rows', label: 'Rows', kind: 'number', min: 1, max: 30 },
    {
      key: 'order',
      label: 'Order',
      kind: 'select',
      options: [
        ['oldest-first', 'Oldest first'],
        ['newest-first', 'Newest first'],
      ],
    },
    { key: 'showCurrent', label: 'Current lap row', kind: 'boolean' },
    { key: 'showDelta', label: 'Gap to best', kind: 'boolean' },
    { key: 'showHeader', label: 'Header', kind: 'boolean' },
    { key: 'decimals', label: 'Decimals', kind: 'number', min: 0, max: 3 },
    { key: 'color', label: 'Text', kind: 'color' },
    { key: 'currentColor', label: 'Current lap', kind: 'color' },
    { key: 'bestColor', label: 'Best lap', kind: 'color' },
    { key: 'background', label: 'Background panel', kind: 'boolean' },
  ],
  inputs: (props) => [props.lapTimeId, props.lapNumberId],
  prepare: ({ props, values }): Lap[] => lapsFromSeries(values, props.lapTimeId, props.lapNumberId),
  render(ctx, frame) {
    const { props, prepared: laps } = frame;
    if (props.background) drawPanel(ctx, frame);
    const time = frame.time;
    const currentIndex = lapIndexAt(laps, time);
    const sessionMode = props.mode === 'session';
    // Best of what the viewer has seen so far, or of the whole session.
    const best = sessionMode ? bestLapTime(laps) : bestLapTime(laps, time);

    let shown = laps.map((lap, index) => ({ lap, index }));
    if (!sessionMode) {
      shown = shown.filter(({ lap, index }) => lapFinished(lap, time) || index === currentIndex);
    }
    if (!props.showCurrent) shown = shown.filter(({ index }) => index !== currentIndex);
    if (props.order === 'newest-first') shown.reverse();

    // Scroll so the current lap (else the latest one) stays in view, a row before the edge.
    const focus = Math.max(
      0,
      shown.findIndex(({ index }) => index === Math.max(currentIndex, 0)),
    );
    const maxFirst = Math.max(0, shown.length - props.rows);
    const lead = props.order === 'newest-first' ? 1 : props.rows - 2;
    const first = Math.min(maxFirst, Math.max(0, focus - Math.max(0, lead)));
    const visible = shown.slice(first, first + props.rows);

    const lines = props.rows + (props.showHeader ? 1 : 0);
    const pad = frame.unit * 5;
    const rowH = (frame.height - pad * 2) / lines;
    const width = frame.width - pad * 2;
    const columns = props.showDelta ? [0.2, 0.45, 0.35] : [0.3, 0.7, 0];
    const lapRight = pad + width * (columns[0] as number);
    const timeRight = lapRight + width * (columns[1] as number);
    const deltaRight = frame.width - pad;
    const textSize = rowH * 0.6;
    const cellPad = width * 0.03;
    ctx.textBaseline = 'middle';

    let y = pad;
    const cell = (text: string, right: number, share: number, color: string, weight = 600) => {
      ctx.textAlign = 'right';
      ctx.fillStyle = color;
      fitText(ctx, frame, text, right - cellPad, y + rowH / 2, width * share - cellPad, textSize, weight);
    };

    if (props.showHeader) {
      const muted = frame.color('textMuted');
      cell('LAP', lapRight, columns[0] as number, muted, 700);
      cell('TIME', timeRight, columns[1] as number, muted, 700);
      if (props.showDelta) cell('GAP', deltaRight, columns[2] as number, muted, 700);
      y += rowH;
    }

    if (laps.length === 0) {
      cell('-:--', timeRight, columns[1] as number, frame.color('textMuted'));
      return;
    }

    for (const { lap, index } of visible) {
      const isCurrent = index === currentIndex;
      const done = lapFinished(lap, time);
      const future = index > currentIndex;
      if (isCurrent) {
        const highlight = frame.color(props.currentColor);
        roundRectPath(ctx, pad, y + rowH * 0.06, width, rowH * 0.88, rowH * 0.2);
        ctx.fillStyle = withAlpha(highlight, 0.25);
        ctx.fill();
        // Where the video is in the lap, when the lap length is known.
        const progress = Number.isFinite(lap.duration) ? (time - lap.start) / lap.duration : Number.NaN;
        if (progress > 0) {
          roundRectPath(ctx, pad, y + rowH * 0.06, width * Math.min(1, progress), rowH * 0.88, rowH * 0.2);
          ctx.fillStyle = withAlpha(highlight, 0.55);
          ctx.fill();
        }
      }
      const isBestLap = lap.duration === best;
      const isBest = done && isBestLap;
      const base = frame.color(future ? 'textMuted' : props.color);
      const shownTime = isCurrent && !done ? time - lap.start : lap.duration;
      cell(String(lap.number), lapRight, columns[0] as number, base, 700);
      cell(
        formatDuration(shownTime, props.decimals, '-:--'),
        timeRight,
        columns[1] as number,
        isBest ? frame.color(props.bestColor) : base,
        isCurrent ? 800 : 600,
      );
      if (props.showDelta && (done || future) && Number.isFinite(lap.duration) && !isBestLap) {
        const gap = lap.duration - best;
        cell(
          formatDelta(gap, props.decimals),
          deltaRight,
          columns[2] as number,
          future ? base : frame.color(gap > 0 ? 'negative' : 'positive'),
        );
      }
      y += rowH;
    }
  },
});
