import {statfs, stat} from 'fs/promises';
import type {DiskUsage, DownloadDiskUsage} from '@/lib/disk-space';

export type {DiskUsage, DownloadDiskUsage} from '@/lib/disk-space';

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
