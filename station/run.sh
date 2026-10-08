#!/usr/bin/env bash
# Run the MattyFM station in the foreground so systemd supervises it.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$repo/media/backup" "$repo/media/ready"
docker rm -f mattyfm-station >/dev/null 2>&1 || true
exec docker run --rm --name mattyfm-station --network host \
  -e MATTYFM_RATE="${MATTYFM_RATE:-44100}" \
  -e ICECAST_SOURCE_PASSWORD \
  -v "$repo/station:/station:ro" -v "$repo/media:/media:ro" \
  savonet/liquidsoap:v2.4.5 /station/radio.liq
