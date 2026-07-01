import {statfs, stat} from 'fs/promises';

export interface DiskUsage {
  free: number; // bytes available to an unprivileged process
  total: number; // total bytes on the filesystem
}

// Free/total bytes for both filesystems a download can touch: the models
// directory (where it lands) and cold storage (where the optional copy goes).
// `sameDevice` flags when they share one filesystem, so the caller knows their
// free space is shared rather than additive.
export interface DownloadDiskUsage {
  models: DiskUsage;
  cold: DiskUsage;
  sameDevice: boolean;
}

// Free/total bytes of the filesystem holding `path`. `bavail` (not `bfree`) is
// the space actually usable, matching what the download will be allowed to
// write.
export async function diskUsage(path: string): Promise<DiskUsage> {
  const s = await statfs(path);
  return {free: s.bsize * s.bavail, total: s.bsize * s.blocks};
}

export async function downloadDiskUsage(
  modelsPath: string,
  coldPath: string,
): Promise<DownloadDiskUsage> {
  const [models, cold, modelsDev, coldDev] = await Promise.all([
    diskUsage(modelsPath),
    diskUsage(coldPath),
    stat(modelsPath).then((s) => s.dev),
    stat(coldPath).then((s) => s.dev),
  ]);
  return {models, cold, sameDevice: modelsDev === coldDev};
}
