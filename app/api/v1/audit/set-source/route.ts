import path from 'path';
import {
  auditFile,
  type AuditProgressEvent,
  type AuditResult,
} from '@/lib/audit/audit';
import {
  proxyAuditRequest,
  resolveAuditLocation,
} from '@/lib/audit/audit-location';
import {isObject, readJsonBody} from '@/lib/util/request';
import {hashProgressEmitter} from '@/lib/audit/audit-progress';
import {
  canonicalBranch,
  parseHfFileUrl,
  resolveHfFileByPath,
} from '@/lib/hf/hf-infer';

// SHA256 progress events are thinned to one per this interval (the final 100%
// event is always sent) — same cadence as the audit route.
const PROGRESS_INTERVAL_MS = 500;

/**
 * Record the HuggingFace source for a file the audit couldn't infer. The client
 * supplies the file's blob URL; we resolve its size/checksum from the repo,
 * then run the normal audit with that source so the verdict (and sidecar) come
 * out exactly as a freshly-inferred one would — including `misplaced`, which the
 * existing Fix action can then relocate.
 *
 * Resolution failures return plain JSON errors up front; once verification
 * starts, the response streams NDJSON — `AuditProgressEvent` lines while the
 * file hashes, then the verdict as a final `AuditResult` line (distinguished
 * by its `status` field).
 */
export async function POST(req: Request) {
  const body = await readJsonBody<{
    location?: string;
    file?: string;
    url?: string;
  }>(req, isObject);
  if (body instanceof Response) return body;
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

  // A pasted commit permalink would pin every later audit to that revision;
  // verify against the branch head instead. If the file is an older revision,
  // the audit's history walk still finds and passes it.
  const hf = await resolveHfFileByPath(
    ref.repoId,
    canonicalBranch(ref.branch),
    ref.repoPath,
  );
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

  const enc = new TextEncoder();
  const {readable, writable} = new TransformStream();
  const writer = writable.getWriter();

  (async () => {
    const emit = async (event: AuditResult | AuditProgressEvent) => {
      try {
        await writer.ready;
        await writer.write(enc.encode(JSON.stringify(event) + '\n'));
      } catch {
        /* client disconnected */
      }
    };

    const result = await auditFile(
      basePath,
      file,
      '',
      path.basename(file),
      abortController.signal,
      hf,
      hashProgressEmitter(file, (e) => void emit(e), PROGRESS_INTERVAL_MS),
    );
    await emit(result);
    try {
      await writer.close();
    } catch {
      /* already closed */
    }
  })();

  return new Response(readable, {
    headers: {'Content-Type': 'application/x-ndjson'},
  });
}
