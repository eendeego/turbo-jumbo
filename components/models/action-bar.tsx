'use client';

import {Card} from '@astryxdesign/core/Card';
import {HStack} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import {Button} from '@astryxdesign/core/Button';

interface ActionBarProps {
  selected: Set<string>;
  onDelete: () => void;
  deleting: boolean;
  onCopy: () => void;
  copying: boolean;
}

export function ActionBar({
  selected,
  onDelete,
  deleting,
  onCopy,
  copying,
}: ActionBarProps) {
  if (selected.size === 0) return null;
  return (
    <Card padding={2}>
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
    </Card>
  );
}
