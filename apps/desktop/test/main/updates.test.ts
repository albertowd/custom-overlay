import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pkg from '../../package.json';
import { appInfo, checkForUpdate, isProjectUrl } from '../../src/main/updates';
import { app } from './electron-mock';

vi.mock('electron', () => import('./electron-mock'));

const fetchMock = vi.fn<typeof fetch>();

function release(overrides: Record<string, unknown> = {}) {
  return {
    tag_name: 'v1.3.0',
    name: 'Better sync',
    body: '  Faster exports.  ',
    html_url: 'https://github.com/albertowd/custom-overlay/releases/tag/v1.3.0',
    draft: false,
    prerelease: false,
    assets: [
      { name: 'custom-overlay-1.3.0-win-x64.exe', browser_download_url: 'https://dl/win-x64.exe' },
      { name: 'custom-overlay-1.3.0-win-arm64.exe', browser_download_url: 'https://dl/win-arm64.exe' },
      { name: 'custom-overlay-1.3.0-mac-arm64.dmg', browser_download_url: 'https://dl/mac-arm64.dmg' },
      { name: 'custom-overlay-1.3.0-linux-x64.AppImage', browser_download_url: 'https://dl/linux.AppImage' },
    ],
    ...overrides,
  };
}

const respond = (body: unknown, status = 200) =>
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));

function onPlatform(platform: NodeJS.Platform, arch: NodeJS.Architecture): void {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
  vi.spyOn(process, 'arch', 'get').mockReturnValue(arch);
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  app.isPackaged = true;
  app.getVersion.mockReturnValue('1.2.0');
  onPlatform('win32', 'x64');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('appInfo', () => {
  it('describes this build', () => {
    expect(appInfo()).toEqual({
      name: 'Custom Overlay',
      version: '1.2.0',
      author: pkg.author,
      homepage: 'https://github.com/albertowd/custom-overlay',
    });
  });
});

describe('checkForUpdate', () => {
  it('offers a newer release with the installer of this OS', async () => {
    respond(release());
    expect(await checkForUpdate()).toEqual({
      current: '1.2.0',
      latest: '1.3.0',
      change: 'minor',
      title: 'Better sync',
      notes: 'Faster exports.',
      pageUrl: 'https://github.com/albertowd/custom-overlay/releases/tag/v1.3.0',
      downloadUrl: 'https://dl/win-x64.exe',
      assetName: 'custom-overlay-1.3.0-win-x64.exe',
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('https://api.github.com/repos/albertowd/custom-overlay/releases/latest');
    expect(init?.headers).toMatchObject({ 'User-Agent': 'custom-overlay/1.2.0' });
  });

  it.each([
    ['win32', 'arm64', 'https://dl/win-arm64.exe'],
    ['darwin', 'arm64', 'https://dl/mac-arm64.dmg'],
    ['darwin', 'x64', null],
    ['linux', 'x64', 'https://dl/linux.AppImage'],
    ['freebsd', 'x64', null],
  ] as const)('picks the %s %s installer', async (platform, arch, url) => {
    onPlatform(platform, arch);
    respond(release());
    expect((await checkForUpdate())?.downloadUrl).toBe(url);
  });

  it('uses the tag as title and empty notes when the release has none', async () => {
    respond(release({ tag_name: 'v2.0.0', name: null, body: null }));
    expect(await checkForUpdate()).toMatchObject({ title: 'v2.0.0', notes: '', change: 'major' });
  });

  it('shortens long release notes', async () => {
    respond(release({ body: 'x'.repeat(5000) }));
    expect((await checkForUpdate())?.notes).toHaveLength(2000);
  });

  it.each([
    ['the same version', { tag_name: 'v1.2.0' }],
    ['an older version', { tag_name: 'v1.1.9' }],
    ['a draft', { draft: true }],
    ['a tag that is not a version', { tag_name: 'nightly' }],
  ])('ignores %s', async (_name, overrides) => {
    respond(release(overrides));
    expect(await checkForUpdate()).toBeNull();
  });

  it('returns null when GitHub answers an error or cannot be reached', async () => {
    respond({ message: 'Not Found' }, 404);
    expect(await checkForUpdate()).toBeNull();
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await checkForUpdate()).toBeNull();
  });

  it('only checks in development builds when asked to', async () => {
    app.isPackaged = false;
    expect(await checkForUpdate()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubEnv('CUSTOM_OVERLAY_CHECK_UPDATES', '1');
    respond(release());
    expect(await checkForUpdate()).not.toBeNull();
  });
});

describe('isProjectUrl', () => {
  it('only accepts pages of the project on GitHub', () => {
    expect(isProjectUrl('https://github.com/albertowd/custom-overlay/releases')).toBe(true);
    expect(isProjectUrl('https://github.com/someone/else')).toBe(false);
    expect(isProjectUrl('http://github.com/albertowd/custom-overlay')).toBe(false);
    expect(isProjectUrl('file:///etc/passwd')).toBe(false);
    expect(isProjectUrl('https://github.com/albertowd/custom-overlay')).toBe(true);
    expect(isProjectUrl('https://github.com/albertowd/custom-overlay?tab=readme')).toBe(true);
    expect(isProjectUrl('https://github.com/albertowd/custom-overlay-evil')).toBe(false);
    expect(isProjectUrl('https://github.com/albertowd/custom-overlay.evil.com/x')).toBe(false);
    expect(isProjectUrl('https://github.com.evil.com/albertowd/custom-overlay')).toBe(false);
    expect(isProjectUrl('https://user@github.com/albertowd/custom-overlay')).toBe(false);
    expect(isProjectUrl('not a url')).toBe(false);
  });
});
