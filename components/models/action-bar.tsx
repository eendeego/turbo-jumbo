'use client';

import {Card} from '@astryxdesign/core/Card';
import {HStack, VStack} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import {Button} from '@astryxdesign/core/Button';
import {ProgressBar} from '@astryxdesign/core/ProgressBar';
import type {CopyProgress} from '@/lib/copy-progress';

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
    copying && copyProgress != null && copyProgress.total > 0;

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
          <ProgressBar
            label="Files copied"
            value={copyProgress!.done}
            max={copyProgress!.total}
            hasValueLabel
            formatValueLabel={(v, m) => `${v} of ${m}`}
          />
        )}
      </VStack>
    </Card>
  );
}
