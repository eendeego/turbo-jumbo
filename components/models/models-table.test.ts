import {test, expect} from 'bun:test';
import {buildModelRows} from '@/components/models/models-table';
import type {Model} from '@/lib/models';

function single(
  filename: string,
  quant: string,
  size = 100,
): Model['files'][number] {
  return {
    isSplit: false,
    filename,
    path: filename,
    quant,
    size,
    missing: false,
  };
}

// A weight at a repo-relative path (the form scanModels produces), so its
// component folder survives — used for diffusers-layout tests.
function comp(path: string, quant: string, size = 100): Model['files'][number] {
  return {
    isSplit: false,
    filename: path.split('/').pop() ?? path,
    path,
    quant,
    size,
    missing: false,
  };
}

test('buildModelRows collapses a diffusers pipeline into per-component variant rows', () => {
  const local: Model[] = [
    {
      name: 'stabilityai/sdxl-turbo',
      files: [
        comp(
          'stabilityai/sdxl-turbo/unet/diffusion_pytorch_model.fp16.safetensors',
          'F16',
          5000,
        ),
        comp(
          'stabilityai/sdxl-turbo/vae/diffusion_pytorch_model.fp16.safetensors',
          'F16',
          160,
        ),
        comp(
          'stabilityai/sdxl-turbo/text_encoder/model.fp16.safetensors',
          'F16',
          246,
        ),
        comp(
          'stabilityai/sdxl-turbo/text_encoder_2/model.fp16.safetensors',
          'F16',
          1400,
        ),
      ],
    },
  ];
  const [row] = buildModelRows(local, []);
  // One row per component, not a single collapsed 'F16' quant.
  expect(row.quants.map((q) => q.label).sort()).toEqual([
    'text_encoder',
    'text_encoder_2',
    'unet',
    'vae',
  ]);
  // Additive: model size is the sum, shown as one number (min === max).
  expect(row.minSize).toBe(5000 + 160 + 246 + 1400);
  expect(row.maxSize).toBe(row.minSize);
  // Summary shows precision, not garbled component names.
  expect(row.quantizations).toBe('fp16');
  const unet = row.quants.find((q) => q.label === 'unet')!;
  expect(unet.precisions).toEqual(['fp16']);
  expect(unet.paths).toEqual([
    'stabilityai/sdxl-turbo/unet/diffusion_pytorch_model.fp16.safetensors',
  ]);
  expect(unet.size).toBe(5000);
});

test('buildModelRows merges fp16+fp32 of a diffusers component into one row', () => {
  const local: Model[] = [
    {
      name: 'stabilityai/sdxl-turbo',
      files: [
        comp(
          'stabilityai/sdxl-turbo/unet/diffusion_pytorch_model.fp16.safetensors',
          'F16',
          5000,
        ),
        comp(
          'stabilityai/sdxl-turbo/unet/diffusion_pytorch_model.safetensors',
          'F32',
          10000,
        ),
      ],
    },
  ];
  const [row] = buildModelRows(local, []);
  expect(row.quants.map((q) => q.label)).toEqual(['unet']);
  const unet = row.quants[0];
  expect([...unet.paths].sort()).toEqual([
    'stabilityai/sdxl-turbo/unet/diffusion_pytorch_model.fp16.safetensors',
    'stabilityai/sdxl-turbo/unet/diffusion_pytorch_model.safetensors',
  ]);
  // fp32 carries no precision infix, so only fp16 is badged; size is one
  // precision (the first seen), never the sum.
  expect(unet.precisions).toEqual(['fp16']);
  expect(unet.size).toBe(5000);
});

test('buildModelRows keeps an mmproj as an isProjector quant, out of the summary', () => {
  const local: Model[] = [
    {
      name: 'org/repo',
      files: [
        single('repo-Q4_K_M.gguf', 'Q4_K_M'),
        single('mmproj-F16.gguf', 'F16', 50),
      ],
    },
  ];
  const [row] = buildModelRows(local, []);
  const weights = row.quants.filter((q) => !q.isProjector);
  const projectors = row.quants.filter((q) => q.isProjector);
  expect(weights.map((q) => q.label)).toEqual(['Q4_K_M']);
  expect(row.quantizations).toBe('4');
  expect(projectors.map((q) => q.label)).toEqual(['mmproj-F16.gguf']);
  expect(projectors[0].paths).toEqual(['mmproj-F16.gguf']);
  expect(projectors[0].size).toBe(50);
});

test('buildModelRows keeps a real F16 weight distinct from mmproj-F16', () => {
  const local: Model[] = [
    {
      name: 'org/repo',
      files: [
        single('repo-F16.gguf', 'F16', 200),
        single('mmproj-F16.gguf', 'F16', 50),
      ],
    },
  ];
  const [row] = buildModelRows(local, []);
  const weight = row.quants.find((q) => !q.isProjector);
  const projector = row.quants.find((q) => q.isProjector);
  expect(weight?.label).toBe('F16');
  expect(weight?.size).toBe(200);
  expect(projector?.label).toBe('mmproj-F16.gguf');
  expect(projector?.size).toBe(50);
  expect(row.quantizations).toBe('16'); // weight only, not duplicated
  expect(row.minSize).toBe(200); // projector excluded from the range
});

test('buildModelRows detects a projector cold copy only within the same model', () => {
  const local: Model[] = [
    {name: 'org/repo', files: [single('mmproj-F16.gguf', 'F16', 50)]},
  ];
  const cold: Model[] = [
    {name: 'org/repo', files: [single('mmproj-F16.gguf', 'F16', 50)]},
    {name: 'org/other', files: [single('mmproj-F16.gguf', 'F16', 50)]},
  ];
  const row = buildModelRows(local, cold).find((r) => r.name === 'org/repo')!;
  const projector = row.quants.find((q) => q.isProjector)!;
  expect(projector.inColdStorage).toBe(true);
  expect(projector.coldComplete).toBe(true);
});

test("buildModelRows does not borrow a different model's projector cold copy", () => {
  const local: Model[] = [
    {name: 'org/repo', files: [single('mmproj-F16.gguf', 'F16', 50)]},
  ];
  // Only a DIFFERENT model has the projector in cold storage.
  const cold: Model[] = [
    {name: 'org/other', files: [single('mmproj-F16.gguf', 'F16', 50)]},
  ];
  const row = buildModelRows(local, cold).find((r) => r.name === 'org/repo')!;
  const projector = row.quants.find((q) => q.isProjector)!;
  expect(projector.inColdStorage).toBe(false);
});

test('a model is Partial, not Complete, when its mmproj is missing from cold storage', () => {
  const local: Model[] = [
    {
      name: 'org/repo',
      files: [
        single('repo-Q4_K_M.gguf', 'Q4_K_M', 100),
        single('mmproj-F16.gguf', 'F16', 50),
      ],
    },
  ];
  // Cold storage has the weight but not the projector.
  const cold: Model[] = [
    {name: 'org/repo', files: [single('repo-Q4_K_M.gguf', 'Q4_K_M', 100)]},
  ];

  const row = buildModelRows(local, cold).find((r) => r.name === 'org/repo')!;
  expect(row.allInColdStorage).toBe(false); // Partial, because the mmproj isn't cold
  expect(row.noneInColdStorage).toBe(false);
});

test('a model is Complete when both its weight and mmproj are in cold storage', () => {
  const local: Model[] = [
    {
      name: 'org/repo',
      files: [
        single('repo-Q4_K_M.gguf', 'Q4_K_M', 100),
        single('mmproj-F16.gguf', 'F16', 50),
      ],
    },
  ];
  const cold: Model[] = [
    {
      name: 'org/repo',
      files: [
        single('repo-Q4_K_M.gguf', 'Q4_K_M', 100),
        single('mmproj-F16.gguf', 'F16', 50),
      ],
    },
  ];

  const row = buildModelRows(local, cold).find((r) => r.name === 'org/repo')!;
  expect(row.allInColdStorage).toBe(true);
});

test('buildModelRows leaves no projector quant for a weights-only model', () => {
  const local: Model[] = [
    {name: 'org/repo', files: [single('repo-Q8_0.gguf', 'Q8_0')]},
  ];
  const [row] = buildModelRows(local, []);
  expect(row.quants.some((q) => q.isProjector)).toBe(false);
});

function singleModel(name: string, filename: string, quant: string): Model {
  return {
    name,
    files: [
      {
        isSplit: false,
        filename,
        path: filename,
        quant,
        size: 100,
        missing: false,
      },
    ],
  };
}

function fileAt(
  name: string,
  relPath: string,
  quant: string,
  size: number,
): Model {
  return {
    name,
    files: [
      {
        isSplit: false,
        filename: relPath.split('/').pop()!,
        path: relPath,
        quant,
        size,
        missing: false,
      },
    ],
  };
}

test('orders rows alphabetically by display name, not the org-qualified name', () => {
  const local = [
    fileAt('zzz/Apple-GGUF', 'zzz/Apple-GGUF/apple-Q4_K_M.gguf', 'Q4_K_M', 100),
    fileAt('Banana-GGUF', 'Banana-GGUF/banana-Q4_K_M.gguf', 'Q4_K_M', 100),
    fileAt(
      'aaa/Cherry-GGUF',
      'aaa/Cherry-GGUF/cherry-Q4_K_M.gguf',
      'Q4_K_M',
      100,
    ),
  ];
  // Displayed as Apple-GGUF, Banana-GGUF, Cherry-GGUF — that is the order,
  // not the raw-name order (aaa/Cherry, Banana, zzz/Apple).
  expect(buildModelRows(local, []).map((r) => r.name)).toEqual([
    'zzz/Apple-GGUF',
    'Banana-GGUF',
    'aaa/Cherry-GGUF',
  ]);
});

test('a generic safetensors is not in cold when only a different repo shares the name', () => {
  // Two unrelated models each named their weights `model.safetensors`; the
  // generic basename must not make one look present in cold because of the
  // other.
  const file = 'model.safetensors';
  const local = [fileAt('org-a/Model', `org-a/Model/${file}`, 'ST', 100)];
  const cold = [fileAt('org-b/Other', `org-b/Other/${file}`, 'ST', 200)];

  const q = buildModelRows(local, cold).find((r) => r.name === 'org-a/Model')!
    .quants[0];
  expect(q.inColdStorage).toBe(false);
  expect(q.coldPaths).toEqual([]);
});

test('a generic safetensors is in cold when the same repo has it', () => {
  const file = 'model.safetensors';
  const local = [fileAt('org-a/Model', `org-a/Model/${file}`, 'ST', 100)];
  const cold = [
    fileAt(
      'org-a/Model',
      `models--org-a--Model/snapshots/r1/${file}`,
      'ST',
      100,
    ),
  ];

  const q = buildModelRows(local, cold).find((r) => r.name === 'org-a/Model')!
    .quants[0];
  expect(q.inColdStorage).toBe(true);
  expect(q.coldComplete).toBe(true);
  expect(q.coldPaths).toEqual([`models--org-a--Model/snapshots/r1/${file}`]);
});

test('detects cold presence across differing layouts (bare local vs repoId cold)', () => {
  const file = 'gemma-4-26B-A4B-it-UD-IQ2_M.gguf';
  const size = 9974938368;
  const local = [fileAt('gemma-4-26B-A4B-it', file, 'UD-IQ2_M', size)];
  const cold = [
    fileAt(
      'gemma-4-26B-A4B-it',
      `unsloth/gemma-4-26B-A4B-it-GGUF/${file}`,
      'UD-IQ2_M',
      size,
    ),
  ];

  const q = buildModelRows(local, cold).find(
    (r) => r.name === 'gemma-4-26B-A4B-it',
  )!.quants[0];
  expect(q.inColdStorage).toBe(true);
  expect(q.coldComplete).toBe(true); // same size → a complete copy
  expect(q.coldPaths).toEqual([`unsloth/gemma-4-26B-A4B-it-GGUF/${file}`]);
});

test('flags a size mismatch as present-but-incomplete (incomplete cold copy)', () => {
  // A 32.6 GB local file whose cold copy is a truncated 88 MB partial.
  const file = 'JKL-Luau-Gemma-4-31B-it-Claude-Opus-Distill.Q8_0.gguf';
  const local = [
    fileAt('JKL', `dylanjkl/JKL-GGUF/${file}`, 'Q8_0', 32635674240),
  ];
  const cold = [fileAt('JKL', `dylanjkl/JKL-GGUF/${file}`, 'Q8_0', 88290024)];

  const q = buildModelRows(local, cold).find((r) => r.name === 'JKL')!
    .quants[0];
  expect(q.inColdStorage).toBe(true); // a file of this name exists in cold
  expect(q.coldComplete).toBe(false); // ...but the size differs
  expect(q.coldSize).toBe(88290024);
  expect(q.coldPaths).toEqual([`dylanjkl/JKL-GGUF/${file}`]);
});

test('same-named files of different size match by name but are not complete (MTP)', () => {
  const file = 'Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf';
  const local = [
    fileAt(
      'unsloth/Qwen3.6-35B-A3B-GGUF',
      `unsloth/Qwen3.6-35B-A3B-GGUF/${file}`,
      'UD-Q4_K_XL',
      22360456160,
    ),
  ];
  const cold = [
    fileAt(
      'unsloth/Qwen3.6-35B-A3B-MTP-GGUF',
      `unsloth/Qwen3.6-35B-A3B-MTP-GGUF/${file}`,
      'UD-Q4_K_XL',
      22853663008,
    ),
  ];

  const q = buildModelRows(local, cold).find(
    (r) => r.name === 'unsloth/Qwen3.6-35B-A3B-GGUF',
  )!.quants[0];
  expect(q.inColdStorage).toBe(true);
  expect(q.coldComplete).toBe(false);
});

test('detects cold presence by path even when local/cold model names differ', () => {
  const file = 'Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf';
  // Local file has a sidecar → org/repo name; the cold copy has none → a
  // filename-derived name. The names diverge but the path is the same.
  const local = [
    singleModel('unsloth/Qwen3.6-35B-A3B-MTP-GGUF', file, 'UD-Q4_K_XL'),
  ];
  const cold = [singleModel('Qwen3.6-35B-A3B', file, 'UD-Q4_K_XL')];

  const rows = buildModelRows(local, cold);
  const localRow = rows.find(
    (r) => r.name === 'unsloth/Qwen3.6-35B-A3B-MTP-GGUF',
  )!;
  expect(localRow.quants[0].inColdStorage).toBe(true);
  expect(localRow.quants[0].coldPaths).toEqual([file]);
});

test('reports not-in-cold when the local file is absent from cold storage', () => {
  const rows = buildModelRows(
    [singleModel('X', 'a.Q4_K_M.gguf', 'Q4_K_M')],
    [singleModel('Y', 'b.Q4_K_M.gguf', 'Q4_K_M')],
  );
  expect(rows.find((r) => r.name === 'X')!.quants[0].inColdStorage).toBe(false);
  expect(rows.find((r) => r.name === 'X')!.quants[0].coldPaths).toEqual([]);
});

test('merges local and cold copies that disagree on sidecar naming into one row', () => {
  // The local copy was audited, so its scan named it after the sidecar repo;
  // the cold copy has no sidecar and got the filename-derived name. They are
  // the same model and must not produce two table rows.
  const local = [
    fileAt(
      'unsloth/gpt-oss-20b-GGUF',
      'unsloth/gpt-oss-20b-GGUF/gpt-oss-20b-Q4_K_M.gguf',
      'Q4_K_M',
      100,
    ),
  ];
  const cold = [
    fileAt('gpt-oss-20b', 'gpt-oss-20b-Q4_K_M.gguf', 'Q4_K_M', 100),
  ];

  const rows = buildModelRows(local, cold);
  expect(rows.map((r) => r.name)).toEqual(['unsloth/gpt-oss-20b-GGUF']);
  expect(rows[0].quants).toHaveLength(1);
  expect(rows[0].quants[0].inColdStorage).toBe(true);
  expect(rows[0].quants[0].coldComplete).toBe(true);
  // Operations target the local copy's real path.
  expect(rows[0].quants[0].paths).toEqual([
    'unsloth/gpt-oss-20b-GGUF/gpt-oss-20b-Q4_K_M.gguf',
  ]);
});
