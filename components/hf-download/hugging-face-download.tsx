'use client';

import {useEffect, useMemo, useState} from 'react';
import * as stylex from '@stylexjs/stylex';
import {Section} from '@astryxdesign/core/Section';
import {VStack, HStack, StackItem} from '@astryxdesign/core/Stack';
import {Heading, Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {Button} from '@astryxdesign/core/Button';
import {CheckboxInput} from '@astryxdesign/core/CheckboxInput';
import {List, ListItem} from '@astryxdesign/core/List';
import {Dialog} from '@astryxdesign/core/Dialog';
import {
  DownloadModal,
  buildHfCommand,
  copyToClipboard,
  useDownloadRunner,
} from '@/components/hf-download/download-runner';
import {LemonadeBrowser} from '@/components/lemonade/lemonade-browser';
import type {InventoryLocation} from '@/lib/lemonade';
import {defaultDownloadSelection} from '@/lib/hf-download';

type ParsedUrl = {
  repoId: string;
  branch: string;
  folder: string | null;
  filename: string | null;
};
type HfFile = {path: string; size: number};

function parseHfUrl(url: string): ParsedUrl | null {
  const s = url.trim().replace(/\/+$/, ''); // strip trailing slashes

  // Full file URL: https://huggingface.co/owner/repo/blob/branch/path/to/file.gguf
  const fileMatch = s.match(
    /^https?:\/\/huggingface\.co\/([^/]+\/[^/]+)\/(blob|resolve)\/([^/]+)\/(.+)$/,
  );
  if (fileMatch) {
    const repoId = fileMatch[1];
    const branch = fileMatch[3];
    const filePath = fileMatch[4];
    const slashIdx = filePath.indexOf('/');
    const folder = slashIdx !== -1 ? filePath.slice(0, slashIdx) : null;
    const filename = filePath.split('/').pop()!;
    return {repoId, branch, folder, filename};
  }

  // Repo URL with explicit branch: https://huggingface.co/owner/repo/blob/branch (no file)
  const blobRootMatch = s.match(
    /^https?:\/\/huggingface\.co\/([^/]+\/[^/]+)\/(?:blob|tree)\/([^/]+)$/,
  );
  if (blobRootMatch) {
    return {
      repoId: blobRootMatch[1],
      branch: blobRootMatch[2],
      folder: null,
      filename: null,
    };
  }

  // Repo URL: https://huggingface.co/owner/repo
  const repoUrlMatch = s.match(
    /^https?:\/\/huggingface\.co\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/,
  );
  if (repoUrlMatch) {
    return {
      repoId: repoUrlMatch[1],
      branch: 'main',
      folder: null,
      filename: null,
    };
  }

  // Bare owner/repo
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)) {
    return {repoId: s, branch: 'main', folder: null, filename: null};
  }

  return null;
}

// Given the filename from the URL, pick which files to pre-select.
// - Shard file (e.g. model-00001-of-00004.gguf) → all sibling shards
// - Single file → just that file
// - No match → everything
function formatBytes(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(1)} KB`;
}

const styles = stylex.create({
  // Fixed-height body: the dialog must not grow/shrink as the list loads, the
  // filter narrows it, or a short repo resolves — the file list flex-fills
  // the slack instead.
  pickerBody: {height: '55vh', minHeight: 0},
  fileList: {flexGrow: 1, minHeight: 0, overflowY: 'auto'},
});

export function HuggingFaceDownload({
  localModelsPath,
  hfTokenSet,
  inventoryLocations,
}: {
  localModelsPath: string;
  hfTokenSet: boolean;
  inventoryLocations: InventoryLocation[];
}) {
  const [url, setUrl] = useState('');
  const [showLemonade, setShowLemonade] = useState(false);
  const [sendToCold, setSendToCold] = useState(false);
  const [deleteAfterTransfer, setDeleteAfterTransfer] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  const {term, progress, running, start, cancel, reset} = useDownloadRunner();
  const [files, setFiles] = useState<HfFile[] | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');

  // Debounce so we don't hit the HF API on every keypress
  const [debouncedUrl, setDebouncedUrl] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedUrl(url), 400);
    return () => clearTimeout(t);
  }, [url]);

  const parsed = useMemo(
    () => (debouncedUrl.trim() ? parseHfUrl(debouncedUrl.trim()) : null),
    [debouncedUrl],
  );

  // Only show invalid after the debounce has settled (avoids flashing mid-type)
  const isInvalid =
    url.trim() !== '' && url === debouncedUrl && parsed === null;

  // Fetch file list from HF API whenever parsed URL changes. Resetting state
  // synchronously here is the intended "re-sync to the new URL" behaviour.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!parsed) {
      setFiles(null);
      setFilesError(null);
      setFilesLoading(false);
      setSelectedPaths(new Set());
      setFilter('');
      return;
    }
    setFiles(null);
    setFilesError(null);
    setFilesLoading(true);
    setFilter('');

    const params = new URLSearchParams({
      repoId: parsed.repoId,
      branch: parsed.branch,
    });
    if (parsed.folder) params.set('folder', parsed.folder);

    let cancelled = false;
    fetch(`/api/v1/hf-files?${params}`)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json() as Promise<HfFile[]>;
      })
      .then((data) => {
        if (!cancelled) {
          setFiles(data);
          setSelectedPaths(defaultDownloadSelection(data, parsed.filename));
          setFilesLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setFilesError(String(e.message ?? e));
          setFilesLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [parsed]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const selectedFiles = useMemo(
    () => files?.filter((f) => selectedPaths.has(f.path)) ?? [],
    [files, selectedPaths],
  );
  const totalSize = selectedFiles.reduce((s, f) => s + f.size, 0);

  // The picker shows the rows matching the filter; selection is by path, so
  // files selected and then filtered out of view stay selected (the footer
  // count always tells the whole story).
  const visibleFiles = useMemo(() => {
    if (!files) return [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return files;
    return files.filter((f) =>
      (f.path.split('/').pop() ?? f.path).toLowerCase().includes(needle),
    );
  }, [files, filter]);

  const command = useMemo(() => {
    if (!parsed || !files || selectedFiles.length === 0) return null;
    return buildHfCommand(
      {
        repoId: parsed.repoId,
        branch: parsed.branch,
        filePaths: selectedFiles.map((f) => f.path),
      },
      localModelsPath,
    );
  }, [parsed, files, selectedFiles, localModelsPath]);

  const toggleFile = (path: string, checked: boolean) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (checked) next.add(path);
      else next.delete(path);
      return next;
    });
  };

  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    if (!command) return;
    copyToClipboard(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  const startDownload = () => {
    if (!parsed || selectedFiles.length === 0 || running) return;
    setShowTerminal(true);
    start({
      repoId: parsed.repoId,
      branch: parsed.branch,
      filePaths: selectedFiles.map((f) => f.path),
      sendToCold,
      deleteAfterTransfer,
    });
  };

  // Closing the terminal returns to the picker (the URL stays); closing the
  // picker clears the URL, which resets everything via the fetch effect.
  const closeTerminal = () => {
    if (running) cancel();
    setShowTerminal(false);
    reset();
  };
  const closePicker = () => {
    setUrl('');
    setDebouncedUrl('');
  };

  const hasFiles = files !== null && files.length > 0;

  return (
    <Section>
      <VStack gap={3}>
        <Heading level={2}>Download model</Heading>
        <HStack gap={2} vAlign="end">
          <StackItem size="fill">
            <TextInput
              label="Hugging Face URL"
              value={url}
              onChange={setUrl}
              placeholder="https://huggingface.co/org/repo/blob/main/quant-folder/file.gguf"
              status={
                isInvalid
                  ? {
                      type: 'error',
                      message: 'Not a valid Hugging Face file URL.',
                    }
                  : undefined
              }
            />
          </StackItem>
          <Button
            label="Browse Lemonade models…"
            variant="secondary"
            onClick={() => setShowLemonade(true)}
          />
        </HStack>
      </VStack>

      {showLemonade && (
        <LemonadeBrowser
          hfTokenSet={hfTokenSet}
          inventoryLocations={inventoryLocations}
          onClose={() => setShowLemonade(false)}
        />
      )}

      {showTerminal ? (
        <DownloadModal
          term={term}
          progress={progress}
          running={running}
          hfTokenSet={hfTokenSet}
          onClose={closeTerminal}
        />
      ) : (
        parsed && (
          <Dialog
            isOpen
            onOpenChange={(open) => {
              if (!open) closePicker();
            }}
            width={600}
            purpose="form"
          >
            <VStack gap={4}>
              <Heading level={3}>Download from {parsed.repoId}</Heading>
              <VStack gap={3} xstyle={styles.pickerBody}>
                {filesLoading && (
                  <Text type="supporting">Fetching file list…</Text>
                )}
                {filesError && (
                  <Text type="supporting" color="accent">
                    Error: {filesError}
                  </Text>
                )}
                {hasFiles && (
                  <HStack gap={3} vAlign="center">
                    <StackItem size="fill">
                      <TextInput
                        label="Filter files"
                        isLabelHidden
                        value={filter}
                        onChange={setFilter}
                        placeholder="Filter files…"
                      />
                    </StackItem>
                    <Text type="supporting">
                      {visibleFiles.length} / {files!.length} files
                    </Text>
                  </HStack>
                )}
                {hasFiles && (
                  <List hasDividers xstyle={styles.fileList}>
                    {visibleFiles.map((f) => (
                      <ListItem
                        key={f.path}
                        startContent={
                          <CheckboxInput
                            label={f.path}
                            isLabelHidden
                            value={selectedPaths.has(f.path)}
                            onChange={(checked) => toggleFile(f.path, checked)}
                          />
                        }
                        label={f.path.split('/').pop()}
                        description={formatBytes(f.size)}
                      />
                    ))}
                    {visibleFiles.length === 0 && (
                      <ListItem label="No files match the filter." />
                    )}
                  </List>
                )}
                {hasFiles && (
                  <VStack gap={2}>
                    <CheckboxInput
                      label="Copy to cold storage when done"
                      value={sendToCold}
                      onChange={(checked) => {
                        setSendToCold(checked);
                        if (!checked) setDeleteAfterTransfer(false);
                      }}
                    />
                    {sendToCold && (
                      <CheckboxInput
                        label="Delete from local storage after transfer"
                        value={deleteAfterTransfer}
                        onChange={setDeleteAfterTransfer}
                      />
                    )}
                  </VStack>
                )}
              </VStack>
              <HStack gap={2} hAlign="between" vAlign="center">
                <Text type="supporting">
                  {selectedFiles.length} file
                  {selectedFiles.length !== 1 ? 's' : ''} ·{' '}
                  {formatBytes(totalSize)}
                </Text>
                <HStack gap={2} hAlign="end">
                  <Button
                    label={copied ? 'Copied' : 'Copy command'}
                    variant="secondary"
                    size="sm"
                    onClick={handleCopy}
                    isDisabled={command == null}
                  />
                  <Button
                    label="Run"
                    variant="primary"
                    size="sm"
                    onClick={startDownload}
                    isDisabled={selectedFiles.length === 0}
                  />
                </HStack>
              </HStack>
            </VStack>
          </Dialog>
        )
      )}
    </Section>
  );
}
