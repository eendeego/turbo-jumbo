'use client';

import {useEffect, useState} from 'react';
import {Section} from '@astryxdesign/core/Section';
import {VStack} from '@astryxdesign/core/Stack';
import {Heading, Text} from '@astryxdesign/core/Text';
import {Spinner} from '@astryxdesign/core/Spinner';
import type {Peer} from '@/lib/config';
import type {Model} from '@/lib/models';
import {ModelList} from '@/components/models/model-list';
import {ActionBar} from '@/components/models/action-bar';
import {
  DeleteModal,
  selectedFileInfo,
  anyMissingFromColdStorage,
} from '@/components/models/delete-modal';

export function PeersSection({coldModels}: {coldModels: Model[]}) {
  const [peers, setPeers] = useState<Peer[] | null>(null);
  const [peerModels, setPeerModels] = useState<Map<string, Model[]>>(new Map());
  const [peerSelections, setPeerSelections] = useState<
    Record<string, string[]>
  >({});
  const [peerDeleting, setPeerDeleting] = useState<Record<string, boolean>>({});
  const [confirmingPeer, setConfirmingPeer] = useState<Peer | null>(null);

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

  if (!peers || peers.length === 0) return null;

  const confirmingModels = confirmingPeer
    ? (peerModels.get(confirmingPeer.address) ?? [])
    : [];
  const confirmingSelected = confirmingPeer
    ? new Set(peerSelections[confirmingPeer.address] ?? [])
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
      {peers.map((peer) => {
        const models = peerModels.get(peer.address);
        const selected = new Set(peerSelections[peer.address] ?? []);
        const deleting = peerDeleting[peer.address] ?? false;
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
