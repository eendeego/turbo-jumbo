import {NextResponse} from 'next/server';
import {localModelsDir, lemonadeDir} from '@/lib/config';
import {findReposWithInvalidFiles} from '@/lib/audit/incomplete-models';

// Repo ids present in this host's storage with at least one local file that
// audits invalid (used by the models table to flag a model whose download is
// present but corrupt or unverifiable, e.g. a Kokoro repo with a bad index.json).
export async function GET() {
  if (!localModelsDir) return NextResponse.json({invalid: []});
  const invalid = await findReposWithInvalidFiles(localModelsDir, lemonadeDir);
  return NextResponse.json({invalid});
}
