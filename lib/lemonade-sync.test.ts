import {test, expect} from 'bun:test';
import {promises as fsp} from 'fs';
import os from 'os';
import path from 'path';
import {
  syncLemonadeToTurboJumbo,
  findLemonadeOnlyRepos,
} from '@/lib/lemonade-sync';
import {readModelSidecar} from '@/lib/model-sidecar';

async function write(base: string, rel: string, content: string) {
  const full = path.join(base, rel);
  await fsp.mkdir(path.dirname(full), {recursive: true});
  await fsp.writeFile(full, content);
  return full;
}

// Build a Lemonade cache repo (HF cache layout) with the given snapshot files.
async function lemonadeRepo(
  lemBase: string,
  org: string,
  repo: string,
  rev: string,
  files: Record<string, string>,
  {withRef = true}: {withRef?: boolean} = {},
) {
  const dir = `models--${org}--${repo}`;
  if (withRef) await write(lemBase, `${dir}/refs/main`, rev);
  for (const [rel, content] of Object.entries(files)) {
    await write(lemBase, `${dir}/snapshots/${rev}/${rel}`, content);
  }
}

async function mkdirs() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-lemsync-'));
  return {
    root,
    tj: path.join(root, 'turbo-jumbo'),
    lem: path.join(root, 'lemonade'),
  };
}

test('syncs a Lemonade-only model: moves files into TJ, symlinks them back', async () => {
  const {root, tj, lem} = await mkdirs();
  const rev = '047e06635fbe71469926b35ea414537245218200';
  await lemonadeRepo(lem, 'LiquidAI', 'LFM2.5-GGUF', rev, {
    'model.gguf': 'WEIGHTS',
    'config/index.json': '{}', // nested path
  });

  const results = await syncLemonadeToTurboJumbo(tj, lem);
  expect(results.map((r) => r.repoId)).toEqual(['LiquidAI/LFM2.5-GGUF']);

  // Turbo Jumbo now holds the real files.
  const tjFile = path.join(tj, 'LiquidAI/LFM2.5-GGUF/model.gguf');
  expect((await fsp.lstat(tjFile)).isSymbolicLink()).toBe(false);
  expect(await fsp.readFile(tjFile, 'utf8')).toBe('WEIGHTS');
  expect(
    await fsp.readFile(
      path.join(tj, 'LiquidAI/LFM2.5-GGUF/config/index.json'),
      'utf8',
    ),
  ).toBe('{}');

  // The Lemonade snapshot entry is now a symlink to the absolute TJ path.
  const lemFile = path.join(
    lem,
    `models--LiquidAI--LFM2.5-GGUF/snapshots/${rev}/model.gguf`,
  );
  expect((await fsp.lstat(lemFile)).isSymbolicLink()).toBe(true);
  expect(await fsp.readlink(lemFile)).toBe(path.resolve(tjFile));
  expect(await fsp.readFile(lemFile, 'utf8')).toBe('WEIGHTS'); // reads through the link

  // The sidecar records the moved files and the snapshot rev as repoCommit.
  const sidecar = await readModelSidecar(tj, 'LiquidAI/LFM2.5-GGUF');
  expect(sidecar?.repoCommit).toBe(rev);
  expect(sidecar?.files.map((f) => f.path).sort()).toEqual([
    'config/index.json',
    'model.gguf',
  ]);
  expect(
    sidecar?.files.find((f) => f.path === 'model.gguf')?.computedSize,
  ).toBe('WEIGHTS'.length);
  await fsp.rm(root, {recursive: true, force: true});
});

test('is idempotent: a second run finds nothing to sync', async () => {
  const {root, tj, lem} = await mkdirs();
  const rev = 'abc123';
  await lemonadeRepo(lem, 'org', 'repo', rev, {'a.bin': 'A'});

  expect((await syncLemonadeToTurboJumbo(tj, lem)).length).toBe(1);
  // After the first sync the repo lives in TJ, so it's no longer Lemonade-only.
  expect(await findLemonadeOnlyRepos(tj, lem)).toEqual([]);
  expect(await syncLemonadeToTurboJumbo(tj, lem)).toEqual([]);
  await fsp.rm(root, {recursive: true, force: true});
});

test('leaves a model alone when Turbo Jumbo holds a different (size) file', async () => {
  const {root, tj, lem} = await mkdirs();
  const rev = 'deadbeef';
  await write(tj, 'org/repo/a.bin', 'TJ-COPY'); // 7 bytes
  await lemonadeRepo(lem, 'org', 'repo', rev, {'a.bin': 'LEM-COPY-X'}); // 10 bytes

  expect(await syncLemonadeToTurboJumbo(tj, lem)).toEqual([]);
  // Both copies are untouched — neither is the other.
  const lemFile = path.join(lem, `models--org--repo/snapshots/${rev}/a.bin`);
  expect((await fsp.lstat(lemFile)).isSymbolicLink()).toBe(false);
  expect(await fsp.readFile(lemFile, 'utf8')).toBe('LEM-COPY-X');
  expect(await fsp.readFile(path.join(tj, 'org/repo/a.bin'), 'utf8')).toBe(
    'TJ-COPY',
  );
  await fsp.rm(root, {recursive: true, force: true});
});

test('deduplicates a model in both stores: deletes the Lemonade copy, symlinks to TJ', async () => {
  const {root, tj, lem} = await mkdirs();
  const rev = 'rev-dup';
  await write(tj, 'org/repo/a.bin', 'SAME'); // Turbo Jumbo already owns it
  await lemonadeRepo(lem, 'org', 'repo', rev, {'a.bin': 'SAME'}); // identical size

  const [result] = await syncLemonadeToTurboJumbo(tj, lem);
  expect(result.files).toEqual([{repoPath: 'a.bin', status: 'deduplicated'}]);

  // The Turbo Jumbo copy is untouched (still a real file).
  const tjFile = path.join(tj, 'org/repo/a.bin');
  expect((await fsp.lstat(tjFile)).isSymbolicLink()).toBe(false);
  expect(await fsp.readFile(tjFile, 'utf8')).toBe('SAME');

  // The Lemonade copy is now a symlink to the Turbo Jumbo file.
  const lemFile = path.join(lem, `models--org--repo/snapshots/${rev}/a.bin`);
  expect((await fsp.lstat(lemFile)).isSymbolicLink()).toBe(true);
  expect(await fsp.readlink(lemFile)).toBe(path.resolve(tjFile));
  expect(await fsp.readFile(lemFile, 'utf8')).toBe('SAME');

  // Idempotent: a second run has nothing left to do.
  expect(await syncLemonadeToTurboJumbo(tj, lem)).toEqual([]);
  await fsp.rm(root, {recursive: true, force: true});
});

test('resolves the revision from a sole snapshots dir when refs/main is absent', async () => {
  const {root, tj, lem} = await mkdirs();
  const rev = 'no-ref-rev';
  await lemonadeRepo(
    lem,
    'org',
    'repo2',
    rev,
    {'w.bin': 'W'},
    {withRef: false},
  );

  const [result] = await syncLemonadeToTurboJumbo(tj, lem);
  expect(result?.rev).toBe(rev);
  expect(await fsp.readFile(path.join(tj, 'org/repo2/w.bin'), 'utf8')).toBe(
    'W',
  );
  await fsp.rm(root, {recursive: true, force: true});
});
