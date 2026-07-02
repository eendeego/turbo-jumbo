// Client-safe disk-space types and the pure warning logic shared by the HF
// download picker and the Lemonade browser. The actual statfs lives in the
// server-only lib/storage/disk-usage.ts, which reuses these types.

export interface DiskUsage {
  free: number; // bytes available to an unprivileged process
  total: number; // total bytes on the filesystem
}

export interface DownloadDiskUsage {
  models: DiskUsage; // where the download lands
  cold: DiskUsage; // the optional "copy to cold storage" target
  sameDevice: boolean; // models & cold share one filesystem (space is shared)
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e12) return `${(bytes / 1e12).toFixed(1)} TB`;
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${(bytes / 1e3).toFixed(1)} KB`;
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
          `needs ${formatBytes(need)} but only ${formatBytes(disk.models.free)} is free`,
        ]
      : [];
  }
  const out: string[] = [];
  if (neededBytes > disk.models.free)
    out.push(
      `local storage needs ${formatBytes(neededBytes)} but only ${formatBytes(disk.models.free)} is free`,
    );
  if (sendToCold && neededBytes > disk.cold.free)
    out.push(
      `cold storage needs ${formatBytes(neededBytes)} but only ${formatBytes(disk.cold.free)} is free`,
    );
  return out;
}
