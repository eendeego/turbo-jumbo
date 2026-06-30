'use client';

import {useState} from 'react';
import {VStack} from '@astryxdesign/core/Stack';
import type {Model} from '@/lib/models';
import {type CopyProgress, readCopyProgress} from '@/lib/copy-progress';
import {ModelList} from '@/components/models/model-list';
import {ActionBar} from '@/components/models/action-bar';
import {DeleteModal, selectedFileInfo} from '@/components/models/delete-modal';
import {CopyModal, type CopyDestinations} from '@/components/models/copy-modal';

export function ColdStorageSection({initialModels}: {initialModels: Model[]}) {
  const [models, setModels] = useState(initialModels);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [copying, setCopying] = useState(false);
  const [confirmingCopy, setConfirmingCopy] = useState(false);
  const [copyProgress, setCopyProgress] = useState<CopyProgress | null>(null);

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
      await fetch('/api/v1/cold-storage', {
        method: 'DELETE',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({files: Array.from(selected)}),
      });
      const res = await fetch('/api/v1/cold-storage');
      setModels(await res.json());
      setSelected(new Set());
    } finally {
      setDeleting(false);
    }
  }

  async function onCopy(destinations: CopyDestinations) {
    setConfirmingCopy(false);
    setCopying(true);
    setCopyProgress(null);
    try {
      const res = await fetch('/api/v1/copy', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          files: Array.from(selected),
          from: 'cold-storage',
          ...destinations,
        }),
      });
      await readCopyProgress(res, setCopyProgress);
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
      />
      {confirming && (
        <DeleteModal
          files={selectedFileInfo(models, selected)}
          requireDoubleConfirm={false}
          onConfirm={onDelete}
          onCancel={() => setConfirming(false)}
        />
      )}
      {confirmingCopy && (
        <CopyModal
          files={selectedFileInfo(models, selected)}
          from="cold-storage"
          onCopy={onCopy}
          onCancel={() => setConfirmingCopy(false)}
        />
      )}
    </VStack>
  );
}
