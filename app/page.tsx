import fs from 'fs';
import path from 'path';
import {AppShell} from '@astryxdesign/core/AppShell';
import {Section} from '@astryxdesign/core/Section';
import {HStack, VStack} from '@astryxdesign/core/Stack';
import {Collapsible} from '@astryxdesign/core/Collapsible';
import {List, ListItem} from '@astryxdesign/core/List';
import {Badge} from '@astryxdesign/core/Badge';
import {EmptyState} from '@astryxdesign/core/EmptyState';
import {Heading, Text} from '@astryxdesign/core/Text';
import {config, localPeer} from '@/lib/config';

// Reads the live filesystem (cold storage), so render per-request rather than
// prerendering at build time.
export const dynamic = 'force-dynamic';

const QUANT_RE =
  /[-_.](?:IQ\d+_(?:XXS|XS|NL|[SML])|Q\d+(?:_K(?:_[SML])?|_[01])?|BF16|F16|F32)$/i;
const SPLIT_RE = /^(.+)-(\d+)-of-(\d+)\.gguf$/i;

function extractModelName(filename: string): string {
  return filename
    .replace(/\.(gguf|safetensors|bin)$/i, '')
    .replace(QUANT_RE, '');
}

function extractQuant(filename: string): string {
  const base = filename.replace(/\.(gguf|safetensors|bin)$/i, '');
  const m = base.match(
    /[-_.]((IQ\d+_(?:XXS|XS|NL|[SML])|Q\d+(?:_K(?:_[SML])?|_[01])?|BF16|F16|F32))$/i,
  );
  return m ? m[1].toUpperCase() : 'unknown';
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(1)} KB`;
}

interface SingleFile {
  isSplit: false;
  filename: string;
  quant: string;
  size: number;
  missing: boolean;
}

interface SplitGroup {
  isSplit: true;
  representativeFilename: string;
  quant: string;
  totalShards: number;
  presentShards: number;
  missingIndices: number[];
  totalSize: number;
}

type ModelFile = SingleFile | SplitGroup;

interface Model {
  name: string;
  files: ModelFile[];
}

function scanModels(storagePath: string | undefined): Model[] {
  if (!storagePath) return [];
  const singleMap = new Map<string, SingleFile[]>();

  interface SplitAccum {
    modelName: string;
    quant: string;
    totalShards: number;
    presentIndices: Set<number>;
    totalSize: number;
    representativeFilename: string;
  }
  const splitMap = new Map<string, SplitAccum>();

  function walk(dir: string) {
    let entries;
    try {
      entries = fs.readdirSync(dir, {withFileTypes: true});
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name));
        continue;
      }

      const fullPath = path.join(dir, entry.name);
      const splitMatch = entry.name.match(SPLIT_RE);

      if (splitMatch) {
        // Split GGUF: <model>-<quant>-<index>-of-<count>.gguf
        const base = splitMatch[1]; // everything before -NNNNN-of-MMMMM
        const index = parseInt(splitMatch[2], 10);
        const total = parseInt(splitMatch[3], 10);
        const modelName = extractModelName(`${base}.gguf`);
        const quant = extractQuant(`${base}.gguf`);
        const key = `${modelName}::${base}`;

        let size = 0;
        try {
          size = fs.statSync(fullPath).size;
        } catch {
          /* inaccessible shard: don't count size */
        }

        if (!splitMap.has(key)) {
          splitMap.set(key, {
            modelName,
            quant,
            totalShards: total,
            presentIndices: new Set(),
            totalSize: 0,
            representativeFilename: entry.name,
          });
        }
        const accum = splitMap.get(key)!;
        accum.presentIndices.add(index);
        accum.totalSize += size;
      } else if (/\.(gguf|safetensors|bin)$/i.test(entry.name)) {
        let size = 0;
        let missing = false;
        try {
          size = fs.statSync(fullPath).size;
        } catch {
          missing = true;
        }
        const modelName = extractModelName(entry.name);
        const file: SingleFile = {
          isSplit: false,
          filename: entry.name,
          quant: extractQuant(entry.name),
          size,
          missing,
        };
        const existing = singleMap.get(modelName);
        if (existing) existing.push(file);
        else singleMap.set(modelName, [file]);
      }
    }
  }

  walk(storagePath);

  const modelMap = new Map<string, ModelFile[]>();

  for (const [modelName, files] of singleMap) {
    modelMap.set(modelName, [...files]);
  }

  for (const accum of splitMap.values()) {
    const missingIndices: number[] = [];
    for (let i = 1; i <= accum.totalShards; i++) {
      if (!accum.presentIndices.has(i)) missingIndices.push(i);
    }
    const splitGroup: SplitGroup = {
      isSplit: true,
      representativeFilename: accum.representativeFilename,
      quant: accum.quant,
      totalShards: accum.totalShards,
      presentShards: accum.presentIndices.size,
      missingIndices,
      totalSize: accum.totalSize,
    };
    const existing = modelMap.get(accum.modelName);
    if (existing) existing.push(splitGroup);
    else modelMap.set(accum.modelName, [splitGroup]);
  }

  return Array.from(modelMap.entries())
    .map(([name, files]) => ({
      name,
      files: files.sort((a, b) => a.quant.localeCompare(b.quant)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
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

// Local models live under <base_path>/turbo-jumbo for the local peer.
function localModelsPath(): string | undefined {
  return localPeer?.base_path
    ? path.join(localPeer.base_path, 'turbo-jumbo')
    : undefined;
}

export default function Home() {
  const localPath = localModelsPath();
  const localModels = scanModels(localPath);
  const coldModels = scanModels(localPeer?.cold_storage_path);

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
              {localPath ?? 'No local peer matches this machine'}
            </Text>
            <ModelList models={localModels} />
          </VStack>
        </Section>

        <Section>
          <VStack gap={3}>
            <Heading level={2}>Models in cold storage</Heading>
            <Text type="supporting">
              {localPeer?.cold_storage_path ??
                'No local peer matches this machine'}
            </Text>
            <ModelList models={coldModels} />
          </VStack>
        </Section>
      </VStack>
    </AppShell>
  );
}
