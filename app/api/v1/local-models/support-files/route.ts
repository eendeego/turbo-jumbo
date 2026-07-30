import {localModelsDir} from '@/lib/config';
import {expandSupportFiles} from '@/lib/storage/support-files';
import {isObject, isStringArray, readJsonBody} from '@/lib/util/request';

// The support files (config/tokenizer/index — everything the weight scan
// doesn't track) sitting next to the given weight files in this host's local
// storage, so a copy whose source is this peer can carry them along. Called by
// the copy pre-check on the host driving the copy.
export async function POST(req: Request) {
  const body = await readJsonBody<{files: string[]}>(req, isObject);
  if (body instanceof Response) return body;
  if (!isStringArray(body.files))
    return new Response('Invalid files', {status: 400});
  if (!localModelsDir) return Response.json({files: []});
  const files = await expandSupportFiles(localModelsDir, body.files);
  return Response.json({files});
}
