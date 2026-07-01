# Lemonade Model Label Icons Implementation Plan

**Goal:** Replace the Lemonade browser's gray capability-label text chips with
small Heroicons that show a longer description on hover.

**Architecture:** Pure label data (descriptions, display order, sort) lives in
a testable `lib/` module; a small client component maps each label to a
Heroicon wrapped in a `HoverCard`, with a gray-badge fallback for unmapped
labels; the browser swaps its label `.map` to render the component in sorted
order. Download-status and `suggested` badges are untouched.

Spec: `docs/specs/2026-06-16-lemonade-label-icons-design.md`

## Task 1: Label data module (descriptions, order, sort)

**Files:**

- Create: `lib/lemonade-labels.ts`
- Test: `lib/lemonade-labels.test.ts`

```ts
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

export function sortLabelsForDisplay(labels: string[]): string[] {
  const rank = (label: string): number => {
    const i = LABEL_DISPLAY_ORDER.indexOf(label);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...labels].sort((a, b) => rank(a) - rank(b));
}
```

Tests: known labels are ordered by `LABEL_DISPLAY_ORDER`; unknown labels sort
last, stably, in their input order; every label in `LABEL_DISPLAY_ORDER` has
an entry in `LABEL_DESCRIPTIONS`.

## Task 2: ModelLabelIcon component

**Files:**

- Create: `components/lemonade/model-label-icon.tsx`
- New dependency: `@heroicons/react`

No unit test: the component imports Astryx components, which the repo's bun
test setup does not render (consistent with existing component coverage).
Verified by typecheck.

One Heroicon per capability label, deliberately distinct metaphors from
lemonade's lucide set (Eye→Photo, Flame→Star, Wrench→Puzzle, Brain→Bulb,
SquareCode→CommandLine, Layers→Squares, ListOrdered→Arrows):

```tsx
const LABEL_ICONS: Record<string, IconType> = {
  reasoning: LightBulbIcon,
  coding: CommandLineIcon,
  vision: PhotoIcon,
  'tool-calling': PuzzlePieceIcon,
  hot: StarIcon,
  embeddings: Squares2X2Icon,
  reranking: ArrowsUpDownIcon,
  mtp: BoltIcon,
  'chat-transcription': MicrophoneIcon,
  llamacpp: CpuChipIcon,
};

export function ModelLabelIcon({label}: {label: string}) {
  const IconComponent = LABEL_ICONS[label];
  if (!IconComponent) return <Badge label={label} variant="neutral" />;
  return (
    <HoverCard content={LABEL_DESCRIPTIONS[label] ?? label}>
      <Icon icon={IconComponent} size="sm" />
    </HoverCard>
  );
}
```

`Icon` is Astryx's icon wrapper, which accepts a custom SVG component
directly — so passing a Heroicon through `icon={IconComponent}` gets the
design system's standard sizing/color handling for free.

## Task 3: Render icons in the Lemonade browser

**Files:**

- Modify: `components/lemonade/lemonade-browser.tsx`

Import `ModelLabelIcon` and `sortLabelsForDisplay`. Replace the
`m.labels.map((l) => <Badge key={l} label={l} variant="neutral" />)` block
with:

```tsx
{
  m.labels.length > 0 && (
    <HStack gap={1} vAlign="center">
      {sortLabelsForDisplay(m.labels).map((l) => (
        <ModelLabelIcon key={l} label={l} />
      ))}
    </HStack>
  );
}
```

Leave the `suggested` badge and the download-status badge unchanged.

Manual verification: capability labels render as small icons in the same row
position, in the fixed order; hovering an icon shows the longer description;
`downloaded`/`partial` and `suggested` badges look exactly as before; the
filter box still matches on label text.

## Self-review

- `LABEL_DESCRIPTIONS`/`LABEL_DISPLAY_ORDER`/`sortLabelsForDisplay` defined
  once in `lib/lemonade-labels.ts`, consumed identically by
  `ModelLabelIcon`/`lemonade-browser.tsx`.
- Out of scope: status badges, label data/search-filter changes.
