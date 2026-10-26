import { setOutput } from '@custom-overlay/core';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Preview } from '../../../src/app/components/Preview';
import { useStore } from '../../../src/app/store';
import { loadVideoProject, resetStore, videoInfo } from './canvas-helpers';

const FRAME = 1 / 30;

const button = (title: RegExp) => screen.getByTitle(title);
const video = () => document.querySelector('video') as HTMLVideoElement;
const time = () => useStore.getState().currentTime;

/** Let the playback loop run for `ms` of animation frames. */
function play(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe('Preview', () => {
  beforeEach(() => {
    resetStore();
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a transparent stage without videos, with the transport disabled', () => {
    render(<Preview overlay={<span>overlay here</span>} />);
    expect(screen.getByText('No video — transparent output')).toBeTruthy();
    expect(screen.getByText('overlay here')).toBeTruthy();
    expect(document.querySelector('.stage')?.className).toContain('transparent');
    expect((screen.getByRole('slider') as HTMLInputElement).disabled).toBe(true);
    expect(video()).toBeNull();
  });

  it('plays the video covering the playhead and names it', () => {
    loadVideoProject();
    render(<Preview />);
    expect(video().getAttribute('src')).toBe('media://video');
    expect(screen.getByText('GX010001.MP4')).toBeTruthy();
    expect(screen.getByText('0:10.000')).toBeTruthy();
  });

  it('says when no video covers the playhead', () => {
    loadVideoProject();
    useStore.setState({ currentTime: 30 });
    render(<Preview />);
    expect(screen.getByText('No video at this time')).toBeTruthy();
  });

  it('reports videos that cannot be decoded until they load again', () => {
    loadVideoProject();
    render(<Preview />);
    fireEvent.error(video());
    expect(screen.getByText(/cannot be decoded/)).toBeTruthy();
    fireEvent.loadedMetadata(video());
    expect(screen.queryByText(/cannot be decoded/)).toBeNull();
  });

  it('moves the video element to the playhead on seek requests and when it loads', () => {
    loadVideoProject();
    render(<Preview />);
    act(() => useStore.getState().seek(4));
    expect(video().currentTime).toBeCloseTo(4);
    video().currentTime = 0;
    fireEvent.loadedMetadata(video());
    expect(video().currentTime).toBeCloseTo(4);
  });

  it('steps frames with the buttons and the arrow keys, within the timeline', () => {
    loadVideoProject();
    render(<Preview />);
    fireEvent.click(button(/Next frame/));
    expect(time()).toBeCloseTo(FRAME);
    fireEvent.keyDown(window, { key: 'ArrowRight', shiftKey: true });
    expect(time()).toBeCloseTo(11 * FRAME);
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(time()).toBeCloseTo(10 * FRAME);
    fireEvent.keyDown(window, { key: 'ArrowLeft', shiftKey: true });
    expect(time()).toBeCloseTo(0);
    fireEvent.click(button(/Previous frame/));
    expect(time()).toBe(0);
    act(() => useStore.getState().seek(10));
    fireEvent.click(button(/Next frame/));
    expect(time()).toBe(10);
  });

  it('ignores shortcuts while typing and other keys', () => {
    loadVideoProject();
    render(
      <>
        <input aria-label="name" />
        <Preview />
      </>,
    );
    fireEvent.keyDown(screen.getByLabelText('name'), { key: 'ArrowRight' });
    fireEvent.keyDown(window, { key: 'x' });
    expect(time()).toBe(0);
  });

  it('seeks with the scrubber', () => {
    loadVideoProject();
    render(<Preview />);
    fireEvent.change(screen.getByRole('slider'), { target: { value: '6.5' } });
    expect(time()).toBe(6.5);
    expect(useStore.getState().seekRequest?.time).toBe(6.5);
  });

  it('plays on the wall clock without a ready video and stops at the end', () => {
    loadVideoProject(videoInfo({ durationSeconds: 1 }));
    render(<Preview />);
    fireEvent.keyDown(window, { code: 'Space' });
    expect(button(/Play/).textContent).toBe('⏸');
    play(500);
    expect(time()).toBeGreaterThan(0.4);
    expect(time()).toBeLessThan(0.6);
    play(1000);
    expect(time()).toBe(1);
    expect(button(/Play/).textContent).toBe('▶');
    // Playing again from the end restarts at the beginning.
    fireEvent.click(button(/Play/));
    expect(useStore.getState().seekRequest?.time).toBe(0);
    play(100);
    expect(time()).toBeGreaterThan(0);
    fireEvent.click(button(/Play/));
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  });

  it('starts a ready video and then follows its clock', () => {
    loadVideoProject();
    render(<Preview />);
    const element = video();
    Object.defineProperty(element, 'readyState', { configurable: true, value: 4 });
    fireEvent.click(button(/Play/));
    play(20);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
    Object.defineProperty(element, 'paused', { configurable: true, value: false });
    element.currentTime = 3;
    play(20);
    expect(time()).toBeCloseTo(3);
    // A video that loads while playing starts at once.
    vi.mocked(HTMLMediaElement.prototype.play).mockClear();
    fireEvent.loadedMetadata(element);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
  });

  it('places the video on the canvas like the export does', () => {
    loadVideoProject();
    const { project } = useStore.getState();
    const fit = { mode: 'contain', rotation: 0, rotateWidgets: false, zoom: 1, x: 0.5, y: 0 } as const;
    useStore.setState({ project: setOutput(project, { width: 1080, height: 1920, fit }) });
    const { container } = render(<Preview />);
    const stage = container.querySelector('.stage') as HTMLElement;
    expect(stage.style.getPropertyValue('--stage-aspect')).toBe('0.5625');
    // The 16:9 video at the top of the 9:16 canvas.
    expect(video().style).toMatchObject({ left: '0%', top: '0%', width: '100%', height: '31.640625%' });
    expect(container.querySelector('.stage-backdrop')).toBeNull();

    // A portrait (rotated) video once the element knows its size.
    Object.defineProperty(video(), 'videoWidth', { value: 1080, configurable: true });
    Object.defineProperty(video(), 'videoHeight', { value: 1920, configurable: true });
    fireEvent.loadedMetadata(video());
    expect(video().style).toMatchObject({ top: '0%', height: '100%' });

    act(() => useStore.getState().setOutput({ fit: { ...fit, mode: 'blur' } }));
    expect(container.querySelector('.stage-backdrop')).toBeTruthy();
    play(50);
  });

  it('turns the video before fitting it', () => {
    loadVideoProject();
    const { project } = useStore.getState();
    const fit = { mode: 'contain', rotation: 90, rotateWidgets: false, zoom: 1, x: 0.5, y: 0.5 } as const;
    useStore.setState({ project: setOutput(project, { width: 1080, height: 1920, fit }) });
    render(<Preview />);
    // The 16:9 element, centred on the canvas, turned to fill the 9:16 canvas.
    expect(video().style).toMatchObject({
      left: `${(-420 / 1080) * 100}%`,
      top: '21.875%',
      width: `${(1920 / 1080) * 100}%`,
      height: '56.25%',
      transform: 'rotate(90deg)',
    });
    // Upright widgets cover the canvas as is.
    const overlay = () => document.querySelector('.overlay-layer') as HTMLElement;
    expect(overlay().style.transform).toBe('');
    act(() => useStore.getState().setOutput({ fit: { ...fit, rotateWidgets: true } }));
    // Turning with the video: the 16:9 layer is turned like it.
    expect(overlay().style).toMatchObject({ top: '21.875%', height: '56.25%', transform: 'rotate(90deg)' });
    act(() => useStore.getState().setOutput({ fit: { ...fit, rotation: 0 } }));
    expect(video().style.transform).toBe('');
    expect(overlay().style.transform).toBe('');
  });
});
