import { FULL_DATA_RANGE, inDataRange, type ResolvedDataRange } from '../model/data-range.js';
import type { Project } from '../model/project.js';
import type { ValueScript } from '../model/values.js';
import { computeTimeline, type ProjectMedia } from '../workflow/timeline.js';
import { BUILTIN_VALUES } from './builtins.js';
import { rawBinding, sampleBinding, sourceBindings } from './sources.js';
import { timingValues } from './timing.js';
import type { FrameGrid, RawSamples, ValueContext, ValueInfo, ValueOutput } from './types.js';

interface Provider {
  info: ValueInfo;
  compute(ctx: ValueContext): ValueOutput;
  raw?: () => RawSamples;
}

export interface ValueEngineOptions {
  /** Frames per second to evaluate at (default: the project output frame rate). */
  frameRate?: number;
  /** Value scripts, lowest priority first (e.g. template values, then project values). */
  scripts?: readonly ValueScript[];
  /** Data range in timeline seconds; the whole session by default. */
  dataRange?: ResolvedDataRange;
}

export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValueError';
  }
}

/** Frames covering the whole timeline at `frameRate`. */
export function frameGrid(start: number, end: number, frameRate: number): FrameGrid {
  const count = end > start ? Math.floor((end - start) * frameRate + 1e-9) + 1 : 0;
  const times = new Float64Array(count);
  for (let i = 0; i < count; i++) times[i] = start + i / frameRate;
  return { start, frameRate, count, times };
}

/** Turn whatever a computation returned into one number per frame. */
export function normalizeOutput(output: ValueOutput, count: number): Float64Array {
  if (output === null || output === undefined) return new Float64Array(count).fill(Number.NaN);
  if (typeof output === 'number') return new Float64Array(count).fill(output);
  if (typeof output === 'boolean') return new Float64Array(count).fill(output ? 1 : 0);
  if (typeof output === 'object' && typeof output.length === 'number') {
    if (output.length !== count) {
      throw new ValueError(`returned ${output.length} values, expected one per frame (${count})`);
    }
    const out = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const v = output[i];
      if (typeof v === 'number') out[i] = v;
      else if (typeof v === 'boolean') out[i] = v ? 1 : 0;
      else out[i] = Number.NaN;
    }
    return out;
  }
  throw new ValueError('must return a number, null, or an array with one number per frame');
}

/** Compile a value script body into a function of `ctx`. Scripts are trusted code. */
export function compileValueScript(script: ValueScript): (ctx: ValueContext) => ValueOutput {
  try {
    // Value scripts are user authored, trusted code by design (see "Trust" in src/values/README.md).
    const compiled = new Function('ctx', `"use strict";\n${script.code}`); // NOSONAR: trusted scripts
    return compiled as (ctx: ValueContext) => ValueOutput;
  } catch (error) {
    throw new ValueError(`syntax error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Lazily evaluates values on a frame grid. Every value is computed at most once; scripts can read
 * other values by id, circular dependencies are reported as errors.
 */
export class ValueEngine {
  readonly grid: FrameGrid;
  private readonly providers = new Map<string, Provider>();
  private readonly cache = new Map<string, Float64Array>();
  private readonly failures = new Map<string, string>();
  private readonly stack: string[] = [];
  private readonly context: ValueContext;
  readonly range: ResolvedDataRange;

  constructor(project: Project, media: ProjectMedia, options: ValueEngineOptions = {}) {
    const timeline = computeTimeline(project, media);
    this.grid = frameGrid(timeline.start, timeline.end, options.frameRate ?? project.output.frameRate);
    this.range = options.dataRange ?? FULL_DATA_RANGE;

    for (const binding of sourceBindings(project, media)) {
      this.register({
        info: binding.info,
        compute: () => sampleBinding(binding, this.grid.times),
        raw: () => rawBinding(binding),
      });
    }
    for (const builtin of [...BUILTIN_VALUES, ...timingValues(project.track)]) {
      this.register({
        info: { initial: null, ...builtin.info, origin: 'builtin' },
        compute: builtin.compute,
      });
    }
    for (const script of options.scripts ?? []) this.registerScript(script);

    this.context = {
      frameCount: this.grid.count,
      frameRate: this.grid.frameRate,
      start: this.grid.start,
      times: this.grid.times,
      startEpochMs: timeline.startEpochMs,
      range: this.range,
      get: (id) => this.get(id).slice(),
      has: (id) => this.providers.has(id),
      info: (id) => this.providers.get(id)?.info,
      raw: (id) => this.providers.get(id)?.raw?.() ?? null,
    };
  }

  private register(provider: Provider): void {
    const existing = this.providers.get(provider.info.id);
    const info = existing ? { ...provider.info, overrides: existing.info.origin } : provider.info;
    this.providers.set(info.id, { ...provider, info });
  }

  private registerScript(script: ValueScript): void {
    let compiled: ((ctx: ValueContext) => ValueOutput) | null = null;
    let compileError: string | null = null;
    try {
      compiled = compileValueScript(script);
    } catch (error) {
      compileError = error instanceof Error ? error.message : String(error);
    }
    this.register({
      info: {
        id: script.id,
        name: script.name,
        description: script.description,
        unit: script.unit,
        initial: script.initial,
        origin: 'script',
      },
      compute: (ctx) => {
        if (!compiled) throw new ValueError(compileError ?? 'invalid script');
        return compiled(ctx);
      },
    });
  }

  /** Every available value, sorted by id. */
  list(): ValueInfo[] {
    return [...this.providers.values()].map((p) => p.info).sort((a, b) => a.id.localeCompare(b.id));
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  /** Per frame values (do not modify). Failed values are all NaN; see `error()`. */
  get(id: string): Float64Array {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const provider = this.providers.get(id);
    if (!provider) throw new ValueError(`unknown value '${id}'`);
    if (this.stack.includes(id)) {
      const cycle = [...this.stack.slice(this.stack.indexOf(id)), id];
      const message = `circular dependency: ${cycle.join(' → ')}`;
      for (const member of cycle) this.failures.set(member, message);
      throw new ValueError(message);
    }
    this.stack.push(id);
    let data: Float64Array;
    try {
      data = normalizeOutput(provider.compute(this.context), this.grid.count);
    } catch (error) {
      if (!this.failures.has(id))
        this.failures.set(id, error instanceof Error ? error.message : String(error));
      data = new Float64Array(this.grid.count).fill(Number.NaN);
    } finally {
      this.stack.pop();
    }
    const { initial } = provider.info;
    if (initial !== null) for (let i = 0; i < data.length; i++) if (Number.isNaN(data[i])) data[i] = initial;
    // No data outside the data range (the timeline and the clock are not data).
    if (!id.startsWith('time.') && (this.range.start > -Infinity || this.range.end < Infinity)) {
      const { times } = this.grid;
      for (let i = 0; i < data.length; i++)
        if (!inDataRange(this.range, times[i] as number)) data[i] = Number.NaN;
    }
    this.cache.set(id, data);
    return data;
  }

  /** Error of a value evaluated so far, undefined when it succeeded. */
  error(id: string): string | undefined {
    return this.failures.get(id);
  }

  /** Evaluate the given values (all by default). */
  evaluate(ids: readonly string[] = [...this.providers.keys()]): {
    data: Record<string, Float64Array>;
    errors: Record<string, string>;
  } {
    const data: Record<string, Float64Array> = {};
    const errors: Record<string, string> = {};
    for (const id of ids) {
      if (!this.providers.has(id)) {
        errors[id] = `unknown value '${id}'`;
        continue;
      }
      data[id] = this.get(id);
      const failure = this.failures.get(id);
      if (failure) errors[id] = failure;
    }
    return { data, errors };
  }

  /** Index of the frame shown at a timeline time. */
  frameAt(time: number): number {
    const index = Math.round((time - this.grid.start) * this.grid.frameRate);
    return Math.min(Math.max(index, 0), Math.max(this.grid.count - 1, 0));
  }
}

/** Value scripts of a project: template values first, project values override them. */
export function projectScripts(project: Project): ValueScript[] {
  return [...project.template.values, ...project.values];
}

export function createValueEngine(
  project: Project,
  media: ProjectMedia,
  options: ValueEngineOptions = {},
): ValueEngine {
  return new ValueEngine(project, media, { scripts: projectScripts(project), ...options });
}
