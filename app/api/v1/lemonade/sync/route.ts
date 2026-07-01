import {NextResponse} from 'next/server';
import {previewSync, runSync} from '@/lib/lemonade-sync-run';

// Sync Lemonade and Turbo Jumbo: GET previews the changes (read-only); POST
// executes them. Pass 1 consolidates Lemonade's on-disk cache into Turbo Jumbo
// (move + deduplicate); pass 2 mirrors catalog models Turbo Jumbo already holds
// back into Lemonade's cache as symlinks.

export async function GET() {
  return NextResponse.json(await previewSync());
}

export async function POST() {
  const out = await runSync();
  if (!out) return new Response('Lemonade is not configured', {status: 400});
  return NextResponse.json(out);
}
