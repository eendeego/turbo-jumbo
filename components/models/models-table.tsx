import type {Model, ModelFile} from '@/lib/models/model-types';
import {compareByRepoName, isMmprojFilename} from '@/lib/models/model-name';
import {normalizeModelNames} from '@/lib/models/models';
import {isDiffusersRepo, diffusersComponentKey} from '@/lib/models/diffusers';
import {fileJoinKey} from '@/lib/peers/peer-paths';
import {coldStorageRollup} from '@/lib/storage/cold-storage-rollup';
import {
  modelDirForRepo,
  fileProvenance,
  summarizeFiles,
} from '@/lib/models/model-sidecar';
import type {
  SidecarLocation,
  SidecarSummary,
  TjModelFile,
} from '@/lib/models/sidecar-types';
import type {ModelRow, QuantInfo} from './models-table-client';

// Extract the bit size from a quantization string (e.g. "Q4_K_M" → "4",
// "BF16" → "16"); falls back to the raw token when there's no number.
function quantBits(quant: string): string {
  const m = quant.match(/\d+/);
  return m ? m[0] : quant;
}

// Build one table row per model (across local + cold storage), each carrying
// its distinct quantizations and cold-storage presence flags. Pure data prep
// that runs on the server; the table renders in ModelsTableClient.
export function getModelsTableData(
  localModels: Model[],
  coldModels: Model[],
): ModelRow[] {
  return buildModelRows(localModels, coldModels);
}

export function buildModelRows(
  localScan: Model[],
  coldScan: Model[],
): ModelRow[] {
  // A model's name depends on which copies carry sidecars, so the two scans
  // can name the same model differently; reconcile before grouping by name
  // (see normalizeModelNames).
  const [localModels, coldModels] = normalizeModelNames([localScan, coldScan]);

  // The model-level sidecar summary per model name, split by tier. The primary
  // (`sidecarByName`) is the local copy's when it has one, else the cold copy's,
  // and drives the hovercard's provenance. The per-tier maps let the hovercard
  // break the file total out by location when the two copies differ.
  const localSidecarByName = new Map<string, SidecarSummary>();
  for (const m of localModels)
    if (m.sidecar) localSidecarByName.set(m.name, m.sidecar);
  const coldSidecarByName = new Map<string, SidecarSummary>();
  for (const m of coldModels)
    if (m.sidecar) coldSidecarByName.set(m.name, m.sidecar);
  const sidecarByName = new Map<string, SidecarSummary>();
  for (const m of coldModels)
    if (m.sidecar) sidecarByName.set(m.name, m.sidecar);
  for (const m of localModels)
    if (m.sidecar) sidecarByName.set(m.name, m.sidecar);

  // A model's per-location file roll-up, but only when the local and cold copies
  // actually differ (different quant, extra companion files, …) — otherwise the
  // single primary total already tells the whole story.
  const sidecarLocationsFor = (name: string): SidecarLocation[] | undefined => {
    const local = localSidecarByName.get(name);
    const cold = coldSidecarByName.get(name);
    if (!local || !cold) return undefined;
    if (
      local.fileCount === cold.fileCount &&
      local.totalSourceSize === cold.totalSourceSize
    )
      return undefined;
    const roll = (label: string, s: SidecarSummary): SidecarLocation => ({
      label,
      fileCount: s.fileCount,
      totalSourceSize: s.totalSourceSize,
    });
    return [roll('Local', local), roll('Cold', cold)];
  };

  // Manifest-key → sidecar record per model, cold first then local so the
  // local copy's record wins. Keyed by the file's model-dir-relative path.
  const recordsByName = new Map<string, Map<string, TjModelFile>>();
  const addRecords = (models: Model[]) => {
    for (const m of models) {
      if (!m.sidecarFiles) continue;
      let map = recordsByName.get(m.name);
      if (!map) {
        map = new Map();
        recordsByName.set(m.name, map);
      }
      for (const f of m.sidecarFiles) map.set(f.path, f);
    }
  };
  addRecords(coldModels);
  addRecords(localModels);

  // The sidecar record for a model's storage-relative file path, or undefined.
  const recordFor = (
    modelName: string,
    relPath: string,
  ): TjModelFile | undefined => {
    const map = recordsByName.get(modelName);
    if (!map) return undefined;
    const key = modelDirForRepo(relPath, modelName)?.key;
    return key ? map.get(key) : undefined;
  };

  // Models laid out as diffusers pipelines (component folders at two
  // precisions): presented as present-only, precision-collapsed component
  // variants rather than a whole-repo file list — so their weights key by
  // component (unet, vae, …), merging fp16/fp32 siblings, instead of by quant.
  const diffusersModels = new Set<string>();
  for (const m of [...localModels, ...coldModels]) {
    const paths = m.files.flatMap((f) =>
      f.isSplit ? f.files.map((s) => s.path) : [f.path],
    );
    if (isDiffusersRepo(paths)) diffusersModels.add(m.name);
  }

  // A projector (mmproj) is keyed by its filename, not its quant label, so a
  // real F16 weight and mmproj-F16.gguf don't collide; a diffusers weight keys
  // by its component folder; everything else keys by quant.
  const fileLabel = (f: ModelFile, isDiffusers: boolean): string => {
    const base = f.isSplit ? f.representativeFilename : f.filename;
    if (isMmprojFilename(base)) return base;
    if (isDiffusers && !f.isSplit)
      return diffusersComponentKey(f.path).component;
    return f.quant;
  };

  // Index cold files by join key. This is what survives the differences between
  // the two roots: the same file can sit at a bare path in one and under
  // <repoId>/ in the other, and the model name is sidecar-derived (so it differs
  // too). Neither the path nor the name can join them — but filename + size can,
  // and size also tells apart same-named files from different repos (e.g. an MTP
  // vs non-MTP build).
  // Files are joined by `fileJoinKey`: a specific basename (GGUF) on its own —
  // surviving the layout and per-host name differences — and a generic weight
  // name (model.safetensors) qualified by the repo-derived model name, so a
  // different repo's same-named file isn't mistaken for a cold copy.
  const fileBase = (relPath: string) => relPath.split('/').pop() ?? relPath;
  // `sha` is the file's recorded source hash (when its sidecar has one), used to
  // tell apart different builds that merely share a filename — see coldMatch.
  type ColdCandidate = {size: number; path: string; sha: string};
  const coldByKey = new Map<string, ColdCandidate[]>();
  const addCold = (key: string, size: number, p: string, sha: string) => {
    const list = coldByKey.get(key);
    if (list) list.push({size, path: p, sha});
    else coldByKey.set(key, [{size, path: p, sha}]);
  };
  // A file's recorded source hash for the model that owns its storage path.
  const srcSha = (modelName: string, relPath: string): string =>
    recordFor(modelName, relPath)?.sourceSha256 ?? '';
  for (const m of coldModels) {
    for (const f of m.files) {
      if (f.isSplit) {
        for (const s of f.files)
          addCold(
            fileJoinKey(m.name, fileBase(s.path)),
            s.size,
            s.path,
            srcSha(m.name, s.path),
          );
      } else {
        addCold(
          fileJoinKey(m.name, f.filename),
          f.size,
          f.path,
          srcSha(m.name, f.path),
        );
      }
    }
  }

  // The cold copy of a local file. The GGUF join key is a bare filename, so two
  // repos' identically-named builds share it; a recorded source hash is the
  // file's identity, so when both the local file and a candidate have one and
  // they differ, that candidate is a different build, not this file's cold copy.
  // Among the rest, prefer a size-exact match (a complete, identical copy), else
  // any (a partial/mismatched copy). null when none.
  const coldMatch = (
    key: string,
    size: number,
    sha: string,
  ): ColdCandidate | null => {
    const all = coldByKey.get(key);
    if (!all || all.length === 0) return null;
    const candidates = sha ? all.filter((c) => !c.sha || c.sha === sha) : all;
    if (candidates.length === 0) return null;
    return candidates.find((c) => c.size === size) ?? candidates[0];
  };

  // Total size of each quant's cold copy (split groups summed), for comparing
  // against peer copies of the same quant.
  const coldQuantSizes = new Map<string, number>();
  for (const m of coldModels) {
    const isDiffusers = diffusersModels.has(m.name);
    for (const f of m.files) {
      coldQuantSizes.set(
        `${m.name}::${fileLabel(f, isDiffusers)}`,
        f.isSplit ? f.totalSize : f.size,
      );
    }
  }

  // Local file paths + display name per model::fileLabel, for selection/deletion.
  // A diffusers component accumulates its precision siblings (fp16 + fp32)
  // under one key, since they're collapsed into a single variant row.
  const localPathsMap = new Map<string, string[]>();
  const localDisplayNames = new Map<string, string>();
  for (const m of localModels) {
    const isDiffusers = diffusersModels.has(m.name);
    for (const f of m.files) {
      const key = `${m.name}::${fileLabel(f, isDiffusers)}`;
      const paths = f.isSplit ? f.files.map((s) => s.path) : [f.path];
      const prev = localPathsMap.get(key);
      localPathsMap.set(key, prev && isDiffusers ? [...prev, ...paths] : paths);
      localDisplayNames.set(
        key,
        f.isSplit ? f.representativeFilename : f.filename,
      );
    }
  }

  const rowMap = new Map<string, Map<string, QuantInfo>>();
  for (const m of [...localModels, ...coldModels]) {
    const isDiffusers = diffusersModels.has(m.name);
    let quantMap = rowMap.get(m.name);
    if (!quantMap) {
      quantMap = new Map();
      rowMap.set(m.name, quantMap);
    }
    for (const f of m.files) {
      const label = fileLabel(f, isDiffusers);
      if (!quantMap.has(label)) {
        const quantKey = `${m.name}::${label}`;
        // Match each file to its cold copy by filename; size then decides
        // whether that copy is complete (identical) or just shares the name
        // (a partial/incomplete copy, or a different repo's same-named build).
        const localFiles = f.isSplit
          ? f.files.map((s) => ({
              base: fileBase(s.path),
              size: s.size,
              path: s.path,
            }))
          : [{base: f.filename, size: f.size, path: f.path}];
        const coldHits = localFiles.map((lf) =>
          coldMatch(
            fileJoinKey(m.name, lf.base),
            lf.size,
            srcSha(m.name, lf.path),
          ),
        );
        const present = coldHits.filter((c): c is ColdCandidate => c != null);
        const inColdStorage = present.length > 0;
        const coldComplete =
          inColdStorage &&
          localFiles.every((lf, i) => coldHits[i]?.size === lf.size);
        const coldPaths = present.map((c) => c.path);
        const relPaths = f.isSplit ? f.files.map((s) => s.path) : [f.path];
        // A cold size to flag, only for single-file quants where a size mismatch
        // means an incomplete/partial cold copy.
        const coldSize =
          !f.isSplit && present.length === 1 ? present[0].size : null;
        quantMap.set(label, {
          label,
          isSingleFile: !f.isSplit,
          filename: f.isSplit ? null : f.filename,
          displayName:
            localDisplayNames.get(quantKey) ??
            (f.isSplit ? f.representativeFilename : f.filename),
          inColdStorage,
          coldComplete,
          coldSize,
          coldTotalSize: coldQuantSizes.get(quantKey) ?? 0,
          size: f.isSplit ? f.totalSize : f.size,
          paths: localPathsMap.get(quantKey) ?? relPaths,
          coldPaths,
          shards: f.isSplit
            ? [...f.files]
                .sort((a, b) => a.path.localeCompare(b.path))
                .map((s) => {
                  const rec = recordFor(m.name, s.path);
                  return {
                    filename: s.path.split('/').pop() ?? s.path,
                    size: s.size,
                    ...(rec ? {provenance: fileProvenance(rec)} : {}),
                  };
                })
            : [],
          totalShards: f.isSplit ? f.totalShards : 0,
          presentShards: f.isSplit ? f.presentShards : 0,
          missingIndices: f.isSplit ? f.missingIndices : [],
          isProjector: isMmprojFilename(
            f.isSplit ? f.representativeFilename : f.filename,
          ),
          // The precisions present for a diffusers component (fp16 / fp32),
          // shown as a badge; undefined for non-diffusers quants.
          ...(isDiffusers
            ? {
                precisions: [
                  ...new Set(
                    (localPathsMap.get(quantKey) ?? relPaths)
                      .map((p) => diffusersComponentKey(p).precision)
                      .filter((x): x is string => x != null),
                  ),
                ],
              }
            : {}),
          // The file's recorded provenance: a single record for a single-file
          // quant, an across-shards aggregate for a split quant.
          ...(() => {
            if (f.isSplit) {
              const recs = f.files
                .map((s) => recordFor(m.name, s.path))
                .filter((r): r is TjModelFile => r != null);
              return recs.length > 0
                ? {
                    provenanceAggregate: summarizeFiles(
                      `https://huggingface.co/${m.name}`,
                      m.name,
                      recs,
                    ),
                  }
                : {};
            }
            const rec = recordFor(m.name, f.path);
            return rec ? {provenance: fileProvenance(rec)} : {};
          })(),
        });
      }
    }
  }

  return [...rowMap.entries()]
    .map(([name, quantMap]) => {
      const quants = [...quantMap.values()].sort(
        (a, b) =>
          Number(!!a.isProjector) - Number(!!b.isProjector) ||
          Number(quantBits(a.label)) - Number(quantBits(b.label)),
      );
      const weights = quants.filter((q) => !q.isProjector);
      const sizes = weights.map((q) => q.size).filter((s) => s > 0);
      const isDiffusers = diffusersModels.has(name);
      // A diffusers pipeline's components are additive (you need all of them),
      // so the row shows one total size, not a min–max range of alternatives.
      const total = sizes.reduce((a, b) => a + b, 0);
      const precisions = [
        ...new Set(weights.flatMap((q) => q.precisions ?? [])),
      ];
      return {
        name,
        quantizations: isDiffusers
          ? precisions.join(', ') || 'diffusers'
          : [...new Set(weights.map((q) => quantBits(q.label)))].join(', '),
        quants,
        minSize: isDiffusers
          ? total
          : sizes.length > 0
            ? Math.min(...sizes)
            : 0,
        maxSize: isDiffusers
          ? total
          : sizes.length > 0
            ? Math.max(...sizes)
            : 0,
        ...coldStorageRollup(quants),
        ...(sidecarByName.has(name) ? {sidecar: sidecarByName.get(name)} : {}),
        ...((locs) => (locs ? {sidecarLocations: locs} : {}))(
          sidecarLocationsFor(name),
        ),
      };
    })
    .sort((a, b) => compareByRepoName(a.name, b.name));
}
