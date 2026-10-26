import { formatTimecode } from '@custom-overlay/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TimeInput } from '../../../src/app/components/TimeInput';
import { t } from '../../../src/app/i18n';
import { resetStore } from './form-helpers';

beforeEach(() => resetStore());

function setup(props: Partial<Parameters<typeof TimeInput>[0]> = {}) {
  const onCommit = vi.fn<(value: number | null) => boolean>(() => true);
  const user = userEvent.setup();
  render(<TimeInput value={10} onCommit={onCommit} {...props} />);
  const input = screen.getByRole('textbox') as HTMLInputElement;
  return { user, input, onCommit };
}

describe('TimeInput', () => {
  it('shows the value as a timecode', () => {
    const { input } = setup({ value: 150.25 });
    expect(input.value).toBe(formatTimecode(150.25));
    expect(input.className).not.toContain('invalid');
  });

  it('previews the typed time and commits it on Enter', async () => {
    const { user, input, onCommit } = setup();
    await user.clear(input);
    await user.type(input, '2:30');
    expect(screen.getByText(`= ${formatTimecode(150)}`)).toBeTruthy();
    await user.keyboard('{Enter}');
    expect(onCommit).toHaveBeenCalledWith(150);
    // Back to showing the value.
    expect(input.value).toBe(formatTimecode(10));
  });

  it('commits on blur', async () => {
    const { user, input, onCommit } = setup();
    await user.clear(input);
    await user.type(input, '530');
    await user.tab();
    expect(onCommit).toHaveBeenCalledWith(0.53);
  });

  it('flags unreadable text and does not commit it', async () => {
    const { user, input, onCommit } = setup();
    await user.clear(input);
    await user.type(input, 'abc{Enter}');
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByText(t('sync.timeInput.format'))).toBeTruthy();
    expect(input.className).toContain('invalid');
  });

  it('shows the default message when the caller rejects a time, cleared by typing', async () => {
    const { user, input, onCommit } = setup();
    onCommit.mockReturnValue(false);
    await user.clear(input);
    await user.type(input, '5{Enter}');
    expect(onCommit).toHaveBeenCalledWith(0.005);
    expect(screen.getByText(t('sync.timeInput.rejected'))).toBeTruthy();
    expect(input.value).toBe('5');
    await user.type(input, '0');
    expect(screen.queryByText(t('sync.timeInput.rejected'))).toBeNull();
  });

  it('shows the given reject message', async () => {
    const { user, input, onCommit } = setup({ rejectMessage: 'Out of range' });
    onCommit.mockReturnValue(false);
    await user.clear(input);
    await user.type(input, '1{Enter}');
    expect(screen.getByText('Out of range')).toBeTruthy();
  });

  it('cancels the edit on Escape', async () => {
    const { user, input, onCommit } = setup();
    onCommit.mockReturnValue(false);
    await user.clear(input);
    await user.type(input, '1{Enter}');
    await user.keyboard('{Escape}');
    expect(input.value).toBe(formatTimecode(10));
    expect(screen.queryByText(t('sync.timeInput.rejected'))).toBeNull();
    // Nothing being edited: blur does not commit.
    await user.tab();
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('cannot be emptied without a placeholder', async () => {
    const { user, input, onCommit } = setup();
    await user.clear(input);
    await user.keyboard('{Enter}');
    expect(onCommit).not.toHaveBeenCalled();
    expect(input.value).toBe(formatTimecode(10));
  });

  it('commits null when emptied with a placeholder', async () => {
    const { user, input, onCommit } = setup({ placeholder: 3 });
    expect(input.placeholder).toBe(formatTimecode(3));
    await user.clear(input);
    await user.keyboard('{Enter}');
    expect(onCommit).toHaveBeenCalledWith(null);
  });

  it('tells an empty field follows the timeline, or the given hint', () => {
    const { unmount } = render(<TimeInput value={null} placeholder={0} onCommit={() => true} />);
    expect(screen.getByText(t('sync.timeInput.followsTimeline'))).toBeTruthy();
    unmount();
    render(<TimeInput value={null} placeholder={0} onCommit={() => true} emptyHint="Data start" />);
    expect(screen.getByText('Data start')).toBeTruthy();
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('');
  });

  it('labels the field when given a label', () => {
    render(<TimeInput value={1} label="Start" onCommit={() => true} />);
    expect((screen.getByLabelText('Start') as HTMLInputElement).value).toBe(formatTimecode(1));
  });

  it('selects the text on focus', async () => {
    const { user, input } = setup();
    const select = vi.spyOn(input, 'select');
    await user.click(input);
    expect(select).toHaveBeenCalled();
  });
});
