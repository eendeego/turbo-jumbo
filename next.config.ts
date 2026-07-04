import type {NextConfig} from 'next';
import withStylexTurbopack from '@stylexswc/nextjs-plugin/turbopack';

const rootDir = process.cwd();

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle (.next/standalone/server.js) so the
  // Docker image can run without an installed node_modules. See Dockerfile.
  output: 'standalone',
  // Lets an isolated dev/build run write to its own dir (e.g. .next-verify)
  // instead of clobbering the primary .next used by a running dev server.
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  // Lets screenshot/video captures hide the dev-tools indicator bubble.
  devIndicators: process.env.NEXT_DEV_INDICATORS === '0' ? false : undefined,
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
