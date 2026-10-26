import type { FieldSpec } from '@custom-overlay/core';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FieldInput, VALUE_IDS_LIST } from '../../../src/app/components/FieldInput';
import { t } from '../../../src/app/i18n';
import { resetStore } from './form-helpers';

beforeEach(() => resetStore());

// An unknown widget type: labels and hints stay as the field spec writes them.
function setup(field: FieldSpec, value: unknown) {
  const onChange = vi.fn();
  const user = userEvent.setup();
  const result = render(
    <FieldInput widgetType="test-widget" field={field} value={value} onChange={onChange} />,
  );
  return { ...result, user, onChange };
}

describe('FieldInput', () => {
  it('edits a number within its bounds, ignoring an empty field', () => {
    const { container, onChange } = setup(
      { key: 'size', label: 'Size', kind: 'number', min: 1, max: 10, hint: 'In pixels' },
      4,
    );
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    expect(input.value).toBe('4');
    expect([input.min, input.max, input.step]).toEqual(['1', '10', '1']);
    expect(screen.getByText('Size')).toBeTruthy();
    expect(screen.getByText('In pixels')).toBeTruthy();
    expect((container.firstChild as HTMLElement).title).toBe('In pixels');
    fireEvent.change(input, { target: { value: '7' } });
    expect(onChange).toHaveBeenCalledWith(7);
    fireEvent.change(input, { target: { value: '' } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('shows an empty number field for a missing value and uses the given step', () => {
    setup({ key: 'size', label: 'Size', kind: 'number', step: 0.5 }, undefined);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.step).toBe('0.5');
    expect(screen.queryByText('In pixels')).toBeNull();
  });

  it('edits a time as a timecode', async () => {
    const { user, onChange } = setup({ key: 'at', label: 'At', kind: 'time' }, 'not a number');
    const input = screen.getByRole('textbox') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, '1:05{Enter}');
    expect(onChange).toHaveBeenCalledWith(65);
  });

  it('edits text and multi-line text', () => {
    const text = setup({ key: 'title', label: 'Title', kind: 'text' }, undefined);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value).toBe('');
    fireEvent.change(input, { target: { value: 'Hello' } });
    expect(text.onChange).toHaveBeenCalledWith('Hello');
    text.unmount();

    const area = setup({ key: 'body', label: 'Body', kind: 'textarea' }, 'Line 1');
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(textarea.tagName).toBe('TEXTAREA');
    expect(textarea.value).toBe('Line 1');
    fireEvent.change(textarea, { target: { value: 'Line 1\nLine 2' } });
    expect(area.onChange).toHaveBeenCalledWith('Line 1\nLine 2');
  });

  it('toggles a boolean', async () => {
    const { user, onChange } = setup({ key: 'shadow', label: 'Shadow', kind: 'boolean' }, true);
    const box = screen.getByRole('checkbox', { name: 'Shadow' }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    await user.click(box);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('picks a select option', async () => {
    const { user, onChange } = setup(
      {
        key: 'align',
        label: 'Align',
        kind: 'select',
        options: [
          ['left', 'Left'],
          ['right', 'Right'],
        ],
      },
      'left',
    );
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Left', 'Right']);
    await user.selectOptions(screen.getByRole('combobox'), 'right');
    expect(onChange).toHaveBeenCalledWith('right');
  });

  it('picks a palette color or switches to a custom one', async () => {
    const { user, onChange } = setup({ key: 'color', label: 'Color', kind: 'color' }, undefined);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('text');
    expect(document.querySelector('input[type="color"]')).toBeNull();
    await user.selectOptions(select, 'custom');
    expect(onChange).toHaveBeenLastCalledWith('#ffffff');
    await user.selectOptions(select, 'primary');
    expect(onChange).toHaveBeenLastCalledWith('primary');
    expect(screen.getByRole('option', { name: t('template.field.customColor') })).toBeTruthy();
  });

  it('edits a custom hex color, ignoring its alpha', () => {
    const { onChange } = setup({ key: 'color', label: 'Color', kind: 'color' }, '#ff000080');
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('custom');
    const picker = document.querySelector('input[type="color"]') as HTMLInputElement;
    expect(picker.value).toBe('#ff0000');
    fireEvent.change(picker, { target: { value: '#00ff00' } });
    expect(onChange).toHaveBeenCalledWith('#00ff00');
  });

  it('takes a trimmed value id, suggesting the known ids', () => {
    const { onChange } = setup({ key: 'value', label: 'Value', kind: 'value' }, 'speed');
    const input = screen.getByPlaceholderText(t('template.field.valueId')) as HTMLInputElement;
    expect(input.value).toBe('speed');
    expect(input.getAttribute('list')).toBe(VALUE_IDS_LIST);
    fireEvent.change(input, { target: { value: ' lap.time ' } });
    expect(onChange).toHaveBeenCalledWith('lap.time');
  });

  it('shows an empty value id field for a missing value', () => {
    setup({ key: 'value', label: 'Value', kind: 'value' }, null);
    expect((screen.getByPlaceholderText(t('template.field.valueId')) as HTMLInputElement).value).toBe('');
  });

  it('embeds a chosen image as a data URL', async () => {
    const { user, onChange } = setup({ key: 'src', label: 'Image', kind: 'image' }, '');
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('button', { name: t('common.remove') })).toBeNull();
    const input = screen.getByLabelText(t('template.field.chooseImage')) as HTMLInputElement;
    await user.upload(input, new File(['png'], 'logo.png', { type: 'image/png' }));
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(expect.stringMatching(/^data:image\/png;base64,/)),
    );
    expect(input.value).toBe('');
  });

  it('refuses an image over 5 MB', async () => {
    const { user, onChange } = setup({ key: 'src', label: 'Image', kind: 'image' }, '');
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'huge.png', { type: 'image/png' });
    await user.upload(screen.getByLabelText(t('template.field.chooseImage')), big);
    expect(screen.getByText(t('template.field.imageTooLarge'))).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('ignores an empty file selection', () => {
    const { onChange } = setup({ key: 'src', label: 'Image', kind: 'image' }, '');
    fireEvent.change(screen.getByLabelText(t('template.field.chooseImage')), { target: { files: [] } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('shows, replaces and removes an embedded image', async () => {
    const { user, onChange } = setup(
      { key: 'src', label: 'Image', kind: 'image' },
      'data:image/png;base64,AAAA',
    );
    expect((document.querySelector('img') as HTMLImageElement).src).toBe('data:image/png;base64,AAAA');
    expect(screen.getByLabelText(t('template.field.replaceImage'))).toBeTruthy();
    await user.click(screen.getByRole('button', { name: t('common.remove') }));
    expect(onChange).toHaveBeenCalledWith('');
  });
});
