'use client';

import {useState} from 'react';
import {Dialog} from '@astryxdesign/core/Dialog';
import {VStack, HStack} from '@astryxdesign/core/Stack';
import {Heading, Text} from '@astryxdesign/core/Text';
import {Button} from '@astryxdesign/core/Button';
import {List, ListItem} from '@astryxdesign/core/List';
import {CheckboxInput} from '@astryxdesign/core/CheckboxInput';
import {shardPath, type Model} from '@/lib/models/model-types';
import {groupSelectedFiles} from '@/lib/models/selected-file-groups';
import {fileBasename, fileJoinKey, peerFileKeys} from '@/lib/peers/peer-paths';
import {filePaths} from '@/components/models/model-list';

export interface FileInfo {
  model: string;
  quant: string;
  filename: string;
  size?: number; // source size, for size-aware "already present" checks
}

/**
 * The selected files, one entry per file. A split quant contributes one entry
 * per selected shard — not a single entry under its representative filename:
 * the representative is whichever shard the scan saw first, so a one-entry
 * split let a destination holding just that shard pass as holding the whole
 * model, and hid the other shards from every presence check.
 */
export function selectedFileInfo(
  models: Model[],
  selected: Set<string>,
): FileInfo[] {
  const result: FileInfo[] = [];
  for (const model of models) {
    for (const file of model.files) {
      const matched = filePaths(file).filter((p) => selected.has(p));
      if (matched.length === 0) continue;
      if (!file.isSplit) {
        result.push({
          model: model.name,
          quant: file.quant,
          filename: file.filename,
          size: file.size,
        });
        continue;
      }
      const sizeByPath = new Map(file.files.map((s) => [shardPath(s), s.size]));
      for (const p of matched) {
        const size = sizeByPath.get(p);
        result.push({
          model: model.name,
          quant: file.quant,
          filename: fileBasename(p),
          ...(size != null ? {size} : {}),
        });
      }
    }
  }
  return result;
}

/**
 * Whether any selected file has no cold-storage copy. Joins on `fileJoinKey`
 * (the same identity the copy destinations use), so a split is compared shard
 * by shard: matching the two sides' *representative* filenames instead reported
 * a fully-backed split as missing, because each host derives its representative
 * from its own directory order.
 */
export function anyMissingFromColdStorage(
  files: FileInfo[],
  coldModels: Model[],
): boolean {
  const coldKeys = peerFileKeys(coldModels);
  return files.some((f) => !coldKeys.has(fileJoinKey(f.model, f.filename)));
}

interface DeleteModalProps {
  files: FileInfo[];
  from?: string;
  requireDoubleConfirm: boolean;
  // When set, offer a "Keep in cold storage" checkbox that spares the cold
  // copy from a delete that would otherwise also remove it. Only meaningful for
  // a scope that deletes from cold storage alongside other locations.
  showKeepCold?: boolean;
  onConfirm: (dryRun: boolean, keepCold: boolean) => void;
  onCancel: () => void;
}

export function DeleteModal({
  files,
  from,
  requireDoubleConfirm,
  showKeepCold = false,
  onConfirm,
  onCancel,
}: DeleteModalProps) {
  const [step, setStep] = useState<'list' | 'warn'>('list');
  // Dev-only escape hatch: the delete endpoints log what they would remove
  // instead of removing it. Owned by the modal so it resets on every open.
  const [dryRun, setDryRun] = useState(false);
  // Spare the cold-storage copy from the delete. Off by default so the action
  // stays a full delete unless the user opts to keep the cold backup.
  const [keepCold, setKeepCold] = useState(false);
  const isDev = process.env.NODE_ENV === 'development';

  function handleDelete() {
    if (requireDoubleConfirm) setStep('warn');
    else onConfirm(dryRun, keepCold);
  }

  // The warn-step wording, narrowed when the cold copy is being spared.
  const warnMessage =
    from === 'all locations'
      ? keepCold
        ? 'This will delete these files from local storage and every other machine, but keep the cold-storage copy. This cannot be undone.'
        : 'This will delete these files from all locations, including cold storage. This cannot be undone.'
      : from === 'cold storage'
        ? 'These files will be permanently deleted from cold storage and cannot be recovered.'
        : 'Some of these files are not backed up in cold storage and cannot be recovered after deletion.';

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      purpose="required"
    >
      {step === 'list' ? (
        <VStack gap={4}>
          <Heading level={3}>
            Delete {files.length} {files.length === 1 ? 'file' : 'files'}
            {from ? ` from ${from}` : ''}?
          </Heading>
          <List hasDividers>
            {groupSelectedFiles(files).map((entry, i) => (
              <ListItem
                key={i}
                label={entry.label}
                description={entry.description}
              />
            ))}
          </List>
          {showKeepCold && (
            <CheckboxInput
              label="Keep in cold storage"
              value={keepCold}
              onChange={setKeepCold}
              size="sm"
            />
          )}
          {isDev && (
            <CheckboxInput
              label="Dry run (log only, no actual deletion)"
              value={dryRun}
              onChange={setDryRun}
              size="sm"
            />
          )}
          <HStack gap={2} hAlign="end">
            <Button label="Cancel" variant="secondary" onClick={onCancel} />
            <Button
              label="Delete"
              variant="destructive"
              onClick={handleDelete}
            />
          </HStack>
        </VStack>
      ) : (
        <VStack gap={4}>
          <Heading level={3}>Are you sure?</Heading>
          <Text type="supporting">{warnMessage}</Text>
          <HStack gap={2} hAlign="end">
            <Button
              label="Back"
              variant="secondary"
              onClick={() => setStep('list')}
            />
            <Button
              label="Confirm delete"
              variant="destructive"
              onClick={() => onConfirm(dryRun, keepCold)}
            />
          </HStack>
        </VStack>
      )}
    </Dialog>
  );
}
