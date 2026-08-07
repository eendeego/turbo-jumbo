import {test, expect} from 'bun:test';
import {checkStatusLabel} from '@/lib/storage/check-progress';

test('reads as plain "Checking…" before the first frame lands', () => {
  expect(checkStatusLabel(null)).toBe('Checking…');
  expect(checkStatusLabel({done: 0, total: 0, file: '', hashing: false})).toBe(
    'Checking…',
  );
});

test('counts the pair being examined, not the one just finished', () => {
  expect(
    checkStatusLabel({done: 0, total: 48, file: 'a', hashing: false}),
  ).toBe('Checking 1/48…');
  expect(
    checkStatusLabel({done: 3, total: 48, file: 'a', hashing: false}),
  ).toBe('Checking 4/48…');
});

test('says "Verifying" while whole files are being read', () => {
  expect(checkStatusLabel({done: 2, total: 48, file: 'a', hashing: true})).toBe(
    'Verifying 3/48…',
  );
});

test('never counts past the total on the closing frame', () => {
  expect(
    checkStatusLabel({done: 48, total: 48, file: 'a', hashing: false}),
  ).toBe('Checking 48/48…');
});
