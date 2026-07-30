# Changelog

All notable changes to Turbo Jumbo, written for humans. New entries go under
**Unreleased** in the same change that introduces them; a release stamps that
section with a version and date (`bin/release.sh`).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Safetensors models now show their weight precision (BF16, F16, …) as a badge
  on the model row. Previously the dtype read from the safetensors headers was
  never displayed anywhere — only GGUF models showed their quantization, on
  their per-quant rows.
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

- A model holding more than one quantization now shows a single total in the
  Size column instead of a min–max range across its quants (which said little
  once each quant is its own separate download). The total counts what's
  actually present at the location you're viewing: files on local storage on
  the All tab, the cold copy on the Cold Storage tab, the peer's copy on a
  peer tab — so a quant that lives only in cold storage or only on a peer no
  longer inflates the local total.
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
  content could overflow off-screen with no scrollbar. The progress bars and
  any warnings stay pinned in view above that scrolling output, so you can
  read the raw log without losing sight of how far along the download is.
- The Lemonade catalog opens with every section collapsed, showing just the
  section headers and their model counts. Expand what you need — or type in
  the filter, which looks inside collapsed sections and shows every match.
- Models that back a Lemonade catalog entry now carry a 🍋 marker next to
  their name in the models table; hovering it names the exact catalog
  entries the repo backs (e.g. `Qwen/Qwen3.6-35B-A3B` behind the catalog's
  `Qwen3.6-35B-A3B-FP16-vLLM`). A missing lemon reliably means the model
  isn't in the catalog.

### Fixed

- The model name hovercard no longer shows one copy's size as if it were the
  whole model's. When the local and cold-storage copies differ — most often a
  different quantization in each — the file total is now broken out by
  location (`Files · Local  3 · 18.7 GiB`, `Files · Cold  2 · 33.7 GiB`), so
  the number always matches the files it describes.
- Every byte size in the app now reads in binary units (GiB/MiB/KiB) — models,
  files, disk usage and download progress alike — instead of some places
  dividing by 1024 while printing "GB" and others using decimal GB. (The
  Lemonade catalog still shows the figure its own spec lists, in GB.)
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
