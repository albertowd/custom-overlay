import { ENCODE_PRESETS, presetNotes } from '@custom-overlay/core';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { ExportStep } from '../../../src/app/steps/ExportStep';
import { useStore } from '../../../src/app/store';
import { api, circleSnapshot, resetStore, withSource, withVideo } from './helpers';

beforeEach(() => {
  resetStore();
  // Values stay as seeded: the evaluation never answers.
  api().evaluateValues.mockReturnValue(new Promise(() => undefined));
});

const state = () => useStore.getState();
const output = () => state().project.output;
const encoder = () => state().project.export.encoder;

function seedVideo() {
  const { project, video, info } = withVideo();
  useStore.setState({ project, videos: { [video.id]: info } });
  return { video, info };
}

const select = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('ExportStep without video', () => {
  it('exports an image sequence only and asks where', async () => {
    const { project } = withSource(state().project);
    useStore.setState({ project: { ...project, export: { ...project.export, mode: 'image-sequence' } } });
    render(<ExportStep />);

    const video = screen.getByRole('radio', { name: /Final video/ }) as HTMLInputElement;
    expect(video.disabled).toBe(true);
    expect(
      (screen.getByRole('radio', { name: /Transparent image sequence/ }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(screen.queryByText('Encoding')).toBeNull();
    expect(screen.getByDisplayValue('/logs/Untitled project frames')).toBeTruthy();

    api().selectOutput.mockResolvedValue('/exports/frames');
    await userEvent.click(screen.getByRole('button', { name: 'Choose…' }));
    expect(api().selectOutput).toHaveBeenCalledWith('image-sequence', '/logs/Untitled project frames');
    expect(state().project.export.outputPath).toBe('/exports/frames');
  });

  it('has no default location without media', () => {
    useStore.setState({
      project: { ...state().project, export: { ...state().project.export, mode: 'image-sequence' } },
    });
    render(<ExportStep />);
    expect(screen.getByPlaceholderText('No output selected')).toBeTruthy();
    expect(screen.queryByText(/Not chosen/)).toBeNull();
  });
});

describe('ExportStep with a video', () => {
  it('chooses the output location or goes back to the default one', async () => {
    seedVideo();
    render(<ExportStep />);
    expect(screen.getByDisplayValue('/videos/Session.mp4')).toBeTruthy();
    expect(screen.getByText(/Not chosen: it goes next to the videos/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Choose…' }));
    expect(state().project.export.outputPath).toBeNull();

    api().selectOutput.mockResolvedValue('/exports/race.mp4');
    await userEvent.click(screen.getByRole('button', { name: 'Choose…' }));
    expect(state().project.export.outputPath).toBe('/exports/race.mp4');
    await userEvent.click(screen.getByRole('button', { name: 'Choose…' }));
    expect(api().selectOutput).toHaveBeenLastCalledWith('video', '/exports/race.mp4');

    await userEvent.click(screen.getByRole('button', { name: 'Use the default location' }));
    expect(state().project.export.outputPath).toBeNull();

    api().selectOutput.mockRejectedValue(new Error('dialog failed'));
    await userEvent.click(screen.getByRole('button', { name: 'Choose…' }));
    expect(state().notice).toEqual({ kind: 'error', message: 'dialog failed' });
  });

  it('switches between a video and an image sequence', async () => {
    seedVideo();
    render(<ExportStep />);
    expect(screen.getByText('Encoding')).toBeTruthy();
    await userEvent.click(screen.getByRole('radio', { name: /Transparent image sequence/ }));
    expect(state().project.export.mode).toBe('image-sequence');
    expect(screen.queryByText('Encoding')).toBeNull();
    await userEvent.click(screen.getByRole('radio', { name: /Final video/ }));
    expect(state().project.export.mode).toBe('video');
  });

  it('edits the output format', async () => {
    seedVideo();
    render(<ExportStep />);

    select('Resolution', '1280x720');
    expect(output()).toMatchObject({ width: 1280, height: 720 });

    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '1000' } });
    expect(output().width).toBe(1000);
    expect(screen.getByRole('option', { name: 'Custom (1000 × 720)' })).toBeTruthy();
    select('Resolution', 'custom');
    expect(output().width).toBe(1000);
    // Empty and too small values are ignored.
    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '8' } });
    expect(output().width).toBe(1000);

    fireEvent.change(screen.getByLabelText('Height'), { target: { value: '500' } });
    expect(output().height).toBe(500);
    fireEvent.change(screen.getByLabelText('Frame rate'), { target: { value: '25' } });
    expect(output().frameRate).toBe(25);

    select('Color space', 'rec2020-hlg');
    expect(output().color.space).toBe('rec2020-hlg');
    select('Range / depth', 'full-10');
    expect(output().color).toMatchObject({ range: 'full', bitDepth: 10 });
    select('Range / depth', 'limited-8');
    expect(output().color).toMatchObject({ range: 'limited', bitDepth: 8 });

    await userEvent.click(screen.getByRole('button', { name: 'Match the first video' }));
    expect(output()).toMatchObject({ width: 3840, height: 2160 });
  });

  it('edits the encoder settings', () => {
    seedVideo();
    render(<ExportStep />);

    const other = ENCODE_PRESETS.find((p) => p.id !== encoder().preset && !p.youtube) ?? ENCODE_PRESETS[1];
    select('Preset', other?.id ?? '');
    expect(encoder().preset).toBe(other?.id);

    select('Codec', 'av1');
    expect(encoder()).toMatchObject({ codec: 'av1', preset: 'custom' });
    expect(screen.getByText('Custom values, kept with the project.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Bitrate (Mbps)'), { target: { value: '12' } });
    expect(encoder().bitrateMbps).toBe(12);
    fireEvent.change(screen.getByLabelText('Keyframe every (s)'), { target: { value: '2' } });
    expect(encoder().keyframeIntervalSeconds).toBe(2);
    fireEvent.change(screen.getByLabelText('B-frames'), { target: { value: '2.6' } });
    expect(encoder().bFrames).toBe(3);
    fireEvent.change(screen.getByLabelText('B-frames'), { target: { value: '' } });
    expect(encoder().bFrames).toBe(3);
    select('Audio', 'none');
    expect(encoder().audio).toBe('none');
    select('Decode / encode on', 'software');
    expect(encoder().acceleration).toBe('software');
    select('Scaling (when the output size differs from a video)', 'lanczos');
    expect(state().project.export.scaling).toBe('lanczos');
    expect(screen.getByText(/Estimated file size: about/)).toBeTruthy();
  });

  it('offers TikTok and Instagram presets that move the canvas to their format', () => {
    seedVideo();
    render(<ExportStep />);
    expect(screen.getByRole('group', { name: 'TikTok · 9:16' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Instagram feed · 4:5' })).toBeTruthy();
    select('Preset', 'tiktok-30');
    expect(output()).toMatchObject({ width: 1080, height: 1920, frameRate: 29.97 });
    expect(encoder()).toMatchObject({ preset: 'tiktok-30', codec: 'h264', bitrateMbps: 8 });
    expect(screen.getByText(/1080 × 1920 video for TikTok.*8 Mbps at 24–30 fps/)).toBeTruthy();
    // The 10-bit footage is converted on upload; the canvas is the preset's.
    expect(screen.getByText(/The app plays 8-bit Rec.709 SDR video/)).toBeTruthy();
    expect((screen.getByLabelText('Resolution') as HTMLSelectElement).value).toBe('1080x1920');
    select('Video placement', 'cover');
    expect(output().fit.mode).toBe('cover');
  });

  it('shows the notes of the preset for the output', () => {
    seedVideo();
    render(<ExportStep />);
    const noted = ENCODE_PRESETS.find((p) => presetNotes(p.id, output()).length > 0);
    expect(noted).toBeDefined();
    select('Preset', noted?.id ?? '');
    const notes = presetNotes(encoder().preset, output());
    expect(notes.length).toBeGreaterThan(0);
    expect(document.querySelectorAll('p.warning')).toHaveLength(notes.length);
  });

  it('sets the slow disk options, the temporary folder only for a video', () => {
    seedVideo();
    render(<ExportStep />);
    const disk = () => state().project.export.disk;
    fireEvent.click(screen.getByRole('checkbox', { name: 'Slow disk (hard drive)' }));
    expect(disk().slow).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Write to the temporary folder first' }));
    expect(disk().stageInTemp).toBe(true);
    const speed = screen.getByLabelText('Max speed (× real time)') as HTMLInputElement;
    expect(speed.placeholder).toBe('No limit');
    fireEvent.change(speed, { target: { value: '1.5' } });
    expect(disk().maxSpeed).toBe(1.5);
    fireEvent.change(speed, { target: { value: '' } });
    expect(disk().maxSpeed).toBe(0);
    act(() => state().setExport({ mode: 'image-sequence' }));
    expect(screen.queryByRole('checkbox', { name: 'Write to the temporary folder first' })).toBeNull();
  });

  it('encodes on a chosen graphics card, listing the installed ones', async () => {
    api().graphicsCards.mockResolvedValue([
      { name: 'NVIDIA GeForce RTX 3070', brand: 'nvidia' },
      { name: 'Intel UHD 770', brand: 'intel' },
    ]);
    seedVideo();
    render(<ExportStep />);
    const select = screen.getByLabelText('Decode / encode on') as HTMLSelectElement;
    await screen.findByRole('option', { name: 'NVIDIA GeForce RTX 3070' });
    expect([...select.options].map((o) => o.text)).toEqual([
      'GPU when available',
      'NVIDIA GeForce RTX 3070',
      'Intel UHD 770',
      'CPU only',
    ]);
    fireEvent.change(select, { target: { value: 'nvidia' } });
    expect(encoder().acceleration).toBe('nvidia');
    // A saved choice stays listed without the card.
    api().graphicsCards.mockResolvedValue([]);
    act(() => state().setEncoder({ acceleration: 'amd' }));
    expect(screen.getByRole('option', { name: 'AMD graphics card' })).toBeTruthy();
  });

  it('shows what the browser does when it exports the video itself', () => {
    seedVideo();
    Object.assign(api().capabilities, { nativeExport: false });
    render(<ExportStep />);
    expect(screen.queryByRole('checkbox', { name: 'Slow disk (hard drive)' })).toBeNull();
    expect(screen.queryByLabelText(/^Scaling/)).toBeNull();
    expect(screen.getByText(/Encoded by this browser on the device's hardware/)).toBeTruthy();
    expect(screen.getByText(/The browser asks where to save it/)).toBeTruthy();
    expect(screen.queryByText(/Not chosen: it goes next to the videos/)).toBeNull();
    // Nothing to choose ahead: no output field.
    expect(screen.queryByRole('button', { name: 'Choose…' })).toBeNull();
    expect(screen.queryByPlaceholderText('No output selected')).toBeNull();
    act(() => state().setExport({ mode: 'image-sequence' }));
    expect(screen.getByText('The browser asks for the folder when the export starts.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Choose…' })).toBeNull();
  });

  it('says when open range bounds follow the Track data range', () => {
    seedVideo();
    useStore.setState({ values: { ...circleSnapshot(), dataRange: { start: 10, end: 50 } } });
    render(<ExportStep />);
    expect(screen.getByText(/the export follows the data range set in the Track step/)).toBeTruthy();
    act(() => useStore.setState({ currentTime: 30 }));
    fireEvent.click(screen.getByRole('button', { name: 'Start at playhead' }));
    expect(state().project.export.range.start).toBeCloseTo(30, 1);
  });
});
