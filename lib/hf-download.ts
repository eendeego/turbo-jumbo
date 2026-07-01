import {isWeightFile} from '@/lib/models';

// In a safetensors model download these are clutter, not part of the model:
// alternate-format weights (including GGUF), docs, images, and repo metadata.
// Everything else — config/tokenizer/index JSON, tokenizer.model, merges.txt,
// chat templates, custom modeling code — is kept so the model is runnable.
const NON_ESSENTIAL_EXT_RE =
  /\.(gguf|onnx|tflite|ot|pt|pth|ckpt|msgpack|h5|md|png|jpe?g|gif|webp|svg|pdf)$/i;
const NON_ESSENTIAL_NAME_RE =
  /^(\.gitattributes|\.gitignore|license.*|readme.*)$/i;

function isNonEssential(p: string): boolean {
  const name = p.split('/').pop() ?? p;
  return NON_ESSENTIAL_EXT_RE.test(name) || NON_ESSENTIAL_NAME_RE.test(name);
}

/**
 * The files to offer from a repo's root listing for download. A safetensors
 * model is unusable without its companion config/tokenizer/index files, so a
 * repo containing safetensors weights lists everything except clutter (other
 * weight formats, docs, images, git/license metadata). A GGUF/bin repo is
 * self-contained, so only its weight files are listed (the user picks a quant).
 */
export function repoDownloadFiles(paths: string[]): string[] {
  const hasSafetensors = paths.some((p) => /\.safetensors$/i.test(p));
  if (!hasSafetensors) return paths.filter(isWeightFile);
  return paths.filter((p) => !isNonEssential(p));
}

/**
 * The files to pre-select in the download picker. A safetensors model is taken
 * whole — the list is already curated to its weights + companions. For a GGUF
 * repo: the named file's shard set or exact match, the full list when a pasted
 * file matches nothing, or nothing for a bare repo URL (the user picks a quant).
 */
export function defaultDownloadSelection(
  files: Array<{path: string}>,
  filename: string | null,
): Set<string> {
  if (files.some((f) => /\.safetensors$/i.test(f.path))) {
    return new Set(files.map((f) => f.path));
  }
  if (!filename) return new Set();
  const shardMatch = filename.match(
    /^(.+)-(\d{5})-of-(\d{5})(\.(?:gguf|bin))$/i,
  );
  if (shardMatch) {
    const [, base, , total, ext] = shardMatch;
    const shards = files.filter((f) => {
      const name = f.path.split('/').pop() ?? '';
      return name.startsWith(`${base}-`) && name.endsWith(`-of-${total}${ext}`);
    });
    if (shards.length > 0) return new Set(shards.map((f) => f.path));
  }
  const exact = files.find((f) => (f.path.split('/').pop() ?? '') === filename);
  if (exact) return new Set([exact.path]);
  return new Set(files.map((f) => f.path));
}
