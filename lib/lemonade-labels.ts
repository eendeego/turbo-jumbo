// Human-readable hover descriptions and display order for a Lemonade model's
// capability labels. Pure data + ordering — the React icon mapping that
// consumes this lives in components/lemonade/model-label-icon.tsx.

/** Longer hover text for each known capability label, keyed by the raw label. */
export const LABEL_DESCRIPTIONS: Record<string, string> = {
  reasoning: 'Reasoning — works through problems step by step',
  coding: 'Coding — tuned for writing and editing code',
  vision: 'Vision — accepts image input',
  'tool-calling': 'Tool calling — can invoke functions / tools',
  hot: 'Hot — popular / recommended',
  embeddings: 'Embeddings — produces vector embeddings',
  reranking: 'Reranking — reorders results by relevance',
  mtp: 'Multi-token prediction — faster decoding',
  'chat-transcription': 'Chat transcription — transcribes audio in chat',
  llamacpp: 'llama.cpp — runs on the llama.cpp backend',
};

/** The order labels are shown in; labels absent here sort after these, stably. */
export const LABEL_DISPLAY_ORDER: string[] = [
  'reasoning',
  'coding',
  'vision',
  'tool-calling',
  'hot',
  'embeddings',
  'reranking',
  'mtp',
  'chat-transcription',
  'llamacpp',
];

/**
 * Order a model's labels for display: known labels by LABEL_DISPLAY_ORDER,
 * unknown labels after them in their original order. Array.sort is stable, so
 * equal-rank (unknown) labels keep their input order.
 */
export function sortLabelsForDisplay(labels: string[]): string[] {
  const rank = (label: string): number => {
    const i = LABEL_DISPLAY_ORDER.indexOf(label);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...labels].sort((a, b) => rank(a) - rank(b));
}
