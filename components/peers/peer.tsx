'use client';

import {useRef, useState} from 'react';
import {Section} from '@astryxdesign/core/Section';
import {VStack, HStack} from '@astryxdesign/core/Stack';
import {Heading, Text} from '@astryxdesign/core/Text';
import {Spinner} from '@astryxdesign/core/Spinner';
import {EmptyState} from '@astryxdesign/core/EmptyState';
import {Banner} from '@astryxdesign/core/Banner';
import {peerSlug} from '@/lib/peers/peer-slug';
import type {Peer as PeerConfig} from '@/lib/config';
import type {Model} from '@/lib/models/model-types';
import {
  type CopyProgress,
  readCopyAndReportErrors,
  buildFileSizes,
} from '@/lib/storage/copy-progress';
import {
  readCheckStream,
  type CheckProgress,
} from '@/lib/storage/check-progress';
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
import type {AsyncState} from '@/lib/util/async-state';

export type PeerModels = AsyncState<Model[]>;

export function Peer({
  peer,
  models,
  coldModels,
  onModelsRefreshed,
}: {
  peer: PeerConfig;
  models: PeerModels;
  coldModels: Model[];
  onModelsRefreshed: (address: string, models: Model[]) => void;
}) {
  const modelList = models.type === 'value' ? models.value : [];
  const [selections, setSelections] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copyProgress, setCopyProgress] = useState<CopyProgress | null>(null);
  const [confirmingCopy, setConfirmingCopy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkProgress, setCheckProgress] = useState<CheckProgress | null>(
    null,
  );
  // Aborts the in-flight conflict check (see use-copy-workflow).
  const checkAbort = useRef<AbortController | null>(null);
  const [pendingConflicts, setPendingConflicts] = useState<ConflictItem[]>([]);
  const [pendingDestinations, setPendingDestinations] =
    useState<CopyDestinations | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    setError(null);
    const url = `/api/v1/peers/${peerSlug(peer)}/models`;
    try {
      const del = await fetch(url, {
        method: 'DELETE',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({files: selections}),
      });
      if (!del.ok) throw new Error(`${del.status} ${del.statusText}`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      onModelsRefreshed(peer.address, await res.json());
      setSelections([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  }

  async function onCopy(destinations: CopyDestinations) {
    setConfirmingCopy(false);
    setChecking(true);
    setCheckProgress(null);
    setError(null);
    let hasConflicts = false;
    let hasError = false;
    let cancelled = false;
    const abort = new AbortController();
    checkAbort.current = abort;
    try {
      const res = await fetch('/api/v1/copy/check', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        signal: abort.signal,
        body: JSON.stringify({
          files: selections,
          from: peer.address,
          toColdStorage: destinations.toColdStorage,
          toPeers: destinations.toPeers,
          fileSizes: buildFileSizes(modelList),
        }),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      // The check streams progress and ends with its verdict; no result frame
      // means it was abandoned, and nothing should be copied.
      const result = await readCheckStream<ConflictItem, unknown>(
        res,
        setCheckProgress,
      );
      if (!result) {
        cancelled = true;
      } else if (result.conflicts.length > 0) {
        hasConflicts = true;
        setPendingConflicts(result.conflicts);
        setPendingDestinations(destinations);
      }
    } catch (e) {
      if (abort.signal.aborted) {
        cancelled = true;
      } else {
        hasError = true;
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      checkAbort.current = null;
      setChecking(false);
      setCheckProgress(null);
    }
    if (!hasConflicts && !hasError && !cancelled)
      await doCopy(destinations, []);
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
    setError(null);
    try {
      const res = await fetch('/api/v1/copy', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          files: selections,
          from: peer.address,
          ...destinations,
          fileSizes: buildFileSizes(modelList),
          skip,
        }),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      await readCopyAndReportErrors(res, setCopyProgress, setError);
      if (destinations.deleteAfterCopy) {
        const refreshed = await fetch(`/api/v1/peers/${peerSlug(peer)}/models`);
        if (!refreshed.ok)
          throw new Error(`${refreshed.status} ${refreshed.statusText}`);
        onModelsRefreshed(peer.address, await refreshed.json());
        setSelections([]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCopying(false);
      setCopyProgress(null);
    }
  }

  const confirmingModels = modelList;

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
          {error && <Banner status="error" title={`Error: ${error}`} />}
          {models.type === 'error' ? (
            <EmptyState title={models.message} />
          ) : models.type === 'value' ? (
            <VStack gap={1}>
              <ModelList
                models={models.value}
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
                checkProgress={checkProgress}
                onCancelCheck={() => checkAbort.current?.abort()}
              />
            </VStack>
          ) : (
            <Spinner label="Loading…" />
          )}
        </VStack>
      </Section>
    </>
  );
}
