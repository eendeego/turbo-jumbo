'use client';

import {useEffect, useRef, useState, useCallback, useMemo} from 'react';
import * as stylex from '@stylexjs/stylex';
import {
  Table,
  proportional,
  pixel,
  type TableColumn,
} from '@astryxdesign/core/Table';
import {HStack, VStack} from '@astryxdesign/core/Stack';
import {Link} from '@astryxdesign/core/Link';
import {Text} from '@astryxdesign/core/Text';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {Button} from '@astryxdesign/core/Button';
import {Badge} from '@astryxdesign/core/Badge';
import {HoverCard} from '@astryxdesign/core/HoverCard';
import {CheckboxInput} from '@astryxdesign/core/CheckboxInput';
import {copyToClipboard} from '@/lib/clipboard';
import type {Peer as PeerConfig} from '@/lib/config';
import type {PeerModels} from '@/components/peers/peer';
import type {
  AuditProgressEvent,
  AuditResult,
  AuditStatus,
  UpdateResult,
} from '@/lib/audit';
import {isMmprojFilename, modelDisplayName} from '@/lib/model-name';
import {ggmlModelVariant} from '@/lib/weight-files';
import {isPickOneSafetensorsRepo} from '@/lib/hf-download';
import {isDiffusersRepo} from '@/lib/diffusers';
import {fileBasename, fileJoinKey, peerFileKeys} from '@/lib/peer-paths';
import {coldStorageRollup} from '@/lib/cold-storage-rollup';
import {rowAudit, rowUpdates, type RowAudit} from '@/lib/row-audit';
import type {RepoFile, RepoFileState} from '@/lib/repo-files';

export interface ShardInfo {
  filename: string;
  size: number;
}

export interface QuantInfo {
  label: string;
  filename: string | null;
  displayName: string;
  isSingleFile: boolean;
  inColdStorage: boolean; // a file of this name exists in cold storage
  coldComplete: boolean; // ...and its size matches (a complete, identical copy)
  coldSize: number | null; // size of the cold copy, when present (for the tooltip)
  coldTotalSize: number; // total size of the cold copy, splits summed (0 when absent)
  size: number;
  paths: string[];
  coldPaths: string[];
  shards: ShardInfo[];
  totalShards: number;
  presentShards: number;
  missingIndices: number[];
  isProjector?: boolean;
  // The precisions present for a diffusers component (fp16 / fp32), shown as a
  // badge; undefined for non-diffusers quants.
  precisions?: string[];
}

export type {LocationTab} from '@/components/models/location-tabs';
import type {LocationTab} from '@/components/models/location-tabs';

export interface ModelRow extends Record<string, unknown> {
  name: string;
  quantizations: string;
  quants: QuantInfo[];
  minSize: number;
  maxSize: number;
  allInColdStorage: boolean;
  noneInColdStorage: boolean;
}

// One location's copy of a quant, for the size-mismatch breakdown.
type SizeEntry = {id: string; location: string; size: number};

// A size-mismatch breakdown, optionally labelled by the file it belongs to.
// Quant rows carry a single unlabelled group; the rolled-up model row carries
// one labelled group per mismatched file so its warning is hoverable too.
type SizeBreakdownGroup = {label: string | null; entries: SizeEntry[]};

// The hovercard shown on a size-mismatch warning icon: each location and the
// size it holds, grouped by file when a model row spans several mismatches.
function SizeMismatchHover({groups}: {groups: SizeBreakdownGroup[]}) {
  return (
    <HoverCard
      placement="above"
      content={
        <VStack gap={2}>
          <Text type="supporting">Sizes differ across locations</Text>
          {groups.map((g) => (
            <VStack key={g.label ?? '_'} gap={1}>
              {g.label && <Text type="supporting">{g.label}</Text>}
              {g.entries.map((e) => (
                <HStack key={e.id} gap={4} hAlign="between">
                  <Text type="body">{e.location}</Text>
                  <Text type="body">{formatSize(e.size)}</Text>
                </HStack>
              ))}
            </VStack>
          ))}
        </VStack>
      }
    >
      <Icon icon="warning" size="sm" />
    </HoverCard>
  );
}

interface DisplayRow extends Record<string, unknown> {
  key: string;
  label: string;
  quantizations: string;
  isSingleFile: boolean;
  filename: string | null;
  depth: number; // 0=model, 1=quant, 2=shard
  parentName: string;
  size: number;
  sizeRange: [number, number] | null;
  inColdStorage: boolean | null;
  coldComplete: boolean | null;
  coldSize: number | null;
  allInColdStorage: boolean;
  noneInColdStorage: boolean;
  paths: string[];
  totalShards: number;
  presentShards: number;
  missingIndices: number[];
  sizeMismatch: boolean;
  sizeBreakdown: SizeEntry[] | null;
  // Set only on a model (rollup) row: one labelled group per mismatched file,
  // so its warning icon shows a hovercard like the per-quant rows do.
  sizeBreakdownGroups?: SizeBreakdownGroup[];
  undersizedLocations: Set<string>;
  isProjector?: boolean;
  // Precisions present for a diffusers component variant row (e.g. ['fp16']).
  precisions?: string[];
  // Set on a whole-repo model's per-file child rows (present/missing/invalid).
  fileState?: RepoFileState;
  // Set on a whole-repo model row (depth 0): its invalid + missing files, for
  // the audit hovercard's "why" list and the download action.
  repoIssues?: RepoFile[];
}

// A whole-repo (non-GGUF) model — ONNX/safetensors/etc. Its expansion lists the
// repo's files rather than quants. A model name without `org/repo` (so no HF
// repo to query) is excluded.
function isWholeRepoModel(m: ModelRow): boolean {
  return (
    m.name.includes('/') &&
    m.quants.length > 0 &&
    m.quants.every((q) => {
      const f = (q.filename ?? q.displayName ?? '').toLowerCase();
      return f !== '' && !f.endsWith('.gguf');
    }) &&
    // A repo of standalone ggml-*.bin models is a collection of single-file
    // variants — each selectable and copyable like a GGUF quant — not one
    // whole-repo model spread across many files.
    !m.quants.every(
      (q) => ggmlModelVariant(q.filename ?? q.displayName ?? '') !== null,
    ) &&
    // A Comfy-Org split_files safetensors bundle is likewise a collection of
    // independent component/quant files, shown as variant rows, not a whole repo.
    !isPickOneSafetensorsRepo(m.quants.flatMap((q) => q.paths)) &&
    // A diffusers pipeline is shown as present-only, precision-collapsed
    // component variant rows (see buildModelRows), not a whole-repo file list.
    !isDiffusersRepo(m.quants.flatMap((q) => q.paths))
  );
}

const styles = stylex.create({
  indent1: {paddingInlineStart: '1.5rem'},
  indent2: {paddingInlineStart: '3rem'},
  // Cached (sidecar-derived) audit verdicts are toned down vs fresh results.
  dimmed: {opacity: 0.6},
});

// Mirrors the server-side helper in models-table.tsx (not importable here:
// that module reads server config).
function quantBits(quant: string): string {
  const m = quant.match(/\d+/);
  return m ? m[0] : quant;
}

export function formatSize(bytes: number): string {
  if (bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

const AUDIT_BADGE: Record<
  AuditStatus,
  {label: string; variant: 'success' | 'error' | 'warning' | 'neutral'}
> = {
  pass: {label: 'Pass', variant: 'success'},
  incomplete: {label: 'Incomplete', variant: 'error'},
  'checksum-mismatch': {label: 'Mismatch', variant: 'error'},
  misplaced: {label: 'Misplaced', variant: 'warning'},
  duplicate: {label: 'Duplicate', variant: 'warning'},
  unverifiable: {label: 'Unverifiable', variant: 'neutral'},
  error: {label: 'Error', variant: 'error'},
};

// The expected value most relevant to a given failure, drawn from the HF source.
// Size isn't special-cased here: the `incomplete` message already names the
// expected size, and the HF block below always shows it.
function expectedDetail(f: AuditResult): string | null {
  if (!f.hf) return null;
  switch (f.status) {
    case 'checksum-mismatch':
      return `Expected sha256: ${f.hf.expectedSha256}`;
    case 'misplaced':
      return `Expected path: ${f.hf.expectedPath}`;
    default:
      return null;
  }
}

function AuditFailureContent({
  failures,
  onFix,
  fixing,
  onSetSource,
  onRedownload,
  redownloading,
  onShowRevisions,
  onFixDuplicate,
  fixingDuplicate,
}: {
  failures: AuditResult[];
  onFix?: (path: string) => void;
  fixing?: boolean;
  onSetSource?: (path: string) => void;
  onRedownload?: (file: AuditResult) => void;
  redownloading?: boolean;
  onShowRevisions?: (file: AuditResult) => void;
  onFixDuplicate?: (path: string) => void;
  fixingDuplicate?: boolean;
}) {
  return (
    <VStack gap={3}>
      {failures.map((f) => {
        const name = f.file.split('/').pop() ?? f.file;
        const detail = expectedDetail(f);
        const {label, variant} = AUDIT_BADGE[f.status];
        // Only non-cached misplaced files can be relocated server-side.
        const canFix = f.status === 'misplaced' && !f.cached && onFix != null;
        // Unverifiable files have no inferred source — let the user supply one.
        const canSetSource = f.status === 'unverifiable' && onSetSource != null;
        // Incomplete (partial) files can be re-fetched; the HF downloader
        // recovers the existing file in place, so it's never deleted first.
        const canRedownload =
          f.status === 'incomplete' && f.hf != null && onRedownload != null;
        // A size/checksum failure that scanned the repo's history carries the
        // revisions it ruled out, viewable in a modal.
        const canShowRevisions =
          (f.revisionsChecked?.length ?? 0) > 0 && onShowRevisions != null;
        // Duplicate groups can be resolved server-side: invalid/older copies
        // deleted, the surviving copy placed at the expected path.
        const canFixDuplicate =
          f.status === 'duplicate' && !f.cached && onFixDuplicate != null;
        return (
          <VStack
            key={f.file}
            gap={1}
            xstyle={f.cached ? styles.dimmed : undefined}
          >
            <Text type="body">
              {name}
              {f.cached ? ' (cached)' : ''}
            </Text>
            <HStack gap={2} vAlign="center">
              <Badge label={label} variant={variant} />
              {f.message && <Text type="supporting">{f.message}</Text>}
            </HStack>
            {detail && <Text type="supporting">{detail}</Text>}
            {f.hf && (
              <VStack gap={0}>
                {f.hf.expectedSize != null && (
                  <Text type="supporting">
                    Size: {formatSize(f.hf.expectedSize)}
                  </Text>
                )}
                {f.hf.commit && (
                  <Link href={f.hf.commitUrl ?? f.hf.fileUrl} isExternalLink>
                    Revision {f.hf.commit.slice(0, 12)}
                    {f.hf.commitDate && ` (${f.hf.commitDate.slice(0, 10)})`}
                  </Link>
                )}
                <Link href={f.hf.modelUrl} isExternalLink>
                  {f.hf.repoId}
                </Link>
                <Link href={f.hf.fileUrl} isExternalLink>
                  View file on HuggingFace
                </Link>
              </VStack>
            )}
            {canFix && (
              <HStack>
                <Button
                  label={fixing ? 'Fixing…' : 'Fix'}
                  variant="ghost"
                  size="sm"
                  onClick={() => onFix?.(f.file)}
                  isDisabled={fixing}
                />
              </HStack>
            )}
            {canFixDuplicate && (
              <HStack>
                <Button
                  label={fixingDuplicate ? 'Fixing…' : 'Fix'}
                  variant="ghost"
                  size="sm"
                  onClick={() => onFixDuplicate?.(f.file)}
                  isDisabled={fixingDuplicate}
                />
              </HStack>
            )}
            {canSetSource && (
              <HStack>
                <Button
                  label="Set source…"
                  variant="ghost"
                  size="sm"
                  onClick={() => onSetSource?.(f.file)}
                />
              </HStack>
            )}
            {canRedownload && (
              <HStack>
                <Button
                  label={
                    redownloading
                      ? 'Downloading…'
                      : name.toLowerCase().startsWith('mmproj')
                        ? 'Download mmproj'
                        : 'Download missing files'
                  }
                  variant="ghost"
                  size="sm"
                  onClick={() => onRedownload?.(f)}
                  isDisabled={redownloading}
                />
              </HStack>
            )}
            {canShowRevisions && (
              <HStack>
                <Button
                  label="Checked revisions…"
                  variant="ghost"
                  size="sm"
                  onClick={() => onShowRevisions?.(f)}
                />
              </HStack>
            )}
          </VStack>
        );
      })}
    </VStack>
  );
}

// Shown in the Audit column when a row has at least one file whose repo head
// commit is newer than the file's recorded source commit. The hovercard lists
// each behind file with a link to the newer commit.
function UpdateBadge({updates}: {updates: UpdateResult[]}) {
  return (
    <HoverCard
      placement="above"
      content={
        <VStack gap={1}>
          <Text type="supporting">Newer version on Hugging Face</Text>
          {updates.map((u) => {
            const name = u.file.split('/').pop() ?? u.file;
            const local = u.localCommitDate
              ? u.localCommitDate.slice(0, 10)
              : 'unknown';
            const remote = u.latestCommitDate
              ? u.latestCommitDate.slice(0, 10)
              : 'unknown';
            return (
              <VStack key={u.file} gap={0}>
                <Text type="body">{name}</Text>
                <Text type="supporting">
                  Local: {local} · Hugging Face: {remote}
                  {u.latestCommitUrl && u.latestCommit && (
                    <>
                      {' '}
                      <Link href={u.latestCommitUrl} isExternalLink>
                        {u.latestCommit.slice(0, 12)}
                      </Link>
                    </>
                  )}
                </Text>
              </VStack>
            );
          })}
        </VStack>
      }
    >
      <Badge
        label="Update"
        variant="info"
        icon={<Icon icon="info" size="sm" />}
      />
    </HoverCard>
  );
}

// Why a whole-repo model's file is flagged, for the invalid audit hovercard.
// A size that differs from Hugging Face is a truncated/corrupt copy; a size that
// matches but is still invalid means the sidecar can't attest it (no checksum).
function repoIssueReason(f: RepoFile): string {
  if (f.state === 'missing')
    return `missing — expected ${formatSize(f.expectedSize)}`;
  if (f.size != null && f.size !== f.expectedSize)
    return `wrong size — ${formatSize(f.size)}, expected ${formatSize(f.expectedSize)}`;
  return "source can't be verified";
}

function AuditCell({
  audit,
  failures,
  invalid = false,
  repoIssues,
  repoId,
  onDownloadFiles,
  downloadingFiles,
  onFix,
  fixing,
  onSetSource,
  onRedownload,
  redownloading,
  onShowRevisions,
  onFixDuplicate,
  fixingDuplicate,
}: {
  audit: RowAudit;
  failures?: AuditResult[];
  // The model has a local file that audits invalid (depth-0 rows). Its weights
  // can still pass, so a Pass verdict would be misleading — show Invalid instead.
  invalid?: boolean;
  // The model's invalid + missing files, named in the hovercard and downloaded.
  repoIssues?: RepoFile[];
  repoId?: string;
  onDownloadFiles?: (repoId: string, repoPaths: string[]) => void;
  downloadingFiles?: boolean;
  onFix?: (path: string) => void;
  fixing?: boolean;
  onSetSource?: (path: string) => void;
  onRedownload?: (file: AuditResult) => void;
  redownloading?: boolean;
  onShowRevisions?: (file: AuditResult) => void;
  onFixDuplicate?: (path: string) => void;
  fixingDuplicate?: boolean;
}) {
  if (audit == null) return null;
  if (audit.kind === 'pending') {
    // Waiting for a worker (audits serialize on cold storage): a muted marker
    // until the file's start event arrives.
    if (audit.queued) {
      return <Badge label="Queued" variant="neutral" xstyle={styles.dimmed} />;
    }
    return (
      <HStack gap={2} vAlign="center" wrap="nowrap">
        <Badge label="Auditing…" variant="neutral" />
        {/* The percent tracks the SHA256 hashing — the long part of an audit. */}
        {audit.percent != null && (
          <Text type="supporting">{audit.percent}%</Text>
        )}
      </HStack>
    );
  }
  // A model with an invalid file must not read as Pass even when every audited
  // weight passes (the invalid file — e.g. a bad index.json — isn't a weight, so
  // it never enters the audited paths). Expand the row to see which file.
  if (invalid && audit.status === 'pass') {
    const token = (
      <Badge
        label="Invalid"
        variant="error"
        xstyle={audit.cached ? styles.dimmed : undefined}
      />
    );
    const issues = repoIssues ?? [];
    // Detail not fetched yet: still don't claim Pass, just no hovercard.
    if (issues.length === 0) {
      return (
        <HoverCard content="Invalid — a local file doesn't match its Hugging Face source.">
          {token}
        </HoverCard>
      );
    }
    const downloadPaths = issues.map((f) => f.path);
    return (
      <HoverCard
        placement="above"
        content={
          <VStack gap={2}>
            <Text type="supporting">
              These files don&apos;t match Hugging Face:
            </Text>
            {issues.map((f) => (
              <VStack key={f.path} gap={0}>
                <Text type="body">{f.path}</Text>
                <HStack gap={2} vAlign="center">
                  <Badge
                    label={f.state === 'missing' ? 'missing' : 'invalid'}
                    variant="error"
                  />
                  <Text type="supporting">{repoIssueReason(f)}</Text>
                </HStack>
              </VStack>
            ))}
            {onDownloadFiles && repoId && downloadPaths.length > 0 && (
              <Button
                label={downloadingFiles ? 'Downloading…' : 'Download files'}
                variant="ghost"
                size="sm"
                isDisabled={downloadingFiles}
                onClick={() => onDownloadFiles(repoId, downloadPaths)}
              />
            )}
          </VStack>
        }
      >
        {token}
      </HoverCard>
    );
  }
  const {label, variant} = AUDIT_BADGE[audit.status];
  // Cached (metadata-derived) verdicts are toned down to contrast with fresh
  // results.
  const plainBadge = (
    <Badge
      label={label}
      variant={variant}
      xstyle={audit.cached ? styles.dimmed : undefined}
    />
  );
  const hasFailures =
    audit.status !== 'pass' && failures != null && failures.length > 0;
  if (!hasFailures) return plainBadge;
  return (
    <HoverCard
      placement="above"
      content={
        <AuditFailureContent
          failures={failures ?? []}
          onFix={onFix}
          fixing={fixing}
          onSetSource={onSetSource}
          onRedownload={onRedownload}
          redownloading={redownloading}
          onShowRevisions={onShowRevisions}
          onFixDuplicate={onFixDuplicate}
          fixingDuplicate={fixingDuplicate}
        />
      }
    >
      {plainBadge}
    </HoverCard>
  );
}

// Per-file status token in a whole-repo model's expanded file list.
function FileStateMarker({state}: {state: RepoFileState}) {
  const {label, variant} =
    state === 'present'
      ? ({label: 'present', variant: 'green'} as const)
      : state === 'missing'
        ? ({label: 'missing', variant: 'neutral'} as const)
        : ({label: 'invalid', variant: 'red'} as const);
  return <Badge label={label} variant={variant} />;
}

/**
 * A small clipboard icon that copies a model's name. Flips to a check mark for a
 * moment after a successful copy so the click registers visibly.
 */
function CopyNameButton({name}: {name: string}) {
  const [copied, setCopied] = useState(false);
  const copy = (e: {stopPropagation: () => void}) => {
    // Sits next to the row's toggle button; don't expand/collapse on copy.
    e.stopPropagation();
    copyToClipboard(name).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <IconButton
      label={`Copy model name ${name}`}
      icon={<Icon icon={copied ? 'check' : 'copy'} size="sm" />}
      variant="ghost"
      size="sm"
      tooltip={copied ? 'Copied' : 'Copy name'}
      onClick={copy}
    />
  );
}

/**
 * A small "open in new tab" icon linking to a model's Hugging Face page. Only
 * meaningful for `org/repo` models, whose name is the repo id; the repo URL is
 * the sidecar `modelUrl` (`https://huggingface.co/<repoId>`) reconstructed here.
 */
function OpenHfButton({repoId}: {repoId: string}) {
  return (
    <IconButton
      label={`Open ${repoId} on Hugging Face`}
      icon={<Icon icon="externalLink" size="sm" />}
      variant="ghost"
      size="sm"
      tooltip="Open on Hugging Face"
      onClick={(e) => {
        // Sits next to the row's toggle button; don't expand/collapse on click.
        e.stopPropagation();
        window.open(
          `https://huggingface.co/${repoId}`,
          '_blank',
          'noopener,noreferrer',
        );
      }}
    />
  );
}

function NameCell({
  row,
  isExpanded,
  onToggle,
  incomplete = false,
  invalid = false,
}: {
  row: DisplayRow;
  isExpanded: boolean;
  onToggle: (key: string) => void;
  // The model's local copy is present but missing files (depth-0 rows only).
  incomplete?: boolean;
  // The model has at least one local file that audits invalid (depth-0 rows).
  invalid?: boolean;
}) {
  // Whole-repo file row: the filename with a present/missing/invalid marker.
  if (row.fileState) {
    return (
      <HStack gap={2} vAlign="center" xstyle={styles.indent1}>
        <FileStateMarker state={row.fileState} />
        <Text type="supporting">{row.label}</Text>
      </HStack>
    );
  }

  // Shard row
  if (row.depth === 2) {
    return (
      <Text type="supporting" xstyle={styles.indent2}>
        {row.label}
      </Text>
    );
  }

  // Projector (mmproj) row: a companion file, not a quantization — marked so
  // it reads differently from the quant rows it sits among.
  if (row.isProjector) {
    return (
      <HStack gap={2} vAlign="center" xstyle={styles.indent1}>
        <Badge variant="neutral" label="projector" />
        <Text type="supporting">{row.label}</Text>
      </HStack>
    );
  }

  // Quant row
  if (row.depth === 1) {
    if (row.isSingleFile) {
      return (
        <HStack gap={2} vAlign="center" xstyle={styles.indent1}>
          <Text type="body">{row.label}</Text>
          {row.precisions && row.precisions.length > 0 && (
            <Badge label={row.precisions.join(', ')} variant="neutral" />
          )}
          <Text type="supporting">{row.filename}</Text>
        </HStack>
      );
    }
    // Split quant: expandable to its shards
    return (
      <Button
        label={row.label}
        variant="ghost"
        size="sm"
        xstyle={styles.indent1}
        icon={<Icon icon={isExpanded ? 'chevronDown' : 'chevronRight'} />}
        endContent={
          <HStack gap={2} vAlign="center">
            <Text type="supporting">
              {row.presentShards}/{row.totalShards} files
            </Text>
            {row.missingIndices.length > 0 && (
              <Badge
                variant="orange"
                label={`missing: ${row.missingIndices.join(', ')}`}
              />
            )}
          </HStack>
        }
        onClick={() => onToggle(row.key)}
      />
    );
  }

  // Model row. Show the repo segment of an org/repo identity; the full repo (when
  // the name carries one) and the quantizations live in the tooltip.
  const tooltip = row.label.includes('/')
    ? `Repository: ${row.label} · Quantizations: ${row.quantizations}`
    : `Quantizations: ${row.quantizations}`;
  return (
    <HStack gap={2} vAlign="center">
      <Button
        label={modelDisplayName(row.label)}
        variant="ghost"
        size="sm"
        icon={<Icon icon={isExpanded ? 'chevronDown' : 'chevronRight'} />}
        tooltip={tooltip}
        onClick={() => onToggle(row.parentName)}
      />
      {incomplete && <Badge variant="error" label="incomplete" />}
      {invalid && (
        <HoverCard content="Invalid download — a local file's size or checksum doesn't match its source">
          <Badge variant="error" label="invalid" />
        </HoverCard>
      )}
      <CopyNameButton name={row.label} />
      {row.label.includes('/') && <OpenHfButton repoId={row.label} />}
    </HStack>
  );
}

type PeerPresence = 'present' | 'absent' | 'undersized';

/** First letter of a peer name, for the compact badge/header initials. */
const peerInitial = (name: string) => (name[0] ?? '?').toUpperCase();

/**
 * Minimum width (px) for the Peers column. The column is fixed under the table's
 * fixed layout, so it can't grow to its content — size it to the wider of the
 * per-peer badges (24px each, 6px gap) and the "Peers" + initials header, plus
 * the cell's horizontal padding. Scales with the peer count so the column holds
 * no more empty space than the badges need.
 */
function peersColumnWidth(count: number): number {
  const badges = count * 24 + Math.max(0, count - 1) * 6;
  const header = 40 + count * 13; // "Peers" label + one initial per peer
  return Math.max(badges, header) + 24; // + cell padding (12px each side)
}

/**
 * A peer's presence for a row, as a compact single-letter badge: blue for the
 * local peer, cyan for a remote one, neutral when absent, warning when
 * undersized. Identity is the initial; the full name + status is on hover.
 */
function PeerBadge({peer, status}: {peer: PeerConfig; status: PeerPresence}) {
  const variant =
    status === 'absent'
      ? 'neutral'
      : status === 'undersized'
        ? 'warning'
        : peer.isLocal
          ? 'blue'
          : 'cyan';
  const label = status === 'absent' ? 'not present' : status;
  return (
    <HoverCard placement="above" content={`${peer.name} — ${label}`}>
      <Badge label={peerInitial(peer.name)} variant={variant} />
    </HoverCard>
  );
}

function PeersCell({
  row,
  peers,
  peerKeys,
}: {
  row: DisplayRow;
  peers: PeerConfig[];
  peerKeys: Map<string, Set<string>>;
}) {
  if (peers.length === 0 || row.depth === 2) return null;
  return (
    <HStack gap={1} vAlign="center" wrap="nowrap" hAlign="center">
      {peers.map((peer) => {
        // Joined by file key, not model name: names are derived per host and can
        // disagree for the same file, but a generic weight name is qualified by
        // the model so different repos don't collide (see lib/peer-paths.ts).
        const keys = peerKeys.get(peer.address);
        const hasPeer =
          keys != null &&
          row.paths.some((p) =>
            keys.has(fileJoinKey(row.parentName, fileBasename(p))),
          );
        const status: PeerPresence = !hasPeer
          ? 'absent'
          : row.undersizedLocations.has(peer.address)
            ? 'undersized'
            : 'present';
        return <PeerBadge key={peer.address} peer={peer} status={status} />;
      })}
    </HStack>
  );
}

/**
 * The Peers column header: the label plus the peer initials as a legend
 * (local in blue), full names on hover — so the cells can stay letters.
 */
function PeersHeader({peers}: {peers: PeerConfig[]}) {
  return (
    <HStack gap={2} vAlign="center">
      <Text>Peers</Text>
      <HStack gap={1} vAlign="center">
        {peers.map((p) => (
          <HoverCard key={p.address} placement="above" content={p.name}>
            <Badge
              label={peerInitial(p.name)}
              variant={p.isLocal ? 'blue' : 'neutral'}
            />
          </HoverCard>
        ))}
      </HStack>
    </HStack>
  );
}

function ColdStorageCell({
  row,
  onFixIncomplete,
  fixing = false,
}: {
  row: DisplayRow;
  onFixIncomplete?: (paths: string[]) => void;
  fixing?: boolean;
}) {
  if (row.depth === 2) return null; // shards don't show cold storage status
  if (row.depth === 1) {
    if (!row.inColdStorage) return <Badge label="Missing" variant="red" />;
    if (row.coldComplete) {
      const undersized = row.undersizedLocations.has('cold-storage');
      return (
        <Badge
          label="Yes"
          variant="green"
          icon={undersized ? <Icon icon="warning" size="sm" /> : undefined}
        />
      );
    }
    // Present by name but a different size — a partial/mismatched cold copy.
    const incomplete = <Badge label="Incomplete" variant="orange" />;
    if (row.coldSize == null) return incomplete;
    // The partial cold copy can be completed by re-running the local → cold
    // copy, which resumes from the verified prefix already there.
    const canFix = onFixIncomplete != null && row.paths.length > 0;
    return (
      <HoverCard
        placement="above"
        content={
          <VStack gap={2}>
            <Text type="supporting">
              Cold copy {formatSize(row.coldSize)} — expected{' '}
              {formatSize(row.size)}
            </Text>
            {canFix && (
              <HStack>
                <Button
                  label={fixing ? 'Fixing…' : 'Fix'}
                  variant="ghost"
                  size="sm"
                  onClick={() => onFixIncomplete(row.paths)}
                  isDisabled={fixing}
                />
              </HStack>
            )}
          </VStack>
        }
      >
        {incomplete}
      </HoverCard>
    );
  }
  if (row.allInColdStorage) return <Badge label="Complete" variant="green" />;
  if (row.noneInColdStorage) return <Badge label="Missing" variant="red" />;
  return <Badge label="Partial" variant="orange" />;
}

/**
 * Extend `models` with quants that exist only on peers — absent from local
 * and cold storage — so peer-only files are visible and selectable. The first
 * peer naming a quant supplies its representation; its paths are the peer's
 * own. Exported so the copy/delete modals resolve selections against the same
 * augmented view the table renders.
 */
export function augmentWithPeerOnlyQuants(
  models: ModelRow[],
  peerModels: Map<string, PeerModels>,
): ModelRow[] {
  const existingKeys = new Set<string>();
  for (const m of models) {
    for (const q of m.quants) existingKeys.add(`${m.name}::${q.label}`);
  }

  // Gather peer-only quants, picking the first peer's representation.
  type PeerOnly = {
    modelName: string;
    label: string;
    isProjector: boolean;
    isSingleFile: boolean;
    filename: string | null;
    displayName: string;
    size: number;
    paths: string[];
    totalShards: number;
    presentShards: number;
    missingIndices: number[];
  };
  const peerOnly = new Map<string, PeerOnly>();
  for (const [, lo] of peerModels) {
    if (lo.type !== 'value') continue;
    for (const m of lo.value) {
      for (const f of m.files) {
        const base = f.isSplit ? f.representativeFilename : f.filename;
        const label = isMmprojFilename(base) ? base : f.quant;
        const key = `${m.name}::${label}`;
        if (existingKeys.has(key) || peerOnly.has(key)) continue;
        peerOnly.set(key, {
          modelName: m.name,
          label,
          isProjector: isMmprojFilename(base),
          isSingleFile: !f.isSplit,
          filename: f.isSplit ? null : f.filename,
          displayName: f.isSplit ? f.representativeFilename : f.filename,
          size: f.isSplit ? f.totalSize : f.size,
          paths: f.isSplit ? f.files.map((s) => s.path) : [f.path],
          totalShards: f.isSplit ? f.totalShards : 0,
          presentShards: f.isSplit ? f.presentShards : 0,
          missingIndices: f.isSplit ? f.missingIndices : [],
        });
      }
    }
  }

  if (peerOnly.size === 0) return models;

  const byModel = new Map<string, ModelRow>();
  for (const m of models) byModel.set(m.name, {...m, quants: [...m.quants]});

  for (const p of peerOnly.values()) {
    const quant: QuantInfo = {
      label: p.label,
      isSingleFile: p.isSingleFile,
      filename: p.filename,
      displayName: p.displayName,
      inColdStorage: false,
      coldComplete: false,
      coldSize: null,
      coldTotalSize: 0,
      size: p.size,
      paths: p.paths,
      coldPaths: [],
      shards: [],
      totalShards: p.totalShards,
      presentShards: p.presentShards,
      missingIndices: p.missingIndices,
      isProjector: p.isProjector,
    };
    const existing = byModel.get(p.modelName);
    if (existing) {
      existing.quants.push(quant);
    } else {
      byModel.set(p.modelName, {
        name: p.modelName,
        quantizations: '',
        quants: [quant],
        minSize: 0,
        maxSize: 0,
        allInColdStorage: false,
        noneInColdStorage: true,
      });
    }
  }

  // Recompute aggregates and ordering; mirrors the server-side aggregation
  // in models-table.tsx.
  return [...byModel.values()]
    .map((m) => {
      const quants = [...m.quants].sort(
        (a, b) =>
          Number(!!a.isProjector) - Number(!!b.isProjector) ||
          Number(quantBits(a.label)) - Number(quantBits(b.label)),
      );
      const weights = quants.filter((q) => !q.isProjector);
      const sizes = weights.map((q) => q.size).filter((s) => s > 0);
      return {
        ...m,
        quants,
        quantizations: [
          ...new Set(weights.map((q) => quantBits(q.label))),
        ].join(', '),
        minSize: sizes.length > 0 ? Math.min(...sizes) : 0,
        maxSize: sizes.length > 0 ? Math.max(...sizes) : 0,
        ...coldStorageRollup(quants),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function ModelsTableClient({
  models,
  peers,
  peerModels,
  incompleteRepos,
  invalidRepos,
  selected,
  onToggleSelected,
  locations,
  activeLocation = 'all',
  auditResults,
  auditedPaths,
  auditing = false,
  auditProgress,
  auditStarted,
  updateResults,
  onClearAudit,
  onFixMisplaced,
  fixing = false,
  onSetSource,
  onRedownload,
  redownloading = false,
  onDownloadRepoFiles,
  onShowRevisions,
  onFixColdIncomplete,
  coldFixing = false,
  onFixDuplicate,
  fixingDuplicate = false,
}: {
  models: ModelRow[];
  peers: PeerConfig[];
  peerModels: Map<string, PeerModels>;
  // Repo ids (model names) whose local copy is present but incomplete.
  incompleteRepos?: Set<string>;
  // Repo ids (model names) with at least one local file that audits invalid.
  invalidRepos?: Set<string>;
  selected?: Set<string>;
  onToggleSelected?: (paths: string[]) => void;
  locations?: LocationTab[];
  activeLocation?: string;
  auditResults?: Map<string, AuditResult>;
  auditedPaths?: Set<string>;
  auditing?: boolean;
  auditProgress?: Map<string, AuditProgressEvent>;
  auditStarted?: Set<string>;
  updateResults?: Map<string, UpdateResult>;
  onClearAudit?: () => void;
  onFixMisplaced?: (paths: string[]) => void;
  fixing?: boolean;
  onSetSource?: (path: string) => void;
  onRedownload?: (file: AuditResult) => void;
  redownloading?: boolean;
  // Download a whole-repo model's invalid + missing files (from its hovercard).
  onDownloadRepoFiles?: (repoId: string, repoPaths: string[]) => void;
  onShowRevisions?: (file: AuditResult) => void;
  onFixColdIncomplete?: (paths: string[]) => void;
  coldFixing?: boolean;
  onFixDuplicate?: (paths: string[]) => void;
  fixingDuplicate?: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Per-repo file lists for expanded whole-repo models, keyed by
  // `<location>::<model name>` (file status is per location), fetched lazily on
  // expand. In-flight fetches are tracked in a ref so marking one doesn't
  // trigger a render.
  const [repoFiles, setRepoFiles] = useState<Map<string, RepoFile[]>>(
    new Map(),
  );
  const inFlight = useRef<Set<string>>(new Set());

  const toggle = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // Fetch the file list for whole-repo models when they're expanded — and
  // eagerly for any flagged invalid, so the audit hovercard can name the bad
  // files without an expansion. Against the active location (the local store, or
  // a peer proxied to its own endpoint).
  useEffect(() => {
    const peer = peers.find((p) => p.address === activeLocation);
    const urlFor = (repoId: string) =>
      peer
        ? `/api/v1/peers/${encodeURIComponent(peer.name)}/repo-files?repoId=${encodeURIComponent(repoId)}`
        : `/api/v1/local-models/repo-files?repoId=${encodeURIComponent(repoId)}`;
    const wanted = new Set<string>(expanded);
    for (const name of invalidRepos ?? []) wanted.add(name);
    for (const name of wanted) {
      const key = `${activeLocation}::${name}`;
      if (repoFiles.has(key) || inFlight.current.has(key)) continue;
      const m = models.find((mm) => mm.name === name);
      if (!m || !isWholeRepoModel(m)) continue;
      inFlight.current.add(key);
      void (async () => {
        let files: RepoFile[] = [];
        try {
          const res = await fetch(urlFor(name));
          if (res.ok)
            files = ((await res.json()) as {files?: RepoFile[]}).files ?? [];
        } catch {
          /* best-effort: leave the list empty */
        }
        inFlight.current.delete(key);
        setRepoFiles((prev) => new Map(prev).set(key, files));
      })();
    }
  }, [expanded, models, peers, activeLocation, repoFiles, invalidRepos]);

  // Build lookup: peerAddress -> Set<file basename>. Files are matched across
  // hosts by basename because model names are derived per host and can
  // disagree for the same file (see lib/peer-paths.ts).
  const peerKeys = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const [address, lo] of peerModels) {
      if (lo.type !== 'value') continue;
      map.set(address, peerFileKeys(lo.value));
    }
    return map;
  }, [peerModels]);

  // Build lookup: "modelName::quant" -> [{address, size}] across all peers
  // (split groups summed), to flag copies whose sizes disagree by location.
  const peerQuantSizes = useMemo(() => {
    const map = new Map<string, Array<{address: string; size: number}>>();
    for (const [address, lo] of peerModels) {
      if (lo.type !== 'value') continue;
      for (const m of lo.value) {
        // A diffusers pipeline reuses one basename across components (unet/ and
        // vae/ both ship diffusion_pytorch_model.safetensors), so a filename key
        // would compare unrelated components; its variants aren't size-checked
        // across locations.
        if (
          isDiffusersRepo(
            m.files.flatMap((f) =>
              f.isSplit ? f.files.map((s) => s.path) : [f.path],
            ),
          )
        )
          continue;
        for (const f of m.files) {
          // Join copies across locations by filename, not the quant label:
          // several `.bin`/`.safetensors` files in one repo can share a quant
          // (e.g. 'pytorch'), so keying by quant would compare the sizes of
          // unrelated files and report a spurious cross-location mismatch.
          const base = f.isSplit ? f.representativeFilename : f.filename;
          const key = `${m.name}::${base}`;
          const size = f.isSplit ? f.totalSize : f.size;
          const existing = map.get(key);
          if (existing) existing.push({address, size});
          else map.set(key, [{address, size}]);
        }
      }
    }
    return map;
  }, [peerModels]);

  const peerNameByAddr = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of peers) map.set(p.address, p.name);
    return map;
  }, [peers]);

  // Synthesize rows for quants that exist only on peers — absent from local
  // and cold storage — so the table shows everything reachable.
  const augmentedModels = useMemo(
    () => augmentWithPeerOnlyQuants(models, peerModels),
    [models, peerModels],
  );

  // Filter models to the active location tab.
  const effectiveModels = useMemo(() => {
    if (activeLocation === 'all') return augmentedModels;
    return augmentedModels
      .map((m) => {
        const quants = m.quants
          .filter((q) => {
            if (activeLocation === 'cold-storage') return q.inColdStorage;
            const keys = peerKeys.get(activeLocation);
            return (
              keys != null &&
              q.paths.some((p) =>
                keys.has(fileJoinKey(m.name, fileBasename(p))),
              )
            );
          })
          // On the cold-storage tab, delete/select via the cold-storage paths.
          .map((q) =>
            activeLocation === 'cold-storage' && q.coldPaths.length > 0
              ? {...q, paths: q.coldPaths}
              : q,
          );
        if (quants.length === 0) return null;
        const weights = quants.filter((q) => !q.isProjector);
        const sizes = weights.map((q) => q.size).filter((s) => s > 0);
        return {
          ...m,
          quants,
          minSize: sizes.length > 0 ? Math.min(...sizes) : 0,
          maxSize: sizes.length > 0 ? Math.max(...sizes) : 0,
          ...coldStorageRollup(quants),
        } satisfies ModelRow;
      })
      .filter((m): m is ModelRow => m !== null);
  }, [augmentedModels, activeLocation, peerKeys]);

  const showCheckboxes = onToggleSelected != null;

  // Every selectable file path in the current tab's view, for the select-all
  // header checkbox. Same toggle semantics as a row: all selected → clear.
  const allVisiblePaths = useMemo(
    () => effectiveModels.flatMap((m) => m.quants.flatMap((q) => q.paths)),
    [effectiveModels],
  );

  // Everything the current view can expand: each model, and each split
  // quant's shard group. Drives the expand-all chevron in the Model header.
  const allExpandableKeys = useMemo(() => {
    const keys: string[] = [];
    for (const m of effectiveModels) {
      keys.push(m.name);
      for (const q of m.quants) {
        if (!q.isSingleFile) keys.push(`${m.name}::${q.label}`);
      }
    }
    return keys;
  }, [effectiveModels]);

  const toggleAll = useCallback(() => {
    setExpanded((prev) => {
      const allExpanded = allExpandableKeys.every((k) => prev.has(k));
      return allExpanded ? new Set() : new Set(allExpandableKeys);
    });
  }, [allExpandableKeys]);

  // Memoized so row objects keep their identity across unrelated re-renders;
  // Table's per-row memo bails out via shallow compare otherwise (the nested
  // paths/sizeRange arrays would be rebuilt every render).
  const rows: DisplayRow[] = useMemo(() => {
    const out: DisplayRow[] = [];
    for (const m of effectiveModels) {
      // Per-quant size breakdown across cold storage and peers. Locations
      // disagreeing mark the quant — and, rolled up, the model row. The
      // effective size is the largest known copy; smaller copies are
      // undersized.
      type QuantSizeInfo = {
        effectiveSize: number;
        breakdown: SizeEntry[];
        mismatch: boolean;
        undersized: Set<string>;
      };
      const quantInfo = new Map<string, QuantSizeInfo>();
      let anyQuantMismatch = false;
      for (const q of m.quants) {
        const quantKey = `${m.name}::${q.label}`;
        // Peer copies are keyed by filename (see peerQuantSizes), so this
        // quant's cross-location sizes are looked up by its file, not its label
        // — a label can cover several distinct files (e.g. two `.bin` weights).
        const fileKey = `${m.name}::${q.isSingleFile ? q.filename : q.displayName}`;
        const breakdown: SizeEntry[] = [];
        if (q.coldTotalSize > 0) {
          breakdown.push({
            id: 'cold-storage',
            location: 'Cold storage',
            size: q.coldTotalSize,
          });
        }
        for (const ps of peerQuantSizes.get(fileKey) ?? []) {
          breakdown.push({
            id: ps.address,
            location: peerNameByAddr.get(ps.address) ?? ps.address,
            size: ps.size,
          });
        }
        const distinct = new Set(breakdown.map((e) => e.size));
        const mismatch = distinct.size > 1;
        const effectiveSize =
          breakdown.length > 0
            ? Math.max(...breakdown.map((e) => e.size))
            : q.size;
        const undersized = new Set<string>();
        if (mismatch) {
          for (const e of breakdown) {
            if (e.size < effectiveSize) undersized.add(e.id);
          }
        }
        quantInfo.set(quantKey, {
          effectiveSize,
          breakdown,
          mismatch,
          undersized,
        });
        if (mismatch) anyQuantMismatch = true;
      }

      const effectiveQuantSizes = m.quants
        .filter((q) => !q.isProjector)
        .map(
          (q) =>
            quantInfo.get(`${m.name}::${q.label}`)?.effectiveSize ?? q.size,
        )
        .filter((s) => s > 0);
      const minSize =
        effectiveQuantSizes.length > 0 ? Math.min(...effectiveQuantSizes) : 0;
      const maxSize =
        effectiveQuantSizes.length > 0 ? Math.max(...effectiveQuantSizes) : 0;

      // One labelled breakdown per mismatched file, so the rolled-up model
      // row's warning icon shows the same per-location sizes its quant rows do
      // (the row is otherwise collapsed, leaving the icon unexplained).
      const mismatchGroups: SizeBreakdownGroup[] = m.quants
        .map((q) => ({
          label: q.label,
          info: quantInfo.get(`${m.name}::${q.label}`),
        }))
        .filter((x) => x.info?.mismatch === true)
        .map((x) => ({label: x.label, entries: x.info!.breakdown}));

      // A whole-repo model's invalid + missing files (when its repo-file list
      // has been fetched), for the audit hovercard's "why" and download action.
      const repoIssues = isWholeRepoModel(m)
        ? repoFiles
            .get(`${activeLocation}::${m.name}`)
            ?.filter((f) => f.state === 'invalid' || f.state === 'missing')
        : undefined;

      out.push({
        key: m.name,
        label: m.name,
        quantizations: m.quantizations,
        isSingleFile: false,
        filename: null,
        depth: 0,
        parentName: m.name,
        size: minSize === maxSize ? minSize : -1,
        sizeRange: minSize !== maxSize ? [minSize, maxSize] : null,
        inColdStorage: null,
        coldComplete: null,
        coldSize: null,
        allInColdStorage: m.allInColdStorage,
        noneInColdStorage: m.noneInColdStorage,
        paths: m.quants.flatMap((q) => q.paths),
        totalShards: 0,
        presentShards: 0,
        missingIndices: [],
        sizeMismatch: anyQuantMismatch,
        sizeBreakdown: null,
        ...(mismatchGroups.length > 0
          ? {sizeBreakdownGroups: mismatchGroups}
          : {}),
        undersizedLocations: new Set<string>(),
        ...(repoIssues && repoIssues.length > 0 ? {repoIssues} : {}),
      });
      if (!expanded.has(m.name)) continue;
      if (isWholeRepoModel(m)) {
        // Whole-repo model: list its repo files (present/missing/invalid)
        // instead of quants. Empty until the lazy fetch lands.
        for (const f of repoFiles.get(`${activeLocation}::${m.name}`) ?? []) {
          out.push({
            key: `${m.name}::file::${f.path}`,
            label: f.path,
            quantizations: '',
            isSingleFile: true,
            filename: f.path,
            depth: 1,
            parentName: m.name,
            size: f.size ?? f.expectedSize,
            sizeRange: null,
            inColdStorage: null,
            coldComplete: null,
            coldSize: null,
            allInColdStorage: false,
            noneInColdStorage: false,
            paths: [],
            totalShards: 0,
            presentShards: 0,
            missingIndices: [],
            sizeMismatch: false,
            sizeBreakdown: null,
            undersizedLocations: new Set<string>(),
            fileState: f.state,
          });
        }
        continue;
      }
      for (const q of m.quants) {
        const quantKey = `${m.name}::${q.label}`;
        const info = quantInfo.get(quantKey);
        out.push({
          key: quantKey,
          label: q.label,
          quantizations: '',
          isSingleFile: q.isSingleFile,
          filename: q.filename,
          depth: 1,
          parentName: m.name,
          size: info?.effectiveSize ?? q.size,
          sizeRange: null,
          inColdStorage: q.inColdStorage,
          coldComplete: q.coldComplete,
          coldSize: q.coldSize,
          allInColdStorage: false,
          noneInColdStorage: false,
          paths: q.paths,
          totalShards: q.totalShards,
          presentShards: q.presentShards,
          missingIndices: q.missingIndices,
          sizeMismatch: info?.mismatch ?? false,
          sizeBreakdown: info?.mismatch ? info.breakdown : null,
          undersizedLocations: info?.undersized ?? new Set<string>(),
          isProjector: q.isProjector,
          precisions: q.precisions,
        });
        if (!q.isSingleFile && expanded.has(quantKey)) {
          for (const shard of q.shards) {
            out.push({
              key: `${quantKey}::${shard.filename}`,
              label: shard.filename,
              quantizations: '',
              isSingleFile: false,
              filename: null,
              depth: 2,
              parentName: m.name,
              size: shard.size,
              sizeRange: null,
              inColdStorage: null,
              coldComplete: null,
              coldSize: null,
              allInColdStorage: false,
              noneInColdStorage: false,
              paths: [],
              totalShards: 0,
              presentShards: 0,
              missingIndices: [],
              sizeMismatch: false,
              sizeBreakdown: null,
              undersizedLocations: new Set<string>(),
            });
          }
        }
      }
    }
    return out;
  }, [
    effectiveModels,
    expanded,
    repoFiles,
    activeLocation,
    peerQuantSizes,
    peerNameByAddr,
  ]);

  const columns: TableColumn<DisplayRow>[] = [
    ...(showCheckboxes
      ? [
          {
            key: 'select',
            header: (() => {
              const allSelected =
                selected != null &&
                allVisiblePaths.length > 0 &&
                allVisiblePaths.every((p) => selected.has(p));
              const someSelected =
                selected != null &&
                allVisiblePaths.some((p) => selected.has(p));
              return (
                <CheckboxInput
                  label="Select all rows"
                  isLabelHidden
                  value={
                    allSelected ? true : someSelected ? 'indeterminate' : false
                  }
                  onChange={() => onToggleSelected!(allVisiblePaths)}
                  isDisabled={allVisiblePaths.length === 0}
                />
              );
            })(),
            width: pixel(36),
            align: 'center' as const,
            renderCell: (item: DisplayRow) => {
              if (item.depth === 2 || item.paths.length === 0) return null;
              const allSelected =
                selected != null &&
                item.paths.length > 0 &&
                item.paths.every((p) => selected.has(p));
              const someSelected =
                selected != null && item.paths.some((p) => selected.has(p));
              return (
                <CheckboxInput
                  label={`Select ${item.label}`}
                  isLabelHidden
                  value={
                    allSelected ? true : someSelected ? 'indeterminate' : false
                  }
                  onChange={() => onToggleSelected!(item.paths)}
                />
              );
            },
          } satisfies TableColumn<DisplayRow>,
        ]
      : []),
    {
      key: 'label',
      header: (() => {
        const allExpanded =
          allExpandableKeys.length > 0 &&
          allExpandableKeys.every((k) => expanded.has(k));
        return (
          <HStack gap={1} vAlign="center" wrap="nowrap">
            <IconButton
              label={allExpanded ? 'Collapse all rows' : 'Expand all rows'}
              tooltip={allExpanded ? 'Collapse all rows' : 'Expand all rows'}
              icon={
                <Icon icon={allExpanded ? 'chevronDown' : 'chevronRight'} />
              }
              variant="ghost"
              size="sm"
              onClick={toggleAll}
              isDisabled={allExpandableKeys.length === 0}
            />
            <Text type="body">Model</Text>
          </HStack>
        );
      })(),
      width: proportional(1),
      renderCell: (item) => (
        <NameCell
          row={item}
          isExpanded={expanded.has(
            item.depth === 0 ? item.parentName : item.key,
          )}
          onToggle={toggle}
          incomplete={
            item.depth === 0 && (incompleteRepos?.has(item.parentName) ?? false)
          }
          invalid={
            item.depth === 0 && (invalidRepos?.has(item.parentName) ?? false)
          }
        />
      ),
    },
    {
      key: 'size',
      header: 'Size',
      // Fits a two-ended range ("12.3 GB – 45.6 GB") plus the mismatch icon.
      width: pixel(160),
      align: 'end',
      renderCell: (item) => (
        <HStack gap={1} vAlign="center" hAlign="end">
          {item.sizeMismatch &&
            (() => {
              const groups =
                item.sizeBreakdownGroups ??
                (item.sizeBreakdown
                  ? [{label: null, entries: item.sizeBreakdown}]
                  : null);
              return groups ? (
                <SizeMismatchHover groups={groups} />
              ) : (
                <Icon icon="warning" size="sm" />
              );
            })()}
          <Text type="body">
            {item.sizeRange
              ? `${formatSize(item.sizeRange[0])} – ${formatSize(item.sizeRange[1])}`
              : formatSize(item.size)}
          </Text>
        </HStack>
      ),
    },
    // Peers column only on the "All" tab (redundant on a peer's own tab and on
    // the cold-storage tab).
    ...(activeLocation !== 'cold-storage' &&
    !locations?.some((l) => l.id === activeLocation)
      ? [
          {
            key: 'peers',
            header: <PeersHeader peers={peers} />,
            width: pixel(peersColumnWidth(peers.length)),
            align: 'center' as const,
            renderCell: (item: DisplayRow) =>
              item.fileState ? null : (
                <PeersCell row={item} peers={peers} peerKeys={peerKeys} />
              ),
          } satisfies TableColumn<DisplayRow>,
        ]
      : []),
    // Cold Storage column hidden on the cold-storage tab itself.
    ...(activeLocation !== 'cold-storage'
      ? [
          {
            key: 'coldStorage',
            header: 'Cold Storage',
            // Fits the "Cold Storage" header, wider than any of its tokens.
            width: pixel(120),
            align: 'center' as const,
            renderCell: (item: DisplayRow) =>
              item.fileState ? null : (
                <ColdStorageCell
                  row={item}
                  onFixIncomplete={onFixColdIncomplete}
                  fixing={coldFixing}
                />
              ),
          } satisfies TableColumn<DisplayRow>,
        ]
      : []),
    // Audit column appears only once an audit has been run on some selection.
    ...(auditedPaths && auditedPaths.size > 0
      ? [
          {
            key: 'audit',
            header: (
              <HStack gap={1} vAlign="center" wrap="nowrap">
                <Text type="body">Audit</Text>
                {/* Leave audit mode: clear every verdict, which hides the
                    column. Hidden while a run is streaming results. */}
                {onClearAudit && !auditing && (
                  <IconButton
                    label="Clear audit results"
                    tooltip="Clear audit results"
                    icon={<Icon icon="close" size="xsm" />}
                    variant="ghost"
                    size="sm"
                    onClick={onClearAudit}
                  />
                )}
              </HStack>
            ),
            // Wide enough for the longest token, "Auditing… 100%", without
            // wrapping.
            width: pixel(170),
            align: 'center' as const,
            renderCell: (item: DisplayRow) => {
              if (item.fileState) return null;
              const results = auditResults ?? new Map<string, AuditResult>();
              // A model (depth 0) row also shows verdicts for files that
              // belong to it but aren't on disk — e.g. a synthetic
              // missing-mmproj verdict keyed `<repoId>/mmproj-F16.gguf`.
              const companionPaths =
                item.depth === 0
                  ? [...results.keys()].filter(
                      (p) =>
                        p.startsWith(item.key + '/') && !item.paths.includes(p),
                    )
                  : [];
              const auditPaths = [...item.paths, ...companionPaths];
              const failures = auditPaths
                .map((p) => results.get(p))
                .filter(
                  (r): r is AuditResult => r != null && r.status !== 'pass',
                );
              const updates = rowUpdates(item.paths, updateResults);
              return (
                <HStack gap={1} vAlign="center" hAlign="center" wrap="nowrap">
                  <AuditCell
                    audit={rowAudit(
                      auditPaths,
                      auditedPaths,
                      results,
                      auditing,
                      auditProgress,
                      auditStarted,
                    )}
                    failures={failures}
                    invalid={
                      item.depth === 0 &&
                      (invalidRepos?.has(item.parentName) ?? false)
                    }
                    repoIssues={item.repoIssues}
                    repoId={item.parentName}
                    onDownloadFiles={onDownloadRepoFiles}
                    downloadingFiles={redownloading}
                    onFix={
                      onFixMisplaced
                        ? (path) => onFixMisplaced([path])
                        : undefined
                    }
                    fixing={fixing}
                    onSetSource={onSetSource}
                    onRedownload={onRedownload}
                    redownloading={redownloading}
                    onShowRevisions={onShowRevisions}
                    onFixDuplicate={
                      onFixDuplicate
                        ? (path) => onFixDuplicate([path])
                        : undefined
                    }
                    fixingDuplicate={fixingDuplicate}
                  />
                  {updates.length > 0 && <UpdateBadge updates={updates} />}
                </HStack>
              );
            },
          } satisfies TableColumn<DisplayRow>,
        ]
      : []),
  ];

  return <Table data={rows} columns={columns} idKey="key" />;
}
