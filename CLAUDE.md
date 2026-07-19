# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Turbo Jumbo: a tool to download AI models (from HuggingFace) and transfer them between machines. Every machine ("peer") runs the same Next.js app; one config lists all peers including this one. Models live in three places — **local** fast storage, **cold storage** (slow archival), and on **other peers** — and the app's job is to keep the right models present in each. Models can have multiple quantizations, each a single file or a split (sharded) set.

## Commands

```bash
bun dev        # Start dev server at http://localhost:3000
bun build      # Production build
bun start      # Run production build
bun test       # Run all tests (bun's test runner; .test.ts files are co-located in lib/)
bun test lib/audit/audit.test.ts    # Run a single test file
bun test --test-name-pattern <re>   # Run tests whose name matches a regex
bun lint          # ESLint
bun format        # Prettier write
bun format:check  # Prettier check
bun typecheck       # tsc --noEmit
bun typecheck:watch # tsc --noEmit --watch
jj commit -m "<message>"  # Commit (this repo uses Jujutsu, not git)
```

**Package manager is Bun** (not npm/yarn). Run JS/TS with `bun` (`bun -e "…"`, `bun run …`), never `node`; use `bunx`, not `npx`. **Version control is Jujutsu** (`jj`, not `git`).

## Releases and the changelog

- `CHANGELOG.md` is hand-curated ([Keep a Changelog](https://keepachangelog.com)). **When a change is user-visible, add a bullet under `## [Unreleased]` in the same commit**, written for users of the app ("searching the catalog now finds…"), not restyled commit subjects. Internal-only changes (refactors, dev tooling) stay out.
- `bin/release.sh <version>` cuts a release: stamps the Unreleased section, bumps `package.json`, commits, moves `main`, creates the annotated `v<version>` tag, pushes branch + tag to `origin` (Forgejo, source of truth) and `github` (public mirror), and publishes the changelog section as release notes on both forges (`GITHUB_TOKEN`/`FORGEJO_TOKEN` from `.env`).
- The app reports its version identity (`lib/version/`) in the header and at `/api/v1/version`: `dev: true` unless the running code is exactly a clean checkout of the `v<package.json version>` tag. Docker builds are stamped by `bin/docker-build.sh` (`TJ_RELEASE`/`TJ_COMMIT` env), since images carry no git checkout.

## Architecture

Next.js 16 **App Router** + React 19, served by plain `next dev`/`next start` (no custom server). Live peer notifications ride on two Next-native pieces:

- **Peer monitor** (`lib/peers/peer-monitor.ts`), started once at server boot from `instrumentation.ts`. Polls each remote peer's `/api/v1/local-models` every `peer_check_interval` seconds and publishes `peer-up`/`peer-down` events (`lib/peers/peer-event-types.ts`) into an in-process hub (`lib/peers/peer-event-hub.ts`; state lives on `globalThis` because instrumentation and route handlers are separate module graphs).
- **SSE stream** at `/api/v1/events` (a streaming Route Handler): replays the hub's current peer state on connect, then forwards events. Browsers subscribe through `lib/peers/peer-event-client.ts`, which multiplexes all client-side subscribers over one auto-reconnecting `EventSource`. WebSockets are deliberately avoided: Next's router owns HTTP `upgrade` handling and kills upgrades on paths that match a route (the `[[...location]]` catch-all matches everything).

**Directory layout:** `app/` holds only routing (layouts, pages, and `app/api/v1/` route handlers). Non-routing React components live in `components/`; non-React shared logic and its tests in `lib/`. Group modules into subdirectories by feature or theme rather than letting files accumulate at the top level — this applies to `components/` (e.g. `components/lemonade/`, `components/cells/`) and equally to `lib/` (e.g. `lib/audit/`, `lib/hf/`). Path alias `@/*` resolves to the repo root. TypeScript strict mode.

### Configuration (`lib/config/index.ts`, `config.schema.json`)

Loaded from `./config.yaml` (override with `CONFIG_PATH`), validated against `config.schema.json` with Ajv. The **local peer is identified by matching a peer's address host against this machine's own IP addresses** — startup fails if none match. The local peer must define `base_path` (local models at `<base_path>/turbo-jumbo`, Lemonade's cache at `<base_path>/lemonade`) and `cold_storage_path`. Remote peers need only `name` + `address`. See `config.yaml.sample`.

### Peers and the API

Each peer serves `app/api/v1/*`. Routes under `app/api/v1/peers/[name]/*` are **proxies**: the local app forwards to the named remote peer's matching endpoint (e.g. a peer's models, disk usage, hf-download). This lets the UI drive downloads and audits on remote machines through the local instance.

### Model identity and provenance (sidecars)

Models are discovered by **synchronously scanning the filesystem** (`lib/models/models.ts`), not a database. Provenance is recorded in sidecar files alongside the weights:

- **`<file>.tjmeta.json`** (`lib/models/tjmeta.ts`) — per-file record: the HF `modelUrl`/`originUrl` it came from, expected vs. computed size and SHA256, and the resolved source commit.
- **`tjmodel.json`** (`lib/models/model-sidecar.ts`) — per-model sidecar in the model directory: shared identity (`repoId`, `repoCommit`) plus one entry per file. A model's revision is derived from its files' commits (`MIXED_COMMIT` when they disagree).

A model's **name** comes from its sidecar's `org/repo` when present, otherwise the filename — so the _same_ file can be named differently on two peers. Cross-peer matching therefore joins on **file basename**, not model name (`lib/peers/peer-paths.ts`): specific basenames (GGUF, dtype-tagged) join on their own; generic weight names (`model.safetensors`, etc.) and mmproj files are qualified by model name to avoid conflating different repos.

### Audit (`lib/audit/audit.ts` and friends)

The audit verifies on-disk files against HuggingFace: resolves each file at its commit, compares size/hash, detects updates, duplicates, and incomplete/invalid downloads, and writes the results back into the sidecars. Exposed through `app/api/v1/audit/*` and surfaced in the audit cells/columns of the models table.

### Downloads

HuggingFace downloads shell out to the `hf` CLI, which inherits the server's environment (`HF_TOKEN`, Xet acceleration via `HF_XET_HIGH_PERFORMANCE` — set in `.envrc` for dev and in the `Dockerfile`); progress is tracked by polling bytes-on-disk (`lib/hf/hf-download*.ts`, `components/download-runner.tsx`). **Lemonade** is a separate model-server cache the app can browse and sync into (`lib/lemonade/`, `components/lemonade/`).

## UI conventions

- Buttons that open a modal or dialog end their label with an ellipsis (`…`) — e.g. `"Delete…"`, `"Copy to…"`.
- Import Astryx components by their bare names (`import {Button} from '@astryxdesign/core/Button'`) — never alias them (no `XDS*`-style prefixes).

<!-- ASTRYX:START -->
Astryx v0.1.6 · 149 components
CLI: run every command as `bunx astryx <cmd>` (shown below as `astryx ...`).

SETUP (once, in your app entry e.g. main.tsx) — without these, components render unstyled:
  import "@astryxdesign/core/reset.css";
  import "@astryxdesign/core/astryx.css";

WORKFLOW — discover, don't guess. Before writing UI:
1. `astryx build "<idea>"` — START HERE: returns a kit (closest [page] + [block]s + [component]s). No args = full playbook.
2. `astryx template <name> [--skeleton]` — scaffold the [page]/[block]s it named, or study their layout. Templates are reference code.
3. `astryx component <Name>` — props + examples for every component you use.

RULES:
- No <div> — components do all layout/spacing. Full page → AppShell; sidebar nav → SideNav.
- Frame first: pick the shell (AppShell / Layout+LayoutPanel) and budget regions in px BEFORE writing content (`astryx docs layout`).
- Dense data = rows (Table, List/Item) edge-to-edge — never Card-wrapped list items. Card = dashboard widgets, galleries, settings groups only.
- Status → StatusDot/Token; Badge only for counts and enumerated states, never decoration.
- Custom styling: component props first; else the xstyle prop / StyleX tokens (@astryxdesign/core/theme/tokens.stylex). No raw hex/px.
- Tokens for every value (`astryx docs tokens`). Brand/accent via `astryx theme` — never override --color-* in :root.

MORE CLI:
  search "<query>"   find any component / hook / doc / template / block
  component --list   149 components by category
  template --list    page + block recipes
  docs <topic>       color, elevation, icons, illustrations, layout, migration, motion, principles, shape, spacing, styling, theme, tokens, typography
  swizzle <Name>     eject component source for deep customization
  upgrade --apply    run after any @astryxdesign/core bump
<!-- ASTRYX:END -->
