import {NextResponse} from 'next/server';
import {localModelsDir, lemonadeDir} from '@/lib/config';
import {findIncompleteRepos} from '@/lib/audit/incomplete-models';

// Repo ids present in this host's storage but missing files a full download
// would include (used by the Lemonade browser and the models table to flag a
// partial download, e.g. Kokoro with only its voices sidecar).
export async function GET() {
  if (!localModelsDir) return NextResponse.json({incomplete: []});
  const incomplete = await findIncompleteRepos(localModelsDir, lemonadeDir);
  return NextResponse.json({incomplete});
}
