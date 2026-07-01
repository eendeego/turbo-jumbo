import {localModelsDir} from '@/lib/config';
import {logger} from '@/lib/logger';
import {diskUsage} from '@/lib/disk-usage';

// Free/total bytes of the filesystem backing the local models directory — where
// a download lands — so the UI can warn before a transfer that wouldn't fit.
export async function GET() {
  if (!localModelsDir) {
    return new Response('No local peer configured', {status: 400});
  }
  try {
    return Response.json(await diskUsage(localModelsDir));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(`[disk-usage] statfs failed: ${msg}`);
    return new Response(msg, {status: 500});
  }
}
