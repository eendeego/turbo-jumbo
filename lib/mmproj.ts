// Detecting a vision model's missing mmproj (multimodal projector). The pure
// helpers here decide which mmproj a repo's file list offers and whether a copy
// already exists locally; detectMissingMmproj (added later) turns that into
// audit verdicts. Server-only — pulled in by the audit route.

import {
  expectedRelPath,
  hfSummary,
  pathImpliedRepo,
  type AuditResult,
} from '@/lib/audit';
import {parseHubCachePath} from '@/lib/hf-cache';
import {listRepoFiles} from '@/lib/hf-infer';

const basename = (p: string) => p.split('/').pop() ?? p;

/**
 * A GGUF projector file (mmproj-F16.gguf, mmproj-BF16.gguf, …). Note
 * `lib/lemonade.ts` has a separate, looser `isMmproj` (prefix-only) used to
 * *exclude* projectors when selecting weights; the two aren't shared because
 * lemonade.ts is client-reachable and this module imports server-only code.
 */
export function isMmprojName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith('mmproj') && lower.endsWith('.gguf');
}

// Preferred projector precisions, best first. Compared against full basenames.
const MMPROJ_PREFERENCE = [
  'mmproj-f16.gguf',
  'mmproj-bf16.gguf',
  'mmproj-f32.gguf',
];

/**
 * Which mmproj a repo's in-repo paths offer: the preferred precision (F16 →
 * BF16 → F32), else the first mmproj listed, else null when the repo has none.
 */
export function pickMmproj(repoPaths: string[]): string | null {
  const candidates = repoPaths.filter((p) => isMmprojName(basename(p)));
  if (candidates.length === 0) return null;
  for (const pref of MMPROJ_PREFERENCE) {
    const hit = candidates.find((p) => basename(p).toLowerCase() === pref);
    if (hit) return hit;
  }
  return candidates[0];
}

/**
 * Whether any local file is an mmproj belonging to `repoId`, across layouts:
 * a flat-mirror path `<repoId>/…/mmproj*.gguf` or a hub-cache path decoding to
 * `repoId`. `relPaths` are storage-root-relative paths from the scan.
 */
export function hasLocalMmproj(relPaths: string[], repoId: string): boolean {
  return relPaths.some((relPath) => {
    if (!isMmprojName(basename(relPath))) return false;
    const repo =
      parseHubCachePath(relPath)?.repoId ?? pathImpliedRepo(relPath)?.repoId;
    return repo === repoId;
  });
}

/**
 * Synthetic `incomplete` AuditResults for repos that have an mmproj on HF but
 * none locally — one per repo, for the preferred variant, carrying the HF
 * summary that powers re-download. Repos whose tree fetch fails are skipped
 * (no false flag). `allRelPaths` is every path in the local scan.
 */
export async function detectMissingMmproj(
  repoIds: string[],
  allRelPaths: string[],
  branch: string,
): Promise<AuditResult[]> {
  const out: AuditResult[] = [];
  for (const repoId of repoIds) {
    const files = await listRepoFiles(repoId, branch);
    if (!files) continue;
    const chosen = pickMmproj(files.map((f) => f.repoPath));
    if (!chosen) continue;
    if (hasLocalMmproj(allRelPaths, repoId)) continue;
    const hf = files.find((f) => f.repoPath === chosen);
    if (!hf) continue;
    out.push({
      file: expectedRelPath(hf),
      status: 'incomplete',
      message: 'vision projector not downloaded',
      hf: hfSummary(hf),
    });
  }
  return out;
}
