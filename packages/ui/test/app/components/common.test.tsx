import type { SeriesSummary, TelemetrySeries } from '@custom-overlay/core';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Badge,
  ChannelChips,
  DropZone,
  KeyValues,
  LiveValues,
  SeriesFacts,
  SOURCE_KIND_LABELS,
  StepHeader,
} from '../../../src/app/components/common';
import { formatTime } from '../../../src/app/format';
import { t } from '../../../src/app/i18n';
import { resetStore } from './form-helpers';

beforeEach(() => resetStore());

const summary = (startTime: string | null): SeriesSummary =>
  ({
    durationSeconds: 125.5,
    startTime,
    channels: [
      { key: 'speed', label: 'Speed', samples: 1800, rateHz: 18.2 },
      { key: 'gps', label: 'GPS', samples: 10, rateHz: 0.5 },
    ],
  }) as unknown as SeriesSummary;

describe('StepHeader', () => {
  it('shows title, description and optional actions', () => {
    const { container, rerender } = render(<StepHeader title="Videos" description="Add videos" />);
    expect(screen.getByRole('heading', { name: 'Videos' })).toBeTruthy();
    expect(screen.getByText('Add videos')).toBeTruthy();
    expect(container.querySelector('.actions')).toBeNull();
    rerender(
      <StepHeader title="Videos" description="Add videos" actions={<button type="button">Add</button>} />,
    );
    expect(within(container.querySelector('.actions') as HTMLElement).getByRole('button')).toBeTruthy();
  });
});

describe('KeyValues and Badge', () => {
  it('lists the rows as terms and definitions', () => {
    render(
      <KeyValues
        rows={[
          ['Size', '2 MB'],
          [
            'Kind',
            <Badge key="b" tone="ok">
              GoPro
            </Badge>,
          ],
        ]}
      />,
    );
    expect(screen.getAllByRole('term').map((e) => e.textContent)).toEqual(['Size', 'Kind']);
    expect(screen.getAllByRole('definition').map((e) => e.textContent)).toEqual(['2 MB', 'GoPro']);
    expect(screen.getByText('GoPro').className).toBe('badge ok');
  });

  it('uses a neutral badge by default', () => {
    render(<Badge>New</Badge>);
    expect(screen.getByText('New').className).toBe('badge neutral');
  });

  it('labels every source kind', () => {
    expect(SOURCE_KIND_LABELS).toEqual({ gopro: 'GoPro', racechrono: 'RaceChrono', dji: 'DJI' });
  });
});

describe('ChannelChips', () => {
  it('shows each channel with its rate when at least 1 Hz', () => {
    render(<ChannelChips summary={summary(null)} />);
    const speed = screen.getByText('speed').closest('.chip') as HTMLElement;
    expect(speed.textContent).toBe('speed18 Hz');
    expect(speed.title).toBe(t('app.channel.tooltip', { label: 'Speed', count: 1800, rate: '18.2' }));
    expect((screen.getByText('gps').closest('.chip') as HTMLElement).textContent).toBe('gps');
  });
});

describe('SeriesFacts', () => {
  it('shows duration, UTC start and channel count', () => {
    render(<SeriesFacts summary={summary('2024-05-01T10:20:30.000Z')} />);
    expect(screen.getAllByRole('definition').map((e) => e.textContent)).toEqual([
      formatTime(125.5),
      '2024-05-01 10:20:30.000',
      '2',
    ]);
  });

  it('tells when the start time is unknown', () => {
    render(<SeriesFacts summary={summary(null)} />);
    expect(screen.getByText(t('common.unknown'))).toBeTruthy();
  });
});

describe('LiveValues', () => {
  it('shows each channel at the time, shifted by the offset', () => {
    const series = {
      channels: [
        {
          key: 'temp',
          label: 'Temperature',
          unit: 'C',
          time: [0, 1],
          values: [10, 20],
        },
      ],
    } as unknown as TelemetrySeries;
    render(<LiveValues series={series} offset={5} time={5.5} />);
    expect(screen.getByText('temp').title).toBe('Temperature');
    expect(screen.getByText('temp').nextElementSibling?.textContent).toBe('15 C');
  });
});

describe('DropZone', () => {
  it('highlights while dragging over and hands the dropped files', () => {
    const onFiles = vi.fn();
    render(
      <DropZone onFiles={onFiles} className="big">
        Drop here
      </DropZone>,
    );
    const zone = screen.getByRole('region', { name: t('app.dropFiles') });
    expect(zone.className).toContain('big');
    expect(zone.className).not.toContain('over');
    fireEvent.dragOver(zone);
    expect(zone.className).toContain('over');
    fireEvent.dragLeave(zone);
    expect(zone.className).not.toContain('over');
    fireEvent.dragOver(zone);
    const file = new File(['x'], 'session.csv');
    fireEvent.drop(zone, { dataTransfer: { files: [file] } });
    expect(onFiles).toHaveBeenCalledWith([file]);
    expect(zone.className).not.toContain('over');
  });
});
