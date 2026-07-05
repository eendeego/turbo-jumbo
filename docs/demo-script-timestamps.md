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

`turbo-jumbo-demo-2026-07-05-fast.webm` / `.mp4` (2:10) use narration-aware
pacing: 1× only where a narration line needs its slot or where precision
matters (the opening beats, hovercards, modal payoffs), 1.5–2× on watchable
interactions without narration, 2–3× on dead stretches (typing tails,
reload settles, transfer waits), and 6–16× on the pure waits (table polls,
the ~35 GB audit hash, the mmproj redownload). Narration offsets were
fit-checked against every slot before rendering (no line overruns its gap).

Produced by demo-script.md's Post-production step:

```bash
bin/demo-postprod.sh demo-out/turbo-jumbo-demo-2026-07-05.webm \
  -w 24.5:33:2 -w 36.5:44.5:2.5 -w 50:57.5:1.5 -w 57.5:68.5:3 \
  -w 79.5:84.5:2 -w 84.5:90.5:1.5 -w 95.5:102.5:2 -w 107:118.5:2 \
  -w 118.5:128:3 -w 128:145:12 -w 145:148.5:1.5 -w 148.5:160:2 \
  -w 168.9:218:16 -w 226.5:236.6:6 -w 236.6:243.6:1.5
```

The narrated variants (`…-fast-narrated.webm` / `.mp4`) add the
[demo-narration.md](demo-narration.md) voice-over, whose offsets are timed
to this cut.
