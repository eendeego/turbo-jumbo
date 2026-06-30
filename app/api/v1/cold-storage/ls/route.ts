import {NextResponse} from 'next/server';
import {coldStorageDir} from '@/lib/config';
import {promises as fsp} from 'fs';
import nodePath from 'path';

// Raw recursive file listing of cold storage, for when model scanning finds
// nothing but the directory may still hold unrecognised files.
export async function GET() {
  if (!coldStorageDir) return new Response('No cold storage', {status: 400});
  const base = nodePath.resolve(coldStorageDir);
  const entries = (await fsp.readdir(base, {recursive: true})) as string[];
  const files: string[] = [];
  for (const entry of entries) {
    const full = nodePath.join(base, entry);
    try {
      if ((await fsp.stat(full)).isFile()) files.push(entry);
    } catch {
      /* skip entries that vanish mid-scan */
    }
  }
  files.sort();
  return NextResponse.json({dir: base, files});
}
