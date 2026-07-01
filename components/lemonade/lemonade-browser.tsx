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
  type DownloadRequest,
} from '@/components/hf-download/download-runner';
import {ModelLabelIcon} from '@/components/lemonade/model-label-icon';
import {sortLabelsForDisplay} from '@/lib/lemonade-labels';
import {
  collectionDownloadPlan,
  collectionDownloadStatus,
  componentDownloadStatus,
  lemonadeDownloadStatus,
  lemonadeStatusTooltip,
  matchVariantFiles,
  missingVariantFiles,
  planRepoJobs,
  resolveCheckpointFiles,
  type Checkpoint,
  type InventoryLocation,
  type LemonadeComponent,
  type LemonadeDownloadInfo,
  type LemonadeModel,
  type OmniCollection,
} from '@/lib/lemonade';

type HfFile = {path: string; size: number};

// What's currently picked for download: a standalone model, one component of a
// collection, or a whole collection.
type Selection =
  | {kind: 'model'; model: LemonadeModel}
  | {kind: 'component'; collectionName: string; component: LemonadeComponent}
  | {kind: 'collection'; collection: OmniCollection};

function selectionKey(s: Selection): string {
  if (s.kind === 'model') return `model:${s.model.name}`;
  if (s.kind === 'collection') return `coll:${s.collection.name}`;
  return `comp:${s.collectionName}:${s.component.name}`;
}

function selectionLabel(s: Selection): {title: string; sizeGb: number} {
  if (s.kind === 'model') return {title: s.model.name, sizeGb: s.model.sizeGb};
  if (s.kind === 'collection')
    return {title: s.collection.name, sizeGb: s.collection.sizeGb};
  return {title: s.component.name, sizeGb: s.component.sizeGb};
}

const uniq = <T,>(xs: T[]): T[] => [...new Set(xs)];

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
      <StatusMarker info={info} />
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

// A collection member's secondary line: the repo(s) its checkpoints pull from.
function componentSecondary(component: LemonadeComponent): string {
  const repos = uniq(component.checkpoints.map((c) => c.repoId));
  if (repos.length === 0) return component.modality;
  if (repos.length === 1) return repos[0];
  return `${repos[0]} +${repos.length - 1}`;
}

// A collection member's end-of-row content: a download-status marker (when
// the weight scan can track it), its modality, and its size.
function componentEndContent(
  component: LemonadeComponent,
  info: LemonadeDownloadInfo,
) {
  return (
    <HStack gap={1} vAlign="center">
      <StatusMarker info={info} />
      <Badge label={component.modality} variant="neutral" />
      <Text type="supporting">{formatGb(component.sizeGb)}</Text>
    </HStack>
  );
}

// The download-status marker shared by model rows and collection children.
function StatusMarker({info}: {info: LemonadeDownloadInfo | undefined}) {
  if (!info || info.status === 'none') return null;
  return (
    <HoverCard placement="above" content={lemonadeStatusTooltip(info)}>
      <Badge
        label={info.status === 'complete' ? 'downloaded' : 'partial'}
        variant={info.status === 'complete' ? 'blue' : 'orange'}
      />
    </HoverCard>
  );
}

/**
 * Catalog browser for the Lemonade SDK's models. Pick a single GGUF model, or
 * an omni collection / one of its components, and the selection's files —
 * across every repo it spans — download through the regular HF runner into
 * local storage (sequentially, one repo at a time).
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
  const [selection, setSelection] = useState<Selection | null>(null);
  const [sendToCold, setSendToCold] = useState(false);
  const [deleteAfterTransfer, setDeleteAfterTransfer] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [showTerminal, setShowTerminal] = useState(false);
  const [downloadTitle, setDownloadTitle] = useState('');
  const {term, progress, running, start, startMany, cancel, reset} =
    useDownloadRunner();

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

  const selectedKey = selection ? selectionKey(selection) : null;
  const selLabel = selection ? selectionLabel(selection) : null;

  // A single GGUF model: resolve the variant's files in its one repo and run
  // the downloader once. Unchanged from the original single-model path.
  const startModel = async (model: LemonadeModel) => {
    if (resolving || running) return;
    setResolving(true);
    setResolveError(null);
    try {
      const params = new URLSearchParams({
        repoId: model.repoId,
        branch: 'main',
      });
      const res = await fetch(`/api/v1/hf-files?${params}`);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const files = (await res.json()) as HfFile[];
      const all = matchVariantFiles(files, model.variant, model.mmproj);
      if (all.length === 0) {
        setResolveError(
          `No files in ${model.repoId} match "${model.variant ?? 'any gguf'}".`,
        );
        return;
      }
      const localModels =
        inventoryLocations.find((l) => l.isLocal)?.models ?? [];
      const missing = missingVariantFiles(all, localModels, model.repoId);
      setDownloadTitle(model.name);
      setShowTerminal(true);
      void start({
        repoId: model.repoId,
        branch: 'main',
        filePaths: missing.length > 0 ? missing : all,
        sendToCold,
        deleteAfterTransfer,
      });
    } catch (e) {
      setResolveError(e instanceof Error ? e.message : String(e));
    } finally {
      setResolving(false);
    }
  };

  // A collection or one of its components: resolve every checkpoint into a
  // per-repo download request, then run them in sequence through the runner.
  const startPlan = async (checkpoints: Checkpoint[], title: string) => {
    if (resolving || running) return;
    setResolving(true);
    setResolveError(null);
    try {
      const localModels =
        inventoryLocations.find((l) => l.isLocal)?.models ?? [];
      const reqs: DownloadRequest[] = [];
      for (const job of planRepoJobs(checkpoints)) {
        const params = new URLSearchParams({
          repoId: job.repoId,
          branch: 'main',
        });
        const res = await fetch(`/api/v1/hf-files?${params}`);
        if (!res.ok)
          throw new Error(`${job.repoId}: ${res.status} ${res.statusText}`);
        const files = (await res.json()) as HfFile[];
        const all = uniq(
          job.variants.flatMap((v) => resolveCheckpointFiles(files, v)),
        );
        if (all.length === 0) continue;
        const missing = missingVariantFiles(all, localModels, job.repoId);
        reqs.push({
          repoId: job.repoId,
          branch: 'main',
          filePaths: missing.length > 0 ? missing : all,
          sendToCold,
          deleteAfterTransfer,
        });
      }
      if (reqs.length === 0) {
        setResolveError(`Found no files to download for ${title}.`);
        return;
      }
      setDownloadTitle(title);
      setShowTerminal(true);
      await startMany(reqs, (i, req) =>
        setDownloadTitle(`${title} — ${req.repoId} (${i + 1}/${reqs.length})`),
      );
    } catch (e) {
      setResolveError(e instanceof Error ? e.message : String(e));
    } finally {
      setResolving(false);
    }
  };

  const onDownload = () => {
    if (!selection) return;
    if (selection.kind === 'model') return void startModel(selection.model);
    if (selection.kind === 'component')
      return void startPlan(
        selection.component.checkpoints,
        selection.component.name,
      );
    return void startPlan(
      collectionDownloadPlan(selection.collection),
      selection.collection.name,
    );
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
        title={`Downloading ${downloadTitle}…`}
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
                const aggregate = collectionDownloadStatus(
                  c,
                  inventoryLocations,
                );
                const collSelection: Selection = {
                  kind: 'collection',
                  collection: c,
                };
                return (
                  <Fragment key={c.name}>
                    <ListItem
                      label={c.name}
                      description={`${c.components.length} components`}
                      isSelected={selectedKey === selectionKey(collSelection)}
                      onClick={() => setSelection(collSelection)}
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
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleCollection(c.name);
                          }}
                        />
                      }
                      endContent={
                        <HStack gap={1} vAlign="center">
                          <Badge label="omni" variant="purple" />
                          <StatusMarker info={aggregate} />
                          {c.suggested && (
                            <Badge label="suggested" variant="green" />
                          )}
                          <Text type="supporting">{formatGb(c.sizeGb)}</Text>
                        </HStack>
                      }
                    />
                    {isExpanded &&
                      c.components.map((comp) => {
                        const compSelection: Selection = {
                          kind: 'component',
                          collectionName: c.name,
                          component: comp,
                        };
                        return (
                          <ListItem
                            key={comp.name}
                            label={comp.name}
                            description={componentSecondary(comp)}
                            startContent={
                              <span {...stylex.props(styles.indent)} />
                            }
                            isSelected={
                              selectedKey === selectionKey(compSelection)
                            }
                            onClick={() => setSelection(compSelection)}
                            endContent={componentEndContent(
                              comp,
                              componentDownloadStatus(comp, inventoryLocations),
                            )}
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
                  isSelected={selectedKey === `model:${m.name}`}
                  onClick={() => setSelection({kind: 'model', model: m})}
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
            {selLabel
              ? `${selLabel.title} · ${formatGb(selLabel.sizeGb)}`
              : 'Nothing selected'}
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
              onClick={onDownload}
              isDisabled={selection == null || resolving}
            />
          </HStack>
        </HStack>
      </VStack>
    </Dialog>
  );
}
