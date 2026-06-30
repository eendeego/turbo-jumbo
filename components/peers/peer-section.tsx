'use client';

import {useState} from 'react';
import {Section} from '@astryxdesign/core/Section';
import {VStack, HStack} from '@astryxdesign/core/Stack';
import {Heading, Text} from '@astryxdesign/core/Text';
import {Spinner} from '@astryxdesign/core/Spinner';
import {EmptyState} from '@astryxdesign/core/EmptyState';
import type {Peer} from '@/lib/config';
import type {Model} from '@/lib/models';
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

export function PeerSection({
  peer,
  models,
  isDown,
  coldModels,
  onModelsRefreshed,
}: {
  peer: Peer;
  models: Model[] | undefined;
  isDown: boolean;
  coldModels: Model[];
  onModelsRefreshed: (address: string, models: Model[]) => void;
}) {
  const [selections, setSelections] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copyProgress, setCopyProgress] = useState<CopyProgress | null>(null);
  const [confirmingCopy, setConfirmingCopy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [pendingConflicts, setPendingConflicts] = useState<ConflictItem[]>([]);
  const [pendingDestinations, setPendingDestinations] =
    useState<CopyDestinations | null>(null);

  const selected = new Set(selections);

  function onToggle(paths: string[]) {
    setSelections((prev) => {
      const current = new Set(prev);
      const allSelected = paths.every((p) => current.has(p));
      if (allSelected) paths.forEach((p) => current.delete(p));
      else paths.forEach((p) => current.add(p));
      return Array.from(current);
    });
  }

  async function onDelete() {
    setConfirmingDelete(false);
    setDeleting(true);
    const base = peer.isLocal ? '' : `http://${peer.address}`;
    try {
      await fetch(`${base}/api/v1/local-models`, {
        method: 'DELETE',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({files: selections}),
      });
      const res = await fetch(`${base}/api/v1/local-models`);
      onModelsRefreshed(peer.address, await res.json());
      setSelections([]);
    } finally {
      setDeleting(false);
    }
  }

  async function onCopy(destinations: CopyDestinations) {
    setConfirmingCopy(false);
    setChecking(true);
    let hasConflicts = false;
    try {
      const res = await fetch('/api/v1/copy/check', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          files: selections,
          from: peer.address,
          toColdStorage: destinations.toColdStorage,
          toPeers: destinations.toPeers,
          fileSizes: buildFileSizes(models ?? []),
        }),
      });
      const {conflicts} = (await res.json()) as {conflicts: ConflictItem[]};
      if (conflicts.length > 0) {
        hasConflicts = true;
        setPendingConflicts(conflicts);
        setPendingDestinations(destinations);
      }
    } finally {
      setChecking(false);
    }
    if (!hasConflicts) await doCopy(destinations, []);
  }

  async function onConflictsConfirm(
    skip: Array<{file: string; destination: string}>,
  ) {
    if (!pendingDestinations) return;
    const destinations = pendingDestinations;
    setPendingConflicts([]);
    setPendingDestinations(null);
    await doCopy(destinations, skip);
  }

  async function doCopy(
    destinations: CopyDestinations,
    skip: Array<{file: string; destination: string}>,
  ) {
    setCopying(true);
    setCopyProgress(null);
    try {
      const res = await fetch('/api/v1/copy', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          files: selections,
          from: peer.address,
          ...destinations,
          fileSizes: buildFileSizes(models ?? []),
          skip,
        }),
      });
      await readCopyProgress(res, setCopyProgress);
      if (destinations.deleteAfterCopy) {
        const base = peer.isLocal ? '' : `http://${peer.address}`;
        const refreshed = await fetch(`${base}/api/v1/local-models`);
        onModelsRefreshed(peer.address, await refreshed.json());
        setSelections([]);
      }
    } finally {
      setCopying(false);
      setCopyProgress(null);
    }
  }

  const confirmingModels = models ?? [];

  return (
    <>
      {confirmingDelete && (
        <DeleteModal
          files={selectedFileInfo(confirmingModels, selected)}
          from={peer.name}
          requireDoubleConfirm={anyMissingFromColdStorage(
            selectedFileInfo(confirmingModels, selected),
            coldModels,
          )}
          onConfirm={onDelete}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
      {confirmingCopy && (
        <CopyModal
          files={selectedFileInfo(confirmingModels, selected)}
          from={peer.address}
          onCopy={onCopy}
          onCancel={() => setConfirmingCopy(false)}
        />
      )}
      {pendingConflicts.length > 0 && (
        <ConflictsModal
          conflicts={pendingConflicts}
          onConfirm={onConflictsConfirm}
          onCancel={() => {
            setPendingConflicts([]);
            setPendingDestinations(null);
          }}
        />
      )}
      <Section>
        <VStack gap={3}>
          <HStack gap={2} vAlign="center">
            <Heading level={2}>{peer.name}</Heading>
            {peer.isLocal && <Text type="supporting">— local</Text>}
          </HStack>
          {models === undefined ? (
            <Spinner label="Loading…" />
          ) : isDown ? (
            <EmptyState title="Host is down" />
          ) : (
            <VStack gap={1}>
              <ModelList
                models={models}
                selected={selected}
                onToggle={onToggle}
              />
              <ActionBar
                selected={selected}
                onDelete={() => setConfirmingDelete(true)}
                deleting={deleting}
                onCopy={() => setConfirmingCopy(true)}
                copying={copying}
                copyProgress={copyProgress}
                checking={checking}
              />
            </VStack>
          )}
        </VStack>
      </Section>
    </>
  );
}
