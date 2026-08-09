#!/usr/bin/env bash
#
# Record the demo: screen + microphone, straight to an mp4 you can upload.
#
#   pnpm record            # record until you press q
#   pnpm record 180        # record for exactly 3 minutes
#
# There is no screen recorder installed on this machine and no root to install one, so this
# uses a static ffmpeg that pip fetched into a venv — no system packages touched. If the venv
# is missing it rebuilds it.
#
# Output lands in ./recordings with a timestamp, so a second take never overwrites a first.

set -euo pipefail

VENV="${TOLLGATE_REC_VENV:-/tmp/rec-venv}"
OUT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/recordings"
DURATION="${1:-}"

# --- ffmpeg -------------------------------------------------------------------------------
if [ ! -x "$VENV/bin/python" ]; then
  echo "Setting up the recorder (one time)…"
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet imageio-ffmpeg
fi
FFMPEG="$("$VENV/bin/python" -c 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())')"

# --- inputs -------------------------------------------------------------------------------
SCREEN="$(xdpyinfo | awk '/dimensions:/ {print $2}')"
[ -z "$SCREEN" ] && { echo "Cannot read the display size. Is DISPLAY set?"; exit 1; }

# PipeWire usually holds `default`, so the card is opened directly. Falls back to silence
# rather than failing — a video with no narration is recoverable; a failed take is not.
AUDIO_DEV=""
for dev in hw:0,0 plughw:0,0 default; do
  if "$FFMPEG" -hide_banner -loglevel quiet -f alsa -i "$dev" -t 1 -f null - 2>/dev/null; then
    AUDIO_DEV="$dev"; break
  fi
done

mkdir -p "$OUT_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="$OUT_DIR/tollgate-$STAMP.mp4"

echo
echo "  recording   $SCREEN → $FILE"
echo "  microphone  ${AUDIO_DEV:-NONE — video will be silent}"
[ -n "$DURATION" ] && echo "  duration    ${DURATION}s" || echo "  duration    until you press q"
echo
echo "  Switch to your demo windows now. Recording starts in 3…"
sleep 3
echo "  ● RECORDING"
echo

ARGS=(-y -hide_banner -loglevel error -stats)

# Video. 30fps is enough for a screen demo and keeps the file small enough to upload.
ARGS+=(-f x11grab -framerate 30 -video_size "$SCREEN" -i "${DISPLAY:-:0}")

# Audio, if we found a device.
[ -n "$AUDIO_DEV" ] && ARGS+=(-f alsa -ac 1 -i "$AUDIO_DEV")

[ -n "$DURATION" ] && ARGS+=(-t "$DURATION")

# Scaled to 1080p wide. A 3072px capture is unreadable once a submission form re-encodes it,
# and yuv420p is what every player and upload pipeline expects.
ARGS+=(
  -vf "scale=1920:-2"
  -c:v libx264 -preset veryfast -crf 22 -pix_fmt yuv420p
  -movflags +faststart
)
[ -n "$AUDIO_DEV" ] && ARGS+=(-c:a aac -b:a 128k)

"$FFMPEG" "${ARGS[@]}" "$FILE"

echo
echo "  saved  $FILE"
"$FFMPEG" -hide_banner -i "$FILE" 2>&1 | grep -E "Duration|Stream" | sed 's/^/  /'
echo
