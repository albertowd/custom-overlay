import { vi } from 'vitest';
import { installApi } from '../../src/app/api';
import type { AppApi } from '../../src/shared/api';

type Mocked<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? ReturnType<typeof vi.fn<(...args: A) => R>>
    : T[K];
};

/** An app API whose every method is a `vi.fn` resolving to an empty / cancelled answer. */
export type FakeApi = Mocked<AppApi>;

export function createFakeApi(overrides: Partial<AppApi> = {}): FakeApi {
  const api: AppApi = {
    capabilities: { videoExport: true, revealFiles: true, sequenceAsZip: false },
    getLanguage: async () => 'en',
    setLanguage: async () => undefined,
    selectVideos: async () => [],
    withChapters: async (selected) => selected,
    selectSources: async () => [],
    detectSourceKind: async () => null,
    loadVideo: async () => {
      throw new Error('loadVideo not faked');
    },
    loadSource: async () => {
      throw new Error('loadSource not faked');
    },
    openProject: async () => null,
    getStartupProject: async () => null,
    saveProject: async () => null,
    openTemplate: async () => null,
    saveTemplate: async () => null,
    selectOutput: async () => null,
    evaluateValues: async () => {
      throw new Error('evaluateValues not faked');
    },
    openValueCollection: async () => null,
    saveValueCollection: async () => null,
    openWidgets: async () => [],
    saveWidget: async () => null,
    openTrack: async () => null,
    saveTrack: async () => null,
    trackCatalog: async () => null,
    startExport: async () => {
      throw new Error('startExport not faked');
    },
    cancelExport: async () => undefined,
    onExportProgress: () => () => undefined,
    revealPath: async () => undefined,
    appInfo: async () => ({
      name: 'Custom Overlay',
      version: '0.1.0',
      author: 'Alberto',
      homepage: 'https://github.com/example/custom-overlay',
    }),
    checkForUpdate: async () => null,
    openProjectUrl: async () => undefined,
    getPathForFile: (file) => `/dropped/${file.name}`,
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(api).map(([name, value]) => [name, typeof value === 'function' ? vi.fn(value) : value]),
  ) as FakeApi;
}

let installed: FakeApi | null = null;

/** The fake API of the running test (see setup.ts), with its mocks typed. */
export function api(): FakeApi {
  if (!installed) throw new Error('No fake API installed');
  return installed;
}

/** Install a fresh fake as the app API and return it. */
export function installFakeApi(overrides: Partial<AppApi> = {}): FakeApi {
  installed = createFakeApi(overrides);
  installApi(installed);
  return installed;
}
