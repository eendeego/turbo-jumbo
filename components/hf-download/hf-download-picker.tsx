'use client';

import {useEffect, useMemo, useState} from 'react';
import * as stylex from '@stylexjs/stylex';
import {VStack, HStack, StackItem} from '@astryxdesign/core/Stack';
import {Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {Button} from '@astryxdesign/core/Button';
import {CheckboxInput} from '@astryxdesign/core/CheckboxInput';
import {List, ListItem} from '@astryxdesign/core/List';
import {Banner} from '@astryxdesign/core/Banner';
import {
  DownloadModal,
  buildHfCommand,
  useDownloadRunner,
} from '@/components/hf-download/download-runner';
import {copyToClipboard} from '@/lib/clipboard';
import type {DownloadTarget} from '@/lib/download-target';
import {
  formatBytes,
  diskSpaceWarnings,
  type DownloadDiskUsage,
} from '@/lib/disk-space';
import {defaultDownloadSelection} from '@/lib/hf-download';
import {parseHfUrl} from '@/lib/hf-url';

type HfFile = {path: string; size: number};

const styles = stylex.create({
  // Fixed-height body, matching the Lemonade browser: the dialog must not
  // resize as the file list loads or the filter narrows.
  pickerBody: {height: '55vh', minHeight: 0},
  fileList: {flexGrow: 1, minHeight: 0, overflowY: 'auto'},
});

/**
 * The Hugging Face download picker, the body of the HF download modal (title
 * and close button live in the dialog header): a URL field, the resolved file
 * list with a filter and cold-storage options, and a Copy/Run footer.
 */
export function HfDownloadPicker({
  target,
  hfTokenSet,
}: {
  target: DownloadTarget;
  hfTokenSet: boolean;
}) {
  const [url, setUrl] = useState('');
  const [sendToCold, setSendToCold] = useState(false);
  const [deleteAfterTransfer, setDeleteAfterTransfer] = useState(false);
  const [showTerminal, setShowTerminal] = useState(false);
  // Free space at the download target (models dir + cold storage), fetched once,
  // to warn before a transfer that wouldn't fit. Null while unknown (loading or
  // unreadable) — no warning.
  const [disk, setDisk] = useState<DownloadDiskUsage | null>(null);
  const {
    term,
    progress,
    running,
    command: runCommand,
    start,
    cancel,
    reset,
  } = useDownloadRunner(target.displayPath, target.url);
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

  // Read free space at the target once (best-effort: stay silent if it fails).
  useEffect(() => {
    let cancelled = false;
    fetch(target.diskUsageUrl)
      .then((r) => (r.ok ? (r.json() as Promise<DownloadDiskUsage>) : null))
      .then((d) => {
        if (!cancelled && d) setDisk(d);
      })
      .catch(() => {
        /* unreadable disk: no space warning */
      });
    return () => {
      cancelled = true;
    };
  }, [target.diskUsageUrl]);

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
  const spaceWarnings = useMemo(
    () =>
      disk
        ? diskSpaceWarnings(disk, totalSize, sendToCold, deleteAfterTransfer)
        : [],
    [disk, totalSize, sendToCold, deleteAfterTransfer],
  );
  const notEnoughSpace = spaceWarnings.length > 0;

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
      target.displayPath,
    );
  }, [parsed, files, selectedFiles, target.displayPath]);

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

  // Closing the terminal returns to the picker (the URL stays).
  const closeTerminal = () => {
    if (running) cancel();
    setShowTerminal(false);
    reset();
  };

  const hasFiles = files !== null && files.length > 0;

  if (showTerminal) {
    return (
      <DownloadModal
        title={parsed ? `Downloading ${parsed.repoId}…` : undefined}
        term={term}
        progress={progress}
        running={running}
        command={runCommand ?? undefined}
        hfTokenSet={hfTokenSet}
        onClose={closeTerminal}
      />
    );
  }

  return (
    <VStack gap={4}>
      <VStack gap={3} xstyle={styles.pickerBody}>
        <TextInput
          label="Hugging Face URL"
          isLabelHidden
          value={url}
          onChange={setUrl}
          placeholder="org/repo  or  https://huggingface.co/org/repo/blob/main/folder/file.gguf"
          status={
            isInvalid
              ? {type: 'error', message: 'Not a valid Hugging Face file URL.'}
              : undefined
          }
        />
        {filesLoading && <Text type="supporting">Fetching file list…</Text>}
        {filesError && (
          <Text type="supporting" color="accent">
            Error: {filesError}
          </Text>
        )}
        {!hasFiles && !filesLoading && !filesError && (
          <Text type="supporting">
            Enter a Hugging Face URL or org/repo to list its files.
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
                endContent={
                  <Text type="supporting">{formatBytes(f.size)}</Text>
                }
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
      {hasFiles && notEnoughSpace && (
        <Banner
          status="error"
          title={`Not enough disk space — ${spaceWarnings.join('; ')}.`}
        />
      )}
      <HStack gap={2} hAlign="between" vAlign="center">
        <Text type="supporting">
          {selectedFiles.length === 0
            ? 'Nothing selected'
            : `${selectedFiles.length} file${
                selectedFiles.length !== 1 ? 's' : ''
              } · ${formatBytes(totalSize)}`}
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
            label="Download"
            variant="primary"
            size="sm"
            onClick={startDownload}
            isDisabled={selectedFiles.length === 0}
          />
        </HStack>
      </HStack>
    </VStack>
  );
}
