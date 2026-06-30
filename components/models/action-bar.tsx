'use client';

import {Card} from '@astryxdesign/core/Card';
import {HStack} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import {Button} from '@astryxdesign/core/Button';

interface ActionBarProps {
  selected: Set<string>;
  onDelete: () => void;
  deleting: boolean;
}

export function ActionBar({selected, onDelete, deleting}: ActionBarProps) {
  if (selected.size === 0) return null;
  return (
    <Card padding={2}>
      <HStack gap={3} hAlign="between" vAlign="center">
        <Text type="supporting">
          {selected.size} file{selected.size !== 1 ? 's' : ''} selected
        </Text>
        <Button
          label={deleting ? 'Deleting…' : 'Delete…'}
          variant="destructive"
          size="sm"
          isDisabled={deleting}
          onClick={onDelete}
        />
      </HStack>
    </Card>
  );
}
