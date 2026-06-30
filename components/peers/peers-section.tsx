'use client';

import {useEffect, useState} from 'react';
import type {Peer} from '@/lib/config';
import type {Model} from '@/lib/model-types';
import type {WsMessage} from '@/lib/ws-messages';
import {Banner} from '@astryxdesign/core/Banner';
import {PeerSection, type PeerModels} from '@/components/peers/peer-section';
import {AsyncState} from '@/lib/async-state';

export function PeersSection({coldModels}: {coldModels: Model[]}) {
  const [peers, setPeers] = useState<AsyncState<Peer[]>>(
    AsyncState.loading<Peer[]>(),
  );
  const [peerModels, setPeerModels] = useState<Map<string, PeerModels>>(
    new Map(),
  );

  useEffect(() => {
    fetch('/api/v1/peers')
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json();
      })
      .then((data: Peer[]) => {
        setPeers(AsyncState.value(data));
        setPeerModels(
          new Map(data.map((p) => [p.address, AsyncState.empty()])),
        );
      })
      .catch((e: Error) => setPeers(AsyncState.error(e.message)));
  }, []);

  const peerList = peers.type === 'value' ? peers.value : null;

  // Poll the local peer's models over HTTP.
  useEffect(() => {
    if (!peerList) return;
    const local = peerList.find((p) => p.isLocal);
    if (!local) return;

    const fetchLocal = () => {
      fetch('/api/v1/local-models')
        .then((r) => {
          if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
          return r.json();
        })
        .then((models: Model[]) => {
          setPeerModels((prev) =>
            new Map(prev).set(local.address, AsyncState.value(models)),
          );
        })
        .catch((e: Error) => {
          setPeerModels((prev) =>
            new Map(prev).set(local.address, AsyncState.error(e.message)),
          );
        });
    };

    fetchLocal();
    const id = setInterval(fetchLocal, 5000);
    return () => clearInterval(id);
  }, [peerList]);

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
          setPeerModels((prev) =>
            new Map(prev).set(msg.address, AsyncState.value(msg.models)),
          );
        } else if (msg.type === 'peer-down') {
          setPeerModels((prev) =>
            new Map(prev).set(msg.address, AsyncState.error('Host is down')),
          );
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

  if (peers.type === 'error')
    return (
      <Banner status="error" title={`Failed to load peers: ${peers.message}`} />
    );

  if (peers.type !== 'value' || peers.value.length === 0) return null;

  function handleModelsRefreshed(address: string, models: Model[]) {
    setPeerModels((prev) =>
      new Map(prev).set(address, AsyncState.value(models)),
    );
  }

  return (
    <>
      {peers.value.map((peer) => (
        <PeerSection
          key={peer.address}
          peer={peer}
          models={peerModels.get(peer.address) ?? AsyncState.empty()}
          coldModels={coldModels}
          onModelsRefreshed={handleModelsRefreshed}
        />
      ))}
    </>
  );
}
