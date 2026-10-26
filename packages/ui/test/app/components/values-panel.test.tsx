import { createProject, type ValueScript } from '@custom-overlay/core';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ValuesPanel } from '../../../src/app/components/ValuesPanel';
import { t } from '../../../src/app/i18n';
import { useStore } from '../../../src/app/store';
import { resetStore, snapshot, valueInfo } from './form-helpers';

const importValues = vi.fn(async () => undefined);
const exportValues = vi.fn(async () => undefined);

const script: ValueScript = {
  id: 'speed.kmh',
  name: 'Speed km/h',
  description: 'Speed converted',
  unit: 'km/h',
  initial: null,
  code: 'return 1;',
};

const values = snapshot({
  values: [
    valueInfo('speed.kmh', 'script', { name: 'Speed km/h', description: 'Speed converted', unit: 'km/h' }),
    valueInfo('broken', 'script', { name: 'Broken' }),
    valueInfo('speed', 'builtin', { unit: 'm/s', overrides: 'source' }),
    valueInfo('gopro.temp', 'source', { name: 'Camera temperature', unit: 'C' }),
  ],
  data: { 'speed.kmh': [36, 72], speed: [10, 20], 'gopro.temp': [40, 41] },
  errors: { broken: 'ReferenceError: x is not defined' },
});

beforeEach(() => {
  importValues.mockClear();
  exportValues.mockClear();
  resetStore({ importValues, exportValues });
});

/** Row of a value, by the id shown in its header. */
const row = (id: string) =>
  screen
    .getAllByText(id)
    .find((e) => e.classList.contains('mono'))
    ?.closest('tr') as HTMLTableRowElement;

describe('ValuesPanel', () => {
  it('waits for the first evaluation, nothing to export yet', async () => {
    const user = userEvent.setup();
    render(<ValuesPanel />);
    expect(screen.getByText(t('values.panel.evaluating'))).toBeTruthy();
    expect((screen.getByRole('button', { name: t('common.export') }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await user.click(screen.getByRole('button', { name: t('common.import') }));
    expect(importValues).toHaveBeenCalled();
  });

  it('shows why the values could not be evaluated', () => {
    useStore.setState({ valuesError: 'Media not loaded' });
    render(<ValuesPanel />);
    expect(screen.getByText('Media not loaded')).toBeTruthy();
    expect(screen.queryByText(t('values.panel.evaluating'))).toBeNull();
  });

  it('groups the values by origin with their value at the playhead', async () => {
    const user = userEvent.setup();
    useStore.setState({ values, currentTime: 0.1, project: { ...createProject(), values: [script] } });
    render(<ValuesPanel />);
    const groups = screen.getAllByRole('group');
    expect(groups.map((g) => g.querySelector('summary')?.textContent)).toEqual([
      `${t('values.groups.script')} (2)`,
      `${t('values.groups.builtin')} (1)`,
      `${t('values.groups.source')} (1)`,
    ]);
    expect(groups.map((g) => (g as HTMLDetailsElement).open)).toEqual([true, true, false]);
    expect(within(row('speed.kmh')).getByText('72 km/h')).toBeTruthy();
    expect(within(row('speed')).getByText('72.0 km/h')).toBeTruthy();
    expect(row('speed').title).toContain(t('values.panel.replaces', { origin: t('values.origins.source') }));
    expect(within(row('gopro.temp')).getByText('41 C')).toBeTruthy();
    expect(row('gopro.temp').title).toBe('Camera temperature');

    expect(screen.getByText(t('values.panel.failed', { count: 1 }))).toBeTruthy();
    expect(row('broken').className).toBe('has-error');
    expect(row('broken').title).toContain('ReferenceError: x is not defined');
    expect(within(row('broken')).getByText(t('values.panel.error'))).toBeTruthy();

    // Only scripts of the project are editable.
    expect(within(row('speed.kmh')).getByRole('button')).toBeTruthy();
    expect(within(row('broken')).queryByRole('button')).toBeNull();
    expect(within(row('speed')).queryByRole('button')).toBeNull();

    await user.click(screen.getByRole('button', { name: t('common.export') }));
    expect(exportValues).toHaveBeenCalled();
  });

  it('filters by id, name and description', async () => {
    const user = userEvent.setup();
    useStore.setState({ values });
    render(<ValuesPanel />);
    const filter = screen.getByPlaceholderText(t('values.panel.filter'));
    await user.type(filter, 'CONVERTED');
    expect(screen.getAllByRole('group')).toHaveLength(1);
    expect(screen.getByText('speed.kmh')).toBeTruthy();
    await user.clear(filter);
    await user.type(filter, 'temperature');
    expect(screen.getAllByRole('row')).toHaveLength(1);
    expect(screen.getByText('gopro.temp')).toBeTruthy();
    await user.clear(filter);
    await user.type(filter, 'nothing like this');
    expect(screen.queryAllByRole('group')).toHaveLength(0);
  });

  it('opens a new script in the editor and comes back', async () => {
    const user = userEvent.setup();
    useStore.setState({ values });
    render(<ValuesPanel />);
    await user.click(screen.getByRole('button', { name: t('values.panel.new') }));
    expect((screen.getByLabelText(t('common.name')) as HTMLInputElement).value).toBe(
      t('values.panel.newScriptName'),
    );
    expect((screen.getByLabelText(t('values.editor.id')) as HTMLInputElement).value).toBe('my.value');
    await user.click(screen.getByRole('button', { name: t('values.editor.back') }));
    expect(screen.getByPlaceholderText(t('values.panel.filter'))).toBeTruthy();
  });

  it('opens a project script in the editor', async () => {
    const user = userEvent.setup();
    useStore.setState({ values, project: { ...createProject(), values: [script] } });
    render(<ValuesPanel />);
    await user.click(within(row('speed.kmh')).getByRole('button'));
    expect((screen.getByLabelText(t('common.name')) as HTMLInputElement).value).toBe('Speed km/h');
    expect(screen.getByRole('button', { name: t('common.delete') })).toBeTruthy();
  });
});
