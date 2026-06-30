import {expect, test} from 'bun:test';
import {validateRawConfig} from '@/lib/config';

const validPeer = {
  name: 'this-machine',
  address: '192.168.1.10:3000',
  base_path: '/mnt/models',
  cold_storage_path: '/mnt/cold-storage',
};

test('accepts a minimal valid config', () => {
  expect(validateRawConfig({peers: [validPeer]})).toBeNull();
});

test('accepts an optional log_level', () => {
  expect(validateRawConfig({log_level: 'debug', peers: [validPeer]})).toBeNull();
});

test('rejects a missing peers array', () => {
  expect(validateRawConfig({})).toContain('peers');
});

test('rejects an empty peers array', () => {
  expect(validateRawConfig({peers: []})).not.toBeNull();
});

test('rejects an unknown top-level property', () => {
  expect(validateRawConfig({peers: [validPeer], nope: 1})).toContain(
    'unknown property "nope"',
  );
});

test('rejects a peer missing its address', () => {
  expect(validateRawConfig({peers: [{name: 'x'}]})).toContain('address');
});

test('rejects an address without a port', () => {
  expect(
    validateRawConfig({peers: [{name: 'x', address: '192.0.2.1'}]}),
  ).not.toBeNull();
});

test('rejects an invalid log_level', () => {
  expect(
    validateRawConfig({log_level: 'loud', peers: [validPeer]}),
  ).not.toBeNull();
});
