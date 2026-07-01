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
