'use client';

import {Fragment, useEffect, useMemo, useState} from 'react';
import * as stylex from '@stylexjs/stylex';
import {VStack, HStack, StackItem} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {Button} from '@astryxdesign/core/Button';
import {CheckboxInput} from '@astryxdesign/core/CheckboxInput';
import {List, ListItem} from '@astryxdesign/core/List';
import {Badge} from '@astryxdesign/core/Badge';
import {HoverCard} from '@astryxdesign/core/HoverCard';
import {Link} from '@astryxdesign/core/Link';
import {IconButton} from '@astryxdesign/core/IconButton';
import {Icon} from '@astryxdesign/core/Icon';
import {DownloadModal} from '@/components/hf-download/download-runner';
import type {DownloadTarget} from '@/lib/download-target';
import type {Model} from '@/lib/models';
import {
  catalogSection,
  collectionDownloadStatus,
  componentDownloadStatus,
  componentInLemonadeCache,
  lemonadeDownloadStatus,
  modelInLemonadeCache,
  type CatalogSection,
  type InventoryLocation,
  type LemonadeComponent,
  type LemonadeDownloadInfo,
  type LemonadeModel,
  type OmniCollection,
} from '@/lib/lemonade';
import {
  checkpointsIncomplete,
  formatGb,
  selectionKey,
  selectionLabel,
  type CatalogRow,
  type Selection,
} from '@/lib/lemonade-catalog';
import {
  IncompleteMarker,
  LemonadeCacheMarker,
  SectionHeader,
  StatusMarker,
} from '@/components/lemonade/markers';
import {
  componentEndContent,
  componentSecondary,
  modelEndContent,
} from '@/components/lemonade/catalog-rows';
import {useLemonadeDownload} from '@/components/lemonade/use-lemonade-download';

// The catalog's modality sections, in display order. The niche ONNX (Ryzen AI)
// and vLLM LLM backends sit below the media sections to keep the top focused.
const SECTION_LABELS: Record<CatalogSection, string> = {
  llm: 'Language models',
  vision: 'Vision models',
  embeddings: 'Embeddings',
  reranking: 'Rerankers',
  image: 'Image models',
  transcription: 'Speech-to-text',
  tts: 'Text-to-speech',
  onnx: 'ONNX (Ryzen AI)',
  vllm: 'vLLM',
  other: 'Other',
};
const SECTION_ORDER: CatalogSection[] = [
  'llm',
  'vision',
  'embeddings',
  'reranking',
  'image',
  'transcription',
  'tts',
  'onnx',
  'vllm',
  'other',
];

const styles = stylex.create({
  // Fixed-height body, like the HF download picker: the dialog must not
  // resize as the catalog loads or the filter narrows.
  pickerBody: {height: '55vh', minHeight: 0},
  modelList: {flexGrow: 1, minHeight: 0, overflowY: 'auto'},
  indent: {width: 20, display: 'inline-block'},
});

/**
 * Catalog browser for the Lemonade SDK's models, inlined as a sub-tab's body.
 * Pick a single GGUF model, or an omni collection / one of its components,
 * and the selection's files — across every repo it spans — download through
 * the regular HF runner into local storage (sequentially, one repo at a
 * time). Download is only enabled when `canDownload` (the local peer's tab).
 */
export function LemonadeBrowser({
  hfTokenSet,
  target,
  targetName,
  inventoryLocations,
  lemonadeCacheModels,
  incompleteRepos,
  canDownload,
  onDownloaded,
}: {
  hfTokenSet: boolean;
  // Where the download runs (endpoint + display path), and the peer name of the
  // machine it lands on — used to skip files already present there.
  target: DownloadTarget;
  targetName: string | null;
  inventoryLocations: InventoryLocation[];
  // Models found in Lemonade's own cache directory, surfaced with a distinct
  // token alongside the regular download-status marker.
  lemonadeCacheModels: Model[];
  // Repo ids whose local copy is present but incomplete; flagged on each row.
  incompleteRepos: Set<string>;
  canDownload: boolean;
  // Called after a download session ends so the parent can refresh local
  // models; the status markers then recompute from the new inventory.
  onDownloaded?: () => void;
}) {
  const [models, setModels] = useState<LemonadeModel[] | null>(null);
  const [extraModels, setExtraModels] = useState<LemonadeComponent[]>([]);
  const [collections, setCollections] = useState<OmniCollection[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Section keys (a CatalogSection, or 'omni') the user has collapsed.
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(
    new Set(),
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  // When on, the catalog is narrowed to entries the Lemonade catalog flags as
  // `suggested` (GGUF models and omni collections), and the now-redundant
  // suggested token is hidden.
  const [suggestedOnly, setSuggestedOnly] = useState(true);
  // Whether to include the standalone "extra" components (ONNX/vLLM/image/speech
  // models). They carry no `suggested` flag, so they're controlled on their own
  // rather than by the suggested-only filter; off by default to keep the initial
  // view focused on the suggested GGUF models and omni collections.
  const [showExtra, setShowExtra] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [sendToCold, setSendToCold] = useState(false);
  const [deleteAfterTransfer, setDeleteAfterTransfer] = useState(false);
  const {
    resolving,
    resolveError,
    showTerminal,
    downloadTitle,
    term,
    progress,
    running,
    command,
    onDownload,
    closeTerminal,
  } = useLemonadeDownload({
    target,
    targetName,
    inventoryLocations,
    sendToCold,
    deleteAfterTransfer,
    onDownloaded,
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/v1/lemonade-models');
        const data = (await res.json().catch(() => null)) as {
          models?: LemonadeModel[];
          extraModels?: LemonadeComponent[];
          collections?: OmniCollection[];
          error?: string;
        } | null;
        if (cancelled) return;
        if (!res.ok || !data?.models) {
          setLoadError(data?.error ?? `${res.status} ${res.statusText}`);
          return;
        }
        setModels(data.models);
        setExtraModels(data.extraModels ?? []);
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

  const visibleModels = useMemo(() => {
    if (!models) return [];
    const needle = filter.trim().toLowerCase();
    return models.filter((m) => {
      if (suggestedOnly && !m.suggested) return false;
      if (!needle) return true;
      return [m.name, m.repoId, ...m.labels].some((s) =>
        s.toLowerCase().includes(needle),
      );
    });
  }, [models, filter, suggestedOnly]);

  const visibleExtra = useMemo(() => {
    if (!showExtra) return [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return extraModels;
    return extraModels.filter((c) =>
      [c.name, c.recipe, ...c.checkpoints.map((cp) => cp.repoId)].some((s) =>
        s.toLowerCase().includes(needle),
      ),
    );
  }, [extraModels, filter, showExtra]);

  const visibleCollections = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return collections.filter((c) => {
      if (suggestedOnly && !c.suggested) return false;
      if (!needle) return true;
      return [c.name, ...c.labels, ...c.components.map((x) => x.name)].some(
        (s) => s.toLowerCase().includes(needle),
      );
    });
  }, [collections, filter, suggestedOnly]);

  const toggleCollection = (name: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const toggleSection = (key: string) =>
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
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

  // Which standalone catalog models are present in Lemonade's own cache.
  const inCacheByName = useMemo(() => {
    const map = new Map<string, boolean>();
    if (!models) return map;
    for (const m of models) {
      map.set(m.name, modelInLemonadeCache(m, lemonadeCacheModels));
    }
    return map;
  }, [models, lemonadeCacheModels]);

  // Download status + cache presence for the non-llamacpp standalone models,
  // computed the same way as omni members.
  const extraStatusByName = useMemo(() => {
    const map = new Map<string, LemonadeDownloadInfo>();
    for (const c of extraModels) {
      map.set(c.name, componentDownloadStatus(c, inventoryLocations));
    }
    return map;
  }, [extraModels, inventoryLocations]);
  const extraInCacheByName = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const c of extraModels) {
      map.set(c.name, componentInLemonadeCache(c, lemonadeCacheModels));
    }
    return map;
  }, [extraModels, lemonadeCacheModels]);

  // The flat catalog, grouped into ordered modality sections (GGUF models and
  // standalone non-llamacpp models together).
  const sections = useMemo(() => {
    const byCat = new Map<CatalogSection, CatalogRow[]>();
    const push = (key: CatalogSection, row: CatalogRow) => {
      const rows = byCat.get(key);
      if (rows) rows.push(row);
      else byCat.set(key, [row]);
    };
    for (const m of visibleModels)
      push(catalogSection('llamacpp', m.labels), {kind: 'model', model: m});
    for (const c of visibleExtra)
      push(catalogSection(c.recipe, []), {kind: 'component', component: c});
    return SECTION_ORDER.map((key) => ({
      key,
      label: SECTION_LABELS[key],
      rows: byCat.get(key) ?? [],
    })).filter((s) => s.rows.length > 0);
  }, [visibleModels, visibleExtra]);

  const selectedKey = selection ? selectionKey(selection) : null;
  const selLabel = selection ? selectionLabel(selection) : null;

  if (showTerminal) {
    return (
      <DownloadModal
        title={`Downloading ${downloadTitle}…`}
        term={term}
        progress={progress}
        running={running}
        command={command ?? undefined}
        hfTokenSet={hfTokenSet}
        onClose={closeTerminal}
      />
    );
  }

  return (
    <VStack gap={4}>
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
            <CheckboxInput
              label="Suggested only"
              value={suggestedOnly}
              onChange={setSuggestedOnly}
              size="sm"
            />
            <CheckboxInput
              label="Extra models"
              value={showExtra}
              onChange={setShowExtra}
              size="sm"
            />
            <Text type="supporting">
              {visibleModels.length + visibleExtra.length} /{' '}
              {models.length + extraModels.length} models
            </Text>
          </HStack>
        )}
        {models != null && (
          <List hasDividers xstyle={styles.modelList}>
            {visibleCollections.length > 0 && (
              <SectionHeader
                label="Omni models"
                count={visibleCollections.length}
                collapsed={collapsedSections.has('omni')}
                onToggle={() => toggleSection('omni')}
              />
            )}
            {!collapsedSections.has('omni') &&
              visibleCollections.map((c) => {
                const isExpanded = expanded.has(c.name);
                const aggregate = collectionDownloadStatus(
                  c,
                  inventoryLocations,
                );
                // Presence in the Lemonade cache per member, driving the cache
                // marker next to the download-status marker. The header token
                // dims when the collection is only partially cached.
                const componentInCache = new Map(
                  c.components.map((comp) => [
                    comp.name,
                    componentInLemonadeCache(comp, lemonadeCacheModels),
                  ]),
                );
                const cachePresentCount = [...componentInCache.values()].filter(
                  Boolean,
                ).length;
                const collInCache = cachePresentCount > 0;
                const cachePartial =
                  collInCache && cachePresentCount < c.components.length;
                // Members with a present-but-incomplete local copy; the header
                // flags if any.
                const componentIncomplete = new Map(
                  c.components.map((comp) => [
                    comp.name,
                    checkpointsIncomplete(comp.checkpoints, incompleteRepos),
                  ]),
                );
                const anyIncomplete = [...componentIncomplete.values()].some(
                  Boolean,
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
                          {c.manifestUrl && (
                            <HoverCard content="View the manifest (models.json) this omni model is built from">
                              <Link
                                href={c.manifestUrl}
                                isExternalLink
                                onClick={(e) => e.stopPropagation()}
                              >
                                manifest
                              </Link>
                            </HoverCard>
                          )}
                          <Badge label="omni" variant="purple" />
                          <StatusMarker info={aggregate} />
                          <LemonadeCacheMarker
                            present={collInCache}
                            muted={cachePartial}
                          />
                          <IncompleteMarker incomplete={anyIncomplete} />
                          {!suggestedOnly && c.suggested && (
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
                              componentInCache.get(comp.name) ?? false,
                              componentIncomplete.get(comp.name) ?? false,
                            )}
                          />
                        );
                      })}
                  </Fragment>
                );
              })}
            {sections.map((sec) => (
              <Fragment key={sec.key}>
                <SectionHeader
                  label={sec.label}
                  count={sec.rows.length}
                  collapsed={collapsedSections.has(sec.key)}
                  onToggle={() => toggleSection(sec.key)}
                />
                {!collapsedSections.has(sec.key) &&
                  sec.rows.map((row) =>
                    row.kind === 'model' ? (
                      <ListItem
                        key={`m:${row.model.name}`}
                        label={row.model.name}
                        description={`${row.model.repoId}${row.model.variant ? `:${row.model.variant}` : ''}`}
                        isSelected={selectedKey === `model:${row.model.name}`}
                        onClick={() =>
                          setSelection({kind: 'model', model: row.model})
                        }
                        endContent={modelEndContent(
                          row.model,
                          statusByName.get(row.model.name),
                          inCacheByName.get(row.model.name) ?? false,
                          !suggestedOnly,
                        )}
                      />
                    ) : (
                      <ListItem
                        key={`c:${row.component.name}`}
                        label={row.component.name}
                        description={componentSecondary(row.component)}
                        isSelected={
                          selectedKey === `standalone:${row.component.name}`
                        }
                        onClick={() =>
                          setSelection({
                            kind: 'standalone',
                            component: row.component,
                          })
                        }
                        endContent={componentEndContent(
                          row.component,
                          extraStatusByName.get(row.component.name) ?? {
                            status: 'none',
                            locations: [],
                          },
                          extraInCacheByName.get(row.component.name) ?? false,
                          checkpointsIncomplete(
                            row.component.checkpoints,
                            incompleteRepos,
                          ),
                        )}
                      />
                    ),
                  )}
              </Fragment>
            ))}
            {sections.length === 0 && visibleCollections.length === 0 && (
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
        <HStack gap={2} vAlign="center">
          {!canDownload && (
            <Text type="supporting">
              Downloads run on the local machine — open the local tab, then
              copy.
            </Text>
          )}
          <Button
            label={resolving ? 'Resolving…' : 'Download'}
            variant="primary"
            size="sm"
            onClick={() => onDownload(selection)}
            isDisabled={!canDownload || selection == null || resolving}
          />
        </HStack>
      </HStack>
    </VStack>
  );
}
