import type {ReactNode} from 'react';
import {Providers} from './providers';

// Astryx base + theme styles (side-effect imports), then the StyleX output.
import '@astryxdesign/core/reset.css';
import '@astryxdesign/core/astryx.css';
import '@astryxdesign/theme-neutral/theme.css';
import './globals.css';

export const metadata = {
  title: 'Turbo Jumbo',
};

export default function RootLayout({children}: {children: ReactNode}) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
