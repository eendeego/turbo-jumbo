import {repoDownloadFiles} from '@/lib/hf/hf-download';

const REPO_ID_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^[A-Za-z0-9_./-]+$/;
const FOLDER_RE = /^[A-Za-z0-9_. -]+$/;

type HfEntry = {type: string; path: string; size: number};

export async function GET(req: Request) {
  const {searchParams} = new URL(req.url);
  const repoId = searchParams.get('repoId') ?? '';
  const branch = searchParams.get('branch') ?? 'main';
  const folder = searchParams.get('folder') ?? '';
  // Recurse into subdirectories. Needed to resolve a checkpoint that names a
  // nested file (e.g. a Flux VAE at split_files/vae/flux2-vae.safetensors),
  // which a root-only listing reports as just a `split_files` directory.
  const recursive = searchParams.get('recursive') === 'true';

  if (!REPO_ID_RE.test(repoId))
    return new Response('Invalid repoId', {status: 400});
  if (!BRANCH_RE.test(branch))
    return new Response('Invalid branch', {status: 400});
  if (folder && !FOLDER_RE.test(folder))
    return new Response('Invalid folder', {status: 400});

  const treePath = folder ? `${branch}/${folder}` : branch;
  const hfRes = await fetch(
    `https://huggingface.co/api/models/${repoId}/tree/${treePath}${
      recursive ? '?recursive=true' : ''
    }`,
    {headers: {'User-Agent': 'turbo-jumbo/1.0'}},
  );

  if (!hfRes.ok)
    return new Response(await hfRes.text(), {status: hfRes.status});

  const entries: HfEntry[] = await hfRes.json();

  const fileEntries = entries.filter((e) => e.type === 'file');
  // A folder is browsed in full (the user pointed at it deliberately). At the
  // repo root, list what a download needs: GGUF/bin weights for a self-contained
  // repo, or weights plus companion files for a safetensors model.
  const sizeOf = new Map(fileEntries.map((e) => [e.path, e.size]));
  const paths = folder
    ? fileEntries.map((e) => e.path)
    : repoDownloadFiles(fileEntries.map((e) => e.path));
  const files = paths.map((p) => ({path: p, size: sizeOf.get(p) ?? 0}));

  return Response.json(files);
}
