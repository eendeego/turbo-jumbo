// The model weight formats this app tracks: GGUF, safetensors, and legacy
// PyTorch `.bin`. Companion files (config.json, tokenizer, *.index.json) are
// not weights. This module is intentionally dependency-free so client bundles
// can import it without pulling in the server-only scanner (lib/models.ts,
// which transitively imports `fs`/`child_process`).
export const WEIGHT_EXT_RE = /\.(gguf|safetensors|bin)$/i;

/** Whether a path names a model weight file (by extension), ignoring any
 *  directory prefix. */
export function isWeightFile(p: string): boolean {
  return WEIGHT_EXT_RE.test(p);
}

// whisper.cpp packs several complete models into one repo as `ggml-<variant>.bin`
// (tiny, base, large-v3-turbo, optionally quantized). Each is a standalone
// single-file model, so it's treated as its own variant — like a GGUF quant —
// rather than a part of one whole-repo model.
const GGML_MODEL_RE = /^ggml-(.+)\.bin$/i;

/** The variant a whisper.cpp `ggml-<variant>.bin` filename names (e.g. `tiny`,
 *  `large-v3-turbo`), ignoring any directory prefix. Null for anything else. */
export function ggmlModelVariant(p: string): string | null {
  const base = p.split('/').pop() ?? p;
  return base.match(GGML_MODEL_RE)?.[1] ?? null;
}
