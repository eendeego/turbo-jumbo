import {test, expect, afterEach} from 'bun:test';
import {inferHfFile, _clearHfCache} from '@/lib/hf-infer';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  _clearHfCache();
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
