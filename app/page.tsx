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

interface ModelFile {
  filename: string;
  quant: string;
  missing: boolean;
}

interface Model {
  name: string;
  files: ModelFile[];
}

function scanModels(storagePath: string | undefined): Model[] {
  if (!storagePath) return [];
  const modelMap = new Map<string, ModelFile[]>();

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
      } else if (/\.(gguf|safetensors|bin)$/i.test(entry.name)) {
        const fullPath = path.join(dir, entry.name);
        let missing = false;
        try {
          fs.statSync(fullPath);
        } catch {
          missing = true;
        }
        const name = extractModelName(entry.name);
        const file: ModelFile = {
          filename: entry.name,
          quant: extractQuant(entry.name),
          missing,
        };
        const existing = modelMap.get(name);
        if (existing) existing.push(file);
        else modelMap.set(name, [file]);
      }
    }
  }

  walk(storagePath);

  return Array.from(modelMap.entries())
    .map(([name, files]) => ({
      name,
      files: files.sort((a, b) => a.quant.localeCompare(b.quant)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function ModelList({models}: {models: Model[]}) {
  if (models.length === 0) {
    return (
      <EmptyState
        title="No models found"
        description="Nothing in this peer's cold storage yet."
      />
    );
  }
  return (
    <VStack gap={1}>
      {models.map((model) => {
        const hasMissing = model.files.some((f) => f.missing);
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
              {model.files.map((file) => (
                <HStack key={file.filename} gap={3} vAlign="center">
                  <Text type="label">{file.quant}</Text>
                  <Text
                    type="code"
                    color={file.missing ? 'accent' : 'secondary'}
                  >
                    {file.filename}
                  </Text>
                  {file.missing && <Badge variant="warning" label="missing" />}
                </HStack>
              ))}
            </VStack>
          </Collapsible>
        );
      })}
    </VStack>
  );
}

export default function Home() {
  const models = scanModels(localPeer?.cold_storage_path);

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
            <Heading level={2}>Models in cold storage</Heading>
            <Text type="supporting">
              {localPeer?.cold_storage_path ??
                'No local peer matches this machine'}
            </Text>
            <ModelList models={models} />
          </VStack>
        </Section>
      </VStack>
    </AppShell>
  );
}
