#!/usr/bin/env bash
# Icecast for MattyFM: Liquidsoap streams into it; the Pi listens to it.
# Liquidsoap's own harbor server does not send ICY titles (checked on 2.4.5),
# and the Pi needs those titles in-band to time its crossfades.
set -euo pipefail
: "${ICECAST_SOURCE_PASSWORD:?set in ~/.config/mattyfm/env}" "${ICECAST_ADMIN_PASSWORD:?}"
docker rm -f mattyfm-icecast >/dev/null 2>&1 || true
exec docker run --rm --name mattyfm-icecast -p 8040:8000 \
  -e ICECAST_SOURCE_PASSWORD -e ICECAST_ADMIN_PASSWORD \
  -e ICECAST_HOSTNAME=mattyfm -e ICECAST_MAX_CLIENTS=20 \
  libretime/icecast:2.4.4
