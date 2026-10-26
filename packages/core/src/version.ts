/**
 * Semantic Versioning 2.0.0 (https://semver.org): `MAJOR.MINOR.PATCH[-PRERELEASE][+BUILD]`, with an
 * optional leading `v` as in git tags (`v1.2.3`).
 */

export interface Version {
  major: number;
  minor: number;
  patch: number;
  /** Pre-release identifiers (`1.0.0-beta.2` → ['beta', 2]); empty for a release. */
  prerelease: (string | number)[];
  /** Build metadata, ignored when comparing. */
  build: string[];
}

/** The semver.org grammar: numbers without leading zeros, dot-separated identifiers. */
const SEMVER =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** A version, or null when the text is not a valid semantic version. */
export function parseVersion(text: string): Version | null {
  const match = SEMVER.exec(text.trim());
  if (!match) return null;
  const [, major, minor, patch, pre, build] = match;
  const numbers = [major, minor, patch].map(Number);
  if (!numbers.every(Number.isSafeInteger)) return null;
  return {
    major: numbers[0] as number,
    minor: numbers[1] as number,
    patch: numbers[2] as number,
    prerelease: pre ? pre.split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : [],
    build: build ? build.split('.') : [],
  };
}

/** Whether a text is a valid semantic version (`1.2.3`, `v1.2.3-rc.1+build.5`). */
export function isValidVersion(text: string): boolean {
  return parseVersion(text) !== null;
}

/** Order of two pre-release identifiers: numbers numerically and before words, words by ASCII. */
function compareIdentifiers(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'number') return -1;
  if (typeof b === 'number') return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Negative when `a` comes before `b`, positive after, 0 when they have the same precedence.
 * Major, then minor, then patch; a pre-release comes before its release; build metadata does not
 * count. Throws for invalid versions.
 */
export function compareVersions(a: string | Version, b: string | Version): number {
  const va = typeof a === 'string' ? parseVersion(a) : a;
  const vb = typeof b === 'string' ? parseVersion(b) : b;
  if (!va) throw new Error(`Invalid version: '${String(a)}'`);
  if (!vb) throw new Error(`Invalid version: '${String(b)}'`);
  const core = va.major - vb.major || va.minor - vb.minor || va.patch - vb.patch;
  if (core !== 0) return Math.sign(core);
  // A release beats any of its pre-releases.
  if (va.prerelease.length === 0 || vb.prerelease.length === 0) {
    return vb.prerelease.length - va.prerelease.length === 0 ? 0 : va.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(va.prerelease.length, vb.prerelease.length);
  for (let i = 0; i < length; i++) {
    const x = va.prerelease[i];
    const y = vb.prerelease[i];
    // A shorter set of identifiers comes first when all the others are equal.
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const order = compareIdentifiers(x, y);
    if (order !== 0) return Math.sign(order);
  }
  return 0;
}

/** Whether `candidate` is a newer version than `current`; false when either is invalid. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  return a !== null && b !== null && compareVersions(a, b) > 0;
}

export type VersionChange = 'major' | 'minor' | 'patch' | 'prerelease';

/** The kind of step from `current` up to `next`, null when `next` is not newer (or invalid). */
export function versionChange(current: string, next: string): VersionChange | null {
  const a = parseVersion(current);
  const b = parseVersion(next);
  if (!a || !b || compareVersions(b, a) <= 0) return null;
  if (b.major !== a.major) return 'major';
  if (b.minor !== a.minor) return 'minor';
  if (b.patch !== a.patch) return 'patch';
  return 'prerelease';
}

/** The version as text, without a `v` (`1.2.3-beta.1+5`). */
export function formatVersion(version: Version): string {
  const pre = version.prerelease.length > 0 ? `-${version.prerelease.join('.')}` : '';
  const build = version.build.length > 0 ? `+${version.build.join('.')}` : '';
  return `${version.major}.${version.minor}.${version.patch}${pre}${build}`;
}
