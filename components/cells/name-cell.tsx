'use client';

import {useState, type ReactNode} from 'react';
import * as stylex from '@stylexjs/stylex';
import {HStack} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import {Icon} from '@astryxdesign/core/Icon';
import {IconButton} from '@astryxdesign/core/IconButton';
import {Button} from '@astryxdesign/core/Button';
import {Badge} from '@astryxdesign/core/Badge';
import {HoverCard} from '@astryxdesign/core/HoverCard';
import {Link} from '@astryxdesign/core/Link';
import {VStack} from '@astryxdesign/core/Stack';
import {copyToClipboard} from '@/lib/clipboard';
import {modelDisplayName} from '@/lib/model-name';
import type {RepoFileState} from '@/lib/repo-files';
import {formatSize, type DisplayRow} from '@/lib/model-row';
import {MIXED_COMMIT, type SidecarSummary} from '@/lib/sidecar-types';

const styles = stylex.create({
  indent1: {paddingInlineStart: '1.5rem'},
  indent2: {paddingInlineStart: '3rem'},
});

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

/** The Hugging Face commit page URL for a sidecar's model and a commit sha. */
function commitUrl(modelUrl: string, sha: string): string {
  return `${modelUrl}/commit/${sha}`;
}

/** A short commit hash linking to its Hugging Face commit page. */
function CommitLink({modelUrl, sha}: {modelUrl: string; sha: string}) {
  return (
    <Link href={commitUrl(modelUrl, sha)} isExternalLink>
      {sha.slice(0, 12)}
    </Link>
  );
}

/** A label/value pair row inside the model-name hovercard. */
function InfoRow({label, children}: {label: string; children: ReactNode}) {
  return (
    <HStack gap={4} hAlign="between">
      <Text type="supporting">{label}</Text>
      <Text type="body">{children}</Text>
    </HStack>
  );
}

/** The model-level sidecar provenance block appended to the name hovercard. */
function SidecarInfo({sidecar}: {sidecar: SidecarSummary}) {
  const {sourceCommit, repoCommit, repoCommitDate, modelUrl} = sidecar;
  return (
    <VStack gap={1}>
      {sourceCommit && (
        <InfoRow label="Source revision">
          {sourceCommit === MIXED_COMMIT ? (
            'mixed'
          ) : (
            <CommitLink modelUrl={modelUrl} sha={sourceCommit} />
          )}
        </InfoRow>
      )}
      {repoCommit && (
        <InfoRow label="Repo HEAD">
          <CommitLink modelUrl={modelUrl} sha={repoCommit} />
          {repoCommitDate && ` (${repoCommitDate.slice(0, 10)})`}
        </InfoRow>
      )}
      <InfoRow label="Files">
        {sidecar.fileCount} · {formatSize(sidecar.totalSourceSize)}
      </InfoRow>
    </VStack>
  );
}

export function NameCell({
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

  // Model row. Show the repo segment of an org/repo identity; the full repo
  // (when the name carries one) and the sidecar provenance live in the
  // hovercard — shown only when there's something to say.
  const nameButton = (
    <Button
      label={modelDisplayName(row.label)}
      variant="ghost"
      size="sm"
      icon={<Icon icon={isExpanded ? 'chevronDown' : 'chevronRight'} />}
      onClick={() => onToggle(row.parentName)}
    />
  );
  return (
    <HStack gap={2} vAlign="center">
      {row.label.includes('/') || row.sidecar ? (
        <HoverCard
          placement="above"
          content={
            <VStack gap={1}>
              {row.label.includes('/') && (
                <InfoRow label="Repository">{row.label}</InfoRow>
              )}
              {row.sidecar && <SidecarInfo sidecar={row.sidecar} />}
            </VStack>
          }
        >
          {nameButton}
        </HoverCard>
      ) : (
        nameButton
      )}
      {row.orgSuffix && <Text type="supporting">({row.orgSuffix})</Text>}
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
