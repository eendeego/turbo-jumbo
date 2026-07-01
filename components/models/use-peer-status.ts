'use client';

import {useEffect, useState} from 'react';
import type {WsMessage} from '@/lib/ws-messages';
import {clientLog} from '@/lib/client-log';

// Tracks which peers are currently unreachable, keyed by address. The server
// monitors remote peers and broadcasts `peer-up`/`peer-down` over the WebSocket
// (and replays the current state to each newly connected client), so this is a
// thin subscription that just collects the down set. Used by the app chrome to
// flag the matching location tab — it needs the status, not the models, so it
// stays decoupled from the heavier peer-models poll the page content runs.
export function usePeerStatus(): ReadonlySet<string> {
  const [downPeers, setDownPeers] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);

      socket.onmessage = (e: MessageEvent) => {
        const msg = JSON.parse(e.data as string) as WsMessage;
        if (msg.type === 'peer-down') {
          setDownPeers((prev) => {
            if (prev.has(msg.address)) return prev;
            const next = new Set(prev);
            next.add(msg.address);
            return next;
          });
        } else if (msg.type === 'peer-up') {
          setDownPeers((prev) => {
            if (!prev.has(msg.address)) return prev;
            const next = new Set(prev);
            next.delete(msg.address);
            return next;
          });
        }
      };

      socket.onclose = (ev: CloseEvent) => {
        clientLog('info', `[ws] peer-status closed: code=${ev.code}`);
        if (!cancelled) setTimeout(connect, 3000);
      };
      socket.onerror = () => socket.close();
    }

    connect();
    return () => {
      cancelled = true;
    };
  }, []);

  return downPeers;
}
