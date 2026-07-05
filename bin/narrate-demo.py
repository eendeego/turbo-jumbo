#!/usr/bin/env python3
"""Mix the docs/demo-narration.md voice-over into the accelerated demo cut.

Synthesizes one clip per table line with Kokoro (weights from the local
Turbo Jumbo inventory — see docs/dev-setup.md), warns when a clip overruns
its slot, and muxes the result. The video stream is copied, never
re-encoded: the .webm gets Vorbis audio, and when a sibling -fast.mp4
exists (bin/demo-postprod.sh makes one) it gets an AAC variant too.

Run inside the venv (direnv activates it):

    bin/narrate-demo.py demo-out/turbo-jumbo-demo-<date>-fast.webm

Env: KOKORO_DIR (model weights), KOKORO_VOICE (default af_heart),
FFMPEG (default /usr/bin/ffmpeg).
"""

import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import soundfile as sf
from kokoro_onnx import Kokoro
from kokoro_onnx.tokenizer import Tokenizer

REPO_ROOT = Path(__file__).resolve().parent.parent
NARRATION_DOC = REPO_ROOT / "docs" / "demo-narration.md"
KOKORO_DIR = Path(
    os.environ.get("KOKORO_DIR", "/mnt/models/turbo-jumbo/mikkoph/kokoro-onnx")
)
VOICE = os.environ.get("KOKORO_VOICE", "af_heart")
FFMPEG = os.environ.get("FFMPEG", "/usr/bin/ffmpeg")
FFPROBE = os.environ.get("FFPROBE", FFMPEG.replace("ffmpeg", "ffprobe"))


def die(msg: str) -> None:
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def parse_lines(doc: Path) -> list[tuple[float, str]]:
    """The narration table: rows of `| <seconds> | <text> |`."""
    lines = []
    for row in doc.read_text().splitlines():
        m = re.match(r"\|\s*(\d+(?:\.\d+)?)\s*\|\s*(.+?)\s*\|$", row)
        if m:
            lines.append((float(m.group(1)), m.group(2)))
    if not lines:
        die(f"no narration rows found in {doc}")
    if lines != sorted(lines, key=lambda x: x[0]):
        die("narration offsets must be ascending")
    return lines


def video_duration(path: Path) -> float:
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True,
    )
    return float(out.stdout.strip())


def main() -> None:
    if len(sys.argv) != 2:
        die(f"usage: {sys.argv[0]} <accelerated-cut.webm>")
    video = Path(sys.argv[1])
    if not video.is_file():
        die(f"no such file: {video}")
    if not (KOKORO_DIR / "kokoro-v1.0.onnx").is_file():
        die(f"Kokoro weights not found under {KOKORO_DIR} — see docs/dev-setup.md")

    lines = parse_lines(NARRATION_DOC)
    total = video_duration(video)

    # Phoneme QA before any audio: a '.' inside a phoneme token is a pause
    # where none belongs (e.g. a dotted initialism slipping back in).
    tokenizer = Tokenizer()
    for offset, text in lines:
        phonemes = tokenizer.phonemize(text, lang="en-us")
        for token in phonemes.split():
            if "." in token.rstrip(".,;:!?—"):
                print(f"warning: pause-inducing '.' in {token!r} "
                      f"(line at {offset}s) — use a speakable spelling")

    kokoro = Kokoro(
        str(KOKORO_DIR / "kokoro-v1.0.onnx"), str(KOKORO_DIR / "voices-v1.0.bin")
    )

    with tempfile.TemporaryDirectory() as tmp:
        clips: list[tuple[float, Path]] = []
        for i, (offset, text) in enumerate(lines):
            samples, rate = kokoro.create(text, voice=VOICE, speed=1.0)
            wav = Path(tmp) / f"line{i:02d}.wav"
            sf.write(wav, samples, rate)
            dur = len(samples) / rate
            end = offset + dur
            slot_end = lines[i + 1][0] if i + 1 < len(lines) else total
            flag = ""
            if end > slot_end:
                flag = f"  ← overruns the next line by {end - slot_end:.1f}s"
            if end > total:
                flag = f"  ← outruns the video by {end - total:.1f}s"
            print(f"{offset:7.1f}s  {dur:4.1f}s  {text[:60]}{flag}")
            clips.append((offset, wav))

        # One delayed input per clip, mixed without amix's default
        # per-input attenuation (clips don't overlap).
        filters = [
            f"[{i + 1}:a]adelay={int(offset * 1000)}:all=1[a{i}]"
            for i, (offset, _) in enumerate(clips)
        ]
        mix = "".join(f"[a{i}]" for i in range(len(clips)))
        graph = (
            ";".join(filters)
            + f";{mix}amix=inputs={len(clips)}:normalize=0[aout]"
        )
        inputs: list[str] = []
        for _, wav in clips:
            inputs += ["-i", str(wav)]

        def mux(src: Path, out: Path, acodec: list[str]) -> None:
            subprocess.run(
                [FFMPEG, "-hide_banner", "-loglevel", "error",
                 "-i", str(src), *inputs,
                 "-filter_complex", graph,
                 "-map", "0:v", "-map", "[aout]",
                 "-c:v", "copy", *acodec, "-y", str(out)],
                check=True,
            )
            print(f"narrated: {out}")

        base = video.with_suffix("")
        mux(video, Path(f"{base}-narrated.webm"), ["-c:a", "libvorbis"])
        mp4 = video.with_suffix(".mp4")
        if mp4.is_file():
            mux(mp4, Path(f"{base}-narrated.mp4"),
                ["-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart"])
        else:
            print(f"note: no {mp4.name} next to the webm — skipped the mp4 variant")


if __name__ == "__main__":
    main()
