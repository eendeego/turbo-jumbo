import path from 'path';
import {duplicateBasenames, scanModels} from '@/lib/models';
import {
  auditFile,
  duplicateResult,
  type AuditProgressEvent,
  type AuditResult,
} from '@/lib/audit';
import {proxyAuditRequest, resolveAuditLocation} from '@/lib/audit-location';
import {hashProgressEmitter} from '@/lib/audit-progress';
import {clearHfCache} from '@/lib/hf-infer';

// How many files to audit at once. Each job reads an entire (multi-GB) file to
// hash it, so this is capped low: too high thrashes a single disk and the runs
// get slower, not faster. Override with AUDIT_CONCURRENCY for faster storage.
const CONCURRENCY = Number(process.env.AUDIT_CONCURRENCY) || 4;

// SHA256 progress events per file are thinned to one per this interval (the
// final 100% event is always sent), keeping the stream light next to the
// multi-second hashes it reports on.
const PROGRESS_INTERVAL_MS = 500;

export async function POST(req: Request) {
  const body = (await req.json()) as {
    location?: string;
    files?: string[];
  };
  const {files} = body;

  const target = resolveAuditLocation(body.location);
  if (!target) {
    return new Response('Unsupported audit location', {status: 400});
  }
  if (target.kind === 'peer') {
    return proxyAuditRequest(target.peer, '/api/v1/audit', body, req.signal);
  }
  const root = target.basePath;

  // Audit only the explicitly selected files (relative paths from the storage
  // root, the same identifiers copy/delete use).
  const selected = new Set(files ?? []);

  // Fresh inference cache per run; abort the (multi-GB) hashing if the client
  // disconnects so we don't keep working on a response nobody is reading.
  clearHfCache();
  const abortController = new AbortController();
  req.signal.addEventListener('abort', () => abortController.abort(), {
    once: true,
  });
  const {signal} = abortController;

  const models = scanModels(root);
  // Basename collisions across the whole location (not just the selection):
  // a selected file is a duplicate even when its twin wasn't selected.
  const dups = duplicateBasenames(models);
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

    // Per-file hashing progress, interleaved with the verdicts.
    const hashProgress = (file: string) =>
      hashProgressEmitter(file, (e) => void emit(e), PROGRESS_INTERVAL_MS);

    // Collect one job per selected file. A job yields that file's verdict, so
    // they can be run concurrently and emitted in completion order — results are
    // keyed by path, so order doesn't matter to the client.
    const jobs: Array<() => Promise<AuditResult>> = [];
    for (const model of models) {
      for (const file of model.files) {
        if (file.isSplit) {
          // A split with missing shards fails fast: every selected shard of it
          // is reported incomplete (keyed by its own path so the row matches).
          const incomplete = file.missingIndices.length > 0;
          for (const shard of file.files) {
            if (!selected.has(shard.path)) continue;
            const dupPaths = dups.get(path.basename(shard.path));
            if (dupPaths) {
              const result = duplicateResult(shard.path, dupPaths);
              jobs.push(() => Promise.resolve(result));
            } else if (incomplete) {
              const result: AuditResult = {
                file: shard.path,
                status: 'incomplete',
                message: `missing shards: ${file.missingIndices.join(', ')}`,
              };
              jobs.push(() => Promise.resolve(result));
            } else {
              jobs.push(() =>
                auditFile(
                  root,
                  shard.path,
                  model.name,
                  path.basename(shard.path),
                  signal,
                  undefined,
                  hashProgress(shard.path),
                ),
              );
            }
          }
        } else {
          if (!selected.has(file.path)) continue;
          const dupPaths = dups.get(file.filename);
          if (dupPaths) {
            const result = duplicateResult(file.path, dupPaths);
            jobs.push(() => Promise.resolve(result));
          } else {
            jobs.push(() =>
              auditFile(
                root,
                file.path,
                model.name,
                file.filename,
                signal,
                undefined,
                hashProgress(file.path),
              ),
            );
          }
        }
      }
    }

    // Bounded worker pool: each worker pulls the next job until they run out or
    // the client disconnects, emitting verdicts as they complete.
    let next = 0;
    const worker = async () => {
      while (!signal.aborted) {
        const i = next++;
        if (i >= jobs.length) return;
        const result = await jobs[i]();
        if (signal.aborted) return;
        await emit(result);
      }
    };
    await Promise.all(
      Array.from({length: Math.min(CONCURRENCY, jobs.length)}, worker),
    );

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
