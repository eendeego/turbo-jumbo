'use client';

import {Collapsible} from '@astryxdesign/core/Collapsible';
import {HStack, VStack} from '@astryxdesign/core/Stack';
import {Badge} from '@astryxdesign/core/Badge';
import {EmptyState} from '@astryxdesign/core/EmptyState';
import {Text} from '@astryxdesign/core/Text';
import type {Model} from '@/lib/models';

export function formatBytes(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(1)} KB`;
}

export function ModelList({models}: {models: Model[]}) {
  if (models.length === 0) {
    return <EmptyState title="No models found" />;
  }
  return (
    <VStack gap={1}>
      {models.map((model) => {
        const hasMissing = model.files.some((f) =>
          f.isSplit ? f.missingIndices.length > 0 : f.missing,
        );
        return (
          <Collapsible
            key={model.name}
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
                    gap={3}
                    vAlign="center"
                  >
                    <Text type="label">{file.quant}</Text>
                    <Text type="code" color="secondary">
                      {file.presentShards}/{file.totalShards} files
                    </Text>
                    <Text type="supporting">{formatBytes(file.totalSize)}</Text>
                    {file.missingIndices.length > 0 && (
                      <Badge
                        variant="warning"
                        label={`missing shards: ${file.missingIndices.join(', ')}`}
                      />
                    )}
                  </HStack>
                ) : (
                  <HStack key={file.filename} gap={3} vAlign="center">
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
                  </HStack>
                ),
              )}
            </VStack>
          </Collapsible>
        );
      })}
    </VStack>
  );
}
