# Lemonade model labels as icons

## Overview

In the Lemonade browser, each model's capability labels (`reasoning`,
`vision`, …) render today as gray `Badge` text chips. Replace those chips
with small icons, following lemonade's own convention (`../lemonade`'s
`ModalityIcon`: one small icon per label, in a fixed display order, with a
hover description) — but using a distinct icon set, so tip doesn't visually
copy lemonade.

The download-state badges (`downloaded` / `partial`, blue/orange) and the
`suggested` badge (green) are **out of scope** and stay exactly as they are.
Lemonade's convention only iconifies capability labels, not transfer state.

## Scope

- Affects one render site: the label chips in
  `components/lemonade/lemonade-browser.tsx` (the `m.labels.map(...
<Badge/> ...)` block).
- Search is unaffected: the filter reads `m.labels` regardless of how they are
  displayed.

## Icon mapping

Heroicons (`@heroicons/react/24/outline`, added as a new dependency), passed
to Astryx's `Icon` component via its custom-SVG-component support. Every
label present in tip's Lemonade data is covered, and **no icon reuses
lemonade's metaphor** (lemonade's lucide choice listed only to show the
divergence):

| label                | lemonade (avoid) | tip (Heroicon)     | hover description                               |
| -------------------- | ---------------- | ------------------ | ----------------------------------------------- |
| `reasoning`          | Brain            | `LightBulbIcon`    | Reasoning — works through problems step by step |
| `coding`             | SquareCode       | `CommandLineIcon`  | Coding — tuned for writing and editing code     |
| `vision`             | Eye              | `PhotoIcon`        | Vision — accepts image input                    |
| `tool-calling`       | Wrench           | `PuzzlePieceIcon`  | Tool calling — can invoke functions / tools     |
| `hot`                | Flame            | `StarIcon`         | Hot — popular / recommended                     |
| `embeddings`         | Layers           | `Squares2X2Icon`   | Embeddings — produces vector embeddings         |
| `reranking`          | ListOrdered      | `ArrowsUpDownIcon` | Reranking — reorders results by relevance       |
| `mtp`                | —                | `BoltIcon`         | Multi-token prediction — faster decoding        |
| `chat-transcription` | —                | `MicrophoneIcon`   | Chat transcription — transcribes audio in chat  |
| `llamacpp`           | —                | `CpuChipIcon`      | llama.cpp — runs on the llama.cpp backend       |

## Components and data flow

Split pure data (testable, no React) from the React rendering, matching the
repo's convention of keeping logic in `lib/`.

- **`lib/lemonade-labels.ts`** (new, pure):
  - `LABEL_DESCRIPTIONS: Record<string, string>` — the hover text above.
  - `LABEL_DISPLAY_ORDER: string[]` —
    `['reasoning','coding','vision','tool-calling','hot','embeddings','reranking','mtp','chat-transcription','llamacpp']`.
  - `sortLabelsForDisplay(labels: string[]): string[]` — orders by
    `LABEL_DISPLAY_ORDER`; labels not in the order sort last, preserving their
    input order (stable).

- **`components/lemonade/model-label-icon.tsx`** (new): `ModelLabelIcon({label})`.
  - Looks up the Heroicon for `label`. Wraps it in a `HoverCard` showing
    `LABEL_DESCRIPTIONS[label] ?? label`, with the `Icon` as the trigger.
  - Icon styling: small (`size="sm"`), muted (`color="muted"` or the
    equivalent supporting tone), inline.
  - **Fallback:** a label with no mapped icon renders the existing small gray
    `Badge` (text), so an unknown/future label never silently disappears.

- **`components/lemonade/lemonade-browser.tsx`**: replace the `m.labels.map(...)`
  chip block with
  `sortLabelsForDisplay(m.labels).map((l) => <ModelLabelIcon key={l} label={l} />)`,
  wrapped in a small `HStack gap={1}` occupying the same row position.
  `downloaded`/`partial`/`suggested` badges are left untouched.

## Testing

`lib/lemonade-labels.test.ts`:

- `sortLabelsForDisplay` orders known labels per `LABEL_DISPLAY_ORDER` and
  places unknown labels last (stably).
- `LABEL_DESCRIPTIONS` has an entry for every label in `LABEL_DISPLAY_ORDER`
  (guards against a mapped label missing its hover text).

Icon rendering is not unit-tested: `model-label-icon.tsx` and
`lemonade-browser.tsx` import Astryx components, which the repo's bun test
setup does not render — consistent with existing component coverage.

## Out of scope

- Status badges (`downloaded`, `partial`, `suggested`).
- Any change to the label data, the Lemonade source, or the search filter.
