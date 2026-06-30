'use client';

import {useState} from 'react';
import {Dialog} from '@astryxdesign/core/Dialog';
import {VStack, HStack} from '@astryxdesign/core/Stack';
import {Heading, Text} from '@astryxdesign/core/Text';
import {Button} from '@astryxdesign/core/Button';
import {List, ListItem} from '@astryxdesign/core/List';
import type {Model} from '@/lib/models';
import {filePaths} from '@/components/models/model-list';

export interface FileInfo {
  model: string;
  quant: string;
  filename: string;
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
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeleteModal({
  files,
  from,
  requireDoubleConfirm,
  onConfirm,
  onCancel,
}: DeleteModalProps) {
  const [step, setStep] = useState<'list' | 'warn'>('list');

  function handleDelete() {
    if (requireDoubleConfirm) setStep('warn');
    else onConfirm();
  }

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
                description={`${f.model} / ${f.quant}`}
              />
            ))}
          </List>
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
          <Text type="supporting">
            These files are not in cold storage and cannot be recovered after
            deletion.
          </Text>
          <HStack gap={2} hAlign="end">
            <Button
              label="Back"
              variant="secondary"
              onClick={() => setStep('list')}
            />
            <Button
              label="Confirm delete"
              variant="destructive"
              onClick={onConfirm}
            />
          </HStack>
        </VStack>
      )}
    </Dialog>
  );
}
