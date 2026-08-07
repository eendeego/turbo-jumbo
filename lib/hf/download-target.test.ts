import {test, expect} from 'bun:test';
import {downloadTarget, peerModelsDir} from '@/lib/hf/download-target';
import type {Peer} from '@/lib/config';

const local: Peer = {
  name: 'box-a',
  address: '192.0.2.1:3000',
  base_path: '/mnt/a',
  isLocal: true,
};
const remote: Peer = {
  name: 'box-b',
  address: '192.0.2.2:3000',
  base_path: '/mnt/b',
};
const remoteNoBase: Peer = {name: 'box-c', address: '192.0.2.3:3000'};
const peers = [local, remote, remoteNoBase];

test('All tab targets the local download endpoint', () => {
  expect(downloadTarget('all', peers, '/local/models')).toEqual({
    url: '/api/v1/hf-download',
    displayPath: '/local/models',
    diskUsageUrl: '/api/v1/disk-usage',
  });
});

test('local peer targets the local download endpoint', () => {
  expect(downloadTarget('192.0.2.1:3000', peers, '/local/models')).toEqual({
    url: '/api/v1/hf-download',
    displayPath: '/local/models',
    diskUsageUrl: '/api/v1/disk-usage',
  });
});

test('remote peer targets its proxy and resolved models dir', () => {
  expect(downloadTarget('192.0.2.2:3000', peers, '/local/models')).toEqual({
    url: '/api/v1/peers/box-b/hf-download',
    displayPath: '/mnt/b/turbo-jumbo',
    diskUsageUrl: '/api/v1/peers/box-b/disk-usage',
  });
});

test('remote peer without base_path falls back to a placeholder path', () => {
  expect(downloadTarget('192.0.2.3:3000', peers, '/local/models')).toEqual({
    url: '/api/v1/peers/box-c/hf-download',
    displayPath: 'box-c models directory',
    diskUsageUrl: '/api/v1/peers/box-c/disk-usage',
  });
});

test('a peer with a Unicode name targets its proxy by slug', () => {
  const unicode: Peer = {
    name: 'Zürich',
    address: '192.0.2.4:3000',
    slug: 'zurich',
    base_path: '/mnt/g',
  };
  expect(downloadTarget('192.0.2.4:3000', [unicode], '/local/models')).toEqual({
    url: '/api/v1/peers/zurich/hf-download',
    displayPath: '/mnt/g/turbo-jumbo',
    diskUsageUrl: '/api/v1/peers/zurich/disk-usage',
  });
});

test('peerModelsDir honors the turbo_jumbo_subdir override', () => {
  expect(
    peerModelsDir({
      name: 'x',
      address: 'a',
      base_path: '/m',
      turbo_jumbo_subdir: 'tj',
    }),
  ).toBe('/m/tj');
});
