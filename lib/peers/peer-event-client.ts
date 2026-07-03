import type {PeerEvent} from './peer-event-types';
import {clientLog} from '@/lib/util/client-log';

type Listener = (event: PeerEvent) => void;

let source: EventSource | null = null;
const listeners = new Set<Listener>();

function connect(): void {
  if (source) return;
  const es = new EventSource('/api/v1/events');
  source = es;

  es.onopen = () => clientLog('info', '[events] connected');

  es.onmessage = (e: MessageEvent) => {
    const event = JSON.parse(e.data as string) as PeerEvent;
    for (const fn of listeners) fn(event);
  };

  // EventSource reconnects (and replays state, courtesy of the server) on its
  // own, so a dropped connection only needs to be logged.
  es.onerror = () => clientLog('warn', '[events] connection lost, retrying');
}

// Subscribe to peer-up/peer-down events. Several components independently
// care about these (peer status in the app chrome, model refresh in the
// inventory view); this multiplexes them over a single /api/v1/events stream
// instead of each subscriber opening its own. Opens the connection on the
// first subscriber and tears it down once the last one unsubscribes.
export function subscribeToPeerEvents(fn: Listener): () => void {
  listeners.add(fn);
  connect();
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) {
      source?.close();
      source = null;
    }
  };
}
