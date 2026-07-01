# Surface hf notices in the download dialog

## Problem

The `hf` downloader interleaves three kinds of output in the streamed download
log:

1. **Progress** — `Downloading…`, `Fetching N files…`, `Download complete…`,
   the resulting `  path: …` line. Already parsed into progress bars.
2. **Our own wrapper status** — `Process exited with code N`, `Recording
sources…`, per-file audit results, cold-storage progress, `Done.`.
3. **hf chatter** — version-update hints, `FutureWarning` deprecation notices,
   and any `Error:` lines.

Category 3 is easy to miss: it scrolls past in the raw terminal `<pre>` and is
never highlighted. We want those messages (warnings/hints + errors) always
surfaced, while the full raw output moves behind a disclosure toggle.

## Design

### `lib/download-output.ts` (new, pure / unit-tested)

Move `parseProgress` and `parseSize` here from
`components/hf-download/download-runner.tsx` so all hf-output parsing lives in
one tested module, and add notice parsing:

```ts
export type Notice = {text: string; severity: 'warning' | 'error'};
export function parseNotices(lines: string[]): Notice[];
```

Each non-blank line is classified as exactly one of:

- **progress** — matches the existing download/fetch/complete regexes, the
  `  path: …` line, or the cold-storage `[███░░] NN%` bar. Excluded from notices.
- **wrapper status** — our own emitted strings: `Process exited with code`,
  `Recording sources…`, per-file audit results (`  <name>: <status>`),
  `Moving/Copying to cold storage…`, `Cleaning up local copy…`, `Done.`.
  Excluded from notices.
- **notice** — everything else. Severity is `error` when the line matches
  `/error|traceback/i`, otherwise `warning`.

Notices preserve stream order; a multi-line warning (e.g. the 3-line
`FutureWarning` block) renders as consecutive rows.

### `DownloadModal` UI (in `components/hf-download/download-runner.tsx`)

- **Notices panel**: rendered when `parseNotices(term.lines)` is non-empty,
  placed between the HF-token warning and the progress bars. One panel, styled
  like the existing amber token-warning box. Each row carries its own marker:
  a warning icon for `warning`, an error icon for `error`.
- **Full output disclosure**: the raw terminal output moves behind a
  `Show full output ▾` / `Hide full output ▴` toggle (mirroring the existing
  `Show command ▾` toggle), collapsed by default.

No API-route changes — classification is entirely client-side over the existing
stream buffer.

## Testing

`lib/download-output.test.ts` drives `parseNotices` (and the moved
`parseProgress`) against the two real sample outputs:

- the version-update `Hint:` + `To update, run: hf update` pair,
- the `constants.py:NNN:` / `FutureWarning:` / `Please use…` block,

asserting progress and wrapper-status lines are excluded and severities are
correct. Then `bun typecheck` and `bun lint`.
