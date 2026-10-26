import type { Channel } from '@custom-overlay/core';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { type ChartTrace, TelemetryChart } from '../../../src/app/components/TelemetryChart';
import { FakeResizeObserver } from '../resize-observer';
import { recordCanvases, stubRect } from './canvas-helpers';

function channel(values: number[], step = 1): Channel {
  return {
    key: 'speed',
    label: 'Speed',
    unit: 'km/h',
    time: Float64Array.from(values, (_, i) => i * step),
    values: Float64Array.from(values),
  };
}

const trace = (overrides: Partial<ChartTrace> = {}): ChartTrace => ({
  label: 'GoPro',
  channel: channel([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110]),
  offset: 0,
  color: '#ff0000',
  ...overrides,
});

function canvas(): HTMLCanvasElement {
  return document.querySelector('canvas') as HTMLCanvasElement;
}

describe('TelemetryChart', () => {
  it('draws every trace with the axes, the unit and the playhead, and lists them in the legend', () => {
    const drawn = recordCanvases();
    render(
      <TelemetryChart
        traces={[trace(), trace({ label: 'Logger', color: '#00ff00', offset: 2, scale: 0.5 })]}
        start={0}
        end={10}
        currentTime={5}
        onSeek={() => undefined}
        unit="km/h"
      />,
    );
    expect(screen.getByText('GoPro')).toBeTruthy();
    expect(screen.getByText('Logger')).toBeTruthy();
    expect(drawn.texts()).toContain('km/h');
    // Value grid labels from the nice step of 5 to 110 (step 20).
    expect(drawn.texts()).toContain('20');
    // One line per trace plus the playhead and the grid lines.
    expect(drawn.count('lineTo')).toBeGreaterThan(20);
    const strokeColors = drawn.calls.filter((c) => c.method === 'stroke').length;
    expect(strokeColors).toBeGreaterThan(3);
  });

  it('does not draw an empty window', () => {
    const drawn = recordCanvases();
    render(<TelemetryChart traces={[trace()]} start={5} end={5} currentTime={5} onSeek={vi.fn()} unit="m" />);
    expect(drawn.count('stroke')).toBe(0);
  });

  it('copes with traces without numbers and flat traces', () => {
    const drawn = recordCanvases();
    const { rerender } = render(
      <TelemetryChart
        traces={[trace({ channel: channel([Number.NaN, Number.NaN, Number.NaN]) })]}
        start={0}
        end={2}
        currentTime={9}
        onSeek={vi.fn()}
        unit="m"
      />,
    );
    // Default 0..1 axis, labelled with one decimal.
    expect(drawn.texts()).toContain('0.2');
    rerender(
      <TelemetryChart
        traces={[trace({ channel: channel([3, 3, Number.NaN, 3, 3], 0.1) })]}
        start={0}
        end={0.4}
        currentTime={0.2}
        onSeek={vi.fn()}
        unit="m"
        height={120}
      />,
    );
    expect(drawn.texts()).toContain('3.0');
    // Sub-second time labels.
    expect(drawn.texts().some((text) => text.includes('.'))).toBe(true);
  });

  it('decimates long traces to about two points per pixel', () => {
    const drawn = recordCanvases();
    const long = Array.from({ length: 20_000 }, (_, i) => Math.sin(i / 100));
    render(
      <TelemetryChart
        traces={[trace({ channel: channel(long, 0.01) })]}
        start={0}
        end={200}
        currentTime={-1}
        onSeek={vi.fn()}
        unit="g"
      />,
    );
    // 600 px wide minus padding: at most ~2 points per pixel.
    expect(drawn.count('lineTo')).toBeLessThan(2000);
  });

  it('follows the container width, never under 200 px', () => {
    render(
      <TelemetryChart traces={[trace()]} start={0} end={10} currentTime={0} onSeek={vi.fn()} unit="m" />,
    );
    expect(canvas().style.width).toBe('600px');
    act(() => FakeResizeObserver.resizeAll(820.7, 300));
    expect(canvas().style.width).toBe('820px');
    act(() => FakeResizeObserver.resizeAll(50, 300));
    expect(canvas().style.width).toBe('200px');
  });

  it('seeks where clicked and while dragging, clamped to the window', () => {
    const onSeek = vi.fn();
    render(
      <TelemetryChart traces={[trace()]} start={10} end={20} currentTime={0} onSeek={onSeek} unit="m" />,
    );
    // Plot spans 44..588 of a 600 px canvas.
    stubRect(canvas(), 600, 180);
    fireEvent.pointerDown(canvas(), { clientX: 44 + 272, pointerId: 1 });
    expect(onSeek).toHaveBeenLastCalledWith(15);
    fireEvent.pointerMove(canvas(), { clientX: 2000 });
    expect(onSeek).toHaveBeenLastCalledWith(20);
    fireEvent.pointerMove(canvas(), { clientX: 0 });
    expect(onSeek).toHaveBeenLastCalledWith(10);
    fireEvent.pointerUp(canvas());
    onSeek.mockClear();
    fireEvent.pointerMove(canvas(), { clientX: 300 });
    expect(onSeek).not.toHaveBeenCalled();
  });
});
