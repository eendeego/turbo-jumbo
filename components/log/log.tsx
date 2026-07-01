'use client';

import {useCallback, useEffect, useRef, useState} from 'react';
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
  root: {
    position: 'fixed',
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: 50,
    fontFamily: 'monospace',
  },
  // Controlled: no handle bar, just the panel as a fixed overlay. The action
  // bar sits above it (its own z-index), so its Console toggle stays
  // clickable; the bottom padding keeps the newest lines clear of the bar.
  controlledRoot: {
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
  handle: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    padding: '6px 16px',
    background: '#122312',
    cursor: 'pointer',
    borderTop: '1px solid #1a3a1a',
    borderLeft: 'none',
    borderRight: 'none',
  },
  handleBorderOpen: {borderBottom: '1px solid #1a3a1a'},
  handleBorderClosed: {borderBottom: 'none'},
  handleLabel: {
    color: '#4a8a4a',
    fontSize: '11px',
    textTransform: 'uppercase',
    letterSpacing: '1px',
  },
  handleHint: {color: '#3a6a3a', fontSize: '11px'},
  panel: {
    transition: 'height 300ms ease-out',
    overflow: 'hidden',
    background: '#0c1a0c',
  },
  panelOpen: {height: '50vh'},
  panelClosed: {height: 0},
  scroll: {height: '100%', overflowY: 'auto', padding: '8px 16px'},
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

export function Log({
  logLevel,
  open,
  onToggle,
}: {
  logLevel: string;
  // Controlled visibility. When omitted, the panel manages its own open state
  // and shows the bottom handle bar (used by views without an action bar). When
  // provided, the parent owns visibility and the trigger (e.g. the models
  // view's action-bar Console button), and the panel renders as a plain fixed
  // overlay with no handle bar.
  open?: boolean;
  onToggle?: () => void;
}) {
  const controlled = open !== undefined;
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = controlled ? open : internalOpen;
  const toggle = useCallback(() => {
    if (onToggle) onToggle();
    else setInternalOpen((prev) => !prev);
  }, [onToggle]);

  const [entries, setEntries] = useState<LogEntry[]>(getEntries);
  const containerRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  useEffect(() => subscribe(() => setEntries(getEntries())), []);

  // Auto-scroll when pinned to bottom
  useEffect(() => {
    if (isOpen && pinnedRef.current) {
      const el = containerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [entries, isOpen]);

  // Keyboard shortcut: ~ key toggles the console
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === '~' || e.key === '`') {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        if ((e.target as HTMLElement)?.isContentEditable) return;
        e.preventDefault();
        toggle();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [toggle]);

  function onScroll() {
    const el = containerRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
  }

  const configLevel = (logLevel in LEVELS ? logLevel : 'info') as LogLevel;
  const visible = entries.filter((e) => LEVELS[e.level] <= LEVELS[configLevel]);

  const body =
    visible.length === 0 ? (
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
    );

  // Controlled: the parent owns the trigger (the action bar's Console button),
  // so render just the panel as a fixed overlay pinned to the bottom — outside
  // the page layout — and contribute nothing when closed.
  if (controlled) {
    if (!isOpen) return null;
    return (
      <div
        ref={containerRef}
        onScroll={onScroll}
        {...stylex.props(styles.controlledRoot)}
      >
        {body}
      </div>
    );
  }

  // Uncontrolled: fixed overlay with its own handle bar.
  return (
    <div {...stylex.props(styles.root)}>
      {/* Handle tab */}
      <button
        onClick={toggle}
        aria-expanded={isOpen}
        {...stylex.props(
          styles.handle,
          isOpen ? styles.handleBorderOpen : styles.handleBorderClosed,
        )}
      >
        <span {...stylex.props(styles.handleLabel)}>Console</span>
        <span {...stylex.props(styles.handleHint)}>~</span>
      </button>

      {/* Console panel */}
      <div
        {...stylex.props(
          styles.panel,
          isOpen ? styles.panelOpen : styles.panelClosed,
        )}
      >
        <div
          ref={containerRef}
          onScroll={onScroll}
          {...stylex.props(styles.scroll)}
        >
          {body}
        </div>
      </div>
    </div>
  );
}
