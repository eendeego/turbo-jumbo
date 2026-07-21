'use client';

import {useState} from 'react';
import {Dialog} from '@astryxdesign/core/Dialog';
import {VStack, HStack, StackItem} from '@astryxdesign/core/Stack';
import {Heading, Text} from '@astryxdesign/core/Text';
import {Button} from '@astryxdesign/core/Button';
import {Card} from '@astryxdesign/core/Card';
import {Badge} from '@astryxdesign/core/Badge';
import {CheckboxInput} from '@astryxdesign/core/CheckboxInput';
import {formatSize} from '@/lib/format/bytes';
import type {Peer} from '@/lib/config';

export interface ConflictItem {
  file: string;
  destination: string; // "cold-storage" | peer address
  sourceSize: number;
  destSize: number;
  sizeMatch: boolean;
  md5Match: boolean | null;
  sourceMd5: string | null;
  destMd5: string | null;
}

interface ConflictsModalProps {
  conflicts: ConflictItem[];
  peers?: Peer[];
  onConfirm: (skipList: Array<{file: string; destination: string}>) => void;
  onCancel: () => void;
}

const key = (c: {file: string; destination: string}) =>
  `${c.file}\0${c.destination}`;

export function ConflictsModal({
  conflicts,
  peers,
  onConfirm,
  onCancel,
}: ConflictsModalProps) {
  const peerNameMap = new Map((peers ?? []).map((p) => [p.address, p.name]));
  // Checked = overwrite. Default to overwriting anything that isn't byte-identical.
  const [overwrite, setOverwrite] = useState<Set<string>>(
    new Set(conflicts.filter((c) => c.md5Match !== true).map(key)),
  );

  function toggleOverwrite(conflict: ConflictItem) {
    const k = key(conflict);
    setOverwrite((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  function handleConfirm() {
    // skip = everything not marked for overwrite
    const skipList = conflicts
      .filter((c) => !overwrite.has(key(c)))
      .map((c) => ({file: c.file, destination: c.destination}));
    onConfirm(skipList);
  }

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      purpose="required"
    >
      <VStack gap={4}>
        <VStack gap={1}>
          <Heading level={3}>
            {conflicts.length === 1 ? '1 file' : `${conflicts.length} files`}{' '}
            already {conflicts.length === 1 ? 'exists' : 'exist'} at the
            destination
          </Heading>
          <Text type="supporting">
            Check files to overwrite them. Unchecked files are skipped.
          </Text>
        </VStack>

        <VStack gap={2}>
          {conflicts.map((conflict) => {
            const willOverwrite = overwrite.has(key(conflict));
            const destLabel =
              conflict.destination === 'cold-storage'
                ? 'cold storage'
                : (peerNameMap.get(conflict.destination) ??
                  conflict.destination);
            const status =
              conflict.md5Match === true
                ? {label: 'identical', variant: 'success' as const}
                : conflict.sizeMatch
                  ? {label: 'different content', variant: 'warning' as const}
                  : {label: 'different size', variant: 'warning' as const};
            return (
              <Card key={key(conflict)} padding={2}>
                <HStack gap={3} vAlign="start">
                  <CheckboxInput
                    label={`Overwrite ${conflict.file} at ${destLabel}`}
                    isLabelHidden
                    value={willOverwrite}
                    onChange={() => toggleOverwrite(conflict)}
                  />
                  <StackItem size="fill">
                    <VStack gap={1}>
                      <HStack gap={2} vAlign="center">
                        <Text type="code">{conflict.file}</Text>
                        <Text type="supporting">→ {destLabel}</Text>
                        <Badge variant={status.variant} label={status.label} />
                        <StackItem size="fill">
                          <HStack hAlign="end">
                            <Text type="supporting">
                              {willOverwrite ? 'overwrite' : 'skip'}
                            </Text>
                          </HStack>
                        </StackItem>
                      </HStack>
                      <HStack gap={3} vAlign="center">
                        <Text type="label">src</Text>
                        <Text type="code" color="secondary">
                          {formatSize(conflict.sourceSize)}
                        </Text>
                        <Text type="code" color="secondary">
                          {conflict.sourceMd5 ?? '—'}
                        </Text>
                      </HStack>
                      <HStack gap={3} vAlign="center">
                        <Text type="label">dst</Text>
                        <Text
                          type="code"
                          color={conflict.sizeMatch ? 'secondary' : 'accent'}
                        >
                          {formatSize(conflict.destSize)}
                        </Text>
                        <Text
                          type="code"
                          color={
                            conflict.md5Match === false ? 'accent' : 'secondary'
                          }
                        >
                          {conflict.destMd5 ?? '—'}
                        </Text>
                      </HStack>
                    </VStack>
                  </StackItem>
                </HStack>
              </Card>
            );
          })}
        </VStack>

        <HStack gap={2} hAlign="end">
          <Button label="Cancel" variant="secondary" onClick={onCancel} />
          <Button label="Continue" variant="primary" onClick={handleConfirm} />
        </HStack>
      </VStack>
    </Dialog>
  );
}
