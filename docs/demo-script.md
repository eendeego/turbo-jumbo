# Demo video script

The storyline for the recorded product demo (~3 min raw — network- and
disk-speed dependent — 1440×900, dark mode). Each
beat names what the viewer should take away, then the exact on-screen action.
[`bin/record-demo.ts`](../bin/record-demo.ts) records it (its header says how
to run it; mechanics and selector gotchas live in `~/tj/CLAUDE.md`); this
file is the source of truth for _what_ gets recorded — keep the two in sync.
For the whole pipeline in one command — server up, record, accelerate,
mp4 — run [`bin/make-demo.sh`](../bin/make-demo.sh); artifacts land in
`demo-out/`.

## Ground rules

- **Nothing mutates unless a beat is about exactly that.** Very specific,
  pre-planned write or delete operations are fine (e.g. downloading a tiny
  model to show live progress, then deleting it) — but each one is scripted
  deliberately and comes with a cleanup plan. No incidental writes: don't run
  **Audit** (it writes sidecars) or confirm a copy/delete as a side effect of
  showing something else.
- Dark mode throughout — never show light mode. The dev-tools indicator is
  disabled (`NEXT_DEV_INDICATORS=0`).
- Record with both peers up: beat 5 copies to the remote peer, and the Peers
  column should show two live badges throughout.
- Before rolling, delete `mmproj-F16.gguf` from the local
  `unsloth/Qwen3.6-35B-A3B-MTP-GGUF` (`DELETE /api/v1/local-models` with
  `{"files": ["unsloth/Qwen3.6-35B-A3B-MTP-GGUF/mmproj-F16.gguf"]}`): beat 11
  needs its audit to find the model Incomplete, and the beat itself
  re-downloads the mmproj — so every take starts from the same gap and ends
  repaired. (`bin/record-demo.ts` does this in its pre-flight, along with
  clearing any leftover demo model from an interrupted take and running a
  Lemonade sync so beat 9 always finds exactly the demo model to link —
  the sync also sweeps the stale link the previous take left behind.)

## Beats

1. **The inventory at a glance** (~6s)
   Open on the **All** tab. Let the table settle, starting from the top: model
   names with org disambiguation — e.g. the two `LFM2-1.2B-GGUF` entries,
   `(LiquidAI)` vs `(unsloth)` — size ranges across quantizations, per-peer
   presence badges, cold-storage status.

2. **It's a real list, not a mock** (~4s)
   Scroll down a screenful, pause, scroll back up.

3. **Models expand into quantizations** (~6s)
   Expand one multi-quant model row (chevron next to the name — a model with a
   size range, e.g. `gemma-4-26B-A4B-it-GGUF`). Its individual files appear
   with per-file sizes and statuses. Collapse it again.

4. **A real download, start to finish** (~20s, network-dependent)
   **Add model → From Hugging Face**. Type `unsloth/gemma-3-270m-it-GGUF` and
   wait — the picker fetches and lists the repo's files by itself. Tick
   `gemma-3-270m-it-UD-IQ2_M.gguf` (a deliberately tiny quant; the size total
   appears next to the Download button) and click **Download**. Stay on the
   progress view until the download completes, then return to the table: the
   new model is in the list. (Cleanup is beat 7.)

5. **Copy it everywhere** (~15s, network-dependent)
   Tick the just-downloaded file's checkbox. Footer flips to "1 file
   selected"; **Copy to…** and **Delete…** light up. Click **Copy to…**, tick
   both destinations — the remote peer and **Cold storage** — and confirm.
   Wait for the copy to finish: the row's peer badges and cold-storage status
   fill in. Untick. (Cleanup is on camera: beat 7 deletes the model from
   every machine.)

6. **Audit it on the peer** (~15s, network-dependent)
   Click the remote peer's tab — the copied gemma is in its list. Tick it and
   click **Audit** (enabled here, unlike on All): the button flips to
   **Auditing…**, then the audit column fills in with the verdict against
   Hugging Face. On the way back, a quick stop at **Cold Storage** — the
   gemma is here too. Back to **All**.

7. **Delete it everywhere** (~10s)
   On **All**, tick the gemma file again and click **Delete…**. (A
   per-machine tab would delete from just that machine; on All, the modal
   warns it will delete from all locations, including cold storage — "Keep
   in cold storage" stays unticked, since this is the cleanup.) Confirm,
   wait, and the model vanishes from the table, leaving every machine
   exactly as it started.

8. **Same trick, other source** (~20s, network-dependent)
   **Add model → From Lemonade**. Untick **Suggested only** and filter for
   `gemma-3-270m` — the same model, this time out of Lemonade's catalog. Tick
   it, click **Download**, and wait for it to finish. Close the modal — the
   model stays this time; the next two beats build on it.

9. **Consolidate with Lemonade** (~15s)
   Click the local peer's tab and press **Consolidate with Lemonade…**. The
   preview lists the just-downloaded gemma: Turbo Jumbo holds the file,
   Lemonade's catalog knows the model, so the plan is to link it into
   Lemonade's cache — one copy on disk serving both. Click **Sync 1 model**,
   let the result badges land ("1 linked"), and **Close**. (Repeatable:
   the pre-flight deletes the demo model and re-runs a sync, which sweeps
   the then-stale link.)

10. **Delete on one machine** (~8s)
    Still on the local tab, tick the gemma and click **Delete…** — this
    modal targets just this machine, the counterpart to beat 7's
    all-locations delete. Confirm; gone.

11. **Audit finds a real problem — and fixes it** (~30s, disk-speed
    dependent: the audit hashes a big model)
    Still on the local peer's tab, tick
    `unsloth/Qwen3.6-35B-A3B-MTP-GGUF` and press **Audit**; wait for it to
    finish. The audit column flags **Incomplete** — the model is missing its
    mmproj file. Hover the **Incomplete** token and press **Download mmproj**
    on the hovercard; the button flips to **Downloading…** as the repair
    kicks off. (No cleanup: this beat leaves the model more complete than it
    found it.)

12. **Rest** (~2s)
    End on the All tab, nothing selected, cursor parked out of the way.

## Post-production: accelerating the waits

`bin/record-demo.ts` prints a video-relative beat-timestamp table when a
take finishes. After each retake,
refresh [demo-script-timestamps.md](demo-script-timestamps.md) from it,
pick the pure-wait windows (nothing interactive inside), and run
[`bin/demo-postprod.sh`](../bin/demo-postprod.sh):

```bash
bin/demo-postprod.sh raw.webm -w 124:141:8 -w 165:214:8 -w 222.5:232:4
```

Each `-w START:END:SPEED` window is in seconds of the raw video. Use 4× for
stretches with visible progress (transfer bars) so motion stays legible, 8×
for static waits (table polls, hashing). Leave a ~1 s margin on both sides
of each window so no interaction gets sped up. The script writes an
accelerated `…-fast.webm` (one `trim`/`setpts`/`concat` pass — the
recordings have no audio) plus an H.264 `…-fast.mp4`, the format GitHub
accepts for inline README video attachments, and prints both paths. It
needs the full `/usr/bin/ffmpeg`; Playwright's bundled build lacks the
filters.

The voice-over comes last: [`bin/narrate-demo.py`](../bin/narrate-demo.py)
synthesizes the [demo-narration.md](demo-narration.md) script with Kokoro
and mixes it into the accelerated cut (`bin/make-demo.sh` runs it
automatically when Kokoro is installed — see dev-setup.md).

## Beats considered and cut

- **Peer badge hovercard** (peer name + reachability): worth adding once both
  peers are reliably up during recording.
