# Demo narration script

The voice-over for the accelerated demo cut, synthesized locally with Kokoro
(see [dev-setup.md](dev-setup.md)) and mixed in by
[`bin/narrate-demo.py`](../bin/narrate-demo.py), which parses the table
below. Offsets are seconds **in the accelerated cut** (raw-take timestamps
from [demo-script-timestamps.md](demo-script-timestamps.md), transformed
through the acceleration windows) — refresh them after a retake or a window
change.

Writing rules, learned the hard way:

- **Speakable text only.** Initialisms without periods ("AI", never "A.I." —
  the dots become long pauses). Prefer words over jargon tokens: "multimodal
  projector file", not "mmproj"; "quantizations", not "quants".
- Lines must fit their slot: the narrator speaks ~2.3 words/second, and
  `narrate-demo.py` warns when a clip would overlap the next one or outrun
  the video.
- New vocabulary gets a phoneme check before rendering:
  `Tokenizer.phonemize()` output with a `.` inside a token means a pause
  where none belongs.

| Start (s) | Line                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------- |
| 0.6       | This is Turbo Jumbo: one inventory for every AI model across this machine, its peers, and cold storage. |
| 10.2      | Models expand into their quantizations, with per-file sizes and statuses.                               |
| 15.3      | Even disabled buttons explain themselves.                                                               |
| 19.8      | Adding a model from Hugging Face: type the repo, tick a file, and download.                             |
| 33.4      | Seconds later, it's part of the inventory.                                                              |
| 45.6      | Copying to the peer and to cold storage is one operation.                                               |
| 70.0      | The badges fill in as each copy lands.                                                                  |
| 75.0      | On the peer, an audit verifies the copy against its Hugging Face source.                                |
| 90.5      | Cleanup is a single delete, across every machine and cold storage at once.                              |
| 103.1     | The same model again — this time from a Lemonade catalog.                                               |
| 133.5     | And it's just as easy to remove.                                                                        |
| 146.8     | Finally: this model is missing its multimodal projector file.                                           |
| 161.3     | The audit catches it — and one click fetches exactly the missing file.                                  |
| 178.7     | Every machine, every model, in sync.                                                                    |
