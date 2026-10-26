import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { SourcesStep } from '../../../src/app/steps/SourcesStep';
import { useStore } from '../../../src/app/store';
import { api, file, resetStore, speedSeries, withSource, withVideo } from './helpers';

beforeEach(() => resetStore());

describe('SourcesStep', () => {
  it('shows the empty list and asks for files with the add button', async () => {
    render(<SourcesStep />);
    expect(screen.getByText('No data sources yet.')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Add data source…' }));
    expect(api().selectSources).toHaveBeenCalledOnce();
  });

  it('lists standalone and embedded sources with their state', async () => {
    const video = withVideo();
    const { project, source } = withSource(video.project);
    useStore.setState({
      project,
      series: { [source.id]: speedSeries(), [video.embeddedId]: speedSeries({ kind: 'gopro' }) },
      errors: { [source.id]: 'Bad CSV header' },
      loading: { [video.embeddedId]: true },
    });
    render(<SourcesStep />);

    const standalone = screen.getByRole('heading', { name: 'session.csv' }).closest('article') as HTMLElement;
    expect(within(standalone).getByText('error')).toBeTruthy();
    expect(within(standalone).getByText('Bad CSV header')).toBeTruthy();
    expect(within(standalone).getByText('/logs/session.csv')).toBeTruthy();

    const embedded = screen
      .getByRole('heading', { name: 'GX010001.MP4 telemetry' })
      .closest('article') as HTMLElement;
    expect(within(embedded).getByText('embedded in video')).toBeTruthy();
    expect(within(embedded).getByText('loading…')).toBeTruthy();
    // Embedded telemetry is removed with its video only.
    expect(within(embedded).queryByRole('button', { name: 'Remove' })).toBeNull();

    await userEvent.click(within(standalone).getByRole('checkbox', { name: 'Use' }));
    expect(useStore.getState().project.sources.find((s) => s.id === source.id)?.enabled).toBe(false);
    expect(standalone.className).toContain('disabled');

    await userEvent.click(within(standalone).getByRole('button', { name: 'Remove' }));
    expect(useStore.getState().project.sources.map((s) => s.id)).not.toContain(source.id);
  });

  it('adds dropped files it can read and reports the others', async () => {
    api().detectSourceKind.mockImplementation(async (path) => (path.endsWith('.csv') ? 'racechrono' : null));
    api().loadSource.mockResolvedValue(speedSeries());
    render(<SourcesStep />);

    await act(async () => {
      fireEvent.drop(screen.getByRole('region', { name: 'Drop files here' }), {
        dataTransfer: { files: [file('lap.csv'), file('notes.txt')] },
      });
    });

    await waitFor(() => expect(api().loadSource).toHaveBeenCalledWith('/dropped/lap.csv', 'racechrono'));
    const state = useStore.getState();
    expect(state.project.sources.map((s) => s.path)).toEqual(['/dropped/lap.csv']);
    expect(state.notice).toEqual({ kind: 'error', message: 'Unsupported data source: notes.txt' });
  });

  it('adds nothing when no dropped file is supported', async () => {
    render(<SourcesStep />);
    await act(async () => {
      fireEvent.drop(screen.getByRole('region', { name: 'Drop files here' }), {
        dataTransfer: { files: [file('photo.jpg')] },
      });
    });
    expect(api().loadSource).not.toHaveBeenCalled();
    expect(useStore.getState().project.sources).toEqual([]);
  });
});
