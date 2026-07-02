'use client';

import {useState} from 'react';
import {Dialog} from '@astryxdesign/core/Dialog';
import {VStack, HStack} from '@astryxdesign/core/Stack';
import {Heading, Text} from '@astryxdesign/core/Text';
import {Button} from '@astryxdesign/core/Button';
import {List, ListItem} from '@astryxdesign/core/List';
import {CheckboxInput} from '@astryxdesign/core/CheckboxInput';
import type {Model} from '@/lib/models/model-types';
import {modelDisplayName} from '@/lib/models/model-name';
import {filePaths} from '@/components/models/model-list';

export interface FileInfo {
  model: string;
  quant: string;
  filename: string;
  size?: number; // source size, for size-aware "already present" checks
}

export function selectedFileInfo(
  models: Model[],
  selected: Set<string>,
): FileInfo[] {
  const result: FileInfo[] = [];
  for (const model of models) {
    for (const file of model.files) {
      const paths = filePaths(file);
      if (paths.length > 0 && paths.some((p) => selected.has(p))) {
        result.push({
          model: model.name,
          quant: file.quant,
          filename: file.isSplit ? file.representativeFilename : file.filename,
        });
      }
    }
  }
  return result;
}

export function anyMissingFromColdStorage(
  files: FileInfo[],
  coldModels: Model[],
): boolean {
  const coldFilenames = new Set<string>();
  for (const model of coldModels) {
    for (const file of model.files) {
      coldFilenames.add(
        file.isSplit ? file.representativeFilename : file.filename,
      );
    }
  }
  return files.some((f) => !coldFilenames.has(f.filename));
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
            {files.map((f, i) => (
              <ListItem
                key={i}
                label={f.filename}
                description={`${modelDisplayName(f.model)} / ${f.quant}`}
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
