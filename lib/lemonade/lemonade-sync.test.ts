import {test, expect} from 'bun:test';
import {existsSync, promises as fsp} from 'fs';
import os from 'os';
import path from 'path';
import {
  syncLemonadeToTurboJumbo,
  findLemonadeOnlyRepos,
  previewLemonadeSync,
} from '@/lib/lemonade/lemonade-sync';
import {readModelSidecar} from '@/lib/models/model-sidecar';

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
    {
      repoId: 'org/part',
      rev,
      moveCount: 1,
      dedupCount: 0,
      linkCount: 0,
      staleCount: 0,
    },
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

test('preview counts a dangling snapshot link as stale', async () => {
  const {root, tj, lem} = await mkdirs();
  const rev = 'stale-rev';
  // One healthy link, one whose Turbo Jumbo target is then deleted.
  await syncedRepo(lem, tj, 'org', 'stale', rev, {
    'kept.bin': 'KEPT',
    'gone.bin': 'GONE',
  });
  await fsp.rm(path.join(tj, 'org/stale/gone.bin'));

  expect(await previewLemonadeSync(tj, lem)).toEqual([
    {
      repoId: 'org/stale',
      rev,
      moveCount: 0,
      dedupCount: 0,
      linkCount: 0,
      staleCount: 1,
    },
  ]);
  await fsp.rm(root, {recursive: true, force: true});
});

test('sync removes a dangling snapshot link and leaves healthy links alone', async () => {
  const {root, tj, lem} = await mkdirs();
  const rev = 'stale-run';
  await syncedRepo(lem, tj, 'org', 'stale', rev, {
    'kept.bin': 'KEPT',
    'gone.bin': 'GONE',
  });
  await fsp.rm(path.join(tj, 'org/stale/gone.bin'));

  const [result] = await syncLemonadeToTurboJumbo(tj, lem);
  expect(result.repoId).toBe('org/stale');
  expect(result.files).toContainEqual({
    repoPath: 'gone.bin',
    status: 'stale-removed',
  });
  expect(result.files).toContainEqual({
    repoPath: 'kept.bin',
    status: 'already-linked',
  });

  const snap = path.join(lem, `models--org--stale/snapshots/${rev}`);
  // The dangling link is gone; the healthy one still resolves.
  expect(existsSync(path.join(snap, 'gone.bin'))).toBe(false);
  expect(
    (await fsp.lstat(path.join(snap, 'gone.bin')).catch(() => null)) === null,
  ).toBe(true);
  expect(await fsp.readFile(path.join(snap, 'kept.bin'), 'utf8')).toBe('KEPT');

  // Idempotent: with the stale link cleared, a re-run finds nothing.
  expect(await syncLemonadeToTurboJumbo(tj, lem)).toEqual([]);
  await fsp.rm(root, {recursive: true, force: true});
});

// Put a model in Turbo Jumbo's flat layout with a sidecar recording repoCommit.
async function tjModel(
  tjBase: string,
  repoId: string,
  rev: string,
  files: Record<string, string>,
) {
  for (const [rel, content] of Object.entries(files)) {
    await write(tjBase, `${repoId}/${rel}`, content);
  }
  await write(
    tjBase,
    `${repoId}/tjmodel.json`,
    JSON.stringify({
      modelUrl: `https://huggingface.co/${repoId}`,
      repoId,
      repoCommit: rev,
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

test('materializes a catalog model Turbo Jumbo has but Lemonade lacks (symlinks + refs/main)', async () => {
  const {root, tj, lem} = await mkdirs();
  const rev = 'cafebabe0000';
  await tjModel(tj, 'org/cat', rev, {
    'model.gguf': 'WEIGHTS',
    'index.json': '{}',
  });

  // Preview lists it as a link, not a move/dedup.
  expect(await previewLemonadeSync(tj, lem, ['org/cat'])).toEqual([
    {
      repoId: 'org/cat',
      rev,
      moveCount: 0,
      dedupCount: 0,
      linkCount: 2,
      staleCount: 0,
    },
  ]);

  const [result] = await syncLemonadeToTurboJumbo(tj, lem, ['org/cat']);
  expect(result.rev).toBe(rev);
  expect(result.files.every((f) => f.status === 'materialized')).toBe(true);

  // Lemonade now has the cache layout, as symlinks into Turbo Jumbo.
  const snap = path.join(lem, `models--org--cat/snapshots/${rev}`);
  const link = path.join(snap, 'model.gguf');
  expect((await fsp.lstat(link)).isSymbolicLink()).toBe(true);
  expect(await fsp.readlink(link)).toBe(path.join(tj, 'org/cat/model.gguf'));
  expect(await fsp.readFile(link, 'utf8')).toBe('WEIGHTS');
  expect(
    await fsp.readFile(path.join(lem, 'models--org--cat/refs/main'), 'utf8'),
  ).toBe(rev);
  // Our sidecar isn't mirrored into Lemonade.
  expect(existsSync(path.join(snap, 'tjmodel.json'))).toBe(false);

  // Idempotent: every file is now linked, so a re-run does nothing.
  expect(await syncLemonadeToTurboJumbo(tj, lem, ['org/cat'])).toEqual([]);
  await fsp.rm(root, {recursive: true, force: true});
});

test('materializes files missing from an existing cache entry into its snapshot', async () => {
  const {root, tj, lem} = await mkdirs();
  // An existing, healthy cache entry for one file…
  await syncedRepo(lem, tj, 'org', 'grow', 'entry-rev', {'kept.bin': 'KEPT'});
  // …while Turbo Jumbo also holds a file the entry lacks. The sidecar records a
  // different repoCommit: the entry's own revision must win, so the new link
  // joins the existing snapshot instead of opening a second one.
  await write(tj, 'org/grow/new.gguf', 'NEW');
  await write(
    tj,
    'org/grow/tjmodel.json',
    JSON.stringify({
      modelUrl: 'https://huggingface.co/org/grow',
      repoId: 'org/grow',
      repoCommit: 'sidecar-rev',
      files: [],
    }),
  );

  expect(await previewLemonadeSync(tj, lem, ['org/grow'])).toEqual([
    {
      repoId: 'org/grow',
      rev: 'entry-rev',
      moveCount: 0,
      dedupCount: 0,
      linkCount: 1,
      staleCount: 0,
    },
  ]);

  const [result] = await syncLemonadeToTurboJumbo(tj, lem, ['org/grow']);
  expect(result.rev).toBe('entry-rev');
  expect(result.files).toEqual([
    {repoPath: 'new.gguf', status: 'materialized'},
  ]);

  const snap = path.join(lem, 'models--org--grow/snapshots/entry-rev');
  const link = path.join(snap, 'new.gguf');
  expect((await fsp.lstat(link)).isSymbolicLink()).toBe(true);
  expect(await fsp.readFile(link, 'utf8')).toBe('NEW');
  // The pre-existing link is untouched.
  expect(await fsp.readFile(path.join(snap, 'kept.bin'), 'utf8')).toBe('KEPT');

  // Idempotent: with the entry complete, a re-run does nothing.
  expect(await syncLemonadeToTurboJumbo(tj, lem, ['org/grow'])).toEqual([]);
  await fsp.rm(root, {recursive: true, force: true});
});

test('one sync clears a stale link and links the replacement file in', async () => {
  const {root, tj, lem} = await mkdirs();
  const rev = 'phi-rev';
  // The Phi-4 shape: the entry's only link went dangling (its quant was deleted
  // from Turbo Jumbo), while Turbo Jumbo holds a different quant.
  await syncedRepo(lem, tj, 'org', 'phi', rev, {'old-Q6.gguf': 'OLD'});
  await fsp.rm(path.join(tj, 'org/phi/old-Q6.gguf'));
  await write(tj, 'org/phi/new-Q4.gguf', 'NEW');
  await write(
    tj,
    'org/phi/tjmodel.json',
    JSON.stringify({
      modelUrl: 'https://huggingface.co/org/phi',
      repoId: 'org/phi',
      repoCommit: rev,
      files: [],
    }),
  );

  const results = await syncLemonadeToTurboJumbo(tj, lem, ['org/phi']);
  const files = results.flatMap((r) => r.files);
  expect(files).toContainEqual({
    repoPath: 'old-Q6.gguf',
    status: 'stale-removed',
  });
  expect(files).toContainEqual({
    repoPath: 'new-Q4.gguf',
    status: 'materialized',
  });

  const snap = path.join(lem, `models--org--phi/snapshots/${rev}`);
  expect(existsSync(path.join(snap, 'old-Q6.gguf'))).toBe(false);
  expect(await fsp.readFile(path.join(snap, 'new-Q4.gguf'), 'utf8')).toBe(
    'NEW',
  );
  await fsp.rm(root, {recursive: true, force: true});
});

test('materialize ignores hf-CLI .cache metadata alongside the weights', async () => {
  const {root, tj, lem} = await mkdirs();
  const rev = 'cache-rev';
  await tjModel(tj, 'org/hascache', rev, {'model.gguf': 'WEIGHTS'});
  await write(
    tj,
    'org/hascache/.cache/huggingface/download/model.gguf.metadata',
    'META',
  );

  expect(await previewLemonadeSync(tj, lem, ['org/hascache'])).toEqual([
    {
      repoId: 'org/hascache',
      rev,
      moveCount: 0,
      dedupCount: 0,
      linkCount: 1,
      staleCount: 0,
    },
  ]);

  const [result] = await syncLemonadeToTurboJumbo(tj, lem, ['org/hascache']);
  expect(result.files).toEqual([
    {repoPath: 'model.gguf', status: 'materialized'},
  ]);
  await fsp.rm(root, {recursive: true, force: true});
});

test('a dir holding only .cache metadata and sidecars is not a candidate', async () => {
  const {root, tj, lem} = await mkdirs();
  // The husk a deletion leaves behind: sidecars + hf-CLI download metadata,
  // no weights. It must not appear in the preview at all — not even blocked.
  await write(
    tj,
    'org/ghost/tjmodel.json',
    JSON.stringify({
      modelUrl: 'https://huggingface.co/org/ghost',
      repoId: 'org/ghost',
      files: [{path: 'model.gguf'}],
    }),
  );
  await write(tj, 'org/ghost/model.gguf.tjmeta.json', '{}');
  await write(
    tj,
    'org/ghost/.cache/huggingface/download/model.gguf.metadata',
    'META',
  );

  expect(await previewLemonadeSync(tj, lem, ['org/ghost'])).toEqual([]);
  expect(await syncLemonadeToTurboJumbo(tj, lem, ['org/ghost'])).toEqual([]);
  expect(existsSync(path.join(lem, 'models--org--ghost'))).toBe(false);
  await fsp.rm(root, {recursive: true, force: true});
});

test('does not materialize when Turbo Jumbo lacks the model or a recorded revision', async () => {
  const {root, tj, lem} = await mkdirs();
  // In TJ but no repoCommit recorded → can't name the snapshot dir. The model
  // is surfaced as blocked in the preview (not silently omitted), but a run
  // still won't touch it.
  await write(tj, 'org/norev/m.bin', 'X');
  await write(
    tj,
    'org/norev/tjmodel.json',
    JSON.stringify({
      modelUrl: 'https://huggingface.co/org/norev',
      repoId: 'org/norev',
      files: [],
    }),
  );
  // Not in TJ at all.
  const repoIds = ['org/norev', 'org/absent'];

  expect(await previewLemonadeSync(tj, lem, repoIds)).toEqual([
    {
      repoId: 'org/norev',
      rev: '',
      moveCount: 0,
      dedupCount: 0,
      linkCount: 0,
      staleCount: 0,
      blocked: 'no-revision',
    },
  ]);
  expect(await syncLemonadeToTurboJumbo(tj, lem, repoIds)).toEqual([]);
  expect(existsSync(path.join(lem, 'models--org--norev'))).toBe(false);
  await fsp.rm(root, {recursive: true, force: true});
});

test('a model without a sidecar at all is likewise surfaced as blocked', async () => {
  const {root, tj, lem} = await mkdirs();
  await write(tj, 'org/bare/m.bin', 'X');

  expect(await previewLemonadeSync(tj, lem, ['org/bare'])).toEqual([
    {
      repoId: 'org/bare',
      rev: '',
      moveCount: 0,
      dedupCount: 0,
      linkCount: 0,
      staleCount: 0,
      blocked: 'no-revision',
    },
  ]);
  expect(await syncLemonadeToTurboJumbo(tj, lem, ['org/bare'])).toEqual([]);
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
