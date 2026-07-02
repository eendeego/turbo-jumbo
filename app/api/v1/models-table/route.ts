import {NextResponse} from 'next/server';
import {localModelsDir, coldStorageDir, lemonadeDir} from '@/lib/config';
import {scanModels} from '@/lib/models/models';
import {getModelsTableData} from '@/components/models/models-table';

export function GET() {
  const coldModels = scanModels(coldStorageDir);
  const localModels = scanModels(localModelsDir, lemonadeDir);
  return NextResponse.json(getModelsTableData(localModels, coldModels));
}
