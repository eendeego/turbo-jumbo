import {AppShell} from '@astryxdesign/core/AppShell';
import {Section} from '@astryxdesign/core/Section';
import {HStack, VStack} from '@astryxdesign/core/Stack';
import {Collapsible} from '@astryxdesign/core/Collapsible';
import {List, ListItem} from '@astryxdesign/core/List';
import {Badge} from '@astryxdesign/core/Badge';
import {EmptyState} from '@astryxdesign/core/EmptyState';
import {Heading, Text} from '@astryxdesign/core/Text';
import {config, localModelsDir, coldStorageDir} from '@/lib/config';
import {scanModels, type Model} from '@/lib/models';

// Reads the live filesystem (cold storage), so render per-request rather than
// prerendering at build time.
export const dynamic = 'force-dynamic';

function formatBytes(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(1)} KB`;
}

function ModelList({models}: {models: Model[]}) {
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

export default function Home() {
  const localModels = scanModels(localModelsDir);
  const coldModels = scanModels(coldStorageDir);

  return (
    <AppShell contentPadding={6} height="auto">
      <VStack gap={6}>
        <Heading level={1}>Turbo Jumbo</Heading>

        <Section>
          <VStack gap={3}>
            <Heading level={2}>Peers</Heading>
            {config.peers.length === 0 ? (
              <EmptyState
                title="No peers configured"
                description="Add peers to config.yaml."
              />
            ) : (
              <List hasDividers>
                {config.peers.map((peer) => (
                  <ListItem
                    key={peer.name}
                    label={peer.name}
                    description={peer.address}
                  />
                ))}
              </List>
            )}
          </VStack>
        </Section>

        <Section>
          <VStack gap={3}>
            <Heading level={2}>Local models</Heading>
            <Text type="supporting">
              {localModelsDir ?? 'No local peer matches this machine'}
            </Text>
            <ModelList models={localModels} />
          </VStack>
        </Section>

        <Section>
          <VStack gap={3}>
            <Heading level={2}>Models in cold storage</Heading>
            <Text type="supporting">
              {coldStorageDir ?? 'No local peer matches this machine'}
            </Text>
            <ModelList models={coldModels} />
          </VStack>
        </Section>
      </VStack>
    </AppShell>
  );
}
