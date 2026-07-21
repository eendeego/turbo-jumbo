import {test, expect} from 'bun:test';
import {formatSize, formatSpeed} from '@/lib/format/bytes';

test('formatSize renders binary units with GiB/MiB/KiB labels', () => {
  expect(formatSize(-1)).toBe('');
  expect(formatSize(0)).toBe('0 B');
  expect(formatSize(900)).toBe('900 B');
  expect(formatSize(1024)).toBe('1 KiB');
  expect(formatSize(1024 ** 2)).toBe('1.0 MiB');
  expect(formatSize(1.5 * 1024 ** 2)).toBe('1.5 MiB');
  expect(formatSize(1024 ** 3)).toBe('1.0 GiB');
  expect(formatSize(1024 ** 4)).toBe('1.0 TiB');
  // Real weights from the gemma-4-31B repo.
  expect(formatSize(18_323_733_440)).toBe('17.1 GiB');
  expect(formatSize(36_218_995_712)).toBe('33.7 GiB');
});

test('formatSpeed renders a binary transfer rate', () => {
  expect(formatSpeed(5 * 1024)).toBe('5 KiB/s');
  expect(formatSpeed(1024 ** 2)).toBe('1.0 MiB/s');
  expect(formatSpeed(1024 ** 3)).toBe('1.00 GiB/s');
});
