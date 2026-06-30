'use client';

import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import {Theme} from '@astryxdesign/core';
import {neutralTheme} from '@astryxdesign/theme-neutral/built';

type Mode = 'light' | 'dark';

const STORAGE_KEY = 'tj-theme-mode';

// External preference store, read via useSyncExternalStore so there is no
// setState-in-effect and SSR/hydration stay consistent.
const listeners = new Set<() => void>();

function getSnapshot(): Mode {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

// Stable value for SSR and the first hydration render.
function getServerSnapshot(): Mode {
  return 'dark';
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function setStoredMode(mode: Mode): void {
  localStorage.setItem(STORAGE_KEY, mode);
  for (const cb of listeners) cb();
}

interface ThemeModeContextValue {
  mode: Mode;
  toggle: () => void;
}

const ThemeModeContext = createContext<ThemeModeContextValue | null>(null);

export function useThemeMode(): ThemeModeContextValue {
  const ctx = useContext(ThemeModeContext);
  if (!ctx) throw new Error('useThemeMode must be used within <Providers>');
  return ctx;
}

export function Providers({children}: {children: ReactNode}) {
  const mode = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const toggle = () => setStoredMode(mode === 'dark' ? 'light' : 'dark');

  return (
    <ThemeModeContext.Provider value={{mode, toggle}}>
      <Theme theme={neutralTheme} mode={mode}>
        {children}
      </Theme>
    </ThemeModeContext.Provider>
  );
}
