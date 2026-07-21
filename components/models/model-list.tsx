'use client';

import {Collapsible} from '@astryxdesign/core/Collapsible';
import {HStack, VStack, StackItem} from '@astryxdesign/core/Stack';
import {Badge} from '@astryxdesign/core/Badge';
import {CheckboxInput} from '@astryxdesign/core/CheckboxInput';
import {EmptyState} from '@astryxdesign/core/EmptyState';
import {Text} from '@astryxdesign/core/Text';
import type {Model, ModelFile} from '@/lib/models/model-types';
import {shardPath, shardSize} from '@/lib/models/model-types';

// Binary units (÷1024), matching how the rest of the app renders byte sizes.
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(1)} TiB`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

export function formatSpeed(bps: number): string {
  if (bps >= 1024 ** 3) return `${(bps / 1024 ** 3).toFixed(2)} GiB/s`;
  if (bps >= 1024 ** 2) return `${(bps / 1024 ** 2).toFixed(1)} MiB/s`;
  return `${(bps / 1024).toFixed(0)} KiB/s`;
}

export function filePaths(file: ModelFile): string[] {
  if (file.isSplit) {
    const paths = file.files.map(shardPath).filter(Boolean);
    return paths.length ? paths : [file.representativeFilename];
  }
  return [file.path ?? file.filename];
}

interface ModelListProps {
  models: Model[];
  selected?: Set<string>;
  onToggle?: (paths: string[]) => void;
}

export function ModelList({models, selected, onToggle}: ModelListProps) {
  if (models.length === 0) {
    return <EmptyState title="No models found" />;
  }

  function isChecked(file: ModelFile): boolean {
    if (!selected) return false;
    const paths = filePaths(file);
    return paths.length > 0 && paths.every((p) => selected.has(p));
  }

  return (
    <VStack gap={1}>
      {models.map((model) => {
        const hasMissing = model.files.some((f) =>
          f.isSplit ? f.missingIndices.length > 0 : f.missing,
        );
        const allPaths = model.files.flatMap((f) => filePaths(f));
        const allSelected =
          !!selected &&
          allPaths.length > 0 &&
          allPaths.every((p) => selected.has(p));
        const someSelected =
          !!selected && allPaths.some((p) => selected.has(p));
        // The Collapsible trigger is a <button>; a select-all checkbox can't
        // nest inside it, so it sits beside the disclosure as a sibling.
        const collapsible = (
          <Collapsible
            defaultIsOpen={false}
            trigger={
              <HStack gap={2} vAlign="center">
                <Text type="code">{model.name}</Text>
                {hasMissing && (
                  <Badge variant="warning" label="missing files" />
                )}
              </HStack>
            }
          >
            <VStack gap={1}>
              {model.files.map((file) =>
                file.isSplit ? (
                  <HStack
                    key={file.representativeFilename}
                    gap={2}
                    vAlign="start"
                  >
                    {onToggle && (
                      <CheckboxInput
                        label={`Select ${file.quant}`}
                        isLabelHidden
                        value={isChecked(file)}
                        onChange={() => onToggle(filePaths(file))}
                      />
                    )}
                    <StackItem size="fill">
                      <Collapsible
                        defaultIsOpen={false}
                        trigger={
                          <HStack gap={3} vAlign="center">
                            <Text type="label">{file.quant}</Text>
                            <Text type="code" color="secondary">
                              {file.presentShards}/{file.totalShards} files
                            </Text>
                            <Text type="supporting">
                              {formatBytes(file.totalSize)}
                            </Text>
                            {file.missingIndices.length > 0 && (
                              <Badge
                                variant="warning"
                                label={`missing shards: ${file.missingIndices.join(', ')}`}
                              />
                            )}
                            {file.notInColdStorage && (
                              <Badge
                                variant="warning"
                                label="not in cold storage"
                              />
                            )}
                          </HStack>
                        }
                      >
                        <VStack gap={1}>
                          {[...file.files]
                            .sort((a, b) =>
                              shardPath(a).localeCompare(shardPath(b)),
                            )
                            .map((shard, i) => {
                              const p = shardPath(shard);
                              return (
                                <HStack key={p || i} gap={3} vAlign="center">
                                  <Text type="code" color="secondary">
                                    {p.split('/').pop()}
                                  </Text>
                                  <Text type="supporting">
                                    {formatBytes(shardSize(shard))}
                                  </Text>
                                </HStack>
                              );
                            })}
                        </VStack>
                      </Collapsible>
                    </StackItem>
                  </HStack>
                ) : (
                  <HStack key={file.filename} gap={3} vAlign="center">
                    {onToggle && (
                      <CheckboxInput
                        label={`Select ${file.filename}`}
                        isLabelHidden
                        value={isChecked(file)}
                        onChange={() => onToggle(filePaths(file))}
                      />
                    )}
                    <Text type="label">{file.quant}</Text>
                    <Text
                      type="code"
                      color={file.missing ? 'accent' : 'secondary'}
                    >
                      {file.filename}
                    </Text>
                    <Text type="supporting">{formatBytes(file.size)}</Text>
                    {file.missing && (
                      <Badge variant="warning" label="missing" />
                    )}
                    {file.notInColdStorage && (
                      <Badge variant="warning" label="not in cold storage" />
                    )}
                  </HStack>
                ),
              )}
            </VStack>
          </Collapsible>
        );
        return (
          <HStack key={model.name} gap={2} vAlign="start">
            {onToggle && (
              <CheckboxInput
                label={`Select all of ${model.name}`}
                isLabelHidden
                value={
                  allSelected ? true : someSelected ? 'indeterminate' : false
                }
                onChange={() => onToggle(allPaths)}
              />
            )}
            <StackItem size="fill">{collapsible}</StackItem>
          </HStack>
        );
      })}
    </VStack>
  );
}
