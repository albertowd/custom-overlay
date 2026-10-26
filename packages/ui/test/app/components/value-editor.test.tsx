import { createProject, type ValueScript } from '@custom-overlay/core';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ValueEditor } from '../../../src/app/components/ValueEditor';
import { t } from '../../../src/app/i18n';
import { useStore } from '../../../src/app/store';
import { resetStore, snapshot, valueInfo } from './form-helpers';

const script: ValueScript = {
  id: 'speed.kmh',
  name: 'Speed km/h',
  description: 'Speed in km/h',
  unit: 'km/h',
  initial: null,
  code: "return ctx.get('speed').map((v) => v * 3.6);",
};

beforeEach(() => resetStore());

function setup(previousId: string | null, initial: ValueScript = script) {
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(<ValueEditor previousId={previousId} initial={initial} onClose={onClose} />);
  return { user, onClose };
}

const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const code = () => screen.getByRole('textbox', { name: /function \(ctx\)/ }) as HTMLTextAreaElement;
const scripts = () => useStore.getState().project.values;

describe('ValueEditor', () => {
  it('adds a new script and switches to applying changes', async () => {
    const { user, onClose } = setup(null);
    expect(input(t('values.editor.id')).value).toBe('speed.kmh');
    expect(screen.queryByRole('button', { name: t('common.delete') })).toBeNull();
    await user.clear(input(t('common.name')));
    await user.type(input(t('common.name')), 'Kmh');
    await user.type(input(t('values.editor.initial')), '0');
    await user.click(screen.getByRole('button', { name: t('common.add') }));
    expect(scripts()).toEqual([{ ...script, name: 'Kmh', initial: 0 }]);
    expect(screen.getByRole('button', { name: t('common.apply') })).toBeTruthy();
    expect(screen.getByRole('button', { name: t('common.delete') })).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('edits every field of an existing script, then saves and closes', async () => {
    useStore.setState({ project: { ...createProject(), values: [script] } });
    const { user, onClose } = setup('speed.kmh');
    await user.clear(input(t('values.editor.id')));
    await user.type(input(t('values.editor.id')), 'speed.mph');
    await user.clear(input(t('common.unit')));
    await user.type(input(t('common.unit')), 'mph');
    await user.clear(input(t('common.description')));
    await user.type(input(t('common.description')), 'Miles');
    fireEvent.change(code(), { target: { value: 'return 1;' } });
    await user.click(screen.getByRole('button', { name: t('values.editor.saveClose') }));
    expect(scripts()).toEqual([
      { ...script, id: 'speed.mph', unit: 'mph', description: 'Miles', code: 'return 1;' },
    ]);
    expect(onClose).toHaveBeenCalled();
  });

  it('rejects an initial value that is not a number', async () => {
    const { user, onClose } = setup(null);
    await user.type(input(t('values.editor.initial')), 'abc');
    await user.click(screen.getByRole('button', { name: t('values.editor.saveClose') }));
    expect(screen.getByText(t('values.editor.initialInvalid'))).toBeTruthy();
    expect(scripts()).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows why the store refused the script', async () => {
    const { user } = setup(null, { ...script, id: 'Not An Id' });
    await user.click(screen.getByRole('button', { name: t('common.add') }));
    expect(screen.getByText(/^id: /)).toBeTruthy();
    expect(scripts()).toEqual([]);
  });

  it('shows the initial value of an existing script', () => {
    setup('speed.kmh', { ...script, initial: 2.5 });
    expect(input(t('values.editor.initial')).value).toBe('2.5');
  });

  it('previews the saved value at the playhead', () => {
    useStore.setState({
      currentTime: 0.2,
      values: snapshot({ values: [valueInfo('speed.kmh', 'script')], data: { 'speed.kmh': [10, 20, 36.5] } }),
    });
    setup('speed.kmh');
    expect(screen.getByText(t('values.editor.atPlayhead'), { exact: false }).textContent).toContain(
      '36.5 km/h',
    );
  });

  it('shows the evaluation error of the script instead of a value', () => {
    useStore.setState({
      values: snapshot({
        values: [valueInfo('speed.kmh', 'script')],
        errors: { 'speed.kmh': 'ctx is broken' },
      }),
    });
    setup('speed.kmh');
    expect(screen.getByText(t('values.editor.scriptError', { error: 'ctx is broken' }))).toBeTruthy();
    expect(screen.queryByText(t('values.editor.atPlayhead'), { exact: false })).toBeNull();
  });

  it('indents with two spaces on Tab and keeps other keys', async () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 0;
    });
    const { user } = setup(null, { ...script, code: 'ab' });
    const area = code();
    const setSelection = vi.spyOn(area, 'setSelectionRange');
    area.focus();
    area.setSelectionRange(1, 1);
    await user.keyboard('{Tab}');
    expect(code().value).toBe('a  b');
    expect(setSelection).toHaveBeenLastCalledWith(3, 3);
    expect(document.activeElement).toBe(code());
    fireEvent.keyDown(code(), { key: 'Enter' });
    expect(code().value).toBe('a  b');
  });

  it('deletes the script and closes', async () => {
    useStore.setState({ project: { ...createProject(), values: [script] } });
    const { user, onClose } = setup('speed.kmh');
    await user.click(screen.getByRole('button', { name: t('common.delete') }));
    expect(scripts()).toEqual([]);
    expect(onClose).toHaveBeenCalled();
  });

  it('goes back without saving', async () => {
    const { user, onClose } = setup(null);
    await user.click(screen.getByRole('button', { name: t('values.editor.back') }));
    expect(onClose).toHaveBeenCalled();
    expect(scripts()).toEqual([]);
  });
});
