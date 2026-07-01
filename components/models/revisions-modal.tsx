'use client';

import {Dialog} from '@astryxdesign/core/Dialog';
import {VStack, HStack} from '@astryxdesign/core/Stack';
import {Heading, Text} from '@astryxdesign/core/Text';
import {Button} from '@astryxdesign/core/Button';
import {Link} from '@astryxdesign/core/Link';
import type {AuditResult, RevisionCheck} from '@/lib/audit';
import {formatSize} from '@/components/models/models-table-client';

const RESULT_LABEL: Record<RevisionCheck['result'], string> = {
  'size-mismatch': 'Size differs',
  'sha256-mismatch': 'SHA256 differs',
  match: 'Match',
};

interface RevisionsModalProps {
  file: AuditResult; // an audit failure carrying `revisionsChecked`
  onClose: () => void;
}

/** The revisions a failed audit compared the local file against — the latest
 *  first, then each distinct earlier version found in the repo's history —
 *  and why each one was ruled out. */
export function RevisionsModal({file, onClose}: RevisionsModalProps) {
  const name = file.file.split('/').pop() ?? file.file;
  const revisions = file.revisionsChecked ?? [];

  return (
    <Dialog isOpen onOpenChange={onClose} purpose="info">
      <VStack gap={4}>
        <Heading level={3}>Checked revisions</Heading>
        <Text type="supporting">
          <Text type="code">{name}</Text> matches none of the file&apos;s known
          revisions
          {file.hf ? (
            <>
              {' '}
              in{' '}
              <Link href={file.hf.modelUrl} isExternalLink>
                {file.hf.repoId}
              </Link>
            </>
          ) : null}
          . Each one was compared against the local file:
        </Text>
        <VStack gap={1}>
          <Text type="body">Local file</Text>
          <Text type="supporting">
            size{' '}
            {file.computedSize != null
              ? `${formatSize(file.computedSize)} (${file.computedSize} bytes)`
              : 'unknown'}
            , sha256{' '}
            {file.computedSha256 ? (
              <Text type="code">{file.computedSha256}</Text>
            ) : (
              'unavailable'
            )}
          </Text>
        </VStack>
        {revisions.map((rev, i) => (
          <VStack key={rev.commit || i} gap={1}>
            <Text type="body">
              {rev.commit ? (
                <Link href={rev.commitUrl} isExternalLink>
                  {rev.commit.slice(0, 12)}
                </Link>
              ) : (
                'unknown revision'
              )}
              {i === 0 ? ' (latest)' : ''}
              {rev.commitDate ? ` — ${rev.commitDate.slice(0, 10)}` : ''}
            </Text>
            <Text type="supporting">
              {RESULT_LABEL[rev.result]} — size {formatSize(rev.size)} (
              {rev.size} bytes), sha256 <Text type="code">{rev.sha256}</Text>
            </Text>
          </VStack>
        ))}
        <HStack gap={2} hAlign="end">
          <Button label="Close" variant="secondary" onClick={onClose} />
        </HStack>
      </VStack>
    </Dialog>
  );
}
