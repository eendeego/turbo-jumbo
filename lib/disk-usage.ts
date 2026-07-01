import {statfs} from 'fs/promises';

export interface DiskUsage {
  free: number; // bytes available to an unprivileged process
  total: number; // total bytes on the filesystem
}

// Free/total bytes of the filesystem holding `path`, used to warn before a
// download that wouldn't fit. `bavail` (not `bfree`) is the space actually
// usable, matching what the download will be allowed to write.
export async function diskUsage(path: string): Promise<DiskUsage> {
  const s = await statfs(path);
  return {free: s.bsize * s.bavail, total: s.bsize * s.blocks};
}
