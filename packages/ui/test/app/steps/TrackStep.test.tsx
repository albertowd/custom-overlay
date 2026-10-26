import { type CatalogTrack, createProject, type Gate, TRACK_CATALOG } from '@custom-overlay/core';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrackStep } from '../../../src/app/steps/TrackStep';
import { useStore } from '../../../src/app/store';
import { FakeResizeObserver } from '../resize-observer';
import {
  api,
  CIRCLE,
  circleSeries,
  circleSnapshot,
  circleTrack,
  resetStore,
  withSource,
  withVideo,
} from './helpers';

const SATELLITE_KEY = 'custom-overlay.track.satellite';

beforeEach(() => {
  resetStore();
  localStorage.clear();
  // Values stay as seeded: the evaluation never answers.
  api().evaluateValues.mockReturnValue(new Promise(() => undefined));
});

afterEach(() => localStorage.clear());

const state = () => useStore.getState();
const track = () => state().project.track;

/** A line across the circle at `degrees` (0 = east, counter-clockwise). */
function radialGate(degrees: number): Gate {
  const angle = (degrees * Math.PI) / 180;
  const at = (r: number) => ({
    latitude: CIRCLE.latitude + r * Math.sin(angle),
    longitude: CIRCLE.longitude + r * Math.cos(angle),
  });
  return { a: at(CIRCLE.radius * 0.8), b: at(CIRCLE.radius * 1.2) };
}

const circleEntry = (patch: Partial<CatalogTrack> = {}): CatalogTrack => ({
  id: 'it/circle',
  country: 'IT',
  location: 'Lombardia',
  track: circleTrack(),
  ...patch,
});

/** A project whose logger drove the circle, with its values evaluated. */
function seedSession(options: Parameters<typeof circleSnapshot>[0] = {}) {
  const { project, source } = withSource(createProject({ name: 'Session' }));
  useStore.setState({ project, series: { [source.id]: circleSeries() }, values: circleSnapshot(options) });
  return { source };
}

const trackSelect = () =>
  screen
    .getByRole('option', { name: /Choose a track…|No track found/ })
    .closest('select') as HTMLSelectElement;

describe('TrackStep map', () => {
  it('waits for the values, then reports their error', () => {
    const { rerender } = render(<TrackStep />);
    expect(screen.getByText('Loading the session…')).toBeTruthy();
    act(() => useStore.setState({ valuesError: 'Script failed' }));
    rerender(<TrackStep />);
    expect(screen.getByText('Script failed')).toBeTruthy();
    expect(screen.queryByText('Loading the session…')).toBeNull();
  });

  it('needs GPS positions for lines', () => {
    seedSession({ gps: false, loggerLaps: false });
    render(<TrackStep />);
    expect(screen.getByText(/The session has no GPS positions/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Draw' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'From logger laps' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByText('No laps yet.')).toBeTruthy();
  });

  it('scrubs the session without video and remembers the satellite view', async () => {
    seedSession();
    const { unmount } = render(<TrackStep />);
    fireEvent.change(screen.getByRole('slider', { name: 'Position on the timeline' }), {
      target: { value: '12.5' },
    });
    expect(state().currentTime).toBe(12.5);
    expect(state().seekRequest?.time).toBe(12.5);

    const satellite = screen.getByRole('checkbox', { name: 'Satellite view' }) as HTMLInputElement;
    expect(satellite.checked).toBe(true);
    await userEvent.click(satellite);
    expect(localStorage.getItem(SATELLITE_KEY)).toBe('0');
    unmount();

    render(<TrackStep />);
    expect((screen.getByRole('checkbox', { name: 'Satellite view' }) as HTMLInputElement).checked).toBe(
      false,
    );
  });

  it('works without local storage', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    seedSession();
    render(<TrackStep />);
    const satellite = screen.getByRole('checkbox', { name: 'Satellite view' }) as HTMLInputElement;
    expect(satellite.checked).toBe(true);
    await userEvent.click(satellite);
    expect(satellite.checked).toBe(false);
  });

  it('shows the video next to the map instead of a scrubber', () => {
    const { project, video, info, telemetry, embeddedId } = withVideo(createProject(), {
      telemetry: circleSeries(),
    });
    useStore.setState({
      project,
      videos: { [video.id]: info },
      series: telemetry ? { [embeddedId]: telemetry } : {},
      values: circleSnapshot(),
    });
    render(<TrackStep />);
    expect(screen.queryByRole('slider', { name: 'Position on the timeline' })).toBeNull();
    expect(document.querySelector('.track-media')).toBeTruthy();
  });
});

describe('TrackStep lines', () => {
  it('starts and cancels drawing a start/finish line', async () => {
    seedSession();
    render(<TrackStep />);
    expect(screen.getByText('Not set: laps come from the logger.')).toBeTruthy();
    expect(screen.getByText(/Drag the line ends/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Draw' }));
    expect(screen.getByRole('button', { name: 'Draw' }).className).toBe('primary');
    expect(screen.getByText(/Click two points across the track/)).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(screen.getByRole('button', { name: 'Draw' }).className).toBe('primary');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Draw' }).className).toBe('');

    await userEvent.click(screen.getByRole('button', { name: 'Draw' }));
    await userEvent.click(screen.getByRole('button', { name: 'Draw' }));
    expect(screen.getByRole('button', { name: 'Draw' }).className).toBe('');
    // Sector lines need a start/finish line first.
    expect((screen.getByRole('button', { name: 'Add sector line' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('draws lines on the map and drags their ends', async () => {
    seedSession();
    render(<TrackStep />);
    act(() => FakeResizeObserver.resizeAll(400, 300));
    const canvas = document.querySelector('.track-map canvas') as HTMLCanvasElement;
    const click = (x: number, y: number) =>
      fireEvent.pointerDown(canvas, { clientX: x, clientY: y, pointerId: 1 });

    await userEvent.click(screen.getByRole('button', { name: 'Draw' }));
    click(200, 40);
    expect(track().startFinish).toBeNull();
    click(200, 80);
    const drawn = track().startFinish;
    expect(drawn).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Redraw' }).className).toBe('');

    // Drag the first end of the line.
    click(200, 40);
    fireEvent.pointerMove(canvas, { clientX: 150, clientY: 40, pointerId: 1 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });
    expect(track().startFinish?.b).toEqual(drawn?.b);
    expect(track().startFinish?.a).not.toEqual(drawn?.a);

    await userEvent.click(screen.getByRole('button', { name: 'Add sector line' }));
    click(300, 150);
    click(350, 150);
    expect(track().sectors).toHaveLength(1);
    const sector = track().sectors[0];
    click(350, 150);
    fireEvent.pointerMove(canvas, { clientX: 360, clientY: 170, pointerId: 1 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });
    expect(track().sectors[0]?.a).toEqual(sector?.a);
    expect(track().sectors[0]?.b).not.toEqual(sector?.b);
  });

  it('places the start/finish line where the logger lap changes', async () => {
    seedSession();
    render(<TrackStep />);
    await userEvent.click(screen.getByRole('button', { name: 'From logger laps' }));
    expect(track().startFinish).toEqual(circleTrack().startFinish);
    expect(screen.getByText('Set. Drag its ends on the map to adjust.')).toBeTruthy();
  });

  it('reports logger laps that never change', async () => {
    seedSession({ constantLap: true });
    render(<TrackStep />);
    await userEvent.click(screen.getByRole('button', { name: 'From logger laps' }));
    expect(track().startFinish).toBeNull();
    expect(state().notice?.message).toBe('The logger laps do not change anywhere on the GPS path');
  });

  it('orders, removes and adds sector lines', async () => {
    seedSession();
    const [s1, s2] = [radialGate(90), radialGate(200)];
    useStore.setState({ project: { ...state().project, track: circleTrack({ sectors: [s1, s2] }) } });
    render(<TrackStep />);

    expect(screen.getByRole('button', { name: 'Redraw' })).toBeTruthy();
    const up = screen.getAllByRole('button', { name: '↑' }) as HTMLButtonElement[];
    const down = screen.getAllByRole('button', { name: '↓' }) as HTMLButtonElement[];
    expect(up[0]?.disabled).toBe(true);
    expect(down[1]?.disabled).toBe(true);

    await userEvent.click(down[0] as HTMLElement);
    expect(track().sectors).toEqual([s2, s1]);
    await userEvent.click(screen.getAllByRole('button', { name: '↑' })[1] as HTMLElement);
    expect(track().sectors).toEqual([s1, s2]);

    const lines = within(document.querySelector('.sector-lines') as HTMLElement);
    await userEvent.click(lines.getAllByRole('button', { name: 'Remove' })[1] as HTMLElement);
    expect(track().sectors).toEqual([s1]);

    const add = screen.getByRole('button', { name: 'Add sector line' });
    await userEvent.click(add);
    expect(add.className).toBe('primary');
    await userEvent.click(add);
    expect(add.className).toBe('');

    const startFinish = screen.getByRole('heading', { name: 'Start / finish' }).closest('div') as HTMLElement;
    await userEvent.click(within(startFinish).getByRole('button', { name: 'Remove' }));
    expect(track().startFinish).toBeNull();
  });

  it('imports and exports lines', async () => {
    seedSession();
    const { rerender } = render(<TrackStep />);
    expect((screen.getByRole('button', { name: 'Export lines…' }) as HTMLButtonElement).disabled).toBe(true);

    api().openTrack.mockResolvedValue(circleTrack());
    await userEvent.click(screen.getByRole('button', { name: 'Import lines…' }));
    expect(track().name).toBe('Circle Ring');
    rerender(<TrackStep />);
    await userEvent.click(screen.getByRole('button', { name: 'Export lines…' }));
    expect(api().saveTrack).toHaveBeenCalledWith(track());
  });

  it('edits the timing source and the track settings', async () => {
    seedSession();
    render(<TrackStep />);
    expect(screen.getByText(/Now: the logger/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Lap values come from'), { target: { value: 'lines' } });
    expect(track().timing).toBe('lines');
    expect(screen.getByText(/Now: the track lines/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Track name'), { target: { value: 'Home' } });
    expect(track().name).toBe('Home');
    fireEvent.change(screen.getByLabelText(/Minimum lap time/), { target: { value: '-5' } });
    expect(track().minLapSeconds).toBe(0);
    fireEvent.change(screen.getByLabelText(/Minimum lap time/), { target: { value: '25' } });
    expect(track().minLapSeconds).toBe(25);
  });
});

describe('TrackStep laps', () => {
  it('lists the logger laps without lines', async () => {
    seedSession();
    render(<TrackStep />);
    const table = within(document.querySelector('.laps-table') as HTMLElement);
    expect(table.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Lap', 'Logger']);
    const rows = table.getAllByRole('row').slice(1);
    expect(rows).toHaveLength(4);
    expect(rows[0]?.textContent).toContain('40.000');
    await userEvent.click(rows[1] as HTMLElement);
    expect(state().currentTime).toBe(40);
  });

  it('compares the laps timed by the lines with the logger', async () => {
    seedSession();
    useStore.setState({
      project: { ...state().project, track: circleTrack({ sectors: [radialGate(90), radialGate(200)] }) },
    });
    render(<TrackStep />);
    const table = within(document.querySelector('.laps-table') as HTMLElement);
    expect(table.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Lap',
      'S1',
      'S2',
      'S3',
      'Lines',
      'Logger',
      'Diff',
    ]);
    const rows = table.getAllByRole('row').slice(1);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows[1]?.getAttribute('title')).toMatch(/^Starts at /);
    await userEvent.click(rows[1] as HTMLElement);
    expect(state().currentTime).toBeCloseTo(40, 0);
  });

  it('times the lines without logger laps', () => {
    seedSession({ loggerLaps: false });
    useStore.setState({ project: { ...state().project, track: circleTrack() } });
    render(<TrackStep />);
    const table = within(document.querySelector('.laps-table') as HTMLElement);
    expect(table.getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Lap',
      'Lines',
      'Logger',
      'Diff',
    ]);
    expect(table.getAllByText('—').length).toBeGreaterThan(0);
  });
});

describe('TrackStep track list', () => {
  it('finds tracks by name or country in any language and loads one', async () => {
    render(<TrackStep />);
    expect(screen.getByText('This session is on none of the known tracks.')).toBeTruthy();
    expect(screen.getByText(/tracks built into this version/)).toBeTruthy();
    const [first] = TRACK_CATALOG;
    if (!first) throw new Error('empty catalog');

    const search = screen.getByRole('searchbox', { name: 'Search by name, city or country' });
    await userEvent.type(search, 'zzzz');
    expect(screen.getByRole('option', { name: 'No track found' })).toBeTruthy();

    await userEvent.clear(search);
    await userEvent.type(search, 'Brasil');
    expect(screen.getByRole('group', { name: /tracks? found/ })).toBeTruthy();
    fireEvent.change(trackSelect(), { target: { value: first.id } });
    expect(track().name).toBe(first.track.name);
    expect(screen.getByText(`Lines of ${first.track.name} from the track list.`)).toBeTruthy();
  });

  it('detects the session track, lists nearby tracks and loads the detected one', async () => {
    seedSession();
    const nearby = circleEntry({
      id: 'it/nearby',
      track: {
        ...circleTrack(),
        name: 'Nearby Kart',
        startFinish: { a: { latitude: 45.05, longitude: 9 }, b: { latitude: 45.05, longitude: 9.001 } },
      },
    });
    const far = circleEntry({
      id: 'fr/far',
      country: 'FR',
      location: 'Bretagne',
      track: {
        ...circleTrack(),
        name: 'Far Away',
        startFinish: { a: { latitude: 48, longitude: -3 }, b: { latitude: 48, longitude: -3.001 } },
      },
    });
    useStore.setState({
      trackCatalog: [...TRACK_CATALOG, circleEntry(), nearby, far],
      trackCatalogSource: 'github',
    });
    render(<TrackStep />);

    expect(screen.getByText('This session is at Circle Ring.')).toBeTruthy();
    expect(screen.getByRole('group', { name: 'In this session' })).toBeTruthy();
    expect(
      within(screen.getByRole('group', { name: 'Within 100 km' })).getByRole('option').textContent,
    ).toMatch(/Nearby Kart — Lombardia · 5\.\d km/);
    expect(screen.getByText(/up to date with GitHub/)).toBeTruthy();
    // The other tracks by country, in alphabetical order.
    const groups = screen.getAllByRole('group').map((g) => g.getAttribute('label'));
    expect(groups.slice(2)).toEqual(['Brazil', 'France']);

    await userEvent.click(screen.getByRole('button', { name: 'Use its lines' }));
    expect(track().startFinish).toEqual(circleTrack().startFinish);
    expect(screen.queryByRole('button', { name: 'Use its lines' })).toBeNull();
    expect(trackSelect().value).toBe('it/circle');
  });

  it('asks before several matching tracks are chosen from', () => {
    seedSession();
    useStore.setState({ trackCatalog: [circleEntry(), circleEntry({ id: 'it/circle-copy' })] });
    render(<TrackStep />);
    expect(screen.getByText('This session matches several known tracks: pick one below.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Use its lines' })).toBeNull();
  });

  it('confirms before replacing lines drawn by the user', () => {
    seedSession();
    useStore.setState({
      project: { ...state().project, track: circleTrack({ startFinish: radialGate(45) }) },
      trackCatalog: [circleEntry()],
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<TrackStep />);
    fireEvent.change(trackSelect(), { target: { value: 'it/circle' } });
    expect(confirm).toHaveBeenCalledWith('Replace the current lines with those of Circle Ring?');
    expect(track().startFinish).toEqual(radialGate(45));

    confirm.mockReturnValue(true);
    fireEvent.change(trackSelect(), { target: { value: 'it/circle' } });
    expect(track().startFinish).toEqual(circleTrack().startFinish);
  });

  it('ignores unknown tracks and links to the track form', async () => {
    render(<TrackStep />);
    const before = track();
    fireEvent.change(trackSelect(), { target: { value: 'xx/unknown' } });
    expect(track()).toBe(before);
    await userEvent.click(screen.getByRole('button', { name: 'Share your lines' }));
    expect(api().openProjectUrl).toHaveBeenCalledWith(expect.stringContaining('template=track.yml'));
  });
});
