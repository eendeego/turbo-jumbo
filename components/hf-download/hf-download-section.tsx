'use client';

import {useEffect, useMemo, useRef, useState} from 'react';
import {Section} from '@astryxdesign/core/Section';
import {VStack, HStack} from '@astryxdesign/core/Stack';
import {Heading, Text} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {Button} from '@astryxdesign/core/Button';
import {CheckboxInput} from '@astryxdesign/core/CheckboxInput';
import {CodeBlock} from '@astryxdesign/core/CodeBlock';
import {List, ListItem} from '@astryxdesign/core/List';
import {Spinner} from '@astryxdesign/core/Spinner';

type ParsedUrl = {
  repoId: string;
  branch: string;
  folder: string | null;
  filename: string | null;
};
type HfFile = {path: string; size: number};
type TermState = {lines: string[]; col: number};

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
function computeDefaultSelection(
  files: HfFile[],
  filename: string | null,
): Set<string> {
  if (!filename) return new Set();

  const shardMatch = filename.match(/^(.+)-(\d{5})-of-(\d{5})(\.gguf)$/i);
  if (shardMatch) {
    const [, base, , total, ext] = shardMatch;
    const shards = files.filter((f) => {
      const name = f.path.split('/').pop() ?? '';
      return name.startsWith(`${base}-`) && name.endsWith(`-of-${total}${ext}`);
    });
    if (shards.length > 0) return new Set(shards.map((f) => f.path));
  }

  const exact = files.find((f) => f.path.split('/').pop() === filename);
  if (exact) return new Set([exact.path]);

  return new Set(files.map((f) => f.path));
}

// Minimal terminal emulator: handles \r (go to column 0) and \n (new line).
// Keeps lines as an array of strings so \r-based progress bars update in place.
function applyChunk(state: TermState, chunk: string): TermState {
  const lines = [...state.lines];
  let col = state.col;
  for (let i = 0; i < chunk.length; i++) {
    const ch = chunk[i];
    if (ch === '\r') {
      if (chunk[i + 1] === '\n') {
        lines.push('');
        col = 0;
        i++;
      } else {
        col = 0;
      }
    } else if (ch === '\n') {
      lines.push('');
      col = 0;
    } else {
      const li = lines.length - 1;
      const line = lines[li];
      if (col < line.length) {
        lines[li] = line.slice(0, col) + ch + line.slice(col + 1);
      } else {
        lines[li] = line.padEnd(col, ' ') + ch;
      }
      col++;
    }
  }
  return {lines, col};
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(1)} KB`;
}

export function HfDownloadSection({
  localModelsPath,
}: {
  localModelsPath: string;
}) {
  const [url, setUrl] = useState('');
  const [sendToCold, setSendToCold] = useState(false);
  const [deleteAfterTransfer, setDeleteAfterTransfer] = useState(false);
  const [running, setRunning] = useState(false);
  const [term, setTerm] = useState<TermState | null>(null);
  const [files, setFiles] = useState<HfFile[] | null>(null);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);

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
      return;
    }
    setFiles(null);
    setFilesError(null);
    setFilesLoading(true);

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
          setSelectedPaths(computeDefaultSelection(data, parsed.filename));
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

  const command = useMemo(() => {
    if (!parsed || !files || selectedFiles.length === 0) return null;
    const includes = selectedFiles
      .map((f) => `--include "${f.path}"`)
      .join(' ');
    const rev = parsed.branch !== 'main' ? ` --revision ${parsed.branch}` : '';
    return `HF_HUB_ENABLE_HF_TRANSFER=1 hf download ${parsed.repoId} ${includes} --local-dir ${localModelsPath}${rev}`;
  }, [parsed, files, selectedFiles, localModelsPath]);

  const toggleFile = (path: string, checked: boolean) => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (checked) next.add(path);
      else next.delete(path);
      return next;
    });
  };

  const handleCancel = () => abortRef.current?.abort();

  const handleRun = async () => {
    if (!parsed || selectedFiles.length === 0 || running) return;
    const abort = new AbortController();
    abortRef.current = abort;
    setRunning(true);
    setTerm({lines: [''], col: 0});

    try {
      const res = await fetch('/api/v1/hf-download', {
        method: 'POST',
        signal: abort.signal,
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          repoId: parsed.repoId,
          branch: parsed.branch,
          filePaths: selectedFiles.map((f) => f.path),
          sendToCold,
          deleteAfterTransfer,
        }),
      });

      if (!res.ok || !res.body) {
        setTerm({lines: [`Error: ${res.statusText}`], col: 0});
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let state: TermState = {lines: [''], col: 0};

      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        state = applyChunk(state, decoder.decode(value, {stream: true}));
        setTerm({...state});
      }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) {
        setTerm({lines: [`Error: ${String(e)}`], col: 0});
      }
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  };

  const hasFiles = files !== null && files.length > 0;

  return (
    <Section>
      <VStack gap={3}>
        <Heading level={2}>Download model</Heading>
        <TextInput
          label="Hugging Face URL"
          value={url}
          onChange={(value) => {
            setUrl(value);
            setTerm(null);
          }}
          placeholder="https://huggingface.co/org/repo/blob/main/quant-folder/file.gguf"
          status={
            isInvalid
              ? {type: 'error', message: 'Not a valid Hugging Face file URL.'}
              : undefined
          }
        />

        {filesLoading && <Spinner label="Fetching file list…" />}

        {filesError && (
          <Text type="supporting" color="accent">
            Error: {filesError}
          </Text>
        )}

        {hasFiles && (
          <VStack gap={1}>
            <List hasDividers>
              {files!.map((f) => (
                <ListItem
                  key={f.path}
                  startContent={
                    <CheckboxInput
                      label={f.path}
                      isLabelHidden
                      value={selectedPaths.has(f.path)}
                      onChange={(checked) => toggleFile(f.path, checked)}
                      isDisabled={running}
                    />
                  }
                  label={f.path.split('/').pop()}
                  description={formatBytes(f.size)}
                />
              ))}
            </List>
            <HStack gap={2} hAlign="between">
              <Text type="supporting">
                {selectedFiles.length} / {files!.length} selected
              </Text>
              <Text type="label">{formatBytes(totalSize)}</Text>
            </HStack>
          </VStack>
        )}

        {command && (
          <VStack gap={2}>
            <CodeBlock code={command} language="bash" isWrapped width="100%" />
            <HStack gap={2}>
              {running ? (
                <Button
                  label="Cancel"
                  variant="destructive"
                  onClick={handleCancel}
                />
              ) : (
                <Button label="Run" variant="primary" onClick={handleRun} />
              )}
            </HStack>
          </VStack>
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
              isDisabled={running}
            />
            {sendToCold && (
              <CheckboxInput
                label="Delete from local storage after transfer"
                value={deleteAfterTransfer}
                onChange={setDeleteAfterTransfer}
                isDisabled={running}
              />
            )}
          </VStack>
        )}

        {term !== null && (
          <CodeBlock
            code={term.lines.join('\n') || ' '}
            language="plaintext"
            hasCopyButton={false}
            isWrapped
            width="100%"
            maxHeight={256}
          />
        )}
      </VStack>
    </Section>
  );
}
