import { resolve } from 'node:path';
import { createValueEngine, type ValueScript } from '@custom-overlay/core';
import {
  loadProjectMedia,
  readProjectFile,
  readValueCollection,
  writeProjectFile,
  writeValueCollection,
} from '@custom-overlay/core/node';
import type { Command } from 'commander';
import { formatValue, table } from './format.js';

function parseNumber(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`expected a number, got '${value}'`);
  return n;
}

/** `custom-overlay values ...`: list, export and import value scripts. */
export function registerValuesCommands(program: Command, printJson: (value: unknown) => void): void {
  const values = program
    .command('values')
    .description('Values available to widgets (sources, built-ins, scripts)');

  values
    .command('list')
    .description('List every value of a project with its value at a timeline time')
    .argument('<project>', 'project file')
    .option('--at <seconds>', 'timeline time to show values at (default: timeline start)', parseNumber)
    .option('--rate <fps>', 'frame rate to evaluate at (default: project output frame rate)', parseNumber)
    .option('--json', 'output JSON')
    .action(async (file: string, options: { at?: number; rate?: number; json?: boolean }) => {
      const project = await readProjectFile(resolve(file));
      const media = await loadProjectMedia(project);
      const engine = createValueEngine(project, media, options.rate ? { frameRate: options.rate } : {});
      const { data, errors } = engine.evaluate();
      const time = options.at ?? engine.grid.start;
      const frame = engine.frameAt(time);
      const infos = engine.list();
      if (options.json) {
        return printJson({
          time,
          grid: { start: engine.grid.start, frameRate: engine.grid.frameRate, count: engine.grid.count },
          values: infos.map((info) => ({
            ...info,
            value: data[info.id]?.[frame] ?? null,
            error: errors[info.id],
          })),
        });
      }
      console.log(
        `Values at ${time.toFixed(3)} s (frame ${frame} of ${engine.grid.count} at ${engine.grid.frameRate} fps)\n`,
      );
      const rows = infos.map((info) => [
        info.id,
        info.name,
        info.origin + (info.overrides ? ` (replaces ${info.overrides})` : ''),
        errors[info.id]
          ? `error: ${errors[info.id]}`
          : formatValue(data[info.id]?.[frame] ?? Number.NaN, info.unit),
      ]);
      console.log(table(['id', 'name', 'origin', 'value'], rows));
    });

  values
    .command('export')
    .description('Export the value scripts of a project as a collection (*.values.json)')
    .argument('<project>', 'project file')
    .argument('<output>', 'collection file to write')
    .option('--name <name>', 'collection name')
    .action(async (file: string, output: string, options: { name?: string }) => {
      const project = await readProjectFile(resolve(file));
      await writeValueCollection(resolve(output), {
        version: 1,
        name: options.name ?? `${project.name} values`,
        values: project.values,
      });
      console.log(`${project.values.length} value scripts written to ${resolve(output)}`);
    });

  values
    .command('import')
    .description('Add the scripts of a collection to a project (same ids are replaced)')
    .argument('<project>', 'project file')
    .argument('<collection>', 'collection file (*.values.json)')
    .action(async (file: string, collectionFile: string) => {
      const path = resolve(file);
      const project = await readProjectFile(path);
      const collection = await readValueCollection(resolve(collectionFile));
      const ids = new Set(collection.values.map((v) => v.id));
      const merged: ValueScript[] = [...project.values.filter((v) => !ids.has(v.id)), ...collection.values];
      await writeProjectFile(path, { ...project, values: merged });
      console.log(`Imported ${collection.values.length} value scripts from '${collection.name}'`);
    });
}
