# Changelog

All notable changes to Turbo Jumbo, written for humans. New entries go under
**Unreleased** in the same change that introduces them; a release stamps that
section with a version and date (`bin/release.sh`).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Peers can now set a `slug` in `config.yaml` — the short, URL-safe name that
  identifies a machine in its tab's address (`/zurich`) and in the endpoints
  that address it. It was previously derived from the peer's name, which broke
  down for names that aren't plain ASCII: `Zürich` became `z-rich`, and a name
  with no ASCII letters or digits at all left the peer with no reachable tab.
  Leave it out and nothing changes — the derived name is still the default.
  The app now refuses to start if two peers end up with the same slug, or if a
  peer's name yields none, instead of quietly making a tab unreachable.

### Changed

- Updated the UI toolkit (Astryx 0.3.0) and framework (Next.js 16.3, React
  19.2.8), so some controls may look subtly different.

### Fixed

- A sharded model no longer gets a different quantization label on each
  machine. The label is read from one shard's header, and which shard that
  was depended on the order the filesystem happened to list the directory in
  — so a mixed-precision checkpoint could read BF16 on one peer and F32 on
  another. The lowest-numbered shard now always decides.
- Deleting a sharded model no longer warns that it isn't backed up in cold
  storage when every shard is in fact there, and copying one no longer counts
  a destination as already having it when only a single shard is present.
- The "Copy to…" modal is wider and scrolls long selections inside the
  dialog: the file list gets its own viewport while the destination
  checkboxes and the Cancel/Copy buttons stay visible.
- The modal listing files that already exist at a copy destination is wider
  too, and each file's path now gets a line of its own instead of being
  squeezed alongside its destination, status and overwrite/skip label — a
  long path used to wrap mid-name and run into the status badge. Long lists
  scroll inside the dialog instead of stretching it, so Cancel and Continue
  stay put however many files clash.
- Copying a sharded model (a multi-file safetensors repo, a split GGUF) no
  longer lists every shard in the copy modal — it shows one line with the
  file count and total size. Shard sizes now also back the "already present"
  checks, so a destination holding truncated shards no longer counts as
  having the model.
- The audit hovercard stays usable when a model is missing many files: each
  missing file is now a single compact line (the shared repo and revision
  links appear once instead of repeating per file), long file lists scroll
  inside the card, and the "Download missing files" button no longer gets
  pushed out of reach. The invalid-files hovercard's list scrolls the same
  way. Audit hovercards containing buttons or links also linger longer after
  the pointer leaves the badge, so the card no longer vanishes on the way to
  its button.
- The footer's free-space meters now update immediately after a delete, copy,
  or download instead of waiting out their next periodic poll.
- The audit hovercard's "Download missing files" now downloads all of them in
  one go — including small companion files (a tokenizer_config.json) that
  previously had no download path at all — instead of quietly fetching a
  single file. Re-downloads honor the model's pinned revision, and a partial
  re-fetch or single-file delete no longer erases the model's recorded
  revision pin or file scope.
- The audit is now revision-aware: a model downloaded from a pinned branch or
  tag (e.g. a FastFlowLM registry pin) records that revision in its sidecar,
  and every repo comparison — the whole-repo file list, the incomplete and
  invalid checks, audit source resolution — judges it against that revision
  instead of main. Previously a pinned repo whose main had moved on reported
  spurious invalid and missing files.
- Deliberately file-scoped downloads record which files make a complete copy:
  an FLM model downloads exactly the files FastFlowLM's registry names, so
  the repo's extra NPU kernel files no longer count as "missing" — the file
  list and the incomplete check judge only the recorded scope.
- Deleting a model's last weight file now removes its support files too:
  a directory left without any weights takes its config.json, tokenizer
  files, and other companions with it instead of lingering as an unreachable
  husk. Directories that still hold a weight — another quantization, a
  projector — are left untouched.
- Copying a model now carries its support files along — config.json, tokenizer
  files, the safetensors index, and anything else living in the model's
  directory besides the weights. Previously only the weight files selected in
  the table were copied, so a safetensors model arrived at its destination
  unloadable. The pre-copy conflict check reports on the full list, so an
  existing support file at the destination shows up before any bytes move.

### Added

- The Lemonade browser can now list and download FLM (FastFlowLM, AMD NPU)
  models. These exist only inside a running Lemonade server — discovered from
  its flm binary, never in the static catalog — so each peer can name its
  Lemonade server with a new `lemonade_url` config field. The browser then
  shows an "FLM (NPU)" section with that server's models (download state
  included). Models FastFlowLM's public registry maps to a Hugging Face repo
  download directly into Turbo Jumbo storage — at the registry's pinned
  revision, through the regular download runner, with sidecars and peer
  copies like any other model (the `.q4nx` NPU weight format is now
  recognized, labeled Q4NX). Models without a known source fall back to
  asking the Lemonade server to pull into its own store, with live progress;
  after such a pull the server is asked whether it now counts the model as
  downloaded — a server whose flm backend quietly fetched nothing (an
  unhealthy NPU setup) gets a warning instead of a false "downloaded".
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
