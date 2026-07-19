import {expect, test} from 'bun:test';
import {resolveAppVersion, versionLabel} from '@/lib/version/resolve-version';

test('official when the baked release tag matches the package version', () => {
  expect(
    resolveAppVersion({
      pkgVersion: '0.2.0',
      releaseTag: 'v0.2.0',
      gitExactTag: null,
      gitDirty: false,
      commit: 'abc1234',
    }),
  ).toEqual({version: '0.2.0', dev: false, commit: 'abc1234'});
});

test('official when git sits exactly on the matching tag with a clean tree', () => {
  expect(
    resolveAppVersion({
      pkgVersion: '0.2.0',
      releaseTag: null,
      gitExactTag: 'v0.2.0',
      gitDirty: false,
      commit: 'abc1234',
    }).dev,
  ).toBe(false);
});

test('dev when the tree is dirty, even sitting on the matching tag', () => {
  expect(
    resolveAppVersion({
      pkgVersion: '0.2.0',
      releaseTag: null,
      gitExactTag: 'v0.2.0',
      gitDirty: true,
      commit: 'abc1234',
    }).dev,
  ).toBe(true);
});

test('dev when no tag information is available at all', () => {
  expect(
    resolveAppVersion({
      pkgVersion: '0.2.0',
      releaseTag: null,
      gitExactTag: null,
      gitDirty: false,
      commit: null,
    }),
  ).toEqual({version: '0.2.0', dev: true, commit: null});
});

test('dev when the tag names a different version than the package', () => {
  expect(
    resolveAppVersion({
      pkgVersion: '0.3.0',
      releaseTag: 'v0.2.0',
      gitExactTag: null,
      gitDirty: false,
      commit: 'abc1234',
    }).dev,
  ).toBe(true);
  expect(
    resolveAppVersion({
      pkgVersion: '0.3.0',
      releaseTag: null,
      gitExactTag: 'v0.2.0',
      gitDirty: false,
      commit: 'abc1234',
    }).dev,
  ).toBe(true);
});

test('versionLabel appends a dev marker only for unofficial builds', () => {
  expect(versionLabel({version: '0.2.0', dev: false, commit: 'abc1234'})).toBe(
    'v0.2.0',
  );
  expect(versionLabel({version: '0.2.0', dev: true, commit: null})).toBe(
    'v0.2.0 · dev',
  );
});
