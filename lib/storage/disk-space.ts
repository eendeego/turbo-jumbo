// Client-safe disk-space types and the pure warning logic shared by the HF
// download picker and the Lemonade browser. The actual statfs lives in the
// server-only lib/storage/disk-usage.ts, which reuses these types.

import {formatSize} from '@/lib/format/bytes';

export interface DiskUsage {
  free: number; // bytes available to an unprivileged process
  total: number; // total bytes on the filesystem
}

export interface DownloadDiskUsage {
  models: DiskUsage; // where the download lands
  cold: DiskUsage; // the optional "copy to cold storage" target
  sameDevice: boolean; // models & cold share one filesystem (space is shared)
}

/**
 * Human-readable shortfalls for a planned download of `neededBytes`. The
 * download always writes the files into the models dir; "Copy to cold storage"
 * adds a copy on the cold filesystem (and "delete after transfer" removes the
 * local copy afterwards). When both live on one filesystem their free space is
 * shared, so a kept copy needs room for two and a moved copy for one — reported
 * as a single combined shortfall. Empty when everything fits.
 */
export function diskSpaceWarnings(
  disk: DownloadDiskUsage,
  neededBytes: number,
  sendToCold: boolean,
  deleteAfterTransfer: boolean,
): string[] {
  if (neededBytes <= 0) return [];
  if (disk.sameDevice) {
    const need =
      sendToCold && !deleteAfterTransfer ? neededBytes * 2 : neededBytes;
    return need > disk.models.free
      ? [
          `needs ${formatSize(need)} but only ${formatSize(disk.models.free)} is free`,
        ]
      : [];
  }
  const out: string[] = [];
  if (neededBytes > disk.models.free)
    out.push(
      `local storage needs ${formatSize(neededBytes)} but only ${formatSize(disk.models.free)} is free`,
    );
  if (sendToCold && neededBytes > disk.cold.free)
    out.push(
      `cold storage needs ${formatSize(neededBytes)} but only ${formatSize(disk.cold.free)} is free`,
    );
  return out;
}
