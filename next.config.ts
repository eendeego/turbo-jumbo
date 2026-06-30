import type {NextConfig} from 'next';
import withStylexTurbopack from '@stylexswc/nextjs-plugin/turbopack';

const rootDir = process.cwd();

const nextConfig: NextConfig = {};

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
