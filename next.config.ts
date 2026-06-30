import type {NextConfig} from 'next';
import withStylexTurbopack from '@stylexswc/nextjs-plugin/turbopack';

const rootDir = process.cwd();

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle (.next/standalone/server.js) so the
  // Docker image can run without an installed node_modules. See Dockerfile.
  output: 'standalone',
  // Allow the browser (and other peers) to call this peer's API cross-origin,
  // so the UI can read a peer's models and drive deletes/transfers on it.
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [
          {key: 'Access-Control-Allow-Origin', value: '*'},
          {
            key: 'Access-Control-Allow-Methods',
            value: 'GET, POST, DELETE, OPTIONS',
          },
          {key: 'Access-Control-Allow-Headers', value: 'Content-Type'},
        ],
      },
    ];
  },
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
