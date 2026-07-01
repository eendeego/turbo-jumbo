import {test, expect} from 'bun:test';
import {promises as fsp, readFileSync} from 'fs';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import {
  auditFile,
  auditFileUpdate,
  cachedResultFromMeta,
  copyFileWithMeta,
  decideStatus,
  decideUpdate,
  duplicateResult,
  expectedRelPath,
  hfSummary,
  isPlacedCorrectly,
  localSha256,
  mergeMeta,
  moveFileWithMeta,
  readMeta,
  refreshMetaSource,
  resolveSource,
  resumeOffset,
  updateMeta,
  writeMeta,
  metaPath,
  pathImpliedRepo,
  type TjMeta,
} from '@/lib/audit';
import {clearHfCache, type HfFileInfo} from '@/lib/hf-infer';

const hf: HfFileInfo = {
  repoId: 'o/r',
  branch: 'main',
  repoPath: 'M.Q4.gguf',
  commit: 'deadc0de',
  commitDate: '2024-02-19T10:57:45.000Z',
  size: 100,
  sha256: 'deadbeef',
};

// The expected on-disk layout mirrors HuggingFace: <repoId>/<repoPath>.
const placed = 'o/r/M.Q4.gguf';

test('pass when size, sha, and repoId/repoPath all match', () => {
  expect(
    decideStatus({
      hf,
      actualSize: 100,
      relPath: placed,
      computedSha256: 'deadbeef',
    }),
  ).toBe('pass');
});

test('unverifiable when no hf match', () => {
  expect(
    decideStatus({
      hf: null,
      actualSize: 100,
      relPath: 'x',
      computedSha256: 'y',
    }),
  ).toBe('unverifiable');
});

test('incomplete on size mismatch (before sha is considered)', () => {
  expect(
    decideStatus({
      hf,
      actualSize: 99,
      relPath: placed,
      computedSha256: 'deadbeef',
    }),
  ).toBe('incomplete');
});

test('checksum-mismatch when computed sha differs', () => {
  expect(
    decideStatus({
      hf,
      actualSize: 100,
      relPath: placed,
      computedSha256: 'other',
    }),
  ).toBe('checksum-mismatch');
});

test('misplaced when a file sits at the storage root instead of <repoId>/<repoPath>', () => {
  expect(
    decideStatus({
      hf,
      actualSize: 100,
      relPath: 'M.Q4.gguf',
      computedSha256: 'deadbeef',
    }),
  ).toBe('misplaced');
});

test('misplaced when the repo directory is wrong', () => {
  expect(
    decideStatus({
      hf,
      actualSize: 100,
      relPath: 'other/M.Q4.gguf',
      computedSha256: 'deadbeef',
    }),
  ).toBe('misplaced');
});

test('error when sha could not be computed despite matching size', () => {
  expect(
    decideStatus({
      hf,
      actualSize: 100,
      relPath: placed,
      computedSha256: null,
    }),
  ).toBe('error');
});

test('expectedRelPath joins repoId and repoPath', () => {
  expect(expectedRelPath(hf)).toBe('o/r/M.Q4.gguf');
});

test('decideStatus: a correctly-placed cache file passes, not misplaced', () => {
  expect(
    decideStatus({
      hf,
      actualSize: 100,
      relPath: 'models--o--r/snapshots/abc123/M.Q4.gguf',
      computedSha256: 'deadbeef',
    }),
  ).toBe('pass');
});

test('decideStatus: a cache file under the wrong repo dir is misplaced', () => {
  expect(
    decideStatus({
      hf, // repoId 'o/r', repoPath 'M.Q4.gguf'
      actualSize: 100,
      relPath: 'models--other--repo/snapshots/abc123/M.Q4.gguf',
      computedSha256: 'deadbeef',
    }),
  ).toBe('misplaced');
});

test('isPlacedCorrectly accepts the flat and cache layouts, rejects others', () => {
  expect(isPlacedCorrectly('o/r/M.Q4.gguf', 'o/r', 'M.Q4.gguf')).toBe(true);
  expect(
    isPlacedCorrectly('models--o--r/snapshots/x/M.Q4.gguf', 'o/r', 'M.Q4.gguf'),
  ).toBe(true);
  // Wrong repo dir.
  expect(
    isPlacedCorrectly('models--o--z/snapshots/x/M.Q4.gguf', 'o/r', 'M.Q4.gguf'),
  ).toBe(false);
  // Bare file at the storage root.
  expect(isPlacedCorrectly('M.Q4.gguf', 'o/r', 'M.Q4.gguf')).toBe(false);
});

test('duplicateResult names the other copies, not the file itself', () => {
  expect(duplicateResult('a/M.gguf', ['M.gguf', 'a/M.gguf'])).toEqual({
    file: 'a/M.gguf',
    status: 'duplicate',
    message: 'duplicate of M.gguf',
  });
  expect(
    duplicateResult('M.gguf', ['M.gguf', 'a/M.gguf', 'b/M.gguf'], true),
  ).toEqual({
    file: 'M.gguf',
    status: 'duplicate',
    message: 'duplicate of a/M.gguf, b/M.gguf',
    cached: true,
  });
});

const cachedMeta = {
  modelUrl: 'https://huggingface.co/o/r',
  originUrl: 'https://huggingface.co/o/r/blob/main/sub/M.Q4.gguf',
  sourceSize: 100,
  computedSize: 100,
  sourceSha256: 'deadbeef',
  computedSha256: 'deadbeef',
};

test('cachedResultFromMeta: pass when shas match and path is correct', () => {
  const r = cachedResultFromMeta('o/r/sub/M.Q4.gguf', cachedMeta);
  expect(r).toEqual({
    file: 'o/r/sub/M.Q4.gguf',
    status: 'pass',
    cached: true,
    hf: {
      repoId: 'o/r',
      modelUrl: 'https://huggingface.co/o/r',
      fileUrl: 'https://huggingface.co/o/r/blob/main/sub/M.Q4.gguf',
      expectedSize: 100,
      expectedSha256: 'deadbeef',
      expectedPath: 'o/r/sub/M.Q4.gguf',
    },
  });
});

test('cachedResultFromMeta: surfaces a commit permalink when the sidecar pins one', () => {
  const r = cachedResultFromMeta('o/r/sub/M.Q4.gguf', {
    ...cachedMeta,
    sourceCommit: 'deadc0de',
    sourceCommitDate: '2024-02-19T10:57:45.000Z',
  });
  expect(r.hf?.commit).toBe('deadc0de');
  expect(r.hf?.commitUrl).toBe(
    'https://huggingface.co/o/r/blob/deadc0de/sub/M.Q4.gguf',
  );
  expect(r.hf?.commitDate).toBe('2024-02-19T10:57:45.000Z');
});

test('cachedResultFromMeta: incomplete when the recorded on-disk size differs from the source', () => {
  const r = cachedResultFromMeta('o/r/sub/M.Q4.gguf', {
    ...cachedMeta,
    sourceSize: 100,
    computedSize: 50,
  });
  expect(r.status).toBe('incomplete');
  expect(r.message).toBe('size 50 != expected 100');
});

test('cachedResultFromMeta: a correctly-placed cache file is not misplaced', () => {
  const r = cachedResultFromMeta(
    'models--o--r/snapshots/abc123/sub/M.Q4.gguf',
    cachedMeta,
  );
  expect(r.status).toBe('pass');
});

test('cachedResultFromMeta: skips the size check for a legacy sidecar without computedSize', () => {
  // @ts-expect-error — legacy sidecars predate computedSize
  const r = cachedResultFromMeta('o/r/sub/M.Q4.gguf', {
    modelUrl: cachedMeta.modelUrl,
    originUrl: cachedMeta.originUrl,
    sourceSize: 100,
    sourceSha256: 'deadbeef',
    computedSha256: 'deadbeef',
  });
  expect(r.status).toBe('pass');
});

test('cachedResultFromMeta: checksum-mismatch when cached shas differ', () => {
  const r = cachedResultFromMeta('o/r/sub/M.Q4.gguf', {
    ...cachedMeta,
    computedSha256: 'other',
  });
  expect(r.status).toBe('checksum-mismatch');
  expect(r.cached).toBe(true);
});

test('cachedResultFromMeta: misplaced when current path differs from expected', () => {
  const r = cachedResultFromMeta('M.Q4.gguf', cachedMeta);
  expect(r.status).toBe('misplaced');
  expect(r.message).toBe('expected path o/r/sub/M.Q4.gguf');
});

test('cachedResultFromMeta: unverifiable when the audit never hashed the file', () => {
  // An interrupted audit can leave a sidecar with a source but no computed
  // hash — the comparison never happened, which is not a checksum mismatch.
  const r = cachedResultFromMeta('o/r/sub/M.Q4.gguf', {
    ...cachedMeta,
    computedSha256: '',
  });
  expect(r.status).toBe('unverifiable');
  expect(r.message).toBe('not hashed');
  expect(r.hf).toBeDefined(); // the source is still known and shown
});

test('cachedResultFromMeta: the size check wins over the not-hashed rule', () => {
  const r = cachedResultFromMeta('o/r/sub/M.Q4.gguf', {
    ...cachedMeta,
    computedSize: 50,
    computedSha256: '',
  });
  expect(r.status).toBe('incomplete');
});

test('cachedResultFromMeta: unverifiable when the sidecar has no source sha', () => {
  const r = cachedResultFromMeta('M.Q4.gguf', {
    modelUrl: '',
    originUrl: '',
    sourceSize: 0,
    computedSize: 42,
    sourceSha256: '',
    computedSha256: '',
  });
  expect(r.status).toBe('unverifiable');
  expect(r.hf).toBeUndefined();
});

test('hfSummary builds repo/file URLs, a commit permalink, and expected values', () => {
  expect(hfSummary(hf)).toEqual({
    repoId: 'o/r',
    modelUrl: 'https://huggingface.co/o/r',
    fileUrl: 'https://huggingface.co/o/r/blob/main/M.Q4.gguf',
    commit: 'deadc0de',
    commitUrl: 'https://huggingface.co/o/r/blob/deadc0de/M.Q4.gguf',
    commitDate: '2024-02-19T10:57:45.000Z',
    expectedSize: 100,
    expectedSha256: 'deadbeef',
    expectedPath: 'o/r/M.Q4.gguf',
  });
});

test('hfSummary omits commit fields when the source has no resolved commit', () => {
  const s = hfSummary({...hf, commit: ''});
  expect(s.commit).toBeUndefined();
  expect(s.commitUrl).toBeUndefined();
});

test('localSha256 reports hashed bytes as it reads', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-sha-'));
  const full = path.join(dir, 'm.gguf');
  const content = Buffer.from('hello world');
  await fsp.writeFile(full, content);
  const sha = crypto.createHash('sha256').update(content).digest('hex');

  const chunks: number[] = [];
  expect(await localSha256(full, undefined, (n) => chunks.push(n))).toBe(sha);
  // Progress covers every byte hashed.
  expect(chunks.reduce((a, b) => a + b, 0)).toBe(content.length);
  await fsp.rm(dir, {recursive: true, force: true});
});

test('localSha256 rejects when the signal is already aborted', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-sha-'));
  const full = path.join(dir, 'm.gguf');
  await fsp.writeFile(full, 'data');
  const ac = new AbortController();
  ac.abort();
  await expect(localSha256(full, ac.signal)).rejects.toThrow();
  await fsp.rm(dir, {recursive: true, force: true});
});

test('writeMeta/readMeta round-trip and metaPath naming', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-audit-'));
  const f = path.join(dir, 'M.Q4.gguf');
  await fsp.writeFile(f, 'x');
  const meta = {
    modelUrl: 'https://huggingface.co/o/r',
    originUrl: 'https://huggingface.co/o/r/blob/main/M.Q4.gguf',
    sourceSize: 100,
    computedSize: 100,
    sourceSha256: 'deadbeef',
    computedSha256: 'deadbeef',
  };
  await writeMeta(f, meta);
  expect(metaPath(f)).toBe(`${f}.tjmeta.json`);
  expect(await readMeta(f)).toEqual(meta);
  await fsp.rm(dir, {recursive: true, force: true});
});

const priorMeta: TjMeta = {
  modelUrl: 'https://huggingface.co/prior/repo',
  originUrl: 'https://huggingface.co/prior/repo/blob/main/m.gguf',
  sourceCommit: 'priorcommit',
  sourceCommitDate: '2024-01-01T00:00:00.000Z',
  sourceSize: 7,
  computedSize: 7,
  sourceSha256: 'priorsrc',
  computedSha256: 'priorcomputed',
};

test('mergeMeta takes the new source block wholesale when this run resolved one', () => {
  // The fresh source has no commit pin — the prior commit must not bleed into
  // it (that would fabricate a revision that never existed).
  const next: TjMeta = {
    modelUrl: 'https://huggingface.co/new/repo',
    originUrl: 'https://huggingface.co/new/repo/blob/main/m.gguf',
    sourceSize: 9,
    computedSize: 9,
    sourceSha256: 'newsrc',
    computedSha256: 'newcomputed',
  };
  expect(mergeMeta(priorMeta, next)).toEqual(next);
});

test('mergeMeta preserves the prior source block when this run resolved none', () => {
  const merged = mergeMeta(priorMeta, {
    modelUrl: '',
    originUrl: '',
    sourceSize: 0,
    computedSize: 7,
    sourceSha256: '',
    computedSha256: '',
  });
  expect(merged).toEqual({
    ...priorMeta,
    computedSize: 7,
    computedSha256: 'priorcomputed', // size unchanged, hash still valid
  });
});

test('mergeMeta drops the prior computed sha when the on-disk size changed', () => {
  const merged = mergeMeta(priorMeta, {
    modelUrl: '',
    originUrl: '',
    sourceSize: 0,
    computedSize: 12, // file grew since the prior audit
    sourceSha256: '',
    computedSha256: '',
  });
  expect(merged.computedSize).toBe(12);
  expect(merged.computedSha256).toBe('');
  expect(merged.sourceSha256).toBe('priorsrc'); // source block still preserved
});

test('mergeMeta with no prior sidecar returns the fresh meta as-is', () => {
  const next: TjMeta = {
    modelUrl: '',
    originUrl: '',
    sourceSize: 0,
    computedSize: 4,
    sourceSha256: '',
    computedSha256: '',
  };
  expect(mergeMeta(null, next)).toEqual(next);
});

test('updateMeta merges into the sidecar on disk', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-update-'));
  const full = path.join(dir, 'm.gguf');
  await fsp.writeFile(full, 'payload'); // 7 bytes, matching priorMeta
  await writeMeta(full, priorMeta);

  await updateMeta(full, {
    modelUrl: '',
    originUrl: '',
    sourceSize: 0,
    computedSize: 7,
    sourceSha256: '',
    computedSha256: '',
  });

  expect(await readMeta(full)).toEqual(priorMeta);
  await fsp.rm(dir, {recursive: true, force: true});
});

test('readMeta returns null when no sidecar exists', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-audit-'));
  expect(await readMeta(path.join(dir, 'nope.gguf'))).toBeNull();
  await fsp.rm(dir, {recursive: true, force: true});
});

const exists = (p: string) =>
  fsp
    .access(p)
    .then(() => true)
    .catch(() => false);

test('moveFileWithMeta relocates the file and its sidecar, creating dirs', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-move-'));
  const meta = {
    modelUrl: 'u',
    originUrl: 'o',
    sourceSize: 4,
    computedSize: 4,
    sourceSha256: 's',
    computedSha256: 'c',
  };
  await fsp.writeFile(path.join(base, 'M.Q4.gguf'), 'data');
  await writeMeta(path.join(base, 'M.Q4.gguf'), meta);

  await moveFileWithMeta(base, 'M.Q4.gguf', 'o/r/M.Q4.gguf');

  expect(await fsp.readFile(path.join(base, 'o/r/M.Q4.gguf'), 'utf8')).toBe(
    'data',
  );
  expect(await readMeta(path.join(base, 'o/r/M.Q4.gguf'))).toEqual(meta);
  expect(await exists(path.join(base, 'M.Q4.gguf'))).toBe(false);
  expect(await readMeta(path.join(base, 'M.Q4.gguf'))).toBeNull();

  await fsp.rm(base, {recursive: true, force: true});
});

test('moveFileWithMeta refuses to overwrite an existing destination', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-move-'));
  await fsp.writeFile(path.join(base, 'M.Q4.gguf'), 'a');
  await fsp.mkdir(path.join(base, 'o/r'), {recursive: true});
  await fsp.writeFile(path.join(base, 'o/r/M.Q4.gguf'), 'b');

  await expect(
    moveFileWithMeta(base, 'M.Q4.gguf', 'o/r/M.Q4.gguf'),
  ).rejects.toThrow();
  // source is left untouched on refusal
  expect(await fsp.readFile(path.join(base, 'M.Q4.gguf'), 'utf8')).toBe('a');

  await fsp.rm(base, {recursive: true, force: true});
});

test('moveFileWithMeta works when there is no sidecar', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-move-'));
  await fsp.writeFile(path.join(base, 'M.Q4.gguf'), 'data');

  await moveFileWithMeta(base, 'M.Q4.gguf', 'sub/M.Q4.gguf');

  expect(await fsp.readFile(path.join(base, 'sub/M.Q4.gguf'), 'utf8')).toBe(
    'data',
  );
  await fsp.rm(base, {recursive: true, force: true});
});

test('moveFileWithMeta rejects a target that escapes the storage root', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-move-'));
  await fsp.writeFile(path.join(base, 'M.Q4.gguf'), 'data');

  await expect(
    moveFileWithMeta(base, 'M.Q4.gguf', '../escape.gguf'),
  ).rejects.toThrow();

  await fsp.rm(base, {recursive: true, force: true});
});

test('pathImpliedRepo reads <org>/<repo>/<repoPath> from a placed file', () => {
  expect(
    pathImpliedRepo('unsloth/LFM2-1.2B-GGUF/LFM2-1.2B-Q4_K_M.gguf'),
  ).toEqual({
    repoId: 'unsloth/LFM2-1.2B-GGUF',
    repoPath: 'LFM2-1.2B-Q4_K_M.gguf',
  });
  // Deeper nesting belongs to the path within the repo.
  expect(pathImpliedRepo('org/repo/sub/dir/f.gguf')).toEqual({
    repoId: 'org/repo',
    repoPath: 'sub/dir/f.gguf',
  });
});

test('pathImpliedRepo is null for files not under an org/repo directory', () => {
  expect(pathImpliedRepo('f.gguf')).toBeNull();
  expect(pathImpliedRepo('repo/f.gguf')).toBeNull();
  // Segments that aren't valid HF ids can't name a repo.
  expect(pathImpliedRepo('or g/repo/f.gguf')).toBeNull();
  expect(pathImpliedRepo('org/re#po/f.gguf')).toBeNull();
});

test('resolveSource resolves a placed file from its repo directory, without searching', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-implied-'));
  const rel = 'unsloth/LFM2-1.2B-GGUF/LFM2-1.2B-Q4_K_M.gguf';
  const full = path.join(base, rel);
  await fsp.mkdir(path.dirname(full), {recursive: true});
  await fsp.writeFile(full, 'data'); // no sidecar

  const realFetch = globalThis.fetch;
  clearHfCache();
  let searched = false;
  globalThis.fetch = (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes('/api/models?')) {
      searched = true;
      return new Response('[]', {status: 200});
    }
    if (u.includes('/api/models/unsloth/LFM2-1.2B-GGUF/tree/main')) {
      return new Response(
        JSON.stringify([
          {
            type: 'file',
            path: 'LFM2-1.2B-Q4_K_M.gguf',
            size: 4,
            lfs: {oid: 'sha256:feed', size: 4},
            lastCommit: {id: 'c1', date: '2025-07-10T00:00:00.000Z'},
          },
        ]),
        {status: 200},
      );
    }
    return new Response('nf', {status: 404});
  }) as typeof fetch;

  try {
    const hf = await resolveSource(
      full,
      rel,
      'LFM2-1.2B',
      'LFM2-1.2B-Q4_K_M.gguf',
    );
    expect(hf?.repoId).toBe('unsloth/LFM2-1.2B-GGUF');
    expect(hf?.sha256).toBe('feed');
    // The placement names the repo — search (whose ranking drifts as newer
    // model families arrive) must not be consulted at all.
    expect(searched).toBe(false);
  } finally {
    globalThis.fetch = realFetch;
    clearHfCache();
    await fsp.rm(base, {recursive: true, force: true});
  }
});

test('resolveSource falls back to search when the path-implied repo misses', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-implied-'));
  const rel = 'not-a/real-repo/m2.gguf';
  const full = path.join(base, rel);
  await fsp.mkdir(path.dirname(full), {recursive: true});
  await fsp.writeFile(full, 'data');

  const realFetch = globalThis.fetch;
  clearHfCache();
  globalThis.fetch = (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes('/api/models?')) {
      return new Response(JSON.stringify([{id: 'found/by-search'}]), {
        status: 200,
      });
    }
    if (u.includes('/api/models/found/by-search/tree/main')) {
      return new Response(
        JSON.stringify([
          {
            type: 'file',
            path: 'm2.gguf',
            size: 4,
            lfs: {oid: 'sha256:cafe', size: 4},
          },
        ]),
        {status: 200},
      );
    }
    return new Response('nf', {status: 404}); // the implied repo doesn't exist
  }) as typeof fetch;

  try {
    const hf = await resolveSource(full, rel, 'm2', 'm2.gguf');
    expect(hf?.repoId).toBe('found/by-search');
  } finally {
    globalThis.fetch = realFetch;
    clearHfCache();
    await fsp.rm(base, {recursive: true, force: true});
  }
});

test('resolveSource resolves a cache-layout file from its decoded repo', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-cache-'));
  const rel =
    'models--unsloth--Qwen3-0.6B-GGUF/snapshots/abc123/Qwen3-0.6B-Q4_0.gguf';
  const full = path.join(base, rel);
  await fsp.mkdir(path.dirname(full), {recursive: true});
  await fsp.writeFile(full, 'data');

  const realFetch = globalThis.fetch;
  clearHfCache();
  let searched = false;
  globalThis.fetch = (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes('/api/models?')) {
      searched = true;
      return new Response('[]', {status: 200});
    }
    if (u.includes('/api/models/unsloth/Qwen3-0.6B-GGUF/tree/main')) {
      return new Response(
        JSON.stringify([
          {
            type: 'file',
            path: 'Qwen3-0.6B-Q4_0.gguf',
            size: 4,
            lfs: {oid: 'sha256:feed', size: 4},
          },
        ]),
        {status: 200},
      );
    }
    return new Response('nf', {status: 404});
  }) as typeof fetch;

  try {
    const out = await resolveSource(
      full,
      rel,
      'Qwen3-0.6B',
      'Qwen3-0.6B-Q4_0.gguf',
    );
    expect(out?.repoId).toBe('unsloth/Qwen3-0.6B-GGUF');
    expect(out?.sha256).toBe('feed');
    // Resolved straight from the decoded repo — no name search needed.
    expect(searched).toBe(false);
  } finally {
    globalThis.fetch = realFetch;
    clearHfCache();
    await fsp.rm(base, {recursive: true, force: true});
  }
});

test('resolveSource falls back to the sidecar source when inference fails', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-resolve-'));
  const full = path.join(base, 'GPT.gguf');
  await fsp.writeFile(full, 'data');
  // A manually-set source, recorded by the set-source flow.
  await writeMeta(full, {
    modelUrl: 'https://huggingface.co/Hauhau/Repo',
    originUrl: 'https://huggingface.co/Hauhau/Repo/blob/main/GPT.gguf',
    sourceSize: 7,
    computedSize: 7,
    sourceSha256: 'feed',
    computedSha256: 'feed',
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes('/api/models?')) return new Response('[]', {status: 200}); // inference: no match
    if (u.includes('/api/models/Hauhau/Repo/tree/main')) {
      return new Response(
        JSON.stringify([
          {
            type: 'file',
            path: 'GPT.gguf',
            size: 7,
            lfs: {oid: 'sha256:feed', size: 7},
          },
        ]),
        {status: 200},
      );
    }
    return new Response('nf', {status: 404});
  }) as typeof fetch;

  try {
    const hf = await resolveSource(full, 'GPT.gguf', 'GPT', 'GPT.gguf');
    expect(hf).toEqual({
      repoId: 'Hauhau/Repo',
      branch: 'main',
      repoPath: 'GPT.gguf',
      // The tree entry carries no lastCommit here — commit/date degrade to ''.
      commit: '',
      commitDate: '',
      size: 7,
      sha256: 'feed',
    });
    // The Fix target is derived from this, so it agrees with the audit verdict.
    expect(expectedRelPath(hf!)).toBe('Hauhau/Repo/GPT.gguf');
  } finally {
    globalThis.fetch = realFetch;
    await fsp.rm(base, {recursive: true, force: true});
  }
});

test('resolveSource resolves a commit-pinned sidecar source at the branch head', async () => {
  const pin = '2d03716c45a1d5d5b8a82984e9ee3d39c2a5e69f';
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-resolve-'));
  const full = path.join(base, 'Pinned.gguf');
  await fsp.writeFile(full, 'data');
  // A commit permalink pasted into Set source… pins an old revision. Later
  // audits must still compare against the branch head — resolving at the pin
  // would make every newer revision invisible.
  await writeMeta(full, {
    modelUrl: 'https://huggingface.co/Pin/Repo',
    originUrl: `https://huggingface.co/Pin/Repo/blob/${pin}/Pinned.gguf`,
    sourceSize: 7,
    computedSize: 7,
    sourceSha256: 'oldsha',
    computedSha256: 'oldsha',
  });

  const realFetch = globalThis.fetch;
  clearHfCache();
  globalThis.fetch = (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes('/api/models?')) return new Response('[]', {status: 200}); // inference: no match
    if (u.includes('/api/models/Pin/Repo/tree/main')) {
      return new Response(
        JSON.stringify([
          {
            type: 'file',
            path: 'Pinned.gguf',
            size: 9,
            lfs: {oid: 'sha256:newsha', size: 9},
            lastCommit: {id: 'newcommit', date: '2026-01-01T00:00:00.000Z'},
          },
        ]),
        {status: 200},
      );
    }
    if (u.includes(`/api/models/Pin/Repo/tree/${pin}`)) {
      // The repo as of the pinned commit — must not be what gets resolved.
      return new Response(
        JSON.stringify([
          {
            type: 'file',
            path: 'Pinned.gguf',
            size: 7,
            lfs: {oid: 'sha256:oldsha', size: 7},
            lastCommit: {id: pin, date: '2025-02-28T00:00:00.000Z'},
          },
        ]),
        {status: 200},
      );
    }
    return new Response('nf', {status: 404});
  }) as typeof fetch;

  try {
    const hf = await resolveSource(
      full,
      'Pinned.gguf',
      'Pinned',
      'Pinned.gguf',
    );
    expect(hf).toEqual({
      repoId: 'Pin/Repo',
      branch: 'main',
      repoPath: 'Pinned.gguf',
      commit: 'newcommit',
      commitDate: '2026-01-01T00:00:00.000Z',
      size: 9,
      sha256: 'newsha',
    });
  } finally {
    globalThis.fetch = realFetch;
    clearHfCache();
    await fsp.rm(base, {recursive: true, force: true});
  }
});

test('refreshMetaSource backfills size/sha from the source, keeping the computed sha', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-refresh-'));
  const full = path.join(dir, 'm.gguf');
  await fsp.writeFile(full, 'data');
  // A legacy sidecar without sourceSize, naming a stale source.
  await writeMeta(full, {
    modelUrl: 'https://huggingface.co/old/repo',
    originUrl: 'https://huggingface.co/old/repo/blob/main/m.gguf',
    sourceSize: 0,
    computedSize: 0,
    sourceSha256: 'stale',
    computedSha256: 'computed',
  });

  await refreshMetaSource(full, {
    repoId: 'o/r',
    branch: 'main',
    repoPath: 'm.gguf',
    commit: 'freshcommit',
    commitDate: '2025-06-01T12:00:00.000Z',
    size: 4,
    sha256: 'fresh',
  });

  expect(await readMeta(full)).toEqual({
    modelUrl: 'https://huggingface.co/o/r',
    originUrl: 'https://huggingface.co/o/r/blob/main/m.gguf',
    sourceCommit: 'freshcommit',
    sourceCommitDate: '2025-06-01T12:00:00.000Z',
    sourceSize: 4,
    computedSize: 4, // 'data' is 4 bytes, observed by stat
    sourceSha256: 'fresh',
    computedSha256: 'computed', // preserved — a relocation doesn't change bytes
  });
  await fsp.rm(dir, {recursive: true, force: true});
});

test('refreshMetaSource hashes the file when no prior computed sha exists', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-refresh-'));
  const full = path.join(dir, 'm.gguf');
  const content = Buffer.from('hello world');
  await fsp.writeFile(full, content);
  const sha = crypto.createHash('sha256').update(content).digest('hex');

  // No sidecar at all: the computed sha must be recomputed from disk.
  await refreshMetaSource(full, {
    repoId: 'o/r',
    branch: 'main',
    repoPath: 'm.gguf',
    commit: '',
    commitDate: '',
    size: content.length,
    sha256: sha,
  });

  const meta = await readMeta(full);
  expect(meta?.sourceSize).toBe(content.length);
  expect(meta?.computedSha256).toBe(sha);
  await fsp.rm(dir, {recursive: true, force: true});
});

test('copyFileWithMeta copies the file and its sidecar, reporting bytes', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-cp-'));
  const src = path.join(base, 'm.gguf');
  await fsp.writeFile(src, 'payload');
  await writeMeta(src, {
    modelUrl: 'https://huggingface.co/o/r',
    originUrl: 'https://huggingface.co/o/r/blob/main/m.gguf',
    sourceSize: 7,
    computedSize: 7,
    sourceSha256: 's',
    computedSha256: 'c',
  });
  const dst = path.join(base, 'cold', 'sub', 'm.gguf');

  let bytes = 0;
  await copyFileWithMeta(src, dst, (n) => {
    bytes += n;
  });

  expect(await fsp.readFile(dst, 'utf8')).toBe('payload');
  expect(bytes).toBe('payload'.length);
  expect((await readMeta(dst))?.sourceSha256).toBe('s');
  // Source untouched (this is a copy, not a move).
  expect(await readMeta(src)).not.toBeNull();
  await fsp.rm(base, {recursive: true, force: true});
});

test('copyFileWithMeta resumes a matching partial destination', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-cp-'));
  const src = path.join(base, 'm.gguf');
  await fsp.writeFile(src, 'hello world');
  const dst = path.join(base, 'cold', 'm.gguf');
  await fsp.mkdir(path.dirname(dst), {recursive: true});
  await fsp.writeFile(dst, 'hello'); // interrupted earlier copy

  const chunks: number[] = [];
  await copyFileWithMeta(src, dst, (n) => chunks.push(n));

  expect(await fsp.readFile(dst, 'utf8')).toBe('hello world');
  // The skipped prefix is reported up front, then only the remainder streams.
  expect(chunks[0]).toBe('hello'.length);
  expect(chunks.reduce((a, b) => a + b, 0)).toBe('hello world'.length);
  await fsp.rm(base, {recursive: true, force: true});
});

test('resumeOffset reports verification progress over both hashed regions', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-cp-'));
  const src = path.join(base, 'm.gguf');
  await fsp.writeFile(src, 'hello world');
  const dst = path.join(base, 'cold', 'm.gguf');
  await fsp.mkdir(path.dirname(dst), {recursive: true});
  await fsp.writeFile(dst, 'hello');

  const seen: Array<[number, number]> = [];
  const offset = await resumeOffset(src, dst, (done, total) =>
    seen.push([done, total]),
  );

  expect(offset).toBe('hello'.length);
  // Both the partial and the source region get hashed: total is twice the
  // partial's size, and progress ends at that total.
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every(([, total]) => total === 'hello'.length * 2)).toBe(true);
  expect(seen[seen.length - 1][0]).toBe('hello'.length * 2);
  await fsp.rm(base, {recursive: true, force: true});
});

test('resumeOffset never calls onVerify when there is no partial to hash', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-cp-'));
  const src = path.join(base, 'm.gguf');
  await fsp.writeFile(src, 'hello world');
  const dst = path.join(base, 'cold', 'm.gguf'); // absent

  let calls = 0;
  const offset = await resumeOffset(src, dst, () => calls++);

  expect(offset).toBe(0);
  expect(calls).toBe(0);
  await fsp.rm(base, {recursive: true, force: true});
});

test('copyFileWithMeta recopies from scratch when the partial destination differs', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-cp-'));
  const src = path.join(base, 'm.gguf');
  await fsp.writeFile(src, 'hello world');
  const dst = path.join(base, 'cold', 'm.gguf');
  await fsp.mkdir(path.dirname(dst), {recursive: true});
  await fsp.writeFile(dst, 'XXXXX'); // same length as 'hello', different bytes

  let bytes = 0;
  await copyFileWithMeta(src, dst, (n) => (bytes += n));

  expect(await fsp.readFile(dst, 'utf8')).toBe('hello world');
  expect(bytes).toBe('hello world'.length);
  await fsp.rm(base, {recursive: true, force: true});
});

test('copyFileWithMeta recopies when the destination is longer than the source', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-cp-'));
  const src = path.join(base, 'm.gguf');
  await fsp.writeFile(src, 'short');
  const dst = path.join(base, 'cold', 'm.gguf');
  await fsp.mkdir(path.dirname(dst), {recursive: true});
  await fsp.writeFile(dst, 'much longer stale content');

  await copyFileWithMeta(src, dst);

  expect(await fsp.readFile(dst, 'utf8')).toBe('short');
  await fsp.rm(base, {recursive: true, force: true});
});

test('copyFileWithMeta skips the stream when the destination is already complete', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-cp-'));
  const src = path.join(base, 'm.gguf');
  await fsp.writeFile(src, 'hello world');
  const dst = path.join(base, 'cold', 'm.gguf');
  await fsp.mkdir(path.dirname(dst), {recursive: true});
  await fsp.writeFile(dst, 'hello world');

  const chunks: number[] = [];
  await copyFileWithMeta(src, dst, (n) => chunks.push(n));

  expect(await fsp.readFile(dst, 'utf8')).toBe('hello world');
  // Progress still sums to the full size, in a single skipped-prefix report.
  expect(chunks).toEqual(['hello world'.length]);
  await fsp.rm(base, {recursive: true, force: true});
});

test('copyFileWithMeta tolerates a file with no sidecar', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-cp-'));
  const src = path.join(base, 'm.gguf');
  await fsp.writeFile(src, 'data');
  const dst = path.join(base, 'cold', 'm.gguf');

  await copyFileWithMeta(src, dst);

  expect(await fsp.readFile(dst, 'utf8')).toBe('data');
  expect(await readMeta(dst)).toBeNull();
  await fsp.rm(base, {recursive: true, force: true});
});

test('auditFile still writes a sidecar when the file is unverifiable (no source)', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-unver-'));
  const rel = 'mystery.gguf';
  const full = path.join(base, rel);
  await fsp.writeFile(full, 'somebytes');

  // Inference finds nothing and there's no prior sidecar → unverifiable.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes('/api/models?')) return new Response('[]', {status: 200});
    return new Response('nf', {status: 404});
  }) as typeof fetch;
  clearHfCache();
  try {
    const result = await auditFile(base, rel, 'mystery', 'mystery.gguf');
    expect(result.status).toBe('unverifiable');
    expect(result.hf).toBeUndefined();
    const meta = await readMeta(full);
    expect(meta).not.toBeNull();
    expect(meta?.sourceSha256).toBe(''); // no source resolved
    expect(meta?.computedSha256).toBe(''); // not hashed without a source to compare
    expect(meta?.computedSize).toBe('somebytes'.length); // on-disk size is always recorded
  } finally {
    globalThis.fetch = realFetch;
    clearHfCache();
    await fsp.rm(base, {recursive: true, force: true});
  }
});

test('auditFile writes a sidecar for a size-mismatched (incomplete) file', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-incomplete-'));
  const rel = 'o/r/m.gguf';
  const full = path.join(base, rel);
  await fsp.mkdir(path.dirname(full), {recursive: true});
  const content = Buffer.from('short'); // 5 bytes — a partial download
  await fsp.writeFile(full, content);
  const sha = crypto.createHash('sha256').update(content).digest('hex');

  const source: HfFileInfo = {
    repoId: 'o/r',
    branch: 'main',
    repoPath: 'm.gguf',
    commit: '',
    commitDate: '',
    size: 999, // expected, doesn't match the 5 bytes on disk
    sha256: 'expectedsha',
  };

  // The size mismatch triggers a revision-history search; none is reachable.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response('nf', {status: 404})) as typeof fetch;
  try {
    const result = await auditFile(base, rel, '', 'm.gguf', undefined, source);
    expect(result.status).toBe('incomplete');
    // The failure carries the local file's observed values for the
    // checked-revisions view — hashed despite the size mismatch.
    expect(result.computedSize).toBe(5);
    expect(result.computedSha256).toBe(sha);
    const meta = await readMeta(full);
    expect(meta?.sourceSize).toBe(999);
    expect(meta?.computedSize).toBe(5);
    expect(meta?.sourceSha256).toBe('expectedsha');
    expect(meta?.computedSha256).toBe(sha);
  } finally {
    globalThis.fetch = realFetch;
    await fsp.rm(base, {recursive: true, force: true});
  }
});

// Mock the HF history endpoints: a commits listing and per-revision paths-info.
// `revisions` maps a commit id to the file's tree entry at that revision.
function mockHfHistory(
  repoId: string,
  commits: Array<{id: string; date: string}>,
  revisions: Record<string, object>,
): typeof fetch {
  return (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes(`/api/models/${repoId}/commits/main`))
      return new Response(JSON.stringify(commits), {status: 200});
    const rev = u.match(new RegExp(`/api/models/${repoId}/paths-info/(.+)$`));
    if (rev && revisions[rev[1]])
      return new Response(JSON.stringify([revisions[rev[1]]]), {status: 200});
    return new Response('nf', {status: 404});
  }) as typeof fetch;
}

test('auditFile passes a size-mismatched file that matches an earlier revision', async () => {
  clearHfCache();
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-hist-'));
  const rel = 'h/r1/m.gguf';
  const full = path.join(base, rel);
  await fsp.mkdir(path.dirname(full), {recursive: true});
  const content = Buffer.from('old version'); // 11 bytes, not the latest's 100
  await fsp.writeFile(full, content);
  const sha = crypto.createHash('sha256').update(content).digest('hex');

  const source: HfFileInfo = {
    repoId: 'h/r1',
    branch: 'main',
    repoPath: 'm.gguf',
    commit: 'c2',
    commitDate: '2025-01-02T00:00:00.000Z',
    size: 100,
    sha256: 'deadbeef',
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = mockHfHistory(
    'h/r1',
    [
      {id: 'c2', date: '2025-01-02T00:00:00.000Z'},
      {id: 'c1', date: '2024-01-01T00:00:00.000Z'},
    ],
    {
      // c2 is the already-failed latest version (same sha) — skipped unhashed.
      c2: {
        type: 'file',
        path: 'm.gguf',
        size: 100,
        lfs: {oid: 'sha256:deadbeef', size: 100},
      },
      c1: {
        type: 'file',
        path: 'm.gguf',
        size: content.length,
        lfs: {oid: `sha256:${sha}`, size: content.length},
        lastCommit: {id: 'c1', date: '2024-01-01T00:00:00.000Z'},
      },
    },
  );
  try {
    const result = await auditFile(base, rel, '', 'm.gguf', undefined, source);
    expect(result.status).toBe('pass');
    expect(result.message).toBe('matches earlier revision c1, not the latest');
    expect(result.hf?.commit).toBe('c1');
    expect(result.hf?.commitUrl).toBe(
      'https://huggingface.co/h/r1/blob/c1/m.gguf',
    );
    expect(result.hf?.expectedSize).toBe(content.length);
    expect(result.revisionsChecked).toBeUndefined(); // only reported on failure
    // The sidecar pins the matched revision, so a cached audit re-derives pass.
    const meta = await readMeta(full);
    expect(meta?.sourceCommit).toBe('c1');
    expect(meta?.sourceSize).toBe(content.length);
    expect(meta?.sourceSha256).toBe(sha);
    expect(meta?.computedSha256).toBe(sha);
  } finally {
    globalThis.fetch = realFetch;
    await fsp.rm(base, {recursive: true, force: true});
  }
});

test('auditFile passes a checksum-mismatched file that matches an earlier revision', async () => {
  clearHfCache();
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-hist-'));
  const rel = 'h/r2/m.gguf';
  const full = path.join(base, rel);
  await fsp.mkdir(path.dirname(full), {recursive: true});
  const content = Buffer.from('hello world');
  await fsp.writeFile(full, content);
  const sha = crypto.createHash('sha256').update(content).digest('hex');

  const source: HfFileInfo = {
    repoId: 'h/r2',
    branch: 'main',
    repoPath: 'm.gguf',
    commit: 'c2',
    commitDate: '2025-01-02T00:00:00.000Z',
    size: content.length, // same size as on disk…
    sha256: 'deadbeef', // …but different bytes
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = mockHfHistory(
    'h/r2',
    [{id: 'c1', date: '2024-01-01T00:00:00.000Z'}],
    {
      // No lastCommit in the entry — the inspected revision is the fallback.
      c1: {
        type: 'file',
        path: 'm.gguf',
        size: content.length,
        lfs: {oid: `sha256:${sha}`, size: content.length},
      },
    },
  );
  try {
    const result = await auditFile(base, rel, '', 'm.gguf', undefined, source);
    expect(result.status).toBe('pass');
    expect(result.message).toBe('matches earlier revision c1, not the latest');
    expect(result.hf?.commit).toBe('c1');
    expect(result.hf?.commitDate).toBe('2024-01-01T00:00:00.000Z');
    expect((await readMeta(full))?.sourceSha256).toBe(sha);
  } finally {
    globalThis.fetch = realFetch;
    await fsp.rm(base, {recursive: true, force: true});
  }
});

test('auditFile stays incomplete when no earlier revision matches', async () => {
  clearHfCache();
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-hist-'));
  const rel = 'h/r3/m.gguf';
  const full = path.join(base, rel);
  await fsp.mkdir(path.dirname(full), {recursive: true});
  const content = Buffer.from('eleven bytes'); // 12 bytes
  await fsp.writeFile(full, content);
  const sha = crypto.createHash('sha256').update(content).digest('hex');

  const source: HfFileInfo = {
    repoId: 'h/r3',
    branch: 'main',
    repoPath: 'm.gguf',
    commit: 'c2',
    commitDate: '2025-01-02T00:00:00.000Z',
    size: 100,
    sha256: 'deadbeef',
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = mockHfHistory(
    'h/r3',
    [{id: 'c1', date: '2024-01-01T00:00:00.000Z'}],
    {
      c1: {
        type: 'file',
        path: 'm.gguf',
        size: 50, // no revision has the on-disk size
        lfs: {oid: 'sha256:cafe', size: 50},
      },
    },
  );
  try {
    const result = await auditFile(base, rel, '', 'm.gguf', undefined, source);
    expect(result.status).toBe('incomplete');
    expect(result.message).toBe('size 12 != expected 100');
    // Every revision that was ruled out is reported, the latest first.
    expect(result.revisionsChecked).toEqual([
      {
        commit: 'c2',
        commitDate: '2025-01-02T00:00:00.000Z',
        commitUrl: 'https://huggingface.co/h/r3/blob/c2/m.gguf',
        size: 100,
        sha256: 'deadbeef',
        result: 'size-mismatch',
      },
      {
        commit: 'c1',
        commitDate: '2024-01-01T00:00:00.000Z',
        commitUrl: 'https://huggingface.co/h/r3/blob/c1/m.gguf',
        size: 50,
        sha256: 'cafe',
        result: 'size-mismatch',
      },
    ]);
    // The local file's observed values ride along for comparison; even though
    // no revision had a matching size, the hash is computed for the view.
    expect(result.computedSize).toBe(12);
    expect(result.computedSha256).toBe(sha);
    // Still pinned to the latest revision.
    const meta = await readMeta(full);
    expect(meta?.sourceSha256).toBe('deadbeef');
    expect(meta?.computedSha256).toBe(sha);
  } finally {
    globalThis.fetch = realFetch;
    await fsp.rm(base, {recursive: true, force: true});
  }
});

// Mock the full revision pipeline for a repo whose sidecar pins `pin`: name
// inference finds nothing, the branch head is `latest`, the tree at the pinned
// commit is `pinned`, and history walks `commits` with per-revision paths-info
// from `revisions`. Routes everything an audit driven by a pinned sidecar hits.
function mockPinnedRepo(
  repoId: string,
  pin: string,
  latest: object,
  pinned: object,
  commits: Array<{id: string; date: string}>,
  revisions: Record<string, object>,
): typeof fetch {
  return (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes('/api/models?')) return new Response('[]', {status: 200});
    if (u.includes(`/api/models/${repoId}/tree/main`))
      return new Response(JSON.stringify([latest]), {status: 200});
    if (u.includes(`/api/models/${repoId}/tree/${pin}`))
      return new Response(JSON.stringify([pinned]), {status: 200});
    if (u.includes(`/api/models/${repoId}/commits/main`))
      return new Response(JSON.stringify(commits), {status: 200});
    const rev = u.match(new RegExp(`/api/models/${repoId}/paths-info/(.+)$`));
    if (rev && revisions[rev[1]])
      return new Response(JSON.stringify([revisions[rev[1]]]), {status: 200});
    return new Response('nf', {status: 404});
  }) as typeof fetch;
}

test('auditFile passes an older on-disk version whose sidecar pins an old commit', async () => {
  clearHfCache();
  const pin = 'c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1';
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-pin-'));
  const rel = 'h/r4/m.gguf';
  const full = path.join(base, rel);
  await fsp.mkdir(path.dirname(full), {recursive: true});
  const content = Buffer.from('old version'); // 11 bytes; the head is 100
  await fsp.writeFile(full, content);
  const sha = crypto.createHash('sha256').update(content).digest('hex');
  // The sidecar pins the commit that produced this older version.
  await writeMeta(full, {
    modelUrl: 'https://huggingface.co/h/r4',
    originUrl: `https://huggingface.co/h/r4/blob/${pin}/m.gguf`,
    sourceSize: content.length,
    computedSize: content.length,
    sourceSha256: sha,
    computedSha256: sha,
  });

  const oldEntry = {
    type: 'file',
    path: 'm.gguf',
    size: content.length,
    lfs: {oid: `sha256:${sha}`, size: content.length},
    lastCommit: {id: 'c1', date: '2024-01-01T00:00:00.000Z'},
  };
  const latestEntry = {
    type: 'file',
    path: 'm.gguf',
    size: 100,
    lfs: {oid: 'sha256:deadbeef', size: 100},
    lastCommit: {id: 'c2', date: '2025-01-02T00:00:00.000Z'},
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockPinnedRepo(
    'h/r4',
    pin,
    latestEntry,
    oldEntry,
    [
      {id: 'c2', date: '2025-01-02T00:00:00.000Z'},
      {id: 'c1', date: '2024-01-01T00:00:00.000Z'},
    ],
    {c2: latestEntry, c1: oldEntry},
  );
  try {
    const result = await auditFile(base, rel, 'm', 'm.gguf');
    // It matches an older revision — that's a pass, found by walking the
    // branch history from the head, not by trusting the pin as "latest".
    expect(result.status).toBe('pass');
    expect(result.message).toBe('matches earlier revision c1, not the latest');
    expect(result.hf?.commit).toBe('c1');
    // The sidecar is re-anchored to the branch, not the pinned commit, so the
    // next audit also compares against the real head.
    const meta = await readMeta(full);
    expect(meta?.originUrl).toBe(
      'https://huggingface.co/h/r4/blob/main/m.gguf',
    );
    expect(meta?.sourceCommit).toBe('c1');
  } finally {
    globalThis.fetch = realFetch;
    clearHfCache();
    await fsp.rm(base, {recursive: true, force: true});
  }
});

test('auditFile passes a current file whose sidecar pins an outdated commit', async () => {
  clearHfCache();
  const pin = 'c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1';
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-pin-'));
  const rel = 'h/r5/m.gguf';
  const full = path.join(base, rel);
  await fsp.mkdir(path.dirname(full), {recursive: true});
  const content = Buffer.from('new version!'); // the current head revision
  await fsp.writeFile(full, content);
  const sha = crypto.createHash('sha256').update(content).digest('hex');
  // A stale sidecar pin from before the file was updated to the new revision.
  await writeMeta(full, {
    modelUrl: 'https://huggingface.co/h/r5',
    originUrl: `https://huggingface.co/h/r5/blob/${pin}/m.gguf`,
    sourceSize: 7,
    computedSize: 7,
    sourceSha256: 'oldsha',
    computedSha256: 'oldsha',
  });

  const latestEntry = {
    type: 'file',
    path: 'm.gguf',
    size: content.length,
    lfs: {oid: `sha256:${sha}`, size: content.length},
    lastCommit: {id: 'c2', date: '2025-01-02T00:00:00.000Z'},
  };
  const oldEntry = {
    type: 'file',
    path: 'm.gguf',
    size: 7,
    lfs: {oid: 'sha256:oldsha', size: 7},
    lastCommit: {id: 'c1', date: '2024-01-01T00:00:00.000Z'},
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockPinnedRepo('h/r5', pin, latestEntry, oldEntry, [], {});
  try {
    const result = await auditFile(base, rel, 'm', 'm.gguf');
    // The file IS the current revision: a clean pass against the head, no
    // historical-match note.
    expect(result.status).toBe('pass');
    expect(result.message).toBeUndefined();
    expect(result.hf?.commit).toBe('c2');
    const meta = await readMeta(full);
    expect(meta?.originUrl).toBe(
      'https://huggingface.co/h/r5/blob/main/m.gguf',
    );
    expect(meta?.sourceSha256).toBe(sha);
  } finally {
    globalThis.fetch = realFetch;
    clearHfCache();
    await fsp.rm(base, {recursive: true, force: true});
  }
});

test('auditFile reports SHA256 progress while hashing', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-prog-'));
  const rel = 'o/r/m.gguf';
  const full = path.join(base, rel);
  await fsp.mkdir(path.dirname(full), {recursive: true});
  const content = Buffer.from('hello world');
  await fsp.writeFile(full, content);
  const sha = crypto.createHash('sha256').update(content).digest('hex');

  const source: HfFileInfo = {
    repoId: 'o/r',
    branch: 'main',
    repoPath: 'm.gguf',
    commit: 'c',
    commitDate: '',
    size: content.length,
    sha256: sha,
  };

  const events: Array<[number, number]> = [];
  const result = await auditFile(
    base,
    rel,
    '',
    'm.gguf',
    undefined,
    source,
    (done, total) => events.push([done, total]),
  );
  expect(result.status).toBe('pass');
  // Progress spans the whole file: totals are the file size throughout and
  // the last event reports every byte hashed.
  expect(events.length).toBeGreaterThan(0);
  expect(events.every(([, total]) => total === content.length)).toBe(true);
  expect(events[events.length - 1][0]).toBe(content.length);
  await fsp.rm(base, {recursive: true, force: true});
});

test('auditFile reports SHA256 progress for the history-walk hash too', async () => {
  clearHfCache();
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-prog-'));
  const rel = 'h/r6/m.gguf';
  const full = path.join(base, rel);
  await fsp.mkdir(path.dirname(full), {recursive: true});
  const content = Buffer.from('old version'); // not the latest's 100 bytes
  await fsp.writeFile(full, content);
  const sha = crypto.createHash('sha256').update(content).digest('hex');

  const source: HfFileInfo = {
    repoId: 'h/r6',
    branch: 'main',
    repoPath: 'm.gguf',
    commit: 'c2',
    commitDate: '2025-01-02T00:00:00.000Z',
    size: 100,
    sha256: 'deadbeef',
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = mockHfHistory(
    'h/r6',
    [{id: 'c1', date: '2024-01-01T00:00:00.000Z'}],
    {
      c1: {
        type: 'file',
        path: 'm.gguf',
        size: content.length,
        lfs: {oid: `sha256:${sha}`, size: content.length},
        lastCommit: {id: 'c1', date: '2024-01-01T00:00:00.000Z'},
      },
    },
  );
  const events: Array<[number, number]> = [];
  try {
    const result = await auditFile(
      base,
      rel,
      '',
      'm.gguf',
      undefined,
      source,
      (done, total) => events.push([done, total]),
    );
    // The size mismatch sends the audit through the history walk, which does
    // the hashing — its progress must surface the same way.
    expect(result.status).toBe('pass');
    expect(events.length).toBeGreaterThan(0);
    expect(events.every(([, total]) => total === content.length)).toBe(true);
    expect(events[events.length - 1][0]).toBe(content.length);
  } finally {
    globalThis.fetch = realFetch;
    clearHfCache();
    await fsp.rm(base, {recursive: true, force: true});
  }
});

test('auditFile persists the resolved source before hashing begins', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-early-'));
  const rel = 'o/r/m.gguf';
  const full = path.join(base, rel);
  await fsp.mkdir(path.dirname(full), {recursive: true});
  const content = Buffer.from('hello world');
  await fsp.writeFile(full, content);
  const sha = crypto.createHash('sha256').update(content).digest('hex');

  const source: HfFileInfo = {
    repoId: 'o/r',
    branch: 'main',
    repoPath: 'm.gguf',
    commit: 'c',
    commitDate: '',
    size: content.length,
    sha256: sha,
  };

  // Capture the sidecar from inside the first hash-progress event: at that
  // point hashing has started, so everything known beforehand — the source
  // and the on-disk size — must already be on disk. A crash mid-hash then
  // can't lose it.
  let duringHash: TjMeta | null = null;
  const result = await auditFile(
    base,
    rel,
    '',
    'm.gguf',
    undefined,
    source,
    () => {
      duringHash ??= JSON.parse(readFileSync(metaPath(full), 'utf8')) as TjMeta;
    },
  );

  expect(result.status).toBe('pass');
  expect(duringHash).not.toBeNull();
  expect(duringHash?.sourceSha256).toBe(sha);
  expect(duringHash?.sourceSize).toBe(content.length);
  expect(duringHash?.computedSize).toBe(content.length);
  expect(duringHash?.computedSha256).toBe(''); // not hashed yet
  await fsp.rm(base, {recursive: true, force: true});
});

test('auditFile preserves a prior hand-set source when resolution fails', async () => {
  clearHfCache();
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-preserve-'));
  const rel = 'GPT.gguf';
  const full = path.join(base, rel);
  await fsp.writeFile(full, 'payload'); // 7 bytes, matching the prior sidecar
  await writeMeta(full, {
    modelUrl: 'https://huggingface.co/Hauhau/Repo',
    originUrl: 'https://huggingface.co/Hauhau/Repo/blob/main/GPT.gguf',
    sourceCommit: 'handpin',
    sourceCommitDate: '2024-01-01T00:00:00.000Z',
    sourceSize: 7,
    computedSize: 7,
    sourceSha256: 'srcsha',
    computedSha256: 'donesha',
  });

  // Inference finds nothing and the sidecar's repo is unreachable (network
  // down, repo gone) — this run resolves no source.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes('/api/models?')) return new Response('[]', {status: 200});
    return new Response('nf', {status: 404});
  }) as typeof fetch;
  try {
    const result = await auditFile(base, rel, 'GPT', 'GPT.gguf');
    expect(result.status).toBe('unverifiable');
    // The sidecar still carries everything the failed run couldn't re-derive:
    // the hand-set source and the still-valid computed hash.
    expect(await readMeta(full)).toEqual({
      modelUrl: 'https://huggingface.co/Hauhau/Repo',
      originUrl: 'https://huggingface.co/Hauhau/Repo/blob/main/GPT.gguf',
      sourceCommit: 'handpin',
      sourceCommitDate: '2024-01-01T00:00:00.000Z',
      sourceSize: 7,
      computedSize: 7,
      sourceSha256: 'srcsha',
      computedSha256: 'donesha',
    });
  } finally {
    globalThis.fetch = realFetch;
    clearHfCache();
    await fsp.rm(base, {recursive: true, force: true});
  }
});

test('auditFile verifies against an explicit source without any inference', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-src-'));
  const rel = 'o/r/m.gguf'; // already at <repoId>/<repoPath>, so not misplaced
  const full = path.join(base, rel);
  await fsp.mkdir(path.dirname(full), {recursive: true});
  const content = Buffer.from('hello world');
  await fsp.writeFile(full, content);
  const sha = crypto.createHash('sha256').update(content).digest('hex');

  const source: HfFileInfo = {
    repoId: 'o/r',
    branch: 'main',
    repoPath: 'm.gguf',
    commit: 'srccommit',
    commitDate: '2024-02-19T10:57:45.000Z',
    size: content.length,
    sha256: sha,
  };

  // With an explicit source there must be no network call at all.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error('auditFile should not fetch when given a source');
  }) as typeof fetch;
  try {
    const result = await auditFile(base, rel, '', 'm.gguf', undefined, source);
    expect(result.status).toBe('pass');
    const meta = await readMeta(full);
    expect(meta?.sourceCommit).toBe('srccommit');
    expect(meta?.sourceCommitDate).toBe('2024-02-19T10:57:45.000Z');
    expect(meta?.sourceSize).toBe(content.length);
    expect(meta?.computedSize).toBe(content.length);
    expect(meta?.sourceSha256).toBe(sha);
    expect(meta?.computedSha256).toBe(sha);
  } finally {
    globalThis.fetch = realFetch;
    await fsp.rm(base, {recursive: true, force: true});
  }
});

test('decideUpdate: unknown when either commit is empty', () => {
  expect(decideUpdate('', 'abc')).toBe('unknown');
  expect(decideUpdate('abc', '')).toBe('unknown');
  expect(decideUpdate('', '')).toBe('unknown');
});

test('decideUpdate: current when the commits are equal', () => {
  expect(decideUpdate('abc123', 'abc123')).toBe('current');
});

test('decideUpdate: update when the commits differ', () => {
  expect(decideUpdate('abc123', 'def456')).toBe('update');
});

test('auditFileUpdate: update when the head commit differs from the recorded one', async () => {
  clearHfCache();
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-upd-'));
  const rel = 'o/r/m.gguf';
  const full = path.join(base, rel);
  await fsp.mkdir(path.dirname(full), {recursive: true});
  await fsp.writeFile(full, 'data');
  await writeMeta(full, {
    modelUrl: 'https://huggingface.co/o/r',
    originUrl: 'https://huggingface.co/o/r/blob/main/m.gguf',
    sourceCommit: 'oldcommit',
    sourceCommitDate: '2024-01-01T00:00:00.000Z',
    sourceSize: 4,
    computedSize: 4,
    sourceSha256: 'sha',
    computedSha256: 'sha',
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes('/api/models/o/r/tree/main')) {
      return new Response(
        JSON.stringify([
          {
            type: 'file',
            path: 'm.gguf',
            size: 4,
            lfs: {oid: 'sha256:sha', size: 4},
            lastCommit: {id: 'newcommit', date: '2026-01-01T00:00:00.000Z'},
          },
        ]),
        {status: 200},
      );
    }
    return new Response('nf', {status: 404});
  }) as typeof fetch;

  try {
    const r = await auditFileUpdate(base, rel);
    expect(r).toEqual({
      file: rel,
      status: 'update',
      latestCommit: 'newcommit',
      latestCommitDate: '2026-01-01T00:00:00.000Z',
      latestCommitUrl: 'https://huggingface.co/o/r/blob/newcommit/m.gguf',
      localCommitDate: '2024-01-01T00:00:00.000Z',
    });
  } finally {
    globalThis.fetch = realFetch;
    clearHfCache();
    await fsp.rm(base, {recursive: true, force: true});
  }
});

test('auditFileUpdate: update omits localCommitDate when the sidecar has none', async () => {
  clearHfCache();
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-upd-'));
  const rel = 'o/r/m.gguf';
  const full = path.join(base, rel);
  await fsp.mkdir(path.dirname(full), {recursive: true});
  await fsp.writeFile(full, 'data');
  // A sidecar with a source commit but no recorded commit date.
  await writeMeta(full, {
    modelUrl: 'https://huggingface.co/o/r',
    originUrl: 'https://huggingface.co/o/r/blob/main/m.gguf',
    sourceCommit: 'oldcommit',
    sourceSize: 4,
    computedSize: 4,
    sourceSha256: 'sha',
    computedSha256: 'sha',
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes('/api/models/o/r/tree/main')) {
      return new Response(
        JSON.stringify([
          {
            type: 'file',
            path: 'm.gguf',
            size: 4,
            lfs: {oid: 'sha256:sha', size: 4},
            lastCommit: {id: 'newcommit', date: '2026-01-01T00:00:00.000Z'},
          },
        ]),
        {status: 200},
      );
    }
    return new Response('nf', {status: 404});
  }) as typeof fetch;

  try {
    const r = await auditFileUpdate(base, rel);
    expect(r).toEqual({
      file: rel,
      status: 'update',
      latestCommit: 'newcommit',
      latestCommitDate: '2026-01-01T00:00:00.000Z',
      latestCommitUrl: 'https://huggingface.co/o/r/blob/newcommit/m.gguf',
    });
    expect(r).not.toHaveProperty('localCommitDate');
  } finally {
    globalThis.fetch = realFetch;
    clearHfCache();
    await fsp.rm(base, {recursive: true, force: true});
  }
});

test('auditFileUpdate: current when the head commit matches the recorded one', async () => {
  clearHfCache();
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-upd-'));
  const rel = 'o/r/m.gguf';
  const full = path.join(base, rel);
  await fsp.mkdir(path.dirname(full), {recursive: true});
  await fsp.writeFile(full, 'data');
  await writeMeta(full, {
    modelUrl: 'https://huggingface.co/o/r',
    originUrl: 'https://huggingface.co/o/r/blob/main/m.gguf',
    sourceCommit: 'samecommit',
    sourceSize: 4,
    computedSize: 4,
    sourceSha256: 'sha',
    computedSha256: 'sha',
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify([
        {
          type: 'file',
          path: 'm.gguf',
          size: 4,
          lfs: {oid: 'sha256:sha', size: 4},
          lastCommit: {id: 'samecommit', date: '2026-01-01T00:00:00.000Z'},
        },
      ]),
      {status: 200},
    )) as typeof fetch;

  try {
    const r = await auditFileUpdate(base, rel);
    expect(r).toEqual({file: rel, status: 'current'});
  } finally {
    globalThis.fetch = realFetch;
    clearHfCache();
    await fsp.rm(base, {recursive: true, force: true});
  }
});

test('auditFileUpdate: unknown when HF cannot be reached', async () => {
  clearHfCache();
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-upd-'));
  const rel = 'o/r/m.gguf';
  const full = path.join(base, rel);
  await fsp.mkdir(path.dirname(full), {recursive: true});
  await fsp.writeFile(full, 'data');
  await writeMeta(full, {
    modelUrl: 'https://huggingface.co/o/r',
    originUrl: 'https://huggingface.co/o/r/blob/main/m.gguf',
    sourceCommit: 'oldcommit',
    sourceSize: 4,
    computedSize: 4,
    sourceSha256: 'sha',
    computedSha256: 'sha',
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response('nf', {status: 404})) as typeof fetch;

  try {
    const r = await auditFileUpdate(base, rel);
    expect(r).toEqual({file: rel, status: 'unknown'});
  } finally {
    globalThis.fetch = realFetch;
    clearHfCache();
    await fsp.rm(base, {recursive: true, force: true});
  }
});

test('auditFileUpdate: null (not checkable) without a sidecar or recorded commit', async () => {
  clearHfCache();
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-upd-'));
  const rel = 'o/r/m.gguf';
  const full = path.join(base, rel);
  await fsp.mkdir(path.dirname(full), {recursive: true});
  await fsp.writeFile(full, 'data');

  // No sidecar at all.
  expect(await auditFileUpdate(base, rel)).toBeNull();

  // Sidecar present but no sourceCommit recorded.
  await writeMeta(full, {
    modelUrl: 'https://huggingface.co/o/r',
    originUrl: 'https://huggingface.co/o/r/blob/main/m.gguf',
    sourceSize: 4,
    computedSize: 4,
    sourceSha256: 'sha',
    computedSha256: 'sha',
  });
  expect(await auditFileUpdate(base, rel)).toBeNull();

  await fsp.rm(base, {recursive: true, force: true});
});
