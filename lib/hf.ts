/**
 * Whether `hf download` runs with HF_HUB_ENABLE_HF_TRANSFER=1, accelerating
 * transfers via the `hf-transfer` Rust extra (see Dockerfile). Controls both
 * the server-side spawn and the copyable command shown in the download modal.
 */
export const HF_HUB_ENABLE_HF_TRANSFER = true;
