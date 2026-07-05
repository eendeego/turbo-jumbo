# Dev machine setup

The toolchain a development machine needs, from hacking on the app to
producing the narrated demo video. App-level configuration, container builds,
and deployment live in [setup.md](setup.md).

## Core

- **[Bun](https://bun.sh)** — package manager, test runner, and script
  runtime (`curl -fsSL https://bun.sh/install | bash`). Then `bun install`
  in the repo. Never npm/npx: use `bun`/`bunx`.
- **[Jujutsu](https://jj-vcs.github.io)** (`jj`) — version control for this
  repo (colocated with git; don't drive it with `git` commands).
- **[direnv](https://direnv.net)** — loads `.envrc` when you enter the repo.
  `.envrc` is gitignored (it holds your HF token); a working one looks like:

  ```bash
  export HF_TOKEN=hf_…                # gated/private HF repos
  export HF_TOKEN_FILE=hf_token.txt   # only used by docker/podman

  export VIRTUAL_ENV="$HOME/venv"     # python venv (narration tooling)
  layout python

  export DEST=/mnt/ai-models          # bin/deploy.sh target

  # `hf download` (spawned by the app) inherits this: Xet-accelerated
  # transfers. (Do NOT set the deprecated HF_HUB_ENABLE_HF_TRANSFER —
  # the modern CLI ignores it and prints a FutureWarning on every run.)
  export HF_XET_HIGH_PERFORMANCE=1
  ```

## The `hf` downloader

Every HuggingFace download shells out to the official `hf` CLI, which must be
on `PATH`. Install it the same way the `Dockerfile` does:

```bash
curl -LsSf https://hf.co/cli/install.sh | bash   # lands in ~/.local/bin/hf
```

It inherits the server's environment — `HF_TOKEN` and
`HF_XET_HIGH_PERFORMANCE` from `.envrc` above — so there is nothing else to
configure.

## Demo recording and post-production (optional)

Only needed to produce the demo video (`bin/make-demo.sh`,
[demo-script.md](demo-script.md)).

- **Playwright's Chromium** — `bin/record-demo.ts` drives a cached browser
  via `playwright-core` loaded straight from bun's package cache (nothing is
  added to this repo). One command populates both the cache and the browser
  build, with the version pinned to match the path in `bin/record-demo.ts`:

  ```bash
  bunx playwright@1.61.1 install chromium
  ```

- **ffmpeg, a full build** — `bin/demo-postprod.sh` needs `setpts`/`concat`
  and the libvpx/libx264 encoders; narration muxing needs audio filters.
  Install the distro package (`pacman -S ffmpeg`, `apt install ffmpeg`, …).
  Playwright's bundled ffmpeg is NOT enough — it strips out nearly all
  filters — so the scripts default to `/usr/bin/ffmpeg` (override with
  `FFMPEG=`).

## Narration with Kokoro TTS (optional)

Narration clips are synthesized locally with [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M)
via `kokoro-onnx` — CPU-only, no cloud.

1. **Python runtime**, into the venv `.envrc` activates:

   ```bash
   python3 -m venv ~/venv   # if it doesn't exist yet
   ~/venv/bin/pip install kokoro-onnx soundfile
   ```

   (`onnxruntime`, numpy, and a bundled libespeak-ng come along as wheels;
   nothing is installed system-wide.)

2. **Model weights — via Turbo Jumbo itself**: add
   [`mikkoph/kokoro-onnx`](https://huggingface.co/mikkoph/kokoro-onnx)
   through **Add model → From Hugging Face** (both `kokoro-v1.0.onnx` and
   `voices-v1.0.bin`). The narration tooling reads them from
   `<base_path>/turbo-jumbo/mikkoph/kokoro-onnx/`.
