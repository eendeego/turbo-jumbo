'use client';

import {VStack, HStack} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import {Button} from '@astryxdesign/core/Button';
import {Banner} from '@astryxdesign/core/Banner';
import {ProgressBar} from '@astryxdesign/core/ProgressBar';
import {formatSize} from '@/lib/format/bytes';
import type {FlmModel} from '@/lib/lemonade/flm';
import type {FlmProgress} from '@/components/lemonade/use-flm-download';

/**
 * Progress view for a Lemonade-server (FLM) download, shown in place of the
 * catalog while the pull runs. The download happens on the target peer's
 * Lemonade server; this just renders its relayed progress events.
 */
export function FlmDownloadView({
  model,
  peerName,
  progress,
  error,
  running,
  onClose,
}: {
  model: FlmModel;
  peerName: string | null;
  progress: FlmProgress | null;
  error: string | null;
  running: boolean;
  onClose: () => void;
}) {
  const done = !running && !error;
  return (
    <VStack gap={4}>
      <Text type="body">
        {running
          ? `Downloading ${model.name} on ${peerName ?? 'the target peer'}'s Lemonade server…`
          : done
            ? `${model.name} downloaded.`
            : `Downloading ${model.name} failed.`}
      </Text>
      {error && <Banner status="error" title={error} />}
      {!error && !progress && running && (
        <ProgressBar label="Waiting for the Lemonade server…" isIndeterminate />
      )}
      {!error && progress && (
        <ProgressBar
          label={progress.file || 'Download'}
          value={progress.bytesDownloaded}
          max={Math.max(progress.bytesTotal, 1)}
          hasValueLabel
          formatValueLabel={() => {
            const parts = [
              `${formatSize(progress.bytesDownloaded)} / ${formatSize(progress.bytesTotal)}`,
            ];
            if (progress.totalFiles > 1)
              parts.push(
                `file ${progress.fileIndex + 1}/${progress.totalFiles}`,
              );
            return parts.join('  ·  ');
          }}
        />
      )}
      <HStack gap={2} hAlign="end">
        <Button
          label={running ? 'Cancel' : 'Close'}
          variant={running ? 'destructive' : 'primary'}
          size="sm"
          onClick={onClose}
        />
      </HStack>
    </VStack>
  );
}
