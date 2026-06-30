'use client';

import {useRef, useEffect} from 'react';
import {Card} from '@astryxdesign/core/Card';
import {HStack, VStack} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import {Button} from '@astryxdesign/core/Button';
import {ProgressBar} from '@astryxdesign/core/ProgressBar';
import type {CopyProgress} from '@/lib/copy-progress';
import {formatBytes, formatSpeed} from '@/components/models/model-list';

const formatBytePair = (v: number, m: number) =>
  `${formatBytes(v)} of ${formatBytes(m)}`;

interface ActionBarProps {
  selected: Set<string>;
  onDelete: () => void;
  deleting: boolean;
  onCopy: () => void;
  copying: boolean;
  copyProgress?: CopyProgress | null;
  checking?: boolean;
}

export function ActionBar({
  selected,
  onDelete,
  deleting,
  onCopy,
  copying,
  copyProgress,
  checking,
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

  if (selected.size === 0) return null;

  const speed = copying ? speedRef.current : null;

  const showProgress =
    copying && copyProgress != null && copyProgress.filesTotal > 0;

  return (
    <Card padding={2}>
      <VStack gap={2}>
        <HStack gap={3} hAlign="between" vAlign="center">
          <Text type="supporting">
            {selected.size} file{selected.size !== 1 ? 's' : ''} selected
          </Text>
          <HStack gap={2}>
            <Button
              label={copying ? 'Copying…' : checking ? 'Checking…' : 'Copy to…'}
              variant="secondary"
              size="sm"
              isDisabled={copying || deleting || checking}
              onClick={onCopy}
            />
            <Button
              label={deleting ? 'Deleting…' : 'Delete…'}
              variant="destructive"
              size="sm"
              isDisabled={deleting || copying}
              onClick={onDelete}
            />
          </HStack>
        </HStack>
        {showProgress && (
          <VStack gap={2}>
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
