import {
  type DataRange,
  type DataRangeProblem,
  dataRangeKey,
  hasDataBounds,
  type ResolvedDataRange,
  resolveDataRange,
} from '../model/data-range.js';
import type { Project } from '../model/project.js';
import type { Widget } from '../model/widget.js';
import { type Lap, lapsFromSeries } from '../widgets/laps.js';
import type { ValueSeries } from '../widgets/types.js';
import type { ProjectMedia } from '../workflow/timeline.js';
import { createValueEngine, type ValueEngine, type ValueEngineOptions } from './engine.js';

/** The whole-session values of an engine, as widgets read them. */
export function engineSeries(engine: ValueEngine): ValueSeries {
  return { times: engine.grid.times, get: (id) => (engine.has(id) ? engine.get(id) : undefined) };
}

/**
 * Values of a project for its data range and for the widgets with their own: one engine per
 * distinct range, all on the same frames. Lap bounds are resolved with the laps of the whole
 * session (the project's timing source).
 */
export class ProjectValues {
  /** Values of the whole session (no data range). */
  readonly full: ValueEngine;
  private readonly engines = new Map<string, ValueEngine>();
  private readonly series = new Map<ValueEngine, ValueSeries>();
  private lapList: Lap[] | null = null;

  constructor(
    private readonly project: Project,
    private readonly media: ProjectMedia,
    private readonly options: ValueEngineOptions = {},
  ) {
    this.full = createValueEngine(project, media, options);
    this.engines.set('', this.full);
  }

  /** Laps of the whole session. */
  laps(): Lap[] {
    this.lapList ??= lapsFromSeries(engineSeries(this.full), 'lap.time', 'lap.number');
    return this.lapList;
  }

  /** A range in timeline seconds, with the bounds that could not be resolved. */
  resolve(range: DataRange | null | undefined): {
    range: ResolvedDataRange | null;
    problems: DataRangeProblem[];
  } {
    if (!range || !hasDataBounds(range)) return { range: null, problems: [] };
    return resolveDataRange(range, this.laps());
  }

  /** The engine of a data range (the whole session for none). */
  engineFor(range: DataRange | null | undefined): ValueEngine {
    const key = dataRangeKey(range);
    let engine = this.engines.get(key);
    if (!engine) {
      const resolved = this.resolve(range).range;
      engine = resolved
        ? createValueEngine(this.project, this.media, { ...this.options, dataRange: resolved })
        : this.full;
      this.engines.set(key, engine);
    }
    return engine;
  }

  /** The project's values: its data range applied. */
  get engine(): ValueEngine {
    return this.engineFor(this.project.dataRange);
  }

  /** The range a widget's values come from: its own, or the project's. */
  rangeOf(widget: Pick<Widget, 'dataRange'>): DataRange {
    return widget.dataRange ?? this.project.dataRange;
  }

  /** Series of an engine; the same object every time (renderers cache prepared data by series). */
  seriesOf(engine: ValueEngine): ValueSeries {
    let series = this.series.get(engine);
    if (!series) {
      series = engineSeries(engine);
      this.series.set(engine, series);
    }
    return series;
  }

  /** Series of a widget, for rendering. */
  seriesFor(widget: Pick<Widget, 'dataRange'>): ValueSeries {
    return this.seriesOf(this.engineFor(this.rangeOf(widget)));
  }
}
