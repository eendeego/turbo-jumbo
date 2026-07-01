import {isWeightFile} from '@/lib/weight-files';

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
 * The files to offer from a repo's root listing for download.
 *
 *  - A GGUF repo is self-contained: list only its weight files and let the user
 *    pick a quant.
 *  - A safetensors model is unusable without its companion config/tokenizer/
 *    index files, but its repo is often cluttered with alternate-format weights,
 *    docs and images, so list everything except that clutter.
 *  - Any other model repo (ONNX/Kokoro TTS, Ryzen AI, …) isn't self-contained
 *    and its weights aren't a recognized pick-one format, so take the whole repo
 *    — matching Lemonade's "non-GGUF → download all files" rule (see
 *    model_manager.cpp). This is what was dropping Kokoro's `.onnx`, which
 *    `isWeightFile` doesn't recognize.
 */
export function repoDownloadFiles(paths: string[]): string[] {
  // Safetensors first: such a repo is a safetensors model even when it also
  // carries a stray alternate-format weight (a .gguf/.onnx among the clutter).
  if (paths.some((p) => /\.safetensors$/i.test(p)))
    return paths.filter((p) => !isNonEssential(p));
  if (paths.some((p) => /\.gguf$/i.test(p))) return paths.filter(isWeightFile);
  // A repo of standalone .bin weights (ggml whisper.cpp-style) is pick-one like
  // GGUF — each .bin is a complete model, addressed one at a time. List the
  // weights individually rather than the whole repo. See isPickOneBinRepo.
  if (isPickOneBinRepo(paths)) return paths.filter(isWeightFile);
  return paths;
}

/**
 * Whether a repo is a Comfy-Org "split_files" component bundle — every
 * safetensors sits under a `split_files/<role>/` directory (e.g.
 * `Comfy-Org/vae-text-encorder-for-flux-klein-9b`: a VAE plus several
 * text-encoder quants). Each file is an independent component or quantization
 * the Lemonade catalog addresses one at a time, not one whole-repo model needing
 * every file — so they're picked individually like GGUF quants, and an
 * un-downloaded one isn't "missing". The `split_files/` layout is the signal
 * both the HF tree and a local copy's paths carry, and it keeps normal/sharded
 * safetensors models (weights at the repo root) untouched.
 */
export function isPickOneSafetensorsRepo(paths: string[]): boolean {
  const sts = paths.filter((p) => /\.safetensors$/i.test(p));
  return sts.length > 0 && sts.every((p) => /(^|\/)split_files\//i.test(p));
}

/**
 * Whether a repo holds independent single-file `.bin` weights you pick one of —
 * ggml whisper.cpp-style (e.g. `ggerganov/whisper.cpp`, ~40 standalone
 * `ggml-*.bin` models), where Lemonade fetches one named `.bin` per catalog
 * entry, not the whole repo. Used to keep such repos out of whole-repo
 * downloads and completeness checks.
 *
 * Conservatively gated so whole-repo `.bin` models aren't misread: requires
 * *several* `.bin` weights (a lone `.bin` is a single model, taken whole), no
 * `.onnx`/`.safetensors`/`.gguf` (Kokoro/ONNX/safetensors are whole-repo), and
 * no `config.json` (a transformers/pytorch model whose weights need it — even
 * when sharded into multiple `.bin`).
 */
export function isPickOneBinRepo(paths: string[]): boolean {
  const bins = paths.filter((p) => /\.bin$/i.test(p));
  if (bins.length < 2) return false;
  if (paths.some((p) => /\.(onnx|safetensors|gguf)$/i.test(p))) return false;
  if (paths.some((p) => /(^|\/)config\.json$/i.test(p))) return false;
  return true;
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
