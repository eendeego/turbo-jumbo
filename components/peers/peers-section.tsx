'use client';

import {useEffect, useState} from 'react';
import {Section} from '@astryxdesign/core/Section';
import {VStack} from '@astryxdesign/core/Stack';
import {Heading, Text} from '@astryxdesign/core/Text';
import {Spinner} from '@astryxdesign/core/Spinner';
import type {Peer} from '@/lib/config';
import type {Model} from '@/lib/models';
import {type CopyProgress, readCopyProgress} from '@/lib/copy-progress';
import {ModelList} from '@/components/models/model-list';
import {ActionBar} from '@/components/models/action-bar';
import {
  DeleteModal,
  selectedFileInfo,
  anyMissingFromColdStorage,
} from '@/components/models/delete-modal';
import {CopyModal, type CopyDestinations} from '@/components/models/copy-modal';

export function PeersSection({coldModels}: {coldModels: Model[]}) {
  const [peers, setPeers] = useState<Peer[] | null>(null);
  const [peerModels, setPeerModels] = useState<Map<string, Model[]>>(new Map());
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

  useEffect(() => {
    fetch('/api/v1/peers')
      .then((r) => r.json())
      .then((data: Peer[]) => setPeers(data));
  }, []);

  useEffect(() => {
    if (!peers) return;

    const fetchModels = () => {
      peers.forEach((peer) => {
        fetch(`http://${peer.address}/api/v1/local-models`)
          .then((r) => r.json())
          .then((models: Model[]) => {
            setPeerModels((prev) => new Map(prev).set(peer.address, models));
          })
          .catch(() => {
            setPeerModels((prev) => new Map(prev).set(peer.address, []));
          });
      });
    };

    fetchModels();
    const id = setInterval(fetchModels, 5000);
    return () => clearInterval(id);
  }, [peers]);

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
    try {
      await fetch(`http://${peer.address}/api/v1/local-models`, {
        method: 'DELETE',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({files: sel}),
      });
      const res = await fetch(`http://${peer.address}/api/v1/local-models`);
      const models: Model[] = await res.json();
      setPeerModels((prev) => new Map(prev).set(peer.address, models));
      setPeerSelections((prev) => ({...prev, [peer.address]: []}));
    } finally {
      setPeerDeleting((prev) => ({...prev, [peer.address]: false}));
    }
  }

  async function onCopyPeer(peer: Peer, destinations: CopyDestinations) {
    setConfirmingCopyPeer(null);
    const sel = peerSelections[peer.address] ?? [];
    setPeerCopying((prev) => ({...prev, [peer.address]: true}));
    setPeerCopyProgress((prev) => ({...prev, [peer.address]: null}));
    try {
      const res = await fetch('/api/v1/copy', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({files: sel, from: peer.address, ...destinations}),
      });
      await readCopyProgress(res, (p) =>
        setPeerCopyProgress((prev) => ({...prev, [peer.address]: p})),
      );
      if (destinations.deleteAfterCopy) {
        const refreshed = await fetch(
          `http://${peer.address}/api/v1/local-models`,
        );
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
      {peers.map((peer) => {
        const models = peerModels.get(peer.address);
        const selected = new Set(peerSelections[peer.address] ?? []);
        const deleting = peerDeleting[peer.address] ?? false;
        const copying = peerCopying[peer.address] ?? false;
        const copyProgress = peerCopyProgress[peer.address] ?? null;
        return (
          <Section key={peer.address}>
            <VStack gap={3}>
              <Heading level={2}>{peer.name}</Heading>
              <Text type="supporting">{peer.address}</Text>
              {models === undefined ? (
                <Spinner label="Loading…" />
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
