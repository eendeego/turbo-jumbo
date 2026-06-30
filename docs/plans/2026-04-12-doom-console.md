# Doom Console Implementation Plan

**Goal:** Replace the inline operation log with a Doom-style retro-green console
that slides up from the bottom of the viewport, toggled by a handle tab and the
`~` key.

**Architecture:** The `Log` component in `components/log/log.tsx` becomes a
fixed-position overlay with open/close state, a height transition, and a
keyboard shortcut. The call site in `components/home/home-client.tsx` moves
`<Log>` outside the narrow content column so it renders as an independent
overlay above page flow.

**Tech Stack:** React, StyleX (`stylex.create` with literal retro-green colors —
see the design spec for why this surface is deliberately off-brand and bypasses
the Astryx palette), existing `lib/client-log.ts` subscription system.

**Spec:** `docs/plans/2026-04-12-doom-console-design.md`

---

## File Structure

| File                              | Action  | Responsibility                                                    |
| --------------------------------- | ------- | ----------------------------------------------------------------- |
| `components/log/log.tsx`          | Rewrite | Fixed overlay console: handle, height animation, keyboard toggle  |
| `components/home/home-client.tsx` | Modify  | Move `<Log>` from the narrow column to a top-level overlay render |

---

### Task 1: Rewrite `components/log/log.tsx` as a fixed overlay console

- Add `open` state (boolean, default `false`).
- Keep the `getEntries`/`subscribe` wiring and the `logLevel` filtering.
- Add a `containerRef` + `pinnedRef` to preserve auto-scroll-when-pinned.
- Render a fixed bottom container holding:
  - a handle `<button>` (always visible) with the "Console" label and `~` hint;
  - a panel whose `height` animates between `0` and `50vh` via a StyleX
    `transition`, with `overflow: hidden`.
- Style entirely through a local `stylex.create` block using the literal retro
  palette from the design spec (`#0c1a0c`, `#122312`, `#86efac`, the per-level
  colors, etc.). This component intentionally does **not** use Astryx surface
  components — it is a raw terminal aesthetic.
- Add a `useEffect` `keydown` listener on `document` toggling `open` for `~`/`` ` ``,
  ignored when focus is in an input/textarea/contenteditable.
- Verify with `bun typecheck` / `bun lint` / `bun format:check`, then commit.

### Task 2: Move `<Log>` out of the content column in `home-client.tsx`

- Remove `<Log logLevel={...} />` from inside the narrow (`maxWidth: 42rem`)
  `VStack`.
- Render it once at the top level of the component's returned tree, after
  `AppShell`, since it is now a fixed overlay and no longer participates in page
  flow.
- Verify and commit.
