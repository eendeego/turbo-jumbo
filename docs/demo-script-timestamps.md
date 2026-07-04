# Demo recording timestamps

Beat timeline of the current demo recording, `turbo-jumbo-demo-v2.webm`
(recorded 2026-07-04, 4:04 raw). Times are video-relative; they come from the
recorder's `STEP:` log lines (the video starts ≈ at the beat-1 line). Redo
this table after every retake — see "Post-production" in
[demo-script.md](demo-script.md).

| Video time | Event                                                |
| ---------- | ---------------------------------------------------- |
| 0:00       | Beat 1 — inventory at a glance (All tab)             |
| 0:06       | Beat 2 — scroll through the table                    |
| 0:09       | Beat 3 — expand a multi-quant model                  |
| 0:14       | Beat 4 — disabled Copy tooltip                       |
| 0:17       | Beat 5 — Add model → From Hugging Face               |
| 0:28       | · HF download runs (~3 s with Xet) + close, reload   |
| 0:43       | · the new gemma row is in the table                  |
| 0:45       | Beat 6 — select, Copy to… the remote peer + Cold storage      |
| 0:54       | · copy runs (~10 s), badge flips Complete            |
| 1:09       | Beat 7 — audit the copy on the remote peer, Cold Storage stop |
| 1:26       | Beat 8 — Delete… from all locations                  |
| 1:38       | Beat 9 — Add model → From Lemonade, download         |
| 2:03       | · waiting for the table poll (row appears ~2:23)     |
| 2:24       | · select the row, Delete…, confirm                   |
| 2:37       | Beat 10 — local peer tab, select Qwen3.6-35B-A3B-MTP, Audit |
| 2:44       | · audit hashes ~35 GB (runs to ~3:35, live % shown)  |
| 3:37       | · hover Incomplete, press Download mmproj            |
| 3:41       | · mmproj redownload (899 MB, done ~3:52), Close      |
| 3:59       | Beat 11 — rest on All                                |
| 4:04       | End                                                  |

## Accelerated cut

`turbo-jumbo-demo-v2-fast.webm` (~3:00) speeds up the three pure-wait
stretches of the raw recording; everything interactive stays 1×:

| Raw window  | Speed | What it is                               |
| ----------- | ----- | ---------------------------------------- |
| 2:04 – 2:21 | 8×    | Lemonade row wait (static table poll)    |
| 2:45 – 3:34 | 8×    | The ~35 GB audit hash (progress ticks)   |
| 3:42 – 3:52 | 4×    | mmproj redownload (progress bar visible) |

Produced by demo-script.md's Post-production step:

```bash
bin/demo-postprod.sh turbo-jumbo-demo-v2.webm \
  -w 124:141:8 -w 165:214:8 -w 222.5:232:4
```
