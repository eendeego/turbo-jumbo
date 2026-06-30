// A tiny client-side log store with pub/sub, so the Operation Log UI can show
// the browser's own HTTP/WebSocket activity. Capped to the most recent entries.

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

export interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
}

export const LEVELS: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

const MAX = 500;
let _entries: LogEntry[] = [];
const _listeners = new Set<() => void>();

export function clientLog(level: LogLevel, msg: string): void {
  const entry: LogEntry = {ts: new Date().toISOString(), level, msg};
  _entries =
    _entries.length >= MAX
      ? [..._entries.slice(1), entry]
      : [..._entries, entry];
  for (const fn of _listeners) fn();
}

export function getEntries(): LogEntry[] {
  return _entries;
}

export function subscribe(fn: () => void): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}
