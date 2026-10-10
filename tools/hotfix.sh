#!/usr/bin/env bash
# A fix during the party, without guests noticing: tests, then the Worker and/or the studio, each at a safe
# moment, then a check that it took. Never touches the Pi (restarting its console cuts the music).
#   tools/hotfix.sh worker | studio | both
# Rules for what a hotfix may change: docs/hotfix.md.
set -euo pipefail
cd "$(dirname "$0")/.."
what=${1:?worker, studio or both}
set -a; . ~/.config/mattyfm/env; set +a
state() { curl -s -m 8 -H "x-admin-token: $ADMIN_TOKEN" https://fm.willms.co/api/admin/state; }

echo "== tests"
(cd worker && npx vitest run >/tmp/hotfix-worker.log 2>&1) || { tail -30 /tmp/hotfix-worker.log; echo "worker tests failed: nothing deployed"; exit 1; }
.venv/bin/pytest studio/tests -q >/tmp/hotfix-studio.log 2>&1 || { tail -30 /tmp/hotfix-studio.log; echo "studio tests failed: nothing deployed"; exit 1; }

if [[ $what == worker || $what == both ]]; then
  echo "== worker"
  want=$(grep -oP 'code: "\K[^"]+' worker/src/party.ts)
  live=$(state | grep -oP '"code":"\K[^"]+' || true)
  (cd worker && npx wrangler deploy 2>&1 | tail -2)
  # the pages pick the new version up by themselves at a quiet moment; the queue (Durable Object) takes ~5 min
  if [[ $want == "$live" ]]; then
    echo "queue code unchanged ($want): page/route fix only, live now"
  else
    s=$(date +%s)
    until state | grep -q "\"code\":\"$want\""; do
      sleep 15; (( $(date +%s) - s > 600 )) && { echo "queue still not on $want after 10 min"; exit 1; }
    done
    echo "queue on $want after $(( $(date +%s) - s ))s"
  fi
fi

if [[ $what == studio || $what == both ]]; then
  echo "== studio"
  # restart while the next song is already in the console (or SomaFM is on): a restart costs a few seconds of
  # beats, and those must not be the seconds the next song should have been pushed in
  s=$(date +%s)
  until state | python3 -c '
import json, sys
h = json.load(sys.stdin).get("health", {})
sys.exit(0 if h.get("source") != "requests" or h.get("queued", 0) >= 1 or h.get("remaining", 0) > 60 else 1)'; do
    sleep 5; (( $(date +%s) - s > 300 )) && { echo "no safe moment in 5 min; restarting anyway"; break; }
  done
  systemctl --user restart mattyfm-studio
  sleep 8
  systemctl --user is-active mattyfm-studio
  journalctl --user -u mattyfm-studio --since "-10s" --no-pager | grep -E "station:|ERROR|Traceback" | tail -3
fi
echo "== done"
