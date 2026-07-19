// Pure resolution of the app's version identity — what version this build is
// and whether it's an official tagged release. The impure inputs (package
// version, baked release env, git state) are gathered by app-version.ts; this
// stays importable from client code and tests.

/** The running app's version identity, as served by /api/v1/version. */
export interface AppVersion {
  version: string; // package.json semver
  dev: boolean; // true unless this is exactly an official tagged release
  commit: string | null; // short commit id when known
}

/**
 * A build is official only when a tag naming exactly `v<package version>`
 * pins it: either baked in at Docker build time (TJ_RELEASE), or read live
 * from git — where uncommitted changes demote it back to dev, since the code
 * running no longer matches the tagged revision.
 */
export function resolveAppVersion(input: {
  pkgVersion: string;
  releaseTag: string | null; // tag stamped into the build environment
  gitExactTag: string | null; // `git describe --tags --exact-match`, if any
  gitDirty: boolean;
  commit: string | null;
}): AppVersion {
  const expected = `v${input.pkgVersion}`;
  const official =
    input.releaseTag === expected ||
    (input.gitExactTag === expected && !input.gitDirty);
  return {version: input.pkgVersion, dev: !official, commit: input.commit};
}

/** The header/display form: `v0.2.0`, or `v0.2.0 · dev` for unofficial builds. */
export function versionLabel(v: AppVersion): string {
  return v.dev ? `v${v.version} · dev` : `v${v.version}`;
}
