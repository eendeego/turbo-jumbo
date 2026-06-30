# Doom Console — Design Spec

## Overview

Replace the inline `Log` section with a Doom-style drop-down console that
overlays the page from the bottom of the viewport. Toggled by a persistent
bottom-edge tab handle and the `~` keyboard shortcut.

## Layout & Position

- `position: fixed; bottom: 0; left: 0; right: 0` — full-width overlay
- Height when open: `50vh`
- High `zIndex` so it sits above all page content
- A small tab handle is always visible at the bottom edge of the viewport,
  whether the console is open or closed

## Handle Tab (Closed State)

- Pinned to bottom of viewport (`position: fixed; bottom: 0`)
- Same retro green palette as the console body
- Background `#122312`, top border `1px solid #1a3a1a`
- Contents: "Console" label (left) and `~` shortcut hint (right)
- Monospace font, small text
- Clicking the handle toggles the console open/closed
- When the console is open, the handle sits at the top edge of the console
  panel as its header bar

## Visual Style — Retro Green

| Element            | Color     |
| ------------------ | --------- |
| Console background | `#0c1a0c` |
| Header/handle bg   | `#122312` |
| Border             | `#1a3a1a` |
| Timestamps         | `#3a6a3a` |
| Log message text   | `#86efac` |
| INFO level         | `#4ade80` |
| WARN level         | `#fbbf24` |
| ERROR level        | `#f87171` |
| DEBUG level        | `#3a6a3a` |
| TRACE level        | `#2a5a2a` |
| Handle label text  | `#4a8a4a` |
| Handle shortcut    | `#3a6a3a` |

- Monospace font throughout
- No border radius on the console panel (it spans full width at the viewport
  edge); the handle tab may have a slight top radius

This retro console is intentionally a raw, themed surface and does **not** use
the Astryx component palette — it is styled entirely through a local
`stylex.create` block with the literal colors above. Astryx tokens do not
cover this deliberately off-brand "terminal" aesthetic, so hard-coded values
are acceptable here and scoped to this one component.

## Animation

- StyleX transition on `height`: `300ms ease-out`
- Open: height transitions from `0` to `50vh`; close reverses
- The handle remains visible at all times; only the console body slides
- `overflow: hidden` on the panel during transition to prevent content flash

## Keyboard Shortcut

- The `~` key (tilde/backtick) toggles the console open/closed
- Ignored when focus is inside an `<input>`, `<textarea>`, or
  `[contenteditable]` element
- Registered via a `useEffect` `keydown` listener on `document`

## Behavior

- Auto-scroll to newest entry when the user is pinned to the bottom
- Log level filtering stays as-is (driven by `logLevel` from config)
- Empty state shown when no entries match the current level
- The console panel body scrolls independently of the page

## Files Changed

### `components/log/log.tsx`

Rewrite `Log` as the fixed overlay console:

- Add `open` state (boolean, default `false`)
- Render the handle tab (always visible)
- Render the console panel with conditional height based on `open`
- Apply the retro green palette via a local `stylex.create` block
- Add `useEffect` for the `~` keyboard listener
- Preserve existing auto-scroll and log filtering logic

### `components/home/home-client.tsx`

- Move `<Log>` out of the narrow content column
- Render it at the top level of the component return (outside `AppShell`'s
  flow, since it is now a fixed overlay)
