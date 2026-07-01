import path from 'path';
import {auditFile} from '@/lib/audit';
import {proxyAuditRequest, resolveAuditLocation} from '@/lib/audit-location';
import {parseHfFileUrl, resolveHfFileByPath} from '@/lib/hf-infer';

/**
 * Record the HuggingFace source for a file the audit couldn't infer. The client
 * supplies the file's blob URL; we resolve its size/checksum from the repo,
 * then run the normal audit with that source so the verdict (and sidecar) come
 * out exactly as a freshly-inferred one would — including `misplaced`, which the
 * existing Fix action can then relocate.
 */
export async function POST(req: Request) {
  const body = (await req.json()) as {
    location?: string;
    file?: string;
    url?: string;
  };
  const {file, url} = body;

  const target = resolveAuditLocation(body.location);
  if (!target) {
    return new Response('Unsupported audit location', {status: 400});
  }
  if (target.kind === 'peer') {
    return proxyAuditRequest(
      target.peer,
      '/api/v1/audit/set-source',
      body,
      req.signal,
    );
  }
  const basePath = target.basePath;

  if (!file || typeof file !== 'string') {
    return new Response('Missing file', {status: 400});
  }
  if (!url || typeof url !== 'string') {
    return new Response('Missing url', {status: 400});
  }

  const ref = parseHfFileUrl(url);
  if (!ref) {
    return Response.json(
      {error: 'Not a valid HuggingFace file URL.'},
      {status: 400},
    );
  }

  const hf = await resolveHfFileByPath(ref.repoId, ref.branch, ref.repoPath);
  if (!hf) {
    return Response.json(
      {error: `Couldn't find ${ref.repoPath} in ${ref.repoId} on HuggingFace.`},
      {status: 422},
    );
  }

  // Abort the (multi-GB) hashing if the client navigates away mid-verify.
  const abortController = new AbortController();
  req.signal.addEventListener('abort', () => abortController.abort(), {
    once: true,
  });

  const result = await auditFile(
    basePath,
    file,
    '',
    path.basename(file),
    abortController.signal,
    hf,
  );
  return Response.json({result});
}
