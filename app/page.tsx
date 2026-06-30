import fs from 'fs';
import {AppShell} from '@astryxdesign/core/AppShell';
import {Section} from '@astryxdesign/core/Section';
import {VStack} from '@astryxdesign/core/Stack';
import {List, ListItem} from '@astryxdesign/core/List';
import {EmptyState} from '@astryxdesign/core/EmptyState';
import {Heading, Text} from '@astryxdesign/core/Text';
import {config, localPeer} from '@/lib/config';

// Reads the live filesystem (cold storage), so render per-request rather than
// prerendering at build time.
export const dynamic = 'force-dynamic';

function readColdStorage(storagePath: string | undefined): string[] {
  if (!storagePath) return [];
  try {
    return fs.readdirSync(storagePath);
  } catch {
    return [];
  }
}

export default function Home() {
  const models = readColdStorage(localPeer?.cold_storage_path);

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
            {models.length === 0 ? (
              <EmptyState
                title="No models found"
                description="Nothing in this peer's cold storage yet."
              />
            ) : (
              <List hasDividers>
                {models.map((model) => (
                  <ListItem key={model} label={model} />
                ))}
              </List>
            )}
          </VStack>
        </Section>
      </VStack>
    </AppShell>
  );
}
