'use client';

import {HStack, VStack} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import {Icon} from '@astryxdesign/core/Icon';
import {Button} from '@astryxdesign/core/Button';
import {Badge} from '@astryxdesign/core/Badge';
import {HoverCard} from '@astryxdesign/core/HoverCard';
import {formatSize, type DisplayRow} from '@/lib/model-row';

export function ColdStorageCell({
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
