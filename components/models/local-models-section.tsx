'use client';

import {useState} from 'react';
import {VStack} from '@astryxdesign/core/Stack';
import type {Model} from '@/lib/models';
import {ModelList} from '@/components/models/model-list';
import {ActionBar} from '@/components/models/action-bar';
import {
  DeleteModal,
  selectedFileInfo,
  anyMissingFromColdStorage,
} from '@/components/models/delete-modal';
import {CopyModal, type CopyDestinations} from '@/components/models/copy-modal';

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
    setCopying(true);
    try {
      await fetch('/api/v1/copy', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          files: Array.from(selected),
          from: 'local',
          ...destinations,
        }),
      });
      if (destinations.deleteAfterCopy) {
        const res = await fetch('/api/v1/local-models');
        setModels(await res.json());
        setSelected(new Set());
      }
    } finally {
      setCopying(false);
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
    </VStack>
  );
}
