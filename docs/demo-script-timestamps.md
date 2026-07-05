# Demo recording timestamps

Beat timeline of the current demo recording,
`demo-out/turbo-jumbo-demo-2026-07-05.webm` (4:09 raw). Times are
video-relative, from the beat table `bin/record-demo.ts` prints. Redo this
file after every retake — see "Post-production" in
[demo-script.md](demo-script.md).

| Video time | Event                                                |
| ---------- | ---------------------------------------------------- |
| 0:00       | Beat 1 — inventory at a glance (All tab)             |
| 0:07       | Beat 2 — scroll through the table                    |
| 0:09       | Beat 3 — expand a multi-quant model                  |
| 0:15       | Beat 4 — disabled Copy tooltip                       |
| 0:18       | Beat 5 — Add model → From Hugging Face               |
| 0:29       | · HF download runs (~3 s with Xet) + close, reload   |
| 0:44       | · the new gemma row is in the table                  |
| 0:45       | Beat 6 — select, Copy to… the remote peer + Cold storage      |
| 0:54       | · copy runs, badge flips Complete                    |
| 1:14       | Beat 7 — audit the copy on the remote peer, Cold Storage stop |
| 1:30       | Beat 8 — Delete… from all locations                  |
| 1:42       | Beat 9 — Add model → From Lemonade, download         |
| 2:07       | · waiting for the table poll, then select and delete |
| 2:41       | Beat 10 — local peer tab, select Qwen3.6-35B-A3B-MTP, Audit |
| 2:48       | · audit hashes ~35 GB (live % shown)                 |
| 3:45       | · hover Incomplete, Download mmproj (899 MB), Close  |
| 4:04       | Beat 11 — rest on All                                |
| 4:09       | End                                                  |

## Accelerated cut

`turbo-jumbo-demo-2026-07-05-fast.webm` / `.mp4` (3:03) speed up the three
pure-wait stretches; everything interactive stays 1×:

| Raw window  | Speed | What it is                               |
| ----------- | ----- | ---------------------------------------- |
| 2:08 – 2:25 | 8×    | Lemonade row wait (static table poll)    |
| 2:49 – 3:38 | 8×    | The ~35 GB audit hash (progress ticks)   |
| 3:47 – 3:57 | 4×    | mmproj redownload (progress bar visible) |

Produced by demo-script.md's Post-production step:

```bash
bin/demo-postprod.sh demo-out/turbo-jumbo-demo-2026-07-05.webm \
  -w 128:145:8 -w 168.9:218:8 -w 226.5:236.6:4
```

The narrated variants (`…-fast-narrated.webm` / `.mp4`) add the
[demo-narration.md](demo-narration.md) voice-over, whose offsets are timed
to this cut.
