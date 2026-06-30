'use client';

import {useEffect, useState} from 'react';
import type {Peer} from '@/lib/config';
import type {Model} from '@/lib/model-types';
import type {WsMessage} from '@/lib/ws-messages';
import {PeerSection} from '@/components/peers/peer-section';

export function PeersSection({coldModels}: {coldModels: Model[]}) {
  const [peers, setPeers] = useState<Peer[] | null>(null);
  const [peerModels, setPeerModels] = useState<Map<string, Model[]>>(new Map());
  const [peerDown, setPeerDown] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch('/api/v1/peers')
      .then((r) => r.json())
      .then((data: Peer[]) => setPeers(data));
  }, []);

  // Poll the local peer's models over HTTP.
  useEffect(() => {
    if (!peers) return;
    const local = peers.find((p) => p.isLocal);
    if (!local) return;

    const fetchLocal = () => {
      fetch('/api/v1/local-models')
        .then((r) => r.json())
        .then((models: Model[]) => {
          setPeerModels((prev) => new Map(prev).set(local.address, models));
        })
        .catch(() => {});
    };

    fetchLocal();
    const id = setInterval(fetchLocal, 5000);
    return () => clearInterval(id);
  }, [peers]);

  // Receive remote peer reachability and models live over the WebSocket, fed by
  // the server-side peer monitor. Reconnects automatically if the socket drops.
  useEffect(() => {
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);

      socket.onmessage = (e: MessageEvent) => {
        const msg = JSON.parse(e.data as string) as WsMessage;
        if (msg.type === 'peer-up') {
          setPeerModels((prev) => new Map(prev).set(msg.address, msg.models));
          setPeerDown((prev) => {
            const next = new Set(prev);
            next.delete(msg.address);
            return next;
          });
        } else if (msg.type === 'peer-down') {
          setPeerModels((prev) => new Map(prev).set(msg.address, []));
          setPeerDown((prev) => new Set(prev).add(msg.address));
        }
      };

      socket.onclose = () => {
        if (!cancelled) setTimeout(connect, 3000);
      };
      socket.onerror = () => socket.close();
    }

    connect();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!peers || peers.length === 0) return null;

  function handleModelsRefreshed(address: string, models: Model[]) {
    setPeerModels((prev) => new Map(prev).set(address, models));
  }

  return (
    <>
      {peers.map((peer) => (
        <PeerSection
          key={peer.address}
          peer={peer}
          models={peerModels.get(peer.address)}
          isDown={peerDown.has(peer.address)}
          coldModels={coldModels}
          onModelsRefreshed={handleModelsRefreshed}
        />
      ))}
    </>
  );
}
