'use client';

import {useState} from 'react';
import {Dialog} from '@astryxdesign/core/Dialog';
import {VStack, HStack} from '@astryxdesign/core/Stack';
import {Heading, Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {Button} from '@astryxdesign/core/Button';
import {ProgressBar} from '@astryxdesign/core/ProgressBar';
import type {AuditProgressEvent} from '@/lib/audit/audit';
import {formatBytes} from '@/components/models/model-list';

interface SetSourceModalProps {
  filename: string;
  busy: boolean;
  error: string | null;
  /** SHA256 progress of the running verification, when one is in flight. */
  progress?: AuditProgressEvent | null;
  onSubmit: (url: string) => void;
  onCancel: () => void;
}

export function SetSourceModal({
  filename,
  busy,
  error,
  progress,
  onSubmit,
  onCancel,
}: SetSourceModalProps) {
  const [url, setUrl] = useState('');
  const trimmed = url.trim();

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
      purpose="form"
    >
      <VStack gap={4}>
        <Heading level={3}>Set HuggingFace source…</Heading>
        <Text type="supporting">
          Paste the HuggingFace file URL for <Text type="code">{filename}</Text>
          . Its repo, revision, size and checksum are read from the URL and
          recorded, then the local file is verified against them.
        </Text>
        <TextInput
          label="HuggingFace file URL"
          value={url}
          onChange={setUrl}
          isDisabled={busy}
          placeholder="https://huggingface.co/org/repo/blob/main/path/file.gguf"
          status={error ? {type: 'error', message: error} : undefined}
        />
        {busy && progress && (
          <ProgressBar
            label="Verifying (SHA256)"
            value={progress.hashedBytes}
            max={Math.max(progress.totalBytes, 1)}
            hasValueLabel
            formatValueLabel={(v, m) =>
              `${formatBytes(v)} of ${formatBytes(m)}`
            }
          />
        )}
        <HStack gap={2} hAlign="end">
          <Button
            label="Cancel"
            variant="secondary"
            onClick={onCancel}
            isDisabled={busy}
          />
          <Button
            label={busy ? 'Verifying…' : 'Verify & save'}
            variant="primary"
            onClick={() => onSubmit(trimmed)}
            isDisabled={trimmed.length === 0 || busy}
          />
        </HStack>
      </VStack>
    </Dialog>
  );
}
