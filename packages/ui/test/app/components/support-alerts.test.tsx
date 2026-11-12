import type { SupportIssue } from '@custom-overlay/ui/api';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { SupportAlerts, SupportBanner, useSupportIssues } from '../../../src/app/components/SupportAlerts';
import { ExportStep } from '../../../src/app/steps/ExportStep';
import { VideosStep } from '../../../src/app/steps/VideosStep';
import { useStore } from '../../../src/app/store';
import { api } from '../fake-api';
import { resetStore, withVideo } from '../steps/helpers';

const DECODE: SupportIssue = {
  code: 'cannotDecode',
  severity: 'error',
  params: { label: 'GX010001.MP4', codec: 'HEVC (H.265)' },
};
const AAC: SupportIssue = { code: 'cannotEncodeAac', severity: 'warning' };
const DOWNLOAD: SupportIssue = { code: 'noSavePicker', severity: 'info' };

beforeEach(resetStore);

/** The issues of the store's project. */
function Probe() {
  const issues = useSupportIssues(useStore((s) => s.project));
  return <span>{issues.length}</span>;
}

describe('SupportAlerts', () => {
  it('shows the most serious first, in words', () => {
    render(<SupportAlerts issues={[DOWNLOAD, AAC, DECODE]} />);
    const alerts = [...document.querySelectorAll('.alert')];
    expect(alerts.map((a) => a.className)).toEqual(['alert error', 'alert warning', 'alert info']);
    expect(alerts[0]?.getAttribute('role')).toBe('alert');
    expect(alerts[0]?.textContent).toContain("This browser cannot decode 'GX010001.MP4' (HEVC (H.265))");
    expect(alerts[1]?.textContent).toContain('encoded as Opus');
  });

  it('shows only the asked codes, and nothing without issues', () => {
    const { container, rerender } = render(
      <SupportAlerts issues={[DECODE, AAC]} codes={['cannotEncodeAac']} />,
    );
    expect(container.querySelectorAll('.alert')).toHaveLength(1);
    rerender(<SupportAlerts issues={[]} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('SupportBanner', () => {
  it("shows the browser's limits when the app opens, until closed", async () => {
    api().supportIssues.mockResolvedValue([{ code: 'noWebCodecs', severity: 'error' }]);
    render(<SupportBanner />);
    expect(await screen.findByText(/This browser cannot encode video/)).toBeTruthy();
    expect(api().supportIssues).toHaveBeenCalledWith(undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByText(/This browser cannot encode video/)).toBeNull();
  });

  it('shows nothing on hosts without limits', async () => {
    const { container } = render(<SupportBanner />);
    await act(async () => undefined);
    expect(container.innerHTML).toBe('');
  });
});

describe('alerts in the steps', () => {
  it('checks the project again when its videos or output change', async () => {
    const { project } = withVideo();
    useStore.setState({ project });
    render(<Probe />);
    await act(async () => undefined);
    expect(api().supportIssues).toHaveBeenCalledTimes(1);
    act(() => useStore.getState().setName('Another name'));
    await act(async () => undefined);
    expect(api().supportIssues).toHaveBeenCalledTimes(1);
    act(() => useStore.getState().setOutput({ width: 1280, height: 720 }));
    await act(async () => undefined);
    expect(api().supportIssues).toHaveBeenCalledTimes(2);
  });

  it('warns about undecodable videos in the Videos step, and every limit in the Export step', async () => {
    api().supportIssues.mockResolvedValue([DECODE, AAC]);
    const { project, video, info } = withVideo();
    useStore.setState({ project, videos: { [video.id]: info } });
    const videos = render(<VideosStep />);
    expect(await screen.findByText(/This browser cannot decode/)).toBeTruthy();
    expect(screen.queryByText(/encoded as Opus/)).toBeNull();
    videos.unmount();
    render(<ExportStep />);
    expect(await screen.findByText(/This browser cannot decode/)).toBeTruthy();
    expect(screen.getByText(/encoded as Opus/)).toBeTruthy();
  });
});
