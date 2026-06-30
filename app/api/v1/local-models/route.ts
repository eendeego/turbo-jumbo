import {NextResponse} from 'next/server';
import {localModelsDir} from '@/lib/config';
import {scanModels} from '@/lib/models';

export function GET() {
  const models = scanModels(localModelsDir);
  return NextResponse.json(models);
}
