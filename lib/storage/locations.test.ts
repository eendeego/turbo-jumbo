import {test, expect} from 'bun:test';
import {parseRoute, lemonadeHref, hfHref} from '@/lib/storage/locations';
import type {Peer} from '@/lib/config';

const peers: Peer[] = [
  {name: 'My Box', address: '192.0.2.1', isLocal: true} as Peer,
  {name: 'Remote Two', address: '192.0.2.2'} as Peer,
];

test('parseRoute: root → all/table', () => {
  expect(parseRoute(undefined, peers)).toEqual({
    location: 'all',
    view: 'table',
  });
  expect(parseRoute([], peers)).toEqual({location: 'all', view: 'table'});
});

test('parseRoute: cold-storage → table', () => {
  expect(parseRoute(['cold-storage'], peers)).toEqual({
    location: 'cold-storage',
    view: 'table',
  });
});

test('parseRoute: peer slug → peer/table', () => {
  expect(parseRoute(['my-box'], peers)).toEqual({
    location: '192.0.2.1',
    view: 'table',
  });
});

test('parseRoute: unknown slug → null', () => {
  expect(parseRoute(['nope'], peers)).toBeNull();
});

test('parseRoute: download/lemonade → all/lemonade', () => {
  expect(parseRoute(['download', 'lemonade'], peers)).toEqual({
    location: 'all',
    view: 'lemonade',
  });
});

test('parseRoute: <slug>/download/lemonade → peer/lemonade', () => {
  expect(parseRoute(['remote-two', 'download', 'lemonade'], peers)).toEqual({
    location: '192.0.2.2',
    view: 'lemonade',
  });
});

test('parseRoute: cold-storage has no lemonade → null', () => {
  expect(
    parseRoute(['cold-storage', 'download', 'lemonade'], peers),
  ).toBeNull();
});

test('parseRoute: bad shapes → null', () => {
  expect(parseRoute(['a', 'b'], peers)).toBeNull();
  expect(parseRoute(['download', 'lemonade', 'extra'], peers)).toBeNull();
  expect(parseRoute(['my-box', 'download', 'soda'], peers)).toBeNull();
});

test('lemonadeHref: all and peer', () => {
  expect(lemonadeHref('all', peers)).toBe('/download/lemonade');
  expect(lemonadeHref('192.0.2.2', peers)).toBe(
    '/remote-two/download/lemonade',
  );
});

test('round-trip lemonadeHref → parseRoute', () => {
  const href = lemonadeHref('192.0.2.1', peers); // '/my-box/download/lemonade'
  const segments = href.split('/').filter(Boolean);
  expect(parseRoute(segments, peers)).toEqual({
    location: '192.0.2.1',
    view: 'lemonade',
  });
});

test('parseRoute: download/hf → all/hf', () => {
  expect(parseRoute(['download', 'hf'], peers)).toEqual({
    location: 'all',
    view: 'hf',
  });
});

test('parseRoute: <local-slug>/download/hf → local peer/hf', () => {
  expect(parseRoute(['my-box', 'download', 'hf'], peers)).toEqual({
    location: '192.0.2.1',
    view: 'hf',
  });
});

test('parseRoute: <remote-slug>/download/hf → remote peer/hf', () => {
  expect(parseRoute(['remote-two', 'download', 'hf'], peers)).toEqual({
    location: '192.0.2.2',
    view: 'hf',
  });
});

test('parseRoute: cold-storage has no hf → null', () => {
  expect(parseRoute(['cold-storage', 'download', 'hf'], peers)).toBeNull();
});

test('parseRoute: bad hf shapes → null', () => {
  expect(parseRoute(['download', 'hf', 'extra'], peers)).toBeNull();
});

test('hfHref: all, local peer, and remote peer', () => {
  expect(hfHref('all', peers)).toBe('/download/hf');
  expect(hfHref('192.0.2.1', peers)).toBe('/my-box/download/hf');
  expect(hfHref('192.0.2.2', peers)).toBe('/remote-two/download/hf');
});

test('round-trip hfHref → parseRoute (local peer)', () => {
  const href = hfHref('192.0.2.1', peers); // '/my-box/download/hf'
  const segments = href.split('/').filter(Boolean);
  expect(parseRoute(segments, peers)).toEqual({
    location: '192.0.2.1',
    view: 'hf',
  });
});
