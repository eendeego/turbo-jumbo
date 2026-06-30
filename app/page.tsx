import {AppShell} from '@astryxdesign/core/AppShell';
import {Section} from '@astryxdesign/core/Section';
import {VStack} from '@astryxdesign/core/Stack';
import {Heading} from '@astryxdesign/core/Text';
import {localModelsDir, coldStorageDir} from '@/lib/config';
import {scanModels} from '@/lib/models';
import {ColdStorageSection} from '@/components/models/cold-storage-section';
import {PeersSection} from '@/components/peers/peers-section';
import {HfDownloadSection} from '@/components/hf-download/hf-download-section';

// Reads the live filesystem (local + cold storage), so render per-request
// rather than prerendering at build time.
export const dynamic = 'force-dynamic';

export default function Home() {
  const coldModels = scanModels(coldStorageDir);

  return (
    <AppShell contentPadding={6} height="auto">
      <VStack gap={6}>
        <Heading level={1}>Turbo Jumbo</Heading>

        {/* The local machine appears here as a peer marked "— local". */}
        <PeersSection coldModels={coldModels} />

        {localModelsDir && (
          <HfDownloadSection localModelsPath={localModelsDir} />
        )}

        <Section>
          <VStack gap={3}>
            <Heading level={2}>Models in cold storage</Heading>
            <ColdStorageSection initialModels={coldModels} />
          </VStack>
        </Section>
      </VStack>
    </AppShell>
  );
}
