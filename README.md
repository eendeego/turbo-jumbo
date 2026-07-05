# Turbo Jumbo

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun&logoColor=black)](https://bun.sh)
[![Next.js 16](https://img.shields.io/badge/Next.js-16-black?logo=nextdotjs)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)

Turbo Jumbo is mission control for your hoard of AI models: download each one
once, put it on every machine that wants it, and know that the bytes on disk
are actually the bytes HuggingFace promised.

![The models table: every model and quantization across peers and cold storage](docs/screenshot.png)

Two-minute narrated tour — a real download, a copy to a peer and cold
storage, audits, deletes, and a Lemonade consolidation, all live:

https://github.com/user-attachments/assets/7804eb94-ba09-439a-8eb5-e21a5898cfa5

## How you end up needing this

It starts innocently. You download one small model, just to try it. Then the
Q8 quantization, because the Q4 lost a few IQ points in compression. Then the
Q4 after all, because the Q8 doesn't fit in VRAM. Then the Unsloth Dynamic one the
internet swears by, and a copy on the other machine, because that's where the
big GPU lives. A few months later you're the reluctant librarian of half a
terabyte of GGUFs, some downloaded three times, none of them where you want
them.

And the odds are not in your favor:

- The only disk big enough for the whole collection is the cold-storage box on
  spinning rust: great for keeping models safe, miserable for running them.
- Inference servers keep private caches with strong opinions. Some will
  cheerfully reorganize (or delete!) the model you spent all night pulling
  down.
- Every re-download is tens of gigabytes, and your ISP's data cap is watching.
- And that `model.safetensors` sitting on disk: is it complete? Still what
  HuggingFace publishes? Secretly the same file you already have under another
  name? Who knows.

## What Turbo Jumbo does about it

Every machine ("peer") runs the same little web app, sharing one list of
peers. Open any of them and you see the whole fleet: which models, in which
quantizations, live on this machine, the other machines, and cold storage.

**Downloads from HuggingFace.** Pick a repo and the files you want; the
download runs on whichever peer needs the model, progress bar and all. Every
file gets a sidecar recording where it came from, the exact source revision,
and its expected size and hash. Provenance, but for tensors.

**Moves models to where the GPUs are.** Transfers go peer-to-peer over your
own network, with cold storage as the archive. The internet is for downloading
a model once; after that it travels on your own wires.

**Audits against HuggingFace.** On demand, Turbo Jumbo re-checks your files
against the source: sizes, hashes, revisions. Incomplete downloads, models
updated upstream, sneaky duplicates — all get flagged. Trust, but verify.
Mostly verify.

**Plays nice with inference servers.** Turbo Jumbo syncs with
[Lemonade](https://lemonade-server.ai)'s model cache in both directions, using
symlinks so one copy on disk serves both the inference server and the archive.
No more caches squabbling over who owns the bytes — and the door is open for
other engines (looking at you, GPUStack) to join.

## Getting started

```bash
cp config.yaml.sample config.yaml  # edit to match your setup
bun install
bun dev                             # http://localhost:3000
```

Configuration, container deployment, and Lemonade sync setup are covered in
[docs/setup.md](docs/setup.md).

## License

Turbo Jumbo is released under the [MIT License](LICENSE).
