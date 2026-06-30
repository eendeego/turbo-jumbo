# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Turbo Jumbo: a tool to download AI models (from HuggingFace) and transfer them between machines. Every machine ("peer") runs the same Next.js app; one config lists all peers including this one. Models live in three places — **local** fast storage, **cold storage** (slow archival), and on **other peers** — and the app's job is to keep the right models present in each. Models can have multiple quantizations, each a single file or a split (sharded) set.

## Commands

```bash
bun dev        # Start dev server at http://localhost:3000 (runs server.ts, not `next dev`)
bun build      # Production build
bun start      # Run production build
bun test       # Run all tests (bun's test runner; .test.ts files are co-located in lib/)
bun test lib/audit.test.ts          # Run a single test file
bun test --test-name-pattern <re>   # Run tests whose name matches a regex
bun lint          # ESLint
bun format        # Prettier write
bun format:check  # Prettier check
bun typecheck       # tsc --noEmit
bun typecheck:watch # tsc --noEmit --watch
jj commit -m "<message>"  # Commit (this repo uses Jujutsu, not git)
```

**Package manager is Bun** (not npm/yarn). **Version control is Jujutsu** (`jj`, not `git`).

## Architecture

Next.js 16 **App Router** + React 19, served by a **custom server** (`server.ts`) rather than `next dev`/`next start`. Run via `bun server.ts`. The custom server exists to add two things Next can't host alone:

- **WebSocket server** at `/ws` (`lib/ws-server.ts`). `server.ts` suppresses Next's own `upgrade` handler (which would otherwise match `/ws` via the catch-all route and kill the socket) and routes upgrades itself — `/ws` to our server, everything else (e.g. Next dev HMR) back to Next.
- **Peer monitor** (`lib/peer-monitor.ts`), started at boot. Polls each remote peer's `/api/v1/local-models` every `peer_check_interval` seconds and broadcasts `peer-up`/`peer-down` (`lib/ws-messages.ts`) to connected browsers, so the UI tracks peer reachability live.

**Directory layout:** `app/` holds only routing (layouts, pages, and `app/api/v1/` route handlers). Non-routing React components live in `components/`; non-React shared logic and its tests in `lib/`. Within both, group modules into subdirectories by feature or theme (e.g. `components/lemonade/`, `components/cells/`) rather than letting files accumulate at the top level. Path alias `@/*` resolves to the repo root. TypeScript strict mode.

### Configuration (`lib/config.ts`, `config.schema.json`)

Loaded from `./config.yaml` (override with `CONFIG_PATH`), validated against `config.schema.json` with Ajv. The **local peer is identified by matching a peer's address host against this machine's own IP addresses** — startup fails if none match. The local peer must define `base_path` (local models at `<base_path>/turbo-jumbo`, Lemonade's cache at `<base_path>/lemonade`) and `cold_storage_path`. Remote peers need only `name` + `address`. See `config.yaml.sample`.

### Peers and the API

Each peer serves `app/api/v1/*`. Routes under `app/api/v1/peers/[name]/*` are **proxies**: the local app forwards to the named remote peer's matching endpoint (e.g. a peer's models, disk usage, hf-download). This lets the UI drive downloads and audits on remote machines through the local instance.

### Model identity and provenance (sidecars)

Models are discovered by **synchronously scanning the filesystem** (`lib/models.ts`), not a database. Provenance is recorded in sidecar files alongside the weights:

- **`<file>.tjmeta.json`** (`lib/tjmeta.ts`) — per-file record: the HF `modelUrl`/`originUrl` it came from, expected vs. computed size and SHA256, and the resolved source commit.
- **`tjmodel.json`** (`lib/model-sidecar.ts`) — per-model sidecar in the model directory: shared identity (`repoId`, `repoCommit`) plus one entry per file. A model's revision is derived from its files' commits (`MIXED_COMMIT` when they disagree).

A model's **name** comes from its sidecar's `org/repo` when present, otherwise the filename — so the *same* file can be named differently on two peers. Cross-peer matching therefore joins on **file basename**, not model name (`lib/peer-paths.ts`): specific basenames (GGUF, dtype-tagged) join on their own; generic weight names (`model.safetensors`, etc.) and mmproj files are qualified by model name to avoid conflating different repos.

### Audit (`lib/audit.ts` and friends)

The audit verifies on-disk files against HuggingFace: resolves each file at its commit, compares size/hash, detects updates, duplicates, and incomplete/invalid downloads, and writes the results back into the sidecars. Exposed through `app/api/v1/audit/*` and surfaced in the audit cells/columns of the models table.

### Downloads

HuggingFace downloads shell out to the `hf` CLI with `hf-transfer` (see `Dockerfile`); progress is tracked by polling bytes-on-disk (`lib/hf-download*.ts`, `components/download-runner.tsx`). **Lemonade** is a separate model-server cache the app can browse and sync into (`lib/lemonade*.ts`, `components/lemonade-*`).

## UI conventions

- Buttons that open a modal or dialog end their label with an ellipsis (`…`) — e.g. `"Delete…"`, `"Copy to…"`.
