import { createProject, setItemOffset } from '@custom-overlay/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { VideosStep } from '../../../src/app/steps/VideosStep';
import { useStore } from '../../../src/app/store';
import { api, file, resetStore, speedSeries, videoInfo, withVideo } from './helpers';

beforeEach(() => resetStore());

const card = (label: string) =>
  screen.getByRole('heading', { name: label }).closest('article') as HTMLElement;

describe('VideosStep without videos', () => {
  it('asks for videos with the add button', async () => {
    render(<VideosStep />);
    expect(screen.getByText(/Drop videos here/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Add videos…' }));
    expect(api().selectVideos).toHaveBeenCalledOnce();
  });

  it('continues without video as an image sequence', async () => {
    render(<VideosStep />);
    await userEvent.click(screen.getByRole('button', { name: 'Continue without video' }));
    const { project, step } = useStore.getState();
    expect(project.export.mode).toBe('image-sequence');
    expect(step).toBe('sources');
  });

  it('shows that videos are being read', () => {
    useStore.setState({ loading: { '/videos/GX010001.MP4': true } });
    render(<VideosStep />);
    expect(screen.getByText('Reading videos…')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Reading…' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('adds dropped videos and rejects other files', async () => {
    api().loadVideo.mockResolvedValue({
      info: videoInfo({ path: '/dropped/a.mp4' }),
      telemetry: null,
      mediaUrl: 'media://a',
    });
    render(<VideosStep />);
    fireEvent.drop(screen.getByRole('region', { name: 'Drop files here' }), {
      dataTransfer: { files: [file('a.mp4'), file('b.csv')] },
    });
    expect(useStore.getState().notice?.message).toBe('Only MP4 / MOV videos can be added here');
    await waitFor(() => expect(useStore.getState().project.videos).toHaveLength(1));
    expect(api().withChapters).toHaveBeenCalledWith(['/dropped/a.mp4'], []);
  });

  it('adds nothing when no dropped file is a video', () => {
    render(<VideosStep />);
    fireEvent.drop(screen.getByRole('region', { name: 'Drop files here' }), {
      dataTransfer: { files: [file('b.csv')] },
    });
    expect(api().withChapters).not.toHaveBeenCalled();
  });
});

describe('VideosStep with videos', () => {
  function seed() {
    const first = withVideo();
    const second = withVideo(first.project, {
      path: '/videos/GX020001.MP4',
      info: { camera: { model: null, firmware: null } },
      telemetry: null,
    });
    const third = withVideo(second.project, { path: '/videos/DJI_0001.MP4', telemetry: null });
    const project = setItemOffset(third.project, third.video.id, 75.5, true);
    useStore.setState({
      project,
      videos: { [first.video.id]: first.info, [second.video.id]: second.info },
      mediaUrls: { [first.video.id]: 'media://first' },
      series: { [first.embeddedId]: first.telemetry ?? speedSeries() },
      errors: { [second.video.id]: 'Cannot decode' },
      loading: { [third.video.id]: true },
    });
    return { first, second, third };
  }

  it('describes each video', () => {
    seed();
    render(<VideosStep />);

    const first = card('GX010001.MP4');
    expect(within(first).getByText('reference')).toBeTruthy();
    expect(within(first).getByText('GPMF telemetry')).toBeTruthy();
    expect(within(first).getByText('HERO11 Black · H22.01')).toBeTruthy();

    const second = card('GX020001.MP4');
    expect(within(second).getByText('not synced')).toBeTruthy();
    expect(within(second).getByText('Cannot decode')).toBeTruthy();
    expect(within(second).getByText('—')).toBeTruthy();

    const third = card('DJI_0001.MP4');
    expect(within(third).getByText(/^at /)).toBeTruthy();
    expect(within(third).getByText('loading…')).toBeTruthy();
  });

  it('disables and removes videos', async () => {
    const { second } = seed();
    render(<VideosStep />);

    await userEvent.click(within(card('GX020001.MP4')).getByRole('checkbox', { name: 'Use' }));
    expect(useStore.getState().project.videos.find((v) => v.id === second.video.id)?.enabled).toBe(false);
    expect(within(card('GX020001.MP4')).queryByText('not synced')).toBeNull();

    await userEvent.click(within(card('GX020001.MP4')).getByRole('button', { name: 'Remove' }));
    expect(useStore.getState().project.videos.map((v) => v.label)).toEqual(['GX010001.MP4', 'DJI_0001.MP4']);
  });

  it('keeps the add button in the header', async () => {
    useStore.setState({ project: withVideo(createProject()).project });
    render(<VideosStep />);
    await userEvent.click(screen.getByRole('button', { name: 'Add videos…' }));
    expect(api().selectVideos).toHaveBeenCalledOnce();
    expect(screen.getByText(/The first video is the timeline reference/)).toBeTruthy();
  });
});
