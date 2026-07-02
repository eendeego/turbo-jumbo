'use client';

import {HStack, VStack} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import {Icon} from '@astryxdesign/core/Icon';
import {HoverCard} from '@astryxdesign/core/HoverCard';
import {formatSize, type SizeBreakdownGroup} from '@/lib/models/model-row';

// The hovercard shown on a size-mismatch warning icon: each location and the
// size it holds, grouped by file when a model row spans several mismatches.
export function SizeMismatchHover({groups}: {groups: SizeBreakdownGroup[]}) {
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
