import {localModelsDir, coldStorageDir, localPeer} from '@/lib/config';
import {logger} from '@/lib/logger';
import nodePath from 'path';
import {promises as fsp} from 'fs';
import {execFile} from 'child_process';
import {promisify} from 'util';

const execFileP = promisify(execFile);

async function localMd5(fullPath: string): Promise<string> {
  const {stdout} = await execFileP('md5sum', [fullPath]);
  return stdout.split(/\s+/)[0];
}

async function peerChecksumData(
  peerAddr: string,
  file: string,
): Promise<{size: number; md5: string} | null> {
  try {
    logger.debug(`[check] fetch checksum ${file} from ${peerAddr}`);
    const res = await fetch(
      `http://${peerAddr}/api/v1/local-models/checksum?file=${encodeURIComponent(file)}`,
    );
    if (!res.ok) return null;
    return (await res.json()) as {size: number; md5: string};
  } catch {
    return null;
  }
}

// Compare each selected file against what already exists at each destination
// (cold storage and/or peers), reporting size and md5 matches so the UI can
// let the user choose what to overwrite before any bytes move.
export async function POST(req: Request) {
  const body = (await req.json()) as {
    files: string[];
    from: string; // "cold-storage" | peer address (local peer's own address for local source)
    toColdStorage: boolean;
    toPeers: string[]; // may include the local peer's address
    fileSizes?: Record<string, number>;
  };

  const {files, from, toColdStorage, toPeers} = body;
  const localPeerAddr = localPeer?.address ?? '';
  const isPeerSource = from !== 'cold-storage' && from !== localPeerAddr;
  const localBase = localModelsDir ? nodePath.resolve(localModelsDir) : '';
  const coldBase = coldStorageDir ? nodePath.resolve(coldStorageDir) : '';

  const conflicts: Array<{
    file: string;
    destination: string;
    sourceSize: number;
    destSize: number;
    sizeMatch: boolean;
    md5Match: boolean | null;
    sourceMd5: string | null;
    destMd5: string | null;
  }> = [];

  for (const file of files) {
    // Get source size
    let sourceSize = body.fileSizes?.[file] ?? 0;
    if (!isPeerSource && sourceSize === 0) {
      const sourcePath =
        from === localPeerAddr
          ? nodePath.resolve(localBase, file)
          : nodePath.resolve(coldBase, file);
      try {
        sourceSize = (await fsp.stat(sourcePath)).size;
      } catch {
        /* ignore */
      }
    }

    // Lazy cached source md5
    let sourceMd5Cache: string | null | undefined = undefined;
    const getSourceMd5 = async (): Promise<string | null> => {
      if (sourceMd5Cache !== undefined) return sourceMd5Cache;
      let result: string | null;
      if (isPeerSource) {
        const cs = await peerChecksumData(from, file);
        result = cs?.md5 ?? null;
      } else {
        const sourcePath =
          from === localPeerAddr
            ? nodePath.resolve(localBase, file)
            : nodePath.resolve(coldBase, file);
        try {
          result = await localMd5(sourcePath);
        } catch {
          result = null;
        }
      }
      sourceMd5Cache = result;
      return result;
    };

    // Check cold storage destination
    if (toColdStorage) {
      const destPath = nodePath.resolve(coldBase, file);
      if (!destPath.startsWith(coldBase + nodePath.sep)) continue;
      try {
        const {size: destSize} = await fsp.stat(destPath);
        const sizeMatch = sourceSize === destSize;
        let md5Match: boolean | null = null;
        let sourceMd5: string | null = null;
        let destMd5: string | null = null;
        if (sizeMatch) {
          [sourceMd5, destMd5] = await Promise.all([
            getSourceMd5(),
            localMd5(destPath),
          ]);
          if (sourceMd5 !== null) md5Match = sourceMd5 === destMd5;
        }
        conflicts.push({
          file,
          destination: 'cold-storage',
          sourceSize,
          destSize,
          sizeMatch,
          md5Match,
          sourceMd5,
          destMd5,
        });
      } catch {
        /* file doesn't exist at destination */
      }
    }

    // Check peer destinations (the local peer is checked directly on disk)
    for (const peerAddr of toPeers) {
      if (peerAddr === localPeerAddr) {
        const destPath = nodePath.resolve(localBase, file);
        if (!destPath.startsWith(localBase + nodePath.sep)) continue;
        try {
          const {size: destSize} = await fsp.stat(destPath);
          const sizeMatch = sourceSize === destSize;
          let md5Match: boolean | null = null;
          let sourceMd5: string | null = null;
          let destMd5: string | null = null;
          if (sizeMatch) {
            [sourceMd5, destMd5] = await Promise.all([
              getSourceMd5(),
              localMd5(destPath),
            ]);
            if (sourceMd5 !== null) md5Match = sourceMd5 === destMd5;
          }
          conflicts.push({
            file,
            destination: peerAddr,
            sourceSize,
            destSize,
            sizeMatch,
            md5Match,
            sourceMd5,
            destMd5,
          });
        } catch {
          /* file doesn't exist at destination */
        }
        continue;
      }
      try {
        logger.debug(`[check] head ${file} @ ${peerAddr}`);
        const headRes = await fetch(
          `http://${peerAddr}/api/v1/local-models/download?file=${encodeURIComponent(file)}`,
          {method: 'HEAD'},
        );
        if (!headRes.ok) continue;
        const destSize = parseInt(
          headRes.headers.get('content-length') ?? '0',
          10,
        );
        const sizeMatch = sourceSize === destSize;
        let md5Match: boolean | null = null;
        let sourceMd5: string | null = null;
        let destMd5: string | null = null;
        if (sizeMatch) {
          const [sm, destCs] = await Promise.all([
            getSourceMd5(),
            peerChecksumData(peerAddr, file),
          ]);
          sourceMd5 = sm;
          destMd5 = destCs?.md5 ?? null;
          if (sourceMd5 !== null && destMd5 !== null)
            md5Match = sourceMd5 === destMd5;
        }
        conflicts.push({
          file,
          destination: peerAddr,
          sourceSize,
          destSize,
          sizeMatch,
          md5Match,
          sourceMd5,
          destMd5,
        });
      } catch {
        /* peer unreachable */
      }
    }
  }

  return Response.json({conflicts});
}
