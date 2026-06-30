import {NextResponse} from 'next/server';
import {localModelsDir, coldStorageDir} from '@/lib/config';
import {scanModels} from '@/lib/models';
import {getModelsTableData} from '@/components/models/models-table';

export function GET() {
  const coldModels = scanModels(coldStorageDir);
  const localModels = scanModels(localModelsDir);
  return NextResponse.json(getModelsTableData(localModels, coldModels));
}
