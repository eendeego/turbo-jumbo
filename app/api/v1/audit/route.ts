import path from 'path';
import {localModelsDir, coldStorageDir} from '@/lib/config';
import {scanModels} from '@/lib/models';
import {auditFile, type AuditResult} from '@/lib/audit';

export async function POST(req: Request) {
  const {location} = (await req.json()) as {location?: string};

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

    for (const model of models) {
      for (const file of model.files) {
        if (file.isSplit) {
          // A split model with missing shards fails fast at the model level.
          if (file.missingIndices.length > 0) {
            await emit({
              file: file.representativeFilename,
              status: 'incomplete',
              message: `missing shards: ${file.missingIndices.join(', ')}`,
            });
            continue;
          }
          for (const shard of file.files) {
            await emit(
              await auditFile(
                root,
                shard.path,
                model.name,
                path.basename(shard.path),
              ),
            );
          }
        } else {
          await emit(
            await auditFile(root, file.path, model.name, file.filename),
          );
        }
      }
    }

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
