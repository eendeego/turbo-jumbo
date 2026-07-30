'use client';

import {VStack, HStack} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import {Button} from '@astryxdesign/core/Button';
import {Banner} from '@astryxdesign/core/Banner';
import {ProgressBar} from '@astryxdesign/core/ProgressBar';
import {formatSize} from '@/lib/format/bytes';
import type {FlmModel} from '@/lib/lemonade/flm';
import type {FlmProgress} from '@/components/lemonade/use-flm-download';

// The per-file position, from Lemonade's 1-based "Downloading X/Y" frames.
// The complete frame reports X = Y, so clamp rather than trusting X blindly.
function fileLabel(p: FlmProgress): string | null {
  if (p.totalFiles <= 0) return null;
  const index = Math.min(Math.max(p.fileIndex, 1), p.totalFiles);
  return `file ${index}/${p.totalFiles}`;
}

/**
 * Progress view for a Lemonade-server (FLM) download, shown in place of the
 * catalog while the pull runs. The download happens on the target peer's
 * Lemonade server; this just renders its relayed progress events. Byte totals
 * are only known while flm prints per-file byte lines — file-boundary frames
 * carry none — so the bar falls back to the stream's own percent.
 */
export function FlmDownloadView({
  model,
  peerName,
  progress,
  error,
  running,
  confirmed,
  onClose,
}: {
  model: FlmModel;
  peerName: string | null;
  progress: FlmProgress | null;
  error: string | null;
  running: boolean;
  // Whether the server lists the model as downloaded after the pull; null
  // while running or when the post-pull check couldn't be made.
  confirmed: boolean | null;
  onClose: () => void;
}) {
  const done = !running && !error;
  return (
    <VStack gap={4}>
      <Text type="body">
        {running
          ? `Downloading ${model.name} on ${peerName ?? 'the target peer'}'s Lemonade server…`
          : done
            ? confirmed === false
              ? `The pull for ${model.name} finished, but the server still lists it as not downloaded.`
              : `${model.name} downloaded.`
            : `Downloading ${model.name} failed.`}
      </Text>
      {error && <Banner status="error" title={error} />}
      {done && confirmed === false && (
        <Banner
          status="warning"
          title="The Lemonade server reported success without registering the model — its flm backend may be unhealthy (for example, NPU memlock limits too low). Check that server before relying on the download."
        />
      )}
      {!error && !progress && running && (
        <ProgressBar label="Waiting for the Lemonade server…" isIndeterminate />
      )}
      {!error &&
        progress &&
        (progress.bytesTotal > 0 ? (
          <ProgressBar
            label={progress.file || 'Download'}
            value={progress.bytesDownloaded}
            max={progress.bytesTotal}
            hasValueLabel
            formatValueLabel={() => {
              const parts = [
                `${formatSize(progress.bytesDownloaded)} / ${formatSize(progress.bytesTotal)}`,
              ];
              const file = fileLabel(progress);
              if (file) parts.push(file);
              return parts.join('  ·  ');
            }}
          />
        ) : (
          <ProgressBar
            label={progress.file || 'Download'}
            value={Math.min(Math.max(progress.percent, 0), 100)}
            max={100}
            hasValueLabel
            formatValueLabel={() =>
              fileLabel(progress) ?? `${progress.percent}%`
            }
          />
        ))}
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
