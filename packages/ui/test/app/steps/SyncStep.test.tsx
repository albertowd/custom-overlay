import { createProject, type SyncResult } from '@custom-overlay/core';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { SyncStep } from '../../../src/app/steps/SyncStep';
import { useStore } from '../../../src/app/store';
import { resetStore, speedSeries, withSource, withVideo } from './helpers';

beforeEach(() => resetStore());

/** A reference video, a second camera started 20 s later and a logger with laps, both to sync. */
function seed() {
  const first = withVideo(createProject({ name: 'Session' }));
  const second = withVideo(first.project, {
    path: '/videos/CAM2.MP4',
    telemetry: speedSeries({ start: 20, duration: 30, kind: 'gopro' }),
  });
  const logger = withSource(second.project, '/logs/laps.csv');
  useStore.setState({
    project: logger.project,
    videos: { [first.video.id]: first.info, [second.video.id]: second.info },
    series: {
      [first.embeddedId]: first.telemetry ?? speedSeries(),
      [second.embeddedId]: second.telemetry ?? speedSeries(),
      [logger.source.id]: speedSeries({
        start: 5,
        duration: 40,
        laps: true,
        startEpochMs: Date.UTC(2026, 4, 1, 10),
      }),
    },
    currentTime: 25,
  });
  return { first, second, source: logger.source };
}

const item = (id: string) => {
  const { videos, sources } = useStore.getState().project;
  const found = [...videos, ...sources].find((i) => i.id === id);
  if (!found) throw new Error(`no item ${id}`);
  return found;
};

describe('SyncStep', () => {
  it('has nothing to sync with a single video', async () => {
    useStore.setState({ project: withVideo().project });
    render(<SyncStep />);
    expect(screen.getByText('Nothing to sync.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(useStore.getState().step).toBe('template');
  });

  it('edits the position of the first item to sync', async () => {
    const { second } = seed();
    render(<SyncStep />);
    expect(screen.getByRole('heading', { level: 2, name: 'CAM2.MP4' })).toBeTruthy();

    const nudges: [string, number][] = [
      ['+1 s', 1],
      ['+0.1 s', 1.1],
      ['−0.1 s', 1],
      ['−1 s', 0],
    ];
    for (const [label, offset] of nudges) {
      await userEvent.click(screen.getByRole('button', { name: label }));
      expect(item(second.video.id).offsetSeconds).toBeCloseTo(offset, 3);
    }
    await userEvent.click(screen.getByRole('button', { name: '+1 frame' }));
    expect(item(second.video.id).offsetSeconds).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: '−1 frame' }));
    expect(item(second.video.id).offsetSeconds).toBeCloseTo(0, 3);

    const field = screen.getByLabelText('Position on the timeline');
    await userEvent.clear(field);
    await userEvent.type(field, '20.5{Enter}');
    expect(item(second.video.id).offsetSeconds).toBe(20.5);

    await userEvent.click(screen.getByRole('checkbox', { name: 'Synced' }));
    expect(item(second.video.id).synced).toBe(true);
  });

  it('runs the automatic sync and applies a candidate', async () => {
    const { second } = seed();
    render(<SyncStep />);
    await userEvent.click(screen.getByRole('button', { name: 'Auto sync' }));
    await waitFor(() => expect(useStore.getState().syncResults[second.video.id]).toBeDefined());
    expect(screen.getByRole('button', { name: 'Auto sync' })).toBeTruthy();
    expect(item(second.video.id).offsetSeconds).toBeCloseTo(20, 0);

    const results = screen.getByRole('list');
    expect(within(results).getByText('By speed signal')).toBeTruthy();
    useStore.getState().setOffset(second.video.id, 0);
    await userEvent.click(within(results).getAllByRole('button', { name: 'Apply' })[0] as HTMLElement);
    expect(item(second.video.id).offsetSeconds).toBeCloseTo(20, 0);
    expect(item(second.video.id).synced).toBe(true);
  });

  it('lists every candidate with its confidence and notes', () => {
    const { second } = seed();
    const results: SyncResult[] = [
      {
        method: 'timestamp',
        offsetSeconds: 12,
        confidence: 0.95,
        overlapSeconds: 60,
        code: 'gpsTime',
        params: { label: 'GX010001.MP4' },
        message: 'GPS time',
        notes: [],
      },
      {
        method: 'correlation',
        offsetSeconds: -3,
        confidence: 0.2,
        overlapSeconds: 30,
        code: 'speedMatch',
        params: { label: 'GX010001.MP4', r: '0.41', overlap: '30' },
        message: 'speed',
        notes: ['ambiguous'],
      },
    ];
    useStore.setState({ syncResults: { [second.video.id]: results } });
    render(<SyncStep />);
    expect(screen.getByText('95%')).toBeTruthy();
    expect(screen.getByText('20%')).toBeTruthy();
    expect(
      screen.getByText(/Speed matched with 'GX010001.MP4' \(r = 0.41, 30 s compared\) — ambiguous/),
    ).toBeTruthy();
  });

  it('says when the automatic sync found nothing', () => {
    const { second } = seed();
    useStore.setState({ syncResults: { [second.video.id]: [] } });
    render(<SyncStep />);
    expect(screen.getByText(/No automatic match/)).toBeTruthy();
  });

  it('switches between items and shows the live values of a logger', async () => {
    seed();
    render(<SyncStep />);
    await userEvent.click(screen.getByRole('button', { name: /laps\.csv/ }));
    expect(screen.getByRole('heading', { level: 2, name: 'laps.csv' })).toBeTruthy();
    expect(screen.getByText('Item clock')).toBeTruthy();
    expect(screen.getByText('Lap')).toBeTruthy();

    await userEvent.click(screen.getByRole('checkbox', { name: /around the playhead/ }));
    expect((screen.getByRole('checkbox', { name: /around the playhead/ }) as HTMLInputElement).checked).toBe(
      true,
    );
  });

  it('has no chart without speed data', () => {
    const first = withVideo(createProject(), { telemetry: null });
    const second = withVideo(first.project, { path: '/videos/CAM2.MP4', telemetry: null });
    useStore.setState({ project: second.project, videos: { [first.video.id]: first.info } });
    render(<SyncStep />);
    expect(screen.getByText('No speed channel to plot.')).toBeTruthy();
  });
});
