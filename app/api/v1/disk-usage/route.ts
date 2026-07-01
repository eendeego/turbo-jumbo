import {localModelsDir, coldStorageDir} from '@/lib/config';
import {logger} from '@/lib/logger';
import {downloadDiskUsage} from '@/lib/disk-usage';

// Free/total bytes of the filesystems a download touches — the local models
// directory (where it lands) and cold storage (the optional copy target) — so
// the UI can warn before a transfer that wouldn't fit.
export async function GET() {
  if (!localModelsDir || !coldStorageDir) {
    return new Response('No local peer configured', {status: 400});
  }
  try {
    return Response.json(
      await downloadDiskUsage(localModelsDir, coldStorageDir),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(`[disk-usage] statfs failed: ${msg}`);
    return new Response(msg, {status: 500});
  }
}
