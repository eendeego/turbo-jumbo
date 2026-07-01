import {NextResponse} from 'next/server';
import {localModelsDir, lemonadeDir} from '@/lib/config';
import {
  previewLemonadeSync,
  syncLemonadeToTurboJumbo,
} from '@/lib/lemonade-sync';

// Sync Lemonade's HuggingFace-cache models into Turbo Jumbo's flat mirror: GET
// previews the Lemonade-only models that would move (read-only); POST executes
// the move + symlink and returns a per-model, per-file result.

export async function GET() {
  if (!localModelsDir || !lemonadeDir) return NextResponse.json({preview: []});
  const preview = await previewLemonadeSync(localModelsDir, lemonadeDir);
  return NextResponse.json({preview});
}

export async function POST() {
  if (!localModelsDir || !lemonadeDir)
    return new Response('Lemonade is not configured', {status: 400});
  const results = await syncLemonadeToTurboJumbo(localModelsDir, lemonadeDir);
  return NextResponse.json({results});
}
