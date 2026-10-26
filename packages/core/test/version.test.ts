import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  formatVersion,
  isNewerVersion,
  isValidVersion,
  parseVersion,
  versionChange,
} from '../src/version.js';

describe('semantic versions', () => {
  it('parses major, minor, patch, pre-release and build', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [], build: [] });
    expect(parseVersion('v0.10.0-beta.2+exp.sha.5114f85')).toEqual({
      major: 0,
      minor: 10,
      patch: 0,
      prerelease: ['beta', 2],
      build: ['exp', 'sha', '5114f85'],
    });
    expect(parseVersion(' v1.0.0 ')?.major).toBe(1);
    expect(formatVersion(parseVersion('v1.0.0-rc.1+7') as never)).toBe('1.0.0-rc.1+7');
  });

  it('rejects what is not a semantic version', () => {
    for (const bad of [
      '',
      '1',
      '1.2',
      '1.2.3.4',
      '01.2.3',
      '1.02.3',
      '1.2.03',
      '1.2.3-',
      '1.2.3-01',
      '1.2.3-beta..1',
      '1.2.3+',
      'V1.2.3',
      'version 1.2.3',
      '1.2.3-beta_1',
      '99999999999999999999.0.0',
    ]) {
      expect(isValidVersion(bad), bad).toBe(false);
    }
    expect(isValidVersion('1.2.3-0.rc-1.x7')).toBe(true);
  });

  it('orders by major, then minor, then patch', () => {
    const ordered = ['0.9.9', '1.0.0', '1.0.1', '1.1.0', '1.10.0', '2.0.0', '10.0.0'];
    for (let i = 1; i < ordered.length; i++) {
      expect(compareVersions(ordered[i - 1] as string, ordered[i] as string)).toBe(-1);
      expect(compareVersions(ordered[i] as string, ordered[i - 1] as string)).toBe(1);
    }
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
  });

  it('orders pre-releases as semver.org does, ignoring build metadata', () => {
    // The example of semver.org, section 11.
    const ordered = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
    ];
    for (let i = 1; i < ordered.length; i++) {
      expect(
        compareVersions(ordered[i - 1] as string, ordered[i] as string),
        `${ordered[i - 1]} < ${ordered[i]}`,
      ).toBe(-1);
    }
    expect(compareVersions('1.0.0+build.1', '1.0.0+build.2')).toBe(0);
    expect(() => compareVersions('1.0', '1.0.0')).toThrow(/Invalid version/);
  });

  it('says whether a version is newer, and what kind of step it is', () => {
    expect(isNewerVersion('v0.2.0', '0.1.0')).toBe(true);
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false);
    expect(isNewerVersion('0.1.0-rc.1', '0.1.0')).toBe(false);
    expect(isNewerVersion('nightly', '0.1.0')).toBe(false);
    expect(versionChange('1.4.2', '2.0.0')).toBe('major');
    expect(versionChange('1.4.2', '1.5.0')).toBe('minor');
    expect(versionChange('1.4.2', '1.4.3')).toBe('patch');
    expect(versionChange('1.5.0-beta.1', '1.5.0')).toBe('prerelease');
    expect(versionChange('1.5.0-beta.1', '1.5.0-beta.2')).toBe('prerelease');
    expect(versionChange('2.0.0', '1.9.9')).toBeNull();
    expect(versionChange('2.0.0', 'latest')).toBeNull();
  });
});
