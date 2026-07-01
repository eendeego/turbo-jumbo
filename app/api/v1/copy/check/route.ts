import {localModelsDir, coldStorageDir, localPeer} from '@/lib/config';
import {logger} from '@/lib/logger';
import nodePath from 'path';
import {promises as fsp} from 'fs';
import {execFile} from 'child_process';
import {promisify} from 'util';

const execFileP = promisify(execFile);

type SourceFile = {path: string; from: string; size: number};

async function localMd5(fullPath: string): Promise<string> {
  const {stdout} = await execFileP('md5sum', [fullPath]);
  return stdout.split(/\s+/)[0];
}

async function peerChecksumData(
  peerAddr: string,
  file: string,
): Promise<{size: number; md5: string} | null> {
  try {
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
    files: SourceFile[];
    toColdStorage: boolean;
    toPeers: string[];
  };

  const {files, toColdStorage, toPeers} = body;
  const localPeerAddr = localPeer?.address ?? '';
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

  for (const f of files) {
    try {
      const {path: file, from, size: sourceSize} = f;

      // Lazy cached source md5
      let sourceMd5Cache: string | null | undefined = undefined;
      const getSourceMd5 = async (): Promise<string | null> => {
        if (sourceMd5Cache !== undefined) return sourceMd5Cache;
        let result: string | null;
        if (from === 'cold-storage') {
          try {
            result = await localMd5(nodePath.resolve(coldBase, file));
          } catch {
            result = null;
          }
        } else if (from === localPeerAddr) {
          try {
            result = await localMd5(nodePath.resolve(localBase, file));
          } catch {
            result = null;
          }
        } else {
          const cs = await peerChecksumData(from, file);
          result = cs?.md5 ?? null;
        }
        sourceMd5Cache = result;
        return result;
      };

      const destinations = [
        ...(toColdStorage ? ['cold-storage'] : []),
        ...toPeers,
      ];

      for (const destination of destinations) {
        if (destination === from) continue;

        let destSize: number | null = null;
        let destMd5Fn: () => Promise<string | null>;

        if (destination === 'cold-storage') {
          const destPath = nodePath.resolve(coldBase, file);
          if (!destPath.startsWith(coldBase + nodePath.sep)) continue;
          try {
            destSize = (await fsp.stat(destPath)).size;
          } catch {
            continue;
          }
          destMd5Fn = async () => {
            try {
              return await localMd5(destPath);
            } catch {
              return null;
            }
          };
        } else if (destination === localPeerAddr) {
          const destPath = nodePath.resolve(localBase, file);
          if (!destPath.startsWith(localBase + nodePath.sep)) continue;
          try {
            destSize = (await fsp.stat(destPath)).size;
          } catch {
            continue;
          }
          destMd5Fn = async () => {
            try {
              return await localMd5(destPath);
            } catch {
              return null;
            }
          };
        } else {
          try {
            const headRes = await fetch(
              `http://${destination}/api/v1/local-models/download?file=${encodeURIComponent(file)}`,
              {method: 'HEAD'},
            );
            if (!headRes.ok) continue;
            destSize = parseInt(
              headRes.headers.get('content-length') ?? '0',
              10,
            );
          } catch {
            continue;
          }
          destMd5Fn = async () => {
            const cs = await peerChecksumData(destination, file);
            return cs?.md5 ?? null;
          };
        }

        const sizeMatch = sourceSize === destSize;
        let md5Match: boolean | null = null;
        let sourceMd5: string | null = null;
        let destMd5: string | null = null;
        if (sizeMatch) {
          [sourceMd5, destMd5] = await Promise.all([
            getSourceMd5(),
            destMd5Fn(),
          ]);
          if (sourceMd5 !== null && destMd5 !== null)
            md5Match = sourceMd5 === destMd5;
        }
        conflicts.push({
          file,
          destination,
          sourceSize,
          destSize: destSize ?? 0,
          sizeMatch,
          md5Match,
          sourceMd5,
          destMd5,
        });
      }
    } catch {
      logger.debug(`[check] skipping file ${f.path}: not present`);
    }
  }

  return Response.json({conflicts});
}
