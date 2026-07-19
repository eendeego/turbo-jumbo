// The Lemonade SDK catalog's shared types: models, checkpoints, components,
// omni collections, the parsed catalog, and the download/inventory shapes the
// status layer reports in.

import type {Model} from '@/lib/models/model-types';

// The Lemonade SDK's model catalog, read from the repo's default branch head so
// the list tracks their latest release rather than a pinned revision.
export const LEMONADE_CATALOG_URL =
  'https://raw.githubusercontent.com/lemonade-sdk/lemonade/main/src/cpp/resources/server_models.json';

/** One downloadable GGUF model from the Lemonade catalog. */
export interface LemonadeModel {
  name: string;
  repoId: string; // HF repo the checkpoint lives in
  variant: string | null; // quant token (Q4_0) or exact filename; null = whole repo
  mmproj: string | null; // companion projector file for vision models
  suggested: boolean;
  labels: string[];
  sizeGb: number;
}

/** A repo + variant to fetch: one of a component's role checkpoints. */
export interface Checkpoint {
  repoId: string;
  variant: string | null; // quant token, exact filename, or null = whole repo
}

/**
 * One member of an omni collection. `downloadable` is true for `llamacpp` GGUF
 * members that join a `LemonadeModel` by `name`; image/audio/TTS members
 * (sd-cpp, whispercpp, kokoro, …) carry their display fields too, and every
 * member lists the `checkpoints` (repos/files) a full download fetches.
 */
export interface LemonadeComponent {
  name: string;
  recipe: string;
  modality: string; // display label: chat, vision, image, transcription, tts…
  suggested: boolean;
  labels: string[];
  sizeGb: number;
  downloadable: boolean;
  checkpoints: Checkpoint[]; // every repo/file this member pulls
}

/**
 * An omni model (`recipe: "collection.omni"`): a bundle of component models
 * rather than a single GGUF. Rendered as an expandable group; its downloadable
 * members reuse the normal per-model download path.
 */
export interface OmniCollection {
  name: string;
  suggested: boolean;
  sizeGb: number;
  labels: string[];
  // The manifest (models.json) this omni model is built from, when it's a
  // manifest-backed collection (a pointer to an HF repo). Absent for inline
  // collections, whose members are defined directly in the catalog.
  manifestUrl?: string;
  components: LemonadeComponent[];
}

/**
 * A `collection.omni` entry whose components live in a manifest JSON inside an
 * HF repo (rather than inline in the catalog). The route fetches `{repo}.json`
 * and resolves it with `collectionFromManifest`.
 */
export interface OmniManifestRef {
  name: string;
  repoId: string;
  suggested: boolean;
  sizeGb: number;
  labels: string[];
}

export interface ParsedLemonade {
  models: LemonadeModel[]; // llamacpp GGUF models, as before
  // Every other standalone catalog entry (ONNX/vLLM LLMs, image, speech, TTS),
  // as components — they carry their own checkpoints and download like an omni
  // member, just not via the single-file GGUF path.
  extraModels: LemonadeComponent[];
  collections: OmniCollection[]; // inline omni collections, fully resolved
  manifestRefs: OmniManifestRef[]; // omni collections needing a manifest fetch
}

// Which section a catalog entry belongs to, for the modality-split catalog.
export type CatalogSection =
  | 'llm'
  | 'vision'
  | 'embeddings'
  | 'reranking'
  | 'image'
  | 'transcription'
  | 'tts'
  | 'onnx'
  | 'vllm'
  | 'other';

/** A per-repo download job: the repo and the variants to resolve within it. */
export interface RepoJob {
  repoId: string;
  variants: Array<string | null>;
}

export type DownloadStatus = 'none' | 'partial' | 'complete';

/** One storage location's scan, labeled for display in the marker tooltip. */
export interface InventoryLocation {
  name: string; // "local", "cold storage", a peer name like "my-server"
  models: Model[];
  isLocal?: boolean; // the location downloads land in
}

/** Where a catalog entry is present, and how complete each copy is. */
export interface LemonadeDownloadInfo {
  status: DownloadStatus; // best across all locations
  locations: Array<{name: string; status: 'partial' | 'complete'}>;
}
