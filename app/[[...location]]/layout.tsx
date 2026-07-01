import type {ReactNode} from 'react';
import {config} from '@/lib/config';
import {AppChrome} from '@/components/chrome/app-chrome';

// Static shell wrapper. It carries no route params, so it never re-renders on
// navigation — AppChrome derives the active location from the URL client-side,
// which keeps the location tabs correct regardless of layout re-render timing.
export default function LocationLayout({children}: {children: ReactNode}) {
  return (
    <AppChrome peers={config.peers} logLevel={config.log_level ?? 'info'}>
      {children}
    </AppChrome>
  );
}
