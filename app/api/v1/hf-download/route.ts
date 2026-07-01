import {localModelsDir} from '@/lib/config';
import {isObject, readJsonBody} from '@/lib/request';
import {streamHfDownload} from '@/lib/hf-download-stream';

export async function POST(req: Request) {
  if (!localModelsDir) {
    return new Response('No local peer configured', {status: 400});
  }

  const body = await readJsonBody<{
    repoId?: unknown;
    branch?: unknown;
    filePaths?: unknown;
    sendToCold?: unknown;
    deleteAfterTransfer?: unknown;
  }>(req, isObject);
  if (body instanceof Response) return body;
  return streamHfDownload(body, req.signal);
}
