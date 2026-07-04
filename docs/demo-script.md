# Demo video script

The storyline for the recorded product demo (~2¾ min — network- and
disk-speed dependent — 1440×900, dark mode). Each
beat names what the viewer should take away, then the exact on-screen action.
The automation that records this lives outside the repo (see `~/tj/CLAUDE.md`,
"Recording a video demo"); this file is the source of truth for _what_ gets
recorded.

## Ground rules

- **Nothing mutates unless a beat is about exactly that.** Very specific,
  pre-planned write or delete operations are fine (e.g. downloading a tiny
  model to show live progress, then deleting it) — but each one is scripted
  deliberately and comes with a cleanup plan. No incidental writes: don't run
  **Audit** (it writes sidecars) or confirm a copy/delete as a side effect of
  showing something else.
- Dark mode throughout — never show light mode. The dev-tools indicator is
  disabled (`NEXT_DEV_INDICATORS=0`).
- Record with both peers up: beat 6 copies to the remote peer, and the Peers
  column should show two live badges throughout.

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

4. **The app explains itself** (~4s)
   Hover the disabled **Copy to…** button in the footer. Tooltip: copying
   needs a selection.

5. **A real download, start to finish** (~20s, network-dependent)
   **Add model → From Hugging Face**. Type `unsloth/gemma-3-270m-it-GGUF` and
   wait — the picker fetches and lists the repo's files by itself. Tick
   `gemma-3-270m-it-UD-IQ2_M.gguf` (a deliberately tiny quant; the size total
   appears next to the Download button) and click **Download**. Stay on the
   progress view until the download completes, then return to the table: the
   new model is in the list. (Cleanup is beat 8.)

6. **Copy it everywhere** (~15s, network-dependent)
   Tick the just-downloaded file's checkbox. Footer flips to "1 file
   selected"; **Copy to…** and **Delete…** light up. Click **Copy to…**, tick
   both destinations — the remote peer and **Cold storage** — and confirm.
   Wait for the copy to finish: the row's peer badges and cold-storage status
   fill in. Untick. (Cleanup is on camera: beat 8 deletes the model from
   every machine.)

7. **Audit it on the peer** (~15s, network-dependent)
   Click the remote peer's tab — the copied gemma is in its list. Tick it and
   click **Audit** (enabled here, unlike on All): the button flips to
   **Auditing…**, then the audit column fills in with the verdict against
   Hugging Face. On the way back, a quick stop at **Cold Storage** — the
   gemma is here too. Back to **All**.

8. **Delete it everywhere** (~10s)
   On **All**, tick the gemma file again and click **Delete…**. The modal
   warns it will delete from all locations, including cold storage ("Keep in
   cold storage" stays unticked — this is the cleanup). Confirm, wait, and
   the model vanishes from the table, leaving every machine exactly as it
   started.

9. **Same trick, other source** (~25s, network-dependent)
   **Add model → From Lemonade**. Untick **Suggested only** and filter for
   `gemma-3-270m` — the same model, this time out of Lemonade's catalog. Tick
   it, click **Download**, and wait for it to finish. Close the modal, then
   tick the model in the table, **Delete…**, and confirm: clean again.

10. **Audit finds a real problem — and fixes it** (~30s, disk-speed
    dependent: the audit hashes a big model)
    Click the first peer's tab (the local one). Tick
    `unsloth/Qwen3.6-35B-A3B-MTP-GGUF` and press **Audit**; wait for it to
    finish. The audit column flags **Incomplete** — the model is missing its
    mmproj file. Hover the **Incomplete** token and press **Download mmproj**
    on the hovercard; the button flips to **Downloading…** as the repair
    kicks off. (No cleanup: this beat leaves the model more complete than it
    found it.)

11. **Rest** (~2s)
    End on the All tab, nothing selected, cursor parked out of the way.

## Beats considered and cut

- **Peer badge hovercard** (peer name + reachability): worth adding once both
  peers are reliably up during recording.
