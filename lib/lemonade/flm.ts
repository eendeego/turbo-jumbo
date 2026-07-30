// FLM (FastFlowLM, AMD NPU) models, as reported by a live Lemonade server.
// These never appear in the static server_models.json catalog: a Lemonade
// server discovers them at runtime by asking its local flm binary, and their
// checkpoints are flm tags (`qwen3.6-moe:35b-a3b`), not Hugging Face repos —
// so both listing and downloading go through that server's API (the per-peer
// `lemonade_url` config), never through the HF download path.

/** One FLM model on a Lemonade server, download state included. */
export interface FlmModel {
  name: string; // Lemonade model id, e.g. "gpt-oss-20b-FLM"
  checkpoint: string; // flm tag, e.g. "gpt-oss:20b" ('' when unreported)
  sizeGb: number; // declared size in decimal GB (0 when unreported)
  downloaded: boolean; // present in that server's FLM store
  labels: string[];
}

/**
 * The FLM-recipe models of a Lemonade `GET /models?show_all=true` response.
 * Tolerant of malformed shapes — the payload comes from a live server of
 * whatever version — so unknown entries are skipped rather than fatal.
 */
export function parseFlmModels(payload: unknown): FlmModel[] {
  if (payload == null || typeof payload !== 'object') return [];
  const data = (payload as {data?: unknown}).data;
  if (!Array.isArray(data)) return [];
  const models: FlmModel[] = [];
  for (const raw of data) {
    if (raw == null || typeof raw !== 'object') continue;
    const e = raw as {
      id?: unknown;
      recipe?: unknown;
      checkpoint?: unknown;
      downloaded?: unknown;
      size?: unknown;
      labels?: unknown;
    };
    if (e.recipe !== 'flm') continue;
    if (typeof e.id !== 'string' || e.id === '') continue;
    models.push({
      name: e.id,
      checkpoint: typeof e.checkpoint === 'string' ? e.checkpoint : '',
      sizeGb: typeof e.size === 'number' ? e.size : 0,
      downloaded: e.downloaded === true,
      labels: Array.isArray(e.labels)
        ? e.labels.filter((l): l is string => typeof l === 'string')
        : [],
    });
  }
  return models;
}

/** A peer's Lemonade API base with the trailing slash normalized away. */
export function lemonadeApiBase(url: string): string {
  return url.replace(/\/+$/, '');
}
