import {test, expect} from 'bun:test';
import {promises as fsp} from 'fs';
import os from 'os';
import path from 'path';
import {expandSupportFiles} from '@/lib/storage/support-files';

async function makeRepo(files: Record<string, string>): Promise<string> {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-support-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(base, rel);
    await fsp.mkdir(path.dirname(full), {recursive: true});
    await fsp.writeFile(full, content);
  }
  return base;
}

test('expands a whole-repo model with its non-weight support files', async () => {
  const base = await makeRepo({
    'Qwen/Qwen3.6-35B-A3B/model-00001-of-00002.safetensors': 'ww',
    'Qwen/Qwen3.6-35B-A3B/model-00002-of-00002.safetensors': 'ww',
    'Qwen/Qwen3.6-35B-A3B/model.safetensors.index.json': '{}',
    'Qwen/Qwen3.6-35B-A3B/config.json': '{}',
    'Qwen/Qwen3.6-35B-A3B/tokenizer.json': '{"a":1}',
  });
  const extra = await expandSupportFiles(base, [
    'Qwen/Qwen3.6-35B-A3B/model-00001-of-00002.safetensors',
    'Qwen/Qwen3.6-35B-A3B/model-00002-of-00002.safetensors',
  ]);
  expect(extra.map((f) => f.path).sort()).toEqual([
    'Qwen/Qwen3.6-35B-A3B/config.json',
    'Qwen/Qwen3.6-35B-A3B/model.safetensors.index.json',
    'Qwen/Qwen3.6-35B-A3B/tokenizer.json',
  ]);
  expect(extra.find((f) => f.path.endsWith('tokenizer.json'))!.size).toBe(7);
});

test('never drags along other quants, sidecars, or dot-clutter', async () => {
  const base = await makeRepo({
    'unsloth/repo-GGUF/model-Q4_K_M.gguf': 'ww',
    'unsloth/repo-GGUF/model-Q8_0.gguf': 'wwww',
    'unsloth/repo-GGUF/model-Q4_K_M.gguf.tjmeta.json': '{}',
    'unsloth/repo-GGUF/tjmodel.json': '{}',
    'unsloth/repo-GGUF/.cache/huggingface/x': 'c',
    'unsloth/repo-GGUF/notes.txt': 'n',
  });
  const extra = await expandSupportFiles(base, [
    'unsloth/repo-GGUF/model-Q4_K_M.gguf',
  ]);
  // The other quant (a weight file), both sidecars (they ride the meta
  // channel), and the dot-dir stay out; only the plain support file rides.
  expect(extra.map((f) => f.path)).toEqual(['unsloth/repo-GGUF/notes.txt']);
});

test('includes support files in nested subdirectories', async () => {
  const base = await makeRepo({
    'org/onnx-repo/model.safetensors': 'ww',
    'org/onnx-repo/assets/vocab.txt': 'vv',
  });
  const extra = await expandSupportFiles(base, [
    'org/onnx-repo/model.safetensors',
  ]);
  expect(extra.map((f) => f.path)).toEqual(['org/onnx-repo/assets/vocab.txt']);
});

test('ignores paths that escape the base or point at missing dirs', async () => {
  const base = await makeRepo({'org/repo/a.gguf': 'w'});
  const extra = await expandSupportFiles(base, [
    '../outside/evil.gguf',
    'org/gone/x.gguf',
  ]);
  expect(extra).toEqual([]);
});
