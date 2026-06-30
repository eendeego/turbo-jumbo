'use client';

import {Collapsible} from '@astryxdesign/core/Collapsible';
import {HStack, VStack} from '@astryxdesign/core/Stack';
import {Badge} from '@astryxdesign/core/Badge';
import {CheckboxInput} from '@astryxdesign/core/CheckboxInput';
import {EmptyState} from '@astryxdesign/core/EmptyState';
import {Text} from '@astryxdesign/core/Text';
import type {Model, ModelFile} from '@/lib/models';

export function formatBytes(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(1)} KB`;
}

export function filePaths(file: ModelFile): string[] {
  if (file.isSplit) {
    const files = file.files as string[] | undefined;
    return files?.length ? files : [file.representativeFilename];
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
                    {onToggle && (
                      <CheckboxInput
                        label={`Select ${file.quant}`}
                        isLabelHidden
                        value={isChecked(file)}
                        onChange={() => onToggle(filePaths(file))}
                      />
                    )}
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
