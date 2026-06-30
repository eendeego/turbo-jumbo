import {execFile} from 'child_process';
import {promises as fsp} from 'fs';
import path from 'path';
import {promisify} from 'util';
import {inferHfFile, type HfFileInfo} from '@/lib/hf-infer';

const execFileP = promisify(execFile);

export type AuditStatus =
  | 'pass'
  | 'incomplete'
  | 'checksum-mismatch'
  | 'misplaced'
  | 'unverifiable'
  | 'error';

/** The inferred HuggingFace source for a file, with links and expected values,
 *  attached to a result so the UI can explain a failure. */
export interface HfSummary {
  repoId: string;
  modelUrl: string; // repo page, e.g. https://huggingface.co/unsloth/FLUX.2-klein-9B-GGUF
  fileUrl: string; // file blob page within the repo
  expectedSize?: number; // omitted for cached results (size isn't in the sidecar)
  expectedSha256: string;
  expectedPath: string; // <repoId>/<repoPath>
}

export interface AuditResult {
  file: string; // path relative to the storage root
  status: AuditStatus;
  message?: string;
  hf?: HfSummary; // present whenever an HF source was inferred
  cached?: boolean; // derived from a sidecar (a prior run), not freshly computed
}

export interface TjMeta {
  modelUrl: string; // HF model/repo URL, e.g. https://huggingface.co/unsloth/GLM-4.7-GGUF
  originUrl: string; // HF file URL within the repo
  sourceSha256: string;
  computedSha256: string;
}

/**
 * Where a file should live relative to the storage root: the HuggingFace
 * layout mirrored on disk, i.e. `<repoId>/<repoPath>` (e.g.
 * `unsloth/FLUX.2-klein-9B-GGUF/flux-2-klein-9b-Q8_0.gguf`). `repoPath` alone
 * is only the path *within* the repo, so a file dropped at the storage root
 * must not be treated as correctly placed.
 */
export function expectedRelPath(hf: HfFileInfo): string {
  return `${hf.repoId}/${hf.repoPath}`;
}

export function hfSummary(hf: HfFileInfo): HfSummary {
  return {
    repoId: hf.repoId,
    modelUrl: `https://huggingface.co/${hf.repoId}`,
    fileUrl: `https://huggingface.co/${hf.repoId}/blob/${hf.branch}/${hf.repoPath}`,
    expectedSize: hf.size,
    expectedSha256: hf.sha256,
    expectedPath: expectedRelPath(hf),
  };
}

/**
 * Reconstruct a best-effort verdict from a previously written sidecar, without
 * re-hashing or hitting the network. The sidecar lacks an expected size, so the
 * size check is skipped (it passed when the sidecar was written): only the
 * cached sha comparison and the current placement are evaluated. Marked
 * `cached` so the UI can tone it down against a fresh result.
 */
export function cachedResultFromMeta(
  relPath: string,
  meta: TjMeta,
): AuditResult {
  const repoId = meta.modelUrl.replace(/^https:\/\/huggingface\.co\//, '');
  const pathMatch = meta.originUrl.match(
    /^https:\/\/huggingface\.co\/[^/]+\/[^/]+\/blob\/[^/]+\/(.+)$/,
  );
  const repoPath = pathMatch?.[1] ?? '';
  const hf: HfSummary | undefined =
    repoId && repoPath
      ? {
          repoId,
          modelUrl: meta.modelUrl,
          fileUrl: meta.originUrl,
          expectedSha256: meta.sourceSha256,
          expectedPath: `${repoId}/${repoPath}`,
        }
      : undefined;

  let status: AuditStatus;
  let message: string | undefined;
  if (!meta.sourceSha256) {
    status = 'unverifiable';
  } else if (meta.computedSha256 !== meta.sourceSha256) {
    status = 'checksum-mismatch';
  } else if (hf && relPath !== hf.expectedPath) {
    status = 'misplaced';
    message = `expected path ${hf.expectedPath}`;
  } else {
    status = 'pass';
  }

  return {
    file: relPath,
    status,
    ...(message ? {message} : {}),
    hf,
    cached: true,
  };
}

/**
 * Pure verdict. Order matches the spec: size (fail-fast) -> sha256 -> directory.
 * `computedSha256` is null only when hashing failed after the size matched.
 */
export function decideStatus(input: {
  hf: HfFileInfo | null;
  actualSize: number;
  relPath: string;
  computedSha256: string | null;
}): AuditStatus {
  const {hf, actualSize, relPath, computedSha256} = input;
  if (!hf) return 'unverifiable';
  if (actualSize !== hf.size) return 'incomplete';
  if (computedSha256 === null) return 'error';
  if (computedSha256 !== hf.sha256) return 'checksum-mismatch';
  if (relPath !== expectedRelPath(hf)) return 'misplaced';
  return 'pass';
}

export async function localSha256(
  fullPath: string,
  signal?: AbortSignal,
): Promise<string> {
  const {stdout} = await execFileP('sha256sum', [fullPath], {signal});
  return stdout.split(/\s+/)[0];
}

export function metaPath(fullPath: string): string {
  return `${fullPath}.tjmeta.json`;
}

export async function readMeta(fullPath: string): Promise<TjMeta | null> {
  try {
    const raw = await fsp.readFile(metaPath(fullPath), 'utf8');
    return JSON.parse(raw) as TjMeta;
  } catch {
    return null;
  }
}

export async function writeMeta(fullPath: string, meta: TjMeta): Promise<void> {
  await fsp.writeFile(metaPath(fullPath), JSON.stringify(meta, null, 2));
}

export interface FixResult {
  file: string; // original path relative to the storage root
  status: 'moved' | 'skipped' | 'error';
  to?: string; // new relative path, when moved
  message?: string;
}

/**
 * Relocate a model file (and its `.tjmeta.json` sidecar, if any) from `fromRel`
 * to `toRel`, both relative to `basePath`, creating intermediate directories.
 * The move within a storage root is a same-filesystem rename. Refuses to escape
 * the root or to overwrite an existing destination.
 */
export async function moveFileWithMeta(
  basePath: string,
  fromRel: string,
  toRel: string,
): Promise<void> {
  const fromFull = path.join(basePath, fromRel);
  const toFull = path.join(basePath, toRel);

  const rel = path.relative(basePath, toFull);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`target escapes storage root: ${toRel}`);
  }

  const destExists = await fsp
    .access(toFull)
    .then(() => true)
    .catch(() => false);
  if (destExists) {
    throw new Error(`destination already exists: ${toRel}`);
  }

  await fsp.mkdir(path.dirname(toFull), {recursive: true});
  await fsp.rename(fromFull, toFull);

  // Move the sidecar alongside if it exists; absence is fine.
  try {
    await fsp.rename(metaPath(fromFull), metaPath(toFull));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

/**
 * Audit a single physical file: infer HF source, fail-fast on size, then hash,
 * persist the sidecar, and return the verdict.
 */
export async function auditFile(
  basePath: string,
  relPath: string,
  modelName: string,
  filename: string,
  signal?: AbortSignal,
): Promise<AuditResult> {
  const fullPath = path.join(basePath, relPath);

  let actualSize: number;
  try {
    actualSize = (await fsp.stat(fullPath)).size;
  } catch {
    return {file: relPath, status: 'incomplete', message: 'file missing'};
  }

  const hf = await inferHfFile(modelName, filename);
  if (!hf) return {file: relPath, status: 'unverifiable'};
  const summary = hfSummary(hf);
  if (actualSize !== hf.size) {
    return {
      file: relPath,
      status: 'incomplete',
      message: `size ${actualSize} != expected ${hf.size}`,
      hf: summary,
    };
  }

  let computedSha256: string | null = null;
  try {
    computedSha256 = await localSha256(fullPath, signal);
  } catch {
    return {
      file: relPath,
      status: 'error',
      message: 'sha256sum failed',
      hf: summary,
    };
  }

  // Record the inferred HF source URL and cache its sha into the sidecar.
  // Note: the URL is inferred from the filename, so it is a best guess until a
  // future download-time flow records an authoritative origin.
  try {
    await writeMeta(fullPath, {
      modelUrl: summary.modelUrl,
      originUrl: summary.fileUrl,
      sourceSha256: hf.sha256,
      computedSha256,
    });
  } catch {
    // Non-fatal: still return the verdict, but note the metadata gap.
    const status = decideStatus({hf, actualSize, relPath, computedSha256});
    return {
      file: relPath,
      status,
      message: 'metadata write failed',
      hf: summary,
    };
  }

  const status = decideStatus({hf, actualSize, relPath, computedSha256});
  return {
    file: relPath,
    status,
    message:
      status === 'misplaced'
        ? `expected path ${expectedRelPath(hf)}`
        : undefined,
    hf: summary,
  };
}
