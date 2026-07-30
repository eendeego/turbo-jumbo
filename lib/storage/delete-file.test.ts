import {test, expect} from 'bun:test';
import {existsSync, promises as fsp} from 'fs';
import os from 'os';
import path from 'path';
import {
  cleanupWeightlessModelDirs,
  deleteFileWithMeta,
} from '@/lib/storage/delete-file';
import {readModelSidecar} from '@/lib/models/model-sidecar';

async function write(base: string, rel: string, content: string) {
  const full = path.join(base, rel);
  await fsp.mkdir(path.dirname(full), {recursive: true});
  await fsp.writeFile(full, content);
  return full;
}

// A flat-layout model dir with a tjmodel.json covering the given files.
async function tjModel(
  base: string,
  repoId: string,
  files: Record<string, string>,
) {
  for (const [rel, content] of Object.entries(files)) {
    await write(base, `${repoId}/${rel}`, content);
  }
  await write(
    base,
    `${repoId}/tjmodel.json`,
    JSON.stringify({
      modelUrl: `https://huggingface.co/${repoId}`,
      repoId,
      files: Object.keys(files).map((rel) => ({
        path: rel,
        originUrl: `https://huggingface.co/${repoId}/blob/main/${rel}`,
        sourceSize: 0,
        computedSize: files[rel].length,
        sourceSha256: '',
        computedSha256: '',
      })),
    }),
  );
}

async function mkbase() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'tj-delete-'));
}

test('deletes the file and drops its sidecar entry, keeping the rest', async () => {
  const base = await mkbase();
  await tjModel(base, 'org/repo', {'a.gguf': 'AAA', 'b.gguf': 'BBB'});
  await write(base, 'org/repo/a.gguf.tjmeta.json', '{}'); // legacy sidecar

  await deleteFileWithMeta(base, 'org/repo/a.gguf');

  expect(existsSync(path.join(base, 'org/repo/a.gguf'))).toBe(false);
  expect(existsSync(path.join(base, 'org/repo/a.gguf.tjmeta.json'))).toBe(
    false,
  );
  // The other file and the sidecar (now only listing b) survive.
  expect(existsSync(path.join(base, 'org/repo/b.gguf'))).toBe(true);
  const sidecar = await readModelSidecar(base, 'org/repo');
  expect(sidecar?.files.map((f) => f.path)).toEqual(['b.gguf']);
  await fsp.rm(base, {recursive: true, force: true});
});

test('deleting the last file removes sidecars, .cache, and emptied dirs', async () => {
  const base = await mkbase();
  await tjModel(base, 'org/solo', {'only.gguf': 'DATA'});
  await write(base, 'org/solo/only.gguf.tjmeta.json', '{}');
  await write(
    base,
    'org/solo/.cache/huggingface/download/only.gguf.metadata',
    'META',
  );

  await deleteFileWithMeta(base, 'org/solo/only.gguf');

  // The whole husk is gone: model dir and the now-empty org dir.
  expect(existsSync(path.join(base, 'org/solo'))).toBe(false);
  expect(existsSync(path.join(base, 'org'))).toBe(false);
  // The storage root itself is never removed.
  expect(existsSync(base)).toBe(true);
  await fsp.rm(base, {recursive: true, force: true});
});

test('keeps the org dir when a sibling model remains', async () => {
  const base = await mkbase();
  await tjModel(base, 'org/gone', {'x.gguf': 'X'});
  await tjModel(base, 'org/stays', {'y.gguf': 'Y'});

  await deleteFileWithMeta(base, 'org/gone/x.gguf');

  expect(existsSync(path.join(base, 'org/gone'))).toBe(false);
  expect(existsSync(path.join(base, 'org/stays/y.gguf'))).toBe(true);
  await fsp.rm(base, {recursive: true, force: true});
});

test('a nested file prunes emptied subdirectories but not shared ones', async () => {
  const base = await mkbase();
  await tjModel(base, 'org/nested', {
    'sub/dir/model.bin': 'DATA',
    'top.gguf': 'TOP',
  });

  await deleteFileWithMeta(base, 'org/nested/sub/dir/model.bin');

  // sub/dir and sub are emptied and pruned; the model dir keeps top.gguf.
  expect(existsSync(path.join(base, 'org/nested/sub'))).toBe(false);
  expect(existsSync(path.join(base, 'org/nested/top.gguf'))).toBe(true);
  const sidecar = await readModelSidecar(base, 'org/nested');
  expect(sidecar?.files.map((f) => f.path)).toEqual(['top.gguf']);
  await fsp.rm(base, {recursive: true, force: true});
});

test('a file without any sidecar still deletes and prunes', async () => {
  const base = await mkbase();
  await write(base, 'org/bare/loose.gguf', 'DATA');

  await deleteFileWithMeta(base, 'org/bare/loose.gguf');

  expect(existsSync(path.join(base, 'org/bare'))).toBe(false);
  expect(existsSync(path.join(base, 'org'))).toBe(false);
  expect(existsSync(base)).toBe(true);
  await fsp.rm(base, {recursive: true, force: true});
});

test('a top-level file outside any model dir just gets deleted', async () => {
  const base = await mkbase();
  await write(base, 'stray.gguf', 'DATA');

  await deleteFileWithMeta(base, 'stray.gguf');

  expect(existsSync(path.join(base, 'stray.gguf'))).toBe(false);
  expect(existsSync(base)).toBe(true);
  await fsp.rm(base, {recursive: true, force: true});
});

test('cleanup removes a model dir left with only support files', async () => {
  const base = await mkbase();
  await tjModel(base, 'Qwen/wr', {
    'model-00001-of-00002.safetensors': 'W1',
    'model-00002-of-00002.safetensors': 'W2',
    'config.json': '{}',
    'tokenizer.json': '{}',
  });
  await write(base, 'Qwen/wr/.cache/huggingface/x', 'bookkeeping');

  await deleteFileWithMeta(base, 'Qwen/wr/model-00001-of-00002.safetensors');
  await deleteFileWithMeta(base, 'Qwen/wr/model-00002-of-00002.safetensors');
  await cleanupWeightlessModelDirs(base, [
    'Qwen/wr/model-00001-of-00002.safetensors',
    'Qwen/wr/model-00002-of-00002.safetensors',
  ]);

  // No weights remain, so the support files, sidecar, .cache, and the whole
  // dir husk (including the emptied org dir) are gone.
  expect(existsSync(path.join(base, 'Qwen'))).toBe(false);
  expect(existsSync(base)).toBe(true);
  await fsp.rm(base, {recursive: true, force: true});
});

test('cleanup leaves the dir alone while any weight file remains', async () => {
  const base = await mkbase();
  await tjModel(base, 'org/multi', {
    'a-Q4.gguf': 'AAA',
    'b-Q8.gguf': 'BBBB',
    'notes.txt': 'n',
  });

  await deleteFileWithMeta(base, 'org/multi/a-Q4.gguf');
  await cleanupWeightlessModelDirs(base, ['org/multi/a-Q4.gguf']);

  expect(existsSync(path.join(base, 'org/multi/b-Q8.gguf'))).toBe(true);
  expect(existsSync(path.join(base, 'org/multi/notes.txt'))).toBe(true);
  await fsp.rm(base, {recursive: true, force: true});
});

test('cleanup counts weights in subdirectories and never touches hub-cache layouts', async () => {
  const base = await mkbase();
  // Weights live below the dir the deleted file sat in: still not weightless.
  await write(base, 'org/deep/sub/real.safetensors', 'W');
  await write(base, 'org/deep/gone.gguf', 'W');
  await write(base, 'org/deep/config.json', '{}');
  await fsp.rm(path.join(base, 'org/deep/gone.gguf'));
  await cleanupWeightlessModelDirs(base, ['org/deep/gone.gguf']);
  expect(existsSync(path.join(base, 'org/deep/config.json'))).toBe(true);

  // A hub-cache snapshot path is owned by the hub layout — no dir removal.
  const snap = 'models--o--r/snapshots/abc';
  await write(base, `${snap}/config.json`, '{}');
  await cleanupWeightlessModelDirs(base, [`${snap}/model.safetensors`]);
  expect(existsSync(path.join(base, snap, 'config.json'))).toBe(true);
  await fsp.rm(base, {recursive: true, force: true});
});
