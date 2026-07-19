// Server-side resolution of the running app's version identity. Gathers the
// impure inputs — package.json, the TJ_RELEASE/TJ_COMMIT env a release Docker
// build bakes in, and live git state in a checkout — and hands them to the
// pure resolver. Server-only (shells out to git); client code imports from
// resolve-version instead.

import {execFileSync} from 'child_process';
import pkg from '@/package.json';
import {
  resolveAppVersion,
  type AppVersion,
} from '@/lib/version/resolve-version';

function git(...args: string[]): string | null {
  try {
    return execFileSync('git', args, {stdio: ['ignore', 'pipe', 'ignore']})
      .toString()
      .trim();
  } catch {
    // No git binary (production image) or not a repo: the env stamps decide.
    return null;
  }
}

function compute(): AppVersion {
  const status = git('status', '--porcelain');
  return resolveAppVersion({
    pkgVersion: pkg.version,
    releaseTag: process.env.TJ_RELEASE || null,
    gitExactTag: git('describe', '--tags', '--exact-match', 'HEAD'),
    // Uncommitted changes mean the code diverges from any tag HEAD carries.
    gitDirty: status !== null && status !== '',
    commit:
      git('rev-parse', '--short', 'HEAD') ?? process.env.TJ_COMMIT ?? null,
  });
}

let cached: AppVersion | null = null;

/** The app's version identity, computed once per server process. */
export function appVersion(): AppVersion {
  return (cached ??= compute());
}
