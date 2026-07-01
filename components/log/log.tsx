'use client';

import {useEffect, useRef, useState} from 'react';
import * as stylex from '@stylexjs/stylex';
import {
  getEntries,
  subscribe,
  LEVELS,
  type LogEntry,
  type LogLevel,
} from '@/lib/client-log';

// Deliberately off-brand retro "terminal" palette. This console is not built
// from Astryx surface components — it is a raw fixed overlay styled entirely
// through this local StyleX block. See docs/plans/2026-04-12-doom-console-design.md.
const LEVEL_COLOR: Record<string, string> = {
  error: '#f87171',
  warn: '#fbbf24',
  info: '#4ade80',
  debug: '#3a6a3a',
  trace: '#2a5a2a',
};

const styles = stylex.create({
  // A fixed overlay pinned to the bottom, outside the page layout. The action
  // bar sits above it (its own z-index), so its Console toggle stays
  // clickable; the bottom padding keeps the newest lines clear of the bar.
  root: {
    position: 'fixed',
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 40,
    height: '50vh',
    overflowY: 'auto',
    background: '#0c1a0c',
    fontFamily: 'monospace',
    borderTop: '1px solid #1a3a1a',
    padding: '8px 16px 72px',
  },
  empty: {color: '#3a6a3a'},
  list: {display: 'flex', flexDirection: 'column', gap: '1px'},
  row: {display: 'flex', gap: '8px', lineHeight: '20px', fontSize: '12px'},
  ts: {color: '#3a6a3a', flexShrink: 0},
  level: {
    textTransform: 'uppercase',
    fontWeight: 600,
    flexShrink: 0,
    width: '3.5rem',
  },
  msg: {color: '#86efac', wordBreak: 'break-all'},
});

// The global console panel: a controlled fixed overlay pinned to the bottom,
// outside the page layout. Visibility is owned by the layout shell (AppChrome)
// and toggled from the table's action-bar Console button or the ~ key. Always
// mounted so it keeps collecting entries; renders nothing when closed.
export function Log({
  logLevel,
  open,
  onToggle,
}: {
  logLevel: string;
  open: boolean;
  onToggle: () => void;
}) {
  const [entries, setEntries] = useState<LogEntry[]>(getEntries);
  const containerRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  useEffect(() => subscribe(() => setEntries(getEntries())), []);

  // Auto-scroll when pinned to bottom
  useEffect(() => {
    if (open && pinnedRef.current) {
      const el = containerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [entries, open]);

  // Keyboard shortcut: ~ key toggles the console
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === '~' || e.key === '`') {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        if ((e.target as HTMLElement)?.isContentEditable) return;
        e.preventDefault();
        onToggle();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onToggle]);

  function onScroll() {
    const el = containerRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
  }

  if (!open) return null;

  const configLevel = (logLevel in LEVELS ? logLevel : 'info') as LogLevel;
  const visible = entries.filter((e) => LEVELS[e.level] <= LEVELS[configLevel]);

  return (
    <div ref={containerRef} onScroll={onScroll} {...stylex.props(styles.root)}>
      {visible.length === 0 ? (
        <p {...stylex.props(styles.empty)}>No log entries yet.</p>
      ) : (
        <div {...stylex.props(styles.list)}>
          {visible.map((e, i) => (
            <div key={`${e.ts}-${i}`} {...stylex.props(styles.row)}>
              <span {...stylex.props(styles.ts)}>{e.ts.slice(11, 19)}</span>
              <span
                {...stylex.props(styles.level)}
                style={{color: LEVEL_COLOR[e.level] ?? '#3a6a3a'}}
              >
                {e.level}
              </span>
              <span {...stylex.props(styles.msg)}>{e.msg}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
