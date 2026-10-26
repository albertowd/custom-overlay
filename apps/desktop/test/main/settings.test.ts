import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app, paths } from './electron-mock';

vi.mock('electron', () => import('./electron-mock'));

let userData: string;

/** A fresh settings module: it caches the file once read. */
const load = async () => {
  vi.resetModules();
  return import('../../src/main/settings');
};

const settingsFile = () => join(userData, 'settings.json');
const saved = () => JSON.parse(readFileSync(settingsFile(), 'utf8'));

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'co-settings-'));
  paths.userData = userData;
  paths.videos = join(userData, 'Videos');
  paths.documents = join(userData, 'Documents');
  app.getPreferredSystemLanguages.mockReturnValue(['en-US']);
  app.commandLine.appendSwitch.mockClear();
});

afterEach(() => {
  rmSync(userData, { recursive: true, force: true });
});

describe('language', () => {
  it('follows the system languages until the user picks one', async () => {
    app.getPreferredSystemLanguages.mockReturnValue(['es-MX', 'en-US']);
    const settings = await load();
    expect(settings.getLanguage()).toBe('es');

    settings.setLanguage('ja');
    expect(settings.getLanguage()).toBe('ja');
    expect(saved()).toMatchObject({ language: 'ja' });
  });

  it('reads the saved choice on the next start', async () => {
    writeFileSync(settingsFile(), JSON.stringify({ language: 'pt-BR' }));
    const settings = await load();
    expect(settings.getLanguage()).toBe('pt-BR');
    expect(settings.t('main.filters.videos')).toBe('Vídeos');
    expect(settings.t('main.chapters.files', { count: 2 })).toBe('2 arquivos');
  });

  it('switches Chromium to the chosen language only', async () => {
    writeFileSync(settingsFile(), JSON.stringify({ language: 'pt-BR' }));
    (await load()).applyChromiumLanguage();
    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith('lang', 'pt-BR');

    app.commandLine.appendSwitch.mockClear();
    rmSync(settingsFile());
    (await load()).applyChromiumLanguage();
    expect(app.commandLine.appendSwitch).not.toHaveBeenCalled();
  });

  it('ignores a broken or invalid settings file', async () => {
    writeFileSync(settingsFile(), '{ not json');
    expect((await load()).getLanguage()).toBe('en');

    writeFileSync(
      settingsFile(),
      JSON.stringify({ language: 'klingon', lastFolder: '', folders: { media: 42, template: '' } }),
    );
    const settings = await load();
    expect(settings.getLanguage()).toBe('en');
    expect(settings.startFolder('template')).toBe(paths.documents);
  });
});

describe('dialog folders', () => {
  it('starts in the system Videos folder for media and Documents for the rest', async () => {
    const settings = await load();
    expect(settings.startFolder('media')).toBe(paths.videos);
    expect(settings.startFolder('project')).toBe(paths.documents);
  });

  it('remembers the folder per kind, and the last one for kinds not used yet', async () => {
    const videos = join(userData, 'clips');
    const templates = join(userData, 'templates');
    mkdirSync(videos);
    mkdirSync(templates);
    const settings = await load();

    settings.rememberFolder('media', join(videos, 'GX010001.MP4'));
    expect(settings.startFolder('media')).toBe(videos);
    expect(settings.startFolder('widget')).toBe(videos);

    settings.rememberFolder('template', join(templates, 'a.template.json'));
    expect(settings.startFolder('template')).toBe(templates);
    expect(settings.startFolder('media')).toBe(videos);
    expect(settings.startFolder('widget')).toBe(templates);

    expect(saved()).toEqual({
      language: null,
      folders: { media: videos, template: templates },
      lastFolder: templates,
    });
    // Saved for the next start.
    expect((await load()).startFolder('media')).toBe(videos);
  });

  it('skips folders that were deleted', async () => {
    const gone = join(userData, 'gone');
    const last = join(userData, 'last');
    mkdirSync(last);
    writeFileSync(settingsFile(), JSON.stringify({ folders: { media: gone }, lastFolder: last }));
    expect((await load()).startFolder('media')).toBe(last);

    rmSync(last, { recursive: true });
    expect((await load()).startFolder('media')).toBe(paths.videos);
  });
});
