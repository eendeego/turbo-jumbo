import {fileURLToPath} from 'node:url';
import {dirname} from 'node:path';

const rootDir = dirname(fileURLToPath(import.meta.url));

// Under Turbopack the StyleX SWC loader (configured in next.config.ts) compiles
// the JS but does NOT extract CSS, so this PostCSS pass does the extraction.
// Both passes must share the same rsOptions. The @stylex directive in
// app/globals.css is replaced with the generated CSS.
/** @type {import('postcss-load-config').Config} */
export default {
  plugins: {
    '@stylexswc/postcss-plugin': {
      include: [
        'app/**/*.{ts,tsx}',
        'components/**/*.{ts,tsx}',
        'lib/**/*.{ts,tsx}',
      ],
      rsOptions: {
        dev: process.env.NODE_ENV !== 'production',
        unstable_moduleResolution: {type: 'commonJS', rootDir},
      },
    },
    autoprefixer: {},
  },
};
