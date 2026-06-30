import {AppShell} from '@astryxdesign/core/AppShell';
import {Section} from '@astryxdesign/core/Section';
import {VStack} from '@astryxdesign/core/Stack';
import {Heading, Text} from '@astryxdesign/core/Text';
import {localModelsDir, coldStorageDir} from '@/lib/config';
import {scanModels} from '@/lib/models';
import {ModelList} from '@/components/models/model-list';
import {PeersSection} from '@/components/peers/peers-section';
import {HfDownloadSection} from '@/components/hf-download/hf-download-section';

// Reads the live filesystem (local + cold storage), so render per-request
// rather than prerendering at build time.
export const dynamic = 'force-dynamic';

export default function Home() {
  const localModels = scanModels(localModelsDir);
  const coldModels = scanModels(coldStorageDir);

  return (
    <AppShell contentPadding={6} height="auto">
      <VStack gap={6}>
        <Heading level={1}>Turbo Jumbo</Heading>

        <PeersSection />

        <Section>
          <VStack gap={3}>
            <Heading level={2}>Local models</Heading>
            <Text type="supporting">
              {localModelsDir ?? 'No local peer matches this machine'}
            </Text>
            <ModelList models={localModels} />
          </VStack>
        </Section>

        {localModelsDir && (
          <HfDownloadSection localModelsPath={localModelsDir} />
        )}

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
