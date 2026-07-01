# Config base directory with turbo-jumbo / lemonade subdirectories

## Overview

Add configurable subdirectory-name overrides for the two directories this app
already derives from a peer's `base_path` (turbo-jumbo's models at
`<base_path>/turbo-jumbo`, Lemonade's cache at `<base_path>/lemonade`), and
extract a pure, testable helper for that derivation. No model files are
moved — only the configuration schema and `lib/config.ts` change.

## Motivation

`base_path` + derived subdirectories is already this app's model (per
`CLAUDE.md`): the local peer's `base_path` yields `<base_path>/turbo-jumbo`
and `<base_path>/lemonade`. Today the derivation is inlined twice — once for
`localModelsDir`, once for `lemonadeDir` — with the subdirectory names
hardcoded. Extracting `resolveBaseSubdirs` as one pure function, and letting a
peer override the subdirectory names, removes the duplication and gives a
peer with an existing on-disk layout a way to point at it without a
`base_path`-relative move.

## Key constraint that bounds the change

Every consumer of storage paths (~20 call sites across `app/`, `components/`,
`lib/`) reads the **derived** config exports — `localModelsDir`,
`coldStorageDir`, `lemonadeDir` (or, server-side, `config.local_models.path` /
`config.lemonade?.path`). Only `lib/config.ts` reads the **raw** per-peer YAML
fields. Keeping the derived exports' shape identical confines the change to
`config.schema.json` and `lib/config.ts`; no consumer changes.

## Schema (per peer)

| field                | change                 | default       |
| -------------------- | ---------------------- | ------------- |
| `base_path`          | unchanged              | (required)    |
| `cold_storage_path`  | unchanged              | (required)    |
| `turbo_jumbo_subdir` | new; optional override | `turbo-jumbo` |
| `lemonade_subdir`    | new; optional override | `lemonade`    |

Example `config.yaml` (override case — a peer with an existing layout):

```yaml
peers:
  - name: this-machine
    address: 192.168.1.10:3000
    base_path: /mnt/models
    cold_storage_path: /mnt/cold-storage
    turbo_jumbo_subdir: tj
    lemonade_subdir: lmnd
```

## Code changes (`lib/config.ts`, `config.schema.json`)

1. **`Peer` interface:** add `turbo_jumbo_subdir?: string` and
   `lemonade_subdir?: string`.

2. **New pure helper:**

   ```ts
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

3. **`loadConfig`:** derive `localModelsDir` and `lemonadeDir` from
   `resolveBaseSubdirs(localPeer)` instead of the inline `path.join` calls.
   `lemonade` becomes unconditionally derived (always `<base>/lemonade` or its
   override) rather than only populated when a separate path was configured —
   consistent with `CLAUDE.md`'s fixed convention. The exported type stays
   optional (`lemonadeDir: string | undefined`, unset only when there's no
   local peer) so existing `lemonadeDir`/`config.lemonade?.path` call sites
   are untouched.

4. **`config.schema.json`:** add the two optional string properties to the
   peer schema.

## Testing

New `lib/config.test.ts`:

- `resolveBaseSubdirs` with default subdir names → `<base>/turbo-jumbo`,
  `<base>/lemonade`.
- `resolveBaseSubdirs` with `turbo_jumbo_subdir` / `lemonade_subdir`
  overrides → the overridden paths.

`loadConfig` itself remains untested (it depends on machine-IP matching and
file IO), matching the current state.

## Out of scope

- Moving or relocating any model files on disk.
- Cold storage layout (stays a separate top-level path).
- Any consumer of the derived config exports.
