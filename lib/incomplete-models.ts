import {logger} from '@/lib/logger';
import {scanModels, type ModelFile} from '@/lib/models';
import {repoFileStatuses} from '@/lib/repo-files';
import {repoDownloadFiles} from '@/lib/hf-download';
import {listRepoFiles, type HfFileInfo} from '@/lib/hf-infer';
import {hfSummary, type AuditResult, type TjMeta} from '@/lib/audit';
import {
  readModelSidecar,
  upsertFileMeta,
  metaToEntry,
} from '@/lib/model-sidecar';
import {existsSync, statSync} from 'fs';
import nodePath from 'path';

// A repo's Hugging Face file list changes rarely, but it's a network round-trip,
// so cache the expected-file list per repo. The on-disk presence check is
// recomputed every call (cheap) so a just-finished download clears the flag.
const TTL_MS = 30 * 60 * 1000;
const treeCache = new Map<string, {files: string[]; fetchedAt: number}>();

const baseName = (p: string) => p.split('/').pop() ?? p;
// Pure docs / repo metadata a complete, runnable model doesn't depend on — a
// missing README isn't an incomplete download, but a missing index.json or
// config is, so those are kept.
const CLUTTER_EXT = /\.(md|txt|png|jpe?g|gif|webp|svg|pdf)$/i;
const CLUTTER_NAME = /^(\.gitattributes|\.gitignore|license.*|readme.*)$/i;
const isClutter = (p: string) => {
  const n = baseName(p);
  return CLUTTER_EXT.test(n) || CLUTTER_NAME.test(n);
};

// The files a complete download of `repoId` would contain — what the downloader
// pulls (repoDownloadFiles), minus pure docs/metadata. Cached per repo.
async function expectedFiles(repoId: string): Promise<string[]> {
  const hit = treeCache.get(repoId);
  if (hit && Date.now() - hit.fetchedAt < TTL_MS) return hit.files;
  const res = await fetch(
    `https://huggingface.co/api/models/${repoId}/tree/main`,
    {headers: {'User-Agent': 'tj/1.0'}},
  );
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const entries = (await res.json()) as Array<{type: string; path: string}>;
  const files = repoDownloadFiles(
    entries.filter((e) => e.type === 'file').map((e) => e.path),
  ).filter((p) => !isClutter(p));
  treeCache.set(repoId, {files, fetchedAt: Date.now()});
  return files;
}

const groupName = (f: ModelFile) =>
  f.isSplit ? f.representativeFilename : f.filename;

// A GGUF repo is downloaded one quant at a time, so its full repo file list
// doesn't describe a "complete" local copy — only non-GGUF models (ONNX/Kokoro,
// safetensors, …) are judged complete by having every expected file.
const isSelfContainedGguf = (files: ModelFile[]) =>
  files.every((f) => groupName(f).toLowerCase().endsWith('.gguf'));

/**
 * Repo ids present in `storagePath` whose local copy is missing files a full
 * download would include (e.g. Kokoro with only voices-v1.0.bin, missing
 * kokoro-v1.0.onnx). GGUF models are skipped — their per-quant downloads aren't
 * judged against the whole repo. A network failure for a repo leaves it
 * unflagged rather than falsely reported incomplete.
 */
export async function findIncompleteRepos(
  storagePath: string,
  lemonadePath?: string,
): Promise<string[]> {
  const base = nodePath.resolve(storagePath);
  const local = scanModels(storagePath, lemonadePath);
  const candidates = local.filter((m) => !isSelfContainedGguf(m.files));
  const results = await Promise.all(
    candidates.map(async (m) => {
      try {
        const expected = await expectedFiles(m.name);
        if (expected.length === 0) return null;
        const dir = nodePath.join(base, m.name);
        const incomplete = expected.some(
          (f) => !existsSync(nodePath.join(dir, f)),
        );
        return incomplete ? m.name : null;
      } catch (e) {
        logger.debug(
          `[incomplete] ${m.name}: ${e instanceof Error ? e.message : String(e)}`,
        );
        return null;
      }
    }),
  );
  return results.filter((x): x is string => x != null);
}

/**
 * Repo ids present in `storagePath` with at least one local file that audits
 * `invalid` — its size differs from Hugging Face, or its sidecar can't attest it
 * (unknown source size, or a recorded size/hash that disagrees with the source);
 * see `repoFileStatuses`. Like `findIncompleteRepos`, only non-GGUF (whole-repo)
 * models are judged: a GGUF repo's per-quant copies are audited file-by-file, so
 * a bad quant already surfaces in the audit column. A network failure for a repo
 * leaves it unflagged rather than falsely reported invalid.
 */
export async function findReposWithInvalidFiles(
  storagePath: string,
  lemonadePath?: string,
): Promise<string[]> {
  const local = scanModels(storagePath, lemonadePath);
  const candidates = local.filter((m) => !isSelfContainedGguf(m.files));
  const results = await Promise.all(
    candidates.map(async (m) => {
      try {
        const files = await repoFileStatuses(storagePath, m.name);
        return files.some((f) => f.state === 'invalid') ? m.name : null;
      } catch (e) {
        logger.debug(
          `[invalid] ${m.name}: ${e instanceof Error ? e.message : String(e)}`,
        );
        return null;
      }
    }),
  );
  return results.filter((x): x is string => x != null);
}

/**
 * Synthetic `incomplete` audit verdicts for the files a full download would
 * include but that aren't on disk under `storageBase` (e.g. a Kokoro repo's
 * kokoro-v1.0.onnx or its index.json). Uses the same expected set as the table
 * flag, so the two agree. A large (LFS) file carries the HF summary that powers
 * re-download; a small companion (no checksum) is still flagged, just without
 * it. GGUF repos are skipped — their per-quant downloads are judged
 * file-by-file, and a missing projector is handled by detectMissingMmproj.
 */
export async function detectMissingExpectedFiles(
  repoIds: string[],
  storageBase: string,
  branch: string,
): Promise<AuditResult[]> {
  const base = nodePath.resolve(storageBase);
  const out: AuditResult[] = [];
  for (const repoId of repoIds) {
    const lfs = await listRepoFiles(repoId, branch);
    if (!lfs) continue;
    const repoPaths = lfs.map((f) => f.repoPath);
    const hasGguf = repoPaths.some((p) => /\.gguf$/i.test(p));
    const hasSafetensors = repoPaths.some((p) => /\.safetensors$/i.test(p));
    if (hasGguf && !hasSafetensors) continue; // per-quant GGUF repo
    let expected: string[];
    try {
      expected = await expectedFiles(repoId);
    } catch {
      continue; // network failure: don't falsely flag
    }
    const lfsByPath = new Map(lfs.map((f) => [f.repoPath, f]));
    const dir = nodePath.join(base, repoId);
    // Files this repo's sidecar currently records as missing: a stale flag on a
    // now-present file is cleared below so the cached audit agrees with disk.
    const sidecar = await readModelSidecar(base, repoId);
    const flaggedMissing = new Set(
      (sidecar?.files ?? []).filter((f) => f.missing).map((f) => f.path),
    );
    for (const repoPath of expected) {
      const full = nodePath.join(dir, repoPath);
      const hf = lfsByPath.get(repoPath);
      if (!existsSync(full)) {
        out.push({
          file: `${repoId}/${repoPath}`,
          status: 'incomplete',
          message: 'expected file not downloaded',
          ...(hf ? {hf: hfSummary(hf)} : {}),
        });
        await persistMissingState(base, repoId, repoPath, branch, hf, 0, true);
      } else if (flaggedMissing.has(repoPath)) {
        let size = 0;
        try {
          size = statSync(full).size;
        } catch {
          /* unreadable: recorded as 0, the per-file audit re-measures */
        }
        await persistMissingState(
          base,
          repoId,
          repoPath,
          branch,
          hf,
          size,
          false,
        );
      }
    }
  }
  return out;
}

/**
 * Record (or clear) the `missing` flag for one file on its model sidecar. The
 * HF summary, when known, lets a later re-download verify against source.
 * Best-effort: a sidecar write failure must not fail the audit.
 */
async function persistMissingState(
  base: string,
  repoId: string,
  repoPath: string,
  branch: string,
  hf: HfFileInfo | undefined,
  computedSize: number,
  missing: boolean,
): Promise<void> {
  const meta: TjMeta = {
    modelUrl: `https://huggingface.co/${repoId}`,
    originUrl: `https://huggingface.co/${repoId}/blob/${branch}/${repoPath}`,
    ...(hf?.commit ? {sourceCommit: hf.commit} : {}),
    ...(hf?.commitDate ? {sourceCommitDate: hf.commitDate} : {}),
    sourceSize: hf?.size ?? 0,
    computedSize,
    sourceSha256: hf?.sha256 ?? '',
    computedSha256: '',
    ...(missing ? {missing: true} : {}),
  };
  try {
    await upsertFileMeta(base, repoId, repoId, metaToEntry(repoPath, meta));
  } catch (e) {
    logger.warn(
      `[incomplete] failed to record missing state for ${repoId}/${repoPath}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}
