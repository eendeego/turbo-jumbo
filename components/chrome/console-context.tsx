'use client';

import {createContext, useContext} from 'react';

export type ConsoleState = {open: boolean; toggle: () => void};

const ConsoleContext = createContext<ConsoleState | null>(null);

export const ConsoleProvider = ConsoleContext.Provider;

// Read the global console state. The provider lives in AppChrome (the persistent
// layout), so any view — the table's action bar, a keyboard handler — drives the
// same overlay.
export function useConsole(): ConsoleState {
  const ctx = useContext(ConsoleContext);
  if (!ctx) throw new Error('useConsole must be used within ConsoleProvider');
  return ctx;
}
