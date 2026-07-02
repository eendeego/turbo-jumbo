export type ParsedUrl = {
  repoId: string;
  branch: string;
  folder: string | null;
  filename: string | null;
};

/**
 * Parse a Hugging Face reference into its repo, branch, optional folder and
 * file. Accepts a bare `org/repo`, a repo URL, a `blob|tree/<branch>` URL, and a
 * `blob|resolve/<branch>/<path>` file URL. Returns null when the string isn't a
 * recognizable HF reference.
 */
export function parseHfUrl(url: string): ParsedUrl | null {
  const s = url.trim().replace(/\/+$/, '');

  const fileMatch = s.match(
    /^https?:\/\/huggingface\.co\/([^/]+\/[^/]+)\/(blob|resolve)\/([^/]+)\/(.+)$/,
  );
  if (fileMatch) {
    const repoId = fileMatch[1];
    const branch = fileMatch[3];
    const filePath = fileMatch[4];
    const slashIdx = filePath.indexOf('/');
    const folder = slashIdx !== -1 ? filePath.slice(0, slashIdx) : null;
    const filename = filePath.split('/').pop()!;
    return {repoId, branch, folder, filename};
  }

  const blobRootMatch = s.match(
    /^https?:\/\/huggingface\.co\/([^/]+\/[^/]+)\/(?:blob|tree)\/([^/]+)$/,
  );
  if (blobRootMatch) {
    return {
      repoId: blobRootMatch[1],
      branch: blobRootMatch[2],
      folder: null,
      filename: null,
    };
  }

  const repoUrlMatch = s.match(
    /^https?:\/\/huggingface\.co\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/,
  );
  if (repoUrlMatch) {
    return {
      repoId: repoUrlMatch[1],
      branch: 'main',
      folder: null,
      filename: null,
    };
  }

  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s)) {
    return {repoId: s, branch: 'main', folder: null, filename: null};
  }

  return null;
}
