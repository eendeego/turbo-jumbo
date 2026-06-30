'use client';

import {useState} from 'react';
import {VStack} from '@astryxdesign/core/Stack';
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

export function LocalModelsSection({
  initialModels,
  coldModels,
}: {
  initialModels: Model[];
  coldModels: Model[];
}) {
  const [models, setModels] = useState(initialModels);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [copying, setCopying] = useState(false);
  const [confirmingCopy, setConfirmingCopy] = useState(false);
  const [copyProgress, setCopyProgress] = useState<CopyProgress | null>(null);
  const [checking, setChecking] = useState(false);
  const [pendingConflicts, setPendingConflicts] = useState<ConflictItem[]>([]);
  const [pendingDestinations, setPendingDestinations] =
    useState<CopyDestinations | null>(null);

  function onToggle(paths: string[]) {
    setSelected((prev) => {
      const next = new Set(prev);
      const allSelected = paths.every((p) => next.has(p));
      if (allSelected) paths.forEach((p) => next.delete(p));
      else paths.forEach((p) => next.add(p));
      return next;
    });
  }

  async function onDelete() {
    setConfirming(false);
    setDeleting(true);
    try {
      await fetch('/api/v1/local-models', {
        method: 'DELETE',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({files: Array.from(selected)}),
      });
      const res = await fetch('/api/v1/local-models');
      setModels(await res.json());
      setSelected(new Set());
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
          files: Array.from(selected),
          from: 'local',
          toColdStorage: destinations.toColdStorage,
          toLocal: destinations.toLocal,
          toPeers: destinations.toPeers,
          fileSizes: buildFileSizes(models),
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
    const dest = pendingDestinations;
    setPendingConflicts([]);
    setPendingDestinations(null);
    await doCopy(dest, skip);
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
          files: Array.from(selected),
          from: 'local',
          ...destinations,
          fileSizes: buildFileSizes(models),
          skip,
        }),
      });
      await readCopyProgress(res, setCopyProgress);
      if (destinations.deleteAfterCopy) {
        const refreshed = await fetch('/api/v1/local-models');
        setModels(await refreshed.json());
        setSelected(new Set());
      }
    } finally {
      setCopying(false);
      setCopyProgress(null);
    }
  }

  return (
    <VStack gap={1}>
      <ModelList models={models} selected={selected} onToggle={onToggle} />
      <ActionBar
        selected={selected}
        onDelete={() => setConfirming(true)}
        deleting={deleting}
        onCopy={() => setConfirmingCopy(true)}
        copying={copying}
        copyProgress={copyProgress}
        checking={checking}
      />
      {confirming && (
        <DeleteModal
          files={selectedFileInfo(models, selected)}
          requireDoubleConfirm={anyMissingFromColdStorage(
            selectedFileInfo(models, selected),
            coldModels,
          )}
          onConfirm={onDelete}
          onCancel={() => setConfirming(false)}
        />
      )}
      {confirmingCopy && (
        <CopyModal
          files={selectedFileInfo(models, selected)}
          from="local"
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
    </VStack>
  );
}
