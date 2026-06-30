'use client';

import {useRef, useState} from 'react';
import {Section} from '@astryxdesign/core/Section';
import {VStack, HStack} from '@astryxdesign/core/Stack';
import {Heading} from '@astryxdesign/core/Text';
import {TextInput} from '@astryxdesign/core/TextInput';
import {Button} from '@astryxdesign/core/Button';
import {CodeBlock} from '@astryxdesign/core/CodeBlock';

function parseHfUrl(
  url: string,
): {repoId: string; folder: string | null} | null {
  // https://huggingface.co/{owner}/{repo}/blob/{branch}/{...path}
  // https://huggingface.co/{owner}/{repo}/resolve/{branch}/{...path}
  const match = url.match(
    /^https?:\/\/huggingface\.co\/([^/]+\/[^/]+)\/(blob|resolve)\/[^/]+\/(.+)$/,
  );
  if (!match) return null;

  const repoId = match[1];
  const filePath = match[3];

  const slashIdx = filePath.indexOf('/');
  const folder = slashIdx !== -1 ? filePath.slice(0, slashIdx) : null;

  return {repoId, folder};
}

// Minimal terminal emulator: handles \r (go to column 0) and \n (new line).
// Keeps lines as an array of strings so \r-based progress bars update in place.
type TermState = {lines: string[]; col: number};

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

export function HfDownloadSection({
  localModelsPath,
}: {
  localModelsPath: string;
}) {
  const [url, setUrl] = useState('');
  const [running, setRunning] = useState(false);
  const [term, setTerm] = useState<TermState | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const parsed = url.trim() ? parseHfUrl(url.trim()) : null;

  let command: string | null = null;
  if (parsed) {
    const include = parsed.folder
      ? `--include "${parsed.folder}/*"`
      : `--include "*.gguf"`;
    command = `HF_HUB_ENABLE_HF_TRANSFER=1 hf download ${parsed.repoId} ${include} --local-dir ${localModelsPath}`;
  }

  const handleCancel = () => abortRef.current?.abort();

  const handleRun = async () => {
    if (!parsed || running) return;
    const abort = new AbortController();
    abortRef.current = abort;
    setRunning(true);
    setTerm({lines: [''], col: 0});

    try {
      const res = await fetch('/api/v1/hf-download', {
        method: 'POST',
        signal: abort.signal,
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({repoId: parsed.repoId, folder: parsed.folder}),
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

  const isInvalid = url.trim() !== '' && parsed === null;

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
