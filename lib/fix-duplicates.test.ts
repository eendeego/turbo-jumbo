import {test, expect} from 'bun:test';
import {promises as fsp} from 'fs';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import {metaPath, writeMeta, readMetaResolved} from '@/lib/audit';
import {fixDuplicateGroup} from '@/lib/fix-duplicates';
import {clearHfCache} from '@/lib/hf-infer';

const sha = (content: string) =>
  crypto.createHash('sha256').update(content).digest('hex');

async function writeCopy(base: string, rel: string, content: string) {
  const full = path.join(base, rel);
  await fsp.mkdir(path.dirname(full), {recursive: true});
  await fsp.writeFile(full, content);
  return full;
}

// Give one copy a sidecar naming the o/r source, so resolveSource's sidecar
// fallback finds the repo even though inference (search) returns nothing.
async function writeSourceSidecar(full: string) {
  await writeMeta(full, {
    modelUrl: 'https://huggingface.co/o/r',
    originUrl: 'https://huggingface.co/o/r/blob/main/m.gguf',
    sourceSize: 0,
    computedSize: 0,
    sourceSha256: '',
    computedSha256: '',
  });
}

// One stub for the whole HF API surface the fix touches: model search
// (inference — always empty), the o/r file tree (the latest revision), the
// commit listing, and per-revision paths-info (history search).
function mockHf(opts: {
  tree: object[];
  commits?: Array<{id: string; date: string}>;
  revisions?: Record<string, object>;
}): typeof fetch {
  return (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes('/api/models?')) return new Response('[]', {status: 200});
    if (u.includes('/api/models/o/r/tree/main'))
      return new Response(JSON.stringify(opts.tree), {status: 200});
    if (u.includes('/api/models/o/r/commits/main'))
      return new Response(JSON.stringify(opts.commits ?? []), {status: 200});
    const rev = u.match(/\/api\/models\/o\/r\/paths-info\/(.+)$/);
    if (rev && opts.revisions?.[rev[1]])
      return new Response(JSON.stringify([opts.revisions[rev[1]]]), {
        status: 200,
      });
    return new Response('nf', {status: 404});
  }) as typeof fetch;
}

// Tree/paths-info entry for m.gguf with the given content and pinned commit.
function entry(content: string, commit?: {id: string; date: string}) {
  return {
    type: 'file',
    path: 'm.gguf',
    size: content.length,
    lfs: {oid: `sha256:${sha(content)}`, size: content.length},
    ...(commit ? {lastCommit: commit} : {}),
  };
}

const exists = (p: string) =>
  fsp.access(p).then(
    () => true,
    () => false,
  );

test('discards the invalid copy and moves the valid survivor to the expected path', async () => {
  clearHfCache();
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-dupfix-'));
  const goodFull = await writeCopy(base, 'm.gguf', 'good bytes');
  await writeSourceSidecar(goodFull);
  const badFull = await writeCopy(base, 'sub/m.gguf', 'corrupt!!!'); // same size, wrong sha
  await writeMeta(badFull, {
    modelUrl: '',
    originUrl: '',
    sourceSize: 0,
    computedSize: 10,
    sourceSha256: '',
    computedSha256: '',
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = mockHf({
    tree: [entry('good bytes', {id: 'c1', date: '2025-01-01T00:00:00.000Z'})],
    commits: [{id: 'c1', date: '2025-01-01T00:00:00.000Z'}],
    revisions: {
      c1: entry('good bytes', {id: 'c1', date: '2025-01-01T00:00:00.000Z'}),
    },
  });
  try {
    const results = await fixDuplicateGroup(
      base,
      ['m.gguf', 'sub/m.gguf'],
      'm',
      'm.gguf',
    );
    expect(results).toContainEqual({file: 'sub/m.gguf', status: 'deleted'});
    expect(results).toContainEqual({
      file: 'm.gguf',
      status: 'kept',
      to: 'o/r/m.gguf',
    });
    expect(await exists(path.join(base, 'sub/m.gguf'))).toBe(false);
    expect(await exists(metaPath(path.join(base, 'sub/m.gguf')))).toBe(false);
    expect(await exists(path.join(base, 'o/r/m.gguf'))).toBe(true);
    // The survivor's sidecar pins the verified revision and computed hash.
    const meta = await readMetaResolved(base, 'o/r/m.gguf');
    expect(meta?.sourceCommit).toBe('c1');
    expect(meta?.sourceSha256).toBe(sha('good bytes'));
    expect(meta?.computedSha256).toBe(sha('good bytes'));
    expect(meta?.computedSize).toBe(10);
  } finally {
    globalThis.fetch = realFetch;
    await fsp.rm(base, {recursive: true, force: true});
  }
});

test('keeps the newer of two valid revisions and deletes the older', async () => {
  clearHfCache();
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-dupfix-'));
  const newFull = await writeCopy(base, 'o/r/m.gguf', 'newest version');
  await writeSourceSidecar(newFull);
  await writeCopy(base, 'm.gguf', 'older one'); // matches historical c1

  const realFetch = globalThis.fetch;
  globalThis.fetch = mockHf({
    tree: [
      entry('newest version', {id: 'c2', date: '2025-02-02T00:00:00.000Z'}),
    ],
    commits: [
      {id: 'c2', date: '2025-02-02T00:00:00.000Z'},
      {id: 'c1', date: '2024-01-01T00:00:00.000Z'},
    ],
    revisions: {
      c2: entry('newest version', {
        id: 'c2',
        date: '2025-02-02T00:00:00.000Z',
      }),
      c1: entry('older one', {id: 'c1', date: '2024-01-01T00:00:00.000Z'}),
    },
  });
  try {
    const results = await fixDuplicateGroup(
      base,
      ['m.gguf', 'o/r/m.gguf'],
      'm',
      'm.gguf',
    );
    expect(results).toContainEqual({file: 'm.gguf', status: 'deleted'});
    expect(results).toContainEqual({file: 'o/r/m.gguf', status: 'kept'});
    expect(await exists(path.join(base, 'm.gguf'))).toBe(false);
    expect(await exists(path.join(base, 'o/r/m.gguf'))).toBe(true);
  } finally {
    globalThis.fetch = realFetch;
    await fsp.rm(base, {recursive: true, force: true});
  }
});

test('identical copies: keeps the one already at the expected path', async () => {
  clearHfCache();
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-dupfix-'));
  const placedFull = await writeCopy(base, 'o/r/m.gguf', 'same bytes');
  await writeSourceSidecar(placedFull);
  await writeCopy(base, 'm.gguf', 'same bytes');

  const realFetch = globalThis.fetch;
  globalThis.fetch = mockHf({
    tree: [entry('same bytes', {id: 'c1', date: '2025-01-01T00:00:00.000Z'})],
  });
  try {
    const results = await fixDuplicateGroup(
      base,
      ['m.gguf', 'o/r/m.gguf'],
      'm',
      'm.gguf',
    );
    expect(results).toContainEqual({file: 'm.gguf', status: 'deleted'});
    expect(results).toContainEqual({file: 'o/r/m.gguf', status: 'kept'});
    expect(await exists(path.join(base, 'm.gguf'))).toBe(false);
    expect(await exists(path.join(base, 'o/r/m.gguf'))).toBe(true);
  } finally {
    globalThis.fetch = realFetch;
    await fsp.rm(base, {recursive: true, force: true});
  }
});

test('identical copies with none placed: moves one to the expected path, deletes the rest', async () => {
  clearHfCache();
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-dupfix-'));
  const aFull = await writeCopy(base, 'a/m.gguf', 'same bytes');
  await writeSourceSidecar(aFull);
  await writeCopy(base, 'm.gguf', 'same bytes');
  await writeCopy(base, 'b/m.gguf', 'same bytes');

  const realFetch = globalThis.fetch;
  globalThis.fetch = mockHf({
    tree: [entry('same bytes', {id: 'c1', date: '2025-01-01T00:00:00.000Z'})],
  });
  try {
    const results = await fixDuplicateGroup(
      base,
      ['m.gguf', 'a/m.gguf', 'b/m.gguf'],
      'm',
      'm.gguf',
    );
    const kept = results.filter((r) => r.status === 'kept');
    expect(kept).toHaveLength(1);
    expect(kept[0].to).toBe('o/r/m.gguf');
    expect(results.filter((r) => r.status === 'deleted')).toHaveLength(2);
    expect(await exists(path.join(base, 'o/r/m.gguf'))).toBe(true);
    const survivors = await Promise.all(
      ['m.gguf', 'a/m.gguf', 'b/m.gguf'].map((p) => exists(path.join(base, p))),
    );
    expect(survivors).toEqual([false, false, false]);
  } finally {
    globalThis.fetch = realFetch;
    await fsp.rm(base, {recursive: true, force: true});
  }
});

test('no valid copy: skips the group and touches nothing', async () => {
  clearHfCache();
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-dupfix-'));
  const aFull = await writeCopy(base, 'm.gguf', 'corrupted1');
  await writeSourceSidecar(aFull);
  await writeCopy(base, 'sub/m.gguf', 'corrupted2');

  const realFetch = globalThis.fetch;
  globalThis.fetch = mockHf({
    tree: [entry('the truth', {id: 'c1', date: '2025-01-01T00:00:00.000Z'})],
    commits: [{id: 'c1', date: '2025-01-01T00:00:00.000Z'}],
    revisions: {
      c1: entry('the truth', {id: 'c1', date: '2025-01-01T00:00:00.000Z'}),
    },
  });
  try {
    const results = await fixDuplicateGroup(
      base,
      ['m.gguf', 'sub/m.gguf'],
      'm',
      'm.gguf',
    );
    expect(results).toEqual([
      {file: 'm.gguf', status: 'skipped', message: 'no valid copy'},
      {file: 'sub/m.gguf', status: 'skipped', message: 'no valid copy'},
    ]);
    expect(await exists(path.join(base, 'm.gguf'))).toBe(true);
    expect(await exists(path.join(base, 'sub/m.gguf'))).toBe(true);
  } finally {
    globalThis.fetch = realFetch;
    await fsp.rm(base, {recursive: true, force: true});
  }
});

test('unresolvable source: skips the group and touches nothing', async () => {
  clearHfCache();
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-dupfix-'));
  await writeCopy(base, 'm.gguf', 'data');
  await writeCopy(base, 'sub/m.gguf', 'data');

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response('nf', {status: 404})) as typeof fetch;
  try {
    const results = await fixDuplicateGroup(
      base,
      ['m.gguf', 'sub/m.gguf'],
      'm',
      'm.gguf',
    );
    expect(results).toEqual([
      {file: 'm.gguf', status: 'skipped', message: 'unverifiable'},
      {file: 'sub/m.gguf', status: 'skipped', message: 'unverifiable'},
    ]);
    expect(await exists(path.join(base, 'm.gguf'))).toBe(true);
    expect(await exists(path.join(base, 'sub/m.gguf'))).toBe(true);
  } finally {
    globalThis.fetch = realFetch;
    await fsp.rm(base, {recursive: true, force: true});
  }
});
