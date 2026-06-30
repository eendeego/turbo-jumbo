import type {Metadata} from 'next';
import {AppShell} from '@astryxdesign/core/AppShell';
import {Section} from '@astryxdesign/core/Section';
import {VStack, HStack, StackItem} from '@astryxdesign/core/Stack';
import {Heading} from '@astryxdesign/core/Text';
import {config, localModelsDir, coldStorageDir, localPeer} from '@/lib/config';
import {scanModels} from '@/lib/models';
import {ColdStorage} from '@/components/models/cold-storage';
import {Peers} from '@/components/peers/peers';
import {HuggingFaceDownload} from '@/components/hf-download/hugging-face-download';
import {Log} from '@/components/log/log';
import {ThemeToggle} from '@/components/theme/theme-toggle';

export function generateMetadata(): Metadata {
  return {title: `Turbo Jumbo - ${localPeer?.name ?? 'unknown'}`};
}

// Reads the live filesystem (local + cold storage), so render per-request
// rather than prerendering at build time.
export const dynamic = 'force-dynamic';

export default function Home() {
  const coldModels = scanModels(coldStorageDir);

  return (
    <AppShell contentPadding={6} height="auto">
      <VStack gap={6}>
        <HStack vAlign="center">
          <StackItem size="fill">
            <Heading level={1}>Turbo Jumbo</Heading>
          </StackItem>
          <ThemeToggle />
        </HStack>

        {/* The local machine appears here as a peer marked "— local". */}
        <Peers coldModels={coldModels} />

        {localModelsDir && (
          <HuggingFaceDownload localModelsPath={localModelsDir} />
        )}

        <Section>
          <VStack gap={3}>
            <Heading level={2}>Models in cold storage</Heading>
            <ColdStorage initialModels={coldModels} />
          </VStack>
        </Section>

        <Log logLevel={config.log_level ?? 'info'} />
      </VStack>
    </AppShell>
  );
}
