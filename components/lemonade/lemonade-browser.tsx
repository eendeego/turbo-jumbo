'use client';

import {useEffect, useMemo, useState} from 'react';
import * as stylex from '@stylexjs/stylex';
import {Dialog} from '@astryxdesign/core/Dialog';
import {VStack, HStack, StackItem} from '@astryxdesign/core/Stack';
import {Heading, Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {Button} from '@astryxdesign/core/Button';
import {CheckboxInput} from '@astryxdesign/core/CheckboxInput';
import {List, ListItem} from '@astryxdesign/core/List';
import {Badge} from '@astryxdesign/core/Badge';
import {HoverCard} from '@astryxdesign/core/HoverCard';
import {
  DownloadModal,
  useDownloadRunner,
} from '@/components/hf-download/download-runner';
import {
  lemonadeDownloadStatus,
  lemonadeStatusTooltip,
  matchVariantFiles,
  missingVariantFiles,
  type InventoryLocation,
  type LemonadeDownloadInfo,
  type LemonadeModel,
} from '@/lib/lemonade';

type HfFile = {path: string; size: number};

function formatGb(sizeGb: number): string {
  return `${sizeGb.toFixed(2)} GB`;
}

const styles = stylex.create({
  // Fixed-height body, like the HF download picker: the dialog must not
  // resize as the catalog loads or the filter narrows.
  pickerBody: {height: '55vh', minHeight: 0},
  modelList: {flexGrow: 1, minHeight: 0, overflowY: 'auto'},
});

/**
 * Catalog browser for the Lemonade SDK's GGUF models: pick one, and its
 * checkpoint files (variant-matched, mmproj included) download through the
 * regular HF runner into local storage.
 */
export function LemonadeBrowser({
  hfTokenSet,
  inventoryLocations,
  onClose,
}: {
  hfTokenSet: boolean;
  inventoryLocations: InventoryLocation[];
  onClose: () => void;
}) {
  const [models, setModels] = useState<LemonadeModel[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [sendToCold, setSendToCold] = useState(false);
  const [deleteAfterTransfer, setDeleteAfterTransfer] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [showTerminal, setShowTerminal] = useState(false);
  const {term, progress, running, start, cancel, reset} = useDownloadRunner();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/v1/lemonade-models');
        const data = (await res.json().catch(() => null)) as {
          models?: LemonadeModel[];
          error?: string;
        } | null;
        if (cancelled) return;
        if (!res.ok || !data?.models) {
          setLoadError(data?.error ?? `${res.status} ${res.statusText}`);
          return;
        }
        setModels(data.models);
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const visible = useMemo(() => {
    if (!models) return [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return models;
    return models.filter((m) =>
      [m.name, m.repoId, ...m.labels].some((s) =>
        s.toLowerCase().includes(needle),
      ),
    );
  }, [models, filter]);

  const statusByName = useMemo(() => {
    const map = new Map<string, LemonadeDownloadInfo>();
    if (!models) return map;
    for (const m of models) {
      map.set(m.name, lemonadeDownloadStatus(m, inventoryLocations));
    }
    return map;
  }, [models, inventoryLocations]);

  const selected = useMemo(
    () => models?.find((m) => m.name === selectedName) ?? null,
    [models, selectedName],
  );

  // Resolve the model's repo file list, pick the variant's files, and hand
  // off to the regular download runner.
  const startDownload = async () => {
    if (!selected || resolving || running) return;
    setResolving(true);
    setResolveError(null);
    try {
      const params = new URLSearchParams({
        repoId: selected.repoId,
        branch: 'main',
      });
      const res = await fetch(`/api/v1/hf-files?${params}`);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const files = (await res.json()) as HfFile[];
      const all = matchVariantFiles(files, selected.variant, selected.mmproj);
      if (all.length === 0) {
        setResolveError(
          `No files in ${selected.repoId} match "${selected.variant ?? 'any gguf'}".`,
        );
        return;
      }
      // Download only what's missing from local storage (where downloads land);
      // if everything is already present, fall back to the full set (the hf CLI
      // skips complete files).
      const localModels =
        inventoryLocations.find((l) => l.isLocal)?.models ?? [];
      const missing = missingVariantFiles(all, localModels, selected.repoId);
      const filePaths = missing.length > 0 ? missing : all;
      setShowTerminal(true);
      void start({
        repoId: selected.repoId,
        branch: 'main',
        filePaths,
        sendToCold,
        deleteAfterTransfer,
      });
    } catch (e) {
      setResolveError(e instanceof Error ? e.message : String(e));
    } finally {
      setResolving(false);
    }
  };

  // Closing the terminal returns to the catalog; the selection stays.
  const closeTerminal = () => {
    if (running) cancel();
    setShowTerminal(false);
    reset();
  };

  if (showTerminal) {
    return (
      <DownloadModal
        title={`Downloading ${selected?.name ?? ''}…`}
        term={term}
        progress={progress}
        running={running}
        hfTokenSet={hfTokenSet}
        onClose={closeTerminal}
      />
    );
  }

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      width={800}
      purpose="form"
    >
      <VStack gap={4}>
        <Heading level={3}>Lemonade models</Heading>
        <VStack gap={3} xstyle={styles.pickerBody}>
          {models == null && loadError == null && (
            <Text type="supporting">Fetching the catalog…</Text>
          )}
          {loadError && (
            <Text type="supporting" color="accent">
              Error: {loadError}
            </Text>
          )}

          {models != null && (
            <HStack gap={3} vAlign="center">
              <StackItem size="fill">
                <TextInput
                  label="Filter models"
                  isLabelHidden
                  value={filter}
                  onChange={setFilter}
                  placeholder="Filter by name, repo or label…"
                />
              </StackItem>
              <Text type="supporting">
                {visible.length} / {models.length} models
              </Text>
            </HStack>
          )}
          {models != null && (
            <List hasDividers xstyle={styles.modelList}>
              {visible.map((m) => (
                <ListItem
                  key={m.name}
                  label={m.name}
                  description={`${m.repoId}${m.variant ? `:${m.variant}` : ''}`}
                  isSelected={selectedName === m.name}
                  onClick={() => setSelectedName(m.name)}
                  endContent={
                    <HStack gap={1} vAlign="center">
                      {(() => {
                        const info = statusByName.get(m.name);
                        if (!info || info.status === 'none') return null;
                        return (
                          <HoverCard
                            placement="above"
                            content={lemonadeStatusTooltip(info)}
                          >
                            <Badge
                              label={
                                info.status === 'complete'
                                  ? 'downloaded'
                                  : 'partial'
                              }
                              variant={
                                info.status === 'complete' ? 'blue' : 'orange'
                              }
                            />
                          </HoverCard>
                        );
                      })()}
                      {m.suggested && (
                        <Badge label="suggested" variant="green" />
                      )}
                      {m.labels.map((l) => (
                        <Badge key={l} label={l} variant="neutral" />
                      ))}
                      <Text type="supporting">{formatGb(m.sizeGb)}</Text>
                    </HStack>
                  }
                />
              ))}
              {visible.length === 0 && (
                <ListItem label="No models match the filter." />
              )}
            </List>
          )}

          {models != null && (
            <VStack gap={2}>
              <CheckboxInput
                label="Copy to cold storage when done"
                value={sendToCold}
                onChange={setSendToCold}
              />
              {sendToCold && (
                <CheckboxInput
                  label="Delete from local storage after transfer"
                  value={deleteAfterTransfer}
                  onChange={setDeleteAfterTransfer}
                />
              )}
              {resolveError && (
                <Text type="supporting" color="accent">
                  {resolveError}
                </Text>
              )}
            </VStack>
          )}
        </VStack>
        <HStack gap={2} hAlign="between" vAlign="center">
          <Text type="supporting">
            {selected
              ? `${selected.name} · ${formatGb(selected.sizeGb)}`
              : 'No model selected'}
          </Text>
          <HStack gap={2} hAlign="end">
            <Button
              label="Cancel"
              variant="secondary"
              size="sm"
              onClick={onClose}
            />
            <Button
              label={resolving ? 'Resolving…' : 'Download'}
              variant="primary"
              size="sm"
              onClick={() => void startDownload()}
              isDisabled={selected == null || resolving}
            />
          </HStack>
        </HStack>
      </VStack>
    </Dialog>
  );
}
