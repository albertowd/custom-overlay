import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NewProjectDialog } from '../../../src/app/components/NewProjectDialog';
import { t } from '../../../src/app/i18n';
import { useStore } from '../../../src/app/store';
import { resetStore } from './form-helpers';

const newProject = vi.fn();
const cancelNewProject = vi.fn();
const openProject = vi.fn(async () => undefined);

beforeEach(() => {
  newProject.mockClear();
  cancelNewProject.mockClear();
  openProject.mockClear();
  resetStore({ newProject, cancelNewProject, openProject });
});

const dialog = () => screen.getByRole('dialog', { hidden: true }) as HTMLDialogElement;
const create = () => screen.getByRole('button', { name: t('app.newProject.create') }) as HTMLButtonElement;

describe('NewProjectDialog', () => {
  it('renders nothing until a name is asked', () => {
    const { container } = render(<NewProjectDialog />);
    expect(container.innerHTML).toBe('');
  });

  it('creates a project with the trimmed name', async () => {
    const user = userEvent.setup();
    useStore.setState({ naming: 'new' });
    render(<NewProjectDialog />);
    expect(dialog().open).toBe(true);
    expect(create().disabled).toBe(true);
    await user.type(screen.getByLabelText(t('common.name')), '   ');
    expect(create().disabled).toBe(true);
    await user.type(screen.getByLabelText(t('common.name')), 'Monza day 1  ');
    expect(create().disabled).toBe(false);
    await user.click(create());
    expect(newProject).toHaveBeenCalledWith('Monza day 1');
  });

  it('does not submit an empty name', () => {
    useStore.setState({ naming: 'new' });
    render(<NewProjectDialog />);
    fireEvent.submit(create().closest('form') as HTMLFormElement);
    expect(newProject).not.toHaveBeenCalled();
  });

  it('can be cancelled with the button or Escape when asked from the menu', async () => {
    const user = userEvent.setup();
    useStore.setState({ naming: 'new' });
    render(<NewProjectDialog />);
    await user.click(screen.getByRole('button', { name: t('common.cancel') }));
    expect(cancelNewProject).toHaveBeenCalledTimes(1);
    fireEvent(dialog(), new Event('cancel', { cancelable: true }));
    expect(cancelNewProject).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: t('app.newProject.openInstead') })).toBeNull();
  });

  it('cannot be dismissed at startup, but offers to open a project', async () => {
    const user = userEvent.setup();
    useStore.setState({ naming: 'startup' });
    render(<NewProjectDialog />);
    const cancel = new Event('cancel', { cancelable: true });
    fireEvent(dialog(), cancel);
    expect(cancel.defaultPrevented).toBe(true);
    expect(cancelNewProject).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: t('common.cancel') })).toBeNull();
    await user.click(screen.getByRole('button', { name: t('app.newProject.openInstead') }));
    expect(openProject).toHaveBeenCalled();
  });

  it('starts empty each time it opens and closes when done', async () => {
    const user = userEvent.setup();
    useStore.setState({ naming: 'new' });
    const { container } = render(<NewProjectDialog />);
    await user.type(screen.getByLabelText(t('common.name')), 'Old');
    act(() => useStore.setState({ naming: null }));
    expect(container.innerHTML).toBe('');
    act(() => useStore.setState({ naming: 'new' }));
    expect((screen.getByLabelText(t('common.name')) as HTMLInputElement).value).toBe('');
  });
});
