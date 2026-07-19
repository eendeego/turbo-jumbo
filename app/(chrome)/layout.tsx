import type {ReactNode} from 'react';
import {config} from '@/lib/config';
import {appVersion} from '@/lib/version/app-version';
import {AppChrome} from '@/components/chrome/app-chrome';

// Static shell wrapper. It carries no route params, so it never re-renders on
// navigation — AppChrome derives the active location from the URL client-side,
// which keeps the location tabs correct regardless of layout re-render timing.
// The `modal` slot hosts the intercepted Lemonade download modal and renders
// null (default.tsx) whenever no modal route is active.
export default function ChromeLayout({
  children,
  modal,
}: {
  children: ReactNode;
  modal: ReactNode;
}) {
  return (
    <AppChrome
      peers={config.peers}
      logLevel={config.log_level ?? 'info'}
      version={appVersion()}
    >
      {children}
      {modal}
    </AppChrome>
  );
}
