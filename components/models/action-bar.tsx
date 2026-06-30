'use client';

import {Card} from '@astryxdesign/core/Card';
import {HStack, VStack} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import {Button} from '@astryxdesign/core/Button';
import {ProgressBar} from '@astryxdesign/core/ProgressBar';
import type {CopyProgress} from '@/lib/copy-progress';
import {formatBytes} from '@/components/models/model-list';

const formatBytePair = (v: number, m: number) =>
  `${formatBytes(v)} of ${formatBytes(m)}`;

interface ActionBarProps {
  selected: Set<string>;
  onDelete: () => void;
  deleting: boolean;
  onCopy: () => void;
  copying: boolean;
  copyProgress?: CopyProgress | null;
}

export function ActionBar({
  selected,
  onDelete,
  deleting,
  onCopy,
  copying,
  copyProgress,
}: ActionBarProps) {
  if (selected.size === 0) return null;

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
              label={copying ? 'Copying…' : 'Copy to…'}
              variant="secondary"
              size="sm"
              isDisabled={copying || deleting}
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
                formatValueLabel={formatBytePair}
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
