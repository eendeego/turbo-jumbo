import {test, expect, afterEach} from 'bun:test';
import {
  inferHfFile,
  clearHfCache,
  parseHfFileUrl,
  resolveHfFileByPath,
} from '@/lib/hf-infer';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  clearHfCache();
});

function jsonResponse(data: unknown) {
  return new Response(JSON.stringify(data), {status: 200});
}

test('infers repo by exact filename match and parses size + sha256', async () => {
  globalThis.fetch = (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes('/api/models?')) {
      return jsonResponse([{id: 'someorg/My-Model-GGUF'}]);
    }
    if (u.includes('/tree/')) {
      return jsonResponse([
        {
          type: 'file',
          path: 'My-Model.Q4_K_M.gguf',
          size: 100,
          lfs: {oid: 'abc123', size: 4200},
          lastCommit: {id: 'commitabc', date: '2024-02-19T10:57:45.000Z'},
        },
      ]);
    }
    return new Response('not found', {status: 404});
  }) as typeof fetch;

  const info = await inferHfFile('My-Model', 'My-Model.Q4_K_M.gguf');
  expect(info).toEqual({
    repoId: 'someorg/My-Model-GGUF',
    branch: 'main',
    repoPath: 'My-Model.Q4_K_M.gguf',
    commit: 'commitabc',
    commitDate: '2024-02-19T10:57:45.000Z',
    size: 4200,
    sha256: 'abc123',
  });
});

test('returns null when no candidate repo contains the filename', async () => {
  globalThis.fetch = (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes('/api/models?')) return jsonResponse([{id: 'x/y'}]);
    if (u.includes('/tree/')) {
      return jsonResponse([{type: 'file', path: 'other.gguf', size: 1}]);
    }
    return new Response('nf', {status: 404});
  }) as typeof fetch;

  expect(await inferHfFile('My-Model', 'My-Model.Q4_K_M.gguf')).toBeNull();
});

test('skips a filename match with no LFS oid (non-LFS / no checksum)', async () => {
  globalThis.fetch = (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes('/api/models?')) return jsonResponse([{id: 'o/r'}]);
    if (u.includes('/tree/')) {
      // file matches by name but has no lfs pointer → no sha available
      return jsonResponse([{type: 'file', path: 'm.gguf', size: 10}]);
    }
    return new Response('nf', {status: 404});
  }) as typeof fetch;

  expect(await inferHfFile('m', 'm.gguf')).toBeNull();
});

test('falls through to a later candidate that carries the LFS checksum', async () => {
  globalThis.fetch = (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes('/api/models?')) {
      return jsonResponse([{id: 'no-lfs/repo'}, {id: 'good/repo'}]);
    }
    if (u.includes('/api/models/no-lfs/repo/tree/')) {
      return jsonResponse([{type: 'file', path: 'm.gguf', size: 10}]);
    }
    if (u.includes('/api/models/good/repo/tree/')) {
      return jsonResponse([
        {
          type: 'file',
          path: 'm.gguf',
          size: 10,
          lfs: {oid: 'sha256:cafe', size: 10},
          lastCommit: {id: 'goodcommit', date: '2023-01-02T03:04:05.000Z'},
        },
      ]);
    }
    return new Response('nf', {status: 404});
  }) as typeof fetch;

  const info = await inferHfFile('m', 'm.gguf');
  expect(info).toEqual({
    repoId: 'good/repo',
    branch: 'main',
    repoPath: 'm.gguf',
    commit: 'goodcommit',
    commitDate: '2023-01-02T03:04:05.000Z',
    size: 10,
    sha256: 'cafe',
  });
});

test('strips the sha256: prefix from the lfs oid when present', async () => {
  globalThis.fetch = (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes('/api/models?')) return jsonResponse([{id: 'o/r'}]);
    if (u.includes('/tree/')) {
      return jsonResponse([
        {
          type: 'file',
          path: 'm.gguf',
          size: 5,
          lfs: {oid: 'sha256:deadbeef', size: 5},
        },
      ]);
    }
    return new Response('nf', {status: 404});
  }) as typeof fetch;

  const info = await inferHfFile('m', 'm.gguf');
  expect(info?.sha256).toBe('deadbeef');
});

test('parseHfFileUrl parses a blob URL into repo, branch and path', () => {
  expect(
    parseHfFileUrl(
      'https://huggingface.co/HauhauCS/GPT-OSS-20B-Uncensored-HauhauCS-Aggressive/blob/main/GPT-OSS-20B-Uncensored-HauhauCS-MXFP4-Aggressive.gguf',
    ),
  ).toEqual({
    repoId: 'HauhauCS/GPT-OSS-20B-Uncensored-HauhauCS-Aggressive',
    branch: 'main',
    repoPath: 'GPT-OSS-20B-Uncensored-HauhauCS-MXFP4-Aggressive.gguf',
  });
});

test('parseHfFileUrl accepts the resolve form and nested paths', () => {
  expect(
    parseHfFileUrl('https://huggingface.co/o/r/resolve/main/sub/dir/file.gguf'),
  ).toEqual({repoId: 'o/r', branch: 'main', repoPath: 'sub/dir/file.gguf'});
});

test('parseHfFileUrl strips a query string and trims whitespace', () => {
  expect(
    parseHfFileUrl(
      '  https://huggingface.co/o/r/blob/main/f.gguf?download=true ',
    ),
  ).toEqual({repoId: 'o/r', branch: 'main', repoPath: 'f.gguf'});
});

test('parseHfFileUrl rejects non-file and non-HF URLs', () => {
  expect(parseHfFileUrl('https://huggingface.co/o/r')).toBeNull();
  expect(parseHfFileUrl('https://example.com/o/r/blob/main/f.gguf')).toBeNull();
  expect(parseHfFileUrl('not a url')).toBeNull();
  expect(
    parseHfFileUrl('https://huggingface.co/o/r/blob/main/../escape'),
  ).toBeNull();
});

test('resolveHfFileByPath matches a known path without a name search', async () => {
  let searched = false;
  globalThis.fetch = (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes('/api/models?')) searched = true;
    if (u.includes('/api/models/o/r/tree/main')) {
      return jsonResponse([
        {type: 'file', path: 'other.gguf', size: 1},
        {
          type: 'file',
          path: 'sub/wanted.gguf',
          size: 9,
          lfs: {oid: 'sha256:feed', size: 4200},
          lastCommit: {id: 'pinnedcommit', date: '2025-06-01T00:00:00.000Z'},
        },
      ]);
    }
    return new Response('nf', {status: 404});
  }) as typeof fetch;

  const info = await resolveHfFileByPath('o/r', 'main', 'sub/wanted.gguf');
  expect(info).toEqual({
    repoId: 'o/r',
    branch: 'main',
    repoPath: 'sub/wanted.gguf',
    commit: 'pinnedcommit',
    commitDate: '2025-06-01T00:00:00.000Z',
    size: 4200,
    sha256: 'feed',
  });
  expect(searched).toBe(false); // resolves by path directly, no /api/models? search
});

test('resolveHfFileByPath returns null when the path is absent', async () => {
  globalThis.fetch = (async () =>
    jsonResponse([{type: 'file', path: 'a.gguf', size: 1}])) as typeof fetch;
  expect(await resolveHfFileByPath('o/r', 'main', 'missing.gguf')).toBeNull();
});
