import {NextResponse} from 'next/server';
import {lemonadeDir} from '@/lib/config';
import {logger} from '@/lib/logger';
import {scanModels} from '@/lib/models';

// Lemonade keeps its own hub-cache of models it has pulled, separate from the
// turbo-jumbo storage the rest of the app manages. scanModels normally skips
// this directory; here we scan it directly so the Lemonade browser can flag
// catalog entries that live in that cache.
export function GET() {
  if (!lemonadeDir) return NextResponse.json([]);
  const models = scanModels(lemonadeDir);
  logger.trace(`[lemonade-cache] scan: ${models.length} model(s)`);
  return NextResponse.json(models);
}
