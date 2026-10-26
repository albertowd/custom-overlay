import { createProject } from '@custom-overlay/core';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BusyMask } from '../../../src/app/components/BusyMask';
import { t } from '../../../src/app/i18n';
import { useStore } from '../../../src/app/store';
import { resetStore } from './form-helpers';

beforeEach(() => {
  vi.useFakeTimers();
  resetStore();
});

afterEach(() => {
  vi.useRealTimers();
});

const dialog = () => screen.getByRole('dialog', { hidden: true }) as HTMLDialogElement;

describe('BusyMask', () => {
  it('stays closed while the app is idle', () => {
    render(<BusyMask />);
    expect(dialog().open).toBe(false);
    expect(dialog().textContent).toBe('');
  });

  it('shows an export at once with its progress', () => {
    useStore.setState({
      exportState: {
        status: 'running',
        progress: { frame: 50, frames: 200, fps: 30, elapsedSeconds: 2, etaSeconds: 5 },
      },
    });
    render(<BusyMask />);
    expect(dialog().open).toBe(true);
    expect(screen.getByText(t('app.busy.export.title'))).toBeTruthy();
    expect(screen.getByRole('progressbar', { hidden: true }).getAttribute('aria-valuenow')).toBe('25');
  });

  it('shows other tasks only once they take a while, and closes when they end', () => {
    render(<BusyMask />);
    act(() => useStore.setState({ valuesBusy: true }));
    expect(dialog().open).toBe(false);
    act(() => vi.advanceTimersByTime(300));
    expect(dialog().open).toBe(true);
    expect(screen.getByText(t('app.busy.values.title'))).toBeTruthy();
    act(() => useStore.setState({ valuesBusy: false }));
    expect(dialog().open).toBe(false);
  });

  it('does not flicker for short tasks', () => {
    render(<BusyMask />);
    act(() => useStore.setState({ valuesBusy: true }));
    act(() => vi.advanceTimersByTime(100));
    act(() => useStore.setState({ valuesBusy: false }));
    act(() => vi.advanceTimersByTime(500));
    expect(dialog().open).toBe(false);
  });

  it('names the media files being loaded, counting the others', () => {
    const project = createProject();
    project.videos.push({ id: 'v1', label: 'GX010001.MP4' } as (typeof project.videos)[number]);
    project.sources.push({ id: 's1', label: 'session.csv' } as (typeof project.sources)[number]);
    useStore.setState({
      project,
      loading: {
        v1: true,
        s1: true,
        'C:\\videos\\GX020001.MP4': true,
        '/home/me/GX030001.MP4': true,
        done: false,
        extra1: true,
        extra2: true,
      },
    });
    render(<BusyMask />);
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByText(t('app.busy.media.title'))).toBeTruthy();
    const files = screen.getAllByRole('listitem', { hidden: true }).map((li) => li.textContent);
    expect(files).toEqual([
      'GX010001.MP4',
      'session.csv',
      'GX020001.MP4',
      'GX030001.MP4',
      t('app.busy.media.more', { count: 2 }),
    ]);
  });

  it('cannot be dismissed with Escape and reopens if closed while busy', () => {
    useStore.setState({ exportState: { status: 'running', progress: null } });
    render(<BusyMask />);
    const cancel = new Event('cancel', { cancelable: true });
    fireEvent(dialog(), cancel);
    expect(cancel.defaultPrevented).toBe(true);
    dialog().close();
    expect(dialog().open).toBe(true);
    expect(screen.getByText(t('export.run.preparing'))).toBeTruthy();
  });
});
