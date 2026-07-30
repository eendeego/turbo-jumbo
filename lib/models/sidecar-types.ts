// The sidecar data model and its pure derivations — no filesystem I/O, so this
// is safe to import from client components. The `fs`-backed read/write helpers
// live in `@/lib/model-sidecar`, which re-exports everything here.

export const MODEL_SIDECAR_NAME = 'tjmodel.json';

/** Filename suffix of a legacy per-file provenance sidecar (see tjmeta.ts). */
export const TJMETA_SUFFIX = '.tjmeta.json';

/** A per-file provenance record inside a model sidecar (a TjMeta without modelUrl). */
export interface TjModelFile {
  path: string; // file path relative to the model dir (the manifest key)
  originUrl: string;
  sourceCommit?: string;
  sourceCommitDate?: string;
  sourceSize: number;
  computedSize: number;
  sourceSha256: string;
  computedSha256: string;
  missing?: boolean; // expected on HF but absent locally (recorded by the audit)
}

/** A model's sidecar: shared identity plus one record per file. */
export interface TjModel {
  modelUrl: string; // https://huggingface.co/<repoId>
  repoId: string;
  // The model's revision, derived from its files: the shared file `sourceCommit`
  // when they all agree, `MIXED_COMMIT` when they don't (or one is missing),
  // omitted when no file records a commit. Maintained by upsert/remove.
  sourceCommit?: string;
  // The repo's HEAD commit on its branch — the revision HuggingFace's cache names
  // its `snapshots/<rev>/` directory after (e.g. what Lemonade mirrors). Unlike
  // `sourceCommit` this is repo-level, not derived from files: it's resolved from
  // HF during audit and set directly. Omitted until an audit resolves it.
  repoCommit?: string;
  repoCommitDate?: string; // ISO 8601 date of `repoCommit`, when known
  files: TjModelFile[];
}

/** The model `sourceCommit` value signalling files disagree on their revision. */
export const MIXED_COMMIT = 'mixed';

/** A model's sidecar reduced to its model-level fields plus a file roll-up. */
export interface SidecarSummary {
  repoId: string;
  modelUrl: string;
  sourceCommit?: string; // file-derived; may be MIXED_COMMIT
  repoCommit?: string; // repo HEAD commit
  repoCommitDate?: string; // ISO 8601 date of repoCommit
  fileCount: number;
  totalSourceSize: number;
}

/**
 * One storage tier's roll-up of a model's sidecar files (count + total source
 * size), for the name hovercard. Populated only when the local and cold copies
 * differ — e.g. holding different quantizations — so the hovercard can show
 * `Local N · size` / `Cold N · size` instead of one copy's total standing in for
 * the whole model.
 */
export interface SidecarLocation {
  label: string;
  fileCount: number;
  totalSourceSize: number;
}

/** The model-level summary of a parsed sidecar, for the model-name hovercard. */
export function summarizeModel(model: TjModel): SidecarSummary {
  const files = model.files ?? [];
  return {
    repoId: model.repoId,
    modelUrl: model.modelUrl,
    ...(model.sourceCommit ? {sourceCommit: model.sourceCommit} : {}),
    ...(model.repoCommit ? {repoCommit: model.repoCommit} : {}),
    ...(model.repoCommitDate ? {repoCommitDate: model.repoCommitDate} : {}),
    fileCount: files.length,
    totalSourceSize: files.reduce((sum, f) => sum + (f.sourceSize ?? 0), 0),
  };
}

/** A single file's recorded provenance, for the per-file hovercard. */
export interface FileProvenance {
  originUrl: string;
  sourceCommit?: string;
  sourceCommitDate?: string;
  sourceSize: number;
  computedSize: number;
  sourceSha256: string;
  computedSha256: string;
  missing?: boolean;
}

/**
 * Normalize a file record (a `TjModelFile` or a `TjMeta`) to a `FileProvenance`,
 * dropping fields the per-file hovercard doesn't use and omitting empty optionals.
 */
export function fileProvenance(f: FileProvenance): FileProvenance {
  return {
    originUrl: f.originUrl,
    ...(f.sourceCommit ? {sourceCommit: f.sourceCommit} : {}),
    ...(f.sourceCommitDate ? {sourceCommitDate: f.sourceCommitDate} : {}),
    sourceSize: f.sourceSize,
    computedSize: f.computedSize,
    sourceSha256: f.sourceSha256,
    computedSha256: f.computedSha256,
    ...(f.missing ? {missing: true} : {}),
  };
}

/**
 * A `SidecarSummary` over an arbitrary subset of a model's files (e.g. one split
 * quant's shards): the shared `sourceCommit` (or `MIXED_COMMIT`) derived from
 * those files, their count, and total source size. No repo-level `repoCommit`.
 */
export function summarizeFiles(
  modelUrl: string,
  repoId: string,
  files: TjModelFile[],
): SidecarSummary {
  const sourceCommit = deriveModelCommit(files);
  return summarizeModel({
    modelUrl,
    repoId,
    ...(sourceCommit ? {sourceCommit} : {}),
    files,
  });
}

/**
 * A model's revision from its files: the shared `sourceCommit` when every file
 * has it and they all match, `MIXED_COMMIT` when they differ or any file is
 * missing one, and undefined when no file records a commit at all.
 */
export function deriveModelCommit(files: TjModelFile[]): string | undefined {
  const defined = files
    .map((f) => f.sourceCommit)
    .filter((c): c is string => !!c);
  if (defined.length === 0) return undefined;
  const allPresentAndEqual =
    defined.length === files.length && new Set(defined).size === 1;
  return allPresentAndEqual ? defined[0] : MIXED_COMMIT;
}
