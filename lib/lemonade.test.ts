import {test, expect} from 'bun:test';
import {
  catalogSection,
  collectionDownloadPlan,
  collectionDownloadStatus,
  collectionFromManifest,
  collectionInLemonadeCache,
  componentDownloadStatus,
  componentInLemonadeCache,
  lemonadeDownloadStatus,
  modelInLemonadeCache,
  lemonadeGgufModels,
  lemonadeStatusTooltip,
  matchVariantFiles,
  missingVariantFiles,
  parseCheckpoint,
  parseLemonade,
  planRepoJobs,
  resolveCheckpointFiles,
  type InventoryLocation,
  type LemonadeComponent,
  type LemonadeModel,
  type OmniCollection,
} from '@/lib/lemonade';
import type {Model} from '@/lib/model-types';

test('parseCheckpoint splits a repo from its variant', () => {
  expect(parseCheckpoint('unsloth/Qwen3-0.6B-GGUF:Q4_0')).toEqual({
    repoId: 'unsloth/Qwen3-0.6B-GGUF',
    variant: 'Q4_0',
  });
  expect(
    parseCheckpoint(
      'unsloth/gemma-3-270m-it-GGUF:gemma-3-270m-it-UD-IQ2_M.gguf',
    ),
  ).toEqual({
    repoId: 'unsloth/gemma-3-270m-it-GGUF',
    variant: 'gemma-3-270m-it-UD-IQ2_M.gguf',
  });
  expect(parseCheckpoint('pqnet/bge-reranker-v2-m3-Q8_0-GGUF')).toEqual({
    repoId: 'pqnet/bge-reranker-v2-m3-Q8_0-GGUF',
    variant: null,
  });
});

test('parseCheckpoint rejects malformed checkpoints', () => {
  expect(parseCheckpoint('not-a-repo')).toBeNull();
  expect(parseCheckpoint('a/b/c')).toBeNull();
  expect(parseCheckpoint('or g/repo')).toBeNull();
});

test('lemonadeGgufModels keeps llamacpp entries and maps their fields', () => {
  const models = lemonadeGgufModels({
    'Qwen3-0.6B-GGUF': {
      checkpoint: 'unsloth/Qwen3-0.6B-GGUF:Q4_0',
      recipe: 'llamacpp',
      suggested: true,
      labels: ['reasoning'],
      size: 0.38,
    },
    'Gemma-3-4b-it-GGUF': {
      checkpoint: 'ggml-org/gemma-3-4b-it-GGUF:Q4_K_M',
      mmproj: 'mmproj-model-f16.gguf',
      recipe: 'llamacpp',
      suggested: false,
      labels: ['vision'],
      size: 3.34,
    },
    'Some-ONNX-Model': {
      checkpoint: 'amd/some-onnx-thing',
      recipe: 'ryzenai-llm',
      suggested: true,
      size: 9.09,
    },
  });
  expect(models).toEqual([
    {
      name: 'Qwen3-0.6B-GGUF',
      repoId: 'unsloth/Qwen3-0.6B-GGUF',
      variant: 'Q4_0',
      mmproj: null,
      suggested: true,
      labels: ['reasoning'],
      sizeGb: 0.38,
    },
    {
      name: 'Gemma-3-4b-it-GGUF',
      repoId: 'ggml-org/gemma-3-4b-it-GGUF',
      variant: 'Q4_K_M',
      mmproj: 'mmproj-model-f16.gguf',
      suggested: false,
      labels: ['vision'],
      sizeGb: 3.34,
    },
  ]);
});

test('lemonadeGgufModels skips malformed entries instead of failing', () => {
  expect(
    lemonadeGgufModels({
      ok: {checkpoint: 'o/r:Q4_0', recipe: 'llamacpp', size: 1},
      'bad-checkpoint': {checkpoint: 'nope', recipe: 'llamacpp', size: 1},
      'not-an-object': 42,
    }),
  ).toHaveLength(1);
  expect(lemonadeGgufModels(null)).toEqual([]);
  expect(lemonadeGgufModels([1, 2])).toEqual([]);
});

test('parseLemonade resolves inline omni collections and defers manifest ones', () => {
  const catalog = {
    'Qwen-LLM-GGUF': {
      checkpoint: 'unsloth/Qwen-LLM-GGUF:Q4_K_M',
      recipe: 'llamacpp',
      suggested: true,
      labels: ['vision'],
      size: 4,
    },
    'SD-Turbo': {
      checkpoint: 'stabilityai/sd-turbo:sd_turbo.safetensors',
      recipe: 'sd-cpp',
      labels: ['image'],
      size: 5.21,
    },
    'Whisper-Tiny': {
      checkpoints: {main: 'ggerganov/whisper.cpp:ggml-tiny.bin'},
      recipe: 'whispercpp',
      labels: ['transcription'],
      size: 0.075,
    },
    'Lite Collection': {
      checkpoint: '',
      recipe: 'collection.omni',
      suggested: false,
      components: ['Qwen-LLM-GGUF', 'SD-Turbo', 'Whisper-Tiny'],
    },
    'LMX-Omni-Lite': {
      checkpoint: 'lemonade-sdk/LMX-Omni-Lite',
      recipe: 'collection.omni',
      suggested: true,
      size: 9.3,
      labels: ['omni'],
    },
  };
  const {models, collections, manifestRefs} = parseLemonade(catalog);

  // The llamacpp model is still parsed exactly as lemonadeGgufModels does.
  expect(models.map((m) => m.name)).toEqual(['Qwen-LLM-GGUF']);

  // The inline collection resolves its components against the catalog: the
  // llamacpp one is downloadable, the image/audio ones are not.
  expect(collections).toHaveLength(1);
  expect(collections[0].name).toBe('Lite Collection');
  expect(collections[0].components).toEqual([
    {
      name: 'Qwen-LLM-GGUF',
      recipe: 'llamacpp',
      modality: 'vision',
      sizeGb: 4,
      downloadable: true,
      checkpoints: [{repoId: 'unsloth/Qwen-LLM-GGUF', variant: 'Q4_K_M'}],
    },
    {
      name: 'SD-Turbo',
      recipe: 'sd-cpp',
      modality: 'image',
      sizeGb: 5.21,
      downloadable: false,
      checkpoints: [
        {repoId: 'stabilityai/sd-turbo', variant: 'sd_turbo.safetensors'},
      ],
    },
    {
      name: 'Whisper-Tiny',
      recipe: 'whispercpp',
      modality: 'transcription',
      sizeGb: 0.075,
      downloadable: false,
      checkpoints: [
        {repoId: 'ggerganov/whisper.cpp', variant: 'ggml-tiny.bin'},
      ],
    },
  ]);

  // The manifest-repo omni is deferred: it needs its {name}.json fetched.
  expect(manifestRefs).toEqual([
    {
      name: 'LMX-Omni-Lite',
      repoId: 'lemonade-sdk/LMX-Omni-Lite',
      suggested: true,
      sizeGb: 9.3,
      labels: ['omni'],
    },
  ]);
});

test('parseLemonade marks a component downloadable only when it is a known gguf model', () => {
  const {collections} = parseLemonade({
    'Good-GGUF': {
      checkpoint: 'o/Good-GGUF:Q4_K_M',
      recipe: 'llamacpp',
      size: 1,
    },
    'Bad-GGUF': {checkpoint: 'not-a-repo', recipe: 'llamacpp', size: 1},
    Combo: {
      checkpoint: '',
      recipe: 'collection.omni',
      components: ['Good-GGUF', 'Bad-GGUF', 'Ghost'],
    },
  });
  const byName = Object.fromEntries(
    collections[0].components.map((c) => [c.name, c]),
  );
  expect(byName['Good-GGUF'].downloadable).toBe(true);
  // llamacpp recipe, but its checkpoint doesn't parse, so it isn't a real model.
  expect(byName['Bad-GGUF'].downloadable).toBe(false);
  // Not in the catalog at all.
  expect(byName['Ghost']).toEqual({
    name: 'Ghost',
    recipe: 'unknown',
    modality: 'unknown',
    sizeGb: 0,
    downloadable: false,
    checkpoints: [],
  });
});

test('parseLemonade sums component sizes when an inline collection declares none', () => {
  const {collections} = parseLemonade({
    A: {checkpoint: 'o/A-GGUF:Q4_K_M', recipe: 'llamacpp', size: 2},
    B: {checkpoint: 'o/b:f.safetensors', recipe: 'sd-cpp', size: 3},
    Combo: {checkpoint: '', recipe: 'collection.omni', components: ['A', 'B']},
  });
  expect(collections[0].sizeGb).toBe(5);
});

test('catalogSection routes recipes, and splits llamacpp by label', () => {
  expect(catalogSection('llamacpp', [])).toBe('llm');
  expect(catalogSection('llamacpp', ['vision'])).toBe('vision');
  expect(catalogSection('llamacpp', ['embeddings'])).toBe('embeddings');
  expect(catalogSection('llamacpp', ['reranking'])).toBe('reranking');
  expect(catalogSection('ryzenai-llm', [])).toBe('onnx');
  expect(catalogSection('vllm', [])).toBe('vllm');
  expect(catalogSection('sd-cpp', [])).toBe('image');
  expect(catalogSection('whispercpp', [])).toBe('transcription');
  expect(catalogSection('moonshine', [])).toBe('transcription');
  expect(catalogSection('kokoro', [])).toBe('tts');
  expect(catalogSection('something-new', [])).toBe('other');
});

test('parseLemonade collects non-llamacpp standalone models as downloadable components', () => {
  const {models, extraModels} = parseLemonade({
    'Qwen-GGUF': {checkpoint: 'o/Qwen-GGUF:Q4_0', recipe: 'llamacpp', size: 1},
    'kokoro-v1': {
      checkpoint: 'mikkoph/kokoro-onnx',
      recipe: 'kokoro',
      labels: ['tts'],
      size: 0.3,
    },
    'SD-Turbo': {
      checkpoint: 'stabilityai/sd-turbo:sd.safetensors',
      recipe: 'sd-cpp',
      size: 5,
    },
    Combo: {
      checkpoint: '',
      recipe: 'collection.omni',
      components: ['Qwen-GGUF'],
    },
  });
  // llamacpp stays in `models`; only the rest land in `extraModels`.
  expect(models.map((m) => m.name)).toEqual(['Qwen-GGUF']);
  expect(extraModels.map((c) => c.name).sort()).toEqual([
    'SD-Turbo',
    'kokoro-v1',
  ]);
  const kokoro = extraModels.find((c) => c.name === 'kokoro-v1')!;
  expect(kokoro.recipe).toBe('kokoro');
  expect(kokoro.modality).toBe('tts');
  expect(kokoro.downloadable).toBe(true);
  expect(kokoro.checkpoints).toEqual([
    {repoId: 'mikkoph/kokoro-onnx', variant: null},
  ]);
});

test('parseLemonade marks a standalone model non-downloadable when it resolves no checkpoints', () => {
  const {extraModels} = parseLemonade({
    Weird: {recipe: 'sd-cpp', size: 1}, // no checkpoint(s)
  });
  expect(extraModels).toHaveLength(1);
  expect(extraModels[0].downloadable).toBe(false);
});

test('collectionFromManifest keeps the declared collection size over the sum', () => {
  const ref = {name: 'X', suggested: false, sizeGb: 9.3, labels: []};
  const manifest = {
    models: [
      {model_name: 'A', recipe: 'llamacpp', size: 2},
      {model_name: 'B', recipe: 'sd-cpp', size: 3},
    ],
  };
  expect(collectionFromManifest(ref, manifest, new Set()).sizeGb).toBe(9.3);
});

test('collectionFromManifest builds components from a fetched manifest', () => {
  const manifest = {
    model_name: 'user.LMX-Omni-Lite',
    recipe: 'collection.omni',
    components: ['Qwen-LLM-GGUF', 'SD-Turbo'],
    models: [
      {
        model_name: 'Qwen-LLM-GGUF',
        recipe: 'llamacpp',
        labels: ['vision'],
        size: 4,
        checkpoints: {main: 'unsloth/Qwen-LLM-GGUF:Q4_K_M'},
      },
      {
        model_name: 'SD-Turbo',
        recipe: 'sd-cpp',
        labels: ['image'],
        size: 5.21,
        checkpoints: {main: 'stabilityai/sd-turbo:sd_turbo.safetensors'},
      },
    ],
  };
  const ref = {name: 'LMX-Omni-Lite', suggested: true, sizeGb: 9.3, labels: []};
  expect(
    collectionFromManifest(ref, manifest, new Set(['Qwen-LLM-GGUF'])),
  ).toEqual({
    name: 'LMX-Omni-Lite',
    suggested: true,
    sizeGb: 9.3,
    labels: [],
    components: [
      {
        name: 'Qwen-LLM-GGUF',
        recipe: 'llamacpp',
        modality: 'vision',
        sizeGb: 4,
        downloadable: true,
        checkpoints: [{repoId: 'unsloth/Qwen-LLM-GGUF', variant: 'Q4_K_M'}],
      },
      {
        name: 'SD-Turbo',
        recipe: 'sd-cpp',
        modality: 'image',
        sizeGb: 5.21,
        downloadable: false,
        checkpoints: [
          {repoId: 'stabilityai/sd-turbo', variant: 'sd_turbo.safetensors'},
        ],
      },
    ],
  });
});

test('collectionFromManifest tolerates a missing or malformed models array', () => {
  const ref = {name: 'X', suggested: false, sizeGb: 0, labels: []};
  expect(collectionFromManifest(ref, {}, new Set()).components).toEqual([]);
  expect(collectionFromManifest(ref, null, new Set()).components).toEqual([]);
  expect(
    collectionFromManifest(ref, {models: [42, {}, null]}, new Set()).components,
  ).toEqual([]);
});

test('parseLemonade attaches each component its download checkpoints', () => {
  const {collections} = parseLemonade({
    'Qwen-LLM-GGUF': {
      checkpoint: 'unsloth/Qwen-LLM-GGUF:Q4_K_M',
      recipe: 'llamacpp',
      mmproj: 'mmproj-F16.gguf',
      labels: ['vision'],
      size: 4,
    },
    'Whisper-Tiny': {
      checkpoints: {
        main: 'ggerganov/whisper.cpp:ggml-tiny.bin',
        npu_cache: 'amd/whisper-tiny-onnx-npu:ggml-tiny-encoder-vitisai.rai',
      },
      recipe: 'whispercpp',
      size: 0.075,
    },
    'kokoro-v1': {
      checkpoint: 'mikkoph/kokoro-onnx',
      recipe: 'kokoro',
      size: 0.354,
    },
    Combo: {
      checkpoint: '',
      recipe: 'collection.omni',
      components: ['Qwen-LLM-GGUF', 'Whisper-Tiny', 'kokoro-v1'],
    },
  });
  const byName = Object.fromEntries(
    collections[0].components.map((c) => [c.name, c.checkpoints]),
  );
  // llamacpp: the main quant plus the sibling mmproj filename in the same repo.
  expect(byName['Qwen-LLM-GGUF']).toEqual([
    {repoId: 'unsloth/Qwen-LLM-GGUF', variant: 'Q4_K_M'},
    {repoId: 'unsloth/Qwen-LLM-GGUF', variant: 'mmproj-F16.gguf'},
  ]);
  // A plural checkpoints map, with the npu_cache role skipped.
  expect(byName['Whisper-Tiny']).toEqual([
    {repoId: 'ggerganov/whisper.cpp', variant: 'ggml-tiny.bin'},
  ]);
  // A whole-repo checkpoint carries a null variant.
  expect(byName['kokoro-v1']).toEqual([
    {repoId: 'mikkoph/kokoro-onnx', variant: null},
  ]);
});

test('parseLemonade reads multi-role checkpoints (main, text_encoder, vae)', () => {
  const {collections} = parseLemonade({
    Flux: {
      checkpoints: {
        main: 'unsloth/FLUX-GGUF:flux-Q8_0.gguf',
        text_encoder: 'unsloth/Qwen3-8B-GGUF:Qwen3-8B-Q8_0.gguf',
        vae: 'Comfy-Org/vae:split_files/vae/flux2-vae.safetensors',
      },
      recipe: 'sd-cpp',
      size: 19,
    },
    Combo: {checkpoint: '', recipe: 'collection.omni', components: ['Flux']},
  });
  expect(collections[0].components[0].checkpoints).toEqual([
    {repoId: 'unsloth/FLUX-GGUF', variant: 'flux-Q8_0.gguf'},
    {repoId: 'unsloth/Qwen3-8B-GGUF', variant: 'Qwen3-8B-Q8_0.gguf'},
    {repoId: 'Comfy-Org/vae', variant: 'split_files/vae/flux2-vae.safetensors'},
  ]);
});

const repoFiles = [
  {path: 'model-Q4_K_M.gguf', size: 1},
  {path: 'model-Q8_0.gguf', size: 2},
  {path: 'mmproj-F16.gguf', size: 3},
  {path: 'split_files/vae/flux2-vae.safetensors', size: 4},
  {path: 'config.json', size: 5},
];

test('resolveCheckpointFiles picks gguf carrying a quant token, excluding mmproj', () => {
  expect(resolveCheckpointFiles(repoFiles, 'Q4_K_M')).toEqual([
    'model-Q4_K_M.gguf',
  ]);
});

test('resolveCheckpointFiles matches an exact filename of any extension, in subdirs', () => {
  expect(
    resolveCheckpointFiles(repoFiles, 'split_files/vae/flux2-vae.safetensors'),
  ).toEqual(['split_files/vae/flux2-vae.safetensors']);
  expect(resolveCheckpointFiles(repoFiles, 'mmproj-F16.gguf')).toEqual([
    'mmproj-F16.gguf',
  ]);
});

test('resolveCheckpointFiles matches an exact filename given without its subdir', () => {
  expect(resolveCheckpointFiles(repoFiles, 'flux2-vae.safetensors')).toEqual([
    'split_files/vae/flux2-vae.safetensors',
  ]);
});

test('resolveCheckpointFiles takes the whole repo when the variant is null', () => {
  expect(resolveCheckpointFiles(repoFiles, null)).toEqual(
    repoFiles.map((f) => f.path),
  );
});

test('collectionDownloadPlan flattens and de-dupes component checkpoints in order', () => {
  const collection: OmniCollection = {
    name: 'C',
    suggested: false,
    sizeGb: 0,
    labels: [],
    components: [
      {
        name: 'A',
        recipe: 'llamacpp',
        modality: 'vision',
        sizeGb: 1,
        downloadable: true,
        checkpoints: [
          {repoId: 'o/a', variant: 'Q4_K_M'},
          {repoId: 'o/a', variant: 'mmproj-F16.gguf'},
        ],
      },
      {
        name: 'B',
        recipe: 'kokoro',
        modality: 'tts',
        sizeGb: 0.3,
        downloadable: false,
        checkpoints: [{repoId: 'o/k', variant: null}],
      },
      {
        name: 'A2',
        recipe: 'llamacpp',
        modality: 'chat',
        sizeGb: 1,
        downloadable: true,
        checkpoints: [{repoId: 'o/a', variant: 'Q4_K_M'}], // a duplicate of A's main
      },
    ],
  };
  expect(collectionDownloadPlan(collection)).toEqual([
    {repoId: 'o/a', variant: 'Q4_K_M'},
    {repoId: 'o/a', variant: 'mmproj-F16.gguf'},
    {repoId: 'o/k', variant: null},
  ]);
});

test('planRepoJobs groups checkpoints by repo, preserving order, de-duping variants', () => {
  expect(
    planRepoJobs([
      {repoId: 'o/a', variant: 'Q4_K_M'},
      {repoId: 'o/a', variant: 'mmproj-F16.gguf'},
      {repoId: 'o/b', variant: null},
      {repoId: 'o/a', variant: 'Q4_K_M'}, // duplicate, dropped
    ]),
  ).toEqual([
    {repoId: 'o/a', variants: ['Q4_K_M', 'mmproj-F16.gguf']},
    {repoId: 'o/b', variants: [null]},
  ]);
});

const files = [
  {path: 'Qwen3-0.6B-Q4_0.gguf', size: 100},
  {path: 'Qwen3-0.6B-Q8_0.gguf', size: 200},
  {path: 'mmproj-model-f16.gguf', size: 10},
  {path: 'README.md', size: 1},
];

test('matchVariantFiles picks files carrying the quant token', () => {
  expect(matchVariantFiles(files, 'Q4_0', null)).toEqual([
    'Qwen3-0.6B-Q4_0.gguf',
  ]);
  // The token matches case-insensitively.
  expect(matchVariantFiles(files, 'q4_0', null)).toEqual([
    'Qwen3-0.6B-Q4_0.gguf',
  ]);
});

test('matchVariantFiles resolves an exact-filename variant', () => {
  expect(matchVariantFiles(files, 'Qwen3-0.6B-Q8_0.gguf', null)).toEqual([
    'Qwen3-0.6B-Q8_0.gguf',
  ]);
});

test('matchVariantFiles takes every gguf when there is no variant', () => {
  // Single-quant repos (e.g. pqnet/bge-reranker-v2-m3-Q8_0-GGUF) list the
  // whole checkpoint without a variant; mmproj files don't belong unless
  // asked for.
  expect(matchVariantFiles(files, null, null)).toEqual([
    'Qwen3-0.6B-Q4_0.gguf',
    'Qwen3-0.6B-Q8_0.gguf',
  ]);
});

test('matchVariantFiles appends the mmproj file when the model needs one', () => {
  expect(matchVariantFiles(files, 'Q4_0', 'mmproj-model-f16.gguf')).toEqual([
    'Qwen3-0.6B-Q4_0.gguf',
    'mmproj-model-f16.gguf',
  ]);
});

test('matchVariantFiles excludes mmproj files from token matches', () => {
  // "f16"-style tokens must not accidentally pull companion mmproj files.
  const repo = [
    {path: 'model-F16.gguf', size: 100},
    {path: 'mmproj-model-f16.gguf', size: 10},
  ];
  expect(matchVariantFiles(repo, 'F16', null)).toEqual(['model-F16.gguf']);
});

test('matchVariantFiles matches split shards of the variant', () => {
  const sharded = [
    {path: 'big-Q4_K_M-00001-of-00002.gguf', size: 1},
    {path: 'big-Q4_K_M-00002-of-00002.gguf', size: 1},
    {path: 'big-Q8_0.gguf', size: 2},
  ];
  expect(matchVariantFiles(sharded, 'Q4_K_M', null)).toEqual([
    'big-Q4_K_M-00001-of-00002.gguf',
    'big-Q4_K_M-00002-of-00002.gguf',
  ]);
});

// --- lemonadeDownloadStatus ---------------------------------------------

function model(over: Partial<LemonadeModel> = {}): LemonadeModel {
  return {
    name: 'Qwen3-0.6B-GGUF',
    repoId: 'unsloth/Qwen3-0.6B-GGUF',
    variant: 'Q4_0',
    mmproj: null,
    suggested: false,
    labels: [],
    sizeGb: 0.4,
    ...over,
  };
}

// A single-file model named by its repo (as the hub-cache scan names it).
function repoModel(name: string, files: Model['files']): Model {
  return {name, files};
}

function single(
  filename: string,
  quant: string,
  missing = false,
): Model['files'][number] {
  return {isSplit: false, filename, path: filename, quant, size: 1, missing};
}

function loc(name: string, models: Model[]): InventoryLocation {
  return {name, models};
}

test('lemonadeDownloadStatus matches a quant-token variant case-insensitively', () => {
  const local = loc('local', [
    repoModel('unsloth/Qwen3-0.6B-GGUF', [
      single('Qwen3-0.6B-Q4_0.gguf', 'Q4_0'),
    ]),
  ]);
  const info = lemonadeDownloadStatus(model({variant: 'q4_0'}), [local]);
  expect(info.status).toBe('complete');
  expect(info.locations).toEqual([{name: 'local', status: 'complete'}]);
});

test('lemonadeDownloadStatus matches an exact-filename variant', () => {
  const local = loc('local', [
    repoModel('unsloth/gemma-3-270m-it-GGUF', [
      single('gemma-3-270m-it-UD-IQ2_M.gguf', 'IQ2_M'),
    ]),
  ]);
  const info = lemonadeDownloadStatus(
    model({
      repoId: 'unsloth/gemma-3-270m-it-GGUF',
      variant: 'gemma-3-270m-it-UD-IQ2_M.gguf',
    }),
    [local],
  );
  expect(info.status).toBe('complete');
});

test('lemonadeDownloadStatus matches a whole-repo (null) variant via any gguf', () => {
  const local = loc('local', [
    repoModel('pqnet/bge-reranker-v2-m3-Q8_0-GGUF', [
      single('bge-reranker-v2-m3-Q8_0.gguf', 'Q8_0'),
    ]),
  ]);
  const info = lemonadeDownloadStatus(
    model({repoId: 'pqnet/bge-reranker-v2-m3-Q8_0-GGUF', variant: null}),
    [local],
  );
  expect(info.status).toBe('complete');
});

test('lemonadeDownloadStatus reports partial when a shard is missing', () => {
  const split: Model['files'][number] = {
    isSplit: true,
    representativeFilename: 'Qwen3-0.6B-Q4_0-00001-of-00002.gguf',
    files: [{path: 'Qwen3-0.6B-Q4_0-00001-of-00002.gguf', size: 1}],
    quant: 'Q4_0',
    totalShards: 2,
    presentShards: 1,
    missingIndices: [2],
    totalSize: 1,
  };
  const local = loc('local', [repoModel('unsloth/Qwen3-0.6B-GGUF', [split])]);
  const info = lemonadeDownloadStatus(model(), [local]);
  expect(info.status).toBe('partial');
  expect(info.locations).toEqual([{name: 'local', status: 'partial'}]);
});

test('lemonadeDownloadStatus reports partial when the named mmproj is absent', () => {
  const local = loc('local', [
    repoModel('unsloth/Qwen3-VL-GGUF', [single('Qwen3-VL-Q4_0.gguf', 'Q4_0')]),
  ]);
  const info = lemonadeDownloadStatus(
    model({repoId: 'unsloth/Qwen3-VL-GGUF', mmproj: 'mmproj-F16.gguf'}),
    [local],
  );
  expect(info.status).toBe('partial');
});

test('lemonadeDownloadStatus is complete when the named mmproj is present', () => {
  const local = loc('local', [
    repoModel('unsloth/Qwen3-VL-GGUF', [
      single('Qwen3-VL-Q4_0.gguf', 'Q4_0'),
      single('mmproj-F16.gguf', 'F16'),
    ]),
  ]);
  const info = lemonadeDownloadStatus(
    model({repoId: 'unsloth/Qwen3-VL-GGUF', mmproj: 'mmproj-F16.gguf'}),
    [local],
  );
  expect(info.status).toBe('complete');
});

test('lemonadeDownloadStatus returns none when nothing matches', () => {
  const local = loc('local', [
    repoModel('someone/else-GGUF', [single('else-Q4_0.gguf', 'Q4_0')]),
  ]);
  const info = lemonadeDownloadStatus(model(), [local]);
  expect(info.status).toBe('none');
  expect(info.locations).toEqual([]);
});

test('lemonadeDownloadStatus takes the best status across locations, preserving order', () => {
  const partialSplit: Model['files'][number] = {
    isSplit: true,
    representativeFilename: 'Qwen3-0.6B-Q4_0-00001-of-00002.gguf',
    files: [{path: 'Qwen3-0.6B-Q4_0-00001-of-00002.gguf', size: 1}],
    quant: 'Q4_0',
    totalShards: 2,
    presentShards: 1,
    missingIndices: [2],
    totalSize: 1,
  };
  const myServer = loc('my-server', [
    repoModel('unsloth/Qwen3-0.6B-GGUF', [partialSplit]),
  ]);
  const cold = loc('cold storage', [
    repoModel('unsloth/Qwen3-0.6B-GGUF', [
      single('Qwen3-0.6B-Q4_0.gguf', 'Q4_0'),
    ]),
  ]);
  const info = lemonadeDownloadStatus(model(), [myServer, cold]);
  expect(info.status).toBe('complete');
  expect(info.locations).toEqual([
    {name: 'my-server', status: 'partial'},
    {name: 'cold storage', status: 'complete'},
  ]);
});

// --- lemonadeStatusTooltip ----------------------------------------------

test('lemonadeStatusTooltip groups locations by status', () => {
  expect(
    lemonadeStatusTooltip({
      status: 'complete',
      locations: [
        {name: 'my-server', status: 'partial'},
        {name: 'cold storage', status: 'complete'},
        {name: 'local', status: 'complete'},
      ],
    }),
  ).toBe('Complete: cold storage, local. Partial: my-server.');
});

test('lemonadeDownloadStatus reports partial when a single file is missing', () => {
  const local = loc('local', [
    repoModel('unsloth/Qwen3-0.6B-GGUF', [
      single('Qwen3-0.6B-Q4_0.gguf', 'Q4_0', true /* missing */),
    ]),
  ]);
  const info = lemonadeDownloadStatus(model(), [local]);
  expect(info.status).toBe('partial');
});

test('lemonadeDownloadStatus matches an exact-filename variant against a split group', () => {
  const split: Model['files'][number] = {
    isSplit: true,
    representativeFilename: 'Qwen3-0.6B-Q4_0-00001-of-00002.gguf',
    files: [
      {path: 'Qwen3-0.6B-Q4_0-00001-of-00002.gguf', size: 1},
      {path: 'Qwen3-0.6B-Q4_0-00002-of-00002.gguf', size: 1},
    ],
    quant: 'Q4_0',
    totalShards: 2,
    presentShards: 2,
    missingIndices: [],
    totalSize: 2,
  };
  const local = loc('local', [repoModel('unsloth/Qwen3-0.6B-GGUF', [split])]);
  const info = lemonadeDownloadStatus(
    model({variant: 'Qwen3-0.6B-Q4_0.gguf'}),
    [local],
  );
  expect(info.status).toBe('complete');
});

// --- missingVariantFiles ------------------------------------------------

// A present split group: every shard listed in `files`.
function splitGroup(
  representativeFilename: string,
  quant: string,
  shardPaths: string[],
  totalShards: number,
): Model['files'][number] {
  return {
    isSplit: true,
    representativeFilename,
    files: shardPaths.map((path) => ({path, size: 1})),
    quant,
    totalShards,
    presentShards: shardPaths.length,
    missingIndices: [],
    totalSize: shardPaths.length,
  };
}

test('missingVariantFiles: returns [] when every variant file is present locally', () => {
  const local = [
    repoModel('org/Repo-GGUF', [single('Model-Q4_K_M.gguf', 'Q4_K_M')]),
  ];
  expect(
    missingVariantFiles(['Model-Q4_K_M.gguf'], local, 'org/Repo-GGUF'),
  ).toEqual([]);
});

test('missingVariantFiles: returns all paths when none are present locally', () => {
  const local: Model[] = [];
  expect(
    missingVariantFiles(
      ['Model-Q4_K_M.gguf', 'mmproj.gguf'],
      local,
      'org/Repo-GGUF',
    ),
  ).toEqual(['Model-Q4_K_M.gguf', 'mmproj.gguf']);
});

test('missingVariantFiles: a present single file is excluded, an absent one included', () => {
  const local = [
    repoModel('org/Repo-GGUF', [single('Model-Q4_K_M.gguf', 'Q4_K_M')]),
  ];
  expect(
    missingVariantFiles(
      ['Model-Q4_K_M.gguf', 'mmproj.gguf'],
      local,
      'org/Repo-GGUF',
    ),
  ).toEqual(['mmproj.gguf']);
});

test('missingVariantFiles: a missing single file (missing=true) is treated as absent', () => {
  const local = [
    repoModel('org/Repo-GGUF', [single('Model-Q4_K_M.gguf', 'Q4_K_M', true)]),
  ];
  expect(
    missingVariantFiles(['Model-Q4_K_M.gguf'], local, 'org/Repo-GGUF'),
  ).toEqual(['Model-Q4_K_M.gguf']);
});

test('missingVariantFiles: a partial split returns only the missing shards', () => {
  const local = [
    repoModel('org/Repo-GGUF', [
      splitGroup(
        'Model-Q4_0-00001-of-00002.gguf',
        'Q4_0',
        ['Model-Q4_0-00001-of-00002.gguf'], // only shard 1 present
        2,
      ),
    ]),
  ];
  expect(
    missingVariantFiles(
      ['Model-Q4_0-00001-of-00002.gguf', 'Model-Q4_0-00002-of-00002.gguf'],
      local,
      'org/Repo-GGUF',
    ),
  ).toEqual(['Model-Q4_0-00002-of-00002.gguf']);
});

test('missingVariantFiles: ignores files belonging to a different repo', () => {
  const local = [
    repoModel('org/Other-GGUF', [single('Model-Q4_K_M.gguf', 'Q4_K_M')]),
  ];
  expect(
    missingVariantFiles(['Model-Q4_K_M.gguf'], local, 'org/Repo-GGUF'),
  ).toEqual(['Model-Q4_K_M.gguf']);
});

test('missingVariantFiles: matches by basename when paths carry subdirs', () => {
  const local = [
    repoModel('org/Repo-GGUF', [single('Model-Q4_K_M.gguf', 'Q4_K_M')]),
  ];
  expect(
    missingVariantFiles(['sub/Model-Q4_K_M.gguf'], local, 'org/Repo-GGUF'),
  ).toEqual([]);
});

// --- collection / component download status -----------------------------

function comp(
  name: string,
  recipe: string,
  checkpoints: Array<{repoId: string; variant: string | null}>,
  downloadable = false,
): LemonadeComponent {
  return {
    name,
    recipe,
    modality: recipe,
    sizeGb: 1,
    downloadable,
    checkpoints,
  };
}

function coll(name: string, components: LemonadeComponent[]): OmniCollection {
  return {name, suggested: false, sizeGb: 0, labels: [], components};
}

// A vision LLM (weight + mmproj), a whisper .bin, and a kokoro ONNX (whole
// repo). The ONNX isn't a tracked weight type, so it's the untrackable member.
const llmComp = comp(
  'LLM',
  'llamacpp',
  [
    {repoId: 'o/llm', variant: 'Q4_K_M'},
    {repoId: 'o/llm', variant: 'mmproj-F16.gguf'},
  ],
  true,
);
const whisperComp = comp('Whisper', 'whispercpp', [
  {repoId: 'o/whisper', variant: 'ggml-tiny.bin'},
]);
const kokoroComp = comp('Kokoro', 'kokoro', [
  {repoId: 'o/kokoro', variant: null},
]);

const llmFiles = repoModel('o/llm', [
  single('llm-Q4_K_M.gguf', 'Q4_K_M'),
  single('mmproj-F16.gguf', 'F16'),
]);
const whisperFiles = repoModel('o/whisper', [
  single('ggml-tiny.bin', 'unknown'),
]);

test('collectionDownloadStatus is complete when every trackable member is present', () => {
  const c = coll('Omni', [llmComp, whisperComp, kokoroComp]);
  const info = collectionDownloadStatus(c, [
    loc('local', [llmFiles, whisperFiles]),
  ]);
  // The untrackable kokoro member doesn't hold it back.
  expect(info.status).toBe('complete');
  expect(info.locations).toEqual([{name: 'local', status: 'complete'}]);
});

test('collectionDownloadStatus is partial when a trackable member is missing', () => {
  const c = coll('Omni', [llmComp, whisperComp, kokoroComp]);
  const info = collectionDownloadStatus(c, [loc('local', [llmFiles])]);
  expect(info.status).toBe('partial');
  expect(info.locations).toEqual([{name: 'local', status: 'partial'}]);
});

test('collectionDownloadStatus is none when nothing trackable is present', () => {
  // A collection of only the untrackable kokoro member, plus an empty scan.
  const c = coll('Omni', [kokoroComp]);
  const info = collectionDownloadStatus(c, [loc('local', [])]);
  expect(info.status).toBe('none');
  expect(info.locations).toEqual([]);
});

test('collectionDownloadStatus is partial, not complete, when members are split across locations', () => {
  const c = coll('Omni', [llmComp, whisperComp]);
  const info = collectionDownloadStatus(c, [
    loc('local', [llmFiles]), // has the LLM, not whisper
    loc('cold storage', [whisperFiles]), // has whisper, not the LLM
  ]);
  // No single location holds the whole bundle.
  expect(info.status).toBe('partial');
  expect(info.locations).toEqual([
    {name: 'local', status: 'partial'},
    {name: 'cold storage', status: 'partial'},
  ]);
});

test('componentInLemonadeCache flags a null-variant (.onnx) member by repo-id presence', () => {
  // kokoroComp's only checkpoint is a whole-repo (null variant) `o/kokoro`,
  // which the weight scan can't match file-by-file. Its repo dir being in the
  // cache (here a stray `.bin`) is enough to flag it.
  const cache = [repoModel('o/kokoro', [single('voices.bin', 'unknown')])];
  expect(componentInLemonadeCache(kokoroComp, cache)).toBe(true);
  // componentDownloadStatus, which needs a matchable file, still reads none.
  expect(
    componentDownloadStatus(kokoroComp, [loc('cache', cache)]).status,
  ).toBe('none');
  // Absent from the cache: no flag.
  expect(componentInLemonadeCache(kokoroComp, [])).toBe(false);
});

test('collectionInLemonadeCache flags a collection when any member is cached', () => {
  const c = coll('Omni', [llmComp, kokoroComp]);
  const cache = [repoModel('o/kokoro', [single('voices.bin', 'unknown')])];
  expect(collectionInLemonadeCache(c, cache)).toBe(true);
  expect(collectionInLemonadeCache(c, [])).toBe(false);
});

test('modelInLemonadeCache matches a GGUF variant precisely, not its repo siblings', () => {
  const withVariant = [
    repoModel('unsloth/Qwen3-0.6B-GGUF', [
      single('Qwen3-0.6B-Q4_0.gguf', 'Q4_0'),
    ]),
  ];
  expect(modelInLemonadeCache(model({variant: 'Q4_0'}), withVariant)).toBe(
    true,
  );
  // A different variant of the same repo must not be flagged off the repo alone.
  expect(modelInLemonadeCache(model({variant: 'Q8_0'}), withVariant)).toBe(
    false,
  );
});

test('componentDownloadStatus tracks a non-llamacpp member (whisper) by its file', () => {
  expect(
    componentDownloadStatus(whisperComp, [loc('local', [whisperFiles])]).status,
  ).toBe('complete');
  // The kokoro ONNX can't be seen by the weight scan: no marker.
  expect(componentDownloadStatus(kokoroComp, [loc('local', [])]).status).toBe(
    'none',
  );
});
