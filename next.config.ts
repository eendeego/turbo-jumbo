import {readFileSync} from 'node:fs';
import type {NextConfig} from 'next';
import {load} from 'js-yaml';
import withStylexTurbopack from '@stylexswc/nextjs-plugin/turbopack';

const rootDir = process.cwd();

// Next ≥16.2 blocks cross-origin requests to dev resources, which kills
// hydration (a rendered but completely inert page) when the dev server is
// browsed via this machine's LAN address instead of localhost. Allow the peer
// hosts from the uncommitted config.yaml — the addresses people actually
// browse — plus any extra hosts in TJ_ALLOWED_DEV_ORIGINS (comma-separated,
// for e.g. a DNS alias of this machine). Only dev is affected.
function allowedDevOrigins(): string[] {
  const origins = (process.env.TJ_ALLOWED_DEV_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  try {
    const raw = readFileSync(
      process.env.CONFIG_PATH ?? './config.yaml',
      'utf8',
    );
    const cfg = load(raw) as {peers?: {address?: string}[]};
    for (const peer of cfg?.peers ?? []) {
      // address is schema-bound to host:port; strip the port and any IPv6
      // brackets (mirrors addressHost in lib/config).
      if (peer.address) {
        origins.push(peer.address.replace(/:\d+$/, '').replace(/^\[|\]$/g, ''));
      }
    }
  } catch {
    // No config.yaml (fresh checkout) — localhost-only dev needs no allowlist.
  }
  return origins;
}

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle (.next/standalone/server.js) so the
  // Docker image can run without an installed node_modules. See Dockerfile.
  output: 'standalone',
  // Lets an isolated dev/build run write to its own dir (e.g. .next-verify)
  // instead of clobbering the primary .next used by a running dev server.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  // Lets screenshot/video captures hide the dev-tools indicator bubble.
  devIndicators: process.env.NEXT_DEV_INDICATORS === '0' ? false : undefined,
  allowedDevOrigins: allowedDevOrigins(),
};

// The StyleX SWC loader transforms stylex.create / xstyle calls in app code.
// CSS is extracted by @stylexswc/postcss-plugin (see postcss.config.mjs);
// keep the rsOptions here in sync with it.
export default withStylexTurbopack({
  rsOptions: {
    dev: process.env.NODE_ENV !== 'production',
    unstable_moduleResolution: {type: 'commonJS', rootDir},
    aliases: {'@/*': [`${rootDir}/*`]},
  },
})(nextConfig);
