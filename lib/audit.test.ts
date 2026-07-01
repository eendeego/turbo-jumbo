import {test, expect} from 'bun:test';
import {promises as fsp} from 'fs';
import crypto from 'crypto';
import os from 'os';
import path from 'path';
import {
  auditFile,
  cachedResultFromMeta,
  copyFileWithMeta,
  decideStatus,
  expectedRelPath,
  hfSummary,
  moveFileWithMeta,
  readMeta,
  refreshMetaSource,
  resolveSource,
  writeMeta,
  metaPath,
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
    const hf = await resolveSource(full, 'GPT', 'GPT.gguf');
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

test('auditFile writes a sidecar for a size-mismatched (incomplete) file, without hashing', async () => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'tj-incomplete-'));
  const rel = 'o/r/m.gguf';
  const full = path.join(base, rel);
  await fsp.mkdir(path.dirname(full), {recursive: true});
  await fsp.writeFile(full, 'short'); // 5 bytes — a partial download

  const source: HfFileInfo = {
    repoId: 'o/r',
    branch: 'main',
    repoPath: 'm.gguf',
    commit: '',
    commitDate: '',
    size: 999, // expected, doesn't match the 5 bytes on disk
    sha256: 'expectedsha',
  };

  const result = await auditFile(base, rel, '', 'm.gguf', undefined, source);
  expect(result.status).toBe('incomplete');
  const meta = await readMeta(full);
  expect(meta?.sourceSize).toBe(999);
  expect(meta?.computedSize).toBe(5);
  expect(meta?.sourceSha256).toBe('expectedsha');
  expect(meta?.computedSha256).toBe(''); // skipped — a size mismatch can't be a sha pass
  await fsp.rm(base, {recursive: true, force: true});
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
