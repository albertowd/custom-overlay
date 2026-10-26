import type { StepIssue } from '@custom-overlay/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExportProgressView, ExportRunner } from '../../../src/app/components/ExportRunner';
import { formatTime } from '../../../src/app/format';
import { t } from '../../../src/app/i18n';
import { type ExportState, useStore } from '../../../src/app/store';
import { api } from '../fake-api';
import { resetStore } from './form-helpers';

const startExport = vi.fn(async () => undefined);
const cancelExport = vi.fn(async () => undefined);
const dismissExport = vi.fn();

beforeEach(() => {
  startExport.mockClear();
  cancelExport.mockClear();
  dismissExport.mockClear();
  resetStore({ startExport, cancelExport, dismissExport });
});

const result = {
  outputPath: '/videos/out.mp4',
  frames: 900,
  seconds: 75,
  encoder: 'h264_nvenc',
  workers: 4,
  warnings: [],
};

function renderWith(exportState: ExportState, issues: StepIssue[] = []) {
  useStore.setState({ exportState });
  return render(<ExportRunner issues={issues} />);
}

const warning: StepIssue = { severity: 'warning', code: 'noWidgets', params: {}, message: 'No widgets' };
const error: StepIssue = { severity: 'error', code: 'notLoaded', params: {}, message: 'Not loaded' };

describe('ExportProgressView', () => {
  it('shows preparing before the first frame', () => {
    render(<ExportProgressView progress={null} />);
    expect(screen.getByText(t('export.run.preparing'))).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');
  });

  it('shows the progress, speed and time left, and cancels', async () => {
    const user = userEvent.setup();
    render(
      <ExportProgressView
        progress={{ frame: 300, frames: 900, fps: 60, elapsedSeconds: 5, etaSeconds: Number.NaN }}
      />,
    );
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('33');
    expect(
      screen.getByText(t('export.run.progress', { percent: '33.3', frame: 300, frames: 900 })),
    ).toBeTruthy();
    expect(
      screen.getByText(t('export.run.speed', { fps: '60.0', elapsed: formatTime(5, false), left: '—' })),
    ).toBeTruthy();
    await user.click(screen.getByRole('button', { name: t('common.cancel') }));
    expect(cancelExport).toHaveBeenCalled();
  });
});

describe('ExportRunner', () => {
  it('starts an export, listing warnings', async () => {
    const user = userEvent.setup();
    renderWith({ status: 'idle' }, [warning]);
    expect(screen.getByRole('listitem').className).toBe('warning');
    const start = screen.getByRole('button', { name: t('export.run.start') }) as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    await user.click(start);
    expect(startExport).toHaveBeenCalled();
  });

  it('explains what the export does in each mode', () => {
    const { unmount } = renderWith({ status: 'idle' });
    expect(screen.getByText(t('export.run.help'))).toBeTruthy();
    unmount();
    const project = useStore.getState().project;
    useStore.setState({ project: { ...project, export: { ...project.export, mode: 'image-sequence' } } });
    renderWith({ status: 'idle' });
    expect(screen.getByText(t('export.run.helpSequence'))).toBeTruthy();
    expect(screen.queryByText(t('export.run.help'))).toBeNull();
  });

  it('cannot start with blocking issues', () => {
    renderWith({ status: 'idle' }, [error, warning]);
    expect((screen.getByRole('button', { name: t('export.run.start') }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('shows the progress instead of the button while running', () => {
    renderWith({ status: 'running', progress: null });
    expect(screen.queryByRole('button', { name: t('export.run.start') })).toBeNull();
    expect(screen.getByRole('progressbar')).toBeTruthy();
  });

  it('reports a finished export with its encoder, reveals and dismisses it', async () => {
    const user = userEvent.setup();
    renderWith({ status: 'done', result: { ...result, warnings: ['Widget x failed'] } });
    expect(screen.getByText(t('export.run.done', { count: 900 }))).toBeTruthy();
    expect(
      screen.getByText(
        t('export.run.doneTimeEncoder', { time: formatTime(75, false), encoder: 'h264_nvenc' }),
        {
          exact: false,
        },
      ),
    ).toBeTruthy();
    expect(screen.getByText('Widget x failed')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: t('export.run.showInFolder') }));
    expect(api().revealPath).toHaveBeenCalledWith('/videos/out.mp4');
    await user.click(screen.getByRole('button', { name: t('export.run.dismiss') }));
    expect(dismissExport).toHaveBeenCalled();
  });

  it('reports an image sequence export without encoder', () => {
    renderWith({ status: 'done', result: { ...result, encoder: null } });
    expect(
      screen.getByText(t('export.run.doneTime', { time: formatTime(75, false) }), { exact: false }),
    ).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('reports a failed export', async () => {
    const user = userEvent.setup();
    renderWith({ status: 'failed', message: 'ffmpeg exited with code 1' });
    expect(screen.getByText(t('export.run.failed'))).toBeTruthy();
    expect(screen.getByText('ffmpeg exited with code 1')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: t('export.run.dismiss') }));
    expect(dismissExport).toHaveBeenCalled();
  });

  it('reports a cancelled export', async () => {
    const user = userEvent.setup();
    renderWith({ status: 'cancelled' });
    expect(screen.getByText(t('export.run.cancelled'), { exact: false })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: t('export.run.dismiss') }));
    expect(dismissExport).toHaveBeenCalled();
  });

  it('says what a cancelled image sequence leaves behind', () => {
    const project = useStore.getState().project;
    useStore.setState({ project: { ...project, export: { ...project.export, mode: 'image-sequence' } } });
    const { unmount } = renderWith({ status: 'cancelled' });
    expect(screen.getByText(t('export.run.cancelledSequence'), { exact: false })).toBeTruthy();
    unmount();
    // A browser that downloads sequences as a zip has nothing to keep.
    Object.assign(api().capabilities, { sequenceAsZip: true });
    renderWith({ status: 'cancelled' });
    expect(screen.getByText(t('export.run.cancelledZip'), { exact: false })).toBeTruthy();
  });
});
