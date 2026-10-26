import { formatVersion, parseVersion, versionChange } from '@custom-overlay/core';
import type { AppInfo, UpdateInfo } from '@custom-overlay/ui/api';
import { app } from 'electron';
import pkg from '../../package.json';

/** Where releases are published (see .github/workflows/release.yml). */
const REPOSITORY = 'albertowd/custom-overlay';
const RELEASES_API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;

export function appInfo(): AppInfo {
  return {
    name: 'Custom Overlay',
    version: app.getVersion(),
    author: typeof pkg.author === 'string' ? pkg.author : 'Alberto',
    homepage: `https://github.com/${REPOSITORY}`,
  };
}

/** The installer of this OS / architecture among the release assets (named by the workflow). */
function installerSuffix(): string | null {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'win32') return `-win-${arch}.exe`;
  if (process.platform === 'darwin') return `-mac-${arch}.dmg`;
  if (process.platform === 'linux') return `-linux-${arch}.AppImage`;
  return null;
}

interface GitHubRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  draft: boolean;
  prerelease: boolean;
  assets: { name: string; browser_download_url: string }[];
}

/**
 * The latest GitHub release when it is newer than this app, null otherwise (or offline, or no
 * release yet). Development builds only check when CUSTOM_OVERLAY_CHECK_UPDATES=1.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!app.isPackaged && process.env.CUSTOM_OVERLAY_CHECK_UPDATES !== '1') return null;
  const current = app.getVersion();
  try {
    const response = await fetch(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `custom-overlay/${current}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const release = (await response.json()) as GitHubRelease;
    // Tags that are not semantic versions (e.g. `nightly`) are never offered.
    const latest = parseVersion(release.tag_name);
    const change = versionChange(current, release.tag_name);
    if (release.draft || !latest || !change) return null;
    const suffix = installerSuffix();
    const asset = suffix ? release.assets.find((a) => a.name.endsWith(suffix)) : undefined;
    return {
      current,
      latest: formatVersion(latest),
      change,
      title: release.name || release.tag_name,
      notes: (release.body ?? '').trim().slice(0, 2000),
      pageUrl: release.html_url,
      downloadUrl: asset?.browser_download_url ?? null,
      assetName: asset?.name ?? null,
    };
  } catch {
    // Offline or GitHub unreachable: try again next start.
    return null;
  }
}

/** Only GitHub pages of this project are opened from the update dialog and the footer. */
export function isProjectUrl(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const { protocol, host, username, password, pathname } = new URL(url);
  const root = `/${REPOSITORY}`;
  return (
    protocol === 'https:' &&
    host === 'github.com' &&
    !username &&
    !password &&
    (pathname === root || pathname.startsWith(`${root}/`))
  );
}
