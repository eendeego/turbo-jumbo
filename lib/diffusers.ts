// A `diffusers` pipeline repo (Stable Diffusion / SDXL / FLUX): the model is
// split into component subfolders (`unet/`, `vae/`, `text_encoder/`, …), each
// holding `diffusion_pytorch_model[.fp16].safetensors` or `model[.fp16]
// .safetensors`. The repo also ships every weight at two precisions (fp16 and
// fp32) and often alternate packagings (a single-file checkpoint, an ONNX
// export) — so the flat file list is large and redundant. We present it as
// present-only, precision-collapsed component rows instead. Pure and
// dependency-free so both the scanner and the client bundle can import it.

const COMPONENT_DIRS = [
  'unet',
  'vae',
  'text_encoder',
  'text_encoder_2',
  'transformer',
];

// A component weight directly inside one of the standard folders — anchored so a
// Comfy-Org `split_files/vae/…` bundle (handled as pick-one) doesn't match.
const COMPONENT_FILE_RE = new RegExp(
  `(^|/)(${COMPONENT_DIRS.join('|')})/[^/]+\\.(safetensors|bin)$`,
  'i',
);

/** Whether a path is a diffusers component weight — a `.safetensors`/`.bin`
 *  directly inside a standard component folder (`unet/`, `vae/`, …), not under
 *  `split_files/`. Such files share generic basenames
 *  (`diffusion_pytorch_model.safetensors` in both `unet/` and `vae/`), so they
 *  must be disambiguated by folder, never treated as basename duplicates. */
export function isDiffusersComponentFile(path: string): boolean {
  return !/(^|\/)split_files\//i.test(path) && COMPONENT_FILE_RE.test(path);
}

/** Whether a repo is laid out as a diffusers pipeline — has any component
 *  weight. Works on repo-relative (HF tree) or storage-relative (local) paths. */
export function isDiffusersRepo(paths: string[]): boolean {
  return paths.some(isDiffusersComponentFile);
}

const PRECISION_RE = /[._](fp16|fp32|bf16)(?=[._]|$)/i;

/**
 * The component a diffusers weight belongs to and its precision, ignoring any
 * directory prefix. A weight in a standard component folder keys by that folder
 * (`unet/…` → `unet`); a root-level single-file checkpoint keys by its filename
 * with the precision and extension stripped (`sd_xl_turbo_1.0_fp16.safetensors`
 * → `sd_xl_turbo_1.0`). Precision is the `.fp16`/`_fp16` (etc.) infix, or null.
 */
export function diffusersComponentKey(path: string): {
  component: string;
  precision: string | null;
} {
  const parts = path.split('/');
  const filename = parts.pop() ?? path;
  const parent = parts.pop() ?? '';
  const precision = filename.match(PRECISION_RE)?.[1].toLowerCase() ?? null;
  if (COMPONENT_DIRS.includes(parent.toLowerCase())) {
    return {component: parent, precision};
  }
  const component = filename
    .replace(PRECISION_RE, '')
    .replace(/\.(safetensors|bin)$/i, '');
  return {component, precision};
}
