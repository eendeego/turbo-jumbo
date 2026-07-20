# Changelog

All notable changes to Turbo Jumbo, written for humans. New entries go under
**Unreleased** in the same change that introduces them; a release stamps that
section with a version and date (`bin/release.sh`).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- The Lemonade browser now handles catalog models built from a role map of
  checkpoints — the Gemma-4 MTP (multi-token prediction) models with their
  draft and mmproj companion files. They were previously missing from the
  catalog entirely; now they browse and download like any other model.
- The app knows what version it is: shown next to the name in the header
  (with a `dev` marker when the running code doesn't match an official tagged
  release), and served at `/api/v1/version` — also per peer at
  `/api/v1/peers/<name>/version`, so a fleet running mismatched versions can
  be spotted.
- Peer tabs (and the Cold Storage tab) now show the location's disk usage in
  the footer, above the action buttons: a slim used/total meter per volume —
  turning to a warning color when the disk is over 90% full — with the used,
  free, and total figures beside it, for the models volume and, where
  configured, cold storage. Remote peers report their own disks; volumes
  sharing one filesystem show a single combined meter. The figures refresh
  every minute while the tab is open.

### Changed

- The Lemonade browser's other-backend models (vLLM, Ryzen AI ONNX, image,
  speech) now honor the "Suggested only" filter, wear their suggested badges
  and capability icons, and file under the section their catalog labels say
  they belong to — the MTP models list under Vision models beside their
  single-file siblings.
- Searching the Lemonade catalog is now exhaustive: the filter looks past the
  "Extra models" toggle and matches capability labels, so a model the catalog
  knows is always findable by name.
- The download progress dialog is wider, and long output now scrolls inside
  the dialog with the Cancel/Close button always in reach — previously the
  content could overflow off-screen with no scrollbar.
- The Lemonade catalog opens with every section collapsed, showing just the
  section headers and their model counts. Expand what you need — or type in
  the filter, which looks inside collapsed sections and shows every match.
- Models that back a Lemonade catalog entry now carry a "Lemonade" marker
  next to their name in the models table — spelled out with the catalog name
  when it differs from the repo (e.g. `Qwen/Qwen3.6-35B-A3B` behind the
  catalog's `Qwen3.6-35B-A3B-FP16-vLLM`), so the two views are recognizably
  the same model and a missing marker reliably means "not in the catalog".

### Fixed

- A multi-repo download plan (a Lemonade collection or component) now stops
  when one of its downloads fails, instead of burying the error and carrying
  on with the remaining repos as if nothing happened.
- When the `hf` downloader dies by a signal, the error now says so in plain
  words — "exited with code 137" becomes "killed by signal 9 (SIGKILL),
  usually the out-of-memory killer".

## [0.1.0] - 2026-07-05

The first release: mission control for your hoard of AI models.

### Added

- **The models table** — every model and quantization across all your
  machines and cold storage in one view, including split (sharded) files,
  with live per-peer presence as machines come and go.
- **HuggingFace downloads** — pick a repo and files, download to whichever
  peer needs them, progress bar included. Every file gets a sidecar recording
  where it came from, the exact source revision, and its expected size and
  hash.
- **Peer-to-peer transfers** — copy models between machines over your own
  network, with cold storage as the archive; download from the internet once,
  then move bytes on your own wires.
- **Audits** — re-check what's on disk against HuggingFace on demand: sizes,
  hashes, revisions. Incomplete downloads, upstream updates, and duplicates
  under different names all get flagged.
- **Lemonade integration** — browse and download from the Lemonade SDK's
  model catalog (GGUF models and omni collections), and consolidate with
  Lemonade's cache in both directions using symlinks, so one copy on disk
  serves both the inference server and the archive.
- **Deployment** — a single Next.js app per machine, one shared peer config,
  Docker/podman images with a tarball deploy flow.

[Unreleased]: https://github.com/eendeego/turbo-jumbo/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/eendeego/turbo-jumbo/releases/tag/v0.1.0
