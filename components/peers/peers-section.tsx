'use client';

import {useEffect, useState} from 'react';
import type {Peer} from '@/lib/config';
import type {Model} from '@/lib/model-types';
import type {WsMessage} from '@/lib/ws-messages';
import {Banner} from '@astryxdesign/core/Banner';
import {PeerSection, type PeerModels} from '@/components/peers/peer-section';
import {AsyncState} from '@/lib/async-state';
import {clientLog} from '@/lib/client-log';

export function PeersSection({coldModels}: {coldModels: Model[]}) {
  const [peers, setPeers] = useState<AsyncState<Peer[]>>(
    AsyncState.loading<Peer[]>(),
  );
  const [peerModels, setPeerModels] = useState<Map<string, PeerModels>>(
    new Map(),
  );

  useEffect(() => {
    clientLog('debug', '[http] GET /api/v1/peers');
    fetch('/api/v1/peers')
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json();
      })
      .then((data: Peer[]) => {
        clientLog('debug', `[http] GET /api/v1/peers → ${data.length} peer(s)`);
        setPeers(AsyncState.value(data));
        setPeerModels(
          new Map(data.map((p) => [p.address, AsyncState.empty()])),
        );
      })
      .catch((e: Error) => {
        clientLog('debug', `[http] GET /api/v1/peers → error: ${e.message}`);
        setPeers(AsyncState.error(e.message));
      });
  }, []);

  const peerList = peers.type === 'value' ? peers.value : null;

  // Poll every peer's models through the same-origin proxy.
  useEffect(() => {
    if (!peerList) return;

    const fetchPeer = (peer: Peer) => {
      const url = `/api/v1/peers/${encodeURIComponent(peer.name)}/models`;
      clientLog('trace', `[http] GET ${url} (poll)`);
      fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
          return r.json();
        })
        .then((models: Model[]) => {
          clientLog('trace', `[http] GET ${url} → ${models.length} model(s)`);
          setPeerModels((prev) =>
            new Map(prev).set(peer.address, AsyncState.value(models)),
          );
        })
        .catch((e: Error) => {
          clientLog('trace', `[http] GET ${url} → error: ${e.message}`);
          setPeerModels((prev) =>
            new Map(prev).set(peer.address, AsyncState.error(e.message)),
          );
        });
    };

    peerList.forEach(fetchPeer);
    const id = setInterval(() => peerList.forEach(fetchPeer), 5000);
    return () => clearInterval(id);
  }, [peerList]);

  // WebSocket: peer-down notifications give instant down detection between polls.
  useEffect(() => {
    let cancelled = false;

    function connect() {
      if (cancelled) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${protocol}//${window.location.host}/ws`);

      socket.onopen = () => clientLog('info', '[ws] connected');

      socket.onmessage = (e: MessageEvent) => {
        const msg = JSON.parse(e.data as string) as WsMessage;
        if (msg.type === 'peer-down') {
          clientLog('info', `[ws] peer-down: ${msg.address}`);
          setPeerModels((prev) =>
            new Map(prev).set(msg.address, AsyncState.error('Host is down')),
          );
        }
      };

      socket.onclose = () => {
        clientLog('info', '[ws] disconnected, reconnecting in 3s');
        if (!cancelled) setTimeout(connect, 3000);
      };
      socket.onerror = () => {
        clientLog('warn', '[ws] connection error');
        socket.close();
      };
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
