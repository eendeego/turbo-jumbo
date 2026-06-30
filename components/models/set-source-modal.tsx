'use client';

import {useState} from 'react';
import {Dialog} from '@astryxdesign/core/Dialog';
import {VStack, HStack} from '@astryxdesign/core/Stack';
import {Heading, Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {Button} from '@astryxdesign/core/Button';

interface SetSourceModalProps {
  filename: string;
  busy: boolean;
  error: string | null;
  onSubmit: (url: string) => void;
  onCancel: () => void;
}

export function SetSourceModal({
  filename,
  busy,
  error,
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
