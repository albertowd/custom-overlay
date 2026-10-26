import { embeddedSourceId } from '@custom-overlay/core';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useBusyTask,
  useMedia,
  useSessionCentre,
  useStore,
  useTimeline,
  useTrackMatches,
  useValuesRefresh,
  useWorkflow,
} from '../../src/app/store';
import { api, loadSession, resetStores, TEST_TRACK, valuesSnapshot } from './helpers/project';

beforeEach(resetStores);

describe('useBusyTask', () => {
  it('is null while idle', () => {
    const { result } = renderHook(() => useBusyTask());
    expect(result.current).toBeNull();
  });

  it('puts a running export first', () => {
    useStore.setState({
      exportState: { status: 'running', progress: null },
      loading: { x: true },
      valuesBusy: true,
    });
    const { result } = renderHook(() => useBusyTask());
    expect(result.current).toEqual({ kind: 'export', progress: null });
  });

  it('names the media being loaded: video, source or file being added', () => {
    const session = loadSession();
    useStore.setState({
      loading: {
        [session.videoId]: true,
        [session.sourceId]: true,
        'C:\\videos\\GX020001.MP4': true,
        '/videos/done.mp4': false,
      },
      valuesBusy: true,
    });
    const { result } = renderHook(() => useBusyTask());
    expect(result.current).toEqual({ kind: 'media', files: ['GX010001.MP4', 'session.csv', 'GX020001.MP4'] });
  });

  it('reports values being evaluated last', () => {
    useStore.setState({ valuesBusy: true });
    const { result } = renderHook(() => useBusyTask());
    expect(result.current).toEqual({ kind: 'values' });
  });
});

describe('media hooks', () => {
  it('gives the loaded media, the same object until it changes', () => {
    const session = loadSession();
    const { result, rerender } = renderHook(() => useMedia());
    const first = result.current;
    expect(first).toEqual({ videos: session.videos, series: session.series });
    rerender();
    expect(result.current).toBe(first);
    act(() => useStore.setState({ videos: {} }));
    expect(result.current).not.toBe(first);
  });

  it('computes the timeline of the loaded media', () => {
    const session = loadSession();
    const { result } = renderHook(() => useTimeline());
    expect(result.current).toMatchObject({
      basis: 'video',
      referenceId: session.videoId,
      width: 1920,
      height: 1080,
      startEpochMs: expect.any(Number),
    });
    expect(result.current.durationSeconds).toBeGreaterThanOrEqual(60);
  });

  it('evaluates the workflow with the load errors', () => {
    const session = loadSession();
    const { result } = renderHook(() => useWorkflow());
    expect(result.current.find((s) => s.id === 'sync')?.state).toBe('incomplete');
    act(() => useStore.setState({ errors: { [session.videoId]: 'missing' } }));
    const videos = result.current.find((s) => s.id === 'videos');
    expect(videos?.issues.map((i) => i.code)).toContain('notLoaded');
  });
});

describe('GPS hooks', () => {
  it('finds the known tracks and the centre of the session', () => {
    loadSession({ gps: true });
    useStore.setState({ trackCatalog: [TEST_TRACK] });
    const matches = renderHook(() => useTrackMatches()).result.current;
    expect(matches.map((m) => m.entry.id)).toEqual([TEST_TRACK.id]);
    const centre = renderHook(() => useSessionCentre()).result.current;
    expect(centre?.latitude).toBeCloseTo(10, 3);
    expect(centre?.longitude).toBeCloseTo(20.001, 6);
  });

  it('has no centre without positions, nor from disabled sources', () => {
    const session = loadSession({ gps: true });
    useStore.getState().setSourceEnabled(session.sourceId, false);
    expect(renderHook(() => useSessionCentre()).result.current).toBeNull();
    expect(renderHook(() => useTrackMatches()).result.current).toEqual([]);
  });
});

describe('useValuesRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    api().evaluateValues.mockResolvedValue(valuesSnapshot({ speed: [1] }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('refreshes the values shortly after what they depend on changes', async () => {
    const session = loadSession();
    renderHook(() => useValuesRefresh());
    expect(api().evaluateValues).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(api().evaluateValues).toHaveBeenCalledTimes(1);

    // Several changes in a row: one evaluation.
    act(() => {
      useStore.getState().setOffset(session.sourceId, -20);
      useStore.getState().setOutput({ frameRate: 30 });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(299);
    });
    expect(api().evaluateValues).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(api().evaluateValues).toHaveBeenCalledTimes(2);
  });

  it('does not refresh on widget edits, except their data range', async () => {
    renderHook(() => useValuesRefresh());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(api().evaluateValues).toHaveBeenCalledTimes(1);

    act(() => useStore.getState().addWidget('lap-table'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(api().evaluateValues).toHaveBeenCalledTimes(1);

    const id = useStore.getState().project.template.widgets[0]?.id ?? '';
    act(() =>
      useStore
        .getState()
        .updateWidget(id, { dataRange: { start: { kind: 'lap', lap: 2, fromEnd: false }, end: null } }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(api().evaluateValues).toHaveBeenCalledTimes(2);
  });

  it('refreshes when media loads', async () => {
    const session = loadSession();
    renderHook(() => useValuesRefresh());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    act(() =>
      useStore.setState((s) => ({
        series: { ...s.series, extra: s.series[embeddedSourceId(session.videoId)] as never },
      })),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(api().evaluateValues).toHaveBeenCalledTimes(2);
  });
});
