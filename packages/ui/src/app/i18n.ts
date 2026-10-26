import {
  type EncodePreset,
  SOCIAL_BITRATE_TEXT,
  type SocialFamily,
  type StepIssue,
  type StepStatus,
  type ValueInfo,
  YOUTUBE_BITRATE_TEXT,
  type YoutubeFamily,
} from '@custom-overlay/core';
import { useCallback } from 'react';
import { create } from 'zustand';
import { DEFAULT_LANGUAGE, type Language, type Params, type Translate, translate } from '../shared/i18n';
import { api } from './api';

interface LanguageState {
  language: Language;
  setLanguage(language: Language): void;
}

export const useLanguage = create<LanguageState>((set) => ({
  language: DEFAULT_LANGUAGE,
  setLanguage: (language) => {
    set({ language });
    document.documentElement.lang = language;
    void api().setLanguage(language);
  },
}));

/** Loads the saved (or system) language; call before the first render. */
export async function initLanguage(): Promise<void> {
  const language = await api().getLanguage();
  useLanguage.setState({ language });
  document.documentElement.lang = language;
}

/** Translation function for components; they re-render when the language changes. */
export function useT(): Translate {
  const language = useLanguage((s) => s.language);
  return useCallback(
    (key: string, params?: Params, fallback?: string) => translate(language, key, params, fallback),
    [language],
  );
}

/** Translation outside components (store actions, notices), in the current language. */
export const t: Translate = (key, params, fallback) =>
  translate(useLanguage.getState().language, key, params, fallback);

/** Message key of a value: numbered ids share one message (`sector.2.best` → `sector.N.best`, n = 2). */
function valueKey(id: string): { key: string; params: Params } {
  const match = /\.(\d+)\./.exec(id);
  if (!match) return { key: `core.values.${id}`, params: {} };
  return { key: `core.values.${id.replace(match[0], '.N.')}`, params: { n: match[1] as string } };
}

/**
 * Texts defined in English by the core (steps, issues, widgets, values...), translated by stable
 * ids under the `core` namespace. Anything without a translation, like the name of a user script,
 * stays as the core wrote it.
 */
export const coreText = {
  stepTitle: (tr: Translate, step: Pick<StepStatus, 'id' | 'title'>) =>
    tr(`core.steps.${step.id}.title`, {}, step.title),
  stepDescription: (tr: Translate, step: Pick<StepStatus, 'id' | 'description'>) =>
    tr(`core.steps.${step.id}.description`, {}, step.description),
  issue: (tr: Translate, issue: StepIssue) => tr(`core.issues.${issue.code}`, issue.params, issue.message),
  widgetName: (tr: Translate, widget: { type: string; name: string }) =>
    tr(`core.widgets.${widget.type}.name`, {}, widget.name),
  widgetDescription: (tr: Translate, widget: { type: string; description: string }) =>
    tr(`core.widgets.${widget.type}.description`, {}, widget.description),
  fieldLabel: (tr: Translate, type: string, field: { key: string; label: string }) =>
    tr(`core.widgets.${type}.fields.${field.key}.label`, {}, field.label),
  fieldHint: (tr: Translate, type: string, field: { key: string; hint?: string }) =>
    field.hint === undefined
      ? undefined
      : tr(`core.widgets.${type}.fields.${field.key}.hint`, {}, field.hint),
  /** Label of a `select` field option (`[value, label]` in the widget definition). */
  fieldOption: (tr: Translate, type: string, fieldKey: string, [value, label]: readonly [string, string]) =>
    tr(`core.widgets.${type}.fields.${fieldKey}.options.${value}`, {}, label),
  /**
   * YouTube presets are translated by codec family, social ones by format; the resolution and
   * frame rate stay as is.
   */
  presetFamily: (tr: Translate, family: YoutubeFamily | SocialFamily) =>
    tr(`core.presets.${family.id}.label`, {}, family.label),
  presetLabel: (tr: Translate, preset: EncodePreset) =>
    preset.youtube
      ? `${coreText.presetFamily(tr, preset.youtube.family)} · ${coreText.presetOption(tr, preset)}`
      : coreText.presetOption(tr, preset),
  /**
   * Label of a preset inside its family's group of the preset list. Social ones name their
   * format, so the closed list tells TikTok from Reels.
   */
  presetOption: (tr: Translate, preset: EncodePreset) => {
    if (preset.youtube) {
      return `${preset.youtube.resolution} · ${preset.youtube.fps} · ${preset.youtube.bitrateMbps} Mbps`;
    }
    if (preset.social) {
      const { family, fps, bitrateMbps } = preset.social;
      return `${coreText.presetFamily(tr, family)} · ${fps} · ${bitrateMbps} Mbps`;
    }
    return tr(`core.presets.${preset.id}.label`, {}, preset.label);
  },
  presetDescription: (tr: Translate, preset: EncodePreset) => {
    if (preset.social) {
      const { family, fps, bitrateMbps } = preset.social;
      const description = tr(`core.presets.${family.id}.description`, {}, family.description);
      const bitrate = tr('core.presets.socialBitrate', { bitrate: bitrateMbps, fps }, SOCIAL_BITRATE_TEXT);
      return `${description} ${bitrate}`;
    }
    const target = preset.youtube;
    if (!target) return tr(`core.presets.${preset.id}.description`, {}, preset.description);
    const family = tr(`core.presets.${target.family.id}.description`, {}, target.family.description);
    const bitrate = tr(
      'core.presets.youtubeBitrate',
      {
        bitrate: target.bitrateMbps,
        table: target.family.hdr ? 'HDR' : 'SDR',
        resolution: target.resolution,
        fps: target.fps,
      },
      YOUTUBE_BITRATE_TEXT,
    );
    return `${family} ${bitrate}`;
  },
  /** Only engine values are translated: a script keeps the name its author gave it. */
  valueName: (tr: Translate, info: Pick<ValueInfo, 'id' | 'name' | 'origin'>) => {
    if (info.origin === 'script') return info.name;
    const { key, params } = valueKey(info.id);
    return tr(`${key}.name`, params, info.name);
  },
  valueDescription: (tr: Translate, info: Pick<ValueInfo, 'id' | 'description' | 'origin'>) => {
    if (info.origin === 'script') return info.description;
    const { key, params } = valueKey(info.id);
    return tr(`${key}.description`, params, info.description);
  },
};
