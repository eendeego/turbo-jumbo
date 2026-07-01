'use client';

import {Fragment, useEffect, useMemo, useState} from 'react';
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
import {IconButton} from '@astryxdesign/core/IconButton';
import {Icon} from '@astryxdesign/core/Icon';
import {
  DownloadModal,
  useDownloadRunner,
} from '@/components/hf-download/download-runner';
import {ModelLabelIcon} from '@/components/lemonade/model-label-icon';
import {sortLabelsForDisplay} from '@/lib/lemonade-labels';
import {
  lemonadeDownloadStatus,
  lemonadeStatusTooltip,
  matchVariantFiles,
  missingVariantFiles,
  type InventoryLocation,
  type LemonadeComponent,
  type LemonadeDownloadInfo,
  type LemonadeModel,
  type OmniCollection,
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
  indent: {width: 20, display: 'inline-block'},
});

// The end-of-row content shared by a flat model and a collection's
// downloadable member: download status, suggested badge, capability icons,
// and size.
function modelEndContent(
  model: LemonadeModel,
  info: LemonadeDownloadInfo | undefined,
) {
  return (
    <HStack gap={1} vAlign="center">
      {info && info.status !== 'none' && (
        <HoverCard placement="above" content={lemonadeStatusTooltip(info)}>
          <Badge
            label={info.status === 'complete' ? 'downloaded' : 'partial'}
            variant={info.status === 'complete' ? 'blue' : 'orange'}
          />
        </HoverCard>
      )}
      {model.suggested && <Badge label="suggested" variant="green" />}
      {model.labels.length > 0 && (
        <HStack gap={1} vAlign="center">
          {sortLabelsForDisplay(model.labels).map((l) => (
            <ModelLabelIcon key={l} label={l} />
          ))}
        </HStack>
      )}
      <Text type="supporting">{formatGb(model.sizeGb)}</Text>
    </HStack>
  );
}

// A collection member this app can't store (image, transcription, TTS): shown
// for context, greyed and non-selectable.
function externalComponentDescription(component: LemonadeComponent) {
  return (
    <HStack gap={2} vAlign="center">
      <Text type="supporting">not stored here</Text>
      <Badge label={component.modality} variant="neutral" />
      <Text type="supporting">{formatGb(component.sizeGb)}</Text>
    </HStack>
  );
}

// The aggregate download status of an omni collection's downloadable (GGUF)
// members, for its header badge. Undefined when none of them have started.
function collectionAggregateStatus(
  collection: OmniCollection,
  statusByName: Map<string, LemonadeDownloadInfo>,
): LemonadeDownloadInfo | undefined {
  const statuses = collection.components
    .filter((c) => c.downloadable)
    .map((c) => statusByName.get(c.name)?.status ?? 'none');
  if (statuses.length === 0 || statuses.every((s) => s === 'none'))
    return undefined;
  const status = statuses.every((s) => s === 'complete')
    ? 'complete'
    : 'partial';
  return {status, locations: []};
}

/**
 * Catalog browser for the Lemonade SDK's GGUF models: pick one, and its
 * checkpoint files (variant-matched, mmproj included) download through the
 * regular HF runner into local storage. Omni models render as expandable
 * collections whose GGUF members are selectable here; their image/audio/TTS
 * members are shown for context but aren't stored by this app.
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
  const [collections, setCollections] = useState<OmniCollection[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
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
          collections?: OmniCollection[];
          error?: string;
        } | null;
        if (cancelled) return;
        if (!res.ok || !data?.models) {
          setLoadError(data?.error ?? `${res.status} ${res.statusText}`);
          return;
        }
        setModels(data.models);
        setCollections(data.collections ?? []);
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

  const modelByName = useMemo(() => {
    const map = new Map<string, LemonadeModel>();
    for (const m of models ?? []) map.set(m.name, m);
    return map;
  }, [models]);

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

  const visibleCollections = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return collections;
    return collections.filter((c) =>
      [c.name, ...c.labels, ...c.components.map((x) => x.name)].some((s) =>
        s.toLowerCase().includes(needle),
      ),
    );
  }, [collections, filter]);

  const toggleCollection = (name: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

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
              {visibleCollections.map((c) => {
                const isExpanded = expanded.has(c.name);
                const aggregate = collectionAggregateStatus(c, statusByName);
                return (
                  <Fragment key={c.name}>
                    <ListItem
                      label={c.name}
                      description={`${c.components.length} components`}
                      startContent={
                        <IconButton
                          label={isExpanded ? 'Collapse' : 'Expand'}
                          variant="ghost"
                          size="sm"
                          icon={
                            <Icon
                              icon={isExpanded ? 'chevronDown' : 'chevronRight'}
                            />
                          }
                          onClick={() => toggleCollection(c.name)}
                        />
                      }
                      onClick={() => toggleCollection(c.name)}
                      endContent={
                        <HStack gap={1} vAlign="center">
                          <Badge label="omni" variant="purple" />
                          {aggregate && aggregate.status !== 'none' && (
                            <HoverCard
                              placement="above"
                              content={lemonadeStatusTooltip(aggregate)}
                            >
                              <Badge
                                label={
                                  aggregate.status === 'complete'
                                    ? 'downloaded'
                                    : 'partial'
                                }
                                variant={
                                  aggregate.status === 'complete'
                                    ? 'blue'
                                    : 'orange'
                                }
                              />
                            </HoverCard>
                          )}
                          {c.suggested && (
                            <Badge label="suggested" variant="green" />
                          )}
                          <Text type="supporting">{formatGb(c.sizeGb)}</Text>
                        </HStack>
                      }
                    />
                    {isExpanded &&
                      c.components.map((comp) => {
                        const model = comp.downloadable
                          ? modelByName.get(comp.name)
                          : undefined;
                        return model ? (
                          <ListItem
                            key={comp.name}
                            label={model.name}
                            description={`${model.repoId}${model.variant ? `:${model.variant}` : ''}`}
                            startContent={
                              <span {...stylex.props(styles.indent)} />
                            }
                            isSelected={selectedName === model.name}
                            onClick={() => setSelectedName(model.name)}
                            endContent={modelEndContent(
                              model,
                              statusByName.get(model.name),
                            )}
                          />
                        ) : (
                          <ListItem
                            key={comp.name}
                            label={comp.name}
                            startContent={
                              <span {...stylex.props(styles.indent)} />
                            }
                            isDisabled
                            description={externalComponentDescription(comp)}
                          />
                        );
                      })}
                  </Fragment>
                );
              })}
              {visible.map((m) => (
                <ListItem
                  key={m.name}
                  label={m.name}
                  description={`${m.repoId}${m.variant ? `:${m.variant}` : ''}`}
                  isSelected={selectedName === m.name}
                  onClick={() => setSelectedName(m.name)}
                  endContent={modelEndContent(m, statusByName.get(m.name))}
                />
              ))}
              {visible.length === 0 && visibleCollections.length === 0 && (
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
