'use client';

import {useState, useEffect} from 'react';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {Layout, LayoutContent, LayoutFooter} from '@astryxdesign/core/Layout';
import {VStack, HStack} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import {Button} from '@astryxdesign/core/Button';
import {CheckboxInput} from '@astryxdesign/core/CheckboxInput';
import {List, ListItem} from '@astryxdesign/core/List';
import {Spinner} from '@astryxdesign/core/Spinner';
import type {Peer} from '@/lib/config';
import type {Model} from '@/lib/models/model-types';
import {groupCopyFiles} from '@/lib/models/copy-file-groups';
import {allFilesPresent} from '@/lib/peers/peer-paths';
import type {FileInfo} from '@/components/models/delete-modal';

export interface CopyDestinations {
  toColdStorage: boolean;
  toPeers: string[]; // peer addresses, including the local peer's own address
  deleteAfterCopy: boolean;
}

interface CopyModalProps {
  files: FileInfo[];
  from: string; // "cold-storage" | peer address
  onCopy: (destinations: CopyDestinations) => void;
  onCancel: () => void;
}

export function CopyModal({files, from, onCopy, onCancel}: CopyModalProps) {
  const [peers, setPeers] = useState<Peer[] | null>(null);
  const [coldModels, setColdModels] = useState<Model[] | null>(null);
  const [peerModelsMap, setPeerModelsMap] = useState<Map<string, Model[]>>(
    new Map(),
  );
  const [toColdStorage, setToColdStorage] = useState(false);
  const [deleteAfterCopy, setDeleteAfterCopy] = useState(false);
  const [selectedPeers, setSelectedPeers] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch('/api/v1/peers')
      .then((r) => r.json())
      .then((data: {peers: Peer[]; interval: number}) => setPeers(data.peers));
    fetch('/api/v1/cold-storage')
      .then((r) => r.json())
      .then((data: Model[]) => setColdModels(data));
  }, []);

  useEffect(() => {
    if (!peers) return;
    peers.forEach((peer) => {
      fetch(`/api/v1/peers/${encodeURIComponent(peer.name)}/models`)
        .then((r) => r.json())
        .then((models: Model[]) =>
          setPeerModelsMap((prev) => new Map(prev).set(peer.address, models)),
        )
        .catch(() =>
          setPeerModelsMap((prev) => new Map(prev).set(peer.address, [])),
        );
    });
  }, [peers]);

  const showColdStorage = from !== 'cold-storage';
  // The local peer is just another destination now; only exclude the source.
  const availablePeers = (peers ?? []).filter((p) => p.address !== from);
  const coldAlreadyPresent =
    coldModels !== null && allFilesPresent(files, coldModels);
  const canCopy = toColdStorage || selectedPeers.size > 0;

  function togglePeer(addr: string) {
    setSelectedPeers((prev) => {
      const next = new Set(prev);
      if (next.has(addr)) next.delete(addr);
      else next.add(addr);
      return next;
    });
  }

  function handleCopy() {
    onCopy({
      toColdStorage,
      toPeers: Array.from(selectedPeers),
      deleteAfterCopy: toColdStorage && deleteAfterCopy,
    });
  }

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      purpose="required"
      width="min(800px, 92vw)"
      maxHeight="85vh"
    >
      {/* Only the file list scrolls; the destination checkboxes live in the
          pinned footer with the buttons so they stay visible no matter how
          many files are selected. */}
      <Layout
        header={
          <DialogHeader
            title={`Copy ${files.length} ${files.length === 1 ? 'file' : 'files'} to…`}
          />
        }
        content={
          <LayoutContent>
            <List hasDividers>
              {groupCopyFiles(files).map((entry, i) => (
                <ListItem
                  key={i}
                  label={entry.label}
                  description={entry.description}
                />
              ))}
            </List>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <VStack gap={4}>
              <VStack gap={2}>
                {showColdStorage && (
                  <>
                    <CheckboxInput
                      label="Cold storage"
                      description={
                        coldAlreadyPresent ? 'already present' : undefined
                      }
                      value={toColdStorage}
                      isDisabled={coldAlreadyPresent}
                      onChange={(checked) => {
                        setToColdStorage(checked);
                        if (!checked) setDeleteAfterCopy(false);
                      }}
                    />
                    {toColdStorage && (
                      <CheckboxInput
                        label="Delete after copying"
                        value={deleteAfterCopy}
                        onChange={setDeleteAfterCopy}
                      />
                    )}
                  </>
                )}

                {peers === null ? (
                  <Spinner label="Loading peers…" />
                ) : (
                  availablePeers.map((peer) => {
                    const peerModels = peerModelsMap.get(peer.address);
                    const alreadyPresent =
                      peerModels !== undefined &&
                      allFilesPresent(files, peerModels);
                    const note = peer.isLocal
                      ? alreadyPresent
                        ? 'local · already present'
                        : 'local'
                      : alreadyPresent
                        ? 'already present'
                        : undefined;
                    return (
                      <CheckboxInput
                        key={peer.address}
                        label={peer.name}
                        description={note}
                        value={selectedPeers.has(peer.address)}
                        isDisabled={alreadyPresent}
                        onChange={() => togglePeer(peer.address)}
                      />
                    );
                  })
                )}

                {!showColdStorage &&
                  peers !== null &&
                  availablePeers.length === 0 && (
                    <Text type="supporting">No destinations available.</Text>
                  )}
              </VStack>

              <HStack gap={2} hAlign="end">
                <Button label="Cancel" variant="secondary" onClick={onCancel} />
                <Button
                  label="Copy"
                  variant="primary"
                  isDisabled={!canCopy}
                  onClick={handleCopy}
                />
              </HStack>
            </VStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
