# Demo recording timestamps

Beat timeline of the current demo recording,
`demo-out/turbo-jumbo-demo-2026-07-05.webm` (4:35 raw, the 12-beat
storyline). Times are video-relative, from the beat table
`bin/record-demo.ts` prints. Redo this file after every retake — see
"Post-production" in [demo-script.md](demo-script.md).

| Video time | Event                                                         |
| ---------- | ------------------------------------------------------------- |
| 0:00       | Beat 1 — inventory at a glance (All tab)                      |
| 0:07       | Beat 2 — scroll through the table                             |
| 0:09       | Beat 3 — expand a multi-quant model                           |
| 0:14       | Beat 4 — Add model → From Hugging Face                        |
| 0:26       | · HF download runs + close, reload                            |
| 0:41       | Beat 5 — select, Copy to… the remote peer + Cold storage      |
| 0:51       | · copy runs, badge flips Complete                             |
| 1:13       | Beat 6 — audit the copy on the remote peer, Cold Storage stop |
| 1:29       | Beat 7 — Delete… from all locations                           |
| 1:41       | Beat 8 — Add model → From Lemonade, download (kept)           |
| 2:07       | · waiting for the table poll                                  |
| 2:29       | Beat 9 — Consolidate with Lemonade: preview, Sync             |
| 2:41       | Beat 10 — delete on this machine only                         |
| 2:52       | Beat 11 — local peer tab, select Qwen3.6-35B-A3B-MTP, Audit   |
| 2:56       | · audit hashes ~35 GB (live % shown)                          |
| 4:13       | · hover Incomplete, Download mmproj (899 MB), Close           |
| 4:30       | Beat 12 — rest on All                                         |
| 4:35       | End                                                           |

## Accelerated cut

`turbo-jumbo-demo-2026-07-05-fast.webm` / `.mp4` (2:23) use narration-aware
pacing: 1× only where a narration line needs its slot or where precision
matters, 1.5–2× on watchable interactions without narration, 2–3× on dead
stretches, and 6–16× on the pure waits (table polls, the audit hash, the
mmproj redownload). Narration offsets were fit-checked against every slot
before rendering.

Produced by demo-script.md's Post-production step:

```bash
bin/demo-postprod.sh demo-out/turbo-jumbo-demo-2026-07-05.webm \
  -w 21.4:30:2 -w 33.5:38:2.5 -w 46.7:50.8:1.5 -w 51.8:67.1:3 \
  -w 79.5:84.5:2 -w 84.5:88.2:1.5 -w 94.2:100.7:2 -w 105.6:116.9:2 \
  -w 120.4:127.8:3 -w 127.8:146.9:12 -w 163.1:170.1:2 -w 176.8:245.7:16 \
  -w 254.2:262.9:6 -w 262.9:269.4:1.5
```

The narrated variants (`…-fast-narrated.webm` / `.mp4`) add the
[demo-narration.md](demo-narration.md) voice-over, whose offsets are timed
to this cut.
