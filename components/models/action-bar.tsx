'use client';

import {useRef, useEffect} from 'react';
import * as stylex from '@stylexjs/stylex';
import {Card} from '@astryxdesign/core/Card';
import {HStack, VStack} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import {Button} from '@astryxdesign/core/Button';
import {IconButton} from '@astryxdesign/core/IconButton';
import {ProgressBar} from '@astryxdesign/core/ProgressBar';
import {CommandLineIcon} from '@heroicons/react/24/outline';
import type {CopyProgress} from '@/lib/storage/copy-progress';
import {
  checkStatusLabel,
  type CheckProgress,
} from '@/lib/storage/check-progress';
import {formatSize, formatSpeed} from '@/lib/format/bytes';

const formatBytePair = (v: number, m: number) =>
  `${formatSize(v)} of ${formatSize(m)}`;

// Sits above the fixed-overlay Log console (z-index 40) so its Console toggle
// stays clickable when the console is open.
const styles = stylex.create({
  root: {position: 'relative', zIndex: 50},
});

interface ActionBarProps {
  selected: Set<string>;
  onDelete: () => void;
  deleting: boolean;
  onCopy: () => void;
  copying: boolean;
  copyProgress?: CopyProgress | null;
  checking?: boolean;
  checkProgress?: CheckProgress | null;
  onCancelCheck?: () => void;
  onAudit?: () => void;
  auditing?: boolean;
  auditSupported?: boolean;
  onFixMisplaced?: () => void;
  misplacedCount?: number;
  fixing?: boolean;
  consoleOpen?: boolean;
  onToggleConsole?: () => void;
}

export function ActionBar({
  selected,
  onDelete,
  deleting,
  onCopy,
  copying,
  copyProgress,
  checking,
  checkProgress,
  onCancelCheck,
  onAudit,
  auditing = false,
  auditSupported = false,
  onFixMisplaced,
  misplacedCount = 0,
  fixing = false,
  consoleOpen = false,
  onToggleConsole,
}: ActionBarProps) {
  // Derive a live transfer speed from successive byte-progress samples. The
  // result lives in a ref (no setState in the effect) and is read during the
  // next render, which the changing copyProgress prop already triggers.
  const sampleRef = useRef<{bytes: number; time: number} | null>(null);
  const speedRef = useRef<number | null>(null);
  const bytesDone = copyProgress?.bytesDone;

  useEffect(() => {
    if (!copying || bytesDone == null) {
      sampleRef.current = null;
      speedRef.current = null;
      return;
    }
    const now = Date.now();
    if (sampleRef.current !== null) {
      const dt = (now - sampleRef.current.time) / 1000;
      const db = bytesDone - sampleRef.current.bytes;
      if (dt > 0 && db >= 0) speedRef.current = db / dt;
    }
    sampleRef.current = {bytes: bytesDone, time: now};
  }, [bytesDone, copying]);

  const noneSelected = selected.size === 0;

  const speed = copying ? speedRef.current : null;

  const showProgress =
    copying && copyProgress != null && copyProgress.filesTotal > 0;

  return (
    <Card padding={2} xstyle={styles.root}>
      <VStack gap={2}>
        <HStack gap={3} hAlign="between" vAlign="center">
          <Text type="supporting">
            {noneSelected
              ? 'No files selected'
              : `${selected.size} file${selected.size !== 1 ? 's' : ''} selected`}
          </Text>
          <HStack gap={2}>
            {/* A check that has to hash reads whole files, so it says which
                one and how far along it is — and can be abandoned. */}
            {checking && onCancelCheck && (
              <Button
                label="Cancel check"
                variant="secondary"
                size="sm"
                onClick={onCancelCheck}
              />
            )}
            <Button
              label={
                copying
                  ? 'Copying…'
                  : checking
                    ? checkStatusLabel(checkProgress)
                    : 'Copy to…'
              }
              variant="secondary"
              size="sm"
              // Like the Audit tooltip, only explains the no-selection case;
              // a running action already explains itself via the label.
              tooltip={
                noneSelected
                  ? 'Copying needs a selection — check some files in the table first'
                  : undefined
              }
              isDisabled={
                noneSelected ||
                copying ||
                deleting ||
                checking ||
                auditing ||
                fixing
              }
              onClick={onCopy}
            />
            <Button
              label={deleting ? 'Deleting…' : 'Delete…'}
              variant="destructive"
              size="sm"
              tooltip={
                noneSelected
                  ? 'Deleting needs a selection — check some files in the table first'
                  : undefined
              }
              isDisabled={
                noneSelected || deleting || copying || auditing || fixing
              }
              onClick={onDelete}
            />
            {onAudit && (
              <Button
                label={auditing ? 'Auditing…' : 'Audit'}
                variant="secondary"
                size="sm"
                // With a tooltip the disabled button stays focusable
                // (aria-disabled), so the explanation is reachable.
                tooltip={
                  auditSupported
                    ? undefined
                    : 'Audit is only implemented per location — switch to a peer or cold-storage tab'
                }
                // Unlike the other actions, Audit works without a selection:
                // it then just loads the location's cached (sidecar) verdicts.
                isDisabled={
                  auditing ||
                  copying ||
                  deleting ||
                  checking ||
                  fixing ||
                  !auditSupported
                }
                onClick={onAudit}
              />
            )}
            {onFixMisplaced && misplacedCount > 0 && (
              <Button
                label={fixing ? 'Fixing…' : `Fix misplaced (${misplacedCount})`}
                variant="secondary"
                size="sm"
                isDisabled={
                  fixing || copying || deleting || auditing || checking
                }
                onClick={onFixMisplaced}
              />
            )}
            {onToggleConsole && (
              <IconButton
                label="Console"
                tooltip="Console"
                variant={consoleOpen ? 'secondary' : 'ghost'}
                size="sm"
                icon={<CommandLineIcon style={{width: 16, height: 16}} />}
                onClick={onToggleConsole}
              />
            )}
          </HStack>
        </HStack>
        {showProgress && (
          <VStack gap={2}>
            {copyProgress!.phase === 'verifying' && (
              <ProgressBar
                label="Verifying partial file (SHA256)"
                value={copyProgress!.verifyDone ?? 0}
                max={Math.max(copyProgress!.verifyTotal ?? 0, 1)}
                hasValueLabel
                formatValueLabel={(v, m) => `${Math.floor((v / m) * 100)}%`}
              />
            )}
            {copyProgress!.resume != null && (
              <Text type="supporting">
                {copyProgress!.resume === 'resumed'
                  ? 'Partial file verified — resuming copy'
                  : 'Partial file SHA256 mismatch — copying from start'}
              </Text>
            )}
            {copyProgress!.bytesTotal > 0 && (
              <ProgressBar
                label="Total"
                value={copyProgress!.bytesDone}
                max={copyProgress!.bytesTotal}
                hasValueLabel
                formatValueLabel={(v, m) =>
                  speed != null
                    ? `${formatBytePair(v, m)} · ${formatSpeed(speed)}`
                    : formatBytePair(v, m)
                }
              />
            )}
            <ProgressBar
              label="Files"
              value={copyProgress!.filesDone}
              max={copyProgress!.filesTotal}
              hasValueLabel
              formatValueLabel={(v, m) => `${v} of ${m}`}
            />
            {copyProgress!.fileTotal > 0 && (
              <ProgressBar
                label="Current file"
                value={copyProgress!.fileDone}
                max={copyProgress!.fileTotal}
                hasValueLabel
                formatValueLabel={formatBytePair}
              />
            )}
          </VStack>
        )}
      </VStack>
    </Card>
  );
}
