import type {WsMessage} from './ws-messages';
import {clientLog} from './client-log';

type Listener = (msg: WsMessage) => void;

let socket: WebSocket | null = null;
let reconnectTimer: number | undefined;
const listeners = new Set<Listener>();

function connect(): void {
  if (socket) return;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
  socket = ws;

  ws.onopen = () => clientLog('info', '[ws] connected');

  ws.onmessage = (e: MessageEvent) => {
    const msg = JSON.parse(e.data as string) as WsMessage;
    for (const fn of listeners) fn(msg);
  };

  ws.onclose = (e: CloseEvent) => {
    clientLog('info', `[ws] closed: code=${e.code} reason="${e.reason}"`);
    socket = null;
    if (listeners.size > 0) {
      reconnectTimer = window.setTimeout(connect, 3000);
    }
  };

  ws.onerror = () => {
    clientLog('warn', '[ws] connection error');
    ws.close();
  };
}

// Subscribe to peer-up/peer-down messages. Several components independently
// care about these events (peer status in the app chrome, model refresh in
// the inventory view); this multiplexes them over a single /ws connection
// instead of each subscriber opening its own, which used to cause a burst of
// simultaneous connections from one browser tab. Opens the connection on the
// first subscriber and tears it down once the last one unsubscribes.
export function subscribeToPeerEvents(fn: Listener): () => void {
  listeners.add(fn);
  connect();
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) {
      window.clearTimeout(reconnectTimer);
      socket?.close();
      socket = null;
    }
  };
}
