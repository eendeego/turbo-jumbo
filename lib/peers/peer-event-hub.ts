import type {PeerEvent} from './peer-event-types';
import {logger} from '@/lib/util/logger';

type Listener = (event: PeerEvent) => void;

interface Hub {
  listeners: Set<Listener>;
  // Latest event per peer address, replayed to each new SSE subscriber so a
  // freshly connected browser immediately knows the current peer state.
  lastEvent: Map<string, PeerEvent>;
}

// Next bundles instrumentation.ts and each route handler as separate module
// graphs, so plain module-level state would give the peer monitor and the
// /api/v1/events route different hub instances. Anchor the state on
// globalThis to guarantee a single hub per server process.
const HUB_KEY = Symbol.for('turbo-jumbo.peer-event-hub');

function hub(): Hub {
  const g = globalThis as {[HUB_KEY]?: Hub};
  g[HUB_KEY] ??= {listeners: new Set(), lastEvent: new Map()};
  return g[HUB_KEY];
}

export function publishPeerEvent(event: PeerEvent): void {
  const h = hub();
  h.lastEvent.set(event.address, event);
  for (const fn of h.listeners) {
    try {
      fn(event);
    } catch (err) {
      // A subscriber whose response stream already died must not keep the
      // event from reaching the remaining subscribers.
      logger.warn('[events] subscriber threw:', err as Error);
    }
  }
}

export function subscribePeerEvents(fn: Listener): () => void {
  const h = hub();
  h.listeners.add(fn);
  return () => h.listeners.delete(fn);
}

export function peerEventSnapshot(): PeerEvent[] {
  return [...hub().lastEvent.values()];
}

// Test-only: drop all listeners and replay state.
export function resetPeerEventHub(): void {
  const h = hub();
  h.listeners.clear();
  h.lastEvent.clear();
}
