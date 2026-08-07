import {test, expect} from 'bun:test';
import {peerSlug, slugifyPeerName, peerSlugError} from '@/lib/peers/peer-slug';
import type {Peer} from '@/lib/config';

const peer = (overrides: Partial<Peer>): Peer => ({
  name: 'Test',
  address: '192.0.2.1:3000',
  ...overrides,
});

test('slugifyPeerName lowercases and hyphenates', () => {
  expect(slugifyPeerName('My Box')).toBe('my-box');
  expect(slugifyPeerName('Box_1 (spare)')).toBe('box-1-spare');
});

test('slugifyPeerName drops characters it cannot transliterate', () => {
  expect(slugifyPeerName('Zürich')).toBe('z-rich');
  expect(slugifyPeerName('東京')).toBe('');
});

test('peerSlug prefers the configured slug over the derived one', () => {
  expect(peerSlug(peer({name: 'Zürich', slug: 'zurich'}))).toBe('zurich');
});

test('peerSlug falls back to the derived slug when unset', () => {
  expect(peerSlug(peer({name: 'My Box'}))).toBe('my-box');
});

test('peerSlugError accepts distinct usable slugs', () => {
  expect(
    peerSlugError([
      peer({name: 'My Box'}),
      peer({name: 'Zürich', slug: 'zurich'}),
    ]),
  ).toBeNull();
});

test('peerSlugError rejects a name that derives no slug', () => {
  const err = peerSlugError([peer({name: '東京'})]);
  expect(err).toContain('東京');
  expect(err).toContain('slug');
});

test('peerSlugError rejects two peers sharing a slug', () => {
  const err = peerSlugError([
    peer({name: 'Zürich', slug: 'zurich'}),
    peer({name: 'zurich'}),
  ]);
  expect(err).toContain('zurich');
});

test('peerSlugError rejects a slug that shadows a reserved route', () => {
  const err = peerSlugError([peer({name: 'Cold Storage'})]);
  expect(err).toContain('cold-storage');
});

test('peerSlugError names every reserved route segment', () => {
  for (const reserved of ['all', 'cold-storage', 'download', 'api']) {
    expect(peerSlugError([peer({name: 'X', slug: reserved})])).not.toBeNull();
  }
});
