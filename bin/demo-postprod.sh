#!/usr/bin/env bash
set -euo pipefail

# Post-production for demo recordings (see docs/demo-script.md): speeds up
# the pure-wait windows of a raw capture, then converts the result to an
# H.264 .mp4 — the format GitHub accepts for inline README video attachments
# (.webm uploads are rejected). Prints the .mp4 path as the last line.
#
# Usage:
#   bin/demo-postprod.sh <raw.webm> -w START:END:SPEED [-w START:END:SPEED]...
#
# Windows are in seconds of the raw video, must be ascending and
# non-overlapping, and must contain nothing interactive — take them from
# docs/demo-script-timestamps.md (4x where progress is visible, 8x for
# static waits, ~1s margin on both sides). Example for the 2026-07-04 take:
#   bin/demo-postprod.sh turbo-jumbo-demo-v2.webm \
#     -w 124:141:8 -w 165:214:8 -w 222.5:232:4

# Needs the full ffmpeg: Playwright's bundled build has no setpts/concat.
# (grep without -q so it drains the pipe — pipefail + -q turns ffmpeg's
# SIGPIPE into a spurious failure.)
FFMPEG=${FFMPEG:-/usr/bin/ffmpeg}
"$FFMPEG" -hide_banner -filters 2>/dev/null | grep ' setpts ' >/dev/null ||
    { echo "error: $FFMPEG lacks the setpts filter (Playwright's bundled ffmpeg won't do)" >&2; exit 1; }

RAW=${1:?usage: bin/demo-postprod.sh <raw.webm> -w START:END:SPEED ...}
shift
[[ -f "$RAW" ]] || { echo "error: no such file: $RAW" >&2; exit 1; }

WINDOWS=()
while [[ $# -gt 0 ]]; do
    case $1 in
        -w) WINDOWS+=("${2:?-w needs START:END:SPEED}"); shift 2 ;;
        *) echo "error: unknown argument: $1" >&2; exit 1 ;;
    esac
done
[[ ${#WINDOWS[@]} -gt 0 ]] || { echo "error: at least one -w START:END:SPEED window required" >&2; exit 1; }

# Build the trim/setpts/concat filtergraph: a normal-speed segment before
# each window, the window itself divided by its speed factor, and an
# open-ended normal segment after the last window.
GRAPH='' LABELS='' N=0 PREV=0
add_segment() { # <trim-args> <setpts-expr>
    GRAPH+="[0:v]trim=$1,setpts=$2[v$N];"
    LABELS+="[v$N]"
    N=$((N + 1))
}
for w in "${WINDOWS[@]}"; do
    IFS=: read -r START END SPEED <<<"$w"
    [[ -n "$START" && -n "$END" && -n "$SPEED" ]] ||
        { echo "error: bad window '$w' (want START:END:SPEED)" >&2; exit 1; }
    awk "BEGIN{exit !($PREV <= $START && $START < $END)}" ||
        { echo "error: window '$w' overlaps the previous one or is inverted" >&2; exit 1; }
    awk "BEGIN{exit !($PREV < $START)}" && add_segment "$PREV:$START" "PTS-STARTPTS"
    add_segment "$START:$END" "(PTS-STARTPTS)/$SPEED"
    PREV=$END
done
add_segment "$PREV" "PTS-STARTPTS"
GRAPH+="${LABELS}concat=n=$N:v=1[out]"

BASE=${RAW%.webm}
FAST_WEBM="$BASE-fast.webm"
FAST_MP4="$BASE-fast.mp4"

# The recordings carry no audio, so a single video-only pass suffices. Keep
# the -b:v ceiling: VP8's constrained-quality mode defaults to 256 kbit/s
# and smears the UI text without it.
"$FFMPEG" -hide_banner -loglevel warning -i "$RAW" \
    -filter_complex "$GRAPH" -map '[out]' \
    -c:v libvpx -crf 10 -b:v 8M -deadline good -cpu-used 2 \
    -y "$FAST_WEBM"
echo "accelerated webm: $FAST_WEBM"

# yuv420p is required for Safari/QuickTime playback; +faststart moves the
# index up front so browsers can start playing while still downloading.
"$FFMPEG" -hide_banner -loglevel warning -i "$FAST_WEBM" \
    -c:v libx264 -crf 20 -preset slow -pix_fmt yuv420p -movflags +faststart \
    -y "$FAST_MP4"
echo "mp4 for GitHub: $FAST_MP4"
