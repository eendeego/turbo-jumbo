import {test, expect} from 'bun:test';
import {
  diskSpaceWarnings,
  type DownloadDiskUsage,
} from '@/lib/storage/disk-space';

// Distinct filesystems for models and cold storage.
const split = (modelsFree: number, coldFree: number): DownloadDiskUsage => ({
  models: {free: modelsFree, total: modelsFree * 2},
  cold: {free: coldFree, total: coldFree * 2},
  sameDevice: false,
});
// One shared filesystem (cold mirrors models).
const shared = (free: number): DownloadDiskUsage => ({
  models: {free, total: free * 2},
  cold: {free, total: free * 2},
  sameDevice: true,
});

const GB = 1e9;

test('no warning when nothing is selected', () => {
  expect(diskSpaceWarnings(split(GB, GB), 0, false, false)).toEqual([]);
});

test('no warning when the download fits', () => {
  expect(
    diskSpaceWarnings(split(10 * GB, 10 * GB), 5 * GB, false, false),
  ).toEqual([]);
});

test('separate disks: flags the models filesystem when it is short', () => {
  const out = diskSpaceWarnings(split(2 * GB, 100 * GB), 5 * GB, false, false);
  expect(out).toHaveLength(1);
  expect(out[0]).toContain('local storage needs');
});

test('separate disks: flags cold storage only when copying to it', () => {
  expect(
    diskSpaceWarnings(split(100 * GB, 2 * GB), 5 * GB, false, false),
  ).toEqual([]);
  const out = diskSpaceWarnings(split(100 * GB, 2 * GB), 5 * GB, true, false);
  expect(out).toHaveLength(1);
  expect(out[0]).toContain('cold storage needs');
});

test('separate disks: both filesystems short produces two warnings', () => {
  const out = diskSpaceWarnings(split(1 * GB, 1 * GB), 5 * GB, true, false);
  expect(out).toHaveLength(2);
});

test('shared disk: a kept copy needs room for two', () => {
  // 5 GB selected, 8 GB free: fits alone, but a kept cold copy needs 10 GB.
  expect(diskSpaceWarnings(shared(8 * GB), 5 * GB, false, false)).toEqual([]);
  const out = diskSpaceWarnings(shared(8 * GB), 5 * GB, true, false);
  expect(out).toHaveLength(1);
  expect(out[0]).toContain('needs 10.0 GB');
});

test('shared disk: a moved copy needs room for one', () => {
  // delete-after-transfer is a rename on one filesystem — only 1× is needed.
  expect(diskSpaceWarnings(shared(8 * GB), 5 * GB, true, true)).toEqual([]);
});
