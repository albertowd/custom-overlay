import { ENCODE_PRESETS, type EncodePreset, type StepIssue } from '@custom-overlay/core';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { coreText, initLanguage, t, useLanguage, useT } from '../../src/app/i18n';
import { api, resetStores } from './helpers/project';

beforeEach(resetStores);

const preset = (find: (p: EncodePreset) => boolean) => {
  const found = ENCODE_PRESETS.find(find);
  if (!found) throw new Error('preset not found');
  return found;
};

describe('language', () => {
  it('loads the saved language before the first render', async () => {
    api().getLanguage.mockResolvedValue('es');
    await initLanguage();
    expect(useLanguage.getState().language).toBe('es');
    expect(document.documentElement.lang).toBe('es');
  });

  it('saves a chosen language and marks the document', () => {
    useLanguage.getState().setLanguage('it');
    expect(useLanguage.getState().language).toBe('it');
    expect(document.documentElement.lang).toBe('it');
    expect(api().setLanguage).toHaveBeenCalledWith('it');
  });

  it('translates outside components in the current language', () => {
    expect(t('common.save')).toBe('Save');
    useLanguage.setState({ language: 'pt-BR' });
    expect(t('common.save')).not.toBe('Save');
  });

  it('re-renders components when the language changes', () => {
    const { result } = renderHook(() => useT());
    expect(result.current('app.toolbar.new')).toBe('New');
    const before = result.current;
    act(() => useLanguage.setState({ language: 'es' }));
    expect(result.current).not.toBe(before);
    expect(result.current('app.toolbar.new')).not.toBe('New');
  });
});

describe('coreText', () => {
  const tr = t;

  it('translates step titles and descriptions by id, keeping the core text otherwise', () => {
    expect(coreText.stepTitle(tr, { id: 'videos', title: 'core title' })).toBe('Videos');
    expect(coreText.stepDescription(tr, { id: 'videos', description: 'x' })).toMatch(/^Select the videos/);
    expect(coreText.stepTitle(tr, { id: 'nope' as 'videos', title: 'core title' })).toBe('core title');
  });

  it('translates issues with their parameters', () => {
    const issue: StepIssue = {
      code: 'notLoaded',
      severity: 'error',
      message: 'fallback',
      params: { label: 'run.mp4' },
    } as StepIssue;
    expect(coreText.issue(tr, issue)).toBe("'run.mp4' could not be loaded");
    expect(coreText.issue(tr, { ...issue, code: 'unknownCode' } as unknown as StepIssue)).toBe('fallback');
  });

  it('translates widget names, descriptions, fields and options', () => {
    expect(coreText.widgetName(tr, { type: 'text', name: 'x' })).toBe('Text');
    expect(coreText.widgetName(tr, { type: 'my-plugin', name: 'Plugin widget' })).toBe('Plugin widget');
    expect(coreText.widgetDescription(tr, { type: 'text', description: 'x' })).toMatch(/^Static text/);
    expect(coreText.fieldLabel(tr, 'text', { key: 'size', label: 'x' })).toBe('Font size');
    expect(coreText.fieldHint(tr, 'text', { key: 'size', hint: 'x' })).toBe('Fraction of the box height');
    expect(coreText.fieldHint(tr, 'text', { key: 'size' })).toBeUndefined();
    expect(coreText.fieldOption(tr, 'text', 'weight', ['800', 'x'])).toBe('Bold');
    expect(coreText.fieldOption(tr, 'text', 'weight', ['900', 'Black'])).toBe('Black');
  });

  it('labels YouTube presets by family and target, other presets by id', () => {
    const youtube = preset((p) => p.id === 'youtube-sdr-h264-4320p30');
    expect(coreText.presetFamily(tr, youtube.youtube?.family as never)).toBe('YouTube SDR · H.264');
    expect(coreText.presetOption(tr, youtube)).toBe('4320p (8K) · 24–30 fps · 160 Mbps');
    expect(coreText.presetLabel(tr, youtube)).toBe('YouTube SDR · H.264 · 4320p (8K) · 24–30 fps · 160 Mbps');
    const archive = preset((p) => p.id === 'archive');
    expect(coreText.presetLabel(tr, archive)).toBe(archive.label);
    expect(coreText.presetOption(tr, archive)).toBe(archive.label);
  });

  it('describes YouTube presets with the SDR or HDR bitrate table', () => {
    const sdr = preset((p) => p.id === 'youtube-sdr-h264-4320p30');
    expect(coreText.presetDescription(tr, sdr)).toBe(sdr.description);
    const hdr = preset((p) => p.youtube?.family.hdr === true);
    expect(coreText.presetDescription(tr, hdr)).toContain("YouTube's HDR range");
    const archive = preset((p) => p.id === 'archive');
    expect(coreText.presetDescription(tr, archive)).toBe(archive.description);
  });

  it('translates engine values, numbered ones included, but never script values', () => {
    expect(coreText.valueName(tr, { id: 'speed.kmh', name: 'x', origin: 'builtin' })).toBe('Speed (km/h)');
    expect(coreText.valueName(tr, { id: 'sector.2.best', name: 'x', origin: 'builtin' })).toBe(
      'Best sector 2',
    );
    expect(coreText.valueDescription(tr, { id: 'sector.3.last', description: 'x', origin: 'builtin' })).toBe(
      'Latest time of sector 3 (project timing source)',
    );
    expect(coreText.valueDescription(tr, { id: 'speed.kmh', description: 'x', origin: 'builtin' })).toBe(
      'Best available speed in km/h',
    );
    expect(coreText.valueName(tr, { id: 'speed.kmh', name: 'Mine', origin: 'script' })).toBe('Mine');
    expect(coreText.valueDescription(tr, { id: 'speed.kmh', description: 'My own', origin: 'script' })).toBe(
      'My own',
    );
  });
});
