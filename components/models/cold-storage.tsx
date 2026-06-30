'use client';

import {useState} from 'react';
import {VStack} from '@astryxdesign/core/Stack';
import {Banner} from '@astryxdesign/core/Banner';
import {Button} from '@astryxdesign/core/Button';
import {Text} from '@astryxdesign/core/Text';
import type {Model} from '@/lib/model-types';
import {
  type CopyProgress,
  readCopyProgress,
  buildFileSizes,
} from '@/lib/copy-progress';
import {ModelList} from '@/components/models/model-list';
import {ActionBar} from '@/components/models/action-bar';
import {DeleteModal, selectedFileInfo} from '@/components/models/delete-modal';
import {CopyModal, type CopyDestinations} from '@/components/models/copy-modal';
import {
  ConflictsModal,
  type ConflictItem,
} from '@/components/models/conflicts-modal';

export function ColdStorage({initialModels}: {initialModels: Model[]}) {
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
  const [error, setError] = useState<string | null>(null);
  const [rawListing, setRawListing] = useState<{
    dir: string;
    files: string[];
  } | null>(null);
  const [loadingRaw, setLoadingRaw] = useState(false);

  async function listDirectory() {
    setLoadingRaw(true);
    try {
      const res = await fetch('/api/v1/cold-storage/ls');
      setRawListing(await res.json());
    } finally {
      setLoadingRaw(false);
    }
  }

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
    setError(null);
    try {
      const del = await fetch('/api/v1/cold-storage', {
        method: 'DELETE',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({files: Array.from(selected)}),
      });
      if (!del.ok) throw new Error(`${del.status} ${del.statusText}`);
      const res = await fetch('/api/v1/cold-storage');
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      setModels(await res.json());
      setSelected(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  }

  async function onCopy(destinations: CopyDestinations) {
    setConfirmingCopy(false);
    setChecking(true);
    setError(null);
    let hasConflicts = false;
    let hasError = false;
    try {
      const res = await fetch('/api/v1/copy/check', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          files: Array.from(selected),
          from: 'cold-storage',
          toColdStorage: destinations.toColdStorage,
          toPeers: destinations.toPeers,
          fileSizes: buildFileSizes(models),
        }),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const {conflicts} = (await res.json()) as {conflicts: ConflictItem[]};
      if (conflicts.length > 0) {
        hasConflicts = true;
        setPendingConflicts(conflicts);
        setPendingDestinations(destinations);
      }
    } catch (e) {
      hasError = true;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
    if (!hasConflicts && !hasError) await doCopy(destinations, []);
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
    setError(null);
    try {
      const res = await fetch('/api/v1/copy', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          files: Array.from(selected),
          from: 'cold-storage',
          ...destinations,
          fileSizes: buildFileSizes(models),
          skip,
        }),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      await readCopyProgress(res, setCopyProgress);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCopying(false);
      setCopyProgress(null);
    }
  }

  return (
    <VStack gap={1}>
      {error && <Banner status="error" title={`Error: ${error}`} />}
      <ModelList models={models} selected={selected} onToggle={onToggle} />
      {models.length === 0 &&
        (rawListing === null ? (
          <Button
            label={loadingRaw ? 'Listing…' : 'List directory'}
            variant="secondary"
            size="sm"
            isDisabled={loadingRaw}
            onClick={listDirectory}
          />
        ) : (
          <VStack gap={1}>
            <Text type="supporting">
              {rawListing.dir} — {rawListing.files.length}{' '}
              {rawListing.files.length === 1 ? 'file' : 'files'}
            </Text>
            {rawListing.files.length === 0 ? (
              <Text type="supporting">Directory is empty</Text>
            ) : (
              <VStack gap={0.5}>
                {rawListing.files.map((f) => (
                  <Text key={f} type="code" color="secondary">
                    {f}
                  </Text>
                ))}
              </VStack>
            )}
          </VStack>
        ))}
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
