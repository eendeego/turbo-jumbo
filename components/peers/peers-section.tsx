'use client';

import {useEffect, useState} from 'react';
import {Section} from '@astryxdesign/core/Section';
import {VStack, HStack} from '@astryxdesign/core/Stack';
import {Heading, Text} from '@astryxdesign/core/Text';
import {Spinner} from '@astryxdesign/core/Spinner';
import {EmptyState} from '@astryxdesign/core/EmptyState';
import type {Peer} from '@/lib/config';
import type {Model} from '@/lib/model-types';
import type {WsMessage} from '@/lib/ws-messages';
import {
  type CopyProgress,
  readCopyProgress,
  buildFileSizes,
} from '@/lib/copy-progress';
import {ModelList} from '@/components/models/model-list';
import {ActionBar} from '@/components/models/action-bar';
import {
  DeleteModal,
  selectedFileInfo,
  anyMissingFromColdStorage,
} from '@/components/models/delete-modal';
import {CopyModal, type CopyDestinations} from '@/components/models/copy-modal';
import {
  ConflictsModal,
  type ConflictItem,
} from '@/components/models/conflicts-modal';

export function PeersSection({coldModels}: {coldModels: Model[]}) {
  const [peers, setPeers] = useState<Peer[] | null>(null);
  const [peerModels, setPeerModels] = useState<Map<string, Model[]>>(new Map());
  const [peerDown, setPeerDown] = useState<Set<string>>(new Set());
  const [peerSelections, setPeerSelections] = useState<
    Record<string, string[]>
  >({});
  const [peerDeleting, setPeerDeleting] = useState<Record<string, boolean>>({});
  const [confirmingPeer, setConfirmingPeer] = useState<Peer | null>(null);
  const [peerCopying, setPeerCopying] = useState<Record<string, boolean>>({});
  const [peerCopyProgress, setPeerCopyProgress] = useState<
    Record<string, CopyProgress | null>
  >({});
  const [confirmingCopyPeer, setConfirmingCopyPeer] = useState<Peer | null>(
    null,
  );
  const [checkingCopyPeer, setCheckingCopyPeer] = useState<Peer | null>(null);
  const [pendingConflictsPeer, setPendingConflictsPeer] = useState<Peer | null>(
    null,
  );
  const [pendingConflicts, setPendingConflicts] = useState<ConflictItem[]>([]);
  const [pendingDestinations, setPendingDestinations] =
    useState<CopyDestinations | null>(null);

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

  function onTogglePeer(addr: string, paths: string[]) {
    setPeerSelections((prev) => {
      const current = new Set(prev[addr] ?? []);
      const allSelected = paths.every((p) => current.has(p));
      if (allSelected) paths.forEach((p) => current.delete(p));
      else paths.forEach((p) => current.add(p));
      return {...prev, [addr]: Array.from(current)};
    });
  }

  async function onDeletePeer(peer: Peer) {
    setConfirmingPeer(null);
    const sel = peerSelections[peer.address] ?? [];
    setPeerDeleting((prev) => ({...prev, [peer.address]: true}));
    const base = peer.isLocal ? '' : `http://${peer.address}`;
    try {
      await fetch(`${base}/api/v1/local-models`, {
        method: 'DELETE',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({files: sel}),
      });
      const res = await fetch(`${base}/api/v1/local-models`);
      const models: Model[] = await res.json();
      setPeerModels((prev) => new Map(prev).set(peer.address, models));
      setPeerSelections((prev) => ({...prev, [peer.address]: []}));
    } finally {
      setPeerDeleting((prev) => ({...prev, [peer.address]: false}));
    }
  }

  async function onCopyPeer(peer: Peer, destinations: CopyDestinations) {
    setConfirmingCopyPeer(null);
    setCheckingCopyPeer(peer);
    let hasConflicts = false;
    try {
      const res = await fetch('/api/v1/copy/check', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          files: peerSelections[peer.address] ?? [],
          from: peer.address,
          toColdStorage: destinations.toColdStorage,
          toPeers: destinations.toPeers,
          fileSizes: buildFileSizes(peerModels.get(peer.address) ?? []),
        }),
      });
      const {conflicts} = (await res.json()) as {conflicts: ConflictItem[]};
      if (conflicts.length > 0) {
        hasConflicts = true;
        setPendingConflictsPeer(peer);
        setPendingConflicts(conflicts);
        setPendingDestinations(destinations);
      }
    } finally {
      setCheckingCopyPeer(null);
    }
    if (!hasConflicts) await doCopyPeer(peer, destinations, []);
  }

  async function onConflictsPeerConfirm(
    skip: Array<{file: string; destination: string}>,
  ) {
    if (!pendingConflictsPeer || !pendingDestinations) return;
    const peer = pendingConflictsPeer;
    const destinations = pendingDestinations;
    setPendingConflictsPeer(null);
    setPendingConflicts([]);
    setPendingDestinations(null);
    await doCopyPeer(peer, destinations, skip);
  }

  async function doCopyPeer(
    peer: Peer,
    destinations: CopyDestinations,
    skip: Array<{file: string; destination: string}>,
  ) {
    const sel = peerSelections[peer.address] ?? [];
    setPeerCopying((prev) => ({...prev, [peer.address]: true}));
    setPeerCopyProgress((prev) => ({...prev, [peer.address]: null}));
    try {
      const res = await fetch('/api/v1/copy', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          files: sel,
          from: peer.address,
          ...destinations,
          fileSizes: buildFileSizes(peerModels.get(peer.address) ?? []),
          skip,
        }),
      });
      await readCopyProgress(res, (p) =>
        setPeerCopyProgress((prev) => ({...prev, [peer.address]: p})),
      );
      if (destinations.deleteAfterCopy) {
        const base = peer.isLocal ? '' : `http://${peer.address}`;
        const refreshed = await fetch(`${base}/api/v1/local-models`);
        const models: Model[] = await refreshed.json();
        setPeerModels((prev) => new Map(prev).set(peer.address, models));
        setPeerSelections((prev) => ({...prev, [peer.address]: []}));
      }
    } finally {
      setPeerCopying((prev) => ({...prev, [peer.address]: false}));
      setPeerCopyProgress((prev) => ({...prev, [peer.address]: null}));
    }
  }

  if (!peers || peers.length === 0) return null;

  const confirmingModels = confirmingPeer
    ? (peerModels.get(confirmingPeer.address) ?? [])
    : [];
  const confirmingSelected = confirmingPeer
    ? new Set(peerSelections[confirmingPeer.address] ?? [])
    : new Set<string>();

  const confirmingCopyModels = confirmingCopyPeer
    ? (peerModels.get(confirmingCopyPeer.address) ?? [])
    : [];
  const confirmingCopySelected = confirmingCopyPeer
    ? new Set(peerSelections[confirmingCopyPeer.address] ?? [])
    : new Set<string>();

  return (
    <>
      {confirmingPeer && (
        <DeleteModal
          files={selectedFileInfo(confirmingModels, confirmingSelected)}
          from={confirmingPeer.name}
          requireDoubleConfirm={anyMissingFromColdStorage(
            selectedFileInfo(confirmingModels, confirmingSelected),
            coldModels,
          )}
          onConfirm={() => onDeletePeer(confirmingPeer)}
          onCancel={() => setConfirmingPeer(null)}
        />
      )}
      {confirmingCopyPeer && (
        <CopyModal
          files={selectedFileInfo(confirmingCopyModels, confirmingCopySelected)}
          from={confirmingCopyPeer.address}
          onCopy={(destinations) =>
            onCopyPeer(confirmingCopyPeer, destinations)
          }
          onCancel={() => setConfirmingCopyPeer(null)}
        />
      )}
      {pendingConflicts.length > 0 && (
        <ConflictsModal
          conflicts={pendingConflicts}
          onConfirm={onConflictsPeerConfirm}
          onCancel={() => {
            setPendingConflictsPeer(null);
            setPendingConflicts([]);
            setPendingDestinations(null);
          }}
        />
      )}
      {peers.map((peer) => {
        const models = peerModels.get(peer.address);
        const selected = new Set(peerSelections[peer.address] ?? []);
        const deleting = peerDeleting[peer.address] ?? false;
        const copying = peerCopying[peer.address] ?? false;
        const copyProgress = peerCopyProgress[peer.address] ?? null;
        const checking = checkingCopyPeer?.address === peer.address;
        return (
          <Section key={peer.address}>
            <VStack gap={3}>
              <HStack gap={2} vAlign="center">
                <Heading level={2}>{peer.name}</Heading>
                {peer.isLocal && <Text type="supporting">— local</Text>}
              </HStack>
              {models === undefined ? (
                <Spinner label="Loading…" />
              ) : peerDown.has(peer.address) ? (
                <EmptyState title="Host is down" />
              ) : (
                <VStack gap={1}>
                  <ModelList
                    models={models}
                    selected={selected}
                    onToggle={(paths) => onTogglePeer(peer.address, paths)}
                  />
                  <ActionBar
                    selected={selected}
                    onDelete={() => setConfirmingPeer(peer)}
                    deleting={deleting}
                    onCopy={() => setConfirmingCopyPeer(peer)}
                    copying={copying}
                    copyProgress={copyProgress}
                    checking={checking}
                  />
                </VStack>
              )}
            </VStack>
          </Section>
        );
      })}
    </>
  );
}
