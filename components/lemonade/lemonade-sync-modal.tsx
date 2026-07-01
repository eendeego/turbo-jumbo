'use client';

import {useEffect, useState} from 'react';
import {Dialog} from '@astryxdesign/core/Dialog';
import {VStack, HStack} from '@astryxdesign/core/Stack';
import {Heading, Text} from '@astryxdesign/core/Text';
import {Button} from '@astryxdesign/core/Button';
import {Badge} from '@astryxdesign/core/Badge';
import {List, ListItem} from '@astryxdesign/core/List';

// Mirrors the API shapes in lib/lemonade-sync.ts (kept local so this client
// component never imports the server module).
interface Preview {
  repoId: string;
  rev: string;
  fileCount: number;
}
interface FileResult {
  repoPath: string;
  status: 'linked' | 'deduplicated' | 'already-linked' | 'skipped' | 'error';
  message?: string;
}
interface ModelResult {
  repoId: string;
  rev: string;
  files: FileResult[];
}

type Phase = 'loading' | 'preview' | 'running' | 'done' | 'error';

export function LemonadeSyncModal({
  onClose,
  onSynced,
}: {
  onClose: () => void;
  // Called once a sync completes so the caller can refresh the table.
  onSynced: () => void;
}) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [preview, setPreview] = useState<Preview[]>([]);
  const [results, setResults] = useState<ModelResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/v1/lemonade/sync');
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const data = (await res.json()) as {preview?: Preview[]};
        if (!cancelled) {
          setPreview(data.preview ?? []);
          setPhase('preview');
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setPhase('error');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function runSync() {
    setPhase('running');
    try {
      const res = await fetch('/api/v1/lemonade/sync', {method: 'POST'});
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const data = (await res.json()) as {results?: ModelResult[]};
      setResults(data.results ?? []);
      setPhase('done');
      onSynced();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  }

  const totalFiles = preview.reduce((n, p) => n + p.fileCount, 0);
  const counts = results
    .flatMap((r) => r.files)
    .reduce<Record<string, number>>((acc, f) => {
      acc[f.status] = (acc[f.status] ?? 0) + 1;
      return acc;
    }, {});
  const errors = results
    .flatMap((r) => r.files.map((f) => ({repoId: r.repoId, ...f})))
    .filter((f) => f.status === 'error');

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      width={620}
      purpose="form"
    >
      <VStack gap={4}>
        <Heading level={3}>Sync from Lemonade</Heading>
        <Text type="supporting">
          Moves models that exist only in Lemonade into Turbo Jumbo&apos;s file
          structure, and deduplicates files Turbo Jumbo already holds — then
          replaces the Lemonade copies with symbolic links into Turbo Jumbo.
        </Text>

        {phase === 'loading' && (
          <Text type="body">Finding Lemonade-only models…</Text>
        )}

        {phase === 'error' && <Text type="body">{error}</Text>}

        {phase === 'preview' &&
          (preview.length === 0 ? (
            <Text type="body">
              Nothing to sync — every Lemonade model already exists in Turbo
              Jumbo.
            </Text>
          ) : (
            <List hasDividers>
              {preview.map((p) => (
                <ListItem
                  key={p.repoId}
                  label={p.repoId}
                  description={`${p.fileCount} file${p.fileCount === 1 ? '' : 's'} · ${p.rev.slice(0, 12)}`}
                />
              ))}
            </List>
          ))}

        {phase === 'running' && (
          <Text type="body">Moving files and creating links…</Text>
        )}

        {phase === 'done' && (
          <VStack gap={2}>
            <HStack gap={2} vAlign="center">
              <Badge label={`${counts.linked ?? 0} linked`} variant="success" />
              {counts.deduplicated ? (
                <Badge
                  label={`${counts.deduplicated} deduplicated`}
                  variant="success"
                />
              ) : null}
              {counts.skipped ? (
                <Badge label={`${counts.skipped} skipped`} variant="neutral" />
              ) : null}
              {errors.length > 0 ? (
                <Badge label={`${errors.length} failed`} variant="error" />
              ) : null}
            </HStack>
            <Text type="supporting">
              Synced {results.length} model{results.length === 1 ? '' : 's'}.
            </Text>
            {errors.map((e, i) => (
              <Text key={i} type="supporting">
                {e.repoId}/{e.repoPath}: {e.message}
              </Text>
            ))}
          </VStack>
        )}

        <HStack gap={2} hAlign="end">
          {phase === 'done' || phase === 'error' ? (
            <Button label="Close" variant="primary" onClick={onClose} />
          ) : (
            <>
              <Button
                label="Cancel"
                variant="secondary"
                onClick={onClose}
                isDisabled={phase === 'running'}
              />
              <Button
                label={
                  phase === 'running'
                    ? 'Syncing…'
                    : `Sync ${preview.length} model${preview.length === 1 ? '' : 's'} (${totalFiles} file${totalFiles === 1 ? '' : 's'})`
                }
                variant="primary"
                onClick={runSync}
                isDisabled={phase !== 'preview' || preview.length === 0}
              />
            </>
          )}
        </HStack>
      </VStack>
    </Dialog>
  );
}
