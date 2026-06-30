import path from 'path';
import {localModelsDir, coldStorageDir} from '@/lib/config';
import {scanModels} from '@/lib/models';
import {auditFile, type AuditResult} from '@/lib/audit';
import {clearHfCache} from '@/lib/hf-infer';

// How many files to audit at once. Each job reads an entire (multi-GB) file to
// hash it, so this is capped low: too high thrashes a single disk and the runs
// get slower, not faster. Override with AUDIT_CONCURRENCY for faster storage.
const CONCURRENCY = Number(process.env.AUDIT_CONCURRENCY) || 4;

export async function POST(req: Request) {
  const {location, files} = (await req.json()) as {
    location?: string;
    files?: string[];
  };

  let basePath: string | undefined;
  if (location === 'cold-storage') {
    basePath = coldStorageDir;
  } else if (location === 'local') {
    basePath = localModelsDir;
  } else {
    return new Response('Unsupported audit location', {status: 400});
  }
  if (!basePath) {
    return new Response('Location not configured', {status: 400});
  }
  const root = basePath;

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
  const enc = new TextEncoder();
  const {readable, writable} = new TransformStream();
  const writer = writable.getWriter();

  (async () => {
    const emit = async (result: AuditResult) => {
      try {
        await writer.ready;
        await writer.write(enc.encode(JSON.stringify(result) + '\n'));
      } catch {
        /* client disconnected */
      }
    };

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
            if (incomplete) {
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
                ),
              );
            }
          }
        } else {
          if (!selected.has(file.path)) continue;
          jobs.push(() =>
            auditFile(root, file.path, model.name, file.filename, signal),
          );
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
