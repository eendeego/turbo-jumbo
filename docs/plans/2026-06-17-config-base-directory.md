# Config Base Directory Implementation Plan

**Goal:** Let a peer override the subdirectory names under its `base_path`
(`turbo_jumbo_subdir` / `lemonade_subdir`, defaulting to `turbo-jumbo` /
`lemonade`), and extract the base→subdir derivation into a pure, tested
helper.

**Architecture:** All ~20 consumers read the derived config exports
(`localModelsDir`, `coldStorageDir`, `lemonadeDir`), which stay identical.
Only `lib/config.ts` reads the raw per-peer YAML, so the change is confined
to `lib/config.ts`, `config.schema.json`, and a new test. A pure helper
`resolveBaseSubdirs` does the base→subdir derivation and is unit-tested.

Spec: `docs/specs/2026-06-17-config-base-directory-design.md`

## Task: Add subdir overrides and `resolveBaseSubdirs` in `lib/config.ts`

Add to the `Peer` interface:

```ts
// Subdirectory names under base_path; default to turbo-jumbo / lemonade.
turbo_jumbo_subdir?: string;
lemonade_subdir?: string;
```

Add the pure helper:

```ts
/**
 * The turbo-jumbo (local models) and Lemonade directories for a peer, derived
 * from its base_path and optional subdir-name overrides. Defaults: models live
 * in <base>/turbo-jumbo and Lemonade's cache in <base>/lemonade.
 */
export function resolveBaseSubdirs(peer: Peer): {
  localModels: string;
  lemonade: string;
} {
  const base = peer.base_path!;
  return {
    localModels: path.join(base, peer.turbo_jumbo_subdir ?? 'turbo-jumbo'),
    lemonade: path.join(base, peer.lemonade_subdir ?? 'lemonade'),
  };
}
```

Replace the inline `path.join(localPeer.base_path, 'turbo-jumbo')` /
`path.join(localPeer.base_path, 'lemonade')` derivations (`localModelsDir`,
`lemonadeDir`) with calls through `resolveBaseSubdirs(localPeer)`, so there's
one definition of the default subdir names. `lemonadeDir` stays
`string | undefined` (unset only when there's no local peer) — no consumer
changes needed.

Add the two new optional string properties to the peer schema in
`config.schema.json`.

Tests (`lib/config.test.ts`, new): `resolveBaseSubdirs` with default subdir
names derives `<base>/turbo-jumbo` and `<base>/lemonade`; with
`turbo_jumbo_subdir`/`lemonade_subdir` overrides, derives the overridden
paths.

## Self-review

- `resolveBaseSubdirs(peer): {localModels, lemonade}` is the one place the
  default subdir names (`turbo-jumbo`, `lemonade`) are written; both
  `localModelsDir` and `lemonadeDir` call through it.
- No consumer of `localModelsDir`/`coldStorageDir`/`lemonadeDir` changes —
  their types and values are unaffected for a peer with no overrides.
- Out of scope: moving model files on disk; cold storage's separate
  top-level path.
