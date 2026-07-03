'use client';

import {useEffect, useState, useCallback, useRef} from 'react';
import type {Peer as PeerConfig} from '@/lib/config';
import type {Model} from '@/lib/models/model-types';
import type {PeerModels} from '@/components/peers/peer';
import {AsyncState} from '@/lib/util/async-state';
import {clientLog} from '@/lib/util/client-log';
import {subscribeToPeerEvents} from '@/lib/peers/peer-event-client';

// Shared peer state: fetches the peer list, polls each peer's models through
// the same-origin proxy, and reacts to peer-down notifications. Lets
// the models table and the Peers section render from one source of truth.
export function usePeerModels() {
  const [peers, setPeers] = useState<AsyncState<PeerConfig[]>>(
    AsyncState.loading<PeerConfig[]>(),
  );
  const [peerModels, setPeerModels] = useState<Map<string, PeerModels>>(
    new Map(),
  );
  const pollIntervalRef = useRef<number>(5000);
  // Last response body applied per peer address. Polls usually return the
  // same payload; skipping the state write in that case avoids re-rendering
  // the whole page every tick. Cleared whenever the state is set to anything
  // other than that payload, so the next poll always re-applies.
  const lastPayloadRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    clientLog('debug', '[http] GET /api/v1/peers');
    fetch('/api/v1/peers')
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json();
      })
      .then((data: {peers: PeerConfig[]; interval: number}) => {
        clientLog(
          'debug',
          `[http] GET /api/v1/peers → ${data.peers.length} peer(s)`,
        );
        setPeers(AsyncState.value(data.peers));
        setPeerModels(
          new Map(data.peers.map((p) => [p.address, AsyncState.empty()])),
        );
        pollIntervalRef.current = data.interval * 1000;
      })
      .catch((e: Error) => {
        clientLog('debug', `[http] GET /api/v1/peers → error: ${e.message}`);
        setPeers(AsyncState.error(e.message));
      });
  }, []);

  const activePeers = peers.type === 'value' ? peers.value : null;

  useEffect(() => {
    if (!activePeers) return;
    const peerList = activePeers;

    const fetchPeer = (peer: PeerConfig) => {
      const url = `/api/v1/peers/${encodeURIComponent(peer.name)}/models`;
      clientLog('trace', `[http] GET ${url} (poll)`);
      fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
          return r.text();
        })
        .then((body) => {
          if (lastPayloadRef.current.get(peer.address) === body) {
            clientLog('trace', `[http] GET ${url} → unchanged`);
            return;
          }
          const models = JSON.parse(body) as Model[];
          clientLog('trace', `[http] GET ${url} → ${models.length} model(s)`);
          lastPayloadRef.current.set(peer.address, body);
          setPeerModels((prev) =>
            new Map(prev).set(peer.address, AsyncState.value(models)),
          );
        })
        .catch((e: Error) => {
          clientLog('trace', `[http] GET ${url} → error: ${e.message}`);
          lastPayloadRef.current.delete(peer.address);
          setPeerModels((prev) =>
            new Map(prev).set(peer.address, AsyncState.error(e.message)),
          );
        });
    };

    peerList.forEach((peer) => {
      lastPayloadRef.current.delete(peer.address);
      setPeerModels((prev) =>
        new Map(prev).set(peer.address, AsyncState.loading()),
      );
      fetchPeer(peer);
    });

    const interval = pollIntervalRef.current;
    const id = setInterval(() => peerList.forEach(fetchPeer), interval);
    return () => clearInterval(id);
  }, [activePeers]);

  useEffect(() => {
    return subscribeToPeerEvents((msg) => {
      if (msg.type === 'peer-down') {
        clientLog('info', `[ws] peer-down: ${msg.address}`);
        lastPayloadRef.current.delete(msg.address);
        setPeerModels((prev) =>
          new Map(prev).set(msg.address, AsyncState.error('Host is down')),
        );
      }
    });
  }, []);

  const handleModelsRefreshed = useCallback(
    (address: string, models: Model[]) => {
      lastPayloadRef.current.delete(address);
      setPeerModels((prev) =>
        new Map(prev).set(address, AsyncState.value(models)),
      );
    },
    [],
  );

  return {peers, peerModels, handleModelsRefreshed};
}
