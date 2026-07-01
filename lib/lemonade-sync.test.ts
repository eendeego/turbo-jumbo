import {test, expect} from 'bun:test';
import {promises as fsp} from 'fs';
import os from 'os';
import path from 'path';
import {
  syncLemonadeToTurboJumbo,
  findLemonadeOnlyRepos,
  previewLemonadeSync,
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

test('preview splits actionable files into move vs deduplicate, omitting no-ops', async () => {
  const {root, tj, lem} = await mkdirs();
  // Lemonade-only → move (two files).
  await lemonadeRepo(lem, 'org', 'only', 'r1', {'a.bin': 'AA', 'b.bin': 'BBB'});
  // Identical copy already in TJ → deduplicate.
  await write(tj, 'org/dup/c.bin', 'SAME');
  await lemonadeRepo(lem, 'org', 'dup', 'r2', {'c.bin': 'SAME'});
  // A different (size) TJ copy → no action, omitted from the preview.
  await write(tj, 'org/diff/d.bin', 'TJVERSION'); // 9 bytes
  await lemonadeRepo(lem, 'org', 'diff', 'r3', {'d.bin': 'LEMONADE-DIFFERENT'});

  const byId = new Map(
    (await previewLemonadeSync(tj, lem)).map((p) => [p.repoId, p]),
  );
  expect(byId.get('org/only')).toMatchObject({moveCount: 2, dedupCount: 0});
  expect(byId.get('org/dup')).toMatchObject({moveCount: 0, dedupCount: 1});
  expect(byId.has('org/diff')).toBe(false);
  await fsp.rm(root, {recursive: true, force: true});
});

// Build a cache repo whose snapshot entries are already symlinks into TJ (the
// state a prior sync leaves behind), plus any extra real files.
async function syncedRepo(
  lemBase: string,
  tjBase: string,
  org: string,
  repo: string,
  rev: string,
  linked: Record<string, string>, // repoPath -> content (lives in TJ, symlinked)
  real: Record<string, string> = {}, // repoPath -> content (not yet synced)
) {
  const dir = `models--${org}--${repo}`;
  await write(lemBase, `${dir}/refs/main`, rev);
  const snap = path.join(lemBase, dir, 'snapshots', rev);
  await fsp.mkdir(snap, {recursive: true});
  for (const [rel, content] of Object.entries(linked)) {
    const tjFile = await write(tjBase, `${org}/${repo}/${rel}`, content);
    await fsp.mkdir(path.dirname(path.join(snap, rel)), {recursive: true});
    await fsp.symlink(path.resolve(tjFile), path.join(snap, rel));
  }
  for (const [rel, content] of Object.entries(real)) {
    await write(lemBase, `${dir}/snapshots/${rev}/${rel}`, content);
  }
}

test('skips a model already synced (its files are symlinks into Turbo Jumbo)', async () => {
  const {root, tj, lem} = await mkdirs();
  const rev = 'synced';
  await syncedRepo(lem, tj, 'org', 'done', rev, {'m.bin': 'DATA'});

  // Neither the preview nor a run treats an already-linked model as work.
  expect(await previewLemonadeSync(tj, lem)).toEqual([]);
  expect(await syncLemonadeToTurboJumbo(tj, lem)).toEqual([]);

  // The existing symlink is left exactly as it was.
  const lemFile = path.join(lem, `models--org--done/snapshots/${rev}/m.bin`);
  expect((await fsp.lstat(lemFile)).isSymbolicLink()).toBe(true);
  expect(await fsp.readlink(lemFile)).toBe(
    path.resolve(path.join(tj, 'org/done/m.bin')),
  );
  await fsp.rm(root, {recursive: true, force: true});
});

test('in a partially-synced model, acts only on the un-synced file', async () => {
  const {root, tj, lem} = await mkdirs();
  const rev = 'partial';
  // old.bin already linked into TJ; new.bin is a fresh real file.
  await syncedRepo(
    lem,
    tj,
    'org',
    'part',
    rev,
    {'old.bin': 'OLD'},
    {'new.bin': 'NEW'},
  );

  // Only the un-synced file is counted as work.
  expect(await previewLemonadeSync(tj, lem)).toEqual([
    {repoId: 'org/part', rev, moveCount: 1, dedupCount: 0},
  ]);

  const [result] = await syncLemonadeToTurboJumbo(tj, lem);
  expect(result.files).toContainEqual({repoPath: 'new.bin', status: 'linked'});
  expect(result.files).toContainEqual({
    repoPath: 'old.bin',
    status: 'already-linked',
  });

  const snap = path.join(lem, `models--org--part/snapshots/${rev}`);
  // The pre-existing symlink is untouched; the new file moved in and is linked.
  expect((await fsp.lstat(path.join(snap, 'old.bin'))).isSymbolicLink()).toBe(
    true,
  );
  expect(await fsp.readFile(path.join(tj, 'org/part/new.bin'), 'utf8')).toBe(
    'NEW',
  );
  expect((await fsp.lstat(path.join(snap, 'new.bin'))).isSymbolicLink()).toBe(
    true,
  );
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
