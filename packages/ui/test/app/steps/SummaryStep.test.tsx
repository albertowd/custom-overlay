import {
  createProject,
  createWidget,
  evaluateWorkflow,
  setSourceEnabled,
  setVideoEnabled,
} from '@custom-overlay/core';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { SummaryStep } from '../../../src/app/steps/SummaryStep';
import { useStore } from '../../../src/app/store';
import { resetStore, speedSeries, withSource, withVideo } from './helpers';

beforeEach(() => resetStore());

const row = (label: RegExp) =>
  within(screen.getByRole('table')).getByText(label).closest('tr') as HTMLElement;

describe('SummaryStep', () => {
  it('summarizes an empty project and links its issues to their steps', async () => {
    useStore.getState().setExport({ mode: 'image-sequence' });
    render(<SummaryStep />);
    expect(screen.getByText('Not defined yet')).toBeTruthy();
    expect(screen.getByText('Transparent image sequence')).toBeTruthy();
    expect(screen.getByText('embedded in project')).toBeTruthy();

    const issues = within(screen.getByRole('list'));
    const [first] = issues.getAllByRole('button');
    const target = evaluateWorkflow({ project: useStore.getState().project, failedIds: [] }).find(
      (s) => s.issues.length > 0,
    );
    await userEvent.click(first as HTMLElement);
    expect(useStore.getState().step).toBe(target?.id);
  });

  it('lists every video and data source with its status', () => {
    const first = withVideo(createProject({ name: 'Race' }));
    const second = withVideo(first.project, { path: '/videos/CAM2.MP4', telemetry: null });
    const third = withVideo(second.project, { path: '/videos/CAM3.MP4', telemetry: null });
    const logger = withSource(third.project, '/logs/laps.csv');
    const broken = withSource(logger.project, '/logs/broken.csv');
    const off = withSource(broken.project, '/logs/off.csv');
    let project = setVideoEnabled(off.project, third.video.id, false);
    project = setSourceEnabled(project, off.source.id, false);
    project = { ...project, templatePath: '/templates/race.json' };
    useStore.setState({
      project,
      videos: { [first.video.id]: first.info },
      series: { [first.embeddedId]: first.telemetry ?? speedSeries(), [logger.source.id]: speedSeries() },
      errors: { [broken.source.id]: 'Bad file' },
    });
    render(<SummaryStep />);

    expect(within(row(/GX010001\.MP4$/)).getByText('reference')).toBeTruthy();
    expect(within(row(/GX010001\.MP4$/)).getByText('2:00.000')).toBeTruthy();
    expect(within(row(/CAM2\.MP4/)).getByText('not synced')).toBeTruthy();
    expect(within(row(/CAM2\.MP4/)).getByText('—')).toBeTruthy();
    expect(within(row(/CAM3\.MP4/)).getByText('disabled')).toBeTruthy();
    expect(within(row(/GX010001\.MP4 telemetry/)).getByText('follows video')).toBeTruthy();
    expect(within(row(/GX010001\.MP4 telemetry/)).getByText('synced')).toBeTruthy();
    expect(within(row(/laps\.csv/)).getByText(/1 channel/)).toBeTruthy();
    expect(within(row(/broken\.csv/)).getByText('error')).toBeTruthy();
    expect(within(row(/off\.csv/)).getByText('disabled')).toBeTruthy();
    expect(screen.getByText('/templates/race.json')).toBeTruthy();
    expect(screen.getByText('First video')).toBeTruthy();
  });

  it('names the encoder preset, or Custom', () => {
    const { project } = withVideo();
    useStore.setState({ project });
    const { unmount } = render(<SummaryStep />);
    expect(screen.getByText('Final video')).toBeTruthy();
    expect(screen.queryByText(/\(Custom\)/)).toBeNull();
    unmount();

    useStore.getState().setEncoder({ bitrateMbps: 7 });
    render(<SummaryStep />);
    expect(screen.getByText(/7 Mbps \(Custom\)/)).toBeTruthy();
  });

  it('opens the step of each section', async () => {
    render(<SummaryStep />);
    const steps: [number, string][] = [
      [0, 'export'],
      [1, 'sync'],
      [2, 'template'],
    ];
    const edits = screen.getAllByRole('button', { name: 'Edit' });
    for (const [index, step] of steps) {
      await userEvent.click(edits[index] as HTMLElement);
      expect(useStore.getState().step).toBe(step);
    }
    await userEvent.click(screen.getByRole('button', { name: 'Videos' }));
    expect(useStore.getState().step).toBe('videos');
    await userEvent.click(screen.getByRole('button', { name: 'Sources' }));
    expect(useStore.getState().step).toBe('sources');
  });

  it('says when everything is ready', () => {
    const { project, video, info, telemetry, embeddedId } = withVideo();
    useStore.setState({
      project: { ...project, template: { ...project.template, widgets: [createWidget('text')] } },
      videos: { [video.id]: info },
      series: telemetry ? { [embeddedId]: telemetry } : {},
    });
    render(<SummaryStep />);
    expect(screen.getByText('Everything is ready.')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });
});
