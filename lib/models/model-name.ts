// Pure helpers for presenting model names. No node-only deps, so these are safe
// to import from both server code (lib/models/models.ts) and client components.

/**
 * Extract the `org/repo` identity from a sidecar `modelUrl` such as
 * `https://huggingface.co/unsloth/Qwen3-GGUF`. Returns null when the URL isn't a
 * well-formed huggingface.co model URL.
 */
export function repoIdFromModelUrl(modelUrl: string): string | null {
  const m = modelUrl
    .trim()
    .match(
      /^https?:\/\/huggingface\.co\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)\/?$/,
    );
  return m ? m[1] : null;
}

/**
 * The label to show for a model identity: the repo segment of an `org/repo`
 * (e.g. `Qwen3-GGUF` from `unsloth/Qwen3-GGUF`), or the name unchanged when it
 * isn't an `org/repo` (a filename-derived name has no slash).
 */
export function modelDisplayName(name: string): string {
  const slash = name.lastIndexOf('/');
  return slash === -1 ? name : name.slice(slash + 1);
}

/**
 * The org segment of an `org/repo` identity (e.g. `unsloth` from
 * `unsloth/Qwen3-GGUF`), or null when the name has no org prefix (a
 * filename-derived name has no slash). Used to disambiguate two models that
 * share a repo name but come from different orgs.
 */
export function modelOrg(name: string): string | null {
  const slash = name.lastIndexOf('/');
  return slash === -1 ? null : name.slice(0, slash);
}

/**
 * Order two model identities by repo name, ignoring the org prefix, so a table
 * groups by the model (Qwen3-GGUF) rather than by who published it. Use as a
 * `.sort` comparator: `models.sort((a, b) => compareByRepoName(a.name, b.name))`.
 */
export function compareByRepoName(a: string, b: string): number {
  return modelDisplayName(a).localeCompare(modelDisplayName(b), undefined, {
    sensitivity: 'base',
  });
}

/**
 * A GGUF projector file (mmproj-F16.gguf, mmproj-BF16.gguf, …). Pass a
 * basename. Pure and client-safe, so both the table builders and the
 * server-only mmproj audit can share one definition.
 */
export function isMmprojFilename(basename: string): boolean {
  const lower = basename.toLowerCase();
  return lower.startsWith('mmproj') && lower.endsWith('.gguf');
}
