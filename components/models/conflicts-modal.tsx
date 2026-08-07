'use client';

import {useState} from 'react';
import {Dialog, DialogHeader} from '@astryxdesign/core/Dialog';
import {Layout, LayoutContent, LayoutFooter} from '@astryxdesign/core/Layout';
import {VStack, HStack, StackItem} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
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
  // Which digest the two copies were compared with, and the result. The check
  // prefers the SHA256 both sidecars already record (no bytes read) and falls
  // back to md5-ing both copies; null means it couldn't compare at all — the
  // sizes differ, or one side offered no digest.
  digest: 'sha256' | 'md5' | null;
  digestMatch: boolean | null;
  sourceDigest: string | null;
  destDigest: string | null;
}

// Digests are identity, not reading material: enough to eyeball two rows
// against each other, with the algorithm named so sha256 and md5 rows are
// never mistaken for each other.
function shortDigest(value: string | null, algo: 'sha256' | 'md5' | null) {
  if (!value) return '—';
  return `${algo ?? '?'}:${value.slice(0, 12)}…`;
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
    new Set(conflicts.filter((c) => c.digestMatch !== true).map(key)),
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
      width="min(800px, 92vw)"
      maxHeight="85vh"
    >
      {/* Only the conflict list scrolls, so the Cancel/Continue buttons stay
          visible however many files clash. */}
      <Layout
        header={
          <DialogHeader
            title={
              conflicts.length === 1
                ? '1 file already exists at the destination'
                : `${conflicts.length} files already exist at the destination`
            }
            subtitle="Check files to overwrite them. Unchecked files are skipped."
          />
        }
        content={
          <LayoutContent>
            <VStack gap={2}>
              {conflicts.map((conflict) => {
                const willOverwrite = overwrite.has(key(conflict));
                const destLabel =
                  conflict.destination === 'cold-storage'
                    ? 'cold storage'
                    : (peerNameMap.get(conflict.destination) ??
                      conflict.destination);
                const status =
                  conflict.digestMatch === true
                    ? {label: 'identical', variant: 'success' as const}
                    : conflict.sizeMatch
                      ? {
                          label: 'different content',
                          variant: 'warning' as const,
                        }
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
                          {/* The path gets a line to itself: sharing one with
                              the destination, status and action crushed all
                              four together once a name grew long. */}
                          <Text type="code">{conflict.file}</Text>
                          <HStack gap={2} vAlign="center">
                            <Text type="supporting">→ {destLabel}</Text>
                            <Badge
                              variant={status.variant}
                              label={status.label}
                            />
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
                              {shortDigest(
                                conflict.sourceDigest,
                                conflict.digest,
                              )}
                            </Text>
                          </HStack>
                          <HStack gap={3} vAlign="center">
                            <Text type="label">dst</Text>
                            <Text
                              type="code"
                              color={
                                conflict.sizeMatch ? 'secondary' : 'accent'
                              }
                            >
                              {formatSize(conflict.destSize)}
                            </Text>
                            <Text
                              type="code"
                              color={
                                conflict.digestMatch === false
                                  ? 'accent'
                                  : 'secondary'
                              }
                            >
                              {shortDigest(
                                conflict.destDigest,
                                conflict.digest,
                              )}
                            </Text>
                          </HStack>
                        </VStack>
                      </StackItem>
                    </HStack>
                  </Card>
                );
              })}
            </VStack>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button label="Cancel" variant="secondary" onClick={onCancel} />
              <Button
                label="Continue"
                variant="primary"
                onClick={handleConfirm}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
