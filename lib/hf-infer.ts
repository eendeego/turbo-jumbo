export interface HfFileInfo {
  repoId: string;
  branch: string;
  repoPath: string; // path of the file within the repo
  size: number;
  sha256: string; // hex, no "sha256:" prefix
}

interface HfSearchEntry {
  id: string;
}

interface HfTreeEntry {
  type: string;
  path: string;
  size: number;
  lfs?: {oid: string; size: number};
}

const HEADERS = {'User-Agent': 'tj/1.0'};
const cache = new Map<string, HfFileInfo | null>();

/** Reset the inference cache. Call once at the start of each audit run so a
 *  transient HF outage doesn't pin a file to `unverifiable` for the process life. */
export function clearHfCache(): void {
  cache.clear();
}

export async function inferHfFile(
  modelName: string,
  filename: string,
  branch = 'main',
): Promise<HfFileInfo | null> {
  const key = `${modelName}\0${filename}\0${branch}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  const result = await resolveHfFile(modelName, filename, branch);
  cache.set(key, result);
  return result;
}

async function resolveHfFile(
  modelName: string,
  filename: string,
  branch: string,
): Promise<HfFileInfo | null> {
  let searchRes: Response;
  try {
    searchRes = await fetch(
      `https://huggingface.co/api/models?search=${encodeURIComponent(
        modelName,
      )}&filter=gguf&limit=10`,
      {headers: HEADERS},
    );
  } catch {
    return null;
  }
  if (!searchRes.ok) return null;
  const candidates = (await searchRes.json()) as HfSearchEntry[];

  for (const candidate of candidates) {
    let treeRes: Response;
    try {
      treeRes = await fetch(
        `https://huggingface.co/api/models/${candidate.id}/tree/${branch}?recursive=true&expand=true`,
        {headers: HEADERS},
      );
    } catch {
      continue;
    }
    if (!treeRes.ok) continue;
    const entries = (await treeRes.json()) as HfTreeEntry[];
    const match = entries.find(
      (e) => e.type === 'file' && e.path.split('/').pop() === filename,
    );
    if (!match) continue;

    const oid = match.lfs?.oid ?? '';
    const sha256 = oid.startsWith('sha256:')
      ? oid.slice('sha256:'.length)
      : oid;
    return {
      repoId: candidate.id,
      branch,
      repoPath: match.path,
      size: match.lfs?.size ?? match.size,
      sha256,
    };
  }
  return null;
}
