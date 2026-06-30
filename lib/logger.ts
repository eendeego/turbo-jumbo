import {config} from './config';

const LEVELS = {error: 0, warn: 1, info: 2, debug: 3, trace: 4} as const;
type Level = keyof typeof LEVELS;

function effectiveLevel(): Level {
  try {
    const l = config.log_level;
    if (l && l in LEVELS) return l as Level;
  } catch {
    /* config not yet available */
  }
  return 'info';
}

function argToString(a: unknown): string {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack ?? a.message;
  return JSON.stringify(a);
}

function log(level: Level, ...args: unknown[]): void {
  if (LEVELS[level] > LEVELS[effectiveLevel()]) return;
  const ts = new Date().toISOString();
  const msg = args.map(argToString).join(' ');
  const fn =
    level === 'error'
      ? console.error
      : level === 'warn'
        ? console.warn
        : console.log;
  fn(`[${ts}] [${level.toUpperCase()}]`, msg);
}

export const logger = {
  error: (...args: unknown[]) => log('error', ...args),
  warn: (...args: unknown[]) => log('warn', ...args),
  info: (...args: unknown[]) => log('info', ...args),
  debug: (...args: unknown[]) => log('debug', ...args),
  trace: (...args: unknown[]) => log('trace', ...args),
};
