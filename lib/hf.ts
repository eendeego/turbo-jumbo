/**
 * Whether `hf download` runs with HF_XET_HIGH_PERFORMANCE=1, which raises
 * xet's parallelism at the cost of saturating the connection. Controls both
 * the server-side spawn and the copyable command shown in the download modal.
 */
export const HF_XET_HIGH_PERFORMANCE = false;
