import {test, expect, afterEach} from 'bun:test';
import {
  canonicalBranch,
  inferHfFile,
  clearHfCache,
  listHfCommits,
  parseHfFileUrl,
  resolveHfFileByPath,
  resolveHfHead,
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

test('the repo search asks for a deep result window', async () => {
  // Search ranking drifts as newer model families flood the results (e.g.
  // LFM2.5 burying LFM2); a top-10 window misses the true repo entirely.
  let searchUrl = '';
  globalThis.fetch = (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes('/api/models?')) {
      searchUrl = u;
      return jsonResponse([]);
    }
    return new Response('nf', {status: 404});
  }) as typeof fetch;

  await inferHfFile('windowed', 'windowed.gguf');
  expect(searchUrl).toContain('limit=500');
});

test('follows tree pagination to find files past the first page', async () => {
  // The tree endpoint pages at ~50 entries; repos with more files keep the
  // rest behind Link headers (e.g. unsloth/Qwen3-Coder-Next-GGUF, 78 files).
  globalThis.fetch = (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes('/api/models/big/repo/tree/main')) {
      if (!u.includes('cursor=')) {
        return new Response(
          JSON.stringify([
            {
              type: 'file',
              path: 'page1.gguf',
              size: 1,
              lfs: {oid: 'sha256:aa', size: 1},
            },
          ]),
          {
            status: 200,
            headers: {
              link: '<https://huggingface.co/api/models/big/repo/tree/main?recursive=true&expand=true&cursor=abc>; rel="next"',
            },
          },
        );
      }
      // Last page: no link header.
      return jsonResponse([
        {
          type: 'file',
          path: 'wanted.gguf',
          size: 9,
          lfs: {oid: 'sha256:bb', size: 9},
        },
      ]);
    }
    return new Response('nf', {status: 404});
  }) as typeof fetch;

  const info = await resolveHfFileByPath('big/repo', 'main', 'wanted.gguf');
  expect(info?.sha256).toBe('bb');
});

test('a tree page failure mid-walk keeps the pages already gathered', async () => {
  globalThis.fetch = (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes('/api/models/flaky/repo/tree/main')) {
      if (!u.includes('cursor=')) {
        return new Response(
          JSON.stringify([
            {
              type: 'file',
              path: 'first.gguf',
              size: 1,
              lfs: {oid: 'sha256:cc', size: 1},
            },
          ]),
          {
            status: 200,
            headers: {
              link: '<https://huggingface.co/api/models/flaky/repo/tree/main?cursor=xyz>; rel="next"',
            },
          },
        );
      }
      return new Response('boom', {status: 500});
    }
    return new Response('nf', {status: 404});
  }) as typeof fetch;

  // A truncated tree still resolves the files it did list.
  const info = await resolveHfFileByPath('flaky/repo', 'main', 'first.gguf');
  expect(info?.sha256).toBe('cc');
});

test('fetches a repo tree once per repo+branch within a run', async () => {
  let treeFetches = 0;
  globalThis.fetch = (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes('/api/models/o/cached-repo/tree/main')) {
      treeFetches++;
      return jsonResponse([
        {
          type: 'file',
          path: 'a.gguf',
          size: 1,
          lfs: {oid: 'sha256:aa', size: 1},
        },
        {
          type: 'file',
          path: 'b.gguf',
          size: 2,
          lfs: {oid: 'sha256:bb', size: 2},
        },
      ]);
    }
    return new Response('nf', {status: 404});
  }) as typeof fetch;

  // Auditing many files of one model resolves against the same tree; fetch it
  // once and reuse it for the rest of the run (clearHfCache starts it fresh).
  expect(
    (await resolveHfFileByPath('o/cached-repo', 'main', 'a.gguf'))?.sha256,
  ).toBe('aa');
  expect(
    (await resolveHfFileByPath('o/cached-repo', 'main', 'b.gguf'))?.sha256,
  ).toBe('bb');
  expect(treeFetches).toBe(1);
});

test('canonicalBranch rewrites a commit SHA to main', () => {
  expect(canonicalBranch('2d03716c45a1d5d5b8a82984e9ee3d39c2a5e69f')).toBe(
    'main',
  );
  // Git SHAs are case-insensitive hex.
  expect(canonicalBranch('2D03716C45A1D5D5B8A82984E9EE3D39C2A5E69F')).toBe(
    'main',
  );
});

test('canonicalBranch leaves branch and tag names alone', () => {
  expect(canonicalBranch('main')).toBe('main');
  expect(canonicalBranch('v2.0')).toBe('v2.0');
  // Short hex could be a real branch name — only a full 40-hex SHA is a pin.
  expect(canonicalBranch('deadbeef')).toBe('deadbeef');
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

test('listHfCommits follows Link pagination through every page', async () => {
  const fetched: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    const u = url.toString();
    fetched.push(u);
    if (u.endsWith('/commits/main')) {
      return new Response(
        JSON.stringify([{id: 'c3', date: '2026-03-01T00:00:00.000Z'}]),
        {
          status: 200,
          headers: {
            link: '<https://huggingface.co/api/models/o/r/commits/main?p=1>; rel="next"',
          },
        },
      );
    }
    if (u.endsWith('?p=1')) {
      return new Response(
        JSON.stringify([{id: 'c2', date: '2026-02-01T00:00:00.000Z'}]),
        {
          status: 200,
          headers: {
            link: '<https://huggingface.co/api/models/o/r/commits/main?p=2>; rel="next"',
          },
        },
      );
    }
    // Last page: no link header.
    return new Response(JSON.stringify([{id: 'c1', date: ''}]), {status: 200});
  }) as typeof fetch;

  expect(await listHfCommits('o/r', 'main')).toEqual([
    {id: 'c3', date: '2026-03-01T00:00:00.000Z'},
    {id: 'c2', date: '2026-02-01T00:00:00.000Z'},
    {id: 'c1', date: ''},
  ]);
  expect(fetched).toHaveLength(3);
});

test('listHfCommits returns the pages gathered before a mid-walk failure', async () => {
  globalThis.fetch = (async (url: string | URL) => {
    if (url.toString().endsWith('/commits/main')) {
      return new Response(JSON.stringify([{id: 'c2', date: ''}]), {
        status: 200,
        headers: {
          link: '<https://huggingface.co/api/models/o/r2/commits/main?p=1>; rel="next"',
        },
      });
    }
    return new Response('boom', {status: 500});
  }) as typeof fetch;

  expect(await listHfCommits('o/r2', 'main')).toEqual([{id: 'c2', date: ''}]);
});

test('listHfCommits returns null when the listing is unreachable', async () => {
  globalThis.fetch = (async () =>
    new Response('nf', {status: 404})) as typeof fetch;
  expect(await listHfCommits('o/r3', 'main')).toBeNull();
});

test('resolveHfHead returns the branch HEAD commit and date', async () => {
  globalThis.fetch = (async (url: string | URL) => {
    const u = url.toString();
    if (u.includes('/api/models/o/r/revision/main')) {
      return jsonResponse({
        sha: '047e06635fbe71469926b35ea414537245218200',
        lastModified: '2026-01-04T15:37:54.000Z',
      });
    }
    return new Response('nf', {status: 404});
  }) as typeof fetch;
  expect(await resolveHfHead('o/r', 'main')).toEqual({
    id: '047e06635fbe71469926b35ea414537245218200',
    date: '2026-01-04T15:37:54.000Z',
  });
});

test('resolveHfHead caches per repo+branch within a run', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return jsonResponse({sha: 'deadbeef'});
  }) as typeof fetch;
  expect(await resolveHfHead('o/r', 'main')).toEqual({
    id: 'deadbeef',
    date: '',
  });
  await resolveHfHead('o/r', 'main');
  expect(calls).toBe(1);
});

test('resolveHfHead returns null when the repo is unreachable', async () => {
  globalThis.fetch = (async () =>
    new Response('nf', {status: 404})) as typeof fetch;
  expect(await resolveHfHead('o/missing', 'main')).toBeNull();
});
